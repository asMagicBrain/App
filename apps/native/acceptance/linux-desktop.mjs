/** Supplemental installed Ubuntu desktop acceptance. Run after the operations and
 * public-docs campaigns, with their application processes closed.
 *
 * source /home/ubuntu/qualification/desktop/session.env
 * ASMB_LINUX_NATIVE_INPUT=operator \
 * ASMB_PACKAGED_EXECUTABLE=/opt/asmagicbrain-preview/asmagicbrain \
 *   node apps/native/acceptance/linux-desktop.mjs --run-isolated
 *
 * Optional: source desktop/wayland.env and set ASMB_LINUX_OZONE=wayland. That
 * campaign exercises shared workflows and explicitly skips X11 OS automation.
 * No main-process inspection, service replacement, or sandbox bypass is used.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createDriver, nativeTarget, testRoot, until, sha} from './linux-driver.mjs';

assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
const ozone = process.env.ASMB_LINUX_OZONE ?? 'x11';
assert.ok(['x11', 'wayland'].includes(ozone));
const x11 = ozone === 'x11';
const exec = promisify(execFile);
const command = async (file, args, options = {}) => (await exec(file, args, {
  encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, ...options,
})).stdout.trim();
await fs.mkdir(testRoot, {recursive: true});
const output = await fs.mkdtemp(path.join(testRoot, `desktop-${ozone}-`));
const dataRoot = path.join(output, 'home/asMagicBrain');
const repository = 'Linux-Desktop-QA';
const workspacePath = path.join(dataRoot, 'workspaces/asMagicBrain', repository);
const driver = await createDriver({...nativeTarget(dataRoot), output, workspacePath});
await fs.copyFile(fileURLToPath(import.meta.url), path.join(output, 'driver-at-launch.mjs'));
const fixture = path.join(output, 'fixture');
const originals = path.join(output, 'originals');
const documentPath = 'notes/linux-outline.md';
const privateMarker = 'Private Linux draft marker Ω';
const externalUrl = `https://example.invalid/asmb-linux-desktop/${path.basename(output)}`;
const source = '# Linux desktop fixture\n\nLinux search needle Ω\n\nSetext heading\n--------------\n\n## Duplicate\n\n```md\n# Not an outline heading\n```\n\n## Duplicate\n\n[Open synthetic external link](' + externalUrl + ')\n';
const draft = `\n## Unsaved Linux heading\n\n${privateMarker}.\n`;
await fs.mkdir(path.join(fixture, 'notes'), {recursive: true});
await fs.writeFile(path.join(fixture, 'README.md'), '# Linux desktop acceptance\n');
await fs.writeFile(path.join(fixture, documentPath), source);
await fs.writeFile(path.join(fixture, 'notes/second-file.md'), '# Second file\n');
await fs.mkdir(path.join(originals, 'PickedFolder/nested'), {recursive: true});
await fs.mkdir(path.join(originals, 'PickedFolder/empty'));
const fileBytes = 'Native file picker original Ω\n';
const folderBytes = '# Native folder picker original Ω\n';
await fs.writeFile(path.join(originals, 'picked-file.txt'), fileBytes);
await fs.writeFile(path.join(originals, 'PickedFolder/nested/note.md'), folderBytes);
const zip = path.join(output, 'desktop-fixture.zip');
await command('/usr/bin/zip', ['-q', '-r', zip, '.'], {cwd: fixture});
const zipHash = sha(await fs.readFile(zip));
const workflows = [];
let page, failure, initialHead, initialWorkspaceReadme;
const button = name => page.getByRole('button', {name, exact: true});
const editor = () => page.locator('.cm-content[contenteditable=true]');
const search = () => page.locator('.ws-search-dialog');
const searchInput = () => search().getByRole('combobox', {name: /^(Search query|Find a file)$/});
const exists = filename => fs.access(filename).then(() => true, () => false);
const git = (...args) => command('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', workspacePath, ...args], {
  env: {PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0'},
});
async function workflow(name, run, skip) {
  if (skip) {workflows.push({name, status: 'skipped', reason: skip}); driver.record('workflow-skipped', {workflow: name, reason: skip}); return;}
  try {await run(); workflows.push({name, status: 'passed', ...(/^0[67]-/.test(name) ? {input: 'operator-assisted-native-picker'} : {})}); driver.record('workflow-passed', {workflow: name});}
  catch (error) {workflows.push({name, status: 'failed', error: error.message}); throw error;}
}
async function action(file, name) {
  await button(file === null ? 'Repository file actions' : `More actions for ${file}`).click();
  await page.getByRole('menuitem', {name, exact: true}).click();
}
async function selectedFile(filename) {
  await until(async () => await page.getByLabel('File path', {exact: true}).count()
    ? await page.getByLabel('File path', {exact: true}).inputValue() === filename
    : await page.locator('.rfe-file-name').innerText() === path.basename(filename), {label: 'active file ' + filename});
}
async function findFile(filename) {
  await page.keyboard.press('Control+p'); await search().waitFor();
  await searchInput().fill(filename);
  const result = search().locator('.ws-search-result').filter({has: page.locator('strong', {hasText: filename})});
  await until(async () => await search().getByRole('listbox').getAttribute('aria-busy') === 'false' && await result.count() === 1, {label: 'finder result ' + filename});
  await searchInput().press('Enter'); await search().waitFor({state: 'detached'}); await selectedFile(filename);
}
async function edit() {
  if (await button('Edit this file').isVisible()) await button('Edit this file').click();
  await editor().waitFor();
}
async function desktopScreenshot(name) {
  assert.ok(x11, 'Full desktop capture requires the X11 campaign.');
  await command('/usr/bin/import', ['-window', 'root', path.join(output, name + '-desktop.png')]);
  driver.record('desktop-screenshot', {file: name + '-desktop.png'});
}
async function documentAreaEvidence(name) {
  const areas = await page.evaluate(() => ({
    viewport: {width: innerWidth, height: innerHeight},
    areas: Object.entries({'V1/E1': '.fw-titlebar', 'V4/E3': '.rfe-sidebar-header, .rfe-sidebar > .fnc', V5: '.rfe-tree', 'V7/E5': '.rfe-context', V8: '.rfe-file-commit', 'V9/V11': '.rfe-toolbar', 'V12/E8': '.rfe-editor-frame [role=tabpanel]:not([hidden])', DO1: '.ido-panel'}).map(([label, selector]) => {
      const elements = [...document.querySelectorAll(selector)].filter(element => element.checkVisibility());
      const boxes = elements.map(element => element.getBoundingClientRect());
      const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
      const right = Math.max(...boxes.map(box => box.right)), bottom = Math.max(...boxes.map(box => box.bottom));
      return {label, selector, visible: boxes.length > 0, ...(boxes.length ? {x, y, width: right - x, height: bottom - y} : {})};
    }),
  }));
  for (const area of areas.areas) assert.ok(area.visible && area.width > 0 && area.height > 0, 'Visible document area ' + area.label);
  await fs.writeFile(path.join(output, name + '-areas.json'), JSON.stringify(areas, null, 2) + '\n');
  await driver.screenshot(name);
  await page.evaluate(({areas}) => {
    const layer = document.createElement('div'); layer.id = 'linux-acceptance-area-overlay';
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    const colors = ['#a32638', '#6639b0', '#08714c', '#00738b', '#a36a0c', '#3157a6', '#8b357f', '#546d14'];
    areas.forEach((area, index) => {
      const color = colors[index], box = document.createElement('div'), label = document.createElement('span');
      box.style.cssText = `position:fixed;left:${area.x}px;top:${area.y}px;width:${area.width}px;height:${area.height}px;border:2px solid ${color};background:${color}12;box-sizing:border-box`;
      label.textContent = area.label; label.style.cssText = `background:white;color:${color};font:700 12px system-ui;padding:2px 4px`;
      box.append(label); layer.append(box);
    });
    document.body.append(layer);
  }, areas);
  try {await driver.screenshot(name + '-overlay');}
  finally {await page.evaluate(() => document.getElementById('linux-acceptance-area-overlay')?.remove());}
  driver.record('measured-document-areas', {file: name + '-areas.json', scope: 'Synthetic document; diagnostic overlay derived from actual DOM bounds and removed after capture.'});
}
async function windows(kind, value) {
  try {return (await command('/usr/bin/xdotool', ['search', '--onlyvisible', kind, value])).split('\n').filter(Boolean);}
  catch (error) {if (error.code === 1) return []; throw error;}
}
const nativeTitle = 'Import files and folders';
const dialogWindows = () => windows('--name', '^' + nativeTitle + '$');
async function nativeDialog() {
  return until(async () => (await dialogWindows()).at(-1), {timeout: 30000, label: 'visible native import dialog'});
}
// The X11 guest's native GTK mode question has three equal-width buttons.
// Use its observed window geometry and OS mouse input; AT-SPI can expose an
// empty desktop tree in an otherwise functioning minimal desktop session.
let nativePhase = null;
async function nativeButton(name) {
  assert.ok(['Files', 'Folders', 'Cancel'].includes(name));
  const window = await nativeDialog();
  const geometry = await command('/usr/bin/xwininfo', ['-id', window]);
  const value = label => Number(geometry.match(new RegExp(label + ':\\s+(-?\\d+)'))?.[1]);
  const X = value('Absolute upper-left X'), Y = value('Absolute upper-left Y'), WIDTH = value('Width'), HEIGHT = value('Height');
  assert.ok(WIDTH >= 500 && WIDTH <= 800 && HEIGHT >= 100 && HEIGHT <= 200, 'Observed three-button mode question geometry');
  const x = Math.round(X + WIDTH * ({Files: 1, Folders: 3, Cancel: 5}[name]) / 6), y = Y + HEIGHT - 17;
  await command('/usr/bin/xdotool', ['mousemove', String(x), String(y), 'click', '1']);
  driver.record('native-os-button', {title: nativeTitle, button: name, window, geometry: {X, Y, WIDTH, HEIGHT}, target: {x, y}});
}
async function nativeImport(mode, filename, screenshot) {
  await action(null, 'Import files…'); const modeWindow = await nativeDialog(); nativePhase = 'mode';
  await desktopScreenshot(screenshot + '-mode'); await nativeButton(mode);
  const window = await until(async () => (await dialogWindows()).find(window => window !== modeWindow), {timeout: 30000, label: 'native file chooser replaces mode question'});
  nativePhase = 'picker';
  await desktopScreenshot(screenshot + '-picker');
  driver.record('native-picker-operator-selection-required', {mode, filename, window,
    instructions: 'Use the real native chooser to navigate to the fixture, select its visible row, and click Open. Capture the selected row in this output directory before acceptance. Do not call application services or fabricate results.'});
  console.log(JSON.stringify({operatorActionRequired: 'Select the actual fixture row in the native chooser, then Open', mode, filename, evidenceDirectory: output}));
  await fs.writeFile(path.join(output, screenshot + '-operator-request.json'), JSON.stringify({mode, filename, window, startedAt: new Date().toISOString(), timeoutMs: 600000, input: 'operator-assisted-native-picker'}, null, 2) + '\n');
  await until(async () => !(await dialogWindows()).length, {timeout: 600000, label: 'operator accepts or cancels actual native picker'});
  await page.locator('.rfe-import-progress').waitFor({state: 'detached'}); nativePhase = null;
}
async function preserveOriginals() {
  assert.equal(await fs.readFile(path.join(originals, 'picked-file.txt'), 'utf8'), fileBytes);
  assert.equal(await fs.readFile(path.join(originals, 'PickedFolder/nested/note.md'), 'utf8'), folderBytes);
  assert.deepEqual(await fs.readdir(path.join(originals, 'PickedFolder/empty')), []);
  assert.equal(await fs.readFile(path.join(workspacePath, documentPath), 'utf8'), source);
  assert.equal(await git('rev-parse', 'HEAD'), initialHead);
  assert.equal(sha(await fs.readFile(zip)), zipHash);
  assert.deepEqual(await fs.readFile(path.join(dataRoot, 'workspaces/asMagicBrain/Workspace/README.md')), initialWorkspaceReadme);
}
const x11Only = x11 ? null : 'Headless Wayland has no configured native input driver; this workflow is qualified in the X11 campaign.';

try {
  if (x11) {
    assert.equal(process.env.ASMB_LINUX_NATIVE_INPUT, 'operator', 'Set ASMB_LINUX_NATIVE_INPUT=operator and provide observed OS input for the Files/Folders picker steps.');
    assert.ok(process.env.DISPLAY && process.env.DBUS_SESSION_BUS_ADDRESS, 'Source the isolated guest desktop/session.env.');
    for (const tool of ['/usr/bin/xdotool', '/usr/bin/xwininfo', '/usr/bin/xclip', '/usr/bin/import']) await fs.access(tool);
  }
  page = await driver.launch();
  initialWorkspaceReadme = await fs.readFile(path.join(dataRoot, 'workspaces/asMagicBrain/Workspace/README.md'));
  await button('Create new options').click(); await button('Import repository').click();
  await page.getByLabel('ZIP archive', {exact: true}).setInputFiles(zip);
  await page.getByLabel('Repository name', {exact: true}).fill(repository);
  await page.locator('.zi-dialog').getByRole('button', {name: 'Import repository', exact: true}).click();
  await page.locator('.zi-dialog').waitFor({state: 'detached'});
  await until(() => exists(path.join(workspacePath, documentPath)), {label: 'synthetic ZIP repository'});
  initialHead = await git('rev-parse', 'HEAD');
  await button(/^Switch local repository:/).click();
  await page.locator('.rh-list').getByRole('button', {name: new RegExp(repository)}).click();
  await button('README.md').first().click();

  await workflow('01-scoped-saved-content-search', async () => {
    await button('Search all repositories').click(); await search().waitFor();
    await search().getByRole('button', {name: 'Contents', exact: true}).click();
    await search().getByRole('combobox', {name: 'Search scope'}).selectOption(repository);
    await searchInput().fill('Linux search needle Ω');
    await until(async () => await search().getByRole('listbox').getAttribute('aria-busy') === 'false' && await search().locator('.ws-search-result').count() === 1, {label: 'exact saved unicode result'});
    assert.equal(await search().locator('.ws-search-result strong').innerText(), documentPath);
    assert.equal(await search().locator('.ws-search-result small').innerText(), repository);
    await driver.screenshot('01-scoped-search'); await searchInput().press('Enter');
    await search().waitFor({state: 'detached'}); await selectedFile(documentPath);
    await page.getByRole('tab', {name: 'Preview', exact: true}).click();
    await button('Toggle document outline').click(); await page.locator('.ido-panel .do-entry').first().waitFor();
    await documentAreaEvidence('01-linux-document-view'); await button('Close document outline').click();
  });
  await workflow('02-control-p-go-to-file', async () => {
    await findFile('notes/second-file.md'); await driver.screenshot('02-go-to-file-opened');
    await findFile(documentPath); await edit();
    await editor().click(); await editor().press('Control+End'); await page.keyboard.insertText(draft);
    assert.equal(await fs.readFile(path.join(workspacePath, documentPath), 'utf8'), source);
  });
  await workflow('03-live-outline-keyboard-jump', async () => {
    await button('Toggle document outline').press('Enter'); await page.locator('.ido-panel').waitFor();
    const entries = page.locator('.ido-panel .do-entry');
    await until(async () => await entries.count() === 5, {label: 'saved and live draft outline headings'});
    const titles = await entries.allTextContents();
    assert.equal(titles.filter(text => text.includes('Duplicate')).length, 2);
    assert.ok(titles.some(text => text.includes('Setext heading')));
    assert.ok(!titles.some(text => text.includes('Not an outline heading')));
    await entries.first().focus(); await entries.first().press('End');
    assert.equal(await entries.last().evaluate(node => node === document.activeElement), true);
    await entries.last().press('Enter');
    await until(() => editor().evaluate(node => node.contains(document.activeElement)), {label: 'outline returns editor focus'});
    assert.match(await page.evaluate(() => {const node = window.getSelection()?.anchorNode; return (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.('.cm-line')?.textContent ?? ''; }), /Unsaved Linux heading/);
    await driver.screenshot('03-live-outline'); await button('Close document outline').click();
    assert.equal(await button('Toggle document outline').evaluate(node => node === document.activeElement), true);
  });
  await workflow('04-control-f-and-private-draft-search-boundary', async () => {
    await editor().focus(); await editor().press('Control+f'); await page.locator('.cm-search').waitFor();
    await page.locator('.cm-search input[name=search]').fill(privateMarker);
    await driver.screenshot('04-document-find');
    await page.locator('.cm-search input[name=search]').press('Escape');
    await page.locator('.cm-search').waitFor({state: 'detached'});
    await button('Search all repositories').click(); await search().waitFor();
    await search().getByRole('combobox', {name: 'Search scope'}).selectOption(repository);
    await searchInput().fill(privateMarker);
    await until(async () => await search().getByRole('listbox').getAttribute('aria-busy') === 'false' && (await search().getByRole('status').innerText()).startsWith('No results.'), {label: 'workspace search excludes private draft'});
    assert.equal(await search().locator('.ws-search-result').count(), 0);
    await driver.screenshot('04-private-draft-excluded'); await searchInput().press('Escape');
    await search().waitFor({state: 'detached'});
  });
  await workflow('05-native-import-cancel', async () => {
    const before = await git('status', '--porcelain');
    await action(null, 'Import files…'); await nativeDialog(); nativePhase = 'mode'; await desktopScreenshot('05-import-cancel');
    await nativeButton('Cancel');
    await until(async () => !(await dialogWindows()).length, {label: 'cancel closes native mode chooser'}); nativePhase = null;
    await page.locator('.rfe-import-progress').waitFor({state: 'detached'});
    assert.equal(await git('status', '--porcelain'), before);
    assert.match(await editor().innerText(), /Private Linux draft marker Ω/);
  }, x11Only);
  await workflow('06-native-files-import', async () => {
    await nativeImport('Files', path.join(originals, 'picked-file.txt'), '06-native-files');
    await until(() => exists(path.join(workspacePath, 'picked-file.txt')), {label: 'native file imported'});
    assert.equal(await fs.readFile(path.join(workspacePath, 'picked-file.txt'), 'utf8'), fileBytes);
    await preserveOriginals(); await driver.screenshot('06-file-imported');
  }, x11Only);
  await workflow('07-native-folders-import', async () => {
    await nativeImport('Folders', path.join(originals, 'PickedFolder'), '07-native-folders');
    await until(() => exists(path.join(workspacePath, 'PickedFolder/nested/note.md')), {label: 'native recursive folder imported'});
    assert.equal(await fs.readFile(path.join(workspacePath, 'PickedFolder/nested/note.md'), 'utf8'), folderBytes);
    assert.deepEqual(await fs.readdir(path.join(workspacePath, 'PickedFolder/empty')), []);
    await preserveOriginals(); await driver.screenshot('07-folder-imported');
  }, x11Only);
  await workflow('08-context-menu-reveal-actual-file-manager-selection', async () => {
    const expand = button('Expand notes'); if (await expand.count()) await expand.click();
    await page.locator(`.rex-node[data-explorer-path="${documentPath}"]`).click({button: 'right'});
    await page.getByRole('menuitem', {name: 'Reveal the file', exact: true}).waitFor();
    await driver.screenshot('08-reveal-context-menu');
    await page.getByRole('menuitem', {name: 'Reveal the file', exact: true}).click();
    const expected = pathToFileURL(path.join(workspacePath, documentPath)).href;
    const selected = await until(async () => {
      for (const window of await windows('--class', '[Tt]hunar')) {
        await command('/usr/bin/xdotool', ['windowactivate', '--sync', window]);
        await command('/usr/bin/xdotool', ['key', '--clearmodifiers', 'ctrl+c']);
        const clipboard = await command('/usr/bin/xclip', ['-selection', 'clipboard', '-o', '-t', 'text/uri-list'], {timeout: 2000}).catch(() => '');
        if (clipboard.split(/\r?\n/).filter(Boolean).join('\n') === expected) return {window, uri: clipboard.trim()};
      }
      return false;
    }, {timeout: 30000, label: 'Thunar selected exact saved source path'});
    await desktopScreenshot('08-thunar-selection'); driver.record('actual-file-manager-selection', selected);
    await command('/usr/bin/xdotool', ['key', '--clearmodifiers', 'ctrl+w']);
    await preserveOriginals();
  }, x11Only);
  await workflow('09-external-link-os-dispatch-to-local-receiver', async () => {
    const handler = process.env.ASMB_LINUX_URL_HANDLER_DESKTOP ?? 'asmb-qa-url-receiver.desktop';
    assert.equal(handler, 'asmb-qa-url-receiver.desktop', 'Only the guest qualification receiver is admitted.');
    assert.equal(await command('/usr/bin/xdg-mime', ['query', 'default', 'x-scheme-handler/https']), handler);
    const log = process.env.ASMB_LINUX_URL_DISPATCH_LOG ?? '/home/ubuntu/qualification/desktop/url-dispatch.jsonl';
    const before = await fs.readFile(log, 'utf8');
    await page.getByRole('tab', {name: 'Preview', exact: true}).click();
    const link = page.getByRole('link', {name: 'Open synthetic external link', exact: true});
    assert.equal(await link.getAttribute('href'), externalUrl); await link.click();
    const containsExactUrl = value => value === externalUrl || (value && typeof value === 'object' && Object.values(value).some(containsExactUrl));
    const dispatch = await until(async () => {
      const current = await fs.readFile(log, 'utf8'); assert.ok(current.startsWith(before), 'Receiver log preserves earlier records.');
      return current.slice(before.length).split('\n').filter(Boolean).map(line => JSON.parse(line)).find(containsExactUrl);
    }, {timeout: 30000, label: 'OS URL handler receives exact link'});
    driver.record('actual-os-url-dispatch', {handler, log, dispatch, scope: 'Guest-only logging handler; no remote page opened.'});
    await driver.screenshot('09-external-link'); if (x11) await desktopScreenshot('09-external-link');
    await page.getByRole('tab', {name: 'Edit', exact: true}).click();
  }, x11Only);
  await workflow('10-normal-restart-retains-draft-and-native-imports', async () => {
    await preserveOriginals(); await driver.closeNormally(); page = await driver.launch();
    await button(/^Switch local repository:/).click();
    await page.locator('.rh-list').getByRole('button', {name: new RegExp(repository)}).click();
    await button('README.md').first().click(); await findFile(documentPath); await edit();
    assert.match(await editor().innerText(), /Private Linux draft marker Ω/);
    if (x11) {
      assert.equal(await fs.readFile(path.join(workspacePath, 'picked-file.txt'), 'utf8'), fileBytes);
      assert.equal(await fs.readFile(path.join(workspacePath, 'PickedFolder/nested/note.md'), 'utf8'), folderBytes);
    }
    await preserveOriginals(); await driver.screenshot('10-restarted-private-draft');
    if (x11) await desktopScreenshot('10-restarted-private-draft');
  });
  assert.equal(driver.errors.length, 0); await driver.closeNormally();
} catch (error) {
  failure = {message: error.message, stack: error.stack}; console.error(error.stack);
  try {await driver.screenshot('failure'); await fs.writeFile(path.join(output, 'failure-dom.txt'), await page.locator('body').innerText());} catch {}
  if (x11) {
    try {
      await desktopScreenshot('failure');
      if ((await dialogWindows()).length) {
        if (nativePhase === 'mode') await nativeButton('Cancel');
        else {
          await command('/usr/bin/xdotool', ['windowactivate', '--sync', await nativeDialog()]);
          for (let attempt = 0; attempt < 3 && (await dialogWindows()).length; attempt++) {
            await command('/usr/bin/xdotool', ['key', '--clearmodifiers', 'Escape']);
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        }
        await until(async () => !(await dialogWindows()).length, {label: 'failure closes native modal before normal quit'});
        await page.locator('.rfe-import-progress').waitFor({state: 'detached'});
      }
    } catch (error) {failure.nativeCleanup = error.message;}
  }
  try {await driver.closeNormally();} catch (error) {failure.close = error.message;}
  process.exitCode = 1;
} finally {
  const status = failure ? 'failed' : workflows.some(item => item.status === 'skipped') ? 'passed-with-skips' : 'passed';
  await driver.report({status, failure, ozone, dataRoot, workflows, zipHash, initialHead,
    scope: 'Ten synthetic Linux desktop workflows through the shipped renderer and standard OS UI automation. No production profile, remote upload, main-process injection, or sandbox bypass.'});
  console.log(JSON.stringify({status, output}));
}
