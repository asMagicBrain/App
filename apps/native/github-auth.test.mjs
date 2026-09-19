import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {randomBytes, createCipheriv, createDecipheriv} from 'node:crypto';
import {createGitHubAuth} from './github-auth.mjs';
import {createCredentialVault} from './credential-vault.mjs';

const DEVICE = 'https://github.com/login/device/code', TOKEN = 'https://github.com/login/oauth/access_token', USER = 'https://api.github.com/user';
const device = () => ({device_code: 'synthetic_private_device_code', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5});
const token = (suffix = 'first', expires = 7200) => ({access_token: 'synthetic_access_' + suffix, token_type: 'bearer', expires_in: expires, refresh_token: 'synthetic_refresh_' + suffix, refresh_token_expires_in: 36000});
const user = (id = 77) => ({id, login: 'sample-user', name: 'Synthetic Test User', email: null});
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
const response = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
function provider() {
  const key = randomBytes(32);
  return {
    isAvailable: async () => true,
    encrypt: async value => {const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]);},
    decrypt: async value => {const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');},
  };
}
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'asmb-auth-'));
  let clock = 1800000000000;
  const calls = [], replies = [], opened = [], storage = provider();
  const options = {clientId: 'Iv1.SYNTHETIC', profileRoot: root, storage, now: () => clock,
    openExternal: async url => {opened.push(url);},
    fetch: async (url, init) => {calls.push({url, init}); const next = replies.shift(); if (typeof next === 'function') return next(url, init); if (next instanceof Error) throw next; assert.ok(next, 'unexpected request'); return response(next);}, ...overrides};
  const services = [], make = extra => {const auth = createGitHubAuth({...options, ...extra}); services.push(auth); return auth;};
  const auth = make();
  t.after(async () => {await Promise.all(services.map(s => s.close())); await fs.rm(root, {recursive: true, force: true});});
  return {root, auth, calls, replies, storage, opened, options, make, advance: milliseconds => {clock += milliseconds;}};
}
async function connect(f, {expires = 7200} = {}) {
  f.replies.push(device()); const start = await f.auth.start(); f.advance(5000); f.replies.push(token('first', expires), user());
  const result = await f.auth.poll({requestId: start.requestId}); assert.equal(result.state, 'connected'); return start;
}

