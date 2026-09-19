import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {testRoot} from '../../tools/development-paths.mjs';
import {createNativeService} from './host-service.mjs';
import {prepareNativeStorage} from './storage-admission.mjs';

const root = path.join(testRoot, 'runs', 'storage-admission');
fs.mkdirSync(root, {recursive: true, mode: 0o700});
const volumeId = 'a2ecb956-8e09-4de1-9e4f-bde230c018aa';
const marker = '.asmb-storage-volume.json';
const request = (service, operation, args = {}) => service.request({repo: 'Workspace', operation, args});
function fixture() {
  const parent = fs.mkdtempSync(path.join(root, 'case-')), dataRoot = path.join(parent, 'data');
  fs.mkdirSync(dataRoot, {mode: 0o700});
  return {parent, dataRoot, probe: () => volumeId};
}
function inventory(directory) {
  const result = {};
  function visit(dir) {for (const name of fs.readdirSync(dir).sort()) {
    if (dir === directory && [marker, '.asmb-storage-volume.pending', '.asmb-native.lock'].includes(name)) continue;
    const file = path.join(dir, name), stat = fs.lstatSync(file), relative = path.relative(directory, file);
    result[relative] = {ino: stat.ino, mode: stat.mode, ...(stat.isFile() ? {hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex')} : {})};
    if (stat.isDirectory()) visit(file);
  }} visit(directory); return result;
}
async function legacy(f, changed = true) {
  const stat = fs.lstatSync(f.dataRoot);
  // Generates the exact legacy ledger format under a prior device namespace.
  // No stat monkeypatch: real workers see and validate the current raw device.
  const context = {schemaVersion: 1, root: f.dataRoot, rootInode: String(stat.ino), owner: stat.uid,
    currentDevice: stat.dev, namespaceDevice: stat.dev + (changed ? 2 : 0), volumeId};
  const service = await createNativeService({dataRoot: f.dataRoot, storageIdentity: context});
  try {
    const opened = await request(service, 'open', {path: 'README.md'});
    await request(service, 'checkpoint', {path: 'README.md', baseHash: opened.sourceHash, text: '# Preserved unsaved draft\n'});
    await request(service, 'checkpointNew', {draftId: 'new-draft', path: 'notes/new.md', text: 'new unsaved document'});
    await service.setAppearance({themeId: 'dark-dimmed', hideUnavailable: false});
  } finally {await service.close();}
  return context;
}
async function open(f, admission) {return createNativeService({dataRoot: f.dataRoot, storageIdentity: admission.context, profileLock: admission.profileLock});}

test('fresh native profile records its volume; legacy device renumber recovers without rewriting old records', async () => {
  const f = fixture(), oldContext = await legacy(f), before = inventory(f.dataRoot);
  let confirmations = 0;
  const admission = await prepareNativeStorage({...f, confirmRecovery: async () => {confirmations++; return true;}});
  assert.equal(confirmations, 1); assert.equal(admission.context.namespaceDevice, oldContext.namespaceDevice);
  assert.deepEqual(inventory(f.dataRoot), before, 'admission preserves every existing inode, mode and file byte');
  assert.ok(fs.existsSync(path.join(admission.backupPath, 'receipt.json')));
  assert.deepEqual(fs.readFileSync(path.join(admission.backupPath, 'managed-data/workspaces/asMagicBrain/Workspace/README.md')), fs.readFileSync(path.join(f.dataRoot, 'workspaces/asMagicBrain/Workspace/README.md')));
  let service = await open(f, admission);
  try {
    assert.equal((await request(service, 'open', {path: 'README.md'})).draft.text, '# Preserved unsaved draft\n');
    assert.equal((await service.bootstrap('Workspace')).newDrafts[0].text, 'new unsaved document');
    assert.equal((await service.getAppearance()).themeId, 'dark-dimmed');
    await request(service, 'create', {path: 'after-recovery.md', text: '# New saved file\n'});
  } finally {await service.close();}
  const next = await prepareNativeStorage({...f, confirmRecovery: () => assert.fail('recovery is one-time'), backup: () => assert.fail('no repeated backup')});
  service = await open(f, next);
  try {assert.equal((await service.read({repo: 'Workspace', path: 'after-recovery.md'})).content, '# New saved file\n');}
  finally {await service.close();}
});

test('fresh profile initializes once and reopens with the same volume identity', async () => {
  const f = fixture(); let admission = await prepareNativeStorage(f), service = await open(f, admission);
  await service.close(); admission = await prepareNativeStorage(f); service = await open(f, admission);
  try {assert.equal((await service.catalog()).repositories[0].name, 'Workspace');} finally {await service.close();}
});

test('released admission lock cannot be handed to a service', async () => {
  const f = fixture(), admission = await prepareNativeStorage(f);
  admission.profileLock.release();
  await assert.rejects(open(f, admission), {code: 'RECOVERY_REQUIRED'});
  assert.equal(fs.existsSync(path.join(f.dataRoot, 'workspaces')), false);
});

test('fresh interrupted publication keeps its recorded namespace across device renumbering', async () => {
  const f = fixture();
  await assert.rejects(prepareNativeStorage({...f, hooks: {at: point => {if (point === 'before-identity-publication') throw Error('stop');}}}));
  const pending = path.join(f.dataRoot, '.asmb-storage-volume.pending');
  const record = JSON.parse(fs.readFileSync(pending));
  record.body.namespaceDevice += 2; // Prior-boot device namespace; no ledgers exist yet.
  record.checksum = createHash('sha256').update(JSON.stringify(record.body)).digest('hex');
  fs.writeFileSync(pending, JSON.stringify(record) + '\n');
  const admission = await prepareNativeStorage(f);
  assert.equal(admission.context.namespaceDevice, record.body.namespaceDevice);
  const service = await open(f, admission); await service.close();
});

test('healthy legacy profile adds a stable identity without changing normal startup recovery', async () => {
  const f = fixture(); await legacy(f, false); const before = inventory(f.dataRoot);
  const admission = await prepareNativeStorage({...f, confirmRecovery: () => assert.fail('no disk change')});
  assert.equal(admission.backupPath, undefined); assert.deepEqual(inventory(f.dataRoot), before); admission.profileLock.release();
});

test('unchanged-device upgrade preserves normal recovery of an interrupted repository rename', async () => {
  const f = fixture();
  let service = await createNativeService({dataRoot: f.dataRoot, hooks: {at: point => {if (point === 'rename-moved') throw Error('interrupted rename');}}});
  await assert.rejects(service.renameRepository({repository: 'Workspace', name: 'Personal'}));
  await service.close();
  const admission = await prepareNativeStorage({...f, confirmRecovery: () => assert.fail('unchanged device'), backup: () => assert.fail('normal host recovery remains authoritative')});
  service = await open(f, admission);
  try {assert.equal((await service.catalog()).defaultRepository, 'Personal');}
  finally {await service.close();}
});

test('cancel, backup failure and changed-after-backup all preserve legacy state and do not publish identity', async () => {
  for (const mode of ['cancel', 'backup-failure', 'change-after-backup']) {
    const f = fixture(); await legacy(f); const before = inventory(f.dataRoot);
    const options = {...f, confirmRecovery: () => mode !== 'cancel'};
    if (mode === 'backup-failure') options.backup = () => {throw Object.assign(Error('no room'), {code: 'ENOSPC'});};
    if (mode === 'change-after-backup') options.hooks = {at: () => fs.writeFileSync(path.join(f.dataRoot, 'workspaces/asMagicBrain/Workspace/README.md'), 'external update')};
    await assert.rejects(prepareNativeStorage(options));
    assert.equal(fs.existsSync(path.join(f.dataRoot, marker)), false);
    if (mode !== 'change-after-backup') assert.deepEqual(inventory(f.dataRoot), before);
    assert.equal(fs.existsSync(path.join(f.dataRoot, '.asmb-native.lock')), false);
  }
});

test('checksum corruption and replaced repository inode are refused before backup or consent', async () => {
  for (const mode of ['checksum', 'replacement']) {
    const f = fixture(); await legacy(f);
    if (mode === 'checksum') fs.appendFileSync(path.join(f.dataRoot, 'state/native/.asmb-host/0000000000000001.json'), 'broken');
    else {
      const workspace = path.join(f.dataRoot, 'workspaces/asMagicBrain/Workspace');
      fs.renameSync(workspace, path.join(f.parent, 'original-workspace'));
      fs.mkdirSync(workspace, {mode: 0o700}); fs.writeFileSync(path.join(workspace, 'README.md'), 'replacement');
    }
    const before = inventory(f.dataRoot);
    await assert.rejects(prepareNativeStorage({...f, confirmRecovery: () => assert.fail('unsafe consent'), backup: () => assert.fail('unsafe backup')}));
    assert.deepEqual(inventory(f.dataRoot), before); assert.equal(fs.existsSync(path.join(f.dataRoot, marker)), false);
  }
});

test('a changed volume UUID, root inode or malformed marker cannot silently adopt a different profile', async () => {
  const f = fixture(), admission = await prepareNativeStorage(f); admission.profileLock.release();
  await assert.rejects(prepareNativeStorage({...f, probe: () => 'another-volume'}), {code: 'STORAGE_IDENTITY_MISMATCH'});
  const original = path.join(f.parent, 'original'); fs.renameSync(f.dataRoot, original); fs.mkdirSync(f.dataRoot, {mode: 0o700});
  fs.copyFileSync(path.join(original, marker), path.join(f.dataRoot, marker)); fs.chmodSync(path.join(f.dataRoot, marker), 0o600);
  await assert.rejects(prepareNativeStorage(f), {code: 'STORAGE_IDENTITY_MISMATCH'});
});

test('interrupted complete publication resumes with exact records; in-use profile cannot enter migration', async () => {
  for (const phase of ['before-identity-publication', 'after-identity-publication']) {
    const f = fixture(); await legacy(f); const before = inventory(f.dataRoot);
    await assert.rejects(prepareNativeStorage({...f, confirmRecovery: () => true, hooks: {at: point => {if (point === phase) throw Error('simulated stop');}}}));
    assert.deepEqual(inventory(f.dataRoot), before);
    const admission = await prepareNativeStorage({...f, confirmRecovery: () => true});
    assert.equal(fs.existsSync(path.join(f.dataRoot, '.asmb-storage-volume.pending')), false);
    await assert.rejects(prepareNativeStorage(f), {code: 'PROFILE_IN_USE'});
    admission.profileLock.release();
  }
});
