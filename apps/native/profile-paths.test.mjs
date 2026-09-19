import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {packagedTestRoot, nativeProfilePaths, installedProfilePaths, ensurePhysicalDirectory, admitNativeProfile, hasPreviewDataOwnership} from './profile-paths.mjs';

const testRoot = '/Volumes/Test/asMagicBrain-Test';
const base = {args: [], testRoot, packaged: true, appData: '/unused'};
function testTemporaryRoot() {
  const temporary = fs.realpathSync(os.tmpdir());
  assert.ok(temporary.includes('/asMagicBrain-Test/'), 'Filesystem tests require TMPDIR inside asMagicBrain-Test');
  return temporary;
}
test('a packaged development build keeps a stable data root across versions and bundle locations', () => {
  const paths = nativeProfilePaths(base);
  assert.equal(paths.dataRoot, testRoot + '/packaged-preview/data');
  assert.equal(paths.profileRoot, paths.dataRoot + '-electron-profile');
  assert.equal(paths.temporaryRoot, paths.profileRoot + '/tmp');
});
test('a QA profile override is confined to the recorded Test directory', () => {
  const dataRoot = testRoot + '/runs/package/fresh';
  assert.equal(nativeProfilePaths({...base, args: ['--test-data-root=' + dataRoot]}).dataRoot, dataRoot);
  for (const invalid of ['', '.', testRoot, testRoot + '/../outside', testRoot + '-other/data']) {
    assert.throws(() => nativeProfilePaths({...base, args: ['--test-data-root=' + invalid]}));
  }
  assert.throws(() => nativeProfilePaths({...base, args: ['--test-data-root=' + dataRoot, '--test-data-root=' + dataRoot]}));
});
test('packaged metadata requires the absolute named Test directory', () => {
  assert.equal(packagedTestRoot({schemaVersion: 1, testRoot}), testRoot);
  assert.equal(packagedTestRoot({schemaVersion: 1, testRoot: '/isolated/custom-data'}), '/isolated/custom-data');
  for (const metadata of [null, {}, {schemaVersion: 1, testRoot: 'asMagicBrain-Test'}, {schemaVersion: 1, testRoot: '/'}, {schemaVersion: 2, testRoot}]) {
    assert.throws(() => packagedTestRoot(metadata));
  }
});
test('direct development launch retains its separate profile default', () => {
  assert.deepEqual(nativeProfilePaths({...base, packaged: false, appData: '/Users/test/Library/Application Support'}), {
    dataRoot: '/Users/test/Library/Application Support/asMagicBrain Native Preview/managed-data',
    profileRoot: '/Users/test/Library/Application Support/asMagicBrain Native Preview',
    temporaryRoot: '/Users/test/Library/Application Support/asMagicBrain Native Preview/tmp',
  });
});

test('installed layout separates managed documents from the OS application profile', () => {
  assert.deepEqual(installedProfilePaths({home: '/Users/person', appData: '/Users/person/Library/Application Support'}), {
    dataRoot: '/Users/person/asMagicBrain', profileRoot: '/Users/person/Library/Application Support/asMagicBrain',
    temporaryRoot: '/Users/person/Library/Application Support/asMagicBrain/tmp',
  });
  assert.throws(() => installedProfilePaths({home: 'relative', appData: '/absolute'}));
  assert.throws(() => installedProfilePaths({home: '/absolute', appData: null}));
});

test('Linux preview follows Electron XDG appData and keeps managed repositories under the user home', () => {
  for (const appData of ['/home/person/.config', '/srv/xdg/person-config']) {
    const paths = nativeProfilePaths({args: [], packaged: true, channel: 'preview', platform: 'linux', home: '/home/person', appData});
    assert.deepEqual(paths, {dataRoot: '/home/person/asMagicBrain', profileRoot: appData + '/asMagicBrain Preview', temporaryRoot: appData + '/asMagicBrain Preview/tmp'});
  }
  const home = testRoot + '/runs/linux/user-home';
  const isolated = nativeProfilePaths({...base, platform: 'linux', channel: 'preview', home: '/home/person', appData: '/srv/xdg/person-config', args: ['--test-user-home=' + home]});
  assert.deepEqual(isolated, {dataRoot: home + '/asMagicBrain', profileRoot: home + '/.config/asMagicBrain Preview', temporaryRoot: home + '/.config/asMagicBrain Preview/tmp'});
});

