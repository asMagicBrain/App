import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {searchRuntimeSpec, verifySearchRuntimeBinary} from './search-runtime.mjs';

test('search inputs are pinned independently per supported platform', () => {
  const mac = searchRuntimeSpec({platform: 'darwin', arch: 'arm64'}), linux = searchRuntimeSpec({platform: 'linux', arch: 'x64'});
  assert.notEqual(mac.sha256, linux.sha256); assert.equal(linux.version, '1.18.0');
  assert.throws(() => searchRuntimeSpec({platform: 'linux', arch: 'arm64'}), /Unsupported/);
  assert.throws(() => verifySearchRuntimeBinary(Buffer.from('untrusted'), {platform: 'linux', arch: 'x64'}), /Unverified/);
});

test('installed native ripgrep bytes match the owned target before execution', () => {
  const spec = searchRuntimeSpec(), bytes = fs.readFileSync(new URL(`../../node_modules/@vscode/ripgrep-${spec.platform}-${spec.arch}/bin/rg`, import.meta.url));
  assert.equal(verifySearchRuntimeBinary(bytes).sha256, spec.sha256);
  const corrupted = Buffer.from(bytes); corrupted[500] ^= 1;
  assert.throws(() => verifySearchRuntimeBinary(corrupted), /Unverified/);
});
