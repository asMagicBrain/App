import fs from 'node:fs';
import {createRepositoryManagement} from './repository-management.mjs';
import {createRepositoryPins} from './repository-pins.mjs';
import {createRepositorySearch} from './repository-search.mjs';
import {installBundledDocs} from './bundled-docs.mjs';
import {hasPreviewDataOwnership} from './profile-paths.mjs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {createWorkspaceService} from '../../packages/desktop-host/src/workspace-service.mjs';
import {readLocalRepository,readLocalRepositoryAsset} from '../../packages/desktop-host/src/repository-reader.mjs';
import {createRepositoryCatalog,createRepositoryImporter,validRepositoryName,validCreationId} from '../../packages/desktop-host/src/repository-import/index.mjs';
import {renameDirectoryStep} from '../../packages/desktop-host/src/repository-import/rename-directory.mjs';
import {canonicalGitHubUrl} from '../../packages/desktop-host/src/local-git/github-clone.mjs';
import {createGitHubUpdates} from '../../packages/desktop-host/src/local-git/github-updates.mjs';
import {createGitHubApply} from '../../packages/desktop-host/src/local-git/github-apply.mjs';
import {ZIP_IMPORT_LIMITS} from '../../packages/desktop-host/src/zip-import/index.mjs';
import {createPrivateStore,assertOutsideGit} from '../../packages/desktop-host/src/private-store.mjs';
import {pinDirectory,checkDirectory,checkSourceSpelling,contains} from '../../packages/desktop-host/src/physical-roots.mjs';
import {inspectExternalSources} from '../../packages/desktop-host/src/repository-runtime/file-management.mjs';
import {isPortableRelativePath,isInspectableRelativePath,portablePathKey} from '../../packages/source-foundation/src/domain/path-policy.mjs';

