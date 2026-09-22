import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createPrivateStore} from '../../packages/desktop-host/src/private-store.mjs';
import {createNodeFilesystem} from '../../packages/source-foundation/src/adapters/node-filesystem.mjs';
import {persistentIdentity,runWithStorageIdentity} from '../../packages/source-foundation/src/adapters/storage-identity.mjs';
import {isPortableRelativePath,portablePathKey} from '../../packages/source-foundation/src/domain/path-policy.mjs';
import {canonicalGitHubUrl} from '../../packages/desktop-host/src/local-git/github-clone.mjs';
import {verifyManagedTrashBacking} from '../../packages/desktop-host/src/repository-runtime/file-management.mjs';
import {hasPreviewDataOwnership} from './profile-paths.mjs';

const LIMITS=Object.freeze({entries:100000,depth:64,hashBytes:128*1024*1024,fileBytes:64*1024*1024,jsonBytes:4*1024*1024});
const HOST_FIELDS=['schemaVersion','ownerId','phase','roots','workspaceIdentity','appearance','workspaceName','repositoryBindings','pendingRename'];
const LEGACY_HOST_FIELDS=['schemaVersion','ownerId','phase','roots','workspaceIdentity','appearance'];
const THEMES=new Set(['light-default','light-high-contrast','light-colorblind','dark-default','dark-high-contrast','dark-colorblind','dark-dimmed','light','dark']);
const sha=value=>createHash('sha256').update(value).digest('hex');
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const identity=value=>typeof value==='string'&&/^\d+:\d+$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const repoName=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)&&isPortableRelativePath(value);
const instant=value=>typeof value==='string'&&(()=>{try{return new Date(value).toISOString()===value;}catch{return false;}})();
const unsafe=cause=>{throw Object.assign(new Error('STORAGE_RECOVERY_UNSAFE'),{code:'STORAGE_RECOVERY_UNSAFE',cause});};
const requireSafe=(condition,message='unsafe storage')=>{if(!condition)throw new Error(message);};
const exists=filename=>{try{return fs.lstatSync(filename,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const raw=stat=>({dev:stat.dev.toString(),ino:stat.ino.toString(),uid:Number(stat.uid),gid:Number(stat.gid),mode:Number(stat.mode&0o7777n),nlink:Number(stat.nlink),size:Number(stat.size),mtimeNs:stat.mtimeNs.toString(),ctimeNs:stat.ctimeNs.toString()});

function safeRead(filename,limit=LIMITS.jsonBytes){
 const named=fs.lstatSync(filename,{bigint:true});requireSafe(named.isFile()&&!named.isSymbolicLink()&&named.nlink===1n&&named.size<=BigInt(limit));
 const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{
  const before=fs.fstatSync(fd,{bigint:true});requireSafe(before.dev===named.dev&&before.ino===named.ino&&before.size===named.size);
  const bytes=Buffer.alloc(Number(before.size)+1);let offset=0;
  while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)break;offset+=count;}
  const after=fs.fstatSync(fd,{bigint:true}),live=fs.lstatSync(filename,{bigint:true});
  requireSafe(offset===Number(before.size)&&['dev','ino','size','mtimeNs','ctimeNs','mode','nlink'].every(key=>before[key]===after[key]&&after[key]===live[key]));
  return {bytes:bytes.subarray(0,offset),stat:before};
 }finally{fs.closeSync(fd);}
}

function inspectInContext(dataRoot,context){
 requireSafe(typeof dataRoot==='string'&&dataRoot===context.root&&path.isAbsolute(dataRoot)&&path.normalize(dataRoot)===dataRoot&&fs.realpathSync(dataRoot)===dataRoot);
 requireSafe(typeof process.getuid==='function'&&process.getuid()===context.owner);
 const fingerprint=[],seen=new Set();let entries=0,hashed=0;
 const relative=filename=>path.relative(dataRoot,filename)||'.';
 function admit(filename,{type,privatePath=false,hashFile=false,maxBytes=LIMITS.fileBytes,record=true}={}){
  requireSafe(path.isAbsolute(filename)&&filename===path.normalize(filename)&&(!seen.has(filename)||!record));
  const stat=fs.lstatSync(filename,{bigint:true});entries++;requireSafe(entries<=LIMITS.entries&&stat.dev===BigInt(context.currentDevice)&&stat.uid===BigInt(context.owner)&&!stat.isSymbolicLink());
  if(type==='directory')requireSafe(stat.isDirectory());else if(type==='file')requireSafe(stat.isFile()&&stat.nlink===1n);else requireSafe(stat.isDirectory()||stat.isFile());
  if(privatePath){if(stat.isDirectory())requireSafe((stat.mode&0o022n)===0n);else requireSafe((stat.mode&0o022n)===0n&&(stat.mode&0o111n)===0n);}
  let fileHash=null;
  if(hashFile&&stat.isFile()){
   requireSafe(stat.size<=BigInt(maxBytes)&&hashed+Number(stat.size)<=LIMITS.hashBytes);const read=safeRead(filename,maxBytes);requireSafe(read.stat.dev===stat.dev&&read.stat.ino===stat.ino);fileHash=sha(read.bytes);hashed+=read.bytes.length;
  }
  if(record){seen.add(filename);fingerprint.push({path:relative(filename),type:stat.isDirectory()?'directory':'file',rawStat:raw(stat),persistentIdentity:persistentIdentity(stat),sha256:fileHash});}
  return stat;
 }
 function walk(directory,{privatePath=false,recordFiles=true,recordDirectories=true,hashFiles=true,skipHash=()=>false,skipDirectory=()=>false,visit=()=>{}}={},depth=0){
  requireSafe(depth<=LIMITS.depth);admit(directory,{type:'directory',privatePath,record:!seen.has(directory)});
  const opened=fs.opendirSync(directory);const names=[];try{for(let entry=opened.readSync();entry;entry=opened.readSync()){names.push(entry.name);requireSafe(names.length<=10000);}}finally{opened.closeSync();}
  for(const name of names.sort()){
   requireSafe(name!=='.'&&name!=='..'&&!name.includes('/')&&!name.includes('\0'));const filename=path.join(directory,name),stat=fs.lstatSync(filename,{bigint:true});
   requireSafe(stat.dev===BigInt(context.currentDevice)&&stat.uid===BigInt(context.owner)&&!stat.isSymbolicLink()&&(stat.isDirectory()||stat.isFile())&&(!stat.isFile()||stat.nlink===1n));visit(filename,name,stat);
   if(stat.isDirectory()){if(skipDirectory(filename,name,stat))continue;admit(filename,{type:'directory',privatePath,record:recordDirectories&&!seen.has(filename)});walk(filename,{privatePath,recordFiles,recordDirectories,hashFiles,skipHash,skipDirectory,visit},depth+1);}
   else admit(filename,{type:'file',privatePath,record:recordFiles,hashFile:hashFiles&&!skipHash(filename),maxBytes:LIMITS.fileBytes});
  }
 }
 function json(filename,limit=LIMITS.jsonBytes){const {bytes}=safeRead(filename,limit);let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(error){throw new Error('invalid JSON',{cause:error});}return value;}
 function scanStore(directory,bindingHash,{optional=false,validate=()=>true,latest=()=>true}={}){
  const stat=exists(directory);if(!stat){requireSafe(optional);return null;}admit(directory,{type:'directory',privatePath:true,record:!seen.has(directory)});
  const scan=createPrivateStore({privateRoot:directory,bindingHash}).scan();requireSafe(!scan.blocked&&scan.events.every(event=>validate(event.payload,event)));
  const value=scan.events.at(-1)?.payload??null;requireSafe(latest(value,scan));return {scan,value};
 }

 const rootStat=admit(dataRoot,{type:'directory',privatePath:true}),rootIdentity=persistentIdentity(rootStat);
 requireSafe(rootStat.ino.toString()===context.rootInode);
 const rootNames=fs.readdirSync(dataRoot).sort();
 requireSafe(rootNames.every(name=>['.asmagicbrain-channel.json','.asmb-native.lock','.asmb-storage-volume.json','.asmb-storage-volume.pending','state','workspaces'].includes(name))&&rootNames.includes('state')&&rootNames.includes('workspaces'));
 requireSafe(!rootNames.includes('.asmagicbrain-channel.json')||hasPreviewDataOwnership(dataRoot));
 for(const name of rootNames.filter(name=>name.startsWith('.asmb-')||name==='.asmagicbrain-channel.json')){
  const stat=fs.lstatSync(path.join(dataRoot,name),{bigint:true});requireSafe(stat.dev===BigInt(context.currentDevice)&&stat.uid===BigInt(context.owner)&&stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1n&&(stat.mode&0o022n)===0n&&(stat.mode&0o111n)===0n&&stat.size<=16384n);
 }
 const workspaces=path.join(dataRoot,'workspaces'),organization=path.join(workspaces,'asMagicBrain'),state=path.join(dataRoot,'state'),native=path.join(state,'native'),host=path.join(native,'.asmb-host');
 for(const directory of [workspaces,organization,state,native,host]){const stat=admit(directory,{type:'directory',privatePath:true});requireSafe((stat.mode&0o777n)===0o700n);}
 requireSafe(fs.readdirSync(workspaces).every(name=>name==='asMagicBrain'));
 const hostBindingHash=sha(JSON.stringify({kind:'native-profile',schemaVersion:1,path:dataRoot,identity:rootIdentity,uid:process.getuid()}));
 const roots={organization:persistentIdentity(fs.lstatSync(organization)),state:persistentIdentity(fs.lstatSync(native))};
 const appearance=value=>exact(value,['themeId','hideUnavailable'])&&(value.themeId===null||THEMES.has(value.themeId))&&typeof value.hideUnavailable==='boolean';
 const binding=value=>exact(value,['name','identity','stateKey','bindingName'])&&repoName(value.name)&&identity(value.identity)&&repoName(value.bindingName)&&typeof value.stateKey==='string'&&(repoName(value.stateKey)||/^\.asmb-repo-[a-f0-9-]{36}$/.test(value.stateKey));
 function rename(value,bindings,workspaceName){return value===null||exact(value,['repository','name','identity','isDefault','reservationIdentity'])&&repoName(value.repository)&&repoName(value.name)&&portablePathKey(value.repository)!==portablePathKey(value.name)&&identity(value.identity)&&typeof value.isDefault==='boolean'&&(value.reservationIdentity===null||identity(value.reservationIdentity))&&bindings.some(item=>item.name===value.repository&&item.identity===value.identity)&&value.isDefault===(value.repository===workspaceName);}
 function hostRecord(value,{historical=false}={}){
  if(exact(value,LEGACY_HOST_FIELDS))return historical&&value.schemaVersion===1&&typeof value.ownerId==='string'&&uuid(value.ownerId)&&['initializing','ready'].includes(value.phase)&&exact(value.roots,['organization','state'])&&JSON.stringify(value.roots)===JSON.stringify(roots)&&(value.workspaceIdentity===null||identity(value.workspaceIdentity))&&appearance(value.appearance);
  if(!exact(value,HOST_FIELDS)||![2,3,4].includes(value.schemaVersion)||!uuid(value.ownerId)||!['initializing','ready'].includes(value.phase)||!exact(value.roots,['organization','state'])||JSON.stringify(value.roots)!==JSON.stringify(roots)||(value.workspaceIdentity!==null&&!identity(value.workspaceIdentity))||!appearance(value.appearance)||!repoName(value.workspaceName)||!Array.isArray(value.repositoryBindings)||value.repositoryBindings.length>1000||!value.repositoryBindings.every(binding)||!rename(value.pendingRename,value.repositoryBindings,value.workspaceName))return false;
  return new Set(value.repositoryBindings.map(item=>portablePathKey(item.name))).size===value.repositoryBindings.length&&new Set(value.repositoryBindings.map(item=>portablePathKey(item.stateKey))).size===value.repositoryBindings.length;
 }
 const hostStore=scanStore(host,hostBindingHash,{validate:value=>hostRecord(value,{historical:true}),latest:value=>hostRecord(value)&&value.phase==='ready'&&value.pendingRename===null});
 requireSafe(hostStore?.value);const record=hostStore.value;

 // Authenticate every state byte before interpreting optional ledgers. Git
 // object files are stat-pinned but deliberately not hashed.
 walk(native,{privatePath:true,recordFiles:true,hashFiles:true,skipHash:filename=>filename.split(path.sep).includes('objects')});

 const docsRoot=path.join(native,'.asmb-bundled-docs'),managementRoot=path.join(native,'.asmb-repository-management'),pinsRoot=path.join(native,'.asmb-repository-pins');
 const activeDocs=new Map(),previousDocs=new Map(),managedTrash=new Map();
 const activeValid=value=>value&&repoName(value.name)&&identity(value.identity)&&digest(value.digest)&&typeof value.version==='string'&&/^[a-f0-9]{40}$/.test(value.head)&&Array.isArray(value.files)&&value.files.length<=1000;
 const docsPending=value=>value===null||value&&exact(value,['next','stage','backup','backupReservation','targetReservation'])&&activeValid(value.next)&&/^\.asmb-docs-stage-[a-f0-9-]{36}$/.test(value.stage)&&/^\.asmb-docs-preserved-[a-f0-9-]{36}$/.test(value.backup)&&(value.backupReservation===null||identity(value.backupReservation))&&(value.targetReservation===null||identity(value.targetReservation));
 const docsValid=value=>exact(value,['schemaVersion','ownerId','active','previous','pending'])&&value.schemaVersion===1&&uuid(value.ownerId)&&(value.active===null||activeValid(value.active))&&Array.isArray(value.previous)&&value.previous.length<=1000&&value.previous.every(activeValid)&&docsPending(value.pending);
 const docs=scanStore(docsRoot,sha(hostBindingHash+':bundled-docs:1'),{optional:true,validate:docsValid,latest:value=>value===null||docsValid(value)&&value.pending===null});
 if(docs?.value?.active){activeDocs.set(docs.value.active.name,docs.value.active);for(const item of docs.value.previous)previousDocs.set(item.identity,item);}
 const managementBinding=sha(hostBindingHash+':repository-management:1');
 const managedEntry=value=>exact(value,['trashId','name','trashedAt','binding'])&&uuid(value.trashId)&&repoName(value.name)&&typeof value.trashedAt==='string'&&!Number.isNaN(Date.parse(value.trashedAt))&&new Date(value.trashedAt).toISOString()===value.trashedAt&&binding(value.binding)&&value.binding.name===value.name;
 const managedPending=value=>value===null||exact(value,['kind','entry','name','reservationIdentity'])&&['trash','restore'].includes(value.kind)&&managedEntry(value.entry)&&repoName(value.name)&&(value.reservationIdentity===null||identity(value.reservationIdentity));
 const managedValid=value=>exact(value,['schemaVersion','entries','pending','restored'])&&value.schemaVersion===1&&Array.isArray(value.entries)&&value.entries.length<=1000&&value.entries.every(managedEntry)&&new Set(value.entries.map(item=>item.trashId)).size===value.entries.length&&new Set(value.entries.map(item=>item.binding.stateKey)).size===value.entries.length&&Array.isArray(value.restored)&&value.restored.length<=1000&&value.restored.every(item=>exact(item,['trashId','name','identity'])&&uuid(item.trashId)&&repoName(item.name)&&identity(item.identity))&&managedPending(value.pending);
 const managed=scanStore(managementRoot,managementBinding,{optional:true,validate:managedValid,latest:value=>value===null||managedValid(value)&&value.pending===null});
 if(managed?.value)for(const item of managed.value.entries){requireSafe(item&&uuid(item.trashId)&&repoName(item.name)&&binding(item.binding)&&item.binding.name===item.name);managedTrash.set(item.trashId,item);}
 scanStore(pinsRoot,sha(hostBindingHash+':repository-pins:1'),{optional:true,validate:value=>exact(value,['schemaVersion','keys'])&&value.schemaVersion===1&&Array.isArray(value.keys)&&value.keys.length<=1000&&value.keys.every(key=>typeof key==='string'&&key.length>0&&key.length<=255)&&new Set(value.keys).size===value.keys.length});

 const catalogRoot=path.join(organization,'.asmb-catalog'),catalogStat=exists(catalogRoot);if(catalogStat)walk(catalogRoot,{privatePath:true,recordFiles:true,hashFiles:true});
 const catalogRecords=new Map(),readyRecords=new Map(),reservationRecords=new Map(),retiredRecords=new Map();
 function validCatalog(value){
  if(!value||!repoName(value.name)||!identity(value.identity)||!Number.isSafeInteger(value.files)||value.files<0||!Number.isSafeInteger(value.bytes)||value.bytes<0)return false;
  if(value.schemaVersion===1)return exact(value,['schemaVersion','name','identity','head','archiveSha256','files','bytes','excludedEntries','importedAt'])&&/^[a-f0-9]{40}$/.test(value.head)&&digest(value.archiveSha256)&&Number.isSafeInteger(value.excludedEntries)&&value.excludedEntries>=0&&instant(value.importedAt);
  const common=uuid(value.creationId)&&uuid(value.stageId)&&repoName(value.requestName)&&instant(value.createdAt);
  if(value.schemaVersion===2)return common&&exact(value,['schemaVersion','source','creationId','stageId','requestName','name','identity','head','files','bytes','createdAt'])&&value.source==='local'&&value.head===null&&value.files===0&&value.bytes===0;
  if(value.schemaVersion===3)return common&&exact(value,['schemaVersion','source','creationId','stageId','requestName','name','identity','head','branch','sourceUrl','files','bytes','createdAt'])&&value.source==='github'&&(value.head===null||/^[a-f0-9]{40}$/.test(value.head))&&typeof value.branch==='string'&&value.branch.length>0&&value.branch.length<1024&&(()=>{try{return canonicalGitHubUrl(value.sourceUrl)===value.sourceUrl;}catch{return false;}})();
  return value.schemaVersion===4&&common&&exact(value,['schemaVersion','source','copySourceIdentity','copySourceName','creationId','stageId','requestName','name','identity','head','files','bytes','createdAt'])&&value.source==='local-copy'&&identity(value.copySourceIdentity)&&repoName(value.copySourceName)&&(value.head===null||/^[a-f0-9]{40}$/.test(value.head));
 }
 if(catalogStat)for(const name of fs.readdirSync(catalogRoot)){
  const filename=path.join(catalogRoot,name);requireSafe(fs.lstatSync(filename).isFile());
  if(name==='import.lock'||name.startsWith('upload-'))throw new Error('unresolved import');
  const value=json(filename,16384);
  if(name.endsWith('.repo.json')){requireSafe(validCatalog(value)&&name===`${value.name}.repo.json`);catalogRecords.set(value.name,value);}
  else if(/^trash-[a-f0-9-]{36}\.json$/.test(name)){requireSafe(value.schemaVersion===1&&uuid(value.trashId)&&validCatalog(value.record));retiredRecords.set(value.trashId,value);}
  else if(/^[a-f0-9-]{36}\.ready\.json$/.test(name)){requireSafe(validCatalog(value));readyRecords.set(name.slice(0,-11),value);}
  else if(/^[a-f0-9-]{36}\.reservation\.json$/.test(name)){requireSafe(exact(value,['schemaVersion','name','identity'])&&value.schemaVersion===1&&repoName(value.name)&&identity(value.identity));reservationRecords.set(name.slice(0,-17),value);}
  else throw new Error('unknown catalog metadata');
 }
 for(const [id,value] of readyRecords){const admitted=[...catalogRecords.values(),...retiredRecords.values()].map(item=>item.record??item).find(item=>item.identity===value.identity&&(item.creationId===value.creationId||item.name===value.name));requireSafe(admitted);if(reservationRecords.has(id))requireSafe(reservationRecords.get(id).name===value.name);}
 for(const id of reservationRecords.keys())requireSafe(readyRecords.has(id));

 const organizationStat=admit(organization,{type:'directory',privatePath:true,record:false}),allowed=new Set(['.asmb-catalog']);
 requireSafe(organizationStat.dev===rootStat.dev);
 function inspectSource(source){
  const sourceGit=path.join(source,'.git');requireSafe(exists(sourceGit));const gitIdentity=persistentIdentity(admit(sourceGit,{type:'directory',record:true}));
  walk(sourceGit,{recordFiles:true,hashFiles:true,skipHash:filename=>filename.split(path.sep).includes('objects')||fs.lstatSync(filename,{bigint:true}).size>BigInt(LIMITS.fileBytes),visit:(filename,name)=>{
   const relativeGit=path.relative(sourceGit,filename).split(path.sep).join('/');requireSafe(!name.endsWith('.lock')&&!['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','BISECT_START'].includes(name)&&!relativeGit.startsWith('rebase-apply/')&&!relativeGit.startsWith('rebase-merge/')&&!relativeGit.startsWith('sequencer/'));
  }});
  // User content contributes raw stat metadata only. Backup owns content bytes.
  walk(source,{recordFiles:true,recordDirectories:true,hashFiles:false,skipDirectory:filename=>filename===sourceGit,visit:(filename,name)=>{if(filename===sourceGit)return;requireSafe(!/^\.asmb-(?:new|old)-/.test(name));}});return gitIdentity;
 }
 function inspectBinding(item,source,provenance){
  const sourceStat=admit(source,{type:'directory',record:true}),sourceIdentity=persistentIdentity(sourceStat);requireSafe(sourceIdentity===item.identity);
  const sourceBindingRoot=path.join(organization,item.bindingName),privateRoot=path.join(native,item.stateKey),privateStat=exists(privateRoot);
  if(privateStat){
   admit(privateRoot,{type:'directory',privatePath:true,record:false});requireSafe((privateStat.mode&0o777n)===0o700n);
   const runtimeBinding={schemaVersion:1,localOwnerId:record.ownerId,localRootId:'native',checkoutId:item.bindingName,sourceRoot:sourceBindingRoot,sourceIdentity};
   const runtimeHash=sha(JSON.stringify(runtimeBinding));
   const runtimeValid=value=>{
    const fields=value&&Object.hasOwn(value,'recoveredDrafts')?['schemaVersion','binding','documents','drafts','trash','recoveredDrafts','pending']:['schemaVersion','binding','documents','drafts','trash','pending'];
    if(!exact(value,fields)||value.schemaVersion!==1||JSON.stringify(value.binding)!==JSON.stringify(runtimeBinding)||!Array.isArray(value.documents)||value.documents.length>10000||!Array.isArray(value.drafts)||!Array.isArray(value.trash)||Object.hasOwn(value,'recoveredDrafts')&&!Array.isArray(value.recoveredDrafts))return false;
    return value.documents.every(entry=>exact(entry,['path','documentId'])&&typeof entry.path==='string'&&typeof entry.documentId==='string')&&value.drafts.every(entry=>exact(entry,['documentId','baseHash','text'])&&typeof entry.documentId==='string'&&digest(entry.baseHash)&&typeof entry.text==='string');
   };
   let runtimeValue=null;const records=path.join(privateRoot,'files','records');if(exists(records)){const runtime=scanStore(records,runtimeHash,{validate:runtimeValid,latest:value=>value===null||runtimeValid(value)&&value.pending===null});requireSafe(runtime);runtimeValue=runtime.value;}
   const drafts=path.join(privateRoot,'new-drafts');if(exists(drafts))scanStore(drafts,sha(JSON.stringify({sourceRoot:sourceBindingRoot,identity:sourceIdentity})),{validate:value=>Array.isArray(value)&&value.length<=32&&value.every(draft=>exact(draft,['draftId','path','text'])&&typeof draft.draftId==='string'&&typeof draft.path==='string'&&typeof draft.text==='string')});
   const gitPrivate=path.join(privateRoot,'git');if(exists(gitPrivate)){
    admit(gitPrivate,{type:'directory',privatePath:true,record:false});const names=fs.readdirSync(gitPrivate);requireSafe(!names.includes('pending.json'));
    if(names.length){requireSafe(names.includes('binding.json'));const gitBinding=json(path.join(gitPrivate,'binding.json'),8192);requireSafe(JSON.stringify(gitBinding)===JSON.stringify({sourceRoot:sourceBindingRoot,sourceIdentity}));}
   }
   const recovery=path.join(privateRoot,'files','recovery');if(exists(recovery)){
    const key=runtimeHash.slice(0,32),transportId=`${key.slice(0,8)}-${key.slice(8,12)}-4${key.slice(13,16)}-8${key.slice(17,20)}-${key.slice(20,32)}`;
    // Construction only pins the supplied roots; inspectRecovery is the
    // adapter's read-only canonical decoder and never repairs or retires data.
    const recoveryState=createNodeFilesystem({repositoryRoot:source,recoveryRoot:recovery,spaceRoot:'.',spaceId:transportId}).inspectRecovery();requireSafe(!recoveryState.blocked);
    const receipts=path.join(recovery,'receipts.json');if(exists(receipts)){const value=json(receipts,1024*1024);requireSafe(Array.isArray(value.retiring)&&value.retiring.length===0);}
   }
   const managedContent=path.join(privateRoot,'files','managed-content'),managedTrashEntries=runtimeValue?.trash.filter(entry=>entry?.format==='tree-v1')??[];
   if(exists(managedContent)){requireSafe(!fs.readdirSync(managedContent).some(name=>name.startsWith('.operation-')));for(const entry of managedTrashEntries)verifyManagedTrashBacking({privateRoot:managedContent,entry});}
   else requireSafe(managedTrashEntries.length===0);
  }
  const gitIdentity=inspectSource(source);
  if(privateStat){
   const updatesRoot=path.join(privateRoot,'github-updates');if(exists(updatesRoot)){
    requireSafe(provenance?.source==='github'&&typeof provenance.sourceUrl==='string'&&typeof provenance.branch==='string');
    const updateBinding=sha(JSON.stringify({sourceRoot:sourceBindingRoot,identity:sourceIdentity,url:provenance.sourceUrl,branch:provenance.branch}));
    const locator=value=>exact(value,['id','identity'])&&uuid(value.id)&&identity(value.identity),latestValue=value=>exact(value,['id','identity','hash'])&&locator({id:value.id,identity:value.identity})&&digest(value.hash);
    const updateValid=value=>exact(value,['schemaVersion','latest','pending','cleanup','seen'])&&value.schemaVersion===1&&(value.latest===null||latestValue(value.latest))&&(value.pending===null||locator(value.pending))&&Array.isArray(value.cleanup)&&value.cleanup.length<=4&&value.cleanup.every(locator)&&Array.isArray(value.seen)&&value.seen.length<=64&&value.seen.every(uuid);
    const updates=scanStore(path.join(updatesRoot,'journal'),updateBinding,{validate:updateValid,latest:value=>updateValid(value)&&value.pending===null&&value.cleanup.length===0});
    const latest=updates.value.latest,snapshots=path.join(updatesRoot,'snapshots'),snapshotNames=fs.readdirSync(snapshots).sort();requireSafe(latest?snapshotNames.length===1&&snapshotNames[0]===latest.id:snapshotNames.length===0);
    if(latest){const snapshot=path.join(snapshots,latest.id),stat=admit(snapshot,{type:'directory',privatePath:true,record:false});requireSafe(persistentIdentity(stat)===latest.identity);const result=safeRead(path.join(snapshot,'result.json'),16*1024*1024);requireSafe(sha(result.bytes)===latest.hash);const value=JSON.parse(result.bytes);requireSafe(value.checkId===latest.id&&value.sourceUrl===provenance.sourceUrl&&value.branch===provenance.branch&&Array.isArray(value.entries));}
   }
   const applyRoot=path.join(privateRoot,'github-apply');if(exists(applyRoot)){
    const applyBinding=sha(JSON.stringify({root:sourceBindingRoot,identity:sourceIdentity,git:gitIdentity}));
    scanStore(path.join(applyRoot,'journal'),applyBinding,{validate:value=>value&&value.schemaVersion===1&&Object.hasOwn(value,'pending')&&Object.hasOwn(value,'cleanup')&&Array.isArray(value.receipts),latest:value=>value&&value.pending===null&&value.cleanup===null});
   }
  }
 }
 for(const item of record.repositoryBindings){
  const source=path.join(organization,item.name);allowed.add(item.name);const isDefault=item.name===record.workspaceName,isDocs=activeDocs.get(item.name)?.identity===item.identity;
  let provenance=null;if(!isDefault&&!isDocs){provenance=catalogRecords.get(item.name);requireSafe(provenance&&provenance.identity===item.identity);}inspectBinding(item,source,provenance);
 }
 for(const [name,value] of activeDocs){requireSafe(record.repositoryBindings.some(item=>item.name===name&&item.identity===value.identity));}
 for(const [id,item] of managedTrash){const hidden=`.asmb-repository-trash-${id}`,retired=retiredRecords.get(id);requireSafe(retired&&retired.record.identity===item.binding.identity);inspectBinding(item.binding,path.join(organization,hidden),retired.record);allowed.add(hidden);}
 for(const name of fs.readdirSync(organization))if(name.startsWith('.asmb-docs-preserved-')){const source=path.join(organization,name),stat=admit(source,{type:'directory',record:true});requireSafe(previousDocs.has(persistentIdentity(stat)));inspectSource(source);allowed.add(name);}
 for(const name of fs.readdirSync(organization)){requireSafe(allowed.has(name)&&!/^\.asmb-(?:import|docs-stage|new|old)-/.test(name));}
 for(const [name,value] of catalogRecords){requireSafe(record.repositoryBindings.some(item=>item.name===name&&item.identity===value.identity));}
 for(const [id,value] of retiredRecords){const managedEntry=managedTrash.get(id);requireSafe(managedEntry&&managedEntry.binding.identity===value.record.identity);}

 const settings=path.join(native,'.asmb-settings','commit-preferences');
 if(exists(settings)){
  const settingsBinding=sha(JSON.stringify({kind:'commit-preferences',schemaVersion:1,workspaceRoot:organization,workspaceIdentity:persistentIdentity(fs.lstatSync(organization)),localOwnerId:record.ownerId,uid:process.getuid()}));
  const label=value=>typeof value==='string'&&value.length<=256&&Buffer.byteLength(value)<=1024&&value.isWellFormed()&&!/[\x00-\x1f\x7f-\x9f<>]/u.test(value);
  const author=value=>exact(value,['name','email'])&&label(value.name)&&label(value.email)&&(value.email===''||/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value.email));
  scanStore(settings,settingsBinding,{validate:(value,event)=>exact(value,['revision','mode','asmagicbrain','github'])&&Number.isSafeInteger(value.revision)&&value.revision>=0&&value.revision===event.sequence-1&&['asmagicbrain','github','manual'].includes(value.mode)&&author(value.asmagicbrain)&&author(value.github)});
 }
 fingerprint.sort((a,b)=>a.path.localeCompare(b.path));
 const fingerprintValue={schemaVersion:1,volumeId:context.volumeId,currentDevice:context.currentDevice,namespaceDevice:context.namespaceDevice,rootInode:context.rootInode,entries:fingerprint,sha256:sha(JSON.stringify(fingerprint))};
 return {hostRecord:structuredClone(record),hostBindingHash,fingerprint:fingerprintValue};
}

/** Read-only admission of an existing native profile before backup/rebinding.
 * Unknown layouts and bounded-walk overflows are intentionally unsupported. */
export function inspectLegacyStorage({dataRoot,context}={}){
 try{
  requireSafe(typeof dataRoot==='string'&&context&&typeof context==='object');
  return runWithStorageIdentity(context,()=>inspectInContext(dataRoot,context));
 }catch(error){if(error?.code==='STORAGE_RECOVERY_UNSAFE')throw error;unsafe(error);}
}
