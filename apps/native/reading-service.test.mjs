import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {testRoot} from '../../tools/development-paths.mjs';
import {createNativeService} from './host-service.mjs';
const base = path.join(testRoot, 'runs/stage4-reading-host-unit'); fs.mkdirSync(base, {recursive: true});
const hash = text => createHash('sha256').update(text).digest('hex');
const measured = '\ufeff# Measured\r\n\r\nMeasured 30 Hz on build demo-1.\r\n';
const planned = '# Planned\n\nTarget 60 Hz; not measured on build demo-2.\n';
const metadata = () => ({schemaVersion: 1, collectionId: 'neutral.engineering', documents: [
  {id: 'measured', path: 'evidence/v1.md', evidence: {observationDate: '2026-09-22', build: 'demo-1', kind: 'measurement', validation: 'measured', scope: 'Synthetic 30 Hz example'}, targets: [{id: 'measurement', kind: 'block', sourceHash: hash(measured), from: measured.indexOf('Measured 30'), to: measured.length}]},
  {id: 'planned', path: 'evidence/v2.md', evidence: {build: 'demo-2', kind: 'planned-target', validation: 'not-measured', supersedes: 'measured'}},
]});
async function fixture(t) {
  const parent = fs.mkdtempSync(path.join(base, 'managed-')), dataRoot = path.join(parent, 'profile');
  let service = await createNativeService({dataRoot}); t.after(async () => service.close());
  const source = path.join(dataRoot, 'workspaces/asMagicBrain/Workspace'); fs.mkdirSync(path.join(source, 'evidence'));
  fs.writeFileSync(path.join(source, 'evidence/v1.md'), measured); fs.writeFileSync(path.join(source, 'evidence/v2.md'), planned);
  fs.writeFileSync(path.join(source, 'asmagicbrain.collection.json'), JSON.stringify(metadata()));
  return {parent, dataRoot, source, get service() {return service;}, async restart() {await service.close(); service = await createNativeService({dataRoot});}, request: (operation, args = {}, repo = 'Workspace') => service.request({repo, operation, args})};
}
const reference = (documentId = 'measured', extra = {}) => ({schemaVersion: 1, collectionId: 'neutral.engineering', documentId, ...extra});
const location = (repoId, relative, extra = {}) => ({schemaVersion: 1, repoId, repo: 'Workspace', ref: '', path: relative, type: 'file', mode: 'preview', editing: false, selection: {anchor: 4, head: 8}, scroll: {main: 140, source: 80, preview: 55}, ...extra});
test('native evidence/reference reads exact saved bytes and preserve private drafts and semantic declarations', async t => {
  const f = await fixture(t), opened = await f.request('open', {path: 'evidence/v1.md'});
  await f.request('checkpoint', {path: opened.path, baseHash: opened.sourceHash, text: measured + 'Unsaved private edit\r\n'});
  const evidence = await f.service.getReadingEvidence({repo: 'Workspace', path: opened.path, ref: ''});
  assert.equal(evidence.evidence.validation, 'measured'); assert.equal(evidence.evidence.build, 'demo-1'); assert.match(evidence.message, /not independently verified/);
  const other = await f.service.getReadingEvidence({repo: 'Workspace', path: 'evidence/v2.md', ref: ''}); assert.equal(other.evidence.validation, 'not-measured');
  const pinned = await f.service.getReadingReference({repo: 'Workspace', path: opened.path, ref: ''}); assert.equal(pinned.reference.sourceHash, hash(measured));
  const resolved = await f.service.resolveReadingReference({reference: reference('measured', {targetId: 'measurement', sourceHash: hash(measured)})});
  assert.equal(resolved.status, 'resolved'); assert.equal(resolved.sourceHash, hash(measured)); assert.equal(resolved.target.from, measured.slice(0, measured.indexOf('Measured 30')).replace(/^\ufeff/, '').replaceAll('\r\n', '\n').length);
  assert.equal((await f.request('open', {path: opened.path})).draft.text, measured + 'Unsaved private edit\r\n'); assert.equal(fs.readFileSync(path.join(f.source, opened.path), 'utf8'), measured);
});
test('managed folder and repeated file rename preserve declared identity through restart without rewriting metadata', async t => {
  const f = await fixture(t), before = fs.readFileSync(path.join(f.source, 'asmagicbrain.collection.json'));
  const entry = await f.request('inspectEntry', {path: 'evidence'});
  await f.request('manage', {operation: 'move', items: [{path: 'evidence', newPath: 'reports', token: entry.token}]});
  let result = await f.service.resolveReadingReference({reference: reference()}); assert.equal(result.status, 'resolved'); assert.equal(result.path, 'reports/v1.md'); assert.equal(result.redirected, true);
  const file = await f.request('open', {path: 'reports/v1.md'});
  await f.request('rename', {path: file.path, newPath: 'reports/renamed.md', baseHash: file.sourceHash});
  await f.restart(); result = await f.service.resolveReadingReference({reference: reference()}); assert.equal(result.status, 'resolved'); assert.equal(result.path, 'reports/renamed.md');
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'asmagicbrain.collection.json')), before);
  fs.renameSync(path.join(f.source, result.path), path.join(f.source, 'reports/external.md'));
  result = await f.service.resolveReadingReference({reference: reference()}); assert.equal(result.status, 'missing'); assert.match(result.message, /external rename/);
});
test('portable collection duplicates require explicit local identity and repository rename preserves stable ID', async t => {
  const f = await fixture(t); const first = (await f.service.catalog()).repositories.find(entry => entry.name === 'Workspace');
  await f.service.createRepository({name: 'Copy', requestId: crypto.randomUUID()});
  const copy = path.join(f.dataRoot, 'workspaces/asMagicBrain/Copy'); fs.mkdirSync(path.join(copy, 'evidence'));
  for (const relative of ['evidence/v1.md', 'evidence/v2.md', 'asmagicbrain.collection.json']) fs.copyFileSync(path.join(f.source, relative), path.join(copy, relative));
  let result = await f.service.resolveReadingReference({reference: reference()}); assert.equal(result.status, 'ambiguous'); assert.equal(result.candidates.length, 2);
  result = await f.service.resolveReadingReference({reference: reference(), repoId: first.stableId}); assert.equal(result.status, 'resolved'); assert.equal(result.repo, 'Workspace');
  await f.service.renameRepository({repository: 'Workspace', name: 'Renamed'}); await f.restart();
  assert.equal((await f.service.catalog()).repositories.find(entry => entry.name === 'Renamed').stableId, first.stableId);
  result = await f.service.resolveReadingReference({reference: reference(), repoId: first.stableId}); assert.equal(result.status, 'resolved'); assert.equal(result.repo, 'Renamed');
});
test('immutable commit/hash pin survives working changes and unavailable versions never substitute working bytes', async t => {
  const f = await fixture(t); const git = args => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', f.source, ...args], {encoding: 'utf8', env: {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0'}}).trim();
  git(['add', '--', 'asmagicbrain.collection.json', 'evidence/v1.md', 'evidence/v2.md']); git(['-c', 'user.name=Neutral Test', '-c', 'user.email=neutral@example.invalid', 'commit', '-m', 'Synthetic evidence']);
  const revision = git(['rev-parse', 'HEAD']); fs.writeFileSync(path.join(f.source, 'evidence/v1.md'), '# Different working bytes\n');
  let result = await f.service.resolveReadingReference({reference: reference('measured', {revision, sourceHash: hash(measured)})}); assert.equal(result.status, 'resolved'); assert.equal(result.sourceHash, hash(measured)); assert.equal(result.revision, revision);
  result = await f.service.resolveReadingReference({reference: reference('measured', {sourceHash: hash(measured)})}); assert.equal(result.status, 'changed');
  result = await f.service.resolveReadingReference({reference: reference('measured', {revision: 'f'.repeat(40), sourceHash: hash(measured)})}); assert.equal(result.status, 'version-unavailable');
  assert.equal(fs.readFileSync(path.join(f.source, 'evidence/v1.md'), 'utf8'), '# Different working bytes\n');
});
test('history is successful-only, draft-independent, stable-ID-bound and session-only', async t => {
  const f = await fixture(t), repoId = (await f.service.catalog()).repositories[0].stableId;
  const first = location(repoId, 'evidence/v1.md'), second = location(repoId, 'evidence/v2.md', {mode: 'split', editing: true});
  await f.service.readingHistory({operation: 'visit', location: first}); await f.service.readingHistory({operation: 'checkpoint', location: {...first, scroll: {main: 900, source: 800, preview: 700}}});
  await assert.rejects(f.service.readingHistory({operation: 'visit', location: location(repoId, 'missing.md')})); assert.equal((await f.service.readingHistory({operation: 'state'})).count, 1);
  await assert.rejects(f.service.readingHistory({operation: 'visit', location: {...second, repoId: 'not-this-repo'}}), {code: 'REPOSITORY_CHANGED'});
  await f.service.readingHistory({operation: 'visit', location: second}); const back = await f.service.readingHistory({operation: 'peek', direction: -1}); assert.equal(back.location.scroll.main, 900);
  await f.service.readingHistory({operation: 'complete', token: back.token, location: back.location}); assert.equal((await f.service.readingHistory({operation: 'state'})).forward, true);
  await f.restart(); assert.deepEqual(await f.service.readingHistory({operation: 'state'}), {back: false, forward: false, count: 0, index: -1});
});
test('malformed/unknown metadata, duplicate IDs and missing exact targets leave Markdown available', async t => {
  const f = await fixture(t); for (const raw of ['{bad', JSON.stringify({...metadata(), schemaVersion: 99}), 'x'.repeat(65537)]) {
    fs.writeFileSync(path.join(f.source, 'asmagicbrain.collection.json'), raw); const context = await f.service.getReadingEvidence({repo: 'Workspace', path: 'evidence/v1.md', ref: ''}); assert.ok(['invalid', 'unsupported'].includes(context.status)); assert.equal((await f.service.read({repo: 'Workspace', path: 'evidence/v1.md'})).content, measured);
  }
  const duplicated = metadata(); duplicated.documents[1].id = 'measured'; fs.writeFileSync(path.join(f.source, 'asmagicbrain.collection.json'), JSON.stringify(duplicated));
  assert.equal((await f.service.getReadingEvidence({repo: 'Workspace', path: 'evidence/v1.md', ref: ''})).status, 'ambiguous');
  fs.writeFileSync(path.join(f.source, 'asmagicbrain.collection.json'), JSON.stringify(metadata()));
  assert.equal((await f.service.resolveReadingReference({reference: reference('measured', {targetId: 'does-not-exist'})})).status, 'missing');
  for (const relative of ['../outside', '.git/config', '.asmb-reading/state']) await assert.rejects(async () => f.service.getReadingEvidence({repo: 'Workspace', path: relative, ref: ''}));
});
