import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createLocalWorkspaceClient} from '../../../ui-workshop/src/local-workspace-client.ts';
import {loadRepositoryCatalog, importRepositoryArchive, createLocalRepository, repositoryCreationError} from '../../../ui-workshop/src/repository-catalog.ts';
import {getNativeBridge, readRepository, readRepositoryAsset, revealRepositoryItem, renameRepository, nativeOperation, waitForNativeOperations} from '../../../ui-workshop/src/native-bridge.mjs';
import {assertFilenameIntentRetained, createNativeCloseHandler} from '../../../ui-workshop/src/native-close.mjs';
import {installNativeCloseRouter, registerNativeCloseHandler} from '../../../ui-workshop/src/native-close-router.mjs';
import {remapSessions, restoreRetainedSessions} from '../../../ui-workshop/src/repository-management.ts';
import {createFileSession} from '../../../ui-workshop/src/repository-file-session.ts';
import {cloneGitHubRepository, cancelGitHubClone, getGitHubCloneProgress, githubRepositoryName, githubCloneError} from '../../../ui-workshop/src/repository-catalog.ts';
import {getRepositoryUpdates, checkRepositoryUpdates, getRepositoryUpdateProgress, cancelRepositoryUpdate, readRepositoryUpdateFile, reviewRepositoryUpdate, applyRepositoryUpdate, getRepositoryApplyProgress} from '../../../ui-workshop/src/repository-updates.ts';

const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const catalog = {organization: 'asMagicBrain', repositories: [{name: 'Workspace', privateRepo: true}], limits: {archiveBytes: 1024}};
async function withBridge(bridge, run) {
  const previous = globalThis.window;
  globalThis.window = {asMagicBrain: {native: true, ...bridge}};
  try {await run();} finally {if (previous === undefined) delete globalThis.window; else globalThis.window = previous;}
}

// Execute the actual preload, then model Electron's documented Error boundary:
// resolved plain objects are copied; rejected Errors retain message but lose code.
async function withPreloadBoundary(invoke,run,{getPathForFile=file=>file.name?`/fixture/${file.name}`:''}={}){
 const previous=globalThis.window;let exposed;const listeners=new Map(),sent=[];
 const electron={
  ipcRenderer:{invoke,on:(name,callback)=>listeners.set(name,callback),removeListener:name=>listeners.delete(name),send:(...args)=>sent.push(args)},webUtils:{getPathForFile},
  contextBridge:{exposeInMainWorld:(_name,api)=>{exposed=Object.fromEntries(Object.entries(api).map(([key,value])=>[key,typeof value==='function'?((...args)=>{
   const loseCode=error=>{throw new Error(error.message);};
   try{const result=value(...args);return result&&typeof result.then==='function'?result.then(value=>structuredClone(value),loseCode):result;}catch(error){return loseCode(error);}
  }):value]));}},
 };
 vm.runInNewContext(fs.readFileSync(new URL('../preload.cjs',import.meta.url),'utf8'),{require:name=>{assert.equal(name,'electron');return electron;}});
 globalThis.window={asMagicBrain:exposed};
 try{await run({wire:exposed,listeners,sent});}finally{if(previous===undefined)delete globalThis.window;else globalThis.window=previous;}
}

test('actual preload transports all coded failures as plain replies through a lossy Error boundary',async()=>{
 const cases=[['catalog',undefined,'RECOVERY_REQUIRED'],['read',{repo:'Workspace',path:'note.md',ref:''},'NOT_FOUND'],['readAsset',{repo:'Workspace',path:'image.png',ref:''},'ASSET_UNAVAILABLE'],['revealItem',{repo:'Workspace',path:'README.md',ref:''},'REVEAL_NOT_FOUND'],['bootstrap','Workspace','REPOSITORY_CHANGED'],['request',{repo:'Workspace',operation:'save',args:{}},'CONFLICT'],['importArchive',{name:'Docs',bytes:new ArrayBuffer(0)},'NAME_EXISTS'],['createRepository',{name:'Docs',requestId:'1570c1ce-8353-43d5-bc83-275127788382'},'NAME_EXISTS'],['renameRepository',{repository:'Workspace',name:'Docs'},'RECOVERY_REQUIRED'],['prepareExternalFiles',[{name:'note.md'}],'SYMLINK_UNSUPPORTED'],['pickExternalFiles',undefined,'IMPORT_BUSY'],['importExternalFiles',{repo:'Workspace',destination:'',ticket:'fixture'},'IMPORT_CANCELLED'],['cancelExternalFiles',{ticket:'fixture'},'INVALID_REQUEST'],['getBuildConfiguration',undefined,'BUILD_CONFIGURATION_INVALID'],['getAppearance',undefined,'RECOVERY_REQUIRED'],['setAppearance',{themeId:'light-default',hideUnavailable:false},'CONFLICT'],['windowAction','close','SERVICE_CLOSED']];
 let failure;
 await withPreloadBoundary(async()=>({ok:false,error:failure}),async({wire})=>{
  const bridge=getNativeBridge();assert.equal(getNativeBridge(),bridge,'adapter identity remains stable for native close routing');assert.equal(wire.responseVersion,1);
  for(const [method,args,code]of cases){failure={code,message:`Specific host message for ${method}`};await assert.rejects(bridge[method](args),error=>error instanceof Error&&error.code===code&&error.message===failure.message);}
  failure={code:'RECOVERY_REQUIRED',message:'Retain staged files for recovery.'};await assert.rejects(createLocalWorkspaceClient('Workspace').request('manage',{}),{code:'RECOVERY_REQUIRED',message:failure.message});
 });
});

