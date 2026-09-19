import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {appRoot} from './development-paths.mjs';
import {resolveNativeStartup, startupFailureMessage} from './startup.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'asmb-startup-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const testRoot = path.join(root, 'asMagicBrain-Test'); fs.mkdirSync(testRoot);
  return {root, testRoot, options: {args: [], packaged: true, metadata: {schemaVersion: 1, channel: 'preview'}, home: path.join(root, 'home'), appData: path.join(root, 'home/Library/Application Support'), platform: 'darwin'}};
}

test('portable preview resolves the current user layout without accessing a build-machine path or writing files', t => {
  const {root, options} = fixture(t);
  const result = resolveNativeStartup(options);
  assert.equal(result.configuration.channel, 'preview');
  assert.equal(result.configuration.validationOnly, false);
  assert.equal(result.testRoot, undefined);
  assert.equal(result.paths.dataRoot, path.join(root, 'home/asMagicBrain'));
  assert.equal(result.paths.profileRoot, path.join(root, 'home/Library/Application Support/asMagicBrain Preview'));
  assert.equal(fs.existsSync(options.home), false);
});

test('Linux startup uses the supplied Electron XDG root, while an isolated home never touches it', t => {
  const {root, testRoot, options} = fixture(t), appData = path.join(root, 'xdg-config');
  const linux = {...options, platform: 'linux', appData};
  const installed = resolveNativeStartup(linux);
  assert.equal(installed.paths.profileRoot, path.join(appData, 'asMagicBrain Preview'));
  const home = path.join(testRoot, 'runs/linux-home');
  const isolated = resolveNativeStartup({...linux, args: [`--test-root=${testRoot}`, `--test-user-home=${home}`]});
  assert.equal(isolated.paths.profileRoot, path.join(home, '.config/asMagicBrain Preview'));
  assert.equal(isolated.paths.dataRoot, path.join(home, 'asMagicBrain'));
  assert.equal(fs.existsSync(appData), false); assert.equal(fs.existsSync(home), false);
});

test('packaged preview requires an explicit physical Test root only for paired isolated overrides', t => {
  const {root, testRoot, options} = fixture(t);
  const home = path.join(testRoot, 'runs/fresh-home');
  const args = [`--test-root=${testRoot}`, `--test-user-home=${home}`];
  assert.equal(resolveNativeStartup({...options, args}).paths.dataRoot, path.join(home, 'asMagicBrain'));
  for (const invalid of [args.slice(0, 1), args.slice(1), [...args, args[0]], [...args, args[1]], ['--test-root'], ['--test-user-home'], [`--test-root=${testRoot}`, `--test-user-home=${root}/outside`], [`--test-root=${testRoot}`, `--test-data-root=${home}`]]) {
    assert.throws(() => resolveNativeStartup({...options, args: invalid}));
  }
  fs.symlinkSync(testRoot, path.join(root, 'linked'));
  assert.throws(() => resolveNativeStartup({...options, args: [`--test-root=${root}/linked/asMagicBrain-Test`, `--test-user-home=${home}`]}));
  assert.equal(fs.existsSync(home), false);
});

test('development retains its recorded Test root; preview rejects embedded development configuration', t => {
  const {testRoot, options} = fixture(t);
  const development = {...options, metadata: {schemaVersion: 1, channel: 'development', testRoot}};
  assert.equal(resolveNativeStartup(development).paths.dataRoot, path.join(testRoot, 'packaged-preview/data'));
  assert.throws(() => resolveNativeStartup({...development, metadata: {...development.metadata, testRoot: testRoot + '/missing/asMagicBrain-Test'}}), {code: 'DEVELOPMENT_DATA_UNAVAILABLE'});
  assert.throws(() => resolveNativeStartup({...options, metadata: {...options.metadata, testRoot}}), {code: 'INVALID_PACKAGE'});
  assert.throws(() => resolveNativeStartup({...options, args: ['--channel=development']}));
});

test('startup failure messages explain storage recovery without a stack trace', () => {
  for (const code of ['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'RECOVERY_REQUIRED', 'DEVELOPMENT_DATA_UNAVAILABLE', 'ASMB_RUNTIME_TEMP']) {
    const error = Object.assign(Error('raw\ninternal stack'), {code});
    const message = startupFailureMessage(error);
    assert.match(message, /Existing files and recovery records are retained/);
    assert.ok(message.includes(`Error: ${code}`));
    assert.ok(!message.includes('internal stack'));
    assert.ok(!message.includes('macOS'));
  }
});

test('source startup admits a configured external data root and packaged startup retains its sealed root', t => {
  const {root, testRoot, options} = fixture(t);
  const sourceRoot = path.join(root, 'custom-source-test-data'); fs.mkdirSync(sourceRoot);
  const source = {...options, packaged: false, metadata: null, sourceTestRoot: sourceRoot, args: ['--test-data-root=' + path.join(sourceRoot, 'run/data')]};
  assert.equal(resolveNativeStartup(source).testRoot, sourceRoot);
  assert.throws(() => resolveNativeStartup({...source, sourceTestRoot: appRoot}));
  assert.throws(() => resolveNativeStartup({...source, sourceTestRoot: path.join(appRoot, 'generated-tests')}));
  const packaged = {...options, metadata: {schemaVersion: 1, channel: 'development', testRoot}, sourceTestRoot: sourceRoot};
  assert.equal(resolveNativeStartup(packaged).testRoot, testRoot);
});
