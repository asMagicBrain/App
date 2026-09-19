import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {crc32, deflateRawSync} from 'node:zlib';
import {extractZip, inspectZip, ZIP_IMPORT_LIMITS} from '../src/zip-import/index.mjs';

// A static archive produced independently by Python's standard-library zipfile.
// Contains a UTF-8 name, binary bytes, BOM/CRLF, explicit/implicit dirs and comment.
const PYTHON_ZIP = Buffer.from('UEsDBBQAAAAIANlkMF0AAAAAAgAAAAAAAAAQAAAAcmVwb3NpdG9yeS1tYWluLwMAUEsDBBQAAAAIANlkMF1r2jhBDwAAAA0AAAAZAAAAcmVwb3NpdG9yeS1tYWluL1JFQURNRS5tZHu/e7+yQnFibkFOKi8XAFBLAwQUAAAICADZZDBdBJCf0AkAAAAHAAAAIAAAAHJlcG9zaXRvcnktbWFpbi/otYTmlpkv56yU6K6wLm1kezat/dmcNVwAUEsDBBQAAAAIANlkMF2U9MN0CAAAAAYAAAAgAAAAcmVwb3NpdG9yeS1tYWluL2Fzc2V0cy9pbWFnZS5iaW5j+N/AxfsPAFBLAwQUAAAACADZZDBdAAAAAAIAAAAAAAAAFgAAAHJlcG9zaXRvcnktbWFpbi9lbXB0eS8DAFBLAQIUAxQAAAAIANlkMF0AAAAAAgAAAAAAAAAQAAAAAAAAAAAAEAD9QQAAAAByZXBvc2l0b3J5LW1haW4vUEsBAhQDFAAAAAgA2WQwXWvaOEEPAAAADQAAABkAAAAAAAAAAAAAAIABMAAAAHJlcG9zaXRvcnktbWFpbi9SRUFETUUubWRQSwECFAMUAAAICADZZDBdBJCf0AkAAAAHAAAAIAAAAAAAAAAAAAAAgAF2AAAAcmVwb3NpdG9yeS1tYWluL+i1hOaWmS/nrJTorrAubWRQSwECFAMUAAAACADZZDBdlPTDdAgAAAAGAAAAIAAAAAAAAAAAAAAAgAG9AAAAcmVwb3NpdG9yeS1tYWluL2Fzc2V0cy9pbWFnZS5iaW5QSwECFAMUAAAACADZZDBdAAAAAAIAAAAAAAAAFgAAAAAAAAAAABAA/UEDAQAAcmVwb3NpdG9yeS1tYWluL2VtcHR5L1BLBQYAAAAABQAFAGUBAAA5AQAAPABmaXh0dXJlIGZyb20gUHl0aG9uIHN0YW5kYXJkLWxpYnJhcnkgemlwZmlsZTsgc3ludGhldGljIG9ubHk=', 'base64');

// Minimal ZIP assembler for hostile headers. The independent Python and Git
// writers below provide compatibility coverage beyond this test-only assembler.
function zip(items, {comment = Buffer.alloc(0)} = {}) {
  const local = [], central = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name), localName = item.localName ? Buffer.from(item.localName) : name;
    const data = Buffer.from(item.data ?? ''), method = item.method ?? 0, flags = item.flags ?? (item.descriptor ? 8 : 0);
    const compressed = item.compressed ?? (method === 8 ? deflateRawSync(data) : data);
    const crc = item.crc ?? crc32(data), size = item.size ?? data.length;
    const extra = item.extra ?? Buffer.alloc(0), localExtra = item.localExtra ?? Buffer.alloc(0);
    const version = item.version ?? 20, header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(version, 4);
    header.writeUInt16LE(flags, 6); header.writeUInt16LE(method, 8);
    header.writeUInt32LE(item.descriptor ? 0 : crc, 14);
    header.writeUInt32LE(item.descriptor ? 0 : compressed.length, 18);
    header.writeUInt32LE(item.descriptor ? 0 : size, 22);
    header.writeUInt16LE(localName.length, 26); header.writeUInt16LE(localExtra.length, 28);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x314, 4);
    directory.writeUInt16LE(version, 6); directory.writeUInt16LE(flags, 8); directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(size, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt16LE(extra.length, 30);
    directory.writeUInt32LE(item.attributes ?? (name.at(-1) === 47 ? 0x41ed0010 : 0x81a40000), 38);
    directory.writeUInt32LE(offset, 42);
    const descriptor = item.descriptor ? Buffer.alloc(item.signed === false ? 12 : 16) : Buffer.alloc(0);
    if (descriptor.length) {
      const prefix = descriptor.length - 12;
      if (prefix) descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, prefix); descriptor.writeUInt32LE(compressed.length, prefix + 4); descriptor.writeUInt32LE(size, prefix + 8);
    }
    const record = Buffer.concat([header, localName, localExtra, compressed, descriptor]);
    local.push(record); central.push(directory, name, extra); offset += record.length;
  }
  const records = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(records.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...local, records, end, comment]);
}
function fixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'asmb-zip-'));
  const destination = path.join(base, 'stage'); fs.mkdirSync(destination, {mode: 0o700});
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  return {base, destination};
}
function reject(bytes, code) { assert.throws(() => inspectZip(bytes), {code}); }

