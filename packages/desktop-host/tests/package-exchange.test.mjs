import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {testRoot} from '../../../tools/development-paths.mjs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createPackageExchange,EXCHANGE_LIMITS} from '../src/package-exchange/index.mjs';
import {createPackageZip,parsePackage,sha256,PACKAGE_MANIFEST} from '../src/package-exchange/archive.mjs';
import {readZipFiles,extractZip} from '../src/zip-import/index.mjs';
import {renderOffline} from '../src/package-exchange/offline-reader.mjs';
const runRoot=path.join(testRoot,'runs/stage4-shared-services-20260922/exchange/unit');fs.mkdirSync(runRoot,{recursive:true,mode:0o700});
const baseFiles={'current.md':'# Current note\n\nPackage v1. The next package can update this unchanged generated note.\n','notes.md':'# Notes\n\nOriginal package note. Both the user and the next package will edit this.\n','old.md':'# Obsolete package note\n\nRemoval may be proposed only under explicit full-snapshot ownership semantics.\n'};
const incomingFiles={'current.md':'# Current note\n\nPackage v2. This is the incoming replacement for the unchanged generated note.\n','notes.md':"# Notes\n\nIncoming package change. Do not silently overwrite the user's different saved edit.\n",'new.md':'# Newly added package note\n\nThis path is new in package v2.\n'};
const localNote='# Notes\n\nUser-added observation that must survive a conflicting incoming package update.\n';
const personal='# Personal note\n\nThis file belongs to the user, not to the imported package, and must survive any incoming package update.\n';
const zip=files=>createPackageZip(Object.entries(files).map(([path,bytes])=>({path,bytes:Buffer.from(bytes)})));
const base=zip(baseFiles),incoming=zip(incomingFiles);
const read=(root,name)=>fs.readFileSync(path.join(root,name),'utf8');
function fixture(options={}){
 const root=fs.mkdtempSync(path.join(runRoot,'asmb-exchange-')),sourceRoot=path.join(root,'source'),privateRoot=path.join(root,'private');
 fs.mkdirSync(sourceRoot,{mode:0o700});fs.mkdirSync(privateRoot,{mode:0o700});extractZip(base,{destination:sourceRoot});let drafts=[];
 const configuration={sourceRoot,privateRoot,getDraftPaths:()=>drafts,renderOffline,...options};
 return {root,sourceRoot,privateRoot,configuration,manager:createPackageExchange(configuration),reopen(){return createPackageExchange(configuration);},setDrafts(value){drafts=value;}};
}
async function registered(options){const f=fixture(options);await f.manager.registerBase({archive:base,collectionId:'engineering',version:'1'});return f;}
async function plan(f,semantics='snapshot'){return f.manager.reviewUpdate({archive:incoming,semantics,version:'2'});}
function choose(review,overrides={}){return review.rows.filter(row=>row.choices.length).map(row=>({path:row.path,choice:overrides[row.path]??(row.conflict?'keep-both':'use-incoming')}));}

test('neutral U01 plan matches exact supplied hashes and explicit conflict copy; rollback restores preimages',async()=>{
 const f=await registered();fs.writeFileSync(path.join(f.sourceRoot,'notes.md'),localNote);fs.writeFileSync(path.join(f.sourceRoot,'personal.md'),personal);
 const r=await plan(f);assert.deepEqual(r.rows.map(row=>[row.path,row.action]),[['current.md','update'],['new.md','add'],['notes.md','conflict'],['old.md','remove'],['personal.md','preserve']]);
 assert.equal(r.rows[0].baseHash,'26f20453111c5452d22a964c5c6af10e5b6b255738f401a90fe1d9328178aba2');assert.equal(r.rows[0].incomingHash,'6adf33aa90535d7ce6d0391fd6a45e4b754341a63ae7a869a85d2ed025e360f8');
 assert.equal(r.rows.find(row=>row.path==='notes.md').currentHash,'f0a45513d8b8c380fd2655f35b60dad991524a4c99be8a5accafed0758514f3d');
 await assert.rejects(f.manager.apply({planId:r.planId,choices:[]}),{code:'CHOICE_REQUIRED'});
 const result=await f.manager.apply({planId:r.planId,choices:choose(r)});assert.equal(result.status,'completed');assert.equal(read(f.sourceRoot,'current.md'),incomingFiles['current.md']);assert.equal(read(f.sourceRoot,'notes.md'),localNote);assert.equal(read(f.sourceRoot,'notes incoming.md'),incomingFiles['notes.md']);assert.equal(read(f.sourceRoot,'personal.md'),personal);assert.ok(!fs.existsSync(path.join(f.sourceRoot,'old.md')));assert.ok(!fs.existsSync(path.join(f.sourceRoot,'.git')));
 const reopened=f.reopen();assert.equal(reopened.status().registration.version,'2');assert.equal(reopened.status().operations[0].canRollback,true);
 await reopened.rollback({operationId:result.operationId});assert.equal(read(f.sourceRoot,'current.md'),baseFiles['current.md']);assert.equal(read(f.sourceRoot,'old.md'),baseFiles['old.md']);assert.equal(read(f.sourceRoot,'notes.md'),localNote);assert.equal(read(f.sourceRoot,'personal.md'),personal);assert.ok(!fs.existsSync(path.join(f.sourceRoot,'new.md')));assert.equal(reopened.status().registration.version,'1');
});

