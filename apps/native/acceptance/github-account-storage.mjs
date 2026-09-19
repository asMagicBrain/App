import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
/** Packaged Electron + real OS safeStorage qualification using synthetic identity.
 * The configured production auth/coordinator are instantiated by the debugger;
 * the shipped main account stays untouched. No IPC handler is replaced. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const testRoot = developmentTestRoot;
const runRoot = path.resolve(process.env.ASMB_ACCEPTANCE_RUN_ROOT ?? path.join(testRoot, 'runs/native-signin-readiness-20260917/review'));
assert.ok(runRoot.startsWith(testRoot + '/runs/'), 'Acceptance output must remain inside Test/runs.');
const executable = process.env.ASMB_PACKAGED_EXECUTABLE;
const probeOnly = process.argv[3] === '--probe-first-connection';
assert.deepEqual(process.argv.slice(2), probeOnly ? ['--run-isolated', '--probe-first-connection'] : ['--run-isolated']);
assert.ok(executable && path.isAbsolute(executable) && executable.includes('.app/Contents/MacOS/') && (executable.startsWith(appRoot + 'releases/') || executable.startsWith(testRoot + '/runs/')));
const bundle = executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
const metadata = JSON.parse(await fs.readFile(bundle + '/Contents/Resources/app/native-package.json', 'utf8'));
const resources = bundle + '/Contents/Resources/app';
const {githubApp: packagedRegistration} = await import(pathToFileURL(resources + '/apps/native/github-config.mjs').href);
const {registrationSummary} = await import(pathToFileURL(resources + '/apps/native/github-registration.mjs').href);
const shippedRegistration = registrationSummary(packagedRegistration);
assert.deepEqual(metadata.githubRegistration, shippedRegistration, 'Package metadata must match its bundled public registration.');
import {_electron, chromium} from '../../../tools/playwright.mjs';
await fs.mkdir(runRoot, {recursive: true});
const output = await fs.mkdtemp(runRoot + '/storage-'), data = output + '/data', tmp = output + '/tmp', vaultProfile = output + '/synthetic-vault';
await fs.mkdir(tmp); await fs.mkdir(vaultProfile, {mode: 0o700});
const nonce = randomUUID(), baseTime = Date.now(), clientId = 'Iv23.' + nonce.replaceAll('-', '');
const events = [], errors = [], logs = [];
let application, page, reconnected, failure, workspaceBefore, authorBefore;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const record = (name, details = {}) => {events.push({name, at: new Date().toISOString(), ...details}); console.log(name);};
async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout; let last;
  do {try {last = await check(); if (last) return last;} catch (error) {last = error.message;} await new Promise(resolve => setTimeout(resolve, 60));} while (Date.now() < deadline);
  throw Error(`Timeout ${label}: ${last}`);
}
async function launch(clock = baseTime, serial = 0) {
  application = await _electron.launch({executablePath: executable, args: ['--test-data-root=' + data], cwd: output, env: {PATH: process.env.PATH, TMPDIR: tmp}});
  page = await application.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  application.process().stdout?.on('data', data => logs.push(data.toString())); application.process().stderr?.on('data', data => logs.push(data.toString()));
  await page.getByRole('button', {name: /^Switch local repository:/}).waitFor();
  const runtime = await application.evaluate(({app}) => ({packaged: app.isPackaged, executable: process.execPath, profile: app.getPath('userData')}));
  assert.equal(runtime.packaged, true); assert.equal(runtime.executable, executable); assert.equal(runtime.profile, data + '-electron-profile');
  // The actual main profile never receives a live or synthetic connection.
  // Only the separate debugger-created instance below performs authorization.
  const shippedConnection = await page.evaluate(() => window.asMagicBrain.getGitHubConnection());
  assert.deepEqual(shippedConnection, {ok:true,value:{configured:shippedRegistration.configured,state:shippedRegistration.configured?'signed-out':'unavailable'}});
  const setup = await application.evaluate(async ({app, safeStorage}, input) => {
    const root = app.getAppPath() + '/apps/native', require = process.getBuiltinModule('node:module').createRequire(root + '/main.mjs');
    const {createGitHubAuth} = require('./github-auth.mjs');
    const {createGitHubAccountCoordinator} = require('./github-account-coordinator.mjs');
    const state = {clock: input.clock, serial: input.serial, requests: [], storageErrors: [], holdDevice: false, holdStarted: false, release: null, dialogs: [], tokens: []};
    const token = (kind, serial) => 'synthetic-' + kind + '-' + input.nonce + '-' + serial;
    const syntheticFetch = async (endpoint, options) => {
      if (!['https://github.com/login/device/code', 'https://github.com/login/oauth/access_token', 'https://api.github.com/user'].includes(endpoint)) throw Error('Unexpected endpoint');
      state.requests.push({endpoint, method: options.method, redirect: options.redirect});
      if (endpoint.endsWith('/device/code')) {
        if (state.holdDevice) {state.holdStarted = true; await new Promise(resolve => {state.release = resolve;});}
        const device = token('device', state.serial); state.tokens.push(device);
        return new Response(JSON.stringify({device_code: device, user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1}), {status: 200});
      }
      if (endpoint.endsWith('/access_token')) {
        state.serial += 1; const access = token('access', state.serial), refresh = token('refresh', state.serial); state.tokens.push(access, refresh);
        return new Response(JSON.stringify({access_token: access, refresh_token: refresh, token_type: 'bearer', expires_in: 28800, refresh_token_expires_in: 15552000}), {status: 200});
      }
      return new Response(JSON.stringify({id: 424242, login: 'asmagicbrain-storage-qa', name: 'Synthetic storage qualification', email: null}), {status: 200});
    };
    const storage = {
      isAvailable: async () => await safeStorage.isAsyncEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
      encrypt: async text => {try {return await safeStorage.encryptStringAsync(text);} catch (error) {state.storageErrors.push({operation: 'encrypt', code: /^[A-Z_]{1,80}$/.test(error?.code ?? '') ? error.code : null}); throw error;}},
      decrypt: async bytes => {try {return (await safeStorage.decryptStringAsync(bytes)).result;} catch (error) {state.storageErrors.push({operation: 'decrypt', code: /^[A-Z_]{1,80}$/.test(error?.code ?? '') ? error.code : null}); throw error;}},
    };
    const auth = createGitHubAuth({clientId: input.clientId, profileRoot: input.vaultProfile, storage, fetch: syntheticFetch, now: () => state.clock, openExternal: async () => {throw Error('Browser opening excluded from storage qualification');}});
    const coordinator = createGitHubAccountCoordinator({auth, cloneCoordinator: {disconnect: action => action()}, updateCoordinator: {disconnect: action => action()}});
    globalThis.__accountStorageQA = {state, auth, coordinator, expected: serial => token('access', serial)};
    return {available: await storage.isAvailable(), electron: process.versions.electron, configured: (await coordinator.request('getGitHubConnection')).configured};
  }, {clock, serial, nonce, clientId, vaultProfile});
  assert.equal(setup.available, true); assert.equal(setup.configured, true);
  record('actual-packaged-launch-real-secure-storage', {runtime, setup, shippedConnection:shippedConnection.value, productionAuthorizationStarted:false});
}
async function connection() {return application.evaluate(() => globalThis.__accountStorageQA.coordinator.request('getGitHubConnection'));}
async function assertCredential(serial) {
  assert.equal(await application.evaluate(async (_, serial) => {
    const qa = globalThis.__accountStorageQA; return (await qa.auth.getCredential()).token === qa.expected(serial);
  }, serial), true);
}
async function connect() {
  const started = await application.evaluate(() => globalThis.__accountStorageQA.coordinator.request('startGitHubConnection'));
  assert.equal(started.state, 'awaiting-authorization'); assert.equal(started.verificationUri, 'https://github.com/login/device');
  const result = await application.evaluate(async (_, requestId) => {
    const qa = globalThis.__accountStorageQA; qa.state.clock += 1001;
    return qa.coordinator.request('pollGitHubConnection', {requestId});
  }, started.requestId);
  if (result.state !== 'connected') {
    const diagnostics = await application.evaluate(() => ({requests: globalThis.__accountStorageQA.state.requests, storageErrors: globalThis.__accountStorageQA.state.storageErrors}));
    record('sanitized-first-connection-failure', {result, diagnostics});
  }
  assert.equal(result.state, 'connected', JSON.stringify(result)); assert.equal(result.account.email, null);
  for (const dto of [started, result, await connection()]) assert.ok(!/synthetic-(access|refresh|device)-|deviceCode|refreshToken|access_token/.test(JSON.stringify(dto)));
  return result;
}
async function ciphertext() {
  const entries = await fs.readdir(vaultProfile + '/github-auth'); assert.deepEqual(entries, [hash(clientId) + '.bin']);
  const file = vaultProfile + '/github-auth/' + entries[0], bytes = await fs.readFile(file), stat = await fs.lstat(file);
  assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.nlink, 1); assert.ok(!bytes.includes(Buffer.from('synthetic-')));
  assert.equal((await fs.stat(vaultProfile + '/github-auth')).mode & 0o777, 0o700);
  return {file, hash: hash(bytes), size: bytes.length};
}
async function close() {
  // Explicitly exercise the configured production coordinator lifecycle. The
  // shipped main independently executes its normal signed-out close protocol.
  await application.evaluate(async () => {await globalThis.__accountStorageQA.coordinator.prepareClose(); await globalThis.__accountStorageQA.auth.close();});
  const closed = application.waitForEvent('close', {timeout: 20000});
  await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].close()).catch(error => {if (!/closed|destroyed/i.test(String(error))) throw error;});
  await closed; application = null; record('configured-service-drain-and-normal-native-close');
}
async function privateScan() {
  let files = 0; const leaks = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        files += 1; const bytes = await fs.readFile(file);
        for (let serial = 0; serial <= 5; serial++) for (const kind of ['access', 'refresh', 'device']) if (bytes.includes(Buffer.from('synthetic-' + kind + '-' + nonce + '-' + serial))) leaks.push(path.relative(output, file));
      }
    }
  }
  await walk(output); assert.deepEqual(leaks, []);
  assert.ok(!logs.join('').includes(nonce));
  return {files, plaintextLeaks: 0};
}

try {
  await launch(); assert.equal((await connection()).state, 'signed-out');
  workspaceBefore = await fs.readFile(data + '/workspaces/asMagicBrain/Workspace/README.md');
  authorBefore = await page.evaluate(() => JSON.stringify(localStorage));
  await fs.writeFile(vaultProfile + '/unrelated-test-marker.txt', 'Preserve unrelated private state.\n');
  await connect(); await assertCredential(1); const first = await ciphertext();
  record('synthetic-account-real-encrypted-publication', {ciphertext: {sha256: first.hash, bytes: first.size}, dtoContainsSecrets: false});
  if (probeOnly) {await close(); record('first-connection-only-probe');} else {
  await close(); await launch(baseTime + 2000, 1);
  assert.equal((await connection()).state, 'connected'); await assertCredential(1); assert.equal((await ciphertext()).hash, first.hash);
  assert.equal(await application.evaluate(() => globalThis.__accountStorageQA.state.requests.length), 0);
  record('new-process-decrypts-cached-identity-without-network');

  await application.evaluate(() => {globalThis.__accountStorageQA.state.clock += 8 * 3600 * 1000;});
  await assertCredential(2); const refreshed = await ciphertext(); assert.notEqual(refreshed.hash, first.hash);
  record('expiry-rotates-synthetic-token-pair-in-real-secure-storage', {ciphertextSha256: refreshed.hash});
  await close(); await launch(baseTime + 8 * 3600 * 1000 + 4000, 2); await assertCredential(2);
  assert.equal((await ciphertext()).hash, refreshed.hash); record('rotated-credential-survives-next-process');

  await application.evaluate(({dialog}) => {
    const old = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = async (...args) => {
      if (args.at(-1)?.title === 'The editor stopped') {globalThis.__accountStorageQA.state.dialogs.push({title: 'The editor stopped', at: Date.now()}); return {response: 0, checkboxChecked: false};}
      return old(...args);
    };
  });
  const rendererPid = await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.getOSProcessId());
  await application.evaluate(({BrowserWindow}) => {setTimeout(() => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(), 0);});
  await until(() => application.evaluate((_, pid) => {const wc = process.getBuiltinModule ? globalThis.__accountStorageQA : null; return wc?.state.dialogs.length === 1;}, rendererPid), 'native renderer recovery dialog');
  await until(() => application.evaluate(({BrowserWindow}, pid) => {const wc = BrowserWindow.getAllWindows()[0].webContents; return !wc.isLoading() && wc.getOSProcessId() > 0 && wc.getOSProcessId() !== pid;}, rendererPid), 'new renderer process');
  const port = (await fs.readFile(data + '-electron-profile/session/DevToolsActivePort', 'utf8')).split('\n')[0];
  reconnected = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  page = reconnected.contexts()[0].pages().find(value => value.url() === 'app://asmagicbrain/index.html'); assert.ok(page);
  page.on('pageerror', error => errors.push(error.message)); await page.getByRole('button', {name: /^Switch local repository:/}).waitFor();
  await assertCredential(2); assert.equal((await ciphertext()).hash, refreshed.hash);
  assert.equal(await page.evaluate(() => Object.hasOwn(globalThis, '__accountStorageQA')), false);
  record('actual-renderer-crash-recovery-retains-host-only-encrypted-identity');

  await application.evaluate(() => {
    const qa = globalThis.__accountStorageQA; qa.state.holdDevice = true;
    qa.pending = qa.coordinator.request('startGitHubConnection').then(() => ({unexpected: true}), error => ({code: error.code}));
  });
  await until(() => application.evaluate(() => globalThis.__accountStorageQA.state.holdStarted), 'synthetic provider pending');
  const cancelled = await application.evaluate(async () => {
    const qa = globalThis.__accountStorageQA; const start = Date.now(); await qa.coordinator.prepareClose();
    const result = await qa.pending; qa.state.release(); await new Promise(resolve => setTimeout(resolve, 20));
    const rejected = await qa.coordinator.request('startGitHubConnection').then(() => null, error => error.code);
    qa.coordinator.resume(); return {result, rejected, elapsed: Date.now() - start, connection: await qa.coordinator.request('getGitHubConnection')};
  });
  assert.equal(cancelled.result.code, 'GITHUB_CANCELLED'); assert.equal(cancelled.rejected, 'SERVICE_CLOSED'); assert.equal(cancelled.connection.state, 'connected'); assert.ok(cancelled.elapsed < 2000);
  assert.equal((await ciphertext()).hash, refreshed.hash); await assertCredential(2);
  record('production-coordinator-cancels-noncooperative-provider-before-close', {milliseconds: cancelled.elapsed, previousCiphertextPreserved: true, seam: 'Explicit lifecycle invocation on debugger-created configured production instance; no global provider override.'});
  await close(); await launch(baseTime + 8 * 3600 * 1000 + 6000, 2); await assertCredential(2);
  const disconnected = await application.evaluate(() => globalThis.__accountStorageQA.coordinator.request('disconnectGitHub'));
  assert.equal(disconnected.state, 'signed-out'); assert.deepEqual(await fs.readdir(vaultProfile + '/github-auth'), []);
  assert.equal(await fs.readFile(vaultProfile + '/unrelated-test-marker.txt', 'utf8'), 'Preserve unrelated private state.\n');
  assert.deepEqual(await fs.readFile(data + '/workspaces/asMagicBrain/Workspace/README.md'), workspaceBefore);
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), authorBefore);
  record('local-disconnect-removes-only-owned-ciphertext-preserves-files-and-preferences');
  await close(); await launch(baseTime + 8 * 3600 * 1000 + 7000, 2); assert.equal((await connection()).state, 'signed-out');
  assert.equal(await application.evaluate(() => globalThis.__accountStorageQA.state.requests.length), 0); await close();
  record('disconnect-remains-signed-out-after-process-restart');
  }
  assert.deepEqual(errors, []); record('owned-profile-and-captured-log-plaintext-scan', await privateScan());
} catch (error) {failure = error; record('failure', {message: error.message, stack: error.stack});}
finally {
  if (application) await application.close().catch(() => {}); if (reconnected) await reconnected.close().catch(() => {});
  await fs.writeFile(output + '/receipt.json', JSON.stringify({passed: !failure, probeOnly, metadata, shippedRegistration, executable, events, errors,
    definitionSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
    qualification: 'Actual packaged Electron 44 safeStorage and normal native close/restart/renderer recovery, using bundled production auth/account coordinator instantiated by debugger with synthetic provider, injected clock, isolated credential directory, and inert authenticated-download coordinators. The shipped public registration matches package metadata; its separate pristine-profile account state is checked without starting production authorization. No account IPC is replaced, and no real GitHub authorization, installation, private clone, OS permission-denial, or non-macOS claim is made. Coordinator prepareClose on the synthetic configured instance is invoked explicitly; the actual main independently runs its normal account lifecycle without receiving a connection. Renderer recovery chooses Reopen editor at the native dialog boundary. No external account/Keychain setting change or live profile is used.'}, null, 2) + '\n');
  console.log(output);
}
if (failure) throw failure;
