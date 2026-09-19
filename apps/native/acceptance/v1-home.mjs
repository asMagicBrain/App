import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
/** Actual packaged V1 Home/organization acceptance. Disposable Test profiles only.
 * Local repository operations are real. The account provider is explicitly synthetic. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const testRoot = developmentTestRoot;
process.env.ASMB_ACCEPTANCE_RUN_ROOT ??= path.join(testRoot, 'runs/native-v1-accounts-20260918/qa');
assert.ok(process.env.ASMB_PACKAGED_EXECUTABLE, 'Supply an exact candidate/final packaged executable.');
const {createDriver, nativeTarget, testRoot: runRoot, until, sha} = await import('./native-driver.mjs');
await fs.mkdir(runRoot, {recursive: true});
const output = await fs.mkdtemp(path.join(runRoot, 'v1-home-'));
const data = path.join(output, 'data'), workspacePath = path.join(data, 'workspaces/asMagicBrain/Workspace');
const definition = await fs.readFile(fileURLToPath(import.meta.url));
await fs.writeFile(path.join(output, 'driver-at-launch.mjs'), definition);
const driver = await createDriver({...nativeTarget(data), output, workspacePath});
const record = driver.record;
driver.record = (name, detail) => {record(name, detail); console.log(JSON.stringify({event: name}));};
const executable = process.env.ASMB_PACKAGED_EXECUTABLE;
const bundle = executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
const metadata = JSON.parse(await fs.readFile(path.join(bundle, 'Contents/Resources/app/native-package.json'), 'utf8'));
const consoleErrors = [];
const importedName = 'Home-Imported-QA', createdName = 'Home-Created-QA';
const fixture = path.join(output, 'zip-source'), zip = path.join(output, 'home-import.zip');
const importedSource = '# Home import fixture\n\nLocal ZIP bytes preserved. Ω\n';
await fs.mkdir(fixture); await fs.writeFile(path.join(fixture, 'README.md'), importedSource);
execFileSync('/usr/bin/zip', ['-q', zip, 'README.md'], {cwd: fixture, env: {PATH: '/usr/bin:/bin', TMPDIR: path.join(output, 'tmp')}});
const zipHash = sha(await fs.readFile(zip));
let page, running = false, failure, initialReadme, recorder, cdp, fixtureInstalled = false;
const button = name => page.getByRole('button', {name, exact: true});
const home = () => page.locator('.wh-view');
const homeButton = name => home().getByRole('button', {name, exact: true});
const cm = () => page.locator('.cm-content[contenteditable=true]');
const draftMarker = '\nPrivate V1 Home draft survives navigation Ω.\n';
const exists = async filename => Boolean(await fs.lstat(filename).catch(() => null));
const row = name => homeButton('Open repository ' + name);
async function settleRoute(view) {
  await page.locator(`.wh-view[data-view=${view}]`).waitFor();
  await until(() => home().locator('.wh-repositories').getAttribute('aria-busy').then(value => value === 'false'), {label: 'Home catalog loaded'});
  assert.equal(await home().locator('.wh-repositories [role=alert]').count(), 0);
}
async function navigate(view, {confirm = true, keyboard = false} = {}) {
  const target = button(view === 'home' ? 'asMagicBrain home' : 'asMagicBrain organization');
  if (keyboard) {await target.focus(); await page.keyboard.press('Enter');} else await target.click();
  await until(async () => await page.locator(`.wh-view[data-view=${view}]`).isVisible() || await button('Leave editor').isVisible(), {label: 'Home navigation or leave confirmation'});
  if (await button('Leave editor').isVisible()) {if (!confirm) return; await button('Leave editor').click();}
  await settleRoute(view);
}
async function openRepository(name) {
  await row(name).click();
  if (await button('Leave editor').isVisible()) await button('Leave editor').click();
  await page.locator('.wh-view').waitFor({state: 'detached'});
  await until(() => page.locator('.rc-identity h1').innerText().then(value => value === name), {label: 'Repository overview ' + name});
  await until(async () => !(await page.locator('.rc-page > [role=status]').count()), {label: 'Repository read finished'});
  assert.equal(await page.locator('.rc-page [role=alert]').count(), 0);
}
async function openReadme() {
  await button('README.md').first().click();
  await until(() => button('Edit this file').isEnabled(), {label: 'README reader ready'});
  await button('Edit this file').click(); await cm().waitFor();
}
async function append(text) {await cm().click(); await cm().press('Meta+ArrowDown'); await page.keyboard.insertText(text);}
async function theme(label) {await button('asMagicBrain Theme').click(); await page.locator('.fw-theme-picker select').selectOption({label}); await page.locator('.fw-theme-picker').getByRole('button', {name: 'Done', exact: true}).click();}
async function mode(value) {const toggle = page.getByRole('switch', {name: 'Hide unavailable functions'}); if ((await toggle.getAttribute('aria-checked') === 'true') !== value) await toggle.click();}
async function focusIs(selector) {return page.locator(selector).evaluate(element => element === document.activeElement);}
async function capture(name) {
  await driver.screenshot(name);
  const measured = await page.evaluate(() => {
    const selectors = {VH1: '.rh-home, .rh-owner', VH2: '.wh-heading-row', VH3: '.wh-account', VH4: '.wh-repositories-heading, .wh-search', VH5: '.wh-repository-list, .wh-empty, .wh-feedback'};
    const areas = [];
    for (const [id, selector] of Object.entries(selectors)) {
      const rows = [...document.querySelectorAll(selector)].filter(element => element.checkVisibility()).map(element => element.getBoundingClientRect()).filter(r => r.width && r.height);
      if (!rows.length) continue;
      const x = Math.min(...rows.map(r => r.x)), y = Math.min(...rows.map(r => r.y));
      areas.push({id, x, y, width: Math.max(...rows.map(r => r.right)) - x, height: Math.max(...rows.map(r => r.bottom)) - y});
    }
    return {viewport: {width: innerWidth, height: innerHeight}, view: document.querySelector('.wh-view')?.getAttribute('data-view') ?? 'repository', areas};
  });
  await fs.writeFile(path.join(output, name + '-bounds.json'), JSON.stringify(measured, null, 2));
  await page.evaluate(({areas}) => {
    const layer = document.createElement('div'); layer.id = 'v1-home-qa-overlay'; layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    areas.forEach((r, index) => {
      const color = ['#a9232f', '#005f8b', '#6941a5', '#196a3e', '#805300'][index % 5], box = document.createElement('div'), badge = document.createElement('span');
      box.style.cssText = `position:fixed;box-sizing:border-box;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;border:2px solid ${color};background:${color}0d`;
      badge.textContent = r.id; badge.style.cssText = `position:absolute;left:0;top:0;padding:2px 4px;font:700 11px system-ui;background:white;color:${color}`;
      box.append(badge); layer.append(box);
    }); (document.querySelector('dialog[open]') ?? document.body).append(layer);
  }, measured);
  try {await page.screenshot({path: path.join(output, name + '-overlay.png')});}
  finally {await page.evaluate(() => document.getElementById('v1-home-qa-overlay')?.remove());}
  driver.record('measured-VH-utility-capture', {raw: name + '.png', overlay: name + '-overlay.png', bounds: name + '-bounds.json'});
  if (recorder) await new Promise(resolve => setTimeout(resolve, 450));
}
async function geometry(label) {
  const result = await home().evaluate(element => {
    const r = element.getBoundingClientRect();
    const controls = [...element.querySelectorAll('button,input')].filter(node => node.checkVisibility()).map(node => {const box = node.getBoundingClientRect(); return {name: node.getAttribute('aria-label') ?? node.textContent.trim(), x: box.x, right: box.right, width: box.width};});
    return {x: r.x, right: r.right, width: innerWidth, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, controls};
  });
  assert.ok(result.x >= 0 && result.right <= result.width + 1 && result.scrollWidth <= result.clientWidth + 1, JSON.stringify(result));
  for (const control of result.controls) assert.ok(control.x >= result.x - 1 && control.right <= result.right + 1 && control.width > 0, JSON.stringify(control));
  driver.record('Home-viewport-and-action-containment', {label, ...result});
}
async function launch() {
  page = await driver.launch(); running = true; fixtureInstalled = false; page.setDefaultTimeout(15000);
  page.on('console', message => {if (message.type() === 'error') consoleErrors.push(message.text());});
  await button('asMagicBrain home').waitFor();
  await driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000));
  await page.context().setOffline(true);
  await page.locator('.rc-document').waitFor(); assert.equal(await page.locator('.rc-page [role=alert]').count(), 0);
  driver.record('initial-local-repository-readable-with-renderer-offline');
}
async function close() {
  await stopVideo();
  if (fixtureInstalled) await driver.app.evaluate(async () => {await globalThis.__v1AccountQA.auth.prepareClose(); await globalThis.__v1AccountQA.auth.close();});
  await driver.closeNormally(); running = false;
}

async function startVideo() {
  cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1440; canvas.height = 1000;
    const context = canvas.getContext('2d'), chunks = [], mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm;codecs=vp8';
    const stream = canvas.captureStream(12), recording = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 1500000});
    window.__asmbV1HomeQAVideo = {canvas, context, chunks, recording, stream, mime};
    recording.ondataavailable = event => {if (event.data.size) chunks.push(event.data);}; recording.start(1000);
  });
  const state = recorder = {started: Date.now(), frames: 0, dropped: 0, busy: false, frameErrors: 0, listener: null};
  state.listener = async event => {
    void cdp.send('Page.screencastFrameAck', {sessionId: event.sessionId}).catch(() => {});
    if (state.busy) {state.dropped++; return;} state.busy = true;
    try {
      await page.evaluate(async jpeg => {
        const video = window.__asmbV1HomeQAVideo; if (!video) return;
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
  await until(() => !state.busy, {label: 'Home video frame drain'});
  const result = await page.evaluate(async () => {
    const video = window.__asmbV1HomeQAVideo;
    await new Promise(resolve => {video.recording.onstop = resolve; video.recording.stop();});
    video.stream.getTracks().forEach(track => track.stop());
    const blob = new Blob(video.chunks, {type: video.mime});
    const base64 = await new Promise(resolve => {const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob);});
    delete window.__asmbV1HomeQAVideo; return {base64, mime: video.mime};
  });
  const bytes = Buffer.from(result.base64, 'base64'), filename = 'v1-home-walkthrough.webm';
  await fs.writeFile(path.join(output, filename), bytes); await cdp.detach();
  driver.record('real-V1-Home-ui-walkthrough-recording', {file: filename, mime: result.mime, durationMs: Date.now() - state.started, capturedFrames: state.frames, droppedFrames: state.dropped, frameErrors: state.frameErrors, canvasRate: 12, bytes: bytes.length, scope: 'First isolated launch only; actual CDP native renderer frames encoded with MediaRecorder. Local UI and synthetic provider; no live credentials, browser or email.'});
  assert.ok(bytes.length > 0 && state.frames > 0); assert.equal(state.frameErrors, 0);
}

// Reuses the account campaign's actual bundled SDK/host/loopback seam. Provider
// and storage are synthetic; this Home UI campaign does not qualify OS storage.
async function installAccountFixture() {
  let deadline;
  const result = await Promise.race([driver.app.evaluate(async ({app, ipcMain}) => {
    const fs = process.getBuiltinModule('node:fs/promises'), crypto = process.getBuiltinModule('node:crypto');
    const root = app.getAppPath(), require = process.getBuiltinModule('node:module').createRequire(root + '/package.json');
    const {createApplicationAuth, applicationAccountMethods} = require(root + '/apps/native/application-auth.mjs');
    const {AuthClient} = require(root + '/apps/native/dist-host/application-sdk.mjs');
    const profileRoot = app.getPath('userData') + '/v1-synthetic-account'; await fs.mkdir(profileRoot, {recursive: true, mode: 0o700});
    const origin = 'https://brgxjdhkcfvbpsziebus.supabase.co', id = '11111111-2222-4333-8444-555555555555', nonce = crypto.randomBytes(24).toString('hex');
    const qa = {offline: false, redirect: null, opens: 0, requests: 0, auth: null};
    // Fresh in-memory key; encrypted fixture records never enter production's
    // account namespace. This is an injected test adapter, not macOS Keychain.
    const key = crypto.randomBytes(32);
    const syntheticStorage = {isAvailable: async () => true,
      encrypt: async value => {const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]);},
      decrypt: async value => {const bytes = Buffer.from(value), decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');},
    };
    const user = () => ({id, email: 'v1-home@example.invalid', aud: 'authenticated', created_at: '2026-09-18T00:00:00Z', is_anonymous: false, app_metadata: {provider: 'github'}, user_metadata: {display_name: 'Home Account Fixture'}, identities: [{provider: 'github', identity_data: {sub: '88', user_name: 'home-synthetic'}}]});
    const session = () => {const exp = Math.floor(Date.now() / 1000) + 3600, encode = value => Buffer.from(JSON.stringify(value)).toString('base64url'); return {access_token: encode({alg: 'ES256', typ: 'JWT'}) + '.' + encode({iss: origin + '/auth/v1', sub: id, exp}) + '.syntheticSignature', refresh_token: 'synthetic_v1_refresh_' + nonce, token_type: 'bearer', expires_in: 3600, expires_at: exp, user: user()};};
    qa.auth = createApplicationAuth({config: {origin, publishableKey: 'sb_publishable_SYNTHETIC_v1_public_key', providers: {github: true, email: true}}, AuthClient, profileRoot,
      storage: syntheticStorage,
      openExternal: async value => {const url = new URL(value); if (url.origin !== origin || url.pathname !== '/auth/v1/authorize' || url.searchParams.get('provider') !== 'github' || url.searchParams.get('code_challenge_method') !== 's256') throw Error('Unexpected synthetic authorize request.'); qa.redirect = url.searchParams.get('redirect_to'); qa.opens++;},
      fetch: async (value, init) => {
        qa.requests++; if (qa.offline) throw Error('Synthetic offline provider.');
        const url = new URL(value); if (url.origin !== origin) throw Error('Unexpected provider origin.');
        let body;
        if (url.pathname === '/auth/v1/token') {const input = JSON.parse(init.body); if (url.searchParams.get('grant_type') !== 'pkce' || !input.code_verifier || input.auth_code !== 'synthetic_v1_code') throw Error('Unexpected exchange.'); body = session();}
        else if (url.pathname === '/auth/v1/user' && init.method === 'GET') body = user();
        else throw Error('Unexpected synthetic provider operation.');
        return new Response(JSON.stringify(body), {status: 200, headers: {'Content-Type': 'application/json'}});
      },
    });
    const original = ipcMain._invokeHandlers.get('asmb:native'); if (typeof original !== 'function') throw Error('Native handler missing.');
    ipcMain.removeHandler('asmb:native');
    ipcMain.handle('asmb:native', async (event, input) => {
      if (!applicationAccountMethods.has(input?.method)) return original(event, input);
      try {const value = await qa.auth.request(input.method, input.args); if (JSON.stringify(value).includes(nonce)) throw Error('Synthetic secret in public DTO.'); return {ok: true, value};}
      catch (error) {return {ok: false, error: {code: error.code ?? 'ACCOUNT_UNAVAILABLE', message: error.code ? error.message : 'Synthetic account request failed.'}};}
    });
    globalThis.__v1AccountQA = qa;
    return {profileRoot, syntheticProvider: true, storage: 'synthetic AES-GCM adapter with ephemeral in-memory key; no OS credential storage qualification', callback: 'real loopback HTTP', liveProviderRequests: 0};
  }), new Promise((_, reject) => {deadline = setTimeout(() => reject(Error('Synthetic account fixture initialization exceeded 25 seconds.')), 25000);})]).finally(() => clearTimeout(deadline));
  fixtureInstalled = true; driver.record('existing-account-host-fixture-installed', result);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}

try {
  await launch(); await startVideo(); initialReadme = await fs.readFile(path.join(workspacePath, 'README.md'));
  await navigate('home', {keyboard: true});
  assert.equal(await focusIs('#wh-heading'), true); assert.equal(await button('asMagicBrain home').getAttribute('aria-current'), 'page');
  assert.equal(await button('asMagicBrain organization').getAttribute('aria-current'), null);
  await until(() => home().locator('.wh-account-status').innerText().then(value => value === 'Not signed in'), {label: 'signed-out Home'});
  await row('Workspace').waitFor(); assert.match(await home().innerText(), /Local repositories are available without signing in/);
  await geometry('signed-out-wide'); await capture('vh-home-signed-out');
  driver.record('V1-keyboard-home-focus-and-real-local-catalog-without-sign-in');
  await homeButton('Sign in to asMagicBrain').click(); const signIn = page.getByRole('dialog', {name: 'Sign in to asMagicBrain', exact: true}); await signIn.waitFor();
  await signIn.getByRole('button', {name: 'Continue with GitHub', exact: true}).waitFor(); await button('Close sign-in').click(); await signIn.waitFor({state: 'detached'});
  driver.record('Home-reuses-existing-sign-in-dialog-without-provider-request');
  await homeButton('New repository').click(); await page.getByRole('dialog', {name: 'New repository', exact: true}).waitFor();
  await page.locator('.nr-dialog').getByRole('button', {name: 'Cancel', exact: true}).click(); await page.locator('.nr-dialog').waitFor({state: 'detached'});
  assert.equal(await homeButton('New repository').evaluate(element => element === document.activeElement), true);
  await homeButton('New repository').click(); await page.getByLabel('Repository name', {exact: true}).fill(createdName);
  await page.locator('.nr-dialog').getByRole('button', {name: 'Create repository', exact: true}).focus(); await page.keyboard.press('Enter');
  await page.locator('.nr-dialog').waitFor({state: 'detached'}); await until(() => exists(path.join(data, 'workspaces/asMagicBrain', createdName, '.git')), {label: 'actual local repository created'});
  assert.equal(await home().count(), 0); assert.equal(await page.locator('.rh-repository-name strong').innerText(), createdName);
  driver.record('Home-New-repository-cancel-focus-and-real-keyboard-creation', {repository: createdName});
  await navigate('organization', {keyboard: true}); assert.equal(await focusIs('#wh-heading'), true); assert.equal(await home().locator('.wh-account').count(), 0);
  assert.equal(await button('asMagicBrain organization').getAttribute('aria-current'), 'page'); assert.match(await home().innerText(), /Local organization/);
  await homeButton('Import repository').click(); await page.locator('.zi-dialog').waitFor();
  await page.getByLabel('ZIP archive', {exact: true}).setInputFiles(zip); await page.getByLabel('Repository name', {exact: true}).fill(importedName);
  await page.locator('.zi-dialog').getByRole('button', {name: 'Import repository', exact: true}).click(); await page.locator('.zi-dialog').waitFor({state: 'detached', timeout: 30000});
  assert.equal(await home().count(), 0); assert.equal(await fs.readFile(path.join(data, 'workspaces/asMagicBrain', importedName, 'README.md'), 'utf8'), importedSource); assert.equal(sha(await fs.readFile(zip)), zipHash);
  driver.record('Organization-Import-reuses-real-ZIP-dialog-and-publishes-local-bytes', {repository: importedName, zipHash});
  await navigate('organization'); await until(() => home().locator('.wh-repository').count().then(count => count === 3), {label: 'three actual registered repositories'});
  const search = home().getByRole('searchbox', {name: 'Search local repositories', exact: true});
  await search.fill('  imported-QA  '); assert.equal(await home().locator('.wh-repository').count(), 1); await row(importedName).waitFor();
  await search.fill('missing-local-fixture'); assert.equal(await home().locator('.wh-repository').count(), 0); assert.equal(await home().locator('.wh-empty').innerText(), 'No repositories match your search.');
  await search.fill(''); await capture('vh-organization-catalog');
  await navigate('home'); assert.equal(await search.inputValue(), '');
  for (const hidden of [false, true]) {await mode(hidden); assert.equal(await button('asMagicBrain home').isVisible(), true); assert.equal(await button('asMagicBrain organization').isVisible(), true); assert.equal(await homeButton('New repository').isVisible(), true); assert.equal(await homeButton('Import repository').isVisible(), true); assert.equal(await button('Repository browsing — unavailable').isVisible(), !hidden);}
  await theme('GitHub Light Default'); await capture('vh-home-light-implemented'); await theme('GitHub Dark Default'); await mode(false);
  await driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(520, 780)); await geometry('narrow-dark-full'); await capture('vh-home-narrow-dark');
  await navigate('organization'); await geometry('narrow-organization'); await mode(true); await capture('vh-organization-narrow-implemented');
  await driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000));
  await openRepository('Workspace'); await openReadme(); await append(draftMarker); await cm().evaluate(element => {window.__v1OriginalEditor = element;});
  await navigate('home', {confirm: false}); await button('Keep editing').click(); assert.equal(await home().count(), 0); assert.match(await cm().innerText(), /Private V1 Home draft/);
  await navigate('home'); assert.equal(await cm().isVisible(), false); assert.equal(await cm().evaluate(element => element === window.__v1OriginalEditor), true);
  assert.equal(await page.locator('.fw-repository-surface').getAttribute('hidden'), '');
  await navigate('organization'); assert.equal(await page.locator('.fw-discard-dialog').count(), 0);
  await home().locator('.wh-return').click(); await cm().waitFor(); assert.equal(await cm().evaluate(element => element === window.__v1OriginalEditor), true);
  await until(() => focusIs('.rh-repository-name'), {label: 'Return restores repository-trigger focus after its animation frame'});
  await cm().click(); await cm().press('Meta+z'); assert.doesNotMatch(await cm().innerText(), /Private V1 Home draft/); await cm().press('Meta+Shift+z'); assert.match(await cm().innerText(), /Private V1 Home draft/);
  assert.deepEqual(await fs.readFile(path.join(workspacePath, 'README.md')), initialReadme);
  driver.record('Home-organization-return-preserves-same-CM6-node-undo-draft-and-saved-bytes');
  await page.getByLabel('File path', {exact: true}).fill('proposed-home-name.md'); await navigate('organization', {confirm: false}); await button('Keep editing').click();
  assert.equal(await page.getByLabel('File path', {exact: true}).inputValue(), 'proposed-home-name.md');
  await navigate('organization');
  for (const target of [homeButton('New repository'), homeButton('Import repository'), row('Workspace')]) {
    await target.click(); await page.locator('.fw-discard-dialog').waitFor(); await button('Keep editing').click();
    assert.equal(await home().isVisible(), true); assert.equal(await page.getByLabel('File path', {exact: true}).inputValue(), 'proposed-home-name.md');
    assert.equal(await page.locator('.nr-dialog, .zi-dialog').count(), 0);
  }
  driver.record('hidden-filename-intent-still-prompts-before-New-Import-and-repository-remount');
  await home().locator('.wh-return').click(); await cm().waitFor();
  assert.equal(await page.getByLabel('File path', {exact: true}).inputValue(), 'proposed-home-name.md'); assert.equal(await exists(path.join(workspacePath, 'proposed-home-name.md')), false);
  await page.getByLabel('File path', {exact: true}).fill('README.md');
  driver.record('filename-intent-confirmation-and-session-retention-without-implicit-rename');
  await navigate('home'); await button('Files').click(); await cm().waitFor(); assert.equal(await cm().evaluate(element => element === window.__v1OriginalEditor), true);
  await navigate('home'); await openRepository('Workspace'); await openReadme(); assert.match(await cm().innerText(), /Private V1 Home draft/);
  driver.record('Files-returns-same-editor-and-current-repository-row-opens-overview-with-retained-draft');
  await navigate('home'); await installAccountFixture(); await homeButton('Sign in to asMagicBrain').click(); await button('Continue with GitHub').click();
  await until(() => driver.app.evaluate(() => globalThis.__v1AccountQA.opens === 1), {label: 'synthetic OAuth browser boundary'});
  assert.equal(await driver.app.evaluate(async () => {const url = new URL(globalThis.__v1AccountQA.redirect); url.searchParams.set('code', 'synthetic_v1_code'); const reply = await fetch(url, {redirect: 'error'}); await reply.text(); return reply.status;}), 200);
  await signIn.waitFor({state: 'detached'}); await until(() => home().locator('.wh-account-status').innerText().then(value => value === 'Signed in'), {label: 'signed-in Home'});
  assert.equal(await home().locator('.wh-account-name').innerText(), 'Home Account Fixture');
  await capture('vh-home-synthetic-signed-in'); await homeButton('Profile').click(); await page.getByRole('dialog', {name: 'Profile', exact: true}).waitFor();
  assert.equal(await page.locator('[name=display-name]').inputValue(), 'Home Account Fixture'); await button('Done').click();
  await driver.app.evaluate(() => {globalThis.__v1AccountQA.offline = true;});
  await page.evaluate(async () => {await window.asMagicBrain.refreshApplicationAccount(); window.dispatchEvent(new Event('focus'));});
  await until(() => home().locator('.wh-account-status').innerText().then(value => value === 'Account offline'), {label: 'offline Home account'});
  await homeButton('Profile').waitFor(); await homeButton('Retry account connection').waitFor(); await row('Workspace').waitFor();
  await capture('vh-home-offline-account-local-repositories');
  await driver.app.evaluate(() => {globalThis.__v1AccountQA.offline = false;}); await homeButton('Retry account connection').click();
  await until(() => home().locator('.wh-account-status').innerText().then(value => value === 'Signed in'), {label: 'account reconnect from Home'});
  await button('Account menu').click(); assert.match(await page.locator('.ac-github-connection').innerText(), /Not connected/); await page.keyboard.press('Escape');
  driver.record('Home-reuses-real-account-flow-profile-and-offline-retry-with-synthetic-provider-GitHub-grant-independent');
  await close();
  await launch(); await navigate('organization'); assert.equal(await home().locator('.wh-repository').count(), 3);
  await openRepository('Workspace'); await openReadme(); assert.match(await cm().innerText(), /Private V1 Home draft/); assert.equal(await page.getByLabel('File path', {exact: true}).inputValue(), 'README.md');
  assert.deepEqual(await fs.readFile(path.join(workspacePath, 'README.md')), initialReadme); assert.equal(await fs.readFile(path.join(data, 'workspaces/asMagicBrain', importedName, 'README.md'), 'utf8'), importedSource);
  await driver.screenshot('vh-restarted-real-editor-draft');
  await navigate('home'); await until(() => home().locator('.wh-account-status').innerText().then(value => value === 'Not signed in'), {label: 'production account excludes synthetic fixture namespace'});
  await capture('vh-restarted-home-catalog'); driver.record('normal-close-from-Home-and-restart-retain-real-catalog-source-and-private-draft');
  await home().locator('.wh-return').click(); await cm().waitFor(); await page.getByLabel('File path', {exact: true}).fill('abandoned-home-name.md');
  await navigate('home'); await page.locator('.rh-repository-name').click(); await page.locator('.fw-discard-dialog').waitFor(); await button('Leave editor').click();
  await page.locator('.rc-document').waitFor(); assert.equal(await home().count(), 0);
  assert.deepEqual(await fs.readFile(path.join(workspacePath, 'README.md')), initialReadme); assert.equal(await exists(path.join(workspacePath, 'abandoned-home-name.md')), false);
  await close(); driver.record('explicit-filename-abandonment-through-Home-overview-clears-unmounted-editor-close-hook');
  await launch(); await openReadme(); assert.match(await cm().innerText(), /Private V1 Home draft/);
  assert.equal(await page.getByLabel('File path', {exact: true}).inputValue(), 'README.md'); assert.deepEqual(await fs.readFile(path.join(workspacePath, 'README.md')), initialReadme);
  driver.record('restart-after-explicit-filename-abandonment-retains-content-draft-and-original-source-path');
  assert.equal(driver.errors.length, 0); assert.equal(consoleErrors.length, 0); await close();
} catch (error) {
  failure = {message: error.message, stack: error.stack}; console.error(error.stack);
  try {await driver.screenshot('failure'); await fs.writeFile(path.join(output, 'failure-dom.txt'), await page.locator('body').innerText());} catch {}
  try {if (running) await close();} catch (closeError) {failure.close = closeError.message;}
  process.exitCode = 1;
} finally {
  await driver.report({status: failure ? 'failed' : 'passed', failure, metadata, definitionSha256: sha(definition), scope: 'V1 Home/organization: real local catalog and repository UI, actual CM6, bundled account service with isolated synthetic provider and storage. No default profile or live provider.', limitations: ['Synthetic account provider/storage do not qualify live OAuth/email, expiry, OS credential storage or account storage migration.', 'Offline renderer and injected auth transport prove local use independently of a live provider; no OS-wide network outage was induced.']});
  console.log(JSON.stringify({status: failure ? 'failed' : 'passed', output}));
}