test('plain native success replies unwrap once, preserving assets and close lifecycle callbacks',async()=>{
 const bytes=new Uint8Array([0,128,255]).buffer,calls=[];
 await withPreloadBoundary(async(channel,input)=>{calls.push([channel,structuredClone(input)]);return {ok:true,value:input?.method==='readAsset'?{mime:'image/png',data:bytes}:input?.method==='bootstrap'?{local:true,newDrafts:[]}:input?.method==='pickExternalFiles'?null:undefined};},async({listeners,sent})=>{
  assert.deepEqual(await createLocalWorkspaceClient('Workspace').bootstrap(),{local:true,newDrafts:[]});
  const asset=await readRepositoryAsset({repo:'Workspace',path:'image.png'});assert.equal(asset.mime,'image/png');assert.deepEqual(new Uint8Array(asset.data),new Uint8Array(bytes));
  const bridge=getNativeBridge();assert.equal(await bridge.pickExternalFiles(),null);assert.equal(await bridge.cancelExternalFiles({ticket:'done'}),undefined);
  const events=[],unsubscribe=bridge.onPrepareClose(message=>events.push(message));listeners.get('asmb:prepare-close')(null,{requestId:'close-1'});assert.deepEqual(events,[{requestId:'close-1'}]);unsubscribe();assert.equal(listeners.size,0);bridge.closeReady({requestId:'close-1',ok:true});assert.deepEqual(sent,[['asmb:close-ready',{requestId:'close-1',ok:true}]]);
 });
 assert.deepEqual(calls[1],['asmb:native',{method:'readAsset',args:{repo:'Workspace',path:'image.png',ref:''}}]);
});

test('preload-local refusals and transport failures are coded without parsing Error messages',async()=>{
 await withPreloadBoundary(async()=>{throw new Error('IPC connection unavailable');},async()=>{
  const bridge=getNativeBridge();await assert.rejects(bridge.prepareExternalFiles([]),{code:'INVALID_EXTERNAL_FILES'});await assert.rejects(bridge.prepareExternalFiles([{name:'synthetic'}]),{code:'INVALID_EXTERNAL_FILES'});await assert.rejects(bridge.catalog(),{code:'NATIVE_OPERATION_FAILED',message:'IPC connection unavailable'});
 },{getPathForFile:()=>''});
 await withPreloadBoundary(async()=>({unexpected:'reply'}),async()=>assert.rejects(getNativeBridge().catalog(),{code:'NATIVE_RESPONSE_INVALID'}));
});

test('native workspace passes exact bounded DTOs without HTTP bootstrap capabilities', async () => {
  const calls = [], value = {path: 'notes.md', text: '\ufefffirst\r\nsecond\rthird\n'};
  await withBridge({bootstrap: async repo => {calls.push(['bootstrap', repo]); return {local: true, newDrafts: []};}, request: async input => {calls.push(['request', input]); return value;}}, async () => {
    const client = createLocalWorkspaceClient('Workspace');
    assert.deepEqual(await client.bootstrap(), {local: true, newDrafts: []});
    assert.equal(await client.request('open', {path: 'notes.md'}), value);
  });
  assert.deepEqual(calls, [['bootstrap', 'Workspace'], ['request', {repo: 'Workspace', operation: 'open', args: {path: 'notes.md'}}]]);
});

test('reveal uses the actual preload and native close drain without saving or exposing absolute paths',async()=>{
 const calls=[],reply=deferred();
 await withPreloadBoundary(async(channel,input)=>{calls.push([channel,structuredClone(input)]);await reply.promise;return {ok:true};},async()=>{
  const input={repo:'Workspace',path:'notes/entry.md'},work=revealRepositoryItem(input);input.path='changed.md';
  let drained=false;const drain=waitForNativeOperations().then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);
  reply.resolve();assert.equal(await work,undefined);await drain;assert.equal(drained,true);
 });
 assert.deepEqual(calls,[['asmb:native',{method:'revealItem',args:{repo:'Workspace',path:'notes/entry.md',ref:''}}]]);
 await withBridge({},async()=>assert.rejects(revealRepositoryItem({repo:'Workspace',path:''}),{code:'REVEAL_UNAVAILABLE'}));
 await withBridge({revealItem:async()=>{throw Object.assign(Error('Select the current branch.'),{code:'HISTORICAL_REVISION'});}},async()=>assert.rejects(revealRepositoryItem({repo:'Workspace',path:'entry.md',ref:'refs/tags/v1'}),{code:'HISTORICAL_REVISION'}));
});

test('explicit HTTP transport stays independent even when a native bridge exists', async () => {
  await withBridge({catalog: () => assert.fail('HTTP test reached native bridge')}, async () => {
    const expected = {...catalog, capability: 'test-only'};
    assert.deepEqual(await loadRepositoryCatalog(async () => Response.json(expected)), expected);
  });
});

