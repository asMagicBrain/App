import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isIdentity } from '../domain/identity.mjs';
import { isPortableRelativePath, isInspectableRelativePath, portablePathKey } from '../domain/path-policy.mjs';
import { isExactDataRecord, snapshotStringArray } from '../setup/data-input.mjs';
import { prepareTransaction, prepareSourceTransaction, prepareFileTransaction, inspectTransaction, checkTransactionPreconditions, inspectRequestIdentity } from '../operations/requests.mjs';

const worker = fileURLToPath(new URL('./filesystem-worker.mjs', import.meta.url));
const locks = new Set(), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const FILE_LIMIT = 1024 * 1024, TOTAL_LIMIT = 8 * FILE_LIMIT, JOURNAL_LIMIT = 32 * FILE_LIMIT;
const READ_BATCH_FILES = 128, READ_BATCH_BYTES = 4 * FILE_LIMIT;
const RECEIPT_LIMIT = 128, COMPACT_AFTER = 32, receiptsName = 'receipts.json';
const error = code => Object.assign(new Error(code), { code });
const preflightFailures = new WeakSet();
// Trusted in-process phase evidence, never a caller-supplied error code/field.
export const isTransactionPreflightFailure = failure => preflightFailures.has(failure);
const identity = stat => `${stat.dev}:${stat.ino}`;
function directory(name) {
  const stat = fs.lstatSync(name);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('UNSAFE_DIRECTORY');
  return { path: name, identity: identity(stat), dev: stat.dev };
}
function inside(parent, child) { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }
const stableStamp = stat => ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key])).join(':');
function exactEntry(parent, name) {
  const opened = fs.opendirSync(parent); let count = 0, matches = 0, exact = false;
  try {
    let entry;
    while ((entry = opened.readSync()) !== null) {
      if (++count > 10000) throw error('DIRECTORY_LIMIT');
      if (portablePathKey(entry.name) === portablePathKey(name)) { matches++; exact ||= entry.name === name; }
    }
  } finally { opened.closeSync(); }
  if (matches > 1 || matches === 1 && !exact) throw error('PATH_ALIAS');
  return matches === 1;
}
function ancestorPins(root) {
  let current = path.parse(root).root; const result = [];
  for (const part of ['', ...root.slice(current.length).split(path.sep).filter(Boolean)]) {
    if (part) { if (!exactEntry(current, part)) throw error('DIRECTORY_CHANGED'); current = path.join(current, part); }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('UNSAFE_DIRECTORY');
    result.push({ path: current, identity: identity(stat), uid: stat.uid, mode: stat.mode });
  }
  return result;
}
function runWorker(parent, command, fields, limit = FILE_LIMIT, outputLimit = 48 * FILE_LIMIT) {
  const result = spawnSync(process.execPath, [worker], {
    cwd: parent.path, shell: false, encoding: 'utf8', timeout: 30000,
    env: {PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},
    input: JSON.stringify({ command, identity: parent.identity, ...fields, limit }),
    maxBuffer: outputLimit,
  });
  if (result.error) throw error(result.error.code ?? 'WORKER_FAILED');
  if (result.signal) throw error('WORKER_FAILED');
  let value; try { value = JSON.parse(result.stdout); } catch { throw error('WORKER_FAILED'); }
  if (result.status !== 0 || !value.ok) throw error(value.code ?? 'WORKER_FAILED');
  if (command === 'transaction' && JSON.stringify(value) !== result.stdout) throw error('WORKER_FAILED');
  return value;
}
function wire(snapshot) {
  return { schemaVersion: snapshot.schemaVersion, requestId: snapshot.requestId, target: snapshot.target,
    expected: snapshot.expected, input: { assets: snapshot.input.assets,
      ...(snapshot.schemaVersion === 3 ? { directories: snapshot.input.directories } : {}),
      files: snapshot.input.files.map(file => ({ path: file.path, bytes: file.bytes === null ? null : Buffer.from(file.bytes).toString('base64') })) } };
}
function unwire(value) {
  if (!value || !value.input || !Array.isArray(value.input.files)) throw error('INVALID_JOURNAL');
  return (value.schemaVersion === 3 ? prepareFileTransaction : value.schemaVersion === 2 ? prepareSourceTransaction : prepareTransaction)({ ...value, input: { ...value.input,
    files: value.input.files.map(file => {
      if (!isExactDataRecord(file, ['path', 'bytes'])) throw error('INVALID_JOURNAL');
      if (value.schemaVersion === 3 && file.bytes === null) return { path: file.path, bytes: null };
      if (typeof file.bytes !== 'string' || file.bytes.length > (value.schemaVersion === 3 ? 6 : 2) * FILE_LIMIT) throw error('INVALID_JOURNAL');
      const bytes = Buffer.from(file.bytes, 'base64');
      if (bytes.toString('base64') !== file.bytes) throw error('INVALID_JOURNAL');
      return { path: file.path, bytes };
    }) } });
}

/** Trusted internal filesystem adapter used by the native host and isolated tests.
 * Not a renderer/public IPC endpoint: the host resolves account/grants and binds
 * these paths and Space identity. No shell, Git or network operations.
 */
export function createNodeFilesystem(options) { return createFilesystem(options); }

