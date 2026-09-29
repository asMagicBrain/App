import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createNativeService} from './host-service.mjs';

function fixture(t){
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'asmb-native-service-'));
 const closers=[];t.after(async()=>{try{for(const close of closers)await close();}finally{fs.rmSync(parent,{recursive:true,force:true});}});
 return {parent,after:close=>closers.push(close),dataRoot:path.join(parent,'profile'),source:path.join(parent,'profile/workspaces/asMagicBrain/Workspace')};
}
const request=(service,operation,args={})=>service.request({repo:'Workspace',operation,args});
const git=(root,...args)=>execFileSync('/usr/bin/git',['-C',root,...args],{env:{PATH:'/usr/bin:/bin',TMPDIR:process.env.TMPDIR,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},encoding:'utf8'}).trim();
const hash=value=>Buffer.from(value).toString('hex');

test('fresh native profile creates only Workspace and unborn main without an author',async t=>{
 const f=fixture(t),service=await createNativeService(f);f.after(()=>service.close());
 const catalog=await service.catalog();assert.match(catalog.repositories[0].stableId,/^[a-f0-9]{64}$/);assert.deepEqual(catalog.repositories.map(({stableId,...entry})=>entry),[{name:'Workspace',privateRepo:true}]);assert.equal(catalog.organization,'asMagicBrain');assert.equal('capability' in catalog,false);
 const home=await service.read({repo:'Workspace'});assert.equal(home.type,'directory');assert.equal(home.branch,'main');assert.equal(home.commit,null);assert.equal(home.commitCount,0);assert.equal(home.readmePath,'README.md');assert.match(home.readme,/^# Workspace/);
 assert.deepEqual(home.entries.map(e=>e.name),['README.md']);assert.deepEqual(await service.bootstrap('Workspace'),{local:true,newDrafts:[]});
 const inspect=await request(service,'gitInspect');assert.equal(inspect.initialized,true);assert.equal(inspect.head,null);
 assert.doesNotMatch(fs.readFileSync(path.join(f.source,'.git/config'),'utf8'),/\[user\]|name\s*=|email\s*=/);
 assert.equal(git(f.source,'symbolic-ref','--short','HEAD'),'main');
 assert.deepEqual(await service.getAppearance(),{themeId:'light-default',hideUnavailable:false});
 assert.deepEqual((await request(service,'getCommitPreferences')).asmagicbrain,{name:'',email:''});
});

test('local Save preserves bytes and document identity; private drafts survive restart independently of Git',async t=>{
 const f=fixture(t);let service=await createNativeService(f);f.after(()=>service.close());
 const first=await request(service,'open',{path:'README.md'}),text='\ufeff# 文本\r\nLine two\r\n';
 const saved=await request(service,'save',{path:first.path,baseHash:first.sourceHash,text});
 assert.equal(hash(fs.readFileSync(path.join(f.source,'README.md'))),hash(text));assert.equal(saved.documentId,first.documentId);assert.equal((await request(service,'gitInspect')).head,null);
 await request(service,'checkpoint',{path:saved.path,baseHash:saved.sourceHash,text:text+'unsaved\r\n'});
 await request(service,'checkpointNew',{draftId:'new-draft',path:'notes/new.md',text:'private new document'});
 await service.close();service=await createNativeService(f);
 const reopened=await request(service,'open',{path:'README.md'});assert.equal(reopened.documentId,first.documentId);assert.equal(reopened.text,text);assert.equal(reopened.draft.text,text+'unsaved\r\n');assert.equal(fs.existsSync(path.join(f.source,'notes/new.md')),false);
 assert.deepEqual((await service.bootstrap('Workspace')).newDrafts,[{draftId:'new-draft',path:'notes/new.md',text:'private new document'}]);
 assert.equal((await service.read({repo:'Workspace',path:'README.md'})).content,text);
 await assert.rejects(request(service,'save',{path:'README.md',baseHash:first.sourceHash,text:'stale'}),{code:'CONFLICT'});
 assert.equal(hash(fs.readFileSync(path.join(f.source,'README.md'))),hash(text));
});

test('appearance and user-entered author preferences persist with validation and CAS',async t=>{
 const f=fixture(t);let service=await createNativeService(f);f.after(()=>service.close());
 for(const invalid of [{themeId:'unknown',hideUnavailable:true},{themeId:'dark',hideUnavailable:'yes'},{themeId:null,hideUnavailable:true,path:'/elsewhere'}])await assert.rejects(service.setAppearance(invalid),{code:'INVALID_APPEARANCE'});
 const preference=await request(service,'getCommitPreferences');
 const set={expectedRevision:preference.revision,mode:'github',asmagicbrain:{name:'',email:''},github:{name:'Fixture Writer',email:'123+fixture@users.noreply.github.com'}};
 await request(service,'setCommitPreferences',set);await assert.rejects(request(service,'setCommitPreferences',set),{code:'CONFLICT'});
 await service.setAppearance({themeId:'dark-dimmed',hideUnavailable:false});await service.close();service=await createNativeService(f);
 assert.deepEqual(await service.getAppearance(),{themeId:'dark-dimmed',hideUnavailable:false});assert.equal((await request(service,'getCommitPreferences')).github.name,'Fixture Writer');
 // Native host shares the existing exact author dispatch requirement. Preferences
 // do not silently substitute the explicit author in a reviewed commit request.
 await assert.rejects(request(service,'gitCommit',{expectedHead:null,expectedIndexHash:null,files:[],message:'no author',author:{name:'',email:''}}),{code:'INVALID_AUTHOR'});
});

test('queued work is detached, serialized and drained before closing, and one profile has one owner',async t=>{
 const f=fixture(t),service=await createNativeService(f);
 await assert.rejects(createNativeService(f),{code:'PROFILE_IN_USE'});
 const message={repo:'Workspace',operation:'create',args:{path:'queued.md',text:'accepted'}};
 const created=service.request(message);message.args.text='later caller mutation';
 const appearance=service.setAppearance({themeId:'light',hideUnavailable:false});const closing=service.close();
 await assert.rejects(request(service,'discover'),{code:'SERVICE_CLOSED'});await Promise.all([created,appearance,service.drain(),closing]);await service.close();
 assert.equal(fs.readFileSync(path.join(f.source,'queued.md'),'utf8'),'accepted');
 const reopened=await createNativeService(f);f.after(()=>reopened.close());assert.deepEqual(await reopened.getAppearance(),{themeId:'light',hideUnavailable:false});
});

test('folder move and Trash retain saved-file draft identity through restart and restore',async t=>{
 const f=fixture(t);let service=await createNativeService(f);f.after(()=>service.close());
 const opened=await request(service,'create',{path:'notes/entry.md',text:'source'});await request(service,'checkpoint',{path:opened.path,baseHash:opened.sourceHash,text:'unsaved'});
 let entry=await request(service,'inspectEntry',{path:'notes'});
 const moved=await request(service,'manage',{operation:'move',items:[{path:'notes',newPath:'moved',token:entry.token}]});assert.deepEqual(moved.pathMoves,[{from:'notes',to:'moved'}]);
 entry=await request(service,'inspectEntry',{path:'moved'});const trashed=await request(service,'manage',{operation:'trash',items:[{path:'moved',token:entry.token}]});
 await service.close();service=await createNativeService(f);const trash=await request(service,'listTrash');assert.equal(trash.length,1);
 await request(service,'restore',{trashId:trashed.items[0].trashId});const restored=await request(service,'open',{path:'moved/entry.md'});
 assert.equal(restored.documentId,opened.documentId);assert.equal(restored.text,'source');assert.equal(restored.draft.text,'unsaved');assert.deepEqual(await request(service,'listTrash'),[]);
});

test('ZIP import registers a byte-preserving repository with fresh history across restart',async t=>{
 const f=fixture(t),archiveRoot=path.join(f.parent,'zip-source');fs.mkdirSync(archiveRoot);
 git(archiveRoot,'init','--initial-branch=main','--quiet');fs.mkdirSync(path.join(archiveRoot,'docs'));
 fs.writeFileSync(path.join(archiveRoot,'docs/note.md'),'\ufeff# Imported\r\n');const binary=Buffer.from([0,255,1,128,10]);fs.writeFileSync(path.join(archiveRoot,'asset.bin'),binary);
 git(archiveRoot,'add','.');git(archiveRoot,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Fixture source history');
 const bytes=execFileSync('/usr/bin/git',['-C',archiveRoot,'archive','--format=zip','--prefix=example-main/','HEAD']);
 let service=await createNativeService(f);f.after(()=>service.close());const imported=await service.importArchive({name:'Imported',bytes:new Uint8Array(bytes).buffer});
 assert.equal(imported.name,'Imported');assert.equal(imported.files,2);assert.deepEqual(fs.readFileSync(path.join(f.dataRoot,'workspaces/asMagicBrain/Imported/asset.bin')),binary);
 await service.close();service=await createNativeService(f);assert.deepEqual((await service.catalog()).repositories.map(r=>r.name),['Workspace','Imported']);
 const snapshot=await service.read({repo:'Imported',path:'docs/note.md'});assert.equal(snapshot.content,'\ufeff# Imported\r\n');assert.equal(snapshot.commitCount,1);assert.notEqual(snapshot.commit.message,'Fixture source history');
 await assert.rejects(service.importArchive({name:'Imported',bytes}),{code:'NAME_EXISTS'});
 assert.equal(fs.readdirSync(path.join(f.dataRoot,'workspaces/asMagicBrain/.asmb-catalog')).some(name=>name.startsWith('upload-')),false);
});

test('invalid requests and unexpected existing profiles preserve all files',async t=>{
 const f=fixture(t);fs.mkdirSync(f.dataRoot,{mode:0o700});fs.writeFileSync(path.join(f.dataRoot,'existing.txt'),'retain');
 await assert.rejects(createNativeService(f),{code:'RECOVERY_REQUIRED'});assert.equal(fs.readFileSync(path.join(f.dataRoot,'existing.txt'),'utf8'),'retain');assert.deepEqual(fs.readdirSync(f.dataRoot),['existing.txt']);
 const other=path.join(f.parent,'valid'),service=await createNativeService({dataRoot:other});f.after(()=>service.close());
 for(const invalid of [{repo:'Workspace',operation:'create',args:{path:'../outside',text:'bad'}},{repo:'Other',operation:'discover',args:{}},{repo:'Workspace',operation:'execute',args:{}},{repo:'Workspace',operation:'discover',args:{},root:f.parent}])await assert.rejects(service.request(invalid));
 for(const invalid of [{repo:'Workspace',path:'.git/config'},{repo:'Workspace',path:'../outside'},{repo:'Workspace',path:null},{repo:'Workspace',path:'',ref:'HEAD'},{repo:'Workspace',path:'',root:f.parent}])await assert.rejects(service.read(invalid));
 assert.deepEqual((await service.read({repo:'Workspace'})).entries.map(e=>e.name),['README.md']);
});

test('replaced repository or damaged host state is held without reseeding source bytes',async t=>{
 const f=fixture(t);let service=await createNativeService(f);await service.close();
 const original=path.join(f.parent,'retained-workspace');fs.renameSync(f.source,original);fs.mkdirSync(f.source,{mode:0o700});fs.writeFileSync(path.join(f.source,'README.md'),'external replacement');
 await assert.rejects(createNativeService(f),{code:'REPOSITORY_CHANGED'});assert.equal(fs.readFileSync(path.join(f.source,'README.md'),'utf8'),'external replacement');
 fs.rmSync(f.source,{recursive:true});fs.renameSync(original,f.source);
 const records=path.join(f.dataRoot,'state/native/.asmb-host'),record=fs.readdirSync(records).find(name=>name.endsWith('.json'));fs.appendFileSync(path.join(records,record),'broken');
 const source=fs.readFileSync(path.join(f.source,'README.md'));await assert.rejects(createNativeService(f),{code:'RECOVERY_REQUIRED'});assert.deepEqual(fs.readFileSync(path.join(f.source,'README.md')),source);
});

test('an acknowledged draft and appearance survive a stopped host process without a graceful close',async t=>{
 const f=fixture(t),moduleURL=new URL('./host-service.mjs',import.meta.url).href;
 const script=`import {createNativeService} from ${JSON.stringify(moduleURL)};
 const service=await createNativeService({dataRoot:${JSON.stringify(f.dataRoot)}});
 const opened=await service.request({repo:'Workspace',operation:'open',args:{path:'README.md'}});
 await service.request({repo:'Workspace',operation:'checkpoint',args:{path:'README.md',baseHash:opened.sourceHash,text:'acknowledged private draft'}});
 await service.setAppearance({themeId:'dark',hideUnavailable:true});
 process.exit(0);`;
 execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})}});
 assert.equal(fs.existsSync(path.join(f.dataRoot,'.asmb-native.lock')),true);
 const service=await createNativeService(f);f.after(()=>service.close());
 assert.equal((await request(service,'open',{path:'README.md'})).draft.text,'acknowledged private draft');
 assert.deepEqual(await service.getAppearance(),{themeId:'dark',hideUnavailable:true});assert.match(fs.readFileSync(path.join(f.source,'README.md'),'utf8'),/^# Workspace/);
});
