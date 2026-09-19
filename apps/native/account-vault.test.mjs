import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createAccountVault, createSessionCredentialVault} from './account-vault.mjs';

test('session policy never consults a profile path or encryption adapter', async () => {
  const forbidden = new Proxy({}, {get() {assert.fail('Encryption adapter must not be consulted');}});
  const vault = createAccountVault({storagePolicy: 'session', profileRoot: null, storage: forbidden, clientId: null});
  assert.equal(vault.policy, 'session'); assert.equal(await vault.isAvailable(), true);
  assert.equal(await vault.load(), null);
  await vault.save({token: 'synthetic-current-process-token'});
  assert.deepEqual(await vault.load(), {token: 'synthetic-current-process-token'});
  await vault.remove(); assert.equal(await vault.load(), null);
  await vault.close(); assert.equal(await vault.isAvailable(), false);
});

test('session records are isolated snapshots and cancellation preserves the previous record', async () => {
  const first = createSessionCredentialVault(), second = createSessionCredentialVault();
  const input = {token: 'synthetic-first', account: {name: 'Original'}};
  const save = first.save(input); input.account.name = 'Outside mutation'; await save;
  const read = await first.load(); read.account.name = 'Reader mutation';
  assert.equal((await first.load()).account.name, 'Original'); assert.equal(await second.load(), null);
  let committed = false;
  assert.equal(await first.save({token: 'synthetic-late'}, {isCurrent: () => false, onCommitted: () => {committed = true;}}), false);
  assert.equal(committed, false); assert.equal((await first.load()).token, 'synthetic-first');
  await first.close(); await second.close();
});

test('closing clears the vault and rejects queued or later publications without affecting a new host lifetime', async () => {
  const vault = createSessionCredentialVault({errorCode: 'ACCOUNT_STORAGE_UNAVAILABLE'});
  await vault.save({token: 'synthetic-active'});
  const late = vault.save({token: 'synthetic-late'});
  const rejection = assert.rejects(late, {code: 'ACCOUNT_STORAGE_UNAVAILABLE'});
  await vault.close(); await rejection; await vault.drain();
  await assert.rejects(vault.load(), {code: 'ACCOUNT_STORAGE_UNAVAILABLE'});
  await assert.rejects(vault.save({token: 'synthetic-reopen'}), {code: 'ACCOUNT_STORAGE_UNAVAILABLE'});
  const restarted = createSessionCredentialVault(); assert.equal(await restarted.load(), null); await restarted.close();
});

test('invalid policies and oversized session records fail without exposing supplied credential bytes', async () => {
  assert.throws(() => createAccountVault({storagePolicy: 'unexpected'}), /Unknown account storage policy/);
  const vault = createSessionCredentialVault();
  await assert.rejects(vault.save({token: 'synthetic_sensitive_'.repeat(2000)}), reason => reason.code === 'GITHUB_STORAGE_UNAVAILABLE' && !reason.message.includes('synthetic_sensitive'));
  assert.equal(await vault.load(), null); await vault.close();
});

test('session policy leaves both legacy credential namespaces unread and unchanged', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'asmb-session-legacy-'));
  t.after(async () => {t.mock.restoreAll(); await fs.rm(root, {recursive: true, force: true});});
  const entries = [];
  for (const namespace of ['application-auth', 'github-auth']) {
    const directory = path.join(root, namespace), clientId = 'synthetic-client-' + namespace;
    await fs.mkdir(directory, {mode: 0o700});
    const filename = path.join(directory, createHash('sha256').update(clientId).digest('hex') + '.bin');
    const bytes = Buffer.from('opaque-legacy-test-ciphertext-' + namespace);
    await fs.writeFile(filename, bytes, {mode: 0o600});
    entries.push({filename, bytes, clientId, namespace, before: await fs.stat(filename)});
  }
  let filesystemCalls = 0;
  for (const method of ['lstat', 'stat', 'realpath', 'mkdir', 'open', 'readFile', 'writeFile', 'rename', 'unlink', 'rm', 'readdir']) {
    t.mock.method(fs, method, () => {filesystemCalls++; throw Error('Session policy attempted filesystem access');});
  }
  const forbidden = new Proxy({}, {get() {assert.fail('Session policy attempted legacy decryption');}});
  for (const {clientId, namespace} of entries) {
    const vault = createAccountVault({storagePolicy: 'session', profileRoot: root, clientId, namespace, storage: forbidden});
    assert.equal(await vault.load(), null);
    await vault.save({token: 'synthetic-current-session'}); await vault.remove(); await vault.close();
  }
  assert.equal(filesystemCalls, 0); t.mock.restoreAll();
  for (const {filename, bytes, before} of entries) {
    assert.deepEqual(await fs.readFile(filename), bytes);
    const after = await fs.stat(filename);
    assert.equal(after.mode, before.mode); assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ino, before.ino);
  }
});