test('native catalog accepts no capability and ZIP import preserves original bytes', async () => {
  const bytes = new Uint8Array([80, 75, 3, 4, 255, 0, 127]), imported = {name: 'Imported', organization: 'asMagicBrain'};
  let received;
  await withBridge({catalog: async () => catalog, importArchive: async input => {received = input; return imported;}}, async () => {
    assert.deepEqual(await loadRepositoryCatalog(), catalog);
    assert.equal(await importRepositoryArchive(new File([bytes], 'file.zip'), 'Imported', catalog), imported);
  });
  assert.equal(received.name, 'Imported');
  assert.ok(received.bytes instanceof ArrayBuffer);
  assert.deepEqual(new Uint8Array(received.bytes), bytes);
});

test('new local repository uses an exact native DTO and participates in the close drain',async()=>{
 const calls=[],reply=deferred(),requestId='1570c1ce-8353-43d5-bc83-275127788382',created={name:'Notes',organization:'asMagicBrain',head:null,files:0,bytes:0};
 await withPreloadBoundary(async(channel,input)=>{calls.push([channel,structuredClone(input)]);await reply.promise;return {ok:true,value:created};},async()=>{
  const input={name:'Notes',requestId},work=createLocalRepository(input);input.name='Later caller mutation';let drained=false;const drain=waitForNativeOperations().then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);
  reply.resolve();assert.deepEqual(await work,created);await drain;assert.equal(drained,true);
 });
 assert.deepEqual(calls,[['asmb:native',{method:'createRepository',args:{name:'Notes',requestId}}]]);
});

test('repository creation refuses unavailable, invalid and unverified requests without falling back to HTTP',async()=>{
 const input={name:'Notes',requestId:'1570c1ce-8353-43d5-bc83-275127788382'};
 await withBridge({},async()=>assert.rejects(createLocalRepository(input),{code:'CREATE_UNAVAILABLE'}));
 await withBridge({createRepository:()=>assert.fail('Invalid request reached host')},async()=>{
  await assert.rejects(createLocalRepository({...input,name:'../escape'}),/Use 1–100/);
  await assert.rejects(createLocalRepository({...input,requestId:''}),/request is invalid/);
 });
 const result={name:'Notes',organization:'asMagicBrain',head:null,files:0,bytes:0};
 for(const invalid of [{...result,name:'Other'},{...result,head:'unexpected-commit'},{...result,files:1},{...result,bytes:1}])await withBridge({createRepository:async()=>invalid},async()=>assert.rejects(createLocalRepository(input),{code:'CREATE_UNVERIFIED'}));
 const failure=Object.assign(new Error('Choose a different name.'),{code:'NAME_EXISTS'});
 await withBridge({createRepository:async()=>{throw failure;}},async()=>assert.rejects(createLocalRepository(input),error=>error===failure));
});

test('creation failures give actionable local guidance while preserving adapter error codes',()=>{
 const failure=Object.assign(new Error('NAME_EXISTS'),{code:'NAME_EXISTS'});
 assert.match(repositoryCreationError(failure),/repository or folder.*already exists/);assert.equal(failure.code,'NAME_EXISTS');
 assert.match(repositoryCreationError(Object.assign(new Error('system detail'),{code:'ENOSPC'})),/free space/);
 assert.match(repositoryCreationError(Object.assign(new Error('system detail'),{code:'EACCES'})),/permissions/);
 assert.match(repositoryCreationError(Object.assign(new Error('system detail'),{code:'RECOVERY_REQUIRED'})),/Close and reopen/);
 assert.equal(repositoryCreationError(new Error('Specific operation refused.')),'Specific operation refused.');
});

test('GitHub clone URL validation accepts repository URLs and rejects credentials, query strings and nested views',()=>{
 assert.equal(githubRepositoryName('https://github.com/asMagicBrain/DES5002'),'DES5002');
 assert.equal(githubRepositoryName('https://github.com/ancorasir/asTeach-App.git'),'asTeach-App');
 assert.equal(githubRepositoryName(' https://github.com/owner/repo/ '),'repo');
 for(const invalid of ['git@github.com:owner/repo.git','http://github.com/owner/repo','https://github.com.attacker.test/owner/repo','https://user:secret@github.com/owner/repo','https://github.com/owner/repo?token=secret','https://github.com/owner/repo#token','https://github.com/owner/repo/tree/main','https://github.com/owner/..','https://github.com/owner/%2e%2e','https://github.com/owner/repo\\another'])assert.equal(githubRepositoryName(invalid),null,invalid);
});

test('actual preload exposes clone and GitHub display-state methods with coded failures intact',async()=>{
 const requestId='1570c1ce-8353-43d5-bc83-275127788382';
 const inputs=[['cloneRepository',{url:'https://github.com/owner/repo',name:'Local',requestId,useAccount:false}],['getCloneProgress',{requestId}],['cancelClone',{requestId}],['getGitHubConnection',undefined],['startGitHubConnection',undefined],['pollGitHubConnection',{requestId}],['cancelGitHubConnection',{requestId}],['openGitHubVerification',{requestId}],['disconnectGitHub',undefined]];
 const calls=[];
 await withPreloadBoundary(async(channel,input)=>{calls.push([channel,structuredClone(input)]);return {ok:false,error:{code:'GITHUB_UNAVAILABLE',message:'GitHub is unavailable. Try again.'}};},async()=>{
  for(const [method,args]of inputs)await assert.rejects(getNativeBridge()[method](args),{code:'GITHUB_UNAVAILABLE',message:'GitHub is unavailable. Try again.'});
 });
 assert.deepEqual(calls,inputs.map(([method,args])=>['asmb:native',{method,args}]));
});

