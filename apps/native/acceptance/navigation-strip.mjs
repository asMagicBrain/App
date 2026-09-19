import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
/** Scoped native navigation acceptance after removing the repository V3 strip.
 * Reuses the existing driver and V3 layout scenarios. Disposable local data only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const testRoot = developmentTestRoot;
process.env.ASMB_ACCEPTANCE_RUN_ROOT ??= path.join(testRoot, 'runs/native-v020-navigation-search-20260918/qa');
assert.ok(process.env.ASMB_PACKAGED_EXECUTABLE, 'Supply the candidate/final packaged executable.');
const {createDriver, nativeTarget, testRoot: runRoot, until, sha} = await import('./native-driver.mjs');
await fs.mkdir(runRoot, {recursive: true});
const output = await fs.mkdtemp(path.join(runRoot, 'navigation-strip-'));
const data = path.join(output, 'data'), repository = 'Navigation-QA';
const workspacePath = path.join(data, 'workspaces/asMagicBrain', repository);
const definition = await fs.readFile(fileURLToPath(import.meta.url));
await fs.writeFile(path.join(output, 'driver-at-launch.mjs'), definition);
const driver = await createDriver({...nativeTarget(data), output, workspacePath});
const originalRecord = driver.record;
driver.record = (name, detail) => {originalRecord(name, detail); console.log(JSON.stringify({event: name}));};
const executable = process.env.ASMB_PACKAGED_EXECUTABLE;
const bundle = executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
const metadata = JSON.parse(await fs.readFile(path.join(bundle, 'Contents/Resources/app/native-package.json'), 'utf8'));
const fixture = path.join(output, 'zip-source'), zip = path.join(output, 'navigation.zip');
const initial = '# Navigation QA\n\nSaved source stays unchanged. Ω\n';
const marker = '\nPrivate navigation draft survives without V3. Ω\n';
await fs.mkdir(path.join(fixture, 'notes'), {recursive: true});
await fs.writeFile(path.join(fixture, 'README.md'), initial);
await fs.writeFile(path.join(fixture, 'other.md'), '# Other local file\n');
await fs.writeFile(path.join(fixture, 'notes/nested.md'), '# Nested local file\n');
execFileSync('/usr/bin/zip', ['-q', '-r', zip, '.'], {cwd: fixture, env: {PATH: '/usr/bin:/bin', TMPDIR: path.join(output, 'tmp')}});
const consoleErrors = [], networkRequests = [];
let page, running = false, failure, recorder, cdp;
const button = name => page.getByRole('button', {name, exact: true});
const editor = () => page.locator('.cm-content[contenteditable=true]');
const sidebarToggle = () => page.locator('.fw-titlebar').getByRole('button', {name: /file sidebar/i});
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 2, `${label}: ${actual} vs ${expected}`);
const text = () => editor().innerText();
async function launch() {
  page = await driver.launch(); running = true; page.setDefaultTimeout(15000);
  page.on('console', message => {if (message.type() === 'error') consoleErrors.push(message.text());});
  page.on('request', request => {if (/^https?:/.test(request.url())) networkRequests.push(request.url());});
  await page.context().setOffline(true);
  await driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000));
  await button('asMagicBrain home').waitFor(); await page.locator('.rc-document').waitFor();
  assert.equal(await page.locator('.rc-page [role=alert]').count(), 0);
}
async function closeNormally() {await stopVideo(); await driver.closeNormally(); running = false;}
async function selectRepository() {
  await button(/^Switch local repository:/).click();
  await page.locator('.rh-list').getByRole('button', {name: new RegExp(repository)}).click();
  await until(() => page.locator('.rc-identity h1').innerText().then(value => value === repository), {label: 'selected repository overview'});
  await until(async () => !await page.locator('.rc-page > [role=status]').count(), {label: 'overview read settled'});
}
async function overview({keyboard = false} = {}) {
  const target = page.locator('.rh-repository-name');
  assert.equal(await target.getAttribute('title'), 'Repository overview');
  if (keyboard) {await target.focus(); await target.press('Enter');} else await target.click();
  await until(async () => await page.locator('.rc-identity h1').isVisible() || await button('Leave editor').isVisible(), {label: 'overview or draft-preserving confirmation'});
  if (await button('Leave editor').isVisible()) await button('Leave editor').click();
  await page.locator('.rc-identity h1').waitFor();
}
async function openReadme() {await button('README.md').first().click(); await until(() => button('Edit this file').isEnabled(), {label: 'README file view'});}
async function edit() {await button('Edit this file').click(); await editor().waitFor();}
async function append(value) {await editor().click(); await editor().press('Meta+ArrowDown'); await page.keyboard.insertText(value);}
async function mode(hide) {
  const target = page.getByRole('switch', {name: 'Hide unavailable functions'});
  await target.focus();
  if ((await target.getAttribute('aria-checked') === 'true') !== hide) await target.press('Space');
  await until(() => target.getAttribute('aria-checked').then(value => value === String(hide)), {label: 'availability mode'});
  assert.equal(await target.evaluate(element => element === document.activeElement), true, 'visibility switch retains keyboard focus');
}
async function openTree(name) {await button('More actions for ' + name).click(); await page.getByRole('menuitem', {name: 'Open', exact: true}).click();}
async function geometry(name, {file = false, narrow = false, overlay = false} = {}) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.rt-bar, #repository-code-tab, #repository-code-panel, [aria-labelledby="repository-code-tab"]').count(), 0, 'V3 and orphaned tab semantics are absent');
  assert.equal(await page.locator('.rt-code-panel').count(), 1, 'retained flex wrapper');
  assert.equal(await page.locator('main main').count(), 0, 'no nested main landmark');
  assert.equal(await page.locator('.rt-code-panel').getAttribute('role'), null);
  assert.equal(await page.locator('.fw-documentbar').count(), 0, 'no replacement strip');
  const bounds = await page.evaluate(() => {
    const box = selector => {const element = document.querySelector(selector), r = element?.getBoundingClientRect(); return element?.checkVisibility() && r.width && r.height ? {x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom} : null;};
    return {viewport: {width: innerWidth, height: innerHeight}, title: box('.fw-titlebar'), rail: box('.fw-rail'), panel: box('.rt-code-panel'), scroll: box('.rc-scroll'), editor: box('.rfe'), main: box('.rfe-main'), documentPane: box('.rfe-document-pane'), sidebar: box('.rfe-sidebar'), sidebarHeader: box('.rfe-sidebar-header'), divider: box('.rfe-resizer'), tabs: document.querySelectorAll('.rt-bar').length};
  });
  near(bounds.title.height, 41, 'titlebar height unchanged'); near(bounds.rail.width, 42, 'rail width unchanged');
  near(bounds.panel.y, bounds.title.bottom, 'repository starts directly below titlebar');
  if (file) {
    assert.ok(bounds.main && bounds.documentPane && bounds.editor);
    near(bounds.main.y, bounds.title.bottom, 'document has no former V3 gap');
    near(bounds.documentPane.y, bounds.title.bottom, 'document column top');
    if (bounds.sidebar) {
      near(bounds.sidebar.y, bounds.title.bottom, 'sidebar top unchanged');
      near(bounds.sidebarHeader.height, 64, 'sidebar header height unchanged');
      if (!narrow) near(bounds.main.x, bounds.divider.right, 'document follows divider');
    } else near(bounds.main.x, bounds.rail.right, 'collapsed document starts beside rail');
  } else {assert.ok(bounds.scroll); near(bounds.scroll.y, bounds.title.bottom, 'overview/listing has no former V3 gap');}
  await driver.screenshot(name); await fs.writeFile(path.join(output, name + '-bounds.json'), JSON.stringify(bounds, null, 2));
  if (overlay) {
    await page.evaluate(bounds => {
      const layer = document.createElement('div'); layer.id = 'navigation-strip-qa-overlay'; layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      for (const [index, [label, r]] of [['V1 titlebar', bounds.title], ['V2 rail', bounds.rail], ['V4/V5 files', bounds.sidebar], ['Document pane', bounds.main ?? bounds.scroll]].entries()) {
        if (!r) continue; const color = ['#a9232f', '#6941a5', '#196a3e', '#005f8b'][index];
        const box = document.createElement('div'), badge = document.createElement('span');
        box.style.cssText = `position:fixed;box-sizing:border-box;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;border:2px solid ${color};background:${color}0d`;
        badge.textContent = label; badge.style.cssText = `background:white;color:${color};font:700 11px system-ui;padding:2px 4px`; box.append(badge); layer.append(box);
      } document.body.append(layer);
    }, bounds);
    try {await page.screenshot({path: path.join(output, name + '-overlay.png')});}
    finally {await page.evaluate(() => document.getElementById('navigation-strip-qa-overlay')?.remove());}
  }
  driver.record('V3-absent-and-retained-layout', {name, file, narrow, bounds, overlay});
  if (recorder) await new Promise(resolve => setTimeout(resolve, 250));
}

async function startVideo() {
  cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1440; canvas.height = 1000;
    const context = canvas.getContext('2d'), chunks = [], mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm;codecs=vp8';
    const stream = canvas.captureStream(12), recording = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 1500000});
    window.__asmbNavigationStripQAVideo = {canvas, context, chunks, recording, stream, mime};
    recording.ondataavailable = event => {if (event.data.size) chunks.push(event.data);}; recording.start(1000);
  });
  const state = recorder = {started: Date.now(), frames: 0, dropped: 0, busy: false, frameErrors: 0, listener: null};
  state.listener = async event => {
    void cdp.send('Page.screencastFrameAck', {sessionId: event.sessionId}).catch(() => {});
    if (state.busy) {state.dropped++; return;} state.busy = true;
    try {
      await page.evaluate(async jpeg => {
        const video = window.__asmbNavigationStripQAVideo; if (!video) return;
        const image = new Image(); image.src = 'data:image/jpeg;base64,' + jpeg; await image.decode();
        video.context.drawImage(image, 0, 0, video.canvas.width, video.canvas.height);
      }, event.data); state.frames++;
    } catch {state.frameErrors++;} finally {state.busy = false;}
  };
  cdp.on('Page.screencastFrame', state.listener);
  await cdp.send('Page.startScreencast', {format: 'jpeg', quality: 75, maxWidth: 1440, maxHeight: 1000, everyNthFrame: 1});
}
async function stopVideo() {
  if (!recorder) return;
  const state = recorder; recorder = null;
  await cdp.send('Page.stopScreencast'); cdp.off('Page.screencastFrame', state.listener);
  await until(() => !state.busy, {label: 'Navigation video frame drain'});
  const result = await page.evaluate(async () => {
    const video = window.__asmbNavigationStripQAVideo;
    await new Promise(resolve => {video.recording.onstop = resolve; video.recording.stop();});
    video.stream.getTracks().forEach(track => track.stop());
    const blob = new Blob(video.chunks, {type: video.mime});
    const base64 = await new Promise(resolve => {const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob);});
    delete window.__asmbNavigationStripQAVideo; return {base64, mime: video.mime};
  });
  const bytes = Buffer.from(result.base64, 'base64'), filename = 'navigation-strip-walkthrough.webm';
  await fs.writeFile(path.join(output, filename), bytes); await cdp.detach();
  driver.record('real-navigation-ui-walkthrough-recording', {file: filename, mime: result.mime, durationMs: Date.now() - state.started, capturedFrames: state.frames, droppedFrames: state.dropped, frameErrors: state.frameErrors, canvasRate: 12, bytes: bytes.length, scope: 'Regular-width first-launch navigation only; actual native renderer frames encoded with MediaRecorder. Narrow views have separate raw captures. No account/provider or live-profile operation.'});
  assert.ok(bytes.length > 0 && state.frames > 0); assert.equal(state.frameErrors, 0);
}

try {
  await launch();
  await button('Create new options').click(); await button('Import repository').click();
  await page.getByLabel('ZIP archive', {exact: true}).setInputFiles(zip);
  await page.getByLabel('Repository name', {exact: true}).fill(repository);
  await page.locator('.zi-dialog').getByRole('button', {name: 'Import repository', exact: true}).click();
  await page.locator('.zi-dialog').waitFor({state: 'detached', timeout: 60000}); await selectRepository();
  assert.equal(await fs.readFile(path.join(workspacePath, 'README.md'), 'utf8'), initial);
  driver.record('real-isolated-ZIP-import');
  await mode(false); await startVideo(); await geometry('overview-full', {overlay: true});
  await mode(true); await geometry('overview-implemented'); await mode(false);
  for (const kind of ['branches', 'tags']) {
    await page.locator('.rp-trigger').click(); if (kind === 'tags') await page.getByRole('tab', {name: 'Tags', exact: true}).click();
    await button('View all ' + kind).click(); await page.locator('.rl-page').waitFor();
    await geometry(kind + '-listing'); await overview({keyboard: true});
  }
  driver.record('branch-tag-and-overview-routes-remain-reachable');
  await openReadme(); await geometry('file-full', {file: true, overlay: true});
  const fileTabs = page.getByRole('tablist', {name: 'File view', exact: true});
  await fileTabs.getByRole('tab', {name: 'Code', exact: true}).click();
  assert.equal(await fileTabs.getByRole('tab', {name: 'Code', exact: true}).getAttribute('aria-selected'), 'true');
  await fileTabs.getByRole('tab', {name: 'Preview', exact: true}).click();
  await mode(true); await geometry('file-implemented', {file: true}); await mode(false);
  driver.record('file-Preview-Code-controls-retained');
  await edit(); await append(marker); await editor().evaluate(element => {window.__navigationOriginalEditor = element;});
  assert.equal(await editor().evaluate(element => element === document.activeElement), true);
  await geometry('editor-full', {file: true, overlay: true});
  assert.equal(await editor().evaluate(element => element === document.activeElement), true, 'capture/layout does not steal editor focus');
  await sidebarToggle().click(); await page.locator('.rfe-sidebar').waitFor({state: 'hidden'});
  await geometry('editor-sidebar-collapsed', {file: true});
  await sidebarToggle().click(); await page.locator('.rfe-sidebar').waitFor();
  const resize = page.getByRole('separator', {name: 'File sidebar width'}), width = Number(await resize.getAttribute('aria-valuenow'));
  await resize.focus(); await resize.press('ArrowRight'); await resize.press('ArrowRight');
  assert.equal(Number(await resize.getAttribute('aria-valuenow')), width + 32);
  await geometry('editor-sidebar-resized', {file: true});
  assert.equal(await editor().evaluate(element => element === window.__navigationOriginalEditor), true);
  await editor().click(); await editor().press('Meta+z'); assert.ok(!(await text()).includes(marker.trim()));
  await editor().press('Meta+Shift+z'); assert.ok((await text()).includes(marker.trim()));
  driver.record('editor-node-focus-draft-undo-preserved-across-layout');
  await openTree('notes'); await page.locator('.rfe-directory-table').waitFor(); await geometry('directory-full', {file: true});
  await openTree('README.md'); await edit(); assert.ok((await text()).includes(marker.trim()));
  driver.record('file-folder-editor-route-preserves-draft');
  await stopVideo();
  await editor().click();
  await driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(390, 760));
  await until(() => page.locator('.rfe').evaluate(element => element.classList.contains('rfe-narrow')), {label: 'narrow layout'});
  await page.locator('.rfe-sidebar').waitFor({state: 'hidden'});
  assert.equal(await editor().evaluate(element => element === document.activeElement && element === window.__navigationOriginalEditor), true, 'resize retains focused editor');
  await geometry('narrow-full', {file: true, narrow: true, overlay: true});
  await sidebarToggle().click(); await page.locator('.rfe-sidebar').waitFor();
  await geometry('narrow-full-drawer', {file: true, narrow: true, overlay: true});
  await sidebarToggle().click(); await page.locator('.rfe-sidebar').waitFor({state: 'hidden'});
  await mode(true); await geometry('narrow-implemented', {file: true, narrow: true});
  await sidebarToggle().click(); await page.locator('.rfe-sidebar').waitFor();
  await geometry('narrow-implemented-drawer', {file: true, narrow: true});
  await sidebarToggle().click(); await page.locator('.rfe-sidebar').waitFor({state: 'hidden'});
  assert.ok((await text()).includes(marker.trim()));
  await driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000));
  await until(() => page.locator('.rfe').evaluate(element => !element.classList.contains('rfe-narrow')), {label: 'regular layout restored'});
  await overview({keyboard: true}); await geometry('overview-after-editor');
  await openReadme(); await edit(); assert.ok((await text()).includes(marker.trim()));
  assert.equal(await fs.readFile(path.join(workspacePath, 'README.md'), 'utf8'), initial);
  driver.record('retained-header-overview-navigation-checkpoints-draft-without-saving');
  await closeNormally();
  await launch(); await selectRepository(); await openReadme(); await edit();
  assert.ok((await text()).includes(marker.trim()));
  assert.equal(await fs.readFile(path.join(workspacePath, 'README.md'), 'utf8'), initial);
  assert.equal(await page.getByRole('switch', {name: 'Hide unavailable functions'}).getAttribute('aria-checked'), 'true');
  await geometry('restart-draft', {file: true});
  driver.record('normal-restart-preserves-draft-saved-source-and-visibility-preference');
  assert.equal(driver.errors.length, 0); assert.equal(consoleErrors.length, 0); assert.equal(networkRequests.length, 0);
  await closeNormally();
} catch (error) {
  failure = {message: error.message, stack: error.stack}; console.error(error.stack);
  try {await driver.screenshot('failure'); await fs.writeFile(path.join(output, 'failure-dom.txt'), await page.locator('body').innerText());} catch {}
  try {if (running) await closeNormally();} catch (closeError) {failure.closeError = String(closeError);}
  process.exitCode = 1;
} finally {
  await driver.report({status: failure ? 'failed' : 'passed', failure, metadata, data, definitionSha256: sha(definition), consoleErrors, networkRequests, qualification: 'Actual candidate/final native UI with real isolated ZIP import, local navigation, geometry, draft and normal restart checks. No account/provider, default profile or remote operation. The existing file Preview/Code/Edit tabs remain in scope only as unchanged navigation.'});
  console.log(JSON.stringify({status: failure ? 'failed' : 'passed', output}));
}
