import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRepositoryRuntime} from '../src/repository-runtime/index.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t,hooks={}){
  const base=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'asmb-management-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const sourceRoot=path.join(base,'source'),privateRoot=path.join(base,'private');fs.mkdirSync(sourceRoot);fs.mkdirSync(privateRoot,{mode:0o700});
  const options={sourceRoot,privateRoot,localOwnerId:'owner',localRootId:'root',checkoutId:'checkout',hooks};
  const write=(relative,bytes)=>{const filename=path.join(sourceRoot,relative);fs.mkdirSync(path.dirname(filename),{recursive:true});fs.writeFileSync(filename,bytes);};
  const read=relative=>fs.readFileSync(path.join(sourceRoot,relative));
  const runtime=createRepositoryRuntime(options);
  const item=(relative,newPath)=>({path:relative,token:runtime.inspectEntry({path:relative}).token,...(newPath?{newPath}:{})});
  return {base,options,runtime,write,read,item};
}

test('large binary rename, private Trash and restart restore preserve bytes while text editing stays bounded',t=>{
  const {runtime,options,write,read}=fixture(t),bytes=Buffer.alloc(3*1024*1024+17);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
  write('large.bin',bytes);const opened=runtime.open('large.bin');assert.equal(opened.readOnly,true);assert.equal(opened.text,null);
  const inspected=runtime.inspectEntry({path:'large.bin'});assert.equal(inspected.byteLength,bytes.length);assert.equal(inspected.token,hash(bytes));
  const renamed=runtime.rename({path:'large.bin',newPath:'nested/moved.bin',baseHash:inspected.token});
  assert.equal(renamed.documentId,opened.documentId);assert.equal(hash(read('nested/moved.bin')),hash(bytes));
  const trashed=runtime.trash({path:'nested/moved.bin',baseHash:inspected.token});assert.equal(fs.existsSync(path.join(options.sourceRoot,'nested/moved.bin')),false);
  assert.equal(runtime.listTrash()[0].byteLength,bytes.length);runtime.close();
  const reopened=createRepositoryRuntime({...options,hooks:{}}),restored=reopened.restore({trashId:trashed.trashId});
  assert.equal(restored.documentId,opened.documentId);assert.equal(restored.readOnly,true);assert.equal(hash(read('nested/moved.bin')),hash(bytes));assert.deepEqual(reopened.listTrash(),[]);
  assert.throws(()=>reopened.create({path:'too-large.md',text:'x'.repeat(1024*1024+1)}),{code:'LIMIT_EXCEEDED'});
  assert.equal(fs.existsSync(path.join(options.sourceRoot,'too-large.md')),false);
});