test('session GitHub connection needs no device storage and survives renderer recovery only', async t => {
  const storage = new Proxy({}, {get() {assert.fail('Session GitHub must not access OS storage');}});
  const f = await fixture(t, {storagePolicy: 'session', profileRoot: undefined, storage});
  assert.deepEqual(await f.auth.getConnection(), {configured: true, state: 'signed-out', persistence: 'session'});
  await connect(f); await f.auth.cancelPending(); await f.auth.prepareClose(); f.auth.resume();
  const state = await f.auth.getConnection(); assert.equal(state.state, 'connected'); assert.equal(state.persistence, 'session');
  assert.ok(!JSON.stringify(state).includes('synthetic_access')); assert.deepEqual(await f.auth.getCredential(), {token: token().access_token});
  assert.equal((await f.make().getConnection()).state, 'signed-out');
  assert.deepEqual(await f.auth.disconnect(), {configured: true, state: 'signed-out', persistence: 'session'});
  await connect(f); const count = f.calls.length; await f.auth.close();
  await assert.rejects(f.auth.getConnection(), {code: 'GITHUB_CLOSED'});
  assert.equal((await f.make().getConnection()).state, 'signed-out'); assert.equal(f.calls.length, count);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('session GitHub refresh retries offline and shares the rotated host-only credential', async t => {
  const f = await fixture(t, {storagePolicy: 'session', profileRoot: undefined, storage: undefined});
  await connect(f, {expires: 65}); f.advance(10000); f.replies.push(Error('offline'));
  await assert.rejects(f.auth.getCredential(), {code: 'GITHUB_UNAVAILABLE'}); assert.equal((await f.auth.getConnection()).state, 'connected');
  const gate = deferred(), entered = deferred(); f.replies.push(() => {entered.resolve(); return gate.promise;}, user());
  const first = f.auth.getCredential(), second = f.auth.getCredential(); await entered.promise; gate.resolve(response(token('session-rotated')));
  assert.deepEqual(await first, {token: token('session-rotated').access_token}); assert.deepEqual(await second, await first);
  assert.equal(f.calls.filter(call => new URLSearchParams(call.init.body).get('grant_type') === 'refresh_token').length, 2);
  await f.auth.prepareClose(); f.auth.resume(); assert.equal((await f.auth.getCredential()).token, token('session-rotated').access_token);
  assert.equal((await f.make().getConnection()).state, 'signed-out'); assert.deepEqual(await fs.readdir(f.root), []);
});

test('session GitHub cancellation keeps the prior account and final close rejects a late refresh', async t => {
  const f = await fixture(t, {storagePolicy: 'session', profileRoot: undefined, storage: undefined}); await connect(f, {expires: 65});
  f.replies.push(device()); const start = await f.auth.start(); f.advance(5000);
  const exchange = deferred(), entered = deferred(); f.replies.push(() => {entered.resolve(); return exchange.promise;});
  const poll = f.auth.poll({requestId: start.requestId}); await entered.promise; const cancel = f.auth.cancel({requestId: start.requestId});
  exchange.resolve(response(token('replacement'))); assert.equal((await poll).state, 'cancelled'); await cancel;
  assert.equal((await f.auth.getConnection()).account.id, 77);
  const refreshGate = deferred(), refreshEntered = deferred(); f.replies.push(() => {refreshEntered.resolve(); return refreshGate.promise;});
  const refresh = f.auth.getCredential(); const rejected = assert.rejects(refresh, {code: 'GITHUB_CANCELLED'});
  await refreshEntered.promise; const closing = f.auth.close(); refreshGate.resolve(response(token('late-refresh'))); await rejected; await closing;
  assert.equal((await f.make().getConnection()).state, 'signed-out'); assert.deepEqual(await fs.readdir(f.root), []);
});

test('unconfigured connection is honest and performs no I/O or network', async t => {
  const f = await fixture(t, {clientId: null});
  assert.deepEqual(await f.auth.getConnection(), {configured: false, state: 'unavailable'});
  await assert.rejects(f.auth.start(), {code: 'GITHUB_NOT_CONFIGURED'});
  await assert.rejects(f.auth.getCredential(), {code: 'GITHUB_NOT_CONFIGURED'});
  assert.deepEqual(await fs.readdir(f.root), []); assert.equal(f.calls.length, 0);
});

test('device DTO omits secret codes, enforces polling interval, and opens only the fixed browser URL', async t => {
  const f = await fixture(t); f.replies.push(device());
  const start = await f.auth.start();
  assert.equal(start.userCode, 'ABCD-EFGH'); assert.equal(start.pollInterval, 5); assert.ok(!JSON.stringify(start).includes('synthetic_private'));
  assert.deepEqual(await f.auth.poll({requestId: start.requestId}), start); assert.equal(f.calls.length, 1);
  await f.auth.openVerification({requestId: start.requestId}); assert.deepEqual(f.opened, ['https://github.com/login/device']);
  f.advance(5000); f.replies.push({error: 'authorization_pending'});
  assert.equal((await f.auth.poll({requestId: start.requestId})).state, 'awaiting-authorization');
  const request = f.calls[1]; assert.equal(request.url, TOKEN); assert.equal(request.init.redirect, 'error');
  assert.equal(new URLSearchParams(request.init.body).get('client_secret'), null);
  assert.equal(new URLSearchParams(request.init.body).get('device_code'), device().device_code);
  await assert.rejects(f.auth.openVerification({requestId: start.requestId, url: 'https://evil.invalid'}), {code: 'GITHUB_INVALID_REQUEST'});
});

test('slow-down increases host interval and expiration stops requests', async t => {
  const f = await fixture(t); f.replies.push(device()); const start = await f.auth.start();
  f.advance(5000); f.replies.push({error: 'slow_down', interval: 8});
  const slowed = await f.auth.poll({requestId: start.requestId}); assert.equal(slowed.pollInterval, 10);
  f.advance(9000); await f.auth.poll({requestId: start.requestId}); assert.equal(f.calls.length, 2);
  f.advance(900000); const expired = await f.auth.poll({requestId: start.requestId}); assert.equal(expired.state, 'expired'); assert.equal(typeof expired.error, 'string');
  assert.deepEqual(await f.auth.poll({requestId: start.requestId}), expired); assert.equal(f.calls.length, 2);
});

test('user denial and server failures return bounded secret-free errors', async t => {
  const f = await fixture(t); f.replies.push(device()); const start = await f.auth.start();
  f.advance(5000); f.replies.push({error: 'access_denied', error_description: 'synthetic_access_do_not_leak'});
  const denied = await f.auth.poll({requestId: start.requestId}); assert.equal(denied.state, 'failed'); assert.equal(denied.code, 'GITHUB_ACCESS_DENIED'); assert.ok(!JSON.stringify(denied).includes('do_not_leak'));
  f.replies.push(Error('transport synthetic_access_do_not_leak'));
  await assert.rejects(f.auth.start(), reason => reason.code === 'GITHUB_UNAVAILABLE' && !reason.message.includes('do_not_leak'));
});

test('successful connection survives restart as ciphertext and disconnect leaves unrelated data intact', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'unrelated'), 'keep'); await connect(f);
  const state = await f.auth.getConnection(); assert.equal(state.state, 'connected'); assert.equal(state.account.username, 'sample-user');
  assert.ok(!JSON.stringify(state).includes('synthetic_access')); assert.deepEqual(await f.auth.getCredential(), {token: token().access_token});
  const dir = path.join(f.root, 'github-auth'), files = await fs.readdir(dir); assert.equal(files.length, 1);
  const bytes = await fs.readFile(path.join(dir, files[0])); assert.ok(!bytes.includes(Buffer.from(token().access_token))); assert.ok(!bytes.includes(Buffer.from('Synthetic Test User')));
  const restarted = f.make(), count = f.calls.length; assert.deepEqual(await restarted.getConnection(), state); assert.equal(f.calls.length, count);
  assert.deepEqual(await restarted.disconnect(), {configured: true, state: 'signed-out'}); assert.deepEqual(await fs.readdir(dir), []);
  assert.equal(await fs.readFile(path.join(f.root, 'unrelated'), 'utf8'), 'keep');
  assert.equal((await f.make().getConnection()).state, 'signed-out');
});

