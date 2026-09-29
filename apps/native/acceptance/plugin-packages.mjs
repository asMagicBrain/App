/** Exact packaged Stage 4.5C/D plugin lifecycle acceptance.
 * The native file dialog alone is redirected to a test-owned package. Package
 * inspection, installation, persistence, enablement and removal remain real. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {assertPackageIdentity} from './package-identity.mjs';
import {testRoot as testBase} from '../../../tools/development-paths.mjs';

assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
assert.ok(process.env.ASMB_PACKAGED_EXECUTABLE, 'Bind acceptance to an exact package.');
process.env.ASMB_ACCEPTANCE_RUN_ROOT ??= path.join(testBase, 'runs/plugin-packages');
const {createDriver, testRoot: runRoot, until} = await import(process.platform === 'linux' ? './linux-driver.mjs' : './native-driver.mjs');
await fs.mkdir(runRoot, {recursive: true});
const output = await fs.mkdtemp(path.join(runRoot, 'acceptance-'));
const executable = process.env.ASMB_PACKAGED_EXECUTABLE;
const bundle = process.platform === 'linux' ? path.dirname(executable) : executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
const payload = path.join(bundle, process.platform === 'linux' ? 'resources/app' : 'Contents/Resources/app');
const metadata = JSON.parse(await fs.readFile(path.join(payload, 'native-package.json')));
assertPackageIdentity(metadata, {
  sourceCommit: process.env.ASMB_EXPECTED_SOURCE_COMMIT,
  buildNumber: process.env.ASMB_EXPECTED_BUILD_NUMBER,
});
const pluginFile = path.resolve('packages/pro-editor-plugin/asMagicBrain-Pro-Editor-0.1.0.asmbplugin');
assert.equal((await fs.stat(pluginFile)).isFile(), true);
const home = path.join(output, 'home');
const data = metadata.channel === 'preview' ? path.join(home, 'asMagicBrain') : path.join(output, 'data');
const organization = path.join(data, 'workspaces/asMagicBrain');
const target = metadata.channel === 'preview'
  ? {executablePath: executable, args: ['--test-root=' + testBase, '--test-user-home=' + home]}
  : {executablePath: executable, args: ['--test-data-root=' + data]};
const driver = await createDriver({...target, output, workspacePath: path.join(organization, 'Workspace')});
await fs.writeFile(path.join(output, 'driver-at-launch.mjs'), await fs.readFile(new URL(import.meta.url)));

let page, running = false, failure;
const requests = [];
const button = name => page.getByRole('button', {name, exact: true});
const region = () => page.getByRole('region', {name: 'Plugins', exact: true});
const card = () => page.locator('.pws-plugin').filter({has: page.getByRole('heading', {name: 'Pro Editor', exact: true})});
const toggle = () => page.getByRole('switch', {name: 'Enable Pro Editor', exact: true});
async function launch() {
  page = await driver.launch(); running = true;
  await page.context().setOffline(true);
  page.on('request', request => {if (/^https?:/i.test(request.url())) requests.push(request.url());});
  await button('Manage plugins').waitFor();
  if (driver.app) await driver.app.evaluate(({BrowserWindow}) => {const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1280, 900); window.show(); window.focus();});
}
async function close() {await driver.closeNormally(); running = false;}
async function manager() {await button('Manage plugins').click(); await region().waitFor();}
async function capture(name) {
  await fs.writeFile(path.join(output, name + '-aria.yml'), await page.locator('body').ariaSnapshot());
  await driver.screenshot(name);
}
async function directPickerToFixture() {
  await driver.app.evaluate(({dialog}, filename) => {
    if (!globalThis.__pluginPickerOriginal) globalThis.__pluginPickerOriginal = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({canceled: false, filePaths: [filename]});
  }, pluginFile);
}
async function restorePicker() {
  if (!driver.app) return;
  await driver.app.evaluate(({dialog}) => {
    if (globalThis.__pluginPickerOriginal) dialog.showOpenDialog = globalThis.__pluginPickerOriginal;
    delete globalThis.__pluginPickerOriginal;
  });
}
async function choosePlugin() {
  if (driver.app) {
    await directPickerToFixture();
    await button('Install plugin…').click();
    return;
  }
  await button('Install plugin…').click();
  const window = await until(() => {
    try {return execFileSync('/usr/bin/xdotool', ['search', '--onlyvisible', '--name', '^Install plugin$'], {encoding: 'utf8'}).trim().split('\n').at(-1) || false;}
    catch (error) {if (error.status === 1) return false; throw error;}
  }, {timeout: 30000, label: 'native Linux plugin chooser'});
  execFileSync('/usr/bin/xdotool', ['windowactivate', '--sync', window]);
  execFileSync('/usr/bin/xdotool', ['key', '--clearmodifiers', 'ctrl+l']);
  execFileSync('/usr/bin/xdotool', ['type', '--clearmodifiers', '--delay', '1', '--', pluginFile]);
  execFileSync('/usr/bin/xdotool', ['key', '--clearmodifiers', 'Return']);
  // GTK may first select the named row and then require the button's default
  // action. A second ordinary Return is inert if the chooser already closed.
  await new Promise(resolve => setTimeout(resolve, 250));
  try {execFileSync('/usr/bin/xdotool', ['key', '--clearmodifiers', 'Return']);} catch {}
}

try {
  await launch(); await manager();
  assert.match(await region().innerText(), /Bundled\s*0/);
  assert.match(await region().innerText(), /Installed\s*0/);
  assert.match(await region().innerText(), /No optional plugins are bundled/);
  assert.equal(await button('Install plugin…').isEnabled(), true);
  await choosePlugin();
  const review = page.getByRole('dialog', {name: 'Install Pro Editor?', exact: true});
  await review.waitFor();
  const reviewText = await review.innerText();
  assert.match(reviewText, /asMagicBrain/);
  assert.match(reviewText, /0\.1\.0/);
  assert.match(reviewText, /No permissions · declarative content only/);
  assert.match(reviewText, /asMagicBrain-Pro-Editor-0\.1\.0\.asmbplugin/);
  await capture('00-plugin-review');
  await review.getByRole('button', {name: 'Install plugin', exact: true}).click();
  await until(async () => await card().count() === 1, {label: 'installed Pro Editor card'});
  assert.equal(await toggle().getAttribute('aria-checked'), 'false');
  await card().getByRole('button', {name: 'View details', exact: true}).click();
  assert.match(await card().innerText(), /Verified first-party/);
  assert.match(await card().innerText(), /Replacing any package byte breaks that binding/);
  assert.equal(await card().getByRole('button', {name: 'Restore previous version', exact: true}).isDisabled(), true);
  await capture('01-plugin-installed');
  await toggle().click();
  await until(async () => await toggle().getAttribute('aria-checked') === 'true', {label: 'enabled Pro Editor'});
  await button('Return to workspace').click();
  await region().waitFor({state: 'hidden'});
  assert.equal(await button('Pro Editor').count(), 1, 'Exact package activates the compiled Pro contribution');
  driver.record('exact-package-enables-pro-editor', {package: path.basename(pluginFile)});
  await close();

  await launch(); await manager();
  assert.equal(await card().count(), 1, 'Installed package persists after normal restart');
  assert.equal(await toggle().getAttribute('aria-checked'), 'true', 'Enabled preference persists after normal restart');
  await capture('02-plugin-restarted');
  await toggle().click();
  await until(async () => await toggle().getAttribute('aria-checked') === 'false', {label: 'disabled Pro Editor'});
  await button('Return to workspace').click(); await region().waitFor({state: 'hidden'});
  assert.equal(await button('Pro Editor').count(), 0, 'Disable disposes Pro contributions');
  await manager();
  await card().getByRole('button', {name: 'View details', exact: true}).click();
  await card().getByRole('button', {name: 'Uninstall…', exact: true}).click();
  const uninstall = page.getByRole('dialog', {name: 'Uninstall Pro Editor?', exact: true});
  await uninstall.waitFor();
  assert.match(await uninstall.innerText(), /Repository files, drafts and Git history remain unchanged/);
  await uninstall.getByRole('button', {name: 'Uninstall', exact: true}).click();
  await until(async () => await card().count() === 0, {label: 'Pro Editor removed'});
  assert.match(await region().innerText(), /Installed\s*0/);
  assert.match(await region().innerText(), /No plugins installed/);
  await capture('03-plugin-uninstalled');
  await restorePicker();
  await close();
  assert.deepEqual(requests, [], 'Plugin lifecycle remains offline');
  assert.deepEqual(driver.errors, [], 'No renderer page errors');
  assert.deepEqual(driver.consoleErrors, [], 'No renderer console errors');
} catch (error) {
  failure = error;
} finally {
  if (running) await restorePicker().catch(() => {});
  if (running) await close().catch(() => {});
  await driver.report({requests, failure: failure ? {name: failure.name, message: failure.message, stack: failure.stack} : null});
}
if (failure) throw failure;
