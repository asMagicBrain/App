import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testRoot } from '../../../tools/development-paths.mjs';
import { currentStorageIdentity, persistentDevice, persistentIdentity, runStorageWorkerEnvelope,
  runWithStorageIdentity, storageWorkerEnvelope } from '../src/adapters/storage-identity.mjs';

function fixture() {
  const directory = path.join(testRoot, 'runs', 'storage-identity-unit');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(directory, 'profile-'));
  const stat = fs.lstatSync(root, { bigint: true }), currentDevice = Number(stat.dev);
  const context = { schemaVersion: 1, root, rootInode: stat.ino.toString(), owner: Number(stat.uid),
    currentDevice, namespaceDevice: currentDevice + 1, volumeId: 'fixture-volume' };
  return { root, stat, context };
}
const rejected = fn => assert.throws(fn, { code: 'RECOVERY_REQUIRED' });

test('identity scope preserves raw stats and swaps both devices without collisions', () => {
  const { root, stat, context } = fixture();
  const methods = [fs.statSync, fs.lstatSync, fs.fstatSync];
  assert.equal(currentStorageIdentity(), null);
  assert.equal(persistentIdentity(stat), `${stat.dev}:${stat.ino}`);
  const result = runWithStorageIdentity(context, () => {
    const admitted = currentStorageIdentity();
    assert.equal(Object.isFrozen(admitted), true);
    assert.notEqual(admitted, context);
    context.namespaceDevice += 10;
    const { currentDevice: current, namespaceDevice: namespace } = admitted;
    assert.equal(persistentDevice(current), namespace);
    assert.equal(persistentDevice(namespace), current);
    assert.equal(persistentDevice(current + 2), current + 2);
    assert.equal(new Set([current, namespace, current + 2].map(persistentDevice)).size, 3);
    assert.equal(persistentDevice(BigInt(current)), BigInt(namespace));
    assert.equal(persistentDevice(BigInt(namespace)), BigInt(current));
    assert.equal(persistentIdentity(stat), `${namespace}:${stat.ino}`);
    assert.equal(fs.lstatSync(root, { bigint: true }).dev, stat.dev);
    assert.deepEqual([fs.statSync, fs.lstatSync, fs.fstatSync], methods);
    return 17;
  });
  assert.equal(result, 17);
  assert.equal(currentStorageIdentity(), null);
  assert.equal(persistentDevice(stat.dev), stat.dev);
});

test('nested and concurrent async scopes restore their own immutable contexts', async () => {
  const first = fixture(), second = fixture();
  second.context.namespaceDevice += 10;
  let releaseFirst, releaseSecond;
  const firstWait = new Promise(resolve => { releaseFirst = resolve; });
  const secondWait = new Promise(resolve => { releaseSecond = resolve; });
  await Promise.all([
    runWithStorageIdentity(first.context, async () => {
      await firstWait;
      assert.equal(currentStorageIdentity().root, first.root);
      runWithStorageIdentity(second.context, () => assert.equal(currentStorageIdentity().root, second.root));
      runWithStorageIdentity(null, () => assert.equal(currentStorageIdentity(), null));
      assert.equal(currentStorageIdentity().root, first.root);
      releaseSecond();
      await Promise.resolve();
      return assert.equal(persistentDevice(first.context.currentDevice), first.context.namespaceDevice);
    }),
    runWithStorageIdentity(second.context, async () => {
      releaseFirst();
      await secondWait;
      assert.equal(currentStorageIdentity().root, second.root);
      assert.equal(persistentDevice(second.context.currentDevice), second.context.namespaceDevice);
    }),
  ]);
  assert.equal(currentStorageIdentity(), null);
  await assert.rejects(runWithStorageIdentity(first.context, async () => { throw new Error('callback'); }), /callback/u);
  assert.throws(() => runWithStorageIdentity(first.context, () => { throw new Error('callback'); }), /callback/u);
  assert.equal(currentStorageIdentity(), null);
});