test('simultaneous polls share one exchange and cancel rejects a late successful response', async t => {
  const f = await fixture(t); f.replies.push(device()); const start = await f.auth.start(); f.advance(5000);
  const gate = deferred(); f.replies.push(() => gate.promise);
  const a = f.auth.poll({requestId: start.requestId}), b = f.auth.poll({requestId: start.requestId}); assert.equal(a, b);
  const cancellation = f.auth.cancel({requestId: start.requestId}); gate.resolve(response(token()));
  assert.equal((await a).state, 'cancelled'); assert.equal((await cancellation).state, 'cancelled'); assert.equal(f.calls.length, 2);
  assert.equal((await f.auth.getConnection()).state, 'signed-out'); assert.deepEqual(await fs.readdir(path.join(f.root, 'github-auth')), []);
});

test('cancellation during encrypted publication restores previous signed-out state', async t => {
  const f = await fixture(t), originalEncrypt = f.storage.encrypt, gate = deferred(), entered = deferred();
  f.storage.encrypt = async text => {entered.resolve(); await gate.promise; return originalEncrypt(text);};
  f.replies.push(device()); const start = await f.auth.start(); f.advance(5000); f.replies.push(token(), user());
  const poll = f.auth.poll({requestId: start.requestId}); await entered.promise;
  const cancellation = f.auth.cancel({requestId: start.requestId}); gate.resolve();
  assert.equal((await poll).state, 'cancelled'); await cancellation;
  assert.equal((await f.make().getConnection()).state, 'signed-out');
});