test('base ownership registration is explicit, match-bound and rejects competing drafts',async()=>{
 const f=fixture();await assert.rejects(plan(f),{code:'BASE_NOT_REGISTERED'});const review=await f.manager.registrationReview({archive:base,collectionId:'engineering',version:'1'});assert.equal(f.manager.status().registration,null);
 f.setDrafts(['current.md']);await assert.rejects(f.manager.registerBase({planId:review.planId}),{code:'STALE_PLAN'});await assert.rejects(f.manager.registrationReview({archive:base,collectionId:'engineering',version:'1'}),{code:'DRAFT_CONFLICT'});
 f.setDrafts([]);fs.writeFileSync(path.join(f.sourceRoot,'current.md'),'different');await assert.rejects(f.manager.registerBase({archive:base,collectionId:'engineering',version:'1'}),{code:'BASE_MISMATCH'});assert.equal(f.manager.status().registration,null);
});

test('saved content, file identity, new collisions and new drafts invalidate review without overwriting',async()=>{
 for(const mutation of ['content','identity','new-file','draft']){const f=await registered(),review=await plan(f);if(mutation==='content')fs.writeFileSync(path.join(f.sourceRoot,'current.md'),'user');if(mutation==='identity'){fs.renameSync(path.join(f.sourceRoot,'current.md'),path.join(f.root,'old-source'));fs.writeFileSync(path.join(f.sourceRoot,'current.md'),baseFiles['current.md']);}if(mutation==='new-file')fs.writeFileSync(path.join(f.sourceRoot,'new.md'),'user-owned');if(mutation==='draft')f.setDrafts(['new.md']);await assert.rejects(f.manager.apply({planId:review.planId,choices:choose(review)}),{code:'STALE_PLAN'});assert.equal(f.manager.status().registration.version,'1');assert.equal(f.manager.status().recoveryRequired,false);}
});

test('drafted owned files only allow keep current and unrelated drafts/user files survive',async()=>{
 const f=await registered();f.setDrafts(['notes.md','personal.md']);fs.writeFileSync(path.join(f.sourceRoot,'personal.md'),personal);const r=await plan(f);assert.deepEqual(r.rows.find(row=>row.path==='notes.md').choices,['keep-current']);await assert.rejects(f.manager.apply({planId:r.planId,choices:choose(r)}),{code:'INVALID_CHOICES'});
 await f.manager.apply({planId:r.planId,choices:choose(r,{'notes.md':'keep-current'})});assert.equal(read(f.sourceRoot,'notes.md'),baseFiles['notes.md']);assert.equal(read(f.sourceRoot,'personal.md'),personal);assert.deepEqual((await f.manager.reviewExport()).drafts,['notes.md','personal.md']);
});

test('patch omissions never delete; locally modified owned snapshot deletions are conflicts',async()=>{
 const f=await registered();fs.writeFileSync(path.join(f.sourceRoot,'old.md'),'local retained');const patch=await plan(f,'patch');assert.equal(patch.rows.find(row=>row.path==='old.md').action,'preserve');const snapshot=await plan(f);assert.equal(snapshot.rows.find(row=>row.path==='old.md').action,'conflict');await f.manager.apply({planId:patch.planId,choices:choose(patch)});assert.equal(read(f.sourceRoot,'old.md'),'local retained');
});

