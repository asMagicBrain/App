import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { testRoot } from '../../tools/development-paths.mjs';
import { backupStorageProfile, probeStorageVolume } from './storage-backup.mjs';

function fixture() {
  const parent = path.join(testRoot, 'runs', 'storage-backup-unit');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const base = fs.mkdtempSync(path.join(parent, 'case-')), root = path.join(base, 'managed data');
  fs.mkdirSync(root, { mode: 0o700 });
  for (const name of ['state', 'state/native', 'workspaces', 'workspaces/Workspace']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const files = new Map([
    ['state/native/draft.json', Buffer.from('{"text":"unsaved draft 中文"}\n')],
    ['workspaces/Workspace/A file.md', Buffer.from('\ufeff# Saved\r\nunchanged\r\n')],
    ['workspaces/Workspace/binary.dat', Buffer.from(Array.from({ length: 2 * 1024 * 1024 + 19 }, (_, i) => i % 256))],
  ]);
  for (const [name, bytes] of files) fs.writeFileSync(path.join(root, name), bytes, { mode: name.startsWith('state/') ? 0o600 : 0o644 });
  fs.writeFileSync(path.join(root, '.asmb-native.lock'), JSON.stringify({ pid: process.pid, token: randomUUID() }), { mode: 0o600 });
  return { base, root, files, backupRoot: path.join(base, 'backup area') };
}
function snapshot(root) {
  const entries = [];
  function walk(relative) {
    const filename = relative ? path.join(root, relative) : root, stat = fs.lstatSync(filename, { bigint: true });
    entries.push({ relative, stamp: [stat.dev, stat.ino, stat.mode, stat.uid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'),
      hash: stat.isFile() ? createHash('sha256').update(fs.readFileSync(filename)).digest('hex') : null });
    if (stat.isDirectory()) for (const name of fs.readdirSync(filename).sort()) walk(relative ? `${relative}/${name}` : name);
  }
  walk(''); return entries;
}
function failed(fn) { let error; try { fn(); } catch (caught) { error = caught; } assert.equal(error?.code, 'STORAGE_BACKUP_FAILED'); return error; }

test('backup preserves saved/draft/binary bytes and modes without writing or fsyncing originals', t => {
  const f = fixture(), before = snapshot(f.root), originalSync = fs.fsyncSync;
  const sourceIds = new Set(before.map(row => row.stamp.split(':').slice(0, 2).join(':')));
  t.mock.method(fs, 'fsyncSync', fd => {
    const stat = fs.fstatSync(fd, { bigint: true });
    assert.equal(sourceIds.has(`${stat.dev}:${stat.ino}`), false);
    return originalSync(fd);
  });
  const backupPath = backupStorageProfile({ dataRoot: f.root, backupRoot: f.backupRoot });
  assert.equal(path.dirname(backupPath), f.backupRoot);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(fs.existsSync(path.join(backupPath, 'managed-data/.asmb-native.lock')), false);
  const receipt = JSON.parse(fs.readFileSync(path.join(backupPath, 'receipt.json')));
  assert.equal(receipt.status, 'verified'); assert.equal(receipt.fileCount, f.files.size);
  assert.deepEqual(receipt.excluded, ['.asmb-native.lock']);
  for (const [name, bytes] of f.files) {
    assert.deepEqual(fs.readFileSync(path.join(backupPath, 'managed-data', name)), bytes);
    assert.equal(fs.statSync(path.join(backupPath, 'managed-data', name)).mode & 0o777, fs.statSync(path.join(f.root, name)).mode & 0o777);
    assert.equal(receipt.files.find(row => row.path === name).sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  assert.equal(fs.statSync(backupPath).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(backupPath, 'receipt.json')).mode & 0o777, 0o600);
});

test('default destination is separate and repeated backups never overwrite prior output', () => {
  const f = fixture(), first = backupStorageProfile({ dataRoot: f.root }), second = backupStorageProfile({ dataRoot: f.root });
  assert.equal(path.dirname(first), path.join(f.base, 'asMagicBrain-recovery-backups'));
  assert.notEqual(first, second);
  assert.equal(fs.existsSync(path.join(first, 'receipt.json')), true);
  assert.equal(fs.existsSync(path.join(second, 'receipt.json')), true);
  failed(() => backupStorageProfile({ dataRoot: f.root, backupRoot: path.join(f.root, 'backup') }));
  assert.equal(fs.existsSync(path.join(f.root, 'backup')), false);
});

test('links, hardlinks, unsafe state and unowned lock are rejected with partial output retained', () => {
  const changes = [
    f => fs.symlinkSync(path.join(f.root, 'state/native/draft.json'), path.join(f.root, 'link')),
    f => fs.linkSync(path.join(f.root, 'state/native/draft.json'), path.join(f.root, 'hardlink')),
    f => fs.chmodSync(path.join(f.root, 'state'), 0o755),
    f => fs.chmodSync(path.join(f.root, 'state/native/draft.json'), 0o666),
    f => fs.writeFileSync(path.join(f.root, '.asmb-native.lock'), JSON.stringify({ pid: process.pid + 1, token: randomUUID() })),
  ];
  for (const change of changes) {
    const f = fixture(); change(f); const before = snapshot(f.root);
    const error = failed(() => backupStorageProfile({ dataRoot: f.root, backupRoot: f.backupRoot }));
    assert.ok(error.backupPath); assert.equal(fs.existsSync(error.backupPath), true);
    assert.equal(fs.existsSync(path.join(error.backupPath, 'receipt.json')), false);
    assert.deepEqual(snapshot(f.root), before);
  }
  const f = fixture(), linked = path.join(f.base, 'linked backup'); fs.symlinkSync(f.root, linked);
  failed(() => backupStorageProfile({ dataRoot: f.root, backupRoot: linked }));
});

test('cross-device files are rejected before a completion receipt', t => {
  const f = fixture(), original = fs.lstatSync, target = path.join(f.root, 'state/native/draft.json');
  t.mock.method(fs, 'lstatSync', (filename, options) => {
    const stat = original(filename, options);
    if (filename !== target) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: typeof stat.dev === 'bigint' ? stat.dev + 1n : stat.dev + 1 });
  });
  const error = failed(() => backupStorageProfile({ dataRoot: f.root, backupRoot: f.backupRoot }));
  assert.equal(fs.existsSync(path.join(error.backupPath, 'receipt.json')), false);
});

test('copied-byte corruption is detected and source bytes remain unchanged', t => {
  const f = fixture(), before = snapshot(f.root), original = fs.writeSync;
  let changed = false;
  t.mock.method(fs, 'writeSync', (fd, buffer, offset, length, position) => {
    if (changed || !length) return original(fd, buffer, offset, length, position);
    changed = true; const corrupted = Buffer.from(buffer); corrupted[offset] ^= 1;
    return original(fd, corrupted, offset, length, position);
  });
  const error = failed(() => backupStorageProfile({ dataRoot: f.root, backupRoot: f.backupRoot }));
  assert.equal(fs.existsSync(error.backupPath), true);
  assert.equal(fs.existsSync(path.join(error.backupPath, 'receipt.json')), false);
  assert.deepEqual(snapshot(f.root), before);
});

test('a source change during copying and a destination fsync failure both retain failed output', t => {
  const f = fixture(), original = fs.writeSync;
  let changed = false;
  const mock = t.mock.method(fs, 'writeSync', (fd, buffer, offset, length, position) => {
    const result = original(fd, buffer, offset, length, position);
    if (!changed) { changed = true; fs.writeFileSync(path.join(f.root, 'state/native/draft.json'), 'external change'); }
    return result;
  });
  const error = failed(() => backupStorageProfile({ dataRoot: f.root, backupRoot: f.backupRoot }));
  assert.equal(fs.existsSync(path.join(error.backupPath, 'receipt.json')), false);
  mock.mock.restore();
  const second = fixture();
  fs.mkdirSync(second.backupRoot, { mode: 0o700 });
  const sync = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', fd => {
    if (fs.fstatSync(fd).isFile()) throw Object.assign(new Error('injected'), { code: 'EIO' });
    return sync(fd);
  });
  const stopped = failed(() => backupStorageProfile({ dataRoot: second.root, backupRoot: second.backupRoot }));
  assert.equal(fs.existsSync(stopped.backupPath), true);
  assert.equal(fs.existsSync(path.join(stopped.backupPath, 'receipt.json')), false);
});

