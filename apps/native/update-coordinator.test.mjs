import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createUpdateCoordinator} from './update-coordinator.mjs';

const request = (useAccount = false) => ({repo: 'Example', requestId: randomUUID(), useAccount});
const deferred = () => {let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b;}); return {promise,resolve,reject};};
const cancelled = () => Object.assign(new Error('Cancelled'), {code:'UPDATE_CANCELLED'});

test('anonymous updates do not read credentials; only known progress crosses the boundary', async () => {
  const input=request(); let calls=0;
  const coordinator=createUpdateCoordinator({getCredential:()=>{throw Error('vault must not be read');},check:async(value,options)=>{
    calls++; assert.deepEqual(value,{repo:input.repo,requestId:input.requestId}); assert.equal(options.credential,undefined);
    options.onProgress({phase:'receiving',token:'secret'}); options.onProgress({phase:'untrusted stderr'});
    assert.deepEqual(coordinator.getRepositoryUpdateProgress({requestId:input.requestId}),{requestId:input.requestId,phase:'receiving'});
    return {checkId:input.requestId,relation:'up-to-date'};
  }});
  const result=await coordinator.checkRepositoryUpdates(input);
  assert.deepEqual(await coordinator.checkRepositoryUpdates(input),result); assert.equal(calls,1);
  assert.equal(coordinator.getRepositoryUpdateProgress({requestId:input.requestId}).phase,'complete');
  await coordinator.close(); await assert.rejects(coordinator.checkRepositoryUpdates(request()),{code:'SERVICE_CLOSED'});
});

test('validation and replay conflicts precede credential access, and credentials stay host-only',async()=>{
  let reads=0;const c=createUpdateCoordinator({getCredential:async()=>{reads++;return {token:'secret-token'};},check:async(value,{credential})=>{
    assert.deepEqual(Object.keys(value).sort(),['repo','requestId']); assert.deepEqual(credential,{token:'secret-token'}); return {checkId:value.requestId};
  }});
  for(const bad of [{...request(true),url:'https://evil.invalid'},{...request(true),repo:'../x'},{...request(true),requestId:'bad'},{...request(true),useAccount:'true'}])await assert.rejects(c.checkRepositoryUpdates(bad),{code:'INVALID_REQUEST'});
  assert.equal(reads,0);const input=request(true);await c.checkRepositoryUpdates(input);
  await assert.rejects(c.checkRepositoryUpdates({...input,repo:'Other'}),{code:'REQUEST_CONFLICT'});
  await assert.rejects(c.checkRepositoryUpdates({...input,useAccount:false}),{code:'REQUEST_CONFLICT'});
  assert.equal(reads,1);assert.doesNotMatch(JSON.stringify(c.getRepositoryUpdateProgress({requestId:input.requestId})),/token|secret/);
});

test('in-flight replay shares acquisition; another job is busy and failed requests can retry',async()=>{
  const gate=deferred();let calls=0;const c=createUpdateCoordinator({check:()=>{calls++;return gate.promise;}}),input=request();
  const first=c.checkRepositoryUpdates(input);assert.equal(c.checkRepositoryUpdates(input),first);
  await assert.rejects(c.checkRepositoryUpdates(request()),{code:'UPDATE_BUSY'});
  gate.reject(Error('network'));await assert.rejects(first,/network/);
  assert.equal(c.getRepositoryUpdateProgress({requestId:input.requestId}).phase,'failed');
  await assert.rejects(c.checkRepositoryUpdates(input),/network/);assert.equal(calls,2);await c.drain();
});

test('cancel during credential acquisition waits for it and never starts network',async()=>{
  const gate=deferred();let calls=0;const c=createUpdateCoordinator({getCredential:()=>gate.promise,check:async()=>{calls++;}}),input=request(true);
  const job=c.checkRepositoryUpdates(input),cancel=c.cancelRepositoryUpdate({requestId:input.requestId});
  gate.resolve({token:'secret'});await assert.rejects(job,{code:'UPDATE_CANCELLED'});await cancel;assert.equal(calls,0);
});

test('disconnect blocks and settles authenticated checks before forgetting the credential',async()=>{
  const started=deferred(),forgetting=deferred();let aborted=false;
  const c=createUpdateCoordinator({getCredential:async()=>({token:'secret'}),check:async(value,{signal})=>{
    started.resolve();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(cancelled());},{once:true}));
  }}),input=request(true);const job=c.checkRepositoryUpdates(input);await started.promise;
  const disconnect=c.disconnect(async()=>{assert.equal(aborted,true);await forgetting.promise;return {state:'signed-out'};});
  await assert.rejects(job,{code:'UPDATE_CANCELLED'});await assert.rejects(c.checkRepositoryUpdates(request(true)),{code:'GITHUB_BUSY'});
  await assert.rejects(c.disconnect(()=>{}),{code:'GITHUB_BUSY'});forgetting.resolve();await disconnect;
});

test('public check survives disconnect; close aborts then drains; resume permits a cancelled close',async()=>{
  let signal;const gate=deferred();const c=createUpdateCoordinator({check:async(value,options)=>{signal=options.signal;return gate.promise;}}),input=request();
  const job=c.checkRepositoryUpdates(input);await c.disconnect(async()=>{});assert.equal(signal.aborted,false);
  let drained=false;const preparation=c.prepareClose().then(()=>{drained=true;});assert.equal(signal.aborted,true);assert.equal(drained,false);
  await assert.rejects(c.checkRepositoryUpdates(request()),{code:'SERVICE_CLOSED'});gate.reject(cancelled());
  await assert.rejects(job,{code:'UPDATE_CANCELLED'});await preparation;assert.equal(drained,true);
  c.resume();await assert.rejects(c.checkRepositoryUpdates(request()),{code:'UPDATE_CANCELLED'});
  await c.close();assert.throws(()=>c.cancelRepositoryUpdate({requestId:randomUUID()}),{code:'UPDATE_NOT_FOUND'});
});

test('a completed immutable receipt wins cancellation and bounded status evicts old completed jobs',async()=>{
  const gate=deferred();let value=gate.promise;const c=createUpdateCoordinator({check:()=>value}),input=request();
  const job=c.checkRepositoryUpdates(input),cancel=c.cancelRepositoryUpdate({requestId:input.requestId});gate.resolve({checkId:input.requestId});await cancel;
  assert.equal((await job).checkId,input.requestId);assert.equal(c.getRepositoryUpdateProgress({requestId:input.requestId}).phase,'complete');
  value=Promise.resolve({});for(let i=0;i<64;i++)await c.checkRepositoryUpdates(request());
  assert.throws(()=>c.getRepositoryUpdateProgress({requestId:input.requestId}),{code:'UPDATE_NOT_FOUND'});
});

test('host cancellation code maps to a cancelled progress state',async()=>{
  const c=createUpdateCoordinator({check:async()=>{throw Object.assign(Error('cancelled'),{code:'UPDATES_CANCELLED'});}}),input=request();
  await assert.rejects(c.checkRepositoryUpdates(input),{code:'UPDATES_CANCELLED'});
  assert.equal(c.getRepositoryUpdateProgress({requestId:input.requestId}).phase,'cancelled');
});
