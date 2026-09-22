import test from 'node:test';
import MarkdownIt from 'markdown-it';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { renderSourcePreview } from '../../apps/desktop/ui/markdown-preview.mjs';
import { MATH_LIMITS, installMath } from '../../apps/desktop/ui/markdown-math.mjs';

const render = source => renderSourcePreview(source, 'notes/math.md', { technical: true }).html;
const count = (html, pattern) => [...html.matchAll(pattern)].length;

test('technical reading is explicit and ordinary previews retain their behavior', () => {
  const source = 'Inline $x_y$ and \\(x^2\\).\n\n$$x^2$$\n\n_important_\n\n```text\n$x_y$\n```';
  const plain = renderSourcePreview(source).html;
  assert.doesNotMatch(plain, /preview-math|katex/);
  assert.match(plain, /<em>important<\/em>/);
  assert.equal(count(render(source), /data-copy-math/g), 3);
});

test('minimal transform and matrix preserve TeX while providing HTML and MathML', () => {
  const source = String.raw`# Transform example

Inline: $T_{AB}T_{BC}=T_{AC}$.

$$
\mathbf{p}_A = \mathbf{R}_{AB}\mathbf{p}_B + \mathbf{t}_{AB}
$$

$$
{}^{A}\mathbf{T}_{B} =
\begin{bmatrix}
1 & 0 & 0 & 0.10 \\
0 & 1 & 0 & 0.20 \\
0 & 0 & 1 & 0.30 \\
0 & 0 & 0 & 1
\end{bmatrix}
\in \mathrm{SE}(3)
$$

$$a_{\mathrm{upper}} = t_{\mathrm{use}}-\hat{t}_{\mathrm{capture}}+\epsilon \leq 50\,\mathrm{ms}$$

Greek: $\theta=\pi/2$, Unicode prose: θ is an angle. Sensor target: $f=100\,\mathrm{Hz}$.
`;
  const html = render(source);
  assert.equal(count(html, /data-math-source=/g), 6);
  assert.equal(count(html, /<math /g), 6);
  assert.equal(count(html, /encoding="application\/x-tex"/g), 6);
  assert.match(html, /<mtable/);
  assert.match(html, /data-math-source="T_\{AB\}T_\{BC\}=T_\{AC\}"/);
  assert.doesNotMatch(html, /preview-math-error/);
  assert.match(html, /Unicode prose: θ is an angle/);
  assert.equal(source.includes(String.raw`\mathbf{R}_{AB}`), true);
});

test('code, emphasis, escapes, prices and ambiguous dollar pairs stay ordinary Markdown', () => {
  const source = 'Code: `T_{AB}` and `$x_y$` and `\\(x\\)`. Emphasis: _important_.\n\n'
    + 'Escaped: \\$5 and \\$10. Prices $5, $10.50, $5 and $10; later $x^2$. '
    + 'Ambiguous $5$ and $2x$; use \\(2x\\). Space $ x$ and $x $. Prose a$x$b.\n\n'
    + '```text\n$not_math$ and T_{AB}\n$$x$$\n```\n\n    $indented$';
  const html = render(source);
  assert.equal(count(html, /data-math-source=/g), 2);
  assert.match(html, /<code>\$x_y\$<\/code>/);
  assert.match(html, /<em>important<\/em>/);
  assert.match(html, /Prices \$5, \$10\.50, \$5 and \$10/);
  assert.match(html, /Ambiguous \$5\$ and \$2x\$/);
  assert.match(html, /<pre><code class="language-text">\$not_math\$ and T_\{AB\}/);
  assert.match(html, /<pre><code>\$indented\$/);
  const adjacent = render('Keep $x$word ordinary; later $y$ renders.');
  assert.match(adjacent, /Keep \$x\$word ordinary/);
  assert.equal(count(adjacent, /data-math-source=/g), 1);
});