test('volume probe uses argument arrays, the filesystem UUID, and rejects unavailable or malformed output', t => {
  const f = fixture(), originalPlatform = process.platform, uuid = '01234567-89AB-CDEF-0123-456789ABCDEF';
  let output = uuid, calls = [];
  t.mock.method(childProcess, 'spawnSync', (executable, args, options) => {
    calls.push({ executable, args, options });
    assert.equal(options.shell, false);
    assert.equal(Object.hasOwn(options.env, 'HOME'), false);
    if (executable === '/bin/df') return { status: 0, stdout: `Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk9s2 100 20 80 20% /a mount\n` };
    if (executable === '/usr/sbin/diskutil') return { status: 0, stdout: '<plist>fixture</plist>' };
    return { status: 0, stdout: output + '\n' };
  });
  try {
    for (const platform of ['darwin', 'linux']) {
      Object.defineProperty(process, 'platform', { value: platform }); calls = [];
      assert.equal(probeStorageVolume(f.root), uuid.toLowerCase());
      assert.ok(calls.some(call => call.args.includes(f.root)));
      if (platform === 'darwin') assert.deepEqual(calls.at(-1).args, ['-extract', 'VolumeUUID', 'raw', '-o', '-', '-']);
      else assert.deepEqual(calls[0].args, ['--noheadings', '--raw', '--output', 'UUID', '--target', f.root]);
      for (output of ['', 'disk9s2', uuid + '\n' + uuid, '/private/path', 'UUID=$(ignored)']) {
        assert.throws(() => probeStorageVolume(f.root), { code: 'STORAGE_VOLUME_UNAVAILABLE' });
      }
      output = uuid;
    }
  } finally { Object.defineProperty(process, 'platform', { value: originalPlatform }); }
});
