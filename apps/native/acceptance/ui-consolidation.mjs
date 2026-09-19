import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
/** Actual packaged v0.2.4 layout/outline acceptance, using disposable Test data.
 * Run with ASMB_PACKAGED_EXECUTABLE and --run-isolated. Renderer interactions use
 * the production native bridge; only a stale outline message is injected.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const testRoot = developmentTestRoot;
process.env.ASMB_ACCEPTANCE_RUN_ROOT ??= path.join(testRoot, 'runs/native-ui-consolidation-20260918/qa');
assert.ok(process.env.ASMB_PACKAGED_EXECUTABLE, 'Supply an admitted candidate/final executable.');
const {createDriver, nativeTarget, testRoot: runRoot, until, sha} = await import('./native-driver.mjs');
await fs.mkdir(runRoot, {recursive: true});
const output = await fs.mkdtemp(path.join(runRoot, 'ui-consolidation-'));
const data = path.join(output, 'data'), workspacePath = path.join(data, 'workspaces/asMagicBrain/Workspace');
const definition = await fs.readFile(fileURLToPath(import.meta.url));
await fs.writeFile(path.join(output, 'driver-at-launch.mjs'), definition);
const driver = await createDriver({...nativeTarget(data), output, workspacePath});
const record = driver.record;
driver.record = (name, detail) => {record(name, detail); console.log(JSON.stringify({event: name}));};
const executable = process.env.ASMB_PACKAGED_EXECUTABLE;
const bundle = executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
const metadata = JSON.parse(await fs.readFile(path.join(bundle, 'Contents/Resources/app/native-package.json'), 'utf8'));
const source = '# UI consolidation fixture\n\n' + Array.from({length: 18}, (_, i) =>
  `## Section ${String(i + 1).padStart(2, '0')}\n\n` + Array.from({length: 8}, (_, j) =>
    `Paragraph ${j + 1}. Local source bytes and Unicode Ω remain preserved while panels move.\n\n`).join('')).join('');
const draft = '\n## Private draft heading\n\nUnsaved consolidation marker Ω.\n';
const errors = [], networkRequests = [], semanticFailures = [];
const recordings = [];
let page, child, mainId, running = false, failure, workArea;
const button = name => page.getByRole('button', {name, exact: true});
const near = (actual, expected, label, tolerance = 2) => assert.ok(Math.abs(actual - expected) < tolerance, `${label}: ${actual} vs ${expected}`);
const focused = locator => locator.evaluate(node => node === document.activeElement || node.contains(document.activeElement));
const nextFrames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function bounded(promise, label, timeout = 4000) {
  let timer;
  try {return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(Error(label + ' timed out')), timeout);})]);}
  finally {clearTimeout(timer);}
}
const editor = () => page.locator('.rfe-source:not([hidden]) .cm-content');
const outlineToggle = () => button('Toggle document outline');
const fileToggle = () => button('Toggle file sidebar');
const catalogToggle = () => button('Toggle repository sidebar');
const watch = target => {
  target.setDefaultTimeout(15000);
  target.on('pageerror', error => errors.push({url: target.url(), message: error.message}));
  target.on('console', message => {if (message.type() === 'error') errors.push({url: target.url(), message: message.text()});});
  target.on('request', request => {if (/^https?:/.test(request.url())) networkRequests.push(request.url());});
};
async function mainAction(action, value) {
  return driver.app.evaluate(({BrowserWindow}, {id, action, value}) => {
    const win = BrowserWindow.fromId(id);
    if (action === 'bounds') return win.getBounds();
    if (action === 'resize') win.setContentSize(value.width, value.height);
    if (action === 'move') win.setPosition(value.x, value.y);
    if (action === 'minimize') win.minimize();
    if (action === 'restore') {win.restore(); win.show();}
    if (action === 'focus') win.focus();
    return win.getBounds();
  }, {id: mainId, action, value});
}
async function windows() {
  return driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().map(win => ({id: win.id, url: win.webContents.getURL(), visible: win.isVisible(), minimized: win.isMinimized(), parentId: win.getParentWindow()?.id ?? null, bounds: win.getBounds()})));
}
async function childWindow() {return (await windows()).find(win => win.url.endsWith('#outline'));}
async function connectChild() {
  if (child && !child.isClosed()) return child;
  child = await until(() => driver.app.windows().find(candidate => candidate.url().endsWith('#outline')), {label: 'separate outline renderer'});
  watch(child);
  await child.waitForLoadState('domcontentloaded');
  await child.evaluate(() => {
    if (!window.outlineCompanion) throw Error('Missing restricted outline bridge');
    if (window.asMagicBrain) throw Error('Outline renderer received the main repository bridge');
    window.__outlineQAState = null;
    window.outlineCompanion.onState(state => {window.__outlineQAState = state;});
    window.outlineCompanion.ready();
  });
  await until(() => child.evaluate(() => Boolean(window.__outlineQAState)), {label: 'outline state delivered'});
  return child;
}
async function ensureOutline(open = true) {
  if ((await outlineToggle().getAttribute('aria-expanded') === 'true') !== open) {await mainAction('focus'); await outlineToggle().click();}
  await until(() => outlineToggle().getAttribute('aria-expanded').then(value => value === String(open)), {label: `outline ${open ? 'open' : 'closed'}`});
  if (open) {await connectChild(); await until(async () => (await childWindow())?.visible, {label: 'outline companion visible'});}
  else await until(async () => !(await childWindow())?.visible, {label: 'outline companion hidden'});
}
async function launch() {
  page = await driver.launch(); running = true; child = null; watch(page);
  await page.context().setOffline(true);
  mainId = await driver.app.evaluate(({BrowserWindow}, url) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === url).id, page.url());
  workArea = await driver.app.evaluate(({screen}) => screen.getPrimaryDisplay().workArea);
  await mainAction('move', {x: workArea.x + 24, y: workArea.y + 24});
  await mainAction('resize', {width: Math.min(1200, workArea.width - 300), height: Math.min(940, workArea.height - 60)});
  await button('asMagicBrain home').waitFor(); await page.locator('.rc-document').waitFor();
  await page.evaluate(() => {
    window.__qaCloseTrace = []; window.asMagicBrain.onPrepareClose(value => window.__qaCloseTrace.push(value));
    window.__qaPointerTrace = [];
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(type, event => {
      window.__qaPointerTrace.push({type, x: event.clientX, y: event.clientY, primary: event.isPrimary, id: event.pointerId, target: event.target.className, focused: document.hasFocus()});
      if (window.__qaPointerTrace.length > 80) window.__qaPointerTrace.shift();
    }, true);
  });
  await driver.app.evaluate(({ipcMain}) => {
    globalThis.__qaCloseReady = [];
    ipcMain.on('asmb:close-ready', (event, value) => {globalThis.__qaCloseReady.push({sender: event.sender.id, value});});
  });
}
async function closeNormally() {
  await stopRecordings();
  try {await bounded(driver.closeNormally(), 'Normal native close', 25000); running = false;}
  catch (error) {
    console.log(JSON.stringify({event: 'close-timeout-diagnostics', message: error.message}));
    const diagnostic = {
      windows: await bounded(windows(), 'Native window diagnostics').catch(error => ({error: error.message})),
      closeReady: await bounded(driver.app.evaluate(() => globalThis.__qaCloseReady), 'Native close-ready diagnostics').catch(error => ({error: error.message})),
      renderer: await bounded(page.evaluate(() => ({closeTrace: window.__qaCloseTrace, pointerTrace: window.__qaPointerTrace, inert: document.querySelector('.fw-window')?.inert, focused: document.hasFocus(), active: document.activeElement?.outerHTML, body: document.body.innerText})), 'Renderer diagnostics').catch(error => ({error: error.message})),
    };
    await fs.writeFile(path.join(output, 'close-timeout-diagnostics.json'), JSON.stringify(diagnostic, null, 2));
    if (!page.isClosed()) await page.screenshot({path: path.join(output, 'close-timeout-main.png')}).catch(() => {});
    throw error;
  }
}
async function mode(hide) {
  await mainAction('focus');
  const control = page.getByRole('switch', {name: 'Hide unavailable functions', exact: true});
  if ((await control.getAttribute('aria-checked') === 'true') !== hide) await control.click();
  await until(() => control.getAttribute('aria-checked').then(value => value === String(hide)), {label: 'Hide/Show mode'});
  assert.equal(await control.getAttribute('title'), hide ? 'Show unavailable functions' : 'Hide unavailable functions');
}
async function theme(label) {
  await mainAction('focus');
  await button('asMagicBrain Theme').click();
  await page.locator('.fw-theme-picker select').selectOption({label});
  await page.locator('.fw-theme-picker').getByRole('button', {name: 'Done', exact: true}).click();
}
async function capture(name) {
  await nextFrames();
  await driver.screenshot(name + '-main');
  const state = await windows();
  if (child && !child.isClosed() && state.some(win => win.url.endsWith('#outline') && win.visible)) await child.screenshot({path: path.join(output, name + '-outline.png')});
  await fs.writeFile(path.join(output, name + '-windows.json'), JSON.stringify(state, null, 2));
  const areas = await page.evaluate(() => Object.fromEntries(Object.entries({V1: '.fw-titlebar', V4: '.rfe-sidebar-header', V5: '.rfe-managed-tree', V7: '.rfe-context', V9: '.rfe-toolbar', A: '.rc-identity', Overview: '.rc-document', AR1: '.ar-sidebar', AR2: '.ar-heading-row'}).map(([name, selector]) => {
    const node = document.querySelector(selector), rect = node?.getBoundingClientRect();
    return [name, node?.checkVisibility() && rect.width && rect.height ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height} : null];
  })));
  const outlineArea = child && !child.isClosed() ? await child.locator('.do-panel').evaluate(node => {const r = node.getBoundingClientRect(); return {x: r.x, y: r.y, width: r.width, height: r.height};}).catch(() => null) : null;
  await fs.writeFile(path.join(output, name + '-areas.json'), JSON.stringify({main: areas, outline: outlineArea, windows: state}, null, 2));
  const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const overlay = (dimensions, image, boxes) => `<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions.width}" height="${dimensions.height}" viewBox="0 0 ${dimensions.width} ${dimensions.height}"><image href="${xml(image)}" width="${dimensions.width}" height="${dimensions.height}"/>${Object.entries(boxes).filter(([, box]) => box).map(([label, box]) => {
    const x = Math.max(0, box.x), y = Math.max(0, box.y), width = Math.max(0, Math.min(box.x + box.width, dimensions.width) - x), height = Math.max(0, Math.min(box.y + box.height, dimensions.height) - y);
    if (!width || !height) return '';
    const text = `native ${label} · ${Math.round(box.width)} × ${Math.round(box.height)}`, labelWidth = Math.min(width, text.length * 7 + 12);
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#e879f9" fill-opacity=".035" stroke="#d946ef" stroke-width="1.5"/><rect x="${x}" y="${y}" width="${labelWidth}" height="20" fill="#701a75"/><text x="${x + 6}" y="${y + 14}" fill="white" font-family="ui-monospace,monospace" font-size="11">${xml(text)}</text>`;
  }).join('')}</svg>`;
  const dimensions = await page.evaluate(() => ({width: innerWidth, height: innerHeight}));
  await fs.writeFile(path.join(output, name + '-main-overlay.svg'), overlay(dimensions, name + '-main.png', areas));
  if (outlineArea && state.some(win => win.url.endsWith('#outline') && win.visible)) {
    const childDimensions = await child.evaluate(() => ({width: innerWidth, height: innerHeight}));
    await fs.writeFile(path.join(output, name + '-outline-overlay.svg'), overlay(childDimensions, name + '-outline.png', {Outline: outlineArea}));
  }
  driver.record('actual-native-two-window-capture', {name, windows: state, note: 'Separate uncomposited renderer captures; native coordinates are recorded.'});
}
async function startRecording(target, name) {
  const cdp = await target.context().newCDPSession(target);
  const dimensions = await target.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = innerWidth; canvas.height = innerHeight;
    const context = canvas.getContext('2d'), chunks = [], mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm;codecs=vp8';
    const stream = canvas.captureStream(12), recording = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 1200000});
    window.__consolidationVideo = {canvas, context, chunks, mime, stream, recording};
    recording.ondataavailable = event => {if (event.data.size) chunks.push(event.data);}; recording.start(1000);
    return {width: innerWidth, height: innerHeight};
  });
  const state = {target, cdp, name, dimensions, started: Date.now(), frames: 0, dropped: 0, errors: 0, busy: false, listener: null};
  state.listener = async event => {
    void cdp.send('Page.screencastFrameAck', {sessionId: event.sessionId}).catch(() => {});
    if (state.busy) {state.dropped++; return;} state.busy = true;
    try {await target.evaluate(async jpeg => {const video = window.__consolidationVideo; if (!video) return; const image = new Image(); image.src = 'data:image/jpeg;base64,' + jpeg; await image.decode(); video.context.drawImage(image, 0, 0, video.canvas.width, video.canvas.height);}, event.data); state.frames++;}
    catch {state.errors++;} finally {state.busy = false;}
  };
  recordings.push(state); cdp.on('Page.screencastFrame', state.listener);
  await cdp.send('Page.startScreencast', {format: 'jpeg', quality: 75, maxWidth: dimensions.width, maxHeight: dimensions.height, everyNthFrame: 1});
}
async function stopRecordings() {
  for (const state of recordings.splice(0)) {
    await state.cdp.send('Page.stopScreencast'); state.cdp.off('Page.screencastFrame', state.listener);
    await until(() => !state.busy, {label: state.name + ' recording frame drain'});
    const result = await state.target.evaluate(async () => {
      const video = window.__consolidationVideo;
      await new Promise(resolve => {video.recording.onstop = resolve; video.recording.stop();}); video.stream.getTracks().forEach(track => track.stop());
      const blob = new Blob(video.chunks, {type: video.mime});
      const base64 = await new Promise(resolve => {const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob);});
      delete window.__consolidationVideo; return {base64, mime: video.mime};
    });
    const bytes = Buffer.from(result.base64, 'base64'), filename = state.name + '-walkthrough.webm';
    await fs.writeFile(path.join(output, filename), bytes); await state.cdp.detach();
    driver.record('actual-native-renderer-recording', {file: filename, mime: result.mime, dimensions: state.dimensions, durationMs: Date.now() - state.started, capturedFrames: state.frames, droppedFrames: state.dropped, frameErrors: state.errors, canvasRate: 12, bytes: bytes.length, scope: 'One actual renderer stream; main and outline are separate recordings, never a desktop composite. Narrow layouts have separate raw screenshots.'});
    assert.ok(bytes.length > 0 && state.frames > 0); assert.equal(state.errors, 0);
  }
}
async function resizeMain(width, height = 850) {await mainAction('resize', {width, height: Math.min(height, workArea.height - 60)}); await nextFrames();}
async function leaveIfPrompt() {
  const leave = button('Leave editor');
  try {await leave.waitFor({state: 'visible', timeout: 1000});}
  catch {return;}
  await leave.click(); await leave.waitFor({state: 'hidden'});
}
async function openCatalog() {
  await mainAction('focus');
  await button('asMagicBrain organization').click(); await leaveIfPrompt(); await page.locator('.ar-view').waitFor();
  await until(async () => !(await page.locator('.ar-view [role=status]').allTextContents()).some(value => /Loading repositories/.test(value)), {label: 'catalog loaded'});
}
async function openReadme() {
  await button('README.md').first().click();
  await until(() => button('Edit this file').isEnabled(), {label: 'README viewer ready'});
}
async function widthOf(locator) {return locator.evaluate(node => node.getBoundingClientRect().width);}
async function focusNative(targetPage) {
  await driver.app.evaluate(({BrowserWindow}, url) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === url)?.focus(), targetPage.url());
  await until(() => targetPage.evaluate(() => document.hasFocus()), {label: 'target native window focused'});
}
async function scrollToLastHeading(scroller, label) {
  await until(async () => {
    await scroller.evaluate(node => {node.scrollTop = node.scrollHeight;});
    await nextFrames();
    const atBottom = await scroller.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop < 2);
    return atBottom && (await child.locator('.do-entry[aria-current=location]').innerText()).includes('Section 18');
  }, {label});
}
async function dragHandle(handle, delta, {release = true, targetPage = page} = {}) {
  await focusNative(targetPage);
  await handle.focus(); await nextFrames(); assert.equal(await focused(handle), true, 'resize handle has keyboard focus before dragging');
  const box = await handle.boundingBox(); assert.ok(box, 'resize handle is visible');
  const x = box.x + box.width / 2, y = box.y + Math.min(80, box.height / 2);
  await targetPage.mouse.move(x, y); await targetPage.mouse.down(); await targetPage.mouse.move(x + delta, y, {steps: 8});
  await nextFrames(); if (release) await targetPage.mouse.up(); await nextFrames();
}
async function assertCleanPointer() {
  assert.deepEqual(await page.evaluate(() => ({selection: document.body.style.userSelect, cursor: document.body.style.cursor})), {selection: '', cursor: ''});
}
async function leftPanelChecks({name, panel, toggle, label}) {
  if (!(await panel.isVisible())) await toggle.click();
  const handle = page.getByRole('separator', {name: label, exact: true});
  near(await widthOf(panel), 280, name + ' default');
  await dragHandle(handle, 80); near(await widthOf(panel), 360, name + ' pointer expansion');
  assert.equal(await focused(handle), true);
  await handle.press('ArrowLeft'); near(await widthOf(panel), 350, name + ' 10px key step');
  await handle.press('Enter'); await panel.waitFor({state: 'hidden'}); assert.equal(await focused(toggle), true);
  await toggle.click(); near(await widthOf(panel), 350, name + ' manual collapse preserves stable width');
  await handle.press('Home'); near(await widthOf(panel), 280, name + ' Home reset');
  await dragHandle(handle, 80); await dragHandle(handle, -68); near(await widthOf(panel), 280, name + ' snap within 16px');
  await dragHandle(handle, 65, {release: false}); await handle.press('Escape'); await page.mouse.up();
  near(await widthOf(panel), 280, name + ' Escape cancels drag'); await assertCleanPointer();
  await dragHandle(handle, 60); await handle.dblclick(); near(await widthOf(panel), 280, name + ' double-click reset');
  await dragHandle(handle, -100); near(await widthOf(panel), 180, name + ' minimum');
  await dragHandle(handle, -41); await panel.waitFor({state: 'hidden'}); assert.equal(await focused(toggle), true);
  await assertCleanPointer(); await toggle.click(); near(await widthOf(panel), 280, name + ' auto-collapse reopens default');
  await dragHandle(handle, 600); near(await widthOf(panel), 480, name + ' maximum');
  await handle.press('Home'); await assertCleanPointer();
  driver.record('left-panel-pointer-keyboard-snap-collapse-cleanup', {name});
}
async function assertFixtureBytes() {assert.equal(await fs.readFile(path.join(workspacePath, 'README.md'), 'utf8'), source);}

try {
  // Bootstrap a real isolated Workspace, then prepare saved fixtures with the app closed.
  await launch(); await closeNormally();
  await fs.writeFile(path.join(workspacePath, 'README.md'), source);
  await fs.writeFile(path.join(workspacePath, 'plain.txt'), 'No Markdown headings here. Ω\n');
  await launch(); await ensureOutline(true); await theme('GitHub Light Default');
  await startRecording(page, 'main'); await startRecording(child, 'outline');
  const overview = await page.evaluate(() => {
    const box = selector => {const rect = document.querySelector(selector).getBoundingClientRect(); return {x: rect.x, width: rect.width};};
    const article = document.querySelector('.rc-document article'), css = getComputedStyle(article);
    return {identity: box('.rc-identity'), card: box('.rc-document'), filebox: box('.rc-filebox'), prose: article.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight), container: {...box('.rc-scroll'), width: document.querySelector('.rc-scroll').clientWidth}};
  });
  near(overview.card.width, 904, 'overview card'); near(overview.prose, 838, 'overview prose');
  near(overview.identity.x, overview.card.x, 'identity/card left alignment'); near(overview.identity.width, 904, 'identity width');
  near(overview.filebox.x, overview.card.x, 'file list/card left alignment');
  near(overview.card.x - overview.container.x, overview.container.width - (overview.card.x - overview.container.x) - overview.card.width, 'centered overview gutters');
  assert.equal(await page.locator('.rc-about').count(), 0);
  for (const name of ['All issues', 'All pull requests', 'All repositories', 'All notifications']) assert.equal(await page.getByRole('button', {name: new RegExp('^' + name)}).count(), 0);
  driver.record('overview-904-card-838-prose-identity-alignment-and-G-through-J-removed', overview);
  for (const hide of [false, true]) {
    await mode(hide);
    for (const name of ['Ask agent', 'Ask agent options']) {
      const target = button(name); assert.equal(await target.isVisible(), true); assert.equal(await target.isDisabled(), true);
      await target.evaluate(node => node.click());
    }
    assert.equal(await page.locator('.ra-menu-agent').count(), 0);
  }
  await capture('overview-light-implemented');
  await openReadme();
  await leftPanelChecks({name: 'file sidebar', panel: page.locator('.rfe-sidebar'), toggle: fileToggle(), label: 'File sidebar width'});
  await capture('file-preview-native-areas');
  const previewWidthRule = await page.locator('.rfe-preview article').evaluate(node => {const style = getComputedStyle(node); return parseFloat(style.maxWidth) - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);});
  assert.equal(previewWidthRule, 1012, 'file Preview retains its separate text measure');
  await until(async () => await child.locator('.do-entry').count() === 19, {label: 'outline headings from real README'});
  assert.equal(await child.locator('.do-document,.do-level').count(), 0, 'outline chrome contains no filename or visible H-level badges');
  const preview = page.locator('.rfe-file-mode .rfe-main-scroll');
  await button('Edit this file').focus(); await scrollToLastHeading(preview, 'Preview scroll tracks last heading');
  assert.equal(await focused(button('Edit this file')), true, 'passive outline tracking retains main focus');
  assert.equal(await child.locator('.do-entry').last().evaluate(node => {const row = node.getBoundingClientRect(), nav = node.closest('.do-navigation').getBoundingClientRect(); return row.top >= nav.top - 1 && row.bottom <= nav.bottom + 1;}), true);
  await child.locator('.do-entry').first().click();
  await until(() => page.locator('.rfe-preview #source-heading-1').evaluate(node => node === document.activeElement), {label: 'outline selection returns focus to Preview'});
  await page.getByRole('tab', {name: 'Code', exact: true}).click();
  await editor().waitFor(); await page.getByRole('tab', {name: 'Code', exact: true}).focus();
  await scrollToLastHeading(page.locator('.rfe-file-mode .rfe-main-scroll'), 'Code scroll tracks heading');
  assert.equal(await focused(page.getByRole('tab', {name: 'Code', exact: true})), true, 'passive Code tracking retains main focus');
  await child.locator('.do-entry').first().click();
  try {await until(() => focused(editor()), {label: 'outline Code selection returns editor focus', timeout: 2000});}
  catch (error) {semanticFailures.push(error.message); driver.record('semantic-failure', {message: error.message});}
  await button('Edit this file').click(); await page.locator('.cm-content[contenteditable=true]').waitFor();
  const oldState = await child.evaluate(() => window.__outlineQAState);
  await editor().focus(); await editor().press('Meta+ArrowDown'); await page.keyboard.insertText(draft);
  await until(() => child.locator('.do-entry').last().innerText().then(value => value.includes('Private draft heading')), {label: 'live draft heading reaches companion'});
  await until(() => child.evaluate(revision => window.__outlineQAState.revision !== revision, oldState.revision), {label: 'outline revision changes with live draft'});
  const beforeStale = await editor().evaluate(node => ({text: node.innerText, scroll: node.closest('.cm-scroller').scrollTop, selection: window.getSelection()?.toString()}));
  await child.evaluate(({revision, id}) => window.outlineCompanion.action({type: 'select', revision, id}), {revision: oldState.revision, id: oldState.entries[0].id});
  await nextFrames(); await new Promise(resolve => setTimeout(resolve, 120));
  const afterStale = await editor().evaluate(node => ({text: node.innerText, scroll: node.closest('.cm-scroller').scrollTop, selection: window.getSelection()?.toString()}));
  assert.deepEqual(afterStale, beforeStale, 'stale outline revision cannot navigate or replace live text');
  await child.locator('.do-entry').first().click(); await until(() => focused(editor()), {label: 'outline Edit selection returns editor focus'});
  await until(() => child.locator('.do-entry').first().getAttribute('aria-current').then(value => value === 'location'), {label: 'Edit heading tracking'});
  for (const hide of [true, false]) {await mode(hide); assert.equal(await button('Commit changes…').isVisible(), true); assert.equal(await button('Commit changes…').isDisabled(), true);}
  await assertFixtureBytes(); driver.record('Preview-Code-Edit-scroll-selection-live-draft-stale-revision-and-focus');

  const initial = await mainAction('bounds'), firstChild = await childWindow();
  assert.equal(firstChild.parentId, mainId); near(firstChild.bounds.x, initial.x + initial.width, 'attached right edge'); near(firstChild.bounds.y, initial.y, 'attached top'); near(firstChild.bounds.height, initial.height, 'attached height'); near(firstChild.bounds.width, 240, 'outline default');
  await mainAction('move', {x: initial.x + 18, y: initial.y + 12});
  await until(async () => {const main = await mainAction('bounds'), outline = await childWindow(); return outline?.bounds.x === main.x + main.width && outline?.bounds.y === main.y;}, {label: 'outline follows native move'});
  await resizeMain(initial.width - 40, initial.height - 30);
  await until(async () => (await childWindow())?.bounds.height === (await mainAction('bounds')).height, {label: 'outline follows native resize'});
  const settledMain = await mainAction('bounds');
  const outlineHandle = child.getByRole('separator');
  await focusNative(child);
  await outlineHandle.press('ArrowRight'); await until(async () => (await childWindow())?.bounds.width === 250, {label: 'outline keyboard resize'});
  await outlineHandle.press('Home'); await until(async () => (await childWindow())?.bounds.width === 240, {label: 'outline default reset'});
  await dragHandle(outlineHandle, 80, {targetPage: child}); await until(async () => (await childWindow())?.bounds.width === 320, {label: 'native outline pointer resize'});
  await dragHandle(outlineHandle, -70, {targetPage: child}); await until(async () => (await childWindow())?.bounds.width === 240, {label: 'native outline pointer snap'});
  await dragHandle(outlineHandle, 60, {targetPage: child, release: false}); await outlineHandle.press('Escape'); await child.mouse.up();
  await until(async () => (await childWindow())?.bounds.width === 240, {label: 'native outline drag cancellation'});
  await dragHandle(outlineHandle, -101, {targetPage: child});
  await until(() => outlineToggle().getAttribute('aria-expanded').then(value => value === 'false'), {label: 'native outline automatic collapse'});
  await ensureOutline(true); await until(async () => (await childWindow())?.bounds.width === 240, {label: 'native outline reopens at default'});
  assert.deepEqual(await mainAction('bounds'), settledMain, 'outline resize preserves main bounds when pair fits');
  await child.locator('.do-header h2').focus(); await child.locator('.do-header h2').press('Escape');
  await until(() => outlineToggle().getAttribute('aria-expanded').then(value => value === 'false'), {label: 'outline Escape closes companion'});
  await until(() => focused(outlineToggle()), {label: 'outline Escape returns main toggle focus'});
  await ensureOutline(true);
  await theme('GitHub Dark Default');
  const mainTheme = await page.locator('.fw-window').evaluate(node => getComputedStyle(node).getPropertyValue('--fw-bg').trim());
  await until(() => child.locator('.fw-window').evaluate(node => getComputedStyle(node).getPropertyValue('--fw-bg').trim()).then(value => value === mainTheme), {label: 'native companion theme synchronization'});
  await capture('live-draft-dark-two-windows');
  await mainAction('minimize'); await until(async () => !(await childWindow())?.visible, {label: 'minimize hides companion'});
  await mainAction('restore'); await until(async () => (await childWindow())?.visible, {label: 'restore reattaches companion'});
  await ensureOutline(false); assert.equal(await focused(outlineToggle()), true);
  await ensureOutline(true);
  await driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#outline')).close());
  await until(() => outlineToggle().getAttribute('aria-expanded').then(value => value === 'false'), {label: 'native companion close updates main toggle'});
  await until(() => focused(outlineToggle()), {label: 'native companion close returns toggle focus'});
  await ensureOutline(true); driver.record('native-companion-parenting-geometry-move-resize-theme-minimize-show-hide-close-focus');

  await openCatalog(); await until(async () => await child.locator('.do-entry').count() === 0, {label: 'catalog clears stale outline entries'}); await child.locator('.do-empty').waitFor();
  for (const hide of [true, false]) {await mode(hide); assert.equal(await button('Workspace is always pinned').isVisible(), true); assert.equal(await button('Workspace is always pinned').isDisabled(), true);}
  await leftPanelChecks({name: 'catalog sidebar', panel: page.locator('.ar-sidebar'), toggle: catalogToggle(), label: 'Repository sidebar width'});
  await page.getByRole('separator', {name: 'Repository sidebar width'}).press('Home');
  await dragHandle(page.getByRole('separator', {name: 'Repository sidebar width'}), 200);
  await stopRecordings();
  await resizeMain(390, 780); await catalogToggle().click();
  const drawer = page.getByRole('dialog', {name: 'Repository navigation', exact: true}); await drawer.waitFor();
  near(await widthOf(drawer), 332, 'catalog drawer viewport cap');
  const drawerHandle = page.getByRole('separator', {name: 'Repository sidebar width'});
  try {await until(async () => Number(await drawerHandle.getAttribute('aria-valuenow')) === 332, {label: 'catalog drawer ARIA reflects cap', timeout: 2000});}
  catch (error) {semanticFailures.push(error.message); driver.record('semantic-failure', {message: error.message});}
  await dragHandle(drawerHandle, -30); near(await widthOf(drawer), 302, 'capped drawer shrinks without dead zone');
  await drawerHandle.press('Enter'); await drawer.waitFor({state: 'hidden'}); assert.equal(await focused(catalogToggle()), true);
  await catalogToggle().click(); await drawer.waitFor(); await drawer.press('Escape'); await drawer.waitFor({state: 'hidden'});
  await capture('catalog-narrow-empty-outline');
  await resizeMain(1200, 940); await button('Open repository Workspace').click(); await leaveIfPrompt(); await page.locator('.rc-document').waitFor(); await openReadme();
  if (!(await page.locator('.rfe-sidebar').isVisible())) await fileToggle().click();
  await dragHandle(page.getByRole('separator', {name: 'File sidebar width'}), 200);
  await resizeMain(420, 780); if (!(await page.locator('.rfe-sidebar').isVisible())) await fileToggle().click();
  const fileDrawer = page.locator('.rfe-sidebar'), fileHandle = page.getByRole('separator', {name: 'File sidebar width'});
  const cap = await page.locator('.rfe').evaluate(node => node.getBoundingClientRect().width * .85);
  near(await widthOf(fileDrawer), cap, 'file drawer caps at 85%');
  await dragHandle(fileHandle, -70); near(await widthOf(fileDrawer), Math.round(cap) - 70, 'file drawer shrinks from visible edge');
  await fileHandle.press('Enter'); await fileDrawer.waitFor({state: 'hidden'}); assert.equal(await focused(fileToggle()), true);
  await capture('file-narrow-drawer-collapsed');
  await resizeMain(1200, 940); await ensureOutline(true);
  await button('Search all repositories').click(); await page.locator('.ws-search-dialog').waitFor();
  await until(() => child.locator('.do-entry').first().isDisabled(), {label: 'main modal blocks companion navigation'});
  assert.equal(await child.locator('.do-entry').first().isVisible(), true);
  const entryCount = await child.locator('.do-entry').count();
  assert.ok(entryCount > 0); assert.equal(await child.locator('.do-entry:disabled').count(), entryCount);
  await capture('search-dialog-outline-blocked');
  await page.locator('.ws-search-dialog').getByRole('combobox').first().press('Escape'); await page.locator('.ws-search-dialog').waitFor({state: 'hidden'});
  await until(() => child.locator('.do-entry').first().isEnabled(), {label: 'closing main modal restores companion navigation'});
  driver.record('main-search-dialog-keeps-outline-visible-and-blocks-navigation');
  await ensureOutline(true); await focusNative(child); await child.locator('.do-header h2').focus();
  const closeShortcut = await driver.app.evaluate(({BrowserWindow, Menu}) => {
    const companion = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#outline'));
    const menu = Menu.getApplicationMenu().items.find(item => item.label === 'Window').submenu.items.find(item => item.label === 'Close');
    if (!companion.isFocused()) throw Error('Companion must own native focus before Window → Close');
    if (menu.accelerator !== 'CmdOrCtrl+W') throw Error('Native Close shortcut changed');
    menu.click(menu, companion, {});
    return {windowId: companion.id, accelerator: menu.accelerator, input: 'Actual Electron application menu Window → Close handler', limit: 'CDP and Electron synthetic key events did not invoke the macOS application-menu accelerator. The actual native menu action and its configured shortcut are verified; physical shortcut dispatch is not claimed.'};
  });
  await until(() => outlineToggle().getAttribute('aria-expanded').then(value => value === 'false'), {label: 'native Close menu closes only focused companion'});
  assert.equal(page.isClosed(), false); await until(() => focused(outlineToggle()), {label: 'companion native Close returns main toggle focus'});
  driver.record('focused-companion-native-menu-Close-closes-only-outline', closeShortcut);
  await resizeMain(1200, 940); await button('Edit this file').click(); await editor().waitFor();
  await editor().focus(); await editor().press('Meta+ArrowDown');
  assert.match(await editor().innerText(), /Unsaved consolidation marker/); await assertFixtureBytes();
  await mode(true); await capture('restored-live-draft-wide'); await closeNormally();
  await launch();
  await until(() => page.locator('.fw-window').evaluate(node => getComputedStyle(node).getPropertyValue('--fw-bg').trim()).then(value => value === mainTheme), {label: 'dark theme restored after normal restart'});
  assert.equal(await page.getByRole('switch', {name: 'Hide unavailable functions', exact: true}).getAttribute('aria-checked'), 'true', 'Show/Hide preference survives restart');
  await openReadme(); await button('Edit this file').click(); await editor().waitFor();
  await editor().focus(); await editor().press('Meta+ArrowDown');
  assert.match(await editor().innerText(), /Unsaved consolidation marker/); await assertFixtureBytes();
  await closeNormally();
  assert.deepEqual(driver.errors, []); assert.deepEqual(errors, []); assert.deepEqual(networkRequests, []);
  assert.deepEqual(semanticFailures, [], 'All native focus semantics must pass');
  driver.record('narrow-left-drawers-caps-focus-implemented-disabled-controls-draft-restart-and-normal-close');
} catch (error) {
  failure = {name: error.name, message: error.message, stack: error.stack};
  try {if (page && !page.isClosed()) {await fs.writeFile(path.join(output, 'failure-dom.txt'), await page.locator('body').innerText()); await fs.writeFile(path.join(output, 'failure-focus.json'), JSON.stringify(await page.evaluate(() => ({focused: document.hasFocus(), active: document.activeElement?.outerHTML, source: document.querySelector('.rfe-source:not([hidden]) .cm-content')?.outerHTML.slice(0, 1200)})), null, 2)); await fs.writeFile(path.join(output, 'failure-pointer-trace.json'), JSON.stringify(await page.evaluate(() => window.__qaPointerTrace), null, 2)); await capture('failure');}} catch {}
  throw error;
} finally {
  if (running) try {await closeNormally();} catch (error) {driver.record('normal-cleanup-close-failed', {message: error.message});}
  await driver.report({status: failure ? 'failed' : 'passed', failure, semanticFailures, sourceDefinition: {path: fileURLToPath(import.meta.url), sha256: sha(definition)}, metadata, fixtureSha256: sha(Buffer.from(source)), consoleErrors: errors, networkRequests,
    scope: 'Actual packaged native host, two BrowserWindows, shared React/CM6/Arborist, isolated Workspace, real pointer/keyboard input. One deliberately stale child IPC selection. Offline renderers; no live profile, account or remote repository.',
    limits: 'One prepared macOS display; captures are separate main/outline renderer images with native window coordinates, not a composited desktop recording. Physical Cmd+W dispatch is not claimed: native Window → Close menu action and its configured shortcut are tested because synthetic CDP/Electron keys do not invoke the macOS application-menu accelerator. Other display arrangements and operating systems require separate qualification.'});
  console.log(JSON.stringify({output, status: failure ? 'failed' : 'passed'}));
}