test('later user edit or draft prevents rollback',async()=>{
 for(const kind of ['edit','draft']){const f=await registered(),r=await plan(f),done=await f.manager.apply({planId:r.planId,choices:choose(r)});if(kind==='edit')fs.writeFileSync(path.join(f.sourceRoot,'current.md'),'later');else f.setDrafts(['current.md']);await assert.rejects(f.manager.rollback({operationId:done.operationId}),{code:kind==='edit'?'ROLLBACK_CONFLICT':'DRAFT_CONFLICT'});assert.equal(f.manager.status().recoveryRequired,false);}
});

for(const phase of ['exchange-after-intent','exchange-before-step','exchange-after-step'])test(`interruption at ${phase} is held across restart and explicit rollback is supported`,async()=>{
 let armed=false,used=false;const f=await registered({hooks:{at:value=>{if(armed&&!used&&value===phase){used=true;throw Object.assign(Error('Injected storage failure'),{code:'INJECTED'});}}}});const r=await plan(f);armed=true;
 await assert.rejects(f.manager.apply({planId:r.planId,choices:choose(r)}));assert.equal(f.manager.status().recoveryRequired,true);await assert.rejects(f.manager.reviewExport(),{code:'RECOVERY_REQUIRED'});const reopened=f.reopen();const result=await reopened.recover({direction:'rollback'});assert.equal(result.status,'rolled-back');for(const [name,text]of Object.entries(baseFiles))assert.equal(read(f.sourceRoot,name),text);assert.ok(!fs.existsSync(path.join(f.sourceRoot,'new.md')));
});

for(const phase of ['before-file-intent','after-file-intent','after-file-stage','after-journal','after-replace','after-completion'])test(`existing source journal recovers ${phase}, then package Resume completes`,async()=>{
 let armed=false,used=false;const f=await registered({hooks:{transactionAt:value=>{if(armed&&!used&&value===phase){used=true;throw Object.assign(Error('injected'),{code:'INJECTED'});}}}});const r=await plan(f);armed=true;await assert.rejects(f.manager.apply({planId:r.planId,choices:choose(r)}));assert.equal(f.manager.status().recoveryRequired,true);const reopened=f.reopen();await reopened.recover({direction:'resume'});assert.equal(read(f.sourceRoot,'current.md'),incomingFiles['current.md']);assert.equal(read(f.sourceRoot,'new.md'),incomingFiles['new.md']);assert.equal(reopened.status().recoveryRequired,false);
});

test('actual process exit during publication resumes after restart without manual private-state repair',async()=>{
 const f=await registered(),entry=new URL('../src/package-exchange/index.mjs',import.meta.url).href;
 const script=`import fs from 'node:fs';import {createPackageExchange} from ${JSON.stringify(entry)};const manager=createPackageExchange({sourceRoot:${JSON.stringify(f.sourceRoot)},privateRoot:${JSON.stringify(f.privateRoot)},hooks:{at:phase=>{if(phase==='exchange-after-step')process.exit(86);}}});const r=await manager.reviewUpdate({archive:Buffer.from(${JSON.stringify(incoming.toString('base64'))},'base64'),semantics:'snapshot',version:'2'});await manager.apply({planId:r.planId,choices:r.rows.filter(row=>row.choices.length).map(row=>({path:row.path,choice:'use-incoming'}))});`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env:process.env,encoding:'utf8'});assert.equal(result.status,86,result.stderr);const reopened=f.reopen();assert.equal(reopened.status().recoveryRequired,true);await reopened.recover({direction:'resume'});assert.equal(read(f.sourceRoot,'current.md'),incomingFiles['current.md']);assert.equal(reopened.status().operations.at(-1).status,'completed');
});

