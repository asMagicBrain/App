import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createNativeService} from './host-service.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const id=p=>{const s=fs.lstatSync(p);return `${s.dev}:${s.ino}`;};
const git=(p,...args)=>execFileSync('/usr/bin/git',['--no-pager','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',p,...args],{env:{PATH:'/usr/bin:/bin',TMPDIR:process.env.TMPDIR,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'}}).toString().trim();
function inventory(root){const rows=[];function walk(p,rel=''){for(const name of fs.readdirSync(p).sort()){const file=path.join(p,name),relative=rel?rel+'/'+name:name,s=fs.lstatSync(file);assert(!s.isSymbolicLink());rows.push({path:relative,mode:s.mode&0o777,type:s.isDirectory()?'directory':'file',...(s.isFile()?{bytes:s.size,sha256:sha(fs.readFileSync(file))}:{})});if(s.isDirectory())walk(file,relative);}}walk(root);return rows;}
async function fixture(t,hooks={}){
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'repository-management-')),dataRoot=path.join(parent,'data');let service=await createNativeService({dataRoot,hooks});
 t.after(async()=>{await service?.close();fs.rmSync(parent,{recursive:true,force:true});});
 return {parent,dataRoot,get service(){return service;},root:n=>path.join(dataRoot,'workspaces/asMagicBrain',n),private:n=>path.join(dataRoot,'state/native',n),request:(repo,operation,args={})=>service.request({repo,operation,args}),stop:()=>service.close(),restart:async()=>{await service.close();service=await createNativeService({dataRoot});}};
}
async function populate(f,name='Original'){
 await f.service.createRepository({name,requestId:randomUUID()});await f.request(name,'create',{path:'README.md',text:'# Saved source\r\n'});
 fs.mkdirSync(path.join(f.root(name),'assets'));fs.writeFileSync(path.join(f.root(name),'assets/binary.dat'),Buffer.alloc(1024*1024+13,141),{mode:0o640});
 git(f.root(name),'add','.');git(f.root(name),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Saved history');git(f.root(name),'tag','retained-tag');
 const opened=await f.request(name,'open',{path:'README.md'});await f.request(name,'checkpoint',{path:'README.md',baseHash:opened.sourceHash,text:'Unsaved original draft'});await f.request(name,'checkpointNew',{draftId:'future',path:'new.md',text:'Unsaved new file'});
 const trash=await f.request(name,'create',{path:'trash.md',text:'saved removed file'});await f.request(name,'checkpoint',{path:'trash.md',baseHash:trash.sourceHash,text:'private removed draft'});const token=await f.request(name,'inspectEntry',{path:'trash.md'});const trashed=await f.request(name,'manage',{operation:'trash',items:[{path:'trash.md',token:token.token}]});
 await f.service.setRepositoryPinned({repo:name,pinned:true});await f.request(name,'gitInspect');return {opened,trash,trashId:trashed.items[0].trashId};
}
async function retained(f,name,state){const opened=await f.request(name,'open',{path:'README.md'});assert.equal(opened.documentId,state.opened.documentId);assert.equal(opened.draft.text,'Unsaved original draft');assert.deepEqual((await f.service.bootstrap(name)).newDrafts,[{draftId:'future',path:'new.md',text:'Unsaved new file'}]);assert.equal((await f.request(name,'listTrash'))[0].trashId,state.trashId);assert((await f.service.getRepositoryPins()).pinnedRepositories.includes(name));}

test('duplicate retains every saved/Git byte and mode with independent identity, no private drafts/Trash or GitHub provenance, retry and restart',async t=>{
 const f=await fixture(t),state=await populate(f),before=inventory(f.root('Original')),privateBefore=inventory(f.private('Original')),head=git(f.root('Original'),'rev-parse','HEAD'),requestId=randomUUID();
 const result=await f.service.duplicateRepository({repository:'Original',name:'Copy',requestId});assert.equal(result.repository,'Copy');assert.equal(result.sourceRepository,'Original');assert.deepEqual(inventory(f.root('Copy')),before);assert.notEqual(id(f.root('Copy')),id(f.root('Original')));assert.equal(git(f.root('Copy'),'rev-parse','HEAD'),head);assert.equal(git(f.root('Copy'),'rev-parse','retained-tag'),head);
 assert.deepEqual(inventory(f.root('Original')),before);assert.deepEqual(inventory(f.private('Original')),privateBefore);await retained(f,'Original',state);
 const copy=await f.request('Copy','open',{path:'README.md'});assert.notEqual(copy.documentId,state.opened.documentId);assert.equal(copy.draft,null);assert.deepEqual((await f.service.bootstrap('Copy')).newDrafts,[]);assert.deepEqual(await f.request('Copy','listTrash'),[]);assert.equal((await f.service.getRepositoryUpdates({repo:'Copy'})).eligible,false);
 assert.equal((await f.service.duplicateRepository({repository:'Original',name:'Copy',requestId})).repository,'Copy');await f.restart();await retained(f,'Original',state);assert.equal((await f.request('Copy','open',{path:'README.md'})).draft,null);
 await f.request('Copy','save',{path:'README.md',baseHash:copy.sourceHash,text:'Independent copy edit'});assert.deepEqual(inventory(f.root('Original')),before);
});

test('repository Trash and alternate-name restore preserve source inode, Git, all private state and stable pin, while reused name gets new state',async t=>{
 const f=await fixture(t),state=await populate(f),before=inventory(f.root('Original')),privateBefore=inventory(f.private('Original')),rootId=id(f.root('Original')),requestId=randomUUID();
 const result=await f.service.trashRepository({repository:'Original',requestId});assert.equal(result.trashId,requestId);assert(!result.repositories.some(r=>r.name==='Original'));assert(!fs.existsSync(f.root('Original')));const hidden=f.root('.asmb-repository-trash-'+requestId);assert.equal(id(hidden),rootId);assert.deepEqual(inventory(hidden),before);assert.deepEqual(inventory(f.private('Original')),privateBefore);assert.deepEqual((await f.service.getRepositoryPins()).pinnedRepositories,['Workspace']);
 assert.equal((await f.service.trashRepository({repository:'Original',requestId})).trashId,requestId);await f.restart();assert.equal((await f.service.listTrashedRepositories())[0].name,'Original');
 await f.service.createRepository({name:'Original',requestId:randomUUID()});await assert.rejects(f.service.trashRepository({repository:'Original',requestId}),{code:'REQUEST_CONFLICT'});assert.deepEqual((await f.service.bootstrap('Original')).newDrafts,[]);await assert.rejects(f.service.restoreRepository({trashId:requestId,name:'Original'}),{code:'NAME_EXISTS'});
 const restored=await f.service.restoreRepository({trashId:requestId,name:'Restored'});assert.equal(restored.repository,'Restored');assert.equal(id(f.root('Restored')),rootId);assert.deepEqual(inventory(f.root('Restored')),before);await retained(f,'Restored',state);assert.deepEqual(await f.service.listTrashedRepositories(),[]);await f.restart();await retained(f,'Restored',state);
 await f.request('Restored','restore',{trashId:state.trashId});assert.equal((await f.request('Restored','open',{path:'trash.md'})).draft.text,'private removed draft');assert.equal((await f.service.restoreRepository({trashId:requestId,name:'Restored'})).repository,'Restored');
});

test('default protection follows Workspace rename; collisions, invalid requests, busy Git, links and outside destinations are rejected',async t=>{
 const f=await fixture(t);await f.service.renameRepository({repository:'Workspace',name:'Personal'});await assert.rejects(f.service.trashRepository({repository:'Personal',requestId:randomUUID()}),{code:'DEFAULT_REPOSITORY_PROTECTED'});await populate(f);
 for(const name of ['../escape','A/B','bad name'])await assert.rejects(f.service.duplicateRepository({repository:'Original',name,requestId:randomUUID()}),{code:'INVALID_REPOSITORY_NAME'});
 await assert.rejects(f.service.duplicateRepository({repository:'Original',name:'original',requestId:randomUUID()}),{code:'NAME_EXISTS'});
 fs.writeFileSync(path.join(f.root('Original'),'.git/index.lock'),'busy');await assert.rejects(f.service.trashRepository({repository:'Original',requestId:randomUUID()}),{code:'GIT_BUSY'});fs.unlinkSync(path.join(f.root('Original'),'.git/index.lock'));
 const outside=path.join(f.parent,'outside');fs.writeFileSync(outside,'outside bytes');fs.symlinkSync(outside,path.join(f.root('Original'),'link'));await assert.rejects(f.service.duplicateRepository({repository:'Original',name:'Unsafe',requestId:randomUUID()}),{code:'UNSAFE_REPOSITORY'});assert.equal(fs.readFileSync(outside,'utf8'),'outside bytes');assert(!fs.existsSync(f.root('Unsafe')));
});

test('each durable Trash and restore phase recovers on restart without changing original bytes or draft identity',async t=>{
 for(const operation of ['trash','restore'])for(const phase of ['intent','reserved','moved','cataloged','bound','completed'])await t.test(operation+'-'+phase,async t=>{
  let armed=false;const f=await fixture(t,{at:point=>{if(armed&&point===`repository-${operation}-${phase}`){armed=false;throw Object.assign(new Error('interrupted'),{code:'TEST_INTERRUPTION'});}}}),state=await populate(f),before=inventory(f.root('Original')),rootId=id(f.root('Original')),requestId=randomUUID();
  if(operation==='restore')await f.service.trashRepository({repository:'Original',requestId});armed=true;
  await assert.rejects(operation==='trash'?f.service.trashRepository({repository:'Original',requestId}):f.service.restoreRepository({trashId:requestId,name:'Restored'}),{code:'RECOVERY_REQUIRED'});await f.restart();
  if(operation==='trash')await f.service.restoreRepository({trashId:requestId,name:'Restored'});assert.equal(id(f.root('Restored')),rootId);assert.deepEqual(inventory(f.root('Restored')),before);await retained(f,'Restored',state);
 });
});

test('unrecorded repository Trash reservation is held for recovery without deleting either directory',async t=>{
 let armed=false;const f=await fixture(t,{at:p=>{if(armed&&p==='repository-trash-reserved-before-receipt'){armed=false;throw new Error('interrupted');}}});await populate(f);const before=inventory(f.root('Original')),requestId=randomUUID();armed=true;await assert.rejects(f.service.trashRepository({repository:'Original',requestId}),{code:'RECOVERY_REQUIRED'});await f.stop();await assert.rejects(createNativeService({dataRoot:f.dataRoot}),{code:'RECOVERY_REQUIRED'});assert.deepEqual(inventory(f.root('Original')),before);assert.deepEqual(fs.readdirSync(f.root('.asmb-repository-trash-'+requestId)),[]);
});


test('duplicate retry binds source identity and accepts a managed source rename; unsafe metadata and private-source trees are rejected',async t=>{
 const f=await fixture(t);await populate(f);const requestId=randomUUID();await f.service.duplicateRepository({repository:'Original',name:'Copy',requestId});
 await assert.rejects(f.service.duplicateRepository({repository:'Workspace',name:'Copy',requestId}),{code:'REQUEST_CONFLICT'});await f.service.renameRepository({repository:'Original',name:'Renamed'});assert.equal((await f.service.duplicateRepository({repository:'Renamed',name:'Copy',requestId})).repository,'Copy');
 const root=f.root('Renamed');
 for(const relative of ['.asmb-private/data','.git/hooks/pre-commit','.git/objects/info/alternates']){
  const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'must not be copied');
  await assert.rejects(f.service.duplicateRepository({repository:'Renamed',name:'Rejected',requestId:randomUUID()}),error=>['PRIVATE_SOURCE_UNSUPPORTED','UNSUPPORTED_GIT_DIRECTORY'].includes(error.code));assert(!fs.existsSync(f.root('Rejected')));fs.unlinkSync(file);if(relative.startsWith('.asmb-'))fs.rmdirSync(path.dirname(file));
 }
});

test('durable duplicate publication retries after interruption and keeps original private state separate',async t=>{
 for(const phase of ['ready','reserved','published','cataloged'])await t.test(phase,async t=>{
  let armed=false;const f=await fixture(t,{at:p=>{if(armed&&p===`duplicate-${phase}`){armed=false;throw Object.assign(new Error('interrupted'),{code:'TEST_INTERRUPTION'});}}}),state=await populate(f),source=inventory(f.root('Original')),requestId=randomUUID();armed=true;
  await assert.rejects(f.service.duplicateRepository({repository:'Original',name:'Copy',requestId}));await f.restart();assert.equal((await f.service.duplicateRepository({repository:'Original',name:'Copy',requestId})).repository,'Copy');assert.deepEqual(inventory(f.root('Copy')),source);await retained(f,'Original',state);assert.deepEqual((await f.service.bootstrap('Copy')).newDrafts,[]);
 });
});
