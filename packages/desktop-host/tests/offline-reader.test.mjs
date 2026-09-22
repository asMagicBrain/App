import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {testRoot} from '../../../tools/development-paths.mjs';
import {loadOfflineAssets,KATEX_READER_CSS} from '../src/package-exchange/offline-assets.mjs';
import {renderOffline} from '../src/package-exchange/offline-reader.mjs';
import {createPackageZip,sha256} from '../src/package-exchange/archive.mjs';

const require=createRequire(import.meta.url),katexRoot=path.dirname(require.resolve('katex/package.json'));
const fixture=[{path:'chapters/math.md',bytes:Buffer.from(String.raw`# Equations

Inline $\theta$, $\pi$ and $\epsilon$.

$$
\begin{bmatrix}1 & 0 & x\\0 & 1 & y\\0 & 0 & 1\end{bmatrix}
$$

[Other chapter](../other.md)
<script>globalThis.imported=true</script>
<style>body{display:none}</style>
`)},{path:'other.md',bytes:Buffer.from('# Other')}];
const map=result=>new Map(result.files.map(file=>[file.path,file.bytes]));

test('offline math includes visible static KaTeX HTML, accessible MathML and local font/style CSP',()=>{
  const files=map(renderOffline({files:fixture})),page=files.get('reader/chapters/math.md.html').toString();
  assert.match(page,/class="katex-html" aria-hidden="true"/);assert.match(page,/class="katex-mathml"/);assert.match(page,/<math /);
  for(const glyph of ['θ','π','ϵ'])assert.ok(page.includes(glyph));
  assert.match(page,/class="[^\"]*delimsizing[^\"]*"/);assert.match(page,/style="/);
  assert.match(page,/href="\.\.\/\.\.\/reader-assets\/katex\/katex.min.css"/);
  assert.match(page,/style-src &#39;self&#39;; style-src-attr &#39;unsafe-inline&#39;/);
  assert.match(page,/font-src &#39;self&#39;/);assert.match(page,/script-src &#39;none&#39;/);assert.match(page,/connect-src &#39;none&#39;/);
  assert.match(page,/&lt;script&gt;/);assert.match(page,/&lt;style&gt;/);assert.doesNotMatch(page,/<script|<style|<button/);
  assert.match(page,/href="\.\.\/other.md.html"/);
  assert.doesNotMatch(files.get('reader.css').toString(),/katex-html|katex-mathml|STIX|Cambria/);
  assert.match(files.get(KATEX_READER_CSS).toString(),/\.katex \.katex-mathml\{[^}]*clip-path:inset\(50%\)[^}]*position:absolute/);
});

test('offline CSS and all 60 font references are unchanged pinned bytes with complete local closure and notices',()=>{
  const files=map(renderOffline({files:fixture})),css=files.get(KATEX_READER_CSS);
  assert.deepEqual(css,fs.readFileSync(path.join(katexRoot,'dist/katex.min.css')));
  const references=[...css.toString().matchAll(/url\(([^)]+)\)/g)].map(match=>match[1]);assert.equal(new Set(references).size,60);
  for(const relative of references){assert.match(relative,/^fonts\/KaTeX_[A-Za-z0-9-]+\.(?:woff2?|ttf)$/);assert.deepEqual(files.get('reader-assets/katex/'+relative),fs.readFileSync(path.join(katexRoot,'dist',relative)));}
  const notices=files.get('READER-NOTICES.txt').toString();
  for(const text of ['markdown-it 15.0.2','katex 0.18.7','The MIT License','SIL OPEN FONT LICENSE Version 1.1','Design Science, Inc.','Khan Academy','Reserved Font Names','KaTeX_Math','KaTeX_Size4','TERMINATION','DISCLAIMER'])assert.ok(notices.includes(text),text);
});

test('offline assets, math output and resulting ZIP are deterministic across fresh renders',()=>{
  const first=renderOffline({files:fixture}),second=renderOffline({files:fixture});
  assert.deepEqual(first,second);assert.equal(sha256(createPackageZip(first.files)),sha256(createPackageZip(second.files)));
  assert.deepEqual(renderOffline({files:fixture,analyzeOnly:true}),{warnings:first.warnings});
});

test('build asset admission refuses missing fonts and nonlocal or imported stylesheet references',()=>{
  const root=path.join(testRoot,'runs/stage4-shared-services-20260922/exchange/offline-assets');fs.mkdirSync(root,{recursive:true,mode:0o700});
  for(const css of ['@font-face{src:url(fonts/KaTeX_Math-Italic.woff2)}','@font-face{src:url(https://example.invalid/font.woff2)}','@import "external.css";@font-face{src:url(fonts/KaTeX_Math-Italic.woff2)}']){
    const temporary=fs.mkdtempSync(path.join(root,'case-'));fs.mkdirSync(path.join(temporary,'dist'));fs.writeFileSync(path.join(temporary,'dist/katex.min.css'),css);
    assert.throws(()=>loadOfflineAssets({katexRoot:temporary}));
  }
});

test('offline math keeps untrusted TeX and HTML inert, with explicit diagrams and artifact source fallback',()=>{
  const result=renderOffline({files:[{path:'README.md',bytes:Buffer.from('$$\\href{https://example.invalid}{outside}$$\n\n```mermaid\nflowchart LR\n A-->B\n```\n\n<iframe src="evil.html"></iframe>')},{path:'slider.html',bytes:Buffer.from('<input type="range"><script>fetch("https://example.invalid")</script>')}]});
  const files=map(result),page=files.get('reader/README.md.html').toString(),slider=files.get('reader/slider.html.html').toString();
  assert.doesNotMatch(page,/<a href="https:|<iframe|<script/);assert.match(page,/Mermaid diagram — source fallback/);assert.match(page,/&lt;iframe/);
  assert.doesNotMatch(slider,/<input|<script/);assert.match(slider,/&lt;input/);assert.match(slider,/Source view/);
  assert.ok(result.warnings.some(value=>value.code==='STATIC_ARTIFACT_FALLBACK'));
});
