import {persistentIdentity, runStorageWorkerEnvelope} from './storage-identity.mjs';
// Internal fixed-command worker. Not a shell, renderer transport or public API.
// cwd pins one directory object; all file operations below use direct basenames.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isPortableRelativePath, isInspectableRelativePath, portablePathKey } from '../domain/path-policy.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const leaf = value => isPortableRelativePath(value) && !value.includes('/');
const flags = fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
// Inspect direct entries of the pinned cwd, not an absolute path. A portable
// source path must name exactly one entry with exactly the recorded spelling.
// Bound enumeration before allocating an unbounded list. Hostile same-user
// namespace mutation between syscalls still requires OS-level isolation.
function exactName(name) {
  const directory = fs.opendirSync('.'); let count = 0, matches = 0, exact = false;
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      if (++count > 10000) fail('DIRECTORY_LIMIT');
      if (portablePathKey(entry.name) === portablePathKey(name)) {
        matches += 1; exact ||= entry.name === name;
      }
    }
  } finally { directory.closeSync(); }
  if (matches > 1 || (matches === 1 && !exact)) fail('PATH_ALIAS');
}
function read(name, limit) {
  let fd;
  try {
    exactName(name);
    fd = fs.openSync(name, fs.constants.O_RDONLY | flags);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) fail('UNSAFE_FILE');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) fail('CHANGED_DURING_READ'); offset += count;
    }
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('CHANGED_DURING_READ');
    return { hash: hash(bytes), bytes: bytes.toString('base64') };
  } catch (error) { if (error.code === 'ENOENT') return { hash: null, bytes: null }; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
// A batch shares only its read-only cwd/name index. Original single-file and all
// write commands keep their existing paths below. Nothing is published on error.
const stamp = stat => ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key])).join(':');
function nameIndex() {
  const directory = fs.opendirSync('.'), names = [], keys = new Map();
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      if (names.length === 10000) fail('DIRECTORY_LIMIT');
      names.push(entry.name);
      const key = portablePathKey(entry.name), prior = keys.get(key);
      keys.set(key, prior === undefined ? entry.name : null);
    }
  } finally { directory.closeSync(); }
  return { names: names.sort(), keys };
}
function* readMany(names, limit, totalLimit, observations = false) {
  const parent = fs.statSync('.', { bigint: true }), before = nameIndex(), saved = []; let total = 0;
  for (const name of names) {
    const key = portablePathKey(name);
    if (before.keys.has(key) && before.keys.get(key) !== name) fail('PATH_ALIAS');
    if (!before.keys.has(key)) {
      try { fs.lstatSync(name); } catch (error) { if (error.code === 'ENOENT') { saved.push({ name, hash: null, bytes: null, identity: null }); continue; } throw error; }
      fail('CHANGED_DURING_READ');
    }
    let fd;
    try {
      fd = fs.openSync(name, fs.constants.O_RDONLY | flags);
      const original = fs.fstatSync(fd, { bigint: true });
      if (!original.isFile() || original.nlink !== 1n || original.dev !== parent.dev || original.size > BigInt(limit)) fail('UNSAFE_FILE');
      if (stamp(fs.lstatSync(name, { bigint: true })) !== stamp(original)) fail('CHANGED_DURING_READ');
      total += Number(original.size); if (total > totalLimit) fail('SOURCE_TOO_LARGE');
      const bytes = Buffer.alloc(Number(original.size) + 1); let offset = 0;
      while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count; }
      if (offset !== Number(original.size) || stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(original)
        || stamp(fs.lstatSync(name, { bigint: true })) !== stamp(original)) fail('CHANGED_DURING_READ');
      const kept = bytes.subarray(0, offset); saved.push({ name, hash: hash(kept), bytes: kept.toString('base64'), identity: stamp(original) });
    } catch (error) { if (error.code === 'ENOENT') fail('CHANGED_DURING_READ'); throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  // Existing qualification-only IPC pattern; production opens no IPC channel.
  // No flag, command or injected path can select this syscall boundary.
  if (process.send && !observations) yield { ready: 'read-many' };
  const after = nameIndex(), current = fs.statSync('.', { bigint: true });
  if (['dev', 'ino', 'uid', 'mode'].some(key => current[key] !== parent[key])) fail('DIRECTORY_CHANGED');
  if (JSON.stringify(before.names) !== JSON.stringify(after.names)) fail('CHANGED_DURING_READ');
  for (const file of saved) {
    let stat;
    try { stat = fs.lstatSync(file.name, { bigint: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (file.identity === null ? stat !== undefined : stat === undefined || stamp(stat) !== file.identity) fail('CHANGED_DURING_READ');
  }
  return { files: saved.map(({ name, hash, bytes }) => ({ name, hash, bytes })),
    ...(observations ? { observations: saved, namespace: before.names } : {}) };
}
// One isolated process traverses a bounded read set. The utility/host never
// changes cwd; writes still use the original single pinned-cwd commands below.
// Every path is re-traversed before reply, so the saved cwd is not a pathname
// lease and a renamed/replaced parent cannot publish a detached read as current.
function* readPaths(paths, limit, totalLimit) {
  const root = fs.realpathSync('.'), rootStat = fs.statSync('.'), ancestors = [];
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;
  let ancestor = path.parse(root).root;
  for (const part of ['', ...root.slice(ancestor.length).split('/').filter(Boolean)]) {
    if (part) ancestor = path.join(ancestor, part);
    const stat = fs.lstatSync(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_DIRECTORY');
    ancestors.push({ path: ancestor, stat });
  }
  function anchor() {
    for (const item of ancestors) {
      const current = fs.lstatSync(item.path);
      if (!current.isDirectory() || current.isSymbolicLink() || !same(current, item.stat)) fail('DIRECTORY_CHANGED');
    }
    process.chdir(root);
    if (!same(fs.statSync('.'), rootStat)) fail('DIRECTORY_CHANGED');
  }
  function* enter(parts, expected = null) {
    anchor(); const chain = [];
    for (const [index, part] of parts.entries()) {
      exactName(part);
      const fd = fs.openSync(part, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | flags);
      try {
        const held = fs.fstatSync(fd), named = fs.lstatSync(part);
        if (!held.isDirectory() || named.isSymbolicLink() || !same(held, named)) fail('DIRECTORY_CHANGED');
        if (held.dev !== rootStat.dev) fail('CROSS_DEVICE');
        if (expected && !same(held, expected[index])) fail('DIRECTORY_CHANGED');
        if (process.send && !expected) {
          yield { ready: 'read-paths-directory', name: part };
        }
        // chdir is child-only, and cannot select a replacement for the held FD.
        process.chdir(part);
        if (!same(fs.statSync('.'), held)) fail('DIRECTORY_CHANGED');
        chain.push(held);
      } finally { fs.closeSync(fd); }
    }
    return chain;
  }
  const groups = new Map(), saved = new Map(); let total = 0;
  for (const relative of paths) {
    const parent = path.posix.dirname(relative);
    if (!groups.has(parent)) groups.set(parent, { parts: parent === '.' ? [] : parent.split('/'), names: [] });
    groups.get(parent).names.push(path.posix.basename(relative));
  }
  for (const [parent, group] of groups) {
    group.chain = yield* enter(group.parts);
    group.stat = fs.statSync('.');
    const current = yield* readMany(group.names, limit, totalLimit, true);
    group.observations = current.observations; group.namespace = current.namespace;
    for (const file of current.files) {
      total += file.bytes === null ? 0 : Buffer.from(file.bytes, 'base64').length;
      if (total > totalLimit) fail('SOURCE_TOO_LARGE');
      const relative = parent === '.' ? file.name : parent + '/' + file.name;
      saved.set(relative, { path: relative, hash: file.hash, bytes: file.bytes,
        parentIdentity: persistentIdentity(group.stat), parentDev: group.stat.dev });
    }
  }
  if (process.send) yield { ready: 'read-paths' };
  for (const group of groups.values()) {
    yield* enter(group.parts, group.chain);
    if (!same(fs.statSync('.'), group.stat)) fail('DIRECTORY_CHANGED');
    const currentNames = nameIndex();
    if (JSON.stringify(currentNames.names) !== JSON.stringify(group.namespace)) fail('CHANGED_DURING_READ');
    for (const file of group.observations) {
      const key = portablePathKey(file.name);
      if (currentNames.keys.has(key) && currentNames.keys.get(key) !== file.name) fail('PATH_ALIAS');
      let current;
      try { current = fs.lstatSync(file.name, { bigint: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (file.identity === null ? current !== undefined : current === undefined || stamp(current) !== file.identity) fail('CHANGED_DURING_READ');
    }
  }
  anchor(); return { files: paths.map(relative => saved.get(relative)) };
}
function syncDirectory() { const fd = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function exclusive(name, bytes) {
  const fd = fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | flags, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory();
}
function* command(input) {
  if (['read-paths', 'read-file-paths'].includes(input?.command)) {
    if (Object.keys(input).sort().join('|') !== ['command','identity','paths','limit','totalLimit'].sort().join('|')
      || !Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 128
      || input.paths.some(name => !isInspectableRelativePath(name))
      || new Set(input.paths.map(portablePathKey)).size !== input.paths.length) fail('INVALID_READ_BATCH');
    const binary = input.command === 'read-file-paths';
    if (input.limit !== (binary ? 4 : 1) * 1024 * 1024 || input.totalLimit !== (binary ? 8 : 4) * 1024 * 1024) fail('INVALID_LIMIT');
  } else if (input?.command === 'read-many') {
    if (Object.keys(input).sort().join('|') !== ['command','identity','names','limit','totalLimit'].sort().join('|')
      || !Array.isArray(input.names) || input.names.length < 1 || input.names.length > 128
      || input.names.some(name => !isInspectableRelativePath(name) || name.includes('/'))
      || new Set(input.names.map(portablePathKey)).size !== input.names.length) fail('INVALID_READ_BATCH');
    if (input.limit !== 1024 * 1024 || input.totalLimit !== 4 * 1024 * 1024) fail('INVALID_LIMIT');
  } else {
    if (!input || Object.keys(input).some(key => !['command','identity','name','stage','previous','expectedHash','candidateHash','bytes','limit'].includes(key))) fail('INVALID_COMMAND');
    const readOnlyName = ['read','directory','directory-state'].includes(input.command);
    if (!(readOnlyName ? isInspectableRelativePath(input.name) && !input.name.includes('/') : leaf(input.name))
      || (input.stage !== undefined && !leaf(input.stage)) || (input.previous !== undefined && !leaf(input.previous))) fail('INVALID_PATH');
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > 32 * 1024 * 1024) fail('INVALID_LIMIT');
  const dir = fs.statSync('.');
  const held = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  const pinned = fs.fstatSync(held); fs.closeSync(held);
  if (!dir.isDirectory() || persistentIdentity(dir) !== input.identity || persistentIdentity(pinned) !== input.identity) fail('DIRECTORY_CHANGED');
  let result;
  if (['directory','directory-state'].includes(input.command)) {
    exactName(input.name);
    let fd;
    try {
      fd = fs.openSync(input.name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | flags);
      const stat = fs.fstatSync(fd); if (!stat.isDirectory()) fail('UNSAFE_DIRECTORY');
      result = { identity: persistentIdentity(stat), dev: stat.dev };
    } catch (error) { if (input.command !== 'directory-state' || error.code !== 'ENOENT') throw error; result = { identity: null, dev: null }; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  } else if (input.command === 'mkdir') {
    // An explicitly selected ordinary folder may acquire product metadata or a
    // user-requested child folder. Never recursive; an existing entry wins.
    exactName(input.name); fs.mkdirSync(input.name, { mode: 0o700 }); syncDirectory();
    const fd = fs.openSync(input.name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | flags);
    try { const stat = fs.fstatSync(fd); result = { identity: persistentIdentity(stat), dev: stat.dev }; }
    finally { fs.closeSync(fd); }
  } else if (input.command === 'read') result = read(input.name, input.limit);
  else if (input.command === 'read-many') result = yield* readMany(input.names, input.limit, input.totalLimit);
  else if (['read-paths', 'read-file-paths'].includes(input.command)) result = yield* readPaths(input.paths, input.limit, input.totalLimit);
  else if (input.command === 'stage') {
    const bytes = Buffer.from(input.bytes, 'base64');
    if (bytes.length > input.limit || hash(bytes) !== input.candidateHash) fail('INVALID_CANDIDATE');
    const prior = read(input.name, input.limit);
    if (prior.hash === null) exclusive(input.name, bytes);
    else if (prior.hash !== input.candidateHash) fail('STAGE_CONFLICT');
    result = { hash: input.candidateHash };
  } else if (input.command === 'detach') {
    if (input.expectedHash === null || input.candidateHash !== null || !leaf(input.previous)
      || input.name === input.previous || read(input.previous, input.limit).hash !== null) fail('INVALID_CANDIDATE');
    if (read(input.name, input.limit).hash !== input.expectedHash) fail('STALE');
    if (process.send) yield { ready: 'detach' };
    fs.renameSync(input.name, input.previous); syncDirectory();
    if (read(input.previous, input.limit).hash !== input.expectedHash) {
      try { fs.linkSync(input.previous, input.name); syncDirectory(); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      fail('STALE_RETAINED');
    }
    if (read(input.name, input.limit).hash !== null) fail('STALE_RETAINED');
    result = { hash: null };
  } else if (input.command === 'replace') {
    const current = read(input.name, input.limit), candidate = read(input.stage, input.limit);
    if (current.hash !== input.expectedHash) fail('STALE');
    if (candidate.hash !== input.candidateHash) fail('MISSING_STAGE');
    if (input.name === input.stage || input.name === input.previous || input.stage === input.previous) fail('INVALID_PATH');
    if (input.expectedHash !== null && (!leaf(input.previous) || read(input.previous,input.limit).hash !== null)) fail('PREVIOUS_CONFLICT');
    // Optional parent IPC barrier supports deterministic syscall-boundary tests.
    // The production adapter does not open an IPC channel. No commands or paths
    // are accepted here; the same relative syscall runs after one acknowledgement.
    if (process.send) {
      yield { ready: 'replace' };
    }
    if (input.expectedHash === null) {
      // link is atomic no-clobber: another creator wins rather than being lost.
      fs.linkSync(input.stage, input.name); syncDirectory();
      fs.unlinkSync(input.stage); syncDirectory();
    } else {
      // Preserve the actual leaf at the syscall, not just the bytes read earlier.
      // Internal reserved predecessor names are exclusively owned by the host;
      // hostile same-user mutation of recovery/staging is outside this boundary.
      fs.renameSync(input.name, input.previous); syncDirectory();
      const moved = read(input.previous, input.limit);
      if (moved.hash !== input.expectedHash) {
        // Restore visibility only if nobody recreated the destination. Retain the
        // predecessor too: its bytes were not in the prepared journal snapshot.
        try { fs.linkSync(input.previous, input.name); syncDirectory(); } catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
        fail('STALE_RETAINED');
      }
      fs.linkSync(input.stage, input.name); syncDirectory();
      fs.unlinkSync(input.stage); syncDirectory();
    }
    result = { hash: input.candidateHash };
  } else if (input.command === 'cleanup') {
    const current=read(input.name,input.limit);
    if (current.hash !== null && current.hash !== input.expectedHash) fail('RETAINED_CONFLICT');
    if (current.hash !== null) { fs.unlinkSync(input.name); syncDirectory(); }
    result = { removed: current.hash !== null };
  } else if (input.command === 'journal') {
    const bytes = Buffer.from(input.bytes, 'base64');
    if (bytes.length > input.limit || hash(bytes) !== input.candidateHash) fail('INVALID_CANDIDATE');
    if (read(input.name, input.limit).hash !== input.expectedHash) fail('STALE');
    const temporary = '.journal-' + randomUUID();
    exclusive(temporary, bytes);
    if (input.expectedHash === null) { fs.linkSync(temporary, input.name); syncDirectory(); fs.unlinkSync(temporary); }
    else fs.renameSync(temporary, input.name);
    syncDirectory(); result = { hash: input.candidateHash };
  } else fail('INVALID_COMMAND');
  return { ok: true, ...result };
}
// Only the fixed task below uses this executor. Each primitive still operates
// against a held, identity-checked cwd, in this dedicated process, never host cwd.
function localExecutor(context) {
  const roots = [context.options.repositoryRoot, context.options.recoveryRoot];
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;
  const anchors = new Map();
  for (const root of roots) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || fs.realpathSync(root) !== root) fail('INVALID_CONTEXT');
    let current = path.parse(root).root;
    for (const part of ['', ...root.slice(current.length).split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_DIRECTORY');
      anchors.set(current, stat);
    }
  }
  function check(items) {
    for (const [name, prior] of items) {
      const stat = fs.lstatSync(name);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !same(stat, prior)) fail('DIRECTORY_CHANGED');
    }
  }
  return (parent, operation, fields, limit = 1024 * 1024) => {
    check(anchors);
    const root = roots.find(root => parent.path === root || parent.path.startsWith(root + path.sep));
    if (!root) fail('INVALID_CONTEXT');
    process.chdir(root);
    if (!same(fs.statSync('.'), anchors.get(root))) fail('DIRECTORY_CHANGED');
    const chain = new Map(); let current = root;
    for (const part of path.relative(root, parent.path).split(path.sep).filter(Boolean)) {
      if (!isInspectableRelativePath(part) || part.includes('/')) fail('INVALID_PATH');
      exactName(part);
      const fd = fs.openSync(part, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | flags);
      try {
        const held = fs.fstatSync(fd), named = fs.lstatSync(part);
        if (!held.isDirectory() || named.isSymbolicLink() || !same(held, named)) fail('DIRECTORY_CHANGED');
        if (held.dev !== anchors.get(root).dev) fail('CROSS_DEVICE');
        process.chdir(part);
        if (!same(fs.statSync('.'), held)) fail('DIRECTORY_CHANGED');
        current = path.join(current, part); chain.set(current, held);
      } finally { fs.closeSync(fd); }
    }
    if (persistentIdentity(fs.statSync('.')) !== parent.identity) fail('DIRECTORY_CHANGED');
    const iterator = command({ command: operation, identity: parent.identity, ...fields, limit });
    const step = iterator.next();
    // Production never has a qualification IPC channel. Do not consume a test
    // barrier and pretend that its external race action has happened.
    if (!step.done) fail('UNEXPECTED_BARRIER');
    check(anchors); check(chain);
    if (persistentIdentity(fs.statSync(parent.path)) !== parent.identity) fail('DIRECTORY_CHANGED');
    return step.value;
  };
}
try {
  const raw = fs.readFileSync(0, 'utf8');
  if (raw.length > 48 * 1024 * 1024) fail('INPUT_TOO_LARGE');
  await runStorageWorkerEnvelope(JSON.parse(raw), async input => {
  let step;
  if (input?.command === 'transaction') {
    if (Object.keys(input).sort().join('|') !== ['command', 'identity', 'limit', 'context', 'request'].sort().join('|')
      || input.limit !== 1024 * 1024 || input.identity !== input.context?.repositoryIdentity
      || persistentIdentity(fs.statSync('.')) !== input.identity) fail('INVALID_CONTEXT');
    const { executeFilesystemTransaction } = await import('./node-filesystem.mjs');
    step = { done: true, value: executeFilesystemTransaction(input.context, input.request, localExecutor(input.context)) };
  } else {
    const iterator = command(input); step = iterator.next();
    while (!step.done) {
      process.send(step.value); await new Promise(resolve => process.once('message', resolve));
      step = iterator.next();
    }
  }
  process.stdout.write(JSON.stringify(step.value));
  });
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? 'FAILED' })); process.exitCode = 1;
}
