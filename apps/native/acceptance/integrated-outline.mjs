import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
/** Actual packaged v0.2.5 integrated-outline acceptance.
 * Launch only with an admitted package and --run-isolated. All files, profiles,
 * recordings and diagnostics stay inside Test. No product callbacks are replaced.
 * DOM identity/event observations and one guarded programmatic modal click are
 * explicitly recorded; assertions otherwise use production UI/native behavior.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const testRoot = developmentTestRoot;
process.env.ASMB_ACCEPTANCE_RUN_ROOT ??= path.join(testRoot, 'runs/native-integrated-outline-20260918/qa');
assert.ok(process.env.ASMB_PACKAGED_EXECUTABLE, 'Supply an admitted candidate/final executable.');
const {createDriver, nativeTarget, testRoot: runRoot, until, sha} = await import('./native-driver.mjs');
await fs.mkdir(runRoot, {recursive: true});
const output = await fs.mkdtemp(path.join(runRoot, 'integrated-outline-'));
const data = path.join(output, 'data'), workspacePath = path.join(data, 'workspaces/asMagicBrain/Workspace');
const definition = await fs.readFile(fileURLToPath(import.meta.url));
await fs.writeFile(path.join(output, 'driver-at-launch.mjs'), definition);
const driver = await createDriver({...nativeTarget(data), output, workspacePath});
const record = driver.record;
driver.record = (name, detail) => {record(name, detail); console.log(JSON.stringify({event: name}));};
const executable = process.env.ASMB_PACKAGED_EXECUTABLE;
const bundle = executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
const metadata = JSON.parse(await fs.readFile(path.join(bundle, 'Contents/Resources/app/native-package.json'), 'utf8'));
const source = '# Integrated outline fixture\n\n' + Array.from({length: 18}, (_, i) =>
  `## Section ${String(i + 1).padStart(2, '0')}\n\n` + Array.from({length: 8}, (_, j) =>
    `Paragraph ${j + 1}. Local source bytes and Unicode Ω remain preserved while panels move.\n\n`).join('')).join('');
const draft = '\n## Private draft heading\n\nUnsaved integrated outline marker Ω.\n';
const savedMarker = '\nSaved after integration qualification. Ω\n';
const errors = [], networkRequests = [], mainDiagnostics = [], launchPids = [], recordings = [];
let page, mainId, running = false, failure, workArea, stderr = [], closeFailed = false, expectedSaved = source;
const button = name => page.getByRole('button', {name, exact: true});
const near = (actual, expected, label, tolerance = 2) => assert.ok(Math.abs(actual - expected) < tolerance, `${label}: ${actual} vs ${expected}`);
const focused = locator => locator.evaluate(node => node === document.activeElement || node.contains(document.activeElement));
const nextFrames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const editor = () => page.locator('.rfe-source:not([hidden]) .cm-content');
const outline = () => page.locator('.ido-panel');
const entries = () => outline().locator('.do-entry');
const outlineToggle = () => button('Toggle document outline');
const outlineHandle = () => page.getByRole('separator', {name: 'Resize document outline', exact: true});
const fileToggle = () => button('Toggle file sidebar');
const catalogToggle = () => button('Toggle repository sidebar');
const exists = async name => Boolean(await fs.lstat(name).catch(() => null));
const widthOf = locator => locator.evaluate(node => node.getBoundingClientRect().width);
async function bounded(promise, label, timeout = 4000) {
  let timer;
  try {return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(Error(label + ' timed out')), timeout);})]);}
  finally {clearTimeout(timer);}
}
async function mainAction(action, value) {
  return driver.app.evaluate(({BrowserWindow}, {id, action, value}) => {
    const win = BrowserWindow.fromId(id);
    if (action === 'resize') win.setContentSize(value.width, value.height);
    if (action === 'move') win.setPosition(value.x, value.y);
    if (action === 'focus') win.focus();
    if (action === 'fullscreen') win.setFullScreen(value);
    return {bounds: win.getBounds(), fullscreen: win.isFullScreen()};
  }, {id: mainId, action, value});
}
async function windows() {
  return driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().map(win => ({id: win.id, url: win.webContents.getURL(), visible: win.isVisible(), parentId: win.getParentWindow()?.id ?? null, bounds: win.getBounds()})));
}
async function oneWindow(label) {
  const state = await windows();
  assert.equal(state.length, 1, label + ': exactly one native BrowserWindow');
  assert.equal(state[0].id, mainId); assert.equal(state[0].parentId, null);
  assert.equal(state[0].url, 'app://asmagicbrain/index.html');
  const observation = await driver.app.evaluate(() => globalThis.__integratedQA);
  assert.deepEqual(observation.created, [], label + ': no additional native windows were created');
  assert.deepEqual(observation.exceptions, [], label + ': no main-process exceptions');
  assert.deepEqual(observation.gone, [], label + ': no renderer process failures');
  driver.record('single-native-window', {label, windows: state});
}
async function focusNative() {
  await mainAction('focus');
  await until(() => page.evaluate(() => document.hasFocus()), {label: 'main native window focused'});
}
async function launch() {
  page = await driver.launch(); running = true; closeFailed = false;
  launchPids.push(driver.app.process().pid); stderr = [];
  driver.app.process().stderr?.on('data', bytes => stderr.push(bytes.toString()));
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push({kind: 'renderer-javascript', message: error.message}));
  page.on('console', message => {if (message.type() === 'error') errors.push({kind: 'renderer-console', message: message.text()});});
  page.on('request', request => {if (/^https?:/.test(request.url())) networkRequests.push(request.url());});
  await page.context().setOffline(true);
  mainId = await driver.app.evaluate(({BrowserWindow, app}) => {
    const state = globalThis.__integratedQA = {created: [], exceptions: [], gone: [], closeReady: [], windowEvents: [], inputEvents: [], ipcEvents: []};
    process.on('uncaughtExceptionMonitor', error => state.exceptions.push({message: error.message, stack: error.stack}));
    app.on('browser-window-created', (_event, win) => state.created.push({id: win.id, at: Date.now()}));
    app.on('render-process-gone', (_event, contents, details) => state.gone.push({id: contents.id, details}));
    const all = BrowserWindow.getAllWindows();
    if (all.length !== 1) throw Error(`Expected one initial window; got ${all.length}`);
    const main = all[0];
    for (const type of ['move', 'resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) main.on(type, () => state.windowEvents.push({type, at: Date.now(), bounds: main.isDestroyed() ? null : main.getBounds()}));
    main.webContents.on('before-input-event', (_event, input) => {state.inputEvents.push({at: Date.now(), input}); if (state.inputEvents.length > 1600) state.inputEvents.shift();});
    main.webContents.on('ipc-message', (_event, channel, ...args) => {if (channel === 'asmb:native' && args[0]?.method === 'windowAction') state.ipcEvents.push({at: Date.now(), channel, args});});
    return main.id;
  });
  workArea = await driver.app.evaluate(({screen}) => screen.getPrimaryDisplay().workArea);
  await mainAction('move', {x: workArea.x + 24, y: workArea.y + 24});
  await resizeMain(Math.min(1440, workArea.width - 48), Math.min(940, workArea.height - 60));
  await button('asMagicBrain home').waitFor(); await page.locator('.rc-document').waitFor();
  await installRendererObservers();
  await driver.app.evaluate(({ipcMain}) => {ipcMain.on('asmb:close-ready', (event, value) => globalThis.__integratedQA.closeReady.push({sender: event.sender.id, value}));});
  assert.equal(await outlineToggle().getAttribute('aria-expanded'), 'false', 'outline starts collapsed');
  assert.equal(await outline().count(), 0);
  await oneWindow('fresh launch');
}
async function installRendererObservers() {
  await page.evaluate(() => {
    window.__qaCloseTrace = []; window.asMagicBrain.onPrepareClose(value => window.__qaCloseTrace.push(value));
    window.__qaInputTrace = [];
    for (const type of ['keydown', 'keyup', 'beforeinput', 'input']) document.addEventListener(type, event => {
      window.__qaInputTrace.push({type, at: Date.now(), key: event.key, code: event.code, meta: event.metaKey, shift: event.shiftKey, control: event.ctrlKey, alt: event.altKey, inputType: event.inputType, data: event.data, target: event.target.className, active: document.activeElement?.className});
      if (window.__qaInputTrace.length > 1600) window.__qaInputTrace.shift();
    }, true);
    window.__qaPointerTrace = [];
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(type, event => {
      window.__qaPointerTrace.push({type, x: event.clientX, y: event.clientY, id: event.pointerId, target: event.target.className, focused: document.hasFocus()});
      if (window.__qaPointerTrace.length > 80) window.__qaPointerTrace.shift();
    }, true);
  });
}
async function diagnostics(label) {
  const result = {label, pid: driver.app?.process().pid, stderr: stderr.join(''),
    windows: await bounded(windows(), 'window diagnostics').catch(error => ({error: error.message})),
    main: await bounded(driver.app.evaluate(() => globalThis.__integratedQA), 'main diagnostics').catch(error => ({error: error.message})),
    renderer: await bounded(page.evaluate(() => ({closeTrace: window.__qaCloseTrace, pointerTrace: window.__qaPointerTrace, inputTrace: window.__qaInputTrace, inert: document.querySelector('.fw-window')?.inert, focused: document.hasFocus(), active: document.activeElement?.outerHTML, body: document.body.innerText})), 'renderer diagnostics').catch(error => ({error: error.message})),
  };
  await fs.writeFile(path.join(output, label + '.json'), JSON.stringify(result, null, 2));
  if (!page.isClosed()) await bounded(page.screenshot({path: path.join(output, label + '.png')}), 'diagnostic screenshot').catch(() => {});
}
async function closeNormally({qualify = true} = {}) {
  await stopRecordings(); if (qualify) await oneWindow('before normal close');
  mainDiagnostics.push(await driver.app.evaluate(() => globalThis.__integratedQA));
  try {await bounded(driver.closeNormally(), 'Normal native close', 20000); running = false;}
  catch (error) {closeFailed = true; await diagnostics('normal-close-timeout'); throw error;}
  await fs.writeFile(path.join(output, `native-observed-stderr-${launchPids.length}.log`), stderr.join(''));
  assert.doesNotMatch(stderr.join(''), /TypeError:|ReferenceError:|SyntaxError:|Uncaught Exception|Object has been destroyed/, 'No native JavaScript exception in stderr');
}
async function ensureOutline(open = true, keyboard = false) {
  if ((await outlineToggle().getAttribute('aria-expanded') === 'true') !== open) {
    await focusNative();
    if (keyboard) {await outlineToggle().focus(); await outlineToggle().press('Enter');}
    else await outlineToggle().click();
  }
  await until(() => outlineToggle().getAttribute('aria-expanded').then(value => value === String(open)), {label: `outline ${open ? 'open' : 'closed'}`});
  await outline().waitFor({state: open ? 'visible' : 'detached'});
}
async function mode(hide) {
  const control = page.getByRole('switch', {name: 'Hide unavailable functions', exact: true});
  if ((await control.getAttribute('aria-checked') === 'true') !== hide) await control.click();
  await until(() => control.getAttribute('aria-checked').then(value => value === String(hide)), {label: 'Hide/Show mode'});
}
async function theme(label) {
  await button('asMagicBrain Theme').click(); await page.locator('.fw-theme-picker select').selectOption({label});
  await page.locator('.fw-theme-picker').getByRole('button', {name: 'Done', exact: true}).click();
}
async function resizeMain(width, height = 850) {await mainAction('resize', {width, height: Math.min(height, workArea.height - 60)}); await until(() => page.evaluate(expected => innerWidth === expected, width), {label: 'native content width ' + width}); await nextFrames();}
async function leaveIfPrompt() {
  const leave = button('Leave editor');
  try {await leave.waitFor({state: 'visible', timeout: 1000});} catch {return;}
  await leave.click(); await leave.waitFor({state: 'hidden'});
}
async function openCatalog() {
  await button('asMagicBrain organization').click(); await leaveIfPrompt(); await page.locator('.ar-view').waitFor();
  await until(async () => !(await page.locator('.ar-view [role=status]').allTextContents()).some(value => /Loading repositories/.test(value)), {label: 'catalog loaded'});
}
async function openReadme() {
  await button('README.md').first().click(); await until(() => button('Edit this file').isEnabled(), {label: 'README viewer ready'});
}
async function edit() {if (await button('Edit this file').isVisible()) await button('Edit this file').click(); await page.locator('.cm-content[contenteditable=true]').waitFor();}
async function append(text) {
  await editor().focus(); await editor().press('Meta+ArrowDown'); await nextFrames();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {if (i) await editor().press('Enter'); if (lines[i]) await page.keyboard.insertText(lines[i]);}
}
async function undoRedoDraft(label) {
  let groups = 0;
  while (await entries().count() === 20 && groups < 12) {await editor().press('Meta+z'); await nextFrames(); groups++;}
  assert.equal(await entries().count(), 19, label + ': undo removes live draft heading');
  for (let i = 0; i < groups; i++) {await editor().press('Meta+Shift+z'); await nextFrames();}
  await until(() => entries().count().then(value => value === 20), {label: label + ': redo restores live draft heading'});
  driver.record('undo-redo-exact-input-groups', {label, groups});
}
async function assertSaved() {assert.equal(await fs.readFile(path.join(workspacePath, 'README.md'), 'utf8'), expectedSaved);}
async function observeDraft(label) {
  const stateRoot = path.join(data, 'state/native/Workspace/files');
  const records = [];
  for (const name of await fs.readdir(stateRoot, {recursive: true}).catch(() => [])) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(stateRoot, name), bytes = await fs.readFile(file), value = JSON.parse(bytes);
    const payload = value.body?.payload;
    if (payload) records.push({name, sequence: value.body.sequence, mtime: (await fs.stat(file)).mtime.toISOString(), sha256: sha(bytes), drafts: payload.drafts?.map(item => ({documentId: item.documentId, marker: item.text.includes('Unsaved integrated outline marker'), length: item.text.length, tail: item.text.slice(-160)}))});
  }
  const snapshot = {label, at: new Date().toISOString(), windows: await windows(), main: await driver.app.evaluate(() => globalThis.__integratedQA), records,
    renderer: await page.evaluate(() => ({inputTrace: window.__qaInputTrace, pointerTrace: window.__qaPointerTrace, headings: [...document.querySelectorAll('.do-title')].map(node => node.textContent), textTail: document.querySelector('.cm-content')?.innerText.slice(-350), notice: [...document.querySelectorAll('.rfe-notice')].map(node => node.textContent), active: document.activeElement?.outerHTML.slice(0, 400)}))};
  await fs.writeFile(path.join(output, label + '-draft-observation.json'), JSON.stringify(snapshot, null, 2));
}
async function sameEditor(label) {
  assert.equal(await page.evaluate(() => window.__qaCmNode === document.querySelector('.cm-editor')), true, label + ': same CM6 DOM instance');
  assert.equal(await page.locator('.cm-editor').count(), 1, label + ': exactly one CM6 editor');
}
async function scrollToLastHeading(scroller, label) {
  await until(async () => {
    await scroller.evaluate(node => {node.scrollTop = node.scrollHeight;}); await nextFrames();
    return await scroller.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop < 2) &&
      (await entries().filter({has: page.locator('.do-title', {hasText: 'Section 18'})}).getAttribute('aria-current')) === 'location';
  }, {label});
}
async function keyboardReopenCurrent(label) {
  await ensureOutline(false); await ensureOutline(true, true);
  await until(() => outline().evaluate(node => {
    const active = document.activeElement, current = node.querySelector('.do-entry[aria-current=location]'), nav = node.querySelector('.do-navigation');
    if (!current || !nav || active !== current || !current.textContent.includes('Section 18')) return false;
    const row = current.getBoundingClientRect(), viewport = nav.getBoundingClientRect();
    return active.matches(':focus-visible') && row.top >= viewport.top - 1 && row.bottom <= viewport.bottom + 1;
  }), {label: label + ' keyboard reopen focuses visible current heading'});
  driver.record('keyboard-reopen-visible-current-heading', {mode: label});
}
async function dragHandle(handle, delta, {release = true} = {}) {
  await focusNative(); await handle.focus(); await nextFrames();
  const box = await handle.boundingBox(); assert.ok(box, 'resize handle is visible');
  const x = box.x + box.width / 2, y = box.y + Math.min(80, box.height / 2);
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + delta, y, {steps: 8});
  await nextFrames(); if (release) await page.mouse.up(); await nextFrames();
}
async function assertCleanPointer() {
  assert.deepEqual(await page.evaluate(() => ({selection: document.body.style.userSelect, cursor: document.body.style.cursor})), {selection: '', cursor: ''});
}
async function capture(name) {
  await nextFrames(); await driver.screenshot(name + '-main');
  const measured = await page.evaluate(() => {
    const box = selector => {const node = document.querySelector(selector), r = node?.getBoundingClientRect(); return node?.checkVisibility() && r.width && r.height ? {x: r.x, y: r.y, width: r.width, height: r.height} : null;};
    const areas = {V1: box('.fw-titlebar'), V4: box('.rfe-sidebar-header'), V5: box('.rfe-managed-tree'), V7: box('.rfe-context'), V9: box('.rfe-toolbar'), 'V12 Document canvas': box('.rfe-editor-frame'), A: box('.rc-identity'), Overview: box('.rc-overview-centered .rc-document'), AR1: box('.ar-sidebar'), Outline: box('.ido-panel')};
    if (areas.V4 && areas.V5) areas.V4.height = areas.V5.y - areas.V4.y;
    return {areas, viewport: {width: innerWidth, height: innerHeight}, documentWidth: document.documentElement.scrollWidth};
  });
  const state = await windows();
  await fs.writeFile(path.join(output, name + '-geometry.json'), JSON.stringify({...measured, windows: state}, null, 2));
  const raw = await fs.readFile(path.join(output, name + '-main.png'));
  const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const {width, height} = measured.viewport;
  const boxes = Object.entries(measured.areas).filter(([, box]) => box).map(([label, box]) => {
    const text = `native ${label} · ${Math.round(box.width)} × ${Math.round(box.height)}`;
    return `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="#e879f9" fill-opacity=".035" stroke="#d946ef" stroke-width="1.5"/><rect x="${box.x}" y="${box.y}" width="${Math.min(box.width, text.length * 7 + 12)}" height="20" fill="#701a75"/><text x="${box.x + 6}" y="${box.y + 14}" fill="white" font-family="ui-monospace,monospace" font-size="11">${xml(text)}</text>`;
  }).join('');
  await fs.writeFile(path.join(output, name + '-overlay.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image href="data:image/png;base64,${raw.toString('base64')}" width="${width}" height="${height}"/>${boxes}</svg>`);
  driver.record('native-integrated-capture', {name, windows: state, rawSha256: sha(raw), semantics: 'V4 includes file navigation controls through V5 start; V12 is the document canvas. SVG embeds unaltered raw PNG.'});
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
    driver.record('actual-native-renderer-recording', {file: filename, mime: result.mime, dimensions: state.dimensions, durationMs: Date.now() - state.started, capturedFrames: state.frames, droppedFrames: state.dropped, frameErrors: state.errors, canvasRate: 12, bytes: bytes.length, scope: 'One actual renderer stream; this is the single integrated application window, never a desktop composite. Narrow layouts have separate raw screenshots.'});
    assert.ok(bytes.length > 0 && state.frames > 0); assert.equal(state.errors, 0);
  }
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

try {
  // Bootstrap and shut down the actual package before preparing the isolated fixture.
  await launch(); await closeNormally();
  await fs.writeFile(path.join(workspacePath, 'README.md'), source);
  await fs.writeFile(path.join(workspacePath, 'plain.txt'), 'No Markdown headings here. Ω\n');
  await launch(); await theme('GitHub Light Default'); await mode(false);
  const overview = await page.evaluate(() => {
    const box = selector => {const rect = document.querySelector(selector).getBoundingClientRect(); return {x: rect.x, width: rect.width};};
    const article = document.querySelector('.rc-document article'), css = getComputedStyle(article);
    return {identity: box('.rc-identity'), card: box('.rc-document'), prose: article.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight), container: {...box('.rc-scroll'), width: document.querySelector('.rc-scroll').clientWidth}};
  });
  near(overview.card.width, 904, 'overview card'); near(overview.prose, 838, 'overview prose');
  near(overview.identity.x, overview.card.x, 'identity/card alignment');
  near(overview.card.x - overview.container.x, overview.container.width - (overview.card.x - overview.container.x) - overview.card.width, 'overview centered gutters');
  await capture('overview-collapsed-default');
  await button('Files').click(); await page.locator('.rfe-directory-readme article').waitFor();
  await ensureOutline(true, true); await entries().first().waitFor(); await entries().first().press('Escape');
  await outline().waitFor({state: 'detached'});
  assert.equal(await focused(page.locator('.rfe-directory-readme article')), true, 'directory README Escape returns article focus');
  await oneWindow('directory README navigation'); driver.record('directory-readme-Escape-document-focus');
  await openReadme(); await page.evaluate(() => {window.__qaCmNode = document.querySelector('.cm-editor');});
  const previewMeasure = await page.locator('.rfe-preview article').evaluate(node => {const css = getComputedStyle(node); return parseFloat(css.maxWidth) - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);});
  assert.equal(previewMeasure, 1012, 'file Preview retains its distinct prose maximum');
  await capture('file-preview-collapsed');
  await startRecording(page, 'integrated-main');
  const initialBounds = (await mainAction('bounds')).bounds;
  await ensureOutline(true);
  assert.equal(await focused(outlineToggle()), true, 'pointer-open retains toggle focus');
  assert.equal(await outline().locator('.do-header h2').getAttribute('tabindex'), null, 'title is an ordinary heading');
  await outline().locator('.do-header h2').click();
  assert.equal(await focused(outline().locator('.do-header h2')), false, 'pointer title never receives a focus square');
  await ensureOutline(false); await ensureOutline(true, true);
  await until(() => entries().count().then(value => value === 19), {label: '19 fixture headings'});
  const keyboardFocus = await outline().evaluate(node => {const active = document.activeElement; const css = getComputedStyle(active); return {inside: node.contains(active), visible: active.matches(':focus-visible'), outlineStyle: css.outlineStyle, outlineWidth: css.outlineWidth, title: active.tagName === 'H2'};});
  assert.equal(keyboardFocus.inside, true); assert.equal(keyboardFocus.visible, true); assert.equal(keyboardFocus.title, false);
  assert.notEqual(keyboardFocus.outlineStyle, 'none'); assert.ok(parseFloat(keyboardFocus.outlineWidth) > 0);
  await button('Close document outline').click(); assert.equal(await focused(outlineToggle()), true);
  for (let i = 0; i < 12; i++) {await ensureOutline(true, i % 2 === 0); await ensureOutline(false);}
  await ensureOutline(true); await oneWindow('24 repeated toggle actions'); await sameEditor('repeated toggles');
  assert.deepEqual((await mainAction('bounds')).bounds, initialBounds, 'opening and closing never moves or resizes main native frame');
  driver.record('collapsed-default-pointer-title-keyboard-focus-and-repeated-toggle', keyboardFocus);

  const previewScroll = page.locator('.rfe-file-mode .rfe-main-scroll');
  await button('Edit this file').focus(); await scrollToLastHeading(previewScroll, 'Preview tracks final heading');
  assert.equal(await focused(button('Edit this file')), true, 'passive Preview tracking preserves focus');
  await keyboardReopenCurrent('Preview');
  await entries().first().click();
  await until(() => page.locator('.rfe-preview #source-heading-1').evaluate(node => node === document.activeElement), {label: 'Preview heading selection focus'});
  await page.getByRole('tab', {name: 'Code', exact: true}).click(); await editor().waitFor();
  await scrollToLastHeading(page.locator('.rfe-file-mode .rfe-main-scroll'), 'Code tracks final heading');
  await keyboardReopenCurrent('Code');
  await entries().first().click(); await until(() => focused(editor()), {label: 'readonly Code heading focus'});
  await sameEditor('Preview and Code navigation');
  for (const hide of [false, true]) {
    await mode(hide);
    for (const name of ['History', 'Ask agent about this file', 'Raw', 'Download raw file']) assert.equal(await button(name).count(), 0, name + ' removed from read-only viewer');
    assert.equal(await page.getByRole('tab', {name: 'Blame', exact: true}).count(), 0);
    assert.equal(await button('Copy raw file').isVisible(), true);
    for (const name of ['Search files', 'Go to file', 'New Markdown file', 'Repository file actions']) assert.equal(await button(name).isVisible(), true, name + ' preserved');
    for (const name of ['Search documents', 'Repository browsing — unavailable', 'Additional tools — unavailable']) assert.equal(await button(name).count(), 0, name + ' removed from far-left rail');
    assert.equal(await page.locator('.fw-rail').getByRole('button', {name: 'Files', exact: true}).isVisible(), true);
  }
  await button('Go to file').click(); await page.locator('.ws-search-dialog').waitFor();
  await page.locator('.ws-search-dialog').getByRole('combobox', {name: 'Find a file', exact: true}).press('Escape');
  await page.locator('.ws-search-dialog').waitFor({state: 'hidden'});
  driver.record('removed-viewer-and-rail-controls-both-modes-preserved-sidebar-and-go-to-file');
  await edit(); await append(draft);
  await until(() => entries().last().innerText().then(text => text.includes('Private draft heading')), {label: 'live draft adds Outline heading'});
  await undoRedoDraft('live draft');
  await entries().first().click(); await until(() => focused(editor()), {label: 'Edit heading focus'});
  await entries().last().click(); await until(() => focused(editor()), {label: 'live draft heading selection focus'});
  await assertSaved(); await sameEditor('live draft undo redo');
  driver.record('Preview-Code-Edit-current-heading-click-live-draft-undo-redo-one-editor');

  // Right panel divider is its left edge: leftward input increases width.
  near(await widthOf(outline()), 240, 'outline default');
  await outlineHandle().press('ArrowLeft'); near(await widthOf(outline()), 250, 'outline left key increases 10');
  await outlineHandle().press('ArrowRight'); near(await widthOf(outline()), 240, 'outline right key decreases 10');
  await dragHandle(outlineHandle(), -80); near(await widthOf(outline()), 320, 'left-edge pointer expansion');
  await dragHandle(outlineHandle(), 70); near(await widthOf(outline()), 240, 'outline snap within 16');
  await dragHandle(outlineHandle(), -60, {release: false}); await outlineHandle().press('Escape'); await page.mouse.up();
  near(await widthOf(outline()), 240, 'outline Escape cancels active drag'); await assertCleanPointer();
  await dragHandle(outlineHandle(), -600); near(await widthOf(outline()), 480, 'outline maximum');
  await outlineHandle().press('Enter'); await outline().waitFor({state: 'detached'}); assert.equal(await focused(outlineToggle()), true);
  await ensureOutline(true); near(await widthOf(outline()), 480, 'manual collapse preserves width');
  await outlineHandle().press('Home'); near(await widthOf(outline()), 240, 'outline Home reset');
  await dragHandle(outlineHandle(), -50); await outlineHandle().dblclick(); near(await widthOf(outline()), 240, 'outline double click reset');
  await dragHandle(outlineHandle(), 60); near(await widthOf(outline()), 180, 'outline minimum');
  await dragHandle(outlineHandle(), 41); await outline().waitFor({state: 'detached'}); assert.equal(await focused(outlineToggle()), true);
  await ensureOutline(true); near(await widthOf(outline()), 240, 'auto collapse restores default'); await assertCleanPointer();
  await entries().first().focus(); await entries().first().press('Escape');
  await outline().waitFor({state: 'detached'}); assert.equal(await focused(editor()), true, 'Escape returns document focus');
  await ensureOutline(true); await sameEditor('outline pointer and keyboard resizing');
  assert.deepEqual((await mainAction('bounds')).bounds, initialBounds); await oneWindow('Outline resizing');
  driver.record('outline-left-edge-pointer-keyboard-snap-clamp-auto-collapse-cancel-and-focus');

  await leftPanelChecks({name: 'file sidebar', panel: page.locator('.rfe-sidebar'), toggle: fileToggle(), label: 'File sidebar width'});
  for (const hide of [false, true]) {
    await mode(hide);
    for (const name of ['Ask agent', 'Ask agent options']) {assert.equal(await button(name).isVisible(), true); assert.equal(await button(name).isDisabled(), true);}
    assert.equal(await button('Commit changes…').isVisible(), true); assert.equal(await button('Commit changes…').isDisabled(), true);
    assert.equal(await button('Search all repositories').isVisible(), true);
  }
  await mode(false);
  const fileRow = page.locator('.rex-row[data-explorer-path="README.md"]');
  await fileRow.click({button: 'right'}); const fileMenu = page.getByRole('menu', {name: 'Actions for README.md', exact: true}); await fileMenu.waitFor();
  assert.equal(await fileMenu.getByRole('menuitem', {name: 'Copy path', exact: true}).isEnabled(), true);
  await fileMenu.press('Escape'); await fileMenu.waitFor({state: 'detached'}); await sameEditor('preserved file context menu');

  await entries().last().click(); await nextFrames();
  const sourceScroll = page.locator('.cm-scroller');
  await button('Search all repositories').click(); const searchDialog = page.locator('.ws-search-dialog'); await searchDialog.waitFor();
  const beforeModal = await sourceScroll.evaluate(node => node.scrollTop);
  // Native modal top layer must reject focus; the explicit callback guard must
  // also ignore programmatic activation while the dialog is open.
  await entries().first().evaluate(node => {node.focus(); node.click();}); await nextFrames();
  assert.equal(await searchDialog.evaluate(node => node.contains(document.activeElement)), true, 'dialog owns focus');
  near(await sourceScroll.evaluate(node => node.scrollTop), beforeModal, 'dialog prevents hidden document navigation');
  await capture('global-search-top-layer');
  await searchDialog.getByRole('combobox').first().press('Escape'); await searchDialog.waitFor({state: 'hidden'});
  await entries().first().click(); await until(() => focused(editor()), {label: 'outline navigation resumes after dialog'});
  await oneWindow('search modal'); driver.record('main-modal-top-layer-and-outline-stale-action-guard');

  await editor().focus(); await editor().press('Meta+ArrowDown'); await undoRedoDraft('after panels and dialogs');
  await assertSaved(); await sameEditor('all panel controls and dialogs');
  await theme('GitHub Dark Default'); await capture('file-live-draft-integrated-dark');
  await theme('GitHub Light Default'); await stopRecordings(); await observeDraft('before-catalog');
  await openCatalog(); await observeDraft('catalog-entered'); await until(() => entries().count().then(value => value === 0), {label: 'catalog clears stale document headings'});
  await outline().locator('.do-empty').waitFor();
  await leftPanelChecks({name: 'catalog sidebar', panel: page.locator('.ar-sidebar'), toggle: catalogToggle(), label: 'Repository sidebar width'});
  await oneWindow('catalog and empty Outline'); await capture('catalog-integrated-empty'); await observeDraft('catalog-resized');
  await button('Open repository Workspace').click(); await leaveIfPrompt(); await page.locator('.rc-document').waitFor(); await observeDraft('repository-returned'); await openReadme(); await observeDraft('readme-viewer-returned'); await edit(); await observeDraft('edit-returned');
  await editor().focus(); await editor().press('Meta+ArrowDown'); assert.match(await editor().innerText(), /Unsaved integrated outline marker/); await assertSaved();
  await page.evaluate(() => {window.__qaCmNode = document.querySelector('.cm-editor');});
  for (const width of [1200, 800, 760, 600, 390]) {
    await resizeMain(width, 780); await ensureOutline(true); await oneWindow('responsive ' + width);
    const geometry = await page.evaluate(() => {
      const box = node => {const r = node.getBoundingClientRect(); return {x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height};};
      return {outline: box(document.querySelector('.ido-panel')), main: box(document.querySelector('.fw-main')), viewport: {width: innerWidth, height: innerHeight}, pageWidth: document.documentElement.scrollWidth, divider: getComputedStyle(document.querySelector('.ido-panel>.panel-resize-handle')).display};
    });
    assert.ok(geometry.outline.right <= geometry.viewport.width + 1 && geometry.outline.bottom <= geometry.viewport.height + 1);
    assert.ok(geometry.pageWidth <= geometry.viewport.width, 'responsive page does not overflow horizontally');
    if (width <= 760) {near(geometry.outline.x, geometry.main.x, 'bottom dock left'); near(geometry.outline.width, geometry.main.width, 'bottom dock width'); assert.ok(geometry.outline.y >= geometry.main.bottom - 1, 'dock does not overlay content'); assert.equal(geometry.divider, 'none');}
    else {near(geometry.outline.x, geometry.main.right, 'desktop adjoining panes'); assert.notEqual(geometry.divider, 'none');}
    await sameEditor('responsive ' + width); await capture('responsive-' + width);
  }
  await resizeMain(1200, 900); await mainAction('fullscreen', true);
  await until(async () => (await mainAction('bounds')).fullscreen, {timeout: 10000, label: 'native fullscreen entered'}); await nextFrames();
  await ensureOutline(false); await ensureOutline(true); await oneWindow('fullscreen toggles'); await capture('fullscreen-integrated');
  await mainAction('fullscreen', false); await until(async () => !(await mainAction('bounds')).fullscreen, {timeout: 10000, label: 'native fullscreen left'});
  await resizeMain(1200, 900); await sameEditor('fullscreen'); await assertSaved();
  driver.record('responsive-bottom-dock-native-fullscreen-and-single-editor');

  await ensureOutline(false); await append(savedMarker); await button('Save').click();
  expectedSaved = source + draft + savedMarker;
  await until(async () => await fs.readFile(path.join(workspacePath, 'README.md'), 'utf8') === expectedSaved, {label: 'explicit Save preserves exact bytes'});
  const restartDraft = '\n## Restart draft heading\n\nRetained across renderer reload and normal close.\n';
  await append(restartDraft); await ensureOutline(true);
  await until(() => entries().last().innerText().then(text => text.includes('Restart draft heading')), {label: 'restart draft heading'}); await assertSaved();
  // Allow the ordinary checkpoint signal to settle before an intentional reload.
  await until(async () => {
    const stateRoot = path.join(data, 'state/native/Workspace/files');
    const names = (await fs.readdir(stateRoot, {recursive: true})).filter(name => name.endsWith('.json'));
    for (const name of names) if ((await fs.readFile(path.join(stateRoot, name), 'utf8')).includes('Retained across renderer reload and normal close.')) return true;
    return false;
  }, {label: 'exact new draft marker reaches private native storage'});
  await page.reload(); await page.waitForLoadState('domcontentloaded'); await button('asMagicBrain home').waitFor(); await installRendererObservers();
  assert.equal(await outlineToggle().getAttribute('aria-expanded'), 'false', 'renderer reload starts collapsed'); await oneWindow('renderer reload');
  await openReadme(); await edit(); await editor().focus(); await editor().press('Meta+ArrowDown');
  assert.match(await editor().innerText(), /Retained across renderer reload and normal close/); await assertSaved();
  await ensureOutline(true); await entries().last().waitFor(); await capture('reload-retained-draft');
  await closeNormally();
  await launch(); await openReadme(); await edit(); await editor().focus(); await editor().press('Meta+ArrowDown');
  assert.match(await editor().innerText(), /Retained across renderer reload and normal close/); await assertSaved();
  await ensureOutline(true); await oneWindow('same isolated profile restart'); await capture('restart-retained-draft');
  await closeNormally();
  driver.record('exact-save-draft-renderer-reload-normal-close-and-same-profile-restart');
  assert.deepEqual(errors, []); assert.deepEqual(driver.errors, []); assert.deepEqual(networkRequests, []);
} catch (error) {
  failure = {name: error.name, message: error.message, stack: error.stack};
  if (page && !page.isClosed()) await diagnostics('failure').catch(() => {});
  throw error;
} finally {
  if (running && !closeFailed) try {await closeNormally({qualify: false});} catch (error) {failure ??= {name: error.name, message: error.message, stack: error.stack}; driver.record('normal-cleanup-close-failed', {message: error.message});}
  const processes = launchPids.map(pid => {let alive = true; try {process.kill(pid, 0);} catch (error) {if (error.code === 'ESRCH') alive = false;} return {pid, alive};});
  const locks = [];
  for (const root of [data, data + '-electron-profile']) if (await exists(root)) for (const name of await fs.readdir(root, {recursive: true})) if (/\.lock$|SingletonLock|lease/i.test(name)) locks.push({root, name});
  const cleanup = {processes, ownedNativeProcessRemaining: processes.some(item => item.alive), locks, nativeServiceLeaseRemaining: await exists(path.join(data, '.asmb-native.lock')), closeFailed};
  await fs.writeFile(path.join(output, 'cleanup-verification.json'), JSON.stringify(cleanup, null, 2));
  if (cleanup.ownedNativeProcessRemaining || cleanup.nativeServiceLeaseRemaining) failure ??= {name: 'CleanupError', message: 'Owned isolated native process remains; no forced termination attempted.'};
  await driver.report({status: failure ? 'failed' : 'passed', failure, sourceDefinition: {path: fileURLToPath(import.meta.url), sha256: sha(definition)}, metadata, fixtureSha256: sha(Buffer.from(source)), rendererObservations: errors, networkRequests, mainDiagnostics, cleanup,
    scope: 'One actual packaged Electron BrowserWindow, production bridge/React/CM6/Arborist, fresh isolated Test profile. Native geometry, pointer/keyboard controls, modal scope, real local draft/Save and lifecycle. Observational event/DOM identity probes; one programmatic behind-modal click verifies the production guard. No app callback replacement, live profile, remote repository or CUA app launch.',
    limits: 'One macOS display. Fullscreen is requested through the native BrowserWindow API. Keyboard events are renderer input; physical macOS application-menu accelerator dispatch is not claimed. Native close uses BrowserWindow.close and production preservation hooks. Screenshots/recording show the actual single renderer, not a desktop composite.'});
  console.log(JSON.stringify({output, status: failure ? 'failed' : 'passed'}));
}
