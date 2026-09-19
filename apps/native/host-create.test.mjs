import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createNativeService} from './host-service.mjs';

const git=(root,...args)=>execFileSync('/usr/bin/git',['--no-pager','-C',root,...args],{env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
async function fixture(t,hooks={}){
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'asmb-create-')),dataRoot=path.join(parent,'profile');let service;
 t.after(async()=>{try{await service?.close();}finally{fs.rmSync(parent,{recursive:true,force:true});}});
 service=await createNativeService({dataRoot,hooks});
 return {parent,dataRoot,get service(){return service;},root:name=>path.join(dataRoot,'workspaces/asMagicBrain',name),
  restart:async()=>{await service.close();service=await createNativeService({dataRoot});},stop:()=>service.close()};
}
const request=(service,repo,operation,args={})=>service.request({repo,operation,args});
const creation=(name='Notes')=>({name,requestId:randomUUID()});

test('new managed repository starts empty on local main; save, selected initial commit and private draft survive restart',async t=>{
 const f=await fixture(t),input=creation(),before=fs.readFileSync(path.join(f.root('Workspace'),'README.md'));
 assert.deepEqual(await f.service.createRepository(input),{name:'Notes',organization:'asMagicBrain',head:null,files:0,bytes:0});
 assert.deepEqual(fs.readdirSync(f.root('Notes')),['.git']);assert.equal(git(f.root('Notes'),'symbolic-ref','--short','HEAD'),'main');
 assert.equal(git(f.root('Notes'),'remote'),'');assert.doesNotMatch(fs.readFileSync(path.join(f.root('Notes'),'.git/config'),'utf8'),/\[user\]|\[remote /);
 let view=await f.service.read({repo:'Notes'});assert.deepEqual(view.entries,[]);assert.equal(view.commitCount,0);assert.equal(view.commit,null);assert.equal(view.branch,'main');
 assert.deepEqual(await f.service.bootstrap('Notes'),{local:true,newDrafts:[]});
 const saved=await request(f.service,'Notes','create',{path:'first.md',text:'\ufeff# New\r\n'});
 await request(f.service,'Notes','create',{path:'unchecked.md',text:'retain uncommitted'});
 await request(f.service,'Notes','checkpoint',{path:saved.path,baseHash:saved.sourceHash,text:'private unsaved text'});
 const review=await request(f.service,'Notes','gitReview',{paths:['first.md']});
 await request(f.service,'Notes','gitCommit',{expectedHead:review.expectedHead,expectedIndexHash:review.expectedIndexHash,
  files:review.files.map(({path,expectedSourceHash,expectedSourceMode})=>({path,expectedSourceHash,expectedSourceMode})),message:'First selected file',author:{name:'Test author',email:'fixture@example.invalid'}});
 assert.equal(git(f.root('Notes'),'ls-tree','--name-only','HEAD'),'first.md');assert.equal(git(f.root('Notes'),'rev-list','--count','HEAD'),'1');
 await f.restart();view=await f.service.read({repo:'Notes'});assert.equal(view.commitCount,1);
 assert.equal((await request(f.service,'Notes','open',{path:'first.md'})).draft.text,'private unsaved text');
 assert.deepEqual(fs.readFileSync(path.join(f.root('Notes'),'first.md')),Buffer.from('\ufeff# New\r\n'));
 assert.equal(fs.readFileSync(path.join(f.root('Notes'),'unchecked.md'),'utf8'),'retain uncommitted');
 assert.deepEqual(fs.readFileSync(path.join(f.root('Workspace'),'README.md')),before);
});

test('request token retries are idempotent across restart and rename; token reuse for a different name is refused',async t=>{
 const f=await fixture(t),input=creation();await Promise.all([f.service.createRepository(input),f.service.createRepository(input)]);
 const identity=fs.statSync(f.root('Notes')).ino;await request(f.service,'Notes','create',{path:'keep.md',text:'already written'});
 await f.restart();assert.equal((await f.service.createRepository(input)).name,'Notes');assert.equal(fs.statSync(f.root('Notes')).ino,identity);
 assert.equal(fs.readFileSync(path.join(f.root('Notes'),'keep.md'),'utf8'),'already written');
 await assert.rejects(f.service.createRepository({...input,name:'Other'}),{code:'REQUEST_CONFLICT'});
 await f.service.renameRepository({repository:'Notes',name:'Renamed'});assert.equal((await f.service.createRepository(input)).name,'Renamed');
 await f.restart();assert.deepEqual((await f.service.catalog()).repositories.map(item=>item.name),['Workspace','Renamed']);
 assert.equal(fs.statSync(f.root('Renamed')).ino,identity);
});

test('invalid, case-colliding and unregistered names are rejected without changing another folder or admitting paths',async t=>{
 const f=await fixture(t);fs.mkdirSync(f.root('Existing'));fs.writeFileSync(path.join(f.root('Existing'),'keep.txt'),'outside registration');
 for(const name of ['Workspace','workspace','Existing','existing'])await assert.rejects(f.service.createRepository(creation(name)),{code:'NAME_EXISTS'});
 for(const name of ['', '../escape','/absolute','new name','CON','trailing.','a/b','.git'])await assert.rejects(f.service.createRepository(creation(name)),{code:'INVALID_REPOSITORY_NAME'});
 for(const value of [{name:'Notes'},{...creation(),requestId:'bad'},{...creation(),root:f.parent},{...creation(),readme:true}])await assert.rejects(f.service.createRepository(value),{code:'INVALID_REQUEST'});
 assert.equal(fs.readFileSync(path.join(f.root('Existing'),'keep.txt'),'utf8'),'outside registration');assert.deepEqual((await f.service.catalog()).repositories.map(item=>item.name),['Workspace']);
});

test('accepted repository creation drains before close and remains registered on reopen',async t=>{
 const f=await fixture(t),input=creation();const created=f.service.createRepository(input),closed=f.service.close();
 await assert.rejects(f.service.createRepository(creation('Later')),{code:'SERVICE_CLOSED'});await Promise.all([created,closed]);
 await f.restart();assert.deepEqual((await f.service.catalog()).repositories.map(item=>item.name),['Workspace','Notes']);
});

test('durable ready, reserved, published, cataloged and binding phases recover after a stopped host process',async t=>{
 for(const phase of ['create-ready','create-reserved','create-published','create-cataloged','create-before-bindings','create-bound'])await t.test(phase,async t=>{
  const f=await fixture(t),input=creation();await f.stop();
  const script=`import {createNativeService} from ${JSON.stringify(new URL('./host-service.mjs',import.meta.url).href)};
   const service=await createNativeService({dataRoot:${JSON.stringify(f.dataRoot)},hooks:{at:point=>{if(point===${JSON.stringify(phase)})process.exit(86);}}});
   await service.createRepository(${JSON.stringify(input)});process.exit(87);`;
  assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})}}),error=>error.status===86);
  await f.restart();assert.deepEqual((await f.service.catalog()).repositories.map(item=>item.name),['Workspace','Notes']);
  assert.deepEqual(fs.readdirSync(f.root('Notes')),['.git']);assert.equal((await request(f.service,'Notes','gitInspect')).head,null);
  assert.equal((await f.service.createRepository(input)).name,'Notes');assert.deepEqual((await f.service.read({repo:'Notes'})).entries,[]);
 });
});

