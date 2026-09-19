import test from 'node:test';
import assert from 'node:assert/strict';
import {renderSourcePreview, localLink} from '../../apps/desktop/ui/markdown-preview.mjs';

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
