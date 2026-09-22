/** Packaged offline reading acceptance. Imported Markdown is data, never code. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {testRoot as testBase} from '../../../tools/development-paths.mjs';
assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
assert.ok(process.env.ASMB_PACKAGED_EXECUTABLE, 'Bind acceptance to an exact package.');
assert.ok(process.env.ASMB_TECHNICAL_FIXTURES, 'Supply the reviewed reproduction directory containing math.md and diagrams.md.');
process.env.ASMB_ACCEPTANCE_RUN_ROOT ??= path.join(testBase, 'runs/technical-reading');
const {createDriver, nativeTarget, testRoot: runRoot, until, sha} = await import(process.platform === 'linux' ? './linux-driver.mjs' : './native-driver.mjs');
await fs.mkdir(runRoot, {recursive: true});
const output = await fs.mkdtemp(path.join(runRoot, 'reader-'));
const executable = process.env.ASMB_PACKAGED_EXECUTABLE;
const bundle = process.platform === 'linux' ? path.dirname(executable) : executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
const payload = path.join(bundle, process.platform === 'linux' ? 'resources/app' : 'Contents/Resources/app');
const metadata = JSON.parse(await fs.readFile(path.join(payload, 'native-package.json')));
const home = path.join(output, 'home');
const data = metadata.channel === 'preview' ? path.join(home, 'asMagicBrain') : path.join(output, 'data');
const organization = path.join(data, 'workspaces/asMagicBrain');
const target = metadata.channel === 'preview' ? {executablePath: executable, args: ['--test-root=' + testBase, '--test-user-home=' + home]} : nativeTarget(data);
const driver = await createDriver({...target, output, workspacePath: path.join(organization, 'Workspace')});
await fs.copyFile(new URL(import.meta.url), path.join(output, 'driver-at-launch.mjs'));
const fixture = path.join(output, 'fixture'); await fs.mkdir(fixture);
const originals = {};
for (const name of ['math.md', 'diagrams.md']) {
  originals[name] = await fs.readFile(path.join(process.env.ASMB_TECHNICAL_FIXTURES, name));
  await fs.writeFile(path.join(fixture, name), originals[name]);
}
const largeDiagram = '# Large bounded diagram\n\n```mermaid\nflowchart LR\n' + Array.from({length:24}, (_, index) => 'N'+index+'[Node '+index+']').join('\n') + '\n' + Array.from({length:23}, (_, index) => 'N'+index+'-->N'+(index+1)).join('\n') + '\n```\n';
originals['large-diagram.md'] = Buffer.from(largeDiagram);
await fs.writeFile(path.join(fixture, 'large-diagram.md'), largeDiagram);
await fs.writeFile(path.join(fixture, 'README.md'), '# Technical reading\n\n[Math](math.md) · [Diagrams](diagrams.md)\n');
const hostile = [
  '# Bounded hostile inputs',
  String.raw`$\href{javascript:window.__technicalAttack=1}{Go}$`,
  String.raw`$$\def\x{\x}\x$$`,
  '$$' + '{'.repeat(40) + 'x' + '}'.repeat(40) + '$$',
  '$$' + 'x'.repeat(4200) + '$$',
  '<script>window.__technicalAttack=1</script>',
  ...[
    '%%{init: {securityLevel:"loose"}}%%\nflowchart LR\nA-->B',
    'flowchart LR\nA-->B\nclick A "https://example.invalid/"',
    'flowchart LR\nA[<img src=x onerror=window.__technicalAttack=1>]-->B',
    'flowchart LR\nA:::fw-window-->B',
    'sequenceDiagram\n' + 'loop outer\n'.repeat(5) + 'A->>B: message\n' + 'end\n'.repeat(5),
    'flowchart LR\n' + Array.from({length:49}, (_, i) => 'N' + i).join('\n'),
    'flowchart LR\nSafe[Later safe diagram]-->Still[Still readable]',
  ].map(s => '```mermaid\n' + s + '\n```'),
  'Later valid math: $x^2=1$.',
].join('\n\n') + '\n';
originals['hostile.md'] = Buffer.from(hostile);
await fs.writeFile(path.join(fixture, 'hostile.md'), hostile);
const zip = path.join(output, 'technical-reading.zip');
execFileSync('/usr/bin/zip', ['-q', zip, 'README.md', 'math.md', 'diagrams.md', 'hostile.md', 'large-diagram.md'], {cwd: fixture});
const repo = 'Technical-Reading';
let page, running = false, failure;
const requests = [], layout = [], copies = [];
const button = name => page.getByRole('button', {name, exact: true});
const record = (name, detail = {}) => {driver.record(name, detail); console.log(JSON.stringify({event: name}));};
const source = name => fs.readFile(path.join(organization, repo, name));
async function launch() {
  page = await driver.launch(); running = true;
  await page.context().setOffline(true);
  page.on('request', request => {if (/^https?:/i.test(request.url())) requests.push(request.url());});
  await button('asMagicBrain organization').waitFor();
  if (driver.app) await driver.app.evaluate(({BrowserWindow}) => {const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1280, 900); w.show(); w.focus();});
}
async function close() {await driver.closeNormally(); running = false;}
async function theme(label) {await button('asMagicBrain Theme').click(); await page.getByRole('combobox', {name: 'Theme', exact: true}).selectOption({label}); await page.locator('.fw-theme-picker').getByRole('button', {name: 'Done', exact: true}).click();}
async function openFile(name) {
  await button('asMagicBrain organization').click();
  await button('Open repository ' + repo).click();
  await page.getByRole('table', {name: 'Directory contents'}).getByRole('button', {name, exact: true}).click();
  await page.locator('.rfe-preview').waitFor({state: 'visible'});
}
async function clipboard() {
  return driver.app ? driver.app.evaluate(({clipboard}) => clipboard.readText()) : execFileSync('/usr/bin/xclip', ['-selection', 'clipboard', '-o'], {encoding: 'utf8'});
}
async function clearClipboard() {
  if (driver.app) await driver.app.evaluate(({clipboard}) => clipboard.writeText('Technical reading clipboard check'));
  else execFileSync('/usr/bin/xclip', ['-selection', 'clipboard', '-i'], {input: 'Technical reading clipboard check', stdio: ['pipe', 'ignore', 'ignore']});
}
async function inspectMath() {
  await page.locator('.rfe-preview .katex').first().waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    // This small font exposed Vite's data-URL inlining against font-src 'self'.
    await document.fonts.load('16px KaTeX_Size3');
  });
  const values = await page.locator('.rfe-preview').evaluate(root => ({
    equations: root.querySelectorAll('.katex').length, mathml: root.querySelectorAll('math').length,
    errors: root.querySelectorAll('.preview-math-error').length,
    text: root.textContent, annotation: [...root.querySelectorAll('annotation')].map(n => n.textContent),
    inlineCode: [...root.querySelectorAll('p > code')].map(n => n.textContent),
    emphasis: [...root.querySelectorAll('em')].map(n => n.textContent),
    code: [...root.querySelectorAll('pre > code')].map(n => n.textContent),
    fonts: [...document.fonts].filter(f => f.family.includes('KaTeX')).map(f => ({family: f.family, status: f.status})),
  }));
  assert.ok(values.equations >= 7, JSON.stringify(values)); assert.equal(values.mathml, values.equations);
  assert.equal(values.errors, 1); assert.ok(values.annotation.some(s => s.includes('T_{AB}T_{BC}=T_{AC}')));
  assert.ok(values.inlineCode.includes('T_{AB}')); assert.ok(values.emphasis.includes('important'));
  assert.ok(values.code.some(s => s.includes('$not_math$ and T_{AB}')));
  assert.ok(values.text.includes('$5 and $10')); assert.ok(values.text.includes('This paragraph must remain readable.'));
  assert.ok(values.fonts.some(f => f.family.includes('KaTeX_Main') && f.status === 'loaded'), 'Bundled KaTeX Main font loaded');
  assert.ok(values.fonts.some(f => f.family.includes('KaTeX_Math') && f.status === 'loaded'), 'Bundled KaTeX Math font loaded');
  assert.ok(values.fonts.some(f => f.family.includes('KaTeX_Size3') && f.status === 'loaded'), 'Bundled small KaTeX font loaded without a data URL');
  const copy = page.locator('.rfe-preview [data-copy-math]').first();
  const expected = await copy.evaluate(n => n.closest('[data-math-source]').dataset.mathSource);
  await clearClipboard(); await copy.click(); await until(() => clipboard().then(v => v === expected), {label: 'Copy TeX bytes'});
  copies.push({kind: 'math', expected, actual: await clipboard()});
  await page.locator('.rfe-preview [role=status]').filter({hasText: 'Copied'}).first().waitFor({state: 'visible'});
  record('M01-M03-M05-M06-math-source-and-accessible-fallback', values);
}
async function inspectDiagrams() {
  await until(() => page.locator('.technical-diagram svg').count().then(n => n === 3), {timeout: 120000, label: 'three offline diagram types'});
  const values = await page.locator('.rfe-preview').evaluate(root => ({
    figures: root.querySelectorAll('[data-mermaid-diagram]').length,
    svgs: root.querySelectorAll('.technical-diagram svg').length,
    unsafe: root.querySelectorAll('.technical-diagram svg script,.technical-diagram svg foreignObject,.technical-diagram svg a,.technical-diagram svg image,.technical-diagram svg [onclick],.technical-diagram svg [href]').length,
    text: root.textContent,
    sources: [...root.querySelectorAll('.technical-diagram-source code')].map(n => n.textContent),
  }));
  assert.equal(values.figures, 4); assert.equal(values.svgs, 3); assert.equal(values.unsafe, 0);
  assert.ok(values.text.includes('This paragraph must remain readable after the error.'));
  assert.ok(values.text.includes('Sensor capture')); assert.ok(values.text.includes('Monitor')); assert.ok(values.text.includes('Disconnected'));
  const copy = page.locator('.technical-diagram').first().getByRole('button', {name: /Copy/}).first();
  await clearClipboard(); await copy.click(); await until(() => clipboard().then(v => v.includes('flowchart LR')), {label: 'Copy diagram source'});
  copies.push({kind: 'diagram', actual: await clipboard()});
  const enlarge = page.locator('.technical-diagram').first().getByRole('button', {name: /Enlarge/});
  await enlarge.click();
  const fit = page.locator('.technical-diagram').first().getByRole('button', {name: 'Fit diagram', exact: true});
  assert.equal(await fit.getAttribute('aria-pressed'), 'true');
  record('diagram-enlarge', {pressed: 'true'});
  if (copies.filter(item => item.kind === 'diagram').length === 1) await screenshot('09-diagram-enlarged');
  await fit.click();
  record('D01-D03-D05-static-diagrams-errors-copy', values);
}
async function capture(label) {
  await fs.writeFile(path.join(output, label + '-aria.yml'), await page.locator('body').ariaSnapshot());
  await screenshot(label);
  const geometry = await page.locator('.rfe-preview').evaluate(root => ({
    width: root.clientWidth, scrollWidth: root.scrollWidth,
    blocks: [...root.querySelectorAll('.preview-math-display,.technical-diagram')].map(n => ({kind: n.className, width: n.clientWidth, scrollWidth: n.scrollWidth, x: n.getBoundingClientRect().x})),
  })); layout.push({label, ...geometry}); assert.ok(geometry.scrollWidth <= geometry.width + 2, JSON.stringify(geometry));
  if (label === '01-math-light' || label === '02-diagrams-light') {
    await page.locator('.rfe-preview').evaluate((root, text) => {
      const rect = root.getBoundingClientRect(), overlay = document.createElement('div');
      overlay.id = 'acceptance-area-overlay';
      Object.assign(overlay.style, {position:'fixed',pointerEvents:'none',zIndex:'2147483647',boxSizing:'border-box',border:'2px solid #7654bf',left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:Math.min(rect.height,innerHeight-rect.y-4)+'px'});
      const label = document.createElement('span'); label.textContent = text;
      Object.assign(label.style, {position:'absolute',right:'8px',top:'6px',background:'#7654bf',color:'white',padding:'5px 8px',borderRadius:'4px',font:'12px system-ui'});
      overlay.append(label); document.body.append(overlay);
    }, label.startsWith('01') ? 'V12.1 · Math reading' : 'V12.2 · Static diagram reading');
    try {await screenshot(label + '-annotated');}
    finally {await page.locator('#acceptance-area-overlay').evaluate(node => node.remove());}
  }
}
async function screenshot(name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (!driver.app) return driver.screenshot(name);
  const captured = await driver.app.evaluate(async ({BrowserWindow}) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return {png:image.toPNG().toString('base64'),size:image.getSize()};
  });
  await fs.writeFile(path.join(output, name+'.png'), Buffer.from(captured.png,'base64'));
  record('native-screenshot', {file:name+'.png',size:captured.size});
}
async function show(locator) {
  await locator.evaluate(node => node.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function preserveInCodeAndEdit(name, sample) {
  await page.getByRole('tab', {name:'Code',exact:true}).click();
  await page.locator('.rfe-source:not([hidden]) .cm-content').waitFor();
  assert.ok(await page.locator('.rfe-source:not([hidden])').innerText().then(text => text.includes(sample)));
  await page.getByRole('tab', {name:'Preview',exact:true}).click();
  await button('Edit this file').click();
  const editor = page.locator('.cm-content[contenteditable=true]'); await editor.click();
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await editor.press(mod+'+End'); await page.keyboard.insertText('\nTransient edit undone before Save.'); await editor.press(mod+'+z');
  await button('Save').click(); assert.deepEqual(await source(name), originals[name]);
  await button('Cancel changes').click(); await page.locator('.rfe-preview').waitFor({state:'visible'});
  record('code-edit-save-preserves-source', {name,hash:sha(originals[name])});
}
async function zoom(factor) {
  if (driver.app) await driver.app.evaluate(({BrowserWindow}, factor) => {const w = BrowserWindow.getAllWindows()[0]; w.webContents.setZoomFactor(factor); w.setContentSize(factor === 1 ? 1280 : 980, factor === 1 ? 900 : 850);}, factor);
  else await page.evaluate(factor => {document.body.style.zoom = String(factor);}, factor);
}
async function inspectHostile() {
  await openFile('hostile.md');
  await until(() => page.locator('.technical-diagram[data-diagram-state=ready]').count().then(n => n === 1), {timeout:120000,label:'later valid diagram after rejected inputs'});
  const result = await page.locator('.rfe-preview').evaluate(root => ({
    attacked: window.__technicalAttack ?? false,
    mathErrors: root.querySelectorAll('.preview-math-error').length,
    diagramsRejected: root.querySelectorAll('[data-diagram-state=error]').length,
    unsafeElements: root.querySelectorAll('script,iframe,foreignObject,svg a,svg image,svg [onclick],svg [onload]').length,
    validMath: root.querySelectorAll('math').length,
    text: root.textContent,
  }));
  assert.equal(result.attacked,false); assert.equal(result.mathErrors,4); assert.equal(result.diagramsRejected,6); assert.equal(result.unsafeElements,0); assert.equal(result.validMath,1);
  assert.ok(result.text.includes('Later safe diagram')); record('M07-D06-hostile-inputs-rejected-in-native-reader',result); await capture('08-native-input-rejections');
}
try {
  await launch(); await theme('GitHub Light Default');
  await button('Create new options').click(); await page.locator('.ra-menu-create').getByRole('button', {name: 'Import repository', exact: true}).click();
  await page.getByLabel('ZIP archive', {exact: true}).setInputFiles(zip); await page.getByLabel('Repository name', {exact: true}).fill(repo);
  await page.locator('.zi-dialog').getByRole('button', {name: 'Import repository', exact: true}).click(); await page.locator('.zi-dialog').waitFor({state: 'detached', timeout: 120000});
  await openFile('math.md'); await inspectMath(); await capture('01-math-light');
  await preserveInCodeAndEdit('math.md','T_{AB}T_{BC}=T_{AC}');
  await openFile('diagrams.md'); await inspectDiagrams(); await capture('02-diagrams-light');
  await preserveInCodeAndEdit('diagrams.md','flowchart LR');
  await theme('GitHub Dark Default'); await inspectDiagrams(); await capture('03-diagrams-dark'); await openFile('math.md'); await inspectMath(); await capture('04-math-dark');
  await zoom(2); await show(page.locator('.preview-math-display').nth(1)); await capture('05-math-200-percent');
  await show(page.locator('.preview-math-display').nth(2)); await capture('05b-units-greek-200-percent');
  await show(page.locator('.preview-math-inline').last()); await capture('05c-superscripts-200-percent');
  await zoom(1); await openFile('diagrams.md'); await zoom(2); await inspectDiagrams();
  await show(page.locator('.technical-diagram-viewport').first()); await capture('06-diagrams-200-percent');
  record('M02-D04-zoom', {kind: driver.app ? 'native WebContents zoom 2.0' : 'CSS zoom 2.0; native platform zoom not claimed'});
  await zoom(1);
  await openFile('large-diagram.md'); await page.locator('.technical-diagram[data-diagram-state=ready]').waitFor({timeout:120000});
  await page.getByRole('button',{name:'Enlarge',exact:true}).click();
  const large = await page.locator('.technical-diagram-viewport').evaluate(viewport => {
    viewport.scrollLeft = viewport.scrollWidth;
    return {width:viewport.clientWidth,scrollWidth:viewport.scrollWidth,scrollLeft:viewport.scrollLeft,labels:[...viewport.querySelectorAll('text')].map(node=>node.textContent)};
  });
  assert.ok(large.scrollWidth>large.width && large.scrollLeft>0); assert.equal(large.labels.filter(label=>/^Node \d+$/.test(label)).length,24);
  await show(page.locator('.technical-diagram-viewport')); await capture('10-large-diagram-enlarged');
  await page.getByRole('button',{name:'Fit diagram',exact:true}).click(); record('D04-large-native-diagram',large);
  await inspectHostile();
  for (const name of Object.keys(originals)) assert.deepEqual(await source(name), originals[name]);
  await close(); await launch(); await openFile('math.md'); await inspectMath(); await openFile('diagrams.md'); await inspectDiagrams(); await capture('07-offline-restart');
  for (const name of Object.keys(originals)) assert.deepEqual(await source(name), originals[name]);
  record('M04-D02-offline-restart-byte-preservation', {hashes: Object.fromEntries(Object.entries(originals).map(([name, bytes]) => [name, sha(bytes)]))});
  assert.deepEqual(requests, []); assert.equal(driver.errors.length, 0);
  assert.equal(driver.consoleErrors.length, 0, 'Native reader must have no console errors, including blocked font loads.'); await close();
} catch (error) {
  failure = {message: error.message, stack: error.stack}; console.error(error.stack);
  if (page && !page.isClosed()) {await driver.screenshot('failure').catch(() => {}); await fs.writeFile(path.join(output, 'failure-dom.txt'), await page.locator('body').innerText()).catch(() => {});}
  if (running) await close().catch(error => {failure.close = error.message;}); process.exitCode = 1;
} finally {
  await driver.report({status: failure ? 'failed' : 'passed', failure, metadata, host: {platform: process.platform, arch: process.arch, release: os.release()}, requests, copies, layout,
    limits: 'MathML/ARIA inspected; human screen-reader speech not qualified. Hostile-input acceptance recorded separately. General collection export remains deferred.'});
  console.log(JSON.stringify({status: failure ? 'failed' : 'passed', output}));
}
