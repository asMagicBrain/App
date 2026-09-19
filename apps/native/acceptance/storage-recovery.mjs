/** Packaged storage-recovery acceptance on macOS/Ubuntu.
 * ASMB_PACKAGED_EXECUTABLE=/absolute/packaged/executable node ... --run-isolated
 * Linux also requires ASMB_PACKAGE_MANIFEST=/absolute/package-manifest.json.
 * macOS defaults to the package-manifest.json alongside its .app.
 * Uses external Chromium CDP with the shipped inspection fuses unchanged.
 * An operator accepts the real native dialog after waiting-for-operator appears.
 * The prior device namespace is synthetic; this does not simulate a real reboot,
 * driver installation or physical volume change. No filesystem stat patch.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from '../../../tools/playwright.mjs';
import { testRoot } from '../../../tools/development-paths.mjs';

assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
assert.ok(['darwin', 'linux'].includes(process.platform));
const executable = process.env.ASMB_PACKAGED_EXECUTABLE;
assert.ok(executable && path.isAbsolute(executable) && fs.realpathSync(executable) === executable);
if (process.platform === 'linux') assert.equal(executable, '/opt/asmagicbrain-preview/asmagicbrain');
else assert.ok(executable.includes('.app/Contents/MacOS/'));
const payload = process.platform === 'linux' ? path.join(path.dirname(executable), 'resources/app')
  : path.join(executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4), 'Contents/Resources/app');
const metadataBytes = fs.readFileSync(path.join(payload, 'native-package.json')), metadata = JSON.parse(metadataBytes);
assert.equal(metadata.channel, 'preview');
assert.equal(metadata.accountRuntimePolicy.electronFuses.wire, process.platform === 'darwin' ? '101100011' : '100000011');
assert.match(metadata.sourceCommit, /^[a-f0-9]{40}$/u);
assert.equal(typeof metadata.candidate, 'boolean');
const manifestPath = process.env.ASMB_PACKAGE_MANIFEST ?? (process.platform === 'darwin'
  ? path.join(path.dirname(executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4)), 'package-manifest.json') : null);
assert.ok(manifestPath && path.isAbsolute(manifestPath), 'Supply the exact package manifest on Linux.');
assert.equal(fs.realpathSync(manifestPath), manifestPath);
const manifestBytes = fs.readFileSync(manifestPath), packageManifest = JSON.parse(manifestBytes);
for (const key of ['version', 'buildNumber', 'sourceCommit', 'sourceTag', 'channel', 'candidate']) assert.equal(packageManifest[key], metadata[key]);
assert.equal(packageManifest.runtime.platform, process.platform); assert.equal(packageManifest.runtime.arch, process.arch);
const runRoot = path.resolve(process.env.ASMB_ACCEPTANCE_RUN_ROOT ?? path.join(testRoot, 'runs/storage-recovery'));
assert.ok(runRoot.startsWith(path.join(testRoot, 'runs') + path.sep));
fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
assert.equal(fs.realpathSync(runRoot), runRoot);
const output = fs.mkdtempSync(path.join(runRoot, 'native-')), home = path.join(output, 'home');
const dataRoot = path.join(home, 'asMagicBrain'), workspace = path.join(dataRoot, 'workspaces/asMagicBrain/Workspace');
const profileRoot = path.join(home, process.platform === 'darwin' ? 'Library/Application Support/asMagicBrain Preview' : '.config/asMagicBrain Preview');
const portFile = path.join(profileRoot, 'session/DevToolsActivePort');
const args = [`--test-root=${testRoot}`, `--test-user-home=${home}`];
const temporary = path.join(output, 'tmp'); fs.mkdirSync(temporary, { mode: 0o700 });
process.env.TMPDIR = temporary; process.env.TMP = temporary; process.env.TEMP = temporary;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const events = [], rendererErrors = [], consoleErrors = [];
const record = (name, detail = {}) => {const event = { name, at: new Date().toISOString(), ...detail }; events.push(event); console.log(JSON.stringify(event));};
const write = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
fs.copyFileSync(new URL(import.meta.url), path.join(output, 'driver-at-launch.mjs'));
record('isolated-run-created', { output, executable, platform: process.platform, version: metadata.version, buildNumber: metadata.buildNumber });

const modules = ['apps/native/host-service.mjs', 'apps/native/profile-paths.mjs', 'apps/native/bundled-docs-manifest.mjs',
  'apps/native/storage-backup.mjs', 'apps/native/storage-admission.mjs', 'apps/native/storage-preflight.mjs',
  'packages/source-foundation/src/adapters/storage-identity.mjs', 'apps/native/main.mjs'];
const moduleHashes = Object.fromEntries(modules.map(name => [name, sha(fs.readFileSync(path.join(payload, name)))]));
const payloadPrefix = process.platform === 'darwin' ? 'Contents/Resources/app/' : 'opt/asmagicbrain-preview/resources/app/';
const manifestRows = new Map(packageManifest.entries.map(row => [row.path, row]));
for (const name of [...modules, 'native-package.json']) assert.equal(manifestRows.get(payloadPrefix + name)?.type, 'file');
// Bind both direct fixture imports and their shipped JavaScript dependencies to
// the admitted artifact, rather than importing mutable checkout implementations.
for (const row of packageManifest.entries.filter(item => item.type === 'file' && item.path.startsWith(payloadPrefix)
  && (/\.(?:mjs|cjs)$/u.test(item.path) || item.path === payloadPrefix + 'native-package.json'))) {
  const name = row.path.slice(payloadPrefix.length);
  assert.ok(name && !name.split('/').some(part => part === '.' || part === '..'));
  const filename = path.join(payload, name), stat = fs.lstatSync(filename), bytes = fs.readFileSync(filename);
  assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.mode & 0o777, row.mode); assert.equal(bytes.length, row.bytes); assert.equal(sha(bytes), row.sha256);
}
const imported = name => import(pathToFileURL(path.join(payload, name)).href);
const { createNativeService } = await imported('apps/native/host-service.mjs');
const { admitNativeProfile } = await imported('apps/native/profile-paths.mjs');
const { loadBundledDocs } = await imported('apps/native/bundled-docs-manifest.mjs');
const { probeStorageVolume } = await imported('apps/native/storage-backup.mjs');
const savedText = '# Recovery saved fixture\nSaved bytes remain separate from drafts.\n';
const draftText = savedText + 'Retained private draft Ω.\n';
const newDraft = { draftId: 'recovery-new-draft', path: 'unsaved-new.md', text: '# Retained new draft\nNew document stays private.\n' };
const createdText = '# After recovery\nSaved through the packaged preload bridge.\n';
let child, browser, page, exitResult, launchNumber = 0, failure, context, before, backupPath, seedService;
const markerPath = path.join(dataRoot, '.asmb-storage-volume.json');

async function until(check, label, timeout = 120000) {
  const end = Date.now() + timeout; let last;
  do {
    if (child && exitResult) throw Error(`Native process exited while waiting for ${label}: ${JSON.stringify(exitResult)}`);
    try {last = await check(); if (last) return last;} catch (error) {last = error;}
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < end);
  throw Error(`Timed out waiting for ${label}: ${String(last)}`);
}
function inventory(root) {
  const files = {};
  function visit(folder, prefix = '') {
    for (const name of fs.readdirSync(folder).sort()) {
      if (!prefix && ['.asmb-native.lock', '.asmb-storage-volume.json', '.asmb-storage-volume.pending'].includes(name)) continue;
      const relative = prefix + name, filename = path.join(folder, name), stat = fs.lstatSync(filename);
      assert.equal(stat.isSymbolicLink(), false); assert.ok(stat.isFile() || stat.isDirectory());
      if (stat.isDirectory()) visit(filename, relative + '/');
      else files[relative] = { sha256: sha(fs.readFileSync(filename)), bytes: stat.size, inode: String(stat.ino), mode: stat.mode & 0o777 };
    }
  }
  visit(root); return files;
}
async function bridge(method, argument) {
  const reply = await page.evaluate(async ({method, argument}) => window.asMagicBrain[method](argument), {method, argument});
  assert.equal(reply.ok, true, JSON.stringify(reply)); return reply.value;
}
const request = (operation, argument = {}) => bridge('request', {repo: 'Workspace', operation, args: argument});
async function launch(expectConfirmation) {
  assert.ok(!child || exitResult?.code === 0, 'Previous app must close normally');
  launchNumber++; exitResult = null;
  if (fs.existsSync(portFile)) {
    fs.copyFileSync(portFile, path.join(output, `previous-devtools-port-${launchNumber}.txt`)); fs.unlinkSync(portFile);
  }
  const env = { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
  for (const name of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_SANDBOX']) delete env[name];
  const log = fs.openSync(path.join(output, `native-${launchNumber}.log`), 'wx', 0o600);
  try {
    child = spawn(executable, [...args, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      ...(process.platform === 'linux' ? [`--ozone-platform=${process.env.ASMB_LINUX_OZONE ?? 'x11'}`] : [])],
    { cwd: output, env, stdio: ['ignore', log, log] });
  } finally {fs.closeSync(log);}
  child.once('error', error => {exitResult = { error: error.message };});
  child.once('exit', (code, signal) => {exitResult = { code, signal };});
  write(`launch-${launchNumber}.json`, { pid: child.pid, args, expectConfirmation, profileRoot });
  if (expectConfirmation) record('waiting-for-operator', { pid: child.pid,
    action: 'Observe the native Restore workspace access dialog and click Back Up and Restore Access.',
    confirmationEvidence: 'Operator observation is separate; this driver does not automate the native confirmation.' });
  const timeout = expectConfirmation ? 10 * 60 * 1000 : 120000;
  const port = await until(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0], 'Chromium CDP endpoint', timeout);
  assert.match(port, /^[0-9]+$/u);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 120000 });
  page = await until(() => browser.contexts()[0]?.pages().find(item => item.url() === 'app://asmagicbrain/index.html'),
    expectConfirmation ? 'operator-confirmed native startup' : 'unattended restart without another confirmation', timeout);
  page.setDefaultTimeout(120000);
  page.on('pageerror', error => rendererErrors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') consoleErrors.push(message.text());});
  await page.getByRole('button', {name: 'asMagicBrain organization', exact: true}).waitFor();
  await page.context().setOffline(true);
  assert.equal(await page.evaluate(() => typeof process), 'undefined');
  assert.equal((await bridge('getBuildConfiguration')).channel, 'preview');
  if (process.platform === 'linux') {
    const renderers = [];
    for (const pid of fs.readdirSync('/proc').filter(name => /^[0-9]+$/u.test(name))) {
      let command, status;
      try {command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '); status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');}
      catch (error) {if (['ENOENT', 'EACCES', 'ESRCH'].includes(error.code)) continue; throw error;}
      if (!command.startsWith(executable + ' ') || !command.includes('--type=renderer') || !command.includes(profileRoot)) continue;
      assert.match(status, /^Seccomp:\s+2$/mu); assert.match(status, /^NoNewPrivs:\s+1$/mu);
      assert.doesNotMatch(command, /--no-sandbox|--disable-seccomp/u); renderers.push(Number(pid));
    }
    assert.ok(renderers.length); record('linux-renderer-sandbox-observed', { renderers });
  }
  record('packaged-native-ready', { launch: launchNumber, pid: child.pid, expectConfirmation });
}
async function closeNormally() {
  assert.ok(child && !exitResult, 'App remains alive before normal close');
  try {await bridge('windowAction', 'close');} catch (error) {if (!/closed|destroyed/iu.test(error.message)) throw error;}
  const end = Date.now() + 120000;
  while (!exitResult && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(exitResult, { code: 0, signal: null });
  await browser.close(); browser = null; page = null;
  assert.equal(fs.existsSync(path.join(dataRoot, '.asmb-native.lock')), false);
  record('normal-window-close', { launch: launchNumber, exit: exitResult });
}
async function showCatalog() {
  await page.getByRole('button', {name: 'asMagicBrain organization', exact: true}).click();
  await page.locator('.ar-view').waitFor();
  await until(async () => {
    const names = await page.locator('.ar-repositories > li').evaluateAll(rows => rows.map(row => row.getAttribute('data-repository-name')));
    return names.includes('Workspace') && names.includes('asMagicBrain-Docs') && names;
  }, 'renderer catalog contains Workspace and packaged Docs');
}
async function showDraft() {
  await showCatalog();
  await page.getByRole('button', {name: 'Open repository Workspace', exact: true}).click();
  await page.getByRole('table', {name: 'Directory contents'}).getByRole('button', {name: 'README.md', exact: true}).click();
  await until(async () => {
    const edit = page.getByRole('button', {name: 'Edit this file', exact: true});
    return await edit.isVisible() || await page.locator('.cm-content[contenteditable=true]').count();
  }, 'README reader or retained editor');
  const edit = page.getByRole('button', {name: 'Edit this file', exact: true});
  if (await edit.isVisible()) await edit.click();
  await until(async () => (await page.locator('.cm-content[contenteditable=true]').allTextContents()).join('\n').includes('Retained private draft Ω.'), 'renderer retained private draft');
  assert.ok((await page.locator('.cm-content[contenteditable=true]').allTextContents()).join('\n').includes('Recovery saved fixture'));
}

try {
  admitNativeProfile({ args, testRoot, channel: 'preview', paths: {dataRoot, profileRoot} });
  const stat = fs.lstatSync(dataRoot), volumeId = probeStorageVolume(dataRoot);
  context = {schemaVersion: 1, root: dataRoot, rootInode: String(stat.ino), owner: stat.uid,
    currentDevice: stat.dev, namespaceDevice: stat.dev + 2, volumeId};
  assert.ok(Number.isSafeInteger(context.namespaceDevice));
  const bundledDocs = loadBundledDocs(payload, {packaged: true, metadata});
  seedService = await createNativeService({dataRoot, storageIdentity: context, bundledDocs});
  const seedRequest = (operation, argument = {}) => seedService.request({repo: 'Workspace', operation, args: argument});
  const initial = await seedRequest('open', {path: 'README.md'});
  const saved = await seedRequest('save', {path: initial.path, baseHash: initial.sourceHash, text: savedText});
  await seedRequest('checkpoint', {path: saved.path, baseHash: saved.sourceHash, text: draftText});
  await seedRequest('checkpointNew', newDraft);
  await seedRequest('getCommitPreferences');
  await seedService.setAppearance({themeId: 'dark-dimmed', hideUnavailable: false});
  await seedService.catalog(); await seedService.close(); seedService = null;
  assert.equal(fs.existsSync(markerPath), false);
  assert.equal(fs.existsSync(path.join(workspace, newDraft.path)), false);
  before = inventory(dataRoot); write('legacy-before.json', {context, files: before});
  record('synthetic-legacy-profile-seeded', {simulation: 'persistent device namespace current+2; real raw stat results unchanged',
    savedSha256: sha(savedText), draftSha256: sha(draftText), newDraftSha256: sha(newDraft.text), files: Object.keys(before).length});
  await launch(true);
  const markerBytes = fs.readFileSync(markerPath), marker = JSON.parse(markerBytes);
  assert.equal(marker.checksum, sha(JSON.stringify(marker.body)));
  for (const name of ['root', 'rootInode', 'owner', 'namespaceDevice', 'volumeId']) assert.equal(marker.body[name], context[name]);
  const backupParent = path.join(home, 'asMagicBrain-recovery-backups'), backups = fs.readdirSync(backupParent);
  assert.equal(backups.length, 1); backupPath = path.join(backupParent, backups[0]);
  const backupReceipt = JSON.parse(fs.readFileSync(path.join(backupPath, 'receipt.json')));
  assert.equal(backupReceipt.status, 'verified');
  assert.deepEqual(backupReceipt.files.filter(row => row.type === 'file').map(row => row.path).sort(), Object.keys(before).sort());
  for (const [relative, expected] of Object.entries(before)) {
    assert.equal(sha(fs.readFileSync(path.join(backupPath, 'managed-data', relative))), expected.sha256, 'Backup bytes: ' + relative);
    assert.equal(sha(fs.readFileSync(path.join(dataRoot, relative))), expected.sha256, 'Original record bytes before interaction: ' + relative);
    assert.equal(String(fs.lstatSync(path.join(dataRoot, relative)).ino), expected.inode, 'Original inode: ' + relative);
    assert.equal(fs.lstatSync(path.join(dataRoot, relative)).mode & 0o777, expected.mode, 'Original mode: ' + relative);
  }
  record('recovery-published-marker-with-verified-backup-and-unchanged-old-records', {namespaceDevice: marker.body.namespaceDevice,
    volumeId: marker.body.volumeId, markerSha256: sha(markerBytes), backupPath, backupReceiptSha256: sha(fs.readFileSync(path.join(backupPath, 'receipt.json')))});
  let opened = await request('open', {path: 'README.md'});
  assert.equal(opened.text, savedText); assert.equal(opened.draft.text, draftText);
  assert.deepEqual((await bridge('bootstrap', 'Workspace')).newDrafts, [newDraft]);
  assert.equal((await bridge('getAppearance')).themeId, 'dark-dimmed');
  await showCatalog(); await page.screenshot({path: path.join(output, 'recovered-catalog.png')});
  await showDraft(); await page.screenshot({path: path.join(output, 'recovered-draft.png')});
  record('renderer-catalog-saved-source-private-drafts-and-theme-preserved');
  const created = await request('create', {path: 'after-recovery.md', text: '# Created after recovery\n'});
  await request('save', {path: created.path, baseHash: created.sourceHash, text: createdText});
  assert.equal(fs.readFileSync(path.join(workspace, created.path), 'utf8'), createdText);
  record('packaged-preload-create-and-save-completed');
  await closeNormally();
  await launch(false);
  assert.deepEqual(fs.readFileSync(markerPath), markerBytes);
  assert.deepEqual(fs.readdirSync(backupParent), backups);
  opened = await request('open', {path: 'README.md'});
  assert.equal(opened.text, savedText); assert.equal(opened.draft.text, draftText);
  assert.deepEqual((await bridge('bootstrap', 'Workspace')).newDrafts, [newDraft]);
  assert.equal((await request('open', {path: 'after-recovery.md'})).text, createdText);
  assert.equal((await bridge('getAppearance')).themeId, 'dark-dimmed');
  await showDraft(); await page.screenshot({path: path.join(output, 'restart-retained-draft.png')});
  record('unattended-restart-retains-marker-backup-count-saved-files-and-drafts');
  await closeNormally();
  assert.equal(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8'), savedText);
  assert.equal(fs.existsSync(path.join(workspace, newDraft.path)), false);
  assert.deepEqual(rendererErrors, []); assert.deepEqual(consoleErrors, []);
} catch (error) {
  failure = {message: error.message, stack: error.stack}; process.exitCode = 1;
  try {if (page) await page.screenshot({path: path.join(output, 'failure.png')});} catch {}
  try {if (page && child && !exitResult) await closeNormally();} catch (closeError) {failure.close = closeError.message;}
  console.error(error.stack);
} finally {
  try {await seedService?.close();} catch (error) {failure ??= {message: error.message}; process.exitCode = 1;}
  const receipt = {schemaVersion: 1, status: failure ? 'failed' : 'passed', platform: process.platform, architecture: process.arch, fixtureNode: process.version,
    scope: 'Synthetic legacy device namespace, real packaged recovery confirmation/backup, renderer preservation, preload Save/Create and normal restart; no physical reboot or Tuxera simulation.',
    executable, metadata, packageMetadataSha256: sha(metadataBytes), packageManifestPath: manifestPath,
    packageManifestSha256: sha(manifestBytes), packagedModuleHashes: moduleHashes,
    output, dataRoot, backupPath, context, events, rendererErrors, consoleErrors, failure,
    remainingProcess: child && !exitResult ? {pid: child.pid, reason: 'Retained for operator-directed normal close; never force-killed'} : null};
  write('receipt.json', receipt);
  console.log(JSON.stringify({status: receipt.status, output, receipt: path.join(output, 'receipt.json')}));
}
