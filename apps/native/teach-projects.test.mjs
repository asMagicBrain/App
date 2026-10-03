import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeachProjects,validateProjectPolicy,projectStarter} from './teach-projects.mjs';

function fixture(){
 let saved=null,interrupt=false,calls=0;
 const repositories=[],byRequest=new Map();
 const ctx={courseId:'00000000-0000-4000-8000-000000000001',code:'ROB7103_8103',migrated:true,terms:['2026-autumn'],repositories};
 const store={scan:()=>({events:saved?[{payload:structuredClone(saved)}]:[],tailRecords:0,coveredFiles:[]}),ensureDurable:v=>v,append:(_s,_k,v)=>{saved=structuredClone(v);}};
 const create=()=>createTeachProjects({store,snapshot:async()=>structuredClone(ctx),createLocal:async(team,files)=>{
  calls++;
  let binding=byRequest.get(team.requestId);
  if(!binding){binding={stableId:String(byRequest.size+1).padStart(64,'0'),name:team.localName};byRequest.set(team.requestId,binding);repositories.push(binding);assert.equal(files.filter(f=>f.path.startsWith('worksheets/')).length,6);}
  if(interrupt){interrupt=false;throw Error('interrupted after creation');}
  return binding;
 }});
 return {manager:create(),create,ctx,repositories,get calls(){return calls;},get saved(){return saved;},corrupt(change){change(saved);},interrupt(){interrupt=true;}};
}
const input={repo:'Course',year:2026,season:'autumn',count:8};
test('eight sibling identities survive restart and rename; repeat creation is a no-op',async()=>{
 const f=fixture(),p=await f.manager.reviewCreate(input);
 assert.equal(f.calls,0);assert.equal(p.teams.length,8);
 await f.manager.applyCreate(p.planId);
 const before=(await f.manager.settings('Course')).projects;
 assert.equal(new Set(before.map(p=>p.bindingId)).size,8);
 f.repositories[0].name='Renamed team';f.manager=f.create();
 const after=(await f.manager.settings('Course')).projects;
 assert.equal(after[0].name,'Renamed team');assert.equal(after[0].id,before[0].id);
 assert.equal((await f.manager.reviewCreate(input)).planId,null);assert.equal(f.calls,8);
});
test('interrupted creation recovers with the same request identity',async()=>{
 const f=fixture(),p=await f.manager.reviewCreate(input);f.interrupt();
 await assert.rejects(f.manager.applyCreate(p.planId));assert.equal(f.repositories.length,1);
 f.manager=f.create();await f.manager.recover('Course');
 assert.equal(f.repositories.length,8);assert.equal((await f.manager.settings('Course')).projects.length,8);assert.equal(f.saved.pending,null);
});
test('stale review cannot create repositories and policy edits require current revision',async()=>{
 const f=fixture(),p=await f.manager.reviewCreate(input);f.ctx.code='Changed';
 await assert.rejects(f.manager.applyCreate(p.planId),{code:'CONFLICT'});assert.equal(f.calls,0);
 await f.manager.applyCreate((await f.manager.reviewCreate(input)).planId);
 const team=(await f.manager.settings('Course')).projects[0];
 await f.manager.policy({repo:'Course',projectId:team.id,revision:1,policy:{members:['as-wanfang'],milestones:[{id:'final',deadline:null}]}});
 await assert.rejects(f.manager.policy({repo:'Course',projectId:team.id,revision:1,policy:{members:[],milestones:[]}}),{code:'CONFLICT'});
 assert.equal(f.calls,8);
});
test('starter is inert and policy rejects ambiguous members and invalid dates',()=>{
 assert.throws(()=>validateProjectPolicy({members:['WanF','wanf'],milestones:[]}),{code:'INVALID_REQUEST'});
 assert.throws(()=>validateProjectPolicy({members:[],milestones:[{id:'final',deadline:'2026-02-30T00:00:00Z'}]}),{code:'INVALID_REQUEST'});
 const files=projectStarter({code:'ROB',label:'Team01',term:'2026-autumn'});
 assert.equal(JSON.parse(files.find(f=>f.path==='submission.json').bytes).files.length,0);
 assert.match(files.find(f=>f.path==='SUBMISSION.md').bytes.toString(),/A push is not a submission/);
});
test('duplicate stored repository bindings fail closed instead of aliasing team data',async()=>{
 const f=fixture();await f.manager.applyCreate((await f.manager.reviewCreate(input)).planId);
 f.corrupt(state=>{state.projects[1].bindingId=state.projects[0].bindingId;});
 assert.throws(()=>f.manager.get(f.saved.projects[0].id),{code:'RECOVERY_REQUIRED'});
});
test('adoption binds a cloned sibling without generating or replacing files',async()=>{
 const f=fixture();f.repositories.push({stableId:'f'.repeat(64),name:'ExistingClone'});
 const input={repo:'Course',year:2026,season:'autumn',label:'Team08',repositoryId:'f'.repeat(64)};
 const review=await f.manager.reviewBinding(input);assert.equal(review.name,'ExistingClone');
 await assert.rejects(f.manager.applyCreate(review.planId),{code:'STALE_PLAN'});assert.equal(f.saved,null);
 await f.manager.applyBinding((await f.manager.reviewBinding(input)).planId);
 assert.equal(f.calls,0);assert.equal((await f.manager.settings('Course')).projects[0].name,'ExistingClone');
 await assert.rejects(f.manager.reviewBinding({...input,label:'Team07'}),{code:'TEACH_GRAPH_BINDING'});
 f.manager=f.create();assert.equal((await f.manager.settings('Course')).projects[0].bindingId,'f'.repeat(64));
});
