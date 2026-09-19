import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { isIdentity } from '../domain/identity.mjs';
import { isPortableRelativePath, portablePathKey } from '../domain/path-policy.mjs';
import { OPERATION_SCHEMAS, TRANSACTION_LIMITS } from '../../schemas/operations.mjs';

export { TRANSACTION_LIMITS } from '../../schemas/operations.mjs';
const plans = new WeakMap();
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthOf = Object.getOwnPropertyDescriptor(typedArray, 'byteLength').get;
const bufferOf = Object.getOwnPropertyDescriptor(typedArray, 'buffer').get;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function invalid(label) { fail('INVALID_OPERATION', `${label} does not match the strict operation schema.`); }

// Walk only own data descriptors. Reject proxies before any reflective access;
// getters, iterators, toJSON and caller-owned typed-array properties never run.
function snapshot(input, schema, label = 'Request', budget = { bytes: 0 }) {
  switch (schema.type) {
    case 'literal': if (input !== schema.value) invalid(label); return input;
    case 'uuid': if (!isIdentity(input)) invalid(label); return input;
    case 'hash': if (!isHash(input)) invalid(label); return input;
    case 'nullableHash': if (input !== null && !isHash(input)) invalid(label); return input;
    case 'path':
      if (!isPortableRelativePath(input) || !input.isWellFormed()) invalid(label);
      return input;
    case 'nullableBytes': if (input === null) return null;
    // falls through: the same intrinsic snapshot and aggregate budget apply.
    case 'bytes': {
      if (types.isProxy(input) || !types.isUint8Array(input)) invalid(label);
      if (types.isSharedArrayBuffer(bufferOf.call(input))) invalid(label);
      const byteLength = byteLengthOf.call(input);
      if (byteLength > schema.maxBytes) fail('LIMIT_EXCEEDED', `${label} exceeds its byte limit.`);
      budget.bytes += byteLength;
      if (budget.bytes > TRANSACTION_LIMITS.totalBytes) fail('LIMIT_EXCEEDED', 'Transaction exceeds its total byte limit.');
      // The typed-array constructor uses intrinsic typed-array storage, not
      // Symbol.iterator, buffer, constructor or species supplied by the caller.
      try { return new Uint8Array(input); } catch { invalid(label); }
      break;
    }
    case 'record': {
      if (types.isProxy(input) || input === null || typeof input !== 'object') invalid(label);
      if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid(label);
      const fields = Object.keys(schema.properties);
      const keys = Reflect.ownKeys(input);
      if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) invalid(label);
      const result = {};
      for (const key of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid(`${label}.${key}`);
        result[key] = snapshot(descriptor.value, schema.properties[key], `${label}.${key}`, budget);
      }
      return result;
    }
    case 'array': {
      if (types.isProxy(input) || !Array.isArray(input)) invalid(label);
      if (![Array.prototype, null].includes(Object.getPrototypeOf(input))) invalid(label);
      const count = Object.getOwnPropertyDescriptor(input, 'length').value;
      if (count > schema.maxItems) fail('LIMIT_EXCEEDED', `${label} exceeds its item limit.`);
      if (Reflect.ownKeys(input).length !== count + 1) invalid(label);
      const result = [];
      for (let index = 0; index < count; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid(label);
        result.push(snapshot(descriptor.value, schema.items, `${label}[${index}]`, budget));
      }
      return result;
    }
    default: throw new Error('Unknown internal operation schema.');
  }
}

