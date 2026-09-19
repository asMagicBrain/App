import fs from 'node:fs';
import path from 'node:path';
import { portablePathKey } from '../../source-foundation/src/domain/path-policy.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const identity = stat => `${stat.dev}:${stat.ino}`;
export const contains = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const spellingCache = new Map();
const directoryStamp = value => `${value.dev}:${value.ino}:${value.mode}:${value.uid}:${value.mtimeNs}:${value.ctimeNs}`;
function names(directory) {
  const before = fs.lstatSync(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) fail('DENIED');
  const stamp = directoryStamp(before), cached = spellingCache.get(directory);
  if (cached?.stamp === stamp) {
    spellingCache.delete(directory); spellingCache.set(directory, cached);
    return cached.entries;
  }
  const handle = fs.opendirSync(directory), entries = [];
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (entries.length >= 10000) fail('LIMIT_EXCEEDED');
      entries.push(entry.name);
    }
    const after = fs.lstatSync(directory, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino
      || after.mode !== before.mode || after.uid !== before.uid) fail('DENIED');
    // Unrelated children of shared ancestors (notably /private/tmp) may change
    // during enumeration. Keep the original uncached spelling check behavior;
    // cache only a stable listing, never make ambient activity a permanent hold.
    if (directoryStamp(after) !== stamp) { spellingCache.delete(directory); return entries; }
    spellingCache.delete(directory);
    if (spellingCache.size >= 128) spellingCache.delete(spellingCache.keys().next().value);
    const result = Object.freeze(entries); spellingCache.set(directory, { stamp, entries: result });
    return result;
  } finally { handle.closeSync(); }
}

// Root admission is trusted host setup. Reject spelling aliases and symlinks in
// every ancestor instead of silently resolving a different supplied location.
export function pinDirectory(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root || root === path.parse(root).root) fail('INVALID');
  let current = path.parse(root).root;
  const chain = [];
  for (const part of root.slice(current.length).split(path.sep)) {
    const entries = names(current);
    const matches = entries.filter(name => portablePathKey(name) === portablePathKey(part));
    if (matches.length !== 1 || matches[0] !== part) fail('DENIED');
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('DENIED');
    chain.push({ path: current, identity: identity(stat), dev: stat.dev });
  }
  return Object.freeze({ path: root, identity: chain.at(-1).identity, dev: chain.at(-1).dev,
    chain: Object.freeze(chain.map(Object.freeze)) });
}

export function checkDirectory(pinned) {
  const live = pinDirectory(pinned.path);
  if (live.chain.length !== pinned.chain.length || live.chain.some((entry, index) => entry.identity !== pinned.chain[index].identity)) fail('DENIED');
}

// These are read-only spelling checks. File bytes always come from the qualified
// pinned-directory worker, which independently rejects links and special files.
export function checkSourceSpelling(root, relative) {
  let current = root;
  for (const part of relative.split('/')) {
    const entries = names(current);
    const matches = entries.filter(name => portablePathKey(name) === portablePathKey(part));
    if (!matches.length) fail('PARTIAL');
    if (matches.length !== 1 || matches[0] !== part) fail('DENIED');
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail('DENIED');
  }
}
