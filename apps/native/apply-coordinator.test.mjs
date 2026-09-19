import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApplyCoordinator} from './apply-coordinator.mjs';

const input = () => ({repo: 'Example', checkId: randomUUID(), reviewId: randomUUID(), requestId: randomUUID()});
const gate = () => {let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b;}); return {promise,resolve,reject};};

test('close waits for accepted publication; duplicate requests do not republish', async () => {
  const pending = gate(); let calls = 0, options;
  const coordinator = createApplyCoordinator({apply: async (request, opts) => {calls++; options=opts; return pending.promise;}});
  const request=input(), first=coordinator.applyRepositoryUpdate(request);
  assert.equal(coordinator.applyRepositoryUpdate(request), first);
  await Promise.resolve(); options.onProgress({phase:'applying', privatePath:'/private/secret'});
  assert.deepEqual(coordinator.getRepositoryApplyProgress({requestId:request.requestId}), {requestId:request.requestId,phase:'applying'});
  let closed=false; const closing=coordinator.prepareClose().then(()=>{closed=true;});
  await Promise.resolve(); assert.equal(closed,false);
  await assert.rejects(coordinator.applyRepositoryUpdate(input()), {code:'SERVICE_CLOSED'});
  pending.resolve({status:'applied',head:'a'.repeat(40)}); await closing;
  assert.equal(closed,true); assert.equal(calls,1); assert.equal((await first).status,'applied');
  coordinator.resume(); assert.deepEqual(await coordinator.applyRepositoryUpdate(request),await first);
  await coordinator.close(); await assert.rejects(coordinator.applyRepositoryUpdate(input()), {code:'SERVICE_CLOSED'});
});

test('invalid or conflicting identities cannot reach publication; only one active apply',async()=>{
  const pending=gate(); let calls=0;const coordinator=createApplyCoordinator({apply:()=>{calls++;return pending.promise;}});
  for(const bad of [{...input(),repo:'../x'},{...input(),reviewId:'forged'},{...input(),credential:'secret'},{...input(),remoteHead:'a'.repeat(40)}])
    await assert.rejects(coordinator.applyRepositoryUpdate(bad),{code:'INVALID_REQUEST'});
  const request=input(), first=coordinator.applyRepositoryUpdate(request);
  await assert.rejects(coordinator.applyRepositoryUpdate({...request,reviewId:randomUUID()}),{code:'REQUEST_CONFLICT'});
  await assert.rejects(coordinator.applyRepositoryUpdate(input()),{code:'APPLY_BUSY'});
  pending.resolve({status:'applied'});await first;assert.equal(calls,1);
});

test('failed publication remains idempotent and drains before close',async()=>{
  const pending=gate();let calls=0;const coordinator=createApplyCoordinator({apply:()=>{calls++;return pending.promise;}});
  const request=input(), first=coordinator.applyRepositoryUpdate(request),closing=coordinator.prepareClose();
  pending.reject(Object.assign(new Error('Recovery needed'),{code:'RECOVERY_REQUIRED'}));
  await assert.rejects(first,{code:'RECOVERY_REQUIRED'});await closing;
  assert.equal(coordinator.getRepositoryApplyProgress({requestId:request.requestId}).phase,'failed');
  coordinator.resume();await assert.rejects(coordinator.applyRepositoryUpdate(request),{code:'RECOVERY_REQUIRED'});assert.equal(calls,1);
});