// Internal fixed-worker entry. It shares the complete transaction engine below;
// neither the renderer nor a public operation can supply an executor or roots.
export function executeFilesystemTransaction(context, request, execute) {
  if (!isExactDataRecord(context, ['options', 'repositoryIdentity', 'recoveryIdentity'])
    || typeof execute !== 'function') throw error('INVALID_CONTEXT');
  for (const [field, expected] of [['repositoryRoot', context.repositoryIdentity], ['recoveryRoot', context.recoveryIdentity]]) {
    const name = context.options?.[field];
    if (typeof name !== 'string' || fs.realpathSync(name) !== name || directory(name).identity !== expected) throw error('DIRECTORY_CHANGED');
  }
  let parents = [];
  const api = createFilesystem(context.options, execute, value => { parents = value; }), plan = unwire(request), snapshot = inspectTransaction(plan);
  if (snapshot.schemaVersion !== 2) throw error('INVALID_OPERATION');
  try {
    const outcome = api.apply(plan);
    return { ok: true, phase: 'result', result: outcome,
      parents: outcome.status === 'completed' && !outcome.replay ? parents : [] };
  } catch (failure) {
    if (!isTransactionPreflightFailure(failure)) throw failure;
    return { ok: true, phase: 'preflight', code: failure.code };
  }
}

