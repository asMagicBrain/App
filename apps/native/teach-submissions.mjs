import {randomUUID,createHash} from 'node:crypto';
import {createPackageZip} from '../../packages/desktop-host/src/package-exchange/archive.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const hash=v=>createHash('sha256').update(v).digest('hex');
const fingerprint=v=>hash(JSON.stringify(v));
const uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/.test(v);
const contentIdentity=s=>({releaseId:s.releaseId,tag:s.tag,commit:s.commit,submitter:s.submitter,publishedAt:s.publishedAt,manifestHash:s.manifestHash,manifest:s.manifest});
export function createTeachSubmissions({store,provider,context,archive,openArchive}){
 const plans=new Map();let paused=false;
 function load(){const scan=store.ensureDurable(store.scan());if(scan.blocked)fail('RECOVERY_REQUIRED');const state=scan.events.at(-1)?.payload??{schemaVersion:1,receipts:[],checks:{}};if(state.schemaVersion!==1||!Array.isArray(state.receipts)||state.receipts.length>128||!state.checks||typeof state.checks!=='object'||new Set(state.receipts.map(r=>r?.id)).size!==state.receipts.length||state.receipts.some(r=>!uuid(r?.id)||!uuid(r.projectId)||! /^[0-9a-f]{64}$/.test(r.snapshotHash)||! /^[0-9a-f]{40}$/.test(r.commit)||!Number.isFinite(Date.parse(r.observedAt))))fail('RECOVERY_REQUIRED');return {scan,state};}
 function write(state){let {scan,state:prior}=load();if(scan.tailRecords>=24||scan.coveredFiles.length)scan=store.compact(scan,prior);store.append(scan,'draft',state);}
 async function read(input){if(paused)fail('GITHUB_BUSY');const ctx=await context(input.repo,input.projectId);const milestone=ctx.project.policy.milestones.find(m=>m.id===input.milestone);if(!milestone)fail('SUBMISSION_MILESTONE');const session=await provider.session(),remote=await session.inspect(ctx.remote.owner,ctx.remote.name);if(!remote||remote.id!==ctx.remote.id||remote.visibility!=='private'||remote.archived||!remote.permissions.read)fail('SUBMISSION_ACCESS');const submission=await session.submission({owner:remote.owner,repository:remote.name,milestone:input.milestone,sequence:input.sequence});const after=await session.inspect(remote.owner,remote.name);if(!after||after.id!==remote.id||after.visibility!=='private'||!after.permissions.read)fail('SUBMISSION_ACCESS');return {ctx,milestone,account:session.account,submission};}
 return {
  pause(){paused=true;plans.clear();},resume(){paused=false;},
  status(projectId){const {state}=load();return structuredClone({receipts:state.receipts.filter(r=>r.projectId===projectId),checks:Object.entries(state.checks).filter(([k])=>k.startsWith(projectId+':')).map(([,v])=>v)});},
  async review(input){let value;try{value=await read(input);}catch(error){if(['SUBMISSION_MISSING','SUBMISSION_ACCESS','GITHUB_PERMISSION_REQUIRED','SUBMISSION_HASH_MISMATCH','SUBMISSION_MANIFEST','SUBMISSION_ARTIFACT'].includes(error.code)){const {state}=load();if(Object.keys(state.checks).length>=256&&!state.checks[`${input.projectId}:${input.milestone}`])fail('SUBMISSION_LIMIT');write({...state,checks:{...state.checks,[`${input.projectId}:${input.milestone}`]:{milestone:input.milestone,sequence:input.sequence,status:error.code,checkedAt:Date.now()}}});}throw error;}
   const {ctx,milestone,account,submission}=value,{state}=load();const old=state.receipts.find(r=>r.projectId===input.projectId&&r.tag===submission.tag);
   if(old){if(old.commit!==submission.commit||old.manifestHash!==submission.manifestHash||old.releaseId!==submission.releaseId)fail('SUBMISSION_TAG_REUSED');return {planId:null,receipt:old,status:'Already receipted; the retained snapshot is unchanged.'};}
   if(state.receipts.length>=128)fail('SUBMISSION_LIMIT');for(const [id,p] of plans)if(p.expires<Date.now())plans.delete(id);if(plans.size>=4)fail('BUSY');const planId=randomUUID();
   // Do not retain large downloaded buffers while the teacher reviews.
   plans.set(planId,{input:structuredClone(input),ctxHash:fingerprint(ctx),contentHash:fingerprint(contentIdentity(submission)),accountId:account.id,expires:Date.now()+300000});
   return {planId,team:ctx.project.label,tag:submission.tag,commit:submission.commit,submitter:submission.submitter,publishedAt:submission.publishedAt,observedAt:submission.observedAt,deadline:milestone.deadline,manifestHash:submission.manifestHash,files:submission.manifest.files,artifacts:submission.manifest.artifacts,warnings:['GitHub tags and release publication dates do not prove when the current content was first submitted. Deadline status uses this server-observed verification time.','All declared bytes are archived privately; reproducibility still requires a separate code review or controlled execution.']};
  },
  async apply(planId){if(paused)fail('GITHUB_BUSY');const p=plans.get(planId);plans.delete(planId);if(!p||p.expires<Date.now())fail('STALE_PLAN');const value=await read(p.input),{ctx,milestone,account,submission}=value;if(account.id!==p.accountId||fingerprint(ctx)!==p.ctxHash||fingerprint(contentIdentity(submission))!==p.contentHash)fail('SUBMISSION_CHANGED');const {state}=load();if(state.receipts.some(r=>r.projectId===p.input.projectId&&r.tag===submission.tag))fail('CONFLICT');
   const receipt={schemaVersion:1,id:randomUUID(),courseId:ctx.project.courseId,projectId:ctx.project.id,team:ctx.project.label,term:ctx.project.term,milestone:p.input.milestone,sequence:p.input.sequence,remoteId:ctx.remote.id,...contentIdentity(submission),observedAt:submission.observedAt,verifier:account,deadline:milestone.deadline,deadlineStatus:milestone.deadline===null?'no-deadline':Date.parse(submission.observedAt)>Date.parse(milestone.deadline)?'late':'on-time',validation:'bytes-verified; code-not-executed'};
   const zip=createPackageZip([...submission.files,{path:'receipt.json',bytes:Buffer.from(JSON.stringify(receipt,null,2)+'\n')}]),snapshotHash=hash(zip);await archive(snapshotHash,zip);
   // Archive is fsynced before the immutable receipt is journaled. A failed append leaves only an unreferenced archive.
   const saved={...receipt,snapshotHash};write({...state,receipts:[...state.receipts,saved],checks:{...state.checks,[`${saved.projectId}:${saved.milestone}`]:{milestone:saved.milestone,sequence:saved.sequence,status:'receipted',observedAt:saved.observedAt}}});return {receipt:saved};
  },
  cancel(planId){plans.delete(planId);return {cancelled:true};},
  async open({repo,projectId,receiptId}){const ctx=await context(repo,projectId),receipt=load().state.receipts.find(r=>r.id===receiptId&&r.projectId===ctx.project.id);if(!receipt)fail('NOT_FOUND');return openArchive(receipt.snapshotHash);}
 };
}
