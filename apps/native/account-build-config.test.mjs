import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveAccountBuildConfig} from './account-build-config.mjs';
import {createApplicationAuth} from './application-auth.mjs';
import {createAuthTransport} from './application-transport.mjs';

test('source account build defaults offline; official preset is explicit and reproducible', async () => {
  const offline = resolveAccountBuildConfig();
  assert.equal(offline.id, 'offline'); assert.equal(offline.applicationAccount.origin, null); assert.equal(offline.githubApp.clientId, null);
  const service = createApplicationAuth({config: offline.applicationAccount, fetch() {throw Error('Offline build made a request');}});
  assert.equal((await service.getApplicationAccount()).state, 'unavailable'); await service.close();
  const official = resolveAccountBuildConfig('official');
  assert.equal(official.githubApp.slug, 'asmagicbrain'); assert.equal(official.sha256, resolveAccountBuildConfig('official').sha256);
  assert.notEqual(official.sha256, offline.sha256);
});
test('fork public registration pins a canonical HTTPS origin and rejects extra secret keys', t => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'asmb-account-build-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const filename = path.join(directory, 'accounts.json');
  const value = {applicationAccount: {origin: 'https://fork.example.invalid', publishableKey: 'sb_publishable_synthetic_fork_123', providers: {github: true, email: false}}, githubApp: {clientId: 'Iv23Synthetic123', slug: 'synthetic-fork'}};
  const write = item => fs.writeFileSync(filename, JSON.stringify(item));
  write(value); const selected = resolveAccountBuildConfig(filename);
  assert.equal(selected.id, 'custom'); assert.equal(selected.applicationAccount.origin, value.applicationAccount.origin);
  assert.throws(() => resolveAccountBuildConfig('relative.json'));
  for (const origin of ['http://fork.example.invalid', 'https://user:password@fork.example.invalid', 'https://fork.example.invalid/path', 'https://fork.example.invalid/', 'https://fork.example.invalid?key=a', 'https://fork.example.invalid#part']) {
    write({...value, applicationAccount: {...value.applicationAccount, origin}}); assert.throws(() => resolveAccountBuildConfig(filename));
  }
  write({...value, secret: 'do-not-embed'}); assert.throws(() => resolveAccountBuildConfig(filename));
  write({...value, applicationAccount: {...value.applicationAccount, serviceRoleKey: 'do-not-embed'}}); assert.throws(() => resolveAccountBuildConfig(filename));
  write({...value, applicationAccount: {...value.applicationAccount, publishableKey: 'sb_secret_do-not-embed'}}); assert.throws(() => resolveAccountBuildConfig(filename));
});
test('fork transport sends requests only to the compiled origin and never follows redirects', async () => {
  const calls = [];
  const transport = createAuthTransport({origin: 'https://fork.example.invalid', fetch: async (url, options) => {
    calls.push({url, options}); return new Response('{}', {status: 200});
  }});
  const context = transport.context(), request = transport.forContext(context);
  for (const url of ['https://different.example.invalid/auth/v1/user', 'http://fork.example.invalid/auth/v1/user', 'https://fork.example.invalid/not-auth', 'https://user:pass@fork.example.invalid/auth/v1/user']) {
    assert.equal((await request(url)).status, 400);
  }
  assert.equal(calls.length, 0);
  assert.equal((await request('https://fork.example.invalid/auth/v1/user')).status, 200);
  assert.equal(calls.length, 1); assert.equal(calls[0].options.redirect, 'error');
  transport.release(context);
});
