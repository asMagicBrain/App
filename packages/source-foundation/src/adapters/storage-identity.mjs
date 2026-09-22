import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';

const storage = new AsyncLocalStorage();
const fields = ['schemaVersion', 'root', 'rootInode', 'owner', 'currentDevice', 'namespaceDevice', 'volumeId'];
const maxUnsigned = (1n << 64n) - 1n;
const fail = () => { throw Object.assign(new Error('RECOVERY_REQUIRED'), { code: 'RECOVERY_REQUIRED' }); };
function exact(value, keys) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const names = Reflect.ownKeys(value);
  return names.length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable;
  });
}
const deviceNumber = value => Number.isSafeInteger(value) && value >= 0;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;

// Native admission owns volume lookup and legacy recovery. This boundary only
// accepts its exact context and rechecks the physical root in each process.
function validate(value) {
  if (!exact(value, fields)) fail();
  const context = Object.freeze({ ...value });
  if (context.schemaVersion !== 1 || typeof context.root !== 'string' || !context.root.isWellFormed()
    || context.root.includes('\0') || context.root.length > 4096 || !path.isAbsolute(context.root)
    || path.normalize(context.root) !== context.root || context.root.endsWith(path.sep)
    || typeof context.rootInode !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(context.rootInode)
    || BigInt(context.rootInode) > maxUnsigned || !Number.isInteger(context.owner)
    || context.owner < 0 || context.owner > 0xffffffff
    || !deviceNumber(context.currentDevice) || !deviceNumber(context.namespaceDevice)
    || typeof context.volumeId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(context.volumeId)) fail();
  let fd;
  try {
    const ancestors = [];
    let current = path.parse(context.root).root;
    for (const part of ['', ...context.root.slice(current.length).split(path.sep)]) {
      if (part) current = path.join(current, part);
      const stat = fs.lstatSync(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
      ancestors.push({ path: current, stat });
    }
    const root = ancestors.at(-1).stat;
    if (root.dev !== BigInt(context.currentDevice) || root.ino.toString() !== context.rootInode
      || root.uid !== BigInt(context.owner) || fs.realpathSync(context.root) !== context.root) fail();
    fd = fs.openSync(context.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const held = fs.fstatSync(fd, { bigint: true });
    if (!held.isDirectory() || !same(held, root)) fail();
    for (const ancestor of ancestors) {
      const live = fs.lstatSync(ancestor.path, { bigint: true });
      if (!live.isDirectory() || live.isSymbolicLink() || !same(live, ancestor.stat)) fail();
    }
  } catch { fail(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return context;
}

export function runWithStorageIdentity(context, fn) {
  if (typeof fn !== 'function') fail();
  return storage.run(context === null ? null : validate(context), fn);
}

export function currentStorageIdentity() { return storage.getStore() ?? null; }

// A swap, rather than a one-way replacement, keeps distinct devices distinct.
// Only identity serialization uses this namespace; fs.Stats and raw device
// comparisons retain the operating system's values.
export function persistentDevice(dev) {
  if (typeof dev === 'bigint' ? dev < 0n || dev > maxUnsigned : !deviceNumber(dev)) fail();
  const context = currentStorageIdentity();
  if (!context) return dev;
  const current = typeof dev === 'bigint' ? BigInt(context.currentDevice) : context.currentDevice;
  const namespace = typeof dev === 'bigint' ? BigInt(context.namespaceDevice) : context.namespaceDevice;
  return dev === current ? namespace : dev === namespace ? current : dev;
}

export function persistentIdentity(stat) { return `${persistentDevice(stat.dev)}:${stat.ino}`; }

export function storageWorkerEnvelope(request) {
  const context = currentStorageIdentity();
  return context === null ? request : Object.freeze({ storageIdentity: context, request });
}

export function runStorageWorkerEnvelope(input, fn) {
  if (input !== null && typeof input === 'object' && 'storageIdentity' in input) {
    if (!exact(input, ['storageIdentity', 'request']) || input.storageIdentity === null) fail();
    return runWithStorageIdentity(input.storageIdentity, () => fn(input.request));
  }
  return runWithStorageIdentity(null, () => fn(input));
}
