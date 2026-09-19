import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createLinuxRuntimeTemporaryDirectory, maximumLinuxTemporaryPathBytes} from './linux-runtime-temp.mjs';

function fixture(t) {
  const temporary = fs.realpathSync(os.tmpdir());
  assert.ok(temporary.includes('/asMagicBrain-Test/'), 'Filesystem fixtures require TMPDIR inside asMagicBrain-Test.');
  const root = fs.mkdtempSync(path.join(temporary, 'linux-runtime-temp-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const runtimeRoot = path.join(root, 'runtime'), fallback = path.join(root, 'fallback');
  fs.mkdirSync(runtimeRoot, {mode: 0o700}); fs.mkdirSync(fallback, {mode: 0o1777}); fs.chmodSync(fallback, 0o1777);
  const physical = value => value === '/tmp' || value.startsWith('/tmp/') ? fallback + value.slice(4)
    : value === '/qa' || value.startsWith('/qa/') ? runtimeRoot + value.slice(3) : value;
  const virtual = value => value === fallback || value.startsWith(fallback + '/') ? '/tmp' + value.slice(fallback.length)
    : value === runtimeRoot || value.startsWith(runtimeRoot + '/') ? '/qa' + value.slice(runtimeRoot.length) : value;
  // Keep real files, modes, links, inodes and cleanup under Test. Only spellings
  // are shortened; the isolated fallback parent's UID models root-owned /tmp.
  const filesystem = {...fs,
    lstatSync: (value, options) => {
      const stat = fs.lstatSync(physical(value), options);
      if (stat && value === '/tmp') return Object.assign(Object.create(stat), {uid: 0});
      return stat;
    },
    realpathSync: value => virtual(fs.realpathSync(physical(value))),
    mkdtempSync: value => virtual(fs.mkdtempSync(physical(value))),
    openSync: (value, flags) => fs.openSync(physical(value), flags),
    rmSync: (value, options) => fs.rmSync(physical(value), options),
  };
  const parent = '/qa/user'; fs.mkdirSync(physical(parent), {mode: 0o700});
  const create = options => createLinuxRuntimeTemporaryDirectory({runtimeDirectory: parent, uid: process.getuid(), filesystem, ...options});
  return {root, parent, physical, filesystem, create};
}

test('Linux runtime uses a fresh private short directory and cleans only its own temporary contents', t => {
  const f = fixture(t), first = f.create(), second = f.create();
  assert.notEqual(first.directory, second.directory);
  assert.ok(first.directory.startsWith('/qa/user/asmb-'));
  assert.ok(Buffer.byteLength(first.directory) <= maximumLinuxTemporaryPathBytes);
  assert.ok(Buffer.byteLength(first.directory + '/scoped_dir89Z5WN/SingletonSocket') < 108);
  const stat = fs.lstatSync(f.physical(first.directory));
  assert.equal(stat.uid, process.getuid()); assert.equal(stat.mode & 0o7777, 0o700);
  fs.mkdirSync(path.join(f.physical(first.directory), 'scoped_dir')); fs.writeFileSync(path.join(f.physical(first.directory), 'scoped_dir/socket-fixture'), 'ephemeral');
  const preserved = path.join(f.root, 'saved.md'); fs.writeFileSync(preserved, 'preserved original');
  fs.symlinkSync(preserved, path.join(f.physical(first.directory), 'external-link'));
  assert.equal(first.cleanup(), true); assert.equal(first.cleanup(), false);
  assert.equal(fs.existsSync(f.physical(first.directory)), false);
  assert.equal(fs.readFileSync(preserved, 'utf8'), 'preserved original');
  assert.equal(fs.existsSync(f.physical(second.directory)), true, 'Never prune other launches.');
});

test('absent XDG uses only the physical root-owned sticky /tmp fallback', t => {
  const f = fixture(t), created = f.create({runtimeDirectory: ''});
  assert.ok(created.directory.startsWith('/tmp/asmb-'));
  assert.equal(fs.lstatSync(f.physical(created.directory)).mode & 0o7777, 0o700);
  assert.equal(created.cleanup(), true);
  fs.chmodSync(f.physical('/tmp'), 0o777);
  assert.throws(() => f.create({runtimeDirectory: ''}), {code: 'ASMB_RUNTIME_TEMP'});
  fs.chmodSync(f.physical('/tmp'), 0o1777);
  const foreign = {...f.filesystem, lstatSync: (filename, options) => {
    const stat = f.filesystem.lstatSync(filename, options);
    return filename === '/tmp' ? Object.assign(Object.create(stat), {uid: process.getuid() || 1}) : stat;
  }};
  assert.throws(() => f.create({runtimeDirectory: '', filesystem: foreign}), {code: 'ASMB_RUNTIME_TEMP'});
});

test('unsafe, linked, foreign and non-directory XDG parents are refused without fallback writes', t => {
  const f = fixture(t);
  for (const runtimeDirectory of ['relative', '/qa/user/../user', '/qa/user/', '/qa/invalid\0path']) assert.throws(() => f.create({runtimeDirectory}), {code: 'ASMB_RUNTIME_TEMP'});
  fs.chmodSync(f.physical(f.parent), 0o755); assert.throws(() => f.create(), {code: 'ASMB_RUNTIME_TEMP'});
  fs.chmodSync(f.physical(f.parent), 0o700); assert.throws(() => f.create({uid: process.getuid() + 1}), {code: 'ASMB_RUNTIME_TEMP'});
  fs.symlinkSync(f.physical(f.parent), f.physical('/qa/linked'));
  assert.throws(() => f.create({runtimeDirectory: '/qa/linked'}), {code: 'ASMB_RUNTIME_TEMP'});
  fs.mkdirSync(path.join(f.physical(f.parent), 'nested'), {mode: 0o700});
  assert.throws(() => f.create({runtimeDirectory: '/qa/linked/nested'}), {code: 'ASMB_RUNTIME_TEMP'});
  fs.writeFileSync(f.physical('/qa/file'), 'original');
  assert.throws(() => f.create({runtimeDirectory: '/qa/file'}), {code: 'ASMB_RUNTIME_TEMP'});
  assert.deepEqual(fs.readdirSync(f.physical('/tmp')), []);
  assert.equal(fs.readFileSync(f.physical('/qa/file'), 'utf8'), 'original');
});

test('temporary socket budgeting uses UTF-8 bytes and refuses long parents before allocation', t => {
  const f = fixture(t);
  for (const name of ['x'.repeat(60), 'Ω'.repeat(26)]) {
    const parent = '/qa/' + name; fs.mkdirSync(f.physical(parent), {mode: 0o700});
    assert.throws(() => f.create({runtimeDirectory: parent}), {code: 'ASMB_RUNTIME_TEMP'});
    assert.deepEqual(fs.readdirSync(f.physical(parent)), []);
  }
  const boundary = '/qa/' + 'x'.repeat(maximumLinuxTemporaryPathBytes - 4 - 12);
  fs.mkdirSync(f.physical(boundary), {mode: 0o700});
  const created = f.create({runtimeDirectory: boundary});
  assert.equal(Buffer.byteLength(created.directory), maximumLinuxTemporaryPathBytes);
  assert.equal(created.cleanup(), true);
});

test('cleanup refuses a replaced directory or symlink and never removes foreign data', t => {
  const f = fixture(t);
  for (const replacement of ['directory', 'symlink']) {
    const created = f.create(), allocated = f.physical(created.directory), retained = allocated + '-retained';
    fs.writeFileSync(path.join(allocated, 'original'), 'owned ephemeral'); fs.renameSync(allocated, retained);
    const target = path.join(f.root, 'foreign-' + replacement); fs.mkdirSync(target, {mode: 0o700}); fs.writeFileSync(path.join(target, 'saved'), 'foreign saved data');
    if (replacement === 'directory') {fs.mkdirSync(allocated, {mode: 0o700}); fs.writeFileSync(path.join(allocated, 'saved'), 'replacement saved data');}
    else fs.symlinkSync(target, allocated);
    assert.equal(created.cleanup(), false);
    assert.equal(fs.readFileSync(path.join(target, 'saved'), 'utf8'), 'foreign saved data');
    assert.equal(fs.readFileSync(path.join(retained, 'original'), 'utf8'), 'owned ephemeral');
    assert.ok(fs.lstatSync(allocated));
  }
});

test('a directory substituted after private-mode setup is refused and never adopted for cleanup', t => {
  const f = fixture(t); let allocated;
  const filesystem = {...f.filesystem,
    mkdtempSync: prefix => {allocated = f.filesystem.mkdtempSync(prefix); return allocated;},
    closeSync: fd => {
      fs.closeSync(fd);
      fs.renameSync(f.physical(allocated), f.physical(allocated + '-retained'));
      fs.mkdirSync(f.physical(allocated), {mode: 0o700});
      fs.writeFileSync(path.join(f.physical(allocated), 'foreign'), 'preserve replacement');
    },
  };
  assert.throws(() => f.create({filesystem}), {code: 'ASMB_RUNTIME_TEMP'});
  assert.equal(fs.readFileSync(path.join(f.physical(allocated), 'foreign'), 'utf8'), 'preserve replacement');
  assert.ok(fs.existsSync(f.physical(allocated + '-retained')));
});

test('cleanup refuses changed parent identity and preserves crash leftovers', t => {
  const f = fixture(t), created = f.create(), name = path.basename(created.directory);
  fs.renameSync(f.physical(f.parent), f.physical('/qa/previous-parent'));
  fs.mkdirSync(f.physical(f.parent), {mode: 0o700});
  fs.mkdirSync(path.join(f.physical(f.parent), name), {mode: 0o700});
  assert.equal(created.cleanup(), false);
  assert.ok(fs.existsSync(path.join(f.physical('/qa/previous-parent'), name)));
  const next = f.create();
  assert.ok(fs.existsSync(path.join(f.physical(f.parent), name)), 'A new launch never prunes older directories.');
  assert.equal(next.cleanup(), true);
});
