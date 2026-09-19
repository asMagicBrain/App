import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createNativeService} from './host-service.mjs';
import {createWorkspaceService} from '../../packages/desktop-host/src/workspace-service.mjs';

// The immutable previous package is an actual old reader, rather than a mock
// which duplicates the current implementation's compatibility assumptions.
const legacyURL = new URL('../../releases/0.1.0-preview.13/asMagicBrain.app/Contents/Resources/app/apps/native/host-service.mjs', import.meta.url);
const legacyMissing = !fs.existsSync(fileURLToPath(legacyURL));
const legacyOptions = {skip: legacyMissing ? 'Requires the retained immutable preview.13 bundle for compatibility qualification.' : false};
const env = {PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_AUTHOR_NAME: 'Apply review fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Apply review fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', ...(process.env.TMPDIR ? {TMPDIR: process.env.TMPDIR} : {})};
const git = (root, ...args) => execFileSync('/usr/bin/git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', root, ...args], {env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']}).trim();

function inventory(root) {
  const result = Object.create(null);
  const walk = relative => {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      // A deliberately stopped host leaves its owned PID lock. The next host
      // may retire that stale lock, but must preserve all repository/state data.
      if (!relative && name === '.asmb-native.lock') continue;
      const key = relative ? `${relative}/${name}` : name, filename = path.join(root, key), stat = fs.lstatSync(filename);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) {result[key] = {type: 'directory', mode: stat.mode & 0o777}; walk(key);}
      else {assert.equal(stat.isFile(), true); result[key] = {type: 'file', mode: stat.mode & 0o777, bytes: stat.size, hash: createHash('sha256').update(fs.readFileSync(filename)).digest('hex')};}
    }
  };
  walk(''); return result;
}

function hostRecord(dataRoot) {
  const root = path.join(dataRoot, 'state/native/.asmb-host');
  const records = fs.readdirSync(root).filter(name => name === 'checkpoint.json' || /^\d{16}\.json$/.test(name))
    .map(name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')).body)
    .sort((a, b) => a.sequence - b.sequence);
  const current = records.at(-1); assert.ok(current);
  return current.type === 'checkpoint' ? current.payload.state : current.payload;
}
const hostSchema = dataRoot => hostRecord(dataRoot).schemaVersion;

async function fixture(t, hooks = {}, initialFiles = []) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'asmb-apply-review-'));
  const original = path.join(parent, 'original'), dataRoot = path.join(parent, 'profile');
  fs.mkdirSync(original); git(original, 'init', '--initial-branch=main', '--template=');
  fs.writeFileSync(path.join(original, 'README.md'), '# Before\n');
  for (const [name, bytes] of initialFiles) {fs.mkdirSync(path.dirname(path.join(original, name)), {recursive: true}); fs.writeFileSync(path.join(original, name), bytes);}
  git(original, 'add', '.'); git(original, 'commit', '-m', 'Before');
  const serviceHooks = {
    cloneAcquire: async ({destination}) => execFileSync('/usr/bin/git', ['clone', '--no-checkout', '--no-hardlinks', '--no-local', '--template=', '--', original, destination], {env, stdio: 'pipe'}),
    updatesAcquire: async ({gitDir, branch}) => {
      execFileSync('/usr/bin/git', [`--git-dir=${gitDir}`, '-c', 'core.hooksPath=/dev/null', 'fetch', '--no-tags', '--no-write-fetch-head', '--no-auto-maintenance', '--', original, `refs/heads/${branch}:refs/asmb-check/remote`], {env, stdio: 'pipe'});
      return git(original, 'rev-parse', `refs/heads/${branch}`);
    },
    ...hooks,
  };
  let service = await createNativeService({dataRoot, hooks: serviceHooks});
  const root = path.join(dataRoot, 'workspaces/asMagicBrain/Cloned');
  await service.cloneRepository({name: 'Cloned', url: 'https://github.com/example/fixture', requestId: randomUUID()});
  const beforeHead = git(root, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(original, 'README.md'), '# Reviewed update\n');
  fs.writeFileSync(path.join(original, 'new.md'), 'New incoming file\n');
  git(original, 'add', '.'); git(original, 'commit', '-m', 'Incoming');
  const afterHead = git(original, 'rev-parse', 'HEAD');
  const comparison = await service.checkRepositoryUpdates({repo: 'Cloned', requestId: randomUUID()});
  assert.equal(comparison.relation, 'remote-ahead');
  t.after(async () => {try {await service?.close();} finally {fs.rmSync(parent, {recursive: true, force: true});}});
  return {parent, original, dataRoot, root, beforeHead, afterHead, comparison,
    get service() {return service;},
    stop: async () => {await service?.close(); service = null;},
    reopen: async () => {assert.equal(service, null); service = await createNativeService({dataRoot, hooks: serviceHooks});},
    review: () => service.reviewRepositoryUpdate({repo: 'Cloned', checkId: comparison.checkId}),
    apply: review => service.applyRepositoryUpdate({repo: 'Cloned', checkId: comparison.checkId, reviewId: review.reviewId, requestId: randomUUID()}),
  };
}