test('cancelled replacement connection retains the previously connected account and token', async t => {
  const f = await fixture(t); await connect(f); const encrypt = f.storage.encrypt, gate = deferred(), entered = deferred(); let first = true;
  f.storage.encrypt = async text => {if (first) {first = false; entered.resolve(); await gate.promise;} return encrypt(text);};
  f.replies.push(device()); const start = await f.auth.start(); f.advance(5000); f.replies.push(token('replacement'), user(88));
  const poll = f.auth.poll({requestId: start.requestId}); await entered.promise;
  const cancellation = f.auth.cancel({requestId: start.requestId}); gate.resolve(); await poll; await cancellation;
  assert.equal((await f.auth.getConnection()).account.id, 77); assert.equal((await f.make().getCredential()).token, token().access_token);
});

test('refresh is serialized, omits client secret, validates account and persists rotated pair', async t => {
  const f = await fixture(t); await connect(f, {expires: 65}); f.advance(10000);
  const gate = deferred(); f.replies.push(() => gate.promise, user());
  const a = f.auth.getCredential(), b = f.auth.getCredential(); await new Promise(resolve => setImmediate(resolve));
  gate.resolve(response(token('rotated'))); assert.deepEqual(await a, {token: token('rotated').access_token}); assert.deepEqual(await b, await a);
  const refreshes = f.calls.filter(call => new URLSearchParams(call.init.body).get('grant_type') === 'refresh_token'); assert.equal(refreshes.length, 1);
  assert.equal(new URLSearchParams(refreshes[0].init.body).get('client_secret'), null);
  assert.equal((await f.make().getCredential()).token, token('rotated').access_token);
});

test('refresh refuses account substitution and does not publish its credential', async t => {
  const f = await fixture(t); await connect(f, {expires: 65}); f.advance(10000); f.replies.push(token('wrong-account'), user(99));
  await assert.rejects(f.auth.getCredential(), {code: 'GITHUB_ACCOUNT_CHANGED'});
  assert.equal((await f.auth.getConnection()).state, 'expired'); assert.equal((await f.auth.getConnection()).account.id, 77);
});

test('failed rotated-token persistence requires reconnect and preserves prior ciphertext', async t => {
  const f = await fixture(t); await connect(f, {expires: 65});
  const dir = path.join(f.root, 'github-auth'), file = path.join(dir, (await fs.readdir(dir))[0]), previous = await fs.readFile(file);
  f.advance(10000); f.replies.push(token('rotated'), user()); f.storage.encrypt = async () => {throw Error('storage failure synthetic_access_secret');};
  await assert.rejects(f.auth.getCredential(), reason => reason.code === 'GITHUB_STORAGE_UNAVAILABLE' && !reason.message.includes('synthetic'));
  assert.equal((await f.auth.getConnection()).state, 'expired'); assert.deepEqual(await fs.readFile(file), previous);
});

test('offline refresh is retryable without discarding the connection', async t => {
  const f = await fixture(t); await connect(f, {expires: 65}); f.advance(10000); f.replies.push(Error('network down'));
  await assert.rejects(f.auth.getCredential(), {code: 'GITHUB_UNAVAILABLE'}); assert.equal((await f.auth.getConnection()).state, 'connected');
  f.replies.push(token('retry'), user()); assert.equal((await f.auth.getCredential()).token, token('retry').access_token);
});

test('secure-store unavailability rejects sign-in before network and never falls back to plaintext', async t => {
  const f = await fixture(t); f.storage.isAvailable = async () => false;
  await assert.rejects(f.auth.start(), {code: 'GITHUB_STORAGE_UNAVAILABLE'}); assert.equal(f.calls.length, 0);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'github-auth')), []);
});

test('malformed, oversized and redirected provider responses are rejected without raw response text', async t => {
  const f = await fixture(t);
  for (const next of [() => new Response('secret invalid json'), () => new Response('x'.repeat(70000)), () => {const r = response(device()); Object.defineProperty(r, 'url', {value: 'https://evil.invalid'}); return r;}, {...device(), verification_uri: 'https://evil.invalid'}]) {
    f.replies.push(next); await assert.rejects(f.auth.start(), reason => reason.code === 'GITHUB_INVALID_RESPONSE' && !reason.message.includes('secret'));
  }
});

