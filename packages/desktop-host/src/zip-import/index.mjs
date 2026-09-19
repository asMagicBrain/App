import {persistentIdentity} from '../../../source-foundation/src/adapters/storage-identity.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {crc32, inflateRawSync} from 'node:zlib';
import {pinDirectory, checkDirectory} from '../physical-roots.mjs';
import {isPortableRelativePath, portablePathKey} from '../../../source-foundation/src/domain/path-policy.mjs';

// Bounds apply to one untrusted archive, including entries excluded from output.
// They limit memory, CPU and staging disk consumption, not repository lifetime.
export const ZIP_IMPORT_LIMITS = Object.freeze({
  archiveBytes: 256 * 1024 * 1024,
  expandedBytes: 512 * 1024 * 1024,
  memberBytes: 64 * 1024 * 1024,
  entries: 20000,
  extractedEntries: 9999, // Reserve one host-discovery entry for the generated .git directory.
  pathBytes: 4096,
  pathDepth: 32,
});

const fail = code => { throw Object.assign(new Error(code), {code}); };
const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const u16 = (bytes, offset) => bytes.readUInt16LE(offset);
const u32 = (bytes, offset) => bytes.readUInt32LE(offset);
function range(bytes, offset, size, end = bytes.length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > end) fail('ZIP_INVALID');
}
function snapshot(input) {
  if (!(input instanceof Uint8Array)) fail('ZIP_INVALID');
  if (input.byteLength > ZIP_IMPORT_LIMITS.archiveBytes) fail('ZIP_LIMIT_EXCEEDED');
  if (input.byteLength < 22) fail('ZIP_INVALID');
  // A caller cannot change parser input between validation and extraction.
  if (input.buffer instanceof SharedArrayBuffer) fail('ZIP_INVALID');
  return Buffer.from(input);
}
function decode(bytes) {
  try { return decoder.decode(bytes); } catch { fail('ZIP_UNSUPPORTED'); }
}
function validateName(raw) {
  const name = decode(raw), isDirectory = name.endsWith('/');
  if (!name || name.startsWith('/') || /^[A-Za-z]:/u.test(name) || /[\\\x00-\x1f\x7f]/u.test(name)) fail('ZIP_UNSAFE_PATH');
  if (raw.length > ZIP_IMPORT_LIMITS.pathBytes) fail('ZIP_LIMIT_EXCEEDED');
  const parts = (isDirectory ? name.slice(0, -1) : name).split('/');
  if (parts.length > ZIP_IMPORT_LIMITS.pathDepth) fail('ZIP_LIMIT_EXCEEDED');
  if (parts.some(part => !part || part === '.' || part === '..')) fail('ZIP_UNSAFE_PATH');
  if (parts.some(part => Buffer.byteLength(part) > 255)) fail('ZIP_LIMIT_EXCEEDED');
  // The editor's source policy must accept imported names. .git itself is the
  // only exception: its spelling is validated here and its whole subtree omitted.
  const relative = parts.join('/');
  if (relative.length > 1024 || !isPortableRelativePath(parts.map(part => part.toLowerCase() === '.git' ? 'git' : part).join('/'))) fail('ZIP_UNSAFE_PATH');
  return {name, parts, isDirectory};
}
function extraFields(bytes, offset, length, rawName) {
  const end = offset + length;
  range(bytes, offset, length);
  while (offset < end) {
    range(bytes, offset, 4, end);
    const tag = u16(bytes, offset), size = u16(bytes, offset + 2);
    offset += 4;
    range(bytes, offset, size, end);
    if (tag === 1 || tag === 0x9901) fail('ZIP_UNSUPPORTED'); // ZIP64 / AES
    // Some writers provide a second Unicode name. Ambiguity is never extracted.
    if (tag === 0x7075) {
      if (size < 5 || bytes[offset] !== 1 || u32(bytes, offset + 1) !== crc32(rawName)
        || decode(bytes.subarray(offset + 5, offset + size)) !== decode(rawName)) fail('ZIP_UNSAFE_PATH');
    }
    offset += size;
  }
}
function addToNamespace(namespace, entry) {
  let spelling = '';
  for (let i = 0; i < entry.parts.length; i++) {
    spelling += `${i ? '/' : ''}${entry.parts[i]}`;
    const key = portablePathKey(spelling), leaf = i === entry.parts.length - 1;
    const kind = leaf ? entry.kind : 'directory', prior = namespace.get(key);
    if (prior && (prior.spelling !== spelling || prior.kind !== kind || (leaf && prior.explicit))) fail('ZIP_CONFLICT');
    if (!prior) namespace.set(key, {spelling, kind, explicit: leaf});
    else if (leaf) prior.explicit = true;
  }
}
function skipPath(parts) {
  return parts.some(part => {
    const key = portablePathKey(part);
    return ['.GIT', '__MACOSX', '.DS_STORE', '.ASMAGICBRAIN'].includes(key) || key.startsWith('.ASMB-');
  });
}
function content(bytes, entry) {
  const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  let result;
  if (entry.method === 0) result = compressed;
  else {
    try {
      const inflated = inflateRawSync(compressed, {maxOutputLength: Math.max(1, entry.size), info: true});
      if (inflated.engine.bytesWritten !== compressed.length) fail('ZIP_INTEGRITY');
      result = inflated.buffer;
    } catch { fail('ZIP_INTEGRITY'); }
  }
  if (result.length !== entry.size || crc32(result) !== entry.crc32) fail('ZIP_INTEGRITY');
  return result;
}

