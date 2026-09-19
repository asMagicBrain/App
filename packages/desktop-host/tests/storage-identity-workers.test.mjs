import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Worker} from 'node:worker_threads';
import {fileURLToPath} from 'node:url';
import {crc32} from 'node:zlib';
import {persistentIdentity, runWithStorageIdentity, currentStorageIdentity, storageWorkerEnvelope} from '../../source-foundation/src/adapters/storage-identity.mjs';
import {createNodeFilesystem} from '../../source-foundation/src/adapters/node-filesystem.mjs';
import {prepareSourceTransaction} from '../../source-foundation/src/operations/requests.mjs';
import {pinDirectory} from '../src/physical-roots.mjs';
import {renameDirectoryStep} from '../src/repository-import/rename-directory.mjs';
import {copyLocalRepository} from '../src/repository-import/copy-repository.mjs';
import {createRepositoryImporter} from '../src/repository-import/index.mjs';
import {createRepositorySearch} from '../../../apps/native/repository-search.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'asmb-storage-worker-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const stat = fs.lstatSync(root, {bigint: true});
  const context = {schemaVersion: 1, root, rootInode: String(stat.ino), owner: Number(stat.uid),
    currentDevice: Number(stat.dev), namespaceDevice: Number(stat.dev) + 71, volumeId: 'fixture-volume'};
  const directory = name => {const value = path.join(root, name); fs.mkdirSync(value, {recursive: true, mode: 0o700}); return value;};
  return {root, context, directory};
}
function command(relative, cwd, request) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(relative, import.meta.url))], {
    cwd, encoding: 'utf8', input: JSON.stringify(request), timeout: 10000,
    env: {PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', ...(process.versions.electron ? {ELECTRON_RUN_AS_NODE: '1'} : {})},
  });
  assert.ifError(result.error); assert.equal(result.stderr, '');
  return {status: result.status, value: JSON.parse(result.stdout)};
}
function thread(relative, workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(relative, import.meta.url), {workerData}); let result;
    worker.on('message', value => {if (Object.hasOwn(value, 'ok')) result = value;});
    worker.once('error', reject);
    worker.once('exit', code => code === 0 && result ? resolve(result) : reject(Error(`Worker exited ${code}`)));
  });
}

test('filesystem batches keep raw parentDev while source transactions and replay use the namespace', t => {
  const f = fixture(t), source = f.directory('source'), recovery = f.directory('recovery');
  fs.mkdirSync(path.join(source, 'nested')); fs.writeFileSync(path.join(source, 'nested/note.md'), 'before');
  runWithStorageIdentity(f.context, () => {
    const options = {repositoryRoot: source, recoveryRoot: recovery, spaceRoot: '.', spaceId: randomUUID()};
    const adapter = createNodeFilesystem(options);
    assert.equal(Buffer.from(adapter.inspectMany(['nested/note.md'])[0].bytes).toString(), 'before');
    assert.equal(adapter.inspectDirectory('nested').identity, persistentIdentity(fs.statSync(path.join(source, 'nested'))));
    const plan = prepareSourceTransaction({schemaVersion: 2, requestId: randomUUID(), target: {kind: 'source', spaceId: options.spaceId},
      expected: {files: [{path: 'nested/note.md', hash: hash('before')}]},
      input: {files: [{path: 'nested/note.md', bytes: Buffer.from('after')}], assets: []}});
    assert.equal(adapter.apply(plan).status, 'completed');
    assert.equal(createNodeFilesystem(options).apply(plan).status, 'completed');
    assert.equal(fs.readFileSync(path.join(source, 'nested/note.md'), 'utf8'), 'after');
    const journal = fs.readdirSync(recovery).filter(name => name.endsWith('.json')).map(name => fs.readFileSync(path.join(recovery, name), 'utf8')).join('\n');
    assert(journal.includes(`"repositoryIdentity":"${persistentIdentity(fs.statSync(source))}"`));
    assert.equal(fs.statSync(source).dev, f.context.currentDevice);
  });
});

test('rename and both nested repository-copy workers preserve mapped identities and original bytes', async t => {
  const f = fixture(t), source = f.directory('Original'); f.directory('Original/nested');
  fs.writeFileSync(path.join(source, 'nested/note.md'), '\ufeffsaved\r\n');
  await runWithStorageIdentity(f.context, async () => {
    const parent = pinDirectory(f.root), original = pinDirectory(source).identity;
    const reservation = renameDirectoryStep(parent, {operation: 'reserve', name: 'Renamed'});
    assert(reservation.startsWith(f.context.namespaceDevice + ':'));
    assert.equal(renameDirectoryStep(parent, {operation: 'rename', repository: 'Original', name: 'Renamed', identity: original, reservationIdentity: reservation}), original);
    const destination = f.directory('.asmb-import-' + randomUUID());
    await copyLocalRepository({sourceRoot: path.join(f.root, 'Renamed'), destination});
    assert.equal(fs.readFileSync(path.join(destination, 'nested/note.md'), 'utf8'), '\ufeffsaved\r\n');
    assert.notEqual(fs.statSync(destination).ino, fs.statSync(path.join(f.root, 'Renamed')).ino);
  });
});

