import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createNativeService} from './host-service.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const author={name:'Native Operations Fixture',email:'native-operations@example.invalid'};
const text='\ufeff# 原始 notes\r\nOne line\r\n';
const binary=Buffer.alloc(5*1024*1024+257);for(let i=0;i<binary.length;i++)binary[i]=i%251;
const gitEnv={PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TMPDIR:process.env.TMPDIR,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'};
function git(root,args,raw=false){const bytes=execFileSync('/usr/bin/git',['--no-pager','-c','core.hooksPath=/dev/null','-c','core.quotepath=false','-C',root,...args],{env:gitEnv,maxBuffer:32*1024*1024});return raw?bytes:bytes.toString('utf8').trim();}
async function fixture(t){
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'asmb-native-operations-')),dataRoot=path.join(parent,'profile');let service;
 t.after(async()=>{try{await service?.close();}finally{fs.rmSync(parent,{recursive:true,force:true});}});
 service=await createNativeService({dataRoot});
 const state={parent,dataRoot,get service(){return service;},root:repo=>path.join(dataRoot,'workspaces/asMagicBrain',repo),request:(repo,operation,args={})=>service.request({repo,operation,args}),restart:async()=>{await service.close();service=await createNativeService({dataRoot});}};
 state.item=async(repo,source,newPath)=>({path:source,token:(await state.request(repo,'inspectEntry',{path:source})).token,...(newPath?{newPath}:{})});
 return state;
}
function archive(parent){
 const source=path.join(parent,'zip-source');fs.mkdirSync(source);fs.mkdirSync(path.join(source,'docs'));
 fs.writeFileSync(path.join(source,'README.md'),'# Synthetic import\r\n');fs.writeFileSync(path.join(source,'docs/笔记.md'),text);fs.writeFileSync(path.join(source,'docs/media.bin'),binary);fs.writeFileSync(path.join(source,'docs/tool.sh'),'#!/bin/sh\n# inert fixture; never executed\n',{mode:0o755});
 git(source,['init','--initial-branch=main','--template=']);git(source,['add','.']);
 const commit=message=>git(source,['-c',`user.name=${author.name}`,'-c',`user.email=${author.email}`,'commit','--quiet','-m',message]);
 commit('Archive source history one');fs.writeFileSync(path.join(source,'README.md'),'# Synthetic import\r\nSecond source revision\r\n');git(source,['add','README.md']);commit('Archive source history two');
 return git(source,['archive','--format=zip','--prefix=project-main/','HEAD'],true);
}
async function imported(t){const f=await fixture(t);f.zip=archive(f.parent);await f.service.importArchive({name:'Imported',bytes:f.zip});return f;}
const commitRequest=(review,commitAuthor=author,message='Reviewed native fixture change')=>({expectedHead:review.expectedHead,expectedIndexHash:review.expectedIndexHash,files:review.files.map(({path,expectedSourceHash,expectedSourceMode})=>({path,expectedSourceHash,expectedSourceMode})),message,author:commitAuthor});

test('native ZIP strips its wrapper, preserves large assets and executable status, and registers only fresh local history across restart',async t=>{
 const f=await imported(t),root=f.root('Imported');
 assert.deepEqual((await f.service.catalog()).repositories.map(r=>r.name),['Workspace','Imported']);
 assert.equal(fs.existsSync(path.join(root,'project-main')),false);assert.equal(fs.readFileSync(path.join(root,'docs/笔记.md'),'utf8'),text);assert.equal(hash(fs.readFileSync(path.join(root,'docs/media.bin'))),hash(binary));assert.equal(fs.statSync(path.join(root,'docs/tool.sh')).mode&0o777,0o700);
 assert.match(git(root,['ls-tree','HEAD','docs/tool.sh']),/^100755 /);assert.equal(git(root,['rev-list','--count','HEAD']),'1');assert.equal(git(root,['log','-1','--format=%s']),'Import project');assert.equal(git(root,['remote']),'');
 assert.deepEqual((await f.request('Imported','gitStatus')).files,[]);
 const large=await f.request('Imported','open',{path:'docs/media.bin'});assert.equal(large.readOnly,true);assert.equal(large.text,null);
 const head=git(root,['rev-parse','HEAD']);await f.restart();
 assert.deepEqual((await f.service.catalog()).repositories.map(r=>r.name),['Workspace','Imported']);assert.equal((await f.service.read({repo:'Imported',path:'docs/笔记.md'})).content,text);assert.equal(git(root,['rev-parse','HEAD']),head);
 assert.deepEqual((await f.request('Imported','getCommitPreferences')).asmagicbrain,{name:'',email:''});
 await assert.rejects(f.service.importArchive({name:'Imported',bytes:f.zip}),{code:'NAME_EXISTS'});
 await assert.rejects(f.service.importArchive({name:'Incomplete',bytes:f.zip.subarray(0,50)}),{code:'ZIP_INVALID'});
 assert.deepEqual((await f.service.catalog()).repositories.map(r=>r.name),['Workspace','Imported']);assert.equal(fs.existsSync(f.root('Incomplete')),false);assert.equal(hash(fs.readFileSync(path.join(root,'docs/media.bin'))),hash(binary));
});