test('context rejects extra keys, accessors, invalid numbers and noncanonical paths', () => {
  const { context } = fixture();
  const invalid = [
    { extra: true }, { schemaVersion: 2 }, { root: 'relative' }, { root: `${context.root}/` },
    { root: `${context.root}/../${path.basename(context.root)}` }, { root: '/' }, { root: `${context.root}\0` },
    { rootInode: '01' }, { rootInode: '0' }, { rootInode: '18446744073709551616' },
    { owner: -1 }, { owner: 0x100000000 }, { currentDevice: Number.NaN }, { currentDevice: -1 },
    { currentDevice: 1.5 }, { namespaceDevice: Number.MAX_SAFE_INTEGER + 1 }, { namespaceDevice: 1n },
    { volumeId: '' }, { volumeId: 'contains space' }, { volumeId: 'a'.repeat(129) },
  ];
  for (const change of invalid) rejected(() => runWithStorageIdentity({ ...context, ...change }, () => assert.fail('entered')));
  const missing = { ...context }; delete missing.volumeId;
  rejected(() => runWithStorageIdentity(missing, () => {}));
  const accessor = { ...context }; Object.defineProperty(accessor, 'owner', { get() { assert.fail('accessor ran'); }, enumerable: true });
  rejected(() => runWithStorageIdentity(accessor, () => {}));
  rejected(() => runWithStorageIdentity({ ...context, [Symbol('extra')]: true }, () => {}));
  for (const dev of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, -1n, 1n << 64n, '1']) rejected(() => persistentDevice(dev));
});

test('root admission rejects changed device, inode, owner, missing root and symlink ancestors', () => {
  const { root, context } = fixture();
  for (const change of [{ currentDevice: context.currentDevice + 1 }, { rootInode: String(BigInt(context.rootInode) + 1n) },
    { owner: context.owner + 1 }, { root: path.join(root, 'missing') }]) {
    rejected(() => runWithStorageIdentity({ ...context, ...change }, () => assert.fail('entered')));
  }
  const linked = `${root}-linked`; fs.symlinkSync(root, linked);
  rejected(() => runWithStorageIdentity({ ...context, root: linked }, () => {}));
  const child = path.join(root, 'child'); fs.mkdirSync(child);
  const stat = fs.lstatSync(child);
  rejected(() => runWithStorageIdentity({ ...context, root: path.join(linked, 'child'), rootInode: String(stat.ino) }, () => {}));
  fs.renameSync(root, `${root}-retained`); fs.mkdirSync(root);
  rejected(() => runWithStorageIdentity(context, () => {}));
});

test('worker envelopes preserve legacy requests and validate exact context on decode', async () => {
  const { context } = fixture(), request = { command: 'read', value: 1 };
  assert.equal(storageWorkerEnvelope(request), request);
  let envelope;
  runWithStorageIdentity(context, () => {
    envelope = storageWorkerEnvelope(request);
    assert.equal(envelope.request, request);
    assert.equal(envelope.storageIdentity, currentStorageIdentity());
    runStorageWorkerEnvelope(request, value => { assert.equal(value, request); assert.equal(currentStorageIdentity(), null); });
    assert.equal(currentStorageIdentity().root, context.root);
  });
  const wire = JSON.parse(JSON.stringify(envelope));
  assert.equal(await runStorageWorkerEnvelope(wire, async value => {
    await Promise.resolve();
    assert.deepEqual(value, request);
    assert.equal(currentStorageIdentity().root, context.root);
    return persistentDevice(context.currentDevice);
  }), context.namespaceDevice);
  assert.equal(currentStorageIdentity(), null);
  for (const invalid of [{ ...wire, extra: 1 }, { storageIdentity: context }, { storageIdentity: null, request },
    { ...wire, storageIdentity: { ...context, currentDevice: context.currentDevice + 1 } },
    Object.assign(Object.create({ storageIdentity: context }), { request })]) {
    rejected(() => runStorageWorkerEnvelope(invalid, () => assert.fail('entered')));
  }
  fs.renameSync(context.root, `${context.root}-retained`); fs.mkdirSync(context.root);
  rejected(() => runStorageWorkerEnvelope(wire, () => assert.fail('entered')));
});

test('an unchanged device namespace preserves number and bigint identities', () => {
  const { context } = fixture(); context.namespaceDevice = context.currentDevice;
  runWithStorageIdentity(context, () => {
    assert.equal(persistentDevice(context.currentDevice), context.currentDevice);
    assert.equal(persistentDevice(BigInt(context.currentDevice)), BigInt(context.currentDevice));
    assert.equal(persistentDevice(0), 0);
    assert.equal(persistentDevice(0n), 0n);
  });
});
