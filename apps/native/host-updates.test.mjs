import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createNativeService} from './host-service.mjs';

const env={PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_COUNT:'0',GIT_TERMINAL_PROMPT:'0',GIT_AUTHOR_NAME:'Updates test',GIT_AUTHOR_EMAIL:'updates@example.invalid',GIT_COMMITTER_NAME:'Updates test',GIT_COMMITTER_EMAIL:'updates@example.invalid'};
const git=(root,...args)=>execFileSync('/usr/bin/git',['--no-pager','-c','core.hooksPath=/dev/null','-C',root,...args],{env,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const call=(service,operation,args={})=>service.request({repo:'Cloned',operation,args});
const input=()=>({repo:'Cloned',requestId:randomUUID()});
function inventory(root){const result={};const walk=relative=>{for(const entry of fs.readdirSync(path.join(root,relative),{withFileTypes:true})){const name=relative?`${relative}/${entry.name}`:entry.name,filename=path.join(root,name);if(entry.isDirectory())walk(name);else{const stat=fs.lstatSync(filename);result[name]={mode:stat.mode&0o777,bytes:stat.size,hash:createHash('sha256').update(fs.readFileSync(filename)).digest('hex')};}}};walk('');return result;}
function commit(root,files,message='Change'){for(const [name,text] of Object.entries(files)){if(text===null)fs.unlinkSync(path.join(root,name));else{fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});fs.writeFileSync(path.join(root,name),text);}}git(root,'add','--all');git(root,'commit','-m',message);return git(root,'rev-parse','HEAD');}
async function fixture(t,{empty=false,hooks={}}={}){
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'asmb-updates-')),dataRoot=path.join(parent,'profile'),original=path.join(parent,'source');fs.mkdirSync(original);git(original,'init','--initial-branch=main','--template=');if(!empty){commit(original,{'README.md':'# Original\n','remove.md':'Delete me\n','.gitignore':'ignored.txt\n'});git(original,'tag','v1');}
 const acquire=async({gitDir,branch})=>{let head;try{head=git(original,'rev-parse','--verify',`refs/heads/${branch}`);}catch{return null;}execFileSync('/usr/bin/git',[`--git-dir=${gitDir}`,'-c','core.hooksPath=/dev/null','fetch','--no-tags','--no-write-fetch-head','--no-auto-maintenance','--no-recurse-submodules','--',original,`refs/heads/${branch}:refs/asmb-check/remote`],{env,stdio:'pipe'});return head;};
 const serviceHooks={cloneAcquire:async({destination})=>execFileSync('/usr/bin/git',['clone','--no-checkout','--no-hardlinks','--no-local','--template=','--',original,destination],{env,stdio:'pipe'}),updatesAcquire:acquire,...hooks};let service=await createNativeService({dataRoot,hooks:serviceHooks});
 await service.cloneRepository({name:'Cloned',url:'https://github.com/example/repository',requestId:randomUUID()});
 t.after(async()=>{try{await service.close();}finally{fs.rmSync(parent,{recursive:true,force:true});}});
 return {parent,original,dataRoot,root:path.join(dataRoot,'workspaces/asMagicBrain/Cloned'),privateRoot:path.join(dataRoot,'state/native/Cloned'),acquire,get service(){return service;},restart:async()=>{await service.close();service=await createNativeService({dataRoot,hooks:serviceHooks});}};
}

