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