test('independently generated archive extracts exact binary, BOM, Unicode and directory names', t => {
  const {destination} = fixture(t), original = Buffer.from(PYTHON_ZIP);
  const inspected = inspectZip(PYTHON_ZIP);
  assert.equal(inspected.summary.rootDirectory, 'repository-main');
  assert.equal(inspected.summary.fileCount, 3); assert.equal(inspected.summary.directoryCount, 3);
  assert.equal(inspected.summary.expandedBytes, 26); assert.equal(inspected.summary.totalEntries, 5);
  assert.ok(Object.isFrozen(inspected.entries[0])); assert.ok(Object.isFrozen(inspected.summary));
  assert.deepEqual(extractZip(PYTHON_ZIP, {destination}), inspected);
  assert.deepEqual(fs.readFileSync(path.join(destination, 'README.md')), Buffer.from('\ufeff# sample\r\n'));
  assert.equal(fs.readFileSync(path.join(destination, '资料/笔记.md'), 'utf8'), '文本\n');
  assert.deepEqual(fs.readFileSync(path.join(destination, 'assets/image.bin')), Buffer.from([0, 255, 128, 10, 13, 254]));
  assert.deepEqual(fs.readdirSync(path.join(destination, 'empty')), []);
  assert.deepEqual(PYTHON_ZIP, original);
});

test('real git archive wrapper, Unicode, executable intent and commit comment work without executing content', t => {
  const {base, destination} = fixture(t), source = path.join(base, 'source'); fs.mkdirSync(source);
  const git = (...args) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-C', source, ...args], {
    env: {PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  git('init', '--quiet', '--template=', '--initial-branch=main');
  fs.writeFileSync(path.join(source, 'run.sh'), '#!/bin/sh\nexit 123\n', {mode: 0o700});
  fs.writeFileSync(path.join(source, '中文.md'), '\ufeff# ordinary\r\n');
  git('add', '.'); git('-c', 'user.name=ZIP Fixture', '-c', 'user.email=zip@example.test', 'commit', '--quiet', '-m', 'Synthetic fixture');
  const archive = git('archive', '--format=zip', '--prefix=sample-main/', 'HEAD');
  const manifest = extractZip(archive, {destination});
  assert.equal(manifest.summary.fileCount, 2); assert.equal(manifest.summary.rootDirectory, 'sample-main');
  for (const name of ['run.sh', '中文.md']) assert.deepEqual(fs.readFileSync(path.join(source, name)), fs.readFileSync(path.join(destination, name)));
  assert.equal(fs.statSync(path.join(destination, 'run.sh')).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(destination, '.git')), false);
});

test('stored/deflated members and signed/unsigned data descriptors are accepted', t => {
  const {destination} = fixture(t);
  const bytes = zip([{name: 'a', data: '123456789'}, {name: 'b', data: 'repeated'.repeat(100), method: 8, descriptor: true},
    {name: 'c', data: 'third', method: 8, descriptor: true, signed: false}, {name: 'd', data: '', method: 8}]);
  assert.equal(inspectZip(bytes).entries[0].crc32, 0xcbf43926);
  assert.equal(extractZip(bytes, {destination}).summary.rootDirectory, null);
  assert.equal(fs.readFileSync(path.join(destination, 'b'), 'utf8'), 'repeated'.repeat(100));
  assert.equal(fs.readFileSync(path.join(destination, 'c'), 'utf8'), 'third');
});

