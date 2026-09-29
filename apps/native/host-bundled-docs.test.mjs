import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createNativeService} from './host-service.mjs';
import {createBundledDocsManifest} from './bundled-docs-manifest.mjs';

async function fixture(t, {withDocs = true} = {}) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'host-docs-'));
  assert(parent.includes('/asMagicBrain-Test/'));
  const dataRoot = path.join(parent, 'profile'), payload = path.join(parent, 'payload');
  fs.mkdirSync(payload, {mode: 0o700}); fs.writeFileSync(path.join(payload, 'README.md'), '# Bundled user guide\n');
  let bundledDocs = withDocs ? {root: payload, manifest: createBundledDocsManifest(payload, '0.2.10')} : undefined;
  const revealed = [];
  let service = await createNativeService({dataRoot, bundledDocs, revealInFileManager: value => revealed.push(value)});
  t.after(async () => service.close());
  return {dataRoot, payload, revealed, get service() {return service;}, root: name => path.join(dataRoot, 'workspaces/asMagicBrain', name),
    async restart({version = '0.2.10', text} = {}) {
      await service.close();
      if (text !== undefined) fs.writeFileSync(path.join(payload, 'README.md'), text);
      bundledDocs = {root: payload, manifest: createBundledDocsManifest(payload, version)};
      service = await createNativeService({dataRoot, bundledDocs, revealInFileManager: value => revealed.push(value)});
    },
  };
}
const request = (service, repo, operation, args = {}) => service.request({repo, operation, args});
const create = (service, name) => service.createRepository({name, requestId: randomUUID()});
const docs = 'asMagicBrain-Docs';

test('documentation is last after creation, pinned repositories, rename and restart; read, reveal and local Git work', async t => {
  const f = await fixture(t); await create(f.service, 'Zulu'); await create(f.service, 'Alpha');
  await f.service.setRepositoryPinned({repo: 'Zulu', pinned: true});
  await f.service.renameRepository({repository: 'Workspace', name: 'Writing'});
  const rows = (await f.service.catalog()).repositories;
  assert.deepEqual(rows.map(item => item.name), ['Writing', 'Alpha', 'Zulu', docs]);
  const docsId = rows.at(-1).stableId; assert.match(docsId, /^[a-f0-9]{64}$/);
  assert.deepEqual(rows.at(-1), {name: docs, stableId: docsId, privateRepo: false, builtin: 'documentation', readOnly: true});
  assert.equal(new Set(rows.map(item => item.stableId)).size, rows.length);
  assert.equal((await f.service.bootstrap(docs)).readOnly, true);
  assert.equal((await request(f.service, docs, 'open', {path: 'README.md'})).readOnly, true);
  assert.equal((await f.service.read({repo: docs, path: 'README.md'})).content, '# Bundled user guide\n');
  const git = await request(f.service, docs, 'gitInspect'); assert.match(git.head, /^[a-f0-9]{40}$/);
  await f.service.revealItem({repo: docs, path: 'README.md'}); assert.equal(f.revealed[0], path.join(f.root(docs), 'README.md'));
  await f.restart(); const reopenedRows = (await f.service.catalog()).repositories; assert.deepEqual(reopenedRows.map(item => item.name), ['Writing', 'Alpha', 'Zulu', docs]);
  assert.equal(reopenedRows.at(-1).stableId, docsId, 'Documentation identity survives reopening');
  assert.deepEqual((await f.service.getRepositoryPins()).pinnedRepositories, ['Writing', 'Zulu']);
});

