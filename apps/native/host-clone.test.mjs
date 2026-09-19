import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Writable} from 'node:stream';
import {createNativeService} from './host-service.mjs';
import {canonicalGitHubUrl} from '../../packages/desktop-host/src/local-git/github-clone.mjs';

const env={PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_COUNT:'0',GIT_TERMINAL_PROMPT:'0',GIT_AUTHOR_NAME:'Test author',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Test author',GIT_COMMITTER_EMAIL:'test@example.invalid'};
const git=(root,...args)=>execFileSync('/usr/bin/git',['--no-pager','-c','core.hooksPath=/dev/null','-C',root,...args],{env,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const request=(name='Cloned')=>({name,url:'https://github.com/ancorasir/asTeach-App',requestId:randomUUID()});
const call=(service,repo,operation,args={})=>service.request({repo,operation,args});
function source(parent){
 const root=path.join(parent,'original');fs.mkdirSync(root);git(root,'init','--initial-branch=trunk','--template=');
 fs.writeFileSync(path.join(root,'README.md'),'# First\r\n');git(root,'add','.');git(root,'commit','-m','First');git(root,'tag','v1');
 fs.mkdirSync(path.join(root,'docs'));fs.writeFileSync(path.join(root,'docs','notes.md'),'# Second\n');fs.writeFileSync(path.join(root,'asset.bin'),Buffer.alloc(5*1024*1024,71));fs.writeFileSync(path.join(root,'run.sh'),'#!/bin/sh\nexit 0\n',{mode:0o755});fs.writeFileSync(path.join(root,'.gitattributes'),'*.md text eol=lf filter=untrusted\n');
 git(root,'-c','core.autocrlf=false','add','.');git(root,'commit','-m','Second');git(root,'tag','-a','v2','-m','Annotated second');git(root,'checkout','-b','topic');fs.writeFileSync(path.join(root,'topic.md'),'# Topic\n');git(root,'add','.');git(root,'commit','-m','Topic');git(root,'checkout','trunk');return root;
}
function acquireFrom(original){return async({destination})=>{execFileSync('/usr/bin/git',['clone','--no-checkout','--no-hardlinks','--no-local','--template=','--',original,destination],{env,stdio:'pipe'});};}
async function fixture(t,{hooks={},withSource=true}={}){
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'asmb-clone-')),dataRoot=path.join(parent,'profile'),original=withSource?source(parent):null;
 let service=await createNativeService({dataRoot,hooks:{...(original?{cloneAcquire:acquireFrom(original)}:{}),...hooks}});
 t.after(async()=>{try{await service.close();}finally{fs.rmSync(parent,{recursive:true,force:true});}});
 return {parent,dataRoot,original,get service(){return service;},root:name=>path.join(dataRoot,'workspaces/asMagicBrain',name),restart:async()=>{await service.close();service=await createNativeService({dataRoot,hooks:{...(original?{cloneAcquire:acquireFrom(original)}:{})}});},stop:()=>service.close()};
}

test('URL admission accepts only canonical GitHub HTTPS repositories',()=>{
 assert.equal(canonicalGitHubUrl('https://github.com/ancorasir/asTeach-App'),'https://github.com/ancorasir/asTeach-App.git');assert.equal(canonicalGitHubUrl('https://github.com/ancorasir/asTeach-App.git/'),'https://github.com/ancorasir/asTeach-App.git');
 for(const url of ['http://github.com/a/b','https://github.com/a/b?x=1','https://github.com/a/b#x','https://token@github.com/a/b','https://github.com.evil/a/b','https://github.com:443/a/b','git@github.com:a/b','https://github.com/a/b/tree/main','https://github.com/a/..','https://github.com/a/%2e%2e','https://github.com/a-/b','https://github.com/a--b/c','file:///tmp/repo','https://github.com/a/b\n'])assert.throws(()=>canonicalGitHubUrl(url),{code:'INVALID_GITHUB_URL'});
});

test('clone retains full history, tags, branch tips and bytes; selected local commit and drafts survive restart',async t=>{
 const f=await fixture(t),input=request(),phases=[];const result=await f.service.cloneRepository(input,{onProgress:value=>phases.push(value.phase)}),root=f.root('Cloned');
 assert.equal(result.head,git(f.original,'rev-parse','HEAD'));assert.equal(result.branch,'trunk');assert.equal(result.sourceUrl,'https://github.com/ancorasir/asTeach-App.git');assert.deepEqual(phases,['connecting','checking','publishing']);
 assert.equal(git(root,'remote','get-url','origin'),result.sourceUrl);assert.equal(git(root,'rev-list','--all','--count'),git(f.original,'rev-list','--all','--count'));assert.equal(git(root,'tag','--list'),git(f.original,'tag','--list'));
 for(const ref of ['refs/heads/trunk','refs/heads/topic','refs/tags/v1','refs/tags/v2'])assert.equal(git(root,'rev-parse',ref),git(f.original,'rev-parse',ref));
 for(const name of ['README.md','asset.bin','run.sh','docs/notes.md','.gitattributes'])assert.deepEqual(fs.readFileSync(path.join(root,name)),execFileSync('/usr/bin/git',['-C',f.original,'show',`HEAD:${name}`],{env,maxBuffer:8*1024*1024}));
 assert.equal(fs.statSync(path.join(root,'run.sh')).mode&0o111,0o111);assert.equal(fs.existsSync(path.join(root,'topic.md')),false);assert.doesNotMatch(fs.readFileSync(path.join(root,'.git/config'),'utf8'),/user|credential|extraheader|include|filter/);
 const view=await f.service.read({repo:'Cloned'});assert.deepEqual(view.branches,['topic','trunk']);assert.deepEqual(view.tags,['v1','v2']);assert.equal((await f.service.read({repo:'Cloned',path:'topic.md',ref:'refs/heads/topic'})).content,'# Topic\n');
 await call(f.service,'Cloned','create',{path:'new.md',text:'# Local\n'});await call(f.service,'Cloned','create',{path:'unchecked.md',text:'# Unchecked\n'});
 const file=await call(f.service,'Cloned','open',{path:'new.md'});await call(f.service,'Cloned','checkpoint',{path:'new.md',baseHash:file.sourceHash,text:'# Private draft\n'});
 const review=await call(f.service,'Cloned','gitReview',{paths:['new.md']});await call(f.service,'Cloned','gitCommit',{expectedHead:review.expectedHead,expectedIndexHash:review.expectedIndexHash,files:review.files.map(({path,expectedSourceHash,expectedSourceMode})=>({path,expectedSourceHash,expectedSourceMode})),message:'Local selected commit',author:{name:'Local author',email:'local@example.invalid'}});
 assert.equal(git(root,'diff-tree','--no-commit-id','--name-only','-r','HEAD'),'new.md');assert.equal(git(f.original,'rev-parse','HEAD'),result.head);
 await f.restart();assert.equal((await call(f.service,'Cloned','open',{path:'new.md'})).draft.text,'# Private draft\n');assert.equal((await f.service.read({repo:'Cloned'})).commitCount,3);
});

test('clone retry identity persists through restart and repository rename; cross-purpose or URL/name token reuse refuses',async t=>{
 const f=await fixture(t),input=request();await f.service.cloneRepository(input);const before=fs.statSync(f.root('Cloned')).ino;
 await f.restart();assert.equal((await f.service.cloneRepository(input)).name,'Cloned');assert.equal(fs.statSync(f.root('Cloned')).ino,before);
 for(const changed of [{...input,name:'Other'},{...input,url:'https://github.com/other/repo'}])await assert.rejects(f.service.cloneRepository(changed),{code:'REQUEST_CONFLICT'});
 await assert.rejects(f.service.createRepository({name:input.name,requestId:input.requestId}),{code:'REQUEST_CONFLICT'});
 await f.service.renameRepository({repository:'Cloned',name:'Renamed'});assert.equal((await f.service.cloneRepository(input)).name,'Renamed');await f.restart();assert.equal((await f.service.cloneRepository(input)).name,'Renamed');assert.equal(fs.statSync(f.root('Renamed')).ino,before);
});

test('invalid inputs and occupied unregistered destinations are refused without changes',async t=>{
 const f=await fixture(t);fs.mkdirSync(f.root('Occupied'));fs.writeFileSync(path.join(f.root('Occupied'),'keep'),'unchanged');
 for(const name of ['Workspace','workspace','Occupied','occupied'])await assert.rejects(f.service.cloneRepository(request(name)),{code:'NAME_EXISTS'});
 for(const name of ['../escape','a/b','CON','a.'])await assert.rejects(f.service.cloneRepository(request(name)),{code:'INVALID_REPOSITORY_NAME'});
 for(const value of [{...request(),url:'https://evil.example/repo'},{...request(),url:'https://github.com/a/b?x=y'}])await assert.rejects(f.service.cloneRepository(value),{code:'INVALID_GITHUB_URL'});
 for(const value of [{...request(),requestId:'invalid'},{...request(),credential:{token:'renderer'}},{...request(),destination:f.parent}])await assert.rejects(f.service.cloneRepository(value),{code:'INVALID_REQUEST'});
 assert.equal(fs.readFileSync(path.join(f.root('Occupied'),'keep'),'utf8'),'unchanged');assert.deepEqual((await f.service.catalog()).repositories.map(item=>item.name),['Workspace']);
});

test('cancellation before readiness settles without a published repository; after readiness completes publication',async t=>{
 let gate,entered;const wait=new Promise(resolve=>{entered=resolve;});const f=await fixture(t,{hooks:{cloneAcquire:async({destination,signal})=>{fs.mkdirSync(path.join(destination,'partial'));entered();await new Promise(resolve=>{gate=resolve;signal.addEventListener('abort',resolve,{once:true});});}}});
 const controller=new AbortController(),pending=f.service.cloneRepository(request(),{signal:controller.signal});await wait;controller.abort();gate();await assert.rejects(pending,{code:'CLONE_CANCELLED'});assert.equal(fs.existsSync(f.root('Cloned')),false);assert.deepEqual(fs.readdirSync(f.root('')).filter(name=>name.startsWith('.asmb-import-')),[]);
 const after=new AbortController();const g=await fixture(t,{hooks:{at:point=>{if(point==='clone-ready')after.abort();}}});assert.equal((await g.service.cloneRepository(request(),{signal:after.signal})).name,'Cloned');
});

test('unsupported symlink and submodule trees are not published or followed',async t=>{
 for(const kind of ['symlink','submodule'])await t.test(kind,async t=>{
  const f=await fixture(t);if(kind==='symlink'){fs.symlinkSync('/tmp',path.join(f.original,'escape'));git(f.original,'add','escape');}
  else git(f.original,'update-index','--add','--cacheinfo',`160000,${git(f.original,'rev-parse','HEAD')},submodule`);
  git(f.original,'commit','-m','Unsupported entry');await assert.rejects(f.service.cloneRepository(request()),{code:'CLONE_UNSUPPORTED_ENTRY'});assert.equal(fs.existsSync(f.root('Cloned')),false);assert.deepEqual((await f.service.catalog()).repositories.map(item=>item.name),['Workspace']);
 });
});

test('durable publication phases recover after host termination and request retry remains idempotent',async t=>{
 for(const phase of ['clone-ready','clone-reserved','clone-published','clone-cataloged','clone-before-bindings','clone-bound'])await t.test(phase,async t=>{
  const f=await fixture(t),input=request();await f.stop();
  const script=`import {createNativeService} from ${JSON.stringify(new URL('./host-service.mjs',import.meta.url).href)};import{execFileSync}from'node:child_process';const service=await createNativeService({dataRoot:${JSON.stringify(f.dataRoot)},hooks:{cloneAcquire:async({destination})=>execFileSync('/usr/bin/git',['clone','--no-checkout','--no-hardlinks','--no-local','--template=','--',${JSON.stringify(f.original)},destination],{env:${JSON.stringify(env)},stdio:'pipe'}),at:point=>{if(point===${JSON.stringify(phase)})process.exit(86);}}});await service.cloneRepository(${JSON.stringify(input)});process.exit(87);`;
  assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})}}),error=>error.status===86);
  await f.restart();assert.deepEqual((await f.service.catalog()).repositories.map(item=>item.name),['Workspace','Cloned']);assert.equal((await f.service.cloneRepository(input)).head,git(f.original,'rev-parse','HEAD'));assert.equal((await f.service.read({repo:'Cloned'})).branch,'trunk');
 });
});

