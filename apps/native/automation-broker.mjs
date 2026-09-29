import {createHash,randomUUID} from 'node:crypto';
import {isPortableRelativePath,portablePathKey} from '../../packages/source-foundation/src/domain/path-policy.mjs';
import {AUTOMATION_LIMITS as limits,automationResultLimit} from './automation-limits.mjs';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(canonical(value))).digest('hex');
const bytesHash=value=>createHash('sha256').update(value).digest('hex');
const fail=(code,publicMessage=code)=>{throw Object.assign(Error(code),{code,publicMessage});};
const scopes=['read','write','import','export'];
const mutations={'write.plan':'write','import.plan':'import','package.plan':'import','export.plan':'export'};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const relative=value=>typeof value==='string'&&value.isWellFormed()&&isPortableRelativePath(value)&&!value.split('/').some(part=>['.git','.asmagicbrain'].includes(part.toLowerCase())||part.toLowerCase().startsWith('.asmb-'));
const repositoryName=value=>relative(value)&&!value.includes('/')&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value);
const label=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/.test(value);
const archive=value=>typeof value==='string'&&value.length>0&&value.length<=Math.ceil(limits.archiveBytes/3)*4&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)&&Buffer.from(value,'base64').length<=limits.archiveBytes;
const boundedText=(value,max)=>typeof value==='string'&&value.isWellFormed()&&Buffer.byteLength(value)<=max;
const publicFailure=error=>({code:typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)?error.code:'OPERATION_FAILED',message:boundedText(error?.publicMessage,512)?error.publicMessage:'The operation was not confirmed. Check its status before retrying.'});
/** Read-only decoder shared by startup and storage recovery. It grants no authority. */
export function validateAutomationState(record){
 const invalid=()=>fail('INVALID_AUTOMATION_STATE');
 let encoded;try{encoded=JSON.stringify(record);}catch{invalid();}
 if(!encoded||Buffer.byteLength(encoded)>limits.journalBytes||!exact(record,['schemaVersion','operations'])||record.schemaVersion!==1||!Array.isArray(record.operations)||record.operations.length>limits.operations)invalid();
 const ids=new Set(),requests=new Set();
 const nullableHash=value=>value===null||sha(value),count=(value,max)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
 const pathList=value=>Array.isArray(value)&&value.length<=10000&&value.every(relative)&&new Set(value.map(portablePathKey)).size===value.length;
 const warnings=value=>Array.isArray(value)&&value.length<=4096&&value.every(item=>item&&typeof item==='object'&&!Array.isArray(item)&&Object.keys(item).every(key=>['path','code','message'].includes(key))&&token(item.code)&&boundedText(item.message,4096)&&(item.path===undefined||relative(item.path)));
 const reviewFields=['kind','packageDigest','collectionId','version','semantics','rows','drafts','warnings','fileCount'];
 function checkPlan(op){
  const args=op.args,plan=op.plan;
  if(op.kind==='write.plan'){
   if(!exact(plan,['kind','repo','repoId','path','before','after','expectedHash','afterHash'])||plan.kind!=='write'||!repositoryName(plan.repo)||plan.repoId!==args.repoId||plan.path!==args.path||plan.after!==args.text||plan.expectedHash!==args.expectedHash||plan.afterHash!==hash(args.text)||!(plan.before===null?args.expectedHash===null:boundedText(plan.before,2*1024*1024)&&hash(plan.before)===args.expectedHash))invalid();
  }else if(op.kind==='import.plan'){
   if(!exact(plan,['kind','into','name','archiveSha256','files','history'])||plan.kind!=='import'||plan.into!=='asMagicBrain'||plan.name!==args.name||plan.archiveSha256!==bytesHash(Buffer.from(args.archiveBase64,'base64'))||!boundedText(plan.history,512)||!Array.isArray(plan.files)||!plan.files.length||plan.files.length>4096||new Set(plan.files.map(item=>portablePathKey(item?.path??''))).size!==plan.files.length||plan.files.some(item=>!exact(item,['path','bytes','sha256'])||!relative(item.path)||!count(item.bytes,64*1024*1024)||!sha(item.sha256)))invalid();
  }else{
   const update=op.kind==='package.plan';
   if(!exact(plan,[...reviewFields,update?'choices':'exportKind'])||plan.kind!==(update?'update':'export')||!label(plan.collectionId)||!label(plan.version)||plan.version!==args.version||!Array.isArray(plan.rows)||plan.rows.length>4096||!pathList(plan.drafts)||!warnings(plan.warnings)||!count(plan.fileCount,9999)||new Set(plan.rows.map(row=>portablePathKey(row?.path??''))).size!==plan.rows.length)invalid();
   if(update){
    if(plan.packageDigest!==bytesHash(Buffer.from(args.archiveBase64,'base64'))||plan.semantics!==args.semantics||hash(plan.choices)!==hash(args.choices))invalid();
    for(const row of plan.rows){const fields=['path','action','owned','baseHash','currentHash','incomingHash','conflict','protectedDraft','choices'];if(!row||!fields.every(key=>Object.hasOwn(row,key))||Object.keys(row).some(key=>![...fields,'base','current','incoming'].includes(key))||!relative(row.path)||!['preserve','unchanged','add','update','remove','conflict'].includes(row.action)||typeof row.owned!=='boolean'||![row.baseHash,row.currentHash,row.incomingHash].every(nullableHash)||typeof row.conflict!=='boolean'||typeof row.protectedDraft!=='boolean'||!Array.isArray(row.choices)||row.choices.length>3||new Set(row.choices).size!==row.choices.length||row.choices.some(choice=>!['keep-current','use-incoming','keep-both'].includes(choice))||['base','current','incoming'].some(key=>row[key]!==undefined&&row[key]!==null&&!boundedText(row[key],65536)))invalid();}
    for(const choice of args.choices)if(!plan.rows.find(row=>row.path===choice.path)?.choices.includes(choice.choice))invalid();
   }else if(plan.packageDigest!==null||plan.semantics!==null||plan.collectionId!==args.collectionId||plan.exportKind!==args.kind||plan.rows.some(row=>!exact(row,['path','sha256','bytes'])||!relative(row.path)||!sha(row.sha256)||!count(row.bytes,64*1024*1024)))invalid();
  }
 }
 const json=(value,depth=0)=>{if(depth>24)invalid();if(value===null||typeof value==='boolean'||typeof value==='string'||value===undefined)return;if(typeof value==='number'&&Number.isFinite(value))return;if(Array.isArray(value)){if(value.length>4096)invalid();for(const item of value)json(item,depth+1);return;}if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid();for(const [key,item]of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(key))invalid();json(item,depth+1);}};
 for(const op of record.operations){
  const required=['operationId','requestId','kind','args','repoId','digest','reviewDigest','plan','status','createdAt'];
  if(!op||typeof op!=='object'||Array.isArray(op)||required.some(key=>!Object.hasOwn(op,key))||Object.keys(op).some(key=>![...required,'result','error'].includes(key)))invalid();
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(op.operationId)||ids.has(op.operationId)||!token(op.requestId)||requests.has(op.requestId)||!Object.hasOwn(mutations,op.kind)||!token(op.repoId)||!sha(op.digest)||!sha(op.reviewDigest)||!['review','applying','completed','failed','cancelled'].includes(op.status)||!Number.isSafeInteger(op.createdAt)||op.createdAt<0)invalid();
  ids.add(op.operationId);requests.add(op.requestId);
  const args=op.args;if(!args||args.repoId!==op.repoId)invalid();
  if(op.kind==='write.plan'&&(!exact(args,['repoId','path','expectedHash','text'])||!relative(args.path)||(args.expectedHash!==null&&!sha(args.expectedHash))||!boundedText(args.text,limits.textBytes)))invalid();
  if(op.kind==='import.plan'&&(!exact(args,['repoId','name','archiveBase64'])||!repositoryName(args.name)||!archive(args.archiveBase64)))invalid();
  if(op.kind==='package.plan'&&(!exact(args,['repoId','archiveBase64','semantics','version','choices'])||!archive(args.archiveBase64)||!['patch','snapshot'].includes(args.semantics)||!label(args.version)||!Array.isArray(args.choices)||args.choices.length>256||new Set(args.choices.map(item=>item?.path)).size!==args.choices.length||args.choices.some(item=>!exact(item,['path','choice'])||!relative(item.path)||!['keep-current','use-incoming','keep-both'].includes(item.choice))))invalid();
  if(op.kind==='export.plan'&&(!exact(args,['repoId','kind','collectionId','version'])||!['source','offline'].includes(args.kind)||!label(args.collectionId)||!label(args.version)))invalid();
  json(op.plan);json(op.result);if(!op.plan||typeof op.plan!=='object'||Array.isArray(op.plan)||hash({kind:op.kind,args})!==op.digest||hash(op.plan)!==op.reviewDigest)invalid();
  checkPlan(op);
  if(op.result!==undefined&&Buffer.byteLength(JSON.stringify(op.result))>automationResultLimit(op.kind))invalid();
  if(op.kind==='export.plan'&&op.result!==undefined){
   const result=op.result;
   if(!exact(result,['filename','sha256','archiveBase64','warnings'])||result.filename!==`${args.collectionId}-${args.version}-${args.kind}.zip`||!sha(result.sha256)||!warnings(result.warnings)||typeof result.archiveBase64!=='string'||!result.archiveBase64.length||result.archiveBase64.length>Math.ceil(limits.exportArchiveBytes/3)*4)invalid();
   const bytes=Buffer.from(result.archiveBase64,'base64');
   if(bytes.length>limits.exportArchiveBytes||bytes.toString('base64')!==result.archiveBase64||bytesHash(bytes)!==result.sha256)invalid();
  }
  if(op.status==='completed'&&op.result===undefined)invalid();
  if(op.error!==undefined&&(!exact(op.error,['code','message'])||!boundedText(op.error.code,128)||!boundedText(op.error.message,2048)))invalid();
 }
 return true;
}
/** Session grants + durable operation receipts. Content writes use the one host service. */
export function createAutomationBroker({store,catalog,read,search,validate,capabilities={},prepare,apply,inspectInterrupted}){
 let scan=store.ensureDurable(store.scan());if(scan.blocked)fail('AUTOMATION_RECOVERY_REQUIRED');
 let state=scan.events.at(-1)?.payload??{schemaVersion:1,operations:[]};
 try{validateAutomationState(state);}catch{fail('AUTOMATION_RECOVERY_REQUIRED');}
 let enabled=false,grants=[],serial=Promise.resolve(),closed=false,held=false;
 const queue=fn=>{if(held)return Promise.reject(Object.assign(Error('AUTOMATION_RECOVERY_REQUIRED'),{code:'AUTOMATION_RECOVERY_REQUIRED'}));if(closed)return Promise.reject(Object.assign(Error('SERVICE_CLOSED'),{code:'SERVICE_CLOSED'}));const work=serial.then(()=>{if(held)fail('AUTOMATION_RECOVERY_REQUIRED');return fn();});serial=work.catch(()=>{});return work;};
 const persist=()=>{try{validateAutomationState(state);if(scan.tailRecords>=16||scan.coveredFiles.length)scan=store.compact(scan,state);scan=store.append(scan,'draft',state);}catch(error){held=true;enabled=false;throw error;}};
 const allowed=(repoId,scope)=>enabled&&grants.some(grant=>grant.repoId===repoId&&grant.scopes.includes(scope));
 const admit=(repoId,scope)=>{if(!allowed(repoId,scope))fail('PERMISSION_DENIED','Enable the required repository permission in Local automation.');};
 const receipt=(operation,includeResult=true)=>({operationId:operation.operationId,requestId:operation.requestId,status:operation.status,kind:operation.kind,repoId:operation.repoId,digest:operation.digest,createdAt:operation.createdAt,...(operation.error?{error:operation.error}:{}),...(includeResult&&operation.result!==undefined?{result:operation.result}:{})});
 const find=id=>{const operation=state.operations.find(item=>item.operationId===id||item.requestId===id);if(!operation)fail('OPERATION_NOT_FOUND');return operation;};
 async function recover(operation){
  if(operation.status!=='applying')return;const result=await inspectInterrupted(operation);if(result?.pending)return;
  const candidate=result?.completed?{...operation,status:'completed',result:result.result}:{...operation,status:'failed',error:{code:'REVIEW_REQUIRED',message:'The interrupted operation needs a new review. Its original request will not execute twice.'}};
  if(result?.completed)delete candidate.error;
  try{validateAutomationState({...state,operations:state.operations.map(item=>item===operation?candidate:item)});}catch{held=true;enabled=false;fail('AUTOMATION_RECOVERY_REQUIRED');}
  Object.assign(operation,candidate);if(result?.completed)delete operation.error;persist();
 }
 return Object.freeze({
  setGrants(input){return queue(async()=>{if(!exact(input,['enabled','grants'])||typeof input.enabled!=='boolean'||!Array.isArray(input.grants)||input.grants.length>1000)fail('INVALID_REQUEST');const entries=await catalog();const ids=new Set();for(const grant of input.grants){if(!exact(grant,['repoId','scopes'])||!entries.some(entry=>entry.stableId===grant.repoId)||ids.has(grant.repoId)||!Array.isArray(grant.scopes)||grant.scopes.some(scope=>!scopes.includes(scope))||new Set(grant.scopes).size!==grant.scopes.length)fail('INVALID_GRANT');ids.add(grant.repoId);}enabled=input.enabled;grants=structuredClone(input.grants);return {enabled,grants};});},
  uiStatus(){return queue(async()=>{for(const operation of state.operations)await recover(operation);return {schemaVersion:1,enabled,grants:structuredClone(grants),limits,operations:state.operations.map(operation=>({...receipt(operation,false),plan:operation.plan}))};});},
  request(input){return queue(async()=>{
   if(!exact(input,['requestId','operation','args'])||typeof input.requestId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)||!input.args||typeof input.args!=='object'||Array.isArray(input.args))fail('INVALID_REQUEST');
   if(!enabled)fail('PERMISSION_DENIED');const {operation:kind,args}=input;
   if(kind==='capabilities'){if(Object.keys(args).length)fail('INVALID_REQUEST');return {schemaVersion:1,...capabilities,operations:['capabilities','catalog','read','search','validate','status','cancel',...Object.keys(mutations)],grants:structuredClone(grants),limits,interaction:{imported:'Files only; no code execution.',eligible:'Manifest review is separate from runtime permission.',permitted:'Interactive execution requires a separate in-app approval.'},forbidden:['delete','commit','push','credentials','artifact.run']};}
   if(kind==='catalog'){if(Object.keys(args).length)fail('INVALID_REQUEST');return (await catalog()).filter(entry=>allowed(entry.stableId,'read'));}
   if(kind==='read'||kind==='search'||kind==='validate'){admit(args.repoId,'read');return kind==='read'?read(args):kind==='search'?search(args):validate(args);}
   if(kind==='status'||kind==='cancel'){
    if(!exact(args,['operationId']))fail('INVALID_REQUEST');const operation=find(args.operationId);admit(operation.repoId,mutations[operation.kind]);await recover(operation);
    if(kind==='cancel'){if(operation.status==='applying')fail('OPERATION_BUSY');if(operation.status==='review'){operation.status='cancelled';persist();}}
    return receipt(operation);
   }
   if(!Object.hasOwn(mutations,kind))fail('UNKNOWN_OPERATION');admit(args.repoId,mutations[kind]);
   if(kind==='write.plan'&&(typeof args.text!=='string'||Buffer.byteLength(args.text)>limits.textBytes))fail('LIMIT_EXCEEDED');
   if((kind==='import.plan'||kind==='package.plan')&&!archive(args.archiveBase64))fail('LIMIT_EXCEEDED');
   const digest=hash({kind,args}),previous=state.operations.find(item=>item.requestId===input.requestId);
   if(previous){if(previous.digest!==digest)fail('REQUEST_CONFLICT');await recover(previous);return receipt(previous);}
   // Interrupted effects keep their completion reservation until status or
   // explicit package recovery resolves them. Do not consume it with new work.
   if(state.operations.some(item=>item.status==='applying'))fail('OPERATION_BUSY','Resolve the interrupted operation before requesting another change.');
   if(state.operations.length>=limits.operations){const retire=state.operations.findIndex(item=>['completed','cancelled','failed'].includes(item.status));if(retire<0)fail('LIMIT_EXCEEDED');/* IDs remain bound until explicit reset; no silent idempotency expiration. */fail('OPERATION_HISTORY_FULL','The operation history is full. Use the app directly until this limit is expanded.');}
   const operationId=randomUUID(),plan=await prepare(kind,args,operationId),operation={operationId,requestId:input.requestId,kind,args:structuredClone(args),repoId:args.repoId,digest,reviewDigest:hash(plan),plan,status:'review',createdAt:Date.now()};
   const proposed={...state,operations:[...state.operations,operation]};if(Buffer.byteLength(JSON.stringify(proposed))>limits.journalBytes)fail('LIMIT_EXCEEDED');try{validateAutomationState(proposed);}catch{fail('INVALID_REQUEST');}state.operations.push(operation);persist();return receipt(operation);
  });},
  approve(input){return queue(async()=>{
   if(!exact(input,['operationId','digest']))fail('INVALID_REQUEST');const operation=find(input.operationId);admit(operation.repoId,mutations[operation.kind]);if(operation.digest!==input.digest)fail('STALE_PLAN');
   await recover(operation);if(operation.status==='completed')return receipt(operation);if(operation.status!=='review')fail('OPERATION_NOT_REVIEWABLE');
   if(state.operations.some(item=>item!==operation&&item.status==='applying'))fail('OPERATION_BUSY','Resolve the interrupted operation before approving another change.');
   const current=await prepare(operation.kind,operation.args,operation.operationId);if(hash(current)!==operation.reviewDigest)fail('STALE_PLAN','The saved files or drafts changed. Cancel this request and prepare a new review.');
   // Reserve the largest admitted completed result before invoking an effect.
   // This is the exact prospective JSON shape, replacing only its null result.
   const completed={...operation,status:'completed',result:null};delete completed.error;
   const reservation={...state,operations:state.operations.map(item=>item===operation?completed:item)};
   // Other already-reviewed requests may still be cancelled while an effect is
   // pending; each status can grow from review to cancelled by three bytes.
   const cancellationHeadroom=limits.operations*3;
   if(Buffer.byteLength(JSON.stringify(reservation))-4+automationResultLimit(operation.kind)+cancellationHeadroom>limits.journalBytes)fail('OPERATION_HISTORY_FULL','There is not enough retained operation space for this result. Use the app directly.');
   operation.status='applying';persist();
   let result;
   try{result=await apply(operation.kind,operation.args,operation.operationId,current);}catch(error){operation.error=publicFailure(error);if(operation.kind==='export.plan')operation.status='failed';persist();throw error;}
   // A completion durability failure must retain the prior applying receipt;
   // never replace an uncertain successful effect with a fabricated failure.
   const candidate={...operation,result,status:'completed'};delete candidate.error;
   try{if(Buffer.byteLength(JSON.stringify(result))>automationResultLimit(operation.kind))fail('LIMIT_EXCEEDED');validateAutomationState({...state,operations:state.operations.map(item=>item===operation?candidate:item)});}catch(error){
    if(operation.kind==='export.plan'){operation.status='failed';operation.error={code:error.code??'INVALID_RESPONSE',message:'The export result exceeds its limit or could not be verified. Use the app export controls.'};persist();}throw error;
   }
   Object.assign(operation,candidate);delete operation.error;persist();return receipt(operation);
  });},
  cancel(input){return queue(()=>{if(!exact(input,['operationId']))fail('INVALID_REQUEST');const operation=find(input.operationId);if(operation.status==='applying')fail('OPERATION_BUSY');if(operation.status==='review'){operation.status='cancelled';persist();}return receipt(operation,false);});},
  async close(){closed=true;enabled=false;grants=[];await serial;enabled=false;grants=[];},
  async drain(){await serial;},
 });
}