test('interrupted rollback resumes; unknown later bytes remain held and intact',async()=>{
 let armed=false,used=false;const f=await registered({hooks:{at:phase=>{if(armed&&!used&&phase==='exchange-after-rollback-step'){used=true;throw Object.assign(Error('injected'),{code:'INJECTED'});}}}});const r=await plan(f),done=await f.manager.apply({planId:r.planId,choices:choose(r)});armed=true;await assert.rejects(f.manager.rollback({operationId:done.operationId}));const reopened=f.reopen();assert.equal(reopened.status().pending.direction,'rollback');await reopened.recover();assert.equal(read(f.sourceRoot,'old.md'),baseFiles['old.md']);assert.equal(reopened.status().recoveryRequired,false);
 const g=await registered({hooks:{at:phase=>{if(phase==='exchange-after-step')throw Object.assign(Error('injected'),{code:'INJECTED'});}}}),rr=await plan(g);await assert.rejects(g.manager.apply({planId:rr.planId,choices:choose(rr)}));fs.writeFileSync(path.join(g.sourceRoot,'current.md'),'external unknown');await assert.rejects(g.reopen().recover({direction:'rollback'}),{code:'ROLLBACK_CONFLICT'});assert.equal(read(g.sourceRoot,'current.md'),'external unknown');
});

test('cancel plan writes nothing; nested assets use pinned parents and retain harmless empty directories after rollback',async()=>{
 const f=await registered(),r=await plan(f);f.manager.cancelPlan(r.planId);await assert.rejects(f.manager.apply({planId:r.planId,choices:choose(r)}),{code:'STALE_PLAN'});assert.equal(read(f.sourceRoot,'current.md'),baseFiles['current.md']);
 const nested=await f.manager.reviewUpdate({archive:zip({...baseFiles,'assets/nested/model.bin':Buffer.from([0,255,16])}),semantics:'snapshot',version:'2'}),done=await f.manager.apply({planId:nested.planId,choices:choose(nested)});assert.deepEqual(fs.readFileSync(path.join(f.sourceRoot,'assets/nested/model.bin')),Buffer.from([0,255,16]));await f.manager.rollback({operationId:done.operationId});assert.ok(fs.statSync(path.join(f.sourceRoot,'assets/nested')).isDirectory());assert.ok(!fs.existsSync(path.join(f.sourceRoot,'assets/nested/model.bin')));
});

test('symlinks, hardlinks, aliases, protected paths, duplicate entries and checksum mismatch fail before source writes',async()=>{
 for(const kind of ['symlink','hardlink','case']){const f=await registered();const victim=path.join(f.root,'victim');fs.writeFileSync(victim,'outside');if(kind==='symlink')fs.symlinkSync(victim,path.join(f.sourceRoot,'new.md'));if(kind==='hardlink')fs.linkSync(victim,path.join(f.sourceRoot,'new.md'));if(kind==='case')fs.writeFileSync(path.join(f.sourceRoot,'NEW.md'),'case');await assert.rejects(plan(f));assert.equal(read(f.sourceRoot,'current.md'),baseFiles['current.md']);assert.equal(fs.readFileSync(victim,'utf8'),'outside');}
 for(const name of ['../escape','a/../escape','.git/config','.asmb-secret','CON','unsafe\\name'])assert.throws(()=>zip({[name]:'bad'}));
 assert.throws(()=>createPackageZip([{path:'same.md',bytes:Buffer.from('a')},{path:'same.md',bytes:Buffer.from('b')}]),{code:'ZIP_CONFLICT'});assert.throws(()=>zip({'A.md':'a','a.md':'b'}),{code:'ZIP_CONFLICT'});
 const manifest={format:'asMagicBrain-package',schemaVersion:1,collectionId:'engineering',version:'2',semantics:'snapshot',files:[{path:'current.md',sha256:'0'.repeat(64)}]};assert.throws(()=>parsePackage(zip({'current.md':'changed',[PACKAGE_MANIFEST]:JSON.stringify(manifest)})),{code:'PACKAGE_INTEGRITY'});
 const f=await registered();const target=path.join(f.root,'replaced');fs.renameSync(f.sourceRoot,target);fs.mkdirSync(f.sourceRoot);await assert.rejects(plan(f),{code:'DENIED'});
});

