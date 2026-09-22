import {assertPackageIdentity} from './package-identity.mjs';
/** Stage 2 exact-package acceptance through ordinary shipped controls.
 * Uses only synthetic imported data. DOM references observe editor identity;
 * no app callback, plugin module, privileged bridge or host result is replaced.
 * Incompatible manifests and injected module failures are source-test coverage.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {testRoot as testBase} from '../../../tools/development-paths.mjs';
assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
assert.ok(process.env.ASMB_PACKAGED_EXECUTABLE, 'Bind acceptance to an exact package.');
process.env.ASMB_ACCEPTANCE_RUN_ROOT ??= path.join(testBase, 'runs/plugin-foundation');
const {createDriver, nativeTarget, testRoot: runRoot, until, sha} = await import(process.platform === 'linux' ? './linux-driver.mjs' : './native-driver.mjs');
await fs.mkdir(runRoot, {recursive: true});
const output = await fs.mkdtemp(path.join(runRoot, 'plugins-'));
const executable = process.env.ASMB_PACKAGED_EXECUTABLE;
const bundle = process.platform === 'linux' ? path.dirname(executable) : executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
const payload = path.join(bundle, process.platform === 'linux' ? 'resources/app' : 'Contents/Resources/app');
const metadata = JSON.parse(await fs.readFile(path.join(payload, 'native-package.json')));
assertPackageIdentity(metadata);
if (process.env.ASMB_EXPECTED_SOURCE_COMMIT) assert.equal(metadata.sourceCommit, process.env.ASMB_EXPECTED_SOURCE_COMMIT);
if (process.env.ASMB_EXPECTED_BUILD_NUMBER) assert.equal(metadata.buildNumber, Number(process.env.ASMB_EXPECTED_BUILD_NUMBER));
const home = path.join(output, 'home');
const data = metadata.channel === 'preview' ? path.join(home, 'asMagicBrain') : path.join(output, 'data');
const organization = path.join(data, 'workspaces/asMagicBrain');
const target = metadata.channel === 'preview' ? {executablePath: executable, args: ['--test-root=' + testBase, '--test-user-home=' + home]} : nativeTarget(data);
const driver = await createDriver({...target, output, workspacePath: path.join(organization, 'Workspace')});
const definition = await fs.readFile(new URL(import.meta.url));
await fs.writeFile(path.join(output, 'driver-at-launch.mjs'), definition);
const fixtures = path.join(output, 'fixtures'); await fs.mkdir(fixtures);
const repo = 'Plugin-Foundation';
const source = '# Plugin foundation\n\nNative source Ω stays readable.\n\nInline math: $x^2=1$.\n\n```mermaid\nflowchart LR\nA[Host source]-->B[Static reading]\n```\n';
const untouched = '# Unselected saved file\n\nKeep this file outside the selected-file commit. Ω\n';
await fs.writeFile(path.join(fixtures, 'README.md'), source);
await fs.writeFile(path.join(fixtures, 'untouched.md'), untouched);
const zip = path.join(output, 'plugin-foundation.zip');
execFileSync('/usr/bin/zip', ['-q', zip, 'README.md', 'untouched.md'], {cwd: fixtures});
const draftSuffix = '\nRetained plugin draft Ω\nretained Ω';
const expectedDraft = source + draftSuffix;
const expectedBold = source + draftSuffix.replace(/retained Ω$/, '**retained Ω**');
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const end = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';
// Linux character key bindings distinguish key='Z' from lowercase 'z' even
// when Shift is set. Match the uppercase key delivered by a physical keypress.
const redo = process.platform === 'linux' ? 'Control+Shift+Z' : mod + '+Shift+z';
let page, running = false, failure;
const requests = [], observations = [];
const captures = [];
const button = name => page.getByRole('button', {name, exact: true});
const editor = () => page.locator('.rfe-source:not([hidden]) .cm-content[contenteditable=true]');
const text = () => page.locator('.rfe-source .cm-line').evaluateAll(lines => lines.map(line => line.textContent).join('\n'));
const saved = name => fs.readFile(path.join(organization, repo, name), 'utf8');
const record = (name, detail = {}) => { driver.record(name, detail); console.log(JSON.stringify({event: name})); };
async function capture(label) {
  await fs.writeFile(path.join(output, label + '-aria.yml'), await page.locator('body').ariaSnapshot());
  await driver.screenshot(label);
  captures.push(path.join(output, label + '.png'));
}
async function annotated(label, definitions) {
  const areas = await page.evaluate(definitions => definitions.flatMap(([name, selector]) => {
    const node = document.querySelector(selector);
    if (!node || !node.checkVisibility()) return [];
    const r = node.getBoundingClientRect();
    return [{name, x: r.x, y: r.y, width: r.width, height: r.height}];
  }), definitions);
  assert.equal(areas.length, definitions.length, 'Every documented UI area is visible');
  await fs.writeFile(path.join(output, label + '-areas.json'), JSON.stringify(areas, null, 2) + '\n');
  await page.evaluate(areas => {
    const layer = document.createElement('div'); layer.id = 'stage2-qa-annotation';
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    areas.forEach((area, index) => {
      const color = ['#a32638', '#6639b0', '#08714c', '#00738b'][index % 4];
      const box = document.createElement('div'), badge = document.createElement('span');
      box.style.cssText = `position:fixed;left:${area.x}px;top:${area.y}px;width:${area.width}px;height:${area.height}px;border:2px solid ${color};background:${color}10;box-sizing:border-box`;
      badge.textContent = area.name; badge.style.cssText = `background:white;color:${color};font:700 11px system-ui;padding:2px 4px;position:absolute;left:0;top:0;white-space:nowrap`;
      box.append(badge); layer.append(box);
    });
    document.body.append(layer);
  }, areas);
  try { await capture(label + '-annotated'); }
  finally { await page.evaluate(() => document.getElementById('stage2-qa-annotation')?.remove()); }
}
async function launch() {
  page = await driver.launch(); running = true;
  await page.context().setOffline(true);
  page.on('request', request => { if (/^https?:/i.test(request.url())) requests.push(request.url()); });
  await button('asMagicBrain organization').waitFor();
  if (driver.app) await driver.app.evaluate(({BrowserWindow}) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1280, 900); w.show(); w.focus(); });
}
async function close() { await driver.closeNormally(); running = false; }
async function openReadme() {
  await button('asMagicBrain organization').click();
  if (await button('Leave editor').isVisible()) await button('Leave editor').click();
  await button('Open repository ' + repo).click();
  await page.getByRole('table', {name: 'Directory contents'}).getByRole('button', {name: 'README.md', exact: true}).click();
  await page.locator('.rfe-preview').waitFor({state: 'visible'});
}
async function edit() { await button('Edit this file').click(); await editor().waitFor(); }
async function sameEditor(label) {
  const result = await page.evaluate(() => ({count: document.querySelectorAll('.rfe-source .cm-editor').length,
    same: document.querySelector('.rfe-source .cm-editor') === window.__stage2Editor,
    sameContent: document.querySelector('.rfe-source .cm-content') === window.__stage2Content}));
  assert.deepEqual(result, {count: 1, same: true, sameContent: true}, label);
  observations.push({label, ...result});
}
async function rememberEditor() {
  await page.evaluate(() => { window.__stage2Editor = document.querySelector('.rfe-source .cm-editor'); window.__stage2Content = document.querySelector('.rfe-source .cm-content'); });
}
async function assertDraft(expected, label) { await until(async () => await text() === expected, {timeout: 30000, label}); await sameEditor(label); }
async function selectTail() {
  await editor().focus(); await editor().press(end);
  for (let i = 0; i < 'retained Ω'.length; i++) await editor().press('Shift+ArrowLeft');
  assert.equal(await page.evaluate(() => getSelection()?.toString()), 'retained Ω');
}
// Accessible labels are part of the minimal bundled-plugin UI contract.
async function manager() { await button('Manage plugins').click(); await page.getByRole('region', {name: 'Plugins', exact: true}).waitFor(); }
const pluginSwitch = () => page.getByRole('switch', {name: 'Enable Markdown tools', exact: true});
async function enabled(value, keyboard = false) {
  await manager();
  const toggle = pluginSwitch();
  if ((await toggle.getAttribute('aria-checked') === 'true') !== value) {
    if (keyboard) { await toggle.focus(); await toggle.press('Space'); } else await toggle.click();
  }
  await until(async () => (await toggle.getAttribute('aria-checked') === 'true') === value, {label: 'Markdown tools enabled=' + value});
  await button('Return to workspace').click();
  await page.getByRole('region', {name: 'Plugins', exact: true}).waitFor({state: 'hidden'});
}
const statistics = value => `${value.trim().split(/\s+/u).length} words · ${Array.from(value).length} characters · ${value.split('\n').length} lines`;
async function coreReading(label) {
  await page.locator('.rfe-preview .katex').waitFor();
  await page.locator('.technical-diagram[data-diagram-state=ready]').waitFor({timeout: 120000});
  assert.equal(await page.locator('.rfe-preview .katex').count(), 1);
  assert.equal(await page.locator('.technical-diagram[data-diagram-state=ready]').count(), 1);
  assert.equal(await page.locator('.rfe-preview script,.rfe-preview iframe,.rfe-preview foreignObject').count(), 0);
  record(label, {math: 1, diagrams: 1, savedSha256: sha(await saved('README.md'))});
}
try {
  await launch();
  await button('Create new options').click();
  await page.locator('.ra-menu-create').getByRole('button', {name: 'Import repository', exact: true}).click();
  await page.getByLabel('ZIP archive', {exact: true}).setInputFiles(zip);
  await page.getByLabel('Repository name', {exact: true}).fill(repo);
  await page.locator('.zi-dialog').getByRole('button', {name: 'Import repository', exact: true}).click();
  await page.locator('.zi-dialog').waitFor({state: 'detached', timeout: 120000});
  await openReadme(); await enabled(false); await coreReading('core-reading-with-plugin-disabled');
  await manager(); await page.locator('.pws-plugin').filter({has:page.getByRole('heading',{name:'Markdown tools',exact:true})}).getByRole('button',{name:'View details',exact:true}).click();
  assert.match(await page.getByRole('region', {name: 'Plugins', exact: true}).innerText(), /Edits stay in the document’s draft until you save them/);
  await capture('00-plugin-manager');
  await annotated('00-plugin-manager', [['P1 · Plugins rail', '.fw-rail'], ['P2 · Manager header', '.pws-heading'], ['P3 · Plugin and enable', '.pws-plugin-row'], ['P4 · Document access', '.pws-details']]);
  await button('Return to workspace').click();
  await edit(); await rememberEditor();
  assert.equal(await text(), source, 'CM6 initially contains the complete saved source including its final newline');
  // CDP insertText can coalesce a leading newline with contenteditable's final
  // placeholder line. Use the ordinary Enter command, then insert the text.
  await editor().focus(); await editor().press(end); await editor().press('Enter'); await page.keyboard.insertText(draftSuffix.slice(1));
  await assertDraft(expectedDraft, 'private draft before plugin');
  assert.equal(await saved('README.md'), source);
  await selectTail(); await enabled(true);
  await assertDraft(expectedDraft, 'activation preserves private draft');
  assert.equal(await button('Document statistics').count(), 1);
  assert.equal(await button('Bold selection').count(), 1);
  await button('Bold selection').click();
  await assertDraft(expectedBold, 'plugin edits retained selection through CM6');
  assert.equal(await saved('README.md'), source, 'Plugin edit does not save');
  await editor().focus(); await editor().press(mod + '+z');
  await assertDraft(expectedDraft, 'one undo removes only plugin transaction');
  await editor().press(redo);
  await assertDraft(expectedBold, 'redo restores plugin transaction');
  await capture('01-plugin-cm6-draft');
  await annotated('01-plugin-cm6-draft', [['PT1 · Plugin commands', '.np-document-tools'], ['PT2 · Shared CM6 source', '.rfe-source:not([hidden])'], ['PT3 · Save and commit', '.rfe-actions']]);
  for (let cycle = 1; cycle <= 5; cycle++) {
    await enabled(false, cycle % 2 === 0);
    assert.equal(await button('Bold selection').count(), 0);
    assert.equal(await button('Document statistics').count(), 0);
    await assertDraft(expectedBold, 'disable retains draft ' + cycle);
    await enabled(true, cycle % 2 === 0);
    assert.equal(await button('Bold selection').count(), 1);
    assert.equal(await button('Document statistics').count(), 1);
    await assertDraft(expectedBold, 'reenable retains draft ' + cycle);
    record('enable-disable-no-duplicate-contributions', {cycle});
  }
  await button('Document statistics').click();
  await until(async () => await page.getByRole('group', {name: 'Markdown tools', exact: true}).getByRole('status').innerText() === statistics(expectedBold), {label: 'statistics reflect retained private draft'});
  await capture('02-document-statistics');
  await assertDraft(expectedBold, 'statistics reads same retained draft');
  await button('Markdown tools').click();
  const statisticsDialog = page.getByRole('dialog', {name: 'Document statistics', exact: true});
  await statisticsDialog.waitFor();
  await until(async () => await statisticsDialog.getByRole('status').innerText() === statistics(expectedBold), {label: 'navigation contribution reads the same draft'});
  await statisticsDialog.getByRole('button', {name: 'Done', exact: true}).click();
  await enabled(false);
  await editor().focus(); await editor().press(mod + '+z');
  await assertDraft(expectedDraft, 'undo survives plugin disposal');
  await editor().press(redo);
  await assertDraft(expectedBold, 'redo survives plugin disposal');
  assert.equal(await saved('README.md'), source);
  assert.equal(await saved('untouched.md'), untouched);
  await capture('03-disabled-private-draft');
  await close();
  assert.equal(await saved('README.md'), source, 'Normal close retains draft without saving');
  await launch(); await openReadme(); await edit(); await rememberEditor();
  assert.equal(await button('Bold selection').count(), 0, 'Disabled preference persists across normal restart');
  await assertDraft(expectedBold, 'normal restart restores private draft');
  await capture('04-restarted-private-draft');
  assert.equal(await saved('README.md'), source);
  await button('Save').click();
  await until(async () => await saved('README.md') === expectedBold, {label: 'explicit Save exact source'});
  assert.equal(await saved('untouched.md'), untouched);
  record('explicit-save-source-and-unselected-bytes', {savedSha256: sha(expectedBold), untouchedSha256: sha(untouched)});
  await button('Commit changes…').click();
  const dialog = page.getByRole('dialog', {name: 'Commit changes', exact: true});
  await dialog.waitFor();
  const initialize = dialog.getByRole('button', {name: 'Initialize local Git and review', exact: true});
  if (await initialize.isVisible()) await initialize.click();
  await dialog.getByLabel('Commit message', {exact: true}).fill('Qualify shared plugin document');
  await dialog.getByLabel('Local author name', {exact: true}).fill('Native QA');
  await dialog.getByLabel('Local author email', {exact: true}).fill('native-qa@example.invalid');
  const checked = await dialog.locator('fieldset input[type=checkbox]:checked').evaluateAll(nodes => nodes.map(node => node.closest('label')?.textContent));
  assert.equal(checked.length, 1); assert.ok(checked[0].includes('README.md'));
  await dialog.getByRole('button', {name: 'Commit changes', exact: true}).click();
  await dialog.waitFor({state: 'hidden'});
  const git = args => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', path.join(organization, repo), ...args], {encoding: 'utf8', env: {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'}});
  const committed = git(['show', 'HEAD:README.md']); assert.equal(committed, expectedBold);
  const committedPaths = git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', 'HEAD']).trim().split('\n');
  assert.deepEqual(committedPaths, ['README.md']);
  record('selected-file-commit-remains-explicit', {commit: git(['rev-parse', 'HEAD']).trim(), paths: committedPaths});
  // A successful commit returns to the normal file preview itself.
  await page.locator('.rfe-preview').waitFor({state: 'visible'});
  assert.equal(await button('Edit this file').isVisible(), true);
  await coreReading('core-reading-after-plugin-save');
  await capture('05-saved-reading');
  await enabled(true);
  await close();
  await launch(); await openReadme(); await coreReading('second-restart-saved-source');
  assert.equal(await button('Document statistics').count(), 1, 'Enabled preference persists across normal restart');
  assert.equal(await button('Bold selection').isDisabled(), true, 'Preview remains read-only after restoring plugin preference');
  assert.equal(await saved('README.md'), expectedBold); assert.equal(await saved('untouched.md'), untouched);
  await capture('06-saved-restart');
  // The included reader contribution remains useful on protected documentation;
  // its editing contribution must stay unavailable through the real UI.
  await button('asMagicBrain organization').click();
  await button('Open repository asMagicBrain-Docs').click();
  await page.getByRole('table', {name: 'Directory contents'}).getByRole('button', {name: 'README.md', exact: true}).click();
  await page.locator('.rfe-preview').waitFor({state: 'visible'});
  const docsFile = path.join(organization, 'asMagicBrain-Docs', 'README.md');
  const docsSource = await fs.readFile(docsFile, 'utf8');
  await enabled(true);
  assert.equal(await button('Edit this file').isDisabled(), true);
  assert.equal(await button('Bold selection').isDisabled(), true);
  assert.equal(await page.locator('.cm-content[contenteditable=true]').count(), 0);
  await button('Document statistics').click();
  await until(async () => await page.getByRole('group', {name: 'Markdown tools', exact: true}).getByRole('status').innerText() === statistics(docsSource), {label: 'read-only statistics'});
  await page.getByRole('tab', {name: 'Code', exact: true}).click();
  assert.equal(await button('Bold selection').isDisabled(), true);
  assert.equal(await page.locator('.cm-content[contenteditable=true]').count(), 0);
  await capture('07-read-only-document-tools');
  const denied = await page.evaluate(() => window.asMagicBrain.request({repo: 'asMagicBrain-Docs', operation: 'checkpointNew', args: {draftId: crypto.randomUUID(), path: 'plugin-should-not-write.md', text: 'denied synthetic write'}}));
  assert.equal(denied.ok, false); assert.equal(denied.error.code, 'DOCS_READ_ONLY');
  assert.equal(await fs.readFile(docsFile, 'utf8'), docsSource);
  assert.equal(await fs.stat(path.join(organization, 'asMagicBrain-Docs', 'plugin-should-not-write.md')).then(() => true, error => {if (error.code === 'ENOENT') return false; throw error;}), false);
  await enabled(false);
  record('protected-documents-read-only-ui-and-host-boundary', {docsSha256: sha(docsSource), denial: denied.error.code});
  assert.deepEqual(requests, []); assert.equal(driver.errors.length, 0); assert.equal(driver.consoleErrors.length, 0);
  await close();
} catch (error) {
  failure = {message: error.message, stack: error.stack}; console.error(error.stack);
  if (page && !page.isClosed()) await capture('failure').catch(() => {});
  if (running) await close().catch(error => { failure.close = error.message; });
  process.exitCode = 1;
} finally {
  await driver.report({status: failure ? 'failed' : 'passed', failure, metadata, driverSha256: sha(definition),
    host: {platform: process.platform, arch: process.arch, release: os.release(), node: process.version}, requests, observations, captures,
    limits: 'Actual bundled Markdown tools only. Incompatible/malformed manifests, injected failures and revoked/stale request races use separately reported source-level contracts tests. No imported modules, Pro/asTeach runtime, interactive artifact execution, provider access or human screen-reader speech is qualified.'});
  console.log(JSON.stringify({status: failure ? 'failed' : 'passed', output}));
}