test('file-management and GitHub-apply command workers admit mapped parents and return mapped reservations', t => {
  const f = fixture(t);
  runWithStorageIdentity(f.context, () => {
    const parentIdentity = persistentIdentity(fs.statSync(f.root));
    for (const [worker, name] of [['../src/repository-runtime/file-management-worker.mjs', 'managed'], ['../src/local-git/github-apply-worker.mjs', 'applied']]) {
      const reply = command(worker, f.root, storageWorkerEnvelope({command: 'mkdir', parentIdentity, name}));
      assert.equal(reply.status, 0); assert.equal(reply.value.ok, true);
      assert.equal(reply.value.value.identity, persistentIdentity(fs.statSync(path.join(f.root, name))));
    }
  });
});

test('search caller carries the mapped admitted root into its fixed worker', async t => {
  const f = fixture(t), source = f.directory('source'); fs.writeFileSync(path.join(source, 'note.md'), 'saved');
  await runWithStorageIdentity(f.context, async () => {
    const search = createRepositorySearch({admit: async () => [{repo: 'Fixture', pin: pinDirectory(source)}]});
    try {assert.deepEqual((await search.listRepositoryFiles({requestId: 'mapped-search', repo: 'Fixture'})).paths, ['note.md']);}
    finally {await search.close();}
  });
});

test('external worker initializes workspace bindings under its host-supplied context', async t => {
  const f = fixture(t), base = f.directory('organization'), privateBase = f.directory('state'), source = f.directory('organization/Workspace');
  fs.writeFileSync(path.join(source, 'note.md'), 'saved');
  await runWithStorageIdentity(f.context, async () => {
    const reply = await thread('../src/repository-import/external-worker.mjs', {storageIdentity: currentStorageIdentity(),
      workspace: {base, privateBase, builtinRepositories: [{name: 'Workspace', privateRepo: true}],
        repositoryBindings: [{name: 'Workspace', identity: persistentIdentity(fs.statSync(source)), stateKey: 'Workspace', bindingName: 'Workspace'}]},
      repo: 'Workspace', operation: 'inspectEntry', args: {path: 'note.md'}, cancelFlag: new SharedArrayBuffer(4)});
    assert.equal(reply.ok, true, JSON.stringify(reply)); assert.equal(reply.value.token, hash('saved'));
  });
});

// One stored member, with headers generated independently of the ZIP importer.
function archive() {
  const name = Buffer.from('fixture-main/note.md'), data = Buffer.from('archive saved\r\n');
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22), crc = crc32(data);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0x81a40000, 38);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}
test('archive-import caller propagates its context through the worker thread and catalog receipt', async t => {
  const f = fixture(t), base = f.directory('organization'), archivePath = path.join(f.root, 'fixture.zip');
  fs.writeFileSync(archivePath, archive());
  await runWithStorageIdentity(f.context, async () => {
    const importer = createRepositoryImporter({base});
    const result = await importer.importArchive({name: 'Imported', archivePath});
    assert.equal(result.files, 1); assert.equal(fs.readFileSync(path.join(base, 'Imported/note.md'), 'utf8'), 'archive saved\r\n');
    assert.equal(importer.catalog.list().some(item => item.name === 'Imported'), true);
  });
});

test('invalid context and extra command fields fail before worker mutation; raw legacy requests still work', t => {
  const f = fixture(t), worker = '../src/repository-import/rename-worker.mjs';
  const rawIdentity = `${fs.statSync(f.root).dev}:${fs.statSync(f.root).ino}`;
  const request = {operation: 'reserve', name: 'Forbidden', parentIdentity: rawIdentity};
  const invalid = command(worker, f.root, {storageIdentity: {...f.context, rootInode: String(BigInt(f.context.rootInode) + 1n)}, request});
  assert.equal(invalid.value.code, 'RECOVERY_REQUIRED'); assert.equal(fs.existsSync(path.join(f.root, 'Forbidden')), false);
  runWithStorageIdentity(f.context, () => {
    const reply = command(worker, f.root, storageWorkerEnvelope({...request, parentIdentity: persistentIdentity(fs.statSync(f.root)), root: f.root}));
    assert.equal(reply.value.code, 'INVALID_REQUEST'); assert.equal(fs.existsSync(path.join(f.root, 'Forbidden')), false);
  });
  const legacy = command(worker, f.root, {...request, name: 'Legacy'});
  assert.equal(legacy.status, 0); assert.equal(legacy.value.identity, `${fs.statSync(path.join(f.root, 'Legacy')).dev}:${fs.statSync(path.join(f.root, 'Legacy')).ino}`);
});