test('manifest identity/base/version do not grant target authority and unsupported formats remain data',async()=>{
 const f=await registered(),files=Object.entries(incomingFiles).map(([path,bytes])=>({path,sha256:sha256(bytes)})),metadata={format:'asMagicBrain-package',schemaVersion:1,collectionId:'other',version:'2',semantics:'snapshot',files};
 await assert.rejects(f.manager.reviewUpdate({archive:zip({...incomingFiles,[PACKAGE_MANIFEST]:JSON.stringify(metadata)})}),{code:'COLLECTION_MISMATCH'});
 metadata.collectionId='engineering';metadata.base={version:'wrong',files:[]};await assert.rejects(f.manager.reviewUpdate({archive:zip({...incomingFiles,[PACKAGE_MANIFEST]:JSON.stringify(metadata)})}),{code:'BASE_MISMATCH'});delete metadata.base;metadata.schemaVersion=2;assert.throws(()=>parsePackage(zip({...incomingFiles,[PACKAGE_MANIFEST]:JSON.stringify(metadata)})),{code:'UNSUPPORTED_FORMAT'});
});

test('portable source ZIP relocates exact bytes, excludes private state and detects stale export',async()=>{
 const f=await registered();fs.mkdirSync(path.join(f.sourceRoot,'assets'));const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+R6nIAAAAASUVORK5CYII=','base64');fs.writeFileSync(path.join(f.sourceRoot,'assets','image.png'),png);fs.writeFileSync(path.join(f.sourceRoot,'README.md'),'# Guide\n[Notes](notes.md)\n![Image](assets/image.png)\n');fs.writeFileSync(path.join(f.sourceRoot,'LICENSE'),'Example permission notice');fs.mkdirSync(path.join(f.sourceRoot,'.git'));fs.writeFileSync(path.join(f.sourceRoot,'.git','config'),'private credentials');f.setDrafts(['notes.md']);
 const r=await f.manager.reviewExport(),out=await f.manager.buildExport({planId:r.planId}),copied=path.join(f.root,'renamed');fs.mkdirSync(copied);extractZip(out.bytes,{destination:copied});assert.equal(read(copied,'README.md'),read(f.sourceRoot,'README.md'));assert.deepEqual(fs.readFileSync(path.join(copied,'assets/image.png')),png);assert.equal(read(copied,'LICENSE'),'Example permission notice');assert.ok(!fs.existsSync(path.join(copied,'.git')));const parsed=parsePackage(out.bytes);assert.equal(parsed.metadata.files.find(file=>file.path==='README.md').sha256,sha256(read(copied,'README.md')));assert.ok(out.warnings.some(warning=>warning.code==='DRAFTS_EXCLUDED'));
 fs.writeFileSync(path.join(f.sourceRoot,'notes.md'),'changed');await assert.rejects(f.manager.buildExport({planId:r.planId}),{code:'STALE_PLAN'});
});

