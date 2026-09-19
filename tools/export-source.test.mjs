import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
const gitEnvironment = {...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Source export fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Source export fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid'};
const git = (root, ...args) => execFileSync('git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', root, ...args], {env: gitEnvironment, encoding: 'utf8', stdio: 'pipe'}).trim();

test('linked output ancestor cannot publish back inside the source checkout', () => {
  const f=fixture(),alias=path.join(path.dirname(f.root),'linked-output');
  fs.symlinkSync(f.root,alias,'dir');
  const result=spawnSync(process.execPath,[path.join(f.root,'tools/export-source.mjs'),'--output='+path.join(alias,'export')],{env:environment,encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/physical destination ancestors/);assert.equal(fs.existsSync(path.join(f.root,'export')),false);
});
function fixture({attributes} = {}) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'source-export-'));
  const root = path.join(parent, 'repository'); fs.mkdirSync(root, {mode: 0o700});
  const write = (name, bytes, mode = 0o644) => {const filename = path.join(root, name); fs.mkdirSync(path.dirname(filename), {recursive: true, mode: 0o700}); fs.writeFileSync(filename, bytes, {mode}); fs.chmodSync(filename, mode);};
  for (const name of ['LICENSE', 'NOTICE', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'docs/README.md']) write(name, `# Synthetic ${name}\n`);
  write('package-lock.json', '{}\n'); write('ui-workshop/package-lock.json', '{}\n');
  write('apps/native/release.json', JSON.stringify({schemaVersion: 1, version: '0.2.10', buildNumber: 31, bundleId: 'org.asmagicbrain.preview'}) + '\n');
  write('docs/notes.md', '\ufeffRelease bytes\r\n'); write('docs/revision.md', '$Format:%H$\n'); write('tools/demo.sh', '#!/bin/sh\nexit 0\n', 0o755);
  if (attributes) write('.gitattributes', attributes);
  for (const name of ['tools/export-source.mjs', 'tools/public-source-policy.mjs', 'apps/native/release-identity.mjs', 'packages/desktop-host/src/zip-import/index.mjs', 'packages/desktop-host/src/physical-roots.mjs', 'packages/source-foundation/src/domain/path-policy.mjs']) write(name, fs.readFileSync(path.join(sourceRoot, name)));
  git(root, 'init', '--initial-branch=main', '--object-format=sha1', '--template=');
  git(root, 'add', '--all'); git(root, 'commit', '--no-gpg-sign', '-m', 'Synthetic source export fixture'); git(root, 'tag', 'native-v0.2.10');
  const output = path.join(parent, 'export');
  return {root, output, write, run: (extra = {}) => spawnSync(process.execPath, [path.join(root, 'tools/export-source.mjs'), '--output=' + output], {cwd: parent, env: {...environment, ...extra}, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024})};
}

test('exact tagged export binds archive and extracted bytes, preserves executable status and contains no Git history', () => {
  const f = fixture(), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.output, 'source-manifest.json')));
  assert.equal(manifest.sourceCommit, git(f.root, 'rev-parse', 'HEAD')); assert.equal(manifest.sourceTag, 'native-v0.2.10');
  assert.equal(manifest.historyIncluded, false); assert.equal(manifest.publication, 'prepared-local-only');
  assert.equal(manifest.archiveSha256, hash(fs.readFileSync(path.join(f.output, manifest.archive))));
  assert.equal(fs.existsSync(path.join(f.output, 'source/.git')), false);
  for (const file of manifest.files) {
    const filename = path.join(f.output, 'source', file.path);
    assert.equal(hash(fs.readFileSync(filename)), file.sha256, file.path);
    assert.equal(Boolean(fs.statSync(filename).mode & 0o111), Boolean(file.mode & 0o111), file.path);
  }
  assert.equal(fs.readFileSync(path.join(f.output, 'source/docs/notes.md'), 'utf8'), '\ufeffRelease bytes\r\n');
});

function reissue(f, {tag = true} = {}) {
  const original = git(f.root, 'rev-parse', 'refs/tags/native-v0.2.10^{commit}');
  const release = JSON.parse(fs.readFileSync(path.join(f.root, 'apps/native/release.json')));
  f.write('apps/native/release.json', JSON.stringify({...release, buildNumber: 32, metadataRevision: 1}) + '\n');
  f.write('NOTICE', '# Updated synthetic attribution\n');
  git(f.root, 'add', '--all'); git(f.root, 'commit', '--no-gpg-sign', '-m', 'Synthetic metadata revision');
  if (tag) git(f.root, 'tag', 'native-v0.2.10-metadata.1');
  return original;
}

test('metadata reissue exports exact new tagged bytes without moving the original version tag or needing npm', () => {
  const f = fixture(), original = reissue(f), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.output, 'source-manifest.json')));
  assert.equal(manifest.version, '0.2.10'); assert.equal(manifest.sourceTag, 'native-v0.2.10-metadata.1');
  assert.equal(manifest.sourceCommit, git(f.root, 'rev-parse', 'HEAD')); assert.notEqual(manifest.sourceCommit, original);
  assert.equal(git(f.root, 'rev-parse', 'refs/tags/native-v0.2.10^{commit}'), original);
  assert.equal(fs.readFileSync(path.join(f.output, 'source/NOTICE'), 'utf8'), '# Updated synthetic attribution\n');
  assert.equal(fs.existsSync(path.join(f.root, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'ui-workshop/node_modules')), false);
  const before = hash(fs.readFileSync(path.join(f.output, manifest.archive))), repeated = f.run();
  assert.notEqual(repeated.status, 0); assert.match(repeated.stderr, /Preserve existing exports/);
  assert.equal(hash(fs.readFileSync(path.join(f.output, manifest.archive))), before);
});

