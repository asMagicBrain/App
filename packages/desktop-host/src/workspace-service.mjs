import {persistentIdentity} from '../../source-foundation/src/adapters/storage-identity.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRepositoryRuntime} from './repository-runtime/index.mjs';
import {createPrivateStore} from './private-store.mjs';
import {pinDirectory, checkDirectory} from './physical-roots.mjs';
import {createRepositoryCatalog,validRepositoryName} from './repository-import/index.mjs';
import {createCommitPreferencesStore,isValidCommitAuthor} from './commit-preferences.mjs';
import {isPortableRelativePath} from '../../source-foundation/src/domain/path-policy.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const fields={open:['path'],discover:[],checkpoint:['path','baseHash','text'],save:['path','baseHash','text'],create:['path','text'],rename:['path','newPath','baseHash'],discard:['path'],createFolder:['path'],inspectEntry:['path'],manage:['operation','items'],listTrash:[],restore:['trashId'],reconcile:[],runtimeStatus:[],checkpointNew:['draftId','path','text'],discardNew:['draftId'],getCommitPreferences:[],setCommitPreferences:['expectedRevision','mode','asmagicbrain','github'],gitInspect:[],gitInitialize:['branch'],gitStatus:[],gitReview:['paths'],gitCommit:['expectedHead','expectedIndexHash','files','message','author']};
const text=(v,max)=>typeof v==='string'&&v.isWellFormed()&&!v.includes('\0')&&Buffer.byteLength(v)<=max;
function draftValid(v){return exact(v,['draftId','path','text'])&&typeof v.draftId==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(v.draftId)&&text(v.path,4096)&&!/[\x00-\x1f]/.test(v.path)&&text(v.text,1024*1024);}