test('pre-ready process stops leave preserved stages but the same request can retry with a fresh stage',async t=>{
 for(const phase of ['create-staging','create-initialized','create-before-ready'])await t.test(phase,async t=>{
  const f=await fixture(t),input=creation();await f.stop();
  const script=`import {createNativeService} from ${JSON.stringify(new URL('./host-service.mjs',import.meta.url).href)};
   const service=await createNativeService({dataRoot:${JSON.stringify(f.dataRoot)},hooks:{at:point=>{if(point===${JSON.stringify(phase)})process.exit(86);}}});
   await service.createRepository(${JSON.stringify(input)});`;
  assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})}}),error=>error.status===86);
  const stages=fs.readdirSync(f.root('')).filter(name=>name.startsWith('.asmb-import-'));assert.equal(stages.length,1);
  const before=fs.statSync(f.root(stages[0])).ino,entries=fs.readdirSync(f.root(stages[0]));
  await f.restart();assert.deepEqual((await f.service.catalog()).repositories.map(item=>item.name),['Workspace']);
  assert.equal((await f.service.createRepository(input)).name,'Notes');
  assert.equal(fs.statSync(f.root(stages[0])).ino,before);assert.deepEqual(fs.readdirSync(f.root(stages[0])),entries);
  assert.deepEqual(fs.readdirSync(f.root('Notes')),['.git']);assert.deepEqual((await f.service.read({repo:'Notes'})).entries,[]);
 });
});