function parse(bytes, stripRoot) {
  if (typeof stripRoot !== 'boolean') fail('ZIP_INVALID');
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (u32(bytes, offset) === 0x06054b50 && offset + 22 + u16(bytes, offset + 20) === bytes.length) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) fail('ZIP_INVALID');
  const count = u16(bytes, endOffset + 10), centralSize = u32(bytes, endOffset + 12), centralOffset = u32(bytes, endOffset + 16);
  if (u16(bytes, endOffset + 4) || u16(bytes, endOffset + 6) || u16(bytes, endOffset + 8) !== count
    || count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('ZIP_UNSUPPORTED');
  if (count > ZIP_IMPORT_LIMITS.entries) fail('ZIP_LIMIT_EXCEEDED');
  range(bytes, centralOffset, centralSize, endOffset);
  if (centralOffset + centralSize !== endOffset) fail('ZIP_INVALID');
  const entries = [], namespace = new Map();
  let cursor = centralOffset, expandedBytes = 0;
  for (let index = 0; index < count; index++) {
    range(bytes, cursor, 46, endOffset);
    if (u32(bytes, cursor) !== 0x02014b50) fail('ZIP_INVALID');
    const version = u16(bytes, cursor + 6), flags = u16(bytes, cursor + 8), method = u16(bytes, cursor + 10);
    const checksum = u32(bytes, cursor + 16), compressedSize = u32(bytes, cursor + 20), size = u32(bytes, cursor + 24);
    const nameSize = u16(bytes, cursor + 28), extraSize = u16(bytes, cursor + 30), commentSize = u16(bytes, cursor + 32);
    const attributes = u32(bytes, cursor + 38), localOffset = u32(bytes, cursor + 42);
    if (version > 20 || (flags & ~0x080e) || ![0, 8].includes(method) || (method === 0 && (flags & 6))
      || u16(bytes, cursor + 34) || [compressedSize, size, localOffset].includes(0xffffffff)) fail('ZIP_UNSUPPORTED');
    range(bytes, cursor + 46, nameSize + extraSize + commentSize, endOffset);
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameSize), named = validateName(rawName);
    extraFields(bytes, cursor + 46 + nameSize, extraSize, rawName);
    const type = (attributes >>> 16) & 0xf000, dosDirectory = Boolean(attributes & 0x10);
    if ((type && ![0x4000, 0x8000].includes(type)) || (attributes & 8)) fail('ZIP_UNSUPPORTED');
    if ((type === 0x4000 || dosDirectory) && !named.isDirectory || type === 0x8000 && named.isDirectory) fail('ZIP_INVALID');
    if (size > ZIP_IMPORT_LIMITS.memberBytes || (expandedBytes += size) > ZIP_IMPORT_LIMITS.expandedBytes) fail('ZIP_LIMIT_EXCEEDED');
    if (method === 0 && size !== compressedSize || named.isDirectory && (size || checksum)) fail('ZIP_INTEGRITY');

    range(bytes, localOffset, 30, centralOffset);
    if (u32(bytes, localOffset) !== 0x04034b50 || u16(bytes, localOffset + 4) !== version
      || u16(bytes, localOffset + 6) !== flags || u16(bytes, localOffset + 8) !== method) fail('ZIP_INVALID');
    const localNameSize = u16(bytes, localOffset + 26), localExtraSize = u16(bytes, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameSize + localExtraSize;
    range(bytes, localOffset + 30, localNameSize + localExtraSize + compressedSize, centralOffset);
    if (!rawName.equals(bytes.subarray(localOffset + 30, localOffset + 30 + localNameSize))) fail('ZIP_UNSAFE_PATH');
    extraFields(bytes, localOffset + 30 + localNameSize, localExtraSize, rawName);
    const localValues = [u32(bytes, localOffset + 14), u32(bytes, localOffset + 18), u32(bytes, localOffset + 22)];
    const centralValues = [checksum, compressedSize, size];
    if (localValues.some((value, i) => value !== centralValues[i] && (!(flags & 8) || value !== 0))) fail('ZIP_INTEGRITY');
    let localEnd = dataOffset + compressedSize;
    if (flags & 8) {
      const matches = [];
      for (const signatureBytes of [0, 4]) {
        if (localEnd + signatureBytes + 12 > centralOffset) continue;
        if (signatureBytes && u32(bytes, localEnd) !== 0x08074b50) continue;
        if (centralValues.every((value, i) => value === u32(bytes, localEnd + signatureBytes + 4 * i))) matches.push(signatureBytes + 12);
      }
      if (matches.length !== 1) fail('ZIP_INTEGRITY');
      localEnd += matches[0];
    }
    const entry = {archivePath: named.name, parts: named.parts, kind: named.isDirectory ? 'directory' : 'file',
      size, compressedSize, crc32: checksum, mode: named.isDirectory ? 0o700 : ((attributes >>> 16) & 0o111 ? 0o700 : 0o600),
      skipped: skipPath(named.parts), dataOffset, method, localOffset, localEnd};
    addToNamespace(namespace, entry);
    entries.push(entry);
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  if (cursor !== endOffset) fail('ZIP_INVALID');
  // Reject overlapping records, unindexed local records and self-extracting prefixes.
  let nextOffset = 0;
  for (const entry of [...entries].sort((a, b) => a.localOffset - b.localOffset)) {
    if (entry.localOffset !== nextOffset) fail('ZIP_INVALID');
    nextOffset = entry.localEnd;
  }
  if (nextOffset !== centralOffset) fail('ZIP_INVALID');
  const kept = entries.filter(entry => !entry.skipped), root = kept[0]?.parts[0];
  const rootDirectory = stripRoot && root && kept.every(entry => entry.parts[0] === root
    && (entry.parts.length > 1 || entry.kind === 'directory')) ? root : null;
  const outputNamespace = new Map();
  for (const entry of entries) {
    entry.path = entry.skipped ? null : entry.parts.slice(rootDirectory ? 1 : 0).join('/');
    if (!entry.skipped && entry.path) addToNamespace(outputNamespace, {...entry, parts: entry.path.split('/')});
  }
  if (outputNamespace.size > ZIP_IMPORT_LIMITS.extractedEntries) fail('ZIP_LIMIT_EXCEEDED');
  // Includes skipped metadata: a corrupt archive never reaches staging.
  for (const entry of entries) content(bytes, entry);
  const output = entries.filter(entry => !entry.skipped && entry.path);
  const summary = Object.freeze({archiveBytes: bytes.length, totalEntries: entries.length,
    fileCount: output.filter(entry => entry.kind === 'file').length,
    directoryCount: [...outputNamespace.values()].filter(entry => entry.kind === 'directory').length,
    expandedBytes: output.reduce((sum, entry) => sum + entry.size, 0),
    skippedEntries: entries.filter(entry => entry.skipped).length, rootDirectory});
  const manifest = Object.freeze({summary, entries: Object.freeze(entries.map(entry => Object.freeze({
    archivePath: entry.archivePath, path: entry.path, kind: entry.kind, size: entry.size,
    compressedSize: entry.compressedSize, crc32: entry.crc32, mode: entry.mode, skipped: entry.skipped,
  })))});
  return {entries, manifest};
}

/** Read-only, synchronous inspection. This also verifies expanded sizes and CRCs. */
export function inspectZip(input, {stripRoot = true} = {}) {
  return parse(snapshot(input), stripRoot).manifest;
}

/** Host-only extraction into an existing empty staging directory. The host owns
 * its private parent and must discard the entire stage on failure, then publish
 * only after its repository initialization/registry transaction succeeds.
 */
export function extractZip(input, {destination, stripRoot = true} = {}) {
  const bytes = snapshot(input), {entries, manifest} = parse(bytes, stripRoot);
  let root;
  try {
    root = pinDirectory(destination);
    if (fs.readdirSync(destination).length) fail('ZIP_DESTINATION_UNSAFE');
  } catch { fail('ZIP_DESTINATION_UNSAFE'); }
  const directories = new Map([['', root]]);
  function checkStageDirectory(pinned) {
    const live = fs.lstatSync(pinned.path);
    if (!live.isDirectory() || live.isSymbolicLink() || persistentIdentity(live) !== pinned.identity) fail('ZIP_DESTINATION_UNSAFE');
  }
  function ensureDirectory(relative) {
    let current = '';
    for (const part of relative ? relative.split('/') : []) {
      const parent = directories.get(current);
      current += `${current ? '/' : ''}${part}`;
      checkStageDirectory(parent);
      if (!directories.has(current)) {
        const absolute = path.join(root.path, current);
        fs.mkdirSync(absolute, {mode: 0o700});
        const stat = fs.lstatSync(absolute);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail('ZIP_DESTINATION_UNSAFE');
        directories.set(current, {path: absolute, identity: persistentIdentity(stat)});
      } else checkStageDirectory(directories.get(current));
    }
    return directories.get(relative);
  }
  for (const entry of entries) {
    if (entry.skipped || !entry.path) continue;
    checkDirectory(root);
    if (entry.kind === 'directory') { ensureDirectory(entry.path); continue; }
    const parent = ensureDirectory(entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '');
    checkStageDirectory(parent);
    const filename = path.join(root.path, entry.path);
    const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, entry.mode);
    try {
      const output = content(bytes, entry);
      fs.writeFileSync(fd, output);
      fs.fsyncSync(fd);
      const written = fs.fstatSync(fd), live = fs.lstatSync(filename);
      if (!written.isFile() || written.nlink !== 1 || written.size !== entry.size || written.dev !== live.dev || written.ino !== live.ino) fail('ZIP_DESTINATION_UNSAFE');
    } finally { fs.closeSync(fd); }
    checkStageDirectory(parent);
  }
  for (const pinned of [...directories.values()].reverse()) {
    checkDirectory(root);
    checkStageDirectory(pinned);
    const fd = fs.openSync(pinned.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  return manifest;
}
