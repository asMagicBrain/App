import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const fail = (code = 'STORAGE_BACKUP_FAILED') => { throw Object.assign(new Error(code), { code }); };
const uid = () => typeof process.getuid === 'function' ? process.getuid() : null;
const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const stamp = stat => [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const sameRoot = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

function canonical(filename) {
  if (typeof filename !== 'string' || !filename.isWellFormed() || filename.includes('\0')
    || filename.length > 4096 || !path.isAbsolute(filename) || path.normalize(filename) !== filename
    || filename.endsWith(path.sep)) fail();
  return filename;
}
function pin(filename) {
  canonical(filename);
  let current = path.parse(filename).root;
  const chain = [];
  for (const part of ['', ...filename.slice(current.length).split(path.sep)]) {
    if (part) current = path.join(current, part);
    const stat = fs.lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    chain.push({ path: current, stat });
  }
  if (fs.realpathSync(filename) !== filename) fail();
  return { path: filename, stat: chain.at(-1).stat, chain };
}
function check(pinned) {
  for (const entry of pinned.chain) {
    const stat = fs.lstatSync(entry.path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameRoot(stat, entry.stat)) fail();
  }
}
function syncDirectory(directory) {
  const pinned = pin(directory), fd = fs.openSync(directory, flags | fs.constants.O_DIRECTORY);
  try {
    if (!sameRoot(fs.fstatSync(fd, { bigint: true }), pinned.stat)) fail();
    fs.fsyncSync(fd); check(pinned);
  } finally { fs.closeSync(fd); }
}
function privateDirectory(pinned) {
  if ((pinned.stat.mode & 0o7777n) !== 0o700n || uid() === null || pinned.stat.uid !== BigInt(uid())) fail();
}
function command(executable, args, input) {
  const result = childProcess.spawnSync(executable, args, { shell: false, encoding: 'utf8', timeout: 10000,
    maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
    ...(input === undefined ? {} : { input }) });
  if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== 'string') fail('STORAGE_VOLUME_UNAVAILABLE');
  return result.stdout;
}

/** Return a filesystem UUID. Device numbers, mount paths and container IDs are
 * never substituted when the platform cannot provide a volume identifier. */
export function probeStorageVolume(dataRoot) {
  let root;
  try { root = pin(dataRoot); } catch { fail('STORAGE_VOLUME_UNAVAILABLE'); }
  let value;
  if (process.platform === 'darwin') {
    const lines = command('/bin/df', ['-P', root.path]).trim().split('\n');
    const device = lines.length === 2 ? lines[1].trim().split(/\s+/u)[0] : '';
    if (!/^\/dev\/disk[0-9]+(?:s[0-9]+)*$/u.test(device)) fail('STORAGE_VOLUME_UNAVAILABLE');
    const plist = command('/usr/sbin/diskutil', ['info', '-plist', device]);
    value = command('/usr/bin/plutil', ['-extract', 'VolumeUUID', 'raw', '-o', '-', '-'], plist).trim().toLowerCase();
  } else if (process.platform === 'linux') {
    value = command('/usr/bin/findmnt', ['--noheadings', '--raw', '--output', 'UUID', '--target', root.path]).trim().toLowerCase();
  } else fail('STORAGE_VOLUME_UNAVAILABLE');
  if (!uuidPattern.test(value)) fail('STORAGE_VOLUME_UNAVAILABLE');
  try { check(root); } catch { fail('STORAGE_VOLUME_UNAVAILABLE'); }
  return value;
}