test('real publication and journal write failures never report success and recover without replacing source',async t=>{
 for(const failure of ['ready-write','publish-rename','catalog-link'])await t.test(failure,async t=>{
  let restore=()=>{},armed=true;
  const hooks={at:point=>{
   if(!armed)return;
   const method=failure==='ready-write'&&point==='create-before-ready'?'writeFileSync':failure==='publish-rename'&&point==='create-before-publish'?'renameSync':failure==='catalog-link'&&point==='create-before-register'?'linkSync':null;
   if(!method)return;armed=false;const original=fs[method];restore=()=>{fs[method]=original;};
   fs[method]=(...args)=>{restore();throw Object.assign(new Error('Injected storage failure'),{code:failure==='ready-write'?'ENOSPC':'EIO'});};
  }};
  const f=await fixture(t,hooks),input=creation();t.after(()=>restore());
  await assert.rejects(f.service.createRepository(input),{code:failure==='ready-write'?'ENOSPC':'EIO'});restore();
  const rootExisted=fs.existsSync(f.root('Notes')),inode=rootExisted?fs.statSync(f.root('Notes')).ino:null;
  await f.restart();
  if(failure==='ready-write'){assert.equal(fs.existsSync(f.root('Notes')),false);assert.deepEqual((await f.service.catalog()).repositories.map(item=>item.name),['Workspace']);}
  assert.equal((await f.service.createRepository(input)).name,'Notes');assert.deepEqual(fs.readdirSync(f.root('Notes')),['.git']);
  if(failure==='catalog-link')assert.equal(fs.statSync(f.root('Notes')).ino,inode);
  assert.equal((await request(f.service,'Notes','gitInspect')).head,null);
 });
});

test('catalog recovery repairs private bindings before exposing a just-published repository in the same host',async t=>{
 let armed=true;const f=await fixture(t,{at:point=>{if(armed&&point==='create-before-bindings'){armed=false;throw Object.assign(new Error('Interrupted before profile binding'),{code:'EIO'});}}}),input=creation();
 await assert.rejects(f.service.createRepository(input),{code:'EIO'});
 assert.deepEqual((await f.service.catalog()).repositories.map(item=>item.name),['Workspace','Notes']);
 const saved=await request(f.service,'Notes','create',{path:'recovered.md',text:'saved after catalog recovery'});
 await request(f.service,'Notes','checkpoint',{path:saved.path,baseHash:saved.sourceHash,text:'preserved draft'});
 assert.equal((await f.service.createRepository(input)).name,'Notes');await f.restart();
 assert.equal((await request(f.service,'Notes','open',{path:'recovered.md'})).draft.text,'preserved draft');
});

test('an interrupted unreceipted destination remains preserved and requires recovery rather than adoption',async t=>{
 const f=await fixture(t),input=creation();await f.stop();
 const script=`import {createNativeService} from ${JSON.stringify(new URL('./host-service.mjs',import.meta.url).href)};
  const service=await createNativeService({dataRoot:${JSON.stringify(f.dataRoot)},hooks:{at:point=>{if(point==='create-reserved-before-receipt')process.exit(86);}}});
  await service.createRepository(${JSON.stringify(input)});`;
 assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})}}),error=>error.status===86);
 const identity=fs.statSync(f.root('Notes')).ino;assert.deepEqual(fs.readdirSync(f.root('Notes')),[]);
 await assert.rejects(createNativeService({dataRoot:f.dataRoot}),{code:'RECOVERY_REQUIRED'});
 assert.equal(fs.statSync(f.root('Notes')).ino,identity);assert.deepEqual(fs.readdirSync(f.root('Notes')),[]);
 const ready=JSON.parse(fs.readFileSync(path.join(f.root('.asmb-catalog'),`${input.requestId}.ready.json`),'utf8'));
 assert.equal(fs.existsSync(path.join(f.root(`.asmb-import-${ready.stageId}`),'.git/HEAD')),true);
});