test('recursive copy gets fresh identities; move and folder Trash retain saved bytes, empty folders and private drafts',t=>{
  const {runtime,options,write,read,item}=fixture(t),raw='\ufeff# 原始\r\nline\n',binary=Buffer.alloc(2*1024*1024+3,0xb7);
  write('docs/A.md',raw);write('docs/嵌套/data.bin',binary);write('docs/run.sh','#!/bin/sh\nexit 0\n');fs.chmodSync(path.join(options.sourceRoot,'docs/run.sh'),0o755);fs.mkdirSync(path.join(options.sourceRoot,'docs/empty'));
  const original=runtime.open('docs/A.md');runtime.checkpoint({path:original.path,baseHash:original.sourceHash,text:'retained unsaved draft'});
  const copied=runtime.manage({operation:'copy',items:[item('docs','copies/docs')]});assert.equal(copied.status,'completed');assert.deepEqual(copied.pathMoves,[]);
  const copiedDocument=runtime.open('copies/docs/A.md');assert.notEqual(copiedDocument.documentId,original.documentId);assert.equal(copiedDocument.draft,null);assert.equal(copiedDocument.text,raw);
  assert.equal(hash(read('copies/docs/嵌套/data.bin')),hash(binary));assert.equal(fs.statSync(path.join(options.sourceRoot,'copies/docs/empty')).isDirectory(),true);assert.equal(fs.statSync(path.join(options.sourceRoot,'copies/docs/run.sh')).mode&0o777,0o755);
  const moved=runtime.manage({operation:'move',items:[item('docs','moved/docs')]});assert.deepEqual(moved.pathMoves,[{from:'docs',to:'moved/docs'}]);assert(moved.changedPaths.includes('docs/嵌套/data.bin'));assert(moved.changedPaths.includes('moved/docs/嵌套/data.bin'));
  const movedDocument=runtime.open('moved/docs/A.md');assert.equal(movedDocument.documentId,original.documentId);assert.equal(movedDocument.draft.text,'retained unsaved draft');assert.equal(movedDocument.text,raw);
  const trashed=runtime.manage({operation:'trash',items:[item('moved/docs')]});const trashId=trashed.items[0].trashId;
  assert.equal(runtime.listTrash()[0].type,'directory');assert.equal(runtime.listTrash()[0].fileCount,3);assert.throws(()=>runtime.create({path:'moved/docs/new.md',text:'occupant'}),{code:'TRASH_PATH_RESERVED'});
  runtime.close();const reopened=createRepositoryRuntime({...options,hooks:{}});
  fs.mkdirSync(path.join(options.sourceRoot,'moved/docs'));assert.throws(()=>reopened.restore({trashId}),{code:'ALREADY_EXISTS'});fs.rmdirSync(path.join(options.sourceRoot,'moved/docs'));
  assert.equal(reopened.restore({trashId}).type,'directory');assert.equal(reopened.open('moved/docs/A.md').documentId,original.documentId);assert.equal(reopened.open('moved/docs/A.md').draft.text,'retained unsaved draft');assert.equal(hash(read('moved/docs/嵌套/data.bin')),hash(binary));
  assert.equal(fs.statSync(path.join(options.sourceRoot,'moved/docs/empty')).isDirectory(),true);assert.deepEqual(reopened.listTrash(),[]);assert(!fs.readdirSync(options.sourceRoot).some(name=>name.startsWith('.asmb-')));
});

test('all selected paths, collisions, aliases and unsafe descendants fail before publication',t=>{
  const {runtime,options,base,write,read,item}=fixture(t);write('a.txt','A');write('b.txt','B');write('occupied.txt','occupant');
  assert.throws(()=>runtime.manage({operation:'move',items:[item('a.txt','first.txt'),item('b.txt','occupied.txt')]}),{code:'ALREADY_EXISTS'});
  assert.equal(read('a.txt').toString(),'A');assert.equal(read('b.txt').toString(),'B');assert.equal(fs.existsSync(path.join(options.sourceRoot,'first.txt')),false);
  const stale=item('a.txt','new/deep.txt');write('a.txt','newer');assert.throws(()=>runtime.manage({operation:'copy',items:[stale]}),{code:'CONFLICT'});assert.equal(fs.existsSync(path.join(options.sourceRoot,'new')),false);
  write('Folder/file.md','x');
  for(const newPath of ['Folder/child','folder','../outside','.git/data','reserved/.asmb-stage','CON'])assert.throws(()=>runtime.manage({operation:'copy',items:[item('Folder',newPath)]}));
  assert.throws(()=>runtime.manage({operation:'trash',items:[item('Folder'),item('Folder/file.md')]}),{code:'OVERLAPPING_PATHS'});
  fs.symlinkSync(base,path.join(options.sourceRoot,'Folder/escape'));assert.throws(()=>runtime.inspectEntry({path:'Folder'}));
  fs.unlinkSync(path.join(options.sourceRoot,'Folder/escape'));fs.linkSync(path.join(options.sourceRoot,'a.txt'),path.join(options.sourceRoot,'Folder/hardlink'));assert.throws(()=>runtime.inspectEntry({path:'Folder'}),{code:'UNSAFE_FILE'});
  assert.equal(read('occupied.txt').toString(),'occupant');assert(!fs.readdirSync(options.sourceRoot).some(name=>name.startsWith('.asmb-')));
});

