import {createHash} from 'node:crypto';
import {createPrivateStore} from './private-store.mjs';
import {pinDirectory, checkDirectory, contains} from './physical-roots.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)
 &&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const modes=new Set(['asmagicbrain','github','manual']);
const revisionValid=value=>Number.isSafeInteger(value)&&value>=0;
const labelValid=value=>typeof value==='string'&&value.length<=256&&Buffer.byteLength(value)<=1024
 &&value.isWellFormed()&&!/[\x00-\x1f\x7f-\x9f<>]/u.test(value);
const emailValid=value=>/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value);
function identityValid(value,complete=false){
 return exact(value,['name','email'])&&labelValid(value.name)&&labelValid(value.email)
  &&(value.name===''?!complete:value.name.trim().length>0)
  &&(value.email===''?!complete:emailValid(value.email));
}
export const isValidCommitAuthor=value=>identityValid(value,true);
function preferencesValid(value){
 return exact(value,['revision','mode','asmagicbrain','github'])&&revisionValid(value.revision)
  &&modes.has(value.mode)&&identityValid(value.asmagicbrain)&&identityValid(value.github);
}
const initial=()=>({revision:0,mode:'asmagicbrain',asmagicbrain:{name:'',email:''},github:{name:'',email:''}});
const copy=value=>({revision:value.revision,mode:value.mode,asmagicbrain:{...value.asmagicbrain},github:{...value.github}});

/** Local commit labels only: no authentication, Git config, or repository data.
 * The trusted host supplies a dedicated 0700 directory outside source/Git. A
 * checksummed append log binds labels to this OS owner and physical workspace.
 * Revision zero is persisted too, so reopening never silently rebinds a store.
 */
export function createCommitPreferencesStore({workspaceRoot,privateRoot,localOwnerId,hooks={}}){
 if(!labelValid(localOwnerId)||!localOwnerId.trim())fail('INVALID_OWNER');
 const workspace=pinDirectory(workspaceRoot),privatePin=pinDirectory(privateRoot);
 if(contains(workspace.path,privatePin.path)||contains(privatePin.path,workspace.path))fail('INVALID_PRIVATE_ROOT');
 const bindingHash=createHash('sha256').update(JSON.stringify({kind:'commit-preferences',schemaVersion:1,
  workspaceRoot:workspace.path,workspaceIdentity:workspace.identity,localOwnerId,
  uid:typeof process.getuid==='function'?process.getuid():null})).digest('hex');
 const store=createPrivateStore({privateRoot:privatePin.path,bindingHash,hooks});
 function read(){
  checkDirectory(workspace);checkDirectory(privatePin);
  let scan=store.ensureDurable(store.scan());
  if(scan.events.length===0)scan=store.append(scan,'draft',initial());
  // Compaction retains the original sequence; one record corresponds to each
  // revision, including the initial empty profile. Reject malformed state and
  // never turn a damaged or differently bound log into fresh defaults.
  for(const event of scan.events)if(!preferencesValid(event.payload)||event.payload.revision!==event.sequence-1)fail('RECOVERY_REQUIRED');
  const value=scan.events.at(-1)?.payload;
  if(!preferencesValid(value)||scan.blocked)fail('RECOVERY_REQUIRED');
  checkDirectory(workspace);return {scan,value};
 }
 return Object.freeze({
  get(){return copy(read().value);},
  set(request){
   if(!exact(request,['expectedRevision','mode','asmagicbrain','github'])||!revisionValid(request.expectedRevision)
    ||!preferencesValid({revision:request.expectedRevision,mode:request.mode,asmagicbrain:request.asmagicbrain,github:request.github}))fail('INVALID_PREFERENCES');
   let {scan,value}=read();
   if(request.expectedRevision!==value.revision)fail('CONFLICT');
   if(value.revision===Number.MAX_SAFE_INTEGER)fail('LIMIT_EXCEEDED');
   const next=copy({revision:value.revision+1,mode:request.mode,asmagicbrain:request.asmagicbrain,github:request.github});
   if(scan.tailRecords>=24||scan.coveredFiles.length)scan=store.compact(scan,value);
   const written=store.append(scan,'draft',next);
   if(written.blocked)fail('RECOVERY_REQUIRED');
   checkDirectory(workspace);return copy(next);
  },
 });
}