test('host denies documentation mutations even when renderer requests them directly; Duplicate creates an editable independent repository', async t => {
  const f = await fixture(t), original = fs.readFileSync(path.join(f.root(docs), 'README.md'));
  for (const operation of ['checkpoint', 'save', 'create', 'rename', 'discard', 'createFolder', 'manage', 'restore', 'reconcile', 'checkpointNew', 'discardNew', 'gitInitialize', 'gitCommit', 'setCommitPreferences']) {
    await assert.rejects(request(f.service, docs, operation, {}), {code: 'DOCS_READ_ONLY'}, operation);
  }
  await assert.rejects(f.service.renameRepository({repository: docs, name: 'Renamed'}), {code: 'DOCS_READ_ONLY'});
  await assert.rejects(f.service.trashRepository({repository: docs, requestId: randomUUID()}), {code: 'DOCS_READ_ONLY'});
  await assert.rejects(f.service.setRepositoryPinned({repo: docs, pinned: true}), {code: 'DOCS_READ_ONLY'});
  const external = path.join(f.payload, 'README.md'); const sources = await f.service.prepareExternalFiles([external]);
  await assert.rejects(f.service.importExternalFiles({repo: docs, destination: '', sources}), {code: 'DOCS_READ_ONLY'});
  assert.deepEqual(fs.readFileSync(path.join(f.root(docs), 'README.md')), original);
  await f.service.duplicateRepository({repository: docs, name: 'My-Docs', requestId: randomUUID()});
  const copied = (await f.service.catalog()).repositories.find(item => item.name === 'My-Docs'); assert.equal(copied.builtin, undefined); assert.equal(copied.readOnly, undefined);
  const opened = await request(f.service, 'My-Docs', 'open', {path: 'README.md'}); assert.equal(opened.readOnly, false);
  await request(f.service, 'My-Docs', 'save', {path: 'README.md', baseHash: opened.sourceHash, text: 'My editable notes\n'});
  assert.deepEqual(fs.readFileSync(path.join(f.root(docs), 'README.md')), original);
  await f.restart(); assert.equal((await f.service.catalog()).repositories.at(-1).name, docs);
  assert.equal((await f.service.read({repo: 'My-Docs', path: 'README.md'})).content, 'My editable notes\n');
});

test('user repository with documentation name stays editable, preserves drafts and is not classified as builtin', async t => {
  const f = await fixture(t, {withDocs: false});
  await create(f.service, docs);
  const saved = await request(f.service, docs, 'create', {path: 'mine.md', text: 'user bytes'});
  await request(f.service, docs, 'checkpoint', {path: 'mine.md', baseHash: saved.sourceHash, text: 'private draft'});
  await f.restart(); const rows = (await f.service.catalog()).repositories;
  assert.deepEqual(rows.map(item => item.name), ['Workspace', docs, `${docs}-2`]);
  assert.equal(rows[1].builtin, undefined); assert.equal(rows[2].builtin, 'documentation');
  assert.equal((await request(f.service, docs, 'open', {path: 'mine.md'})).draft.text, 'private draft');
  await f.service.renameRepository({repository: docs, name: 'My-existing-docs'});
  await f.restart(); assert.equal((await f.service.catalog()).repositories.at(-1).name, `${docs}-2`);
});

test('documentation update changes only its owned source/binding and retains user drafts and old docs private state', async t => {
  const f = await fixture(t);
  const original = await request(f.service, 'Workspace', 'open', {path: 'README.md'});
  await request(f.service, 'Workspace', 'checkpoint', {path: 'README.md', baseHash: original.sourceHash, text: 'Keep my workspace draft'});
  await request(f.service, docs, 'open', {path: 'README.md'});
  const before = fs.readdirSync(path.join(f.dataRoot, 'state/native')).filter(name => name.startsWith('.asmb-repo-'));
  await f.restart({version: '0.2.11', text: '# New user guide\n'});
  assert.equal((await f.service.read({repo: docs, path: 'README.md'})).content, '# New user guide\n');
  assert.equal((await request(f.service, 'Workspace', 'open', {path: 'README.md'})).draft.text, 'Keep my workspace draft');
  assert(before.every(name => fs.existsSync(path.join(f.dataRoot, 'state/native', name))));
  assert.equal((await request(f.service, docs, 'open', {path: 'README.md'})).readOnly, true);
});

test('external docs folder swap is rejected during the session and preserved with collision recovery on restart', async t => {
  const f = await fixture(t), root = f.root(docs);
  fs.renameSync(root, f.root('moved-docs')); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'foreign.txt'), 'leave this alone');
  await assert.rejects(f.service.catalog(), {code: 'DOCS_RECOVERY_REQUIRED'});
  await assert.rejects(f.service.read({repo: docs}), {code: 'DOCS_RECOVERY_REQUIRED'});
  await f.restart(); assert.equal((await f.service.catalog()).repositories.at(-1).name, `${docs}-2`);
  assert.equal(fs.readFileSync(path.join(root, 'foreign.txt'), 'utf8'), 'leave this alone');
  assert(fs.existsSync(f.root('moved-docs/README.md')));
});
