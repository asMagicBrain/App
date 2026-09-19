import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
/** Actual packaged account UI and OS encrypted persistence, with a synthetic
 * Auth provider. Never reads the default profile or contacts a live service. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const testRoot = developmentTestRoot;
process.env.ASMB_ACCEPTANCE_RUN_ROOT ??= path.join(testRoot, 'runs/native-accounts-20260918/native');
assert.ok(process.env.ASMB_PACKAGED_EXECUTABLE, 'Supply an exact candidate/final packaged executable.');
const {createDriver, nativeTarget, testRoot: runRoot, until} = await import('./native-driver.mjs');
await fs.mkdir(runRoot, {recursive: true});
const output = await fs.mkdtemp(path.join(runRoot, 'application-account-'));
const data = path.join(output, 'data'), workspacePath = path.join(data, 'workspaces/asMagicBrain/Workspace');
const definition = await fs.readFile(fileURLToPath(import.meta.url));
await fs.writeFile(path.join(output, 'driver-at-launch.mjs'), definition);
const driver = await createDriver({...nativeTarget(data), output, workspacePath});
let page, running = false, failure, initialReadme, profileName = 'Native Account Test', recorder, cdp;
const button = name => page.getByRole('button', {name, exact: true});
const menuitem = name => page.getByRole('menuitem', {name, exact: true});
const signInDialog = () => page.getByRole('dialog', {name: 'Sign in to asMagicBrain', exact: true});
const accountMenu = async () => {if (!await page.locator('.ac-menu').isVisible()) await button('Account menu').click();};
const dismissMenu = async () => {if (await page.locator('.ac-menu').isVisible()) await page.keyboard.press('Escape');};
const controls = value => driver.app.evaluate((_, value) => Object.assign(globalThis.__applicationAccountQA.controls, value), value);
const release = name => driver.app.evaluate((_, name) => {globalThis.__applicationAccountQA.gates[name]?.(); delete globalThis.__applicationAccountQA.gates[name];}, name);
const stats = () => driver.app.evaluate(() => ({...globalThis.__applicationAccountQA.stats}));
const signalCode = (wrongState = false) => driver.app.evaluate(async (_, wrongState) => {
  const qa = globalThis.__applicationAccountQA, url = new URL(qa.redirect);
  url.searchParams.set('code', 'synthetic_native_authorization_code');
  if (wrongState) url.searchParams.set('app_state', 'é'.repeat(43));
  const response = await fetch(url, {redirect: 'error'}); await response.text();
  return response.status;
}, wrongState);
const accountState = () => page.evaluate(async () => {
  const reply = await window.asMagicBrain.getApplicationAccount();
  if (!reply.ok) throw Error('Account state unavailable.');
  return {state: reply.value.state, name: reply.value.account?.displayName ?? null, notice: reply.value.notice ?? null};
});
async function capture(name) {
  await driver.screenshot(name);
  const measured = await page.evaluate(() => {
    const selectors = {
      AA1: '.ac-profile', AA2: '.ac-menu [data-app-account-action]', GA1: '.ac-github-connection',
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
  const bytes = Buffer.from(result.base64, 'base64'), filename = 'application-account-walkthrough.webm';
  await fs.writeFile(path.join(output, filename), bytes); await cdp.detach();
  driver.record('real-account-ui-walkthrough-recording', {file: filename, mime: result.mime, durationMs: Date.now() - state.started, capturedFrames: state.frames, droppedFrames: state.dropped, frameErrors: state.frameErrors, canvasRate: 12, bytes: bytes.length, scope: 'First isolated launch only; actual CDP native renderer frames encoded with MediaRecorder. Synthetic provider; no live credentials, browser or email.'});
  assert.ok(bytes.length > 0 && state.frames > 0); assert.equal(state.frameErrors, 0);
}

async function installFixture() {
  let deadline;
  const result = await Promise.race([driver.app.evaluate(async ({app, ipcMain, safeStorage}, expectedName) => {
    const stage = value => {globalThis.__applicationAccountQAStage = value; process.stderr.write('ASMB_ACCOUNT_QA_STAGE ' + value + '\n');};
    stage('loading-bundled-modules');
    const fs = process.getBuiltinModule('node:fs/promises');
    const crypto = process.getBuiltinModule('node:crypto');
    const resources = app.getAppPath(), require = process.getBuiltinModule('node:module').createRequire(resources + '/package.json');
    const {createApplicationAuth, applicationAccountMethods} = require(resources + '/apps/native/application-auth.mjs');
    const {createCredentialVault} = require(resources + '/apps/native/credential-vault.mjs');
    const {AuthClient} = require(resources + '/apps/native/dist-host/application-sdk.mjs');
    stage('creating-isolated-fixture-profile');
    const profileRoot = app.getPath('userData') + '/account-acceptance-fixture';
    await fs.mkdir(profileRoot, {mode: 0o700, recursive: true});
    const origin = 'https://brgxjdhkcfvbpsziebus.supabase.co', id = '11111111-2222-4333-8444-555555555555';
    const nonce = crypto.randomBytes(24).toString('hex');
    const qa = {controls: {name: expectedName, holdSend: false, holdEncrypt: false, offline: false, badCode: false}, gates: {}, stats: {opened: 0, otp: 0, verify: 0, exchanged: 0, users: 0, updates: 0, logout: 0, localScope: false, encrypted: 0, invalidPublicReply: false}};
    const wait = name => new Promise(resolve => {qa.gates[name] = resolve;});
    const user = () => ({id, email: 'native-test@example.invalid', aud: 'authenticated', created_at: '2026-09-18T00:00:00Z', is_anonymous: false, app_metadata: {provider: 'github'}, user_metadata: {display_name: qa.controls.name}, identities: [{provider: 'github', identity_data: {sub: '77', user_name: 'native-synthetic'}}]});
    const session = () => {
      const expires_at = Math.floor(Date.now() / 1000) + 3600;
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      return {access_token: encode({alg: 'ES256', typ: 'JWT'}) + '.' + encode({iss: origin + '/auth/v1', sub: id, exp: expires_at}) + '.syntheticSignature', refresh_token: 'synthetic_native_refresh_' + nonce, token_type: 'bearer', expires_in: 3600, expires_at, user: user(), provider_token: 'synthetic_native_provider_' + nonce, provider_refresh_token: 'synthetic_native_provider_refresh_' + nonce};
    };
    const response = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
    const nativeStorage = {isAvailable: () => safeStorage.isAsyncEncryptionAvailable(), encrypt: value => safeStorage.encryptStringAsync(value), decrypt: async value => (await safeStorage.decryptStringAsync(value)).result};
    const githubVault = createCredentialVault({profileRoot, clientId: 'Iv1.SYNTHETIC_INDEPENDENT', storage: nativeStorage});
    stage('encrypting-independent-github-marker');
    await githubVault.save({marker: nonce});
    stage('creating-fixture-auth-service');
    qa.independentGitHubVaultIntact = async () => (await githubVault.load()).marker === nonce;
    qa.profileHasNoPlaintextNonce = async () => {
      const walk = async directory => {
        for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
          const filename = directory + '/' + entry.name;
          if (entry.isDirectory()) {if (!await walk(filename)) return false;}
          else if (entry.isFile() && (await fs.readFile(filename)).includes(Buffer.from(nonce))) return false;
        }
        return true;
      };
      return walk(profileRoot);
    };
    const auth = createApplicationAuth({config: {origin, publishableKey: 'sb_publishable_SYNTHETIC_native_public_key', providers: {github: true, email: true}}, AuthClient, profileRoot,
      storage: {...nativeStorage, encrypt: async value => {if (qa.controls.holdEncrypt) await wait('encrypt'); qa.stats.encrypted++; return safeStorage.encryptStringAsync(value);}},
      openExternal: async value => {const url = new URL(value); if (url.origin !== origin || url.pathname !== '/auth/v1/authorize' || url.searchParams.get('provider') !== 'github' || url.searchParams.get('code_challenge_method') !== 's256') throw Error('Unexpected synthetic authorize URL.'); qa.redirect = url.searchParams.get('redirect_to'); qa.stats.opened++;},
      fetch: async (value, init) => {
        if (qa.controls.offline) throw Error('synthetic_native_private_network_detail');
        const url = new URL(value), body = init.body ? JSON.parse(init.body) : null;
        if (url.origin !== origin) throw Error('Unexpected synthetic auth origin.');
        if (url.pathname === '/auth/v1/otp') {qa.stats.otp++; qa.redirect = url.searchParams.get('redirect_to'); if (body.code_challenge_method !== 's256' || body.create_user !== true) throw Error('Incorrect email protocol.'); if (qa.controls.holdSend) await wait('send'); return response({});}
        if (url.pathname === '/auth/v1/token') {qa.stats.exchanged++; if (url.searchParams.get('grant_type') === 'pkce' && (!body.code_verifier || body.auth_code !== 'synthetic_native_authorization_code')) throw Error('Incorrect PKCE exchange.'); return response(session());}
        if (url.pathname === '/auth/v1/verify') {qa.stats.verify++; if (body.type !== 'email' || body.email !== 'native-test@example.invalid' || typeof body.token !== 'string') throw Error('Incorrect OTP verification.'); return qa.controls.badCode ? response({message: 'synthetic_native_provider_private_detail'}, 403) : response(session());}
        if (url.pathname === '/auth/v1/user' && init.method === 'GET') {qa.stats.users++; return response(user());}
        if (url.pathname === '/auth/v1/user' && init.method === 'PUT') {qa.stats.updates++; if (Object.keys(body).some(key => !['data', 'code_challenge', 'code_challenge_method'].includes(key)) || body.code_challenge !== null || body.code_challenge_method !== null || Object.keys(body.data).join(',') !== 'display_name') throw Error('Unexpected profile update fields.'); qa.controls.name = body.data.display_name; return response(user());}
        if (url.pathname === '/auth/v1/logout') {qa.stats.logout++; qa.stats.localScope = url.searchParams.get('scope') === 'local'; return response(null, 204);}
        throw Error('Unexpected synthetic auth endpoint.');
      },
    });
    qa.auth = auth;
    stage('checking-production-ipc-sender-rejection');
    const original = ipcMain._invokeHandlers.get('asmb:native');
    if (typeof original !== 'function') throw Error('Native IPC handler missing.');
    const denied = await original({sender: null, senderFrame: null}, {method: 'getApplicationAccount'});
    if (denied.ok !== false || denied.error.code !== 'VIEW_UNAVAILABLE') throw Error('Untrusted sender reached account IPC.');
    ipcMain.removeHandler('asmb:native');
    ipcMain.handle('asmb:native', async (event, input) => {
      if (input?.method === 'getGitHubConnection') return {ok: true, value: {configured: true, state: 'connected', account: {id: 77, username: 'native-repository-account', displayName: 'Repository Grant Fixture', email: null}}};
      if (!applicationAccountMethods.has(input?.method)) return original(event, input);
      try {
        const value = await auth.request(input.method, input.args);
        if (/synthetic_native_(?:refresh|provider|private)/.test(JSON.stringify(value))) {qa.stats.invalidPublicReply = true; throw Error('Secret fixture value reached public DTO.');}
        return {ok: true, value};
      } catch (error) {return {ok: false, error: {code: error.code ?? 'ACCOUNT_UNAVAILABLE', message: error.code ? error.message : 'Synthetic account request failed.'}};}
    });
    globalThis.__applicationAccountQA = qa;
    stage('fixture-installed');
    return {secureStorage: await safeStorage.isAsyncEncryptionAvailable(), profileRoot, sdk: resources + '/apps/native/dist-host/application-sdk.mjs', syntheticProvider: true, liveNetwork: false, callbackListener: 'actual loopback HTTP', untrustedIpcRejected: true};
  }, profileName), new Promise((_, reject) => {deadline = setTimeout(() => reject(Error('Fixture initialization exceeded 25 seconds; inspect sanitized stage markers.')), 25000);})]).finally(() => clearTimeout(deadline));
  assert.equal(result.secureStorage, true);
  driver.record('synthetic-provider-with-bundled-sdk-and-native-secure-storage', {...result, githubFixture: 'Display-only connected identity plus a separate real OS-encrypted vault marker; no real GitHub grant.'});
  await page.evaluate(() => {window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('asmb:github-connection-changed'));});
}

async function launch() {
  page = await driver.launch(); running = true; page.setDefaultTimeout(15000);
  driver.app.process().stderr?.on('data', value => {
    for (const line of value.toString().split('\n')) if (/^ASMB_ACCOUNT_QA_STAGE [a-z-]+$/.test(line)) console.log(line);
  });
  await button('Account menu').waitFor();
  await driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000));
  await installFixture();
}
async function close() {
  // Settle the test-only service as well as the production native close path.
  let fixtureFailure;
  try {
    await stopVideo();
    const initialized = await driver.app.evaluate(() => Boolean(globalThis.__applicationAccountQA));
    if (initialized) {
      assert.equal(await driver.app.evaluate(() => globalThis.__applicationAccountQA.profileHasNoPlaintextNonce()), true);
      assert.equal(await driver.app.evaluate(() => globalThis.__applicationAccountQA.independentGitHubVaultIntact()), true);
      await driver.app.evaluate(async () => {await globalThis.__applicationAccountQA.auth.prepareClose(); await globalThis.__applicationAccountQA.auth.close();});
    }
  } catch (error) {fixtureFailure = error;}
  await driver.closeNormally(); running = false;
  if (fixtureFailure) throw fixtureFailure;
}
async function openSignIn() {await accountMenu(); await menuitem('Sign in to asMagicBrain').click(); await signInDialog().waitFor();}
async function connected(expectedName) {
  await until(async () => (await accountState()).name === expectedName && (await accountState()).state === 'signed-in', {label: 'verified app account'});
  await signInDialog().waitFor({state: 'detached'});
  await accountMenu(); await until(() => page.locator('.ac-profile strong').innerText().then(value => value === expectedName), {label: 'app identity in account menu'});
  assert.equal(await page.locator('.ac-github-connection').getByText('native-repository-account', {exact: true}).count(), 1);
}

try {
  await launch(); await startVideo(); initialReadme = await fs.readFile(path.join(workspacePath, 'README.md'));
  await accountMenu(); await menuitem('Sign in to asMagicBrain').waitFor(); await menuitem('Disconnect GitHub').waitFor();
  await capture('aa-signed-out-separate-github'); await dismissMenu();
  driver.record('account-and-repository-connection-distinct-in-actual-native-menu');

  await openSignIn(); await capture('aa-signin-methods'); await button('Continue with email').click();
  assert.equal(await page.locator('[name=account-email]').getAttribute('aria-invalid'), 'true');
  assert.equal((await stats()).otp, 0); driver.record('invalid-email-blocked-before-host-operation');
  await page.locator('[name=account-email]').fill('native-test@example.invalid'); await controls({holdSend: true});
  await button('Continue with email').click(); await until(async () => (await stats()).otp === 1, {label: 'delayed email request'});
  await button('Close sign-in').click(); await release('send'); await controls({holdSend: false});
  await signInDialog().waitFor({state: 'detached'}); assert.equal((await accountState()).state, 'signed-out');
  driver.record('cancel-before-email-start-response-keeps-signed-out');

  await openSignIn(); await controls({holdEncrypt: true}); await button('Continue with GitHub').click();
  await signInDialog().getByText('Waiting for browser sign-in…', {exact: true}).waitFor();
  assert.equal(await signalCode(), 200); await until(() => driver.app.evaluate(() => Boolean(globalThis.__applicationAccountQA.gates.encrypt)), {label: 'OS secure publication gate'});
  await button('Close sign-in').click(); await release('encrypt'); await controls({holdEncrypt: false});
  await signInDialog().waitFor({state: 'detached'}); assert.equal((await accountState()).state, 'signed-out');
  driver.record('cancel-during-secure-publication-no-late-account');

  await openSignIn(); await button('Continue with GitHub').click();
  await signInDialog().getByText('Waiting for browser sign-in…', {exact: true}).waitFor(); await capture('aa-awaiting-browser');
  assert.equal(await signalCode(true), 400); assert.equal((await accountState()).state, 'signed-out');
  assert.equal(await signalCode(), 200); await connected(profileName); await capture('aa-connected-menu'); await menuitem('Profile').click();
  await page.getByRole('dialog', {name: 'Profile', exact: true}).waitFor();
  profileName = 'Native Updated Account'; await page.locator('[name=display-name]').fill(profileName); await button('Save profile').click();
  await page.getByText('Profile saved.', {exact: true}).waitFor(); await capture('aa-profile-saved'); await button('Done').click();
  driver.record('actual-loopback-wrong-state-rejected-valid-code-accepted-profile-update-and-github-independence');
  const beforeClose = await stats(); assert.equal(beforeClose.invalidPublicReply, false); assert.equal(beforeClose.updates, 1);
  await close();

  await launch(); await connected(profileName); await capture('aa-restored-encrypted-session');
  driver.record('same-package-restart-restores-app-session-through-real-os-storage');
  await menuitem('Sign out of asMagicBrain').click(); await until(async () => (await accountState()).state === 'signed-out', {label: 'local application logout'});
  assert.equal((await stats()).localScope, true); await accountMenu(); assert.equal(await menuitem('Disconnect GitHub').isVisible(), true); await dismissMenu();
  driver.record('application-signout-explicit-local-scope-preserves-github-display');

  await openSignIn(); await page.locator('[name=account-email]').fill('native-test@example.invalid'); await button('Continue with email').click();
  await signInDialog().getByText('My email includes a code', {exact: true}).waitFor(); await capture('aa-email-link-or-code');
  await button('My email includes a code').click(); await controls({badCode: true}); await page.locator('[name=account-code]').fill('000000'); await button('Sign in').click();
  await until(() => page.locator('[name=account-code]').getAttribute('aria-invalid').then(value => value === 'true'), {label: 'retryable invalid email code'});
  assert.ok(!(await signInDialog().innerText()).includes('synthetic_native_provider_private_detail'));
  await capture('aa-optional-email-code-error');
  await controls({badCode: false}); await page.locator('[name=account-code]').fill('123456'); await button('Sign in').click();
  await connected(profileName); driver.record('email-otp-ui-error-and-retry-through-official-sdk');

  await controls({offline: true}); await menuitem('Sign out of asMagicBrain').click();
  await until(async () => (await accountState()).state === 'signed-out', {label: 'offline local logout'});
  assert.match((await accountState()).notice, /this device/); await accountMenu(); await capture('aa-offline-signout-notice'); await dismissMenu();
  assert.deepEqual(await fs.readFile(path.join(workspacePath, 'README.md')), initialReadme);
  assert.equal((await stats()).invalidPublicReply, false);
  driver.record('offline-signout-removes-app-session-and-preserves-local-source');
  await controls({offline: false}); await openSignIn(); await page.locator('[name=account-email]').fill('native-test@example.invalid'); await button('Continue with email').click();
  await button('My email includes a code').waitFor(); assert.equal(await signalCode(), 200); await connected(profileName);
  driver.record('email-magic-link-actual-loopback-completes-through-official-sdk');
  await menuitem('Sign out of asMagicBrain').click(); await until(async () => (await accountState()).state === 'signed-out', {label: 'email link logout'}); await dismissMenu();
  await theme('GitHub Dark Default');
  await driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(520, 760));
  await openSignIn(); await page.keyboard.press('Tab');
  const geometry = await signInDialog().evaluate(element => {
    const r = element.getBoundingClientRect(); return {x: r.x, y: r.y, right: r.right, bottom: r.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, documentWidth: document.documentElement.scrollWidth, keyboardFocusInside: element.contains(document.activeElement)};
  });
  assert.ok(geometry.x >= 0 && geometry.y >= 0 && geometry.right <= geometry.viewportWidth + 1 && geometry.bottom <= geometry.viewportHeight + 1 && geometry.documentWidth <= geometry.viewportWidth && geometry.keyboardFocusInside);
  await capture('aa-narrow-dark-keyboard'); await page.keyboard.press('Escape'); await signInDialog().waitFor({state: 'detached'});
  assert.equal(await button('Account menu').evaluate(element => element === document.activeElement), true);
  driver.record('dark-narrow-dialog-contained-keyboard-focus-and-escape-restore', geometry);
  await close(); await launch(); assert.equal((await accountState()).state, 'signed-out');
  assert.deepEqual(await fs.readFile(path.join(workspacePath, 'README.md')), initialReadme); await close();
  assert.deepEqual(driver.errors, []);
} catch (error) {
  failure = error; driver.record('failure', {message: error.message});
  if (page && running) await driver.screenshot('failure').catch(() => {});
} finally {
  if (running) await close().catch(error => {driver.record('normal-close-incomplete', {message: error.message});});
  await driver.report({passed: !failure, definitionSha256: createHash('sha256').update(definition).digest('hex'), qualification: 'Actual packaged renderer, preload, bundled Auth SDK and application auth/vault modules with synthetic host-only provider responses. Loopback HTTP callback, OS encryption, normal close and isolated restart are real. Existing production account IPC is temporarily delegated to a separate fixture service only in this test process. GitHub connected state is a display fixture plus independent encrypted-vault marker; no real grant, system browser, email or remote mutation is exercised.', limitations: ['No live OAuth/email delivery or Supabase redirect configuration qualification.', 'Native teardown explicitly drains the fixture service; production lifetime ownership has separate host tests.', 'No default profile or live workspace was opened; no forced app quit.']});
  console.log(output);
}
if (failure) throw failure;
