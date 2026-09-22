import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {testRoot} from '../../tools/development-paths.mjs';
import path from 'node:path';
import {createNativeService} from './host-service.mjs';
import {createPackageZip,parsePackage} from '../../packages/desktop-host/src/package-exchange/archive.mjs';
import {readZipFiles} from '../../packages/desktop-host/src/zip-import/index.mjs';
const runRoot=path.join(testRoot,'runs/stage4-shared-services-20260922/exchange/native');fs.mkdirSync(runRoot,{recursive:true,mode:0o700});
const zip=files=>createPackageZip(Object.entries(files).map(([path,bytes])=>({path,bytes:Buffer.from(bytes)})));
const base=zip({'current.md':'# Current\nBase\n','notes.md':'# Notes\nBase\n','old.md':'Old\n'}),incoming=zip({'current.md':'# Current\nIncoming\n','notes.md':'# Notes\nIncoming\n','new.md':'New\n'});
async function fixture(t,hooks={}){const root=fs.mkdtempSync(path.join(runRoot,'native-exchange-')),dataRoot=path.join(root,'profile');let service=await createNativeService({dataRoot,hooks});t.after(async()=>{await service.close();});await service.importArchive({name:'Engineering',bytes:base});return {root,dataRoot,source:path.join(dataRoot,'workspaces/asMagicBrain/Engineering'),get service(){return service;},async reopen(){await service.close();service=await createNativeService({dataRoot,hooks});}};}
const request=(f,operation,args={})=>f.service.request({repo:'Engineering',operation,args});
async function register(f){const r=await f.service.reviewPackageBase({repo:'Engineering',bytes:base,collectionId:'engineering',version:'1'});return f.service.registerPackageBase({repo:'Engineering',planId:r.planId});}
const review=f=>f.service.reviewPackageUpdate({repo:'Engineering',bytes:incoming,semantics:'snapshot',version:'2'});
const choices=r=>r.rows.filter(row=>row.choices.length).map(row=>({path:row.path,choice:row.conflict?'keep-both':'use-incoming'}));

test('native shared authority qualifies explicit ownership, update, preserved Git, saved source, export and rollback after restart',async t=>{
 const f=await fixture(t);await register(f);const initialGit=await request(f,'gitInspect'),opened=await request(f,'open',{path:'notes.md'});await request(f,'save',{path:'notes.md',baseHash:opened.sourceHash,text:'# Notes\nMy saved evidence\n'});await request(f,'create',{path:'personal.md',text:'My private source\n'});
 const r=await review(f);assert.equal(r.rows.find(row=>row.path==='notes.md').action,'conflict');const result=await f.service.applyPackageUpdate({repo:'Engineering',planId:r.planId,choices:choices(r)});assert.equal(result.status,'completed');assert.equal((await request(f,'gitInspect')).head,initialGit.head);assert.equal((await f.service.read({repo:'Engineering',path:'current.md'})).content,'# Current\nIncoming\n');assert.equal((await f.service.read({repo:'Engineering',path:'notes.md'})).content,'# Notes\nMy saved evidence\n');assert.ok(fs.existsSync(path.join(f.source,'notes incoming.md')));
 const exportReview=await f.service.reviewPackageExport({repo:'Engineering',collectionId:'engineering',version:'2'});const source=await f.service.buildPackageExport({repo:'Engineering',planId:exportReview.planId,kind:'source'});assert.ok(parsePackage(source.bytes).files.some(file=>file.path==='personal.md'));const offline=await f.service.buildPackageExport({repo:'Engineering',planId:exportReview.planId,kind:'offline'});const reader=new Map(readZipFiles(offline.bytes,{stripRoot:false}).files.map(file=>[file.path,file.bytes.toString('utf8')]));assert.ok(reader.has('index.html'));assert.match(reader.get('READER-NOTICES.txt'),/Copyright/);assert.ok(!reader.has('source/.git/config'));
 await f.reopen();assert.equal((await f.service.packageStatus({repo:'Engineering'})).operations.at(-1).operationId,result.operationId);await f.service.rollbackPackageUpdate({repo:'Engineering',operationId:result.operationId});assert.equal((await f.service.read({repo:'Engineering',path:'current.md'})).content,'# Current\nBase\n');assert.equal((await request(f,'gitInspect')).head,initialGit.head);assert.equal(fs.readFileSync(path.join(f.source,'personal.md'),'utf8'),'My private source\n');
});

