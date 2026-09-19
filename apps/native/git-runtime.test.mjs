import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync, execFileSync} from 'node:child_process';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {copyGitRuntime, gitRuntimeSpec, prepareGitRuntime, verifyGitRuntime as verifyPreparedGit} from './git-runtime.mjs';
import {selectGitRuntimeSpec} from './native-runtime.mjs';
import {testRoot} from '../../tools/development-paths.mjs';
import {assertGitRuntime, gitExecutable, gitEnvironment, verifyGitRuntime} from '../../packages/desktop-host/src/git-executable.mjs';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const built = path.join(appRoot, 'apps/native/dist-host/git');
const available = fs.existsSync(built);
const sourceModule = path.join(appRoot, 'packages/desktop-host/src/git-executable.mjs');
const author = {name: 'Bundled Runtime Fixture', email: 'runtime@example.invalid'};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bundled git '));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}
function packagedFixture(t) {
  const root = fixture(t), app = path.join(root, 'Moved Preview.app/Contents/Resources/app');
  fs.mkdirSync(path.join(app, 'packages/desktop-host/src'), {recursive: true});
  fs.copyFileSync(sourceModule, path.join(app, 'packages/desktop-host/src/git-executable.mjs'));
  const git = path.join(app, 'apps/native/dist-host/git'), descriptor = copyGitRuntime(built, git);
  fs.writeFileSync(path.join(app, 'native-package.json'), JSON.stringify({bundledGit: {manifestSha256: descriptor.manifestSha256}}));
  const entry = pathToFileURL(path.join(app, 'packages/desktop-host/src/git-executable.mjs')).href;
  const probe = () => spawnSync(process.execPath, ['--input-type=module', '-e', `import {assertGitRuntime,gitExecutable,gitEnvironment} from ${JSON.stringify(entry)}; import {execFileSync} from 'node:child_process'; try {const runtime=assertGitRuntime({packaged:true}); console.log(JSON.stringify({runtime,version:execFileSync(gitExecutable(),['--version'],{env:gitEnvironment(),encoding:'utf8'}).trim()}));} catch(error){console.error(error.code);process.exit(1);}`], {encoding: 'utf8', env: {PATH: '/no-user-path', GIT_EXEC_PATH: '/attacker/helpers', GIT_CONFIG_GLOBAL: '/attacker/config', ASMB_GIT_PATH: '/usr/bin/git', ...(process.versions.electron ? {ELECTRON_RUN_AS_NODE: '1'} : {})}});
  return {root, app, git, probe, descriptor};
}

test('pinned bundled closure has owned helpers, exact source, signatures and no credential manager', {skip: !available}, () => {
  const result = assertGitRuntime(); assert.equal(result.kind, 'bundled');
  assert.equal(result.gitVersion, gitRuntimeSpec.gitVersion);
  assert.equal(execFileSync(gitExecutable(), ['--exec-path'], {env: gitEnvironment(), encoding: 'utf8'}).trim(), result.execPath);
  const manifest = JSON.parse(fs.readFileSync(path.join(built, 'runtime-manifest.json')));
  if (process.platform === 'darwin') {
    assert(manifest.machO.length >= 8);
    for (const item of manifest.machO) assert.equal(spawnSync('/usr/bin/codesign', ['--verify', '--strict', path.join(built, item.path)]).status, 0);
  } else {
    assert.equal(manifest.signing, 'upstream-unchanged');
    assert.deepEqual(manifest.elf.map(item => item.path), ['bin/git', 'libexec/git-core/git', 'libexec/git-core/git-remote-http']);
    assert(manifest.elf.every(item => item.searchPaths.length === 0 && item.needed.every(name => gitRuntimeSpec.systemDependencies.needed.includes(name))));
  }
  assert(!manifest.entries.some(item => /credential-manager|osxkeychain|git-lfs|\.dylib$|etc\/gitconfig/.test(item.path)));
  assert(fs.existsSync(path.join(built, 'licenses/git-67ad4214-source.tar.gz')));
  assert(fs.existsSync(path.join(built, 'licenses/sha1collisiondetection-855827c5-source.tar.gz')));
  assert.equal(result.manifestSha256, gitRuntimeSpec.preparedManifestSha256);
  assert.equal(gitEnvironment().GIT_CONFIG_COUNT, '0');
  assert.equal(gitEnvironment().GIT_CONFIG_GLOBAL, '/dev/null');
});