test('close invalidates pending authorization and prevents further auth calls', async t => {
  const f = await fixture(t); f.replies.push(device()); const start = await f.auth.start(); f.advance(5000);
  const gate = deferred(); f.replies.push(() => gate.promise); const pending = f.auth.poll({requestId: start.requestId}), closing = f.auth.close();
  gate.resolve(response(token())); assert.equal((await pending).state, 'cancelled'); await closing;
  await assert.rejects(f.auth.getConnection(), {code: 'GITHUB_CLOSED'}); assert.equal((await f.make().getConnection()).state, 'signed-out');
});

test('authorization transport has a bounded timeout without leaking provider errors', async t => {
  const entered = deferred();
  const f = await fixture(t, {fetch: async () => {entered.resolve(); return new Promise(() => {});}});
  t.mock.timers.enable({apis: ['setTimeout']});
  const started = f.auth.start(); await entered.promise; t.mock.timers.tick(15001);
  await assert.rejects(started, {code: 'GITHUB_TIMEOUT'}); assert.equal((await f.auth.getConnection()).state, 'signed-out');
  t.mock.timers.reset();
});

test('disconnect during token publication wins and late completion cannot reconnect', async t => {
  const f = await fixture(t), encrypt = f.storage.encrypt, gate = deferred(), entered = deferred();
  f.storage.encrypt = async text => {entered.resolve(); await gate.promise; return encrypt(text);};
  f.replies.push(device()); const start = await f.auth.start(); f.advance(5000); f.replies.push(token(), user());
  const poll = f.auth.poll({requestId: start.requestId}); await entered.promise; const disconnected = f.auth.disconnect(); gate.resolve();
  assert.equal((await poll).state, 'cancelled'); assert.equal((await disconnected).state, 'signed-out');
  assert.equal((await f.make().getConnection()).state, 'signed-out');
});

test('bad refresh tokens require reconnect and expired refresh is never sent', async t => {
  const f = await fixture(t); await connect(f, {expires: 65}); f.advance(10000); f.replies.push({error: 'bad_refresh_token'});
  await assert.rejects(f.auth.getCredential(), {code: 'GITHUB_RECONNECT_REQUIRED'}); assert.equal((await f.auth.getConnection()).state, 'expired');
  const count = f.calls.length; await assert.rejects(f.auth.getCredential(), {code: 'GITHUB_RECONNECT_REQUIRED'}); assert.equal(f.calls.length, count);
  const restarted = f.make(); f.advance(36000 * 1000);
  assert.equal((await restarted.getConnection()).state, 'expired'); await assert.rejects(restarted.getCredential(), {code: 'GITHUB_RECONNECT_REQUIRED'}); assert.equal(f.calls.length, count);
});

test('connection DTOs do not permit a caller to modify the saved account', async t => {
  const f = await fixture(t); await connect(f); const state = await f.auth.getConnection(); state.account.username = 'changed';
  assert.equal((await f.auth.getConnection()).account.username, 'sample-user');
});

test('encrypted records are isolated by client ID and corruption is preserved until disconnect', async t => {
  const f = await fixture(t); await connect(f);
  assert.equal((await f.make({clientId: 'Iv1.OTHER'}).getConnection()).state, 'signed-out');
  const dir = path.join(f.root, 'github-auth'), file = path.join(dir, (await fs.readdir(dir))[0]); await fs.writeFile(file, 'corrupt ciphertext', {mode: 0o600});
  const corrupt = f.make(); const state = await corrupt.getConnection(); assert.equal(state.state, 'unavailable'); assert.equal(typeof state.error, 'string');
  await assert.rejects(corrupt.start(), {code: 'GITHUB_STORAGE_UNAVAILABLE'}); assert.equal(await fs.readFile(file, 'utf8'), 'corrupt ciphertext');
  assert.equal((await corrupt.disconnect()).state, 'signed-out');
});

