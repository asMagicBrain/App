import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDocumentOutline} from '../src/outline-model.ts';
import {renderSourcePreview} from '../../apps/desktop/ui/markdown-preview.mjs';

test('outline uses Markdown heading grammar, excluding fenced and indented code', () => {
  const source = '# One\n\n```md\n# Fake fenced\n```\n\n    ## Fake indented\n\nTwo\n---\n\n### Three ###\n\n#not a heading\n';
  const entries = buildDocumentOutline(source);
  assert.deepEqual(entries.map(({title, level, line}) => ({title, level, line})), [
    {title: 'One', level: 1, line: 1}, {title: 'Two', level: 2, line: 9}, {title: 'Three', level: 3, line: 12},
  ]);
  for (const entry of entries) assert.equal(source.slice(0, entry.from).split('\n').length, entry.line);
  assert.equal(source.slice(entries[1].from, entries[1].to), 'Two\n---\n');
});

test('duplicate, nested and blank headings keep exact existing preview IDs', () => {
  const source = '# Same\n\n#\n\n> ## Same\n\n- ### Same\n\n# Same\n';
  const entries = buildDocumentOutline(source), preview = renderSourcePreview(source);
  assert.deepEqual(entries.map(entry => entry.id), ['source-heading-1', 'source-heading-3', 'source-heading-4', 'source-heading-5']);
  assert.deepEqual(entries.map(entry => entry.line), [1, 5, 7, 9]);
  for (const entry of entries) {
    assert.ok(preview.headings.some(heading => heading.id === entry.id && heading.level === entry.level));
    assert.match(preview.html, new RegExp(`id="${entry.id}"`));
  }
});

test('labels use parsed inline text and keep Unicode UTF-16 source coordinates', () => {
  const source = '😀 preface\n\n# **Bold** [link](note.md) `code` &amp; Ω\n\nSetext *label*\ncontinues\n===\n';
  const entries = buildDocumentOutline(source);
  assert.equal(entries[0].title, 'Bold link code & Ω');
  assert.equal(entries[0].from, source.indexOf('# **Bold**'));
  assert.equal(entries[1].title, 'Setext label continues');
  assert.equal(entries[1].level, 1);
  assert.equal(source.slice(entries[1].from, entries[1].to), 'Setext *label*\ncontinues\n===\n');
});

test('line maps preserve offsets for CRLF, lone CR, BOM and missing final newline', () => {
  const source = '\ufeffpreface\r\n\r\n## CRLF\r\nbody\r### CR\r\n#### End';
  const entries = buildDocumentOutline(source);
  assert.deepEqual(entries.map(entry => entry.line), [3, 5, 6]);
  assert.deepEqual(entries.map(entry => entry.from), [source.indexOf('## CRLF'), source.indexOf('### CR'), source.indexOf('#### End')]);
  assert.equal(entries.at(-1).to, source.length);
});

test('live draft edits replace the outline without mutating source or inventing empty headings', () => {
  const saved = '# Saved\n\ntext\n';
  assert.deepEqual(buildDocumentOutline(saved).map(entry => entry.title), ['Saved']);
  const draft = saved.replace('# Saved', 'Saved paragraph') + '\n## Unsaved section\n';
  assert.deepEqual(buildDocumentOutline(draft).map(entry => entry.title), ['Unsaved section']);
  assert.equal(saved, '# Saved\n\ntext\n');
  for (const value of ['', 'ordinary text', '#\n\n##  \n', '~~~\n# fenced\n~~~']) assert.deepEqual(buildDocumentOutline(value), []);
});

test('outline adds no rendered-preview size ceiling and never follows heading links', () => {
  const source = 'x'.repeat(512 * 1024 + 1) + '\n\n# [Local](../secret.md) ![picture](https://example.invalid/image.png)\n';
  const entries = buildDocumentOutline(source);
  assert.equal(renderSourcePreview(source).limited, true);
  assert.equal(entries.length, 1); assert.equal(entries[0].title, 'Local picture');
  assert.equal(entries[0].from, source.indexOf('# [Local]'));
});
