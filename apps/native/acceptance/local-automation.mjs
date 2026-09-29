/** Actual desktop UI + shipped CLI acceptance. It creates only disposable Test
 * profiles, grants access through the user dialog, and uses the public protocol.
 * No token-bearing connection descriptor is copied into evidence. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createPackageZip} from '../../../packages/desktop-host/src/package-exchange/archive.mjs';
import {readZipFiles} from '../../../packages/desktop-host/src/zip-import/index.mjs';
import {testRoot as testBase} from '../../../tools/development-paths.mjs';
assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
process.env.ASMB_ACCEPTANCE_RUN_ROOT ??= path.join(testBase, 'runs/local-automation');
const {createDriver, nativeTarget, testRoot: runRoot, until, sha} = await import(process.platform === 'linux' ? './linux-driver.mjs' : './native-driver.mjs');
await fs.mkdir(runRoot, {recursive: true}); const output = await fs.mkdtemp(path.join(runRoot, 'automation-'));
await fs.copyFile(new URL('local-automation.mjs', import.meta.url), path.join(output, 'driver-at-launch.mjs'));
const executable = process.env.ASMB_PACKAGED_EXECUTABLE; let metadata = null;
if (executable) {
  const bundle = process.platform === 'linux' ? path.dirname(executable) : executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
  metadata = JSON.parse(await fs.readFile(path.join(bundle, process.platform === 'linux' ? 'resources/app/native-package.json' : 'Contents/Resources/app/native-package.json')));
  if (process.env.ASMB_EXPECTED_SOURCE_COMMIT) assert.equal(metadata.sourceCommit, process.env.ASMB_EXPECTED_SOURCE_COMMIT);
  if (process.env.ASMB_EXPECTED_BUILD_NUMBER) assert.equal(metadata.buildNumber, Number(process.env.ASMB_EXPECTED_BUILD_NUMBER));
}
const home = path.join(output, 'home'), data = metadata?.channel === 'preview' ? path.join(home, 'asMagicBrain') : path.join(output, 'data');
const organization = path.join(data, 'workspaces/asMagicBrain');
const target = metadata?.channel === 'preview' ? {executablePath: executable, args: ['--test-root=' + testBase, '--test-user-home=' + home]} : nativeTarget(data);
let driver, page, connection, live = false, failure; const checks = [], commands = [], reports = [];
const button = name => page.getByRole('button', {name, exact: true});
const dialog = () => page.getByRole('dialog', {name: 'Local automation', exact: true});
const request = (requestId, operation, args = {}) => ({protocolVersion: 1, requestId, operation, args});
async function markedCapture(name) {
  await driver.screenshot(name);
  const areas = await dialog().evaluate(element => [['LA1 · Repository permissions', element.querySelector('table')], ['LA2 · Local connection', element.querySelector('section')], ['LA3 · Reviewed requests', [...element.querySelectorAll('section')].at(-1)]].map(([label, node]) => {const r = node.getBoundingClientRect(); return {label, x: r.x, y: r.y, width: r.width, height: r.height};}));
  await fs.writeFile(path.join(driver.output, name + '-areas.json'), JSON.stringify(areas, null, 2) + '\n');
  await dialog().evaluate((element, areas) => {const overlay = document.createElement('div'); overlay.id = 'automation-qa-overlay'; overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'; for (const [index, area] of areas.entries()) {const box = document.createElement('div'), label = document.createElement('span'), color = ['#6639b0', '#08714c', '#a32638'][index]; box.style.cssText = `position:fixed;left:${area.x}px;top:${area.y}px;width:${area.width}px;height:${area.height}px;border:2px solid ${color};box-sizing:border-box`; label.style.cssText = `position:absolute;top:0;left:0;background:white;color:${color};padding:2px 4px;font:700 11px system-ui;white-space:nowrap`; label.textContent = area.label; box.append(label); overlay.append(box);} element.append(overlay);}, areas);
  try {await driver.screenshot(name + '-annotated');} finally {await page.evaluate(() => document.getElementById('automation-qa-overlay')?.remove());}
}
async function command(input, timeoutMs = 30000) {
  const count = commands.length + 1, requestFile = path.join(output, `request-${count}.json`);
  await fs.writeFile(requestFile, JSON.stringify(input, null, 2) + '\n');
  const args = [...(metadata ? [] : [target.args[0]]), '--automation-cli', '--connection', connection, '--request', requestFile, '--timeout-ms', String(timeoutMs)];
  const result = await new Promise((resolve, reject) => {
    const env = {...process.env}; for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_SANDBOX']) delete env[key];
    const child = spawn(target.executablePath, args, {cwd: output, env, stdio: ['ignore', 'pipe', 'pipe']}); let stdout = '', stderr = '';
    const deadline = setTimeout(() => {child.kill('SIGTERM'); reject(Error('CLI process did not exit after its own bounded timeout'));}, timeoutMs + 30000);
    child.stdout.on('data', bytes => {stdout += bytes;}); child.stderr.on('data', bytes => {stderr += bytes;});
    child.once('error', error => {clearTimeout(deadline); reject(error);}); child.once('close', (code, signal) => {clearTimeout(deadline); resolve({code, signal, stdout, stderr});});
  });
  const lines = result.stdout.trim().split('\n').filter(Boolean); let reply; for (const line of lines) {try {const value = JSON.parse(line); if (value.protocolVersion === 1) reply = value;} catch {}}
  await fs.writeFile(path.join(output, `cli-capture-${count}.json`), JSON.stringify({requestId: input.requestId, code: result.code, signal: result.signal, stdoutBytes: Buffer.byteLength(result.stdout), stdoutSha256: sha(result.stdout), stderrBytes: Buffer.byteLength(result.stderr), completeVersionedJson: Boolean(reply)}, null, 2) + '\n');
  if (!reply) {
    await fs.writeFile(path.join(output, `cli-incomplete-${count}.stdout`), Buffer.from(result.stdout).subarray(0, 2 * 1024 * 1024));
    await fs.writeFile(path.join(output, `cli-incomplete-${count}.stderr`), Buffer.from(result.stderr).subarray(0, 65536));
  }
  assert.ok(reply, 'CLI emits versioned JSON after process and output pipes close'); assert.equal(reply.requestId, input.requestId); assert.equal(reply.ok ? 0 : 1, result.code);
  assert.ok(!Object.hasOwn(reply, 'token')); commands.push({request: input.requestId, operation: input.operation, code: result.code, reply});
  await fs.writeFile(path.join(output, `reply-${count}.json`), JSON.stringify(reply, null, 2) + '\n');
  return reply;
}
async function openAutomation() {await button('Account menu').click(); await page.getByRole('menuitem', {name: 'Local automation', exact: true}).click(); await dialog().waitFor();}
async function enable() {
  for (const scope of ['read', 'write', 'import', 'export']) await page.getByRole('checkbox', {name: `${scope} Workspace`, exact: true}).check();
  await button('Enable for this session').click(); connection = await until(async () => {const text = await dialog().locator('section').filter({has: page.getByRole('heading', {name: 'Connection', exact: true})}).locator('code').textContent().catch(() => null); return text?.startsWith('/') ? text : false;}, {label: 'private connection displayed'});
}
async function approve(requestId) {
  const row = dialog().locator('details').filter({hasText: requestId}); await row.getByRole('button', {name: 'Approve this request', exact: true}).waitFor();
  await row.getByRole('button', {name: 'Approve this request', exact: true}).click();
  await until(async () => (await row.locator('summary').textContent())?.includes('completed'), {timeout: 120000, label: `approved ${requestId} completes`});
}
function assertUnborn(root) {
  const result = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', root, 'rev-parse', '--verify', 'HEAD'], {encoding: 'utf8', env: {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0'}});
  assert.notEqual(result.status, 0, 'Automation never creates a Git commit');
}
async function launch(session) {
  driver = await createDriver({...target, output: path.join(output, `session-${session}`), workspacePath: path.join(organization, 'Workspace')});
  page = await driver.launch(); live = true; await openAutomation();
}
async function close(session) {
  await button('Close local automation').click(); await driver.closeNormally(); live = false;
  assert.deepEqual(driver.errors, []); assert.deepEqual(driver.consoleErrors, []);
  await driver.report({status: 'passed', scope: 'UI grants and review, bundled CLI, normal close'}); reports.push(`session-${session}/receipt.json`);
}
try {
  await launch(1); await enable();
  let reply = await command(request('capabilities', 'capabilities')); assert.equal(reply.ok, true); assert.ok(reply.value.operations.includes('validate')); assert.ok(reply.value.forbidden.includes('artifact.run'));
  reply = await command(request('catalog', 'catalog')); assert.equal(reply.ok, true); assert.deepEqual(reply.value.map(entry => entry.name), ['Workspace']); const repoId = reply.value[0].stableId;
  await markedCapture('permissions-and-connection'); checks.push('A01 actual UI scoped grants, capabilities, catalog');
  const content = '# Automation acceptance\n\nSaved through the reviewed local interface.\n\n$E=mc^2$\n';
  const createRequest = request('create-note', 'write.plan', {repoId, path: 'Automation.md', text: content, expectedHash: null});
  reply = await command(createRequest); assert.equal(reply.ok, true); assert.equal(reply.value.status, 'review'); const createPlan = reply.value;
  assert.equal(await fs.stat(path.join(organization, 'Workspace/Automation.md')).then(() => true, () => false), false);
  await markedCapture('review-write'); await approve('create-note');
  reply = await command(request('read-note', 'read', {repoId, path: 'Automation.md'})); assert.equal(reply.value.text, content); assert.equal(reply.value.sourceHash, sha(content)); assertUnborn(path.join(organization, 'Workspace'));
  const exports = [];
  for (const kind of ['source', 'offline']) {
    const input = request('export-' + kind, 'export.plan', {repoId, kind, collectionId: 'automation-qualification', version: '1'});
    const planned = await command(input); assert.equal(planned.ok, true); assert.equal(planned.value.status, 'review');
    await approve(input.requestId);
    const completed = await command(request('export-status-' + kind, 'status', {operationId: planned.value.operationId}));
    assert.equal(completed.ok, true); assert.equal(completed.value.status, 'completed');
    const result = completed.value.result, bytes = Buffer.from(result.archiveBase64, 'base64'); assert.equal(sha(bytes), result.sha256);
    const {files} = readZipFiles(bytes, {stripRoot: false});
    assert.equal(files.find(file => file.path === (kind === 'offline' ? 'source/' : '') + 'Automation.md')?.bytes.toString(), content);
    if (kind === 'offline') {
      assert.ok(bytes.length > 262144, 'Exercise the font-inclusive export beyond the former API limit');
      assert.ok(files.some(file => file.path.endsWith('KaTeX_Math-Italic.woff2')));
      assert.ok(files.find(file => file.path === 'reader/Automation.md.html')?.bytes.toString().includes('class="katex"'));
    }
    await fs.writeFile(path.join(output, 'cli-' + kind + '.zip'), bytes);
    exports.push({input, operationId: planned.value.operationId, sha256: result.sha256, bytes: bytes.length});
  }
  checks.push('Actual shipped CLI source/offline exports preserve saved bytes and bundled math fonts after explicit review');
  await button('Close local automation').click(); await button('asMagicBrain organization').click(); await button('Open repository Workspace').click();
  await page.getByRole('table', {name: 'Directory contents', exact: true}).getByRole('button', {name: 'Automation.md', exact: true}).click();
  await page.getByRole('heading', {name: 'Automation acceptance', exact: true}).waitFor(); await driver.screenshot('ordinary-reader-saved-note');
  checks.push('A02 ordinary reader displays reviewed saved bytes and unchanged unborn Git history'); await openAutomation();
  const competing = await command(request('competing-editor', 'write.plan', {repoId, path: 'Automation.md', text: '# Must not replace a draft\n', expectedHash: sha(content)})); assert.equal(competing.ok, true);
  await button('Close local automation').click(); await button('Edit this file').click();
  const editor = page.locator('.rfe-source:not([hidden]) .cm-content[contenteditable=true]'); await editor.focus(); await editor.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'); await editor.press('Enter'); await page.keyboard.type('Unsaved competing editor draft');
  await openAutomation(); const competingRow = dialog().locator('details').filter({hasText: 'competing-editor'});
  await competingRow.getByRole('button', {name: 'Approve this request', exact: true}).click(); await dialog().getByRole('alert').waitFor();
  reply = await command(request('competing-status', 'status', {operationId: competing.value.operationId})); assert.equal(reply.value.status, 'review');
  assert.equal(await fs.readFile(path.join(organization, 'Workspace/Automation.md'), 'utf8'), content);
  reply = await command(request('saved-not-draft', 'read', {repoId, path: 'Automation.md'})); assert.equal(reply.value.text, content);
  await driver.screenshot('competing-editor-draft-protected'); await competingRow.getByRole('button', {name: 'Cancel request', exact: true}).click();
  await button('Close local automation').click(); assert.ok((await editor.innerText()).includes('Unsaved competing editor draft'));
  await button('Cancel changes').click(); await page.getByRole('dialog', {name: 'Discard changes?', exact: true}).getByRole('button', {name: 'Discard changes', exact: true}).click();
  await button('Edit this file').waitFor(); assert.equal(await fs.readFile(path.join(organization, 'Workspace/Automation.md'), 'utf8'), content);
  checks.push('A02 real CM6 draft created after automation review blocks approval, remains in editor, and is explicitly discarded only by this test'); await openAutomation();
  const cancelled = await command(request('cancel-note', 'write.plan', {repoId, path: 'Cancelled.md', text: 'Do not publish', expectedHash: null})); assert.equal(cancelled.ok, true);
  await dialog().locator('details').filter({hasText: 'cancel-note'}).getByRole('button', {name: 'Cancel request', exact: true}).click();
  reply = await command(request('cancel-status', 'status', {operationId: cancelled.value.operationId})); assert.equal(reply.value.status, 'cancelled');
  assert.equal(await fs.stat(path.join(organization, 'Workspace/Cancelled.md')).then(() => true, () => false), false); checks.push('A06 cancelled review writes nothing');
  for (const [name, operation, args, error] of [
    ['unrelated', 'read', {repoId: 'unrelated-repo', path: 'README.md'}, 'PERMISSION_DENIED'],
    ['unknown', 'shell.run', {repoId}, 'UNKNOWN_OPERATION'],
    ['no-execute', 'artifact.run', {repoId}, 'UNKNOWN_OPERATION'],
  ]) {reply = await command(request(name, operation, args)); assert.equal(reply.ok, false); assert.equal(reply.error.code, error);}
  reply = await command({...request('protocol-version', 'capabilities'), protocolVersion: 99}); assert.equal(reply.error.code, 'UNSUPPORTED_VERSION');
  for (const relative of ['../outside.md', '.git/config', '.asmb-private/record']) {reply = await command(request('path-' + commands.length, 'read', {repoId, path: relative})); assert.equal(reply.ok, false);}
  reply = await command(request('validate', 'validate', {repoId})); assert.equal(reply.ok, true); assert.equal(reply.value.executionPermitted, false); assert.ok(reply.value.files.some(file => file.path === 'Automation.md' && file.staticPreview === 'markdown-with-math-and-diagram-support'));
  checks.push('A04 private/traversal/unrelated/unknown denied; A05 validation never activates content; A07 actual shipped CLI protocol version refusal');
  const archive = createPackageZip([{path: 'README.md', bytes: Buffer.from('# Neutral import\n')}, ...Array.from({length: 800}, (_, index) => ({path: `notes/note-${String(index).padStart(4, '0')}.md`, bytes: Buffer.from(`# Neutral ${index}\n\nThis is inert imported source.\n`)}))]);
  assert.ok(archive.length < 262144); const importRequest = request('import-once', 'import.plan', {repoId, name: 'AutomationImport', archiveBase64: archive.toString('base64')});
  const firstImport = await command(importRequest, 10); checks.push(firstImport.error?.code === 'TIMEOUT' ? 'A03 actual CLI import-plan timeout observed' : 'A03 import plan completed before 10 ms deadline; timeout not exercised in this native run');
  reply = await command(importRequest); assert.equal(reply.ok, true); assert.equal(reply.value.status, 'review'); const importPlan = reply.value;
  await approve('import-once'); await driver.screenshot('completed-requests'); assertUnborn(path.join(organization, 'AutomationImport'));
  await button('Disconnect tools').click(); reply = await command(request('revoked', 'capabilities')); assert.equal(reply.ok, false); checks.push('A04 disconnect invalidates the old CLI connection');
  await close(1);
  await launch(2); assert.equal(await button('Enable for this session').isVisible(), true); assert.equal(await page.getByRole('checkbox', {name: 'write Workspace', exact: true}).isChecked(), false);
  await enable(); reply = await command(importRequest); assert.equal(reply.value.operationId, importPlan.operationId); assert.equal(reply.value.status, 'completed');
  reply = await command(request('restart-import-status', 'status', {operationId: importPlan.operationId})); assert.equal(reply.value.status, 'completed');
  for (const exported of exports) {
    const status = await command(request('restart-' + exported.input.requestId, 'status', {operationId: exported.operationId}));
    assert.equal(status.ok, true); assert.equal(status.value.status, 'completed');
    assert.equal(sha(Buffer.from(status.value.result.archiveBase64, 'base64')), exported.sha256);
    const repeated = await command(exported.input); assert.equal(repeated.value.operationId, exported.operationId);
    assert.equal(repeated.value.result.sha256, exported.sha256);
  }
  checks.push('Both export results survive normal restart and same-ID queries without regeneration or replay');
  reply = await command(request('changed-token', 'status', {operationId: createPlan.operationId})); assert.equal(reply.value.status, 'completed');
  reply = await command({...importRequest, args: {...importRequest.args, name: 'DuplicateImport'}}); assert.equal(reply.error.code, 'REQUEST_CONFLICT');
  const repositories = await fs.readdir(organization); assert.equal(repositories.filter(name => name === 'AutomationImport').length, 1); assert.ok(!repositories.includes('DuplicateImport')); assertUnborn(path.join(organization, 'AutomationImport'));
  assert.equal(await fs.readFile(path.join(organization, 'Workspace/Automation.md'), 'utf8'), content); checks.push('A03 exactly one import and durable status after normal quit/restart; changed payload rejected; fresh grants required');
  await driver.screenshot('restarted-operation-status'); await close(2);
} catch (error) {failure = String(error?.stack ?? error); if (live) {try {await driver.screenshot('failure');} catch {}}}
finally {
  if (live) {try {if (await button('Close local automation').isVisible()) await button('Close local automation').click(); await driver.closeNormally(); live = false;} catch (error) {failure ??= String(error);}}
  if (failure && driver) await driver.report({status: 'failed', failure});
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify({status: failure ? 'failed' : 'passed', failure, platform: process.platform, architecture: process.arch, metadata, sourceOnly: !metadata,
    driverSha256: sha(await fs.readFile(new URL('local-automation.mjs', import.meta.url))), checks, commands, reports,
    limits: 'Saved-file CAS and storage interruption have separate native host unit evidence. The native competing-draft step deliberately discards only its own disposable draft after verifying protection. No imported script execution, live account, remote mutation or implicit commit.'}, null, 2) + '\n');
}
if (failure) throw Error(failure); console.log(JSON.stringify({status: 'passed', output, checks}));
