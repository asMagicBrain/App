import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createNativeService} from './host-service.mjs';
import {createExternalFileTickets} from './external-file-tickets.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const failure=code=>Object.assign(new Error(code),{code});
function inventory(root){
 const entries=[];function walk(directory,relative=''){for(const name of fs.readdirSync(directory).sort()){
  const filename=path.join(directory,name),key=relative?`${relative}/${name}`:name,s=fs.lstatSync(filename);
  entries.push({path:key,type:s.isDirectory()?'directory':s.isSymbolicLink()?'link':'file',identity:`${s.dev}:${s.ino}`,mode:s.mode&0o777,...(s.isFile()?{size:s.size,sha256:hash(fs.readFileSync(filename))}:{})});if(s.isDirectory())walk(filename,key);
 }}walk(root);return entries;
}
async function fixture(t,hooks={}){
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'asmb-external-')),dataRoot=path.join(parent,'profile');let service=await createNativeService({dataRoot,hooks});
 t.after(async()=>{try{await service?.close();}finally{fs.rmSync(parent,{recursive:true,force:true});}});
 const source=path.join(parent,'originals');fs.mkdirSync(source);
 return {parent,source,dataRoot,get service(){return service;},root:path.join(dataRoot,'workspaces/asMagicBrain/Workspace'),request:(operation,args={})=>service.request({repo:'Workspace',operation,args}),
  import:async(paths,destination='',signal)=>service.importExternalFiles({repo:'Workspace',destination,sources:await service.prepareExternalFiles(paths)},{signal}),
  restart:async()=>{await service.close();service=await createNativeService({dataRoot});}};
}

test('recursive external copy preserves original bytes/identities, binary size, empty folders, ordinary dotfiles and draft paths; skips only metadata',async t=>{
 const f=await fixture(t),incoming=path.join(f.source,'Incoming');fs.mkdirSync(incoming);fs.mkdirSync(path.join(incoming,'empty'));fs.mkdirSync(path.join(incoming,'docs'));
 const text='\ufeff# 外部 note\r\noriginal bytes\r\n',binary=Buffer.alloc(5*1024*1024+73,137);
 fs.writeFileSync(path.join(incoming,'docs/note.md'),text);fs.writeFileSync(path.join(incoming,'media.bin'),binary);fs.writeFileSync(path.join(incoming,'.ordinary'),'preserved dotfile');fs.writeFileSync(path.join(incoming,'run.sh'),'#!/bin/sh\n# inert fixture\n',{mode:0o755});
 fs.mkdirSync(path.join(incoming,'.git'));fs.writeFileSync(path.join(incoming,'.git/config'),'excluded');fs.mkdirSync(path.join(incoming,'.asmagicbrain'));fs.writeFileSync(path.join(incoming,'.asmagicbrain/private'),'excluded');fs.writeFileSync(path.join(incoming,'.asmb-note'),'excluded');fs.writeFileSync(path.join(incoming,'.DS_Store'),'excluded');
 const before=inventory(f.source),opened=await f.request('open',{path:'README.md'});await f.request('checkpoint',{path:opened.path,baseHash:opened.sourceHash,text:'existing private draft'});
 await f.request('checkpointNew',{draftId:'pending',path:'Incoming/proposed.md',text:'unsaved proposed document'});
 await f.request('createFolder',{path:'destination'});
 const result=await f.import([incoming]);assert.deepEqual(result.importedPaths,['Incoming copy']);assert.equal(result.skippedMetadata,4);assert.deepEqual(result.pathMoves,[]);
 assert.deepEqual(inventory(f.source),before);assert.equal(fs.readFileSync(path.join(f.root,'Incoming copy/docs/note.md'),'utf8'),text);assert.equal(hash(fs.readFileSync(path.join(f.root,'Incoming copy/media.bin'))),hash(binary));assert.equal(fs.statSync(path.join(f.root,'Incoming copy/run.sh')).mode&0o777,0o755);assert.deepEqual(fs.readdirSync(path.join(f.root,'Incoming copy/empty')),[]);assert.equal(fs.readFileSync(path.join(f.root,'Incoming copy/.ordinary'),'utf8'),'preserved dotfile');
 for(const name of ['.git','.asmagicbrain','.asmb-note','.DS_Store'])assert.equal(fs.existsSync(path.join(f.root,'Incoming copy',name)),false);
 assert.equal((await f.request('gitInspect')).head,null);assert.equal((await f.request('open',{path:'README.md'})).draft.text,'existing private draft');assert.equal((await f.service.bootstrap('Workspace')).newDrafts[0].path,'Incoming/proposed.md');
 const first=await f.request('open',{path:'Incoming copy/docs/note.md'});await f.restart();assert.equal((await f.request('open',{path:first.path})).documentId,first.documentId);assert.equal((await f.request('open',{path:'README.md'})).documentId,opened.documentId);assert.equal((await f.request('runtimeStatus')).recoveryRequired,false);assert.deepEqual(inventory(f.source),before);
});