test('metadata and host-reserved trees are counted and skipped; wrappers remain optional', t => {
  const {destination} = fixture(t);
  const bytes = zip([{name: '__MACOSX/._root', data: 'finder'}, {name: 'root/'}, {name: 'root/.git/config', data: 'hostile'},
    {name: 'root/.GiT/hooks/pre-commit', data: 'hostile'}, {name: 'root/.asmagicbrain/private', data: 'hostile'},
    {name: 'root/.asmb-state/state', data: 'hostile'}, {name: 'root/.DS_Store', data: 'finder'}, {name: 'root/nested/file', data: 'kept'}]);
  // Even skipped aliases remain invalid: no normalization can select a winner.
  reject(bytes, 'ZIP_CONFLICT');
  const safe = zip([{name: '__MACOSX/._root'}, {name: 'root/'}, {name: 'root/.git/config', data: 'hostile'},
    {name: 'root/.asmagicbrain/private'}, {name: 'root/.asmb-state/state'}, {name: 'root/.DS_Store'}, {name: 'root/nested/file', data: 'kept'}]);
  assert.equal(inspectZip(safe, {stripRoot: false}).entries.at(-1).path, 'root/nested/file');
  const result = extractZip(safe, {destination});
  assert.equal(result.summary.skippedEntries, 5); assert.equal(result.summary.rootDirectory, 'root');
  assert.deepEqual(fs.readdirSync(destination), ['nested']); assert.equal(fs.readFileSync(path.join(destination, 'nested/file'), 'utf8'), 'kept');
});

test('absolute, traversal, ambiguous and editor-incompatible names fail even in skipped subtrees', () => {
  for (const name of ['/etc/file', '../file', 'root/../file', 'root//file', 'root/./file', 'C:/file', 'C:file', '\\server\\file',
    'root\\file', 'root/zero\0file', 'root/.git/../../file', 'root/__MACOSX/../file', 'root/end.', 'root/end ', 'root/ leading',
    'root/a%20b', 'root/CON.txt', 'root/a:b', 'root/a?b', 'root/a\x7fb']) reject(zip([{name}]), 'ZIP_UNSAFE_PATH');
});

test('duplicate, case/Unicode alias, and file/directory conflicts include implicit parents', () => {
  for (const names of [['a', 'a'], ['a/', 'a/'], ['A', 'a'], ['é', 'e\u0301'], ['Folder/a', 'folder/b'],
    ['a', 'a/b'], ['a/b', 'a'], ['a/', 'a'], ['ß', 'SS']]) reject(zip(names.map(name => ({name}))), 'ZIP_CONFLICT');
  assert.equal(inspectZip(zip([{name: 'a/b'}, {name: 'a/'}])).summary.fileCount, 1);
});

test('symlinks, devices, sockets and contradictory entry types never become files', () => {
  for (const mode of [0xa1ff, 0x21a4, 0x61a4, 0x11a4, 0xc1a4]) reject(zip([{name: 'root/item', attributes: (mode * 65536) >>> 0}]), 'ZIP_UNSUPPORTED');
  reject(zip([{name: 'volume', attributes: 8}]), 'ZIP_UNSUPPORTED');
  reject(zip([{name: 'dir', attributes: 0x41ed0010}]), 'ZIP_INVALID');
  reject(zip([{name: 'file/', attributes: 0x81a40000}]), 'ZIP_INVALID');
});

test('central/local names, methods, sizes, offsets and data descriptors must agree', () => {
  reject(zip([{name: 'safe', localName: 'evil'}]), 'ZIP_UNSAFE_PATH');
  const original = zip([{name: 'file', data: 'bytes', method: 8, descriptor: true}]);
  for (const [offset, value] of [[8, 0], [14, 1], [18, 1], [22, 1]]) {
    const changed = Buffer.from(original); changed[offset] = value; reject(changed, offset === 8 ? 'ZIP_INVALID' : 'ZIP_INTEGRITY');
  }
  const descriptor = Buffer.from(original), central = descriptor.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  descriptor[central - 1] = 1; reject(descriptor, 'ZIP_INTEGRITY');
  const overlapping = zip([{name: 'a'}, {name: 'b'}]);
  const secondCentral = overlapping.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), 63);
  overlapping.writeUInt32LE(0, secondCentral + 42); reject(overlapping, 'ZIP_UNSAFE_PATH');
});

