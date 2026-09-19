import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
/** Exact packaged production session-only accounts. Provider replies and browser
 * dispatch are intercepted; auth instances, SDK, IPC and callback remain real.
 * No OS storage method is called by the fixture. No default profile is read. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const projectTest = developmentTestRoot;
process.env.ASMB_ACCEPTANCE_RUN_ROOT ??= path.join(projectTest, 'runs/native-session-accounts-20260918/qa');
assert.ok(process.env.ASMB_PACKAGED_EXECUTABLE, 'Supply an exact candidate/final packaged executable.');
const {createDriver, nativeTarget, testRoot: runRoot, until, sha} = await import('./native-driver.mjs');
import {chromium} from '../../../tools/playwright.mjs';
await fs.mkdir(runRoot, {recursive: true});
const output = await fs.mkdtemp(path.join(runRoot, 'session-accounts-'));
const data = path.join(output, 'data'), profile = data + '-electron-profile', workspacePath = path.join(data, 'workspaces/asMagicBrain/Workspace');
const definition = await fs.readFile(fileURLToPath(import.meta.url));
await fs.writeFile(path.join(output, 'driver-at-launch.mjs'), definition);
const driver = await createDriver({...nativeTarget(data), output, workspacePath});
const executable = process.env.ASMB_PACKAGED_EXECUTABLE, bundle = executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4), resources = path.join(bundle, 'Contents/Resources/app');
const metadata = JSON.parse(await fs.readFile(path.join(resources, 'native-package.json'), 'utf8'));
assert.equal(metadata.accountRuntimePolicy.persistence, 'session');
assert.equal(metadata.accountRuntimePolicy.electronFuses.cookieEncryption, false);
const shippedMain = await fs.readFile(path.join(resources, 'apps/native/main.mjs'), 'utf8');
assert.ok(!/safeStorage|isAsyncEncryptionAvailable|encryptString|decryptString/.test(shippedMain), 'Production main must contain no OS credential storage reference.');
assert.equal((shippedMain.match(/storagePolicy:\s*['"]session['"]/g) ?? []).length, 2);
const runtimeBytes = await fs.readFile(path.join(bundle, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'));
const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), offset = runtimeBytes.indexOf(sentinel);
assert.ok(offset >= 0 && runtimeBytes.indexOf(sentinel, offset + 1) === -1);
const fuseVersion = runtimeBytes[offset + sentinel.length], fuseLength = runtimeBytes[offset + sentinel.length + 1], wire = runtimeBytes.subarray(offset + sentinel.length + 2, offset + sentinel.length + 2 + fuseLength).toString();
assert.equal(fuseVersion, 1); assert.equal(wire[1], '0');
driver.record('exact-package-session-policy-and-disabled-cookie-encryption', {metadata, mainSha256: sha(shippedMain), fuseVersion, fuseLength, wire, cookieEncryption: false, scope: 'Static startup evidence complements the post-window runtime safeStorage traps.'});
const {githubApp} = await import(pathToFileURL(path.join(resources, 'apps/native/github-config.mjs')).href);
const origin = 'https://brgxjdhkcfvbpsziebus.supabase.co', nonce = randomBytes(24).toString('hex');
const legacy = [];
for (const [namespace, clientId] of [['github-auth', githubApp.clientId], ['application-auth', 'supabase:' + origin]]) {
  const directory = path.join(profile, namespace); await fs.mkdir(directory, {recursive: true, mode: 0o700});
  for (const suffix of ['.bin', '.bin.pending']) {
    const filename = path.join(directory, createHash('sha256').update(clientId).digest('hex') + suffix);
    await fs.writeFile(filename, 'INERT LEGACY CIPHERTEXT FIXTURE ' + namespace + suffix + '\n', {mode: 0o600});
    const stat = await fs.stat(filename); legacy.push({path: filename, sha256: sha(await fs.readFile(filename)), mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs, inode: stat.ino});
  }
}
let page, running = false, failure, recorder, cdp, reconnected, savedSource, committedHead;
const extraErrors = [], extraConsoleErrors = [], counts = [], observedConsole = [];
let rendererTransition = false;
const button = name => page.getByRole('button', {name, exact: true});
const menuitem = name => page.getByRole('menuitem', {name, exact: true});
const cm = () => page.locator('.cm-content[contenteditable=true]');
const signInDialog = () => page.getByRole('dialog', {name: 'Sign in to asMagicBrain', exact: true});
const githubDialog = () => page.getByRole('dialog', {name: 'Connect GitHub', exact: true});
const accountMenu = async () => {if (!await page.locator('.ac-menu').isVisible()) await button('Account menu').click();};
const dismissMenu = async () => {if (await page.locator('.ac-menu').isVisible()) await page.keyboard.press('Escape');};
const controls = value => driver.app.evaluate((_, value) => Object.assign(globalThis.__sessionAccountsQA.controls, value), value);
const stats = () => driver.app.evaluate(() => ({...globalThis.__sessionAccountsQA.stats}));
const git = (...args) => execFileSync('/usr/bin/git', ['-C', workspacePath, ...args], {encoding: 'utf8', env: {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'}}).trimEnd();
async function states() {
  return page.evaluate(async () => {
    const app = await window.asMagicBrain.getApplicationAccount(), github = await window.asMagicBrain.getGitHubConnection();
    if (!app.ok || !github.ok || /synthetic_session_(access|refresh|provider)/.test(JSON.stringify([app, github]))) throw Error('Invalid or secret-bearing public account response.');
    return {app: app.value, github: github.value};
  });
}
async function assertLegacy() {
  for (const entry of legacy) {assert.equal(sha(await fs.readFile(entry.path)), entry.sha256); const stat = await fs.stat(entry.path); assert.equal(stat.mode & 0o777, entry.mode); assert.equal(stat.mtimeMs, entry.mtimeMs); assert.equal(stat.ino, entry.inode);}
  for (const namespace of ['github-auth', 'application-auth']) assert.equal((await fs.readdir(path.join(profile, namespace))).length, 2);
}
async function noTokenOnDisk() {
  const walk = async directory => {for (const entry of await fs.readdir(directory, {withFileTypes: true})) {const full = path.join(directory, entry.name); if (entry.isDirectory()) await walk(full); else if (entry.isFile()) assert.ok(!(await fs.readFile(full)).includes(Buffer.from(nonce)), 'Synthetic token marker reached owned fixture disk: ' + entry.name);}};
  await walk(data); await walk(profile);
}
async function capture(name) {
  await page.screenshot({path: path.join(output, name + '.png')}); driver.record('screenshot', {file: name + '.png'});
  const measured = await page.evaluate(() => {
    const selectors = {
      VH3: '.wh-account', AA1: '.ac-profile', AA2: '.ac-menu [data-app-account-action]', GA1: '.ac-github-connection',
      GA2: '.gc-connect-dialog > header', GA3: '#gc-connect-description', GA4: '.gc-code-row', GA5: '.gc-connect-dialog > .zi-primary', GA6: '.gc-connect-dialog > .zi-progress', GA7: '.gc-connect-dialog > footer',
      AA3: '.aa-dialog:not(.aa-profile-dialog) > header, .aa-dialog:not(.aa-profile-dialog) > .ac-description',
      AA4: '.aa-dialog:not(.aa-profile-dialog) > .aa-provider, .aa-dialog:not(.aa-profile-dialog) > form:has([name=account-email])',
      AA5: '.aa-dialog:not(.aa-profile-dialog) > form:has(.aa-sent)',
      AA6: '.aa-dialog:not(.aa-profile-dialog) > .aa-status, .aa-dialog:not(.aa-profile-dialog) > .ac-save-error, .aa-dialog:not(.aa-profile-dialog) .ac-field-error, .aa-dialog:not(.aa-profile-dialog) > footer',
      AA7: '.aa-profile-dialog > header, .aa-profile-dialog > .ac-description, .aa-profile-dialog .ac-field, .aa-profile-dialog form > .ac-help',
      AA8: '.aa-profile-dialog .aa-reconnect, .aa-profile-dialog .ac-save-error, .aa-profile-dialog .ac-field-error, .aa-profile-dialog .aa-status, .aa-profile-dialog form > footer',
    };
    const actions = new Set(['Sign in to asMagicBrain', 'Sign in again', 'Profile', 'Retry account connection', 'Sign out of asMagicBrain']);
    const areas = [];
    for (const [id, selector] of Object.entries(selectors)) {
      const nodes = id === 'AA2' ? [...document.querySelectorAll('.ac-menu [role=menuitem]')].filter(element => actions.has(element.textContent.trim())) : [...document.querySelectorAll(selector)];
      const rows = nodes.filter(element => element.checkVisibility()).map(element => element.getBoundingClientRect()).filter(r => r.width && r.height);
      if (!rows.length) continue;
      const x = Math.min(...rows.map(r => r.x)), y = Math.min(...rows.map(r => r.y));
      areas.push({id, x, y, width: Math.max(...rows.map(r => r.right)) - x, height: Math.max(...rows.map(r => r.bottom)) - y});
    }
    return {viewport: {width: innerWidth, height: innerHeight}, theme: document.querySelector('.fw-window')?.getAttribute('data-theme') ?? null, areas};
  });
  await fs.writeFile(path.join(output, name + '-bounds.json'), JSON.stringify(measured, null, 2));
  await page.evaluate(({areas}) => {
    const layer = document.createElement('div'); layer.id = 'app-account-qa-overlay';
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    areas.forEach((r, index) => {
      const color = ['#a9232f', '#005f8b', '#6941a5', '#196a3e'][index % 4], box = document.createElement('div'), badge = document.createElement('span');
      box.style.cssText = `position:fixed;box-sizing:border-box;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;border:2px solid ${color};background:${color}0d`;
      badge.textContent = r.id; badge.style.cssText = `position:absolute;left:0;top:0;padding:2px 4px;font:700 11px system-ui;background:white;color:${color}`;
      box.append(badge); layer.append(box);
    });
    (document.querySelector('dialog[open]') ?? document.body).append(layer);
  }, measured);
  try {await page.screenshot({path: path.join(output, name + '-overlay.png')});}
  finally {await page.evaluate(() => document.getElementById('app-account-qa-overlay')?.remove());}
  driver.record('measured-AA-utility-capture', {raw: name + '.png', overlay: name + '-overlay.png', bounds: name + '-bounds.json'});
  if (recorder) await new Promise(resolve => setTimeout(resolve, 450));
}
async function theme(label) {
  await button('asMagicBrain Theme').click(); await page.locator('.fw-theme-picker select').selectOption({label});
  await page.locator('.fw-theme-picker').getByRole('button', {name: 'Done', exact: true}).click();
}
async function startVideo() {
  cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1440; canvas.height = 1000;
    const context = canvas.getContext('2d'), chunks = [], mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm;codecs=vp8';
    const stream = canvas.captureStream(12), recording = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 1500000});
    window.__asmbAccountQAVideo = {canvas, context, chunks, recording, stream, mime};
    recording.ondataavailable = event => {if (event.data.size) chunks.push(event.data);}; recording.start(1000);
  });
  const state = recorder = {started: Date.now(), frames: 0, dropped: 0, busy: false, frameErrors: 0, listener: null};
  state.listener = async event => {
    void cdp.send('Page.screencastFrameAck', {sessionId: event.sessionId}).catch(() => {});
    if (state.busy) {state.dropped++; return;} state.busy = true;
    try {
      await page.evaluate(async jpeg => {
        const video = window.__asmbAccountQAVideo; if (!video) return;
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
  await until(() => !state.busy, {label: 'account video frame drain'});
  const result = await page.evaluate(async () => {
    const video = window.__asmbAccountQAVideo;
    await new Promise(resolve => {video.recording.onstop = resolve; video.recording.stop();});
    video.stream.getTracks().forEach(track => track.stop());
    const blob = new Blob(video.chunks, {type: video.mime});
    const base64 = await new Promise(resolve => {const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob);});
    delete window.__asmbAccountQAVideo; return {base64, mime: video.mime};
  });
  const bytes = Buffer.from(result.base64, 'base64'), filename = 'session-accounts-walkthrough.webm';
  await fs.writeFile(path.join(output, filename), bytes); await cdp.detach();
  driver.record('real-session-account-ui-walkthrough-recording', {file: filename, mime: result.mime, durationMs: Date.now() - state.started, capturedFrames: state.frames, droppedFrames: state.dropped, frameErrors: state.frameErrors, canvasRate: 12, bytes: bytes.length, scope: 'First isolated launch only; actual CDP native renderer frames encoded with MediaRecorder. Synthetic provider; exact production session policy; no live credentials, browser or email.'});
  assert.ok(bytes.length > 0 && state.frames > 0); assert.equal(state.frameErrors, 0);
}

async function installBoundaryFixture() {
  const fixture = await driver.app.evaluate(({app, safeStorage, shell, ipcMain, dialog}, {origin, nonce}) => {
    const qa = {controls: {name: 'Session Account Test', offline: false, github: 'pending'}, stats: {safeStorageCalls: 0, applicationOpened: 0, applicationExchanges: 0, applicationUsers: 0, applicationUpdates: 0, applicationLogout: 0, githubDevices: 0, githubPolls: 0, githubUsers: 0, githubOpened: 0, unexpectedFetch: 0, recoveryDialogs: 0}, nativeFetch: globalThis.fetch};
    for (const name of ['isEncryptionAvailable', 'isAsyncEncryptionAvailable', 'encryptString', 'decryptString', 'encryptStringAsync', 'decryptStringAsync', 'setUsePlainTextEncryption', 'getSelectedStorageBackend']) {
      if (typeof safeStorage[name] !== 'function') continue;
      Object.defineProperty(safeStorage, name, {configurable: true, value: () => {qa.stats.safeStorageCalls++; throw Error('FORBIDDEN_OS_CREDENTIAL_STORAGE');}});
    }
    const id = '11111111-2222-4333-8444-555555555555';
    const user = () => ({id, email: 'session-test@example.invalid', aud: 'authenticated', created_at: '2026-09-18T00:00:00Z', is_anonymous: false, app_metadata: {provider: 'github'}, user_metadata: {display_name: qa.controls.name}, identities: [{provider: 'github', identity_data: {sub: '77', user_name: 'session-app-user'}}]});
    const session = () => {
      const expires_at = Math.floor(Date.now() / 1000) + 3600, encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      return {access_token: encode({alg: 'ES256', typ: 'JWT'}) + '.' + encode({iss: origin + '/auth/v1', sub: id, exp: expires_at}) + '.synthetic_session_access_' + nonce,
        refresh_token: 'synthetic_session_refresh_' + nonce, token_type: 'bearer', expires_in: 3600, expires_at, user: user(), provider_token: 'synthetic_session_provider_' + nonce};
    };
    const response = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
    globalThis.fetch = async (value, init = {}) => {
      if (qa.controls.offline) throw Error('Synthetic session provider offline.');
      const url = new URL(value);
      if (url.origin === origin) {
        const body = init.body ? JSON.parse(init.body) : null;
        if (url.pathname === '/auth/v1/token') {qa.stats.applicationExchanges++; if (url.searchParams.get('grant_type') === 'pkce' && (!body.code_verifier || body.auth_code !== 'synthetic_session_code')) throw Error('Invalid PKCE request.'); return response(session());}
        if (url.pathname === '/auth/v1/user' && init.method === 'GET') {qa.stats.applicationUsers++; if (!new Headers(init.headers).get('authorization')?.includes(nonce)) throw Error('Missing host app credential.'); return response(user());}
        if (url.pathname === '/auth/v1/user' && init.method === 'PUT') {qa.stats.applicationUpdates++; if (Object.keys(body).some(key => !['data', 'code_challenge', 'code_challenge_method'].includes(key)) || Object.keys(body.data).join(',') !== 'display_name') throw Error('Unexpected profile write.'); qa.controls.name = body.data.display_name; return response(user());}
        if (url.pathname === '/auth/v1/logout') {qa.stats.applicationLogout++; if (url.searchParams.get('scope') !== 'local') throw Error('Unexpected signout scope.'); return response(null, 204);}
      }
      if (url.href === 'https://github.com/login/device/code') {qa.stats.githubDevices++; return response({device_code: 'synthetic_session_device_' + nonce, user_code: 'TEST-' + String(qa.stats.githubDevices).padStart(4, '0'), verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1});}
      if (url.href === 'https://github.com/login/oauth/access_token') {
        qa.stats.githubPolls++;
        if (qa.controls.github === 'pending') return response({error: 'authorization_pending'});
        if (qa.controls.github === 'denied') return response({error: 'access_denied', error_description: 'synthetic_session_provider_private_detail'});
        return response({access_token: 'synthetic_session_access_' + nonce, token_type: 'bearer', expires_in: 3600, refresh_token: 'synthetic_session_refresh_' + nonce, refresh_token_expires_in: 86400});
      }
      if (url.href === 'https://api.github.com/user') {qa.stats.githubUsers++; if (init.headers.Authorization !== 'Bearer synthetic_session_access_' + nonce) throw Error('Missing host GitHub credential.'); return response({id: 9919, login: 'session-repository-user', name: 'Session Repository Identity', email: null});}
      qa.stats.unexpectedFetch++; throw Error('Unexpected synthetic provider request.');
    };
    shell.openExternal = async value => {
      const url = new URL(value);
      if (url.origin === origin && url.pathname === '/auth/v1/authorize' && url.searchParams.get('provider') === 'github' && url.searchParams.get('code_challenge_method') === 's256') {qa.redirect = url.searchParams.get('redirect_to'); qa.stats.applicationOpened++; return;}
      if (url.href === 'https://github.com/login/device') {qa.stats.githubOpened++; return;}
      throw Error('Unexpected external browser target.');
    };
    const oldDialog = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = async (...args) => {if (args.at(-1)?.title === 'The editor stopped') {qa.stats.recoveryDialogs++; return {response: 0, checkboxChecked: false};} return oldDialog(...args);};
    globalThis.__sessionAccountsQA = qa;
    const handler = ipcMain._invokeHandlers.get('asmb:native');
    if (typeof handler !== 'function') throw Error('Native handler absent.');
    qa.handler = handler;
    return {profile: app.getPath('userData'), trappedMethods: Object.getOwnPropertyNames(safeStorage).filter(name => typeof safeStorage[name] === 'function'), authReplacement: false, ipcReplacement: false, providerLiveNetwork: false};
  }, {origin, nonce});
  assert.equal(fixture.profile, profile);
  const rejected = await driver.app.evaluate(async () => globalThis.__sessionAccountsQA.handler({sender: null, senderFrame: null}, {method: 'getApplicationAccount'}));
  assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'VIEW_UNAVAILABLE');
  driver.record('production-auth-network-boundary-fixture-and-safeStorage-traps', fixture);
}
async function launch() {
  page = await driver.launch(); running = true; page.setDefaultTimeout(15000);
  page.on('console', value => {if (value.type() === 'error') observedConsole.push({phase: rendererTransition ? 'intentional-renderer-interruption' : 'normal', text: value.text()});});
  await button('Account menu').waitFor();
  await driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000));
  await installBoundaryFixture(); await page.context().setOffline(true);
  await page.locator('.rc-document').waitFor(); assert.equal(await page.locator('.rc-page [role=alert]').count(), 0);
  const state = await states(); assert.equal(state.app.state, 'signed-out'); assert.equal(state.github.state, 'signed-out');
  assert.equal(state.app.persistence, 'session'); assert.equal(state.github.persistence, 'session');
  await assertLegacy(); driver.record('startup-ignores-legacy-ciphertext-and-pending-markers-signed-out');
}
async function close() {
  await stopVideo(); await assertLegacy(); await noTokenOnDisk();
  const observed = await stats(); assert.equal(observed.safeStorageCalls, 0); assert.equal(observed.unexpectedFetch, 0); counts.push(observed);
  driver.record('no-OS-storage-or-unexpected-provider-call-during-instrumented-process', observed);
  await driver.closeNormally(); running = false; reconnected = null; await assertLegacy(); await noTokenOnDisk();
}
async function openAppSignIn() {await accountMenu(); await menuitem('Sign in to asMagicBrain').click(); await signInDialog().waitFor(); assert.match(await signInDialog().innerText(), /You stay signed in until you quit asMagicBrain\./);}
async function callback(wrongState = false) {
  return driver.app.evaluate(async (_, wrongState) => {const qa = globalThis.__sessionAccountsQA, url = new URL(qa.redirect); url.searchParams.set('code', 'synthetic_session_code'); if (wrongState) url.searchParams.set('app_state', 'x'.repeat(43)); const response = await qa.nativeFetch(url, {redirect: 'error'}); await response.text(); return response.status;}, wrongState);
}
async function signInApp() {
  await openAppSignIn(); await button('Continue with GitHub').click(); await signInDialog().getByText('Waiting for browser sign-in…', {exact: true}).waitFor();
  assert.equal(await callback(), 200); await signInDialog().waitFor({state: 'detached'});
  await until(async () => (await states()).app.state === 'signed-in', {label: 'production app session connected'});
}
async function openGitHub() {await accountMenu(); await menuitem('Connect GitHub').click(); await githubDialog().waitFor(); assert.match(await githubDialog().innerText(), /GitHub stays connected until you quit asMagicBrain\./); await githubDialog().getByRole('button', {name: 'Connect GitHub', exact: true}).click(); await page.locator('.gc-user-code').waitFor();}
async function connectGitHub() {await controls({github: 'success'}); await openGitHub(); await githubDialog().waitFor({state: 'detached'}); await until(async () => (await states()).github.state === 'connected', {label: 'production GitHub session connected'});}
async function openReadme() {await button('README.md').first().click(); await until(() => button('Edit this file').isEnabled(), {label: 'README ready'}); await button('Edit this file').click(); await cm().waitFor();}
async function append(text) {await cm().click(); await cm().press('Meta+ArrowDown'); await page.keyboard.insertText(text);}
async function leaveIfAsked() {if (await button('Leave editor').isVisible()) await button('Leave editor').click();}
async function draftAcknowledged(marker) {
  await until(async () => {
    let found = false;
    const walk = async directory => {for (const entry of await fs.readdir(directory, {withFileTypes: true})) {const full = path.join(directory, entry.name); if (entry.isDirectory()) await walk(full); else if (entry.name.endsWith('.json') && (await fs.readFile(full, 'utf8')).includes(marker)) found = true;}};
    await walk(path.join(data, 'state')); return found;
  }, {label: 'acknowledged private CM6 draft'});
}
async function recoverRenderer() {
  await stopVideo(); rendererTransition = true;
  const before = await driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.getOSProcessId());
  await driver.app.evaluate(({BrowserWindow}) => {setTimeout(() => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(), 0);});
  await until(async () => (await stats()).recoveryDialogs === 1, {label: 'real renderer recovery dialog'});
  await until(() => driver.app.evaluate(({BrowserWindow}, before) => {const wc = BrowserWindow.getAllWindows()[0].webContents; return !wc.isLoading() && wc.getOSProcessId() > 0 && wc.getOSProcessId() !== before;}, before), {label: 'real replacement renderer'});
  const port = (await fs.readFile(path.join(profile, 'session/DevToolsActivePort'), 'utf8')).split('\n')[0];
  reconnected = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  page = reconnected.contexts()[0].pages().find(value => value.url() === 'app://asmagicbrain/index.html'); assert.ok(page); page.setDefaultTimeout(15000);
  page.on('pageerror', error => extraErrors.push(error.message)); page.on('console', value => {if (value.type() === 'error') extraConsoleErrors.push(value.text());});
  await button('Account menu').waitFor(); await page.context().setOffline(true); rendererTransition = false;
  driver.record('forced-renderer-interruption-console-diagnostics', {observed: observedConsole.filter(value => value.phase === 'intentional-renderer-interruption'), scope: 'Raw diagnostics retained, including Electron sandbox startup errors on the interrupted original Playwright target. Fresh replacement renderer is checked separately.'});
}

try {
  await launch(); await startVideo();
  const original = await fs.readFile(path.join(workspacePath, 'README.md'));
  const preferences = await page.evaluate(() => window.asMagicBrain.request({repo: 'Workspace', operation: 'getCommitPreferences', args: {}}));
  await accountMenu(); await capture('session-signed-out-legacy-preserved'); await dismissMenu();
  await button('asMagicBrain home').click(); await page.locator('.wh-account').waitFor(); await capture('session-signed-out-home'); await button('Return to Workspace').click();

  await openAppSignIn(); await capture('session-app-signin-policy'); await button('Continue with GitHub').click();
  await signInDialog().getByText('Waiting for browser sign-in…', {exact: true}).waitFor(); assert.equal(await callback(true), 400);
  await button('Close sign-in').click(); await signInDialog().waitFor({state: 'detached'}); assert.equal((await states()).app.state, 'signed-out');
  driver.record('actual-loopback-rejects-wrong-state-and-cancel-keeps-app-signed-out');

  await controls({github: 'pending'}); await openGitHub(); await button('Open GitHub').click(); await capture('session-github-code-policy'); await controls({github: 'denied'});
  await githubDialog().getByRole('alert').filter({hasText: 'declined'}).waitFor(); assert.ok(!(await githubDialog().innerText()).includes('synthetic_session_provider_private_detail'));
  await button('Close GitHub connection').click(); assert.equal((await states()).github.state, 'signed-out');
  driver.record('github-provider-denial-sanitized-and-not-connected');
  await controls({github: 'pending'}); await openGitHub(); await button('Close GitHub connection').click(); await githubDialog().waitFor({state: 'detached'}); assert.equal((await states()).github.state, 'signed-out');
  driver.record('github-device-attempt-cancellation-leaves-no-session');

  await signInApp(); await connectGitHub();
  assert.deepEqual(await page.evaluate(() => window.asMagicBrain.request({repo: 'Workspace', operation: 'getCommitPreferences', args: {}})), preferences);
  await accountMenu(); await capture('session-independent-connected-accounts'); await menuitem('Profile').click();
  const profileDialog = page.getByRole('dialog', {name: 'Profile', exact: true}); await profileDialog.waitFor(); assert.match(await profileDialog.innerText(), /You stay signed in until you quit asMagicBrain\./);
  await profileDialog.locator('[name=display-name]').fill('Edited Session Account'); await profileDialog.getByRole('button', {name: 'Save profile', exact: true}).click();
  await until(async () => (await states()).app.account.displayName === 'Edited Session Account', {label: 'real SDK profile update in current session'}); await capture('session-profile-policy');
  await profileDialog.getByRole('button', {name: 'Close profile', exact: true}).click();
  await accountMenu(); await menuitem('Settings').click();
  const settings = page.getByRole('dialog', {name: 'Commit author'}); await settings.getByRole('radio', {name: /GitHub identity/}).check();
  await settings.locator('[name=author-email]').fill('selected@example.invalid'); await settings.getByRole('button', {name: 'Use connected GitHub identity'}).click();
  assert.equal(await settings.locator('[name=author-name]').inputValue(), 'Session Repository Identity'); assert.equal(await settings.locator('[name=author-email]').inputValue(), 'selected@example.invalid'); await settings.getByRole('button', {name: 'Cancel', exact: true}).click();
  driver.record('independent-session-identities-profile-update-and-explicit-Git-author-copy');
  await accountMenu(); await menuitem('Sign out of asMagicBrain').click(); await until(async () => (await states()).app.state === 'signed-out', {label: 'app signout'}); assert.equal((await states()).github.state, 'connected'); await signInApp();
  await accountMenu(); await menuitem('Disconnect GitHub').click(); await until(async () => (await states()).github.state === 'signed-out', {label: 'GitHub disconnect'}); assert.equal((await states()).app.state, 'signed-in'); await connectGitHub();
  driver.record('independent-signout-and-disconnect-preserve-other-current-session');

  await dismissMenu(); await button('asMagicBrain home').click(); await page.locator('.wh-account').waitFor(); assert.match(await page.locator('.wh-account').innerText(), /You stay signed in until you quit asMagicBrain\./); await capture('session-signed-in-home');
  await theme('GitHub Dark Default'); await driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(520, 780)); await capture('session-home-narrow-dark');
  const bounds = await page.locator('.wh-account').evaluate(element => {const r = element.getBoundingClientRect(); return {x: r.x, right: r.right, width: innerWidth, scroll: document.documentElement.scrollWidth};}); assert.ok(bounds.x >= 0 && bounds.right <= bounds.width && bounds.scroll <= bounds.width);
  await driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000)); await theme('GitHub Light Default'); await button('Return to Workspace').click();
  await controls({offline: true});
  const offline = await page.evaluate(() => window.asMagicBrain.refreshApplicationAccount()); assert.equal(offline.ok, true); assert.equal(offline.value.state, 'offline'); assert.equal((await states()).github.state, 'connected');
  await openReadme(); await append('\nPrivate session-account draft survives renderer and quit.\n'); await draftAcknowledged('Private session-account draft survives');
  assert.deepEqual(await fs.readFile(path.join(workspacePath, 'README.md')), original); await capture('session-offline-private-editor');
  await recoverRenderer(); assert.equal((await states()).app.state, 'offline'); assert.equal((await states()).github.state, 'connected');
  await openReadme(); assert.match(await cm().innerText(), /Private session-account draft survives/); assert.deepEqual(await fs.readFile(path.join(workspacePath, 'README.md')), original);
  driver.record('renderer-crash-recovery-retains-production-host-sessions-and-acknowledged-private-draft');
  await close();

  await launch(); await openReadme(); assert.match(await cm().innerText(), /Private session-account draft survives/); assert.deepEqual(await fs.readFile(path.join(workspacePath, 'README.md')), original);
  driver.record('actual-process-restart-forgets-both-accounts-but-retains-private-draft');
  await controls({offline: true}); await button('Save').click();
  await until(async () => (await fs.readFile(path.join(workspacePath, 'README.md'), 'utf8')).includes('Private session-account draft survives'), {label: 'real offline Save'});
  await until(() => button('Save').isEnabled(), {label: 'Save response settled before private edit'});
  savedSource = await fs.readFile(path.join(workspacePath, 'README.md'));
  await append('Private draft excluded from local commit.\n'); await draftAcknowledged('Private draft excluded from local commit.');
  await button('Repository file actions').click(); await menuitem('New Markdown file').click();
  await until(async () => await button('Leave editor').isVisible() || await page.getByLabel('File path', {exact: true}).inputValue() === 'untitled.md', {label: 'new local commit context or leave confirmation'}); await leaveIfAsked();
  await page.getByLabel('File path', {exact: true}).fill('commit-context.md'); await append('# Separate saved commit context\n'); await button('Save').click();
  await until(() => fs.readFile(path.join(workspacePath, 'commit-context.md'), 'utf8').then(value => value.includes('Separate saved commit context')), {label: 'second file saved; README draft retained'});
  await button('Commit changes…').click(); const commit = page.locator('.rfe-commit-dialog[open]'); await commit.waitFor();
  await commit.getByLabel('Commit message', {exact: true}).fill('Offline session-account qualification');
  await commit.getByLabel('Local author name', {exact: true}).fill('Session Account QA'); await commit.getByLabel('Local author email', {exact: true}).fill('session-qa@example.invalid');
  for (const item of await commit.locator('.rfe-change-selection label').all()) await item.locator('input').setChecked((await item.locator('span').innerText()).startsWith('README.md '));
  await commit.getByRole('button', {name: 'Refresh review', exact: true}).click(); await until(() => commit.getByRole('button', {name: 'Commit changes', exact: true}).isEnabled(), {label: 'local commit review'});
  await commit.getByRole('button', {name: 'Commit changes', exact: true}).click(); await commit.waitFor({state: 'hidden'});
  committedHead = git('rev-parse', 'HEAD'); assert.equal(git('show', committedHead + ':README.md'), savedSource.toString().trimEnd()); assert.equal(git('remote'), ''); assert.equal(git('show', '-s', '--format=%an <%ae>'), 'Session Account QA <session-qa@example.invalid>');
  driver.record('offline-real-Save-and-selected-local-Git-commit-exclude-private-draft', {head: committedHead, sourceSha256: sha(savedSource)});
  await capture('session-restarted-offline-local-commit'); await close();

  await launch(); await openReadme(); assert.match(await cm().innerText(), /Private draft excluded from local commit/); assert.deepEqual(await fs.readFile(path.join(workspacePath, 'README.md')), savedSource); assert.equal(git('rev-parse', 'HEAD'), committedHead);
  driver.record('second-restart-preserves-local-Git-saved-bytes-and-private-draft-with-accounts-signed-out');
  await openGitHub(); await close(); driver.record('ordinary-native-quit-cancels-pending-GitHub-device-flow-without-OS-storage');
  assert.equal(driver.errors.length, 0); assert.deepEqual(extraErrors, []); assert.deepEqual(extraConsoleErrors, []);
} catch (error) {
  failure = {message: error.message, stack: error.stack};
  try {await page?.screenshot({path: path.join(output, 'failure.png')});} catch {}
  try {if (running) await close();} catch (closeError) {failure.close = closeError.message;}
} finally {
  await driver.report({status: failure ? 'failed' : 'passed', failure, definitionSha256: sha(definition), extraRendererErrors: extraErrors, extraConsoleErrors, observedConsole, providerCountsByProcess: counts, legacyCiphertextFixture: legacy, metadata,
    qualification: 'Exact production main account instances, session-only in-memory credential policy, official SDK, preload/IPC, callback listener and native lifecycle. Synthetic provider fetch replies and external-browser dispatch are the only account boundaries replaced. Electron safeStorage methods are trapped after first window; static startup source and exact disabled cookie-encryption fuse supplement that interval. Synthetic legacy ciphertext/pending markers stay untouched. Renderer recovery chooses Reopen editor at dialog presentation. No live OAuth, email, private clone, real credentials, user profile, Keychain read/write/permission change, or OS-wide no-Keychain instrumentation claim.'});
  const receipt = JSON.parse(await fs.readFile(path.join(output, 'receipt.json'), 'utf8'));
  const classified = observedConsole.filter(value => value.phase === 'intentional-renderer-interruption' && (value.text === 'Electron sandboxed_renderer.bundle.js script failed to run' || value.text.startsWith("TypeError: Cannot destructure property 'preloadScripts' of 'binding.startupData' as it is null.")));
  const sameConsoleMultiset = JSON.stringify(receipt.consoleErrors.map(value => value.text).sort()) === JSON.stringify(classified.map(value => value.text).sort());
  if (!failure && (!sameConsoleMultiset || receipt.extraConsoleErrors.length)) {failure = {message: 'Unexpected renderer console errors outside the recorded forced-crash transition.'}; receipt.status = 'failed'; receipt.failure = failure; await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));}
  process.stdout.write(JSON.stringify({status: failure ? 'failed' : 'passed', output, failure}) + '\n'); if (failure) process.exitCode = 1;
}
