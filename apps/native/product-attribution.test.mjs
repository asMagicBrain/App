import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {packageAttribution} from './product-attribution.mjs';
import {linuxControl} from './linux-package-policy.mjs';

const source = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('official package credits carry the approved public identity into Debian metadata', () => {
  const credits = packageAttribution(source);
  assert.deepEqual(credits.author, {name:'SONG Chaoyang', email:'AncoraSIR@gmail.com', url:'https://AncoraSIR.com'});
  assert.deepEqual(credits.organization, {name:'Design and Learning Research Group', url:'https://AncoraSIR.com'});
  const control = linuxControl({channel:'preview', version:'0.2.11', installedSize:1000, attribution:credits});
  assert.match(control, /^Maintainer: SONG Chaoyang <AncoraSIR@gmail.com>$/m);
  assert.match(control, /^Homepage: https:\/\/AncoraSIR.com$/m);
  for (const relative of ['../../LICENSE', '../../NOTICE', '../../docs/licensing.md']) {
    const text = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
    assert.match(text, /Copyright \(c\) 2026 SONG Chaoyang/);
    assert.match(text, /Copyright \(c\) 2026 asMagicBrain contributors/);
  }
});

test('release credits reject missing fields and metadata injection', () => {
  assert.throws(() => packageAttribution({}));
  for (const field of [['author','name'],['author','email'],['author','url'],['organization','name'],['organization','url'],['homepage'],['copyright']]) {
    for (const suffix of ['\nMaintainer: injected', '\r', '\u0000', '\u2028']) {
      const value = structuredClone(source);
      const parent = field.length === 1 ? value : value[field[0]], key = field.at(-1);
      parent[key] += suffix;
      assert.throws(() => packageAttribution(value), field.join('.'));
      assert.throws(() => linuxControl({channel:'preview',version:'0.2.11',installedSize:1,attribution:value}));
    }
  }
  for (const email of ['missing-at', 'a@b@example.com', 'a<test>@example.com']) {
    assert.throws(() => packageAttribution({...source, author:{...source.author,email}}));
  }
  for (const homepage of ['file:///etc/passwd','https://user:password@example.com','not a URL']) {
    assert.throws(() => packageAttribution({...source, homepage}));
  }
});
