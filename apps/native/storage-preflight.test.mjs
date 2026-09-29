import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createNativeService,acquireNativeProfileLock} from './host-service.mjs';
import {inspectLegacyStorage} from './storage-preflight.mjs';
import {createBundledDocsManifest} from './bundled-docs-manifest.mjs';
import {persistentIdentity,runWithStorageIdentity} from '../../packages/source-foundation/src/adapters/storage-identity.mjs';

const testRoot=process.env.ASMB_TEST_ROOT;
if(!testRoot||!path.isAbsolute(testRoot))throw new Error('storage-preflight tests require an absolute ASMB_TEST_ROOT');
const sha=value=>createHash('sha256').update(value).digest('hex');
const gitEnvironment={PATH:'/usr/bin:/bin',TMPDIR:process.env.TMPDIR,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_COUNT:'0',GIT_TERMINAL_PROMPT:'0'};

function fixture(t){
 const runRoot=path.join(testRoot,'runs','storage-preflight');fs.mkdirSync(runRoot,{recursive:true,mode:0o700});
 const parent=fs.mkdtempSync(path.join(runRoot+path.sep,'fixture-'));
 fs.chmodSync(parent,0o700);const dataRoot=path.join(parent,'profile');fs.mkdirSync(dataRoot,{mode:0o700});
 const root=fs.lstatSync(dataRoot,{bigint:true}),currentDevice=Number(root.dev);assert.equal(Number.isSafeInteger(currentDevice),true);
 const namespaceDevice=currentDevice===Number.MAX_SAFE_INTEGER?currentDevice-1:currentDevice+1;
 const context={schemaVersion:1,root:dataRoot,rootInode:root.ino.toString(),owner:process.getuid(),currentDevice,namespaceDevice,volumeId:'fixture-volume'};
 t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 return {parent,dataRoot,context,source:path.join(dataRoot,'workspaces/asMagicBrain/Workspace')};
}

async function initialized(t,hooks){
 const value=fixture(t),service=await createNativeService({...value,storageIdentity:value.context,hooks});
 await service.close();return value;
}

const request=(service,repo,operation,args={})=>service.request({repo,operation,args});
const git=(root,...args)=>execFileSync('/usr/bin/git',['--no-pager','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',root,...args],{env:gitEnvironment,encoding:'utf8'}).trim();

function snapshot(root){
 const entries=[];
 function walk(filename){
  const stat=fs.lstatSync(filename,{bigint:true}),relative=path.relative(root,filename)||'.';
  const item={path:relative,dev:stat.dev.toString(),ino:stat.ino.toString(),uid:stat.uid.toString(),gid:stat.gid.toString(),mode:(stat.mode&0o7777n).toString(),nlink:stat.nlink.toString(),size:stat.size.toString(),mtimeNs:stat.mtimeNs.toString(),ctimeNs:stat.ctimeNs.toString(),type:stat.isDirectory()?'directory':stat.isFile()?'file':stat.isSymbolicLink()?'symlink':'special'};
  if(stat.isFile())item.sha256=sha(fs.readFileSync(filename));else if(stat.isSymbolicLink())item.target=fs.readlinkSync(filename);
  entries.push(item);if(stat.isDirectory())for(const name of fs.readdirSync(filename).sort())walk(path.join(filename,name));
 }
 walk(root);return entries;
}

async function lockedPreflight(f,assertion){
 const lease=runWithStorageIdentity(f.context,()=>acquireNativeProfileLock(f.dataRoot));
 try{const before=snapshot(f.dataRoot);await assertion(()=>inspectLegacyStorage({dataRoot:f.dataRoot,context:f.context}));assert.deepEqual(snapshot(f.dataRoot),before);}
 finally{lease.release();}
}

const rejectsUnsafe=async invoke=>assert.throws(invoke,error=>error?.code==='STORAGE_RECOVERY_UNSAFE'&&error.message==='STORAGE_RECOVERY_UNSAFE');

