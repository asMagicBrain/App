import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createLocalGit} from '../src/local-git/index.mjs';
import {createImportedGitSnapshot} from '../src/local-git/import-snapshot.mjs';

const author={name:'Local Fixture',email:'fixture@example.test'};
function fixture(t,hooks={}){
 const base=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'asmb-local-git-')),sourceRoot=path.join(base,'source'),privateRoot=path.join(base,'private');
 fs.mkdirSync(sourceRoot);fs.mkdirSync(privateRoot,{mode:0o700});t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const api=createLocalGit({sourceRoot,privateRoot,hooks});
 const git=(...args)=>execFileSync('/usr/bin/git',['--no-pager','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',sourceRoot,...args],{encoding:'utf8',stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'}}).trim();
 return {base,sourceRoot,privateRoot,api,git,write:(name,text)=>fs.writeFileSync(path.join(sourceRoot,name),text)};
}
async function commit(api,paths,message='Selected local change'){
 const reviewed=await api.review({paths});
 return api.commit({expectedHead:reviewed.expectedHead,expectedIndexHash:reviewed.expectedIndexHash,files:reviewed.files.map(({path,expectedSourceHash,expectedSourceMode})=>({path,expectedSourceHash,expectedSourceMode})),message,author});
}

test('initialize and initial selected commit preserve BOM/CRLF, source bytes and unrelated files',async t=>{
 const {api,write,git,sourceRoot}=fixture(t);assert.equal((await api.inspect()).initialized,false);
 write('A.md','\ufeff# A\r\n文本\r\n');write('B.md','Leave untracked\n');
 assert.equal((await api.initialize()).branch,'main');assert.equal((await api.status()).head,null);
 const bytes=fs.readFileSync(path.join(sourceRoot,'A.md')),review=await api.review({paths:['A.md']});
 assert.equal(review.files[0].status,'added');assert.equal(review.files[0].after,bytes.toString('utf8'));assert.equal(review.files[0].before,null);
 const result=await commit(api,['A.md']);assert.equal(result.status,'committed');assert.equal(git('ls-tree','--name-only','HEAD'),'A.md');
 const blob=execFileSync('/usr/bin/git',['-C',sourceRoot,'cat-file','blob','HEAD:A.md']);assert.deepEqual(blob,bytes);assert.deepEqual(fs.readFileSync(path.join(sourceRoot,'A.md')),bytes);
 assert.deepEqual((await api.status()).files.map(file=>[file.path,file.status]),[['B.md','added']]);assert.equal(git('status','--porcelain'),'?? B.md');
 assert.equal(git('log','-1','--format=%an <%ae>'),'Local Fixture <fixture@example.test>');
 assert.throws(()=>git('config','--local','--get','user.name'));
});

test('selected modifications and rename leave unrelated worktree edits unchanged',async t=>{
 const {api,write,git,sourceRoot}=fixture(t);await api.initialize();write('A.md','A\n');write('B.md','B\n');await commit(api,['A.md','B.md']);
 write('A.md','A changed\r\n');write('B.md','Private unrelated change\n');
 const review=await api.review({paths:['A.md']});assert.equal(review.files[0].before,'A\n');assert.equal(review.files[0].after,'A changed\r\n');assert.equal(review.files[0].status,'modified');
 await commit(api,['A.md']);assert.equal(git('show','HEAD:B.md'),'B');assert.equal(fs.readFileSync(path.join(sourceRoot,'B.md'),'utf8'),'Private unrelated change\n');
 fs.renameSync(path.join(sourceRoot,'A.md'),path.join(sourceRoot,'Renamed.md'));
 const renamed=await api.review({paths:['A.md','Renamed.md']});assert.deepEqual(renamed.files.map(file=>file.status),['deleted','added']);await commit(api,['A.md','Renamed.md']);
 assert.equal(git('ls-tree','--name-only','HEAD'),'B.md\nRenamed.md');assert.equal(git('status','--porcelain'),'M B.md');
});

test('stale source, HEAD, and index preconditions fail without losing changes',async t=>{
 const {api,write,git,sourceRoot}=fixture(t);await api.initialize();write('A.md','A');await commit(api,['A.md']);write('A.md','B');
 const reviewed=await api.review({paths:['A.md']}),request={expectedHead:reviewed.expectedHead,expectedIndexHash:reviewed.expectedIndexHash,files:reviewed.files.map(({path,expectedSourceHash,expectedSourceMode})=>({path,expectedSourceHash,expectedSourceMode})),message:'Changed',author};
 write('A.md','External');await assert.rejects(api.commit(request),{code:'CONFLICT'});assert.equal(git('show','HEAD:A.md'),'A');assert.equal(fs.readFileSync(path.join(sourceRoot,'A.md'),'utf8'),'External');
 write('A.md','B');await commit(api,['A.md']);await assert.rejects(api.commit(request),{code:'HEAD_CHANGED'});
 write('A.md','Staged externally');git('add','A.md');assert.equal((await api.status()).staged,true);const before=fs.readFileSync(path.join(sourceRoot,'.git','index'));await assert.rejects(api.review({paths:['A.md']}),{code:'STAGED_CHANGES'});await assert.rejects(api.commit(request),{code:'STAGED_CHANGES'});assert.deepEqual(fs.readFileSync(path.join(sourceRoot,'.git','index')),before);
});

test('hooks, filters, external diff, signing and network configuration never execute',async t=>{
 const {api,write,git,base,sourceRoot}=fixture(t);await api.initialize();write('A.md','A\r\n');write('.gitattributes','*.md filter=danger diff=danger text eol=lf\n');await commit(api,['A.md','.gitattributes']);
 const marker=path.join(base,'executed'),command=`touch ${marker}`;
 for(const key of ['filter.danger.clean','filter.danger.smudge','filter.danger.process','diff.external','diff.danger.textconv','core.fsmonitor','gpg.program','core.sshCommand','credential.helper'])git('config','--local',key,command);
 git('config','--local','filter.danger.required','true');git('config','--local','commit.gpgSign','true');git('config','--local','core.autocrlf','true');git('config','--local','remote.origin.url','ssh://invalid.example/never');
 fs.mkdirSync(path.join(sourceRoot,'.git','hooks'));for(const name of ['pre-commit','commit-msg','post-commit','reference-transaction'])fs.writeFileSync(path.join(sourceRoot,'.git','hooks',name),`#!/bin/sh\n${command}\n`,{mode:0o755});
 write('A.md','Changed\r\n');assert.equal((await api.status()).files.find(file=>file.path==='A.md').status,'modified');await api.review({paths:['A.md']});await commit(api,['A.md']);
 assert.equal(fs.existsSync(marker),false);assert.deepEqual(execFileSync('/usr/bin/git',['-C',sourceRoot,'cat-file','blob','HEAD:A.md']),Buffer.from('Changed\r\n'));
});

test('ignored files stay out of status, unsafe paths and special source entries are rejected',async t=>{
 const {api,write,sourceRoot,base}=fixture(t);await api.initialize();write('.gitignore','ignored.md\n');write('ignored.md','hidden');write('visible.md','shown');
 assert.equal((await api.status()).files.some(file=>file.path==='ignored.md'),false);
 await assert.rejects(api.review({paths:['ignored.md']}),{code:'IGNORED_PATH'});
 for(const name of ['../outside','.git/config','.asmagicbrain/x','.asmb-private','bad\\path','a/../b'])await assert.rejects(api.review({paths:[name]}));
 fs.writeFileSync(path.join(base,'outside'),'outside');fs.symlinkSync(path.join(base,'outside'),path.join(sourceRoot,'link.md'));await assert.rejects(api.review({paths:['link.md']}));
 fs.linkSync(path.join(base,'outside'),path.join(sourceRoot,'hard.md'));await assert.rejects(api.review({paths:['hard.md']}),{code:'UNSAFE_FILE'});assert.equal(fs.readFileSync(path.join(base,'outside'),'utf8'),'outside');
});

test('mode-only changes are reviewed and chmod after review is a conflict',async t=>{
 const {api,write,sourceRoot,git}=fixture(t);await api.initialize();write('A.md','A');await commit(api,['A.md']);write('A.md','Changed');
 const reviewed=await api.review({paths:['A.md']});fs.chmodSync(path.join(sourceRoot,'A.md'),0o755);
 await assert.rejects(api.commit({expectedHead:reviewed.expectedHead,expectedIndexHash:reviewed.expectedIndexHash,files:reviewed.files.map(({path,expectedSourceHash,expectedSourceMode})=>({path,expectedSourceHash,expectedSourceMode})),message:'Changed',author}),{code:'CONFLICT'});
 write('A.md','A');const mode=await api.review({paths:['A.md']});assert.equal(mode.files[0].before,mode.files[0].after);assert.equal(mode.files[0].beforeMode,'100644');assert.equal(mode.files[0].afterMode,'100755');await commit(api,['A.md']);assert.match(git('ls-tree','HEAD','A.md'),/^100755 /);
});

test('external HEAD switch after ref publication cannot replace active-branch index',async t=>{
 const {api,write,sourceRoot,privateRoot,git}=fixture(t);await api.initialize();write('A.md','A');await commit(api,['A.md']);git('branch','other');const priorIndex=fs.readFileSync(path.join(sourceRoot,'.git','index'));write('A.md','B');
 const switched=createLocalGit({sourceRoot,privateRoot,hooks:{at:where=>{if(where==='after-ref')git('symbolic-ref','HEAD','refs/heads/other');}}});
 await assert.rejects(commit(switched,['A.md']),{code:'RECOVERY_REQUIRED'});assert.equal(git('symbolic-ref','--short','HEAD'),'other');assert.deepEqual(fs.readFileSync(path.join(sourceRoot,'.git','index')),priorIndex);assert.equal((await switched.inspect()).recoveryRequired,true);
});

test('private state cannot be rebound and SHA256 repositories retain their object format',async t=>{
 const {api,write,git,sourceRoot,privateRoot,base}=fixture(t);const other=path.join(base,'other');fs.mkdirSync(other);assert.throws(()=>createLocalGit({sourceRoot:other,privateRoot}),{code:'RECOVERY_REQUIRED'});
 git('init','--object-format=sha256','--initial-branch=main','--template=');write('A.md','A');const first=await commit(api,['A.md']);assert.equal(first.head.length,64);write('A.md','B');await commit(api,['A.md']);assert.equal((await api.status()).files.length,0);
});

test('existing index lock and detached/merge states fail closed',async t=>{
 const {api,write,git,sourceRoot}=fixture(t);await api.initialize();write('A.md','A');await commit(api,['A.md']);write('A.md','B');
 fs.writeFileSync(path.join(sourceRoot,'.git','index.lock'),'external lock');await assert.rejects(api.review({paths:['A.md']}),{code:'GIT_BUSY'});assert.equal(fs.readFileSync(path.join(sourceRoot,'.git','index.lock'),'utf8'),'external lock');fs.unlinkSync(path.join(sourceRoot,'.git','index.lock'));
 git('checkout','--detach');await assert.rejects(api.review({paths:['A.md']}),{code:'DETACHED_HEAD'});git('checkout','main');fs.writeFileSync(path.join(sourceRoot,'.git','MERGE_HEAD'),git('rev-parse','HEAD'));await assert.rejects(api.review({paths:['A.md']}),{code:'GIT_OPERATION_IN_PROGRESS'});
});

for(const point of ['after-intent','after-ref','after-index'])test(`interruption ${point} retains journal and blocks later writes after reopen`,async t=>{
 const {sourceRoot,privateRoot,api,write,git}=fixture(t);await api.initialize();write('A.md','A');await commit(api,['A.md']);const head=git('rev-parse','HEAD');write('A.md','B');
 const failing=createLocalGit({sourceRoot,privateRoot,hooks:{at:where=>{if(where===point)throw Error('injected');}}});await assert.rejects(commit(failing,['A.md']),{code:'RECOVERY_REQUIRED'});
 const resumed=createLocalGit({sourceRoot,privateRoot});assert.equal((await resumed.inspect()).recoveryRequired,true);await assert.rejects(resumed.review({paths:['A.md']}),{code:'RECOVERY_REQUIRED'});assert.equal(fs.readFileSync(path.join(sourceRoot,'A.md'),'utf8'),'B');assert.equal(git('rev-parse','HEAD')===head,point==='after-intent');
 const journal=JSON.parse(fs.readFileSync(path.join(privateRoot,'pending.json'),'utf8'));assert.equal(journal.beforeHead,head);assert.equal(journal.paths[0],'A.md');assert.equal(journal.afterIndexHash,createHash('sha256').update(fs.readFileSync(path.join(privateRoot,journal.temporary))).digest('hex'));
});

test('imported large unchanged assets use bounded status reads and do not block a Markdown commit',async t=>{
 const {api,write,sourceRoot,git}=fixture(t);
 // Both the per-file interactive ceiling and its aggregate ceiling are exceeded.
 const asset=Buffer.alloc(18*1024*1024,0x93);write('slides.pdf',asset);write('reference.pdf',Buffer.alloc(6*1024*1024,0x71));write('README.md','# Notes\r\n');
 await createImportedGitSnapshot({sourceRoot,files:[{path:'slides.pdf'},{path:'reference.pdf'},{path:'README.md'}],author});
 const read=fs.readSync;let largestRead=0;
 fs.readSync=function(fd,buffer,offset,length,position){largestRead=Math.max(largestRead,length);return read.call(this,fd,buffer,offset,length,position);};
 try{assert.deepEqual((await api.status()).files,[]);}finally{fs.readSync=read;}
 assert.ok(largestRead<=64*1024,`largest status read: ${largestRead}`);
 write('README.md','# Notes\r\nA small edit.\r\n');
 assert.deepEqual((await api.status()).files.map(file=>[file.path,file.status]),[['README.md','modified']]);
 await commit(api,['README.md']);
 assert.equal(git('log','-1','--format=%s'),'Selected local change');assert.deepEqual((await api.status()).files,[]);
 const largeReview=await api.review({paths:['slides.pdf']});assert.equal(largeReview.files[0].previewOmitted,true);assert.equal(largeReview.files[0].beforeSize,asset.length);assert.equal(largeReview.files[0].after,null);
 const fd=fs.openSync(path.join(sourceRoot,'slides.pdf'),'r+');try{fs.writeSync(fd,Buffer.from([0x94]),0,1,0);}finally{fs.closeSync(fd);}
 asset[0]=0x94;const changed=(await api.status()).files.find(file=>file.path==='slides.pdf');
 assert.equal(changed.status,'modified');assert.equal(changed.expectedSourceHash,createHash('sha256').update(asset).digest('hex'));
 await api.commit({expectedHead:git('rev-parse','HEAD'),expectedIndexHash:(await api.inspect()).expectedIndexHash,files:[{path:'slides.pdf',expectedSourceHash:changed.expectedSourceHash,expectedSourceMode:changed.expectedSourceMode}],message:'Large binary change',author});assert.deepEqual((await api.status()).files,[]);
});

test('streaming status and commit admit assets above64MiB and retain link safeguards',async t=>{
 const {api,sourceRoot,base}=fixture(t);await api.initialize();
 const filename=path.join(sourceRoot,'huge.pdf'),fd=fs.openSync(filename,'w');fs.ftruncateSync(fd,64*1024*1024+1);fs.closeSync(fd);
 assert.equal((await api.status()).files[0].status,'added');await commit(api,['huge.pdf']);assert.deepEqual((await api.status()).files,[]);fs.unlinkSync(filename);
 const outside=path.join(base,'outside');fs.writeFileSync(outside,'external');fs.linkSync(outside,filename);
 await assert.rejects(api.status(),{code:'UNSAFE_FILE'});
});

 test('large binary moves copies and deletes commit exact bytes without materializing diff buffers',async t=>{
 const {api,sourceRoot,write,git}=fixture(t);await api.initialize();
 const size=5*1024*1024,bytes=Buffer.alloc(size,0x91);write('original.pdf',bytes);fs.chmodSync(path.join(sourceRoot,'original.pdf'),0o755);await commit(api,['original.pdf']);
 fs.renameSync(path.join(sourceRoot,'original.pdf'),path.join(sourceRoot,'moved.pdf'));fs.copyFileSync(path.join(sourceRoot,'moved.pdf'),path.join(sourceRoot,'copied.pdf'));
 const review=await api.review({paths:['original.pdf','moved.pdf','copied.pdf']});
 assert.deepEqual(review.files.map(f=>f.status),['deleted','added','added']);assert(review.files.every(f=>f.previewOmitted&&f.before===null&&f.after===null));
 await commit(api,['original.pdf','moved.pdf','copied.pdf']);
 assert.equal(git('rev-parse','HEAD:moved.pdf'),git('rev-parse','HEAD:copied.pdf'));assert.match(git('ls-tree','HEAD','moved.pdf'),/^100755/);
 fs.unlinkSync(path.join(sourceRoot,'moved.pdf'));await commit(api,['moved.pdf']);assert.deepEqual((await api.status()).files,[]);
 const read=fs.readSync;let largest=0;fs.readSync=function(fd,buffer,offset,length,position){largest=Math.max(largest,length);return read.call(this,fd,buffer,offset,length,position);};
 try{await api.review({paths:['copied.pdf']});}finally{fs.readSync=read;}assert(largest<=64*1024);
 const stale=await api.review({paths:['copied.pdf']});const fd=fs.openSync(path.join(sourceRoot,'copied.pdf'),'r+');fs.writeSync(fd,Buffer.from([0x92]),0,1,0);fs.closeSync(fd);
 await assert.rejects(api.commit({expectedHead:stale.expectedHead,expectedIndexHash:stale.expectedIndexHash,files:stale.files.map(({path,expectedSourceHash,expectedSourceMode})=>({path,expectedSourceHash,expectedSourceMode})),message:'stale',author}),{code:'CONFLICT'});
});
 test('review budgets omit extra text previews without rejecting selected files',async t=>{
 const {api,write}=fixture(t);await api.initialize();for(let i=0;i<6;i++)write(`large-${i}.txt`,'a'.repeat(3*1024*1024));
 const names=Array.from({length:6},(_,i)=>`large-${i}.txt`),review=await api.review({paths:names});
 assert.equal(review.files.length,6);assert.equal(review.files.at(-1).previewOmitted,true);assert.equal(review.files.at(-1).binary,false);await commit(api,names);assert.deepEqual((await api.status()).files,[]);
 await assert.rejects(api.review({paths:Array.from({length:257},(_,i)=>`x${i}`)}),{code:'INVALID_SELECTION'});
});