test('Linux preview ownership pairs an isolated .config profile and refuses a linked XDG ancestor', t => {
  const root = fs.mkdtempSync(path.join(testTemporaryRoot(), 'asmb-linux-profile-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const home = path.join(root, 'home'), args = ['--test-user-home=' + home];
  fs.mkdirSync(home);
  const paths = nativeProfilePaths({args, testRoot: root, packaged: true, channel: 'preview', platform: 'linux'});
  const outside = path.join(root, 'other-user-config'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'existing settings');
  fs.symlinkSync(outside, path.join(home, '.config'));
  assert.throws(() => admitNativeProfile({args, testRoot: root, channel: 'preview', paths}), {code: 'ASMB_PROFILE_PATH'});
  assert.equal(fs.existsSync(paths.dataRoot), false);
  assert.deepEqual(fs.readdirSync(outside), ['keep']);
  fs.unlinkSync(path.join(home, '.config'));
  admitNativeProfile({args, testRoot: root, channel: 'preview', paths});
  assert.equal(hasPreviewDataOwnership(paths.dataRoot), true);
  fs.writeFileSync(path.join(paths.dataRoot, 'saved.md'), 'retained content');
  admitNativeProfile({args, testRoot: root, channel: 'preview', paths});
  assert.equal(fs.readFileSync(path.join(paths.dataRoot, 'saved.md'), 'utf8'), 'retained content');
});

test('installed-layout qualification is isolated inside Test and cannot combine overrides', () => {
  const home = testRoot + '/runs/local-foundation/user-home';
  assert.deepEqual(nativeProfilePaths({...base, platform: 'darwin', args: ['--test-user-home=' + home]}), installedProfilePaths({home, appData: home + '/Library/Application Support'}));
  for (const invalid of ['', '.', '/Users/person', testRoot, testRoot + '/../outside', testRoot + '-other/home']) {
    assert.throws(() => nativeProfilePaths({...base, args: ['--test-user-home=' + invalid]}));
  }
  assert.throws(() => nativeProfilePaths({...base, args: ['--test-user-home=' + home, '--test-data-root=' + home]}));
  assert.throws(() => nativeProfilePaths({...base, args: ['--test-user-home=' + home, '--test-user-home=' + home]}));
});

test('profile setup refuses a linked ancestor before writing through it', t => {
  const root = fs.mkdtempSync(path.join(testTemporaryRoot(), 'asmb-profile-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'existing'));
  fs.symlinkSync(path.join(root, 'existing'), path.join(root, 'linked'));
  assert.throws(() => ensurePhysicalDirectory(path.join(root, 'linked', 'new-profile')), /physical/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'existing')), []);
  assert.equal(ensurePhysicalDirectory(path.join(root, 'physical', 'profile')), path.join(root, 'physical', 'profile'));
  fs.writeFileSync(path.join(root, 'physical', 'profile', 'keep'), 'existing user data');
  ensurePhysicalDirectory(path.join(root, 'physical', 'profile'));
  assert.equal(fs.readFileSync(path.join(root, 'physical', 'profile', 'keep'), 'utf8'), 'existing user data');
});

test('preview test overrides use a separate explicit Test home', () => {
  const home = testRoot + '/runs/configurations/preview-home';
  assert.deepEqual(nativeProfilePaths({...base, channel: 'preview', platform: 'darwin', args: [`--test-user-home=${home}`]}), {
    dataRoot: home + '/asMagicBrain', profileRoot: home + '/Library/Application Support/asMagicBrain Preview',
    temporaryRoot: home + '/Library/Application Support/asMagicBrain Preview/tmp',
  });
  for (const args of [['--test-data-root=' + home], ['--test-user-home=/Users/person'], ['--test-user-home=' + testRoot + '/packaged-preview/fake-home'], ['--test-user-home=' + testRoot + '/native-preview/fake-home']]) {
    assert.throws(() => nativeProfilePaths({...base, channel: 'preview', args}));
  }
  assert.throws(() => nativeProfilePaths({...base, channel: 'unknown'}), /Unknown/);
});

test('test-home ownership blocks cross-channel data/session sharing and never adopts unmarked preview data', t => {
  const root = fs.mkdtempSync(path.join(testTemporaryRoot(), 'asmb-channels-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const isolatedRoot = path.join(root, 'asMagicBrain-Test'); fs.mkdirSync(isolatedRoot);
  function fixture(channel, home) {
    const args = [`--test-user-home=${home}`];
    const paths = nativeProfilePaths({...base, testRoot: isolatedRoot, channel, platform: 'darwin', args});
    return {channel, args, testRoot: isolatedRoot, paths};
  }
  const preview = fixture('preview', path.join(isolatedRoot, 'preview-home'));
  admitNativeProfile(preview); admitNativeProfile(preview);
  fs.writeFileSync(path.join(preview.paths.dataRoot, 'preserve'), 'user work');
  admitNativeProfile(preview);
  assert.throws(() => admitNativeProfile(fixture('development', path.join(isolatedRoot, 'preview-home'))), /another native build channel/);
  assert.throws(() => admitNativeProfile({channel: 'development', testRoot: isolatedRoot, args: [`--test-data-root=${preview.paths.dataRoot}`], paths: preview.paths}), /another native build channel/);
  assert.equal(fs.readFileSync(path.join(preview.paths.dataRoot, 'preserve'), 'utf8'), 'user work');

  const development = fixture('development', path.join(isolatedRoot, 'development-home'));
  admitNativeProfile(development);
  assert.throws(() => admitNativeProfile(fixture('preview', path.join(isolatedRoot, 'development-home'))), /another native build channel/);

  const unmarked = fixture('preview', path.join(isolatedRoot, 'unmarked-home'));
  fs.mkdirSync(unmarked.paths.dataRoot, {recursive: true}); fs.writeFileSync(path.join(unmarked.paths.dataRoot, 'keep'), 'legacy work');
  assert.throws(() => admitNativeProfile(unmarked), /no ownership record/);
  assert.equal(fs.readFileSync(path.join(unmarked.paths.dataRoot, 'keep'), 'utf8'), 'legacy work');
  assert.equal(fs.existsSync(path.join(isolatedRoot, 'unmarked-home/.asmagicbrain-channel.json')), false);
});

test('channel ownership refuses linked or malformed records without profile creation', t => {
  const root = fs.mkdtempSync(path.join(testTemporaryRoot(), 'asmb-channel-record-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const options = {args: [`--test-user-home=${home}`], testRoot: root, channel: 'preview', paths: {dataRoot: path.join(home, 'asMagicBrain'), profileRoot: path.join(home, 'Library/Application Support/asMagicBrain Preview')}};
  const record = path.join(home, '.asmagicbrain-channel.json');
  fs.writeFileSync(record, JSON.stringify({schemaVersion: 1, channel: 'production'}));
  assert.throws(() => admitNativeProfile(options), /Unknown/);
  fs.unlinkSync(record); fs.writeFileSync(path.join(root, 'foreign'), JSON.stringify({schemaVersion: 1, channel: 'preview'})); fs.symlinkSync(path.join(root, 'foreign'), record);
  assert.throws(() => admitNativeProfile(options), /physical/);
  assert.equal(fs.existsSync(options.paths.dataRoot), false);
});

function fixture(t, prefix = 'preview-owned-') {
  const temporary = testTemporaryRoot();
  const root = fs.mkdtempSync(path.join(temporary, prefix));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const home = path.join(root, 'home'), appData = path.join(home, 'Library/Application Support');
  fs.mkdirSync(home);
  const paths = nativeProfilePaths({args: [], channel: 'preview', packaged: true, home, appData});
  return {root, home, appData, paths, options: {channel: 'preview', args: [], paths}};
}
const marker = directory => path.join(directory, '.asmagicbrain-channel.json');
const bytes = filename => fs.readFileSync(filename, 'utf8');

test('ordinary packaged preview uses supplied OS paths without any Test dependency', () => {
  const home = '/Users/person', appData = '/Users/person/Library/Application Support';
  assert.deepEqual(nativeProfilePaths({packaged: true, channel: 'preview', home, appData}), {
    dataRoot: home + '/asMagicBrain', profileRoot: appData + '/asMagicBrain Preview', temporaryRoot: appData + '/asMagicBrain Preview/tmp',
  });
  assert.throws(() => nativeProfilePaths({packaged: false, channel: 'preview', home, appData}), {code: 'ASMB_PROFILE_ARGUMENT'});
  assert.throws(() => nativeProfilePaths({packaged: true, channel: 'preview', appData}), {code: 'ASMB_PROFILE_PATH'});
  const args = ['--test-user-home=' + testRoot + '/runs/home'];
  assert.throws(() => nativeProfilePaths({packaged: true, channel: 'preview', home, appData, args}), {code: 'ASMB_PROFILE_ARGUMENT'});
});

test('first preview admission owns fresh physical roots and restart/update retains every byte and mode', t => {
  const {paths, options} = fixture(t);
  admitNativeProfile(options);
  const originals = new Map();
  for (const [role, directory] of [['data', paths.dataRoot], ['profile', paths.profileRoot]]) {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(marker(directory)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(bytes(marker(directory))), {schemaVersion: 2, channel: 'preview', role, dataRoot: paths.dataRoot, profileRoot: paths.profileRoot});
    fs.writeFileSync(path.join(directory, 'keep'), `${role} saved data and settings`, {mode: 0o640});
    originals.set(directory, {record: bytes(marker(directory)), inode: fs.statSync(marker(directory)).ino});
  }
  admitNativeProfile(options);
  admitNativeProfile({...options, version: 'future-version'});
  for (const [role, directory] of [['data', paths.dataRoot], ['profile', paths.profileRoot]]) {
    assert.equal(bytes(path.join(directory, 'keep')), `${role} saved data and settings`);
    assert.equal(fs.statSync(path.join(directory, 'keep')).mode & 0o777, 0o640);
    assert.equal(bytes(marker(directory)), originals.get(directory).record);
    assert.equal(fs.statSync(marker(directory)).ino, originals.get(directory).inode);
  }
});

test('unmarked managed or profile roots, including empty roots, reject without creating the other root', t => {
  for (const rootName of ['dataRoot', 'profileRoot']) for (const content of ['', 'prior user data']) {
    const {paths, options} = fixture(t);
    fs.mkdirSync(paths[rootName], {recursive: true});
    if (content) fs.writeFileSync(path.join(paths[rootName], 'keep'), content, {mode: 0o640});
    assert.throws(() => admitNativeProfile(options), {code: 'ASMB_PROFILE_UNOWNED'});
    assert.deepEqual(fs.readdirSync(paths[rootName]), content ? ['keep'] : []);
    assert.equal(fs.existsSync(paths[rootName === 'dataRoot' ? 'profileRoot' : 'dataRoot']), false);
    if (content) assert.equal(bytes(path.join(paths[rootName], 'keep')), content);
  }
});

test('foreign and mismatched marked roots reject before creating a profile', t => {
  for (const record of [
    {schemaVersion: 1, channel: 'development'},
    {schemaVersion: 1, channel: 'preview'},
    {schemaVersion: 2, channel: 'preview', role: 'profile', dataRoot: '/elsewhere', profileRoot: '/elsewhere-profile'},
  ]) {
    const {paths, options} = fixture(t);
    fs.mkdirSync(paths.dataRoot);
    fs.writeFileSync(marker(paths.dataRoot), JSON.stringify(record));
    assert.throws(() => admitNativeProfile(options), {code: 'ASMB_PROFILE_OWNERSHIP'});
    assert.equal(fs.existsSync(paths.profileRoot), false);
    assert.equal(bytes(marker(paths.dataRoot)), JSON.stringify(record));
  }
});

test('interrupted mkdir and marker writes never authorize adoption of later data', t => {
  for (const content of [null, '', '{"schemaVersion":2']) {
    const {paths, options} = fixture(t);
    fs.mkdirSync(paths.dataRoot);
    if (content !== null) fs.writeFileSync(marker(paths.dataRoot), content);
    fs.writeFileSync(path.join(paths.dataRoot, 'keep'), 'added after interrupted admission');
    assert.throws(() => admitNativeProfile(options), error => /^ASMB_PROFILE_(UNOWNED|OWNERSHIP)$/.test(error.code));
    assert.equal(bytes(path.join(paths.dataRoot, 'keep')), 'added after interrupted admission');
    assert.equal(fs.existsSync(paths.profileRoot), false);
    if (content !== null) assert.equal(bytes(marker(paths.dataRoot)), content);
  }
});

test('marker permission failure remains an unowned preserved root on restart', t => {
  const {paths, options} = fixture(t), originalOpen = fs.openSync;
  const open = t.mock.method(fs, 'openSync', (...args) => {
    if (args[0] === marker(paths.dataRoot)) throw Object.assign(new Error('permission denied'), {code: 'EACCES'});
    return originalOpen(...args);
  });
  assert.throws(() => admitNativeProfile(options), {code: 'EACCES'});
  open.mock.restore();
  assert.deepEqual(fs.readdirSync(paths.dataRoot), []);
  assert.equal(fs.existsSync(paths.profileRoot), false);
  fs.writeFileSync(path.join(paths.dataRoot, 'keep'), 'preserved');
  assert.throws(() => admitNativeProfile(options), {code: 'ASMB_PROFILE_UNOWNED'});
  assert.equal(bytes(path.join(paths.dataRoot, 'keep')), 'preserved');
});

test('a failure before the second root is created permits safe retry of the first owned root', t => {
  const {paths, options} = fixture(t), originalMkdir = fs.mkdirSync;
  const mkdir = t.mock.method(fs, 'mkdirSync', (...args) => {
    if (args[0] === paths.profileRoot) throw Object.assign(new Error('permission denied'), {code: 'EACCES'});
    return originalMkdir(...args);
  });
  assert.throws(() => admitNativeProfile(options), {code: 'EACCES'});
  mkdir.mock.restore();
  const record = bytes(marker(paths.dataRoot));
  fs.writeFileSync(path.join(paths.dataRoot, 'keep'), 'preserved on retry');
  admitNativeProfile(options);
  assert.equal(bytes(marker(paths.dataRoot)), record);
  assert.equal(bytes(path.join(paths.dataRoot, 'keep')), 'preserved on retry');
  assert.equal(JSON.parse(bytes(marker(paths.profileRoot))).role, 'profile');
});

test('a root appearing after preflight is never adopted or overwritten', t => {
  const {paths, options} = fixture(t), originalMkdir = fs.mkdirSync;
  const mkdir = t.mock.method(fs, 'mkdirSync', (...args) => {
    if (args[0] === paths.dataRoot) originalMkdir(paths.dataRoot);
    return originalMkdir(...args);
  });
  assert.throws(() => admitNativeProfile(options), {code: 'EEXIST'});
  mkdir.mock.restore();
  assert.deepEqual(fs.readdirSync(paths.dataRoot), []);
  assert.equal(fs.existsSync(paths.profileRoot), false);
});

test('linked root, ancestor, dangling ownership record and hardlinked record preserve their targets', t => {
  for (const kind of ['root', 'ancestor', 'dangling-marker', 'hardlinked-marker']) {
    const {root, home, paths, options} = fixture(t);
    const foreign = path.join(root, 'foreign'); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'keep'), 'foreign data');
    if (kind === 'root') fs.symlinkSync(foreign, paths.dataRoot);
    if (kind === 'ancestor') fs.symlinkSync(foreign, path.join(home, 'Library'));
    if (kind.includes('marker')) {
      fs.mkdirSync(paths.dataRoot);
      if (kind === 'dangling-marker') fs.symlinkSync(path.join(foreign, 'missing'), marker(paths.dataRoot));
      else {fs.writeFileSync(path.join(foreign, 'record'), '{}'); fs.linkSync(path.join(foreign, 'record'), marker(paths.dataRoot));}
    }
    assert.throws(() => admitNativeProfile(options), error => /^ASMB_PROFILE_(PATH|OWNERSHIP)$/.test(error.code));
    assert.equal(bytes(path.join(foreign, 'keep')), 'foreign data');
    assert.equal(fs.existsSync(paths.profileRoot), false);
    assert.equal(fs.existsSync(path.join(foreign, 'missing')), false);
    if (kind === 'ancestor') assert.equal(fs.existsSync(paths.dataRoot), false);
  }
});

test('recognized v027 preview test homes retain physical data and settings without migration', t => {
  const {root, home, paths} = fixture(t);
  fs.writeFileSync(marker(home), JSON.stringify({schemaVersion: 1, channel: 'preview'}));
  for (const directory of [paths.dataRoot, paths.profileRoot]) {
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(path.join(directory, 'legacy'), 'v027 data', {mode: 0o600});
  }
  const options = {args: [`--test-user-home=${home}`], testRoot: root, channel: 'preview', paths};
  admitNativeProfile(options);
  for (const directory of [paths.dataRoot, paths.profileRoot]) {
    assert.deepEqual(fs.readdirSync(directory), ['legacy']);
    assert.equal(bytes(path.join(directory, 'legacy')), 'v027 data');
  }
  assert.throws(() => admitNativeProfile({...options, args: [], testRoot: undefined}), {code: 'ASMB_PROFILE_UNOWNED'});
});

test('development defaults remain untouched and cannot adopt preview-owned test data', t => {
  const {root, home, paths, options} = fixture(t);
  admitNativeProfile({channel: 'development', args: [], paths});
  assert.equal(fs.existsSync(paths.dataRoot), false);
  assert.equal(fs.existsSync(paths.profileRoot), false);
  admitNativeProfile(options);
  for (const args of [[`--test-user-home=${home}`], [`--test-data-root=${paths.dataRoot}`], [`--test-data-root=${paths.dataRoot}/nested`]]) {
    const developmentPaths = nativeProfilePaths({args, testRoot: root, channel: 'development', packaged: true, platform: 'darwin'});
    assert.throws(() => admitNativeProfile({args, testRoot: root, channel: 'development', paths: developmentPaths}), {code: 'ASMB_PROFILE_OWNERSHIP'});
  }
});

test('a partial marker caused by storage exhaustion is preserved and never repaired automatically', t => {
  const {paths, options} = fixture(t), originalWrite = fs.writeFileSync;
  const write = t.mock.method(fs, 'writeFileSync', (...args) => {
    if (typeof args[0] === 'number') {
      originalWrite(args[0], '{"schemaVersion":2');
      throw Object.assign(new Error('disk full'), {code: 'ENOSPC'});
    }
    return originalWrite(...args);
  });
  assert.throws(() => admitNativeProfile(options), {code: 'ENOSPC'});
  write.mock.restore();
  assert.equal(bytes(marker(paths.dataRoot)), '{"schemaVersion":2');
  assert.throws(() => admitNativeProfile(options), {code: 'ASMB_PROFILE_OWNERSHIP'});
  assert.equal(bytes(marker(paths.dataRoot)), '{"schemaVersion":2');
  assert.equal(fs.existsSync(paths.profileRoot), false);
});

test('ownership read permission errors retain their filesystem code for startup guidance', t => {
  const {paths, options} = fixture(t);
  admitNativeProfile(options);
  const originalRead = fs.readFileSync, before = bytes(marker(paths.dataRoot));
  const read = t.mock.method(fs, 'readFileSync', (...args) => {
    if (args[0] === marker(paths.dataRoot)) throw Object.assign(new Error('permission denied'), {code: 'EACCES'});
    return originalRead(...args);
  });
  assert.throws(() => admitNativeProfile(options), {code: 'EACCES'});
  read.mock.restore();
  assert.equal(bytes(marker(paths.dataRoot)), before);
});

test('host ownership proof is read-only, absent for unmarked roots, and requires the exact paired profile', t => {
  const {paths, options} = fixture(t);
  assert.equal(hasPreviewDataOwnership(paths.dataRoot), false);
  assert.equal(fs.existsSync(paths.dataRoot), false);
  admitNativeProfile(options);
  assert.equal(hasPreviewDataOwnership(paths.dataRoot), true);
  const dataMarker = bytes(marker(paths.dataRoot)), profileMarker = bytes(marker(paths.profileRoot));
  const dataInode = fs.statSync(marker(paths.dataRoot)).ino;
  assert.equal(hasPreviewDataOwnership(paths.dataRoot), true);
  assert.equal(bytes(marker(paths.dataRoot)), dataMarker);
  assert.equal(fs.statSync(marker(paths.dataRoot)).ino, dataInode);
  fs.unlinkSync(marker(paths.profileRoot));
  assert.throws(() => hasPreviewDataOwnership(paths.dataRoot), {code: 'ASMB_PROFILE_OWNERSHIP'});
  fs.writeFileSync(marker(paths.profileRoot), JSON.stringify({...JSON.parse(profileMarker), dataRoot: '/other-root'}));
  assert.throws(() => hasPreviewDataOwnership(paths.dataRoot), {code: 'ASMB_PROFILE_OWNERSHIP'});
  assert.equal(bytes(marker(paths.dataRoot)), dataMarker);
  fs.unlinkSync(marker(paths.dataRoot));
  assert.equal(hasPreviewDataOwnership(paths.dataRoot), false);
});

test('host ownership proof rejects foreign, malformed, linked and oversized records before reading large content', t => {
  for (const kind of ['foreign', 'malformed', 'linked', 'oversized']) {
    const {paths, options} = fixture(t);
    admitNativeProfile(options);
    const filename = marker(paths.dataRoot);
    if (kind === 'foreign') fs.writeFileSync(filename, JSON.stringify({schemaVersion: 1, channel: 'development'}));
    if (kind === 'malformed') fs.writeFileSync(filename, '{');
    if (kind === 'linked') {fs.unlinkSync(filename); fs.symlinkSync(marker(paths.profileRoot), filename);}
    if (kind === 'oversized') fs.writeFileSync(filename, ' '.repeat(4097));
    const originalRead = fs.readFileSync;
    const read = t.mock.method(fs, 'readFileSync', (...args) => {
      if (kind === 'oversized' && args[0] === filename) assert.fail('Oversized marker must be rejected before reading');
      return originalRead(...args);
    });
    assert.throws(() => hasPreviewDataOwnership(paths.dataRoot), {code: 'ASMB_PROFILE_OWNERSHIP'});
    read.mock.restore();
    assert.deepEqual(fs.readdirSync(paths.dataRoot), ['.asmagicbrain-channel.json']);
  }
});
