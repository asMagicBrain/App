import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID, randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {testRoot} from '../../tools/development-paths.mjs';
import {createPackageZip} from '../../packages/desktop-host/src/package-exchange/archive.mjs';
import {readZipFiles} from '../../packages/desktop-host/src/zip-import/index.mjs';
import {AUTOMATION_LIMITS} from './automation-limits.mjs';
import {createNativeService} from './host-service.mjs';

const base = path.join(testRoot, 'runs/stage4-automation-host-unit'); fs.mkdirSync(base, {recursive: true});
const hash = text => createHash('sha256').update(text).digest('hex');
async function fixture(t, options = {}) {
  const parent = fs.mkdtempSync(path.join(base, 'managed-')), dataRoot = path.join(parent, 'profile');
  let service = await createNativeService({dataRoot, ...options}); t.after(async () => service.close());
  const source = path.join(dataRoot, 'workspaces/asMagicBrain/Workspace');
  const repoId = (await service.catalog()).repositories.find(entry => entry.name === 'Workspace').stableId;
  return {parent, dataRoot, source, repoId, get service() {return service;}, async restart() {await service.close(); service = await createNativeService({dataRoot, ...options});},
    grants: (scopes = ['read', 'write', 'import', 'export']) => service.setAutomationGrants({enabled: true, grants: [{repoId, scopes}]}),
    automation: (requestId, operation, args = {}) => service.automationRequest({requestId, operation, args}),
    request: (operation, args = {}) => service.request({repo: 'Workspace', operation, args}),
    write: (requestId, relative, text, expectedHash = null) => service.automationRequest({requestId, operation: 'write.plan', args: {repoId, path: relative, expectedHash, text}}),
    approve: plan => service.approveAutomation({operationId: plan.operationId, digest: plan.digest}),
  };
}
function assertUnborn(root) {
  const result = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', root, 'rev-parse', '--verify', 'HEAD'], {encoding: 'utf8', env: {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0'}});
  assert.notEqual(result.status, 0, 'automation must not create a Git commit');
}

test('native automation admits only explicitly granted repositories and saved text', async t => {
  const f = await fixture(t); fs.writeFileSync(path.join(f.source, 'note.md'), '# Saved\n');
  await assert.rejects(f.automation('off', 'catalog'), {code: 'PERMISSION_DENIED'});
  await f.service.createRepository({name: 'Other', requestId: randomUUID()});
  const other = (await f.service.catalog()).repositories.find(entry => entry.name === 'Other'); await f.grants(['read']);
  assert.deepEqual((await f.automation('catalog', 'catalog')).map(entry => entry.name), ['Workspace']);
  const read = await f.automation('read', 'read', {repoId: f.repoId, path: 'note.md'});
  assert.equal(read.text, '# Saved\n'); assert.equal(read.sourceHash, hash(read.text)); assert.equal(read.source, 'saved');
  await assert.rejects(f.automation('other', 'read', {repoId: other.stableId, path: 'README.md'}), {code: 'PERMISSION_DENIED'});
  await assert.rejects(f.write('write-off', 'new.md', 'No'), {code: 'PERMISSION_DENIED'});
  for (const relative of ['../outside.md', '.git/config', '.asmb-private/state']) await assert.rejects(f.automation(`bad-${randomUUID()}`, 'read', {repoId: f.repoId, path: relative}));
  for (const operation of ['delete', 'commit', 'push', 'credentials', 'artifact.run', 'shell.run']) await assert.rejects(f.automation(`unknown-${randomUUID()}`, operation, {repoId: f.repoId}), {code: 'UNKNOWN_OPERATION'});
  await f.service.setAutomationGrants({enabled: false, grants: []}); await assert.rejects(f.automation('revoked', 'read', {repoId: f.repoId, path: 'note.md'}), {code: 'PERMISSION_DENIED'});
});

