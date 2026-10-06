import test from 'node:test';
import assert from 'node:assert/strict';
import {renderSourcePreview, localLink} from '../../apps/desktop/ui/markdown-preview.mjs';

test('portable heading anchors retain Chinese titles and source locations without HTML admission', () => {
  const source = '## 实验步骤 <a href="#asmb-experiment" id="asmb-experiment"></a>\n\n## 实验步骤';
  const result = renderSourcePreview(source, 'class.md', {sourceMap:true});
  assert.equal(result.headings[0].title, '实验步骤');
  assert.match(result.html, /data-explicit-heading-anchor="asmb-experiment"/);
  assert.match(result.html, /data-source-line="1"/);
  assert.match(result.html, /data-heading-anchor="实验步骤-1"/);
  assert.doesNotMatch(result.html, /<a|&lt;a/);
  for (const markup of ['<a id="x" onclick="run()"></a>', '<a href="https://example.com" id="x"></a>', '<a href="#other" id="x"></a>', '<a id="x">text</a>']) {
    const html = renderSourcePreview('## Title '+markup).html;
    assert.doesNotMatch(html, /data-explicit-heading-anchor|<a /);
    assert.match(html, /&lt;a/);
  }
  assert.match(renderSourcePreview('```md\n'+source+'\n```').html, /&lt;a/);
});

test('document anchors preserve outline IDs and uniquely identify headings', () => {
  const result = renderSourcePreview('# A **reader** & `code`\n\n# A reader code\n\n# A reader code\n\n# 中文标题');
  assert.equal(result.headings[0].id, 'source-heading-1');
  const anchors = [...result.html.matchAll(/data-heading-anchor="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(anchors, ['a-reader--code', 'a-reader-code', 'a-reader-code-1', '中文标题']);
});

test('nested documentation links and image paths stay repository-relative', () => {
  assert.deepEqual(localLink('../docs/guide.md#file-view', 'notes/README.md'), {path: 'docs/guide.md', fragment: 'file-view'});
  assert.deepEqual(localLink('#中文标题', 'docs/guide.md'), {path: 'docs/guide.md', fragment: '中文标题'});
  assert.equal(localLink('../../outside.png', 'docs/guide.md'), null);
  const result = renderSourcePreview('![Overlay](../media/area.png)\n\n![Remote](https://example.com/remote.png)\n\n<script>run()</script>', 'docs/guide.md');
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].relativeUrl, '../media/area.png');
  assert.match(result.html, /External or unsafe image stays inert/);
  assert.doesNotMatch(result.html, /<script>|<img/);
});