test('storage failure before ready preserves existing data and permits a fresh safe retry',async t=>{
 let armed=true;const f=await fixture(t,{hooks:{at:point=>{if(armed&&point==='clone-before-ready'){armed=false;throw Object.assign(new Error('Disk full'),{code:'ENOSPC'});}}}});const input=request(),workspace=fs.readFileSync(path.join(f.root('Workspace'),'README.md'));
 await assert.rejects(f.service.cloneRepository(input),{code:'ENOSPC'});assert.equal(fs.existsSync(f.root('Cloned')),false);assert.deepEqual(fs.readFileSync(path.join(f.root('Workspace'),'README.md')),workspace);assert.equal((await f.service.cloneRepository(input)).name,'Cloned');
});

test('empty remote repository retains its unborn default branch without inventing a commit',async t=>{
 const f=await fixture(t,{withSource:false}),original=path.join(f.parent,'empty');fs.mkdirSync(original);git(original,'init','--initial-branch=main','--template=');await f.stop();
 const service=await createNativeService({dataRoot:f.dataRoot,hooks:{cloneAcquire:acquireFrom(original)}});try{
  const result=await service.cloneRepository(request());assert.equal(result.head,null);assert.equal(result.files,0);assert.equal(result.bytes,0);assert.equal(result.branch,'main');assert.equal(git(f.root('Cloned'),'symbolic-ref','--short','HEAD'),'main');
  const view=await service.read({repo:'Cloned'});assert.equal(view.commitCount,0);assert.deepEqual(view.entries,[]);await call(service,'Cloned','create',{path:'first.md',text:'First local content'});const review=await call(service,'Cloned','gitReview',{paths:['first.md']});assert.equal(review.expectedHead,null);
 }finally{await service.close();}
});