const THEMES=new Set(['light-default','light-high-contrast','light-colorblind','dark-default','dark-high-contrast','dark-colorblind','dark-dimmed','light','dark']);
const README='# Workspace\n\nYour local workspace. Create a file or import a ZIP to begin.\n';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const updateError=error=>{const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{1,79}$/.test(error.code)?error.code:'UPDATES_FAILED';return Object.assign(new Error(code),{code});};
const identity=stat=>`${stat.dev}:${stat.ino}`;
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const exists=filename=>{try{return fs.lstatSync(filename);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const uid=()=>typeof process.getuid==='function'?process.getuid():null;
const appearanceValid=value=>exact(value,['themeId','hideUnavailable'])&&(value.themeId===null||THEMES.has(value.themeId))&&typeof value.hideUnavailable==='boolean';
function syncDirectory(pin){checkDirectory(pin);const fd=fs.openSync(pin.path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{if(identity(fs.fstatSync(fd))!==pin.identity)fail('DENIED');fs.fsyncSync(fd);checkDirectory(pin);}finally{fs.closeSync(fd);}}
function privateDirectory(filename,create=false){
 if(!exists(filename)){if(!create)fail('RECOVERY_REQUIRED');const parent=pinDirectory(path.dirname(filename));fs.mkdirSync(filename,{mode:0o700});syncDirectory(parent);}
 const pin=pinDirectory(filename),stat=fs.lstatSync(filename);
 if((stat.mode&0o777)!==0o700||(uid()!==null&&stat.uid!==uid()))fail('INVALID_PRIVATE_ROOT');return pin;
}
function writeExclusive(filename,bytes){
 const parent=pinDirectory(path.dirname(filename));const fd=fs.openSync(filename,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDirectory(parent);
}
function readSmall(filename){
 const stat=exists(filename);if(!stat?.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>16384||(stat.mode&0o777)!==0o600||(uid()!==null&&stat.uid!==uid()))fail('RECOVERY_REQUIRED');
 const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const before=fs.fstatSync(fd);if(identity(before)!==identity(stat)||!before.isFile())fail('RECOVERY_REQUIRED');const bytes=Buffer.alloc(stat.size+1),count=fs.readSync(fd,bytes,0,bytes.length,0),after=fs.fstatSync(fd);if(count!==stat.size||after.size!==stat.size||after.mtimeMs!==before.mtimeMs||identity(fs.lstatSync(filename))!==identity(stat))fail('RECOVERY_REQUIRED');return {bytes:bytes.subarray(0,count),identity:identity(stat)};}finally{fs.closeSync(fd);}
}
function acquireLock(root){
 const filename=path.join(root.path,'.asmb-native.lock');
 if(exists(filename)){
  const observed=readSmall(filename);let value;try{value=JSON.parse(observed.bytes);}catch{fail('RECOVERY_REQUIRED');}
  if(!exact(value,['pid','token'])||!Number.isSafeInteger(value.pid)||value.pid<1||typeof value.token!=='string'||!/^[a-f0-9-]{36}$/.test(value.token))fail('RECOVERY_REQUIRED');
  try{process.kill(value.pid,0);fail('PROFILE_IN_USE');}catch(error){if(error.code!=='ESRCH')throw error;}
  const again=readSmall(filename);if(again.identity!==observed.identity||!again.bytes.equals(observed.bytes))fail('PROFILE_IN_USE');checkDirectory(root);fs.unlinkSync(filename);syncDirectory(root);
 }
 const bytes=Buffer.from(JSON.stringify({pid:process.pid,token:randomUUID()}));writeExclusive(filename,bytes);const owned=readSmall(filename);
 return ()=>{checkDirectory(root);const live=readSmall(filename);if(live.identity!==owned.identity||!live.bytes.equals(owned.bytes))fail('RECOVERY_REQUIRED');fs.unlinkSync(filename);syncDirectory(root);};
}
// Initial Git metadata must reach storage before the profile becomes ready. Git
// later owns its object/index/ref transactions; ordinary Save never invokes Git.
function syncInitialTree(directory){
 const pin=pinDirectory(directory);for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  const filename=path.join(directory,entry.name);if(entry.isDirectory())syncInitialTree(filename);else if(entry.isFile()){
   const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{if(!fs.fstatSync(fd).isFile())fail('RECOVERY_REQUIRED');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }else fail('RECOVERY_REQUIRED');
 }syncDirectory(pin);
}
function copyRequest(value){
 let serialized;try{serialized=JSON.stringify(value);}catch{fail('INVALID_REQUEST');}
 if(typeof serialized!=='string'||Buffer.byteLength(serialized)>7*1024*1024)fail('INVALID_REQUEST');
 // IPC supplies plain structured data. Round-trip also detaches caller-owned
 // objects immediately, before an accepted request waits in the serial queue.
 return JSON.parse(serialized);
}
function readerPath(value){return typeof value==='string'&&value.isWellFormed()&&(value===''||(isInspectableRelativePath(value)&&value.split('/').length<=32&&!value.split('/').some(segment=>segment.toLowerCase()==='.asmagicbrain'||segment.toLowerCase().startsWith('.asmb-'))));}
function mutationPath(value){return readerPath(value)&&(value===''||isPortableRelativePath(value));}
function updatePath(value){return isInspectableRelativePath(value)&&value.split('/').length<=32&&!value.split('/').some(segment=>segment.toLowerCase()==='.asmagicbrain'||segment.toLowerCase().startsWith('.asmb-'));}

/** Trusted main/utility-process factory. No renderer method accepts a root,
 * executable or capability. Only one service may hold a profile at a time.
 * Existing data is never reseeded: damaged, moved or incomplete storage holds
 * for recovery instead of becoming a new empty profile. */
export async function createNativeService({dataRoot,hooks={},revealInFileManager,ripgrepPath,searchLimits,bundledDocs}={}){
 if(typeof dataRoot!=='string'||!path.isAbsolute(dataRoot)||path.normalize(dataRoot)!==dataRoot)fail('INVALID_DATA_ROOT');
 const root=privateDirectory(dataRoot,true);assertOutsideGit(root.path);
 const ownedPreview=hasPreviewDataOwnership(root.path);
 const names=fs.readdirSync(root.path).filter(name=>!ownedPreview||name!=='.asmagicbrain-channel.json'),fresh=names.length===0;
 // A previous process may have died after writing only its lock. Retain every
 // other interrupted setup for explicit recovery; never adopt arbitrary data.
 const lockOnly=names.length===1&&names[0]==='.asmb-native.lock';
 const release=acquireLock(root);let workspace;
 try{
  const initialize=fresh||lockOnly;
  const workspaces=privateDirectory(path.join(root.path,'workspaces'),initialize);
  const organization=privateDirectory(path.join(workspaces.path,'asMagicBrain'),initialize);
  const state=privateDirectory(path.join(root.path,'state'),initialize);
  const privateRoot=privateDirectory(path.join(state.path,'native'),initialize);
  const host=privateDirectory(path.join(privateRoot.path,'.asmb-host'),initialize);
  const pins=[root,workspaces,organization,state,privateRoot,host];
  const bindingHash=createHash('sha256').update(JSON.stringify({kind:'native-profile',schemaVersion:1,path:root.path,identity:root.identity,uid:uid()})).digest('hex');
  const store=createPrivateStore({privateRoot:host.path,bindingHash});
  let scan=store.ensureDurable(store.scan()),record=scan.events.at(-1)?.payload;
  const roots={organization:organization.identity,state:privateRoot.identity};
  const legacyFields=['schemaVersion','ownerId','phase','roots','workspaceIdentity','appearance'];
  const normalize=value=>exact(value,legacyFields)&&value.schemaVersion===1?{...value,schemaVersion:2,workspaceName:'Workspace',repositoryBindings:[],pendingRename:null}:value;
  const validIdentity=value=>typeof value==='string'&&/^\d+:\d+$/.test(value);
  const validBinding=value=>exact(value,['name','identity','stateKey','bindingName'])&&validRepositoryName(value.name)&&validIdentity(value.identity)&&validRepositoryName(value.bindingName)&&typeof value.stateKey==='string'&&(validRepositoryName(value.stateKey)||/^\.asmb-repo-[a-f0-9-]{36}$/.test(value.stateKey));
  const validRecord=value=>exact(value,[...legacyFields,'workspaceName','repositoryBindings','pendingRename'])&&[2,3,4].includes(value.schemaVersion)&&typeof value.ownerId==='string'&&/^[a-f0-9-]{36}$/.test(value.ownerId)&&['initializing','ready'].includes(value.phase)&&exact(value.roots,['organization','state'])&&JSON.stringify(value.roots)===JSON.stringify(roots)&&(value.workspaceIdentity===null||validIdentity(value.workspaceIdentity))&&appearanceValid(value.appearance)&&validRepositoryName(value.workspaceName)&&Array.isArray(value.repositoryBindings)&&value.repositoryBindings.length<=1000&&value.repositoryBindings.every(validBinding)&&new Set(value.repositoryBindings.map(v=>portablePathKey(v.name))).size===value.repositoryBindings.length&&new Set(value.repositoryBindings.map(v=>portablePathKey(v.stateKey))).size===value.repositoryBindings.length&&(value.pendingRename===null||(exact(value.pendingRename,['repository','name','identity','isDefault','reservationIdentity'])&&validRepositoryName(value.pendingRename.repository)&&validRepositoryName(value.pendingRename.name)&&portablePathKey(value.pendingRename.repository)!==portablePathKey(value.pendingRename.name)&&validIdentity(value.pendingRename.identity)&&typeof value.pendingRename.isDefault==='boolean'&&(value.pendingRename.reservationIdentity===null||validIdentity(value.pendingRename.reservationIdentity))&&value.repositoryBindings.some(v=>v.name===value.pendingRename.repository&&v.identity===value.pendingRename.identity)&&value.pendingRename.isDefault===(value.pendingRename.repository===value.workspaceName)));
  if(!record){if(!initialize||scan.sequence)fail('RECOVERY_REQUIRED');record={schemaVersion:2,ownerId:randomUUID(),phase:'initializing',roots,workspaceIdentity:null,appearance:{themeId:'light-default',hideUnavailable:false},workspaceName:'Workspace',repositoryBindings:[],pendingRename:null};scan=store.append(scan,'draft',record);}
  for(const event of scan.events)if(!validRecord(normalize(event.payload)))fail('RECOVERY_REQUIRED');
  record=normalize(record);
  if(scan.blocked||!validRecord(record))fail('RECOVERY_REQUIRED');
  const persist=next=>{if(!validRecord(next))fail('RECOVERY_REQUIRED');if(scan.tailRecords>=24||scan.coveredFiles.length)scan=store.compact(scan,record);scan=store.append(scan,'draft',next);if(scan.blocked)fail('RECOVERY_REQUIRED');record=next;};
  const checkStorage=()=>{for(const pin of pins)checkDirectory(pin);assertOutsideGit(privateRoot.path);const live=store.ensureDurable(store.scan());if(live.sequence!==scan.sequence||live.previous!==scan.previous)fail('RECOVERY_REQUIRED');};
  const at=point=>hooks.at?.(point);
  function finishRename(){
   let intent=record.pendingRename;if(!intent)return;
   checkStorage();const oldPath=path.join(organization.path,intent.repository),newPath=path.join(organization.path,intent.name);
   const old=exists(oldPath),next=exists(newPath);
   if(old){
    if(pinDirectory(oldPath).identity!==intent.identity)fail('REPOSITORY_CHANGED');
    if(intent.reservationIdentity===null){
     if(next)fail('RECOVERY_REQUIRED');
     const reservationIdentity=renameDirectoryStep(organization,{operation:'reserve',name:intent.name});
     at('rename-reserved-before-receipt');
     persist({...record,pendingRename:{...intent,reservationIdentity}});intent=record.pendingRename;at('rename-reserved');
    }else if(!next||pinDirectory(newPath).identity!==intent.reservationIdentity)fail('RECOVERY_REQUIRED');
    checkStorage();renameDirectoryStep(organization,{operation:'rename',repository:intent.repository,name:intent.name,identity:intent.identity,reservationIdentity:intent.reservationIdentity});at('rename-moved');
   }else if(!next||pinDirectory(newPath).identity!==intent.identity)fail('RECOVERY_REQUIRED');
   if(!intent.isDefault)createRepositoryCatalog(organization.path,{builtinRepositories:[]}).renameRegistration(intent);
   at('rename-cataloged');
   persist({...record,workspaceName:intent.isDefault?intent.name:record.workspaceName,repositoryBindings:record.repositoryBindings.map(item=>item.name===intent.repository?{...item,name:intent.name}:item),pendingRename:null});
   at('rename-completed');
  }
  // Complete an acknowledged intent before catalog admission or binding any
  // session. Unknown names/identities hold for recovery without deleting data.
  finishRename();
  const sourceRoot=path.join(organization.path,record.workspaceName);let sourcePin;
  if(record.workspaceIdentity===null){
   if(record.phase!=='initializing'||exists(sourceRoot))fail('RECOVERY_REQUIRED');
   sourcePin=privateDirectory(sourceRoot,true);persist({...record,workspaceIdentity:sourcePin.identity});
  }else{sourcePin=pinDirectory(sourceRoot);if(sourcePin.identity!==record.workspaceIdentity)fail('REPOSITORY_CHANGED');}
  let renameHeld=false,repositoryManagement;
  const check=()=>{checkStorage();if(record.pendingRename||renameHeld||repositoryManagement?.hasPending())fail('RECOVERY_REQUIRED');checkDirectory(sourcePin);};
  if(record.phase==='initializing'){
   const filename=path.join(sourceRoot,'README.md');if(!exists(filename))writeExclusive(filename,Buffer.from(README));else if(!readSmall(filename).bytes.equals(Buffer.from(README)))fail('RECOVERY_REQUIRED');
  }
  let documentation;
  if(bundledDocs){
   const docsPrivate=privateDirectory(path.join(privateRoot.path,'.asmb-bundled-docs'),true);
   documentation=await installBundledDocs({organization:organization.path,privateRoot:docsPrivate.path,bindingHash:createHash('sha256').update(bindingHash+':bundled-docs:1').digest('hex'),payloadRoot:bundledDocs.root,manifest:bundledDocs.manifest,hooks});
   // Only the private documentation ledger can replace a prior builtin binding.
   // Retain the prior private store; the new source identity gets a fresh store.
   const older=record.repositoryBindings.filter(binding=>documentation.previous.some(item=>item.name===binding.name&&item.identity===binding.identity));
   if(older.length){
    persist({...record,repositoryBindings:record.repositoryBindings.filter(binding=>!older.includes(binding))});
   }
  }
  const isDocumentation=name=>documentation?.entry.name===name;
  const assertWritable=name=>{if(isDocumentation(name))throw Object.assign(new Error('Bundled documentation is read only. Duplicate the repository to make an editable copy.'),{code:'DOCS_READ_ONLY'});};
  const builtins=()=>[{name:record.workspaceName,privateRepo:true},...(documentation?[documentation.entry]:[])];
  function management(){
   if(!repositoryManagement){
    const directory=privateDirectory(path.join(privateRoot.path,'.asmb-repository-management'),true);
    repositoryManagement=createRepositoryManagement({organization:organization.path,privateRoot:directory.path,bindingHash:createHash('sha256').update(bindingHash+':repository-management:1').digest('hex'),hooks,
     retireBinding:binding=>{const current=record.repositoryBindings.find(v=>v.identity===binding.identity);if(!current)return;if(JSON.stringify(current)!==JSON.stringify(binding)||current.name===record.workspaceName)fail('RECOVERY_REQUIRED');persist({...record,repositoryBindings:record.repositoryBindings.filter(v=>v.identity!==binding.identity)});},
     publishBinding:binding=>{const current=record.repositoryBindings.find(v=>v.identity===binding.identity);if(current){if(JSON.stringify(current)!==JSON.stringify(binding))fail('RECOVERY_REQUIRED');return;}if(record.repositoryBindings.some(v=>portablePathKey(v.name)===portablePathKey(binding.name)||v.stateKey===binding.stateKey))fail('RECOVERY_REQUIRED');persist({...record,repositoryBindings:[...record.repositoryBindings,binding]});}
    });
   }return repositoryManagement;
  }
  if(exists(path.join(privateRoot.path,'.asmb-repository-management')))management().recover();
  let importer=createRepositoryImporter({base:organization.path,builtinRepositories:builtins(),hooks});
  function syncBindings(){
   const repositories=importer.catalog.list(),next=[...record.repositoryBindings];
   if(repositories.length>1000||next.some(item=>!repositories.some(repo=>repo.name===item.name)))fail('RECOVERY_REQUIRED');
   for(const repo of repositories){
    const source=pinDirectory(path.join(organization.path,repo.name)),known=next.find(item=>item.name===repo.name);
    if(known){if(known.identity!==source.identity)fail('REPOSITORY_CHANGED');continue;}
    // A previously renamed repository retains its private directory. Reusing
    // its old source name must never adopt the previous repository's drafts.
    const stateKey=(isDocumentation(repo.name)||next.some(item=>portablePathKey(item.stateKey)===portablePathKey(repo.name))||repositoryManagement?.reservedStateKeys().some(key=>portablePathKey(key)===portablePathKey(repo.name)))?`.asmb-repo-${randomUUID()}`:repo.name;
    next.push({name:repo.name,identity:source.identity,stateKey,bindingName:repo.name});
   }
   if(next.length!==record.repositoryBindings.length)persist({...record,repositoryBindings:next});
  }
  const openWorkspace=()=>{workspace=createWorkspaceService({base:organization.path,privateBase:privateRoot.path,builtinRepositories:builtins(),repositoryBindings:record.repositoryBindings,localOwnerId:record.ownerId,localRootId:'native'});};
  const updateManagers=new Map(),applyManagers=new Map(),updateJobs=new Set(),applyJobs=new Set(),applyHeld=new Set();
  function updateManagerFor(name){
   const provenance=importer.catalog.provenance(name);if(!provenance)return null;
   const binding=record.repositoryBindings.find(value=>value.name===name),source=pinDirectory(path.join(organization.path,name));
   if(!binding||binding.identity!==source.identity||source.identity!==provenance.identity)fail('REPOSITORY_CHANGED');
   let manager=updateManagers.get(binding.stateKey);
   if(!manager){const perRepository=privateDirectory(path.join(privateRoot.path,binding.stateKey),true),updates=privateDirectory(path.join(perRepository.path,'github-updates'),true);manager=createGitHubUpdates({sourceRoot:source.path,sourceBindingRoot:path.join(organization.path,binding.bindingName),privateRoot:updates.path,sourceUrl:provenance.sourceUrl,branch:provenance.branch,hooks:{acquire:hooks.updatesAcquire,at:hooks.updatesAt}});updateManagers.set(binding.stateKey,manager);}
   return {manager,binding,source,provenance};
  }
  function applyManagerFor(name){
   const context=updateManagerFor(name);if(!context)fail('UPDATES_UNAVAILABLE');
   const {binding,source,manager:snapshots}=context;let manager=applyManagers.get(binding.stateKey);
   if(!manager){const directory=privateDirectory(path.join(privateRoot.path,binding.stateKey,'github-apply'),true);manager=createGitHubApply({sourceRoot:source.path,sourceBindingRoot:path.join(organization.path,binding.bindingName),privateRoot:directory.path,snapshots,hooks:{at:hooks.applyAt,workerStopAfter:hooks.applyWorkerStopAfter}});applyManagers.set(binding.stateKey,manager);}
   return manager;
  }
  const assertApplyReady=name=>{if(applyHeld.has(name))fail('APPLY_RECOVERY_REQUIRED');};
  syncBindings();
  // Recover admitted updates before any workspace session can read a mixed
  // source/index or run its ordinary local Git recovery. Unknown bytes hold only
  // that repository; its retained data is never silently reset.
  for(const binding of record.repositoryBindings){
   if(!exists(path.join(privateRoot.path,binding.stateKey,'github-apply')))continue;
   try{const manager=applyManagerFor(binding.name);if(manager.inspect().recoveryRequired&&record.schemaVersion<3)fail('APPLY_RECOVERY_REQUIRED');const recovered=await manager.recover();if(recovered.status==='held')applyHeld.add(binding.name);}catch{applyHeld.add(binding.name);}
  }
  openWorkspace();
  if(record.phase==='initializing'){
   await workspace.execute(record.workspaceName,'gitInitialize',{branch:'main'});syncInitialTree(path.join(sourceRoot,'.git'));syncDirectory(sourcePin);persist({...record,phase:'ready'});
  }
  check();
  let serial=Promise.resolve(),closing=false,closed=false,pending=0,importPending=false,closePromise;
  function queue(fn){
   if(closing)return Promise.reject(Object.assign(new Error('SERVICE_CLOSED'),{code:'SERVICE_CLOSED'}));
   if(pending>=64)return Promise.reject(Object.assign(new Error('SERVICE_BUSY'),{code:'SERVICE_BUSY'}));
   pending++;const work=serial.then(async()=>{check();const value=await fn();check();return value;});serial=work.catch(()=>{}).finally(()=>{pending--;});return work;
  }
  const repo=value=>{if(!validRepositoryName(value))fail('UNKNOWN_REPOSITORY');if(isDocumentation(value))documentation.assertCurrent();return value;};
  async function updatesContext(name){
   const context=updateManagerFor(name);if(!context)return {status:{eligible:false,reason:'local-only'}};
   const {manager,binding,provenance}=context;
   if(applyHeld.has(name))return {manager,binding,status:{eligible:false,reason:'recovery-required',sourceUrl:provenance.sourceUrl,branch:provenance.branch}};
   const meta=await workspace.execute(name,'gitInspect',{}),runtime=await workspace.execute(name,'runtimeStatus',{});
   const lastCheck=manager.get({localHead:meta.head,localBranch:meta.branch}),reason=meta.recoveryRequired||runtime.recoveryRequired?'recovery-required':meta.branch!==provenance.branch?'branch-changed':null;
   return {manager,meta,binding,status:{eligible:reason===null,...(reason?{reason}:{}),sourceUrl:provenance.sourceUrl,branch:provenance.branch,...(lastCheck?{lastCheck}:{})}};
  }
  async function applyReadiness(name){
   assertApplyReady(name);
   const runtime=await workspace.execute(name,'runtimeStatus',{}),boot=workspace.bootstrap(name),git=await workspace.execute(name,'gitStatus',{});
   return {draftCount:runtime.draftCount+(runtime.recoveredDrafts?.length??0)+boot.newDrafts.length,dirtyFileCount:git.files.length+(git.staged?1:0),recoveryRequired:runtime.recoveryRequired||git.recoveryRequired};
  }
  function externalSources(paths){const sources=inspectExternalSources(paths);if(sources.some(item=>contains(privateRoot.path,item.path)||contains(item.path,privateRoot.path)))fail('PRIVATE_SOURCE_UNSUPPORTED');return sources;}
  function runWorkspaceWorker(value,signal){
   const cancelFlag=new SharedArrayBuffer(4),cancelled=new Int32Array(cancelFlag),cancel=()=>Atomics.store(cancelled,0,1);if(signal?.aborted)cancel();signal?.addEventListener('abort',cancel,{once:true});
   const operation=new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('../../packages/desktop-host/src/repository-import/external-worker.mjs',import.meta.url),{workerData:{workspace:{base:organization.path,privateBase:privateRoot.path,builtinRepositories:builtins(),repositoryBindings:record.repositoryBindings,localOwnerId:record.ownerId,localRootId:'native'},...value,cancelFlag,reportPhases:typeof hooks.externalPhase==='function',...(value.operation==='importExternal'&&hooks.externalInterruptAt?{interruptAt:hooks.externalInterruptAt}:{}),...(value.operation==='importExternal'&&hooks.externalExitAt?{exitAt:hooks.externalExitAt}:{})}});let result;
    worker.on('message',message=>{if(Object.hasOwn(message,'ok'))result=message;else if(message.phase)hooks.externalPhase?.(message.phase);});
    worker.once('error',reject);worker.once('exit',code=>{if(code!==0||!result)reject(Object.assign(new Error('The local file operation was interrupted. Reopen and reconcile the repository before continuing.'),{code:'RECOVERY_REQUIRED'}));else if(!result.ok)reject(Object.assign(new Error(result.message??result.code),{code:result.code}));else resolve(result.value);});
   });
   return operation.finally(()=>signal?.removeEventListener('abort',cancel));
  }
  const search=createRepositorySearch({ripgrepPath,limits:searchLimits,admit:(selection,searchInput)=>queue(async()=>{
   const names=selection===null?importer.catalog.list().map(item=>item.name):[repo(selection)];
   if(searchInput.ref)for(const name of names)await workspace.execute(name,'gitInspect',{});
   return names.map(name=>{repo(name);assertApplyReady(name);importer.catalog.assertKnown(name);const pin=pinDirectory(path.join(organization.path,name));if(record.repositoryBindings.find(item=>item.name===name)?.identity!==pin.identity)fail('REPOSITORY_CHANGED');return {repo:name,pin};});
  })});
  let repositoryPins;
  const preferences=()=>{if(!repositoryPins){const directory=privateDirectory(path.join(privateRoot.path,'.asmb-repository-pins'),true);repositoryPins=createRepositoryPins({privateRoot:directory.path,bindingHash:createHash('sha256').update(bindingHash+':repository-pins:1').digest('hex')});}return repositoryPins;};
  async function managementReady(name){
   assertApplyReady(name);if(applyJobs.has(name)||[...updateJobs].some(job=>job.repo===name))fail('UPDATES_BUSY');importer.catalog.assertKnown(name);
   workspace.bootstrap(name);if((await workspace.execute(name,'runtimeStatus',{})).recoveryRequired)fail('RECOVERY_REQUIRED');
   const git=await workspace.execute(name,'gitInspect',{});if(git.recoveryRequired)fail('RECOVERY_REQUIRED');if(git.busy)fail('GIT_BUSY');
   const binding=record.repositoryBindings.find(v=>v.name===name),source=pinDirectory(path.join(organization.path,name));if(!binding||binding.identity!==source.identity)fail('REPOSITORY_CHANGED');return {binding,source,git};
  }
  const managementResult=repository=>({repository,organization:'asMagicBrain',defaultRepository:record.workspaceName,repositories:importer.catalog.list()});
  const reopenAfterManagement=()=>{importer=createRepositoryImporter({base:organization.path,builtinRepositories:builtins(),hooks});openWorkspace();};
  return Object.freeze({
   catalog:()=>queue(()=>{
    documentation?.assertCurrent();
    importer.catalog.recover();const previousBindings=record.repositoryBindings.length;syncBindings();
    if(record.repositoryBindings.length!==previousBindings){workspace.close();openWorkspace();}
    return {organization:'asMagicBrain',defaultRepository:record.workspaceName,repositories:importer.catalog.list(),limits:ZIP_IMPORT_LIMITS};
   }),
   read:request=>{let value;try{value=copyRequest(request);if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['repo','path','ref'].includes(key)))fail('INVALID_REQUEST');repo(value.repo);if(value.path===undefined)value.path='';if(value.ref===undefined)value.ref='';if(!readerPath(value.path)||typeof value.ref!=='string'||!value.ref.isWellFormed()||value.ref.length>1024||/[\x00-\x1f\x7f]/.test(value.ref))fail('INVALID_PATH');}catch(error){return Promise.reject(error);}return queue(async()=>{assertApplyReady(value.repo);await workspace.execute(value.repo,'gitInspect',{});return readLocalRepository(value.repo,value.path,organization.path,value.ref,{builtinRepositories:builtins()});});},
   readAsset:request=>{let value;try{value=copyRequest(request);if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['repo','path','ref'].includes(key)))fail('INVALID_REQUEST');repo(value.repo);if(value.ref===undefined)value.ref='';if(!value.path||!readerPath(value.path)||typeof value.ref!=='string'||!value.ref.isWellFormed()||value.ref.length>1024||/[\x00-\x1f\x7f]/.test(value.ref))fail('INVALID_PATH');}catch(error){return Promise.reject(error);}return queue(async()=>{assertApplyReady(value.repo);await workspace.execute(value.repo,'gitInspect',{});return readLocalRepositoryAsset(value.repo,value.path,organization.path,value.ref,{builtinRepositories:builtins()});});},
   revealItem:request=>{
    let value;try{
     value=copyRequest(request);
     if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['repo','path','ref'].includes(key))||!Object.hasOwn(value,'path'))fail('INVALID_REQUEST');
     repo(value.repo);if(!readerPath(value.path)||value.ref!==undefined&&typeof value.ref!=='string')fail('INVALID_PATH');
     if(value.ref)throw Object.assign(new Error('Historical revisions have no matching local file to reveal. Select the current branch first.'),{code:'HISTORICAL_REVISION'});
    }catch(error){return Promise.reject(error);}
    return queue(()=>{
     if(typeof revealInFileManager!=='function')throw Object.assign(new Error('Revealing files requires the native application.'),{code:'REVEAL_UNAVAILABLE'});
     assertApplyReady(value.repo);importer.catalog.assertKnown(value.repo);
     const repository=pinDirectory(path.join(organization.path,value.repo));
     if(record.repositoryBindings.find(binding=>binding.name===value.repo)?.identity!==repository.identity)fail('REPOSITORY_CHANGED');
     const filename=path.join(repository.path,value.path);
     if(!contains(repository.path,filename))fail('INVALID_PATH');
     try{
      if(value.path)checkSourceSpelling(repository.path,value.path);
      const item=fs.lstatSync(filename);
      if(item.isSymbolicLink()||fs.realpathSync(filename)!==filename)fail('DENIED');
      if(!item.isFile()&&!item.isDirectory())throw Object.assign(new Error('Only local files and folders can be revealed.'),{code:'REVEAL_UNSUPPORTED'});
      // Reveal the saved working-tree item, never a temporary historical copy.
      // Keep physical validation and OS dispatch in the same synchronous turn.
      checkDirectory(repository);
      if(value.path)checkSourceSpelling(repository.path,value.path);
     }catch(error){
      if(['ENOENT','ENOTDIR','PARTIAL'].includes(error.code))throw Object.assign(new Error('This file or folder is no longer available on this computer.'),{code:'REVEAL_NOT_FOUND'});
      throw error;
     }
     try{revealInFileManager(filename);}catch{throw Object.assign(new Error('The file manager could not reveal this item.'),{code:'REVEAL_FAILED'});}
    });
   },
   bootstrap:name=>queue(()=>{repo(name);assertApplyReady(name);return {...workspace.bootstrap(name),...(isDocumentation(name)?{readOnly:true}:{})};}),
   getRepositoryUpdates:request=>{let value;try{value=copyRequest(request);if(!exact(value,['repo']))fail('INVALID_REQUEST');repo(value.repo);}catch(error){return Promise.reject(updateError(error));}return queue(async()=> (await updatesContext(value.repo)).status).catch(error=>{throw updateError(error);});},
   checkRepositoryUpdates:(request,{signal,credential,onProgress}={})=>{
    let value;try{value=copyRequest(request);if(!exact(value,['repo','requestId'])||!validCreationId(value.requestId))fail('INVALID_REQUEST');repo(value.repo);if(closing)fail('SERVICE_CLOSED');if([...updateJobs].some(job=>job.repo===value.repo)||applyJobs.has(value.repo))fail('UPDATES_BUSY');}catch(error){return Promise.reject(error);}
    const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const job={repo:value.repo,controller,promise:null};updateJobs.add(job);
    job.promise=(async()=>{
     const context=await queue(async()=>{const context=await updatesContext(value.repo);if(!context.status.eligible)fail('UPDATES_UNAVAILABLE');return context;});
     // Network and derived comparison stay outside the native queue. Save and
     // draft checkpoints continue while the isolated remote snapshot arrives.
     const result=await context.manager.check({requestId:value.requestId,localHead:context.meta.head,localBranch:context.meta.branch},{signal:controller.signal,credential,onProgress});
     return queue(async()=>{const current=await updatesContext(value.repo);return current.status.lastCheck?.checkId===result.checkId?current.status.lastCheck:{...result,stale:true};});
    })().catch(error=>{throw updateError(error);}).finally(()=>{signal?.removeEventListener('abort',abort);credential=undefined;updateJobs.delete(job);});
    void job.promise.catch(()=>{});return job.promise;
   },
   reviewRepositoryUpdate:request=>{
    let value;try{value=copyRequest(request);if(!exact(value,['repo','checkId'])||!validCreationId(value.checkId))fail('INVALID_REQUEST');repo(value.repo);if(applyJobs.has(value.repo)||[...updateJobs].some(job=>job.repo===value.repo))fail('UPDATES_BUSY');}catch(error){return Promise.reject(updateError(error));}
    return queue(async()=>{assertApplyReady(value.repo);return applyManagerFor(value.repo).review({checkId:value.checkId},{validateContext:()=>applyReadiness(value.repo)});}).catch(error=>{throw updateError(error);});
   },
   applyRepositoryUpdate:(request,{onProgress}={})=>{
    let value;try{value=copyRequest(request);if(!exact(value,['repo','checkId','reviewId','requestId'])||!['checkId','reviewId','requestId'].every(key=>validCreationId(value[key])))fail('INVALID_REQUEST');repo(value.repo);if(applyJobs.has(value.repo)||[...updateJobs].some(job=>job.repo===value.repo))fail('UPDATES_BUSY');}catch(error){return Promise.reject(updateError(error));}
    applyJobs.add(value.repo);
    return queue(async()=>{
     assertApplyReady(value.repo);const manager=applyManagerFor(value.repo);
     try{return await manager.apply({checkId:value.checkId,reviewId:value.reviewId,requestId:value.requestId},{validateContext:()=>applyReadiness(value.repo),onProgress,onAdmission:async()=>{
      check();if(record.schemaVersion<3)persist({...record,schemaVersion:3});at('apply-profile-upgraded');
     }});}finally{
      try{if(manager.inspect().recoveryRequired)applyHeld.add(value.repo);}catch{applyHeld.add(value.repo);}
      workspace.close();openWorkspace();
     }
    }).catch(error=>{throw updateError(error);}).finally(()=>applyJobs.delete(value.repo));
   },
   readRepositoryUpdateFile:request=>{let value;try{value=copyRequest(request);if(!exact(value,['repo','checkId','path'])||!validCreationId(value.checkId)||!updatePath(value.path))fail('INVALID_REQUEST');repo(value.repo);}catch(error){return Promise.reject(updateError(error));}return queue(async()=>{const context=await updatesContext(value.repo);if(!context.manager||!context.status.eligible)fail('UPDATES_UNAVAILABLE');if(context.status.lastCheck?.stale)fail('UPDATES_STALE');return context.manager.readFile({checkId:value.checkId,path:value.path});}).catch(error=>{throw updateError(error);});},
   request:request=>{let value;try{value=copyRequest(request);if(value&&typeof value==='object'&&!Array.isArray(value)&&value.args===undefined)value.args={};if(!exact(value,['repo','operation','args'])||typeof value.operation!=='string')fail('INVALID_REQUEST');repo(value.repo);}catch(error){return Promise.reject(error);}return queue(async()=>{
    assertApplyReady(value.repo);
    if(isDocumentation(value.repo)&&!['open','discover','inspectEntry','listTrash','runtimeStatus','getCommitPreferences','gitInspect','gitStatus','gitReview'].includes(value.operation))assertWritable(value.repo);
    if(['inspectEntry','manage','restore','reconcile'].includes(value.operation)){workspace.close();try{return await runWorkspaceWorker(value);}finally{openWorkspace();}}
    const result=await workspace.execute(value.repo,value.operation,value.args);return isDocumentation(value.repo)&&value.operation==='open'?{...result,readOnly:true}:result;
   });},
   // Trusted main-process methods. IPC accepts only opaque File/picker tickets,
   // never these absolute source descriptors or cancellation primitives.
   prepareExternalFiles:paths=>{let value;try{value=copyRequest(paths);}catch(error){return Promise.reject(error);}return queue(()=>externalSources(value));},
   importExternalFiles:(request,{signal}={})=>{
    let value;try{value=copyRequest(request);if(!exact(value,['repo','destination','sources'])||!mutationPath(value.destination)||!Array.isArray(value.sources)||!value.sources.length||value.sources.length>256)fail('INVALID_REQUEST');repo(value.repo);
     if(value.sources.some(item=>!exact(item,['path','identity','kind'])||typeof item.identity!=='string'||!/^\d+:\d+$/.test(item.identity)||!['file','directory'].includes(item.kind)))fail('INVALID_EXTERNAL_FILES');
    }catch(error){return Promise.reject(error);}
    return queue(async()=>{
     assertWritable(value.repo);
     assertApplyReady(value.repo);importer.catalog.assertKnown(value.repo);if(signal?.aborted)fail('IMPORT_CANCELLED');
     const live=externalSources(value.sources.map(item=>item.path));if(JSON.stringify(live)!==JSON.stringify(value.sources))fail('CONFLICT');
     // The full synchronous filesystem engine runs in a dedicated worker so
     // hashing/copy/publication cannot stall native cancellation/window events.
     workspace.close();try{return await runWorkspaceWorker({...value,operation:'importExternal'},signal);}finally{openWorkspace();}
    });
   },
   renameRepository:request=>{
    let value;try{value=copyRequest(request);if(!exact(value,['repository','name']))fail('INVALID_REQUEST');repo(value.repository);if(!validRepositoryName(value.name))fail('INVALID_REPOSITORY_NAME');}catch(error){return Promise.reject(error);}
    return queue(async()=>{
     assertWritable(value.repository);
     assertApplyReady(value.repository);if(applyJobs.has(value.repository)||[...updateJobs].some(job=>job.repo===value.repository))fail('UPDATES_BUSY');
     importer.catalog.assertKnown(value.repository);
     const result=()=>({repository:value.name,previousName:value.repository,organization:'asMagicBrain',defaultRepository:record.workspaceName,repositories:importer.catalog.list()});
     if(value.repository===value.name)return result();
     importer.catalog.assertAvailable(value.name);
     workspace.bootstrap(value.repository);
     if((await workspace.execute(value.repository,'runtimeStatus',{})).recoveryRequired)fail('RECOVERY_REQUIRED');
     const git=await workspace.execute(value.repository,'gitInspect',{});if(git.recoveryRequired)fail('RECOVERY_REQUIRED');if(git.busy)fail('GIT_BUSY');
     const binding=record.repositoryBindings.find(item=>item.name===value.repository),source=pinDirectory(path.join(organization.path,value.repository));
     if(!binding||binding.identity!==source.identity)fail('REPOSITORY_CHANGED');
     importer.catalog.assertAvailable(value.name);check();
     persist({...record,pendingRename:{repository:value.repository,name:value.name,identity:source.identity,isDefault:value.repository===record.workspaceName,reservationIdentity:null}});
     workspace.close();
     try{
      at('rename-intent');finishRename();
      sourcePin=pinDirectory(path.join(organization.path,record.workspaceName));
      importer=createRepositoryImporter({base:organization.path,builtinRepositories:builtins(),hooks});updateManagers.delete(binding.stateKey);applyManagers.delete(binding.stateKey);openWorkspace();
      return result();
     }catch(error){renameHeld=true;throw Object.assign(new Error('Repository rename requires recovery. Reopen the application to retry the recorded operation. Unrecognized destination state will remain preserved for manual recovery.'),{code:'RECOVERY_REQUIRED',cause:error});}
    });
   },
   duplicateRepository:request=>{
    let value;try{value=copyRequest(request);if(!exact(value,['repository','name','requestId'])||!validCreationId(value.requestId))fail('INVALID_REQUEST');repo(value.repository);if(!validRepositoryName(value.name))fail('INVALID_REPOSITORY_NAME');}catch(error){return Promise.reject(error);}
    return queue(async()=>{
     const {source,git}=await managementReady(value.repository);if(record.repositoryBindings.length>=1000&&!importer.catalog.created(value.requestId,value.name,'local-copy'))fail('LIMIT_EXCEEDED');
     if(record.schemaVersion<4)persist({...record,schemaVersion:4});workspace.close();
     try{const copied=await importer.duplicateRepository({sourceRoot:source.path,name:value.name,requestId:value.requestId,head:git.head});syncBindings();return {...managementResult(copied.name),sourceRepository:value.repository};}
     finally{reopenAfterManagement();}
    });
   },
   listTrashedRepositories:()=>queue(()=>repositoryManagement?repositoryManagement.list():[]),
   trashRepository:request=>{
    let value;try{value=copyRequest(request);if(!exact(value,['repository','requestId'])||!validCreationId(value.requestId))fail('INVALID_REQUEST');repo(value.repository);}catch(error){return Promise.reject(error);}
    return queue(async()=>{
     assertWritable(value.repository);
     if(value.repository===record.workspaceName)fail('DEFAULT_REPOSITORY_PROTECTED');const previous=repositoryManagement?.find(value.requestId);
     if(previous){const active=record.repositoryBindings.find(v=>v.name===value.repository);if(previous.name!==value.repository||active&&active.identity!==previous.binding.identity)fail('REQUEST_CONFLICT');return {...managementResult(value.repository),trashId:previous.trashId};}
     if(repositoryManagement?.completedRestore(value.requestId))fail('REQUEST_CONFLICT');
     const {binding}=await managementReady(value.repository);if(record.schemaVersion<4)persist({...record,schemaVersion:4});workspace.close();
     try{const entry=management().trash({binding,requestId:value.requestId});updateManagers.delete(binding.stateKey);applyManagers.delete(binding.stateKey);reopenAfterManagement();return {...managementResult(value.repository),trashId:entry.trashId};}
     catch(error){renameHeld=true;throw Object.assign(new Error('Repository Trash requires recovery. Reopen the application to finish the recorded operation. Your repository and private state are retained.'),{code:'RECOVERY_REQUIRED',cause:error});}
    });
   },
   restoreRepository:request=>{
    let value;try{value=copyRequest(request);if(!exact(value,['trashId','name'])||!validCreationId(value.trashId))fail('INVALID_REQUEST');if(!validRepositoryName(value.name))fail('INVALID_REPOSITORY_NAME');}catch(error){return Promise.reject(error);}
    return queue(()=>{
     if(!repositoryManagement)fail('UNKNOWN_REPOSITORY_TRASH');const entry=repositoryManagement.find(value.trashId);
     if(!entry){const done=repositoryManagement.completedRestore(value.trashId);if(done&&done.name===value.name&&record.repositoryBindings.some(v=>v.name===done.name&&v.identity===done.identity))return managementResult(value.name);fail('UNKNOWN_REPOSITORY_TRASH');}
     if(record.repositoryBindings.length>=1000)fail('LIMIT_EXCEEDED');importer.catalog.assertAvailable(value.name);workspace.close();
     try{repositoryManagement.restore(value);reopenAfterManagement();return managementResult(value.name);}
     catch(error){renameHeld=true;throw Object.assign(new Error('Repository restore requires recovery. Reopen the application to finish the recorded operation. Existing destinations remain protected.'),{code:'RECOVERY_REQUIRED',cause:error});}
    });
   },
   createRepository:request=>{
    let value;try{value=copyRequest(request);if(!exact(value,['name','requestId'])||!validCreationId(value.requestId))fail('INVALID_REQUEST');if(!validRepositoryName(value.name))fail('INVALID_REPOSITORY_NAME');}catch(error){return Promise.reject(error);}
    return queue(async()=>{
     if(record.repositoryBindings.length>=1000&&!importer.catalog.created(value.requestId,value.name))fail('LIMIT_EXCEEDED');
     const result=await importer.createRepository(value);at('create-before-bindings');syncBindings();at('create-bound');
     workspace.close();openWorkspace();return result;
    });
   },
   cloneRepository:(request,{signal,credential,onProgress}={})=>{
    let value;try{value=copyRequest(request);if(!exact(value,['name','url','requestId'])||!validCreationId(value.requestId))fail('INVALID_REQUEST');if(!validRepositoryName(value.name))fail('INVALID_REPOSITORY_NAME');value.url=canonicalGitHubUrl(value.url);}catch(error){return Promise.reject(error);}
    return queue(async()=>{
     if(record.repositoryBindings.length>=1000&&!importer.catalog.created(value.requestId,value.name,'github',value.url))fail('LIMIT_EXCEEDED');
     const result=await importer.cloneRepository(value,{signal,credential,onProgress});at('clone-before-bindings');syncBindings();at('clone-bound');
     workspace.close();openWorkspace();return result;
    });
   },
   importArchive:request=>{
    let name,bytes;try{if(!exact(request,['name','bytes'])||!(request.bytes instanceof Uint8Array)&&!(request.bytes instanceof ArrayBuffer))fail('INVALID_REQUEST');name=request.name;if(!validRepositoryName(name))fail('INVALID_REPOSITORY_NAME');if(request.bytes.byteLength>ZIP_IMPORT_LIMITS.archiveBytes)fail('ZIP_LIMIT_EXCEEDED');if(importPending)fail('IMPORT_BUSY');if(closing)fail('SERVICE_CLOSED');bytes=Buffer.from(request.bytes instanceof ArrayBuffer?new Uint8Array(request.bytes):request.bytes);importPending=true;}catch(error){return Promise.reject(error);}
    return queue(async()=>{
     if(record.repositoryBindings.length>=1000)fail('LIMIT_EXCEEDED');
     importer.catalog.assertAvailable(name);const pin=importer.catalog.ensure(),filename=path.join(pin.path,`upload-${randomUUID()}.zip`);let owned;
     try{writeExclusive(filename,bytes);owned=identity(fs.lstatSync(filename));bytes=null;const result=await importer.importArchive({name,archivePath:filename});syncBindings();workspace.close();openWorkspace();return result;}
     finally{if(owned){checkDirectory(pin);const live=exists(filename);if(live&&identity(live)===owned){fs.unlinkSync(filename);syncDirectory(pin);}}}
    }).finally(()=>{importPending=false;});
   },
   getRepositoryPins:()=>queue(()=>preferences().get(record.repositoryBindings.filter(binding=>!isDocumentation(binding.name)),record.workspaceName)),
   setRepositoryPinned:request=>{let value;try{value=copyRequest(request);if(!exact(value,['repo','pinned'])||typeof value.pinned!=='boolean')fail('INVALID_REQUEST');repo(value.repo);}catch(error){return Promise.reject(error);}return queue(()=>{assertWritable(value.repo);importer.catalog.assertKnown(value.repo);return preferences().set(record.repositoryBindings.filter(binding=>!isDocumentation(binding.name)),record.workspaceName,value.repo,value.pinned);});},
   listRepositoryFiles:request=>search.listRepositoryFiles(request),
   searchRepositoryText:request=>search.searchRepositoryText(request),
   cancelRepositorySearch:request=>search.cancelRepositorySearch(request),
   prepareSearchClose:()=>search.prepareClose(),
   resumeSearch:()=>search.resume(),
   getAppearance:()=>queue(()=>({...record.appearance})),
   setAppearance:value=>{let next;try{next=copyRequest(value);if(!appearanceValid(next))fail('INVALID_APPEARANCE');}catch(error){return Promise.reject(error);}return queue(()=>{persist({...record,appearance:next});return {...record.appearance};});},
   drain:async()=>{await search.drain();await Promise.allSettled([...updateJobs].map(job=>job.promise));await serial;},
   close:()=>{if(closePromise)return closePromise;closing=true;void search.close();for(const job of updateJobs)job.controller.abort();closePromise=Promise.allSettled([search.close(),...[...updateJobs].map(job=>job.promise)]).then(()=>serial).then(()=>{if(closed)return;workspace.close();release();closed=true;});return closePromise;},
  });
 }catch(error){try{workspace?.close();}finally{try{release();}catch{}}throw error;}
}
