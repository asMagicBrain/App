import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createTeachSubmissions} from './teach-submissions.mjs';
import {readGitHubSubmission,validateSubmissionManifest} from './teach-submission-provider.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const blob=b=>createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const projectId='00000000-0000-4000-8000-000000000001';
function fixture(){
 let saved=null,sequence=1,commit='a'.repeat(40),observedAt='2026-10-04T10:00:00.000Z',archiveFail=false,visibility='private',account=7;
 const archives=new Map(),project={id:projectId,courseId:'00000000-0000-4000-8000-000000000002',term:'2026-autumn',label:'Team01',policy:{members:['student'],milestones:[{id:'final',deadline:'2026-10-04T09:00:00Z'}]}};
 const bytes=Buffer.from('inert code'),manifest={schemaVersion:1,milestone:'final',files:[{path:'code/main.py',size:bytes.length,sha256:hash(bytes)}],artifacts:[]};
 const remote={id:10,owner:'owner',name:'project',visibility,permissions:{read:true}};
 const provider={session:async()=>({account:{id:account,login:'teacher'},inspect:async()=>({...remote,visibility}),submission:async()=>({tag:`asmb-submit/final/${sequence}`,releaseId:100+sequence,commit,submitter:{id:20,login:'student'},publishedAt:'2026-10-04T08:00:00Z',observedAt,manifestHash:hash(JSON.stringify(manifest)),manifest,files:[{path:'tracked/code/main.py',bytes}]})})};
 const store={scan:()=>({events:saved?[{payload:structuredClone(saved)}]:[],tailRecords:0,coveredFiles:[]}),ensureDurable:s=>s,append:(_s,_k,v)=>{saved=structuredClone(v);}};
 const create=()=>createTeachSubmissions({store,provider,context:async()=>({project:structuredClone(project),remote}),archive:async(key,zip)=>{if(archiveFail)throw Error('disk full');archives.set(key,zip);},openArchive:async key=>archives.get(key)});
 return {manager:create(),create,project,archives,set commit(v){commit=v;},set sequence(v){sequence=v;},set archiveFail(v){archiveFail=v;},set visibility(v){visibility=v;},set account(v){account=v;}};
}
const input={repo:'Course',projectId,milestone:'final',sequence:1};
test('receipt archives verified bytes and survives later commits, restart and deadline edits',async()=>{
 const f=fixture(),review=await f.manager.review(input);assert.equal(f.archives.size,0);
 const {receipt}=await f.manager.apply(review.planId);assert.equal(receipt.deadlineStatus,'late');assert.equal(receipt.publishedAt,'2026-10-04T08:00:00Z');assert.equal(f.archives.size,1);
 f.commit='b'.repeat(40);f.project.policy.milestones[0].deadline=null;f.manager=f.create();
 assert.equal(f.manager.status(projectId).receipts[0].commit,'a'.repeat(40));assert.equal(f.manager.status(projectId).receipts[0].deadlineStatus,'late');
 await assert.rejects(f.manager.review(input),{code:'SUBMISSION_TAG_REUSED'});
 assert.ok((await f.manager.open({...input,receiptId:receipt.id})).length>0);
 f.sequence=2;const next=await f.manager.review({...input,sequence:2});await f.manager.apply(next.planId);assert.equal(f.manager.status(projectId).receipts.length,2);
});
test('changed content/account and failed snapshot never record completion',async()=>{
 const f=fixture();let review=await f.manager.review(input);f.commit='b'.repeat(40);await assert.rejects(f.manager.apply(review.planId),{code:'SUBMISSION_CHANGED'});
 review=await f.manager.review(input);f.account=8;await assert.rejects(f.manager.apply(review.planId),{code:'SUBMISSION_CHANGED'});
 review=await f.manager.review(input);f.archiveFail=true;await assert.rejects(f.manager.apply(review.planId));assert.equal(f.manager.status(projectId).receipts.length,0);
 f.visibility='public';await assert.rejects(f.manager.review(input),{code:'SUBMISSION_ACCESS'});
});
test('pause invalidates consent and unknown milestone does not count as submission',async()=>{
 const f=fixture(),p=await f.manager.review(input);f.manager.pause();await assert.rejects(f.manager.apply(p.planId),{code:'GITHUB_BUSY'});f.manager.resume();await assert.rejects(f.manager.apply(p.planId),{code:'STALE_PLAN'});await assert.rejects(f.manager.review({...input,milestone:'invented'}),{code:'SUBMISSION_MILESTONE'});
});
test('manifest refuses absolute paths, duplicate paths, undeclared formats and oversize assets',()=>{
 const valid={schemaVersion:1,milestone:'final',files:[{path:'code/main.py',sha256:'a'.repeat(64),size:1}],artifacts:[]};
 assert.equal(validateSubmissionManifest(valid,'final'),valid);
 for(const path of ['../secret','/secret','.git/config'])assert.throws(()=>validateSubmissionManifest({...valid,files:[{...valid.files[0],path}]},'final'),{code:'SUBMISSION_MANIFEST'});
 assert.throws(()=>validateSubmissionManifest({...valid,files:[valid.files[0],valid.files[0]]},'final'),{code:'SUBMISSION_MANIFEST'});
});
test('fixed provider resolves annotated tags, verifies regular tracked bytes and rejects moved tags',async()=>{
 const bytes=Buffer.from('example'),manifestBytes=Buffer.from(JSON.stringify({schemaVersion:1,milestone:'final',files:[{path:'README.md',size:bytes.length,sha256:hash(bytes)}],artifacts:[]}));let moved=false,refCalls=0;
 const release={id:5,draft:false,tag_name:'asmb-submit/final/1',published_at:'2026-10-04T08:00:00Z',author:{id:1,login:'student'},assets:[]};
 const request=async route=>{let data;if(route.includes('/releases/tags/'))data=release;else if(route.includes('/git/ref/')){refCalls++;data={object:{type:'tag',sha:moved&&refCalls%2===0?'d'.repeat(40):'a'.repeat(40)}};}else if(route.includes('/git/tags/'))data={object:{type:'commit',sha:'b'.repeat(40)}};else if(route.includes('/git/commits/'))data={tree:{sha:'c'.repeat(40)}};else data={truncated:false,tree:[{path:'submission.json',type:'blob',mode:'100644',sha:blob(manifestBytes)},{path:'README.md',type:'blob',mode:'100644',sha:blob(bytes)}]};return {data,serverDate:'Sun, 04 Oct 2026 10:00:00 GMT'};};
 const args={request,binary:async route=>route.includes('submission.json')?manifestBytes:bytes,owner:'owner',repository:'project',milestone:'final',sequence:1};
 assert.equal((await readGitHubSubmission(args)).commit,'b'.repeat(40));moved=true;await assert.rejects(readGitHubSubmission(args),{code:'SUBMISSION_CHANGED'});
});
