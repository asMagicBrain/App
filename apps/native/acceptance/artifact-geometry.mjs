/** Exact native geometry/lifecycle qualification. The only injected behavior is
 * deliberate child-only renderer failure or a named invalid-geometry request;
 * neither alters production source, callbacks, sandbox or host policy. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createArtifactProbe} from './pro-editor-probe.mjs';
import {testRoot as testBase} from '../../../tools/development-paths.mjs';
assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
process.env.ASMB_ACCEPTANCE_RUN_ROOT ??= path.join(testBase, 'runs/artifact-geometry');
const {createDriver, nativeTarget, testRoot: runRoot, until, sha} = await import(process.platform === 'linux' ? './linux-driver.mjs' : './native-driver.mjs');
await fs.mkdir(runRoot, {recursive: true});
const output = await fs.mkdtemp(path.join(runRoot, 'geometry-'));
await fs.copyFile(new URL('artifact-geometry.mjs', import.meta.url), path.join(output, 'driver-at-launch.mjs'));
const executable = process.env.ASMB_PACKAGED_EXECUTABLE;
let metadata = null;
if (executable) {
  const bundle = process.platform === 'linux' ? path.dirname(executable) : executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
  metadata = JSON.parse(await fs.readFile(path.join(bundle, process.platform === 'linux' ? 'resources/app/native-package.json' : 'Contents/Resources/app/native-package.json')));
  if (process.env.ASMB_EXPECTED_SOURCE_COMMIT) assert.equal(metadata.sourceCommit, process.env.ASMB_EXPECTED_SOURCE_COMMIT);
  if (process.env.ASMB_EXPECTED_BUILD_NUMBER) assert.equal(metadata.buildNumber, Number(process.env.ASMB_EXPECTED_BUILD_NUMBER));
}
const fixture = path.join(output, 'fixture'); await fs.mkdir(fixture);
const source = '<!doctype html><meta charset="utf-8"><title>Geometry qualification</title><h1>Geometry qualification</h1><label>Angle <input id="angle" type="range" min="0" max="180" value="45"></label><output id="value">45</output><script>angle.oninput=()=>{value.value=angle.value};</script>';
await fs.writeFile(path.join(fixture, 'view.html'), source);
await fs.writeFile(path.join(fixture, 'README.md'), '# Geometry qualification\n\n[Local example](view.html)\n');
const zip = path.join(output, 'geometry.zip'); execFileSync('/usr/bin/zip', ['-q', zip, 'README.md', 'view.html'], {cwd: fixture});
let driver, page, probe, live = false, artifact, failure;
const sessions = [], captures = [], reports = [];
const button = name => page.getByRole('button', {name, exact: true});
const status = () => page.evaluate(async () => {const result = await window.asMagicBrain.artifactStatus(); if (result.ok === false) throw Error(result.error.code); return result.value ?? result;});
const expectedBounds = () => page.locator('.artifact-surface').evaluate(element => {const r = element.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), width: Math.floor(r.width), height: Math.floor(r.height)};});
const geometryMatches = (left, right) => left && Object.keys(right).every(key => Math.abs(left[key] - right[key]) <= 1);
async function osWindowId() {
  const ids = execFileSync('/usr/bin/xdotool', ['search', '--onlyvisible', '--class', 'asmagicbrain'], {encoding: 'utf8'}).trim().split('\n');
  assert.equal(ids.length, 1, 'Exactly one visible isolated asMagicBrain owner window'); return ids[0];
}
async function resize(width) {
  if (driver.app) await driver.app.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
  else execFileSync('/usr/bin/xdotool', ['windowsize', '--sync', await osWindowId(), String(width), '900']);
  return until(async () => {
    const expected = await expectedBounds(), current = await status();
    assert.notEqual(current.state, 'failed', JSON.stringify(current));
    if (!current.runId || current.geometryPending || !geometryMatches(current.bounds, expected)) return false;
    let native = null;
    if (driver.app) native = await driver.app.evaluate(({BrowserWindow}) => {
      const v = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v.webContents?.getURL().startsWith('asmb-artifact:'));
      return v ? {bounds: v.getBounds(), visible: typeof v.getVisible === 'function' ? v.getVisible() : null} : null;
    });
    if (driver.app && (!geometryMatches(native?.bounds, expected) || native?.visible === false)) return false;
    return {expected, native, current};
  }, {timeout: 10000, label: `fresh admitted geometry at ${width}px`});
}
async function run() {
  await button('Run interactive view').click();
  const target = await until(async () => (await probe.targets())[0], {timeout: 60000, label: 'explicit artifact target'});
  artifact = await probe.attach(target.targetId);
  await until(() => artifact.evaluate('document.querySelector("#value")?.value').then(value => value === '45'), {label: 'local slider ready'});
  const current = await until(async () => {const value = await status(); return value.state === 'running' && !value.geometryPending ? value : false;}, {label: 'fresh geometry visible'});
  return current.runId;
}
async function interact() {await artifact.click('#angle'); await artifact.key('End', 'End', 35); assert.equal(await artifact.evaluate('document.querySelector("#value").value'), '180');}
async function disposed(label) {await until(() => probe.targets().then(list => list.length === 0), {label}); await artifact?.detach(); artifact = null; return status();}
async function show() {
  if (driver.app) await driver.app.evaluate(({BrowserWindow}) => {const w = BrowserWindow.getAllWindows()[0]; w.restore(); w.show(); w.focus();});
  else {const ids = execFileSync('/usr/bin/xdotool', ['search', '--class', 'asmagicbrain'], {encoding: 'utf8'}).trim().split('\n'); assert.equal(ids.length, 1); execFileSync('/usr/bin/xdotool', ['windowmap', '--sync', ids[0], 'windowactivate', '--sync', ids[0]]);}
}
try {
  for (let session = 1; session <= 3; session++) {
    const sessionRoot = path.join(output, 'session-' + session); await fs.mkdir(sessionRoot);
    const home = path.join(sessionRoot, 'home'), data = metadata?.channel === 'preview' ? path.join(home, 'asMagicBrain') : path.join(sessionRoot, 'data');
    const organization = path.join(data, 'workspaces/asMagicBrain'), repo = 'Geometry-Qualification';
    const target = metadata?.channel === 'preview' ? {executablePath: executable, args: ['--test-root=' + testBase, '--test-user-home=' + home]} : nativeTarget(data);
    driver = await createDriver({...target, output: sessionRoot, workspacePath: path.join(organization, 'Workspace')});
    page = await driver.launch(); live = true; probe = await createArtifactProbe(page);
    await button('Create new options').click(); await page.locator('.ra-menu-create').getByRole('button', {name: 'Import repository', exact: true}).click();
    await page.getByLabel('ZIP archive', {exact: true}).setInputFiles(zip); await page.getByLabel('Repository name', {exact: true}).fill(repo);
    await page.locator('.zi-dialog').getByRole('button', {name: 'Import repository', exact: true}).click(); await page.locator('.zi-dialog').waitFor({state: 'detached', timeout: 120000});
    await button('Manage plugins').click(); const toggle = page.getByRole('switch', {name: 'Enable Pro Editor', exact: true}); if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click(); await button('Return to workspace').click();
    await button('asMagicBrain organization').click(); await button('Open repository ' + repo).click();
    await page.getByRole('table', {name: 'Directory contents', exact: true}).getByRole('button', {name: 'view.html', exact: true}).click();
    await button('Review interactive view').click(); const runId = await run(); const cycles = [];
    for (let cycle = 1; cycle <= 10; cycle++) for (const width of [1280, 960, 1280]) {
      const result = await resize(width); assert.equal(result.current.runId, runId); await interact();
      cycles.push({cycle, width, bounds: result.expected, native: result.native, runId: result.current.runId, geometryPending: result.current.geometryPending});
    }
    const stable = await status(); assert.equal(stable.started, 1); assert.equal(stable.disposed, 0);
    await driver.screenshot('stable-resize'); captures.push(`session-${session}/stable-resize.png`);
    const childImage = await artifact.send('Page.captureScreenshot', {format: 'png'}); await fs.writeFile(path.join(sessionRoot, 'child-after-resize.png'), Buffer.from(childImage.data, 'base64')); captures.push(`session-${session}/child-after-resize.png`);
    driver.record('thirty-size-changes-ten-full-cycles-stable-run', {session, runId, cycles});
    // Deliberate trusted QA request: invalid geometry must destroy rather than
    // keep drawing with the last valid native rectangle.
    const invalid = await page.evaluate(async runId => window.asMagicBrain.resizeArtifact({runId, bounds: {x: 40, y: 100, width: 1, height: 100}, viewport: {width: innerWidth, height: innerHeight}}), runId);
    assert.equal(invalid.ok, false); assert.equal(invalid.error.code, 'ARTIFACT_INVALID_BOUNDS');
    let value = await disposed('invalid geometry child disposed'); assert.equal(value.errorCode, 'ARTIFACT_INVALID_BOUNDS');
    await until(() => button('Run interactive view').isVisible(), {label: 'invalid geometry fallback'}); await button('Source').click();
    value = await status(); assert.equal(value.lastFailure.code, 'ARTIFACT_INVALID_BOUNDS'); assert.equal(value.state, 'failed');
    await run(); await interact();
    if (driver.app) await driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].minimize());
    else execFileSync('/usr/bin/xdotool', ['windowminimize', '--sync', await osWindowId()]);
    value = await disposed('real minimize child disposed'); assert.equal(value.lastStopReason, 'owner-minimized'); await show();
    await until(() => button('Run interactive view').isVisible(), {label: 'minimize fallback'}); await run();
    if (driver.app) await driver.app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].hide());
    else execFileSync('/usr/bin/xdotool', ['windowunmap', '--sync', await osWindowId()]);
    value = await disposed('real hide child disposed'); assert.ok(['owner-hidden', 'owner-minimized'].includes(value.lastStopReason)); await show();
    await until(() => button('Run interactive view').isVisible(), {label: 'hide fallback'}); await run();
    if (driver.app) await driver.app.evaluate(({BrowserWindow, webContents}) => {
      const owner = BrowserWindow.getAllWindows()[0], child = webContents.getAllWebContents().find(w => w.getURL().startsWith('asmb-artifact:'));
      if (!child || child.getOSProcessId() === owner.webContents.getOSProcessId()) throw Error('Child-only failure admission'); child.forcefullyCrashRenderer();
    }); else void artifact.send('Page.crash').catch(() => {});
    value = await disposed('deliberately failed child disposed'); assert.equal(value.errorCode, 'ARTIFACT_RENDERER_EXITED');
    await until(() => button('Run interactive view').isVisible(), {label: 'failure fallback'}); await button('Source').click();
    value = await status(); assert.equal(value.lastFailure.code, 'ARTIFACT_RENDERER_EXITED'); assert.equal(value.state, 'failed');
    await run(); await interact(); await button('Stop').click(); value = await disposed('explicit Stop child disposed'); assert.equal(value.state, 'stopped');
    assert.equal(value.lastFailure.code, 'ARTIFACT_RENDERER_EXITED'); assert.equal(value.activeViews, 0); assert.ok(value.diagnostics.length <= 32);
    assert.equal(await fs.readFile(path.join(organization, repo, 'view.html'), 'utf8'), source);
    driver.record('invalid-bounds-hide-minimize-child-failure-explicit-stop-and-source-preserved', {session, status: value});
    await button('Keep reading').click(); await probe.dispose(); probe = null; await driver.closeNormally(); live = false;
    assert.deepEqual(driver.errors, []); assert.deepEqual(driver.consoleErrors, []);
    const report = {session, runId, cycles, status: value}; sessions.push(report);
    await driver.report({status: 'passed', geometry: report}); reports.push(`session-${session}/receipt.json`);
  }
} catch (error) {failure = String(error?.stack ?? error); if (live) {try {await fs.writeFile(path.join(output, 'failure-status.json'), JSON.stringify(await status(), null, 2)); await driver.screenshot('failure');} catch {}}}
finally {
  await probe?.dispose().catch(() => {});
  if (live) {try {const close = button('Close interactive view'); if (await close.isVisible()) await close.click(); await driver.closeNormally(); live = false;} catch (error) {failure ??= String(error);}}
  if (failure && driver) await driver.report({status: 'failed', failure});
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify({status: failure ? 'failed' : 'passed', failure, platform: process.platform, architecture: process.arch, metadata,
    sourceOnly: !metadata, driverSha256: sha(await fs.readFile(new URL('artifact-geometry.mjs', import.meta.url))), fixtureSha256: sha(source), sessions, reports, captures,
    scope: 'Three fresh isolated application sessions, ten 1280/960/1280 cycles in each (30 cycles,90 size requests), continuous native run identity and slider controls, explicit invalid bounds, genuine OS minimize/hide, child-only failure, Source/fallback, explicit Run/Stop, normal close and unchanged imported source. Linux geometry uses admitted host status plus actual child image; Mac additionally observes native View bounds.'}, null, 2) + '\n');
}
if (failure) throw Error(failure);
console.log(JSON.stringify({status: 'passed', output, sessions: sessions.length, cycles: 30}));