test('healthy namespace-mapped profile is admitted without writes and excludes the held lease',async t=>{
 const f=await initialized(t);
 await lockedPreflight(f,invoke=>{
  const result=invoke(),root=fs.lstatSync(f.dataRoot,{bigint:true});
  const expectedIdentity=`${f.context.namespaceDevice}:${root.ino}`;
  assert.equal(persistentIdentity(root),`${f.context.currentDevice}:${root.ino}`);
  assert.equal(result.hostBindingHash,sha(JSON.stringify({kind:'native-profile',schemaVersion:1,path:f.dataRoot,identity:expectedIdentity,uid:process.getuid()})));
  assert.equal(result.hostRecord.phase,'ready');assert.equal(result.hostRecord.pendingRename,null);
  assert.equal(result.fingerprint.schemaVersion,1);assert.equal(result.fingerprint.namespaceDevice,f.context.namespaceDevice);
  assert.equal(result.fingerprint.entries.some(item=>item.path==='.asmb-native.lock'),false);
  assert.equal(result.fingerprint.sha256,sha(JSON.stringify(result.fingerprint.entries)));
 });
});

test('completed complex legacy history remains admissible after private-log compaction',async t=>{
 const f=fixture(t),payload=path.join(f.parent,'bundled-docs');fs.mkdirSync(payload,{mode:0o700});fs.writeFileSync(path.join(payload,'README.md'),'# Fixture guide\n',{mode:0o600});
 const bundledDocs={root:payload,manifest:createBundledDocsManifest(payload,'0.2.14')};
 const remote=path.join(f.parent,'remote');fs.mkdirSync(remote,{mode:0o700});git(remote,'init','--initial-branch=main','--template=');fs.writeFileSync(path.join(remote,'README.md'),'# Remote\n',{mode:0o600});git(remote,'add','.');git(remote,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Remote');
 const hooks={
  cloneAcquire:async({destination})=>execFileSync('/usr/bin/git',['clone','--no-checkout','--no-hardlinks','--no-local','--template=','--',remote,destination],{env:gitEnvironment,stdio:'pipe'}),
  updatesAcquire:async({gitDir,branch})=>{const head=git(remote,'rev-parse',`refs/heads/${branch}`);execFileSync('/usr/bin/git',[`--git-dir=${gitDir}`,'-c','core.hooksPath=/dev/null','fetch','--no-tags','--no-write-fetch-head','--no-auto-maintenance','--no-recurse-submodules','--',remote,`refs/heads/${branch}:refs/asmb-check/remote`],{env:gitEnvironment,stdio:'pipe'});return head;},
 };
 let service=await createNativeService({...f,storageIdentity:f.context,bundledDocs,hooks});
 const created=await request(service,'Workspace','create',{path:'notes/item.md',text:'saved source'});
 for(let index=0;index<25;index++)await request(service,'Workspace','checkpoint',{path:created.path,baseHash:created.sourceHash,text:`private draft ${index}`});
 let token=await request(service,'Workspace','inspectEntry',{path:'notes'});await request(service,'Workspace','manage',{operation:'move',items:[{path:'notes',newPath:'moved',token:token.token}]});
 token=await request(service,'Workspace','inspectEntry',{path:'moved/item.md'});const trashed=await request(service,'Workspace','manage',{operation:'trash',items:[{path:'moved/item.md',token:token.token}]});
 await request(service,'Workspace','restore',{trashId:trashed.items[0].trashId});
 const review=await request(service,'Workspace','gitReview',{paths:['README.md','moved/item.md']});
 await request(service,'Workspace','gitCommit',{expectedHead:review.expectedHead,expectedIndexHash:review.expectedIndexHash,files:review.files.map(({path:filename,expectedSourceHash,expectedSourceMode})=>({path:filename,expectedSourceHash,expectedSourceMode})),message:'Fixture history',author:{name:'Fixture Author',email:'fixture@example.invalid'}});
 const archiveRoot=path.join(f.parent,'archive-source');fs.mkdirSync(archiveRoot,{mode:0o700});git(archiveRoot,'init','--initial-branch=main','--quiet');fs.writeFileSync(path.join(archiveRoot,'README.md'),'# Imported\n',{mode:0o600});git(archiveRoot,'add','.');git(archiveRoot,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Imported');
 const archive=execFileSync('/usr/bin/git',['-C',archiveRoot,'archive','--format=zip','--prefix=imported-main/','HEAD']);await service.importArchive({name:'Imported',bytes:new Uint8Array(archive).buffer});
 await service.renameRepository({repository:'Imported',name:'Renamed'});await service.duplicateRepository({repository:'Renamed',name:'Copy',requestId:randomUUID()});
 const repositoryTrash=randomUUID();await service.trashRepository({repository:'Copy',requestId:repositoryTrash});await service.restoreRepository({trashId:repositoryTrash,name:'Restored'});await service.setRepositoryPinned({repo:'Renamed',pinned:true});
 await service.cloneRepository({name:'Cloned',url:'https://github.com/example/repository',requestId:randomUUID()});const update=await service.checkRepositoryUpdates({repo:'Cloned',requestId:randomUUID()});assert.equal(update.relation,'up-to-date');
 await service.createRepository({name:'EmptyGit',requestId:randomUUID()});await service.bootstrap('EmptyGit');
 await service.createRepository({name:'Retirable',requestId:randomUUID()});await request(service,'Retirable','create',{path:'retained.md',text:'retained source'});await request(service,'Retirable','checkpointNew',{draftId:'retained-draft',path:'draft.md',text:'retained private draft'});await service.trashRepository({repository:'Retirable',requestId:randomUUID()});
 const current=await request(service,'Workspace','getCommitPreferences');await request(service,'Workspace','setCommitPreferences',{expectedRevision:current.revision,mode:'manual',asmagicbrain:{name:'Fixture Author',email:'fixture@example.invalid'},github:{name:'',email:''}});
 for(let index=0;index<25;index++)await service.setAppearance({themeId:index%2?'dark':'light',hideUnavailable:Boolean(index%2)});
 await service.close();
 await lockedPreflight(f,invoke=>{const result=invoke();assert.equal(result.hostRecord.phase,'ready');assert.deepEqual(result.hostRecord.repositoryBindings.map(item=>item.name),['Workspace','asMagicBrain-Docs','Renamed','Restored','Cloned','EmptyGit']);});
});

test('corrupted authenticated private chain is rejected without repair',async t=>{
 const f=await initialized(t),host=path.join(f.dataRoot,'state/native/.asmb-host');
 const record=fs.readdirSync(host).find(name=>/^\d{16}\.json$/.test(name));assert.ok(record);fs.appendFileSync(path.join(host,record),'broken');
 await lockedPreflight(f,invoke=>rejectsUnsafe(invoke));
});

test('repository inode replacement is rejected without adopting replacement bytes',async t=>{
 const f=await initialized(t),retained=path.join(f.parent,'retained-workspace');
 fs.renameSync(f.source,retained);fs.mkdirSync(f.source,{mode:0o700});fs.writeFileSync(path.join(f.source,'README.md'),'replacement',{mode:0o600});
 await lockedPreflight(f,invoke=>rejectsUnsafe(invoke));assert.equal(fs.readFileSync(path.join(f.source,'README.md'),'utf8'),'replacement');
});

test('durable pending rename intent is rejected without completing it',async t=>{
 let armed=false;const f=fixture(t),service=await createNativeService({...f,storageIdentity:f.context,hooks:{at:point=>{if(armed&&point==='rename-intent')throw new Error('stop after durable intent');}}});
 armed=true;await assert.rejects(service.renameRepository({repository:'Workspace',name:'Pending'}),{code:'RECOVERY_REQUIRED'});await service.close();
 await lockedPreflight(f,invoke=>rejectsUnsafe(invoke));assert.equal(fs.existsSync(path.join(f.dataRoot,'workspaces/asMagicBrain/Workspace')),true);
});

test('altered or missing managed Trash backing is rejected without repair',async t=>{
 for(const damage of ['content','missing'])await t.test(damage,async t=>{
  const f=fixture(t),service=await createNativeService({...f,storageIdentity:f.context});
  await request(service,'Workspace','create',{path:'trashed.md',text:'retained managed bytes'});const item=await request(service,'Workspace','inspectEntry',{path:'trashed.md'});
  const result=await request(service,'Workspace','manage',{operation:'trash',items:[{path:'trashed.md',token:item.token}]});await service.close();
  const backing=path.join(f.dataRoot,'state/native/Workspace/files/managed-content',result.items[0].trashId);
  if(damage==='missing')fs.unlinkSync(backing);else{const bytes=fs.readFileSync(backing);bytes[0]^=1;fs.writeFileSync(backing,bytes);}
  await lockedPreflight(f,invoke=>rejectsUnsafe(invoke));
 });
});

test('symlink inside private state is rejected without following it',async t=>{
 const f=await initialized(t),link=path.join(f.dataRoot,'state/native/unsafe-link');fs.symlinkSync(f.parent,link);
 await lockedPreflight(f,invoke=>rejectsUnsafe(invoke));assert.equal(fs.readlinkSync(link),f.parent);
});

async function stage4Profile(t,{hooks={}}={}){
 const f=fixture(t);f.context.volumeId='a2ecb956-8e09-4de1-9e4f-bde230c018aa';
 const {createPackageZip}=await import('../../packages/desktop-host/src/package-exchange/archive.mjs');
 const files={'guide.md':'# Guide\nBase source\n','remove.md':'Old source\n','asmagicbrain.collection.json':JSON.stringify({schemaVersion:1,collectionId:'neutral',documents:[{id:'guide',path:'guide.md'}]})};
 const archive=values=>createPackageZip(Object.entries(values).map(([path,text])=>({path,bytes:Buffer.from(text)})));
 const service=await createNativeService({...f,storageIdentity:f.context,hooks}),repoId=(await service.catalog()).repositories.find(entry=>entry.name==='Workspace').stableId;
 await service.setAutomationGrants({enabled:true,grants:[{repoId,scopes:['read','write','import','export']}]});
 const imported=await service.automationRequest({requestId:'neutral-import',operation:'import.plan',args:{repoId,name:'Engineering',archiveBase64:archive(files).toString('base64')}});
 await service.approveAutomation({operationId:imported.operationId,digest:imported.digest});
 const registration=await service.reviewPackageBase({repo:'Engineering',bytes:archive(files),collectionId:'neutral',version:'1'});await service.registerPackageBase({repo:'Engineering',planId:registration.planId});
 return {...f,service,files,archive,repoId,imported};
}

test('Stage 4 stores survive uniform device renumber with complete verified backup and no changes to old private bytes',async t=>{
 const f=await stage4Profile(t);let service=f.service;
 const update=await service.reviewPackageUpdate({repo:'Engineering',bytes:f.archive({...f.files,'guide.md':'# Guide\nUpdated source\n','new.md':'New source\n'}),semantics:'snapshot',version:'2'});
 const applied=await service.applyPackageUpdate({repo:'Engineering',planId:update.planId,choices:update.rows.filter(row=>row.choices.length).map(row=>({path:row.path,choice:'use-incoming'}))});
 await service.rollbackPackageUpdate({repo:'Engineering',operationId:applied.operationId});
 const token=await request(service,'Engineering','inspectEntry',{path:'guide.md'});await request(service,'Engineering','manage',{operation:'move',items:[{path:'guide.md',newPath:'renamed.md',token:token.token}]});
 const ref=await service.getReadingReference({repo:'Engineering',path:'renamed.md',ref:''});assert.equal(ref.status,'ready');
 const write=await service.automationRequest({requestId:'create-note',operation:'write.plan',args:{repoId:f.repoId,path:'note.md',expectedHash:null,text:'Saved through shared authority'}});await service.approveAutomation({operationId:write.operationId,digest:write.digest});
 const exportReview=await service.reviewPackageExport({repo:'Engineering',collectionId:'neutral',version:'1'});await service.buildPackageExport({repo:'Engineering',planId:exportReview.planId,kind:'offline'});
 await service.close();
 await lockedPreflight(f,invoke=>{const result=invoke();for(const fragment of ['/.asmb-reading/','/.asmb-automation/','/package-exchange/blobs/','.zip-request.json'])assert.ok(result.fingerprint.entries.some(entry=>entry.path.includes(fragment)&&entry.sha256),fragment);});
 const before=snapshot(f.dataRoot).filter(entry=>entry.type==='file'),{prepareNativeStorage}=await import('./storage-admission.mjs');
 const admission=await prepareNativeStorage({dataRoot:f.dataRoot,probe:()=>f.context.volumeId,confirmRecovery:async()=>true});
 assert.equal(admission.context.namespaceDevice,f.context.namespaceDevice);assert.ok(admission.backupPath);
 const receipt=JSON.parse(fs.readFileSync(path.join(admission.backupPath,'receipt.json')));assert.equal(receipt.status,'verified');
 for(const file of before){assert.equal(sha(fs.readFileSync(path.join(f.dataRoot,file.path))),file.sha256);assert.equal(fs.lstatSync(path.join(f.dataRoot,file.path),{bigint:true}).ino.toString(),file.ino);assert.equal(receipt.files.find(row=>row.path===file.path)?.sha256,file.sha256);assert.equal(sha(fs.readFileSync(path.join(admission.backupPath,'managed-data',file.path))),file.sha256);}
 service=await createNativeService({dataRoot:f.dataRoot,storageIdentity:admission.context,profileLock:admission.profileLock});
 try{const resolved=await service.resolveReadingReference({reference:ref.reference});assert.equal(resolved.path,'renamed.md');assert.equal(resolved.status,'resolved');assert.equal((await service.packageStatus({repo:'Engineering'})).operations.at(-1).status,'rolled-back');assert.equal((await service.getAutomationStatus()).operations.find(op=>op.requestId==='neutral-import').status,'completed');assert.equal((await request(service,'Engineering','gitInspect')).head,null);}
 finally{await service.close();}
});

test('Stage 4 malformed retained blobs and mismatched import request tokens fail closed before recovery',async t=>{
 for(const damage of ['blob','request'])await t.test(damage,async t=>{
  const f=await stage4Profile(t);await f.service.close();
  if(damage==='blob'){const root=path.join(f.dataRoot,'state/native/Engineering/package-exchange/blobs'),name=fs.readdirSync(root)[0];fs.writeFileSync(path.join(root,name),'altered retained bytes');}
  else{const root=path.join(f.dataRoot,'workspaces/asMagicBrain/.asmb-catalog'),name=fs.readdirSync(root).find(name=>name.endsWith('.zip-request.json')),filename=path.join(root,name),record=JSON.parse(fs.readFileSync(filename));record.archiveSha256='0'.repeat(64);fs.writeFileSync(filename,JSON.stringify(record));}
  await lockedPreflight(f,invoke=>rejectsUnsafe(invoke));
 });
});

test('Stage 4 interrupted outer exchange is refused during device rebind without applying or discarding it',async t=>{
 let armed=false;const f=await stage4Profile(t,{hooks:{packageAt:phase=>{if(armed&&phase==='exchange-after-step')throw Error('Interrupted exchange');}}});
 const review=await f.service.reviewPackageUpdate({repo:'Engineering',bytes:f.archive({...f.files,'guide.md':'New bytes'}),semantics:'snapshot',version:'2'});armed=true;
 await assert.rejects(f.service.applyPackageUpdate({repo:'Engineering',planId:review.planId,choices:review.rows.filter(row=>row.choices.length).map(row=>({path:row.path,choice:'use-incoming'}))}));await f.service.close();
 await lockedPreflight(f,invoke=>rejectsUnsafe(invoke));
});

test('authenticated but malformed Stage 4 payloads and applying automation receipts are never silently admitted',async t=>{
 const {createPrivateStore}=await import('../../packages/desktop-host/src/private-store.mjs');
 for(const damage of ['automation-digest','automation-applying','reading-path','exchange-path'])await t.test(damage,async t=>{
  const f=await stage4Profile(t);await f.service.close();
  runWithStorageIdentity(f.context,()=>{
   const hostBindingHash=sha(JSON.stringify({kind:'native-profile',schemaVersion:1,path:f.dataRoot,identity:persistentIdentity(fs.lstatSync(f.dataRoot)),uid:process.getuid()}));
   const exchange=damage==='exchange-path',reading=damage==='reading-path',name=reading?'.asmb-reading':'.asmb-automation';
   const sourceRoot=path.join(f.dataRoot,'workspaces/asMagicBrain/Engineering'),privateRoot=path.join(f.dataRoot,'state/native',exchange?'Engineering/package-exchange/journal':name);
   const bindingHash=exchange?sha(JSON.stringify({sourceRoot,sourceIdentity:persistentIdentity(fs.lstatSync(sourceRoot))})):sha(hostBindingHash+(reading?':reading:1':':automation:1'));
   const store=createPrivateStore({privateRoot,bindingHash}),scan=store.scan(),state=structuredClone(scan.events.at(-1)?.payload??{schemaVersion:1,redirects:[]});
   if(damage==='automation-digest')state.operations[0].digest='0'.repeat(64);
   if(damage==='automation-applying'){state.operations[0].status='applying';delete state.operations[0].result;}
   if(reading)state.redirects=[{repoId:'0'.repeat(64),documentId:'guide',from:'../outside.md',to:'guide.md'}];
   if(exchange)state.registration.files[0].path='../outside.md';
   store.append(scan,'draft',state);
  });
  await lockedPreflight(f,invoke=>rejectsUnsafe(invoke));
 });
});