test('clone adapter submits only the bounded request, waits for publication and preserves coded cancellation',async()=>{
 const requestId='1570c1ce-8353-43d5-bc83-275127788382',input={url:'https://github.com/owner/repo',name:'Local',requestId,useAccount:false},calls=[],reply=deferred();
 const result={name:'Local',organization:'asMagicBrain',head:'a'.repeat(40),files:1,bytes:42,branch:'main',sourceUrl:input.url};
 await withBridge({cloneRepository:async value=>{calls.push(['clone',value]);return reply.promise;},getCloneProgress:async value=>{calls.push(['progress',value]);return {phase:'receiving'};},cancelClone:async value=>{calls.push(['cancel',value]);}},async()=>{
  const work=cloneGitHubRepository({...input,token:'must not cross',absolutePath:'/outside'});let drained=false;const drain=waitForNativeOperations().then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);
  assert.deepEqual(await getGitHubCloneProgress(requestId),{phase:'receiving'});await cancelGitHubClone(requestId);assert.equal(drained,false,'Cancellation request does not imply publication has settled');
  reply.resolve(result);assert.deepEqual(await work,result);await drain;assert.equal(drained,true);
 });
 assert.deepEqual(calls,[['clone',input],['progress',{requestId}],['cancel',{requestId}]]);
 await withBridge({cloneRepository:async()=>{throw Object.assign(new Error('Cancelled'),{code:'CLONE_CANCELLED'});}},async()=>assert.rejects(cloneGitHubRepository(input),{code:'CLONE_CANCELLED'}));
 assert.equal(githubCloneError({code:'CLONE_CANCELLED'}),'Cloning cancelled.');
});

test('clone refuses unavailable/invalid requests and unverified host results without HTTP fallback',async()=>{
 const input={url:'https://github.com/owner/repo',name:'Local',requestId:'1570c1ce-8353-43d5-bc83-275127788382',useAccount:false};
 await withBridge({},async()=>assert.rejects(cloneGitHubRepository(input),{code:'CLONE_UNAVAILABLE'}));
 await withBridge({cloneRepository:()=>assert.fail('Invalid input reached host')},async()=>{
  await assert.rejects(cloneGitHubRepository({...input,url:'https://github.com/owner/repo?token=secret'}),{code:'INVALID_GITHUB_URL'});
  await assert.rejects(cloneGitHubRepository({...input,name:'../outside'}),/Use 1–100/);
  await assert.rejects(cloneGitHubRepository({...input,requestId:''}),/request is invalid/);
 });
 const result={name:'Local',organization:'asMagicBrain',head:null,files:0,bytes:0,branch:'main',sourceUrl:input.url};
 await withBridge({cloneRepository:async()=>result},async()=>assert.deepEqual(await cloneGitHubRepository(input),result));
 for(const invalid of [{...result,name:'Other'},{...result,head:'not-a-hash'},{...result,files:-1},{...result,sourceUrl:'https://other.example/repo'}])await withBridge({cloneRepository:async()=>invalid},async()=>assert.rejects(cloneGitHubRepository(input),{code:'CLONE_UNVERIFIED'}));
});

test('actual preload carries update-check and immutable comparison failures without losing codes',async()=>{
 const requestId='1570c1ce-8353-43d5-bc83-275127788382';
 const inputs=[['getRepositoryUpdates',{repo:'Cloned'}],['checkRepositoryUpdates',{repo:'Cloned',requestId,useAccount:false}],['getRepositoryUpdateProgress',{requestId}],['cancelRepositoryUpdate',{requestId}],['readRepositoryUpdateFile',{repo:'Cloned',checkId:requestId,path:'README.md'}]],calls=[];
 await withPreloadBoundary(async(channel,input)=>{calls.push([channel,structuredClone(input)]);return {ok:false,error:{code:'UPDATES_STALE',message:'Check again.'}};},async()=>{
  for(const [method,args]of inputs)await assert.rejects(getNativeBridge()[method](args),{code:'UPDATES_STALE',message:'Check again.'});
 });
 assert.deepEqual(calls,inputs.map(([method,args])=>['asmb:native',{method,args}]));
});

test('updates separate local inspection from explicit network requests and remain in native close drain',async()=>{
 const requestId='1570c1ce-8353-43d5-bc83-275127788382',calls=[],reply=deferred();
 const result={checkId:requestId,sourceUrl:'https://github.com/owner/repo',branch:'main',checkedAt:1,localHead:'a'.repeat(40),remoteHead:'b'.repeat(40),relation:'remote-ahead',ahead:0,behind:1,stale:false,files:[{path:'README.md',status:'modified'}],totalFiles:1,truncated:false};
 await withBridge({getRepositoryUpdates:async input=>{calls.push(['inspect',input]);return {eligible:true};},checkRepositoryUpdates:async input=>{calls.push(['check',input]);return reply.promise;},getRepositoryUpdateProgress:async input=>{calls.push(['progress',input]);return {phase:'receiving'};},cancelRepositoryUpdate:async input=>{calls.push(['cancel',input]);}},async()=>{
  assert.deepEqual(await getRepositoryUpdates('Cloned'),{eligible:true});assert.deepEqual(calls,[['inspect',{repo:'Cloned'}]],'Inspection does not start a download');
  const work=checkRepositoryUpdates({repo:'Cloned',requestId,useAccount:false,url:'https://evil.invalid',token:'must-not-cross',ref:'arbitrary'});
  let drained=false;const drain=waitForNativeOperations().then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);
  assert.deepEqual(await getRepositoryUpdateProgress(requestId),{phase:'receiving'});await cancelRepositoryUpdate(requestId);assert.equal(drained,false,'Cancel awaits settlement of the original download');
  reply.resolve(result);assert.deepEqual(await work,result);await drain;assert.equal(drained,true);
 });
 assert.deepEqual(calls,[['inspect',{repo:'Cloned'}],['check',{repo:'Cloned',requestId,useAccount:false}],['progress',{requestId}],['cancel',{requestId}]]);
});

