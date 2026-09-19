import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
/** Actual packaged clipboard/inline-feedback acceptance. All fixtures/profile/evidence stay in Test. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const testRoot = developmentTestRoot;
const root = path.join(testRoot, 'runs/native-copy-feedback-20260917');
const executable = process.env.ASMB_PACKAGED_EXECUTABLE;
assert.deepEqual(process.argv.slice(2), ['--run-isolated'], 'Pass --run-isolated explicitly.');
assert.ok(executable && path.isAbsolute(executable) && executable.includes('.app/Contents/MacOS/'), 'Supply ASMB_PACKAGED_EXECUTABLE.');
assert.ok(executable.startsWith(path.join(appRoot, 'releases') + '/') || executable.startsWith(testRoot + '/runs/native-package/'), 'Use a canonical release or isolated candidate.');
import {_electron} from '../../../tools/playwright.mjs';
await fs.mkdir(root, {recursive: true});
const output = await fs.mkdtemp(root + '/acceptance-');
const data = output + '/data', tmp = output + '/tmp', fixture = output + '/fixture';
await fs.mkdir(tmp); await fs.mkdir(fixture);
const initial = '# Copy feedback QA\r\n\r\nRaw **Markdown** — café / 中文.  \r\n\r\n[Other](other.md)\r\n';
const other = '# Other file\n\nSeparate source.\n';
await fs.writeFile(fixture + '/README.md', initial);
await fs.writeFile(fixture + '/other.md', other);
await fs.mkdir(fixture + '/notes');
await fs.writeFile(fixture + '/notes/nested.md', '# Nested\n');
const zip = output + '/fixture.zip';
execFileSync('/usr/bin/zip', ['-q', '-r', zip, '.'], {cwd: fixture, env: {PATH: '/usr/bin:/bin', TMPDIR: tmp}});
const bundle = executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
const metadata = JSON.parse(await fs.readFile(bundle + '/Contents/Resources/app/native-package.json', 'utf8'));
const repo = 'Copy-QA', events = [], errors = [], consoleErrors = [];
let app, page, failure, originalClipboard;
const record = (name, detail = {}) => events.push({name, at: new Date().toISOString(), ...detail});
const button = name => page.getByRole('button', {name, exact: true});
const status = () => page.locator('.rfe-path-copy-status');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout; let last;
  do {try {last = await check(); if (last) return last;} catch (error) {last = error.message;} await new Promise(resolve => setTimeout(resolve, 50));} while (Date.now() < end);
  throw Error('Timeout ' + label + ': ' + last);
}
async function launch() {
  app = await _electron.launch({executablePath: executable, args: ['--test-data-root=' + data], cwd: output, env: {PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmp}});
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') consoleErrors.push(message.text());});
  await button('README.md').first().waitFor();
  const runtime = await app.evaluate(({app}) => ({packaged: app.isPackaged, executable: process.execPath, profile: app.getPath('userData'), cwd: process.cwd()}));
  assert.equal(runtime.packaged, true); assert.equal(runtime.executable, executable); assert.equal(runtime.profile, data + '-electron-profile'); assert.equal(runtime.cwd, output);
  originalClipboard = await app.evaluate(({clipboard}) => clipboard.readText());
  record('actual-packaged-launch', {runtime});
}
async function close() {
  if (typeof originalClipboard === 'string') await app.evaluate(({clipboard}, value) => clipboard.writeText(value), originalClipboard);
  const exit = app.waitForEvent('close', {timeout: 20000});
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].close()).catch(error => {if (!/closed|destroyed/i.test(String(error))) throw error;});
  await exit; record('native-window-close-and-process-exit');
}
async function select() {
  await button(/^Switch local repository:/).click();
  await page.locator('.rh-list').getByRole('button', {name: new RegExp('\\b' + repo + '\\b')}).click();
  await until(async () => await page.locator('.rc-identity h1').innerText() === repo, 'selected repository');
}
async function treeOpen(name) {
  await button('More actions for ' + name).click();
  await page.getByRole('menuitem', {name: 'Open', exact: true}).click();
  if (name === 'notes') await page.locator('.rfe-directory-table').waitFor();
  else await until(async () => await page.locator('.rfe-file-name').innerText() === name, 'open ' + name);
  await until(async () => !await page.locator('.rfe-loading').count(), 'navigation settled');
}
async function theme(name) {
  await button('asMagicBrain Theme').click();
  await page.locator('.fw-theme-picker select').selectOption({label: name});
  await button('Done').click();
}
async function measure() {
  return page.evaluate(() => {
    const box = element => {if (!element) return null; const r = element.getBoundingClientRect(); return {x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom};};
    const content = document.querySelector('.rfe-directory-table-frame') ?? document.querySelector('.rfe-editor-frame');
    const copy = document.querySelector('[aria-label="Copy file path"],[aria-label="Copy directory path"]');
    const feedback = document.querySelector('.rfe-path-copy-status');
    return {header: box(document.querySelector('.rfe-context')), revision: box(document.querySelector('.rfe-file-commit')), content: box(content), button: box(copy), feedback: box(feedback), viewport: {width: innerWidth, height: innerHeight}, documentWidth: document.documentElement.scrollWidth, feedbackText: feedback?.textContent, statusCount: document.querySelectorAll('.rfe-path-copy [role="status"]').length, extraRows: document.querySelectorAll('.rfe-copy-status').length};
  });
}
function stable(before, after) {
  for (const key of ['header', 'revision', 'content', 'button']) assert.deepEqual(after[key], before[key], key + ' geometry stays fixed');
  for (const key of ['x', 'width', 'right']) assert.equal(after.feedback[key], before.feedback[key], 'reserved feedback width/position stays fixed');
}
function inline(boxes) {
  assert.equal(boxes.statusCount, 1, 'one shared accessible inline feedback slot');
  assert.equal(boxes.extraRows, 0, 'no separate copy status row');
  assert.ok(boxes.feedback.x >= boxes.button.right - 1, 'feedback sits to the right of V7 Copy path');
  assert.ok(Math.abs(boxes.feedback.y + boxes.feedback.height / 2 - boxes.button.y - boxes.button.height / 2) < 3, 'feedback shares Copy path centerline');
  assert.ok(boxes.feedback.right <= boxes.header.right + 1, 'feedback remains inside V7');
  assert.ok(boxes.documentWidth <= boxes.viewport.width + 1, 'no page-level horizontal overflow');
}
async function shot(name, boxes) {
  await page.screenshot({path: output + '/' + name + '.png'});
  if (boxes) {
    await fs.writeFile(output + '/' + name + '-bounds.json', JSON.stringify(boxes, null, 2));
    await page.evaluate(boxes => {
      const layer = document.createElement('div'); layer.id = 'copy-feedback-qa-overlay'; layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      [['V7 · path and inline copy feedback', boxes.header, '#1976d2'], ['Shared feedback slot', boxes.feedback, '#a43aba'], ['V8 · revision (unchanged)', boxes.revision, '#c17300'], ['Document content (unchanged)', boxes.content, '#198356']].forEach(([label, r, color], index) => {
        if (!r) return; const region = document.createElement('div'); region.style.cssText = `position:fixed;box-sizing:border-box;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;border:2px solid ${color};background:${color}0d`;
        const badge = document.createElement('span'); badge.textContent = label; badge.style.cssText = `position:absolute;left:0;top:${index === 1 ? r.height + 2 : 0}px;white-space:nowrap;background:#111820;color:white;font:700 11px system-ui;padding:2px 4px`;
        region.append(badge); layer.append(region);
      }); document.body.append(layer);
    }, boxes);
    try {await page.screenshot({path: output + '/' + name + '-overlay.png'});} finally {await page.evaluate(() => document.getElementById('copy-feedback-qa-overlay')?.remove());}
  }
  record('actual-UI-capture', {name, overlay: Boolean(boxes)});
}
async function emptyFeedback() {await until(async () => await status().innerText() === '', 'feedback expiry', 6500);}
async function copyCheck(label, expected, name, {menu = false, capture = true} = {}) {
  await emptyFeedback(); const before = await measure(), started = Date.now();
  if (menu) {await button(label).click(); await page.getByRole('menuitem', {name: 'Copy path', exact: true}).click();} else await button(label).click();
  const message = label === 'Copy raw file' ? 'Raw file copied' : 'Path copied';
  await until(async () => await status().innerText() === message, message);
  const copied = await app.evaluate(({clipboard}) => clipboard.readText());
  assert.deepEqual(Buffer.from(copied, 'utf8'), Buffer.from(expected, 'utf8'), 'actual system clipboard preserves exact UTF-8 bytes/newlines');
  const after = await measure(); stable(before, after); inline(after);
  if (capture) await shot(name, after);
  await emptyFeedback(); stable(before, await measure());
  const durationMs = Date.now() - started; assert.ok(durationMs >= 1700 && durationMs < 6000, 'success is brief and expires');
  record('real-native-clipboard-inline-feedback', {label, message, expectedBytes: Buffer.byteLength(expected), expectedSha256: sha(expected), before, after, durationMs, menu});
}
async function installControlledClipboard() {
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator.clipboard, 'writeText');
    window.__copyFeedbackQA = {descriptor, calls: [], native: navigator.clipboard.writeText.bind(navigator.clipboard)};
    Object.defineProperty(navigator.clipboard, 'writeText', {configurable: true, value(text) {return new Promise((resolve, reject) => window.__copyFeedbackQA.calls.push({text, resolve, reject}));}});
  });
}
async function restoreClipboard() {
  await page.evaluate(() => {const qa = window.__copyFeedbackQA; if (!qa) return; if (qa.descriptor) Object.defineProperty(navigator.clipboard, 'writeText', qa.descriptor); else delete navigator.clipboard.writeText; delete window.__copyFeedbackQA;});
}
async function settle(index, fail = false) {
  await page.evaluate(({index, fail}) => {const call = window.__copyFeedbackQA.calls[index]; if (!call) throw Error('Missing controlled clipboard call'); fail ? call.reject(new DOMException('Isolated clipboard rejection', 'NotAllowedError')) : call.resolve();}, {index, fail});
  await page.waitForTimeout(80);
}
try {
  await launch();
  await button('Create new options').click(); await button('Import repository').click();
  await page.getByLabel('ZIP archive', {exact: true}).setInputFiles(zip);
  await page.getByLabel('Repository name', {exact: true}).fill(repo);
  await page.locator('.zi-dialog').getByRole('button', {name: 'Import repository', exact: true}).click();
  await page.locator('.zi-dialog').waitFor({state: 'detached', timeout: 60000});
  await select(); await button('README.md').first().click(); await until(() => button('Edit this file').isEnabled(), 'reader ready');
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
  await theme('GitHub Light Default');
  await copyCheck('Copy file path', 'README.md', 'path-light');
  await copyCheck('Copy raw file', initial, 'raw-light');
  await page.locator('.rfe-modes').getByRole('tab', {name: 'Code', exact: true}).click();
  await copyCheck('Copy raw file', initial, 'raw-code', {capture: false});
  await page.locator('.rfe-modes').getByRole('tab', {name: 'Preview', exact: true}).click();
  await copyCheck('More file options', 'README.md', 'path-menu', {menu: true, capture: false});
  // Both real clipboard buttons share one slot. The second successful action owns its text/timer.
  await button('Copy raw file').click(); await until(async () => await status().innerText() === 'Raw file copied', 'raw success');
  await page.waitForTimeout(1000); await button('Copy file path').click();
  await until(async () => await status().innerText() === 'Path copied', 'path replaces raw');
  await page.waitForTimeout(1200); assert.equal(await status().innerText(), 'Path copied', 'older timer cannot clear latest feedback');
  assert.equal(await app.evaluate(({clipboard}) => clipboard.readText()), 'README.md'); await emptyFeedback();
  await button('Copy file path').click(); await button('Copy raw file').click();
  await until(async () => await status().innerText() === 'Raw file copied', 'raw replaces path');
  assert.equal(await app.evaluate(({clipboard}) => clipboard.readText()), initial); await emptyFeedback();
  record('real-latest-copy-wins-and-restarts-expiry');

  // Deterministic delayed/rejected clipboard promises qualify feedback races, not native copy success.
  await installControlledClipboard();
  await button('Copy raw file').click(); await button('Copy file path').click();
  await settle(1); assert.equal(await status().innerText(), 'Path copied');
  await settle(0); assert.equal(await status().innerText(), 'Path copied', 'older raw success cannot replace latest path success');
  await button('Copy raw file').click(); await button('Copy file path').click();
  await settle(3); await settle(2, true); assert.equal(await status().innerText(), 'Path copied', 'older raw rejection cannot replace latest success');
  await restoreClipboard(); await emptyFeedback();
  record('controlled-clipboard-out-of-order-success-and-failure-ignored');
  await installControlledClipboard(); await button('Copy raw file').click();
  await treeOpen('other.md'); await settle(0); assert.equal(await status().innerText(), '', 'old file response cannot follow navigation');
  await restoreClipboard();
  await button('Copy raw file').click(); await until(async () => await status().innerText() === 'Raw file copied', 'other success');
  assert.equal(await app.evaluate(({clipboard}) => clipboard.readText()), other);
  await treeOpen('README.md'); assert.equal(await status().innerText(), '', 'completed feedback does not follow navigation');
  record('pending-and-completed-copy-feedback-clears-on-file-navigation');
  await installControlledClipboard(); const beforeFailure = await measure(); await button('Copy raw file').click(); const failureStarted = Date.now();
  await settle(0, true); assert.equal(await status().innerText(), 'Copy failed'); inline(await measure()); stable(beforeFailure, await measure());
  await shot('copy-failed-light', await measure()); await emptyFeedback();
  assert.ok(Date.now() - failureStarted >= 3500, 'failure remains briefly readable'); stable(beforeFailure, await measure());
  await restoreClipboard(); record('controlled-clipboard-rejection-uses-same-inline-slot-and-expires');

  await theme('GitHub Dark Default'); await copyCheck('Copy raw file', initial, 'raw-dark');
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(390, 760));
  await until(async () => await page.locator('.rfe').evaluate(element => element.classList.contains('rfe-narrow')), 'narrow layout');
  await page.locator('.rfe-sidebar').waitFor({state: 'hidden'});
  await copyCheck('Copy raw file', initial, 'raw-narrow-dark');
  await theme('GitHub Light Default'); await copyCheck('Copy raw file', initial, 'raw-narrow-light');
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
  await until(async () => !await page.locator('.rfe').evaluate(element => element.classList.contains('rfe-narrow')), 'wide layout');
  if (!await page.locator('.rfe-sidebar').isVisible()) await button('Toggle file sidebar').click();
  await treeOpen('notes'); await copyCheck('Copy directory path', 'notes', 'directory-inline');
  await copyCheck('More directory options', 'notes', 'directory-menu', {menu: true, capture: false});
  await button('Copy directory path').click(); await button('Go to parent directory').click();
  await until(async () => await page.locator('.rfe-breadcrumbs').innerText() === '', 'root directory');
  assert.equal(await status().innerText(), ''); await copyCheck('Copy directory path', '.', 'root-inline');
  assert.equal(await fs.readFile(data + '/workspaces/asMagicBrain/' + repo + '/README.md', 'utf8'), initial);
  assert.equal(await fs.readFile(data + '/workspaces/asMagicBrain/' + repo + '/other.md', 'utf8'), other);
  record('file-directory-root-path-and-source-preservation');
  assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []); await close();
} catch (error) {
  failure = {message: error.message, stack: error.stack}; console.error(error.stack);
  try {await shot('failure'); await fs.writeFile(output + '/failure-dom.txt', await page.locator('body').innerText());} catch {}
  try {await restoreClipboard(); if (app) await close();} catch {}
  process.exitCode = 1;
} finally {
  await fs.writeFile(output + '/receipt.json', JSON.stringify({status: failure ? 'failed' : 'passed', failure, executable, metadata, data, events, errors, consoleErrors, definitionSha256: sha(await fs.readFile(fileURLToPath(import.meta.url))), scope: 'Actual packaged UI/native clipboard successes. Controlled delayed/rejected clipboard calls are explicitly labelled and exercise only feedback races/error handling.'}, null, 2));
  console.log(JSON.stringify({status: failure ? 'failed' : 'passed', output}));
}