test('vault rejects symlink, hardlink and oversized credential files without changing target bytes', async t => {
  const f = await fixture(t); const vault = createCredentialVault({profileRoot: f.root, clientId: 'test', storage: f.storage}); await vault.save({secret: 'synthetic'});
  const dir = path.join(f.root, 'github-auth'), file = path.join(dir, (await fs.readdir(dir))[0]), target = path.join(f.root, 'preserve');
  await fs.writeFile(target, 'keep', {mode: 0o600}); await fs.unlink(file); await fs.symlink(target, file);
  await assert.rejects(vault.load(), {code: 'GITHUB_STORAGE_UNAVAILABLE'}); await assert.rejects(vault.save({replacement: true})); await assert.rejects(vault.remove()); assert.equal(await fs.readFile(target, 'utf8'), 'keep');
  await fs.unlink(file); await fs.link(target, file); await assert.rejects(vault.load()); await assert.rejects(vault.remove()); assert.equal(await fs.readFile(target, 'utf8'), 'keep');
  await fs.unlink(file); await fs.writeFile(file, Buffer.alloc(70000), {mode: 0o600}); await assert.rejects(vault.load());
});

test('vault rejects a linked parent and a substituted credential directory', async t => {
  const f = await fixture(t), alias = path.join(f.root, 'alias'), actual = path.join(f.root, 'actual'); await fs.mkdir(actual); await fs.symlink(actual, alias);
  const linked = createCredentialVault({profileRoot: alias, clientId: 'test', storage: f.storage}); await assert.rejects(linked.save({secret: 'synthetic'})); assert.deepEqual(await fs.readdir(actual), []);
  const vault = createCredentialVault({profileRoot: f.root, clientId: 'test', storage: f.storage}); await vault.save({secret: 'synthetic'});
  await fs.rename(path.join(f.root, 'github-auth'), path.join(f.root, 'preserved')); await fs.mkdir(path.join(f.root, 'github-auth'));
  await assert.rejects(vault.load()); assert.deepEqual(await fs.readdir(path.join(f.root, 'github-auth')), []);
});

test('disconnect invalidates a start paused at secure-storage readiness before any network request', async t => {
  const f = await fixture(t), entered = deferred(), gate = deferred();
  f.storage.isAvailable = async () => {entered.resolve(); await gate.promise; return true;};
  const started = f.auth.start(); await entered.promise;
  assert.equal((await f.auth.disconnect()).state, 'signed-out'); gate.resolve();
  await assert.rejects(started, {code: 'GITHUB_CANCELLED'});
  assert.equal(f.calls.length, 0); assert.equal((await f.auth.getConnection()).state, 'signed-out');
});

test('only one authorization start is admitted and credentials wait until replacement settles', async t => {
  const f = await fixture(t); await connect(f);
  const entered = deferred(), gate = deferred(); f.replies.push(async () => {entered.resolve(); return gate.promise;});
  const starting = f.auth.start(); await entered.promise;
  await assert.rejects(f.auth.start(), {code: 'GITHUB_BUSY'});
  await assert.rejects(f.auth.getCredential(), {code: 'GITHUB_BUSY'});
  assert.equal((await f.auth.getConnection()).account.id, 77);
  gate.resolve(response(device())); const flow = await starting;
  await assert.rejects(f.auth.getCredential(), {code: 'GITHUB_BUSY'});
  await f.auth.cancel({requestId: flow.requestId});
  assert.equal((await f.auth.getCredential()).token, token().access_token);
});

test('cancelPending invalidates a start without a renderer request ID and promptly aborts a stalled provider', async t => {
  const entered = deferred(); let signal;
  const f = await fixture(t, {fetch: async (_url, init) => {signal = init.signal; entered.resolve(); return new Promise(() => {});}});
  const started = f.auth.start(); await entered.promise;
  await f.auth.cancelPending();
  assert.equal(signal.aborted, true); await assert.rejects(started, {code: 'GITHUB_CANCELLED'});
  assert.equal((await f.auth.getConnection()).state, 'signed-out');
});

test('prepareClose invalidates authorization and pauses new work; resume retains previous identity', async t => {
  const f = await fixture(t); await connect(f);
  f.replies.push(device()); const flow = await f.auth.start();
  await f.auth.prepareClose();
  await assert.rejects(f.auth.start(), {code: 'GITHUB_BUSY'});
  await assert.rejects(f.auth.getCredential(), {code: 'GITHUB_BUSY'});
  assert.throws(() => f.auth.poll({requestId: flow.requestId}), {code: 'GITHUB_BUSY'});
  assert.equal((await f.auth.getConnection()).account.id, 77);
  f.auth.resume();
  assert.equal((await f.auth.poll({requestId: flow.requestId})).state, 'cancelled');
  assert.equal((await f.auth.getCredential()).token, token().access_token);
});

