import fs from 'node:fs';
import path from 'node:path';
import {createPrivateStore} from '../../packages/desktop-host/src/private-store.mjs';
import {createRepositoryCatalog,validRepositoryName,validCreationId} from '../../packages/desktop-host/src/repository-import/index.mjs';
import {renameDirectoryStep} from '../../packages/desktop-host/src/repository-import/rename-directory.mjs';
import {pinDirectory,checkDirectory} from '../../packages/desktop-host/src/physical-roots.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const exists=p=>{try{return fs.lstatSync(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const identity=value=>typeof value==='string'&&/^\d+:\d+$/.test(value);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const binding=b=>exact(b,['name','identity','stateKey','bindingName'])&&validRepositoryName(b.name)&&validRepositoryName(b.bindingName)&&identity(b.identity)&&typeof b.stateKey==='string'&&(validRepositoryName(b.stateKey)||/^\.asmb-repo-[a-f0-9-]{36}$/.test(b.stateKey));
const entry=e=>exact(e,['trashId','name','trashedAt','binding'])&&validCreationId(e.trashId)&&validRepositoryName(e.name)&&typeof e.trashedAt==='string'&&new Date(e.trashedAt).toISOString()===e.trashedAt&&binding(e.binding)&&e.binding.name===e.name;
/** Durable host-only repository Trash. Original source inode and private binding
 * are retained; no recursive deletion, source serialization or private cloning. */
export function createRepositoryManagement({organization,privateRoot,bindingHash,publishBinding,retireBinding,hooks={}}){
 const org=pinDirectory(organization),store=createPrivateStore({privateRoot,bindingHash});let scan=store.ensureDurable(store.scan());
 const valid=v=>exact(v,['schemaVersion','entries','pending','restored'])&&v.schemaVersion===1&&Array.isArray(v.entries)&&v.entries.length<=1000&&v.entries.every(entry)&&new Set(v.entries.map(e=>e.trashId)).size===v.entries.length&&new Set(v.entries.map(e=>e.binding.stateKey)).size===v.entries.length&&Array.isArray(v.restored)&&v.restored.length<=1000&&v.restored.every(x=>exact(x,['trashId','name','identity'])&&validCreationId(x.trashId)&&validRepositoryName(x.name)&&identity(x.identity))&&(v.pending===null||exact(v.pending,['kind','entry','name','reservationIdentity'])&&['trash','restore'].includes(v.pending.kind)&&entry(v.pending.entry)&&validRepositoryName(v.pending.name)&&(v.pending.reservationIdentity===null||identity(v.pending.reservationIdentity)));
 let record=scan.events.at(-1)?.payload??{schemaVersion:1,entries:[],pending:null,restored:[]};
 try{if(scan.blocked||scan.events.some(e=>!valid(e.payload))||!valid(record))fail('RECOVERY_REQUIRED');}catch{fail('RECOVERY_REQUIRED');}
 const check=()=>{checkDirectory(org);const live=store.ensureDurable(store.scan());if(live.blocked||live.sequence!==scan.sequence||live.previous!==scan.previous)fail('RECOVERY_REQUIRED');};
 const persist=next=>{check();if(!valid(next))fail('RECOVERY_REQUIRED');if(scan.tailRecords>=24||scan.coveredFiles.length)scan=store.compact(scan,record);scan=store.append(scan,'draft',next);record=next;};
 const at=p=>hooks.at?.(p);
 const hidden=e=>`.asmb-repository-trash-${e.trashId}`;
 function move(from,to,wanted){
  let pending=record.pending;const original=exists(path.join(org.path,from)),destination=exists(path.join(org.path,to));
  if(original){
   if(pinDirectory(path.join(org.path,from)).identity!==wanted)fail('REPOSITORY_CHANGED');
   if(pending.reservationIdentity===null){
    if(destination)fail('RECOVERY_REQUIRED');const reservationIdentity=renameDirectoryStep(org,{operation:'reserve',name:to});at('repository-'+pending.kind+'-reserved-before-receipt');
    persist({...record,pending:{...pending,reservationIdentity}});pending=record.pending;at('repository-'+pending.kind+'-reserved');
   }else if(!destination||pinDirectory(path.join(org.path,to)).identity!==pending.reservationIdentity)fail('RECOVERY_REQUIRED');
   renameDirectoryStep(org,{operation:'rename',repository:from,name:to,identity:wanted,reservationIdentity:pending.reservationIdentity});at('repository-'+pending.kind+'-moved');
  }else if(!destination||pinDirectory(path.join(org.path,to)).identity!==wanted)fail('RECOVERY_REQUIRED');
 }
 function recover(){
  check();const p=record.pending;if(!p)return;const e=p.entry,catalog=createRepositoryCatalog(org.path,{builtinRepositories:[]});
  if(p.kind==='trash'){
   move(e.name,hidden(e),e.binding.identity);catalog.retireRegistration({repository:e.name,trashId:e.trashId,identity:e.binding.identity});at('repository-trash-cataloged');
   retireBinding(e.binding);at('repository-trash-bound');persist({...record,entries:[...record.entries.filter(v=>v.trashId!==e.trashId),e],pending:null});at('repository-trash-completed');
  }else{
   move(hidden(e),p.name,e.binding.identity);catalog.restoreRegistration({trashId:e.trashId,name:p.name,identity:e.binding.identity});at('repository-restore-cataloged');
   publishBinding({...e.binding,name:p.name});at('repository-restore-bound');persist({...record,entries:record.entries.filter(v=>v.trashId!==e.trashId),pending:null,restored:[...record.restored.filter(v=>v.trashId!==e.trashId),{trashId:e.trashId,name:p.name,identity:e.binding.identity}].slice(-1000)});at('repository-restore-completed');
  }
 }
 return Object.freeze({
  recover,
  hasPending:()=>record.pending!==null,
  reservedStateKeys:()=>record.entries.map(e=>e.binding.stateKey),
  list(){check();return record.entries.map(({trashId,name,trashedAt})=>({trashId,name,trashedAt}));},
  find(id){check();return record.entries.find(e=>e.trashId===id);},
  completedRestore(id){check();return record.restored.find(e=>e.trashId===id);},
  trash({binding:source,requestId}){
   check();if(record.pending)fail('RECOVERY_REQUIRED');const previous=record.entries.find(e=>e.trashId===requestId);
   if(previous){if(previous.binding.identity!==source.identity||previous.name!==source.name)fail('REQUEST_CONFLICT');return previous;}
   if(record.restored.some(e=>e.trashId===requestId))fail('REQUEST_CONFLICT');if(record.entries.length>=1000)fail('LIMIT_EXCEEDED');
   const e={trashId:requestId,name:source.name,trashedAt:new Date().toISOString(),binding:{...source}};
   persist({...record,pending:{kind:'trash',entry:e,name:e.name,reservationIdentity:null}});at('repository-trash-intent');recover();return e;
  },
  restore({trashId,name}){
   check();if(record.pending)fail('RECOVERY_REQUIRED');const e=record.entries.find(v=>v.trashId===trashId);if(!e)fail('UNKNOWN_REPOSITORY_TRASH');
   persist({...record,pending:{kind:'restore',entry:e,name,reservationIdentity:null}});at('repository-restore-intent');recover();return {...e.binding,name};
  },
 });
}