async function assertLegacyRefuses(dataRoot) {
  const before = inventory(dataRoot), {createNativeService: legacyService} = await import(legacyURL.href);
  await assert.rejects(legacyService({dataRoot}), {code: 'RECOVERY_REQUIRED'});
  assert.deepEqual(inventory(dataRoot), before, 'The old reader must reject before mutating workspaces or private state.');
}

test('checking and reviewing without apply preserves a schema2 profile readable by actual preview.13', legacyOptions, async t => {
  const f = await fixture(t), before = inventory(f.root), review = await f.review();
  assert.equal(review.canApply, true); assert.equal(hostSchema(f.dataRoot), 2);
  assert.deepEqual(inventory(f.root), before);
  await f.stop(); const beforeLegacy = inventory(f.dataRoot);
  const {createNativeService: legacyService} = await import(legacyURL.href), legacy = await legacyService({dataRoot: f.dataRoot});
  try {assert.ok((await legacy.catalog()).repositories.some(item => item.name === 'Cloned'));}
  finally {await legacy.close();}
  assert.deepEqual(inventory(f.dataRoot), beforeLegacy); assert.equal(hostSchema(f.dataRoot), 2);
});

test('accepted apply gates preview.13 durably before its first source mutation', legacyOptions, async t => {
  let f, atAdmission = false, before;
  f = await fixture(t, {at: point => {
    if (point !== 'apply-profile-upgraded') return;
    atAdmission = true; assert.equal(hostSchema(f.dataRoot), 3); assert.deepEqual(inventory(f.root), before);
  }});
  before = inventory(f.root); const result = await f.apply(await f.review());
  assert.equal(atAdmission, true); assert.equal(result.status, 'applied');
  assert.equal(result.head, f.afterHead); assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.afterHead);
  assert.equal(fs.readFileSync(path.join(f.root, 'README.md'), 'utf8'), '# Reviewed update\n');
  await f.stop(); assert.equal(hostSchema(f.dataRoot), 3); await assertLegacyRefuses(f.dataRoot);
  await f.reopen(); assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.afterHead);
});

test('rejected stale apply does not upgrade the host profile or discard the new local edit', legacyOptions, async t => {
  const f = await fixture(t), review = await f.review();
  fs.writeFileSync(path.join(f.root, 'README.md'), 'Local edit after review\n'); const before = inventory(f.root);
  await assert.rejects(f.apply(review));
  assert.deepEqual(inventory(f.root), before); assert.equal(hostSchema(f.dataRoot), 2);
  await f.stop(); const {createNativeService: legacyService} = await import(legacyURL.href), legacy = await legacyService({dataRoot: f.dataRoot});
  await legacy.close(); assert.deepEqual(inventory(f.root), before);
});

test('prototype-like incoming filenames remain ordinary explicit paths through review, apply and restart', async t => {
  const f = await fixture(t);
  for (const name of ['__proto__', 'constructor', 'toString', 'nested/__proto__']) {
    fs.mkdirSync(path.dirname(path.join(f.original, name)), {recursive: true});
    fs.writeFileSync(path.join(f.original, name), `Incoming ${name}\n`);
  }
  git(f.original, 'add', '.'); git(f.original, 'commit', '-m', 'Ordinary prototype-like paths');
  const comparison = await f.service.checkRepositoryUpdates({repo: 'Cloned', requestId: randomUUID()});
  const review = await f.service.reviewRepositoryUpdate({repo: 'Cloned', checkId: comparison.checkId});
  assert.equal(review.canApply, true);
  await f.service.applyRepositoryUpdate({repo: 'Cloned', checkId: comparison.checkId, reviewId: review.reviewId, requestId: randomUUID()});
  for (const name of ['__proto__', 'constructor', 'toString', 'nested/__proto__']) assert.equal(fs.readFileSync(path.join(f.root, name), 'utf8'), `Incoming ${name}\n`);
  assert.equal(git(f.root, 'status', '--porcelain=v1'), '');
  const before = inventory(f.root); await f.stop(); await f.reopen(); assert.deepEqual(inventory(f.root), before);
});

