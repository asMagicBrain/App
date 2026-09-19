import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
/** Packaged local-foundation acceptance. Only disposable Test data; no live profile migration. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const testRoot = developmentTestRoot;
const runRoot = path.join(testRoot, 'runs/native-local-foundation-20260917');
const executable = process.env.ASMB_PACKAGED_EXECUTABLE;
const previousExecutable = process.env.ASMB_PREVIOUS_EXECUTABLE ?? path.join(appRoot, 'releases/0.1.0-preview.8/asMagicBrain.app/Contents/MacOS/asMagicBrain');
assert.deepEqual(process.argv.slice(2), ['--run-isolated'], 'Pass --run-isolated explicitly.');
for (const candidate of [executable, previousExecutable]) {
  assert.ok(candidate && path.isAbsolute(candidate) && candidate.includes('.app/Contents/MacOS/'), 'Supply a packaged executable.');
  assert.ok([appRoot + 'releases/', testRoot + '/runs/native-package/'].some(prefix => candidate.startsWith(prefix)), 'Use a release or isolated package candidate.');
}
const bundle = executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
const metadata = JSON.parse(await fs.readFile(bundle + '/Contents/Resources/app/native-package.json', 'utf8'));
import {_electron} from '../../../tools/playwright.mjs';
await fs.mkdir(runRoot, {recursive: true});
const output = await fs.mkdtemp(runRoot + '/acceptance-'), data = output + '/data', tmp = output + '/tmp';
await fs.mkdir(tmp);
const repo = 'Local-Foundation-QA', workspace = data + '/workspaces/asMagicBrain/' + repo;
const oldWorkspace = data + '/workspaces/asMagicBrain/Workspace';
const events = [], errors = [], consoleErrors = [], issues = [];
let application, page, failure, permissionsToRestore = [], activeExecutable;
const record = (name, details = {}) => events.push({name, at: new Date().toISOString(), ...details});
const button = name => page.getByRole('button', {name, exact: true});
const exists = async filename => Boolean(await fs.lstat(filename).catch(() => null));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('/usr/bin/git', ['-C', workspace, ...args], {encoding: 'utf8', env: {PATH: '/usr/bin:/bin', TMPDIR: tmp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0'}}).trim();
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout; let result;
  do {try {result = await check(); if (result) return result;} catch (error) {result = error.message;} await new Promise(resolve => setTimeout(resolve, 50));} while (Date.now() < end);
  throw Error(`Timeout ${label}: ${result}`);
}
async function launch(target = executable, {home} = {}) {
  activeExecutable = target;
  application = await _electron.launch({executablePath: target, args: [home ? '--test-user-home=' + home : '--test-data-root=' + data], cwd: output, env: {PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmp}});
  page = await application.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') consoleErrors.push(message.text());});
  await button(/^Switch local repository:/).waitFor();
  await page.context().setOffline(true);
  const runtime = await application.evaluate(({app}) => ({packaged: app.isPackaged, exe: process.execPath, cwd: process.cwd(), profile: app.getPath('userData'), version: app.getVersion()}));
  assert.equal(runtime.packaged, true); assert.equal(runtime.exe, target); assert.equal(runtime.cwd, output); assert.equal(runtime.profile, home ? home + '/Library/Application Support/asMagicBrain' : data + '-electron-profile');
  record('actual-packaged-launch-offline', {runtime, policy: home ? 'isolated installed-user path policy' : 'development Test profile', home: home ?? null});
}
async function close() {
  const closed = application.waitForEvent('close', {timeout: 20000});
  await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].close()).catch(error => {if (!/closed|destroyed/i.test(String(error))) throw error;});
  await closed; record('normal-native-close', {executable: activeExecutable}); application = null;
}
async function screenshot(name) {
  await page.screenshot({path: output + '/' + name + '.png'}); record('screenshot', {file: name + '.png'});
  if (await page.locator('.nr-dialog').isVisible()) {
    const areas = await page.evaluate(() => {
      const rect = selector => {const element = document.querySelector(selector), r = element?.getBoundingClientRect(); return r ? {x: r.x, y: r.y, width: r.width, height: r.height} : null;};
      return [['NR1 title', '.nr-dialog header'], ['NR2 organization / name', '.nr-dialog .zi-destination'], ['NR3 validation', '#nr-name-error, #nr-name-help'], ['NR4 actions', '.nr-dialog footer']].map(([name, selector]) => ({name, ...rect(selector)}));
    });
    await fs.writeFile(output + '/' + name + '-bounds.json', JSON.stringify(areas, null, 2));
    await page.evaluate(areas => {
      const layer = document.createElement('div'); layer.id = 'foundation-qa-overlay'; layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
      areas.forEach((area, index) => {
        const color = ['#ffa54b', '#54a9ff', '#ae84ff', '#3bd6a4'][index], box = document.createElement('div');
        box.style.cssText = `position:fixed;box-sizing:border-box;left:${area.x}px;top:${area.y}px;width:${area.width}px;height:${area.height}px;border:2px solid ${color};background:${color}22`;
        const badge = document.createElement('span'); badge.textContent = area.name; badge.style.cssText = `position:absolute;top:-18px;left:0;background:#161b22;color:${color};font:700 11px system-ui;padding:2px 4px;white-space:nowrap`; box.append(badge); layer.append(box);
      });
      document.querySelector('.nr-dialog').append(layer);
    }, areas);
    try {await page.screenshot({path: output + '/' + name + '-overlay.png'}); record('temporary-DOM-area-overlay', {raw: name + '.png', overlay: name + '-overlay.png', bounds: name + '-bounds.json'});}
    finally {await page.evaluate(() => document.getElementById('foundation-qa-overlay')?.remove());}
  }
}
async function leaveIfPrompted() {const leave = button('Leave editor'); if (await leave.isVisible()) await leave.click();}
async function select(name) {
  await button(/^Switch local repository:/).click();
  await page.locator('.rh-list').getByRole('button', {name: new RegExp('\\b' + name + '\\b')}).click();
  await leaveIfPrompted(); await until(() => page.locator('.rc-identity h1').innerText().then(text => text === name), 'selected repository ' + name);
}
async function openReadme() {await button('README.md').first().click(); await until(() => button('Edit this file').isEnabled(), 'README reader ready');}
async function edit() {await until(async () => await button('Edit this file').isVisible() || await page.locator('.cm-content[contenteditable=true]').isVisible(), 'reader or retained editor ready'); if (await button('Edit this file').isVisible()) await button('Edit this file').click(); await page.locator('.cm-content[contenteditable=true]').waitFor();}
async function append(text) {const cm = page.locator('.cm-content[contenteditable=true]'); await cm.click(); await cm.press('Meta+ArrowDown'); await page.keyboard.insertText(text);}
async function mode(enabled) {const toggle = page.getByRole('switch', {name: 'Hide unavailable functions'}); if ((await toggle.getAttribute('aria-checked') === 'true') !== enabled) await toggle.click();}
async function theme(label) {await button('asMagicBrain Theme').click(); await page.locator('.fw-theme-picker select').selectOption({label}); await page.locator('.fw-theme-picker').getByRole('button', {name: 'Done', exact: true}).click();}
async function openCreate() {
  await button('Create new options').click(); await button('New repository').click(); await until(async () => await page.locator('.nr-dialog').isVisible() || await button('Leave editor').isVisible(), 'creation or leave confirmation'); await leaveIfPrompted();
  await page.locator('.nr-dialog').waitFor(); await page.getByLabel('Repository name', {exact: true}).waitFor();
}
async function action(entry, label) {await button(entry === null ? 'Repository file actions' : 'More actions for ' + entry).click(); await page.getByRole('menuitem', {name: label, exact: true}).click();}
async function newFile(filename, text) {
  await action(null, 'New Markdown file'); await page.getByLabel('File path', {exact: true}).fill(filename); await append(text);
  await button('Save').press('Enter'); await until(() => exists(workspace + '/' + filename), 'saved ' + filename); await until(() => button('Save').isEnabled(), 'save settled');
}
async function openFile(filename) {await action(filename, 'Open'); await edit();}
async function dialogWithinViewport(name) {
  const bounds = await page.locator('.nr-dialog').evaluate(element => {const r = element.getBoundingClientRect(); return {x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight};});
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.right <= bounds.width + 1 && bounds.bottom <= bounds.height + 1, JSON.stringify(bounds));
  record('dialog-contained-in-viewport', {name, bounds}); await screenshot(name);
}
async function nativeMessages() {return application.evaluate(() => globalThis.__foundationDialogs ?? []);}
async function observeRecoveryDialogs() {
  await application.evaluate(({dialog}) => {
    globalThis.__foundationDialogs = [];
    const original = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      if (options.title === 'Work is still open') {globalThis.__foundationDialogs.push(options); return {response: 0, checkboxChecked: false};}
      return original(...args);
    };
  });
}
async function requestHeldClose(message) {
  const before = (await nativeMessages()).length;
  await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].close());
  await until(async () => (await nativeMessages()).length > before, 'close failure reported');
  const notice = (await nativeMessages()).at(-1);
  assert.match(notice.detail, message);
  assert.equal(await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).length), 1);
  record('failed-close-retains-window', {notice, dialogHandling: 'Main-process dialog intercepted at presentation boundary; Keep editing response automatically supplied by harness.'});
}

try {
  // An actual previous release creates the profile. The new version must preserve it in place.
  await launch(previousExecutable); await openReadme(); await edit();
  const beforeUpgrade = await fs.readFile(oldWorkspace + '/README.md');
  const upgradeMarker = '\nPrivate draft survives preview.8 update Ω.\n';
  await append(upgradeMarker); await theme('GitHub Dark Default'); await mode(true);
  await button('Account menu').click(); await page.getByRole('menuitem', {name: 'Settings', exact: true}).click();
  await page.getByRole('radio', {name: /asMagicBrain profile/}).check();
  await page.getByLabel('Author name', {exact: true}).fill('Local Foundation QA'); await page.getByLabel('Author email', {exact: true}).fill('foundation@example.invalid');
  await button('Save settings').click(); await page.locator('.ac-settings').waitFor({state: 'detached'}); await close();
  await launch(); await select('Workspace'); await openReadme(); await edit();
  assert.match(await page.locator('.cm-content').innerText(), /Private draft survives preview\.8 update Ω/);
  assert.deepEqual(await fs.readFile(oldWorkspace + '/README.md'), beforeUpgrade);
  assert.equal(await page.getByRole('switch', {name: 'Hide unavailable functions'}).getAttribute('aria-checked'), 'true');
  await button('asMagicBrain Theme').click(); assert.equal(await page.locator('.fw-theme-picker select').locator('option:checked').innerText(), 'GitHub Dark Default');
  await page.locator('.fw-theme-picker').getByRole('button', {name: 'Done', exact: true}).click();
  record('preview8-update-preserves-bytes-draft-appearance', {savedSha256: sha(beforeUpgrade)});

  await openCreate();
  try {await until(() => page.getByLabel('Repository name', {exact: true}).evaluate(element => document.activeElement === element), 'repository name receives initial keyboard focus', 2000);}
  catch (error) {const active = await page.evaluate(() => ({tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), text: document.activeElement?.textContent})); issues.push({check: 'initial-dialog-focus', active, message: error.message}); record('initial-dialog-focus-failed', {active});}
  await page.getByLabel('Repository name', {exact: true}).fill('Cancelled-QA'); await dialogWithinViewport('01-new-repository-dark');
  await page.keyboard.press('Escape'); await page.locator('.nr-dialog').waitFor({state: 'detached'}); await until(() => button('Create new options').evaluate(element => element === document.activeElement), 'Cancel restores Create options focus'); assert.equal(await exists(data + '/workspaces/asMagicBrain/Cancelled-QA'), false);
  record('new-repository-cancel-does-not-publish');
  await openCreate(); const form = page.locator('.nr-dialog');
  await page.getByLabel('Repository name', {exact: true}).fill('../escape'); await form.getByRole('button', {name: 'Create repository', exact: true}).click(); await page.locator('#nr-name-error').waitFor(); assert.equal(await exists(data + '/workspaces/escape'), false);
  await page.getByLabel('Repository name', {exact: true}).fill('Workspace'); await form.getByRole('button', {name: 'Create repository', exact: true}).click(); assert.match(await page.locator('#nr-name-error').innerText(), /already exists/); assert.deepEqual(await fs.readFile(oldWorkspace + '/README.md'), beforeUpgrade);
  await screenshot('02-invalid-or-colliding-name');
  const occupied = data + '/workspaces/asMagicBrain/Occupied-QA'; await fs.mkdir(occupied); await fs.writeFile(occupied + '/keep.txt', 'Unregistered folder stays intact.\n');
  await page.getByLabel('Repository name', {exact: true}).fill('Occupied-QA'); await form.getByRole('button', {name: 'Create repository', exact: true}).click();
  await form.getByRole('alert').filter({hasText: 'already exists'}).waitFor(); assert.equal(await fs.readFile(occupied + '/keep.txt', 'utf8'), 'Unregistered folder stays intact.\n');
  record('unregistered-folder-collision-reports-inline-and-preserves-bytes');
  await form.getByRole('button', {name: 'Cancel', exact: true}).click();
  await mode(false); await theme('GitHub Light Default');
  await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(390, 760));
  await openCreate(); await dialogWithinViewport('03-new-repository-narrow'); await form.getByRole('button', {name: 'Cancel', exact: true}).click();
  await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
  await openCreate(); await page.getByLabel('Repository name', {exact: true}).fill(repo);
  await form.getByRole('button', {name: 'Create repository', exact: true}).focus(); await page.keyboard.press('Enter');
  await form.waitFor({state: 'detached'}); await page.locator('.rfe-directory-empty').waitFor();
  assert.deepEqual((await fs.readdir(workspace)).sort(), ['.git']); assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main'); assert.equal(git('remote'), '');
  assert.equal(git('status', '--porcelain'), ''); assert.equal(await page.locator('.rfe-sidebar-header strong').innerText(), repo);
  await screenshot('04-empty-local-repository'); record('new-empty-repository-keyboard-create', {repository: repo, remote: null});

  await newFile('first.md', '# First local document\n\n');
  assert.equal(await fs.readFile(workspace + '/first.md', 'utf8'), '# First local document\n\n');
  // Chromium's native composition path exercises CM6 composition guards without claiming OS candidate-window qualification.
  await observeRecoveryDialogs(); const cdp = await page.context().newCDPSession(page);
  const editor = page.locator('.cm-content[contenteditable=true]'); await editor.click(); await editor.press('Meta+ArrowDown');
  await cdp.send('Input.imeSetComposition', {text: '世界', selectionStart: 2, selectionEnd: 2});
  await until(() => editor.innerText().then(text => text.includes('世界')), 'composition text rendered');
  await requestHeldClose(/composition/i);
  await cdp.send('Input.insertText', {text: '世界'}); await append(' café 👩🏽‍💻\n');
  await button('Save').press('Enter'); await until(async () => (await fs.readFile(workspace + '/first.md', 'utf8')).includes('世界 café 👩🏽‍💻'), 'composition saved');
  const firstSource = await fs.readFile(workspace + '/first.md', 'utf8'); assert.equal((firstSource.match(/世界/g) ?? []).length, 1);
  record('native-chromium-composition-guard-and-unicode-save', {sourceSha256: sha(firstSource), qualification: 'CDP Input.imeSetComposition + Input.insertText through actual Chromium; real OS IME candidate selection remains unqualified.'});

  await newFile('unselected.md', '# Saved outside the selected commit\n');
  await openFile('first.md'); await append('Private draft excluded from first commit.');
  await openFile('unselected.md'); await button('Commit changes…').click();
  const commit = page.locator('.rfe-commit-dialog[open]');
  await commit.getByLabel('Commit message', {exact: true}).fill('First selected local commit');
  assert.equal(await commit.getByLabel('Local author name', {exact: true}).inputValue(), 'Local Foundation QA');
  assert.equal(await commit.getByLabel('Local author email', {exact: true}).inputValue(), 'foundation@example.invalid');
  for (const item of await commit.locator('.rfe-change-selection label').all()) await item.locator('input').setChecked((await item.locator('span').innerText()).startsWith('first.md '));
  await commit.getByRole('button', {name: 'Refresh review', exact: true}).click();
  await until(() => commit.getByRole('button', {name: 'Commit changes', exact: true}).isEnabled(), 'selected initial commit reviewed'); await screenshot('05-first-selected-commit');
  await commit.getByRole('button', {name: 'Commit changes', exact: true}).click(); await commit.waitFor({state: 'hidden'});
  const head = git('rev-parse', 'HEAD'); assert.equal(git('ls-tree', '-r', '--name-only', head), 'first.md'); assert.equal(git('show', head + ':first.md'), firstSource.trimEnd());
  assert.equal(git('show', '-s', '--format=%an <%ae>', head), 'Local Foundation QA <foundation@example.invalid>'); assert.equal(git('remote'), '');
  record('first-selected-local-commit-excludes-unselected-and-private-draft', {head, selected: ['first.md'], sourceSha256: sha(firstSource)});

  // Permission loss of this synthetic repository's private record directory must not discard the editor or rewrite source.
  await openFile('first.md'); assert.match(await editor.innerText(), /Private draft excluded/);
  const stateDirs = [];
  async function findRecords(directory) {for (const entry of await fs.readdir(directory, {withFileTypes: true})) {const full = path.join(directory, entry.name); if (!entry.isDirectory()) continue; if (entry.name === 'records') {for (const file of await fs.readdir(full)) {if (!file.endsWith('.json')) continue; const content = await fs.readFile(path.join(full, file), 'utf8'); if (content.includes(repo)) {stateDirs.push(full); break;}}} else await findRecords(full);}}
  await findRecords(data + '/state'); assert.equal(stateDirs.length, 1, 'Find this repository runtime records only');
  const privateRecords = stateDirs[0]; const originalMode = (await fs.stat(privateRecords)).mode & 0o777;
  permissionsToRestore.push({path: privateRecords, mode: originalMode}); await fs.chmod(privateRecords, 0o500);
  await append(' Retry after storage permission loss.'); await page.getByRole('alert').filter({hasText: 'Draft could not be retained'}).waitFor();
  await requestHeldClose(/RECOVERY_REQUIRED|DENIED|retained|preserv/i); assert.equal(await fs.readFile(workspace + '/first.md', 'utf8'), firstSource);
  await screenshot('06-storage-failure-keeps-work-open');
  await fs.chmod(privateRecords, originalMode); permissionsToRestore = [];
  await close(); await launch(); await select(repo); await button('first.md').first().click(); await edit();
  assert.match(await page.locator('.cm-content[contenteditable=true]').innerText(), /Private draft excluded from first commit/); assert.match(await page.locator('.cm-content[contenteditable=true]').innerText(), /Retry after storage permission loss/);
  assert.equal(await fs.readFile(workspace + '/first.md', 'utf8'), firstSource); assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(await exists(workspace + '/unselected.md'), true); await screenshot('07-restarted-recovered-draft');
  record('storage-permission-restoration-close-retry-and-restart-preserve-draft', {privateRecords, sourceSha256: sha(firstSource), head});
  await close();

  // The installed-root policy runs only against a fake home under Test. No actual user-home directory is touched.
  const fakeHome = output + '/fake-home', homeData = fakeHome + '/asMagicBrain';
  await fs.mkdir(fakeHome); await fs.writeFile(fakeHome + '/personal-marker.txt', 'Existing home contents stay intact.\n');
  await launch(executable, {home: fakeHome});
  const firstRunReadme = await fs.readFile(homeData + '/workspaces/asMagicBrain/Workspace/README.md');
  assert.match(firstRunReadme.toString(), /^# Workspace/); assert.equal(await exists(homeData + '/state'), true);
  await openCreate(); await page.getByLabel('Repository name', {exact: true}).fill('Home-QA');
  await page.locator('.nr-dialog').getByRole('button', {name: 'Create repository', exact: true}).click(); await page.locator('.nr-dialog').waitFor({state: 'detached'});
  await action(null, 'New Markdown file'); await page.getByLabel('File path', {exact: true}).fill('home.md'); await append('# Home root policy\n');
  await button('Save').press('Enter'); const homeFile = homeData + '/workspaces/asMagicBrain/Home-QA/home.md'; await until(() => exists(homeFile), 'home policy file saved');
  await until(() => button('Save').isEnabled(), 'home save settled'); await append('Private draft in user policy.');
  await screenshot('08-isolated-user-home-first-run'); await close();
  await launch(executable, {home: fakeHome}); await select('Home-QA'); await button('home.md').first().click(); await edit();
  assert.match(await page.locator('.cm-content').innerText(), /Private draft in user policy/); assert.equal(await fs.readFile(homeFile, 'utf8'), '# Home root policy\n');
  assert.deepEqual(await fs.readFile(homeData + '/workspaces/asMagicBrain/Workspace/README.md'), firstRunReadme);
  assert.equal(await fs.readFile(fakeHome + '/personal-marker.txt', 'utf8'), 'Existing home contents stay intact.\n');
  assert.equal(await fs.readFile(workspace + '/first.md', 'utf8'), firstSource); assert.equal(git('rev-parse', 'HEAD'), head);
  await screenshot('09-isolated-user-home-restart');
  record('installed-user-path-policy-first-run-restart-preservation', {fakeHome, dataRoot: homeData, profileRoot: fakeHome + '/Library/Application Support/asMagicBrain', initialWorkspaceSha256: sha(firstRunReadme), sourceSha256: sha(await fs.readFile(homeFile)), actualUserHomeTouched: false});
  assert.equal(errors.length, 0); assert.equal(consoleErrors.length, 0); assert.deepEqual(issues, []); await close();
} catch (error) {
  failure = {message: error.message, stack: error.stack}; console.error(error.stack);
  try {await screenshot('failure'); await fs.writeFile(output + '/failure-dom.txt', await page.locator('body').innerText());} catch {}
  for (const entry of permissionsToRestore) await fs.chmod(entry.path, entry.mode).catch(() => {});
  if (application) try {await close();} catch {try {await application.close();} catch {}}
  process.exitCode = 1;
} finally {
  await fs.writeFile(output + '/receipt.json', JSON.stringify({status: failure ? 'failed' : 'passed', failure, executable, previousExecutable, metadata, data, events, errors, consoleErrors, issues, definitionSha256: sha(await fs.readFile(fileURLToPath(import.meta.url)))}, null, 2));
  console.log(JSON.stringify({status: failure ? 'failed' : 'passed', output}));
}
