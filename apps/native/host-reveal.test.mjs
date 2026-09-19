import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createNativeService} from './host-service.mjs';

async function fixture(t,overrides={}){
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'asmb-native-reveal-'));
 const dataRoot=path.join(parent,'profile'),source=path.join(dataRoot,'workspaces/asMagicBrain/Workspace'),revealed=[];
 const service=await createNativeService({dataRoot,revealInFileManager:filename=>revealed.push(filename),...overrides});
 t.after(async()=>{try{await service.close();}finally{fs.rmSync(parent,{recursive:true,force:true});}});
 return {parent,dataRoot,source,revealed,service};
}
const request=(service,operation,args={})=>service.request({repo:'Workspace',operation,args});
const reveal=(service,path,ref)=>service.revealItem({repo:'Workspace',path,...(ref===undefined?{}:{ref})});

test('reveal dispatches exact physical file, folder and repository paths without saving drafts or altering Git',async t=>{
 const f=await fixture(t),opened=await request(f.service,'open',{path:'README.md'});
 await request(f.service,'checkpoint',{path:'README.md',baseHash:opened.sourceHash,text:'Private unsaved text'});
 fs.mkdirSync(path.join(f.source,'notes'));fs.writeFileSync(path.join(f.source,'notes/图 example.md'),'saved bytes\r\n');
 fs.writeFileSync(path.join(f.source,'notes/large.bin'),Buffer.from([0,128,255]));fs.truncateSync(path.join(f.source,'notes/large.bin'),5*1024*1024);
 const before=await request(f.service,'gitInspect'),readme=fs.readFileSync(path.join(f.source,'README.md'));
 for(const relative of ['', 'README.md','notes','notes/图 example.md','notes/large.bin'])assert.equal(await reveal(f.service,relative,''),undefined);
 assert.deepEqual(f.revealed,['','README.md','notes','notes/图 example.md','notes/large.bin'].map(relative=>path.join(f.source,relative)));
 assert.deepEqual(fs.readFileSync(path.join(f.source,'README.md')),readme);
 assert.equal((await request(f.service,'open',{path:'README.md'})).draft.text,'Private unsaved text');
 assert.deepEqual(await request(f.service,'gitInspect'),before);
});

test('reveal rejects snapshot refs and untrusted path descriptors before invoking the operating system',async t=>{
 const f=await fixture(t);
 const invalid=[null,[],{}, {repo:'Workspace'}, {repo:'Workspace',path:null}, {repo:'Workspace',path:5},
  {repo:'Workspace',path:'README.md',root:f.parent}, {repo:'Workspace',path:'README.md',ref:null},
  ...['/etc/passwd','../outside','notes/../../outside','notes\\file.md','file:///etc/passwd','https://example.invalid','%2e%2e/outside','.git/config','.GIT/config','.asmagicbrain/private','.asmb-host','notes//file.md','notes/./file.md','README.md\0'].map(path=>({repo:'Workspace',path}))];
 for(const input of invalid)await assert.rejects(f.service.revealItem(input));
 for(const ref of ['refs/tags/v1','refs/heads/main','HEAD'])await assert.rejects(reveal(f.service,'README.md',ref),{code:'HISTORICAL_REVISION'});
 fs.mkdirSync(path.join(path.dirname(f.source),'Unregistered'));fs.writeFileSync(path.join(path.dirname(f.source),'Unregistered/file.md'),'retain');
 await assert.rejects(f.service.revealItem({repo:'Unregistered',path:'file.md'}),{code:'UNKNOWN_REPOSITORY'});
 await assert.rejects(reveal(f.service,'missing.md'),{code:'REVEAL_NOT_FOUND'});
 assert.deepEqual(f.revealed,[]);
});

test('reveal refuses symlink files, symlink ancestors, aliases and special filesystem items',async t=>{
 const f=await fixture(t),outside=path.join(f.parent,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'secret.md'),'unchanged');
 fs.symlinkSync(path.join(outside,'secret.md'),path.join(f.source,'linked.md'));
 fs.symlinkSync('README.md',path.join(f.source,'inside-link.md'));
 fs.symlinkSync(outside,path.join(f.source,'linked-folder'));
 for(const relative of ['linked.md','inside-link.md','linked-folder','linked-folder/secret.md','readme.md'])await assert.rejects(reveal(f.service,relative),{code:'DENIED'});
 if(process.platform!=='win32'){
  execFileSync('/usr/bin/mkfifo',[path.join(f.source,'pipe')]);
  await assert.rejects(reveal(f.service,'pipe'),{code:'REVEAL_UNSUPPORTED'});
 }
 assert.deepEqual(f.revealed,[]);assert.equal(fs.readFileSync(path.join(outside,'secret.md'),'utf8'),'unchanged');
});

test('reveal binds queued requests and follows managed repository renames, never old or substituted roots',async t=>{
 const f=await fixture(t),input={repo:'Workspace',path:'README.md'};
 const work=f.service.revealItem(input);input.path='../outside';await work;
 assert.equal(f.revealed[0],path.join(f.source,'README.md'));
 await f.service.renameRepository({repository:'Workspace',name:'Personal'});
 await assert.rejects(reveal(f.service,'README.md'),{code:'UNKNOWN_REPOSITORY'});
 await f.service.revealItem({repo:'Personal',path:''});
 assert.equal(f.revealed.at(-1),path.join(path.dirname(f.source),'Personal'));
 const owned=path.join(path.dirname(f.source),'Personal');fs.renameSync(owned,path.join(f.parent,'preserved'));fs.mkdirSync(owned);fs.writeFileSync(path.join(owned,'README.md'),'replacement');
 await assert.rejects(f.service.revealItem({repo:'Personal',path:'README.md'}));assert.equal(f.revealed.length,2);
 fs.rmSync(owned,{recursive:true});fs.renameSync(path.join(f.parent,'preserved'),owned);
});

test('reveal participates in the host close queue and reports unavailable or failed OS dispatch',async t=>{
 const f=await fixture(t),work=reveal(f.service,'README.md'),close=f.service.close();await work;await close;
 assert.deepEqual(f.revealed,[path.join(f.source,'README.md')]);
 await assert.rejects(reveal(f.service,'README.md'),{code:'SERVICE_CLOSED'});
 const unavailable=await fixture(t,{revealInFileManager:undefined});await assert.rejects(reveal(unavailable.service,''),{code:'REVEAL_UNAVAILABLE'});
 const failure=await fixture(t,{revealInFileManager:()=>{throw Error('OS failure');}});await assert.rejects(reveal(failure.service,'README.md'),{code:'REVEAL_FAILED'});
 assert.match((await failure.service.read({repo:'Workspace',path:'README.md'})).content,/^# Workspace/);
});