test('untracked and hidden edited __proto__ files cannot disappear from clean-tree admission', async t => {
  for (const tracked of [false, true]) await t.test(tracked ? 'tracked with assume-unchanged' : 'untracked', async t => {
    const f = await fixture(t, {}, tracked ? [['__proto__', 'Original ordinary file\n']] : []);
    if (tracked) git(f.root, 'update-index', '--assume-unchanged', '__proto__');
    fs.writeFileSync(path.join(f.root, '__proto__'), 'Local work must survive\n');
    const before = inventory(f.root), review = await f.review();
    assert.equal(review.canApply, false); assert.equal(review.reason, 'saved-changes');
    assert.deepEqual(inventory(f.root), before); assert.equal(hostSchema(f.dataRoot), 2);
  });
});

test('retained recovered create text blocks native apply review even with zero ordinary drafts', async t => {
  const f = await fixture(t), before = inventory(f.root);
  await f.stop();
  const record = hostRecord(f.dataRoot), options = {
    base: path.join(f.dataRoot, 'workspaces/asMagicBrain'),
    privateBase: path.join(f.dataRoot, 'state/native'),
    builtinRepositories: [{name: record.workspaceName, privateRepo: true}], repositoryBindings: record.repositoryBindings,
    localOwnerId: record.ownerId, localRootId: 'native',
  };
  // Produce the real retained-old state through the existing runtime API and
  // its interruption hook; never forge or replace a private journal record.
  const interrupted = createWorkspaceService({...options, runtimeHooks: {at: point => {
    if (point === 'after-intent') throw new Error('Acceptance stop after create intent');
  }}});
  try {await assert.rejects(interrupted.execute('Cloned', 'create', {path: 'recovered.md', text: 'Retained local create text\n'}), /Acceptance stop/);}
  finally {interrupted.close();}
  const recovered = createWorkspaceService(options);
  try {
    assert.equal((await recovered.execute('Cloned', 'reconcile', {})).status, 'retained-old');
    const status = await recovered.execute('Cloned', 'runtimeStatus', {});
    assert.equal(status.draftCount, 0); assert.equal(status.recoveryRequired, false);
    assert.deepEqual(status.recoveredDrafts, [{path: 'recovered.md', text: 'Retained local create text\n'}]);
  } finally {recovered.close();}
  assert.deepEqual(inventory(f.root), before);
  await f.reopen();
  const review = await f.review();
  assert.equal(review.canApply, false); assert.equal(review.reason, 'drafts'); assert.equal(review.draftCount, 1);
  assert.equal(hostSchema(f.dataRoot), 2); assert.deepEqual(inventory(f.root), before);
  const status = await f.service.request({repo: 'Cloned', operation: 'runtimeStatus', args: {}});
  assert.deepEqual(status.recoveredDrafts, [{path: 'recovered.md', text: 'Retained local create text\n'}]);
});

for (const phase of ['apply-profile-upgraded', 'apply-after-file']) {
  test(`stopped apply at ${phase} is refused by preview.13 before current-host recovery`, legacyOptions, async t => {
    const f = await fixture(t), before = inventory(f.root); await f.stop();
    const requestId = randomUUID();
    const script = `import {createNativeService} from ${JSON.stringify(new URL('./host-service.mjs', import.meta.url).href)};
      const halt = point => {if (point === ${JSON.stringify(phase)}) process.exit(86);};
      const service = await createNativeService({dataRoot: ${JSON.stringify(f.dataRoot)}, hooks: {at: halt, applyAt: halt}});
      const review = await service.reviewRepositoryUpdate({repo: 'Cloned', checkId: ${JSON.stringify(f.comparison.checkId)}});
      await service.applyRepositoryUpdate({repo: 'Cloned', checkId: ${JSON.stringify(f.comparison.checkId)}, reviewId: review.reviewId, requestId: ${JSON.stringify(requestId)}});
      await service.close(); process.exit(87);`;
    assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], {env: {...process.env, ...(process.versions.electron ? {ELECTRON_RUN_AS_NODE: '1'} : {})}, stdio: 'pipe'}), error => error.status === 86);
    assert.equal(hostSchema(f.dataRoot), 3);
    if (phase === 'apply-profile-upgraded') assert.deepEqual(inventory(f.root), before);
    await assertLegacyRefuses(f.dataRoot);
    await f.reopen();
    if (phase === 'apply-profile-upgraded') {assert.deepEqual(inventory(f.root), before); assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.beforeHead);}
    else {assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.afterHead); assert.equal(fs.readFileSync(path.join(f.root, 'README.md'), 'utf8'), '# Reviewed update\n');}
  });
}