test('Linux-layout workers fail closed when metadata and the runtime are both missing', t => {
  const root = fixture(t), app = path.join(root, 'moved preview/resources/app');
  fs.mkdirSync(path.join(app, 'packages/desktop-host/src'), {recursive: true});
  const filename = path.join(app, 'packages/desktop-host/src/git-executable.mjs');
  fs.copyFileSync(sourceModule, filename);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {assertGitRuntime} from ${JSON.stringify(pathToFileURL(filename).href)}; try {assertGitRuntime(); process.exit(2);} catch(error) {console.log(error.code);}`], {encoding: 'utf8', env: {PATH: '/no-user-path', ...(process.versions.electron ? {ELECTRON_RUN_AS_NODE: '1'} : {})}});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'GIT_RUNTIME_MISSING');
});

const linuxOptions = {platform: 'linux', arch: 'x64'}, linuxSpec = selectGitRuntimeSpec(linuxOptions), downloads = path.join(testRoot, 'tooling-downloads');
const linuxInputsAvailable = linuxSpec.inputs.every(input => fs.existsSync(path.join(downloads, input.filename)));
test('Linux preparation and cross-host copies preserve native 0777 symlink modes and the tracked pin', {skip: !linuxInputsAvailable}, async t => {
  const root = fixture(t), prepared = path.join(root, 'prepared'), copy = path.join(root, 'copied');
  const before = await prepareGitRuntime({destination: prepared, downloads, ...linuxOptions});
  assert.equal(before.manifestSha256, linuxSpec.preparedManifestSha256);
  const originalUmask = process.umask(0o002);
  try {assert.equal(copyGitRuntime(prepared, copy, linuxOptions).manifestSha256, before.manifestSha256);}
  finally {process.umask(originalUmask);}
  const manifest = JSON.parse(fs.readFileSync(path.join(copy, 'runtime-manifest.json')));
  for (const entry of manifest.entries) assert.equal(fs.lstatSync(path.join(copy, entry.path)).mode & 0o777, entry.mode, entry.path);
  const links = manifest.entries.filter(entry => entry.type === 'symlink'); assert(links.length > 100);
  for (const entry of links) {
    assert.equal(entry.mode, 0o777, entry.path);
    assert.equal(fs.lstatSync(path.join(prepared, entry.path)).mode & 0o777, entry.mode, entry.path);
    assert.equal(fs.lstatSync(path.join(copy, entry.path)).mode & 0o777, entry.mode, entry.path);
  }
});

test('a relocated package with spaces ignores inherited executable/config paths', {skip: !available}, t => {
  const f = packagedFixture(t), result = f.probe();
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout); assert.equal(value.version, 'git version 2.53.0');
  assert.equal(value.runtime.executable, path.join(f.git, 'bin/git'));
  assert.equal(value.runtime.manifestSha256, f.descriptor.manifestSha256);
});

test('missing, corrupted, substituted and unlisted packaged runtime inputs fail closed', {skip: !available}, t => {
  const f = packagedFixture(t), binary = path.join(f.git, 'bin/git'), original = fs.readFileSync(binary);
  fs.renameSync(binary, binary + '.held'); assert.match(f.probe().stderr, /GIT_RUNTIME_MISSING/); fs.renameSync(binary + '.held', binary);
  const broken = Buffer.from(original); broken[500] ^= 1; fs.writeFileSync(binary, broken); assert.match(f.probe().stderr, /GIT_RUNTIME_CORRUPT/); fs.writeFileSync(binary, original);
  fs.writeFileSync(path.join(f.git, 'injected-helper'), 'unexpected'); assert.match(f.probe().stderr, /GIT_RUNTIME_CORRUPT/); fs.unlinkSync(path.join(f.git, 'injected-helper'));
  const link = path.join(f.git, 'libexec/git-core/git-upload-pack'), target = fs.readlinkSync(link); fs.unlinkSync(link); fs.symlinkSync('/usr/bin/git', link); assert.match(f.probe().stderr, /GIT_RUNTIME_CORRUPT/); fs.unlinkSync(link); fs.symlinkSync(target, link);
  fs.unlinkSync(path.join(f.app, 'native-package.json')); assert.match(f.probe().stderr, /GIT_RUNTIME_MISSING/);
});

test('rewriting a tampered generated cache manifest cannot replace the tracked signed-runtime pin', {skip: !available}, async t => {
  const root = fixture(t), git = path.join(root, 'git'), descriptor = copyGitRuntime(built, git);
  const executable = path.join(git, 'bin/git'), bytes = fs.readFileSync(executable); bytes[500] ^= 1; fs.writeFileSync(executable, bytes);
  const manifestPath = path.join(git, 'runtime-manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.entries.find(item => item.path === 'bin/git').sha256 = createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  assert.notEqual(createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex'), descriptor.manifestSha256);
  assert.throws(() => verifyPreparedGit(git), {code: 'GIT_RUNTIME_CORRUPT'});
  await assert.rejects(prepareGitRuntime({destination: git, downloads: path.join(root, 'unused-downloads')}), {code: 'GIT_RUNTIME_CORRUPT'});
});

test('real bundled init, selected commit, import, local clone helpers and large blobs never invoke system Git', {skip: !available}, async t => {
  const root = fixture(t), source = path.join(root, 'source with spaces'), privateRoot = path.join(root, 'private');
  fs.mkdirSync(source); fs.mkdirSync(privateRoot, {mode: 0o700});
  const selected = gitExecutable(), calls = [], originals = {execFile: childProcess.execFile, spawn: childProcess.spawn};
  for (const name of Object.keys(originals)) childProcess[name] = function(executable, args, ...rest) {
    if (path.basename(executable) === 'git') {assert.equal(executable, selected); calls.push(args);}
    return originals[name].call(this, executable, args, ...rest);
  };
  syncBuiltinESMExports(); t.after(() => {Object.assign(childProcess, originals); syncBuiltinESMExports();});
  const poison = path.join(root, 'poison-config'), marker = path.join(root, 'MUST-NOT-EXIST');
  fs.writeFileSync(poison, `[init]\n templateDir = /invalid/template\n[credential]\n helper = !touch '${marker}'\n[core]\n hooksPath = /invalid/hooks\n`);
  const previous = {GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_EXEC_PATH: process.env.GIT_EXEC_PATH, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT};
  Object.assign(process.env, {GIT_CONFIG_GLOBAL: poison, GIT_EXEC_PATH: '/attacker/helpers', GIT_CONFIG_COUNT: '800'});
  t.after(() => {for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;});
  const {createLocalGit} = await import('../../packages/desktop-host/src/local-git/index.mjs');
  const {createImportedGitSnapshot} = await import('../../packages/desktop-host/src/local-git/import-snapshot.mjs');
  const {cloneGitHubRepository} = await import('../../packages/desktop-host/src/local-git/github-clone.mjs');
  const api = createLocalGit({sourceRoot: source, privateRoot}); await api.initialize();
  fs.writeFileSync(path.join(source, 'chosen.md'), '# Kept\r\n'); fs.writeFileSync(path.join(source, 'unrelated.md'), 'outside selection');
  const review = await api.review({paths: ['chosen.md']});
  const committed = await api.commit({expectedHead: review.expectedHead, expectedIndexHash: review.expectedIndexHash, files: review.files.map(({path, expectedSourceHash, expectedSourceMode}) => ({path, expectedSourceHash, expectedSourceMode})), message: 'Bundled selected commit', author});
  assert.equal(committed.status, 'committed');
  const run = (args, extra = {}) => execFileSync(selected, args, {env: gitEnvironment(extra), encoding: 'utf8'}).trim();
  assert.equal(run(['-C', source, 'ls-tree', '--name-only', 'HEAD']), 'chosen.md');
  const imported = path.join(root, 'imported large'); fs.mkdirSync(imported); const asset = Buffer.alloc(6 * 1024 * 1024, 71); fs.writeFileSync(path.join(imported, 'asset.bin'), asset);
  await createImportedGitSnapshot({sourceRoot: imported, files: [{path: 'asset.bin'}]});
  const clone = path.join(root, 'cloned with spaces'); fs.mkdirSync(clone);
  const trace = path.join(root, 'clone-trace.jsonl');
  await cloneGitHubRepository({sourceRoot: clone, url: 'https://github.com/fixture/offline', acquire: ({destination}) => {run(['clone', '--no-checkout', '--no-hardlinks', '--no-local', '--template=', '--', imported, destination], {GIT_ALLOW_PROTOCOL: 'file', GIT_TRACE2_EVENT: trace});}});
  assert.deepEqual(fs.readFileSync(path.join(clone, 'asset.bin')), asset);
  const events = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert(events.some(event => event.event === 'cmd_name' && event.name === 'upload-pack'));
  assert(events.some(event => event.event === 'child_start' && event.argv?.some(value => value.includes('git-upload-pack'))));
  assert.equal(fs.existsSync(marker), false); assert(calls.length >= 20);
  assert.equal(verifyGitRuntime(built).gitVersion, '2.53.0');
});