test('offline reader preserves links, math, notices and explicit diagram/artifact fallback without executable imported markup',async()=>{
 const f=await registered();fs.writeFileSync(path.join(f.sourceRoot,'README.md'),'# Guide\n[Notes](notes.md#notes)\n[Artifact](slider.html)\n![Missing](missing.png)\n[External](https://example.test)\n\n$$x^2$$\n\n```mermaid\ngraph TD; A-->B\n```\n');fs.writeFileSync(path.join(f.sourceRoot,'slider.html'),'<script>fetch("https://attacker.test")</script><input type="range">');fs.writeFileSync(path.join(f.sourceRoot,'LICENSE'),'Original asset license');fs.writeFileSync(path.join(f.sourceRoot,'PROVENANCE.md'),'Original provenance');
 const r=await f.manager.reviewExport(),out=await f.manager.buildExport({planId:r.planId,kind:'offline'}),files=new Map(readZipFiles(out.bytes,{stripRoot:false}).files.map(file=>[file.path,file.bytes.toString('utf8')]));
 const html=files.get('reader/README.md.html');assert.match(html,/href="notes.md.html#notes"/);assert.match(html,/href="slider.html.html"/);assert.match(html,/<math /);assert.match(html,/Mermaid diagram — source fallback/);assert.match(html,/A--&gt;B/);assert.ok(!html.includes('<script'));assert.match(files.get('reader/slider.html.html'),/&lt;script&gt;/);assert.match(files.get('reader/slider.html.html'),/script-src &#39;none&#39;/);assert.equal(files.get('source/LICENSE'),'Original asset license');assert.equal(files.get('source/PROVENANCE.md'),'Original provenance');assert.ok(files.has('READER-NOTICES.txt'));assert.ok(out.warnings.some(warning=>warning.code==='MISSING_DEPENDENCY'));assert.ok(out.warnings.some(warning=>warning.code==='EXTERNAL_REFERENCE'));assert.ok(out.warnings.some(warning=>warning.code==='STATIC_ARTIFACT_FALLBACK'));
});

test('large asset export is independent of bounded update publication',async()=>{
 const f=await registered(),large=Buffer.alloc(EXCHANGE_LIMITS.updateMemberBytes+1,37);fs.writeFileSync(path.join(f.sourceRoot,'large.bin'),large);const exportReview=await f.manager.reviewExport(),out=await f.manager.buildExport({planId:exportReview.planId});assert.equal(parsePackage(out.bytes).files.find(file=>file.path==='large.bin').bytes.length,large.length);
 const r=await f.manager.reviewUpdate({archive:zip({...incomingFiles,'new-large.bin':large}),semantics:'patch',version:'2'});assert.ok(r.warnings.some(warning=>warning.code==='UPDATE_MEMBER_LIMIT'));await assert.rejects(f.manager.apply({planId:r.planId,choices:choose(r)}),{code:'UPDATE_MEMBER_LIMIT'});assert.equal(f.manager.status().recoveryRequired,false);
});

test('async draft observation cannot approve overwritten saved changes during register/apply/export',async()=>{
 for(const operation of ['register','apply','export']){
  let armed=false,sourceRoot;const f=fixture({getDraftPaths:async()=>{await Promise.resolve();if(armed){armed=false;fs.writeFileSync(path.join(sourceRoot,'current.md'),'changed during draft observation');}return [];}});sourceRoot=f.sourceRoot;
  let review;if(operation==='register')review=await f.manager.registrationReview({archive:base,collectionId:'engineering',version:'1'});else{await f.manager.registerBase({archive:base,collectionId:'engineering',version:'1'});review=operation==='apply'?await plan(f):await f.manager.reviewExport();}
  armed=true;await assert.rejects(operation==='register'?f.manager.registerBase({planId:review.planId}):operation==='apply'?f.manager.apply({planId:review.planId,choices:choose(review)}):f.manager.buildExport({planId:review.planId}),{code:'STALE_PLAN'});
  assert.equal(read(f.sourceRoot,'current.md'),'changed during draft observation');assert.equal(f.manager.status().recoveryRequired,false);
 }
});

test('declined user-owned collision and declined new addition never become package owned',async()=>{
 for(const choice of ['keep-current','keep-both']){const f=await registered();fs.writeFileSync(path.join(f.sourceRoot,'personal.md'),personal);const r=await f.manager.reviewUpdate({archive:zip({...incomingFiles,'personal.md':'incoming claim','declined.md':'not accepted'}),semantics:'snapshot',version:'2'});assert.equal(r.rows.find(row=>row.path==='personal.md').owned,false);await f.manager.apply({planId:r.planId,choices:choose(r,{'personal.md':choice,'declined.md':'keep-current'})});
  const next=await f.manager.reviewUpdate({archive:incoming,semantics:'snapshot',version:'3'});assert.equal(next.rows.find(row=>row.path==='personal.md').owned,false);assert.equal(next.rows.find(row=>row.path==='personal.md').action,'preserve');assert.ok(!next.rows.some(row=>row.path==='declined.md'));assert.equal(read(f.sourceRoot,'personal.md'),personal);
 }
});

test('credential filename exclusions are visible in export review and manifest without changing source or ordinary import',async()=>{
 const f=await registered(),secretNames=['.env','.env.local','.envrc','private.pem','signing.key','account.p12','account.pfx','id_rsa','.npmrc','credentials.json','.ssh/config'],templates=['.env.example','.env.sample','.env.template'];
 for(const name of [...secretNames,...templates]){fs.mkdirSync(path.dirname(path.join(f.sourceRoot,name)),{recursive:true});fs.writeFileSync(path.join(f.sourceRoot,name),`source bytes for ${name}`);}
 const review=await f.manager.reviewExport();assert.deepEqual(review.excluded.map(entry=>entry.path).sort(),secretNames.sort());for(const name of secretNames)assert.ok(review.warnings.some(warning=>warning.path===name&&warning.code==='SUSPECTED_CREDENTIAL_EXCLUDED'));
 for(const kind of ['source','offline']){
  const exported=await f.manager.buildExport({planId:review.planId,kind}),files=readZipFiles(exported.bytes,{stripRoot:false}).files,prefix=kind==='offline'?'source/':'';
  const manifest=JSON.parse(files.find(file=>file.path===prefix+PACKAGE_MANIFEST).bytes);assert.deepEqual(manifest.excluded.map(entry=>entry.path).sort(),secretNames);assert.ok(manifest.excluded.every(entry=>entry.reason==='suspected-credential-filename'));
  for(const name of secretNames){assert.ok(!files.some(file=>file.path===prefix+name));assert.equal(read(f.sourceRoot,name),`source bytes for ${name}`);}
  for(const name of templates)assert.ok(files.some(file=>file.path===prefix+name));
  if(kind==='source')assert.equal(parsePackage(exported.bytes).metadata.excluded.length,secretNames.length);
 }
 const importOnly=parsePackage(zip({'.env':'incoming original bytes'}));assert.equal(importOnly.files[0].bytes.toString(),'incoming original bytes');
 fs.writeFileSync(path.join(f.sourceRoot,'.env.new'),'new excluded file');await assert.rejects(f.manager.buildExport({planId:review.planId}),{code:'STALE_PLAN'});
});

for(const phase of ['exchange-after-complete','exchange-after-step'])test(`trusted broker identity survives ${phase}, restart and read-only receipt lookup`,async()=>{
 let armed=false,used=false;const operationId='cfb7451e-95d2-4dc1-821a-080bf09a563d',f=await registered({hooks:{at:value=>{if(armed&&!used&&value===phase){used=true;throw Object.assign(Error('Lost broker completion'),{code:'INJECTED'});}}}}),r=await plan(f);armed=true;
 await assert.rejects(f.manager.apply({planId:r.planId,choices:choose(r),operationId}));const reopened=f.reopen(),status=reopened.status();
 if(phase==='exchange-after-step'){
  assert.equal(status.pending.operationId,operationId);await assert.rejects(reopened.apply({planId:r.planId,choices:choose(r),operationId}),{code:'RECOVERY_REQUIRED'});await reopened.recover({operationId,direction:'resume'});
 }else assert.equal(status.operations.at(-1).operationId,operationId);
 const complete=reopened.status().operations.at(-1);assert.equal(complete.operationId,operationId);assert.equal(complete.status,'completed');assert.equal(read(f.sourceRoot,'current.md'),incomingFiles['current.md']);
 const another=await reopened.reviewUpdate({archive:incoming,semantics:'patch',version:'3'});await assert.rejects(reopened.apply({planId:another.planId,choices:choose(another),operationId}),{code:'OPERATION_ID_USED'});assert.equal(reopened.status().operations.length,1);assert.equal(reopened.status().registration.version,'2');
 await reopened.rollback({operationId});assert.equal(reopened.status().operations.at(-1).status,'rolled-back');const afterRollback=await reopened.reviewUpdate({archive:incoming,semantics:'snapshot',version:'2'});await assert.rejects(reopened.apply({planId:afterRollback.planId,choices:choose(afterRollback),operationId}),{code:'OPERATION_ID_USED'});assert.equal(read(f.sourceRoot,'current.md'),baseFiles['current.md']);
});

test('invalid trusted operation identities are rejected before retained blobs or source changes',async()=>{
 const f=await registered(),r=await plan(f),before=fs.readdirSync(path.join(f.privateRoot,'blobs')).sort();
 for(const operationId of [null,12,'','../escape','CFB7451E-95D2-4DC1-821A-080BF09A563D','cfb7451e-95d2-1dc1-821a-080bf09a563d'])await assert.rejects(f.manager.apply({planId:r.planId,choices:choose(r),operationId}),{code:'INVALID_REQUEST'});
 assert.deepEqual(fs.readdirSync(path.join(f.privateRoot,'blobs')).sort(),before);assert.equal(f.manager.status().operations.length,0);assert.equal(read(f.sourceRoot,'current.md'),baseFiles['current.md']);
});
