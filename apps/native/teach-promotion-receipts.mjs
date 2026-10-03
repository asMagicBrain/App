import {randomUUID} from 'node:crypto';
const fail=code=>{throw Object.assign(Error(code),{code});};
const hash=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const safePath=v=>typeof v==='string'&&v.length<=4096&&!/[\\\u0000-\u001f]/.test(v)&&!v.startsWith('/')&&v.split('/').every(p=>p&&p!=='.'&&p!=='..');
function validReceipt(r,pending){return r&&typeof r==='object'&&uuid(r.id)&&uuid(r.courseId)&&hash(r.sourceId)&&hash(r.destinationId)&&r.sourceId!==r.destinationId&&(r.sourceCommit===null||typeof r.sourceCommit==='string'&&/^[0-9a-f]{40,64}$/.test(r.sourceCommit))&&['instructors','assistants'].includes(r.sourceRole)&&['instructors','assistants','students'].includes(r.toRole)&&r.sourceRole!==r.toRole&&Number.isSafeInteger(r.localRecordedAt)&&r.localRecordedAt>0&&Array.isArray(r.files)&&r.files.length>0&&r.files.length<=128&&new Set(r.files.map(f=>f.path)).size===r.files.length&&r.files.every(f=>safePath(f.path)&&hash(f.sha256)&&Number.isSafeInteger(f.bytes)&&f.bytes>=0&&f.bytes<=4*1024*1024)&&(pending?Array.isArray(r.priorHashes)&&r.priorHashes.length===r.files.length&&r.priorHashes.every((f,i)=>f.path===r.files[i].path&&(f.sha256===null||hash(f.sha256))):(r.operationId===null||uuid(r.operationId))&&r.status==='copied-locally');}
// Local copy provenance, not a submission receipt or proof of publication time.
export function createPromotionReceipts(store){
 function load(){const scan=store.ensureDurable(store.scan());if(scan.blocked)fail('RECOVERY_REQUIRED');const state=scan.events.at(-1)?.payload??{schemaVersion:1,receipts:[],pending:null};if(state.schemaVersion!==1||!Array.isArray(state.receipts)||state.receipts.length>1000||state.receipts.some(r=>!validReceipt(r,false))||state.pending!==null&&!validReceipt(state.pending,true))fail('RECOVERY_REQUIRED');return {scan,state};}
 function write(state){let {scan,state:prior}=load();if(scan.tailRecords>=24||scan.coveredFiles.length)scan=store.compact(scan,prior);store.append(scan,'draft',state);}
 return {
  status(courseId){const {state}=load();return {last:state.receipts.filter(r=>r.courseId===courseId).at(-1)??null,pending:state.pending?.courseId===courseId?state.pending:null};},
  ready(){const {state}=load();if(state.pending)fail('PROMOTION_RECOVERY_REQUIRED');if(state.receipts.length>=1000)fail('PROMOTION_RECEIPT_LIMIT');},
  begin(value){this.ready();const {state}=load(),pending={...value,id:randomUUID(),localRecordedAt:Date.now()};write({...state,pending});return pending;},
  complete(operationId){const {state}=load();if(!state.pending)fail('PROMOTION_RECOVERY_REQUIRED');const {priorHashes,...receipt}=state.pending;write({...state,pending:null,receipts:[...state.receipts,{...receipt,operationId,status:'copied-locally'}]});return receipt;},
  cancel(){const {state}=load();write({...state,pending:null});},
  pending(){return structuredClone(load().state.pending);}
 };
}