test('native reviewed write uses ordinary saved files, stays idempotent and never commits', async t => {
  const f = await fixture(t); await f.grants(); assertUnborn(f.source);
  const original = '# Automation\n\n$E=mc^2$\n', plans = await Promise.all(Array.from({length: 5}, () => f.write('create-one', 'notes/neutral.md', original)));
  const plan = plans[0]; assert.equal(new Set(plans.map(item => item.operationId)).size, 1); assert.equal(fs.existsSync(path.join(f.source, 'notes/neutral.md')), false);
  const result = await f.approve(plan); assert.equal(result.status, 'completed');
  const opened = await f.request('open', {path: 'notes/neutral.md'}); assert.equal(opened.text, original); assert.equal(opened.sourceHash, hash(original)); assertUnborn(f.source);
  assert.equal((await f.write('create-one', 'notes/neutral.md', original)).operationId, plan.operationId);
  assert.equal((await f.approve(plan)).status, 'completed');
  await assert.rejects(f.write('create-one', 'notes/neutral.md', 'Different'), {code: 'REQUEST_CONFLICT'});
  const update = await f.write('update-one', 'notes/neutral.md', '# Updated\n', opened.sourceHash); await f.approve(update);
  assert.equal((await f.request('open', {path: 'notes/neutral.md'})).text, '# Updated\n'); assertUnborn(f.source);
  await f.restart(); await assert.rejects(f.automation('restart-off', 'status', {operationId: plan.operationId}), {code: 'PERMISSION_DENIED'});
  await f.grants(); assert.equal((await f.automation('restart-on', 'status', {operationId: plan.operationId})).status, 'completed');
  assert.equal((await f.write('create-one', 'notes/neutral.md', original)).status, 'completed'); assert.equal(fs.readFileSync(path.join(f.source, 'notes/neutral.md'), 'utf8'), '# Updated\n'); assertUnborn(f.source);
});

test('drafts before or after review, saved conflicts and cancelled plans cannot overwrite files', async t => {
  const f = await fixture(t); await f.grants(); fs.writeFileSync(path.join(f.source, 'note.md'), '# Original\n');
  const opened = await f.request('open', {path: 'note.md'}), plan = await f.write('draft-after', 'note.md', '# Requested\n', opened.sourceHash);
  await f.request('checkpoint', {path: 'note.md', baseHash: opened.sourceHash, text: '# Private draft\n'});
  await assert.rejects(f.approve(plan), {code: 'DRAFT_CONFLICT'});
  await assert.rejects(f.write('draft-before', 'note.md', '# Requested\n', opened.sourceHash), {code: 'DRAFT_CONFLICT'});
  assert.equal(fs.readFileSync(path.join(f.source, 'note.md'), 'utf8'), '# Original\n'); assert.equal((await f.request('open', {path: 'note.md'})).draft.text, '# Private draft\n');
  await f.restart(); await f.grants(); await assert.rejects(f.write('retained-draft', 'note.md', 'No', opened.sourceHash), {code: 'DRAFT_CONFLICT'});
  const fresh = await f.write('external-change', 'other.md', '# Planned\n'); fs.writeFileSync(path.join(f.source, 'other.md'), '# External\n');
  await assert.rejects(f.approve(fresh), {code: 'CONFLICT'}); assert.equal(fs.readFileSync(path.join(f.source, 'other.md'), 'utf8'), '# External\n');
  const cancel = await f.write('cancelled', 'cancelled.md', 'Do not save'); await f.service.cancelAutomation({operationId: cancel.operationId});
  await assert.rejects(f.approve(cancel), {code: 'OPERATION_NOT_REVIEWABLE'}); assert.equal(fs.existsSync(path.join(f.source, 'cancelled.md')), false); assertUnborn(f.source);
});

test('approved neutral ZIP import survives a lost response and restart without duplication or Git commits', async t => {
  const f = await fixture(t); await f.grants();
  const bytes = createPackageZip([{path: 'README.md', bytes: Buffer.from('# Imported neutral example\n')}, {path: 'interactive/demo.html', bytes: Buffer.from('<button onclick="document.body.dataset.clicked=1">Local only</button>')}]);
  const args = {repoId: f.repoId, name: 'NeutralImport', archiveBase64: bytes.toString('base64')};
  const plan = await f.automation('import-once', 'import.plan', args); assert.equal(fs.existsSync(path.join(f.dataRoot, 'workspaces/asMagicBrain/NeutralImport')), false);
  // Deliberately ignore the successful response, as a disconnected client would.
  await f.approve(plan); await f.restart(); await f.grants();
  const retry = await f.automation('import-once', 'import.plan', args); assert.equal(retry.status, 'completed'); assert.equal(retry.operationId, plan.operationId);
  assert.equal((await f.automation('import-status', 'status', {operationId: plan.operationId})).status, 'completed');
  const catalog = (await f.service.catalog()).repositories; assert.equal(catalog.filter(entry => entry.name === 'NeutralImport').length, 1);
  const imported = path.join(f.dataRoot, 'workspaces/asMagicBrain/NeutralImport'); assert.equal(fs.readFileSync(path.join(imported, 'README.md'), 'utf8'), '# Imported neutral example\n'); assertUnborn(imported);
  assert.deepEqual(fs.readFileSync(path.join(imported, 'interactive/demo.html')), Buffer.from('<button onclick="document.body.dataset.clicked=1">Local only</button>'));
  await assert.rejects(f.automation('import-once', 'import.plan', {...args, name: 'DuplicateImport'}), {code: 'REQUEST_CONFLICT'});
  assert.equal(fs.existsSync(path.join(f.dataRoot, 'workspaces/asMagicBrain/DuplicateImport')), false);
  for (const name of [null, '../escape', 'bad/name', '']) await assert.rejects(f.automation(`malformed-${randomUUID()}`, 'import.plan', {...args, name}), {code: 'INVALID_REQUEST'});
});

