import {createHash,randomUUID} from 'node:crypto';
const fail=code=>{throw Object.assign(Error(code),{code});};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const roles=['instructors','assistants','students'];
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export function validateRepositoryGraph(value){
 if(!exact(value,['schemaVersion','courseId','revision','bindings'])||value.schemaVersion!==1||!Number.isSafeInteger(value.revision)||value.revision<1||typeof value.courseId!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.courseId)||!exact(value.bindings,roles))fail('TEACH_GRAPH_INVALID');
 const ids=roles.map(role=>value.bindings[role]);
 if(ids.some((id,i)=>id!==null&&(typeof id!=='string'||!/^[0-9a-f]{64}$/.test(id))||i!==1&&id===null)||new Set(ids.filter(Boolean)).size!==ids.filter(Boolean).length)fail('TEACH_GRAPH_INVALID');
 return structuredClone(value);
}
// Host-private identities only. Course content, credentials and rosters are not copied here.
export function createTeachRepositoryGraph({store,snapshot}){
 const plans=new Map();
 function load(){const scan=store.ensureDurable(store.scan());if(scan.blocked)fail('RECOVERY_REQUIRED');const state=scan.events.at(-1)?.payload??{schemaVersion:1,courses:{}};if(!exact(state,['schemaVersion','courses'])||state.schemaVersion!==1||!state.courses||typeof state.courses!=='object'||Array.isArray(state.courses))fail('RECOVERY_REQUIRED');for(const [id,graph] of Object.entries(state.courses))if(validateRepositoryGraph(graph).courseId!==id)fail('RECOVERY_REQUIRED');return {scan,state};}
 function write(courseId,graph){let {scan,state}=load();if(scan.tailRecords>=24||scan.coveredFiles.length)scan=store.compact(scan,state);store.append(scan,'draft',{schemaVersion:1,courses:{...state.courses,[courseId]:graph}});}
 function graphFor(ctx){return load().state.courses[ctx.courseId]??null;}
 function display(ctx,graph){return {schemaVersion:1,courseId:ctx.courseId,revision:graph?.revision??0,migrated:Boolean(graph),terms:ctx.terms,roles:roles.map(role=>{const id=graph?.bindings[role]??(role==='instructors'?ctx.instructorId:role==='students'?ctx.studentId:null),entry=ctx.repositories.find(e=>e.stableId===id);return {role,repositoryId:id,name:entry?.name??null,available:Boolean(entry),intendedVisibility:role==='students'?'public':'private',observedVisibility:null,accessStatus:'not-verified',sourceUrl:entry?.sourceUrl??null,branch:entry?.branch??null};}),repositories:ctx.repositories.filter(e=>!ctx.reservedIds.includes(e.stableId)||Object.values(graph?.bindings??{}).includes(e.stableId)),warnings:['Visibility and access have not been verified with GitHub.']};}
 return {
  get(courseId){return structuredClone(load().state.courses[courseId]??null);},
  async settings(repo){const ctx=await snapshot(repo);return display(ctx,graphFor(ctx));},
  async review(repo,assistantId){const ctx=await snapshot(repo),prior=graphFor(ctx);if(assistantId!==null&&(!/^[0-9a-f]{64}$/.test(assistantId)||!ctx.repositories.some(e=>e.stableId===assistantId)))fail('TEACH_GRAPH_BINDING');
   const next=validateRepositoryGraph({schemaVersion:1,courseId:ctx.courseId,revision:(prior?.revision??0)+1,bindings:{instructors:ctx.instructorId,students:ctx.studentId,assistants:assistantId}});
   for(const id of Object.values(next.bindings).filter(Boolean))if(ctx.reservedIds.includes(id)&&!Object.values(prior?.bindings??{}).includes(id)&&id!==ctx.instructorId&&id!==ctx.studentId)fail('TEACH_GRAPH_BINDING');
   for(const graph of Object.values(load().state.courses))if(graph.courseId!==ctx.courseId&&Object.values(graph.bindings).some(id=>id&&Object.values(next.bindings).includes(id)))fail('TEACH_GRAPH_BINDING');
   for(const [id,plan] of plans)if(plan.expiresAt<Date.now())plans.delete(id);if(plans.size>=8)fail('BUSY');const planId=randomUUID();plans.set(planId,{repo,next,fingerprint:digest({ctx,prior}),expiresAt:Date.now()+300000});
   return {planId,before:display(ctx,prior),after:display(ctx,next),changes:roles.filter(r=>next.bindings[r]!==prior?.bindings[r]),preserves:['Repository files and Git history','Drafts, calendars and deadlines','Existing repository names and course identity']};
  },
  async apply(planId){const plan=plans.get(planId);plans.delete(planId);if(!plan||plan.expiresAt<Date.now())fail('STALE_PLAN');const ctx=await snapshot(plan.repo),prior=graphFor(ctx);if(digest({ctx,prior})!==plan.fingerprint)fail('CONFLICT');write(ctx.courseId,plan.next);return display(ctx,plan.next);},
  cancel(planId){plans.delete(planId);return {cancelled:true};}
 };
}
