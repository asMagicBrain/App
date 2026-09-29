import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {testRoot} from '../../../tools/development-paths.mjs';
import {verifyFontAssets} from './font-assets.mjs';

const output = path.join(testRoot, 'runs/stage1-reading-20260922/font-assets');
await fs.mkdir(output, {recursive: true});
async function fixture(source, font = Buffer.from('synthetic font bytes')) {
  const root = await fs.mkdtemp(path.join(output, 'case-'));
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'assets/index.css'), source);
  if (font !== null) await fs.writeFile(path.join(root, 'assets/math.woff2'), font);
  return root;
}
test('compiled relative fonts are hashed and repeated references share one asset record', async () => {
  const root = await fixture('@font-face{font-family:Math;src:url(./math.woff2) format("woff2")}@font-face{font-family:Math;src:url("math.woff2");font-weight:700}');
  const result = await verifyFontAssets(root);
  assert.equal(result.status, 'passed'); assert.equal(result.fontFaces, 2); assert.equal(result.references, 2);
  assert.equal(result.fonts.length, 1); assert.equal(result.fonts[0].path, 'assets/math.woff2');
  assert.equal(result.fonts[0].sha256, createHash('sha256').update('synthetic font bytes').digest('hex'));
  assert.equal((await verifyFontAssets(path.join(root, 'assets'))).fonts[0].path, 'math.woff2');
});
test('inlined, remote, protocol-relative and system-font sources fail closed', async () => {
  for (const source of ['url(data:font/woff2;base64,d09GMg==)', 'url("data:font/woff2;base64,d09GMg==")', 'url(https://example.invalid/math.woff2)', 'url(//example.invalid/math.woff2)', 'local("Math"),url(math.woff2)', 'url(%64ata:font/woff2;base64,d09GMg==)']) {
    await assert.rejects(verifyFontAssets(await fixture('@font-face{src:' + source + '}')), /local file/);
  }
});
test('missing, empty, escaped and symlinked font files cannot qualify', async () => {
  await assert.rejects(verifyFontAssets(await fixture('@font-face{src:url(math.woff2)}', null)), /Missing local font/);
  await assert.rejects(verifyFontAssets(await fixture('@font-face{src:url(math.woff2)}', Buffer.alloc(0))), /Empty local font/);
  await assert.rejects(verifyFontAssets(await fixture('@font-face{src:url(../../outside.woff2)}')), /escapes renderer/);
  const root = await fixture('@font-face{src:url(link.woff2)}');
  await fs.symlink('math.woff2', path.join(root, 'assets/link.woff2'));
  await assert.rejects(verifyFontAssets(root), /symlinks/);
});
test('empty or malformed font coverage cannot report success', async () => {
  for (const css of ['body{color:red}', '@font-face{font-family:Math}', '@font-face{src:url(math.woff2)', '@font-face{src:url(math.woff2);src:local(Math)}']) {
    await assert.rejects(verifyFontAssets(await fixture(css)), /font|Font/);
  }
});