test('updates compare complete committed filenames and previews without modifying any local Git/source bytes',async t=>{
 const f=await fixture(t);assert.deepEqual(await f.service.getRepositoryUpdates({repo:'Workspace'}),{eligible:false,reason:'local-only'});assert.equal((await f.service.getRepositoryUpdates({repo:'Cloned'})).eligible,true);
 const before=inventory(f.root);const unchanged=await f.service.checkRepositoryUpdates(input());assert.equal(unchanged.relation,'up-to-date');assert.deepEqual(unchanged.files,[]);assert.deepEqual(inventory(f.root),before);
 const remote=commit(f.original,{'README.md':'# Remote\n','remove.md':null,'new.md':'Remote new\n','binary.bin':Buffer.from([0,1,2]),'large.md':'x'.repeat(4*1024*1024+1),'exec.sh':'#!/bin/sh\n'});fs.chmodSync(path.join(f.original,'exec.sh'),0o755);git(f.original,'add','.');git(f.original,'commit','-m','Executable');
 const request=input(),result=await f.service.checkRepositoryUpdates(request);assert.equal(result.relation,'remote-ahead');assert.equal(result.ahead,0);assert.equal(result.behind,2);assert.equal(result.totalFiles,6);assert.equal(result.truncated,false);assert.equal(result.stale,false);assert.deepEqual(result.files.map(item=>item.path),['README.md','binary.bin','exec.sh','large.md','new.md','remove.md']);assert.notEqual(result.remoteHead,remote);assert.deepEqual(inventory(f.root),before);
 const preview=await f.service.readRepositoryUpdateFile({repo:'Cloned',checkId:result.checkId,path:'README.md'});assert.equal(preview.before,'# Original\n');assert.equal(preview.after,'# Remote\n');assert.equal(preview.binary,false);assert.equal(preview.beforeMode,'100644');assert.equal((await f.service.readRepositoryUpdateFile({repo:'Cloned',checkId:result.checkId,path:'binary.bin'})).binary,true);assert.equal((await f.service.readRepositoryUpdateFile({repo:'Cloned',checkId:result.checkId,path:'large.md'})).previewOmitted,true);assert.equal((await f.service.readRepositoryUpdateFile({repo:'Cloned',checkId:result.checkId,path:'exec.sh'})).afterMode,'100755');
 await assert.rejects(f.service.readRepositoryUpdateFile({repo:'Cloned',checkId:unchanged.checkId,path:'README.md'}),{code:'COMPARISON_EXPIRED'});assert.deepEqual(await f.service.checkRepositoryUpdates(request),result);
 await f.restart();assert.deepEqual((await f.service.getRepositoryUpdates({repo:'Cloned'})).lastCheck,result);assert.deepEqual(inventory(f.root),before);
});

test('local ahead, diverged and unrelated histories report commit directions without applying versions',async t=>{
 const f=await fixture(t);commit(f.root,{'local.md':'Local only\n'});assert.equal((await f.service.checkRepositoryUpdates(input())).relation,'local-ahead');commit(f.original,{'remote.md':'Remote only\n'});const diverged=await f.service.checkRepositoryUpdates(input());assert.equal(diverged.relation,'diverged');assert.equal(diverged.ahead,1);assert.equal(diverged.behind,1);
 git(f.original,'checkout','--orphan','replacement');git(f.original,'rm','-rf','.');commit(f.original,{'different.md':'Unrelated\n'});git(f.original,'branch','-M','main');const result=await f.service.checkRepositoryUpdates(input());assert.equal(result.relation,'unrelated');assert.equal(fs.existsSync(path.join(f.root,'different.md')),false);
});

test('dirty saved/index/ignored and private existing/new drafts remain exact; current HEAD makes old comparison stale',async t=>{
 const f=await fixture(t);await f.service.getRepositoryUpdates({repo:'Cloned'});fs.writeFileSync(path.join(f.root,'ignored.txt'),'Ignored local bytes');fs.writeFileSync(path.join(f.root,'saved.md'),'Saved local bytes');git(f.root,'add','saved.md');
 const opened=await call(f.service,'open',{path:'README.md'});await call(f.service,'checkpoint',{path:'README.md',baseHash:opened.sourceHash,text:'Unsaved private draft'});await call(f.service,'checkpointNew',{draftId:'new-draft',path:'new-draft.md',text:'Private new draft'});
 const before=inventory(f.root),drafts=inventory(path.join(f.privateRoot,'files')),newDrafts=inventory(path.join(f.privateRoot,'new-drafts'));commit(f.original,{'README.md':'Remote changes\n'});const result=await f.service.checkRepositoryUpdates(input());assert.equal(result.relation,'remote-ahead');assert.deepEqual(inventory(f.root),before);assert.deepEqual(inventory(path.join(f.privateRoot,'files')),drafts);assert.deepEqual(inventory(path.join(f.privateRoot,'new-drafts')),newDrafts);
 git(f.root,'commit','-m','User staged commit');assert.equal((await f.service.getRepositoryUpdates({repo:'Cloned'})).lastCheck.stale,true);await assert.rejects(f.service.readRepositoryUpdateFile({repo:'Cloned',checkId:result.checkId,path:'README.md'}),{code:'UPDATES_STALE'});
});