const comparePath = (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
function pathMap(files, label) {
  const byKey = new Map();
  for (const file of files) {
    const key = portablePathKey(file.path);
    if (byKey.has(key)) fail('PATH_COLLISION', `${label} has colliding paths.`);
    byKey.set(key, file);
  }
  return byKey;
}
function checkUnionPaths(request) {
  const unique = new Map();
  for (const file of [...request.expected.files, ...request.input.files, ...request.input.assets]) {
    const key = portablePathKey(file.path);
    if (unique.has(key) && unique.get(key) !== file.path) fail('PATH_COLLISION', 'Path spelling aliases are ambiguous.');
    unique.set(key, file.path);
  }
  for (const key of unique.keys()) {
    const parts = key.split('/');
    for (let count = 1; count < parts.length; count++) {
      if (unique.has(parts.slice(0, count).join('/'))) fail('PATH_COLLISION', 'A file path is another file path ancestor.');
    }
  }
}

function fingerprint(request) {
  const digest = createHash('sha256');
  // Fixed-field JSON plus length-prefixed raw bytes is unambiguous and avoids
  // base64 expansion. Ordering is canonical; exact path/UUID spelling is bound.
  digest.update('asMagicBrain.prepareTransaction.v1\n');
  digest.update(JSON.stringify({ schemaVersion: request.schemaVersion,
    requestId: request.requestId, target: request.target, expected: request.expected,
    assets: request.input.assets, ...(request.schemaVersion === 3 ? { directories: request.input.directories } : {}),
    files: request.input.files.map(({ path, bytes }) => ({ path, byteLength: bytes === null ? null : bytes.length })) }));
  digest.update('\n');
  for (const file of request.input.files) if (file.bytes !== null) digest.update(file.bytes);
  return digest.digest('hex');
}

/** Pure preparation; validates declared dependencies but performs zero reads/writes. */
export function prepareTransaction(input) {
  return prepare(input, OPERATION_SCHEMAS.transaction);
}
export function prepareSourceTransaction(input) {
  return prepare(input, OPERATION_SCHEMAS.sourceTransaction);
}
export function prepareFileTransaction(input) {
  return prepare(input, OPERATION_SCHEMAS.fileTransaction);
}
const schemaFor = version => version === 3 ? OPERATION_SCHEMAS.fileTransaction
  : version === 2 ? OPERATION_SCHEMAS.sourceTransaction : OPERATION_SCHEMAS.transaction;
function prepare(input, schema) {
  const request = snapshot(input, schema);
  let totalBytes = 0;
  for (const file of request.input.files) {
    totalBytes += file.bytes?.length ?? 0;
    if (totalBytes > TRANSACTION_LIMITS.totalBytes) fail('LIMIT_EXCEEDED', 'Transaction exceeds its total byte limit.');
  }
  const expected = pathMap(request.expected.files, 'Expected files');
  const candidates = pathMap(request.input.files, 'Candidate files');
  pathMap(request.input.assets, 'Assets');
  checkUnionPaths(request);
  if (request.schemaVersion === 3) {
    const directories = request.input.directories;
    if (new Set(directories.map(portablePathKey)).size !== directories.length) fail('PATH_COLLISION', 'Directory aliases are ambiguous.');
    for (const directory of directories) {
      if ([...request.expected.files, ...request.input.files].some(file => portablePathKey(file.path) === portablePathKey(directory)
        || portablePathKey(directory).startsWith(portablePathKey(file.path) + '/'))
        || !request.input.files.some(file => file.bytes !== null && file.path.startsWith(directory + '/'))
        || request.expected.files.some(file => file.path.startsWith(directory + '/') && file.hash !== null)
        || directories.some(other => other !== directory && directory.startsWith(other + '/'))) fail('INVALID_PRECONDITIONS', 'Only independent expected-absent candidate parents can be created.');
    }
    directories.sort();
  }
  const files = request.input.files.map(({ path, bytes }) => {
    const before = expected.get(portablePathKey(path));
    if (!before) fail('INVALID_PRECONDITIONS', 'Every candidate needs an exact expected hash or absence.');
    const hash = bytes === null ? null : sha256(bytes);
    return { path, bytes, hash, expectedHash: before.hash, changed: hash !== before.hash };
  }).sort(comparePath);
  const fileByKey = new Map(files.map((file) => [portablePathKey(file.path), file]));
  const required = new Set(candidates.keys());
  for (const asset of request.input.assets) {
    const key = portablePathKey(asset.path);
    const candidate = fileByKey.get(key);
    if (candidate) {
      if (candidate.hash !== asset.hash) fail('INVALID_ASSET', 'Asset hash does not match its candidate bytes.');
    } else {
      const before = expected.get(key);
      if (!before || before.hash !== asset.hash) fail('INVALID_ASSET', 'Existing asset needs the matching non-null expected hash.');
      required.add(key);
    }
  }
  if (expected.size !== required.size || [...expected.keys()].some((key) => !required.has(key))) {
    fail('INVALID_PRECONDITIONS', 'Expected paths must exactly match candidate files and existing asset dependencies.');
  }
  request.expected.files.sort(comparePath);
  request.input.files.sort(comparePath);
  request.input.assets.sort(comparePath);
  const handle = Object.freeze(Object.create(null));
  plans.set(handle, { request, files, totalBytes, fingerprint: fingerprint(request) });
  return handle;
}

function trustedPlan(handle) {
  const plan = plans.get(handle);
  if (!plan) fail('INVALID_TRANSACTION_PLAN', 'Use the original prepareTransaction handle.');
  return plan;
}

/** Read-only query: no actor or fabricated mutation preconditions required. */
export function inspectTransaction(handle) {
  const plan = trustedPlan(handle);
  const request = snapshot(plan.request, schemaFor(plan.request.schemaVersion));
  const files = plan.files.map((file) => ({ ...file, bytes: file.bytes === null ? null : new Uint8Array(file.bytes) }));
  return { ...request, fingerprint: plan.fingerprint, files,
    changedFiles: files.filter((file) => file.changed).map((file) => ({ ...file, bytes: file.bytes === null ? null : new Uint8Array(file.bytes) })),
    noOp: files.every((file) => !file.changed), totalBytes: plan.totalBytes, writes: 0 };
}

/** Compare trusted adapter observations; this does not read or lock a filesystem. */
export function checkTransactionPreconditions(handle, input) {
  const plan = trustedPlan(handle);
  const observed = snapshot(input, plan.request.schemaVersion >= 2 ? OPERATION_SCHEMAS.sourceObserved : OPERATION_SCHEMAS.observed);
  const actual = pathMap(observed.files, 'Observed files');
  if (actual.size !== plan.request.expected.files.length) fail('INVALID_PRECONDITIONS', 'Observations must cover exactly the expected paths.');
  for (const expected of plan.request.expected.files) {
    const file = actual.get(portablePathKey(expected.path));
    if (!file || file.path !== expected.path) fail('INVALID_PRECONDITIONS', 'Observations must use exactly the expected paths.');
    if (file.hash !== expected.hash) fail('STALE', 'A current hash or absence differs from the declared base.');
  }
  return Object.freeze({ status: 'current' });
}

/** Identity comparison only. The trusted host owns durable outcomes and locks. */
export function inspectRequestIdentity(handle, prior) {
  const plan = trustedPlan(handle);
  if (prior === null) return Object.freeze({ status: 'fresh', requestId: plan.request.requestId, fingerprint: plan.fingerprint });
  const identity = snapshot(prior, OPERATION_SCHEMAS.identity);
  if (identity.requestId !== plan.request.requestId) fail('INVALID_REQUEST_IDENTITY', 'Ledger lookup returned another request ID.');
  if (identity.fingerprint !== plan.fingerprint) fail('REQUEST_ID_REUSED', 'Request ID already belongs to different input.');
  return Object.freeze({ status: 'replay', requestId: plan.request.requestId, fingerprint: plan.fingerprint });
}