test('comparison previews preserve bytes and refuse responses for another snapshot or path',async()=>{
 const input={repo:'Cloned',checkId:'verified-check',path:'README.md'};
 const result={...input,status:'modified',before:'original\r\n',after:'incoming Ω\r\n',beforeMode:'100644',afterMode:'100644',beforeSize:10,afterSize:13,binary:false,unsupported:false,previewOmitted:false};
 await withBridge({getRepositoryUpdates:async()=>({eligible:true}),readRepositoryUpdateFile:async value=>{assert.deepEqual(value,input);return result;}},async()=>assert.deepEqual(await readRepositoryUpdateFile({...input,absolutePath:'/outside',ref:'arbitrary'}),result));
 for(const invalid of [{...result,checkId:'other-check'},{...result,path:'other.md'},{...result,beforeSize:-1},{...result,after:undefined}])await withBridge({getRepositoryUpdates:async()=>({eligible:true}),readRepositoryUpdateFile:async()=>invalid},async()=>assert.rejects(readRepositoryUpdateFile(input),{code:'UPDATES_RESPONSE_INVALID'}));
 await withBridge({getRepositoryUpdates:async()=>({eligible:true}),readRepositoryUpdateFile:async()=>{throw Object.assign(Error('Check again'),{code:'COMPARISON_EXPIRED'});}},async()=>assert.rejects(readRepositoryUpdateFile(input),{code:'COMPARISON_EXPIRED'}));
});

test('update review and apply bind exact host review identity without arbitrary refs or credentials',async()=>{
 const review={checkId:'check-1',reviewId:'review-1',canApply:true,localHead:'a'.repeat(40),remoteHead:'b'.repeat(40),branch:'main',totalFiles:2,behind:1,expiresAt:Date.now()+60000,dirtyFileCount:0,draftCount:0};
 const input={repo:'Cloned',checkId:review.checkId,reviewId:review.reviewId,requestId:'1570c1ce-8353-43d5-bc83-275127788382'};
 const result={status:'applied',requestId:input.requestId,checkId:input.checkId,previousHead:review.localHead,head:review.remoteHead,branch:'main'},calls=[];
 await withBridge({getRepositoryUpdates:async()=>({eligible:true}),reviewRepositoryUpdate:async value=>{calls.push(['review',value]);return review;},applyRepositoryUpdate:async value=>{calls.push(['apply',value]);return result;},getRepositoryApplyProgress:async value=>{calls.push(['progress',value]);return{requestId:input.requestId,phase:'applying'};}},async()=>{
  assert.deepEqual(await reviewRepositoryUpdate({repo:'Cloned',checkId:review.checkId,ref:'arbitrary',token:'must-not-cross'}),review);
  assert.deepEqual(await applyRepositoryUpdate({...input,head:'unreviewed',url:'https://evil.invalid',credential:'must-not-cross'},review),result);
  assert.deepEqual(await getRepositoryApplyProgress(input.requestId),{requestId:input.requestId,phase:'applying'});
 });
 assert.deepEqual(calls,[['review',{repo:'Cloned',checkId:review.checkId}],['apply',input],['progress',{requestId:input.requestId}]]);
});

test('update review rejects mismatched snapshots and unsafe ready responses; blocked work remains explicit',async()=>{
 const input={repo:'Cloned',checkId:'check-1'};
 const blocked={checkId:input.checkId,reviewId:null,canApply:false,reason:'drafts',localHead:'a'.repeat(40),remoteHead:'b'.repeat(40),branch:'main',totalFiles:1,behind:1,expiresAt:null,dirtyFileCount:0,draftCount:2};
 await withBridge({getRepositoryUpdates:async()=>({eligible:true}),reviewRepositoryUpdate:async()=>blocked},async()=>assert.deepEqual(await reviewRepositoryUpdate(input),blocked));
 for(const invalid of [{...blocked,checkId:'other'},{...blocked,canApply:true},{...blocked,draftCount:-1},{...blocked,dirtyFileCount:null},{...blocked,remoteHead:'invalid'},{...blocked,expiresAt:NaN},{...blocked,totalFiles:-1}]){
  await withBridge({getRepositoryUpdates:async()=>({eligible:true}),reviewRepositoryUpdate:async()=>invalid},async()=>assert.rejects(reviewRepositoryUpdate(input),{code:'UPDATES_RESPONSE_INVALID'}));
 }
 await withBridge({getRepositoryUpdates:async()=>({eligible:true}),applyRepositoryUpdate:()=>assert.fail('Blocked review reached host')},async()=>assert.rejects(applyRepositoryUpdate({...input,reviewId:'invented',requestId:'request'},blocked),{code:'UPDATES_RESPONSE_INVALID'}));
});