test('multiple dropped basenames keep both copies in the chosen folder without changing an existing dirty file',async t=>{
 const f=await fixture(t);fs.mkdirSync(path.join(f.source,'a'));fs.mkdirSync(path.join(f.source,'b'));fs.writeFileSync(path.join(f.source,'a/report.md'),'first');fs.writeFileSync(path.join(f.source,'b/report.md'),'second');
 const existing=await f.request('create',{path:'target/report.md',text:'existing'});await f.request('checkpoint',{path:existing.path,baseHash:existing.sourceHash,text:'unsaved existing'});
 const result=await f.import([path.join(f.source,'a/report.md'),path.join(f.source,'b/report.md')],'target');assert.deepEqual(result.importedPaths,['target/report copy.md','target/report copy 2.md']);assert.equal(fs.readFileSync(path.join(f.root,'target/report.md'),'utf8'),'existing');assert.equal((await f.request('open',{path:existing.path})).draft.text,'unsaved existing');
 assert.equal(fs.readFileSync(path.join(f.root,'target/report copy.md'),'utf8'),'first');assert.equal(fs.readFileSync(path.join(f.root,'target/report copy 2.md'),'utf8'),'second');
 await assert.rejects(f.import([path.join(f.source,'a/report.md')],'missing'),error=>['PARTIAL','ENOENT'].includes(error.code));assert.equal(fs.existsSync(path.join(f.root,'missing')),false);
});

test('external source admission refuses links, unsupported entries, private storage and excessive combined depth without visible publication',async t=>{
 const f=await fixture(t);fs.writeFileSync(path.join(f.source,'ordinary.md'),'retain');fs.symlinkSync('ordinary.md',path.join(f.source,'link.md'));
 await assert.rejects(f.import([path.join(f.source,'link.md')]),{code:'SYMLINK_UNSUPPORTED'});
 const nested=path.join(f.source,'Linked');fs.mkdirSync(nested);fs.symlinkSync('../ordinary.md',path.join(nested,'nested-link'));await assert.rejects(f.import([nested]),{code:'SYMLINK_UNSUPPORTED'});assert.equal(fs.existsSync(path.join(f.root,'Linked')),false);
 await assert.rejects(f.import([path.join(f.dataRoot,'state/native')]),{code:'PRIVATE_SOURCE_UNSUPPORTED'});
 const deep=path.join(f.source,'deep');fs.mkdirSync(deep);fs.writeFileSync(path.join(deep,'leaf.md'),'retain');const destination=Array.from({length:31},(_,i)=>`d${i}`).join('/');await f.request('createFolder',{path:destination});await assert.rejects(f.import([deep],destination),{code:'INVALID_PATH'});assert.equal(fs.existsSync(path.join(f.root,destination,'deep')),false);
 const metadata=path.join(f.source,'.git');fs.mkdirSync(metadata);fs.writeFileSync(path.join(metadata,'config'),'never imported');await assert.rejects(f.import([metadata]),{code:'NO_IMPORTABLE_FILES'});
 assert.equal(fs.readFileSync(path.join(f.source,'ordinary.md'),'utf8'),'retain');assert.equal((await f.request('runtimeStatus')).recoveryRequired,false);
});