test('native retained and new-document drafts invalidate stale updates and stay private',async t=>{
 const f=await fixture(t);await register(f);const r=await review(f),opened=await request(f,'open',{path:'current.md'});await request(f,'checkpoint',{path:'current.md',baseHash:opened.sourceHash,text:'Unsaved current'});await request(f,'checkpointNew',{draftId:'new-not-yet-saved',path:'new.md',text:'Unsaved new'});
 await assert.rejects(f.service.applyPackageUpdate({repo:'Engineering',planId:r.planId,choices:choices(r)}),{code:'STALE_PLAN'});const newReview=await review(f);assert.deepEqual(newReview.rows.find(row=>row.path==='current.md').choices,['keep-current']);assert.deepEqual(newReview.rows.find(row=>row.path==='new.md').choices,['keep-current']);await f.reopen();assert.equal((await request(f,'open',{path:'current.md'})).draft.text,'Unsaved current');assert.equal((await f.service.bootstrap('Engineering')).newDrafts[0].text,'Unsaved new');assert.ok(!fs.existsSync(path.join(f.source,'new.md')));
});

test('native interrupted update holds ordinary reads/writes through restart until explicit Resume or Rollback',async t=>{
 let armed=false,once=false;const f=await fixture(t,{packageAt:phase=>{if(armed&&!once&&phase==='exchange-after-step'){once=true;throw Object.assign(Error('injected'),{code:'INJECTED'});}}});await register(f);const r=await review(f);armed=true;await assert.rejects(f.service.applyPackageUpdate({repo:'Engineering',planId:r.planId,choices:choices(r)}));assert.equal((await f.service.packageStatus({repo:'Engineering'})).recoveryRequired,true);
 await assert.rejects(request(f,'create',{path:'blocked.md',text:'not permitted while mixed'}),{code:'PACKAGE_RECOVERY_REQUIRED'});await assert.rejects(f.service.read({repo:'Engineering',path:'current.md'}),{code:'PACKAGE_RECOVERY_REQUIRED'});
 await f.reopen();const status=await f.service.packageStatus({repo:'Engineering'});assert.equal(status.recoveryRequired,true);await assert.rejects(request(f,'create',{path:'blocked.md',text:'still held'}),{code:'PACKAGE_RECOVERY_REQUIRED'});await f.service.recoverPackageUpdate({repo:'Engineering',operationId:status.pending.operationId,direction:'rollback'});assert.equal((await f.service.read({repo:'Engineering',path:'current.md'})).content,'# Current\nBase\n');await request(f,'create',{path:'allowed.md',text:'safe now'});assert.ok(!fs.existsSync(path.join(f.source,'blocked.md')));
});

test('native queue serializes competing Save ahead of apply and validates request fields',async t=>{
 const f=await fixture(t);await register(f);const opened=await request(f,'open',{path:'current.md'}),r=await review(f);const save=request(f,'save',{path:'current.md',baseHash:opened.sourceHash,text:'Concurrent saved change'}),apply=f.service.applyPackageUpdate({repo:'Engineering',planId:r.planId,choices:choices(r)});await save;await assert.rejects(apply,{code:'STALE_PLAN'});assert.equal(fs.readFileSync(path.join(f.source,'current.md'),'utf8'),'Concurrent saved change');assert.throws(()=>f.service.packageStatus({repo:'Engineering',root:'/arbitrary'}),{code:'INVALID_REQUEST'});assert.throws(()=>f.service.reviewPackageUpdate({repo:'Engineering',bytes:incoming,semantics:'snapshot',version:'2',root:'/arbitrary'}),{code:'INVALID_REQUEST'});
});