test('metadata reissue refuses a missing or stale revision tag and dirty source before creating output', () => {
  for (const state of ['missing', 'stale', 'dirty']) {
    const f = fixture(), original = reissue(f, {tag: state === 'dirty'});
    if (state === 'stale') git(f.root, 'tag', 'native-v0.2.10-metadata.1', original);
    if (state === 'dirty') f.write('NOTICE', 'Uncommitted attribution\n');
    const result = f.run();
    assert.notEqual(result.status, 0, state); assert.equal(fs.existsSync(f.output), false, state);
    assert.equal(git(f.root, 'rev-parse', 'refs/tags/native-v0.2.10^{commit}'), original);
  }
});

test('Git export-ignore cannot silently remove a manifest member', () => {
  const f = fixture({attributes: 'docs/notes.md export-ignore\n'}), result = f.run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Archive attributes changed the committed source membership/);
  assert(fs.existsSync(path.join(f.output, 'INCOMPLETE.txt'))); assert(!fs.existsSync(path.join(f.output, 'source-manifest.json')));
});

test('Git export-subst cannot silently change the archived content', () => {
  const f = fixture({attributes: 'docs/revision.md export-subst\n'}), result = f.run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Archived source differs from release blob: docs\/revision\.md/);
  assert(fs.existsSync(path.join(f.output, 'INCOMPLETE.txt'))); assert(!fs.existsSync(path.join(f.output, 'source-manifest.json')));
});

test('skip-worktree cannot conceal locally changed bytes from source export validation', () => {
  const f = fixture(); git(f.root, 'update-index', '--skip-worktree', 'docs/notes.md'); f.write('docs/notes.md', 'Uncommitted working bytes\n');
  assert.equal(git(f.root, 'status', '--porcelain=v1'), '');
  const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Working file differs from release blob: docs\/notes\.md/);
  assert(!fs.existsSync(f.output));
});

test('inherited Git directory, work tree, index and injected configuration do not redirect the exporter', () => {
  const f = fixture(), foreign = fixture();
  foreign.write('uncommitted.txt', 'Foreign work must not be exported\n');
  const foreignHead = git(foreign.root, 'rev-parse', 'HEAD');
  const result = f.run({GIT_DIR: path.join(foreign.root, '.git'), GIT_WORK_TREE: foreign.root, GIT_INDEX_FILE: path.join(foreign.root, '.git/index'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true'});
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.output, 'source-manifest.json')));
  assert.equal(manifest.sourceCommit, git(f.root, 'rev-parse', 'HEAD'));
  assert(!manifest.files.some(file => file.path === 'uncommitted.txt'));
  assert.equal(git(foreign.root, 'rev-parse', 'HEAD'), foreignHead);
  assert.equal(fs.readFileSync(path.join(foreign.root, 'uncommitted.txt'), 'utf8'), 'Foreign work must not be exported\n');
});

test('concurrent exports reserve publication once and preserve the winning archive', {timeout: 30000}, async t => {
  const f = fixture(), parent = path.dirname(f.root), preload = path.join(parent, 'reservation-barrier.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
import path from 'node:path';
const original = fs.mkdirSync, label = process.env.ASMB_EXPORT_TEST_LABEL;
fs.mkdirSync = function(directory, options) {
  if (path.resolve(directory) === process.env.ASMB_EXPORT_TEST_OUTPUT) {
    fs.writeFileSync(process.env.ASMB_EXPORT_TEST_BARRIER + '.ready-' + label, 'ready');
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(process.env.ASMB_EXPORT_TEST_BARRIER + '.go-' + label)) {
      if (Date.now() > deadline) throw Error('Test reservation barrier timed out.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return original.call(this, directory, options);
};
`);
  const barrier = path.join(parent, 'barrier'), children = [];
  t.after(() => {for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');});
  function start(label) {
    const child = spawn(process.execPath, ['--import', preload, path.join(f.root, 'tools/export-source.mjs'), '--output=' + f.output], {
      cwd: parent, env: {...environment, ASMB_EXPORT_TEST_LABEL: label, ASMB_EXPORT_TEST_OUTPUT: f.output, ASMB_EXPORT_TEST_BARRIER: barrier}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child); let stderr = ''; child.stdout.resume(); child.stderr.on('data', bytes => {stderr += bytes;});
    return new Promise((resolve, reject) => {child.once('error', reject); child.once('close', code => resolve({code, stderr}));});
  }
  const first = start('first'), second = start('second'), deadline = Date.now() + 20000;
  while (!['first', 'second'].every(label => fs.existsSync(barrier + '.ready-' + label))) {
    assert.ok(Date.now() < deadline, 'Both exporters must reach the reservation after checking absence.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  fs.writeFileSync(barrier + '.go-first', 'continue');
  const winner = await first; assert.equal(winner.code, 0, winner.stderr);
  const snapshot = () => {
    const result = [];
    function walk(directory) {for (const entry of fs.readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filename); else result.push({path: path.relative(f.output, filename), sha256: hash(fs.readFileSync(filename))});
    }}
    walk(f.output); return result;
  };
  const before = snapshot(), manifest = JSON.parse(fs.readFileSync(path.join(f.output, 'source-manifest.json')));
  assert.equal(hash(fs.readFileSync(path.join(f.output, manifest.archive))), manifest.archiveSha256);
  fs.writeFileSync(barrier + '.go-second', 'continue');
  const loser = await second; assert.notEqual(loser.code, 0); assert.match(loser.stderr, /EEXIST/);
  assert.equal(fs.existsSync(path.join(f.output, 'INCOMPLETE.txt')), false);
  assert.deepEqual(snapshot(), before, 'The losing exporter must not modify any published file.');
});