function createFilesystem(options, localExecute = null, captureParents = null) {
  if (!isExactDataRecord(options, ['repositoryRoot', 'recoveryRoot', 'spaceRoot', 'spaceId'])
    || !isIdentity(options.spaceId) || !isPortableRelativePath(options.spaceRoot, { allowRoot: true })
    || ![options.repositoryRoot, options.recoveryRoot].every(value => typeof value === 'string' && path.isAbsolute(value))) throw error('INVALID_CONTEXT');
  options = Object.freeze({ ...options });
  const repository = directory(fs.realpathSync(options.repositoryRoot));
  const recovery = directory(fs.realpathSync(options.recoveryRoot));
  // Recovery contains fsynced JSON copies, not cross-volume rename targets.
  // Staging and atomic replacement stay in each pinned source parent.
  if (inside(repository.path, recovery.path) || inside(recovery.path, repository.path)) throw error('INVALID_RECOVERY_ROOT');
  const recoveryAncestors = ancestorPins(recovery.path);
  const session = new Map(), journalCache = new Map();
  const run = localExecute ?? runWorker;
  function remember(snapshot) {
    const key = snapshot.requestId.toLowerCase(); session.delete(key);
    session.set(key, { requestId: snapshot.requestId, fingerprint: snapshot.fingerprint });
    while (session.size > RECEIPT_LIMIT) session.delete(session.keys().next().value);
  }
  function checkRoots() {
    if (directory(repository.path).identity !== repository.identity || directory(recovery.path).identity !== recovery.identity) throw error('DIRECTORY_CHANGED');
  }
  function parentFor(relative, readOnly = false) {
    checkRoots();
    if (!(readOnly ? isInspectableRelativePath(relative) : isPortableRelativePath(relative))) throw error('INVALID_PATH');
    const parts = [...(options.spaceRoot === '.' ? [] : options.spaceRoot.split('/')), ...relative.split('/')];
    let current = repository;
    // Resolve each next directory through the previous pinned cwd. A pathname
    // swap during traversal cannot redefine the identity expected at the next hop.
    for (const part of parts.slice(0, -1)) {
      const child = run(current, 'directory', { name: part });
      current = { path: path.join(current.path, part), identity: child.identity, dev: child.dev };
    }
    if (current.dev !== repository.dev) throw error('CROSS_DEVICE');
    return { ...current, name: parts.at(-1) };
  }
  function read(relative, readOnly = false) {
    if (!(readOnly ? isInspectableRelativePath(relative) : isPortableRelativePath(relative))) throw error('INVALID_PATH');
    return readMany([relative], readOnly)[0];
  }
  function observed(snapshot) {
    let total = 0;
    if (snapshot.schemaVersion >= 2) {
      const groups = new Map(), result = new Map();
      for (const file of snapshot.expected.files) {
        const directory = path.posix.dirname(file.path);
        if (!groups.has(directory)) groups.set(directory, []);
        groups.get(directory).push(file.path);
      }
      for (const names of groups.values()) for (let offset = 0; offset < names.length; offset += READ_BATCH_FILES) {
        const batch = names.slice(offset, offset + READ_BATCH_FILES);
        const declared = snapshot.schemaVersion === 3 && snapshot.input.directories.find(dir => batch.every(name => path.posix.dirname(name) === dir));
        const absent = declared && directoryState(declared).identity === null;
        for (const current of absent ? batch.map(name => ({ path: name, hash: null, bytes: null, parent: null })) : readMany(batch, false, snapshot.schemaVersion === 3)) {
          total += current.bytes === null ? 0 : Buffer.from(current.bytes, 'base64').length;
          if (total > TOTAL_LIMIT) throw error('SOURCE_TOO_LARGE');
          result.set(current.path, current);
        }
      }
      return snapshot.expected.files.map(file => result.get(file.path));
    }
    const files = snapshot.expected.files.map(file => {
      const current = read(file.path); total += current.bytes === null ? 0 : Buffer.from(current.bytes, 'base64').length;
      if (total > TOTAL_LIMIT) throw error('SOURCE_TOO_LARGE');
      return { path: file.path, hash: current.hash, bytes: current.bytes, parent: current.parent };
    });
    return files;
  }
  function directoryState(relative) {
    const parent = parentFor(relative), state = run(parent, 'directory-state', { name: parent.name });
    if (state.identity !== null && state.dev !== repository.dev) throw error('CROSS_DEVICE');
    if (parentFor(relative).identity !== parent.identity) throw error('DIRECTORY_CHANGED');
    return { ...state, parent };
  }
  function journalName(id) { if (!isIdentity(id)) throw error('INVALID_REQUEST_ID'); return id.toLowerCase() + '.json'; }
  // Only host-authored, single-level recovery records use this read-only path.
  // As in private-store reads, FD/named/root checks guard publication; this is
  // not an openat sandbox against coordinated same-user namespace mutation.
  // Source reads and ALL mutations retain the isolated pinned-cwd worker.
  function readRecoveryFile(name, limit) {
    if (name !== receiptsName && (!name.endsWith('.json') || !isIdentity(name.slice(0, -5)) || name !== name.toLowerCase())) throw error('INVALID_REQUEST_ID');
    let rootFd, fileFd;
    function rootsCurrent() {
      checkRoots();
      for (const pin of recoveryAncestors) {
        if (pin.path !== path.parse(pin.path).root && !exactEntry(path.dirname(pin.path), path.basename(pin.path))) throw error('DIRECTORY_CHANGED');
        const current = fs.lstatSync(pin.path);
        if (!current.isDirectory() || current.isSymbolicLink() || identity(current) !== pin.identity
          || current.uid !== pin.uid || current.mode !== pin.mode) throw error('DIRECTORY_CHANGED');
      }
      if (rootFd !== undefined && identity(fs.fstatSync(rootFd)) !== recovery.identity) throw error('DIRECTORY_CHANGED');
    }
    const filename = path.join(recovery.path, name), flags = fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    try {
      rootsCurrent();
      rootFd = fs.openSync(recovery.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | flags); rootsCurrent();
      const present = exactEntry(recovery.path, name);
      if (!present) {
        rootsCurrent();
        if (exactEntry(recovery.path, name)) throw error('CHANGED_DURING_READ');
        try { fs.lstatSync(filename); } catch (failure) { if (failure.code === 'ENOENT') { rootsCurrent(); return { hash: null, bytes: null }; } throw failure; }
        throw error('CHANGED_DURING_READ');
      }
      fileFd = fs.openSync(filename, fs.constants.O_RDONLY | flags);
      const before = fs.fstatSync(fileFd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.dev !== BigInt(recovery.dev) || before.size > BigInt(limit)) throw error('UNSAFE_FILE');
      if (stableStamp(fs.lstatSync(filename, { bigint: true })) !== stableStamp(before)) throw error('CHANGED_DURING_READ');
      rootsCurrent(); if (!exactEntry(recovery.path, name)) throw error('CHANGED_DURING_READ');
      // No file contents are read before all held/named/root checks above pass.
      const bytes = Buffer.alloc(Number(before.size) + 1); let offset = 0;
      while (offset < bytes.length) { const count = fs.readSync(fileFd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count; }
      if (offset !== Number(before.size) || stableStamp(fs.fstatSync(fileFd, { bigint: true })) !== stableStamp(before)
        || stableStamp(fs.lstatSync(filename, { bigint: true })) !== stableStamp(before)) throw error('CHANGED_DURING_READ');
      if (!exactEntry(recovery.path, name)) throw error('CHANGED_DURING_READ'); rootsCurrent();
      const kept = bytes.subarray(0, offset); return { hash: hash(kept), bytes: kept.toString('base64') };
    } finally { if (fileFd !== undefined) fs.closeSync(fileFd); if (rootFd !== undefined) fs.closeSync(rootFd); }
  }
  function readJournal(id) { return readRecoveryFile(journalName(id), JOURNAL_LIMIT); }
  function writeJournal(record, priorHash) {
    checkRoots(); const bytes = Buffer.from(JSON.stringify(record));
    return run(recovery, 'journal', { name: journalName(record.request.requestId), expectedHash: priorHash,
      candidateHash: hash(bytes), bytes: bytes.toString('base64') }, JOURNAL_LIMIT).hash;
  }
  function readReceipts() {
    const saved = readRecoveryFile(receiptsName, FILE_LIMIT);
    if (saved.hash === null) return { hash: null, record: { schemaVersion: 1,
      repositoryIdentity: repository.identity, spaceId: options.spaceId.toLowerCase(), spaceRoot: options.spaceRoot,
      receipts: [], retiring: [] } };
    let record; const bytes = Buffer.from(saved.bytes, 'base64');
    try { record = JSON.parse(bytes.toString('utf8')); } catch { throw error('INVALID_JOURNAL'); }
    if (JSON.stringify(record) !== bytes.toString('utf8') || !Buffer.from(JSON.stringify(record)).equals(bytes)
      || !isExactDataRecord(record, ['schemaVersion','repositoryIdentity','spaceId','spaceRoot','receipts','retiring'])
      || record.schemaVersion !== 1 || record.repositoryIdentity !== repository.identity
      || record.spaceId !== options.spaceId.toLowerCase() || record.spaceRoot !== options.spaceRoot
      || !Array.isArray(record.receipts) || record.receipts.length > RECEIPT_LIMIT
      || !Array.isArray(record.retiring) || record.retiring.length > COMPACT_AFTER) throw error('INVALID_JOURNAL');
    const ids = new Set();
    for (const item of record.receipts) {
      if (!isExactDataRecord(item, ['requestId','fingerprint']) || !isIdentity(item.requestId)
        || item.requestId !== item.requestId.toLowerCase() || !/^[a-f0-9]{64}$/.test(item.fingerprint)
        || ids.has(item.requestId)) throw error('INVALID_JOURNAL');
      ids.add(item.requestId);
    }
    const retiring = new Set();
    for (const item of record.retiring) {
      if (!isExactDataRecord(item, ['requestId','fingerprint','journalHash'])
        || !record.receipts.some(receipt => receipt.requestId === item.requestId && receipt.fingerprint === item.fingerprint)
        || !/^[a-f0-9]{64}$/.test(item.journalHash) || retiring.has(item.requestId)) throw error('INVALID_JOURNAL');
      retiring.add(item.requestId);
    }
    return { hash: saved.hash, record };
  }
  function writeReceipts(record, priorHash) {
    checkRoots(); const bytes = Buffer.from(JSON.stringify(record));
    return run(recovery, 'journal', { name: receiptsName, expectedHash: priorHash,
      candidateHash: hash(bytes), bytes: bytes.toString('base64') }, FILE_LIMIT).hash;
  }
  function decodeJournal(saved) {
    if (saved.hash === null) return null;
    // Journal is host-authored JSON; bound parse before interpreting paths/bytes.
    let record;
    try {
      const raw = Buffer.from(saved.bytes, 'base64').toString('utf8'); record = JSON.parse(raw);
      // Journals use one canonical host-written encoding. Reject duplicate keys,
      // alternative numeric spellings and malformed UTF-8 before issuing commands.
      if (JSON.stringify(record) !== raw || Buffer.from(raw).toString('base64') !== saved.bytes) throw error('INVALID_JOURNAL');
    } catch { throw error('INVALID_JOURNAL'); }
    if (!isExactDataRecord(record, ['schemaVersion','repositoryIdentity','spaceId','spaceRoot','request','fingerprint','state','prior','stages','progress', ...(record.schemaVersion === 2 ? ['directories'] : [])])
      || ![1,2].includes(record.schemaVersion) || record.spaceId !== options.spaceId.toLowerCase() || record.spaceRoot !== options.spaceRoot
      || record.repositoryIdentity !== repository.identity
      || !['prepared','applying','completed','retained-old','manual', ...(record.schemaVersion === 2 ? ['preparing'] : [])].includes(record.state)
      || !Array.isArray(record.prior) || !Array.isArray(record.stages) || !Array.isArray(record.progress)) throw error('INVALID_JOURNAL');
    const plan = unwire(record.request), snapshot = inspectTransaction(plan);
    if ((record.schemaVersion === 2) !== (snapshot.schemaVersion === 3)) throw error('INVALID_JOURNAL');
    if (record.schemaVersion === 2 && (!Array.isArray(record.directories)
      || record.directories.length !== snapshot.input.directories.length
      || record.directories.some((item, index) => !isExactDataRecord(item, ['path','identity'])
        || item.path !== snapshot.input.directories[index] || (item.identity !== null && !/^\d+:\d+$/u.test(item.identity))))) throw error('INVALID_JOURNAL');
    if (snapshot.target.spaceId.toLowerCase() !== options.spaceId.toLowerCase() || snapshot.fingerprint !== record.fingerprint
      || snapshot.expected.files.some(file => file.path.split('/').some(part => portablePathKey(part).startsWith('.ASMB-')))
      || record.prior.length !== snapshot.files.length || (record.state === 'preparing' || record.schemaVersion === 2 && record.state === 'retained-old'
        ? record.stages.length > snapshot.changedFiles.length : record.stages.length !== snapshot.changedFiles.length)
      || record.progress.length > record.stages.length) throw error('INVALID_JOURNAL');
    let total = 0;
    record.prior.forEach((file, index) => {
      const expected = snapshot.files[index];
      if (!isExactDataRecord(file, ['path','hash','bytes']) || file.path !== expected.path || file.hash !== expected.expectedHash
        || (file.bytes !== null && typeof file.bytes !== 'string')) throw error('INVALID_JOURNAL');
      const bytes = file.bytes === null ? null : Buffer.from(file.bytes, 'base64');
      if ((bytes === null ? null : hash(bytes)) !== file.hash || (bytes && bytes.toString('base64') !== file.bytes)) throw error('INVALID_JOURNAL');
      total += bytes?.length ?? 0; if (total > TOTAL_LIMIT) throw error('INVALID_JOURNAL');
    });
    record.stages.forEach((stage, index) => {
      if (!isExactDataRecord(stage, ['path','name','previous','parentIdentity']) || stage.path !== snapshot.changedFiles[index].path
        || stage.name !== `.asmb-${snapshot.requestId.toLowerCase()}-${index}` || stage.previous !== stage.name+'-previous'
        || !/^\d+:\d+$/u.test(stage.parentIdentity)) throw error('INVALID_JOURNAL');
    });
    if (record.progress.some((value, index) => value !== record.stages[index].path)) throw error('INVALID_JOURNAL');
    return { record, plan, snapshot };
  }
  function listJournals() {
    checkRoots(); const entries = fs.readdirSync(recovery.path);
    return entries.filter(name => name.endsWith('.json') && name !== receiptsName).map(name => {
      const id = name.slice(0, -5); if (!isIdentity(id)) throw error('INVALID_JOURNAL');
      const stat = fs.lstatSync(path.join(recovery.path, name), { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw error('INVALID_JOURNAL');
      const stamp = [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs,stat.mode].join(':');
      const cached = journalCache.get(name);
      if (cached?.stamp === stamp) return cached.value;
      const saved = readJournal(id), decoded = decodeJournal(saved);
      if (!decoded || journalName(decoded.snapshot.requestId) !== name) throw error('INVALID_JOURNAL');
      const value = { ...decoded, journalHash: saved.hash };
      journalCache.delete(name); journalCache.set(name, { stamp, value });
      while (journalCache.size > COMPACT_AFTER * 2) journalCache.delete(journalCache.keys().next().value);
      return value;
    });
  }
  function maintainCompleted(hooks = {}) {
    let receipts = readReceipts();
    // Receipt publication precedes retirement. An interrupted retirement is
    // repeatable and only removes a journal whose exact bytes are covered.
    const retire = record => {
      for (const item of record.retiring) {
        checkRoots();
        try { fs.lstatSync(path.join(recovery.path, journalName(item.requestId))); }
        catch (failure) { if (failure.code === 'ENOENT') continue; throw failure; }
        run(recovery, 'cleanup', { name: journalName(item.requestId), expectedHash: item.journalHash }, JOURNAL_LIMIT);
        journalCache.delete(journalName(item.requestId)); hooks.at?.('after-journal-retirement');
      }
    };
    retire(receipts.record);
    let journals = listJournals();
    if (journals.some(item => !['completed','retained-old'].includes(item.record.state))) throw error('RECOVERY_REQUIRED');
    const eligible = journals.filter(item => item.record.state === 'completed');
    let retainedBytes = eligible.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.record)), 0);
    while (eligible.length >= COMPACT_AFTER || retainedBytes > TOTAL_LIMIT) {
      const batch = eligible.splice(0, COMPACT_AFTER), covered = [];
      for (const item of batch) {
        // A failed post-completion cleanup is not a healthy success to compact.
        // Never retire a predecessor, stage or failed/retained-old journal here.
        const clear = item.record.stages.every(stage => {
          const parent = parentFor(stage.path);
          if (parent.identity !== stage.parentIdentity) throw error('DIRECTORY_CHANGED');
          return run(parent, 'read', { name: stage.name }, item.snapshot.schemaVersion === 3 ? 4 * FILE_LIMIT : FILE_LIMIT).hash === null
            && run(parent, 'read', { name: stage.previous }, item.snapshot.schemaVersion === 3 ? 4 * FILE_LIMIT : FILE_LIMIT).hash === null;
        });
        if (clear) covered.push({ requestId: item.snapshot.requestId.toLowerCase(),
          fingerprint: item.snapshot.fingerprint, journalHash: item.journalHash });
        retainedBytes -= Buffer.byteLength(JSON.stringify(item.record));
      }
      if (!covered.length) continue;
      const next = new Map(receipts.record.receipts.map(item => [item.requestId,item]));
      for (const { requestId, fingerprint } of covered) { next.delete(requestId); next.set(requestId, { requestId, fingerprint }); }
      while (next.size > RECEIPT_LIMIT) next.delete(next.keys().next().value);
      const record = { ...receipts.record, receipts: [...next.values()], retiring: covered };
      hooks.at?.('before-receipt-publication');
      receipts = { hash: writeReceipts(record, receipts.hash), record };
      hooks.at?.('after-receipt-publication'); retire(record);
    }
    return receipts.record.receipts;
  }
  function locked(action) {
    if (locks.has(repository.identity)) throw error('BUSY');
    locks.add(repository.identity); try { return action(); } finally { locks.delete(repository.identity); }
  }
  function result(status, snapshot, extra = {}) { return Object.freeze({ status, requestId: snapshot.requestId,
    fingerprint: snapshot.fingerprint, savedLocally: status === 'completed', gitEffects: false, ...extra }); }
  function validateComplete(snapshot) {
    const current = observed(snapshot), expected = new Map(snapshot.files.map(file => [file.path, file.hash]));
    if (current.some(file => file.hash !== (expected.has(file.path) ? expected.get(file.path) : snapshot.expected.files.find(item => item.path === file.path).hash))) throw error('CONFLICT_EXTERNAL');
    checkRoots(); return current;
  }
  function readMany(relatives, readOnly = true, binary = false) {
      let names;
      try { names = snapshotStringArray(relatives, READ_BATCH_FILES, READ_BATCH_FILES * 4096); }
      catch { throw error('INVALID_READ_BATCH'); }
      if (!names.length || names.some(name => !(readOnly ? isInspectableRelativePath(name) : isPortableRelativePath(name)))
        || new Set(names.map(portablePathKey)).size !== names.length) throw error('INVALID_READ_BATCH');
      checkRoots();
      const paths = names.map(name => options.spaceRoot === '.' ? name : options.spaceRoot + '/' + name);
      const fileLimit = binary ? 4 * FILE_LIMIT : FILE_LIMIT, totalLimit = binary ? TOTAL_LIMIT : READ_BATCH_BYTES;
      const current = run(repository, binary ? 'read-file-paths' : 'read-paths', { paths, totalLimit }, fileLimit);
      if (!isExactDataRecord(current, ['ok', 'files']) || current.ok !== true || !Array.isArray(current.files)
        || current.files.length !== names.length) throw error('WORKER_FAILED');
      let total = 0;
      const entries = current.files.map((file, index) => {
        if (!isExactDataRecord(file, ['path', 'hash', 'bytes', 'parentIdentity', 'parentDev']) || file.path !== paths[index]
          || typeof file.parentIdentity !== 'string' || !/^\d+:\d+$/u.test(file.parentIdentity)
          || !Number.isSafeInteger(file.parentDev) || file.parentDev !== repository.dev
          || file.parentIdentity.split(':')[0] !== String(file.parentDev)
          || (file.bytes === null ? file.hash !== null : typeof file.bytes !== 'string' || file.bytes.length > 2 * fileLimit)) throw error('WORKER_FAILED');
        if (file.bytes !== null) {
          const bytes = Buffer.from(file.bytes, 'base64'); total += bytes.length;
          if (bytes.length > fileLimit || total > totalLimit || bytes.toString('base64') !== file.bytes || hash(bytes) !== file.hash) throw error('WORKER_FAILED');
        }
        // No output pathname becomes authority. Reconstruct the source parent
        // only from the already validated request, retaining the child's pin.
        const parent = { path: path.dirname(path.join(repository.path, paths[index])),
          identity: file.parentIdentity, dev: file.parentDev, name: path.posix.basename(paths[index]) };
        return { path: names[index], hash: file.hash, bytes: file.bytes, parent };
      });
      checkRoots();
      // Fresh post-reply namespace checks, without launching another process.
      // The child already re-traversed against its held identities; reject a
      // parent replacement/symlink occurring after that reply as well.
      const parents = new Map();
      for (const { parent } of entries) {
        if (parents.has(parent.path) && parents.get(parent.path).identity !== parent.identity) throw error('WORKER_FAILED');
        parents.set(parent.path, parent);
      }
      for (const parent of parents.values()) verifyParent(parent);
      return entries;
  }
  function verifyParent(parent) {
      let currentPath = repository.path;
      for (const part of path.relative(repository.path, parent.path).split(path.sep).filter(Boolean)) {
        const directory = fs.opendirSync(currentPath); let count = 0, matches = 0, exact = false;
        try {
          let entry;
          while ((entry = directory.readSync()) !== null) {
            if (++count > 10000) throw error('DIRECTORY_LIMIT');
            if (portablePathKey(entry.name) === portablePathKey(part)) { matches++; exact ||= entry.name === part; }
          }
        } finally { directory.closeSync(); }
        if (matches !== 1 || !exact) throw error('PATH_ALIAS');
        currentPath = path.join(currentPath, part);
        const current = fs.lstatSync(currentPath);
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== repository.dev) throw error('DIRECTORY_CHANGED');
      }
      if (directory(parent.path).identity !== parent.identity) throw error('DIRECTORY_CHANGED');
  }
  function applyTask(plan) {
    return locked(() => {
      let snapshot;
      try {
        snapshot = inspectTransaction(plan);
        inspectRequestIdentity(plan, session.get(snapshot.requestId.toLowerCase()) ?? null);
        checkRoots();
      } catch (failure) {
        const rejected = error(failure?.code ?? 'FAILED'); preflightFailures.add(rejected); throw rejected;
      }
      const reply = runWorker(repository, 'transaction', { context: {
        options: { ...options, repositoryRoot: repository.path, recoveryRoot: recovery.path },
        repositoryIdentity: repository.identity, recoveryIdentity: recovery.identity }, request: wire(snapshot) });
      checkRoots();
      if (isExactDataRecord(reply, ['ok', 'phase', 'code']) && reply.ok === true && reply.phase === 'preflight'
        && typeof reply.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(reply.code)) {
        const rejected = error(reply.code); preflightFailures.add(rejected); throw rejected;
      }
      if (!isExactDataRecord(reply, ['ok', 'phase', 'result', 'parents']) || reply.ok !== true || reply.phase !== 'result'
        || !Array.isArray(reply.parents)) throw error('WORKER_FAILED');
      const value = reply.result, common = ['status', 'requestId', 'fingerprint', 'savedLocally', 'gitEffects', 'publication'];
      const keys = value?.status === 'manual-recovery' ? [...common, 'retained', ...(Object.hasOwn(value, 'code') ? ['code'] : [])]
        : [...common, 'writes', ...(Object.hasOwn(value ?? {}, 'replay') ? ['replay'] : [])];
      if (!isExactDataRecord(value, keys) || !['completed', 'no-op', 'manual-recovery'].includes(value.status)
        || value.requestId !== snapshot.requestId || value.fingerprint !== snapshot.fingerprint || value.gitEffects !== false
        || value.savedLocally !== (value.status === 'completed') || typeof value.publication !== 'boolean'
        || (value.status === 'manual-recovery' ? value.publication !== false || !Array.isArray(value.retained)
          || value.retained.some(name => typeof name !== 'string') : !Number.isSafeInteger(value.writes)
          || value.writes < 0 || value.writes > snapshot.changedFiles.length
          || (Object.hasOwn(value, 'replay') && (value.replay !== true || value.writes !== 0 || value.publication !== false)))) throw error('WORKER_FAILED');
      if (value.status === 'completed' && !value.replay && (snapshot.noOp || value.writes !== snapshot.changedFiles.length || !value.publication)
        || value.status === 'no-op' && (!snapshot.noOp || value.writes !== 0 || value.publication || Object.hasOwn(value, 'replay'))
        || value.status === 'manual-recovery' && (value.retained.length > 1 + snapshot.changedFiles.length * 2
          || Object.hasOwn(value, 'code') && (typeof value.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.code)))) throw error('WORKER_FAILED');
      const expectedParents = value.status === 'completed' && !value.replay ? snapshot.changedFiles : [];
      if (reply.parents.length !== expectedParents.length) throw error('WORKER_FAILED');
      for (const [index, parent] of reply.parents.entries()) {
        if (!isExactDataRecord(parent, ['path', 'identity']) || parent.path !== expectedParents[index].path
          || typeof parent.identity !== 'string' || !/^\d+:\d+$/u.test(parent.identity)) throw error('WORKER_FAILED');
        verifyParent({ path: path.dirname(path.join(repository.path, options.spaceRoot === '.' ? '' : options.spaceRoot, parent.path)), identity: parent.identity });
      }
      if (value.status !== 'manual-recovery') remember(snapshot);
      return Object.freeze(value);
    });
  }
  return Object.freeze({
    preflight(plan) {
      return locked(() => {
        const snapshot = inspectTransaction(plan);
        if (snapshot.target.spaceId.toLowerCase() !== options.spaceId.toLowerCase()) throw error('DENIED');
        if (snapshot.expected.files.some(file => file.path.split('/').some(part => portablePathKey(part).startsWith('.ASMB-')))) throw error('RESERVED_PATH');
        if (listJournals().some(item => !['completed','retained-old'].includes(item.record.state))) throw error('RECOVERY_REQUIRED');
        if (snapshot.schemaVersion === 3) for (const name of snapshot.input.directories) if (directoryState(name).identity !== null) throw error('STALE');
        checkTransactionPreconditions(plan, { files: observed(snapshot).map(({path,hash}) => ({path,hash})) });
        return Object.freeze({ status: 'current', writes: 0 });
      });
    },
    inspectDirectory(relative) { const state = directoryState(relative); return Object.freeze({ identity: state.identity }); },
    inspectAsset(relative) { const current = readMany([relative], true, true)[0]; return Object.freeze({ path: relative, hash: current.hash,
      get bytes() { return current.bytes === null ? null : new Uint8Array(Buffer.from(current.bytes, 'base64')); } }); },
    inspect(relative) { const current = read(relative, true); return Object.freeze({ path: relative, hash: current.hash,
      readOnly: !isPortableRelativePath(relative), warnings: Object.freeze(isPortableRelativePath(relative) ? [] : ['NON_PORTABLE_PATH']),
      get bytes() { return current.bytes === null ? null : new Uint8Array(Buffer.from(current.bytes, 'base64')); } }); },
    inspectMany(relatives) {
      return Object.freeze(readMany(relatives).map(file => Object.freeze({ path: file.path, hash: file.hash,
        readOnly: !isPortableRelativePath(file.path), warnings: Object.freeze(isPortableRelativePath(file.path) ? [] : ['NON_PORTABLE_PATH']),
        get bytes() { return file.bytes === null ? null : new Uint8Array(Buffer.from(file.bytes, 'base64')); } })));
    },
    apply(plan, hooks = {}) {
      // Hooks are trusted in-process qualification hooks, never request fields.
      // The ordinary v2 path uses one short-lived task. Hook-bearing execution
      // runs this SAME engine locally, retaining every existing fault boundary.
      if (localExecute === null && inspectTransaction(plan).schemaVersion === 2 && Reflect.ownKeys(hooks).length === 0) return applyTask(plan);
      return locked(() => {
        let snapshot, current;
        try {
          snapshot = inspectTransaction(plan);
          if (snapshot.target.spaceId.toLowerCase() !== options.spaceId.toLowerCase()) throw error('DENIED');
          if (snapshot.expected.files.some(file => file.path.split('/').some(part => portablePathKey(part).startsWith('.ASMB-')))) throw error('RESERVED_PATH');
          const priorSession = session.get(snapshot.requestId.toLowerCase());
          inspectRequestIdentity(plan, priorSession ?? null);
          const receipt = readReceipts().record.receipts.find(item => item.requestId === snapshot.requestId.toLowerCase());
          if (receipt) {
            inspectRequestIdentity(plan, receipt);
            return result('completed', snapshot, { replay: true, writes: 0, publication: false });
          }
          const saved = readJournal(snapshot.requestId), existing = decodeJournal(saved);
          if (existing) {
            inspectRequestIdentity(plan, { requestId: existing.snapshot.requestId, fingerprint: existing.snapshot.fingerprint });
            if (existing.record.state !== 'completed') return result('manual-recovery', snapshot, { publication: false, retained: [journalName(snapshot.requestId)] });
            return result('completed', snapshot, { replay: true, writes: 0, publication: false });
          }
          if (listJournals().some(item => !['completed','retained-old'].includes(item.record.state))) throw error('RECOVERY_REQUIRED');
          if (snapshot.schemaVersion === 3) for (const name of snapshot.input.directories) {
            if (directoryState(name).identity !== null) throw error('STALE');
          }
          current = observed(snapshot);
          checkTransactionPreconditions(plan, { files: current.map(({ path, hash }) => ({ path, hash })) });
          if (snapshot.noOp) {
            remember(snapshot);
            return result('no-op', snapshot, { writes: 0, publication: false });
          }
        } catch (failure) {
          // No stage, source write or recovery maintenance has started. Brand a
          // fresh error so this classification does not mutate the original.
          const rejected = error(failure?.code ?? 'FAILED');
          preflightFailures.add(rejected); throw rejected;
        }
        // May publish/retire recovery receipts: deliberately outside preflight.
        maintainCompleted(hooks);
        const fileMode = snapshot.schemaVersion === 3, fileLimit = fileMode ? 4 * FILE_LIMIT : FILE_LIMIT;
        const record = { schemaVersion: fileMode ? 2 : 1, repositoryIdentity: repository.identity, spaceId: options.spaceId.toLowerCase(), spaceRoot: options.spaceRoot,
          request: wire(snapshot), fingerprint: snapshot.fingerprint, state: fileMode ? 'preparing' : 'prepared',
          ...(fileMode ? { directories: snapshot.input.directories.map(path => ({ path, identity: null })) } : {}),
          prior: snapshot.files.map(file => { const old = current.find(item => item.path === file.path); return { path: file.path, hash: old.hash, bytes: old.bytes }; }),
          stages: [], progress: [] };
        let journalHash = null;
        try {
          if (fileMode) {
            hooks.at?.('before-file-intent');
            journalHash = writeJournal(record, null); hooks.at?.('after-file-intent');
            for (const item of record.directories) {
              const before = directoryState(item.path); if (before.identity !== null) throw error('STALE');
              hooks.at?.('before-mkdir');
              const created = run(before.parent, 'mkdir', { name: before.parent.name });
              hooks.at?.('after-mkdir');
              if (directoryState(item.path).identity !== created.identity) throw error('DIRECTORY_CHANGED');
              item.identity = created.identity; journalHash = writeJournal(record, journalHash);
            }
            current = observed(snapshot);
            checkTransactionPreconditions(plan, { files: current.map(({ path, hash }) => ({ path, hash })) });
          }
          snapshot.changedFiles.forEach((file, index) => {
            const parent = current.find(item => item.path === file.path).parent;
            const name = `.asmb-${snapshot.requestId.toLowerCase()}-${index}`;
            if (file.bytes !== null) run(parent, 'stage', { name, candidateHash: file.hash, bytes: Buffer.from(file.bytes).toString('base64') }, fileLimit);
            record.stages.push({ path: file.path, name, previous: name+'-previous', parentIdentity: parent.identity });
            if (fileMode) { journalHash = writeJournal(record, journalHash); hooks.at?.('after-file-stage', index); }
          });
          hooks.at?.('before-journal');
          record.state = 'prepared'; journalHash = writeJournal(record, journalHash); hooks.at?.('after-journal');
          checkTransactionPreconditions(plan, { files: observed(snapshot).map(({ path, hash }) => ({ path, hash })) });
          for (const item of record.directories ?? []) if (directoryState(item.path).identity !== item.identity) throw error('DIRECTORY_CHANGED');
          for (let index = 0; index < snapshot.changedFiles.length; index += 1) {
            const file = snapshot.changedFiles[index], stage = record.stages[index], parent = parentFor(file.path);
            if (parent.identity !== stage.parentIdentity) throw error('DIRECTORY_CHANGED');
            hooks.at?.('before-replace', index);
            run(parent, file.bytes === null ? 'detach' : 'replace', { name: parent.name, stage: stage.name,
              previous: stage.previous, expectedHash: file.expectedHash, candidateHash: file.hash }, fileLimit);
            // A displaced original directory is not a valid published path.
            if (parentFor(file.path).identity !== parent.identity) throw error('DIRECTORY_CHANGED');
            record.state = 'applying'; record.progress.push(file.path);
            journalHash = writeJournal(record, journalHash); hooks.at?.('after-replace', index);
          }
          validateComplete(snapshot);
          record.state = 'completed'; journalHash = writeJournal(record, journalHash);
          hooks.at?.('after-completion');
          const completed = validateComplete(snapshot);
          // Return only the pins the engine actually validated, never repin a
          // new directory after completion while preparing the task response.
          captureParents?.(snapshot.changedFiles.map(file => ({ path: file.path,
            identity: completed.find(current => current.path === file.path).parent.identity })));
          for (const stage of record.stages) {
            const file=snapshot.files.find(file=>file.path===stage.path), parent=parentFor(stage.path);
            if(parent.identity!==stage.parentIdentity) throw error('DIRECTORY_CHANGED');
            run(parent,'cleanup',{name:stage.previous,expectedHash:file.expectedHash}, fileLimit);
          }
          remember(snapshot);
          hooks.publish?.(Object.freeze({ requestId: snapshot.requestId, fingerprint: snapshot.fingerprint }));
          return result('completed', snapshot, { writes: snapshot.changedFiles.length, publication: true });
        } catch (failure) {
          return result('manual-recovery', snapshot, { code: failure.code ?? 'FAILED', publication: false,
            retained: [journalHash ? journalName(snapshot.requestId) : 'uncommitted-stages', ...record.stages.flatMap(stage => [stage.path + ':' + stage.name, stage.path + ':' + stage.previous])] });
        }
      });
    },
    // Query only: terminal receipts describe history, not verified current files.
    // Malformed/unbound journals fail closed through listJournals; never report
    // an unreadable recovery directory as empty or silently repair it here.
    inspectRecovery() {
      return locked(() => {
        const records = new Map(readReceipts().record.receipts.map(item => [item.requestId,
          { requestId: item.requestId, state: 'completed' }]));
        for (const { record } of listJournals()) records.set(record.request.requestId,
          { requestId: record.request.requestId, state: record.state });
        const entries = Object.freeze([...records.values()].map(Object.freeze));
        return Object.freeze({ blocked: entries.some(entry => !['completed', 'retained-old'].includes(entry.state)),
          entries, scope: 'journals-only', currentStateValidated: false, publication: false });
      });
    },
    recover() {
      return locked(() => {
        const journals = listJournals(), current = new Set(journals.map(item => item.snapshot.requestId.toLowerCase()));
        const prior = readReceipts().record.receipts.filter(item => !current.has(item.requestId)).map(item =>
          result('completed', item, { publication: false, historical: true, currentStateValidated: false, recovered: false }));
        return [...prior, ...journals.map(({ record, snapshot, journalHash }) => {
        // Terminal receipts describe history, not the current working copy. A
        // later valid edit/undo must never reinterpret an earlier outcome.
        if (['completed','retained-old'].includes(record.state)) return result(record.state, snapshot,
          { publication: false, historical: true, currentStateValidated: false, recovered: false });
        try {
          for (const item of record.directories ?? []) {
            const actual = directoryState(item.path).identity;
            // A crash after mkdir but before its inode receipt cannot establish
            // ownership. Preserve the directory and require manual review.
            if (actual !== item.identity) throw error('DIRECTORY_CHANGED');
          }
          for (const stage of record.stages) if (parentFor(stage.path).identity !== stage.parentIdentity) throw error('DIRECTORY_CHANGED');
          const current = observed(snapshot), candidates = new Map(snapshot.files.map(file => [file.path, file.hash]));
          const allNew = current.every(file => file.hash === (candidates.has(file.path) ? candidates.get(file.path) : snapshot.expected.files.find(item => item.path === file.path).hash));
          const allOld = current.every(file => file.hash === snapshot.expected.files.find(item => item.path === file.path).hash);
          if (allNew) {
            if (record.stages.length !== snapshot.changedFiles.length) throw error('CONFLICT_EXTERNAL');
            record.state = 'completed'; writeJournal(record, journalHash); return result('completed', snapshot, { publication: false, recovered: true });
          }
          if (allOld) { record.state = 'retained-old'; writeJournal(record, journalHash); return result('retained-old', snapshot, { publication: false, retained: [journalName(snapshot.requestId)] }); }
          // Mixed or externally changed content is not silently rolled back.
          // Every prior/candidate remains in the private journal for manual choice.
          return result('manual-recovery', snapshot, { code: 'CONFLICT_EXTERNAL', publication: false, retained: [journalName(snapshot.requestId)] });
        } catch (failure) { return result('manual-recovery', snapshot, { code: failure.code ?? 'FAILED', publication: false, retained: [journalName(snapshot.requestId)] }); }
        })];
      });
    },
  });
}