test('interrupted multi-item publication reopens blocked and safely rolls back without losing drafts',t=>{
  let interrupt=true;const {runtime,options,write,read,item}=fixture(t,{at(point,{index}={}){if(interrupt&&point==='management-after-item'&&index===0)throw Error('simulated interruption');}});
  write('first/A.md','first saved');write('second/B.md','second saved');const original=runtime.open('first/A.md');runtime.checkpoint({path:original.path,baseHash:original.sourceHash,text:'private draft'});
  assert.throws(()=>runtime.manage({operation:'move',items:[item('first','moved-first'),item('second','moved-second')]}),{code:'RECOVERY_REQUIRED'});assert.equal(runtime.state().recoveryRequired,true);runtime.close();interrupt=false;
  const reopened=createRepositoryRuntime({...options,hooks:{}});assert.throws(()=>reopened.createFolder({path:'blocked'}),{code:'RECOVERY_REQUIRED'});
  assert.equal(reopened.reconcile().status,'retained-old');assert.equal(read('first/A.md').toString(),'first saved');assert.equal(read('second/B.md').toString(),'second saved');assert.equal(fs.existsSync(path.join(options.sourceRoot,'moved-first')),false);
  assert.equal(reopened.open('first/A.md').documentId,original.documentId);assert.equal(reopened.open('first/A.md').draft.text,'private draft');assert.equal(reopened.state().recoveryRequired,false);
});

test('publication completed before interruption reconciles metadata, preserving folder identity and drafts',t=>{
  const {runtime,options,write,read,item}=fixture(t,{at(point){if(point==='after-source-write')throw Error('simulated interruption');}});
  write('docs/note.md','saved');const original=runtime.open('docs/note.md');runtime.checkpoint({path:original.path,baseHash:original.sourceHash,text:'private draft'});
  assert.throws(()=>runtime.manage({operation:'move',items:[item('docs','renamed')]}),{code:'RECOVERY_REQUIRED'});runtime.close();
  const reopened=createRepositoryRuntime({...options,hooks:{}});assert.equal(reopened.reconcile().status,'completed');assert.equal(read('renamed/note.md').toString(),'saved');assert.equal(reopened.open('renamed/note.md').documentId,original.documentId);assert.equal(reopened.open('renamed/note.md').draft.text,'private draft');assert.equal(reopened.state().recoveryRequired,false);
});

test('recovery refuses to overwrite an external occupant and remains recoverable after it is relocated',t=>{
  const {runtime,options,write,read,item}=fixture(t,{at(point){if(point==='management-after-retain')throw Error('simulated interruption');}});
  write('docs/note.md','saved');const original=runtime.open('docs/note.md');runtime.checkpoint({path:original.path,baseHash:original.sourceHash,text:'private draft'});
  assert.throws(()=>runtime.manage({operation:'move',items:[item('docs','new-docs')]}),{code:'RECOVERY_REQUIRED'});runtime.close();
  write('docs/external.md','new external contents');const reopened=createRepositoryRuntime({...options,hooks:{}});assert.throws(()=>reopened.reconcile(),{code:'RECOVERY_REQUIRED'});assert.equal(read('docs/external.md').toString(),'new external contents');assert.equal(reopened.state().recoveryRequired,true);
  fs.renameSync(path.join(options.sourceRoot,'docs'),path.join(options.sourceRoot,'external-preserved'));
  assert.equal(reopened.reconcile().status,'retained-old');assert.equal(read('docs/note.md').toString(),'saved');assert.equal(read('external-preserved/external.md').toString(),'new external contents');assert.equal(reopened.open('docs/note.md').draft.text,'private draft');
});

test('private Trash also safely restores an empty directory',t=>{
  const {runtime,options,item}=fixture(t);fs.mkdirSync(path.join(options.sourceRoot,'empty'),{mode:0o700});const result=runtime.manage({operation:'trash',items:[item('empty')]});
  assert.equal(runtime.restore({trashId:result.items[0].trashId}).type,'directory');assert.deepEqual(fs.readdirSync(path.join(options.sourceRoot,'empty')),[]);
});