// Fixed host bindings only. Neither URLs nor renderer messages can select roots.
export function createWorkspaceService({base,privateBase,builtinRepositories,repositoryBindings,localOwnerId='asMagicBrain',localRootId='local-editor',runtimeHooks={}}={}){
 base=path.resolve(base);privateBase=path.resolve(privateBase);
 if(repositoryBindings!==undefined){
  if(!Array.isArray(repositoryBindings)||repositoryBindings.length>1000||repositoryBindings.some(value=>!exact(value,['name','identity','stateKey','bindingName'])||!validRepositoryName(value.name)||!validRepositoryName(value.bindingName)||typeof value.identity!=='string'||!/^\d+:\d+$/.test(value.identity)||typeof value.stateKey!=='string'||!(validRepositoryName(value.stateKey)||/^\.asmb-repo-[a-f0-9-]{36}$/.test(value.stateKey)))||new Set(repositoryBindings.map(value=>value.name.toUpperCase())).size!==repositoryBindings.length||new Set(repositoryBindings.map(value=>value.stateKey.toUpperCase())).size!==repositoryBindings.length)fail('INVALID_IDENTITY');
  repositoryBindings=repositoryBindings.map(value=>Object.freeze({...value}));
 }
 const basePin=pinDirectory(base),sessions=new Map(),catalog=createRepositoryCatalog(base,{builtinRepositories});
 function directory(parent,name){
  const parentPin=pinDirectory(parent),target=path.join(parent,name);try{fs.mkdirSync(target,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  const pin=pinDirectory(target);if((fs.statSync(target).mode&0o777)!==0o700)fail('INVALID_PRIVATE_ROOT');
  const fd=fs.openSync(parent,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  try{if(persistentIdentity(fs.fstatSync(fd))!==parentPin.identity)fail('DENIED');fs.fsyncSync(fd);checkDirectory(parentPin);}finally{fs.closeSync(fd);}return pin;
 }
 const privatePin=directory(path.dirname(privateBase),path.basename(privateBase));
 let commitPreferences;
 function preferences(repo){
  catalog.assertKnown(repo);checkDirectory(basePin);checkDirectory(privatePin);
  if(!commitPreferences){
   // A leading dot cannot be an imported repository name. Keep shared settings
   // outside every per-repository private directory and outside source/Git.
   const settings=directory(privateBase,'.asmb-settings'),root=directory(settings.path,'commit-preferences');
   for(const pin of [privatePin,settings,root]){
    checkDirectory(pin);const stat=fs.lstatSync(pin.path);
    if((stat.mode&0o777)!==0o700||(typeof process.getuid==='function'&&stat.uid!==process.getuid()))fail('INVALID_PRIVATE_ROOT');
   }
   // Persist each new directory's name in its parent as well as the records.
   for(const pin of [privatePin,settings,root]){
    const parent=pinDirectory(path.dirname(pin.path)),fd=fs.openSync(parent.path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
    try{if(persistentIdentity(fs.fstatSync(fd))!==parent.identity)fail('DENIED');fs.fsyncSync(fd);checkDirectory(parent);}finally{fs.closeSync(fd);}
   }
   commitPreferences=createCommitPreferencesStore({workspaceRoot:base,privateRoot:root.path,localOwnerId});
  }
  return commitPreferences;
 }
 function session(repo){
  catalog.assertKnown(repo);checkDirectory(basePin);checkDirectory(privatePin);
  if(sessions.has(repo)){const cached=sessions.get(repo);checkDirectory(cached.sourcePin);return cached;}
  const sourceRoot=path.join(base,repo),sourcePin=pinDirectory(sourceRoot),binding=repositoryBindings?.find(item=>item.name===repo);
  if(repositoryBindings&&(!binding||binding.identity!==sourcePin.identity))fail('REPOSITORY_CHANGED');
  const root=directory(privateBase,binding?.stateKey??repo),sourceBindingRoot=path.join(base,binding?.bindingName??repo);
  const runtime=createRepositoryRuntime({sourceRoot,sourceBindingRoot,privateRoot:directory(root.path,'files').path,localOwnerId,localRootId,checkoutId:binding?.bindingName??repo,hooks:runtimeHooks});
  const drafts=createPrivateStore({privateRoot:directory(root.path,'new-drafts').path,bindingHash:createHash('sha256').update(JSON.stringify({sourceRoot:sourceBindingRoot,identity:sourcePin.identity})).digest('hex')});
  const readDrafts=()=>{const scan=drafts.ensureDurable(drafts.scan());const values=scan.events.at(-1)?.payload??[];if(!Array.isArray(values)||values.length>32||!values.every(draftValid))fail('RECOVERY_REQUIRED');return {scan,values};};
  const updateDrafts=fn=>{let {scan,values}=readDrafts();const next=fn(values);if(next.length>32||Buffer.byteLength(JSON.stringify(next))>3*1024*1024)fail('DRAFT_LIMIT');if(scan.tailRecords>=24)scan=drafts.compact(scan,values);drafts.append(scan,'draft',next);return {status:'checkpointed'};};
  const value={runtime,readDrafts,updateDrafts,git:null,sourceRoot,sourceBindingRoot,sourcePin,gitRoot:directory(root.path,'git').path};sessions.set(repo,value);return value;
 }
 async function execute(repo,operation,args){
  if(!Object.hasOwn(fields,operation)||!exact(args,fields[operation]))fail('INVALID_REQUEST');
  for(const key of ['path','newPath'])if(Object.hasOwn(args,key)&&!text(args[key],4096))fail('INVALID_PATH');
  if(Object.hasOwn(args,'text')&&!text(args.text,1024*1024))fail('INVALID_TEXT');
  if(operation==='getCommitPreferences')return preferences(repo).get();
  if(operation==='setCommitPreferences')return preferences(repo).set(args);
  if(operation==='gitCommit'&&!isValidCommitAuthor(args.author))fail('INVALID_AUTHOR');
  const s=session(repo);
  if(operation==='checkpointNew'){if(!draftValid(args))fail('INVALID_DRAFT');return s.updateDrafts(values=>[...values.filter(v=>v.draftId!==args.draftId),args]);}
  if(operation==='discardNew'){if(typeof args.draftId!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(args.draftId))fail('INVALID_DRAFT');return s.updateDrafts(values=>values.filter(v=>v.draftId!==args.draftId));}
  if(operation.startsWith('git')){
   if(!s.git){const {createLocalGit}=await import('./local-git/index.mjs');s.git=createLocalGit({sourceRoot:s.sourceRoot,sourceBindingRoot:s.sourceBindingRoot,privateRoot:s.gitRoot});}
   const method={gitInspect:'inspect',gitInitialize:'initialize',gitStatus:'status',gitReview:'review',gitCommit:'commit'}[operation];return s.git[method](args);
  }
  if(operation==='open'||operation==='discard')return s.runtime[operation](args.path);
  if(operation==='discover')return s.runtime.discover();
  if(operation==='listTrash'||operation==='reconcile')return s.runtime[operation]();
  if(operation==='runtimeStatus')return s.runtime.state();
  return s.runtime[operation](args);
 }
 return {bootstrap(repo){const s=session(repo);return {local:true,newDrafts:s.readDrafts().values};},execute,
  importExternal(repo,request){const s=session(repo);return s.runtime.importExternal({...request,reservedPaths:s.readDrafts().values.map(item=>item.path).filter(value=>isPortableRelativePath(value)&&value.split('/').length<=32)});},
  close(){for(const s of sessions.values())s.runtime.close();sessions.clear();}};
}