function admit(stat, relative, root) {
  if (stat.dev !== root.stat.dev || stat.uid !== root.stat.uid || stat.isSymbolicLink()
    || (!stat.isDirectory() && !stat.isFile()) || (stat.mode & 0o7000n) !== 0n
    || (stat.isFile() && (stat.nlink !== 1n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)))) fail();
  if (relative === 'state' || relative === 'state/native') {
    if (!stat.isDirectory() || (stat.mode & 0o777n) !== 0o700n) fail();
  }
  if ((relative === 'state' || relative.startsWith('state/')) && (stat.mode & 0o022n) !== 0n) fail();
}
function inventory(root, excludeLock = true) {
  const rows = [];
  function walk(directory, relative, depth) {
    if (depth > 128 || rows.length >= 200000) fail();
    check(root);
    const stat = fs.lstatSync(directory, { bigint: true });
    admit(stat, relative, root);
    rows.push({ path: relative, type: stat.isDirectory() ? 'directory' : 'file', stat, stamp: stamp(stat) });
    if (stat.isDirectory()) {
      const before = stamp(stat), names = fs.readdirSync(directory).sort();
      for (const name of names) {
        if (!name.isWellFormed()) fail();
        const filename = path.join(directory, name), child = relative ? `${relative}/${name}` : name;
        if (excludeLock && child === '.asmb-native.lock') {
          const lock = fs.lstatSync(filename, { bigint: true });
          admit(lock, child, root);
          if (!lock.isFile() || (lock.mode & 0o777n) !== 0o600n || lock.size > 16384n) fail();
          const chunks = [];
          const hashed = streamFile(filename, { stamp: stamp(lock) }, chunk => chunks.push(Buffer.from(chunk)));
          let value;
          try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(); }
          if (!value || Object.keys(value).length !== 2 || value.pid !== process.pid
            || typeof value.token !== 'string' || !/^[a-f0-9-]{36}$/u.test(value.token)) fail();
          Object.defineProperty(rows, 'excludedLock', { value: { stamp: stamp(lock), sha256: hashed.sha256 } });
          continue;
        }
        walk(filename, child, depth + 1);
      }
      if (stamp(fs.lstatSync(directory, { bigint: true })) !== before) fail();
    }
  }
  walk(root.path, '', 0);
  check(root);
  return rows;
}
function parentCheck(root, relative, rowsByPath) {
  check(root);
  let current = path.posix.dirname(relative);
  for (;;) {
    const key = current === '.' ? '' : current, expected = rowsByPath.get(key);
    const stat = fs.lstatSync(key ? path.join(root.path, key) : root.path, { bigint: true });
    if (!expected || !stat.isDirectory() || stat.isSymbolicLink() || stamp(stat) !== expected.stamp) fail();
    if (!key) break;
    current = path.posix.dirname(key);
  }
}
function streamFile(filename, expected, onChunk) {
  const fd = fs.openSync(filename, flags), hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  let size = 0;
  try {
    const initial = fs.fstatSync(fd, { bigint: true });
    if (!initial.isFile() || initial.nlink !== 1n || stamp(initial) !== expected.stamp) fail();
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, size);
      if (!count) break;
      size += count;
      if (BigInt(size) > initial.size) fail();
      const chunk = buffer.subarray(0, count); hash.update(chunk); onChunk?.(chunk);
    }
    if (BigInt(size) !== initial.size || stamp(fs.fstatSync(fd, { bigint: true })) !== expected.stamp
      || stamp(fs.lstatSync(filename, { bigint: true })) !== expected.stamp) fail();
    return { sha256: hash.digest('hex'), size };
  } finally { fs.closeSync(fd); }
}
function metadata(row) {
  return { path: row.path, type: row.type, mode: Number(row.stat.mode & 0o777n), uid: Number(row.stat.uid),
    gid: Number(row.stat.gid),
    device: row.stat.dev.toString(), inode: row.stat.ino.toString(), size: row.stat.size.toString(),
    mtimeNs: row.stat.mtimeNs.toString(), ctimeNs: row.stat.ctimeNs.toString() };
}

/** Caller holds the managed profile lock. Read only the source, retain every
 * partial destination, and publish a receipt only after independent rereads. */