test('network waits allow draft checkpoints and mark concurrent local commits stale; rename waits for completion',async t=>{
 let enter,release,acquire;const entered=new Promise(resolve=>{enter=resolve;});const f=await fixture(t,{hooks:{updatesAcquire:async options=>{enter();await new Promise(resolve=>{release=resolve;});return acquire(options);}}});acquire=f.acquire;
 const pending=f.service.checkRepositoryUpdates(input());await entered;const file=await call(f.service,'open',{path:'README.md'});await call(f.service,'checkpoint',{path:'README.md',baseHash:file.sourceHash,text:'Typed during check'});await assert.rejects(f.service.renameRepository({repository:'Cloned',name:'Renamed'}),{code:'UPDATES_BUSY'});commit(f.root,{'while-checking.md':'New commit'});release();const result=await pending;assert.equal(result.stale,true);assert.equal((await call(f.service,'open',{path:'README.md'})).draft.text,'Typed during check');
 await f.service.renameRepository({repository:'Cloned',name:'Renamed'});const status=await f.service.getRepositoryUpdates({repo:'Renamed'});assert.equal(status.lastCheck.checkId,result.checkId);assert.equal(status.lastCheck.stale,true);
});

test('failed/cancelled check retains last complete snapshot and native close drains owned staging',async t=>{
 let gate=false,enter;const entered=new Promise(resolve=>{enter=resolve;});let acquire;const f=await fixture(t,{hooks:{updatesAcquire:async options=>{if(gate){enter();await new Promise(resolve=>{if(options.signal.aborted)resolve();else options.signal.addEventListener('abort',resolve,{once:true});});return null;}return acquire(options);}}});acquire=f.acquire;
 const initial=await f.service.checkRepositoryUpdates(input());gate=true;const controller=new AbortController(),pending=f.service.checkRepositoryUpdates(input(),{signal:controller.signal});await entered;controller.abort();await assert.rejects(pending,{code:'UPDATES_CANCELLED'});assert.equal((await f.service.getRepositoryUpdates({repo:'Cloned'})).lastCheck.checkId,initial.checkId);
 const again=f.service.checkRepositoryUpdates(input());await new Promise(resolve=>setTimeout(resolve,100));await f.service.close();await assert.rejects(again,{code:'UPDATES_CANCELLED'});assert.deepEqual(fs.readdirSync(path.join(f.privateRoot,'github-updates/snapshots')),[initial.checkId]);
});

test('empty local/remote and missing admitted branch are explicit; invalid caller sources/refs are refused',async t=>{
 const f=await fixture(t,{empty:true});const empty=await f.service.checkRepositoryUpdates(input());assert.equal(empty.relation,'remote-branch-missing');assert.equal(empty.localHead,null);commit(f.original,{'README.md':'First remote\n'});const incoming=await f.service.checkRepositoryUpdates(input());assert.equal(incoming.relation,'local-empty');assert.equal(incoming.files[0].status,'added');assert.equal((await f.service.readRepositoryUpdateFile({repo:'Cloned',checkId:incoming.checkId,path:'README.md'})).before,null);
 await assert.rejects(f.service.checkRepositoryUpdates({...input(),url:'https://evil.example/repo'}),{code:'INVALID_REQUEST'});await assert.rejects(f.service.checkRepositoryUpdates({...input(),localHead:'a'.repeat(40)}),{code:'INVALID_REQUEST'});await assert.rejects(f.service.readRepositoryUpdateFile({repo:'Cloned',checkId:incoming.checkId,path:'../escape'}),{code:'INVALID_REQUEST'});
});

test('large committed change list declares truncation while retaining full changed-file count',async t=>{
 const f=await fixture(t);const files={};for(let i=0;i<1005;i++)files[`many/file-${String(i).padStart(4,'0')}.md`]='item\n';commit(f.original,files);const result=await f.service.checkRepositoryUpdates(input());assert.equal(result.totalFiles,1005);assert.equal(result.files.length,1000);assert.equal(result.truncated,true);assert.equal((await f.service.readRepositoryUpdateFile({repo:'Cloned',checkId:result.checkId,path:'many/file-1004.md'})).after,'item\n');
});

