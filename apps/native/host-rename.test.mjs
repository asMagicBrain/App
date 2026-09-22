import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createNativeService} from './host-service.mjs';
import {createPrivateStore} from '../../packages/desktop-host/src/private-store.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const identity=filename=>{const s=fs.lstatSync(filename);return `${s.dev}:${s.ino}`;};
const author={name:'Repository Rename Fixture',email:'rename@example.invalid'};
const git=(root,...args)=>execFileSync('/usr/bin/git',['--no-pager','-c','core.hooksPath=/dev/null','-C',root,...args],{env:{PATH:'/usr/bin:/bin',TMPDIR:process.env.TMPDIR,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'},maxBuffer:16*1024*1024});
function inventory(root){
 const result=[];function walk(directory,relative=''){for(const name of fs.readdirSync(directory).sort()){
  const target=path.join(directory,name),key=relative?`${relative}/${name}`:name,s=fs.lstatSync(target);
  assert.equal(s.isSymbolicLink(),false);result.push({path:key,type:s.isDirectory()?'directory':'file',mode:s.mode&0o777,identity:identity(target),...(s.isFile()?{size:s.size,sha256:hash(fs.readFileSync(target))}:{})});if(s.isDirectory())walk(target,key);
 }}walk(root);return result;
}
async function fixture(t,hooks={}){
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'asmb-native-rename-')),dataRoot=path.join(parent,'profile');let service=await createNativeService({dataRoot,hooks});
 t.after(async()=>{try{await service?.close();}finally{fs.rmSync(parent,{recursive:true,force:true});}});
 return {parent,dataRoot,get service(){return service;},root:repo=>path.join(dataRoot,'workspaces/asMagicBrain',repo),private:repo=>path.join(dataRoot,'state/native',repo),request:(repo,operation,args={})=>service.request({repo,operation,args}),restart:async()=>{await service.close();service=await createNativeService({dataRoot});},stop:()=>service.close()};
}
function archive(parent){
 const root=path.join(parent,'archive-source');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'README.md'),'# Original import\r\n');fs.writeFileSync(path.join(root,'asset.bin'),Buffer.alloc(2*1024*1024+19,173));
 git(root,'init','--initial-branch=main','--template=');git(root,'add','.');git(root,'-c',`user.name=${author.name}`,'-c',`user.email=${author.email}`,'commit','--quiet','-m','Fixture');
 return git(root,'archive','--format=zip','--prefix=fixture-main/','HEAD');
}
async function populate(f,repo){
 await f.request(repo,'gitInspect');
 const opened=await f.request(repo,'open',{path:'README.md'});await f.request(repo,'checkpoint',{path:opened.path,baseHash:opened.sourceHash,text:'private unsaved README'});
 await f.request(repo,'checkpointNew',{draftId:'future-file',path:'notes/not-saved.md',text:'private unsaved new file'});
 const trash=await f.request(repo,'create',{path:'trash/note.md',text:'saved trash bytes'});await f.request(repo,'checkpoint',{path:trash.path,baseHash:trash.sourceHash,text:'private trash draft'});
 const entry=await f.request(repo,'inspectEntry',{path:'trash'}),result=await f.request(repo,'manage',{operation:'trash',items:[{path:'trash',token:entry.token}]});
 return {opened,trash,trashId:result.items[0].trashId};
}
async function retained(f,repo,before){
 const opened=await f.request(repo,'open',{path:'README.md'});assert.equal(opened.documentId,before.opened.documentId);assert.equal(opened.sourceHash,before.opened.sourceHash);assert.equal(opened.draft.text,'private unsaved README');
 assert.deepEqual((await f.service.bootstrap(repo)).newDrafts,[{draftId:'future-file',path:'notes/not-saved.md',text:'private unsaved new file'}]);assert.equal(fs.existsSync(path.join(f.root(repo),'notes/not-saved.md')),false);
 assert.equal((await f.request(repo,'listTrash'))[0].trashId,before.trashId);
}

