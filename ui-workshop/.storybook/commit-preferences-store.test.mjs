import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {execFileSync} from 'node:child_process';
import {createCommitPreferencesStore,isValidCommitAuthor} from './commit-preferences-store.mjs';
import {createWorkspaceHandler,createWorkspaceService} from './local-workspace.mjs';

const empty={revision:0,mode:'asmagicbrain',asmagicbrain:{name:'',email:''},github:{name:'',email:''}};
const author={name:'Test Writer',email:'writer@example.invalid'};
function fixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'asmb-commit-preferences-'));
 const base=path.join(root,'repositories'),privateBase=path.join(root,'private'),privateRoot=path.join(root,'store');
 fs.mkdirSync(base);fs.mkdirSync(privateRoot,{mode:0o700});
 for(const repo of ['Workspace','asTeach-App']){fs.mkdirSync(path.join(base,repo));fs.writeFileSync(path.join(base,repo,'README.md'),'# Unchanged source\n');}
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,base,privateBase,privateRoot,workspaceRoot:base,localOwnerId:'asMagicBrain'};
}
const request=(value,overrides={})=>({expectedRevision:value.revision,mode:value.mode,asmagicbrain:value.asmagicbrain,github:value.github,...overrides});
async function call(handler,{method='GET',headers={},body,url='/__local-workspace?repo=Workspace'}={}){
 const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{method,url,headers:{host:'127.0.0.1:6006',...headers}});
 const result={};await handler(req,{writeHead(status,headers){Object.assign(result,{status,headers});},end(text){result.body=JSON.parse(text);}});return result;
}

test('empty identities persist without fabricating an author and snapshots are detached',t=>{
 const options=fixture(t),store=createCommitPreferencesStore(options),first=store.get();assert.deepEqual(first,empty);
 assert.equal(fs.readdirSync(options.privateRoot).length,1);
 first.asmagicbrain.name='renderer mutation';assert.deepEqual(store.get(),empty);
 const partial=store.set(request(empty,{asmagicbrain:{name:'张三',email:''},github:{name:'',email:'123+writer@users.noreply.github.com'}}));
 assert.equal(partial.revision,1);assert.equal(isValidCommitAuthor(partial.asmagicbrain),false);
 partial.github.email='changed@example.invalid';
 const reopened=createCommitPreferencesStore(options).get();
 assert.deepEqual(reopened,{revision:1,mode:'asmagicbrain',asmagicbrain:{name:'张三',email:''},github:{name:'',email:'123+writer@users.noreply.github.com'}});
 for(const name of fs.readdirSync(options.privateRoot))assert.equal(fs.statSync(path.join(options.privateRoot,name)).mode&0o777,0o600);
});

test('CAS reads the live revision across independent store instances',t=>{
 const options=fixture(t),one=createCommitPreferencesStore(options),two=createCommitPreferencesStore(options);
 const snapshot=one.get();assert.deepEqual(two.get(),snapshot);
 const saved=one.set(request(snapshot,{mode:'github',github:author}));
 assert.throws(()=>two.set(request(snapshot,{mode:'manual'})),{code:'CONFLICT'});
 assert.deepEqual(two.get(),saved);
 const updated=two.set(request(saved,{mode:'manual'}));assert.equal(updated.revision,2);assert.deepEqual(one.get(),updated);
});

test('bounded exact profiles accept incomplete setup but reject malformed names and emails',t=>{
 const store=createCommitPreferencesStore(fixture(t));store.get();
 const invalid=[
  {...request(empty),extra:true},{...request(empty),expectedRevision:-1},{...request(empty),expectedRevision:0.1},
  {...request(empty),expectedRevision:'0'},{...request(empty),expectedRevision:Number.MAX_SAFE_INTEGER+1},
  {...request(empty),mode:'account'}, {...request(empty),asmagicbrain:null},
  {...request(empty),github:{...author,token:'secret'}},
  ...[' ', 'a\nline','a\u0085line','a<b','\ud800','x'.repeat(257),'😀'.repeat(129)]
   .map(name=>request(empty,{asmagicbrain:{name,email:''}})),
  ...['local-only','user@host','user@@host.invalid','user @host.invalid','user@host.invalid\n','a<@host.invalid','\ud800@host.invalid','a'.repeat(257)+'@host.invalid']
   .map(email=>request(empty,{github:{name:'',email}})),
 ];
 for(const value of invalid)assert.throws(()=>store.set(value),{code:'INVALID_PREFERENCES'});
 assert.deepEqual(store.get(),empty);
 const value=store.set(request(empty,{mode:'manual',asmagicbrain:{name:'😀'.repeat(128),email:''}}));
 assert.equal(value.asmagicbrain.name.length,256);
 assert.equal(isValidCommitAuthor(author),true);
 assert.equal(isValidCommitAuthor({name:'张三',email:'123+writer@users.noreply.github.com'}),true);
 for(const value of [{name:'',email:author.email},{name:' ',email:author.email},{name:'Name',email:''},{name:'Name',email:'name@host'}, {...author,extra:true}])assert.equal(isValidCommitAuthor(value),false);
});

