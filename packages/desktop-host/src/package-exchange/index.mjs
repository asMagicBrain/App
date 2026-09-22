import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateExchangeState} from './state.mjs';
import {selectExportFiles} from './export-policy.mjs';
import {pinDirectory, checkDirectory, checkSourceSpelling, contains} from '../physical-roots.mjs';
import {createPrivateStore, assertOutsideGit} from '../private-store.mjs';
import {openRawFile} from '../local-git/raw-file.mjs';
import {createFileManagement} from '../repository-runtime/file-management.mjs';
import {createNodeFilesystem} from '../../../source-foundation/src/adapters/node-filesystem.mjs';
import {prepareFileTransaction} from '../../../source-foundation/src/operations/requests.mjs';
import {portablePathKey} from '../../../source-foundation/src/domain/path-policy.mjs';
import {PACKAGE_MANIFEST, parsePackage, createPackageZip, sha256, failure, validHash, validLabel, safePath} from './archive.mjs';

export const EXCHANGE_LIMITS = Object.freeze({files:9999, changedFiles:256, memberBytes:64*1024*1024,
  updateMemberBytes:4*1024*1024, totalBytes:512*1024*1024, retainedBytes:2*1024*1024*1024, reviewMs:10*60*1000, operations:8});
const exists = name => { try { return fs.lstatSync(name); } catch (error) { if(error.code==='ENOENT') return null; throw error; } };
const exact = (value,fields) => value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===fields.length && fields.every(field=>Object.hasOwn(value,field));
const textPreview = bytes => { if(bytes===null)return null; if(bytes.length>64*1024)return '[Large file: compare the recorded hashes.]'; try { const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes); return text.includes('\0')?'[Binary file]':text; } catch { return '[Binary file]'; } };
const namespaceContains = (a,b) => portablePathKey(a)===portablePathKey(b) || portablePathKey(b).startsWith(portablePathKey(a)+'/');
const keyList = files => files.map(file=>({path:file.path,sha256:file.hash??sha256(file.bytes)})).sort((a,b)=>a.path.localeCompare(b.path));
function sync(pin) { checkDirectory(pin); const fd=fs.openSync(pin.path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); checkDirectory(pin); } finally { fs.closeSync(fd); } }
function child(parent,name) { checkDirectory(parent); const target=path.join(parent.path,name); if(!exists(target)){fs.mkdirSync(target,{mode:0o700});sync(parent);} const pin=pinDirectory(target); if((fs.statSync(target).mode&0o777)!==0o700)failure('INVALID_PRIVATE_ROOT'); return pin; }

/** Host-only service. The native host serializes this with ordinary file/Git
 * operations, supplies durable draft paths, and holds all writes while recovery
 * is pending. Source publication uses the existing pinned transaction worker. */