test('imported repository rename preserves every source/Git inode and byte, drafts, Trash, history and subsequent Save/commit across restart',async t=>{
 const f=await fixture(t);await f.service.importArchive({name:'Imported',bytes:archive(f.parent)});const state=await populate(f,'Imported');
 const source=inventory(f.root('Imported')),privateState=inventory(f.private('Imported')),rootId=identity(f.root('Imported')),head=git(f.root('Imported'),'rev-parse','HEAD').toString();
 const beforeCatalog=(await f.service.catalog()).repositories,workspaceId=beforeCatalog.find(item=>item.name==='Workspace').stableId,repoId=beforeCatalog.find(item=>item.name==='Imported').stableId;assert.match(workspaceId,/^[a-f0-9]{64}$/);assert.match(repoId,/^[a-f0-9]{64}$/);assert.notEqual(repoId,workspaceId);
 const renamed=await f.service.renameRepository({repository:'Imported',name:'Renamed'});
 assert.deepEqual(renamed,{repository:'Renamed',previousName:'Imported',organization:'asMagicBrain',defaultRepository:'Workspace',repositories:[{name:'Workspace',stableId:workspaceId,privateRepo:true},{name:'Renamed',stableId:repoId,privateRepo:true}]});
 assert.equal(fs.existsSync(f.root('Imported')),false);assert.equal(identity(f.root('Renamed')),rootId);assert.deepEqual(inventory(f.root('Renamed')),source);assert.deepEqual(inventory(f.private('Imported')),privateState);assert.equal(fs.existsSync(f.private('Renamed')),false);
 await retained(f,'Renamed',state);await assert.rejects(f.service.bootstrap('Imported'),{code:'UNKNOWN_REPOSITORY'});await f.restart();await retained(f,'Renamed',state);assert.equal((await f.service.catalog()).repositories.find(item=>item.name==='Renamed').stableId,repoId);
 assert.equal(git(f.root('Renamed'),'rev-parse','HEAD').toString(),head);assert.equal((await f.service.read({repo:'Renamed',path:'README.md',ref:'refs/heads/main'})).content,state.opened.text);
 await f.request('Renamed','restore',{trashId:state.trashId});const restored=await f.request('Renamed','open',{path:'trash/note.md'});assert.equal(restored.documentId,state.trash.documentId);assert.equal(restored.draft.text,'private trash draft');
 const saved=await f.request('Renamed','save',{path:'README.md',baseHash:state.opened.sourceHash,text:'# Saved after repository rename\r\n'});assert.equal(saved.documentId,state.opened.documentId);
 const review=await f.request('Renamed','gitReview',{paths:['README.md']});await f.request('Renamed','gitCommit',{expectedHead:review.expectedHead,expectedIndexHash:review.expectedIndexHash,files:review.files.map(({path,expectedSourceHash,expectedSourceMode})=>({path,expectedSourceHash,expectedSourceMode})),message:'After rename',author});
 assert.equal(git(f.root('Renamed'),'show','HEAD:README.md').toString(),saved.text);assert.equal((await f.request('Renamed','open',{path:'trash/note.md'})).draft.text,'private trash draft');
 await f.service.renameRepository({repository:'Renamed',name:'Imported'});await f.restart();assert.deepEqual((await f.service.catalog()).repositories.map(r=>r.name),['Workspace','Imported']);assert.equal((await f.service.catalog()).repositories.find(item=>item.name==='Imported').stableId,repoId);assert.equal((await f.request('Imported','open',{path:'README.md'})).documentId,state.opened.documentId);
});

test('default Workspace rename remains default across restart without reseeding and shares author/appearance preferences',async t=>{
 const f=await fixture(t),state=await populate(f,'Workspace'),before=inventory(f.root('Workspace'));
 const workspaceId=(await f.service.catalog()).repositories[0].stableId;assert.match(workspaceId,/^[a-f0-9]{64}$/);
 const prefs=await f.request('Workspace','getCommitPreferences');await f.request('Workspace','setCommitPreferences',{expectedRevision:prefs.revision,mode:'asmagicbrain',asmagicbrain:author,github:{name:'',email:''}});await f.service.setAppearance({themeId:'dark-default',hideUnavailable:true});
 await f.service.renameRepository({repository:'Workspace',name:'My-Workspace'});assert.deepEqual(inventory(f.root('My-Workspace')),before);await f.restart();
 const catalog=await f.service.catalog();assert.equal(catalog.defaultRepository,'My-Workspace');assert.deepEqual(catalog.repositories,[{name:'My-Workspace',stableId:workspaceId,privateRepo:true}]);assert.equal(fs.existsSync(f.root('Workspace')),false);await retained(f,'My-Workspace',state);
 assert.deepEqual((await f.request('My-Workspace','getCommitPreferences')).asmagicbrain,author);assert.deepEqual(await f.service.getAppearance(),{themeId:'dark-default',hideUnavailable:true});assert.equal((await f.request('My-Workspace','gitInspect')).head,null);
 await f.service.renameRepository({repository:'My-Workspace',name:'My-Workspace'});assert.deepEqual(inventory(f.root('My-Workspace')),before);
});

test('reusing a renamed repository name allocates separate state and never inherits its drafts',async t=>{
 const f=await fixture(t),state=await populate(f,'Workspace'),originalId=(await f.service.catalog()).repositories[0].stableId;await f.service.renameRepository({repository:'Workspace',name:'Personal'});
 await f.service.importArchive({name:'Workspace',bytes:archive(f.parent)});const imported=await f.request('Workspace','open',{path:'README.md'});
 const rows=(await f.service.catalog()).repositories;assert.equal(rows.find(item=>item.name==='Personal').stableId,originalId);const newId=rows.find(item=>item.name==='Workspace').stableId;assert.match(newId,/^[a-f0-9]{64}$/);assert.notEqual(newId,originalId,'Reusing a folder name cannot inherit the previous repository identity');
 assert.notEqual(imported.documentId,state.opened.documentId);assert.equal(imported.draft,null);assert.deepEqual((await f.service.bootstrap('Workspace')).newDrafts,[]);assert.deepEqual(await f.request('Workspace','listTrash'),[]);
 await f.restart();await retained(f,'Personal',state);assert.equal((await f.request('Workspace','open',{path:'README.md'})).documentId,imported.documentId);assert.equal((await f.service.catalog()).defaultRepository,'Personal');
});

