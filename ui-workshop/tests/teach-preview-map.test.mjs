import test from 'node:test';
import assert from 'node:assert/strict';
import {renderTeachSource, teachDisplaySource} from '../src/teach-content.mjs';
import {mapTeachPreviewSource} from '../src/teach-preview-map.mjs';
import {renderSourcePreview} from '../../apps/desktop/ui/markdown-preview.mjs';

test('source hints are opt-in; plain preview and headings keep their existing HTML', () => {
  const source = '# Title\n\nFirst paragraph.\n\n## Next\n\nSecond paragraph.\n';
  const baseline = renderSourcePreview(source, 'term/instructor.md');
  const mapped = renderTeachSource(source, 'term/instructor.md', undefined, {sourceMap: true});
  assert.deepEqual(renderTeachSource(source, 'term/instructor.md'), baseline);
  assert.equal(mapped.html.replace(/ data-source-(?:end-)?line="\d+"/g, ''), baseline.html);
  assert.match(mapped.html, /<h2 data-source-line="5" data-source-end-line="6"/);
  assert.match(mapped.html, /<p data-source-line="7" data-source-end-line="8"/);
});

test('recognized frontmatter maps displayed blocks to original CRLF source lines', () => {
  const source = '\uFEFF---\r\ntitle: Example\r\ndescription: Example\r\n---\r\n# Title\r\n\r\nBody\r\n';
  const html = renderTeachSource(source, 'instructor.md', undefined, {sourceMap: true}).html;
  assert.match(html, /<h1 data-source-line="5" data-source-end-line="6"/);
  assert.match(html, /<p data-source-line="7" data-source-end-line="8"/);
  assert.equal(source.startsWith('\uFEFF---\r\n'), true);
});

test('fences, nested lists, quotes and tables expose block positions without interpreting content', () => {
  const source = '# Title\n\n- one\n  - two\n\n> quoted\n\n```js\nconst unsafe = "<script>";\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';
  const html = renderTeachSource(source, 'instructor.md', undefined, {sourceMap: true}).html;
  assert.match(html, /<li data-source-line="3"/);
  assert.match(html, /<blockquote data-source-line="6"/);
  assert.match(html, /<pre data-source-line="8" data-source-end-line="11"/);
  assert.match(html, /<table data-source-line="12"/);
  assert.equal(html.includes('<script>'), false);
});

test('reference figure and preserved HTML table transforms retain original subsequent line locations', () => {
  const source = '---\ntitle: Reference\n---\n# Title\n\n<figure>\n<img src="../assets/one.png" alt="One">\n<figcaption>Caption</figcaption>\n</figure>\n\n## After figure\n\n<table>\n<tr><td>Cell</td></tr>\n</table>\n\n## After table\n\nLast paragraph';
  const assets = {'assets/one.png': '/__asteach-reference/assets/one.png'};
  const result = renderTeachSource(source, 'term/instructor.md', assets, {sourceMap: true});
  assert.match(result.html, /<h2 data-source-line="11" data-source-end-line="12"/);
  assert.match(result.html, /<h2 data-source-line="17" data-source-end-line="18"/);
  assert.match(result.html, /<p data-source-line="19" data-source-end-line="20"/);
  assert.match(result.html, /class="teach-reference-image"/);
  assert.match(result.html, /&lt;table&gt;/);
  const mapping = mapTeachPreviewSource(source, teachDisplaySource(source), true);
  assert(mapping.lineMap.every((line, index) => index === 0 || line >= mapping.lineMap[index - 1]));
  assert.equal(result.html.replace(/ data-source-(?:end-)?line="\d+"/g, ''), renderTeachSource(source, 'term/instructor.md', assets).html);
});

test('source-map data and imported destinations cannot inject markup or remote images', () => {
  const result = renderSourcePreview('# Title\n\n![remote](https://example.test/a.png)\n\n<script>alert(1)</script>', '', {sourceMap: true, sourceLineMap: ['1" onload="bad()', -2, Infinity]});
  assert.match(result.html, /data-source-line="1"/);
  assert(!result.html.includes('<script>'));
  assert(!result.html.includes('<img'));
  assert(!result.html.includes('onload='));
});

test('empty and final unterminated lines map safely; unsupported transformations are refused', () => {
  assert.deepEqual(mapTeachPreviewSource('', '').lineMap, [1, 2]);
  const source = '# Last';
  assert.match(renderTeachSource(source, 'instructor.md', undefined, {sourceMap: true}).html, /data-source-line="1" data-source-end-line="2"/);
  assert.throws(() => mapTeachPreviewSource('original', 'rewritten'), /original source suffix/);
});