test('prepublication cancellation cleans admitted staging, retains originals/drafts, and leaves native main responsive',async t=>{
 const controller=new AbortController();let armed=false;
 const f=await fixture(t,{externalPhase:point=>{if(armed&&point==='management-before-worker')controller.abort();}});
 const incoming=path.join(f.source,'Cancel');fs.mkdirSync(incoming);for(let i=0;i<20;i++)fs.writeFileSync(path.join(incoming,`file-${i}.bin`),Buffer.alloc(256*1024,i));
 const before=inventory(f.source),opened=await f.request('open',{path:'README.md'});await f.request('checkpoint',{path:opened.path,baseHash:opened.sourceHash,text:'retained while canceling'});
 let ticks=0;const timer=setInterval(()=>{ticks++;},1);armed=true;
 try{await assert.rejects(f.import([incoming],'',controller.signal),{code:'IMPORT_CANCELLED'});}finally{clearInterval(timer);}
 assert(ticks>2,'main event loop should remain responsive during recursive import');assert.deepEqual(inventory(f.source),before);assert.equal(fs.existsSync(path.join(f.root,'Cancel')),false);assert.equal(fs.readdirSync(f.root).some(name=>name.startsWith('.asmb-new-')),false);assert.equal((await f.request('runtimeStatus')).recoveryRequired,false);assert.equal((await f.request('open',{path:opened.path})).draft.text,'retained while canceling');
 await f.restart();assert.equal((await f.request('runtimeStatus')).recoveryRequired,false);
});

test('accepted external imports drain before close and internal copies use the same responsive worker boundary',async t=>{
 const f=await fixture(t),file=path.join(f.source,'large.bin');fs.writeFileSync(file,Buffer.alloc(6*1024*1024,91));const sources=await f.service.prepareExternalFiles([file]);
 const work=f.service.importExternalFiles({repo:'Workspace',destination:'',sources}),closing=f.service.close();await Promise.all([work,closing]);await f.restart();assert.equal(hash(fs.readFileSync(path.join(f.root,'large.bin'))),hash(fs.readFileSync(file)));
 const entry=await f.request('inspectEntry',{path:'large.bin'});let ticks=0;const timer=setInterval(()=>{ticks++;},1);
 try{await f.request('manage',{operation:'copy',items:[{path:'large.bin',newPath:'large copy.bin',token:entry.token}]});}finally{clearInterval(timer);}
 assert(ticks>2);assert.equal(hash(fs.readFileSync(path.join(f.root,'large copy.bin'))),hash(fs.readFileSync(file)));assert.equal((await f.request('gitInspect')).head,null);
});

test('ordinary mid-selection publication failure rolls back only its copies and retains existing data',async t=>{
 const f=await fixture(t,{externalInterruptAt:'management-after-item'});fs.writeFileSync(path.join(f.source,'one.md'),'one');fs.writeFileSync(path.join(f.source,'two.md'),'two');const before=inventory(f.source);
 await assert.rejects(f.import([path.join(f.source,'one.md'),path.join(f.source,'two.md')]),{code:'TEST_INTERRUPTION'});assert.equal(fs.existsSync(path.join(f.root,'one.md')),false);assert.equal(fs.existsSync(path.join(f.root,'two.md')),false);assert.deepEqual(inventory(f.source),before);assert.equal((await f.request('runtimeStatus')).recoveryRequired,false);
});

test('interrupted imported publication remains visible to recovery and completes consistently after restart',async t=>{
 const f=await fixture(t,{externalExitAt:'after-source-write'}),file=path.join(f.source,'published.md');fs.writeFileSync(file,'published source');const before=inventory(f.source);
 await assert.rejects(f.import([file]),{code:'RECOVERY_REQUIRED'});assert.equal((await f.request('runtimeStatus')).recoveryRequired,true);await f.restart();assert.equal((await f.request('runtimeStatus')).recoveryRequired,true);
 const result=await f.request('reconcile');assert.equal(result.status,'completed');assert.equal(fs.readFileSync(path.join(f.root,'published.md'),'utf8'),'published source');assert.deepEqual(inventory(f.source),before);assert.equal((await f.request('runtimeStatus')).recoveryRequired,false);
});

