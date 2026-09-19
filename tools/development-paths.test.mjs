import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveTestRoot} from './development-paths.mjs';

test('developer test root is absolute and separate from the checkout', () => {
  assert.equal(resolveTestRoot('/data/test', '/source/app'), '/data/test');
  for (const value of ['', 'relative', '/source/app', '/source/app/output', '/source', '/']) {
    assert.throws(() => resolveTestRoot(value, '/source/app'));
  }
});

test('standalone clone uses a sibling while the historical multi-repository layout is preserved', () => {
  const saved = process.env.ASMB_TEST_ROOT; delete process.env.ASMB_TEST_ROOT;
  try {
    assert.equal(resolveTestRoot(undefined, '/Users/contributor/asMagicBrain'), '/Users/contributor/asMagicBrain-Test');
    assert.equal(resolveTestRoot(undefined, '/project/asMagicBrain-Latest/asMagicBrain-App'), '/project/asMagicBrain-Test');
  } finally {if (saved !== undefined) process.env.ASMB_TEST_ROOT = saved;}
});

test('a linked external root cannot redirect generated files into the source checkout', t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'asmb-tooling-paths-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  const alias = path.join(root, 'outside'); fs.symlinkSync(source, alias);
  assert.throws(() => resolveTestRoot(path.join(alias, 'generated'), source));
});