test('prepareClose aborts and cancels a stalled response body without publishing credentials', async t => {
  const f = await fixture(t); f.replies.push(device()); const flow = await f.auth.start(); f.advance(5000);
  let cancelledBody = false; const entered = deferred();
  f.replies.push(() => new Response(new ReadableStream({start() {entered.resolve();}, cancel() {cancelledBody = true;}}), {status: 200}));
  const polling = f.auth.poll({requestId: flow.requestId}); await entered.promise;
  await f.auth.prepareClose(); assert.equal((await polling).state, 'cancelled');
  await new Promise(resolve => setImmediate(resolve));
  f.auth.resume(); assert.equal((await f.auth.getConnection()).state, 'signed-out');
  assert.equal(f.calls.length, 2); assert.equal(cancelledBody, true);
});

test('vault refuses permissive private-directory permissions without mutating ciphertext', async t => {
  const f = await fixture(t); await connect(f);
  const directory = path.join(f.root, 'github-auth'), filename = path.join(directory, (await fs.readdir(directory))[0]), bytes = await fs.readFile(filename);
  await fs.chmod(directory, 0o755);
  const restarted = f.make(); assert.equal((await restarted.getConnection()).state, 'unavailable');
  await assert.rejects(restarted.getCredential(), {code: 'GITHUB_STORAGE_UNAVAILABLE'});
  await assert.rejects(restarted.disconnect(), {code: 'GITHUB_STORAGE_UNAVAILABLE'});
  assert.deepEqual(await fs.readFile(filename), bytes); await fs.chmod(directory, 0o700);
});

test('vault refuses executable ciphertext and preserves it for recovery', async t => {
  const f = await fixture(t); await connect(f);
  const directory = path.join(f.root, 'github-auth'), filename = path.join(directory, (await fs.readdir(directory))[0]), bytes = await fs.readFile(filename);
  await fs.chmod(filename, 0o700);
  assert.equal((await f.make().getConnection()).state, 'unavailable'); assert.deepEqual(await fs.readFile(filename), bytes);
});

test('cancelled vault publication restores exact prior ciphertext without re-encrypting it', async t => {
  const f = await fixture(t), vault = createCredentialVault({profileRoot: f.root, clientId: 'guarded', storage: f.storage});
  await vault.save({account: 'previous'});
  const directory = path.join(f.root, 'github-auth'), filename = path.join(directory, (await fs.readdir(directory))[0]), previous = await fs.readFile(filename);
  const encrypt = f.storage.encrypt; let encryptions = 0, guards = 0, committed = false;
  f.storage.encrypt = async text => {encryptions++; if (encryptions > 1) throw Error('Keychain locked after publication'); return encrypt(text);};
  const saved = await vault.save({account: 'replacement'}, {isCurrent: () => ++guards < 4, onCommitted: () => {committed = true;}});
  assert.equal(guards, 4); assert.equal(saved, false); assert.equal(committed, false); assert.equal(encryptions, 1);
  assert.deepEqual(await fs.readFile(filename), previous); assert.deepEqual(await vault.load(), {account: 'previous'});
  assert.deepEqual(await fs.readdir(directory), [path.basename(filename)]);
});

test('cancelled initial vault publication removes only its own ciphertext and marker', async t => {
  const f = await fixture(t), vault = createCredentialVault({profileRoot: f.root, clientId: 'initial', storage: f.storage}); let guards = 0;
  await fs.writeFile(path.join(f.root, 'unrelated'), 'keep');
  assert.equal(await vault.save({account: 'replacement'}, {isCurrent: () => ++guards < 4}), false);
  assert.equal(await vault.load(), null); assert.deepEqual(await fs.readdir(path.join(f.root, 'github-auth')), []);
  assert.equal(await fs.readFile(path.join(f.root, 'unrelated'), 'utf8'), 'keep');
});