test('renaming an unrelated repository cannot reconstruct or remove the active update snapshot',async t=>{
 let enter,release,acquire;const entered=new Promise(resolve=>{enter=resolve;});const f=await fixture(t,{hooks:{updatesAcquire:async options=>{enter();await new Promise(resolve=>{release=resolve;});return acquire(options);}}});acquire=f.acquire;await f.service.createRepository({name:'Other',requestId:randomUUID()});
 const pending=f.service.checkRepositoryUpdates(input());await entered;await f.service.renameRepository({repository:'Other',name:'Different'});assert.equal((await f.service.getRepositoryUpdates({repo:'Cloned'})).eligible,true);release();assert.equal((await pending).relation,'up-to-date');assert.equal((await f.service.catalog()).repositories.some(item=>item.name==='Different'),true);
});

test('stopped-host snapshot phases recover without replacing the previous result prematurely',async t=>{
 for(const phase of ['updates-intent','updates-before-publish','updates-published'])await t.test(phase,async t=>{
  const f=await fixture(t),prior=await f.service.checkRepositoryUpdates(input());commit(f.original,{'remote.md':'New version\n'});const before=inventory(f.root),request=input();await f.service.close();
  const script=`import {createNativeService} from ${JSON.stringify(new URL('./host-service.mjs',import.meta.url).href)};import{execFileSync}from'node:child_process';const service=await createNativeService({dataRoot:${JSON.stringify(f.dataRoot)},hooks:{updatesAcquire:async({gitDir,branch})=>{execFileSync('/usr/bin/git',['--git-dir='+gitDir,'-c','core.hooksPath=/dev/null','fetch','--no-tags','--no-write-fetch-head','--no-auto-maintenance','--',${JSON.stringify(f.original)},'refs/heads/'+branch+':refs/asmb-check/remote'],{env:${JSON.stringify(env)},stdio:'pipe'});return execFileSync('/usr/bin/git',['--git-dir='+gitDir,'rev-parse','refs/asmb-check/remote'],{env:${JSON.stringify(env)},encoding:'utf8'}).trim();},updatesAt:point=>{if(point===${JSON.stringify(phase)})process.exit(86);}}});await service.checkRepositoryUpdates(${JSON.stringify(request)});process.exit(87);`;
  assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})}}),error=>error.status===86);
  await f.restart();const status=await f.service.getRepositoryUpdates({repo:'Cloned'});assert.equal(status.lastCheck.checkId,phase==='updates-published'?request.requestId:prior.checkId);assert.deepEqual(inventory(f.root),before);assert.deepEqual(fs.readdirSync(path.join(f.privateRoot,'github-updates/snapshots')),[status.lastCheck.checkId]);
  assert.equal((await f.service.checkRepositoryUpdates(request)).relation,'remote-ahead');assert.deepEqual(inventory(f.root),before);
 });
});

test('transport failures return generic errors without private path or credential text',async t=>{
 const f=await fixture(t,{hooks:{updatesAcquire:async()=>{throw Object.assign(new Error('/private/secret/path token=secret'),{code:'ENOENT'});}}});
 await assert.rejects(f.service.checkRepositoryUpdates(input()),error=>error.code==='ENOENT'&&error.message==='ENOENT'&&!error.message.includes('secret'));
 assert.equal((await f.service.getRepositoryUpdates({repo:'Cloned'})).lastCheck,undefined);
});

test('read-only remote comparison preserves inspectable Git names without authorizing local creation',async t=>{
 const f=await fixture(t),before=inventory(f.root);commit(f.original,{'100%.md':'Percent\n','Week1: Notes.md':'Colon\n'});const result=await f.service.checkRepositoryUpdates(input());assert.deepEqual(result.files.map(file=>file.path),['100%.md','Week1: Notes.md']);
 assert.equal((await f.service.readRepositoryUpdateFile({repo:'Cloned',checkId:result.checkId,path:'100%.md'})).after,'Percent\n');assert.equal((await f.service.readRepositoryUpdateFile({repo:'Cloned',checkId:result.checkId,path:'Week1: Notes.md'})).after,'Colon\n');assert.deepEqual(inventory(f.root),before);
 await assert.rejects(call(f.service,'create',{path:'100%.md',text:'Not a local write permission'}),{code:'INVALID_PATH'});
});