test('corrupt CRC, truncated streams, appended compressed streams and lying expansion sizes fail before writes', t => {
  const {destination} = fixture(t);
  const invalid = [zip([{name: 'a', data: 'bytes', crc: 1}]), zip([{name: 'a', method: 8, data: 'bytes', compressed: Buffer.from([3])}]),
    zip([{name: 'a', method: 8, data: 'bytes', compressed: Buffer.concat([deflateRawSync(Buffer.from('bytes')), Buffer.from([0])])}]),
    zip([{name: 'a', method: 8, data: 'x'.repeat(1000), size: 2}]), zip([{name: 'a', method: 8, data: 'x', size: 2}]),
    zip([{name: 'good', data: 'valid'}, {name: 'bad', data: 'invalid', crc: 1}]), zip([{name: '.git/config', data: 'invalid', crc: 1}])];
  for (const bytes of invalid) {
    assert.throws(() => extractZip(bytes, {destination}), {code: 'ZIP_INTEGRITY'});
    assert.deepEqual(fs.readdirSync(destination), []);
  }
});

test('encryption, unsupported compression, ZIP64 and multidisk are explicit unsupported formats', () => {
  for (const flags of [1, 0x40, 0x2000]) reject(zip([{name: 'a', flags}]), 'ZIP_UNSUPPORTED');
  reject(zip([{name: 'a', method: 12}]), 'ZIP_UNSUPPORTED');
  reject(zip([{name: 'a', version: 45}]), 'ZIP_UNSUPPORTED');
  reject(zip([{name: 'a', extra: Buffer.from([1, 0, 0, 0])}]), 'ZIP_UNSUPPORTED');
  for (const offset of [4, 6, 8]) {
    const bytes = zip([{name: 'a'}]); bytes.writeUInt16LE(offset === 8 ? 2 : 1, bytes.length - 22 + offset); reject(bytes, 'ZIP_UNSUPPORTED');
  }
});

test('UTF-8 without EFS is preserved; invalid encoding and alternate Unicode name ambiguity are rejected', () => {
  assert.equal(inspectZip(zip([{name: '文.md', flags: 0}])).entries[0].path, '文.md');
  reject(zip([{name: Buffer.from([0xff])}]), 'ZIP_UNSUPPORTED');
  const extra = Buffer.alloc(13); extra.writeUInt16LE(0x7075, 0); extra.writeUInt16LE(9, 2);
  extra[4] = 1; extra.writeUInt32LE(crc32(Buffer.from('safe')), 5); extra.write('evil', 9);
  reject(zip([{name: 'safe', extra}]), 'ZIP_UNSAFE_PATH');
  reject(zip([{name: 'safe', extra: Buffer.from([0, 0, 255, 255])}]), 'ZIP_INVALID');
});

test('per-operation count, expanded-size, member and path bounds reject before inflation or staging', () => {
  reject(new Uint8Array(ZIP_IMPORT_LIMITS.archiveBytes + 1), 'ZIP_LIMIT_EXCEEDED');
  reject(zip([{name: 'a', method: 8, size: ZIP_IMPORT_LIMITS.memberBytes + 1}]), 'ZIP_LIMIT_EXCEEDED');
  reject(zip(Array.from({length: 9}, (_, index) => ({name: `file${index}`, method: 8, size: ZIP_IMPORT_LIMITS.memberBytes}))), 'ZIP_LIMIT_EXCEEDED');
  const count = zip([]); count.writeUInt16LE(ZIP_IMPORT_LIMITS.entries + 1, 8); count.writeUInt16LE(ZIP_IMPORT_LIMITS.entries + 1, 10);
  reject(count, 'ZIP_LIMIT_EXCEEDED');
  reject(zip([{name: 'a'.repeat(256)}]), 'ZIP_LIMIT_EXCEEDED');
  reject(zip([{name: Array(33).fill('a').join('/')}]), 'ZIP_LIMIT_EXCEEDED');
  reject(zip([{name: Array(6).fill('a'.repeat(200)).join('/')}]), 'ZIP_UNSAFE_PATH');
  // Highly compressible legitimate content stays usable within absolute bounds.
  assert.equal(inspectZip(zip([{name: 'notes.md', method: 8, data: 'a'.repeat(1024 * 1024)}])).summary.expandedBytes, 1024 * 1024);
});

