import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
/** Scoped actual packaged All repositories acceptance. Disposable Test profiles only.
 * Catalog, New repository, ZIP import and editor lifecycle use real local host services. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const testRoot = developmentTestRoot;
process.env.ASMB_ACCEPTANCE_RUN_ROOT ??= path.join(testRoot, 'runs/native-all-repositories-20260918/qa');
assert.ok(process.env.ASMB_PACKAGED_EXECUTABLE, 'Supply the ready candidate/final packaged executable.');
const {createDriver, nativeTarget, testRoot: runRoot, until, sha} = await import('./native-driver.mjs');
await fs.mkdir(runRoot, {recursive: true});
const output = await fs.mkdtemp(path.join(runRoot, 'all-repositories-'));
const data = path.join(output, 'data'), workspacePath = path.join(data, 'workspaces/asMagicBrain/Workspace');
const definition = await fs.readFile(fileURLToPath(import.meta.url));
await fs.writeFile(path.join(output, 'driver-at-launch.mjs'), definition);
const driver = await createDriver({...nativeTarget(data), output, workspacePath});
const originalRecord = driver.record;
driver.record = (name, detail) => {originalRecord(name, detail); console.log(JSON.stringify({event: name}));};
const executable = process.env.ASMB_PACKAGED_EXECUTABLE;
const bundle = executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
const metadata = JSON.parse(await fs.readFile(path.join(bundle, 'Contents/Resources/app/native-package.json'), 'utf8'));
const fixture = path.join(output, 'zip-source'), zip = path.join(output, 'repositories.zip');
const importedName = 'Zeta-Imported-QA', createdName = 'Alpha-Created-QA';
const importedSource = '# Catalog import fixture\n\nOriginal imported bytes remain unchanged. Ω\n';
const marker = '\nPrivate All repositories draft survives navigation. Ω\n';
await fs.mkdir(fixture); await fs.writeFile(path.join(fixture, 'README.md'), importedSource);
execFileSync('/usr/bin/zip', ['-q', zip, 'README.md'], {cwd: fixture, env: {PATH: '/usr/bin:/bin', TMPDIR: path.join(output, 'tmp')}});
const zipHash = sha(await fs.readFile(zip));
const consoleErrors = [], networkRequests = [];
let page, running = false, failure, recorder, cdp, initialReadme;
const button = name => page.getByRole('button', {name, exact: true});
const editor = () => page.locator('.cm-content[contenteditable=true]');
const exists = async filename => Boolean(await fs.lstat(filename).catch(() => null));
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 2, `${label}: ${actual} vs ${expected}`);
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
async function mode(hide) {
  const target = page.getByRole('switch', {name: 'Hide unavailable functions'});
  await target.focus();
  if ((await target.getAttribute('aria-checked') === 'true') !== hide) await target.press('Space');
  await until(() => target.getAttribute('aria-checked').then(value => value === String(hide)), {label: 'availability mode'});
  assert.equal(await target.evaluate(element => element === document.activeElement), true);
}
async function theme(label) {
  await button('asMagicBrain Theme').click(); await page.locator('.fw-theme-picker select').selectOption({label});
  await page.locator('.fw-theme-picker').getByRole('button', {name: 'Done', exact: true}).click();
}
async function openReadme() {
  await button('README.md').first().click();
  await until(() => button('Edit this file').isEnabled(), {label: 'README reader ready'});
  await button('Edit this file').click(); await editor().waitFor();
}
async function append(value) {await editor().click(); await editor().press('Meta+ArrowDown'); await page.keyboard.insertText(value);}
async function keyboardClick(target) {await target.focus(); await target.press('Enter');}

async function startVideo() {
  cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1440; canvas.height = 1000;
    const context = canvas.getContext('2d'), chunks = [], mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm;codecs=vp8';
    const stream = canvas.captureStream(12), recording = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 1500000});
    window.__asmbAllRepositoriesQAVideo = {canvas, context, chunks, recording, stream, mime};
    recording.ondataavailable = event => {if (event.data.size) chunks.push(event.data);}; recording.start(1000);
  });
  const state = recorder = {started: Date.now(), frames: 0, dropped: 0, busy: false, frameErrors: 0, listener: null};
  state.listener = async event => {
    void cdp.send('Page.screencastFrameAck', {sessionId: event.sessionId}).catch(() => {});
    if (state.busy) {state.dropped++; return;} state.busy = true;
    try {
      await page.evaluate(async jpeg => {
        const video = window.__asmbAllRepositoriesQAVideo; if (!video) return;
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
  await until(() => !state.busy, {label: 'Repositories video frame drain'});
  const result = await page.evaluate(async () => {
    const video = window.__asmbAllRepositoriesQAVideo;
    await new Promise(resolve => {video.recording.onstop = resolve; video.recording.stop();});
    video.stream.getTracks().forEach(track => track.stop());
    const blob = new Blob(video.chunks, {type: video.mime});
    const base64 = await new Promise(resolve => {const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob);});
    delete window.__asmbAllRepositoriesQAVideo; return {base64, mime: video.mime};
  });
  const bytes = Buffer.from(result.base64, 'base64'), filename = 'all-repositories-walkthrough.webm';
  await fs.writeFile(path.join(output, filename), bytes); await cdp.detach();
  driver.record('real-repositories-ui-walkthrough-recording', {file: filename, mime: result.mime, durationMs: Date.now() - state.started, capturedFrames: state.frames, droppedFrames: state.dropped, frameErrors: state.frameErrors, canvasRate: 12, bytes: bytes.length, scope: 'Regular-width first-launch navigation only; actual native renderer frames encoded with MediaRecorder. Narrow views have separate raw captures. No account/provider or live-profile operation.'});
  assert.ok(bytes.length > 0 && state.frames > 0); assert.equal(state.frameErrors, 0);
}



const catalog = () => page.locator('.ar-view');
const catalogButton = name => catalog().getByRole('button', {name, exact: true});
const entry = () => button('All repositories');
const navigationToggle = () => button('Toggle repository sidebar');
const row = name => catalogButton('Open repository ' + name);
const search = () => catalog().getByRole('searchbox', {name: 'Search repositories', exact: true});
const sort = () => catalog().getByRole('combobox', {name: 'Sort repositories', exact: true});
const rows = () => catalog().locator('.ar-repository-link');
const rowNames = () => rows().evaluateAll(elements => elements.map(element => element.getAttribute('aria-label').replace('Open repository ', '')));
async function settleCatalog() {
  await catalog().waitFor();
  await until(async () => !(await catalog().getByRole('status').allTextContents()).some(text => /Loading repositories/.test(text)), {label: 'catalog settled'});
  assert.equal(await catalog().getByRole('alert').count(), 0);
  assert.equal(await entry().getAttribute('aria-current'), 'page');
}
async function navigate({confirm = true, keyboard = false} = {}) {
  if (keyboard) await keyboardClick(entry()); else await entry().click();
  await until(async () => await catalog().isVisible() || await button('Leave editor').isVisible(), {label: 'catalog route or leave confirmation'});
  if (await button('Leave editor').isVisible()) {if (!confirm) return; await button('Leave editor').click();}
  await settleCatalog();
}
async function openRepository(name) {
  await row(name).click();
  if (await button('Leave editor').isVisible()) await button('Leave editor').click();
  await catalog().waitFor({state: 'detached'});
  await until(() => page.locator('.rc-identity h1').innerText().then(value => value === name), {label: 'selected repository overview'});
  await until(async () => !(await page.locator('.rc-page > [role=status]').count()), {label: 'selected repository read settled'});
  assert.equal(await page.locator('.rc-page [role=alert]').count(), 0);
}
async function openImport() {
  await button('Create new options').click();
  await page.locator('.ra-menu-create').getByRole('button', {name: 'Import repository', exact: true}).click();
}
async function readHeaderGeometry() {
  return page.evaluate(() => {
    const box = element => {const r = element?.getBoundingClientRect(); return element?.checkVisibility() && r.width && r.height ? {x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom} : null;};
    const visible = [...document.querySelectorAll('.fw-titlebar button')].map(element => ({name: element.getAttribute('aria-label') ?? element.textContent.trim(), disabled: element.disabled, ...box(element)})).filter(row => row.width > 0);
    return {viewport: {width: innerWidth, height: innerHeight}, title: box(document.querySelector('.fw-titlebar')), visibleButtons: visible,
      activeControls: ['.rh-home', '.fw-titlebar > [aria-label="Toggle repository sidebar"], .fw-titlebar > [aria-label="Toggle file sidebar"]', '.ra-all-repositories'].map(selector => box(document.querySelector(selector)))};
  });
}
function assertHeaderGeometry(header) {
  near(header.title.height, 41, 'retained titlebar height');
  for (const control of header.activeControls) assert.ok(control && control.width >= 24 && control.x >= 0 && control.right <= header.viewport.width + 1, 'active titlebar control within viewport: ' + JSON.stringify(control));
  for (const control of header.visibleButtons) assert.ok(control.x >= -1 && control.right <= header.viewport.width + 1 && control.y >= 0 && control.bottom <= header.title.bottom + 1, 'visible titlebar button within bounds: ' + JSON.stringify(control));
  for (let i = 0; i < header.visibleButtons.length; i++) for (let j = i + 1; j < header.visibleButtons.length; j++) {
    const a = header.visibleButtons[i], b = header.visibleButtons[j];
    const width = Math.min(a.right, b.right) - Math.max(a.x, b.x), height = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
    assert.ok(width <= 1 || height <= 1, 'visible titlebar buttons overlap: ' + JSON.stringify({a, b, width, height}));
  }
}
async function captureRepositoryHeader(name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const header = await readHeaderGeometry(); await fs.writeFile(path.join(output, name + '-bounds.json'), JSON.stringify(header, null, 2));
  assertHeaderGeometry(header); assert.equal(await catalog().count(), 0); assert.equal(await editor().isVisible(), true);
  assert.equal(await page.locator('.rt-bar').count(), 0); await driver.screenshot(name);
  driver.record('retained-repository-minimum-width-header', {name, header});
}
async function capture(name, {narrow = false, drawer = false} = {}) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.rt-bar, #repository-code-tab, #repository-code-panel').count(), 0);
  assert.equal(await page.locator('main main').count(), 0);
  assert.equal(await catalog().locator('.rfe-tree, .rfe-sidebar, [role=tree]').count(), 0, 'repository catalog navigation is not a file tree');
  const bounds = await page.evaluate(() => {
    const box = selector => {const element = document.querySelector(selector), r = element?.getBoundingClientRect(); return element?.checkVisibility() && r.width && r.height ? {x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom} : null;};
    const controls = [...document.querySelectorAll('.ar-view button, .ar-view input, .ar-view select')].filter(element => element.checkVisibility()).map(element => {const r = element.getBoundingClientRect(); return {label: element.getAttribute('aria-label') ?? element.textContent.trim(), x: r.x, right: r.right, width: r.width};});
    return {viewport: {width: innerWidth, height: innerHeight}, title: box('.fw-titlebar'), rail: box('.fw-rail'), catalog: box('.ar-view'), sidebar: box('.ar-sidebar'), heading: box('.ar-heading-row'), filter: box('.ar-search'), toolbar: box('.ar-list-toolbar'), list: box('.ar-repositories'), drawer: box('.ar-navigation-dialog'), controls};
  });
  bounds.header = await readHeaderGeometry();
  await fs.writeFile(path.join(output, name + '-bounds.json'), JSON.stringify(bounds, null, 2));
  assertHeaderGeometry(bounds.header); near(bounds.rail.width, 42, 'retained rail width');
  near(bounds.catalog.y, bounds.title.bottom, 'catalog begins below titlebar');
  assert.ok(bounds.catalog.x >= 0 && bounds.catalog.right <= bounds.viewport.width + 1);
  const overflow = await catalog().evaluate(element => ({width: element.clientWidth, scroll: element.scrollWidth}));
  assert.ok(overflow.scroll <= overflow.width + 1, 'catalog does not overflow horizontally');
  for (const control of bounds.controls) assert.ok(control.width > 0 && control.x >= -1 && control.right <= bounds.viewport.width + 1, JSON.stringify(control));
  if (!narrow && bounds.sidebar) near(bounds.sidebar.width, 256, 'dedicated repository navigation width');
  if (drawer) assert.equal(await page.getByRole('dialog', {name: 'Repository navigation', exact: true}).isVisible(), true);
  assert.equal(await entry().isVisible(), true, 'active catalog entry remains reachable narrow and in both modes');
  await driver.screenshot(name);
  await page.evaluate(bounds => {
    const layer = document.createElement('div'); layer.id = 'all-repositories-qa-overlay'; layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    for (const [index, [label, r]] of [['V1 / E1 titlebar', bounds.title], ['AR1 repository navigation', bounds.drawer ?? bounds.sidebar], ['AR2 heading', bounds.heading], ['AR3 name filter', bounds.filter], ['AR4 list controls', bounds.toolbar], ['AR5 repository rows', bounds.list]].entries()) {
      if (!r) continue; const color = ['#a9232f', '#6941a5', '#196a3e', '#005f8b', '#805300', '#006c70'][index];
      const box = document.createElement('div'), badge = document.createElement('span');
      box.style.cssText = `position:fixed;box-sizing:border-box;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;border:2px solid ${color};background:${color}0d`;
      badge.textContent = label; badge.style.cssText = `background:white;color:${color};font:700 11px system-ui;padding:2px 4px`; box.append(badge); layer.append(box);
    } (document.querySelector('.ar-navigation-dialog[open]') ?? document.body).append(layer);
  }, bounds);
  try {await page.screenshot({path: path.join(output, name + '-overlay.png')});}
  finally {await page.evaluate(() => document.getElementById('all-repositories-qa-overlay')?.remove());}
  driver.record('measured-repository-catalog-layout', {name, narrow, drawer, bounds});
  if (recorder) await new Promise(resolve => setTimeout(resolve, 300));
}

try {
  await launch(); initialReadme = await fs.readFile(path.join(workspacePath, 'README.md'));
  await mode(false); await navigate({keyboard: true});
  await row('Workspace').waitFor();
  assert.equal(await catalog().locator('.ar-count').innerText(), '1 repository');
  assert.equal(await catalog().getByRole('heading', {name: 'My repositories', level: 1, exact: true}).evaluate(element => element === document.activeElement), true);
  assert.equal(await catalogButton('My repositories').getAttribute('aria-current'), 'page');
  assert.match(await catalog().innerText(), /On this device/);
  assert.equal(await navigationToggle().getAttribute('aria-expanded'), 'true');
  await startVideo(); await capture('repositories-wide-full');
  driver.record('E1-keyboard-entry-opens-distinct-local-catalog-and-navigation');

  await catalogButton('New repository').click(); await page.locator('.nr-dialog').waitFor();
  await page.locator('.nr-dialog').getByRole('button', {name: 'Cancel', exact: true}).click(); await page.locator('.nr-dialog').waitFor({state: 'detached'});
  assert.equal(await catalogButton('New repository').evaluate(element => element === document.activeElement), true);
  await catalogButton('New repository').click(); await page.getByLabel('Repository name', {exact: true}).fill(createdName);
  await keyboardClick(page.locator('.nr-dialog').getByRole('button', {name: 'Create repository', exact: true}));
  await page.locator('.nr-dialog').waitFor({state: 'detached'});
  await until(() => exists(path.join(data, 'workspaces/asMagicBrain', createdName, '.git')), {label: 'real local repository creation'});
  assert.equal(await catalog().count(), 0); assert.equal(await page.locator('.rh-repository-name strong').innerText(), createdName);
  assert.deepEqual((await fs.readdir(path.join(data, 'workspaces/asMagicBrain', createdName))).filter(name => name !== '.git'), []);
  driver.record('catalog-New-repository-cancel-focus-and-real-creation-selection');

  await navigate(); await openImport(); await page.locator('.zi-dialog').waitFor();
  await page.locator('.zi-dialog').getByRole('button', {name: 'Cancel', exact: true}).click(); await page.locator('.zi-dialog').waitFor({state: 'detached'});
  assert.equal(await button('Create new options').evaluate(element => element === document.activeElement), true);
  await openImport(); await page.locator('.zi-dialog').waitFor();
  await page.getByLabel('ZIP archive', {exact: true}).setInputFiles(zip);
  await page.getByLabel('Repository name', {exact: true}).fill(importedName);
  await page.locator('.zi-dialog').getByRole('button', {name: 'Import repository', exact: true}).click();
  await page.locator('.zi-dialog').waitFor({state: 'detached', timeout: 60000});
  assert.equal(await catalog().count(), 0); assert.equal(await page.locator('.rh-repository-name strong').innerText(), importedName);
  assert.equal(await fs.readFile(path.join(data, 'workspaces/asMagicBrain', importedName, 'README.md'), 'utf8'), importedSource);
  assert.equal(sha(await fs.readFile(zip)), zipHash);
  driver.record('catalog-global-Import-cancel-focus-and-real-ZIP-selection', {zipHash});

  await navigate(); await until(() => rows().count().then(count => count === 3), {label: 'three actual catalog entries'});
  assert.equal(await catalog().locator('.ar-count').innerText(), '3 repositories');
  await sort().selectOption({label: 'Name A–Z'}); assert.deepEqual(await rowNames(), [createdName, 'Workspace', importedName]);
  await sort().selectOption({label: 'Name Z–A'}); assert.deepEqual(await rowNames(), [importedName, 'Workspace', createdName]);
  await search().fill('  zETA-iMPORTED  '); assert.deepEqual(await rowNames(), [importedName]);
  assert.equal(await catalog().locator('.ar-count').innerText(), '1 of 3 repositories');
  await search().fill('no-matching-repository'); assert.equal(await rows().count(), 0);
  assert.equal(await catalog().locator('.ar-count').innerText(), '0 of 3 repositories');
  assert.match(await catalog().locator('.ar-empty').innerText(), /No repositories match/);
  await capture('repositories-empty-filter'); await search().fill(''); await sort().selectOption({label: 'Name A–Z'});
  await catalogButton('Comfortable').click(); const comfortable = (await catalog().locator('.ar-repository-row').first().boundingBox()).height;
  await catalogButton('Compact').click(); assert.equal(await catalogButton('Compact').getAttribute('aria-pressed'), 'true');
  assert.equal(await catalogButton('Comfortable').getAttribute('aria-pressed'), 'false');
  assert.equal(await catalog().getAttribute('data-density'), 'compact');
  const compact = (await catalog().locator('.ar-repository-row').first().boundingBox()).height; assert.ok(compact < comfortable, 'compact rows reclaim height');
  assert.deepEqual(await rowNames(), [createdName, 'Workspace', importedName]);
  await capture('repositories-compact-sorted'); await catalogButton('Comfortable').click();
  driver.record('local-name-filter-empty-count-sort-and-density', {comfortable, compact});

  await catalogButton('Collapse sidebar').click();
  assert.equal(await navigationToggle().getAttribute('aria-expanded'), 'false');
  assert.equal(await catalog().locator('.ar-sidebar').isVisible(), false);
  await capture('repositories-sidebar-collapsed');
  await keyboardClick(navigationToggle()); assert.equal(await navigationToggle().getAttribute('aria-expanded'), 'true');
  await catalog().locator('.ar-sidebar').waitFor();
  for (const hidden of [true, false]) {
    await mode(hidden); assert.equal(await entry().isVisible(), true); assert.equal(await catalogButton('New repository').isVisible(), true);
    for (const label of ['My contributions', 'My forks', 'Admin access', 'Create view']) {
      const control = catalog().locator('.ar-sidebar').getByRole('button', {name: new RegExp('^' + label), includeHidden: true});
      assert.equal(await control.isDisabled(), true); assert.equal(await control.isVisible(), !hidden);
    }
  }
  await theme('GitHub Dark Default'); await mode(true); await capture('repositories-dark-implemented');
  await mode(false); await theme('GitHub Light Default');
  driver.record('distinct-navigation-collapse-keyboard-toggle-and-availability-modes');

  await openRepository('Workspace'); await openReadme(); await append(marker);
  await editor().evaluate(element => {window.__allRepositoriesOriginalEditor = element;});
  const originalSidebarOpen = await page.locator('.rfe-sidebar').isVisible();
  await navigate({confirm: false, keyboard: true}); await button('Keep editing').click();
  assert.equal(await catalog().count(), 0); assert.match(await editor().innerText(), /Private All repositories draft/);
  await navigate(); assert.equal(await editor().isVisible(), false);
  assert.equal(await editor().evaluate(element => element === window.__allRepositoriesOriginalEditor), true);
  assert.equal(await page.locator('.fw-repository-surface').getAttribute('hidden'), '');
  await catalogButton('Collapse sidebar').click(); await keyboardClick(navigationToggle());
  await catalogButton('Return to Workspace').click(); await editor().waitFor();
  assert.equal(await editor().evaluate(element => element === window.__allRepositoriesOriginalEditor), true);
  assert.equal(await page.locator('.rfe-sidebar').isVisible(), originalSidebarOpen);
  await until(() => page.locator('.rh-repository-name').evaluate(element => element === document.activeElement), {label: 'return focus'});
  await editor().click(); await editor().press('Meta+z'); assert.doesNotMatch(await editor().innerText(), /Private All repositories draft/);
  await editor().press('Meta+Shift+z'); assert.match(await editor().innerText(), /Private All repositories draft/);
  assert.deepEqual(await fs.readFile(path.join(workspacePath, 'README.md')), initialReadme);
  driver.record('catalog-return-retains-CM6-node-undo-draft-source-and-file-sidebar');

  await page.getByLabel('File path', {exact: true}).fill('proposed-catalog-name.md');
  await navigate({confirm: false}); await button('Keep editing').click();
  assert.equal(await page.getByLabel('File path', {exact: true}).inputValue(), 'proposed-catalog-name.md');
  await navigate();
  for (const action of [() => catalogButton('New repository').click(), openImport, () => row(createdName).click()]) {
    await action(); await page.locator('.fw-discard-dialog').waitFor(); await button('Keep editing').click();
    assert.equal(await catalog().isVisible(), true); assert.equal(await page.locator('.nr-dialog, .zi-dialog').count(), 0);
    assert.equal(await page.getByLabel('File path', {exact: true}).inputValue(), 'proposed-catalog-name.md');
  }
  await catalogButton('Return to Workspace').click(); await editor().waitFor();
  assert.equal(await page.getByLabel('File path', {exact: true}).inputValue(), 'proposed-catalog-name.md');
  assert.equal(await exists(path.join(workspacePath, 'proposed-catalog-name.md')), false);
  await page.getByLabel('File path', {exact: true}).fill('README.md');
  driver.record('hidden-filename-intent-guards-New-Import-and-repository-remount');

  await navigate();
  await keyboardClick(button('asMagicBrain home')); await page.locator('.wh-view[data-view=home]').waitFor();
  assert.equal(await page.locator('.fw-discard-dialog').count(), 0);
  await keyboardClick(button('asMagicBrain organization')); await page.locator('.wh-view[data-view=organization]').waitFor();
  assert.equal(await page.locator('.fw-discard-dialog').count(), 0);
  await navigate({keyboard: true});
  assert.equal(await editor().evaluate(element => element === window.__allRepositoriesOriginalEditor), true);
  driver.record('Home-organization-and-catalog-routes-retain-hidden-editor');
  await stopVideo();
  await driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(390, 760));
  await until(() => navigationToggle().getAttribute('aria-expanded').then(value => value === 'false'), {label: 'narrow sidebar closed'});
  await capture('repositories-narrow-full', {narrow: true});
  await driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(360, 760));
  await capture('repositories-minimum-width-full', {narrow: true});
  await keyboardClick(navigationToggle());
  await page.getByRole('dialog', {name: 'Repository navigation', exact: true}).getByRole('button', {name: 'Return to Workspace', exact: true}).click();
  await editor().waitFor(); await captureRepositoryHeader('repository-minimum-width-full');
  assert.equal(await editor().evaluate(element => element === window.__allRepositoriesOriginalEditor), true);
  await navigate();
  await driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(390, 760));
  await keyboardClick(navigationToggle()); await page.getByRole('dialog', {name: 'Repository navigation', exact: true}).waitFor();
  await capture('repositories-narrow-navigation', {narrow: true, drawer: true});
  await page.keyboard.press('Escape'); await page.getByRole('dialog', {name: 'Repository navigation', exact: true}).waitFor({state: 'hidden'});
  assert.equal(await navigationToggle().evaluate(element => element === document.activeElement), true);
  await keyboardClick(navigationToggle());
  const drawerBounds = await page.getByRole('dialog', {name: 'Repository navigation', exact: true}).boundingBox();
  assert.ok(drawerBounds.x + drawerBounds.width < 380, 'narrow drawer leaves a backdrop target');
  await page.mouse.click(380, 740);
  await page.getByRole('dialog', {name: 'Repository navigation', exact: true}).waitFor({state: 'hidden'});
  assert.equal(await navigationToggle().evaluate(element => element === document.activeElement), true);
  await mode(true); await theme('GitHub Dark Default'); await capture('repositories-narrow-dark-implemented', {narrow: true});
  await keyboardClick(button('asMagicBrain home')); await page.locator('.wh-view[data-view=home]').waitFor();
  await navigate({keyboard: true}); assert.equal(await entry().isVisible(), true);
  await keyboardClick(navigationToggle()); await page.getByRole('dialog', {name: 'Repository navigation', exact: true}).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await navigationToggle().evaluate(element => element === document.activeElement), true);
  driver.record('narrow-entry-modal-navigation-Escape-backdrop-focus-and-both-modes');
  await driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000));
  await closeNormally();

  await launch(); await navigate(); await until(() => rows().count().then(count => count === 3), {label: 'restored real catalog'});
  assert.deepEqual(new Set(await rowNames()), new Set([createdName, 'Workspace', importedName]));
  await capture('repositories-restarted'); await openRepository('Workspace'); await openReadme();
  assert.match(await editor().innerText(), /Private All repositories draft/);
  assert.equal(await page.getByLabel('File path', {exact: true}).inputValue(), 'README.md');
  assert.deepEqual(await fs.readFile(path.join(workspacePath, 'README.md')), initialReadme);
  assert.equal(await fs.readFile(path.join(data, 'workspaces/asMagicBrain', importedName, 'README.md'), 'utf8'), importedSource);
  assert.equal(await exists(path.join(workspacePath, 'proposed-catalog-name.md')), false);
  await driver.screenshot('repositories-restarted-private-draft');
  driver.record('normal-close-from-catalog-and-restart-preserve-real-catalog-draft-and-source');
  assert.equal(driver.errors.length, 0); assert.equal(consoleErrors.length, 0); assert.equal(networkRequests.length, 0);
  await closeNormally();
} catch (error) {
  failure = {message: error.message, stack: error.stack}; console.error(error.stack);
  try {await driver.screenshot('failure'); await fs.writeFile(path.join(output, 'failure-dom.txt'), await page.locator('body').innerText());} catch {}
  try {if (running) await closeNormally();} catch (closeError) {failure.close = closeError.message;}
  process.exitCode = 1;
} finally {
  await driver.report({status: failure ? 'failed' : 'passed', failure, metadata, definitionSha256: sha(definition), consoleErrors, networkRequests, scope: 'All repositories: real local catalog, New/Import and CM6 navigation with isolated Test data; no account/provider/default-profile operation.'});
  console.log(JSON.stringify({status: failure ? 'failed' : 'passed', output}));
}