export function createPackageExchange({sourceRoot,sourceBindingRoot,privateRoot,getDraftPaths=()=>[],renderOffline,hooks={}}) {
  const source=pinDirectory(sourceRoot), root=pinDirectory(privateRoot);
  if(contains(source.path,root.path)||contains(root.path,source.path)||(fs.statSync(root.path).mode&0o777)!==0o700)failure('INVALID_PRIVATE_ROOT');
  assertOutsideGit(root.path);
  const journal=child(root,'journal'), blobs=child(root,'blobs'), recovery=child(root,'recovery'), managementRoot=child(root,'management');
  const bindingHash=sha256(JSON.stringify({sourceRoot:sourceBindingRoot??source.path,sourceIdentity:source.identity}));
  const transportId=`${bindingHash.slice(0,8)}-${bindingHash.slice(8,12)}-4${bindingHash.slice(13,16)}-8${bindingHash.slice(17,20)}-${bindingHash.slice(20,32)}`;
  const store=createPrivateStore({privateRoot:journal.path,bindingHash}), adapter=createNodeFilesystem({repositoryRoot:source.path,recoveryRoot:recovery.path,spaceRoot:'.',spaceId:transportId});
  const management=createFileManagement({source,privateRoot:managementRoot.path,check});
  const reviews=new Map(); let scan,state;
  function check(){for(const pin of [source,root,journal,blobs,recovery,managementRoot])checkDirectory(pin);assertOutsideGit(root.path);}
  function load(){check();scan=store.ensureDurable(store.scan());state=scan.events.at(-1)?.payload??{schemaVersion:1,registration:null,pending:null,operations:[]};
    if(scan.blocked)failure('RECOVERY_REQUIRED');validateExchangeState(state);
  }
  function persist(next){check();if(scan.tailRecords>=16||scan.coveredFiles.length)scan=store.compact(scan,state);scan=store.append(scan,'draft',next);state=structuredClone(next);}
  function ready(){load();if(state.pending||adapter.inspectRecovery().blocked)failure('RECOVERY_REQUIRED');}
  function current(relative){
    if(!safePath(relative))failure('INVALID_PATH');check();
    let parent=source;
    const parts=relative.split('/');
    for(let n=0;n<parts.length;n++){
      checkDirectory(parent);const names=fs.readdirSync(parent.path),matches=names.filter(name=>portablePathKey(name)===portablePathKey(parts[n]));
      if(!matches.length){checkDirectory(parent);check();return {path:relative,hash:null,bytes:null,stamp:null};}
      if(matches.length!==1||matches[0]!==parts[n])failure('PACKAGE_COLLISION');
      const target=path.join(parent.path,parts[n]);
      if(n<parts.length-1){parent=pinDirectory(target);continue;}
      const file=openRawFile(target,EXCHANGE_LIMITS.memberBytes);
      try{const bytes=Buffer.alloc(file.size);let offset=0;while(offset<bytes.length){const read=fs.readSync(file.fd,bytes,offset,bytes.length-offset,offset);if(!read)failure('STALE_PLAN');offset+=read;}file.verify();checkDirectory(parent);check();return {path:relative,hash:sha256(bytes),bytes,stamp:['dev','ino','size','mode','nlink','mtimeNs','ctimeNs'].map(key=>String(fs.fstatSync(file.fd,{bigint:true})[key])).join(':')};}finally{file.close();}
    }
  }
  function inventory(){
    const files=[];let count=0,total=0;
    function walk(pin,relative=''){
      checkDirectory(pin);const keys=new Set();for(const name of fs.readdirSync(pin.path).sort()){
        if(['.git','.asmagicbrain','.ds_store','__macosx'].includes(name.toLowerCase())||name.toLowerCase().startsWith('.asmb-'))continue;
        const next=relative?`${relative}/${name}`:name,key=portablePathKey(name);if(!safePath(next)||keys.has(key))failure('PACKAGE_COLLISION');keys.add(key);if(++count>10000)failure('LIMIT_EXCEEDED');
        const stat=fs.lstatSync(path.join(pin.path,name));if(stat.isSymbolicLink())failure('UNSAFE_FILE');
        if(stat.isDirectory())walk(pinDirectory(path.join(pin.path,name)),next);else {const file=current(next);total+=file.bytes.length;if(total>EXCHANGE_LIMITS.totalBytes)failure('LIMIT_EXCEEDED');files.push(file);}
      }checkDirectory(pin);
    }walk(source);return files;
  }
  async function drafts(){const paths=await getDraftPaths();if(!Array.isArray(paths)||paths.length>10000||paths.some(value=>typeof value!=='string'))failure('INVALID_DRAFT_STATE');return [...new Set(paths)].sort();}
  const draftAffected=(paths,relative)=>paths.some(value=>namespaceContains(value,relative)||namespaceContains(relative,value));
  const inventoryHash=files=>sha256(JSON.stringify([...files].sort((a,b)=>a.path.localeCompare(b.path)).map(file=>({path:file.path,hash:file.hash,stamp:file.stamp}))));
  const draftHash=paths=>sha256(JSON.stringify(paths));
  function blob(hash){if(!validHash(hash))failure('RECOVERY_REQUIRED');check();const filename=path.join(blobs.path,hash),file=openRawFile(filename,EXCHANGE_LIMITS.memberBytes);try{const bytes=fs.readFileSync(file.fd);file.verify();if(sha256(bytes)!==hash)failure('RECOVERY_REQUIRED');check();return bytes;}finally{file.close();}}
  function retain(bytes){if(bytes===null)return null;const hash=sha256(bytes),filename=path.join(blobs.path,hash);check();if(exists(filename)){if(!blob(hash).equals(bytes))failure('RECOVERY_REQUIRED');return hash;}
    const fd=fs.openSync(filename,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}sync(blobs);return hash;
  }
  function capacity(bytes){check();let retained=0;for(const name of fs.readdirSync(blobs.path)){if(!validHash(name))failure('RECOVERY_REQUIRED');const stat=fs.lstatSync(path.join(blobs.path,name));if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)failure('RECOVERY_REQUIRED');retained+=stat.size;}
    if(retained+bytes>EXCHANGE_LIMITS.retainedBytes)failure('RETAINED_STORAGE_LIMIT');
    for(const pin of [source,root]){const disk=fs.statfsSync(pin.path);if(disk.bavail*disk.bsize<bytes*2+16*1024*1024)failure('INSUFFICIENT_SPACE');}
  }
  function remember(review){for(const [key,value] of reviews)if(value.expiresAt<Date.now())reviews.delete(key);while(reviews.size>=8)reviews.delete(reviews.keys().next().value);reviews.set(review.planId,review);return publicReview(review);}
  function publicReview(review){return structuredClone({schemaVersion:1,kind:review.kind,planId:review.planId,expiresAt:review.expiresAt,packageDigest:review.packageDigest??null,collectionId:review.collectionId,version:review.version,semantics:review.semantics??null,rows:review.rows??[],drafts:review.drafts,warnings:review.warnings??[],excluded:review.excluded??[],fileCount:review.files?.length??0,limits:EXCHANGE_LIMITS});}
  function reviewById(planId,kind){ready();const review=reviews.get(planId);if(!review||review.kind!==kind||review.expiresAt<Date.now())failure('STALE_PLAN');return review;}
  async function registrationReview({archive,collectionId,version}){
    ready();const incoming=parsePackage(archive);if(state.registration)failure('ALREADY_REGISTERED');
    collectionId??=incoming.metadata?.collectionId;version??=incoming.metadata?.version;
    if(!validLabel(collectionId)||!validLabel(version)||incoming.metadata&&(incoming.metadata.collectionId!==collectionId||incoming.metadata.version!==version))failure('INVALID_PACKAGE');
    const files=inventory(),draftPaths=await drafts();
    for(const file of incoming.files){const actual=files.find(item=>item.path===file.path);if(actual?.hash!==sha256(file.bytes))failure('BASE_MISMATCH');if(draftAffected(draftPaths,file.path))failure('DRAFT_CONFLICT');}
    return remember({kind:'register',planId:randomUUID(),expiresAt:Date.now()+EXCHANGE_LIMITS.reviewMs,packageDigest:incoming.digest,collectionId,version,files:incoming.files,inventoryHash:inventoryHash(files),drafts:draftPaths,rows:incoming.files.map(file=>({path:file.path,action:'register',baseHash:null,currentHash:sha256(file.bytes),incomingHash:sha256(file.bytes),conflict:false,choices:[]}))});
  }
  async function registerBase(request){
    // Callers can request a review then explicitly register its opaque identity.
    const review=request.planId?reviewById(request.planId,'register'):reviews.get((await registrationReview(request)).planId);
    const currentDrafts=await drafts();if(draftHash(currentDrafts)!==draftHash(review.drafts)||inventoryHash(inventory())!==review.inventoryHash)failure('STALE_PLAN');
    const bytes=review.files.reduce((sum,file)=>sum+file.bytes.length,0);capacity(bytes);for(const file of review.files)retain(file.bytes);
    persist({...state,registration:{collectionId:review.collectionId,version:review.version,files:keyList(review.files)}});reviews.delete(review.planId);return status();
  }
  async function reviewUpdate({archive,semantics,version}){
    ready();if(!state.registration)failure('BASE_NOT_REGISTERED');const incoming=parsePackage(archive),base=state.registration;
    semantics??=incoming.metadata?.semantics;version??=incoming.metadata?.version;
    if(!['snapshot','patch'].includes(semantics)||!validLabel(version))failure('INVALID_PACKAGE');
    if(incoming.metadata&&(incoming.metadata.collectionId!==base.collectionId||incoming.metadata.semantics!==semantics||incoming.metadata.version!==version))failure('COLLECTION_MISMATCH');
    if(incoming.metadata?.base&&(incoming.metadata.base.version!==base.version||JSON.stringify([...incoming.metadata.base.files].sort((a,b)=>a.path.localeCompare(b.path)))!==JSON.stringify(base.files)))failure('BASE_MISMATCH');
    for(const file of incoming.files)current(file.path);
    const files=inventory(),draftPaths=await drafts(),currentMap=new Map(files.map(file=>[file.path,file])),baseMap=new Map(base.files.map(file=>[file.path,file.sha256])),incomingMap=new Map(incoming.files.map(file=>[file.path,file]));
    const all=[...new Set([...baseMap.keys(),...incomingMap.keys(),...currentMap.keys()])].sort(),rows=[];
    for(const relative of all){const saved=currentMap.get(relative),candidate=incomingMap.get(relative),old=baseMap.get(relative)??null,now=saved?.hash??null,next=candidate?sha256(candidate.bytes):null,owned=baseMap.has(relative),protectedDraft=draftAffected(draftPaths,relative);
      let action='preserve',conflict=false;
      if(candidate){if(!owned&&now!==null){action='conflict';conflict=true;}else if(now===next)action='unchanged';else if(now===old){action=now===null?'add':'update';}else if(next===old)action='preserve';else{action='conflict';conflict=true;}}
      else if(owned&&semantics==='snapshot'&&now!==null){action=now===old?'remove':'conflict';conflict=now!==old;}
      const changing=['add','update','remove','conflict'].includes(action);
      rows.push({path:relative,action,owned,baseHash:old,currentHash:now,incomingHash:next,conflict,protectedDraft,choices:changing?(protectedDraft?['keep-current']:['keep-current','use-incoming',...(candidate&&now!==null?['keep-both']:[])]):[],...(changing?{base:old?textPreview(blob(old)):null,current:textPreview(saved?.bytes??null),incoming:textPreview(candidate?.bytes??null)}:{})});
    }
    const changed=rows.filter(row=>row.choices.length);if(changed.length>EXCHANGE_LIMITS.changedFiles)failure('LIMIT_EXCEEDED');
    // This is an exchange-transaction bound, never an ordinary file-management cap.
    const oversized=changed.filter(row=>(currentMap.get(row.path)?.bytes.length??0)>EXCHANGE_LIMITS.updateMemberBytes||(incomingMap.get(row.path)?.bytes.length??0)>EXCHANGE_LIMITS.updateMemberBytes).map(row=>row.path);
    return remember({kind:'update',planId:randomUUID(),expiresAt:Date.now()+EXCHANGE_LIMITS.reviewMs,packageDigest:incoming.digest,collectionId:base.collectionId,version,semantics,rows,files:incoming.files,inventoryHash:inventoryHash(files),saved:files,drafts:draftPaths,base:structuredClone(base),warnings:oversized.map(path=>({path,code:'UPDATE_MEMBER_LIMIT',message:'This file exceeds the 4 MiB reviewed-update transaction limit; keep the current file.'}))});
  }
  function nextRegistration(review,choiceMap){const map=new Map(review.semantics==='patch'?review.base.files.map(file=>[file.path,file.sha256]):[]);for(const file of review.files){const row=review.rows.find(row=>row.path===file.path);if(row.owned||choiceMap.get(file.path)==='use-incoming')map.set(file.path,sha256(file.bytes));}return {collectionId:review.collectionId,version:review.version,files:[...map].map(([path,sha256])=>({path,sha256})).sort((a,b)=>a.path.localeCompare(b.path))};}
  async function apply({planId,choices=[],operationId=randomUUID()}){
    // Only the trusted host may supply a broker identity. It is a durable receipt
    // correlation key, never permission to replay an old publication.
    if(typeof operationId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId))failure('INVALID_REQUEST');
    const review=reviewById(planId,'update');if(state.operations.some(operation=>operation.operationId===operationId))failure('OPERATION_ID_USED');
    if(!Array.isArray(choices)||choices.length>EXCHANGE_LIMITS.changedFiles||choices.some(choice=>!exact(choice,['path','choice']))||new Set(choices.map(choice=>choice.path)).size!==choices.length)failure('INVALID_CHOICES');
    const currentDrafts=await drafts();if(draftHash(currentDrafts)!==draftHash(review.drafts)||inventoryHash(inventory())!==review.inventoryHash||JSON.stringify(state.registration)!==JSON.stringify(review.base))failure('STALE_PLAN');
    const choiceMap=new Map(choices.map(choice=>[choice.path,choice.choice])),candidates=new Map(review.files.map(file=>[file.path,file.bytes])),changes=[];
    const occupied=new Set(inventory().map(file=>portablePathKey(file.path)));
    for(const choice of choices)if(!review.rows.find(row=>row.path===choice.path)?.choices.includes(choice.choice))failure('INVALID_CHOICES');
    for(const row of review.rows){if(!row.choices.length)continue;const choice=choiceMap.get(row.path);if(!choice)failure('CHOICE_REQUIRED');if(choice==='keep-current')continue;
      if(review.warnings.some(warning=>warning.path===row.path))failure('UPDATE_MEMBER_LIMIT');
      let relative=row.path,before=current(relative),after=candidates.get(row.path)??null;
      if(before.hash!==row.currentHash||before.stamp!==(review.saved.find(file=>file.path===relative)?.stamp??null))failure('STALE_PLAN');
      if(choice==='keep-both'){
        const extension=path.posix.extname(relative),stem=relative.slice(0,relative.length-extension.length);let n=1;
        do{relative=`${stem} incoming${n===1?'':` ${n}`}${extension}`;n++;}while(occupied.has(portablePathKey(relative))&&n<=10001);
        if(n>10001||!safePath(relative)||draftAffected(review.drafts,relative))failure('PACKAGE_COLLISION');before=current(relative);if(before.hash!==null)failure('STALE_PLAN');
      }
      occupied.add(portablePathKey(relative));if(before.hash===(after===null?null:sha256(after)))continue;
      changes.push({path:relative,beforeHash:before.hash,afterHash:after===null?null:sha256(after),before:before.bytes,after});
    }
    capacity(changes.reduce((sum,entry)=>sum+(entry.before?.length??0)+(entry.after?.length??0),0)+review.files.reduce((sum,file)=>sum+file.bytes.length,0));
    for(const entry of changes){retain(entry.before);retain(entry.after);}for(const file of review.files)retain(file.bytes);
    const operation={operationId,packageDigest:review.packageDigest,direction:'apply',phase:'pending',index:0,changes:changes.map(({path,beforeHash,afterHash})=>({path,beforeHash,afterHash})),before:review.base,after:nextRegistration(review,choiceMap),createdDirectories:[],createdAt:Date.now()};
    persist({...state,pending:operation});reviews.delete(planId);hooks.at?.('exchange-after-intent',structuredClone(operation));return finish();
  }
  function ensureParents(relative){let pin=source,currentPath='';for(const part of relative.split('/').slice(0,-1)){
    const next=currentPath?`${currentPath}/${part}`:part;checkDirectory(pin);const found=fs.readdirSync(pin.path).filter(name=>portablePathKey(name)===portablePathKey(part));
    if(found.length&&(found.length!==1||found[0]!==part))failure('PACKAGE_COLLISION');
    if(!found.length){management.createDirectory(pin.path,part);state.pending.createdDirectories.push(next);persist({...state,pending:state.pending});}
    pin=pinDirectory(path.join(source.path,next));currentPath=next;
  }}
  function settleEngine(){const recovered=adapter.recover();if(recovered.some(result=>result.status==='manual-recovery'))failure('RECOVERY_REQUIRED');}
  async function finish(){
    load();if(!state.pending)failure('NO_PENDING_OPERATION');
    try{
      settleEngine();const operation=state.pending;
      // Recheck the entire reviewed write set before resuming any publication.
      for(const change of operation.changes){const hash=current(change.path).hash;if(hash!==change.beforeHash&&hash!==change.afterHash)failure('ROLLBACK_CONFLICT');}
      while(state.pending.index<state.pending.changes.length){
        hooks.checkCancelled?.();const operation=state.pending,index=operation.index,change=operation.changes[operation.direction==='rollback'?operation.changes.length-index-1:index];
        const target=operation.direction==='rollback'?change.beforeHash:change.afterHash,expected=operation.direction==='rollback'?change.afterHash:change.beforeHash;
        const paths=await drafts();if(draftAffected(paths,change.path))failure('DRAFT_CONFLICT');
        let observed=current(change.path);if(observed.hash!==expected&&observed.hash!==target)failure('ROLLBACK_CONFLICT');
        if(observed.hash!==target){
          ensureParents(change.path);observed=current(change.path);if(observed.hash!==expected)failure('STALE_PLAN');
          const request={schemaVersion:3,requestId:randomUUID(),target:{kind:'source',spaceId:transportId},expected:{files:[{path:change.path,hash:expected}]},input:{files:[{path:change.path,bytes:target===null?null:blob(target)}],assets:[],directories:[]}};
          const plan=prepareFileTransaction(request);adapter.preflight(plan);hooks.at?.('exchange-before-step',{operationId:operation.operationId,index,path:change.path});
          const result=adapter.apply(plan,{at:hooks.transactionAt});if(!['completed','no-op'].includes(result.status))failure('RECOVERY_REQUIRED');
          if(current(change.path).hash!==target)failure('RECOVERY_REQUIRED');
        }
        hooks.at?.(operation.direction==='rollback'?'exchange-after-rollback-step':'exchange-after-step',{operationId:operation.operationId,index,path:change.path});
        persist({...state,pending:{...state.pending,index:index+1}});
      }
      const complete={...state.pending,phase:state.pending.direction==='rollback'?'rolled-back':'completed'};
      for(const entry of complete.changes)if(current(entry.path).hash!==(complete.direction==='rollback'?entry.beforeHash:entry.afterHash))failure('RECOVERY_REQUIRED');
      persist({...state,registration:complete.direction==='rollback'?complete.before:complete.after,pending:null,operations:[...state.operations.filter(item=>item.operationId!==complete.operationId),complete].slice(-EXCHANGE_LIMITS.operations)});
      hooks.at?.('exchange-after-complete',{operationId:complete.operationId});return {status:complete.phase,operationId:complete.operationId,changedPaths:complete.changes.map(change=>change.path),createdDirectories:complete.createdDirectories};
    }catch(error){if(state.pending){try{persist({...state,pending:{...state.pending,phase:'interrupted'}});}catch{}}throw Object.assign(new Error(error.code??'RECOVERY_REQUIRED'),{code:error.code??'RECOVERY_REQUIRED',operationId:state.pending?.operationId,recoveryRequired:Boolean(state.pending),cause:error});}
  }
  async function recover({operationId,direction='resume'}={}){
    load();if(!state.pending)failure('NO_PENDING_OPERATION');if(operationId&&state.pending.operationId!==operationId)failure('STALE_PLAN');if(!['resume','rollback'].includes(direction))failure('INVALID_REQUEST');
    if(direction==='rollback'&&state.pending.direction!=='rollback')persist({...state,pending:{...state.pending,direction:'rollback',phase:'pending',index:0}});
    return finish();
  }
  async function rollback({operationId}){
    ready();const operation=state.operations.at(-1);if(!operation||operation.operationId!==operationId||operation.phase!=='completed')failure('ROLLBACK_UNAVAILABLE');
    if(JSON.stringify(state.registration)!==JSON.stringify(operation.after))failure('ROLLBACK_CONFLICT');
    const paths=await drafts();for(const entry of operation.changes){if(current(entry.path).hash!==entry.afterHash)failure('ROLLBACK_CONFLICT');if(draftAffected(paths,entry.path))failure('DRAFT_CONFLICT');}
    persist({...state,pending:{...operation,direction:'rollback',phase:'pending',index:0}});hooks.at?.('exchange-after-rollback-intent',{operationId});return finish();
  }
  async function reviewExport({collectionId,version}={}){
    ready();collectionId??=state.registration?.collectionId??'local-collection';version??=state.registration?.version??'1';if(!validLabel(collectionId)||!validLabel(version))failure('INVALID_PACKAGE');
    const all=inventory().filter(file=>file.path!==PACKAGE_MANIFEST),{files,excluded}=selectExportFiles(all),draftPaths=await drafts();
    if(!files.length)failure('EMPTY_PACKAGE');
    const analysis=renderOffline?.({files:files.map(file=>({path:file.path,bytes:file.bytes})),analyzeOnly:true})??{warnings:[{code:'READER_UNAVAILABLE',message:'Offline reader is unavailable in this host.'}]};
    return remember({kind:'export',planId:randomUUID(),expiresAt:Date.now()+EXCHANGE_LIMITS.reviewMs,collectionId,version,files,excluded,inventoryHash:inventoryHash(all),drafts:draftPaths,warnings:[...excluded.map(entry=>({path:entry.path,code:'SUSPECTED_CREDENTIAL_EXCLUDED',message:'Excluded by a credential filename rule. This rule does not scan file contents for secrets.'})),...(draftPaths.length?[{code:'DRAFTS_EXCLUDED',message:'Private drafts are excluded. Only saved bytes are exported.'}]:[]),...(analysis.warnings??[])],rows:files.map(file=>({path:file.path,sha256:file.hash,bytes:file.bytes.length}))});
  }
  async function buildExport({planId,kind='source'}){
    const review=reviewById(planId,'export');if(!['source','offline'].includes(kind))failure('INVALID_REQUEST');const currentDrafts=await drafts(),all=inventory().filter(file=>file.path!==PACKAGE_MANIFEST),{files,excluded}=selectExportFiles(all);
    if(inventoryHash(all)!==review.inventoryHash||draftHash(currentDrafts)!==draftHash(review.drafts))failure('STALE_PLAN');
    const manifest={format:'asMagicBrain-package',schemaVersion:1,collectionId:review.collectionId,version:review.version,semantics:'snapshot',files:keyList(files),...(excluded.length?{excluded}:{})};
    let output=[...files,{path:PACKAGE_MANIFEST,bytes:Buffer.from(JSON.stringify(manifest,null,2)+'\n')}];
    if(kind==='offline'){if(!renderOffline)failure('READER_UNAVAILABLE');const reader=renderOffline({files:files.map(file=>({path:file.path,bytes:file.bytes})),analyzeOnly:false});output=[...output.map(file=>({path:`source/${file.path}`,bytes:file.bytes})),...reader.files];}
    const bytes=createPackageZip(output);return {schemaVersion:1,kind,bytes,sha256:sha256(bytes),filename:`${review.collectionId}-${review.version}-${kind}.zip`,fileCount:files.length,warnings:review.warnings};
  }
  function status(){load();return {schemaVersion:1,registration:state.registration?{collectionId:state.registration.collectionId,version:state.registration.version,ownedFiles:state.registration.files.length}:null,recoveryRequired:Boolean(state.pending)||adapter.inspectRecovery().blocked,pending:state.pending?{operationId:state.pending.operationId,direction:state.pending.direction,phase:state.pending.phase,completed:state.pending.index,total:state.pending.changes.length,paths:state.pending.changes.map(change=>change.path)}:null,operations:state.operations.map(operation=>({operationId:operation.operationId,status:operation.phase,version:operation.after.version,createdAt:operation.createdAt,paths:operation.changes.map(change=>change.path),canRollback:operation===state.operations.at(-1)&&operation.phase==='completed'})),limits:EXCHANGE_LIMITS};}
  load();return Object.freeze({registrationReview,registerBase,reviewUpdate,apply,rollback,recover,status,reviewExport,buildExport,cancelPlan(planId){return {status:reviews.delete(planId)?'cancelled':'absent'};}});
}