export function backupStorageProfile({ dataRoot, backupRoot } = {}) {
  let backupPath;
  try {
    const source = pin(dataRoot); privateDirectory(source);
    const parentPath = canonical(backupRoot ?? path.join(path.dirname(dataRoot), 'asMagicBrain-recovery-backups'));
    if (inside(source.path, parentPath) || inside(parentPath, source.path)) fail();
    let parent;
    try { parent = pin(parentPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const outer = pin(path.dirname(parentPath)); check(outer);
      fs.mkdirSync(parentPath, { mode: 0o700 }); syncDirectory(outer.path);
      parent = pin(parentPath);
    }
    privateDirectory(parent); check(source);
    backupPath = path.join(parent.path, `profile-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`);
    check(parent); fs.mkdirSync(backupPath, { mode: 0o700 }); syncDirectory(parent.path);
    const destination = pin(backupPath), copyRoot = path.join(backupPath, 'managed-data');
    fs.mkdirSync(copyRoot, { mode: 0o700 });
    const targetDirectories = new Map([['', pin(copyRoot)]]);
    const rows = inventory(source), byPath = new Map(rows.map(row => [row.path, row])), manifest = [];
    for (const row of rows) {
      const target = row.path ? path.join(copyRoot, row.path) : copyRoot;
      check(destination);
      if (!row.path) { manifest.push(metadata(row)); continue; }
      parentCheck(source, row.path, byPath);
      const parentName = path.posix.dirname(row.path), targetParent = targetDirectories.get(parentName === '.' ? '' : parentName);
      if (!targetParent) fail();
      check(targetParent);
      if (row.type === 'directory') {
        fs.mkdirSync(target, { mode: 0o700 }); check(targetParent);
        targetDirectories.set(row.path, pin(target)); manifest.push(metadata(row));
      } else {
        const output = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        let hashed;
        try {
          hashed = streamFile(path.join(source.path, row.path), row, chunk => {
            let offset = 0;
            while (offset < chunk.length) {
              const count = fs.writeSync(output, chunk, offset, chunk.length - offset);
              if (!count) fail();
              offset += count;
            }
          });
          fs.fchmodSync(output, Number(row.stat.mode & 0o777n)); fs.fsyncSync(output);
        } finally { fs.closeSync(output); }
        check(targetParent);
        const copied = fs.lstatSync(target, { bigint: true });
        const verified = streamFile(target, { stamp: stamp(copied) });
        if (verified.sha256 !== hashed.sha256 || verified.size !== hashed.size) fail();
        manifest.push({ ...metadata(row), ...hashed });
      }
    }
    // A second complete inventory and source hash pass detects changes even to
    // files copied early in the run. Reads never fsync or rewrite source files.
    const after = inventory(source);
    if (after.length !== rows.length || JSON.stringify(after.excludedLock) !== JSON.stringify(rows.excludedLock)
      || after.some((row, index) => row.path !== rows[index].path || row.stamp !== rows[index].stamp)) fail();
    const manifestByPath = new Map(manifest.map(row => [row.path, row]));
    for (const row of rows.filter(value => value.type === 'file')) {
      parentCheck(source, row.path, byPath);
      const actual = streamFile(path.join(source.path, row.path), row), recorded = manifestByPath.get(row.path);
      if (actual.sha256 !== recorded.sha256 || actual.size !== recorded.size) fail();
    }
    const final = inventory(source);
    if (final.length !== rows.length || JSON.stringify(final.excludedLock) !== JSON.stringify(rows.excludedLock)
      || final.some((row, index) => row.path !== rows[index].path || row.stamp !== rows[index].stamp)) fail();
    for (const row of rows.filter(value => value.type === 'directory').reverse()) {
      check(destination);
      const target = row.path ? path.join(copyRoot, row.path) : copyRoot;
      fs.chmodSync(target, Number(row.stat.mode & 0o777n)); syncDirectory(target);
    }
    const copiedRoot = pin(copyRoot), copiedRows = inventory(copiedRoot, false);
    if (copiedRows.length !== rows.length) fail();
    const copiedByPath = new Map(copiedRows.map(row => [row.path, row]));
    for (const copied of copiedRows) {
      const expected = manifestByPath.get(copied.path);
      if (!expected || copied.type !== expected.type || Number(copied.stat.mode & 0o777n) !== expected.mode
        || Number(copied.stat.uid) !== expected.uid) fail();
      if (copied.type === 'file') {
        parentCheck(copiedRoot, copied.path, copiedByPath);
        const actual = streamFile(path.join(copyRoot, copied.path), copied);
        if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) fail();
      }
    }
    const receipt = Buffer.from(JSON.stringify({ schemaVersion: 1, status: 'verified', excluded: ['.asmb-native.lock'],
      files: manifest, fileCount: rows.filter(row => row.type === 'file').length }, null, 2) + '\n');
    check(destination);
    const output = fs.openSync(path.join(backupPath, 'receipt.json'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(output, receipt); fs.fsyncSync(output); } finally { fs.closeSync(output); }
    syncDirectory(backupPath); syncDirectory(parent.path); check(source);
    return backupPath;
  } catch (error) {
    throw Object.assign(new Error('STORAGE_BACKUP_FAILED'), { code: 'STORAGE_BACKUP_FAILED', ...(backupPath ? { backupPath } : {}), cause: error });
  }
}