test('applied result must match reviewed branch, commits and request; completion drains before native close',async()=>{
 const review={checkId:'check-1',reviewId:'review-1',canApply:true,localHead:'a'.repeat(40),remoteHead:'b'.repeat(40),branch:'main',totalFiles:1,behind:1,expiresAt:Date.now()+60000,dirtyFileCount:0,draftCount:0};
 const input={repo:'Cloned',checkId:review.checkId,reviewId:review.reviewId,requestId:'request-1'};
 const result={status:'applied',requestId:input.requestId,checkId:input.checkId,previousHead:review.localHead,head:review.remoteHead,branch:review.branch};
 for(const invalid of [{...result,requestId:'other'},{...result,checkId:'other'},{...result,previousHead:'c'.repeat(40)},{...result,head:'c'.repeat(40)},{...result,branch:'other'},{...result,status:'pending'}]){
  await withBridge({getRepositoryUpdates:async()=>({eligible:true}),applyRepositoryUpdate:async()=>invalid},async()=>assert.rejects(applyRepositoryUpdate(input,review),{code:'UPDATES_RESPONSE_INVALID'}));
 }
 const pending=deferred();await withBridge({getRepositoryUpdates:async()=>({eligible:true}),applyRepositoryUpdate:()=>pending.promise},async()=>{
  const work=applyRepositoryUpdate(input,review);let drained=false;const drain=waitForNativeOperations().then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);
  pending.resolve(result);assert.deepEqual(await work,result);await drain;assert.equal(drained,true);
 });
 for(const invalid of [{requestId:'other',phase:'applying'},{requestId:input.requestId,phase:'cancelled'}])await withBridge({getRepositoryUpdates:async()=>({eligible:true}),getRepositoryApplyProgress:async()=>invalid},async()=>assert.rejects(getRepositoryApplyProgress(input.requestId),{code:'UPDATES_RESPONSE_INVALID'}));
});

test('actual preload transports apply failures and review tokens as plain replies',async()=>{
 const inputs=[['reviewRepositoryUpdate',{repo:'Cloned',checkId:'check'}],['applyRepositoryUpdate',{repo:'Cloned',checkId:'check',reviewId:'review',requestId:'request'}],['getRepositoryApplyProgress',{requestId:'request'}]],calls=[];
 await withPreloadBoundary(async(channel,input)=>{calls.push([channel,structuredClone(input)]);return{ok:false,error:{code:'APPLY_STALE',message:'Review again.'}};},async()=>{
  for(const [method,input]of inputs)await assert.rejects(getNativeBridge()[method](input),{code:'APPLY_STALE',message:'Review again.'});
 });
 assert.deepEqual(calls,inputs.map(([method,args])=>['asmb:native',{method,args}]));
});

test('native repository rename passes exact names, verifies default catalog and participates in close drain',async()=>{
 const operation=deferred(),calls=[],renamed={repository:'Personal',previousName:'Workspace',organization:'asMagicBrain',defaultRepository:'Personal',repositories:[{name:'Personal',privateRepo:true}]};
 await withBridge({renameRepository:input=>{calls.push(input);return operation.promise;}},async()=>{
  const input={repository:'Workspace',name:'Personal'},work=renameRepository(input);input.name='later caller mutation';let drained=false;const drain=waitForNativeOperations().then(()=>{drained=true;});
  await Promise.resolve();assert.equal(drained,false);operation.resolve(renamed);assert.deepEqual(await work,renamed);await drain;assert.equal(drained,true);
 });
 assert.deepEqual(calls,[{repository:'Workspace',name:'Personal'}]);
});

test('repository rename refuses unavailable or unverifiable native responses without HTTP fallback',async()=>{
 await withBridge({},async()=>assert.rejects(renameRepository({repository:'Workspace',name:'Personal'}),{code:'RENAME_UNAVAILABLE'}));
 await withBridge({renameRepository:async()=>({repository:'Personal',previousName:'Workspace',organization:'asMagicBrain',defaultRepository:'Workspace',repositories:[{name:'Personal',privateRepo:true}]})},async()=>assert.rejects(renameRepository({repository:'Workspace',name:'Personal'}),{code:'RENAME_UNVERIFIED'}));
 const error=Object.assign(new Error('Name is already in use'),{code:'NAME_EXISTS'});
 await withBridge({renameRepository:async()=>{throw error;}},async()=>assert.rejects(renameRepository({repository:'Workspace',name:'Personal'}),failure=>failure===error));
});

test('native error codes and read identity survive the adapter', async () => {
  const failure = Object.assign(new Error('The saved file changed.'), {code: 'CONFLICT'}), calls = [];
  await withBridge({request: async () => {throw failure;}, read: async input => {calls.push(input); return {content: 'exact\r\n'};}}, async () => {
    await assert.rejects(createLocalWorkspaceClient('Workspace').request('save', {path: 'file.md'}), error => error === failure && error.code === 'CONFLICT');
    assert.deepEqual(await readRepository({repo: 'Workspace', path: 'file.md', ref: 'refs/tags/v1'}), {content: 'exact\r\n'});
  });
  assert.deepEqual(calls, [{repo: 'Workspace', path: 'file.md', ref: 'refs/tags/v1'}]);
});

test('aborted native reads cannot publish stale results', async () => {
  const result = deferred(), controller = new AbortController();
  await withBridge({read: () => result.promise}, async () => {
    const read = readRepository({repo: 'Workspace'}, controller.signal);
    controller.abort(); result.resolve({content: 'stale'});
    await assert.rejects(read, error => error.name === 'AbortError');
  });
});