test('combined descendant depth is rejected before creating destination parents',t=>{
  const {runtime,options,write,item}=fixture(t);write('docs/sub/note.md','saved');
  const destination=Array.from({length:32},(_,index)=>`d${index}`).join('/');
  assert.throws(()=>runtime.manage({operation:'move',items:[item('docs',destination)]}),{code:'INVALID_PATH'});
  assert.equal(fs.existsSync(path.join(options.sourceRoot,'d0')),false);assert.equal(runtime.state().recoveryRequired,false);
});

test('pinned mutation worker cannot redirect source removal through a swapped parent',t=>{
  let ready=false,swapped=false,source,outside;
  const {runtime,options,base,write,read,item}=fixture(t,{at(point,{parent,command}={}){
    if(ready&&!swapped&&point==='management-before-worker'&&command==='link-publish'&&parent===path.join(source,'docs')){
      swapped=true;fs.renameSync(parent,path.join(source,'docs-held'));fs.symlinkSync(outside,parent);
    }
  }});source=options.sourceRoot;outside=path.join(base,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'note.md'),'outside data');
  write('docs/note.md','source data');const request=item('docs/note.md','renamed.md');ready=true;
  assert.throws(()=>runtime.manage({operation:'move',items:[request]}),{code:'RECOVERY_REQUIRED'});
  assert.equal(fs.readFileSync(path.join(outside,'note.md'),'utf8'),'outside data');assert.equal(read('docs-held/note.md').toString(),'source data');assert.equal(fs.existsSync(path.join(source,'renamed.md')),false);
  fs.unlinkSync(path.join(source,'docs'));fs.renameSync(path.join(source,'docs-held'),path.join(source,'docs'));runtime.close();
  const reopened=createRepositoryRuntime({...options,hooks:{}});assert.equal(reopened.reconcile().status,'retained-old');assert.equal(read('docs/note.md').toString(),'source data');
});

test('the pinned worker checks source bytes again before retaining an original',t=>{
  let ready=false,changed=false,source;
  const {runtime,options,write,read,item}=fixture(t,{at(point,{parent,command}={}){
    if(ready&&!changed&&point==='management-before-worker'&&command==='link-publish'&&parent===path.join(source,'docs')){changed=true;fs.writeFileSync(path.join(parent,'note.md'),'external newer');}
  }});source=options.sourceRoot;write('docs/note.md','before');const request=item('docs/note.md','renamed.md');ready=true;
  assert.throws(()=>runtime.manage({operation:'move',items:[request]}),{code:'RECOVERY_REQUIRED'});assert.equal(read('docs/note.md').toString(),'external newer');assert.equal(fs.existsSync(path.join(source,'renamed.md')),false);assert.equal(runtime.state().recoveryRequired,true);
});

test('interrupted staging is durable and retires only verified source prefixes',t=>{
  for(const unknown of [false,true]){
    let active=false,staged;
    const {runtime,options,write,read,item}=fixture(t,{at(point,{parent,command,name}={}){
      if(active&&point==='management-before-worker'&&command==='copy'){
        active=false;staged=path.join(parent,name);fs.writeFileSync(staged,unknown?Buffer.from('unknown bytes'):Buffer.alloc(80000,0x6a));throw Error('simulated partial stage');
      }
    }});const bytes=Buffer.alloc(2*1024*1024,0x6a);write('source.bin',bytes);const request=item('source.bin','copy.bin');active=true;
    assert.throws(()=>runtime.manage({operation:'copy',items:[request]}),{code:'RECOVERY_REQUIRED'});assert.equal(runtime.state().recoveryRequired,true);runtime.close();
    const reopened=createRepositoryRuntime({...options,hooks:{}});
    if(unknown){assert.throws(()=>reopened.reconcile(),{code:'RECOVERY_REQUIRED'});assert.equal(fs.readFileSync(staged,'utf8'),'unknown bytes');}
    else{assert.equal(reopened.reconcile().status,'retained-old');assert.equal(fs.existsSync(staged),false);assert.equal(reopened.state().recoveryRequired,false);}
    assert.equal(hash(read('source.bin')),hash(bytes));assert.equal(fs.existsSync(path.join(options.sourceRoot,'copy.bin')),false);
  }
});

