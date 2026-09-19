import {persistentIdentity} from '../../source-foundation/src/adapters/storage-identity.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pinDirectory, checkDirectory } from './physical-roots.mjs';

export const PRIVATE_LIMITS = Object.freeze({ records: 256, recordBytes: 4 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 });
export const privateHash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function assertOutsideGit(root) {
  let current = root;
  while (true) {
    try { fs.lstatSync(path.join(current, '.git')); fail('DENIED'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}

/** Append-only transaction tail with an atomically published healthy-state checkpoint.
 * A torn exclusive record is intentionally retained and quarantines the store.
 * There is no mutable head to roll back, overwrite, or resurrect after discard.
 */
export function createPrivateStore({ privateRoot, bindingHash, hooks = {} }) {
  const root = pinDirectory(privateRoot);
  let durable = null;
  const checkpointName = 'checkpoint.json';
  const stagingName = '.checkpoint-staging';
  function staging() {
    check(); const filename = path.join(root.path, stagingName);
    try { fs.mkdirSync(filename, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(filename);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== root.dev
      || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) fail('RECOVERY_REQUIRED');
    return pinDirectory(filename);
  }
  function check() {
    checkDirectory(root); assertOutsideGit(root.path);
    const stat = fs.lstatSync(root.path);
    if ((stat.mode & 0o777) !== 0o700 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('DENIED');
  }
  check();
  function read(name, flushExpected = null) {
    check(); const filename = path.join(root.path, name);
    const fd = fs.openSync(filename, (flushExpected ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | fs.constants.O_NOFOLLOW);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600
        || before.size > (name === checkpointName ? PRIVATE_LIMITS.totalBytes : PRIVATE_LIMITS.recordBytes)
        || (typeof process.getuid === 'function' && before.uid !== process.getuid())) fail('RECOVERY_REQUIRED');
      const buffer = Buffer.alloc(before.size + 1); let count = 0;
      while (count < buffer.length) {
        const readBytes = fs.readSync(fd, buffer, count, buffer.length - count, count);
        if (!readBytes) break; count += readBytes;
      }
      const bytes = buffer.subarray(0, count);
      const observed = { name, identity: persistentIdentity(before), bytes: bytes.length, hash: privateHash(bytes) };
      if (flushExpected) {
        if (JSON.stringify(observed) !== JSON.stringify(flushExpected)) fail('RECOVERY_REQUIRED');
        hooks.at?.('private-before-recovery-file-sync', { name }); fs.fsyncSync(fd);
        hooks.at?.('private-after-recovery-file-sync', { name });
      }
      const after = fs.fstatSync(fd), live = fs.lstatSync(filename);
      if (before.dev !== live.dev || before.ino !== live.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size) fail('RECOVERY_REQUIRED');
      check(); return { bytes, observed };
    } finally { fs.closeSync(fd); }
  }
  function scan() {
    const events = [], files = [], coveredFiles = [];
    let retainedFiles = 0, totalBytes = 0, previous = null, sequence = 0, tailRecords = 0;
    try {
      check(); const names = [], directory = fs.opendirSync(root.path);
      try {
        for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
          retainedFiles++;
          if (entry.name === stagingName) {
            const stat = fs.lstatSync(path.join(root.path, stagingName));
            if (!entry.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
              || (stat.mode & 0o777) !== 0o700 || stat.dev !== root.dev) fail('RECOVERY_REQUIRED');
            // Unpublished derived checkpoints are not authority. Retain them,
            // even torn ones, without blocking the intact acknowledged tail.
            continue;
          }
          if (names.length >= PRIVATE_LIMITS.records * 2 + 1 || !entry.isFile()
            || (entry.name !== checkpointName && !/^\d{16}\.json$/.test(entry.name))) fail('RECOVERY_REQUIRED');
          names.push(entry.name);
        }
      } finally { directory.closeSync(); }
      names.sort();
      let covered = new Map();
      if (names.includes(checkpointName)) {
        const { bytes, observed } = read(checkpointName);
        const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!exact(record, ['body', 'checksum']) || !exact(record.body, ['schemaVersion', 'sequence', 'bindingHash', 'previous', 'type', 'payload'])
          || ![2,3].includes(record.body.schemaVersion) || record.body.bindingHash !== bindingHash || record.body.type !== 'checkpoint'
          || !Number.isSafeInteger(record.body.sequence) || record.body.sequence < 1
          || !/^[a-f0-9]{64}$/.test(record.body.previous)
          || !exact(record.body.payload, ['state', 'covered']) || !Array.isArray(record.body.payload.covered)
          || record.body.payload.covered.length > PRIVATE_LIMITS.records
          || record.checksum !== privateHash(JSON.stringify(record.body))) fail('RECOVERY_REQUIRED');
        for (const item of record.body.payload.covered) {
          if (!exact(item, ['name', 'identity', 'bytes', 'hash']) || !/^\d{16}\.json$/.test(item.name)
            || Number(item.name.slice(0, 16)) > record.body.sequence || covered.has(item.name)
            || !/^\d+:\d+$/.test(item.identity) || !Number.isSafeInteger(item.bytes) || item.bytes < 1
            || !/^[a-f0-9]{64}$/.test(item.hash)) fail('RECOVERY_REQUIRED');
          covered.set(item.name, item);
        }
        sequence = record.body.sequence; previous = record.checksum; totalBytes += bytes.length;
        events.push({ ...record.body, payload: record.body.payload.state }); files.push(observed);
      }
      for (const name of names.filter(name => name !== checkpointName)) {
        if (covered.has(name)) {
          const { observed } = read(name);
          if (JSON.stringify(observed) !== JSON.stringify(covered.get(name))) fail('RECOVERY_REQUIRED');
          coveredFiles.push(observed); continue;
        }
        if (++tailRecords > PRIVATE_LIMITS.records || name !== String(sequence + 1).padStart(16, '0') + '.json') fail('RECOVERY_REQUIRED');
        const { bytes, observed } = read(name); totalBytes += bytes.length;
        if (totalBytes > PRIVATE_LIMITS.totalBytes) fail('RECOVERY_REQUIRED');
        const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!exact(record, ['body', 'checksum']) || !exact(record.body, ['schemaVersion', 'sequence', 'bindingHash', 'previous', 'type', 'payload'])
          || (record.body.schemaVersion === 3 ? !['file-intent','file-terminal'].includes(record.body.type)
            : record.body.schemaVersion !== 1 || !['draft', 'intent', 'terminal'].includes(record.body.type))
          || record.body.sequence !== sequence + 1 || record.body.bindingHash !== bindingHash || record.body.previous !== previous
          || record.checksum !== privateHash(JSON.stringify(record.body))) fail('RECOVERY_REQUIRED');
        sequence++; previous = record.checksum; events.push(record.body); files.push(observed);
      }
      return { blocked: false, events, files, coveredFiles, totalBytes, previous, sequence, tailRecords, retainedFiles };
    } catch { return { blocked: true, events, files, coveredFiles, totalBytes, previous, sequence, tailRecords, retainedFiles }; }
  }
  function ensureDurable(snapshot) {
    let directory;
    try {
      const live = scan();
      if (snapshot.blocked || live.blocked || live.previous !== snapshot.previous
        || JSON.stringify(live.files) !== JSON.stringify(snapshot.files)) fail('RECOVERY_REQUIRED');
      if (!live.files.length) return live; // Empty no-op has no state to flush.
      // Reopened/uncertain records still receive the complete durability barrier.
      // Within this instance only an unchanged, byte-verified durable prefix can skip it.
      if (durable === JSON.stringify(live.files)) return live;
      for (const file of live.files) read(file.name, file);
      check(); directory = fs.openSync(root.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      if (persistentIdentity(fs.fstatSync(directory)) !== root.identity) fail('RECOVERY_REQUIRED');
      hooks.at?.('private-before-recovery-directory-sync', {}); fs.fsyncSync(directory);
      hooks.at?.('private-after-recovery-directory-sync', {}); check();
      const after = scan();
      if (after.blocked || after.previous !== live.previous || JSON.stringify(after.files) !== JSON.stringify(live.files)) fail('RECOVERY_REQUIRED');
      durable = JSON.stringify(after.files);
      return after;
    } catch (error) { throw Object.assign(new Error('RECOVERY_REQUIRED'), { code: 'RECOVERY_REQUIRED', cause: error }); }
    finally { if (directory !== undefined) fs.closeSync(directory); }
  }
  function append(snapshot, type, payload) {
    const live = scan();
    if (snapshot.blocked || live.blocked || live.previous !== snapshot.previous || live.events.length !== snapshot.events.length) fail('RECOVERY_REQUIRED');
    const sequence = live.sequence + 1;
    const body = { schemaVersion: type.startsWith('file-') ? 3 : 1, sequence, bindingHash, previous: live.previous, type, payload };
    const bytes = Buffer.from(JSON.stringify({ body, checksum: privateHash(JSON.stringify(body)) }));
    if (!Number.isSafeInteger(sequence) || live.tailRecords >= PRIVATE_LIMITS.records || bytes.length > PRIVATE_LIMITS.recordBytes
      || live.totalBytes + bytes.length > PRIVATE_LIMITS.totalBytes) fail('LIMIT_EXCEEDED');
    // Every acknowledged state depends on its whole retained chain, not merely
    // the newest file. Structural validity after a prior flush failure is not
    // evidence that those older records were ever made durable.
    ensureDurable(live);
    const filename = path.join(root.path, String(sequence).padStart(16, '0') + '.json');
    let fd, directory;
    try {
      check(); hooks.at?.('private-before-create', { type, sequence });
      fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      hooks.at?.('private-after-create', { type, sequence });
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
      hooks.at?.('private-after-file-sync', { type, sequence });
      fs.closeSync(fd); fd = undefined;
      directory = fs.openSync(root.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      if (persistentIdentity(fs.fstatSync(directory)) !== root.identity) fail('RECOVERY_REQUIRED');
      fs.fsyncSync(directory); check();
      hooks.at?.('private-after-directory-sync', { type, sequence });
      const after = scan();
      if (!after.blocked) durable = JSON.stringify(after.files);
      return after;
    } catch (error) {
      // Do not remove/truncate a failed exclusive record, even if its content
      // might be complete. The caller retains/quarantines the ambiguous outcome.
      throw Object.assign(new Error('RECOVERY_REQUIRED'), { code: 'RECOVERY_REQUIRED', cause: error });
    } finally { if (fd !== undefined) fs.closeSync(fd); if (directory !== undefined) fs.closeSync(directory); }
  }
  function reserve(snapshot, records) {
    const live = scan();
    if (snapshot.blocked || live.blocked || snapshot.previous !== live.previous
      || JSON.stringify(snapshot.files) !== JSON.stringify(live.files)) fail('RECOVERY_REQUIRED');
    let sequence = live.sequence, previous = live.previous, bytes = live.totalBytes;
    if (!Array.isArray(records) || live.tailRecords + records.length > PRIVATE_LIMITS.records) fail('LIMIT_EXCEEDED');
    for (const { type, payload } of records) {
      const body = { schemaVersion: type.startsWith('file-') ? 3 : 1, sequence: ++sequence, bindingHash, previous, type, payload };
      if (!Number.isSafeInteger(sequence)) fail('LIMIT_EXCEEDED');
      previous = privateHash(JSON.stringify(body));
      const size = Buffer.byteLength(JSON.stringify({ body, checksum: previous }));
      if (size > PRIVATE_LIMITS.recordBytes) fail('LIMIT_EXCEEDED');
      bytes += size;
    }
    if (bytes > PRIVATE_LIMITS.totalBytes) fail('LIMIT_EXCEEDED');
    return live;
  }
  function compact(snapshot, state) {
    // The host must supply validated latest state with no unresolved intent.
    // No generic recovery, malformed-record deletion or old-generation rollback.
    let live = ensureDurable(snapshot);
    if (!live.sequence) fail('RECOVERY_REQUIRED');
    if (live.coveredFiles.length) {
      // Finish a previously durable checkpoint's interrupted retirement. Only
      // authenticated covered records are eligible; unrelated bytes remain.
      const directory = fs.openSync(root.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        if (persistentIdentity(fs.fstatSync(directory)) !== root.identity) fail('RECOVERY_REQUIRED');
        for (const file of live.coveredFiles) {
          const checkpoint = live.files.find(item => item.name === checkpointName);
          if (!checkpoint || JSON.stringify(read(checkpointName).observed) !== JSON.stringify(checkpoint)) fail('RECOVERY_REQUIRED');
          if (JSON.stringify(read(file.name).observed) !== JSON.stringify(file)) fail('RECOVERY_REQUIRED');
          check(); fs.unlinkSync(path.join(root.path, file.name));
        }
        fs.fsyncSync(directory); check();
      } finally { fs.closeSync(directory); }
      live = scan(); if (live.blocked) fail('RECOVERY_REQUIRED');
    }
    const covered = live.files.filter(file => file.name !== checkpointName);
    const body = { schemaVersion: Object.hasOwn(state, 'fileRequests') ? 3 : 2, sequence: live.sequence, bindingHash, previous: live.previous,
      type: 'checkpoint', payload: { state, covered } };
    const bytes = Buffer.from(JSON.stringify({ body, checksum: privateHash(JSON.stringify(body)) }));
    if (bytes.length > PRIVATE_LIMITS.totalBytes / 2) fail('LIMIT_EXCEEDED');
    const staged = staging();
    const temporary = path.join(staged.path, randomUUID() + '.json'), destination = path.join(root.path, checkpointName);
    let fd, directory, created;
    const verifyCreated = filename => {
      check(); checkDirectory(staged);
      const handle = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const before = fs.fstatSync(handle, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid())
          || (before.mode & 0o777n) !== 0o600n || before.dev !== created.dev || before.ino !== created.ino
          || before.size !== BigInt(bytes.length) || !fs.readFileSync(handle).equals(bytes)) fail('RECOVERY_REQUIRED');
        const after = fs.fstatSync(handle, { bigint: true }), current = fs.lstatSync(filename, { bigint: true });
        if (!['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key] && after[key] === current[key])) fail('RECOVERY_REQUIRED');
      } finally { fs.closeSync(handle); }
    };
    try {
      check(); fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); created = fs.fstatSync(fd, { bigint: true }); fs.closeSync(fd); fd = undefined;
      hooks.at?.('private-before-checkpoint-publish', {});
      // Our temporary is deliberately not consumed by scan. Revalidate all admitted old bytes instead.
      for (const file of live.files) if (JSON.stringify(read(file.name).observed) !== JSON.stringify(file)) fail('RECOVERY_REQUIRED');
      verifyCreated(temporary); check(); checkDirectory(staged); fs.renameSync(temporary, destination);
      hooks.at?.('private-after-checkpoint-rename', {});
      verifyCreated(destination);
      directory = fs.openSync(root.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      if (persistentIdentity(fs.fstatSync(directory)) !== root.identity) fail('RECOVERY_REQUIRED');
      fs.fsyncSync(directory);
      const stagingFd = fs.openSync(staged.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try { if (persistentIdentity(fs.fstatSync(stagingFd)) !== staged.identity) fail('RECOVERY_REQUIRED'); fs.fsyncSync(stagingFd); }
      finally { fs.closeSync(stagingFd); }
      check(); hooks.at?.('private-after-checkpoint-publish', {});
      verifyCreated(destination);
      // Only exact, healthy records covered by the now-durable checkpoint retire.
      // A crash here leaves a readable checkpoint plus verified covered records.
      for (const file of covered) {
        verifyCreated(destination);
        if (JSON.stringify(read(file.name).observed) !== JSON.stringify(file)) fail('RECOVERY_REQUIRED');
        check(); fs.unlinkSync(path.join(root.path, file.name));
        hooks.at?.('private-after-covered-retirement', { name: file.name });
      }
      fs.fsyncSync(directory); durable = null;
      const after = scan(); if (after.blocked) fail('RECOVERY_REQUIRED');
      durable = JSON.stringify(after.files); return after;
    } catch (error) { durable = null; throw Object.assign(new Error('RECOVERY_REQUIRED'), { code: 'RECOVERY_REQUIRED', cause: error }); }
    finally { if (fd !== undefined) fs.closeSync(fd); if (directory !== undefined) fs.closeSync(directory); }
  }
  return Object.freeze({ root, scan, append, ensureDurable, reserve, compact });
}