test('LFS pointer files remain exact ordinary bytes; unsupported config and templates are absent',async t=>{
 const f=await fixture(t),pointer='version https://git-lfs.github.com/spec/v1\noid sha256:'+ 'a'.repeat(64)+'\nsize 123456789\n';
 fs.writeFileSync(path.join(f.original,'.gitattributes'),'*.bin filter=lfs diff=lfs merge=lfs -text\n');fs.writeFileSync(path.join(f.original,'pointer.bin'),pointer);git(f.original,'-c','filter.lfs.required=false','add','.');git(f.original,'commit','-m','LFS pointer');
 await f.service.cloneRepository(request());assert.equal(fs.readFileSync(path.join(f.root('Cloned'),'pointer.bin'),'utf8'),pointer);assert.equal(fs.existsSync(path.join(f.root('Cloned'),'.git','lfs')),false);assert.equal(fs.existsSync(path.join(f.root('Cloned'),'.git','hooks')),false);
});


test('blob write failure and cancellation fully drain streams before owned staging is removed',async t=>{
 for(const failure of ['storage','cancel'])await t.test(failure,async t=>{
  const f=await fixture(t),controller=new AbortController(),original=fs.createWriteStream;let armed=true;
  fs.createWriteStream=(filename,options)=>{
   if(!armed||!filename.endsWith('/asset.bin'))return original(filename,options);armed=false;
   if(failure==='storage')return new Writable({write(chunk,encoding,callback){callback(Object.assign(new Error('Disk full'),{code:'ENOSPC'}));},destroy(error,callback){fs.closeSync(options.fd);callback(error);}});
   const stream=original(filename,options);stream.once('pipe',()=>controller.abort());return stream;
  };
  try{await assert.rejects(f.service.cloneRepository(request(),{signal:controller.signal}),{code:failure==='storage'?'ENOSPC':'CLONE_CANCELLED'});}finally{fs.createWriteStream=original;}
  assert.equal(fs.existsSync(f.root('Cloned')),false);assert.deepEqual(fs.readdirSync(f.root('')).filter(name=>name.startsWith('.asmb-import-')),[]);assert.equal((await f.service.cloneRepository(request())).name,'Cloned');
 });
});
