import {createHash,randomUUID} from 'node:crypto';
import {isPortableRelativePath,portablePathKey} from '../../packages/source-foundation/src/domain/path-policy.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const modes=['legacy-preparation','direct-students'];
function validateRecord(v){
 if(!exact(v,['schemaVersion','courseId','revision','mode','homes'])||v.schemaVersion!==1||!uuid(v.courseId)||!Number.isSafeInteger(v.revision)||v.revision<1||!modes.includes(v.mode)||!v.homes||typeof v.homes!=='object'||Array.isArray(v.homes)||Object.keys(v.homes).length>256)fail('TEACH_WORKFLOW_INVALID');
 const keys=new Set();for(const [term,home] of Object.entries(v.homes)){if(!/^\d{4}-(spring|summer|autumn|winter)$/.test(term)||typeof home!=='string'||!isPortableRelativePath(home)||!home.startsWith(term+'/')||!home.toLowerCase().endsWith('.md')||home.split('/').some(p=>p.startsWith('.'))||keys.has(portablePathKey(home)))fail('TEACH_WORKFLOW_INVALID');keys.add(portablePathKey(home));}
 return {...structuredClone(v),homes:Object.fromEntries(Object.entries(v.homes).sort(([a],[b])=>a.localeCompare(b)))};
}
// Migration adopts already-authored Students bytes. No repository file, Git
// directory, ACL, receipt, calendar or draft is moved, copied or overwritten.
// Missing/ambiguous homes must be reconciled in Students before review.
export function createTeachWorkflow({store,snapshot,at=()=>{}}){
 const plans=new Map();
 function load(){const scan=store.ensureDurable(store.scan());if(scan.blocked)fail('RECOVERY_REQUIRED');const state=scan.events.at(-1)?.payload??{schemaVersion:1,courses:{},pending:null,last:{},creating:{}};
  if(!exact(state,['schemaVersion','courses','pending','last','creating'])||state.schemaVersion!==1||!state.courses||Array.isArray(state.courses)||typeof state.courses!=='object'||!state.last||Array.isArray(state.last)||typeof state.last!=='object'||!state.creating||Array.isArray(state.creating)||typeof state.creating!=='object'||[state.courses,state.last,state.creating].some(v=>Object.keys(v).length>1024))fail('RECOVERY_REQUIRED');
  for(const [id,v] of Object.entries(state.courses))if(validateRecord(v).courseId!==id)fail('RECOVERY_REQUIRED');
  for(const [id,v] of Object.entries(state.last))validateTransaction(v,id);
  if(state.pending)validateTransaction(state.pending,state.pending.courseId);
  for(const [id,hash] of Object.entries(state.creating))if(!uuid(id)||typeof hash!=='string'||! /^[0-9a-f]{64}$/.test(hash))fail('RECOVERY_REQUIRED');
  return {scan,state};
 }
 function validateTransaction(v,id){if(!exact(v,['id','courseId','before','after','fingerprint','phase'])||!uuid(v.id)||!uuid(id)||v.courseId!==id||validateRecord(v.after).courseId!==id||v.before!==null&&validateRecord(v.before).courseId!==id||! /^[0-9a-f]{64}$/.test(v.fingerprint)||!['prepared','activated','complete'].includes(v.phase))fail('RECOVERY_REQUIRED');}
 function write(state){let {scan,state:prior}=load();if(scan.tailRecords>=24||scan.coveredFiles.length)scan=store.compact(scan,prior);store.append(scan,'draft',state);}
 function current(id){return structuredClone(load().state.courses[id]??null);}
 function ready(ctx,homes){
  if(!ctx.bound||!ctx.roles.find(r=>r.role==='students')?.available)fail('TEACH_GRAPH_REQUIRED');
  if(ctx.drafts.length)fail('DRAFT_CONFLICT');
  if(ctx.blocked)fail('RECOVERY_REQUIRED');
  if(Object.keys(homes).length!==ctx.terms.length||ctx.terms.some(t=>!Object.hasOwn(homes,t)))fail('TEACH_HOME_SELECTION_REQUIRED');
  for(const [term,home] of Object.entries(homes)){const candidates=ctx.studentCandidates[term]??[];if(!candidates.includes(home))fail('TEACH_STUDENT_PAGE_MISSING');}
 }
 async function descriptor(repo,term){const ctx=await snapshot(repo,{inventory:false}),value=current(ctx.courseId);if(term!==undefined&&!ctx.terms.includes(term))fail('INVALID_TERM');
  return {schemaVersion:1,courseId:ctx.courseId,term:term??ctx.terms.at(-1),terms:ctx.terms,workflow:value??{schemaVersion:1,courseId:ctx.courseId,revision:0,mode:'legacy-preparation',homes:{}},roles:ctx.roles.map(r=>({...r,homePath:r.role==='students'?value?.homes[term??ctx.terms.at(-1)]??null:ctx.roleHomes[r.role]?.[term??ctx.terms.at(-1)]??null})),projects:ctx.projects.filter(p=>p.term===(term??ctx.terms.at(-1))),pending:load().state.pending?.courseId===ctx.courseId?{id:load().state.pending.id,phase:load().state.pending.phase}:null};
 }
 async function inventory(repo){const ctx=await snapshot(repo);return {schemaVersion:1,courseId:ctx.courseId,terms:ctx.terms,workflow:current(ctx.courseId),roles:ctx.roles,studentCandidates:ctx.studentCandidates,legacyCandidates:ctx.legacyCandidates,files:ctx.files,drafts:ctx.drafts,blocked:ctx.blocked,unchanged:['Saved bytes and relative links','Repository identities and Git history','Calendar, policy and submission receipts']};}
 async function review(repo,homes){const ctx=await snapshot(repo),prior=current(ctx.courseId);homes=validateRecord({schemaVersion:1,courseId:ctx.courseId,revision:1,mode:'direct-students',homes}).homes;ready(ctx,homes);
  if(load().state.pending)fail('TEACH_WORKFLOW_RECOVERY_REQUIRED');
  if(prior?.mode==='direct-students'&&sha(prior.homes)===sha(homes))return {planId:null,alreadyApplied:true};
  for(const [id,p] of plans)if(p.expires<Date.now())plans.delete(id);if(plans.size>=8)fail('BUSY');
  const planId=randomUUID(),next=validateRecord({schemaVersion:1,courseId:ctx.courseId,revision:(prior?.revision??0)+1,mode:'direct-students',homes});plans.set(planId,{repo,prior,next,fingerprint:sha(ctx),expires:Date.now()+300000});
  return {planId,before:prior,after:next,files:ctx.files.filter(f=>f.role==='students'),changes:['Use Students as the authoritative course content'],preserves:['All repository files, drafts, bindings, remotes, calendars and receipts'],localOnly:true};
 }
 async function complete(repo){const {state}=load(),p=state.pending;if(!p)fail('TEACH_WORKFLOW_RECOVERY_REQUIRED');const ctx=await snapshot(repo);if(ctx.courseId!==p.courseId||sha(ctx)!==p.fingerprint)fail('CONFLICT');ready(ctx,p.after.homes);
  const live=state.courses[p.courseId]??null;if(sha(live)!==sha(p.phase==='prepared'?p.before:p.after))fail('CONFLICT');
  if(p.phase==='prepared'){write({...state,courses:{...state.courses,[p.courseId]:p.after},pending:{...p,phase:'activated'}});await at('workflow-activated');}
  const next=load().state;if(sha(await snapshot(repo))!==p.fingerprint)fail('CONFLICT');write({...next,pending:null,last:{...next.last,[p.courseId]:{...p,phase:'complete'}}});await at('workflow-complete');return descriptor(repo);
 }
 return {
  get:current,descriptor,inventory,review,
  creation(id){return load().state.creating[id]??null;},
  startCreation(id,fingerprint){if(!uuid(id)||typeof fingerprint!=='string'||! /^[0-9a-f]{64}$/.test(fingerprint))fail('INVALID_REQUEST');const {state}=load(),prior=state.creating[id];if(prior&&prior!==fingerprint)fail('REQUEST_CONFLICT');if(!prior)write({...state,creating:{...state.creating,[id]:fingerprint}});},
  async initialize(repo,homes){const existing=current((await snapshot(repo,{inventory:false})).courseId);if(existing)return descriptor(repo);const plan=await review(repo,homes);return this.apply(plan.planId);},
  async apply(planId){const p=plans.get(planId);plans.delete(planId);if(!p||p.expires<Date.now())fail('STALE_PLAN');const ctx=await snapshot(p.repo),{state}=load();if(state.pending)fail('TEACH_WORKFLOW_RECOVERY_REQUIRED');if(sha(ctx)!==p.fingerprint||sha(current(ctx.courseId))!==sha(p.prior))fail('CONFLICT');ready(ctx,p.next.homes);
   write({...state,pending:{id:randomUUID(),courseId:ctx.courseId,before:p.prior,after:p.next,fingerprint:p.fingerprint,phase:'prepared'}});await at('workflow-prepared');return complete(p.repo);
  },
  cancel(planId){plans.delete(planId);return {cancelled:true};},
  async recover(repo,direction){if(direction==='resume')return complete(repo);if(direction!=='rollback')fail('INVALID_REQUEST');const {state}=load(),ctx=await snapshot(repo),p=state.pending??state.last[ctx.courseId];if(!p||p.courseId!==ctx.courseId)fail('TEACH_WORKFLOW_RECOVERY_REQUIRED');if(sha(ctx)!==p.fingerprint||ctx.drafts.length)fail('CONFLICT');const live=state.courses[p.courseId]??null;if(sha(live)!==sha(p.phase==='prepared'?p.before:p.after))fail('CONFLICT');const courses={...state.courses},last={...state.last};if(p.before)courses[p.courseId]=p.before;else delete courses[p.courseId];delete last[p.courseId];write({...state,courses,pending:null,last});return descriptor(repo);},
 };
}
