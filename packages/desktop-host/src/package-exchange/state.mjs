import {safePath,validLabel,validHash,validateFileList} from './archive.mjs';
import {portablePathKey} from '../../../source-foundation/src/domain/path-policy.mjs';
const exact=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&fields.every(field=>Object.hasOwn(value,field));
const id=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const requireValid=value=>{if(!value)throw Object.assign(Error('RECOVERY_REQUIRED'),{code:'RECOVERY_REQUIRED'});};
/** Pure journal decoder shared by ordinary startup and read-only volume recovery. */
export function validateExchangeState(state){
 const hashes=new Set();
 function registration(value,nullable=false){
  if(value===null&&nullable)return;
  requireValid(exact(value,['collectionId','version','files'])&&validLabel(value.collectionId)&&validLabel(value.version)&&Array.isArray(value.files)&&value.files.length<=9999);
  validateFileList(value.files);for(const file of value.files)hashes.add(file.sha256);
 }
 function operation(op,pending){
  requireValid(exact(op,['operationId','packageDigest','direction','phase','index','changes','before','after','createdDirectories','createdAt'])&&id(op.operationId)&&validHash(op.packageDigest)&&['apply','rollback'].includes(op.direction)&&Array.isArray(op.changes)&&op.changes.length<=256&&Number.isSafeInteger(op.index)&&op.index>=0&&op.index<=op.changes.length&&Array.isArray(op.createdDirectories)&&op.createdDirectories.length<=8192&&op.createdDirectories.every(safePath)&&new Set(op.createdDirectories.map(portablePathKey)).size===op.createdDirectories.length&&Number.isSafeInteger(op.createdAt)&&op.createdAt>=0);
  requireValid(pending?['pending','interrupted'].includes(op.phase):op.index===op.changes.length&&(op.direction==='apply'?op.phase==='completed':op.phase==='rolled-back'));
  registration(op.before);registration(op.after);requireValid(op.before.collectionId===op.after.collectionId);
  const names=new Set();
  for(const change of op.changes){requireValid(exact(change,['path','beforeHash','afterHash'])&&safePath(change.path)&&[change.beforeHash,change.afterHash].every(value=>value===null||validHash(value))&&change.beforeHash!==change.afterHash&&!names.has(portablePathKey(change.path)));names.add(portablePathKey(change.path));for(const value of [change.beforeHash,change.afterHash])if(value!==null)hashes.add(value);}
 }
 requireValid(exact(state,['schemaVersion','registration','pending','operations'])&&state.schemaVersion===1&&Array.isArray(state.operations)&&state.operations.length<=8);
 registration(state.registration,true);state.operations.forEach(op=>operation(op,false));requireValid(new Set(state.operations.map(op=>op.operationId)).size===state.operations.length);
 if(state.pending!==null){operation(state.pending,true);requireValid(state.registration!==null);}
 return {hashes:[...hashes]};
}