test('both delimiter families work inside list and quote containers, with block source hints', () => {
  const source = '# Value $x_y$\n\n> $$\n> \\frac{x}{y}\n> $$\n\n- \\(2x\\)\n\n\\[\nx^2\n\\]';
  const html = renderSourcePreview(source, '', { technical: true, sourceMap: true }).html;
  assert.equal(count(html, /data-math-source=/g), 4);
  assert.doesNotMatch(html, /preview-math-error/);
  assert.match(html, /data-source-line="3" data-source-end-line="6" class="preview-math/);
  assert.match(html, /data-heading-anchor="value-x_y"/);
});

test('invalid math gives an escaped local diagnostic and retains later content', () => {
  const html = render(String.raw`$$\frac{1}{$$` + '\n\nThis paragraph remains readable. $x^2+y^2=1$');
  assert.equal(count(html, /preview-math-error/g), 1);
  assert.equal(count(html, /<math /g), 1);
  assert.match(html, /This paragraph remains readable/);
  assert.match(html, /data-math-source="\\frac\{1\}\{"/);
  assert.equal(count(html, /data-copy-math/g), 2);
  const malicious = render(String.raw`\(\badcommand{<img src=x onerror=alert(1)>}\)`);
  assert.doesNotMatch(malicious, /<img|<script/);
  assert.match(malicious, /&lt;img/);
});

test('unsafe commands, macro definitions and dynamic expansion never produce active markup', () => {
  const payloads = [
    String.raw`\href{javascript:alert(1)}{x}`, String.raw`\url{https://example.invalid}`,
    String.raw`\includegraphics{https://example.invalid/x.png}`, String.raw`\htmlStyle{position:fixed}{x}`,
    String.raw`\htmlData{onmouseover=alert(1)}{x}`, String.raw`\htmlId{owned}{x}`,
    String.raw`\htmlClass{owned}{x}`, String.raw`\def\loop{\loop}\loop`,
    String.raw`\gdef\owned{bad}`, String.raw`\newcommand{\owned}{bad}`,
    String.raw`\expandafter\def\csname owned\endcsname{bad}`, String.raw`\let\owned=\href`,
    String.raw`\input{/etc/passwd}`, String.raw`\write18{touch owned}`,
  ];
  for (const payload of payloads) {
    const html = render(`\\(${payload}\\)\n\n$x$`);
    assert.equal(count(html, /preview-math-error/g), 1, payload);
    assert.equal(count(html, /<math /g), 1, payload);
    assert.doesNotMatch(html, /<a\b|<img\b|<script\b|<iframe\b|<style\b|\son\w+=/i, payload);
  }
  assert.match(render(String.raw`\(\owned\)`), /preview-math-error/);
});

test('source, tokens, nesting, count and rendered output have bounded local fallbacks', () => {
  const checks = [
    ['x'.repeat(MATH_LIMITS.source + 1), /4,096-character/],
    ['x+'.repeat(MATH_LIMITS.tokens), /1,024-token/],
    ['{'.repeat(MATH_LIMITS.nesting + 1) + 'x' + '}'.repeat(MATH_LIMITS.nesting + 1), /32-level nesting/],
  ];
  for (const [source, diagnostic] of checks) {
    const html = render(`\\(${source}\\)\n\nReadable afterward.`);
    assert.match(html, diagnostic);
    assert.match(html, /Readable afterward/);
    assert.doesNotMatch(html, /<math /);
  }
  const many = render(Array.from({ length: MATH_LIMITS.equations + 2 }, () => '$x$').join('\n\n'));
  assert.equal(count(many, /<math /g), MATH_LIMITS.equations);
  assert.equal(count(many, /Document math reading limit reached/g), 1);
  assert.match(many, /\$x\$/);
  assert.match(render(`\\(${'\\frac{x}{y}'.repeat(140)}\\)`), /Equation output exceeds the reading limit/);
  const documentTokens = render(Array.from({ length: 20 }, () => `\\(${'x+'.repeat(500)}\\)`).join('\n\n'));
  assert.match(documentTokens, /Document math reading limit reached/);
  const hugeSize = render(String.raw`\(\rule{999999em}{999999em}\)`);
  assert.doesNotMatch(hugeSize, /(?:height|width):999999/);
});

test('math source embedded in Markdown links does not create nested interactive controls', () => {
  const html = render('[$x$](other.md)');
  assert.match(html, /<a /);
  assert.match(html, /<math /);
  assert.doesNotMatch(html, /<button /);
});

test('surplus equations produce one diagnostic and literal source without DOM amplification', () => {
  const source = '$x$ '.repeat(60000), html = render(source);
  assert.equal(count(html, /data-math-source=/g), MATH_LIMITS.equations + 1);
  assert.equal(count(html, /Document math reading limit reached/g), 1);
  assert.ok(html.length < source.length * 2);
  assert.match(html, /\$x\$ \$x\$/);
  const blocks = render('$$x$$\n\n'.repeat(MATH_LIMITS.equations + 3));
  assert.equal(count(blocks, /Document math reading limit reached/g), 1);
  assert.equal(count(blocks, /<pre><code>\$\$x\$\$<\/code><\/pre>/g), 2);
});

test('hostile workloads finish in a killable test subprocess without stale macro state', () => {
  // The test process timeout can kill a hang; it is not claimed as the runtime
  // renderer's timeout. Production protection is the bounded-work policy.
  const moduleUrl = new URL('../../apps/desktop/ui/markdown-preview.mjs', import.meta.url).href;
  const script = `import { renderSourcePreview as render } from ${JSON.stringify(moduleUrl)};
    const payloads = [
      '$x '.repeat(100000),
      String.raw\`\\(\\def\\a{\\a}\\a\\)\`,
      '\\\\(' + '{'.repeat(4090) + 'x' + '}'.repeat(4090) + '\\\\)',
      Array.from({length: 5000}, () => '$x$').join(' '),
      String.raw\`\\(\\sqrt\` + '{'.repeat(1020) + 'x' + '}'.repeat(1020) + String.raw\`\\)\`,
    ];
    for (const source of payloads) {
      const result = render(source, '', { technical: true });
      if (result.html.length > 6000000) throw Error('unbounded output');
    }
    process.stdout.write('completed');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'completed');
});

test('offline math option uses native MathML without inline HTML styles or inactive copy buttons',()=>{
 const parser=new MarkdownIt({html:false});installMath(parser,{output:'mathml',copyButton:false});
 const html=parser.render('Inline $x^2$\n\n$$\\frac{a}{b}$$\n',{technical:true});
 assert.match(html,/<math /);assert.match(html,/<mfrac>/);assert.doesNotMatch(html,/style=|katex-html|<button/);
 assert.throws(()=>installMath(new MarkdownIt(),{output:'html',copyButton:false}),/Invalid math/);
});