test('malformed end records, unindexed bytes and invalid API values are rejected without range errors', () => {
  for (const input of [null, 'zip', {}, Buffer.alloc(0), Buffer.alloc(22), PYTHON_ZIP.subarray(0, -1)]) reject(input, 'ZIP_INVALID');
  const bytes = zip([{name: 'a'}]);
  reject(Buffer.concat([bytes, Buffer.from('trailing')]), 'ZIP_INVALID');
  const offset = Buffer.from(bytes); offset.writeUInt32LE(0xfffffff0, offset.length - 6); reject(offset, 'ZIP_INVALID');
  const prefixed = Buffer.concat([Buffer.from('x'), bytes]), end = prefixed.length - 22;
  const central = prefixed.readUInt32LE(end + 16) + 1;
  prefixed.writeUInt32LE(central, end + 16); prefixed.writeUInt32LE(1, central + 42);
  reject(prefixed, 'ZIP_INVALID');
  assert.throws(() => inspectZip(bytes, {stripRoot: 'yes'}), {code: 'ZIP_INVALID'});
  assert.equal(inspectZip(zip([])).summary.fileCount, 0);
});

test('output namespace limit includes implicit folders and permits a corrected smaller retry', () => {
  const files = Array.from({length: ZIP_IMPORT_LIMITS.extractedEntries}, (_, i) => ({name: `file${i}`}));
  assert.equal(inspectZip(zip(files)).summary.fileCount, ZIP_IMPORT_LIMITS.extractedEntries);
  const tooMany = [...files, {name: '.git/config'}, {name: 'nested/extra'}];
  reject(zip(tooMany), 'ZIP_LIMIT_EXCEEDED');
  const valid = inspectZip(zip([...files.slice(0, -2), {name: '.git/config'}, {name: 'nested/extra'}]));
  assert.equal(valid.summary.fileCount, ZIP_IMPORT_LIMITS.extractedEntries - 1);
  assert.equal(valid.summary.directoryCount, 1); assert.equal(valid.summary.skippedEntries, 1);
});

test('existing files, symlink destinations, and symlink ancestors are never overwritten', t => {
  const {base, destination} = fixture(t), bytes = zip([{name: 'a', data: 'incoming'}]);
  fs.writeFileSync(path.join(destination, 'a'), 'preserved');
  assert.throws(() => extractZip(bytes, {destination}), {code: 'ZIP_DESTINATION_UNSAFE'});
  assert.equal(fs.readFileSync(path.join(destination, 'a'), 'utf8'), 'preserved');
  const link = path.join(base, 'link'); fs.symlinkSync(destination, link);
  assert.throws(() => extractZip(bytes, {destination: link}), {code: 'ZIP_DESTINATION_UNSAFE'});
  const sub = path.join(destination, 'sub'); fs.mkdirSync(sub);
  assert.throws(() => extractZip(bytes, {destination: path.join(link, 'sub')}), {code: 'ZIP_DESTINATION_UNSAFE'});
  assert.deepEqual(fs.readdirSync(sub), []);
  assert.throws(() => extractZip(bytes, {destination: path.join(base, 'missing')}), {code: 'ZIP_DESTINATION_UNSAFE'});
});

test('failed archive can be discarded and a corrected archive imported into a new empty stage', t => {
  const {base, destination} = fixture(t);
  assert.throws(() => extractZip(zip([{name: '../unsafe'}]), {destination}), {code: 'ZIP_UNSAFE_PATH'});
  assert.deepEqual(fs.readdirSync(destination), []);
  fs.rmdirSync(destination); fs.mkdirSync(destination);
  assert.equal(extractZip(zip([{name: 'safe', data: 'recovered'}]), {destination}).summary.fileCount, 1);
  assert.equal(fs.readFileSync(path.join(base, 'stage/safe'), 'utf8'), 'recovered');
});
