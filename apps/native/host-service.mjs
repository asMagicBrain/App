import {createTeachAccessBatch} from './teach-access-batch.mjs';
import {createTeachSubmissions} from './teach-submissions.mjs';
import {openRawFile} from '../../packages/desktop-host/src/local-git/raw-file.mjs';
import {createTeachProjects} from './teach-projects.mjs';
import {createTeachStaffAccess} from './teach-staff-access.mjs';
import {createTeachGitHubProvider} from './teach-github-provider.mjs';
import {createTeachGitHubSetup} from './teach-github-setup.mjs';
import {createPromotionReceipts} from './teach-promotion-receipts.mjs';
import {createTeachRepositoryGraph} from './teach-repository-graph.mjs';
import {createTeachWorkflow} from './teach-workflow.mjs';
import {buildRolePromotion,PROMOTION_LIMITS} from './teach-promotion.mjs';
import {createRepositoryConnections,validConnectionBranch} from './repository-connections.mjs';
import {createTeachPairs} from './teach-pairs.mjs';
import {internalTeachPath,teachMetadataPaths} from '../../packages/asteach-plugin/metadata.mjs';
import {courseKey,parseCourse} from '../../packages/asteach-plugin/course.mjs';
import {createPackageZip} from '../../packages/desktop-host/src/package-exchange/archive.mjs';
import {readPublicationFile,createTeachPublication,buildAudiencePublication} from './teach-publication.mjs';
import {isTrustedTeachPackage} from '../../packages/asteach-plugin/binding.mjs';
import {createTeachDefaults} from './teach-defaults.mjs';
import {createTeachService} from './teach-service.mjs';
import {persistentIdentity, currentStorageIdentity, runWithStorageIdentity} from '../../packages/source-foundation/src/adapters/storage-identity.mjs';
import fs from 'node:fs';
import {createAutomationDispatch} from './automation-dispatch.mjs';
import {createReadingService} from './reading-service.mjs';
import {createPackageExchange} from '../../packages/desktop-host/src/package-exchange/index.mjs';
import {createPluginPackageManager} from '../../packages/desktop-host/src/plugin-packages/manager.mjs';
import {PLUGIN_PACKAGE_LIMITS} from '../../packages/desktop-host/src/plugin-packages/format.mjs';
import {validateAutomationFiles} from './automation-validation.mjs';
import {renderOffline,analyzeReferences} from './dist-host/offline-reader.mjs';
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
import {prepareArtifactSnapshot} from './artifact-snapshot.mjs';
import {pinDirectory,checkDirectory,checkSourceSpelling,contains} from '../../packages/desktop-host/src/physical-roots.mjs';
import {inspectExternalSources} from '../../packages/desktop-host/src/repository-runtime/file-management.mjs';
import {isPortableRelativePath,isInspectableRelativePath,portablePathKey} from '../../packages/source-foundation/src/domain/path-policy.mjs';