test('collisions, invalid names and active Git work refuse repository rename before source or private effects',async t=>{
 const f=await fixture(t);await f.request('Workspace','open',{path:'README.md'});await f.service.bootstrap('Workspace');
 fs.mkdirSync(f.root('Existing'));fs.writeFileSync(path.join(f.root('Existing'),'keep.txt'),'other bytes');const before=inventory(f.root('Workspace')),state=inventory(f.private('Workspace'));
 for(const name of ['Existing','workspace'])await assert.rejects(f.service.renameRepository({repository:'Workspace',name}),{code:'NAME_EXISTS'});
 for(const name of ['new name','CON','trailing.'])await assert.rejects(f.service.renameRepository({repository:'Workspace',name}),{code:'INVALID_REPOSITORY_NAME'});
 await assert.rejects(f.service.renameRepository({repository:'Missing',name:'Next'}),{code:'UNKNOWN_REPOSITORY'});
 fs.writeFileSync(path.join(f.root('Workspace'),'.git/index.lock'),'held by ordinary Git operation');await assert.rejects(f.service.renameRepository({repository:'Workspace',name:'Next'}),{code:'GIT_BUSY'});fs.unlinkSync(path.join(f.root('Workspace'),'.git/index.lock'));
 assert.deepEqual(inventory(f.root('Workspace')),before);assert.deepEqual(inventory(f.private('Workspace')),state);assert.equal(fs.existsSync(f.root('Next')),false);assert.equal(fs.readFileSync(path.join(f.root('Existing'),'keep.txt'),'utf8'),'other bytes');
});

test('durable repository rename phases resume after interruption without changing source, Git or draft identity',async t=>{
 for(const phase of ['rename-intent','rename-reserved','rename-moved','rename-cataloged','rename-completed'])await t.test(phase,async t=>{
  let armed=false;const f=await fixture(t,{at:point=>{if(armed&&point===phase){armed=false;throw Object.assign(new Error('simulated interrupted operation'),{code:'TEST_INTERRUPTION'});}}});
  await f.service.importArchive({name:'Imported',bytes:archive(f.parent)});const state=await populate(f,'Imported'),before=inventory(f.root('Imported'));armed=true;
  await assert.rejects(f.service.renameRepository({repository:'Imported',name:'Recovered'}),{code:'RECOVERY_REQUIRED'});await assert.rejects(f.service.catalog(),{code:'RECOVERY_REQUIRED'});
  await f.restart();assert.equal(fs.existsSync(f.root('Imported')),false);assert.deepEqual(inventory(f.root('Recovered')),before);await retained(f,'Recovered',state);assert.deepEqual((await f.service.catalog()).repositories.map(r=>r.name),['Workspace','Recovered']);
 });
});

test('an interruption before destination receipt preserves both folders and holds instead of adopting unknown storage',async t=>{
 let armed=false;const f=await fixture(t,{at:point=>{if(armed&&point==='rename-reserved-before-receipt'){armed=false;throw new Error('simulated receipt failure');}}});const state=await populate(f,'Workspace'),before=inventory(f.root('Workspace'));armed=true;
 await assert.rejects(f.service.renameRepository({repository:'Workspace',name:'Held'}),{code:'RECOVERY_REQUIRED'});assert.deepEqual(inventory(f.root('Workspace')),before);assert.deepEqual(fs.readdirSync(f.root('Held')),[]);await f.stop();
 await assert.rejects(createNativeService({dataRoot:f.dataRoot}),{code:'RECOVERY_REQUIRED'});assert.deepEqual(inventory(f.root('Workspace')),before);assert.equal(fs.existsSync(f.private('Workspace')),true);assert(state.opened.documentId);
});

test('existing v1 native profiles gain rename bindings without rewriting private runtime records',async t=>{
 const f=await fixture(t),state=await populate(f,'Workspace');await f.stop();
 const bindingHash=hash(JSON.stringify({kind:'native-profile',schemaVersion:1,path:f.dataRoot,identity:identity(f.dataRoot),uid:process.getuid()}));
 const store=createPrivateStore({privateRoot:path.join(f.dataRoot,'state/native/.asmb-host'),bindingHash}),scan=store.scan(),latest=scan.events.at(-1).payload;
 const {workspaceName,repositoryBindings,pendingRename,...legacy}=latest;store.append(scan,'draft',{...legacy,schemaVersion:1});
 const before=inventory(f.private('Workspace'));await f.restart();await f.service.renameRepository({repository:'Workspace',name:'Existing-Profile'});assert.deepEqual(inventory(f.private('Workspace')),before);await retained(f,'Existing-Profile',state);await f.restart();await retained(f,'Existing-Profile',state);
});
