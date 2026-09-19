import test from 'node:test';
import assert from 'node:assert/strict';
import {createGitHubAccountCoordinator, githubAccountMethods} from './github-account-coordinator.mjs';
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
function fixture({cloneGate} = {}) {
  const events = [];
  const auth = Object.fromEntries(['getConnection', 'start', 'poll', 'cancel', 'cancelPending', 'openVerification', 'disconnect', 'prepareClose', 'resume'].map(name => [name, async value => {events.push([name, value]); return {state: name === 'start' ? 'awaiting-authorization' : 'signed-out'};}]));
  const cloneCoordinator = {disconnect: async action => {events.push(['clone-barrier']); await cloneGate; return action();}};
  const updateCoordinator = {disconnect: async action => {events.push(['update-barrier']); return action();}};
  return {events,auth,account:createGitHubAccountCoordinator({auth,cloneCoordinator,updateCoordinator})};
}
test('account start and disconnect settle both authenticated transports before auth mutation', async () => {
  const f=fixture();
  await f.account.request('startGitHubConnection');
  assert.deepEqual(f.events.map(x=>x[0]), ['clone-barrier','update-barrier','start']);
  f.events.length=0;
  await f.account.request('disconnectGitHub');
  assert.deepEqual(f.events.map(x=>x[0]), ['clone-barrier','update-barrier','disconnect']);
});
test('cancel pending account start while a transport drains prevents a late authorization request', async () => {
  const gate=deferred(),f=fixture({cloneGate:gate.promise});
  const start=f.account.request('startGitHubConnection');
  const result=start.catch(e=>e);
  await Promise.resolve();
  const cancel=f.account.request('cancelPendingGitHubConnection');
  gate.resolve(); await cancel;
  assert.equal((await result).code,'GITHUB_CANCELLED');
  assert.equal(f.events.some(x=>x[0]==='start'),false);
});
test('close cancels a waiting start, blocks new auth work and can resume after failed window close', async () => {
  const gate=deferred(),f=fixture({cloneGate:gate.promise});
  const start=f.account.request('startGitHubConnection').catch(e=>e);
  const closing=f.account.prepareClose(); gate.resolve(); await closing;
  assert.equal((await start).code,'GITHUB_CANCELLED');
  await assert.rejects(f.account.request('startGitHubConnection'),{code:'SERVICE_CLOSED'});
  await assert.rejects(f.account.request('pollGitHubConnection',{requestId:'test'}),{code:'SERVICE_CLOSED'});
  assert.equal((await f.account.request('getGitHubConnection')).state,'signed-out');
  f.account.resume(); await f.account.request('startGitHubConnection');
  assert.equal(f.events.filter(x=>x[0]==='start').length,1);
});
test('concurrent account changes are refused without replacing the first request', async () => {
  const gate=deferred(),f=fixture({cloneGate:gate.promise});
  const start=f.account.request('startGitHubConnection');
  await assert.rejects(f.account.request('disconnectGitHub'),{code:'GITHUB_BUSY'});
  await assert.rejects(f.account.request('startGitHubConnection'),{code:'GITHUB_BUSY'});
  gate.resolve(); await start;
});
test('only named account DTO operations are dispatched; no credential operation crosses IPC', async () => {
  const f=fixture();
  assert.equal(githubAccountMethods.has('getCredential'),false);
  await assert.rejects(f.account.request('getCredential'),{code:'INVALID_REQUEST'});
  for(const method of ['startGitHubConnection','disconnectGitHub','cancelPendingGitHubConnection','getGitHubConnection']) {
    await assert.rejects(f.account.request(method,{token:'synthetic-unused'}),{code:'INVALID_REQUEST'});
  }
  assert.equal(f.events.length,0);
});
