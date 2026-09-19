import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes, createCipheriv, createDecipheriv, createHash} from 'node:crypto';
import {AuthClient} from '@supabase/auth-js';
import {createApplicationAuth, validateApplicationConfig} from './application-auth.mjs';
import {createCredentialVault} from './credential-vault.mjs';

const origin = 'https://brgxjdhkcfvbpsziebus.supabase.co', id = '11111111-2222-4333-8444-555555555555';
const config = {origin, publishableKey: 'sb_publishable_SYNTHETIC_public_key', providers: {github: true, email: true}};
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
const response = (value, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
const user = (extra = {}) => ({id, email: 'synthetic@example.invalid', aud: 'authenticated', created_at: '2026-09-18T00:00:00Z', is_anonymous: false, app_metadata: {provider: 'github'}, user_metadata: {full_name: 'Synthetic Person'}, identities: [{provider: 'github', identity_data: {sub: '77', user_name: 'synthetic-user'}}], ...extra});
function storageProvider() {
  const key = randomBytes(32);
  return {isAvailable: async () => true,
    encrypt: async value => {const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);},
    decrypt: async value => {const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');},
  };
}
async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'asmb-application-auth-'));
  let time = Date.now(); const storage = storageProvider(), calls = [], replies = [], opened = [], callbacks = [], services = [];
  const options = {config, AuthClient, profileRoot: root, storage, now: () => time, timeoutMs: 100,
    openExternal: async url => {opened.push(url);},
    callbackFactory: async handlers => {const item = {...handlers, redirectTo: 'http://127.0.0.1:43123/auth/callback?app_state=synthetic_state', closed: false, async close() {this.closed = true;}}; callbacks.push(item); return item;},
    fetch: async (url, init) => {calls.push({url, init}); const reply = replies.shift(); assert.ok(reply, 'unexpected account request'); if (typeof reply === 'function') return reply(url, init); if (reply instanceof Error) throw reply; return reply instanceof Response ? reply : response(reply);}, ...extra};
  const make = overrides => {const service = createApplicationAuth({...options, ...overrides}); services.push(service); return service;};
  const auth = make();
  t.after(async () => {await Promise.all(services.map(service => service.close())); await fs.rm(root, {recursive: true, force: true});});
  const session = (who = user(), seconds = 3600, suffix = 'first') => {
    const expires_at = Math.floor(time / 1000) + seconds, encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    return {access_token: encoded({alg: 'ES256', typ: 'JWT'}) + '.' + encoded({iss: origin + '/auth/v1', sub: who.id, exp: expires_at}) + '.syntheticSignature' + suffix, refresh_token: 'synthetic_refresh_' + suffix, token_type: 'bearer', expires_at, expires_in: seconds, user: who, provider_token: 'synthetic_provider_do_not_persist', provider_refresh_token: 'synthetic_provider_refresh_do_not_persist'};
  };
  return {root, auth, make, storage, calls, replies, opened, callbacks, session, options, advance: ms => {time += ms;}};
}
async function connect(f, {method = 'github', who = user(), seconds = 3600} = {}) {
  if (method === 'email') f.replies.push({});
  const flow = await f.auth.startApplicationSignIn(method === 'github' ? {method} : {method, email: 'synthetic@example.invalid'});
  f.replies.push(f.session(who, seconds), who);
  const result = method === 'email' ? await f.auth.verifyApplicationEmail({requestId: flow.requestId, token: '123456'}) : (f.callbacks.at(-1).onCode('synthetic_auth_code'), await settle(f, flow));
  assert.equal(result.state, 'signed-in'); return flow;
}
async function settle(f, flow) {
  // Callback completion includes durable vault I/O, which competes with the
  // filesystem-heavy native suite. Bound elapsed time, not scheduler turns.
  const deadline = performance.now() + 10_000;
  let value;
  do {
    value = await f.auth.pollApplicationSignIn({requestId: flow.requestId});
    if (!['awaiting-browser', 'awaiting-email'].includes(value.state)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (performance.now() < deadline);
  throw Error(`Account flow did not settle within 10 seconds (last state: ${value?.state}).`);
}

test('build-pinned public configuration rejects malformed origins and secrets; disabled build performs no I/O', async t => {
  for (const invalid of [{...config, origin: 'http://example.invalid'}, {...config, origin: 'https://example.invalid/path'}, {...config, origin: 'https://user@example.invalid'}, {...config, publishableKey: 'sb_secret_disallowed'}, {...config, providers: {github: true}}]) assert.throws(() => validateApplicationConfig(invalid));
  const f = await fixture(t, {config: {origin: null}});
  assert.equal((await f.auth.getApplicationAccount()).state, 'unavailable'); assert.deepEqual(await fs.readdir(f.root), []);
  assert.throws(() => f.auth.startApplicationSignIn({method: 'github'}), {code: 'ACCOUNT_NOT_CONFIGURED'}); assert.equal(f.calls.length, 0);
});
test('official SDK generates S256 PKCE and host exchanges only the paired verifier', async t => {
  const f = await fixture(t); const started = await f.auth.startApplicationSignIn({method: 'github'});
  const url = new URL(f.opened[0]); assert.equal(url.origin, origin); assert.equal(url.searchParams.get('code_challenge_method'), 's256');
  assert.equal(url.searchParams.get('redirect_to'), f.callbacks[0].redirectTo); assert.equal(url.searchParams.get('provider'), 'github'); assert.equal(f.calls.length, 0);
  assert.ok(!JSON.stringify(started).includes('code_challenge')); assert.ok(!JSON.stringify(started).includes('app_state'));
  f.replies.push(f.session(), user()); f.callbacks[0].onCode('synthetic_auth_code');
  const completed = await settle(f, started); assert.equal(completed.account.id, id); assert.equal(completed.state, 'signed-in');
  const request = JSON.parse(f.calls[0].init.body); assert.equal(request.auth_code, 'synthetic_auth_code');
  assert.equal(createHash('sha256').update(request.code_verifier).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.ok(f.calls[1].url.endsWith('/user')); assert.equal(f.callbacks[0].closed, true);
  const state = await f.auth.getApplicationAccount(); assert.equal(state.account.github.id, '77'); assert.ok(!JSON.stringify(state).includes('synthetic_refresh')); assert.ok(!JSON.stringify(state).includes('provider_do_not_persist'));
});
test('email supports template magic-link callback and exact email OTP protocol without leaking tokens', async t => {
  const f = await fixture(t); f.replies.push({}); const start = await f.auth.startApplicationSignIn({method: 'email', email: 'synthetic@example.invalid'});
  assert.equal(start.state, 'awaiting-email'); assert.equal(new URL(f.calls[0].url).searchParams.get('redirect_to'), f.callbacks[0].redirectTo);
  const body = JSON.parse(f.calls[0].init.body); assert.equal(body.create_user, true); assert.equal(body.code_challenge_method, 's256');
  f.replies.push(f.session(), user()); f.callbacks[0].onCode('synthetic_email_magic_link'); assert.equal((await settle(f, start)).state, 'signed-in');
  f.replies.push(response(null, 204)); await f.auth.signOutApplicationAccount();
  await connect(f, {method: 'email', who: user({identities: [], app_metadata: {provider: 'email'}})});
  const verified = f.calls.find(call => call.url.endsWith('/verify')); assert.deepEqual(JSON.parse(verified.init.body), {email: 'synthetic@example.invalid', token: '123456', type: 'email', gotrue_meta_security: {}});
});
test('incorrect email code stays pending and a later valid code can complete', async t => {
  const f = await fixture(t); f.replies.push({}); const flow = await f.auth.startApplicationSignIn({method: 'email', email: 'synthetic@example.invalid'});
  f.replies.push(response({message: 'synthetic provider secret'}, 403)); const retry = await f.auth.verifyApplicationEmail({requestId: flow.requestId, token: '000000'});
  assert.equal(retry.state, 'awaiting-email'); assert.ok(!retry.error.includes('synthetic provider secret')); assert.equal(f.callbacks[0].closed, false);
  f.replies.push(f.session(), user()); assert.equal((await f.auth.verifyApplicationEmail({requestId: flow.requestId, token: '123456'})).state, 'signed-in');
});
test('encrypted app vault is independent from GitHub and excludes OAuth provider tokens', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'github-auth'), {mode: 0o700}); await fs.writeFile(path.join(f.root, 'github-auth', 'keep.bin'), 'prior-github-ciphertext');
  await connect(f); const files = await fs.readdir(path.join(f.root, 'application-auth')); assert.equal(files.length, 1);
  const encrypted = await fs.readFile(path.join(f.root, 'application-auth', files[0])); assert.ok(!encrypted.includes(Buffer.from('synthetic_refresh')));
  const plain = await f.storage.decrypt(encrypted); assert.ok(plain.includes('synthetic_refresh')); assert.ok(!plain.includes('synthetic_provider')); assert.ok(!plain.includes('synthetic_auth_code'));
  f.replies.push(user()); const restored = f.make(); assert.equal((await restored.getApplicationAccount()).state, 'signed-in');
  f.replies.push(response(null, 204)); assert.equal((await restored.signOutApplicationAccount()).state, 'signed-out');
  assert.equal(await fs.readFile(path.join(f.root, 'github-auth', 'keep.bin'), 'utf8'), 'prior-github-ciphertext'); assert.equal(new URL(f.calls.at(-1).url).searchParams.get('scope'), 'local');
  assert.deepEqual(await fs.readdir(path.join(f.root, 'application-auth')), []);
});
test('verified JWT expiry remains authoritative when SDK receipt-time expiry differs', async t => {
  const f = await fixture(t), start = await f.auth.startApplicationSignIn({method: 'github'}), issued = f.session(), actualExpiry = issued.expires_at;
  issued.expires_at += 2; f.replies.push(issued, user()); f.callbacks[0].onCode('synthetic_code'); assert.equal((await settle(f, start)).state, 'signed-in');
  const vault = createCredentialVault({profileRoot: f.root, clientId: 'supabase:' + origin, storage: f.storage, namespace: 'application-auth', errorCode: 'ACCOUNT_STORAGE_UNAVAILABLE'});
  assert.equal((await vault.load()).session.expires_at, actualExpiry);
});
test('fresh user verification cannot admit a token with wrong issuer, subject or invalid expiry', async t => {
  const f = await fixture(t);
  for (const claims of [{iss: 'https://evil.invalid/auth/v1'}, {sub: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'}, {exp: 0}, {exp: Number.MAX_SAFE_INTEGER}, {exp: '9999999999'}]) {
    const start = await f.auth.startApplicationSignIn({method: 'github'}), issued = f.session(), pieces = issued.access_token.split('.');
    pieces[1] = Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(pieces[1], 'base64url')), ...claims})).toString('base64url'); issued.access_token = pieces.join('.');
    f.replies.push(issued, user()); f.callbacks.at(-1).onCode('synthetic_code'); assert.equal((await settle(f, start)).state, 'failed'); assert.equal((await f.auth.getApplicationAccount()).state, 'signed-out');
  }
  assert.deepEqual(await fs.readdir(path.join(f.root, 'application-auth')), []);
});
test('startup offline retains encrypted session with honest status; explicit signout works without the network', async t => {
  const f = await fixture(t); await connect(f); f.replies.push(Error('synthetic secret network failure'));
  const restored = f.make(); const state = await restored.getApplicationAccount(); assert.equal(state.state, 'offline'); assert.equal(state.account.id, id); assert.ok(!state.error.includes('synthetic secret'));
  f.replies.push(Error('offline')); const signedOut = await restored.signOutApplicationAccount(); assert.equal(signedOut.state, 'signed-out'); assert.ok(signedOut.notice.includes('this device'));
  assert.equal((await f.make().getApplicationAccount()).state, 'signed-out');
});
test('profile update permits display name only, confirms server user, and leaves independent grant intact', async t => {
  const f = await fixture(t); await connect(f);
  assert.throws(() => f.auth.updateApplicationProfile({displayName: 'Okay', email: 'other@example.invalid'}), {code: 'ACCOUNT_INVALID_REQUEST'});
  f.replies.push(user({user_metadata: {display_name: 'Updated Person'}}), user({user_metadata: {display_name: 'Updated Person'}}));
  const updated = await f.auth.updateApplicationProfile({displayName: ' Updated Person '}); assert.equal(updated.account.displayName, 'Updated Person');
  const request = f.calls.find(call => call.init.method === 'PUT'); assert.deepEqual(JSON.parse(request.init.body), {data: {display_name: 'Updated Person'}, code_challenge: null, code_challenge_method: null});
  assert.equal(updated.account.email, 'synthetic@example.invalid');
});
test('refresh is single-flight, validates stable UUID, and persists rotated credential before success', async t => {
  const f = await fixture(t); await connect(f, {seconds: 150}); f.advance(60000);
  const gate = deferred(); f.replies.push(() => gate.promise, user()); const a = f.auth.refreshApplicationAccount(), b = f.auth.refreshApplicationAccount(); assert.equal(a, b);
  gate.resolve(response(f.session(user(), 3600, 'rotated'))); assert.equal((await a).state, 'signed-in');
  const vault = createCredentialVault({profileRoot: f.root, clientId: 'supabase:' + origin, storage: f.storage, namespace: 'application-auth', errorCode: 'ACCOUNT_STORAGE_UNAVAILABLE'});
  assert.equal((await vault.load()).session.refresh_token, 'synthetic_refresh_rotated');
  f.replies.push(user({id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'})); assert.equal((await f.auth.refreshApplicationAccount()).state, 'expired');
});
test('cancel during network and encryption never publishes a late sign-in', async t => {
  const f = await fixture(t), gate = deferred(); const started = await f.auth.startApplicationSignIn({method: 'github'});
  f.replies.push(() => gate.promise); f.callbacks[0].onCode('synthetic_code'); const cancelled = f.auth.cancelApplicationSignIn({requestId: started.requestId});
  gate.resolve(response(f.session())); await cancelled; assert.equal((await f.auth.getApplicationAccount()).state, 'signed-out');
  const encryption = deferred(), entered = deferred(), encrypt = f.storage.encrypt; f.storage.encrypt = async value => {entered.resolve(); await encryption.promise; return encrypt(value);};
  const second = await f.auth.startApplicationSignIn({method: 'github'}); f.replies.push(f.session(), user()); f.callbacks[1].onCode('synthetic_second'); await entered.promise;
  const stopped = f.auth.cancelApplicationSignIn({requestId: second.requestId}); encryption.resolve(); await stopped;
  assert.equal((await f.auth.getApplicationAccount()).state, 'signed-out'); assert.equal((await f.make().getApplicationAccount()).state, 'signed-out');
});
test('cancelled account switch keeps previous encrypted app account and GitHub remains independent', async t => {
  const f = await fixture(t); await connect(f); const next = await f.auth.startApplicationSignIn({method: 'github'}); await f.auth.cancelApplicationSignIn({requestId: next.requestId});
  assert.equal((await f.auth.getApplicationAccount()).account.id, id); assert.equal((await f.auth.getApplicationAccount()).state, 'signed-in');
});
test('cancelPending and close settle a noncooperative external-browser opening', async t => {
  const entered = deferred(), f = await fixture(t, {openExternal: async () => {entered.resolve(); return new Promise(() => {});}});
  const start = f.auth.startApplicationSignIn({method: 'github'}); await entered.promise;
  const beginning = Date.now(); await f.auth.cancelPendingApplicationSignIn();
  assert.equal((await start).state, 'cancelled'); assert.ok(Date.now() - beginning < 1000); assert.equal(f.callbacks[0].closed, true);
  const second = f.auth.startApplicationSignIn({method: 'github'});
  while (f.callbacks.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
  await f.auth.prepareClose(); const result = await second.catch(error => ({state: error.code})); assert.ok(['cancelled', 'ACCOUNT_CANCELLED'].includes(result.state));
  f.auth.resume(); assert.equal((await f.auth.getApplicationAccount()).state, 'signed-out');
});
test('completed durable account wins late cancellation and cancellation cannot change the terminal result', async t => {
  const f = await fixture(t), completed = await connect(f);
  const result = await f.auth.cancelApplicationSignIn({requestId: completed.requestId});
  assert.equal(result.state, 'signed-in'); assert.equal(result.account.id, id);
  assert.deepEqual(await f.auth.pollApplicationSignIn({requestId: completed.requestId}), result);
  assert.equal((await f.auth.getApplicationAccount()).state, 'signed-in');
});
test('close cancels browser flow but drains a rotated session through durable publication', async t => {
  const f = await fixture(t); await connect(f, {seconds: 150}); f.advance(60000);
  const gate = deferred(), entered = deferred(); f.replies.push(() => {entered.resolve(); return gate.promise;}, user());
  const refresh = f.auth.refreshApplicationAccount(); await entered.promise; const close = f.auth.prepareClose(); gate.resolve(response(f.session(user(), 3600, 'close-rotated'))); await refresh; await close;
  f.auth.resume(); assert.equal((await f.auth.getApplicationAccount()).state, 'signed-in');
  const next = await f.auth.startApplicationSignIn({method: 'github'}); await f.auth.prepareClose(); assert.equal((await f.auth.pollApplicationSignIn({requestId: next.requestId})).state, 'cancelled');
  f.auth.resume();
});
test('vault outage rejects sign-in before opening browser; corrupt vault can be explicitly signed out', async t => {
  const f = await fixture(t); f.storage.isAvailable = async () => false;
  await assert.rejects(f.auth.startApplicationSignIn({method: 'github'}), {code: 'ACCOUNT_STORAGE_UNAVAILABLE'}); assert.equal(f.opened.length, 0); assert.equal(f.calls.length, 0);
  f.storage.isAvailable = async () => true; await connect(f);
  const directory = path.join(f.root, 'application-auth'), [name] = await fs.readdir(directory); await fs.writeFile(path.join(directory, name), 'corrupt');
  const restored = f.make(); assert.equal((await restored.getApplicationAccount()).state, 'unavailable'); assert.equal((await restored.signOutApplicationAccount()).state, 'signed-out');
});
test('bounded transport rejects stalled, oversized and redirected responses without leaking error text', async t => {
  const f = await fixture(t, {timeoutMs: 20}); f.replies.push(() => new Promise(() => {}));
  await assert.rejects(f.auth.startApplicationSignIn({method: 'email', email: 'synthetic@example.invalid'}), {code: 'ACCOUNT_TIMEOUT'});
  f.replies.push(new Response('x'.repeat(140000), {headers: {'Content-Length': '140000'}}));
  await assert.rejects(f.auth.startApplicationSignIn({method: 'email', email: 'synthetic@example.invalid'}), {code: 'ACCOUNT_INVALID_RESPONSE'});
  f.replies.push(() => {const value = response({}); Object.defineProperty(value, 'url', {value: 'https://evil.invalid/'}); return value;});
  await assert.rejects(f.auth.startApplicationSignIn({method: 'email', email: 'synthetic@example.invalid'}), {code: 'ACCOUNT_INVALID_RESPONSE'});
});
test('public request validation refuses extra credential, URL and email mutation fields', async t => {
  const f = await fixture(t);
  for (const [method, input] of [['startApplicationSignIn', {method: 'github', url: 'https://evil.invalid'}], ['startApplicationSignIn', {method: 'email', email: 42}], ['getApplicationAccount', {token: 'not-accepted'}], ['verifyApplicationEmail', {requestId: id, token: 123456}], ['verifyApplicationEmail', {requestId: randomBytes(16).toString('hex'), token: '123456', email: 'other@example.invalid'}], ['updateApplicationProfile', {displayName: 'Fine', password: 'not-accepted'}]]) await assert.rejects(f.auth.request(method, input), {code: 'ACCOUNT_INVALID_REQUEST'});
  assert.equal(f.calls.length, 0);
});

test('session account needs no device storage, supports profile and retry, and survives renderer recovery only', async t => {
  const storage = new Proxy({}, {get() {assert.fail('Session accounts must not access OS storage');}});
  const f = await fixture(t, {storagePolicy: 'session', profileRoot: undefined, storage});
  assert.deepEqual(await f.auth.getApplicationAccount(), {configured: true, persistence: 'session', providers: {github: true, email: true}, state: 'signed-out'});
  await connect(f);
  f.replies.push(user({user_metadata: {display_name: 'Session Person'}}), user({user_metadata: {display_name: 'Session Person'}}));
  assert.equal((await f.auth.updateApplicationProfile({displayName: 'Session Person'})).account.displayName, 'Session Person');
  f.replies.push(Error('offline'));
  assert.equal((await f.auth.refreshApplicationAccount()).state, 'offline');
  f.replies.push(user({user_metadata: {display_name: 'Session Person'}}));
  assert.equal((await f.auth.refreshApplicationAccount()).state, 'signed-in');
  await f.auth.cancelPendingApplicationSignIn(); await f.auth.prepareClose(); f.auth.resume();
  const state = await f.auth.getApplicationAccount();
  assert.equal(state.state, 'signed-in'); assert.equal(state.persistence, 'session'); assert.equal(state.account.displayName, 'Session Person');
  assert.ok(!JSON.stringify(state).includes('synthetic_refresh')); assert.ok(!JSON.stringify(state).includes('synthetic_provider'));
  assert.equal((await f.make().getApplicationAccount()).state, 'signed-out');
  f.replies.push(response(null, 204)); assert.equal((await f.auth.signOutApplicationAccount()).state, 'signed-out');
  assert.equal(new URL(f.calls.at(-1).url).searchParams.get('scope'), 'local');
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('session account drains refresh on renderer recovery and discards it on final host close', async t => {
  const f = await fixture(t, {storagePolicy: 'session', profileRoot: undefined, storage: undefined});
  await connect(f, {seconds: 150}); f.advance(60000);
  const gate = deferred(), entered = deferred(); f.replies.push(() => {entered.resolve(); return gate.promise;}, user());
  const first = f.auth.refreshApplicationAccount(), second = f.auth.refreshApplicationAccount(); assert.equal(first, second);
  await entered.promise; const preparing = f.auth.prepareClose();
  gate.resolve(response(f.session(user(), 3600, 'session-rotated')));
  assert.equal((await first).state, 'signed-in'); await preparing; f.auth.resume();
  assert.equal((await f.auth.getApplicationAccount()).state, 'signed-in');
  const count = f.calls.length; await f.auth.close();
  assert.equal((await f.make().getApplicationAccount()).state, 'signed-out'); assert.equal(f.calls.length, count);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('session account cancellation keeps the previous identity and never publishes a late replacement', async t => {
  const f = await fixture(t, {storagePolicy: 'session', profileRoot: undefined, storage: undefined}); await connect(f);
  const start = await f.auth.startApplicationSignIn({method: 'github'}), gate = deferred(), entered = deferred();
  f.replies.push(() => {entered.resolve(); return gate.promise;}); f.callbacks.at(-1).onCode('synthetic_replacement_code');
  await entered.promise; const cancel = f.auth.cancelApplicationSignIn({requestId: start.requestId});
  gate.resolve(response(f.session(user({id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'}))));
  assert.equal((await cancel).state, 'cancelled'); assert.equal((await f.auth.getApplicationAccount()).account.id, id);
  assert.deepEqual(await fs.readdir(f.root), []);
});