test('restart resumes verified partial cleanup after completed publication',t=>{
  let interrupted=false;const {runtime,options,write,read,item}=fixture(t,{at(point){if(!interrupted&&point==='management-after-cleanup-entry'){interrupted=true;throw Error('interrupted cleanup');}}});
  write('docs/first.md','first');write('docs/second.md','second');
  assert.throws(()=>runtime.manage({operation:'move',items:[item('docs','renamed')]}),{code:'RECOVERY_REQUIRED'});runtime.close();
  const reopened=createRepositoryRuntime({...options,hooks:{}});assert.equal(reopened.reconcile().status,'completed');assert.equal(read('renamed/first.md').toString(),'first');assert.equal(read('renamed/second.md').toString(),'second');assert.equal(reopened.state().recoveryRequired,false);
});

test('restart resumes rollback cleanup and retired private Trash without replaying publication',t=>{
  for(const operation of ['move','trash']){
    const {runtime,options,write,read,item}=fixture(t,{at(point,{index}={}){if(point==='management-after-item'&&index===0)throw Error('interrupted publication');}});
    write('one/first.md','first');write('one/second.md','second');write('two/third.md','third');
    const items=operation==='move'?[item('one','new-one'),item('two','new-two')]:[item('one'),item('two')];
    assert.throws(()=>runtime.manage({operation,items}),{code:'RECOVERY_REQUIRED'});runtime.close();
    let interrupted=false;const middle=createRepositoryRuntime({...options,hooks:{at(point){if(!interrupted&&point==='management-after-cleanup-entry'){interrupted=true;throw Error('interrupted rollback cleanup');}}}});
    assert.throws(()=>middle.reconcile());middle.close();
    const reopened=createRepositoryRuntime({...options,hooks:{}});assert.equal(reopened.reconcile().status,'retained-old');assert.equal(read('one/first.md').toString(),'first');assert.equal(read('one/second.md').toString(),'second');assert.equal(read('two/third.md').toString(),'third');assert.deepEqual(reopened.listTrash(),[]);assert.equal(reopened.state().recoveryRequired,false);
  }
});

test('a growing file stops at the captured size plus one byte without a file-size quota',t=>{
  const {runtime,options,write}=fixture(t);write('growing.bin','x');const filename=path.join(options.sourceRoot,'growing.bin'),identity=fs.statSync(filename).ino,original=fs.readSync;let consumed=0,calls=0;
  fs.readSync=function(fd,...args){const count=original.call(fs,fd,...args);if(fs.fstatSync(fd).ino===identity){calls++;consumed+=count;fs.appendFileSync(filename,Buffer.alloc(65536,0x61));}return count;};
  try{assert.throws(()=>runtime.inspectEntry({path:'growing.bin'}),{code:'CONFLICT'});}finally{fs.readSync=original;}
  assert(consumed<=2);assert(calls<=2);
});

test('temporary entry capacity fails during preflight without staging or a recovery hold',t=>{
  const {runtime,options,item}=fixture(t);
  for(let index=0;index<9999;index++)fs.writeFileSync(path.join(options.sourceRoot,`file-${index}`),'');
  assert.throws(()=>runtime.manage({operation:'move',items:[item('file-0','renamed')]}),{code:'LIMIT_EXCEEDED'});
  assert.equal(runtime.state().recoveryRequired,false);assert.equal(fs.existsSync(path.join(options.sourceRoot,'file-0')),true);assert.equal(fs.readdirSync(options.sourceRoot).length,9999);
});