test('native assets preserve MIME, binary bytes and repository/ref identity without HTTP fallback',async()=>{
  const data=new Uint8Array([0,128,255]).buffer,calls=[];
  await withBridge({readAsset:async input=>{calls.push(input);return {mime:'image/png',data};}},async()=>{
    const result=await readRepositoryAsset({repo:'Docs',path:'assets/image.png',ref:'refs/tags/original'});
    assert.equal(result.mime,'image/png');assert.deepEqual(new Uint8Array(result.data),new Uint8Array(data));
  });
  assert.deepEqual(calls,[{repo:'Docs',path:'assets/image.png',ref:'refs/tags/original'}]);
  await withBridge({},async()=>assert.rejects(readRepositoryAsset({repo:'Docs',path:'image.png'}),{code:'ASSET_UNAVAILABLE'}));
});

test('asset response validates media types and rejects stale results after navigation',async()=>{
  const result=deferred(),controller=new AbortController();
  await withBridge({readAsset:()=>result.promise},async()=>{
    const asset=readRepositoryAsset({repo:'Docs',path:'image.png'},controller.signal);controller.abort();result.resolve({mime:'image/png',data:new ArrayBuffer(1)});
    await assert.rejects(asset,error=>error.name==='AbortError');
  });
  for(const value of [{mime:'text/html',data:new ArrayBuffer(1)},{mime:'image/png',data:'not bytes'}])await withBridge({readAsset:async()=>value},async()=>assert.rejects(readRepositoryAsset({repo:'Docs',path:'image.png'}),{code:'ASSET_UNAVAILABLE'}));
});

test('close drain includes preparation before an IPC call and subsequent pending work', async () => {
  const first = deferred(), second = deferred(), events = [];
  const operation = nativeOperation(async () => {await first.promise; events.push('prepared'); await nativeOperation(() => second.promise);});
  let finished = false;
  const drain = waitForNativeOperations().then(() => {finished = true;});
  first.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(finished, false);
  second.resolve(); await operation; await drain;
  assert.deepEqual(events, ['prepared']); assert.equal(finished, true);
});

function closeHarness(overrides = {}) {
  const events = [], replies = [];
  const handle = createNativeCloseHandler({composing: () => false, prepare: () => {events.push('prepare');}, lock: value => events.push(['lock', value]), settle: async () => {events.push('settle');}, acknowledge: value => replies.push(value), report: error => events.push(['error', error]), ...overrides});
  return {handle, events, replies};
}

test('native close locks immediately and acknowledges only after draft and host drains', async () => {
  const draft = deferred(), host = deferred();
  const state = closeHarness({prepare: () => draft.promise, settle: () => host.promise});
  const closing = state.handle({requestId: 'one'});
  assert.deepEqual(state.events, [['lock', true]]); assert.deepEqual(state.replies, []);
  draft.resolve(); await Promise.resolve(); assert.deepEqual(state.replies, []);
  host.resolve(); await closing;
  assert.deepEqual(state.replies, [{requestId: 'one', ok: true}]);
  assert.deepEqual(state.events, [['lock', true]], 'success stays locked until the actual window closes');
});

test('close waits for admitted apply reload and final unlock before the editor leave guard', async () => {
  const reload = deferred(), cleanup = deferred(), events = [];
  let busy = true;
  const operation = nativeOperation(async () => {
    try {await reload.promise; events.push('reloaded');}
    finally {await cleanup.promise; busy = false; events.push('unlocked');}
  });
  const state = closeHarness({prepare: async () => {
    await waitForNativeOperations();
    events.push('leave-guard');
    if (busy) throw new Error('Wait for the current local operation.');
  }});
  const closing = state.handle({requestId: 'apply-reload'});
  assert.deepEqual(state.events, [['lock', true]], 'window input locks before waiting');
  reload.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(state.replies, []); assert.equal(busy, true);
  cleanup.resolve(); await operation; await closing;
  assert.deepEqual(events, ['reloaded', 'unlocked', 'leave-guard']);
  assert.deepEqual(state.replies, [{requestId: 'apply-reload', ok: true}]);
});

test('handled apply refusal drains its cleanup but unsaved filename still refuses close afterward', async () => {
  const host = deferred(), cleanup = deferred(), events = [];
  const operation = nativeOperation(async () => {
    try {await nativeOperation(() => host.promise);}
    catch {events.push('refusal-reported');}
    finally {await cleanup.promise; events.push('unlocked');}
  });
  const state = closeHarness({prepare: async () => {
    await waitForNativeOperations();
    events.push('filename-guard');
    assertFilenameIntentRetained([{path: 'README.md', proposedPath: 'Renamed.md'}]);
  }});
  await Promise.resolve(); // Admit the inner native request before starting close.
  const closing = state.handle({requestId: 'apply-refused'});
  host.reject(new Error('Local files changed after review.'));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(state.replies, [], 'handled native refusal cannot finish close before cleanup');
  cleanup.resolve(); await operation; await closing;
  assert.deepEqual(events, ['refusal-reported', 'unlocked', 'filename-guard']);
  assert.equal(state.replies[0].ok, false);
  assert.match(state.replies[0].error, /Save or revert filename changes/);
  assert.deepEqual(state.events.at(-2), ['lock', false]);
});