test('uncertain credential publication stays marked and all readers refuse until explicit disconnect', async t => {
  const f = await fixture(t), vault = createCredentialVault({profileRoot: f.root, clientId: 'pending', storage: f.storage}); let guards = 0;
  await vault.save({account: 'previous'});
  await assert.rejects(vault.save({account: 'replacement'}, {isCurrent: () => {if (++guards === 4) throw Error('interrupted publication boundary'); return true;}}), reason => reason.code === 'GITHUB_STORAGE_UNAVAILABLE' && reason.publicationPending === true);
  const directory = path.join(f.root, 'github-auth'), files = await fs.readdir(directory);
  assert.equal(files.length, 2); assert.ok(files.some(name => name.endsWith('.bin.pending')));
  const filename = path.join(directory, files.find(name => name.endsWith('.bin')));
  const envelope = JSON.parse(await f.storage.decrypt(await fs.readFile(filename)));
  assert.equal(envelope.schemaVersion, 2); // Previous readers require exactly schema 1.
  await assert.rejects(vault.load(), {code: 'GITHUB_STORAGE_UNAVAILABLE'});
  const restarted = createCredentialVault({profileRoot: f.root, clientId: 'pending', storage: f.storage});
  await assert.rejects(restarted.load(), {code: 'GITHUB_STORAGE_UNAVAILABLE'});
  await assert.rejects(restarted.save({replacement: 'no'}), {code: 'GITHUB_STORAGE_UNAVAILABLE'});
  await restarted.remove(); assert.equal(await restarted.load(), null);
});

test('a completed durable connection wins a late cancellation request', async t => {
  const f = await fixture(t); const flow = await connect(f);
  const result = await f.auth.cancel({requestId: flow.requestId});
  assert.equal(result.state, 'connected'); assert.equal(result.account.id, 77);
  assert.equal((await f.make().getConnection()).account.id, 77);
});

test('an interrupted empty publication marker fails closed and explicit disconnect can remove it', async t => {
  const f = await fixture(t); await connect(f);
  const directory = path.join(f.root, 'github-auth'), name = (await fs.readdir(directory))[0];
  await fs.writeFile(path.join(directory, name + '.pending'), '', {mode: 0o600, flag: 'wx'});
  const restarted = f.make(); assert.equal((await restarted.getConnection()).state, 'unavailable');
  assert.equal((await restarted.disconnect()).state, 'signed-out'); assert.deepEqual(await fs.readdir(directory), []);
});

test('provider bodies rejected before reading are cancelled rather than left open', async t => {
  const f = await fixture(t); let cancelledBody = false;
  f.replies.push(() => new Response(new ReadableStream({cancel() {cancelledBody = true;}}), {status: 200, headers: {'content-length': '70000'}}));
  await assert.rejects(f.auth.start(), {code: 'GITHUB_INVALID_RESPONSE'}); assert.equal(cancelledBody, true);
});

test('failed marker-removal directory sync restores a hold before restart can use a replacement', async t => {
  const f = await fixture(t), vault = createCredentialVault({profileRoot: f.root, clientId: 'sync-failure', storage: f.storage});
  await vault.save({account: 'previous'});
  const original = fsSync.fsyncSync; let failed = false, committed = false;
  const mock = t.mock.method(fsSync, 'fsyncSync', fd => {
    if (!failed && fsSync.fstatSync(fd).isDirectory()) {failed = true; throw Object.assign(Error('controlled directory sync failure'), {code: 'EIO'});}
    return original(fd);
  });
  syncBuiltinESMExports();
  try {await assert.rejects(vault.save({account: 'replacement'}, {onCommitted: () => {committed = true;}}), reason => reason.code === 'GITHUB_STORAGE_UNAVAILABLE' && reason.publicationPending === true);}
  finally {mock.mock.restore(); syncBuiltinESMExports();}
  assert.equal(failed, true); assert.equal(committed, false);
  const directory = path.join(f.root, 'github-auth'); assert.ok((await fs.readdir(directory)).some(name => name.endsWith('.bin.pending')));
  const restarted = createCredentialVault({profileRoot: f.root, clientId: 'sync-failure', storage: f.storage});
  await assert.rejects(restarted.load(), {code: 'GITHUB_STORAGE_UNAVAILABLE'});
  await restarted.remove(); assert.equal(await restarted.load(), null);
});
