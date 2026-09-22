import test from 'node:test';
import assert from 'node:assert/strict';
import {renderSourcePreview} from '../../apps/desktop/ui/markdown-preview.mjs';

test('technical reading is explicit and Mermaid remains escaped data before hydration', () => {
  const source = '# Diagram\n\n```mermaid\nflowchart LR\nA[<script>bad()</script>]-->B\n```\n';
  const ordinary = renderSourcePreview(source);
  assert.doesNotMatch(ordinary.html, /data-mermaid-diagram/);
  const enhanced = renderSourcePreview(source, '', {technical:true,sourceMap:true});
  assert.match(enhanced.html, /data-mermaid-diagram="diagram-1"/);
  assert.match(enhanced.html, /data-source-line="3"/);
  assert.match(enhanced.html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(enhanced.html, /<script|<svg|<iframe/);
  assert.deepEqual(enhanced.headings, ordinary.headings);
});
test('ordinary fences stay code and excessive diagrams retain source without excess controls', () => {
  const source = '```text\nflowchart LR\nA-->B\n```\n\n'+('```mermaid\nflowchart LR\nA-->B\n```\n\n'.repeat(1000));
  const result = renderSourcePreview(source,'',{technical:true});
  assert.equal((result.html.match(/data-mermaid-diagram=/g)||[]).length,17);
  assert.equal((result.html.match(/A--&gt;B/g)||[]).length,1001);
  assert.match(result.html, /class="language-text"/);
});