test('recursive native copy, move, Trash and restored-folder move retain bytes and draft IDs without saving new-file drafts',async t=>{
 const f=await imported(t),root=f.root('Imported');
 await f.request('Imported','createFolder',{path:'docs/empty'});
 const original=await f.request('Imported','open',{path:'docs/笔记.md'});await f.request('Imported','checkpoint',{path:original.path,baseHash:original.sourceHash,text:'private unsaved content'});
 await f.request('Imported','checkpointNew',{draftId:'new-unsaved',path:'docs/not-created.md',text:'new private draft'});
 await f.request('Imported','manage',{operation:'copy',items:[await f.item('Imported','docs','duplicates/docs')]});
 const copy=await f.request('Imported','open',{path:'duplicates/docs/笔记.md'});assert.notEqual(copy.documentId,original.documentId);assert.equal(copy.draft,null);assert.equal(copy.text,text);
 const moved=await f.request('Imported','manage',{operation:'move',items:[await f.item('Imported','docs','moved/docs')]});assert.deepEqual(moved.pathMoves,[{from:'docs',to:'moved/docs'}]);
 assert.equal(hash(fs.readFileSync(path.join(root,'moved/docs/media.bin'))),hash(binary));assert.equal(fs.statSync(path.join(root,'moved/docs/tool.sh')).mode&0o777,0o700);assert.equal(fs.statSync(path.join(root,'moved/docs/empty')).isDirectory(),true);
 const trashed=await f.request('Imported','manage',{operation:'trash',items:[await f.item('Imported','moved/docs')]});assert.equal(fs.existsSync(path.join(root,'moved/docs')),false);await f.restart();
 const trash=await f.request('Imported','listTrash');assert.equal(trash.length,1);assert.equal(trash[0].type,'directory');assert.equal(trash[0].fileCount,3);
 await f.request('Imported','restore',{trashId:trashed.items[0].trashId});
 // Restore then move before reopening the file exercises the saved-document map.
 await f.request('Imported','manage',{operation:'move',items:[await f.item('Imported','moved/docs','final/docs')]});
 const restored=await f.request('Imported','open',{path:'final/docs/笔记.md'});assert.equal(restored.documentId,original.documentId);assert.equal(restored.sourceHash,original.sourceHash);assert.equal(restored.draft.baseHash,original.sourceHash);assert.equal(restored.draft.text,'private unsaved content');assert.equal(restored.text,text);
 assert.equal(hash(fs.readFileSync(path.join(root,'final/docs/media.bin'))),hash(binary));assert.equal(fs.statSync(path.join(root,'final/docs/empty')).isDirectory(),true);assert.deepEqual(await f.request('Imported','listTrash'),[]);
 assert.deepEqual((await f.service.bootstrap('Imported')).newDrafts,[{draftId:'new-unsaved',path:'docs/not-created.md',text:'new private draft'}]);assert.equal(fs.existsSync(path.join(root,'docs/not-created.md')),false);
 assert.equal((await f.request('Imported','open',{path:'duplicates/docs/笔记.md'})).documentId,copy.documentId);
});