test('composition refuses close without starting a draft write or changing focus', async () => {
  const state = closeHarness({composing: () => true});
  await state.handle({requestId: 'ime'});
  assert.equal(state.events.includes('prepare'), false);
  assert.equal(state.events.some(event => Array.isArray(event) && event[0] === 'lock' && event[1]), false);
  assert.match(state.replies[0].error, /composition/); assert.equal(state.replies[0].ok, false);
});

test('checkpoint or busy failure unlocks and allows a successful retry', async () => {
  let fail = true;
  const state = closeHarness({prepare: () => {if (fail) throw new Error('Wait for the current local operation.');}});
  await state.handle({requestId: 'failed'});
  assert.equal(state.replies[0].ok, false); assert.deepEqual(state.events[0], ['lock', false]);
  fail = false; await state.handle({requestId: 'retry'});
  assert.deepEqual(state.replies[1], {requestId: 'retry', ok: true});
});

test('asynchronous persistence failure keeps the window open with the actual error', async () => {
  const state = closeHarness({prepare: async () => {throw new Error('Checkpoint could not be written.');}});
  await state.handle({requestId: 'disk'});
  assert.deepEqual(state.replies, [{requestId: 'disk', ok: false, error: 'Checkpoint could not be written.'}]);
  assert.deepEqual(state.events.slice(0, 2), [['lock', true], ['lock', false]]);
});

test('host cancellation after renderer success unlocks without a second acknowledgement', async () => {
  const state = closeHarness();
  await state.handle({requestId: 'one'});
  await state.handle({requestId: 'one', cancelled: true, error: 'Host drain failed.'});
  assert.equal(state.replies.length, 1); assert.deepEqual(state.events.at(-2), ['lock', false]);
  await state.handle({requestId: 'two'}); assert.deepEqual(state.replies.at(-1), {requestId: 'two', ok: true});
});

test('startup and editing share one close subscription with an atomic handler handoff', async () => {
  let callback, subscriptions = 0;
  const replies = [], bridge = {onPrepareClose: handler => {subscriptions++; callback = handler;}, closeReady: value => replies.push(value)};
  installNativeCloseRouter(bridge);
  callback({requestId: 'startup'});
  const pending = deferred();
  const remove = registerNativeCloseHandler(bridge, async ({requestId}) => {await pending.promise; bridge.closeReady({requestId, ok: true});});
  callback({requestId: 'editing'});
  assert.equal(subscriptions, 1); assert.deepEqual(replies, [{requestId: 'startup', ok: true}]);
  pending.resolve(); await Promise.resolve(); assert.deepEqual(replies.at(-1), {requestId: 'editing', ok: true});
  remove(); callback({requestId: 'startup-again'}); assert.equal(replies.at(-1).requestId, 'startup-again');
});

test('existing filename intent blocks close even in a background session', () => {
  assert.throws(() => assertFilenameIntentRetained([{path: 'active.md', proposedPath: 'active.md'}, {path: 'old.md', proposedPath: 'new.md'}]), /Save or revert filename changes before closing/);
  assert.doesNotThrow(() => assertFilenameIntentRetained([{path: 'old.md', proposedPath: 'old.md'}]));
});

test('new-file names are already checkpointed and do not trigger the rename close guard', () => {
  assert.doesNotThrow(() => assertFilenameIntentRetained([{isNew: true, path: 'untitled.md', proposedPath: 'notes/recovered.md'}]));
});

test('restored drafts follow a later folder move before their next open', () => {
  const session = createFileSession({path:'notes/file.md',documentId:'retained',sourceHash:'a'.repeat(64),text:'\ufeffSaved\r\n',readOnly:false});
  session.buffer.applyChanges([{from:0,to:0,insert:'Private draft\n'}]);
  const other = createFileSession({path:'notes-other/file.md',documentId:'other',sourceHash:'b'.repeat(64),text:'Unrelated',readOnly:false});
  const originalBuffer = session.buffer, originalRaw = session.buffer.getRawText();
  const sessions = new Map(), trashed = new Map([[session.id,session],[other.id,other]]);
  restoreRetainedSessions(sessions,trashed,['notes']);
  assert.equal(sessions.get('retained'),session);
  assert.equal(trashed.has('retained'),false);
  assert.equal(trashed.get('other'),other,'restoring a folder does not revive a similarly named Trash entry');
  remapSessions(sessions.values(),[{from:'notes',to:'archive/notes'}]);
  assert.equal(session.path,'archive/notes/file.md');
  assert.equal(session.proposedPath,'archive/notes/file.md');
  assert.equal(session.buffer,originalBuffer,'the same source buffer and its history remain active');
  assert.equal(session.buffer.getRawText(),originalRaw);
  assert.equal(session.saved,'\ufeffSaved\r\n');
  assert.equal(session.sourceHash,'a'.repeat(64));
});


test('build configuration crosses the actual preload as read-only plain data',async()=>{
 const configuration={channel:'preview',presentation:'implemented-only',canToggleUnavailable:false,validationOnly:false};
 const calls=[];
 await withPreloadBoundary(async(channel,input)=>{calls.push([channel,structuredClone(input)]);return {ok:true,value:configuration};},async()=>{
  assert.deepEqual(await getNativeBridge().getBuildConfiguration(),configuration);
 });
 assert.deepEqual(calls,[['asmb:native',{method:'getBuildConfiguration',args:undefined}]]);
});
