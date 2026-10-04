import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ensurePhysicalDirectory} from './profile-paths.mjs';
import {probeStorageVolume,backupStorageProfile} from './storage-backup.mjs';
import {acquireNativeProfileLock,createNativeService} from './host-service.mjs';
import {prepareNativeStorage} from './storage-admission.mjs';

const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inside=(a,b)=>b===a||b.startsWith(a+path.sep);
const names={selection:'workspace-selection.json',journal:'workspace-adoption.json'};
function physical(root){
 if(typeof root!=='string'||!path.isAbsolute(root)||path.normalize(root)!==root||root===path.parse(root).root)fail('WORKSPACE_UNSAFE','Choose a physical managed-data folder.');
 for(let p=root;;p=path.dirname(p)){const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink())fail('WORKSPACE_UNSAFE','Linked folders cannot be adopted.');if(p===path.dirname(p))break;}
 const s=fs.lstatSync(root);if(fs.realpathSync(root)!==root||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)fail('WORKSPACE_UNSAFE','The managed-data folder must be owned by you with private permissions (0700).');return {path:root,inode:String(s.ino),owner:s.uid};
}
function recordBytes(file){
 const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.size>1024*1024)fail('WORKSPACE_RECORD_INVALID','The workspace selection record is unsafe or incomplete.');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const b=fs.readFileSync(fd),a=fs.fstatSync(fd),live=fs.lstatSync(file);if(a.ino!==s.ino||a.dev!==s.dev||a.size!==s.size||a.mtimeMs!==s.mtimeMs||live.ino!==s.ino)fail('WORKSPACE_CHANGED','The workspace record changed. Review it again.');return b;}finally{fs.closeSync(fd);}
}
function optional(file){try{return recordBytes(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function read(file){const bytes=optional(file);if(!bytes)return null;let value;try{value=JSON.parse(bytes);}catch{fail('WORKSPACE_RECORD_INVALID','The workspace record is incomplete. Originals are retained.');}if(value?.checksum!==digest(value.body))fail('WORKSPACE_RECORD_INVALID','The workspace record failed its checksum. Originals are retained.');return value.body;}
function publish(profileRoot,name,body){
 physical(profileRoot);const file=path.join(profileRoot,name),old=optional(file),stage=path.join(profileRoot,`.${name}-${randomUUID()}`),fd=fs.openSync(stage,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(fd,JSON.stringify({body,checksum:digest(body)})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 if(!Buffer.from(optional(file)??'').equals(old??Buffer.alloc(0)))fail('WORKSPACE_CHANGED','The workspace record changed. Review it again.');
 fs.renameSync(stage,file);const dir=fs.openSync(profileRoot,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
function ownership(root){const b=optional(path.join(root,'.asmagicbrain-channel.json'));return b?createHash('sha256').update(b).digest('hex'):null;}
export function workspaceIdentity(root,{probe=probeStorageVolume}={}){return {...physical(root),volumeId:probe(root),ownership:ownership(root)};}
function identityMatches(a,b){return a.path===b.path&&a.inode===b.inode&&a.owner===b.owner&&a.volumeId===b.volumeId&&a.ownership===b.ownership;}
export function selectedWorkspace({profileRoot,defaultRoot,allowedRoot,probe}){
 const selected=read(path.join(profileRoot,names.selection));if(!selected)return null;
 if(selected.schemaVersion!==1||selected.defaultRoot!==defaultRoot||!selected.active||!selected.previous||typeof selected.reviewId!=='string')fail('WORKSPACE_RECORD_INVALID','The workspace selection does not match this application profile.');
 if(allowedRoot&&!inside(allowedRoot,selected.active.path))fail('WORKSPACE_UNSAFE','Development may adopt only workspaces inside its Test folder.');
 if(!identityMatches(selected.active,workspaceIdentity(selected.active.path,{probe})))fail('WORKSPACE_CHANGED','The adopted folder or drive no longer matches its reviewed identity. Reconnect the original drive; files are retained.');
 return selected;
}
/** Read metadata only: do not follow links, open Git configuration or execute code. */
export function inspectWorkspace(root,{probe=probeStorageVolume}={}){
 const identity=workspaceIdentity(root,{probe}),organization=path.join(root,'workspaces/asMagicBrain'),state=path.join(root,'state/native');physical(organization);physical(state);
 if(!fs.existsSync(path.join(state,'.asmb-host')))fail('WORKSPACE_UNSUPPORTED','Choose the complete asMagicBrain data folder, including workspaces and state. Repository folders alone cannot preserve private state.');
 let fileCount=0,bytes=0,links=0;const stamps=[];
 function walk(dir,relative,depth){if(depth>128||stamps.length>=200000)fail('WORKSPACE_LIMIT','This folder exceeds the supported 200,000-entry review limit.');const s=fs.lstatSync(dir,{bigint:true});
  if(relative==='.asmb-native.lock')return;
  if(s.uid!==BigInt(identity.owner)||(!s.isFile()&&!s.isDirectory()&&!s.isSymbolicLink())||s.isFile()&&s.nlink!==1n)fail('WORKSPACE_UNSAFE','The folder contains unsupported ownership, hard links or special files.');
  if(s.isSymbolicLink()&&!relative.startsWith('workspaces/'))fail('WORKSPACE_UNSAFE','Private state must not contain symbolic links.');
  const target=s.isSymbolicLink()?fs.readlinkSync(dir):null;
  stamps.push([relative,String(s.ino),String(s.mode),s.isDirectory()?null:String(s.size),s.isDirectory()?null:String(s.mtimeNs),target]);
  if(s.isFile()){fileCount++;bytes+=Number(s.size);}else if(s.isSymbolicLink()){links++;}else for(const n of fs.readdirSync(dir).sort())walk(path.join(dir,n),relative?`${relative}/${n}`:n,depth+1);
 }
 walk(root,'',0);const repositories=fs.readdirSync(organization).filter(n=>{const s=fs.lstatSync(path.join(organization,n));return !n.startsWith('.')&&s.isDirectory()&&!s.isSymbolicLink();}).sort();
 if(!identityMatches(identity,workspaceIdentity(root,{probe})))fail('WORKSPACE_CHANGED','The folder changed during review.');
 return {identity,repositories,fileCount,bytes,links,fingerprint:digest(stamps)};
}
export function adoptionStatus({profileRoot}){return {selection:read(path.join(profileRoot,names.selection)),journal:read(path.join(profileRoot,names.journal))};}
export function reviewWorkspaceAdoption({currentRoot,targetRoot,profileRoot,defaultRoot,allowedRoot,bundledDocs,probe}){
 if(currentRoot===targetRoot||inside(currentRoot,targetRoot)||inside(targetRoot,currentRoot)||inside(targetRoot,profileRoot)||inside(profileRoot,targetRoot))fail('WORKSPACE_UNSAFE','Choose a separate workspace folder.');
 if(allowedRoot&&!inside(allowedRoot,targetRoot))fail('WORKSPACE_UNSAFE','Development may adopt only workspaces inside its Test folder.');
 const current=inspectWorkspace(currentRoot,{probe}),target=inspectWorkspace(targetRoot,{probe});
 return {schemaVersion:1,reviewId:randomUUID(),currentRoot,targetRoot,profileRoot,defaultRoot,allowedRoot,bundledDocs,current,target,overlappingRepositories:target.repositories.filter(n=>current.repositories.includes(n)),createdAt:new Date().toISOString()};
}
/** Run only after the active renderer and host have drained and closed. No merging,
 * copying credentials, rewriting inode-bound stores, publishing or invitations. */
export async function performWorkspaceAdoption(review,{probe=probeStorageVolume,backup=backupStorageProfile,validate,at=()=>{}}={}){
 if(review?.schemaVersion!==1||!review.reviewId||!review.target?.identity)fail('WORKSPACE_REVIEW_REQUIRED','Review the selected workspace first.');
 const {currentRoot,targetRoot,profileRoot,defaultRoot,allowedRoot}=review;
 physical(profileRoot);if(allowedRoot&&!inside(allowedRoot,targetRoot))fail('WORKSPACE_UNSAFE','The selected workspace is outside Test.');
 const current=inspectWorkspace(currentRoot,{probe}),target=inspectWorkspace(targetRoot,{probe});
 if(!identityMatches(current.identity,review.current.identity)||!identityMatches(target.identity,review.target.identity)||target.fingerprint!==review.target.fingerprint)fail('WORKSPACE_CHANGED','The selected workspace changed. Review it again.');
 const selectionBefore=read(path.join(profileRoot,names.selection));
 if(selectionBefore&&selectionBefore.active.path!==currentRoot)fail('WORKSPACE_CHANGED','The active workspace changed. Review it again.');
 const leases=[];let journal={schemaVersion:1,reviewId:review.reviewId,status:'pending',phase:'reviewed',review,backups:[],selectionBefore};
 const save=phase=>{journal={...journal,phase};publish(profileRoot,names.journal,journal);at(phase);};
 try{
  leases.push(acquireNativeProfileLock(currentRoot));leases.push(acquireNativeProfileLock(targetRoot));save('locked');
  // Both backups are independently verified and retained before validation opens
  // any private store. Workspace links are copied lexically, never followed.
  journal.backups.push({root:currentRoot,path:await backup({dataRoot:currentRoot,preserveWorkspaceLinks:true})});save('current-backed-up');
  journal.backups.push({root:targetRoot,path:await backup({dataRoot:targetRoot,preserveWorkspaceLinks:true})});save('target-backed-up');
  if(inspectWorkspace(targetRoot,{probe}).fingerprint!==review.target.fingerprint)fail('WORKSPACE_CHANGED','The selected workspace changed after review.');
  // Storage admission owns a fresh lease. A competing launch makes this fail
  // closed before selecting a workspace, never coexist with an editor.
  for(const l of leases.splice(0).reverse())l.release();
  if(validate)await validate(targetRoot);else{
   const admission=await prepareNativeStorage({dataRoot:targetRoot,probe,confirmRecovery:async()=>true});let host;
   try{host=await createNativeService({dataRoot:targetRoot,bundledDocs:review.bundledDocs,storageIdentity:admission.context,profileLock:admission.profileLock});await host.teachRequest({operation:'defaults'});const courses=await host.teachRequest({operation:'list'});for(const course of courses)await host.teachRequest({operation:'pipelineSettings',repo:course.repo});await host.setAutomationGrants({enabled:false,grants:[]});await host.close();}catch(e){if(host)await host.close().catch(()=>{});else admission.profileLock.release();throw e;}
  }
  save('validated');const active=workspaceIdentity(targetRoot,{probe});
  // Repin and lease both roots for publication; no selection if either is in use.
  leases.push(acquireNativeProfileLock(currentRoot));leases.push(acquireNativeProfileLock(targetRoot));
  if(!identityMatches(active,workspaceIdentity(targetRoot,{probe})))fail('WORKSPACE_CHANGED','The selected folder changed before switching.');
  publish(profileRoot,names.selection,{schemaVersion:1,defaultRoot,active,previous:current.identity,reviewId:review.reviewId,backups:journal.backups,selectedAt:new Date().toISOString()});save('selected');
  journal={...journal,status:'complete'};save('complete');return journal;
 }catch(e){journal={...journal,status:'failed',errorCode:e.code??'WORKSPACE_ADOPTION_FAILED'};try{publish(profileRoot,names.journal,journal);}catch{}throw e;}
 finally{for(const l of leases.reverse())l.release();}
}
/** Interrupted pre-selection work leaves the old root active. Resuming prepares
 * a fresh review and fresh backups; retained partial/verified backups are kept. */
export function resumeWorkspaceAdoption(options){const {journal}=adoptionStatus(options);if(!journal||journal.status==='complete')fail('WORKSPACE_NO_PENDING','No interrupted switch needs review.');return reviewWorkspaceAdoption({...options,targetRoot:journal.review.targetRoot});}
export function discoverWorkspaces({currentRoot,home,testRoot}){
 const candidates=[path.join(home,'asMagicBrain'),...(testRoot?[path.join(testRoot,'packaged-preview/data'),path.join(testRoot,'native-preview/data'),path.join(testRoot,'development-profile/data')]:[])];
 return [...new Set(candidates)].filter(root=>root!==currentRoot).flatMap(root=>{try{physical(root);const org=path.join(root,'workspaces/asMagicBrain');physical(org);return [{root,repositories:fs.readdirSync(org).filter(n=>{const s=fs.lstatSync(path.join(org,n));return !n.startsWith('.')&&s.isDirectory()&&!s.isSymbolicLink();}).sort()}];}catch{return [];}});
}

export function confirmWorkspaceOpened({profileRoot,dataRoot}){const {selection,journal}=adoptionStatus({profileRoot});if(selection&&journal&&journal.reviewId===selection.reviewId&&selection.active.path===dataRoot){publish(profileRoot,names.journal,{...journal,status:'complete',phase:'opened',verifiedAt:new Date().toISOString()});}}