test('missing-file planning never bypasses physical paths, aliases, case collisions or request limits', async t => {
  const f = await fixture(t); await f.grants(); const outside = path.join(f.parent, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'untouched.md'), 'Outside stays unchanged'); fs.symlinkSync(outside, path.join(f.source, 'alias'));
  for (const relative of ['alias/new.md', '../outside/new.md', '.git/new.md', '.asmb-private/new.md']) await assert.rejects(f.write(`denied-${randomUUID()}`, relative, 'No'), error => typeof error.code === 'string');
  assert.deepEqual(fs.readdirSync(outside), ['untouched.md']); fs.unlinkSync(path.join(f.source, 'alias'));
  fs.mkdirSync(path.join(f.source, 'CaseFolder'));
  await assert.rejects(f.write('case-alias', 'casefolder/new.md', 'No'), error => typeof error.code === 'string');
  assert.deepEqual(fs.readdirSync(path.join(f.source, 'CaseFolder')), []);
  await assert.rejects(f.write('too-big', 'large.md', 'x'.repeat(65537)), {code: 'LIMIT_EXCEEDED'});
  await assert.rejects(f.automation('extra-authority', 'write.plan', {repoId: f.repoId, path: 'safe.md', text: 'No', expectedHash: null, root: outside}), {code: 'INVALID_REQUEST'});
  assert.equal(fs.existsSync(path.join(f.source, 'safe.md')), false); assertUnborn(f.source);
});

test('package and export automation persist admitted review schemas and use the shared host service', async t => {
  const f = await fixture(t); await f.grants(); const baseText = '# Package base\n'; fs.writeFileSync(path.join(f.source, 'note.md'), baseText);
  const baseBytes = createPackageZip([{path: 'note.md', bytes: Buffer.from(baseText)}]);
  const basePlan = await f.service.reviewPackageBase({repo: 'Workspace', bytes: baseBytes, collectionId: 'automation-neutral', version: '1'});
  await f.service.registerPackageBase({repo: 'Workspace', planId: basePlan.planId});
  const incoming = createPackageZip([{path: 'note.md', bytes: Buffer.from('# Package updated\n')}, {path: 'added.md', bytes: Buffer.from('# New package note\n')}]);
  const plan = await f.automation('package-update', 'package.plan', {repoId: f.repoId, archiveBase64: incoming.toString('base64'), semantics: 'patch', version: '2', choices: [{path: 'note.md', choice: 'use-incoming'}, {path: 'added.md', choice: 'use-incoming'}]});
  assert.equal(plan.status, 'review'); await f.approve(plan); assert.equal(fs.readFileSync(path.join(f.source, 'note.md'), 'utf8'), '# Package updated\n'); assertUnborn(f.source);
  const exports = [];
  for (const kind of ['source', 'offline']) {
    const exporting = await f.automation(`export-${kind}`, 'export.plan', {repoId: f.repoId, kind, collectionId: 'automation-neutral', version: '2'});
    const result = await f.approve(exporting), bytes = Buffer.from(result.result.archiveBase64, 'base64');
    assert.equal(result.status, 'completed'); assert.equal(hash(bytes), result.result.sha256); assert.match(result.result.filename, new RegExp(`-${kind}\\.zip$`));
    exports.push({operationId: exporting.operationId, result: result.result});
    if(kind==='offline'){
      assert.ok(bytes.length>262144 && bytes.length<=AUTOMATION_LIMITS.exportArchiveBytes,'real self-contained fonts exceed the former cap but fit the bounded export');
      const {files}=readZipFiles(bytes);
      assert.ok(files.some(file=>file.path==='reader-assets/katex/katex.min.css'));
      assert.equal(files.filter(file=>/^reader-assets\/katex\/fonts\/.*\.(?:woff2?|ttf)$/.test(file.path)).length,60);
    }
  }
  await f.restart(); await f.grants(); const status = await f.automation('package-after-restart', 'status', {operationId: plan.operationId}); assert.equal(status.status, 'completed'); assertUnborn(f.source);
  for(const [index,exported]of exports.entries()){
    const retained=await f.automation(`export-status-${index}`,'status',{operationId:exported.operationId});
    assert.equal(retained.status,'completed');assert.deepEqual(retained.result,exported.result,'restart returns the same retained archive, never regenerates it');
  }
});