const THEMES=new Set(['light-default','light-high-contrast','light-colorblind','dark-default','dark-high-contrast','dark-colorblind','dark-dimmed','light','dark']);
const README='# Workspace\n\nYour local workspace. Create a file or import a ZIP to begin.\n';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const updateError=error=>{const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{1,79}$/.test(error.code)?error.code:'UPDATES_FAILED';return Object.assign(new Error(code),{code});};
const identity=persistentIdentity;
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
 const verify=()=>{checkDirectory(root);const live=readSmall(filename);if(live.identity!==owned.identity||!live.bytes.equals(owned.bytes))fail('RECOVERY_REQUIRED');};
 const release=()=>{verify();fs.unlinkSync(filename);syncDirectory(root);};release.verify=verify;return release;
}
// Admission and the service share one host-issued lock. A second process cannot
// enter between recovery inspection, backup, namespace publication and opening.
const admittedLocks=new WeakMap();
export function acquireNativeProfileLock(dataRoot){
 const context=currentStorageIdentity(),root=privateDirectory(dataRoot),release=acquireLock(root);
 const state={root:root.path,identity:root.identity,consumed:false,released:false,verify:release.verify};
 const capability=Object.freeze({release(){if(state.released)return;runWithStorageIdentity(context,release);state.released=true;}});
 admittedLocks.set(capability,state);return capability;
}
function consumeProfileLock(capability,root){
 const value=admittedLocks.get(capability);
 if(!value||value.consumed||value.released||value.root!==root.path||value.identity!==root.identity)fail('RECOVERY_REQUIRED');
 value.verify();value.consumed=true;return ()=>capability.release();
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
async function createNativeServiceInContext({dataRoot,hooks={},revealInFileManager,ripgrepPath,searchLimits,bundledDocs,profileLock,getGitHubCredential,githubFetch}={}){
 if(typeof dataRoot!=='string'||!path.isAbsolute(dataRoot)||path.normalize(dataRoot)!==dataRoot)fail('INVALID_DATA_ROOT');
 const root=privateDirectory(dataRoot,true);assertOutsideGit(root.path);
 const ownedPreview=hasPreviewDataOwnership(root.path);
 const names=fs.readdirSync(root.path).filter(name=>(!ownedPreview||name!=='.asmagicbrain-channel.json')&&(!currentStorageIdentity()||name!=='.asmb-storage-volume.json')),fresh=names.length===0;
 // A previous process may have died after writing only its lock. Retain every
 // other interrupted setup for explicit recovery; never adopt arbitrary data.
 const lockOnly=names.length===1&&names[0]==='.asmb-native.lock';
 const release=profileLock?consumeProfileLock(profileLock,root):acquireLock(root);let workspace;
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
  const updateManagers=new Map(),applyManagers=new Map(),updateJobs=new Set(),applyJobs=new Set(),applyHeld=new Set(),exchangeManagers=new Map(),exchangeHeld=new Set();
  const connections=createRepositoryConnections(createPrivateStore({privateRoot:privateDirectory(path.join(privateRoot.path,".asmb-github-connections"),true).path,bindingHash:createHash("sha256").update(bindingHash+":github-connections:1").digest("hex")}));
  function updateManagerFor(name){
   importer.catalog.assertKnown(name);
   const knownBinding=record.repositoryBindings.find(value=>value.name===name);
   const provenance=importer.catalog.provenance(name)??connections.get(knownBinding?.stateKey);if(!provenance)return null;
   const binding=record.repositoryBindings.find(value=>value.name===name),source=pinDirectory(path.join(organization.path,name));
   if(!binding||binding.identity!==source.identity||source.identity!==provenance.identity)fail('REPOSITORY_CHANGED');
   let manager=updateManagers.get(binding.stateKey);
   if(!manager){const perRepository=privateDirectory(path.join(privateRoot.path,binding.stateKey),true),updates=privateDirectory(path.join(perRepository.path,'github-updates'),true);manager=createGitHubUpdates({sourceRoot:source.path,sourceBindingRoot:path.join(organization.path,binding.bindingName),privateRoot:updates.path,sourceUrl:provenance.sourceUrl,branch:provenance.branch,hooks:{acquire:hooks.updatesAcquire,at:hooks.updatesAt,push:hooks.pushTransport}});updateManagers.set(binding.stateKey,manager);}
   return {manager,binding,source,provenance};
  }
  function applyManagerFor(name){
   const context=updateManagerFor(name);if(!context)fail('UPDATES_UNAVAILABLE');
   const {binding,source,manager:snapshots}=context;let manager=applyManagers.get(binding.stateKey);
   if(!manager){const directory=privateDirectory(path.join(privateRoot.path,binding.stateKey,'github-apply'),true);manager=createGitHubApply({sourceRoot:source.path,sourceBindingRoot:path.join(organization.path,binding.bindingName),privateRoot:directory.path,snapshots,hooks:{at:hooks.applyAt,workerStopAfter:hooks.applyWorkerStopAfter}});applyManagers.set(binding.stateKey,manager);}
   return manager;
  }
  const assertApplyReady=name=>{if(applyHeld.has(name))fail('APPLY_RECOVERY_REQUIRED');if(exchangeHeld.has(name))fail('PACKAGE_RECOVERY_REQUIRED');};
  syncBindings();
  // Recover admitted updates before any workspace session can read a mixed
  // source/index or run its ordinary local Git recovery. Unknown bytes hold only
  // that repository; its retained data is never silently reset.
  for(const binding of record.repositoryBindings){
   if(!exists(path.join(privateRoot.path,binding.stateKey,'github-apply')))continue;
   try{const manager=applyManagerFor(binding.name);if(manager.inspect().recoveryRequired&&record.schemaVersion<3)fail('APPLY_RECOVERY_REQUIRED');const recovered=await manager.recover();if(recovered.status==='held')applyHeld.add(binding.name);}catch{applyHeld.add(binding.name);}
  }
  function exchangeFor(name){
   importer.catalog.assertKnown(name);const binding=record.repositoryBindings.find(value=>value.name===name),source=pinDirectory(path.join(organization.path,name));
   if(!binding||source.identity!==binding.identity)fail('REPOSITORY_CHANGED');
   const key=binding.stateKey;let manager=exchangeManagers.get(key);
   if(!manager){const perRepository=privateDirectory(path.join(privateRoot.path,key),true),directory=privateDirectory(path.join(perRepository.path,'package-exchange'),true);
    manager=createPackageExchange({sourceRoot:source.path,sourceBindingRoot:path.join(organization.path,binding.bindingName),privateRoot:directory.path,renderOffline,getDraftPaths:async()=>{const runtime=await workspace.execute(name,'runtimeStatus',{});if(runtime.recoveryRequired)fail('RECOVERY_REQUIRED');return [...runtime.draftPaths,...runtime.recoveredDrafts.map(value=>value.path),...workspace.bootstrap(name).newDrafts.map(value=>value.path)];},hooks:{at:hooks.packageAt,transactionAt:hooks.packageTransactionAt}});exchangeManagers.set(key,manager);}
   return manager;
  }
  // Interrupted package publication stays explicit: no ordinary writes to a mixed collection.
  for(const binding of record.repositoryBindings){if(exists(path.join(privateRoot.path,binding.stateKey,'package-exchange'))){try{if(exchangeFor(binding.name).status().recoveryRequired)exchangeHeld.add(binding.name);}catch{exchangeHeld.add(binding.name);}}}
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
    const worker=new Worker(new URL('../../packages/desktop-host/src/repository-import/external-worker.mjs',import.meta.url),{workerData:{workspace:{base:organization.path,privateBase:privateRoot.path,builtinRepositories:builtins(),repositoryBindings:record.repositoryBindings,localOwnerId:record.ownerId,localRootId:'native'},...value,storageIdentity:currentStorageIdentity(),cancelFlag,reportPhases:typeof hooks.externalPhase==='function',...(value.operation==='importExternal'&&hooks.externalInterruptAt?{interruptAt:hooks.externalInterruptAt}:{}),...(value.operation==='importExternal'&&hooks.externalExitAt?{exitAt:hooks.externalExitAt}:{})}});let result;
    worker.on('message',message=>{if(Object.hasOwn(message,'ok'))result=message;else if(message.phase)hooks.externalPhase?.(message.phase);});
    worker.once('error',reject);worker.once('exit',code=>{if(code!==0||!result)reject(Object.assign(new Error('The local file operation was interrupted. Reopen and reconcile the repository before continuing.'),{code:'RECOVERY_REQUIRED'}));else if(!result.ok)reject(Object.assign(new Error(result.message??result.code),{code:result.code}));else resolve(result.value);});
   });
   return operation.finally(()=>signal?.removeEventListener('abort',cancel));
  }
  const search=createRepositorySearch({ripgrepPath,limits:searchLimits,admit:(selection,searchInput)=>queue(async()=>{
   const names=selection===null?importer.catalog.list().map(item=>item.name):[repo(selection)];
   if(searchInput.ref)for(const name of names)await workspace.execute(name,'gitInspect',{});
   return Promise.all(names.map(async name=>{repo(name);assertApplyReady(name);importer.catalog.assertKnown(name);const pin=pinDirectory(path.join(organization.path,name));if(record.repositoryBindings.find(item=>item.name===name)?.identity!==pin.identity)fail('REPOSITORY_CHANGED');return {repo:name,pin,excluded:[...await hiddenTeachPaths(name)]};}));
  })});
  let repositoryPins;
  const preferences=()=>{if(!repositoryPins){const directory=privateDirectory(path.join(privateRoot.path,'.asmb-repository-pins'),true);repositoryPins=createRepositoryPins({privateRoot:directory.path,bindingHash:createHash('sha256').update(bindingHash+':repository-pins:1').digest('hex')});}return repositoryPins;};
  async function managementReady(name){
   assertApplyReady(name);if(applyJobs.has(name)||[...updateJobs].some(job=>job.repo===name))fail('UPDATES_BUSY');importer.catalog.assertKnown(name);
   workspace.bootstrap(name);if((await workspace.execute(name,'runtimeStatus',{})).recoveryRequired)fail('RECOVERY_REQUIRED');
   const git=await workspace.execute(name,'gitInspect',{});if(git.recoveryRequired)fail('RECOVERY_REQUIRED');if(git.busy)fail('GIT_BUSY');
   const binding=record.repositoryBindings.find(v=>v.name===name),source=pinDirectory(path.join(organization.path,name));if(!binding||binding.identity!==source.identity)fail('REPOSITORY_CHANGED');return {binding,source,git};
  }
  const readingRepositories=()=>importer.catalog.list().map(entry=>({...entry,stableId:createHash('sha256').update(record.ownerId+':'+record.repositoryBindings.find(binding=>binding.name===entry.name)?.stateKey).digest('hex')}));
  const readingDirectory=privateDirectory(path.join(privateRoot.path,'.asmb-reading'),true);
  const reading=createReadingService({repositories:readingRepositories,redirectStore:createPrivateStore({privateRoot:readingDirectory.path,bindingHash:createHash('sha256').update(bindingHash+':reading:1').digest('hex')}),readSnapshot:async input=>{repo(input.repo);assertApplyReady(input.repo);await workspace.execute(input.repo,'gitInspect',{});return readLocalRepository(input.repo,input.path,organization.path,input.ref,{builtinRepositories:builtins()});}});
  const pluginDirectory=privateDirectory(path.join(privateRoot.path,'.asmb-plugin-packages'),true);
  const pluginPackages=createPluginPackageManager({privateRoot:pluginDirectory.path,bindingHash:createHash('sha256').update(bindingHash+':plugin-packages:1').digest('hex'),hooks:{at:hooks.pluginPackageAt}});
  function readingInput(request){const value=copyRequest(request);if(!exact(value,['repo','path','ref'])||!readerPath(value.path)||typeof value.ref!=='string'||value.ref.length>1024||/[\x00-\x1f\x7f]/.test(value.ref))fail('INVALID_REQUEST');repo(value.repo);return value;}
  function packageRequest(request,fields){const value=copyRequest(request);if(!exact(value,['repo',...fields]))fail('INVALID_REQUEST');repo(value.repo);return value;}
  function packageArchive(request,fields){if(!request||!(request.bytes instanceof ArrayBuffer)&&!ArrayBuffer.isView(request.bytes))fail('INVALID_REQUEST');const bytes=Buffer.from(request.bytes instanceof ArrayBuffer?new Uint8Array(request.bytes):request.bytes);if(!bytes.length||bytes.length>ZIP_IMPORT_LIMITS.archiveBytes)fail('LIMIT_EXCEEDED');const {bytes:ignored,...metadata}=request;const value=packageRequest(metadata,fields);return {...value,bytes:Buffer.from(bytes)};}
  function pluginArchive(request,fields){if(!request||!(request.bytes instanceof ArrayBuffer)&&!ArrayBuffer.isView(request.bytes))fail('PLUGIN_PACKAGE_INVALID_REQUEST');const bytes=Buffer.from(request.bytes instanceof ArrayBuffer?new Uint8Array(request.bytes):request.bytes);if(!bytes.length||bytes.length>PLUGIN_PACKAGE_LIMITS.archiveBytes)fail('PLUGIN_PACKAGE_LIMIT');const {bytes:ignored,...metadata}=request;if(!exact(metadata,fields))fail('PLUGIN_PACKAGE_INVALID_REQUEST');return {...copyRequest(metadata),bytes};}
  async function packageMutation(name,action){assertWritable(name);if(applyHeld.has(name))fail('APPLY_RECOVERY_REQUIRED');const manager=exchangeFor(name);try{return await action(manager);}finally{workspace.close();openWorkspace();try{if(manager.status().recoveryRequired)exchangeHeld.add(name);else exchangeHeld.delete(name);}catch{exchangeHeld.add(name);}}}
  const managementResult=repository=>({repository,organization:'asMagicBrain',defaultRepository:record.workspaceName,repositories:readingRepositories()});
  const reopenAfterManagement=()=>{exchangeManagers.clear();importer=createRepositoryImporter({base:organization.path,builtinRepositories:builtins(),hooks});openWorkspace();};
  const automationWrite=(input,publish)=>queue(async()=>{
   const value=copyRequest(input);if(!exact(value,['repoId','repo','path','expectedHash','text'])||!mutationPath(value.path)||!value.path||typeof value.text!=='string'||Buffer.byteLength(value.text)>65536||value.expectedHash!==null&&!/^[a-f0-9]{64}$/.test(value.expectedHash))fail('INVALID_REQUEST');
   assertWritable(value.repo);await managementReady(value.repo);
   if(readingRepositories().find(entry=>entry.name===value.repo)?.stableId!==value.repoId)fail('REPOSITORY_CHANGED');
   const runtime=await workspace.execute(value.repo,'runtimeStatus',{}),drafts=[...runtime.draftPaths,...runtime.recoveredDrafts.map(entry=>entry.path),...workspace.bootstrap(value.repo).newDrafts.map(entry=>entry.path)];
   if(drafts.some(draft=>portablePathKey(draft)===portablePathKey(value.path)))fail('DRAFT_CONFLICT');
   const missing=()=>{let parent=pinDirectory(path.join(organization.path,value.repo));for(const segment of value.path.split('/')){checkDirectory(parent);const matches=fs.readdirSync(parent.path).filter(name=>portablePathKey(name)===portablePathKey(segment));if(!matches.length){checkDirectory(parent);return true;}if(matches.length!==1||matches[0]!==segment)fail('CONFLICT');const full=path.join(parent.path,segment),stat=fs.lstatSync(full);if(stat.isSymbolicLink())fail('DENIED');if(full===path.join(organization.path,value.repo,value.path))return false;if(!stat.isDirectory())fail('CONFLICT');parent=pinDirectory(full);}return false;};
   let current=null;try{current=await workspace.execute(value.repo,'open',{path:value.path});}catch(error){if(!['ENOENT','NOT_FOUND','PARTIAL'].includes(error.code)||!missing())throw error;}
   if((current?.sourceHash??null)!==value.expectedHash||current?.readOnly||current?.draft)fail('CONFLICT');
   if(!publish)return {kind:'write',repo:value.repo,repoId:value.repoId,path:value.path,before:current?.text??null,after:value.text,expectedHash:value.expectedHash,afterHash:createHash('sha256').update(value.text).digest('hex')};
   const saved=await workspace.execute(value.repo,current?'save':'create',current?{path:value.path,baseHash:value.expectedHash,text:value.text}:{path:value.path,text:value.text});return {path:saved.path,sourceHash:saved.sourceHash,documentId:saved.documentId};
  });
  const automationImport=value=>queue(async()=>{
   if(!validCreationId(value.requestId)||!validRepositoryName(value.name)||value.initializeHistory!==false||!Buffer.isBuffer(value.bytes)||value.bytes.length>262144)fail('INVALID_REQUEST');
   const pin=importer.catalog.ensure(),filename=path.join(pin.path,`upload-${randomUUID()}.zip`);let owned;
   try{writeExclusive(filename,value.bytes);owned=identity(fs.lstatSync(filename));const result=await importer.importArchive({name:value.name,archivePath:filename,requestId:value.requestId,initializeHistory:false});syncBindings();workspace.close();openWorkspace();return result;}
   finally{if(owned){checkDirectory(pin);const live=exists(filename);if(live&&identity(live)===owned){fs.unlinkSync(filename);syncDirectory(pin);}}}
  });
  const teachDefaults=createTeachDefaults(createPrivateStore({privateRoot:privateDirectory(path.join(privateRoot.path,".asmb-teach-defaults"),true).path,bindingHash:createHash("sha256").update(bindingHash+":teach-defaults:1").digest("hex")}));
  const importTeachCourse=async (value,{maxBytes=262144}={})=>{
    if(!validCreationId(value.requestId)||!validRepositoryName(value.name)||!Buffer.isBuffer(value.bytes)||value.bytes.length>maxBytes)fail('INVALID_REQUEST');
    const pin=importer.catalog.ensure(),filename=path.join(pin.path,`upload-${randomUUID()}.zip`);let owned;
    try{writeExclusive(filename,value.bytes);owned=identity(fs.lstatSync(filename));const result=await importer.importArchive({name:value.name,archivePath:filename,requestId:value.requestId,initializeHistory:false});syncBindings();workspace.close();openWorkspace();return result;}
    finally{if(owned){checkDirectory(pin);const live=exists(filename);if(live&&identity(live)===owned){fs.unlinkSync(filename);syncDirectory(pin);}}}
   };
  const teachPairs=createTeachPairs(createPrivateStore({privateRoot:privateDirectory(path.join(privateRoot.path,'.asmb-teach-pairs'),true).path,bindingHash:createHash('sha256').update(bindingHash+':teach-pairs:1').digest('hex')}));
  async function probeTeachFile(name,relative){
   try{const entry=await workspace.execute(name,'inspectEntry',{path:relative});if(entry.type!=='file')fail('CONFLICT');return true;}
   catch(error){if(!['NOT_FOUND','ENOENT','PARTIAL'].includes(error.code))throw error;return false;}
  }
  async function teachPath(name,relative){
   // A bounded whole-tree inventory cannot prove a known file is absent.
   return await probeTeachFile(name,'.asteach/course.json')?internalTeachPath(relative):relative;
  }
  async function hiddenTeachPaths(name,entries){
   const mapped=await teachPath(name,'asteach-course.json');
   if(mapped!== 'asteach-course.json'&&!entries)return new Set(['.asteach']);
   if(mapped!== 'asteach-course.json')return new Set(entries.filter(e=>e.path==='.asteach'||e.path.startsWith('.asteach/')).map(e=>e.path));
   let legacy=false;try{legacy=(await workspace.execute(name,'inspectEntry',{path:'asteach-course.json'})).type==='file';}catch(error){if(!['NOT_FOUND','ENOENT','PARTIAL'].includes(error.code))throw error;}
   if(entries?.some(e=>e.path==='.asteach'||e.path.startsWith('.asteach/'))&&!legacy)return new Set(entries.filter(e=>e.path==='.asteach'||e.path.startsWith('.asteach/')).map(e=>e.path));
   if(!entries&&legacy){const file=await workspace.execute(name,'open',{path:'asteach-course.json'}),course=parseCourse(file.text);return new Set(['asteach-course.json',...course.terms.flatMap(term=>['teaching','class-pages','class-packages'].map(kind=>`${term.year}-${term.season}/${kind}.json`))]);}
   return new Set(legacy?teachMetadataPaths([{path:'asteach-course.json'},...(entries??[])]):[]);
  }
  const teach=createTeachService({
   defaults:teachDefaults,probe:probeTeachFile,directStudents:async(name,term)=>{const value=await workflow.descriptor(name,term);if(value.pending)fail('TEACH_WORKFLOW_RECOVERY_REQUIRED');const role=value.roles.find(r=>r.role==='students');if(!role?.available)fail('TEACH_STUDENT_UNAVAILABLE');return role;},
   checkCreatePaths:async(name,paths)=>{const trash=await workspace.execute(name,'listTrash',{});if(trash.some(entry=>paths.some(target=>{const reserved=portablePathKey(entry.path),key=portablePathKey(target);return key===reserved||key.startsWith(reserved+'/');})))fail('TRASH_PATH_RESERVED');},
   repositories:readingRepositories,
   prepare:async name=>{repo(name);assertWritable(name);await managementReady(name);},
   read:async(name,relative)=>{relative=await teachPath(name,relative);let file;try{file=await workspace.execute(name,'open',{path:relative});}catch(error){if(['NOT_FOUND','ENOENT','PARTIAL'].includes(error.code))return null;throw error;}if(file.readOnly||file.draft)fail('DRAFT_CONFLICT');return file;},
   writeBatch:async(name,files)=>workspace.writeBatch(name,await Promise.all(files.map(async file=>({...file,path:await teachPath(name,file.path)})))),
   importCourse:importTeachCourse,beginCreate:course=>workflow.startCreation(course.courseId,createHash('sha256').update(JSON.stringify(course)).digest('hex')),workflowMode:id=>workflow.get(id)?.mode??null,
   ensurePair:async(found,options)=>{
    const direct=options?.fresh===true&&workflow.creation(found.course.courseId)===createHash('sha256').update(JSON.stringify(found.course)).digest('hex')||workflow.get(found.course.courseId)?.mode==='direct-students';
    await ensureTeachPair(found,undefined,direct);
    if(direct){await graph.initialize(found.repo);const prior=workflow.get(found.course.courseId),homes={...prior?.homes};for(const term of found.course.terms){const id=`${term.year}-${term.season}`;homes[id]??=id+'/student.md';}
     if(!prior)await workflow.initialize(found.repo,homes);else if(JSON.stringify(homes)!==JSON.stringify(prior.homes)){const plan=await workflow.review(found.repo,homes);await workflow.apply(plan.planId);}
    }
   }
  });
  const promotionReceipts=createPromotionReceipts(createPrivateStore({privateRoot:privateDirectory(path.join(privateRoot.path,'.asmb-teach-promotion-receipts'),true).path,bindingHash:createHash('sha256').update(bindingHash+':teach-promotion-receipts:1').digest('hex')}));
  const graphStore=createPrivateStore({privateRoot:privateDirectory(path.join(privateRoot.path,'.asmb-teach-graph'),true).path,bindingHash:createHash('sha256').update(bindingHash+':teach-graph:1').digest('hex')});
  const graph=createTeachRepositoryGraph({store:graphStore,snapshot:async name=>{
   const courses=await teach({operation:'list'}),found=courses.find(c=>c.repo===name);if(!found)fail('INVALID_COURSE');
   await managementReady(name);const entries=readingRepositories(),instructor=entries.find(e=>e.name===name),pair=teachPairs.get(instructor.stableId);
   const reservedIds=courses.flatMap(c=>{const id=entries.find(e=>e.name===c.repo)?.stableId,p=teachPairs.get(id);return [id,p?.destinationId,...Object.values(graph.get(c.course.courseId)?.bindings??{})].filter(Boolean);});
   return {courseId:found.course.courseId,instructorId:instructor.stableId,studentId:pair?.destinationId??null,courseHash:found.hash,terms:found.course.terms.map(t=>`${t.year}-${t.season}`),repositories:entries.filter(e=>e.name!==record.workspaceName&&!isDocumentation(e.name)).map(e=>{const p=updateManagerFor(e.name)?.provenance;return {name:e.name,stableId:e.stableId,sourceUrl:p?.sourceUrl??null,branch:p?.branch??null};}),reservedIds};
  }});
  const teachGitHubProvider=createTeachGitHubProvider({getCredential:getGitHubCredential,fetch:githubFetch});
  const teachGitHubContext=async(name,role)=>{
   const settings=await graph.settings(name),entry=settings.roles.find(r=>r.role===role);if(!entry?.available)fail('TEACH_GRAPH_BINDING');const ready=await managementReady(entry.name),trusted=updateManagerFor(entry.name)?.provenance;
   if(trusted&&ready.git.branch!==trusted.branch)fail('BRANCH_CHANGED');return {courseId:settings.courseId,role,bindingId:entry.repositoryId,localName:entry.name,migrated:settings.migrated,revision:settings.revision,branch:trusted?.branch??ready.git.branch,identity:ready.source.identity,stateKey:ready.binding.stateKey,url:trusted?.sourceUrl??null,terms:settings.terms,otherUrls:settings.roles.filter(r=>r.role!==role).map(r=>r.sourceUrl).filter(Boolean)};
  };
  const githubSetup=createTeachGitHubSetup({fetch:githubFetch,store:createPrivateStore({privateRoot:privateDirectory(path.join(privateRoot.path,'.asmb-teach-github'),true).path,bindingHash:createHash('sha256').update(bindingHash+':teach-github:1').digest('hex')}),provider:teachGitHubProvider,context:teachGitHubContext,connect:async(ctx,remote)=>{const ready=await managementReady(ctx.localName);if(ready.source.identity!==ctx.identity||ready.git.branch!==ctx.branch)fail('CONFLICT');const prior=updateManagerFor(ctx.localName)?.provenance;if(prior){if(prior.sourceUrl.toLowerCase()!==remote.url.toLowerCase()||prior.branch!==ctx.branch)fail('GITHUB_ALREADY_CONNECTED');return;}connections.set(ready.binding.stateKey,{identity:ready.source.identity,sourceUrl:canonicalGitHubUrl(remote.url),branch:ctx.branch});}});
  const teachStaff=createTeachStaffAccess({store:createPrivateStore({privateRoot:privateDirectory(path.join(privateRoot.path,'.asmb-teach-staff'),true).path,bindingHash:createHash('sha256').update(bindingHash+':teach-staff:1').digest('hex')}),provider:teachGitHubProvider,context:teachGitHubContext,setupStatus:id=>githubSetup.status(id)});
  const projects=createTeachProjects({store:createPrivateStore({privateRoot:privateDirectory(path.join(privateRoot.path,'.asmb-teach-projects'),true).path,bindingHash:createHash('sha256').update(bindingHash+':teach-projects:1').digest('hex')}),snapshot:async name=>{const settings=await graph.settings(name),courses=await teach({operation:'list'}),found=courses.find(c=>c.course.courseId===settings.courseId);if(!found)fail('INVALID_COURSE');return {...settings,code:courseKey(found.course.code)};},createLocal:async(team,files)=>{await importTeachCourse({name:team.localName,requestId:team.requestId,bytes:createPackageZip(files)});const entry=readingRepositories().find(e=>e.name===team.localName);if(!entry)fail('TEACH_GRAPH_BINDING');return entry;}});
  const workflow=createTeachWorkflow({store:createPrivateStore({privateRoot:privateDirectory(path.join(privateRoot.path,'.asmb-teach-workflow'),true).path,bindingHash:createHash('sha256').update(bindingHash+':teach-workflow:1').digest('hex')}),at:hooks.workflowAt,snapshot:async(name,{inventory:scanFiles=true}={})=>{
   const settings=await graph.settings(name),binding=graph.get(settings.courseId),requested=readingRepositories().find(r=>r.name===name);if(binding&&binding.bindings.instructors!==requested?.stableId)fail('TEACH_GRAPH_BINDING');
   const found=(await teach({operation:'list'})).find(c=>c.repo===name&&c.course.courseId===settings.courseId);if(!found)fail('INVALID_COURSE');
   const files=[],drafts=[],inventories={},roleHomes={instructors:{},assistants:{}},studentCandidates={},legacyCandidates={};let total=0,blocked=false;
   for(const role of settings.roles){if(!scanFiles||!role.available)continue;const ready=await managementReady(role.name),runtime=await workspace.execute(role.name,'runtimeStatus',{}),inventory=await workspace.execute(role.name,'discover',{});blocked||=!inventory.complete;
    drafts.push(...[...runtime.draftPaths,...runtime.recoveredDrafts.map(d=>d.path),...workspace.bootstrap(role.name).newDrafts.map(d=>d.path)].map(p=>({repositoryId:role.repositoryId,path:p})));
    const keys=new Set();for(const entry of inventory.entries){const key=portablePathKey(entry.path);if(keys.has(key))fail('CONFLICT');keys.add(key);if(entry.type!=='file')continue;total+=entry.byteLength;if(total>128*1024*1024)fail('LIMIT_EXCEEDED');const bytes=readPublicationFile(ready.source,entry.path);files.push({role:role.role,path:entry.path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
    inventories[role.role]={identity:ready.source.identity,head:ready.git.head??null,branch:ready.git.branch??null,entries:inventory.entries,issues:inventory.issues};
   }
   for(const term of found.course.terms){const id=`${term.year}-${term.season}`;roleHomes.instructors[id]=found.audiences[id]?`${found.audiences[id].instructors.root}/README.md`:term.source.paths[0];const assistant=settings.roles.find(r=>r.role==='assistants');roleHomes.assistants[id]=assistant.available&&await probeTeachFile(assistant.name,id+'/README.md')?id+'/README.md':null;studentCandidates[id]=files.filter(f=>f.role==='students'&&f.path.startsWith(id+'/')&&/\.md$/i.test(f.path)).map(f=>f.path);legacyCandidates[id]=files.filter(f=>f.role==='instructors'&&(f.path===id+'/student.md'||f.path.startsWith(id+'/students/'))).map(f=>({path:f.path,sha256:f.sha256}));}
   const teamSettings=settings.migrated?await projects.settings(name):{projects:[],pending:null};
   return {courseId:settings.courseId,terms:settings.terms,bound:settings.migrated,roles:settings.roles.map(r=>({role:r.role,repositoryId:r.repositoryId,name:r.name,available:r.available,sourceUrl:r.sourceUrl,branch:r.branch,rootPath:'',intendedVisibility:r.intendedVisibility,accessStatus:r.accessStatus})),roleHomes,projects:teamSettings.projects.map(p=>({id:p.id,term:p.term,label:p.label,repositoryId:p.bindingId,name:p.name,available:p.available,rootPath:'',homePath:'README.md'})),preservedProjects:teamSettings,courseHash:found.hash,graph:graph.get(settings.courseId),files,drafts,inventories,studentCandidates,legacyCandidates,blocked:blocked||Boolean(teamSettings.pending)};
  }});
  const projectContext=async(projectId,role)=>{if(role!=='instructors')fail('INVALID_REQUEST');const team=projects.get(projectId);if(!team)fail('TEACH_GRAPH_BINDING');const entry=readingRepositories().find(r=>r.stableId===team.bindingId);if(!entry)fail('TEACH_GRAPH_BINDING');const ready=await managementReady(entry.name),trusted=updateManagerFor(entry.name)?.provenance;if(trusted&&ready.git.branch!==trusted.branch)fail('BRANCH_CHANGED');return {courseId:team.id,role,bindingId:team.bindingId,localName:entry.name,migrated:true,revision:team.revision,branch:trusted?.branch??ready.git.branch,identity:ready.source.identity,stateKey:ready.binding.stateKey,url:trusted?.sourceUrl??null,terms:[team.term],otherUrls:readingRepositories().filter(r=>r.stableId!==team.bindingId).map(r=>updateManagerFor(r.name)?.provenance?.sourceUrl).filter(Boolean)};};
  const projectProvider={session:async()=>{const session=await teachGitHubProvider.session();const observed=async remote=>remote?{...remote,isolation:await session.projectIsolation(remote)}:null;return {...session,inspect:async(owner,name)=>observed(await session.inspect(owner,name)),create:async input=>observed(await session.create(input))};}};
  const projectGitHub=createTeachGitHubSetup({requireIsolation:true,fetch:githubFetch,store:createPrivateStore({privateRoot:privateDirectory(path.join(privateRoot.path,'.asmb-teach-project-github'),true).path,bindingHash:createHash('sha256').update(bindingHash+':teach-project-github:1').digest('hex')}),provider:projectProvider,context:projectContext,connect:async(ctx,remote)=>{const ready=await managementReady(ctx.localName);if(ready.source.identity!==ctx.identity||ready.git.branch!==ctx.branch)fail('CONFLICT');const prior=updateManagerFor(ctx.localName)?.provenance;if(prior){if(prior.sourceUrl.toLowerCase()!==remote.url.toLowerCase()||prior.branch!==ctx.branch)fail('GITHUB_ALREADY_CONNECTED');return;}connections.set(ready.binding.stateKey,{identity:ready.source.identity,sourceUrl:canonicalGitHubUrl(remote.url),branch:ctx.branch});}});
  const projectStaff=createTeachStaffAccess({store:createPrivateStore({privateRoot:privateDirectory(path.join(privateRoot.path,'.asmb-teach-project-staff'),true).path,bindingHash:createHash('sha256').update(bindingHash+':teach-project-staff:1').digest('hex')}),provider:projectProvider,context:projectContext,setupStatus:id=>projectGitHub.status(id)});
  const requireProject=async(repo,projectId)=>{const settings=await graph.settings(repo),team=projects.get(projectId);if(!team||team.courseId!==settings.courseId)fail('TEACH_GRAPH_BINDING');return team;};
  const submissionRoot=privateDirectory(path.join(privateRoot.path,'.asmb-teach-submission-snapshots'),true);
  const snapshotBytes=digest=>{if(!/^[0-9a-f]{64}$/.test(digest))fail('INVALID_REQUEST');checkDirectory(submissionRoot);const file=openRawFile(path.join(submissionRoot.path,digest+'.zip'),256*1024*1024);try{const bytes=Buffer.alloc(file.size);let offset=0;while(offset<bytes.length){const n=fs.readSync(file.fd,bytes,offset,bytes.length-offset,offset);if(!n)fail('RECOVERY_REQUIRED');offset+=n;}file.verify();checkDirectory(submissionRoot);if(createHash('sha256').update(bytes).digest('hex')!==digest)fail('RECOVERY_REQUIRED');return bytes;}finally{file.close();}};
  const submissions=createTeachSubmissions({store:createPrivateStore({privateRoot:privateDirectory(path.join(privateRoot.path,'.asmb-teach-submissions'),true).path,bindingHash:createHash('sha256').update(bindingHash+':teach-submissions:1').digest('hex')}),provider:teachGitHubProvider,context:async(repo,projectId)=>{const project=await requireProject(repo,projectId),ctx=await projectContext(projectId,'instructors'),record=projectGitHub.status(projectId).roles.instructors;if(!record||record.bindingId!==ctx.bindingId||record.remote.url!==ctx.url)fail('GITHUB_NOT_CONNECTED');return {project,remote:record.remote,branch:ctx.branch};},archive:async(digest,bytes)=>{checkDirectory(submissionRoot);const filename=path.join(submissionRoot.path,digest+'.zip');if(exists(filename)){if(!snapshotBytes(digest).equals(bytes))fail('RECOVERY_REQUIRED');return;}writeExclusive(filename,bytes);},openArchive:async(digest)=>{const name='Submission_'+digest.slice(0,20),requestId=digest.slice(0,8)+'-'+digest.slice(8,12)+'-'+'4'+digest.slice(13,16)+'-'+'8'+digest.slice(17,20)+'-'+digest.slice(20,32);await importTeachCourse({name,requestId,bytes:snapshotBytes(digest)},{maxBytes:256*1024*1024});return {repo:name,immutableArchive:true,reviewCopyEditable:true};}});

  async function pipelineContext(input){
   const courses=await teach({operation:'list'}),found=courses.find(c=>c.repo===input.repo),folder=`${input.year}-${input.season}`;
   if(!found?.course.terms.some(t=>`${t.year}-${t.season}`===folder))fail('INVALID_TERM');
   const roles=graph.get(found.course.courseId);if(!roles)fail('TEACH_GRAPH_REQUIRED');
   if(input.toRole==='students'&&workflow.get(found.course.courseId)?.mode==='direct-students')fail('TEACH_DIRECT_STUDENTS');
   if(!['instructors','assistants'].includes(input.fromRole)||!['instructors','assistants','students'].includes(input.toRole)||input.fromRole===input.toRole||input.toRole==='instructors'&&input.fromRole!=='assistants')fail('INVALID_REQUEST');
   const entries=readingRepositories();if(entries.find(e=>e.name===input.repo)?.stableId!==roles.bindings.instructors)fail('TEACH_GRAPH_BINDING');const source=entries.find(e=>e.stableId===roles.bindings[input.fromRole]),destination=entries.find(e=>e.stableId===roles.bindings[input.toRole]);
   if(!source||!destination||source.name===destination.name)fail('TEACH_GRAPH_BINDING');
   if(input.destination!==destination.name)fail('TEACH_GRAPH_BINDING');
   promotionReceipts.ready();const ready=await managementReady(source.name);await managementReady(destination.name);const gitStatus=await workspace.execute(source.name,'gitStatus',{});
   const runtime=await workspace.execute(source.name,'runtimeStatus',{});if(runtime.draftPaths.length||runtime.recoveredDrafts.length||workspace.bootstrap(source.name).newDrafts.length)fail('DRAFT_CONFLICT');
   return {sourceAudienceRoot:input.fromRole==='instructors'?found.audiences[folder]?.students.root??null:null,root:ready.source,identity:ready.source.identity,recordHash:JSON.stringify({course:found.hash,graph:roles,head:ready.git.head}),sourceCommit:gitStatus.files?.some(f=>input.paths?.includes(f.path))?null:ready.git.head??null,sourceId:source.stableId,destinationId:destination.stableId,sourceRepo:source.name,sourceRole:input.fromRole,toRole:input.toRole,destinationRepo:destination.name,folder,paths:input.paths,courseId:found.course.courseId,collectionId:'asteach-'+found.course.courseId,semantics:'patch'};
  }
  const promotion=createTeachPublication({build:buildRolePromotion,context:pipelineContext,
   destinations:async()=>readingRepositories().map(e=>({name:e.name,identity:pinDirectory(path.join(organization.path,e.name)).identity})),
   compare:async(name,output,ctx)=>{
    const manager=exchangeFor(name),status=manager.status();if(status.registration&&status.registration.collectionId!==ctx.collectionId)fail('PUBLICATION_COLLECTION_CONFLICT');
    if(status.registration)return {kind:'update',...await manager.reviewUpdate({archive:publicationArchive(output,ctx),semantics:'patch',version:'1',scope:output.folder})};
    const inventory=await workspace.execute(name,'discover',{});if(!inventory.complete)fail('LIMIT_EXCEEDED');
    const registration=await manager.emptyRegistrationReview({collectionId:ctx.collectionId,version:'1'});
    return {kind:'first',planId:registration.planId,rows:output.files.map(f=>({path:f.path,action:inventory.entries.some(e=>e.path===f.path||f.path.startsWith(e.path+'/')&&e.type==='file')?'conflict':'add',conflict:inventory.entries.some(e=>e.path===f.path||f.path.startsWith(e.path+'/')&&e.type==='file')})),warnings:[]};
   },
   copy:async(name,output,ctx,comparison)=>{
    if(comparison.rows.some(r=>r.conflict||r.protectedDraft)||comparison.warnings.length)fail('PUBLICATION_UPDATE_CONFLICT');
    const targetRoot=(await managementReady(name)).source,priorHashes=[];for(const file of output.files){let sha256=null;try{sha256=createHash('sha256').update(readPublicationFile(targetRoot,file.path)).digest('hex');}catch(error){if(!['ENOENT','PARTIAL','NOT_FOUND'].includes(error.code))throw error;}priorHashes.push({path:file.path,sha256});}
    promotionReceipts.begin({courseId:ctx.courseId,sourceId:ctx.sourceId,destinationId:ctx.destinationId,sourceCommit:ctx.sourceCommit,sourceRole:ctx.sourceRole,toRole:ctx.toRole,files:output.files.map(f=>({path:f.path,sha256:f.hash,bytes:f.bytes.length})),priorHashes});
    let result;try{result=await packageMutation(name,async manager=>{
     let reviewed=comparison;if(comparison.kind==='first'){await manager.registerBase({planId:comparison.planId});reviewed=await manager.reviewUpdate({archive:publicationArchive(output,ctx),semantics:'patch',version:'1',scope:output.folder});}
     if(reviewed.rows.some(r=>r.conflict||r.protectedDraft)||reviewed.warnings.length)fail('PUBLICATION_UPDATE_CONFLICT');
     return manager.apply({planId:reviewed.planId,choices:reviewed.rows.filter(r=>r.choices.length).map(r=>({path:r.path,choice:'use-incoming'}))});
    });
    }catch(error){if(!exchangeFor(name).status().recoveryRequired){let unchanged=true;for(const file of priorHashes){let actual=null;try{actual=createHash('sha256').update(readPublicationFile(targetRoot,file.path)).digest('hex');}catch(e){if(!['ENOENT','PARTIAL','NOT_FOUND'].includes(e.code)){unchanged=false;break;}}if(actual!==file.sha256){unchanged=false;break;}}if(unchanged)promotionReceipts.cancel();}throw error;}
    promotionReceipts.complete(result.operationId);
    return {repository:name,files:output.files.length,status:result.status,sourceCommit:ctx.sourceCommit,sourceRole:ctx.sourceRole,toRole:ctx.toRole,manifest:output.files.map(f=>({path:f.path,sha256:f.hash,bytes:f.bytes.length})),localOnly:true};
   }
  });
  const publicationArchive=(output,ctx)=>createPackageZip([...output.files,{path:'asmagicbrain-package.json',bytes:Buffer.from(JSON.stringify({format:'asMagicBrain-package',schemaVersion:1,collectionId:ctx.collectionId,version:'1',semantics:ctx.semantics??'snapshot',files:output.files.map(file=>({path:file.path,sha256:file.hash}))}))}]);
  async function ensureTeachPair(found,preferred,direct=false){
   if(!found)fail('INVALID_COURSE');await managementReady(found.repo);
   const source=readingRepositories().find(e=>e.name===found.repo);if(!source)fail('UNKNOWN_REPOSITORY');
   let pair=teachPairs.get(source.stableId),destination;
   if(!pair){
    const prior=[];for(const e of readingRepositories()){const binding=record.repositoryBindings.find(b=>b.name===e.name);if(e.name!==found.repo&&binding&&exists(path.join(privateRoot.path,binding.stateKey,'package-exchange'))&&exchangeFor(e.name).status().registration?.collectionId==='asteach-'+found.course.courseId)prior.push(e);}
    if(preferred&&!prior.some(e=>e.name===preferred))fail('TEACH_PAIR_CONFLICT');if(prior.length>1&&!preferred)fail('TEACH_PAIR_AMBIGUOUS');
    destination=preferred?prior.find(e=>e.name===preferred):prior[0];pair=teachPairs.set(source.stableId,{courseId:found.course.courseId,destinationId:destination?.stableId??null,name:destination?.name??courseKey(found.course.code)+'_Students',requestId:randomUUID()});
   }
   if(preferred&&pair.destinationId&&readingRepositories().find(e=>e.stableId===pair.destinationId)?.name!==preferred)fail('TEACH_PAIR_CONFLICT');
   if(pair.courseId!==found.course.courseId)fail('TEACH_PAIR_CONFLICT');
   if(pair.destinationId){destination=readingRepositories().find(e=>e.stableId===pair.destinationId);if(!destination)fail('TEACH_STUDENT_UNAVAILABLE');}
   else {
    const initial=found.course.terms[0],folder=`${initial.year}-${initial.season}`;
    const bytes=createPackageZip([{path:'README.md',bytes:Buffer.from('# '+found.course.code+' — Student course\n')},{path:`${folder}/student.md`,bytes:Buffer.from('# '+found.course.code+(direct?'\n\n':'\n\nReview Instructor content to prepare this Student course.\n'))}]);
    const imported=await importTeachCourse({name:pair.name,requestId:pair.requestId,bytes});destination=readingRepositories().find(e=>e.name===imported.name);if(!destination)fail('TEACH_PAIR_CONFLICT');
    pair=teachPairs.set(source.stableId,{...pair,destinationId:destination.stableId});
   }
   await managementReady(destination.name);
   if(direct){const homes=workflow.get(found.course.courseId)?.homes??{};for(const term of found.course.terms){const id=`${term.year}-${term.season}`,relative=homes[id]??id+'/student.md';if(!await probeTeachFile(destination.name,relative)){if(homes[id])fail('TEACH_STUDENT_PAGE_MISSING');await workspace.writeBatch(destination.name,[{path:relative,baseHash:null,text:'# '+found.course.code+'\n\n'}]);}}return {repo:destination.name};}
   for(const term of found.course.terms){
    const folder=`${term.year}-${term.season}`,relative=folder+'/student.md',manager=exchangeFor(destination.name),status=manager.status();
    if(status.registration&&status.registration.collectionId!=='asteach-'+found.course.courseId)fail('TEACH_PAIR_CONFLICT');
    const canonical=folder+'/README.md';
    if(status.registration&&manager.ownedPaths().includes(canonical)){if(!await probeTeachFile(destination.name,canonical))fail('TEACH_STUDENT_PAGE_MISSING');continue;}
    const present=await probeTeachFile(destination.name,relative),owned=manager.ownedPaths().includes(relative);
    if(present&&status.registration){continue;}
    if(!present&&owned)fail('TEACH_STUDENT_PAGE_MISSING');
    const text='# '+found.course.code+'\n\nReview Instructor content to prepare this Student course.\n',bytes=present?readPublicationFile((await managementReady(destination.name)).source,relative):Buffer.from(text),output={folder,files:[{path:relative,bytes,hash:createHash('sha256').update(bytes).digest('hex')}]},ctx={collectionId:'asteach-'+found.course.courseId};
    if(!status.registration){
     // Register the existing saved bytes, including an independently authored home. Draft guards remain mandatory.
     if(!present)await workspace.writeBatch(destination.name,[{path:relative,baseHash:null,text}]);
     await packageMutation(destination.name,m=>m.registerBase({archive:publicationArchive(output,ctx),collectionId:ctx.collectionId,version:'1'}));
    }else if(!owned){
     await packageMutation(destination.name,async m=>{const review=await m.reviewUpdate({archive:publicationArchive(output,ctx),semantics:'snapshot',version:'1',scope:folder});if(review.rows.some(r=>r.conflict||r.protectedDraft)||review.warnings.length)fail('DRAFT_CONFLICT');return m.apply({planId:review.planId,choices:review.rows.filter(r=>r.choices.length).map(r=>({path:r.path,choice:'use-incoming'}))});});
    }
   }
   return {repo:destination.name};
  }
  const directDelivery=createTeachPublication({build:buildAudiencePublication,destinations:async()=>[],context:async input=>{
   if(!exact(input,['repo','year','season','destination','convertGitBook'])||input.destination!==null||typeof input.convertGitBook!=='boolean')fail('INVALID_REQUEST');
   const folder=`${input.year}-${input.season}`,descriptor=await workflow.descriptor(input.repo,folder);
   if(descriptor.workflow.mode!=='direct-students')fail('TEACH_DIRECT_STUDENTS_REQUIRED');if(descriptor.pending)fail('TEACH_WORKFLOW_RECOVERY_REQUIRED');
   const role=descriptor.roles.find(r=>r.role==='students');if(!role?.available||!role.homePath)fail('TEACH_STUDENT_UNAVAILABLE');
   const ready=await managementReady(role.name),runtime=await workspace.execute(role.name,'runtimeStatus',{});
   if(runtime.draftPaths.length||runtime.recoveredDrafts.length||workspace.bootstrap(role.name).newDrafts.length)fail('DRAFT_CONFLICT');
   const inventory=await workspace.execute(role.name,'discoverScope',{path:folder});if(!inventory.complete)fail('LIMIT_EXCEEDED');
   const entries=inventory.entries.filter(e=>e.type==='file');if(entries.length>4096||entries.reduce((n,e)=>n+e.byteLength,0)>128*1024*1024)fail('LIMIT_EXCEEDED');
   const hashes=[];for(const entry of entries)hashes.push([entry.path,createHash('sha256').update(readPublicationFile(ready.source,entry.path)).digest('hex')]);
   return {direct:true,root:ready.source,folder,studentPath:role.homePath,convertGitBook:input.convertGitBook,identity:ready.source.identity,recordHash:JSON.stringify({workflow:descriptor.workflow,role,hashes}),repository:role.name,hashes};
  },prepare:async(output,ctx)=>{
   if(ctx.convertGitBook)fail('INVALID_REQUEST');
   const files=output.files.filter(f=>f.generated).map(f=>({path:f.path,text:f.bytes.toString('utf8'),baseHash:ctx.hashes.find(([p])=>p===f.path)?.[1]??null}));
   await workspace.writeBatch(ctx.repository,files);return {repository:ctx.repository,homePath:output.homePath,files:files.map(f=>f.path)};
  }});
  const publication=createTeachPublication({
   context:async request=>{
    const input={...request};const convertGitBook=input.convertGitBook??false;if(typeof convertGitBook!=='boolean')fail('INVALID_REQUEST');delete input.convertGitBook;
    if(!exact(input,['repo','year','season','destination'])&&!exact(input,['repo','year','season','destination','selectedPages'])&&!exact(input,['repo','year','season','destination','selectedPages','studentText','sourceHash']))fail('INVALID_REQUEST');
    const {source}=await managementReady(input.repo);
    const runtime=await workspace.execute(input.repo,'runtimeStatus',{});
    if(runtime.draftPaths.length||runtime.recoveredDrafts.length||workspace.bootstrap(input.repo).newDrafts.length)fail('DRAFT_CONFLICT');
    const records=await teach({operation:'list'}),found=records.find(item=>item.repo===input.repo),term=found?.course.terms.find(t=>t.year===input.year&&t.season===input.season);
    if(!term||term.source.kind!=='document')fail('INVALID_TERM');
    const review=await teach({operation:'studentReview',repo:input.repo,year:input.year,season:input.season});
    if(Object.hasOwn(input,'studentText')){if(typeof input.studentText!=='string'||!input.studentText.trim()||!input.studentText.isWellFormed()||input.studentText.includes('\0')||Buffer.byteLength(input.studentText)>1048576)fail('INVALID_REQUEST');if(input.sourceHash!==review.instructor.sourceHash)fail('CONFLICT');}else if(!review.student)fail('PUBLICATION_STUDENT_REQUIRED');
    let homeAliases={};const home=review.sourcePath.replace(/[^/]+$/, 'README.md');if(home!==review.sourcePath){try{if(readPublicationFile(source,home).equals(Buffer.from(review.instructor.text)))homeAliases[home]=review.studentPath;}catch(error){if(!['ENOENT','PARTIAL','NOT_FOUND'].includes(error.code))throw error;}}
    return {convertGitBook,homeAliases,studentText:input.studentText,collectionId:'asteach-'+found.course.courseId,selectedPages:input.selectedPages??[],root:source,identity:source.identity,recordHash:found.hash,term,studentPath:review.studentPath,forbidden:found.course.terms.flatMap(t=>t.source.paths)};
   },
   destinations:async sourceName=>{
    const result=[];
    for(const entry of readingRepositories()){
     if(entry.name===sourceName)continue;
     try{assertWritable(entry.name);const {source}=await managementReady(entry.name);
      const found=await workspace.execute(entry.name,'discover',{});if(!found.complete||found.entries.some(e=>['ASTEACH-COURSE.JSON','.ASTEACH/COURSE.JSON'].includes(portablePathKey(e.path))))continue;
      const provenance=updateManagerFor(entry.name)?.provenance;
      result.push({name:entry.name,identity:source.identity,sourceUrl:provenance?.sourceUrl??null,branch:provenance?.branch??null});
     }catch{continue;}
    }return result;
   },
   compare:async(name,output,ctx)=>{
    const manager=exchangeFor(name),status=manager.status();
    if(!status.registration)return {kind:'first',rows:output.files.map(f=>({path:f.path,action:'add',conflict:false}))};
    if(status.registration.collectionId!==ctx.collectionId)fail('PUBLICATION_COLLECTION_CONFLICT');
    const review=await manager.reviewUpdate({archive:publicationArchive(output,ctx),semantics:'snapshot',version:'1',scope:output.folder});
    return {kind:'update',...review};
   },
   copy:async(name,output,ctx,comparison)=>{
    if(comparison?.kind==='update'){
     if(comparison.rows.some(row=>row.conflict||row.protectedDraft)||comparison.warnings.length)fail('PUBLICATION_UPDATE_CONFLICT');
     const result=await packageMutation(name,manager=>manager.apply({planId:comparison.planId,choices:comparison.rows.filter(row=>row.choices.length).map(row=>({path:row.path,choice:'use-incoming'}))}));
     return {repository:name,path:output.homePath??output.folder+'/student.md',files:output.files.length,status:result.status};
    }
    assertWritable(name);await managementReady(name);
    const found=await workspace.execute(name,'discover',{}),runtime=await workspace.execute(name,'runtimeStatus',{}),reserved=[...found.entries.map(e=>e.path),...runtime.draftPaths,...runtime.recoveredDrafts.map(e=>e.path),...workspace.bootstrap(name).newDrafts.map(e=>e.path)];
    if(!found.complete)fail('LIMIT_EXCEEDED');if(reserved.some(p=>portablePathKey(p)===portablePathKey(output.folder)||portablePathKey(p).startsWith(portablePathKey(output.folder)+'/')))fail('PUBLICATION_DESTINATION_EXISTS');
    const stage=privateDirectory(path.join(privateRoot.path,'.asmb-teach-publication'),true),session=privateDirectory(path.join(stage.path,randomUUID()),true);
    for(const file of output.files){const full=path.join(session.path,file.path);fs.mkdirSync(path.dirname(full),{recursive:true,mode:0o700});writeExclusive(full,file.bytes);}
    const sources=inspectExternalSources([path.join(session.path,output.folder)]);
    const result=await workspace.importExternal(name,{sources,destination:'',strictNames:true});
    await packageMutation(name,manager=>manager.registerBase({archive:publicationArchive(output,ctx),collectionId:ctx.collectionId,version:'1'}));
    checkDirectory(session);fs.rmSync(session.path,{recursive:true});syncDirectory(stage);
    return {repository:name,path:output.homePath??output.folder+'/student.md',files:output.files.length,status:result.status};
   }
  });
  const requireTeach=()=>{if(!pluginPackages.list().some(entry=>isTrustedTeachPackage(entry)&&entry.enabled))fail('PLUGIN_DISABLED');};
  async function courseFiles(value){
   const records=await teach({operation:'list'}),record=records.find(r=>r.repo===value.repo),term=record?.course.terms.find(t=>t.year===value.year&&t.season===value.season);
   if(!term)fail('INVALID_TERM');const folder=`${term.year}-${term.season}`;
   await managementReady(value.repo);const roots=record.audiences[folder];
   const inventories=roots?await Promise.all(['instructors','students'].map(a=>workspace.execute(value.repo,'discoverScope',{path:roots[a].root}))):[await workspace.execute(value.repo,'discover',{})];
   if(inventories.some(found=>!found.complete))fail('LIMIT_EXCEEDED');const source={entries:inventories.flatMap(found=>found.entries)};
   const students=[];
   for(const entry of readingRepositories()){
    if(entry.name===value.repo)continue;
    const binding=recordBindings(entry.name);
    if(!binding||!exists(path.join(privateRoot.path,binding.stateKey,'package-exchange')))continue;
    const status=exchangeFor(entry.name).status();if(status.registration?.collectionId!=='asteach-'+record.course.courseId)continue;
    await managementReady(entry.name);const files=await workspace.execute(entry.name,'discover',{});if(!files.complete)fail('LIMIT_EXCEEDED');
    students.push({repo:entry.name,publishedPaths:exchangeFor(entry.name).ownedPaths(),entries:files.entries.filter(e=>e.path.startsWith(folder+'/'))});
   }
   return {folder,audiences:record.audiences[folder],instructor:record.audiences[folder]?record.audiences[folder].instructors.root+'/README.md':term.source.paths[0],entries:source.entries.filter(e=>e.path.startsWith(folder+'/')||e.path.startsWith('shared/')),students};
  }
  const recordBindings=name=>record.repositoryBindings.find(b=>b.name===name);
  const reviewProjectAccess=async value=>{const team=await requireProject(value.repo,value.projectId);const session=await projectProvider.session(),record=projectGitHub.status(team.id).roles.instructors;if(!record)fail('GITHUB_VERIFY_FIRST');const remote=await session.inspect(record.remote.owner,record.remote.name);if(!remote?.isolation?.complete)fail('GITHUB_PROJECT_ISOLATION_UNVERIFIED');const allowed=new Set([...team.policy.members,...remote.isolation.owners].map(v=>v.toLowerCase()));if(remote.collaborators.some(v=>!allowed.has(v.login.toLowerCase()))||remote.invitations.some(v=>!v.login||!allowed.has(v.login.toLowerCase())))fail('GITHUB_PROJECT_ACCESS_DRIFT');if(!team.policy.members.some(login=>login.toLowerCase()===value.login?.toLowerCase()))fail('GITHUB_STAFF_NOT_LISTED');const roster=projectStaff.status(team.id).roster,entries=team.policy.members.map(login=>({login,role:'assistant'}));if(JSON.stringify(roster.entries)!==JSON.stringify(entries))await projectStaff.saveRoster({repo:team.id,revision:roster.revision,entries});return projectStaff.review({repo:value.projectId,role:'instructors',login:value.login,permission:'write'});};
  const peopleBatch=createTeachAccessBatch({
   context:async input=>{const settings=await graph.settings(input.repo),roster=teachStaff.status(settings.courseId);if(roster.pending)fail('GITHUB_STAFF_RECOVERY_REQUIRED');const selected=input.logins.map(login=>roster.roster.entries.find(e=>e.login?.toLowerCase()===login.toLowerCase()));if(selected.some(e=>!e))fail('GITHUB_STAFF_NOT_LISTED');
    if(input.target.startsWith('project:')){if(input.permission!=='write')fail('INVALID_REQUEST');const team=await requireProject(input.repo,input.target.slice(8));if(projectStaff.status(team.id).pending)fail('GITHUB_STAFF_RECOVERY_REQUIRED');if(input.logins.some(login=>!team.policy.members.some(v=>v.toLowerCase()===login.toLowerCase())))fail('GITHUB_STAFF_NOT_LISTED');return {courseId:settings.courseId,roster:roster.roster.revision,teamId:team.id,bindingId:team.bindingId,revision:team.revision,remote:projectGitHub.status(team.id).roles.instructors?.remote.id??null};}
    const role=settings.roles.find(r=>r.role===input.target);if(!role?.available)fail('TEACH_GRAPH_BINDING');if(selected.some(e=>!e.assignments?.some(a=>a.role===input.target&&a.repositoryId===role.repositoryId&&a.permission===input.permission)))fail('GITHUB_ASSIGNMENT_REQUIRED');return {courseId:settings.courseId,roster:roster.roster.revision,revision:settings.revision,bindingId:role.repositoryId,remote:githubSetup.status(settings.courseId).roles[input.target]?.remote.id??null};
   },
   review:input=>input.target.startsWith('project:')?reviewProjectAccess({repo:input.repo,projectId:input.target.slice(8),login:input.login}):teachStaff.review({repo:input.repo,role:input.target,login:input.login,permission:input.permission}),
   apply:(input,id)=>input.target.startsWith('project:')?projectStaff.apply(id):teachStaff.apply(id),
   cancel:async(input,id)=>input.target.startsWith('project:')?projectStaff.cancel(id):teachStaff.cancel(id)
  });
  const teachDispatch=request=>{
   const value={...request};
   if(exact(value,['operation','repo','target','logins','permission'])&&value.operation==='reviewPeopleAccessBatch'){if(typeof value.target!=='string'||!['instructors','assistants','students'].includes(value.target)&&!/^project:[0-9a-f-]{36}$/.test(value.target))fail('INVALID_REQUEST');return peopleBatch.review(value);}
   if(exact(value,['operation','planId'])&&value.operation==='applyPeopleAccessBatch')return peopleBatch.apply(value.planId);
   if(exact(value,['operation','planId'])&&value.operation==='cancelPeopleAccessBatch')return peopleBatch.cancel(value.planId);
   if((exact(value,['operation','repo'])||exact(value,['operation','repo','term']))&&value.operation==='workspaceDescriptor')return workflow.descriptor(value.repo,value.term);
   if(exact(value,['operation','repo'])&&value.operation==='workflowInventory')return workflow.inventory(value.repo);
   if(exact(value,['operation','repo','homes'])&&value.operation==='reviewDirectStudents')return workflow.review(value.repo,value.homes);
   if(exact(value,['operation','planId'])&&value.operation==='applyDirectStudents')return workflow.apply(value.planId);
   if(exact(value,['operation','planId'])&&value.operation==='cancelDirectStudents')return workflow.cancel(value.planId);
   if(exact(value,['operation','repo','direction'])&&value.operation==='recoverDirectStudents')return workflow.recover(value.repo,value.direction);
   if(exact(value,['operation','repo'])&&value.operation==='projectSettings')return projects.settings(value.repo).then(result=>({...result,projects:result.projects.map(p=>({...p,github:projectGitHub.status(p.id),staff:projectStaff.status(p.id),submissions:submissions.status(p.id)}))}));
   if(exact(value,['operation','repo','projectId','milestone','sequence'])&&value.operation==='reviewSubmission')return submissions.review(value);
   if(exact(value,['operation','planId'])&&value.operation==='applySubmission')return submissions.apply(value.planId);
   if(exact(value,['operation','planId'])&&value.operation==='cancelSubmission')return submissions.cancel(value.planId);
   if(exact(value,['operation','repo','projectId','receiptId'])&&value.operation==='openSubmission')return submissions.open(value);
   if(exact(value,['operation','repo','year','season','label','repositoryId'])&&value.operation==='reviewProjectBinding')return projects.reviewBinding(value);
   if(exact(value,['operation','planId'])&&value.operation==='applyProjectBinding')return projects.applyBinding(value.planId);
   if(exact(value,['operation','repo','year','season','count'])&&value.operation==='reviewProjectCreation')return projects.reviewCreate(value);
   if(exact(value,['operation','planId'])&&value.operation==='applyProjectCreation')return projects.applyCreate(value.planId);
   if(exact(value,['operation','planId'])&&value.operation==='cancelProjectCreation')return projects.cancel(value.planId);
   if(exact(value,['operation','repo'])&&value.operation==='recoverProjectCreation')return projects.recover(value.repo);
   if(exact(value,['operation','repo','projectId','revision','policy'])&&value.operation==='saveProjectPolicy')return (async()=>{const team=await requireProject(value.repo,value.projectId);if(projectStaff.status(team.id).pending)fail('GITHUB_STAFF_RECOVERY_REQUIRED');return projects.policy(value);})();
   if(exact(value,['operation','repo','projectId','mode','owner','repository'])&&value.operation==='reviewProjectGitHub')return (async()=>{await requireProject(value.repo,value.projectId);return projectGitHub.review({repo:value.projectId,role:'instructors',mode:value.mode,owner:value.owner,repository:value.repository,visibility:'private'});})();
   if(exact(value,['operation','planId'])&&value.operation==='applyProjectGitHub')return projectGitHub.apply(value.planId);
   if(exact(value,['operation','planId'])&&value.operation==='cancelProjectGitHub')return projectGitHub.cancel(value.planId);
   if(exact(value,['operation','repo','projectId'])&&value.operation==='verifyProjectGitHub')return (async()=>{await requireProject(value.repo,value.projectId);return projectGitHub.verify({repo:value.projectId,role:'instructors'});})();
   if(exact(value,['operation','repo','projectId','direction'])&&value.operation==='recoverProjectGitHub')return (async()=>{await requireProject(value.repo,value.projectId);return projectGitHub.recover({repo:value.projectId,direction:value.direction});})();
   if(exact(value,['operation','repo','projectId','login'])&&value.operation==='reviewProjectAccess')return reviewProjectAccess(value);
   if(exact(value,['operation','planId'])&&value.operation==='applyProjectAccess')return projectStaff.apply(value.planId);
   if(exact(value,['operation','planId'])&&value.operation==='cancelProjectAccess')return projectStaff.cancel(value.planId);
   if(exact(value,['operation','repo','projectId','direction'])&&value.operation==='recoverProjectAccess')return (async()=>{await requireProject(value.repo,value.projectId);return projectStaff.recover({repo:value.projectId,direction:value.direction});})();
   if(exact(value,['operation','repo','entries','revision'])&&value.operation==='saveCourseStaff')return teachStaff.saveRoster(value);
   if(exact(value,['operation','repo','role','login','permission'])&&value.operation==='reviewStaffAccess')return teachStaff.review(value);
   if(exact(value,['operation','planId'])&&value.operation==='applyStaffAccess')return teachStaff.apply(value.planId);
   if(exact(value,['operation','planId'])&&value.operation==='cancelStaffAccess')return teachStaff.cancel(value.planId);
   if(exact(value,['operation','repo','direction'])&&value.operation==='recoverStaffAccess')return teachStaff.recover(value);
   if(exact(value,['operation','repo','role','mode','owner','repository','visibility'])&&value.operation==='reviewGitHubSetup'){const {operation,...input}=value;return githubSetup.review(input);}
   if(exact(value,['operation','planId'])&&value.operation==='applyGitHubSetup')return githubSetup.apply(value.planId);
   if(exact(value,['operation','planId'])&&value.operation==='cancelGitHubSetup')return githubSetup.cancel(value.planId);
   if(exact(value,['operation','repo','role'])&&value.operation==='verifyGitHubAccess')return githubSetup.verify(value);
   if(exact(value,['operation','repo','direction'])&&value.operation==='recoverGitHubSetup')return githubSetup.recover(value);
   if(exact(value,['operation','repo','url','root'])&&value.operation==='saveGitBookMapping')return githubSetup.mapping(value);
   if(exact(value,['operation','repo'])&&value.operation==='pipelineSettings')return graph.settings(value.repo).then(settings=>({...settings,provenance:promotionReceipts.status(settings.courseId),github:githubSetup.status(settings.courseId),staff:teachStaff.status(settings.courseId)}));
   if(exact(value,['operation','repo','direction'])&&value.operation==='resolvePromotion')return (async()=>{
    if(!['complete','cancel'].includes(value.direction))fail('INVALID_REQUEST');const settings=await graph.settings(value.repo),pending=promotionReceipts.pending();if(!pending||pending.courseId!==settings.courseId)fail('PROMOTION_RECOVERY_REQUIRED');
    const destination=readingRepositories().find(e=>e.stableId===pending.destinationId);if(!destination)fail('TEACH_GRAPH_BINDING');const ready=await managementReady(destination.name);
    if(exchangeFor(destination.name).status().recoveryRequired)fail('PROMOTION_RECOVERY_REQUIRED');
    for(const file of value.direction==='complete'?pending.files:pending.priorHashes){let actual=null;try{actual=createHash('sha256').update(readPublicationFile(ready.source,file.path)).digest('hex');}catch(error){if(!['ENOENT','PARTIAL','NOT_FOUND'].includes(error.code))throw error;}if(actual!==file.sha256)fail('CONFLICT');}
    if(value.direction==='complete')promotionReceipts.complete(null);else promotionReceipts.cancel();return {resolved:true};
   })();
   if(exact(value,['operation','repo','assistantId'])&&value.operation==='reviewRepositoryGraph')return graph.review(value.repo,value.assistantId);
   if(exact(value,['operation','planId'])&&value.operation==='applyRepositoryGraph')return graph.apply(value.planId);
   if(exact(value,['operation','planId'])&&value.operation==='cancelRepositoryGraph')return graph.cancel(value.planId);
   if(exact(value,['operation','repo','year','season','fromRole','toRole'])&&value.operation==='pipelineFiles')return (async()=>{
    const settings=await graph.settings(value.repo),destination=settings.roles.find(r=>r.role===value.toRole)?.name;
    const ctx=await pipelineContext({...value,destination}),inventory=await workspace.execute(ctx.sourceRepo,ctx.sourceAudienceRoot?'discoverScope':'discover',ctx.sourceAudienceRoot?{path:ctx.sourceAudienceRoot}:{});if(!inventory.complete)fail('LIMIT_EXCEEDED');
    return {source:ctx.sourceRepo,destination,folder:ctx.folder,candidateRoot:ctx.sourceAudienceRoot,limits:ctx.sourceAudienceRoot?{files:4096,fileBytes:8*1024*1024,totalBytes:128*1024*1024}:PROMOTION_LIMITS,sourceCommit:ctx.sourceCommit,entries:inventory.entries.filter(e=>e.type==='file'&&e.path.startsWith(ctx.sourceAudienceRoot&&value.toRole==='students'?ctx.sourceAudienceRoot+'/':ctx.folder+'/'))};
   })();
   if(exact(value,['operation','repo','year','season','fromRole','toRole','destination','paths'])&&value.operation==='reviewPromotion'){const {operation,...input}=value;return promotion.review(input);}
   if(exact(value,['operation','planId'])&&value.operation==='applyPromotion')return promotion.finish(value.planId,'copy');
   if(exact(value,['operation','planId'])&&value.operation==='cancelPromotion')return promotion.cancel(value.planId);
   if(exact(value,['operation','repo','year','season','convertGitBook'])&&value.operation==='reviewDirectDelivery'){const {operation,...input}=value;return directDelivery.review({...input,destination:null});}
   if(exact(value,['operation','planId'])&&value.operation==='prepareDirectDelivery')return directDelivery.finish(value.planId,'prepare');
   if(exact(value,['operation','planId'])&&value.operation==='cancelDirectDelivery')return directDelivery.cancel(value.planId);
   let conversion;if(Object.hasOwn(value,'convertGitBook')){if(value.operation!=='reviewPublication'||typeof value.convertGitBook!=='boolean')fail('INVALID_REQUEST');conversion=value.convertGitBook;delete value.convertGitBook;}
   if((exact(value,['operation','repo'])||exact(value,['operation','repo','destination']))&&value.operation==='ensureStudent')return teach({operation:'list'}).then(records=>{const found=records.find(r=>r.repo===value.repo);return ensureTeachPair(found,value.destination,found&&workflow.get(found.course.courseId)?.mode==='direct-students');});
   if(exact(value,['operation','repo','year','season'])&&value.operation==='courseFiles')return courseFiles(value);
   if((exact(value,['operation','repo','year','season','destination'])||exact(value,['operation','repo','year','season','destination','selectedPages'])||exact(value,['operation','repo','year','season','destination','selectedPages','studentText','sourceHash']))&&value.operation==='reviewPublication'){const {operation,...input}=value;return publication.review({...input,...(conversion!==undefined?{convertGitBook:conversion}:{})});}
   if(exact(value,['operation','planId'])&&value.operation==='copyPublication')return publication.finish(value.planId,'copy');
   if(exact(value,['operation','planId'])&&value.operation==='cancelPublication')return publication.cancel(value.planId);
   if(exact(value,['operation'])&&value.operation==='publicationDestinations')return publicationDestinations();
   return teach(value);
  };
  async function publicationDestinations(){const courses=await teach({operation:'list'});return readingRepositories().filter(entry=>!courses.some(c=>c.repo===entry.name)).flatMap(entry=>{try{assertWritable(entry.name);const p=updateManagerFor(entry.name)?.provenance;return [{name:entry.name,sourceUrl:p?.sourceUrl??null,branch:p?.branch??null}];}catch{return [];}});}
  const api=Object.freeze({
   buildTeachPublication:input=>{const value=copyRequest(input);return queue(()=>{requireTeach();if(exact(value,['planId','direct'])&&value.direct===true)return directDelivery.finish(value.planId,'zip');if(!exact(value,['planId']))fail('INVALID_REQUEST');return publication.finish(value.planId,'zip');});},
   nativeTeachRequest:input=>{const value=copyRequest(input);return queue(()=>{requireTeach();return teachDispatch(value);});},
   teachRequest:input=>{const value=copyRequest(input);return queue(()=>teachDispatch(value));},
   inspectPluginPackage:request=>{const value=pluginArchive(request,[]);return queue(()=>pluginPackages.inspect(value.bytes));},
   listPluginPackages:()=>queue(()=>pluginPackages.list()),
   installPluginPackage:request=>{const value=pluginArchive(request,['requestId']);return queue(()=>pluginPackages.install(value));},
   setPluginPackageEnabled:request=>{let value;try{value=copyRequest(request);if(!exact(value,['pluginId','enabled']))fail('PLUGIN_PACKAGE_INVALID_REQUEST');}catch(error){return Promise.reject(error);}return queue(()=>pluginPackages.setEnabled(value));},
   rollbackPluginPackage:request=>{let value;try{value=copyRequest(request);if(!exact(value,['pluginId','requestId']))fail('PLUGIN_PACKAGE_INVALID_REQUEST');}catch(error){return Promise.reject(error);}return queue(()=>pluginPackages.rollback(value));},
   uninstallPluginPackage:request=>{let value;try{value=copyRequest(request);if(!exact(value,['pluginId','requestId']))fail('PLUGIN_PACKAGE_INVALID_REQUEST');}catch(error){return Promise.reject(error);}return queue(()=>pluginPackages.uninstall(value));},
   packageStatus:request=>{const value=packageRequest(request,[]);return queue(()=>exchangeFor(value.repo).status());},
   reviewPackageBase:request=>{const value=packageArchive(request,['collectionId','version']);return queue(()=>{assertApplyReady(value.repo);return exchangeFor(value.repo).registrationReview({archive:value.bytes,collectionId:value.collectionId,version:value.version} );});},
   registerPackageBase:request=>{const value=packageRequest(request,['planId']);return queue(()=>packageMutation(value.repo,manager=>manager.registerBase({planId:value.planId})));},
   reviewPackageUpdate:request=>{const value=packageArchive(request,['semantics','version']);return queue(()=>{assertApplyReady(value.repo);return exchangeFor(value.repo).reviewUpdate({archive:value.bytes,semantics:value.semantics,version:value.version} );});},
   applyPackageUpdate:request=>{const value=packageRequest(request,['planId','choices']);return queue(()=>packageMutation(value.repo,manager=>manager.apply({planId:value.planId,choices:value.choices})));},
   recoverPackageUpdate:request=>{const value=packageRequest(request,['operationId','direction']);return queue(()=>packageMutation(value.repo,manager=>manager.recover({operationId:value.operationId,direction:value.direction})));},
   rollbackPackageUpdate:request=>{const value=packageRequest(request,['operationId']);return queue(()=>packageMutation(value.repo,manager=>manager.rollback({operationId:value.operationId})));},
   reviewPackageExport:request=>{const value=packageRequest(request,['collectionId','version']);return queue(()=>{assertApplyReady(value.repo);return exchangeFor(value.repo).reviewExport({collectionId:value.collectionId,version:value.version} );});},
   buildPackageExport:request=>{const value=packageRequest(request,['planId','kind']);return queue(()=>{assertApplyReady(value.repo);return exchangeFor(value.repo).buildExport({planId:value.planId,kind:value.kind} );});},
   cancelPackagePlan:request=>{const value=packageRequest(request,['planId']);return queue(()=>exchangeFor(value.repo).cancelPlan(value.planId));},
   readingHistory:request=>{const value=copyRequest(request);return queue(()=>reading.history(value));},
   getReadingEvidence:request=>{const value=readingInput(request);return queue(()=>reading.evidence(value));},
   getReadingReference:request=>{const value=readingInput(request);return queue(()=>reading.reference(value));},
   resolveReadingReference:request=>{const value=copyRequest(request);return queue(()=>reading.resolve(value));},
   prepareArtifactSnapshot:request=>{let value;try{value=copyRequest(request);if(!exact(value,['repo','path','ref'])||value.ref!==''||!readerPath(value.path)||!value.path)fail('INVALID_REQUEST');repo(value.repo);}catch(error){return Promise.reject(Object.assign(Error('This local interactive view cannot be reviewed.'),{code:'ARTIFACT_INVALID_REQUEST'}));}return queue(async()=>{const {source}=await managementReady(value.repo);return prepareArtifactSnapshot({root:source,path:value.path});}).catch(error=>{throw Object.assign(Error(/^ARTIFACT_[A-Z_]+$/.test(error.code??'')?error.message:'This local interactive view is unavailable. Check repository registration and recovery status before reviewing it again.'),{code:/^ARTIFACT_[A-Z_]+$/.test(error.code??'')?error.code:'ARTIFACT_UNAVAILABLE'});});},
   catalog:()=>queue(()=>{
    documentation?.assertCurrent();
    importer.catalog.recover();const previousBindings=record.repositoryBindings.length;syncBindings();
    if(record.repositoryBindings.length!==previousBindings){workspace.close();openWorkspace();}
    return {organization:'asMagicBrain',defaultRepository:record.workspaceName,repositories:readingRepositories(),limits:ZIP_IMPORT_LIMITS};
   }),
   read:request=>{let value;try{value=copyRequest(request);if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['repo','path','ref'].includes(key)))fail('INVALID_REQUEST');repo(value.repo);if(value.path===undefined)value.path='';if(value.ref===undefined)value.ref='';if(!readerPath(value.path)||typeof value.ref!=='string'||!value.ref.isWellFormed()||value.ref.length>1024||/[\x00-\x1f\x7f]/.test(value.ref))fail('INVALID_PATH');}catch(error){return Promise.reject(error);}return queue(async()=>{assertApplyReady(value.repo);await workspace.execute(value.repo,'gitInspect',{});const result=await readLocalRepository(value.repo,value.path,organization.path,value.ref,{builtinRepositories:builtins()});if(result.entries){const hidden=await hiddenTeachPaths(value.repo,result.entries.map(e=>({...e,path:e.path??(value.path?value.path+'/'+e.name:e.name)})));return {...result,entries:result.entries.filter(e=>!hidden.has(e.path??(value.path?value.path+'/'+e.name:e.name)))};}return result;});},
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
   connectRepositoryGitHub:request=>{let value;try{value=copyRequest(request);if(!exact(value,['repo','url','branch']))fail('INVALID_REQUEST');repo(value.repo);value.url=canonicalGitHubUrl(value.url);if(!validConnectionBranch(value.branch))fail('INVALID_REQUEST');}catch(error){return Promise.reject(error);}return queue(async()=>{assertWritable(value.repo);const {binding,source,git}=await managementReady(value.repo);if(updateManagerFor(value.repo))fail('GITHUB_ALREADY_CONNECTED');if(git.branch!==value.branch)fail('BRANCH_CHANGED');connections.set(binding.stateKey,{identity:source.identity,sourceUrl:value.url,branch:value.branch});return (await updatesContext(value.repo)).status;});},
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
   reviewRepositoryPush:request=>{
    const value=copyRequest(request);if(!exact(value,['repo','checkId'])||!validCreationId(value.checkId))fail('INVALID_REQUEST');repo(value.repo);
    if(applyJobs.has(value.repo)||[...updateJobs].some(j=>j.repo===value.repo))fail('UPDATES_BUSY');
    return queue(async()=>{const context=await updatesContext(value.repo),ready=await applyReadiness(value.repo);if(!context.status.eligible||ready.recoveryRequired||ready.draftCount||ready.dirtyFileCount)fail('PUSH_CLEAN_REQUIRED');return context.manager.reviewPush({checkId:value.checkId,localHead:context.meta.head,localBranch:context.meta.branch});}).catch(error=>{throw updateError(error);});
   },
   pushRepository:(request,{signal,credential}={})=>{
    const value=copyRequest(request);if(!exact(value,['repo','checkId','reviewId','requestId'])||!['checkId','reviewId','requestId'].every(k=>validCreationId(value[k])))fail('INVALID_REQUEST');repo(value.repo);
    if(applyJobs.has(value.repo)||[...updateJobs].some(j=>j.repo===value.repo))fail('UPDATES_BUSY');applyJobs.add(value.repo);
    return queue(async()=>{const context=await updatesContext(value.repo),ready=await applyReadiness(value.repo);if(!context.status.eligible||ready.recoveryRequired||ready.draftCount||ready.dirtyFileCount)fail('PUSH_CLEAN_REQUIRED');await githubSetup.guardPush(readingRepositories().find(r=>r.name===value.repo)?.stableId,credential);await projectGitHub.guardPush(readingRepositories().find(r=>r.name===value.repo)?.stableId,credential);return context.manager.push({checkId:value.checkId,reviewId:value.reviewId,localHead:context.meta.head,localBranch:context.meta.branch},{signal,credential});}).catch(error=>{throw updateError(error);}).finally(()=>applyJobs.delete(value.repo));
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
    if(isDocumentation(value.repo)&&!['open','discover','discoverScope','inspectEntry','listTrash','runtimeStatus','getCommitPreferences','gitInspect','gitStatus','gitReview'].includes(value.operation))assertWritable(value.repo);
    const moves=value.operation==='rename'?[{from:value.args.path,to:value.args.newPath}]:value.operation==='manage'&&value.args.operation==='move'?(value.args.items??[]).map(item=>({from:item.path,to:item.newPath})):[];
    const redirects=moves.length?await reading.prepareRename(value.repo,moves):[];
    let result;if(['inspectEntry','manage','restore','emptyTrash','reconcile'].includes(value.operation)){workspace.close();try{result=await runWorkspaceWorker(value);}finally{openWorkspace();}}else result=await workspace.execute(value.repo,value.operation,value.args);
    if(['discover','discoverScope'].includes(value.operation)){const hidden=await hiddenTeachPaths(value.repo,result.entries);result={...result,entries:result.entries.filter(e=>!hidden.has(e.path))};}
    if(moves.length)reading.renamed(value.repo,moves,redirects);
    return isDocumentation(value.repo)&&value.operation==='open'?{...result,readOnly:true}:result;
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
     const result=()=>({repository:value.name,previousName:value.repository,organization:'asMagicBrain',defaultRepository:record.workspaceName,repositories:readingRepositories()});
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
      importer=createRepositoryImporter({base:organization.path,builtinRepositories:builtins(),hooks});updateManagers.delete(binding.stateKey);applyManagers.delete(binding.stateKey);exchangeManagers.delete(binding.stateKey);openWorkspace();
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
   pauseTeachGitHub:async()=>{peopleBatch.pause();githubSetup.pause();teachStaff.pause();projectGitHub.pause();projectStaff.pause();submissions.pause();await serial;},
   resumeTeachGitHub:()=>{peopleBatch.resume();githubSetup.resume();teachStaff.resume();projectGitHub.resume();projectStaff.resume();submissions.resume();},
   prepareSearchClose:()=>search.prepareClose(),
   resumeSearch:()=>search.resume(),
   getAppearance:()=>queue(()=>({...record.appearance})),
   setAppearance:value=>{let next;try{next=copyRequest(value);if(!appearanceValid(next))fail('INVALID_APPEARANCE');}catch(error){return Promise.reject(error);}return queue(()=>{persist({...record,appearance:next});return {...record.appearance};});},
   drain:async()=>{await search.drain();await Promise.allSettled([...updateJobs].map(job=>job.promise));await serial;},
   close:()=>{if(closePromise)return closePromise;closing=true;peopleBatch.pause();githubSetup.pause();teachStaff.pause();projectGitHub.pause();projectStaff.pause();submissions.pause();void search.close();for(const job of updateJobs)job.controller.abort();closePromise=Promise.allSettled([search.close(),...[...updateJobs].map(job=>job.promise)]).then(()=>serial).then(()=>{if(closed)return;workspace.close();release();closed=true;});return closePromise;},
  });
  const automationRoot=privateDirectory(path.join(privateRoot.path,'.asmb-automation'),true);
  const automation=createAutomationDispatch({api,applyPackage:(input,operationId)=>{const value=packageRequest(input,['planId','choices']);if(!validCreationId(operationId))fail('INVALID_REQUEST');return queue(()=>packageMutation(value.repo,manager=>manager.apply({planId:value.planId,choices:value.choices,operationId})));},validate:input=>queue(async()=>{const value=copyRequest(input);if(!exact(value,['repoId']))fail('INVALID_REQUEST');const entry=readingRepositories().find(entry=>entry.stableId===value.repoId);if(!entry)fail('UNKNOWN_REPOSITORY');assertApplyReady(entry.name);const found=await workspace.execute(entry.name,'discover',{}),paths=found.entries.filter(entry=>entry.type==='file').map(entry=>entry.path),files=[];for(const path of paths.slice(0,256)){let text;try{const snapshot=await readLocalRepository(entry.name,path,organization.path,'',{builtinRepositories:builtins()});if(typeof snapshot.content==='string'&&Buffer.byteLength(snapshot.content)<=65536)text=snapshot.content;}catch{}files.push({path,size:found.entries.find(entry=>entry.path===path)?.byteLength,...(text!==undefined?{text}:{})});}const result=validateAutomationFiles({files,inventoryPaths:paths,analyzeReferences});if(paths.length>256||!found.complete){result.truncated=true;result.status='truncated';}return result;}),write:automationWrite,importArchive:automationImport,importStatus:value=>queue(()=>importer.findCompletedImport(value)),store:createPrivateStore({privateRoot:automationRoot.path,bindingHash:createHash('sha256').update(bindingHash+':automation:1').digest('hex')})});
  let publicClosing=false;const publicMethods={...api,automationRequest:input=>automation.request(copyRequest(input)),setAutomationGrants:input=>automation.setGrants(copyRequest(input)),getAutomationStatus:()=>automation.uiStatus(),approveAutomation:input=>automation.approve(copyRequest(input)),cancelAutomation:input=>automation.cancel(copyRequest(input))};
  return Object.freeze({...Object.fromEntries(Object.entries(publicMethods).map(([name,method])=>[name,(...args)=>publicClosing?Promise.reject(Object.assign(Error(name==='prepareArtifactSnapshot'?'ARTIFACT_UNAVAILABLE':'SERVICE_CLOSED'),{code:name==='prepareArtifactSnapshot'?'ARTIFACT_UNAVAILABLE':'SERVICE_CLOSED'})):method(...args)])),drain:async()=>{await automation.drain();await api.drain();},close:async()=>{publicClosing=true;await automation.close();await api.close();}});
 }catch(error){try{workspace?.close();}finally{try{release();}catch{}}throw error;}
}

// This capability comes only from native storage admission, never renderer data.
export function createNativeService(options={}) {
 const context=options.storageIdentity??null;
 return runWithStorageIdentity(context,async()=>{
  const service=await createNativeServiceInContext(options);
  return Object.freeze(Object.fromEntries(Object.entries(service).map(([name,value])=>
   [name,typeof value==='function'?(...args)=>runWithStorageIdentity(context,()=>value(...args)):value])));
 });
}