test('interrupted staging with a later-missing external original preserves derived bytes in a recovery hold',async t=>{
 const f=await fixture(t,{externalExitAt:'management-after-staging'}),file=path.join(f.source,'staged.md');fs.writeFileSync(file,'derived bytes retained');
 await assert.rejects(f.import([file]),{code:'RECOVERY_REQUIRED'});const staged=fs.readdirSync(f.root).filter(name=>name.startsWith('.asmb-new-'));assert.equal(staged.length,1);assert.equal(fs.readFileSync(path.join(f.root,staged[0]),'utf8'),'derived bytes retained');
 // Ordinary external relocation after the failed operation; only this fixture.
 fs.renameSync(file,path.join(f.source,'moved-original.md'));await f.restart();await assert.rejects(f.request('reconcile'),{code:'RECOVERY_REQUIRED'});assert.equal((await f.request('runtimeStatus')).recoveryRequired,true);assert.equal(fs.readFileSync(path.join(f.root,staged[0]),'utf8'),'derived bytes retained');assert.equal(fs.readFileSync(path.join(f.source,'moved-original.md'),'utf8'),'derived bytes retained');assert.equal(fs.existsSync(path.join(f.root,'staged.md')),false);
});

test('external tickets are owner-bound, one-use, expiring and expose only names/kinds',async()=>{
 let time=1000;const calls=[],sources=[{path:'/physical/example.md',kind:'file',identity:'1:2'}];
 const registry=createExternalFileTickets({now:()=>time,prepare:async()=>sources,importFiles:async(...args)=>{calls.push(args);return {status:'completed'};}});
 const item=await registry.register(7,['/physical/example.md']);assert.deepEqual(item.entries,[{name:'example.md',kind:'file'}]);assert.equal(JSON.stringify(item).includes('/physical'),false);
 await assert.rejects(registry.consume(8,{repo:'Workspace',destination:'',ticket:item.ticket}),{code:'IMPORT_TICKET_EXPIRED'});
 assert.deepEqual(await registry.consume(7,{repo:'Workspace',destination:'',ticket:item.ticket}),{status:'completed'});assert.deepEqual(calls[0][0],{repo:'Workspace',destination:'',sources});await assert.rejects(registry.consume(7,{repo:'Workspace',destination:'',ticket:item.ticket}),{code:'IMPORT_TICKET_EXPIRED'});
 const expired=await registry.register(7,['/physical/example.md']);time=expired.expiresAt;await assert.rejects(registry.consume(7,{repo:'Workspace',destination:'',ticket:expired.ticket}),{code:'IMPORT_TICKET_EXPIRED'});registry.cancel(7,{ticket:expired.ticket});
});

test('ticket cancellation and owner release abort accepted work without allowing re-use',async()=>{
 let activeSignal;const registry=createExternalFileTickets({prepare:async()=>[{path:'/physical/item',kind:'directory',identity:'1:2'}],importFiles:async(_request,{signal})=>{activeSignal=signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(failure('IMPORT_CANCELLED')),{once:true}));}});
 const item=await registry.register(7,['/physical/item']),work=registry.consume(7,{repo:'Workspace',destination:'',ticket:item.ticket});assert.equal(activeSignal.aborted,false);registry.cancel(7,{ticket:item.ticket});await assert.rejects(work,{code:'IMPORT_CANCELLED'});registry.cancel(7,{ticket:item.ticket});
 const next=await registry.register(7,['/physical/item']),second=registry.consume(7,{repo:'Workspace',destination:'',ticket:next.ticket});registry.releaseOwner(7);await assert.rejects(second,{code:'IMPORT_CANCELLED'});
});