test('oversized automation export fails durably without blocking ordinary work or raising input limits', async t => {
  const f=await fixture(t);await f.grants();fs.writeFileSync(path.join(f.source,'large.bin'),randomBytes(AUTOMATION_LIMITS.exportArchiveBytes+1));
  const plan=await f.automation('oversized-export','export.plan',{repoId:f.repoId,kind:'source',collectionId:'bounded',version:'1'});
  await assert.rejects(f.approve(plan),{code:'LIMIT_EXCEEDED'});
  assert.equal((await f.automation('failed-export','status',{operationId:plan.operationId})).status,'failed');
  assert.equal((await f.service.getAutomationStatus()).enabled,true);assertUnborn(f.source);
  const before=hash(fs.readFileSync(path.join(f.source,'large.bin')));
  await f.restart();await f.grants();assert.equal((await f.automation('failed-restart','status',{operationId:plan.operationId})).status,'failed');
  assert.equal(hash(fs.readFileSync(path.join(f.source,'large.bin'))),before);
  await f.approve(await f.write('ordinary-after-export','after.md','# Still available\n'));
  await assert.rejects(f.write('write-limit','too-big.md','x'.repeat(65537)),{code:'LIMIT_EXCEEDED'});
  await assert.rejects(f.automation('import-limit','import.plan',{repoId:f.repoId,name:'TooBig',archiveBase64:Buffer.alloc(262145).toString('base64')}),{code:'LIMIT_EXCEEDED'});
});

for (const injection of ['exchange-after-step', 'exchange-after-complete']) test(`native package automation reconciles ${injection} through shared durable identity after restart`, async t => {
  let injected = false;
  const f = await fixture(t, {hooks: {packageAt(point) {if (!injected && point === injection) {injected = true; throw Object.assign(Error('Synthetic interruption'), {code: 'EIO'});}}}});
  await f.grants(); const baseText = '# Original package\n'; fs.writeFileSync(path.join(f.source, 'note.md'), baseText);
  const baseBytes = createPackageZip([{path: 'note.md', bytes: Buffer.from(baseText)}]);
  const registration = await f.service.reviewPackageBase({repo: 'Workspace', bytes: baseBytes, collectionId: 'recovery-neutral', version: '1'}); await f.service.registerPackageBase({repo: 'Workspace', planId: registration.planId});
  const incoming = createPackageZip([{path: 'note.md', bytes: Buffer.from('# Updated package\n')}, {path: 'added.md', bytes: Buffer.from('# Added package\n')}]);
  const args = {repoId: f.repoId, archiveBase64: incoming.toString('base64'), semantics: 'patch', version: '2', choices: [{path: 'note.md', choice: 'use-incoming'}, {path: 'added.md', choice: 'use-incoming'}]};
  const plan = await f.automation('recover-once', 'package.plan', args); await assert.rejects(f.approve(plan), {code: 'EIO'}); assert.equal(injected, true);
  await f.restart(); await f.grants();
  let status = await f.automation('recovery-status', 'status', {operationId: plan.operationId});
  if (injection === 'exchange-after-step') {
    assert.equal(status.status, 'applying'); const pending = await f.service.packageStatus({repo: 'Workspace'}); assert.equal(pending.pending.operationId, plan.operationId);
    assert.equal((await f.automation('recover-once', 'package.plan', args)).status, 'applying'); assert.equal((await f.service.getAutomationStatus()).operations[0].status, 'applying');
    await f.service.recoverPackageUpdate({repo: 'Workspace', operationId: plan.operationId, direction: 'resume'});
    status = await f.automation('resumed-status', 'status', {operationId: plan.operationId});
  }
  assert.equal(status.status, 'completed'); assert.equal(status.result.operationId, plan.operationId);
  assert.equal((await f.automation('recover-once', 'package.plan', args)).status, 'completed');
  const packageStatus = await f.service.packageStatus({repo: 'Workspace'}); assert.equal(packageStatus.operations.length, 1); assert.equal(packageStatus.operations[0].operationId, plan.operationId); assert.equal(packageStatus.recoveryRequired, false);
  assert.equal(fs.readFileSync(path.join(f.source, 'note.md'), 'utf8'), '# Updated package\n'); assert.equal(fs.readFileSync(path.join(f.source, 'added.md'), 'utf8'), '# Added package\n'); assertUnborn(f.source);
});