test('native selected-file commit uses reviewed saved bytes and explicit author, refuses stale review, and preserves unchecked source and drafts',async t=>{
 const f=await imported(t),root=f.root('Imported');
 const selected=await f.request('Imported','open',{path:'docs/笔记.md'}),unchecked=await f.request('Imported','open',{path:'README.md'});
 let current=await f.request('Imported','save',{path:selected.path,baseHash:selected.sourceHash,text:text+'saved revision A\r\n'});
 const other=await f.request('Imported','save',{path:unchecked.path,baseHash:unchecked.sourceHash,text:'Unchecked saved change\r\n'});await f.request('Imported','checkpoint',{path:other.path,baseHash:other.sourceHash,text:'Unchecked private draft'});
 const preferences=await f.request('Imported','getCommitPreferences'),github={name:'Synthetic GitHub Label',email:'123+synthetic@users.noreply.github.com'};
 await f.request('Imported','setCommitPreferences',{expectedRevision:preferences.revision,mode:'github',asmagicbrain:{name:'',email:''},github});await f.restart();assert.equal((await f.request('Workspace','getCommitPreferences')).mode,'github');
 const review=await f.request('Imported','gitReview',{paths:[selected.path]});assert.equal(review.files.length,1);assert.equal(review.files[0].after,current.text);
 current=await f.request('Imported','save',{path:selected.path,baseHash:current.sourceHash,text:text+'saved revision B\r\n'});await f.request('Imported','checkpoint',{path:selected.path,baseHash:current.sourceHash,text:'Selected private draft, never implicitly committed'});
 const head=git(root,['rev-parse','HEAD']);await assert.rejects(f.request('Imported','gitCommit',commitRequest(review,github)),{code:'CONFLICT'});assert.equal(git(root,['rev-parse','HEAD']),head);
 assert.equal(fs.readFileSync(path.join(root,'README.md'),'utf8'),other.text);assert.equal((await f.request('Imported','open',{path:'README.md'})).draft.text,'Unchecked private draft');
 const fresh=await f.request('Imported','gitReview',{paths:[selected.path]});await f.request('Imported','gitCommit',commitRequest(fresh,github));
 assert.equal(git(root,['show',`HEAD:${selected.path}`],true).toString('utf8'),current.text);assert.equal(git(root,['log','-1','--format=%an <%ae>']),`${github.name} <${github.email}>`);
 assert.deepEqual(git(root,['diff-tree','--no-commit-id','--name-only','-r','HEAD']).split('\n'),[selected.path]);
 assert.equal((await f.request('Imported','open',{path:selected.path})).draft.text,'Selected private draft, never implicitly committed');assert.equal(fs.readFileSync(path.join(root,'README.md'),'utf8'),other.text);assert.equal((await f.request('Imported','open',{path:'README.md'})).draft.text,'Unchecked private draft');
 const latest=await f.request('Imported','getCommitPreferences');await f.request('Imported','setCommitPreferences',{expectedRevision:latest.revision,mode:'manual',asmagicbrain:latest.asmagicbrain,github:latest.github});
 current=await f.request('Imported','save',{path:selected.path,baseHash:current.sourceHash,text:current.text+'explicit manual-author revision\r\n'});const manualReview=await f.request('Imported','gitReview',{paths:[selected.path]});await f.request('Imported','gitCommit',commitRequest(manualReview,author,'Explicit manual author'));
 assert.equal(git(root,['log','-1','--format=%an <%ae>']),`${author.name} <${author.email}>`);assert.equal((await f.request('Imported','getCommitPreferences')).github.name,github.name);assert.equal((await f.request('Imported','gitStatus')).files.find(row=>row.path==='README.md').status,'modified');
 await f.restart();assert.equal((await f.request('Imported','getCommitPreferences')).mode,'manual');assert.equal((await f.request('Imported','open',{path:'README.md'})).draft.text,'Unchecked private draft');
});

test('ordinary external staged work is retained when native selected-file commit is refused',async t=>{
 const f=await fixture(t),root=f.root('Workspace');
 await f.request('Workspace','create',{path:'selected.md',text:'selected saved bytes'});await f.request('Workspace','create',{path:'other.md',text:'unrelated staged bytes'});
 const review=await f.request('Workspace','gitReview',{paths:['selected.md']});git(root,['add','other.md']);const index=fs.readFileSync(path.join(root,'.git/index'));
 await assert.rejects(f.request('Workspace','gitCommit',commitRequest(review)),{code:'STAGED_CHANGES'});assert.equal((await f.request('Workspace','gitInspect')).head,null);assert.deepEqual(fs.readFileSync(path.join(root,'.git/index')),index);assert.equal(fs.readFileSync(path.join(root,'other.md'),'utf8'),'unrelated staged bytes');
 // User-equivalent unstage affects only this disposable fixture's index.
 git(root,['rm','--cached','other.md']);const fresh=await f.request('Workspace','gitReview',{paths:['selected.md']});await f.request('Workspace','gitCommit',commitRequest(fresh));
 assert.equal(git(root,['ls-tree','--name-only','HEAD']),'selected.md');assert.equal(fs.readFileSync(path.join(root,'other.md'),'utf8'),'unrelated staged bytes');
});

test('native large-binary move commits both reviewed paths without text admission or touching an unchecked file',async t=>{
 const f=await imported(t),root=f.root('Imported'),initial=await f.request('Imported','open',{path:'docs/media.bin'});
 await f.request('Imported','manage',{operation:'move',items:[await f.item('Imported','docs/media.bin','assets/media.bin')]});
 const moved=await f.request('Imported','open',{path:'assets/media.bin'});assert.equal(moved.documentId,initial.documentId);assert.equal(moved.readOnly,true);
 const review=await f.request('Imported','gitReview',{paths:['docs/media.bin','assets/media.bin']});assert.deepEqual(review.files.map(row=>row.status),['deleted','added']);assert(review.files.every(row=>row.previewOmitted));
 await f.request('Imported','gitCommit',commitRequest(review));assert.equal(hash(git(root,['show','HEAD:assets/media.bin'],true)),hash(binary));assert.equal(git(root,['ls-tree','--name-only','HEAD','docs/media.bin']),'');assert.equal(fs.readFileSync(path.join(root,'docs/笔记.md'),'utf8'),text);assert.deepEqual((await f.request('Imported','gitStatus')).files,[]);
 await f.restart();assert.equal((await f.request('Imported','open',{path:'assets/media.bin'})).documentId,initial.documentId);assert.deepEqual((await f.request('Imported','gitStatus')).files,[]);
});
