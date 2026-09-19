import fs from 'node:fs';
import {createHash} from 'node:crypto';

export const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const fail = code => { throw Object.assign(new Error(code), {code}); };
const same = (a, b) => ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);

// Callers check the root and each parent component before and after this read.
// The descriptor and final pathname must still identify the same regular file.
export function openRawFile(filename, limit = MAX_ASSET_BYTES) {
  const before = fs.lstatSync(filename, {bigint: true});
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit)) fail('UNSAFE_FILE');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!same(before, fs.fstatSync(fd, {bigint: true}))) fail('CONFLICT');
    return {fd, size: Number(before.size), mode: before.mode & 0o111n ? '100755' : '100644',
      verify() {
        const after = fs.fstatSync(fd, {bigint: true}), live = fs.lstatSync(filename, {bigint: true});
        if (!same(before, after) || !same(before, live)) fail('CONFLICT');
      },
      close() { fs.closeSync(fd); },
    };
  } catch (error) { fs.closeSync(fd); throw error; }
}

export function hashRawFile(filename, {objectFormat = 'sha1', sync = false, limit = MAX_ASSET_BYTES} = {}) {
  const file = openRawFile(filename, limit);
  try {
    const hash = createHash('sha256'), object = createHash(objectFormat).update(`blob ${file.size}\0`);
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    let count = 0;
    while (count < file.size) {
      const read = fs.readSync(file.fd, chunk, 0, Math.min(chunk.length, file.size - count), count);
      if (!read) fail('CONFLICT');
      const bytes = chunk.subarray(0, read);
      hash.update(bytes); object.update(bytes); count += read;
    }
    if (sync) fs.fsyncSync(file.fd);
    file.verify();
    return {hash: hash.digest('hex'), sha: object.digest('hex'), size: file.size, mode: file.mode};
  } finally { file.close(); }
}