test('owner or physical workspace changes cannot reuse an existing profile',t=>{
 const options=fixture(t),store=createCommitPreferencesStore(options);store.set(request(store.get(),{asmagicbrain:author}));
 assert.throws(()=>createCommitPreferencesStore({...options,localOwnerId:'other-local-owner'}).get(),{code:'RECOVERY_REQUIRED'});
 const kept=options.base+'-kept';fs.renameSync(options.base,kept);fs.mkdirSync(options.base);
 assert.throws(()=>store.get(),{code:'DENIED'});
 assert.throws(()=>createCommitPreferencesStore(options).get(),{code:'RECOVERY_REQUIRED'});
 fs.rmdirSync(options.base);fs.renameSync(kept,options.base);
 assert.deepEqual(store.get().asmagicbrain,author);
});

test('private storage rejects source overlap, links, unsafe permissions and Git storage',t=>{
 const options=fixture(t);
 assert.throws(()=>createCommitPreferencesStore({...options,privateRoot:options.base}),{code:'INVALID_PRIVATE_ROOT'});
 const nested=path.join(options.base,'settings');fs.mkdirSync(nested,{mode:0o700});
 assert.throws(()=>createCommitPreferencesStore({...options,privateRoot:nested}),{code:'INVALID_PRIVATE_ROOT'});
 const link=path.join(options.root,'linked-store');fs.symlinkSync(options.privateRoot,link);
 assert.throws(()=>createCommitPreferencesStore({...options,privateRoot:link}),{code:'DENIED'});
 fs.chmodSync(options.privateRoot,0o755);assert.throws(()=>createCommitPreferencesStore(options),{code:'DENIED'});fs.chmodSync(options.privateRoot,0o700);
 fs.mkdirSync(path.join(options.privateRoot,'.git'));assert.throws(()=>createCommitPreferencesStore(options),{code:'DENIED'});
});

test('long-lived preference changes compact and restart at the latest revision',t=>{
 const options=fixture(t),store=createCommitPreferencesStore(options);let value=store.get();
 for(let i=0;i<80;i++)value=store.set(request(value,{asmagicbrain:{name:`Writer ${i}`,email:author.email}}));
 assert.equal(value.revision,80);assert.ok(fs.readdirSync(options.privateRoot).length<28);
 assert.deepEqual(createCommitPreferencesStore(options).get(),value);
});

test('a complete interrupted append is recovered durably and makes stale retries conflict',t=>{
 const options=fixture(t);let armed=false;
 const store=createCommitPreferencesStore({...options,hooks:{at(point){if(armed&&point==='private-after-file-sync')throw Error('isolated failure');}}});
 const before=store.get();armed=true;
 assert.throws(()=>store.set(request(before,{asmagicbrain:author})),{code:'RECOVERY_REQUIRED'});
 const reopened=createCommitPreferencesStore(options),latest=reopened.get();assert.equal(latest.revision,1);assert.deepEqual(latest.asmagicbrain,author);
 assert.throws(()=>reopened.set(request(before,{mode:'manual'})),{code:'CONFLICT'});
});

test('a torn append is retained and never resets preferences to empty defaults',t=>{
 const options=fixture(t);let armed=false;
 const store=createCommitPreferencesStore({...options,hooks:{at(point){if(armed&&point==='private-after-create')throw Error('isolated torn write');}}});
 const value=store.get();armed=true;
 assert.throws(()=>store.set(request(value,{asmagicbrain:author})),{code:'RECOVERY_REQUIRED'});
 const files=fs.readdirSync(options.privateRoot),torn=files.find(name=>fs.statSync(path.join(options.privateRoot,name)).size===0);assert.ok(torn);
 assert.throws(()=>createCommitPreferencesStore(options).get(),{code:'RECOVERY_REQUIRED'});
 assert.throws(()=>createCommitPreferencesStore(options).set(request(empty)),{code:'RECOVERY_REQUIRED'});
 assert.deepEqual(fs.readdirSync(options.privateRoot),files);assert.equal(fs.statSync(path.join(options.privateRoot,torn)).size,0);
});

test('interrupted checkpoint retirement preserves the latest preferences and resumes normal saves',t=>{
 const options=fixture(t);let armed=false;
 const store=createCommitPreferencesStore({...options,hooks:{at(point){if(armed&&point==='private-after-covered-retirement')throw Error('isolated checkpoint interruption');}}});
 let value=store.get();for(let i=0;i<23;i++)value=store.set(request(value,{asmagicbrain:author}));
 armed=true;assert.throws(()=>store.set(request(value,{mode:'manual'})),{code:'RECOVERY_REQUIRED'});
 const reopened=createCommitPreferencesStore(options);assert.deepEqual(reopened.get(),value);
 const saved=reopened.set(request(value,{mode:'manual'}));assert.equal(saved.revision,24);assert.equal(saved.mode,'manual');
 assert.deepEqual(createCommitPreferencesStore(options).get(),saved);
});

