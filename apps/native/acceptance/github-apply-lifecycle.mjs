import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
/** Actual packaged apply lifecycle in an isolated profile. Acceptance-only
 * worker startup delay makes close/renderer-loss ordering deterministic. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const testRoot = developmentTestRoot;
const runRoot = path.join(testRoot, 'runs/native-github-apply-20260917/review');
const executable = process.env.ASMB_PACKAGED_EXECUTABLE;
assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
assert.ok(executable && path.isAbsolute(executable) && executable.includes('.app/Contents/MacOS/') && (executable.startsWith(appRoot + 'releases/') || executable.startsWith(testRoot + '/runs/')));
const bundle = executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
const metadata = JSON.parse(await fs.readFile(bundle + '/Contents/Resources/app/native-package.json', 'utf8'));
import {_electron, chromium} from '../../../tools/playwright.mjs';
await fs.mkdir(runRoot, {recursive: true});
const output = await fs.mkdtemp(runRoot + '/lifecycle-'), data = output + '/data', tmp = output + '/tmp';
await fs.mkdir(tmp);
const repo = 'Apply-Lifecycle-QA', repository = data + '/workspaces/asMagicBrain/' + repo;
const sourceUrl = 'https://github.com/ancorasir/asTeach-App';
const marker = '\nUnrelated Workspace private draft survives GitHub apply Ω.\n';
const events = [], errors = [];
let application, page, failure, reconnected, targetHead, targetContent, targetReadme, ancestor, originalWorkspace, originalOrigin;
const record = (name, details = {}) => {events.push({name, at: new Date().toISOString(), ...details}); console.log(name);};
const button = name => page.getByRole('button', {name, exact: true});
const git = (...args) => execFileSync('/usr/bin/git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repository, ...args], {encoding: 'utf8', env: {PATH: '/usr/bin:/bin', TMPDIR: tmp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0'}}).trim();
async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout; let last;
  do {try {last = await check(); if (last) return last;} catch (error) {last = error.message;} await new Promise(resolve => setTimeout(resolve, 60));} while (Date.now() < deadline);
  throw Error(`Timeout ${label}: ${last}`);
}
async function native(method, args) {
  const reply = await page.evaluate(async ({method, args}) => window.asMagicBrain[method](args), {method, args});
  if (!reply?.ok) throw Object.assign(new Error(reply?.error?.message ?? 'Native reply failed'), {code: reply?.error?.code});
  return reply.value;
}
async function content(root) {
  const values = Object.create(null);
  async function walk(relative = '') {
    for (const entry of await fs.readdir(path.join(root, relative), {withFileTypes: true})) {
      if (!relative && entry.name === '.git') continue;
      const name = path.posix.join(relative, entry.name), filename = path.join(root, name);
      if (entry.isDirectory()) await walk(name);
      else {assert.ok(entry.isFile()); const stat = await fs.stat(filename); values[name] = {hash: createHash('sha256').update(await fs.readFile(filename)).digest('hex'), mode: stat.mode & 0o777};}
    }
  }
  await walk(); return values;
}
async function launch() {
  application = await _electron.launch({executablePath: executable, args: ['--test-data-root=' + data], cwd: output, env: {PATH: process.env.PATH, TMPDIR: tmp}});
  page = await application.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await button(/^Switch local repository:/).waitFor();
  const runtime = await application.evaluate(({app}) => ({packaged: app.isPackaged, executable: process.execPath, profile: app.getPath('userData')}));
  assert.equal(runtime.packaged, true); assert.equal(runtime.executable, executable); assert.equal(runtime.profile, data + '-electron-profile');
  record('actual-packaged-launch', {runtime});
}
async function openReadme(name) {
  await button(/^Switch local repository:/).click();
  await page.locator('.rh-list').getByRole('button', {name: new RegExp('\\b' + name + '\\b')}).click();
  await until(async () => await button('Leave editor').isVisible() || await page.locator('.rc-identity h1').innerText().then(text => text === name), 'repository selection');
  if (await button('Leave editor').isVisible()) await button('Leave editor').click();
  await until(() => page.locator('.rc-identity h1').innerText().then(text => text === name), 'selected repository');
  await button('README.md').first().click();
  await until(async () => await button('Edit this file').isVisible() || await page.locator('.cm-content[contenteditable=true]').isVisible(), 'README view');
}
async function openUpdates() {
  if (!await button('Repository file actions').isVisible()) await button('Toggle file sidebar').click();
  await button('Repository file actions').click(); await page.getByRole('menuitem', {name: 'Check GitHub updates…', exact: true}).click();
  await until(() => button('Check for updates').isEnabled(), 'update check ready');
  await button('Check for updates').click();
  await until(() => page.locator('.ru-result h3').first().innerText().then(text => /incoming commit/.test(text)), 'remote comparison', 180000);
  const result = (await native('getRepositoryUpdates', {repo})).lastCheck;
  assert.equal(result.localHead, ancestor); assert.equal(result.remoteHead, targetHead); assert.equal(result.relation, 'remote-ahead');
  return result;
}
async function workspaceDraft() {
  const value = await native('request', {repo: 'Workspace', operation: 'open', args: {path: 'README.md'}});
  assert.ok(value.draft?.text.includes(marker.trim()));
  assert.deepEqual(await fs.readFile(data + '/workspaces/asMagicBrain/Workspace/README.md'), originalWorkspace);
}
async function close() {
  const start = Date.now(), closed = application.waitForEvent('close', {timeout: 20000});
  await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].close()).catch(error => {if (!/closed|destroyed/i.test(String(error))) throw error;});
  await closed; application = null; record('normal-native-close', {milliseconds: Date.now() - start});
}
const exited = pid => {try {process.kill(pid, 0); return false;} catch (error) {if (error.code === 'ESRCH') return true; throw error;}};

async function instrument() {
  await application.evaluate(({dialog}) => {
    const cp = process.getBuiltinModule('node:child_process'), mod = process.getBuiltinModule('node:module'), original = cp.spawn;
    globalThis.__applyLifecycle = {delayNext: false, calls: [], dialogs: []};
    cp.spawn = (file, args, options) => {
      if (!globalThis.__applyLifecycle.delayNext || file !== process.execPath || !Array.isArray(args) || args.length !== 1 || !args[0].endsWith('/github-apply-worker.mjs')) return original(file, args, options);
      globalThis.__applyLifecycle.delayNext = false;
      const code = 'await new Promise(resolve=>setTimeout(resolve,2000)); await import(' + JSON.stringify(process.getBuiltinModule('node:url').pathToFileURL(args[0]).href) + ');';
      const child = original(file, ['--input-type=module', '-e', code], options);
      const entry = {pid: child.pid, started: Date.now(), delayMs: 2000, closed: false}; globalThis.__applyLifecycle.calls.push(entry);
      child.once('close', (code, signal) => Object.assign(entry, {closed: true, code, signal, closedAt: Date.now()}));
      return child;
    };
    mod.syncBuiltinESMExports();
    const show = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      if (options.title === 'The editor stopped') {globalThis.__applyLifecycle.dialogs.push({title: options.title, at: Date.now(), calls: globalThis.__applyLifecycle.calls.map(value => ({...value}))}); return {response: 0, checkboxChecked: false};}
      return show(...args);
    };
  });
  record('acceptance-only-worker-startup-delay', {scope: 'Debugger delays one owned filesystem child by two seconds, then imports the unchanged packaged worker with its actual stdin/cwd/fd3. No mutation logic or signed file is replaced. Renderer recovery selects Reopen editor at the dialog boundary.'});
}
async function beginApply() {
  await button('Review update…').click(); await until(() => button('Apply update').isEnabled(), 'reviewed clean update');
  const count = await application.evaluate(() => {globalThis.__applyLifecycle.delayNext = true; return globalThis.__applyLifecycle.calls.length;});
  await button('Apply update').click();
  await until(() => application.evaluate((_, count) => globalThis.__applyLifecycle.calls.length > count, count), 'admitted publication child');
  const child = await application.evaluate(() => globalThis.__applyLifecycle.calls.at(-1));
  assert.equal(child.closed, false); return child;
}
async function assertApplied() {
  assert.equal(git('rev-parse', 'HEAD'), targetHead); assert.equal(git('status', '--porcelain=v1'), '');
  assert.equal(git('remote', 'get-url', 'origin'), originalOrigin); assert.deepEqual(await content(repository), targetContent);
  assert.deepEqual(await fs.readFile(repository + '/README.md'), targetReadme);
}

try {
  await launch(); originalWorkspace = await fs.readFile(data + '/workspaces/asMagicBrain/Workspace/README.md');
  await openReadme('Workspace'); await button('Edit this file').click();
  const editor = page.locator('.cm-content[contenteditable=true]'); await editor.click(); await editor.press('Meta+ArrowDown'); await page.keyboard.insertText(marker);
  await until(async () => (await native('request', {repo: 'Workspace', operation: 'runtimeStatus', args: {}})).draftCount === 1, 'acknowledged unrelated draft');
  await native('cloneRepository', {name: repo, url: sourceUrl, requestId: randomUUID(), useAccount: false});
  targetHead = git('rev-parse', 'HEAD'); targetContent = await content(repository); targetReadme = await fs.readFile(repository + '/README.md'); ancestor = git('rev-parse', 'HEAD^'); originalOrigin = git('remote', 'get-url', 'origin');
  await workspaceDraft(); await close();
  git('reset', '--hard', ancestor); const beforeApply = await content(repository);
  record('isolated-public-incoming-fixture', {targetHead, ancestor, remoteWrites: false});

  await launch(); await openReadme(repo); const comparison = await openUpdates();
  const reviewed = await native('reviewRepositoryUpdate', {repo, checkId: comparison.checkId}); assert.equal(reviewed.canApply, true);
  const oldReadme = await fs.readFile(repository + '/README.md'), outsideText = Buffer.from('Local edit after review must not be overwritten.\n');
  await fs.writeFile(repository + '/README.md', outsideText);
  await assert.rejects(native('applyRepositoryUpdate', {repo, checkId: comparison.checkId, reviewId: reviewed.reviewId, requestId: randomUUID()}), error => ['APPLY_SAVED_CHANGES', 'APPLY_STALE'].includes(error.code));
  assert.deepEqual(await fs.readFile(repository + '/README.md'), outsideText); assert.equal(git('rev-parse', 'HEAD'), ancestor);
  await fs.writeFile(repository + '/README.md', oldReadme); assert.deepEqual(await content(repository), beforeApply); await workspaceDraft();
  record('stale-apply-refuses-and-preserves-new-local-bytes', {scope: 'Only the disposable local fixture was edited/restored after native review; the stale apply used actual native IPC.'});

  await instrument(); const closing = await beginApply(), closeStarted = Date.now();
  await close(); assert.equal(exited(closing.pid), true); assert.ok(Date.now() - closeStarted >= 1000, 'Native close waited for the delayed admitted apply.'); await assertApplied();
  record('close-drains-admitted-publication-before-exit', {pid: closing.pid, milliseconds: Date.now() - closeStarted});
  await launch(); await openReadme(repo); await assertApplied(); await workspaceDraft();
  record('restart-opens-updated-bytes-and-preserves-unrelated-draft'); await page.screenshot({path: output + '/after-close-restart.png'}); await close();

  git('reset', '--hard', ancestor);
  await launch(); await openReadme(repo); await openUpdates(); await instrument();
  const crashing = await beginApply(), started = Date.now(), oldRenderer = await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.getOSProcessId());
  await application.evaluate(({BrowserWindow}) => {setTimeout(() => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(), 0);});
  await until(() => application.evaluate(() => globalThis.__applyLifecycle.dialogs.length === 1), 'renderer recovery after apply drain');
  const observed = await application.evaluate(() => globalThis.__applyLifecycle.dialogs[0]);
  assert.equal(observed.calls[0].closed, true); assert.equal(observed.calls[0].code, 0); assert.ok(observed.at >= observed.calls[0].closedAt);
  await until(() => application.evaluate(({BrowserWindow}, oldRenderer) => {const wc = BrowserWindow.getAllWindows()[0].webContents; return !wc.isLoading() && wc.getOSProcessId() > 0 && wc.getOSProcessId() !== oldRenderer;}, oldRenderer), 'recovered renderer');
  const port = (await fs.readFile(data + '-electron-profile/session/DevToolsActivePort', 'utf8')).split('\n')[0];
  reconnected = await chromium.connectOverCDP('http://127.0.0.1:' + port); page = reconnected.contexts()[0].pages().find(value => value.url() === 'app://asmagicbrain/index.html'); assert.ok(page);
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message)); await button(/^Switch local repository:/).waitFor();
  assert.equal(exited(crashing.pid), true); await openReadme(repo); await assertApplied(); await workspaceDraft();
  record('renderer-crash-drains-apply-before-reopen', {milliseconds: Date.now() - started, pid: crashing.pid, recoveryDialog: observed});
  record('renderer-recovery-opens-updated-bytes-and-preserves-unrelated-draft'); await page.screenshot({path: output + '/after-renderer-recovery.png'});
  await close(); assert.deepEqual(errors, []);
} catch (error) {
  failure = error; record('failure', {message: error.message, stack: error.stack}); if (page) await page.screenshot({path: output + '/failure.png'}).catch(() => {});
} finally {
  if (application) await application.close().catch(() => {}); if (reconnected) await reconnected.close().catch(() => {});
  await fs.writeFile(output + '/receipt.json', JSON.stringify({passed: !failure, metadata, executable, data, events, errors, definitionSha256: createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex'), qualification: 'Actual packaged UI/preload/main/coordinator/host apply, real anonymous public clone/check and actual filesystem/Git publication. Only child startup timing and the renderer-recovery dialog choice are debugger-controlled. Local ancestor reset and stale-file edit are confined to the disposable Test clone; no remote writes, live profile, credentials, arbitrary power-loss guarantee or new-platform claim.'}, null, 2) + '\n');
  console.log(output);
}
if (failure) throw failure;
