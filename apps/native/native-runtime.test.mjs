import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {nativeTarget, runtimeSpec, selectGitRuntimeSpec, gitRuntimePaths} from './native-runtime.mjs';
import {inspectLinuxElf, verifyLinuxElf} from './elf-runtime.mjs';

test('native inputs select only reviewed host targets and preserve macOS pins', () => {
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'arm64'], ['darwin', 'x64'], ['linux/../../darwin', 'arm64']]) assert.throws(() => nativeTarget({platform, arch}), /Unsupported/);
  assert.equal(runtimeSpec({platform: 'darwin', arch: 'arm64'}).archiveSha256, 'b658a75b4093fcda7d56d3ee210c8d5fea232d4ebdcf5d7c42810124e77f3831');
  assert.equal(selectGitRuntimeSpec({platform: 'darwin', arch: 'arm64'}).preparedManifestSha256, 'aa0b1261c375a63e0f3e306c7eb93d477daa54e9ef0481a7a8d78bf897d0686f');
  assert.equal(runtimeSpec({platform: 'linux', arch: 'x64'}).archiveSha256, 'db661711f521c2b9d53476fad313f473ea825b2da8f86eb68bb5ba33420c499d');
});

test('Linux selection is pinned and closes local Git and HTTPS without optional runtimes', () => {
  const options = {platform: 'linux', arch: 'x64'}, spec = selectGitRuntimeSpec(options), bytes = fs.readFileSync(gitRuntimePaths(options).selection), selection = JSON.parse(bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), spec.selectionSha256);
  const entries = [...selection.included, ...selection.excluded], names = new Set(entries.map(entry => entry.path));
  assert.equal(names.size, entries.length);
  for (const entry of entries) assert(!entry.path.split('/').some(part => ['', '.', '..'].includes(part)));
  const included = new Set(selection.included.map(entry => entry.path));
  for (const required of ['bin/git', 'libexec/git-core/git', 'libexec/git-core/git-upload-pack', 'libexec/git-core/git-remote-http', 'libexec/git-core/git-remote-https', 'share/git-core/templates']) assert(included.has(required));
  assert(!selection.included.some(entry => /credential|git-lfs|scalar|\.so|perl|gitweb|etc\/|ssl\//.test(entry.path)));
  for (const entry of selection.included.filter(entry => entry.type === 'symlink')) assert(included.has(`libexec/git-core/${entry.target}`));
});

function elf() {
  const bytes = Buffer.alloc(512);
  Buffer.from('7f454c46020101', 'hex').copy(bytes);
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(62, 18); bytes.writeUInt32LE(1, 20); bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(1, 56);
  bytes.writeUInt32LE(1, 64); bytes.writeBigUInt64LE(512n, 64 + 32);
  return bytes;
}
test('ELF admission rejects wrong architecture, malformed offsets and unapproved loader', () => {
  const bytes = elf(); assert.deepEqual(inspectLinuxElf(bytes), {architecture: 'x64', interpreter: null, needed: [], searchPaths: []});
  assert.doesNotThrow(() => verifyLinuxElf(bytes, {interpreter: null, needed: []}));
  assert.throws(() => verifyLinuxElf(bytes, {interpreter: '/lib64/ld-linux-x86-64.so.2', needed: []}), /Unapproved/);
  for (const offset of [4, 5, 18, 54]) {const invalid = Buffer.from(bytes); invalid[offset] = 0; assert.throws(() => inspectLinuxElf(invalid));}
  const truncated = Buffer.from(bytes); truncated.writeBigUInt64LE(511n, 32); assert.throws(() => inspectLinuxElf(truncated));
});

test('ELF dynamic dependency and search-path injections fail closed', () => {
  const bytes = elf(); bytes.writeUInt16LE(2, 56);
  const position = 120; bytes.writeUInt32LE(2, position); bytes.writeBigUInt64LE(200n, position + 8); bytes.writeBigUInt64LE(80n, position + 32);
  for (const [index, [tag, value]] of [[5, 300], [10, 100], [1, 0], [29, 32], [0, 0]].entries()) {bytes.writeBigUInt64LE(BigInt(tag), 200 + index * 16); bytes.writeBigUInt64LE(BigInt(value), 208 + index * 16);}
  bytes.write('libattacker.so\0', 300); bytes.write('/tmp/attacker\0', 332);
  assert.deepEqual(inspectLinuxElf(bytes).needed, ['libattacker.so']);
  assert.deepEqual(inspectLinuxElf(bytes).searchPaths, ['/tmp/attacker']);
  assert.throws(() => verifyLinuxElf(bytes, {interpreter: null, needed: ['libc.so.6']}), /Unapproved/);
  assert.throws(() => verifyLinuxElf(bytes, {interpreter: null, needed: ['libattacker.so']}), /Unapproved/);
});