test('workspace preferences are shared across repositories and survive service restart without source or Git writes',async t=>{
 const options=fixture(t);let service=createWorkspaceService(options);
 const initial=await service.execute('Workspace','getCommitPreferences',{});assert.deepEqual(initial,empty);
 const saved=await service.execute('Workspace','setCommitPreferences',request(initial,{mode:'github',github:author}));
 assert.deepEqual(await service.execute('asTeach-App','getCommitPreferences',{}),saved);
 assert.deepEqual(fs.readdirSync(options.privateBase),['.asmb-settings']);
 for(const repo of ['Workspace','asTeach-App']){assert.deepEqual(fs.readdirSync(path.join(options.base,repo)),['README.md']);assert.equal(fs.readFileSync(path.join(options.base,repo,'README.md'),'utf8'),'# Unchanged source\n');}
 service.close();service=createWorkspaceService(options);t.after(()=>service.close());
 assert.deepEqual(await service.execute('Workspace','getCommitPreferences',{}),saved);
 await assert.rejects(service.execute('Workspace','setCommitPreferences',request(empty)),{code:'CONFLICT'});
 await assert.rejects(service.execute('unknown','getCommitPreferences',{}));
 await assert.rejects(service.execute('Workspace','getCommitPreferences',{root:options.root}),{code:'INVALID_REQUEST'});
});

test('preferences use the same capability boundary and a shared cross-repository revision',async t=>{
 const handler=createWorkspaceHandler(fixture(t));t.after(()=>handler.close());const bootstrap=await call(handler);
 const headers={origin:'http://127.0.0.1:6006','content-type':'application/json','x-asmagicbrain-capability':bootstrap.body.capability};
 const body={repo:'Workspace',operation:'getCommitPreferences',args:{}};
 for(const denied of [{},{...headers,origin:'https://elsewhere.invalid'},{...headers,'x-asmagicbrain-capability':'wrong'}])assert.equal((await call(handler,{method:'POST',headers:denied,body})).status,403);
 assert.deepEqual((await call(handler,{method:'POST',headers,body})).body.value,empty);
 const writes=await Promise.all(['Workspace','asTeach-App'].map(repo=>call(handler,{method:'POST',headers,body:{repo,operation:'setCommitPreferences',args:request(empty,{asmagicbrain:author})}})));
 assert.deepEqual(writes.map(value=>value.status).sort(),[200,409]);
 const current=await call(handler,{method:'POST',headers,body:{...body,repo:'asTeach-App'}});assert.equal(current.body.value.revision,1);
});

test('Commit rejects incomplete author labels and never substitutes stored labels for the reviewed author',async t=>{
 const options=fixture(t),service=createWorkspaceService(options);t.after(()=>service.close());
 await service.execute('Workspace','setCommitPreferences',request(empty,{asmagicbrain:author}));
 const invalid={expectedHead:null,expectedIndexHash:null,files:[],message:'Invalid',author:{name:'',email:''}};
 for(const value of [invalid.author,{name:'Author',email:'bad-email'},{name:'Author\u0085',email:author.email}])await assert.rejects(service.execute('Workspace','gitCommit',{...invalid,author:value}),{code:'INVALID_AUTHOR'});
 assert.equal(fs.existsSync(path.join(options.base,'Workspace','.git')),false);
 // A local Save stays available even with an incomplete selected profile.
 await service.execute('Workspace','setCommitPreferences',request(await service.execute('Workspace','getCommitPreferences',{}),{asmagicbrain:{name:'',email:''}}));
 const opened=await service.execute('Workspace','open',{path:'README.md'});
 await service.execute('Workspace','save',{path:'README.md',baseHash:opened.sourceHash,text:'# Saved locally\n'});
 assert.equal(fs.existsSync(path.join(options.base,'Workspace','.git')),false);
 await service.execute('Workspace','gitInitialize',{branch:'main'});
 const review=await service.execute('Workspace','gitReview',{paths:['README.md']});
 const explicit={name:'Reviewed Writer',email:'42+reviewed@users.noreply.github.com'};
 await service.execute('Workspace','gitCommit',{expectedHead:review.expectedHead,expectedIndexHash:review.expectedIndexHash,files:review.files.map(({path,expectedSourceHash,expectedSourceMode})=>({path,expectedSourceHash,expectedSourceMode})),message:'Explicit author',author:explicit});
 const actual=execFileSync('/usr/bin/git',['-C',path.join(options.base,'Workspace'),'show','-s','--format=%an%n%ae','HEAD'],{encoding:'utf8'});
 assert.equal(actual,`${explicit.name}\n${explicit.email}\n`);
});
