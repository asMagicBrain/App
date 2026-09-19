import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createCloneCoordinator} from './clone-coordinator.mjs';

const request = (useAccount = false) => ({url: 'https://github.com/ancorasir/asTeach-App', name: 'Sample', requestId: randomUUID(), useAccount});
const deferred = () => {let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b;}); return {promise,resolve,reject};};
const cancelled = () => Object.assign(new Error('Cancelled'), {code:'CLONE_CANCELLED'});

test('public clone never requests a credential; progress exposes only admitted phases', async () => {
  const input=request(); let calls=0;
  const c=createCloneCoordinator({getCredential:()=>{throw Error('must not read vault');},clone:async (value, options)=>{
    calls++; assert.equal(value.url,input.url+'.git'); assert.equal(options.credential,undefined);
    options.onProgress({phase:'receiving',token:'secret'});
    options.onProgress({phase:'untrusted provider output'});
    assert.deepEqual(c.getCloneProgress({requestId:input.requestId}),{requestId:input.requestId,phase:'receiving'});
    return {name:'Sample'};
  }});
  const result=await c.cloneRepository(input); assert.deepEqual(result,{name:'Sample'});
  assert.deepEqual(await c.cloneRepository(input),result); assert.equal(calls,1);
  assert.equal(c.getCloneProgress({requestId:input.requestId}).phase,'complete');
  await c.close(); await assert.rejects(c.cloneRepository(request()),{code:'SERVICE_CLOSED'});
});

test('credential reaches only the host clone; validation and request conflicts precede credential access',async()=>{
  let reads=0; const c=createCloneCoordinator({getCredential:async()=>{reads++;return {token:'sensitive'};},clone:async(value,options)=>{
    assert.deepEqual(options.credential,{token:'sensitive'}); assert.deepEqual(Object.keys(value).sort(),['name','requestId','url']);return {name:value.name};
  }});
  for(const value of [{...request(true),token:'x'},{...request(true),url:'https://evil.example/a/b'},{...request(true),name:'../x'}])await assert.rejects(c.cloneRepository(value));
  assert.equal(reads,0); const input=request(true); await c.cloneRepository(input);
  for(const value of [{...input,name:'Other'},{...input,useAccount:false}])await assert.rejects(c.cloneRepository(value),{code:'REQUEST_CONFLICT'});
  assert.equal(reads,1); assert.doesNotMatch(JSON.stringify(c.getCloneProgress({requestId:input.requestId})),/sensitive|token/);
});

test('in-flight replay shares one job; other jobs wait and failed job can retry',async()=>{
  const gate=deferred(); let calls=0;
  const c=createCloneCoordinator({clone:()=>{calls++;return gate.promise;}}), input=request();
  const first=c.cloneRepository(input); assert.equal(c.cloneRepository(input),first);
  await assert.rejects(c.cloneRepository(request()),{code:'CLONE_BUSY'});
  gate.reject(Error('network')); await assert.rejects(first,/network/);
  assert.equal(c.getCloneProgress({requestId:input.requestId}).phase,'failed');
  await assert.rejects(c.cloneRepository(input),/network/); assert.equal(calls,2); await c.drain();
});

test('cancellation during credential acquisition never starts a clone and waits for acquisition to settle',async()=>{
  const gate=deferred(); let calls=0;
  const c=createCloneCoordinator({getCredential:()=>gate.promise,clone:async()=>{calls++;}}),input=request(true);
  const job=c.cloneRepository(input); const cancellation=c.cancelClone({requestId:input.requestId});
  gate.resolve({token:'secret'}); await assert.rejects(job,{code:'CLONE_CANCELLED'}); await cancellation;
  assert.equal(calls,0); assert.equal(c.getCloneProgress({requestId:input.requestId}).phase,'cancelled');
});

test('publication that completes despite cancellation remains a successful registered clone',async()=>{
  const gate=deferred(); const c=createCloneCoordinator({clone:()=>gate.promise}),input=request();
  const job=c.cloneRepository(input); const cancellation=c.cancelClone({requestId:input.requestId});
  gate.resolve({name:'Sample'}); await cancellation; assert.equal((await job).name,'Sample');
  assert.equal(c.getCloneProgress({requestId:input.requestId}).phase,'complete');
});

test('disconnect cancels an authenticated clone before forgetting identity and blocks new authenticated jobs',async()=>{
  const started=deferred(), forgetting=deferred(); let aborted=false, forgotten=false;
  const c=createCloneCoordinator({getCredential:async()=>({token:'secret'}),clone:async(value,{signal})=>{
    started.resolve(); return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(cancelled());},{once:true}));
  }}),input=request(true); const job=c.cloneRepository(input); await started.promise;
  const disconnect=c.disconnect(async()=>{assert.equal(aborted,true);forgotten=true;await forgetting.promise;return {state:'signed-out'};});
  await assert.rejects(job,{code:'CLONE_CANCELLED'});
  await assert.rejects(c.cloneRepository(request(true)),{code:'GITHUB_BUSY'});
  await assert.rejects(c.disconnect(()=>{}),{code:'GITHUB_BUSY'});
  forgetting.resolve(); assert.deepEqual(await disconnect,{state:'signed-out'}); assert.equal(forgotten,true);
});

test('disconnect leaves a public clone running; close aborts and awaits its settlement',async()=>{
  let signal; const gate=deferred(); const c=createCloneCoordinator({clone:async(value,options)=>{signal=options.signal;return gate.promise;}}),input=request();
  const job=c.cloneRepository(input); await c.disconnect(async()=>{}); assert.equal(signal.aborted,false);
  let drained=false; const drain=c.drain().then(()=>{drained=true;}); const close=c.close();
  assert.equal(signal.aborted,true); assert.equal(drained,false); gate.reject(cancelled());
  await assert.rejects(job,{code:'CLONE_CANCELLED'}); await Promise.all([drain,close]); assert.equal(drained,true);
  assert.throws(()=>c.cancelClone({requestId:randomUUID()}),{code:'CLONE_NOT_FOUND'});
});

test('preparing close settles cancellation and prevents new jobs; failed draft close can resume',async()=>{
  const c=createCloneCoordinator({clone:async(value,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(cancelled()),{once:true}))}),input=request();
  const job=c.cloneRepository(input); const preparation=c.prepareClose();
  await assert.rejects(c.cloneRepository(request()),{code:'SERVICE_CLOSED'});
  await assert.rejects(job,{code:'CLONE_CANCELLED'}); await preparation;
  c.resume(); const retry=c.cloneRepository(input); await c.close(); await assert.rejects(retry,{code:'CLONE_CANCELLED'});
});
