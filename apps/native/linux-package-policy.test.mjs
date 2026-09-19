import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {linuxPackageIdentity, linuxControl, linuxDesktopEntry, linuxAppArmorProfile, linuxMaintainerScripts, applyLinuxFuses, assertLinuxPackageModes, moveLinuxPackageEvidence} from './linux-package-policy.mjs';
import {inventory} from './package-support.mjs';
const attribution = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('Ubuntu namespace grants bind exact protected binaries and distinct channels', () => {
  for (const channel of ['development', 'preview']) {
    const identity = linuxPackageIdentity(channel), profile = linuxAppArmorProfile(channel);
    assert.ok(profile.includes(`${identity.executable} flags=(unconfined)`));
    assert.match(profile, /\buserns,/); assert.doesNotMatch(profile, /\*|\/home\//);
    assert.match(linuxDesktopEntry(channel), new RegExp(`Exec=${identity.executable}\\n`));
    assert.doesNotMatch(linuxDesktopEntry(channel), /--no-sandbox|%[fFuU]/);
  }
  assert.notEqual(linuxPackageIdentity('development').installRoot, linuxPackageIdentity('preview').installRoot);
  assert.throws(() => linuxPackageIdentity('preview\ninjected'));
});

test('Debian control rejects version/size injection and declares baseline', () => {
  const control = linuxControl({attribution, channel:'preview',version:'0.2.11',installedSize:1000});
  assert.match(control, /Architecture: amd64/); assert.match(control, /apparmor \(>= 4.0\)/); assert.match(control, /libc6 \(>= 2.39\)/);
  assert.throws(() => linuxControl({attribution, channel:'preview',version:'1.2.3\nDepends: bad',installedSize:1}));
  assert.throws(() => linuxControl({attribution, channel:'preview',version:'1.2.3',installedSize:NaN}));
});

test('Debian dependencies include the pinned Git ELF runtime system packages', () => {
  const runtime = JSON.parse(fs.readFileSync(new URL('./git-runtime-linux-x64.json', import.meta.url), 'utf8'));
  const control = linuxControl({attribution, channel: 'preview', version: '0.2.11', installedSize: 1000});
  const dependencyNames = new Set(control.match(/^Depends: (.+)$/m)[1].split(',').map(value => value.trim().split(/[ (]/)[0]));
  assert.ok(runtime.systemDependencies.ubuntuPackages.length > 0);
  for (const name of runtime.systemDependencies.ubuntuPackages) assert.ok(dependencyNames.has(name), `Missing bundled Git system dependency: ${name}`);
});

test('Debian dependencies explicitly include reviewed Electron ELF loader libraries', () => {
  const control = linuxControl({attribution, channel: 'preview', version: '0.2.11', installedSize: 1000});
  const dependencyNames = new Set(control.match(/^Depends: (.+)$/m)[1].split(',').map(value => value.trim().split(/[ (]/)[0]));
  // DT_NEEDED in the pinned electron-v44.4.0-linux-x64.zip executable includes
  // both libraries. Do not rely on unrelated desktop packages installing them.
  for (const [library, name] of [['libudev.so.1', 'libudev1'], ['libgcc_s.so.1', 'libgcc-s1']]) {
    assert.ok(dependencyNames.has(name), `Missing Electron dependency ${name} for ${library}`);
  }
});

test('package lifecycle scripts scope policy and preserve all user data', () => {
  const {postinst, postrm} = linuxMaintainerScripts('preview');
  assert.match(postinst, /apparmor_parser -r \/etc\/apparmor.d\/asmagicbrain-preview/);
  assert.match(postrm, /profile asmagicbrain-preview \{\}/);
  for (const script of [postinst, postrm]) assert.doesNotMatch(script, /\brm\b|sysctl|chmod|chown|\/home|\$HOME|no-sandbox/);
});

test('Linux fuses remove Node injection while preserving fixed workers and session-only cookies', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'linux-fuses-')), filename=path.join(root,'electron');
  const input=Buffer.concat([Buffer.from('ELF-data-dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),Buffer.from([1,9]),Buffer.from('101100011')]);
  fs.writeFileSync(filename,input);
  const result=applyLinuxFuses(filename); assert.equal(result.after.wire,'100000011');
  assert.equal(result.after.cookieEncryption,false); assert.throws(()=>applyLinuxFuses(filename));
  fs.writeFileSync(filename,Buffer.from('unknown')); assert.throws(()=>applyLinuxFuses(filename));
});

test('Linux package rejects setuid and writable executable input', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'linux-modes-')), filename=path.join(root,'chrome-sandbox');
  fs.writeFileSync(filename,'fixture',{mode:0o755}); assertLinuxPackageModes(root);
  fs.chmodSync(filename,0o4755);
  if (fs.lstatSync(filename).mode & 0o4000) assert.throws(()=>assertLinuxPackageModes(root),/Unsafe/);
  else {assert.notEqual(process.platform,'linux','Linux qualification requires a filesystem that retains setuid fixture modes');t.diagnostic('Host filesystem clears setuid; that assertion must run on Linux.');}
  fs.chmodSync(filename,0o777); assert.throws(()=>assertLinuxPackageModes(root),/Unsafe/);
});

function evidenceFixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'linux-evidence-'));
  const source = path.join(root, 'stage'), destination = path.join(root, 'receipt');
  fs.mkdirSync(path.join(source, 'bin'), {recursive: true, mode: 0o755});
  fs.writeFileSync(path.join(source, 'bin/tool'), 'inert executable fixture', {mode: 0o755});
  fs.writeFileSync(path.join(source, 'manifest.json'), '{"fixture":true}\n', {mode: 0o600});
  fs.symlinkSync('bin/tool', path.join(source, 'tool-link'));
  return {root, source, destination, before: inventory(source, {internalLinks: true})};
}
const differentFilesystem = () => {throw Object.assign(Error('Injected cross-device rename'), {code: 'EXDEV'});};

test('owned package evidence moves on one filesystem and copies verified bytes and relative links on EXDEV', () => {
  for (const options of [{}, {rename: differentFilesystem}]) {
    const {source, destination, before} = evidenceFixture();
    moveLinuxPackageEvidence(source, destination, options);
    assert.equal(fs.existsSync(source), false);
    assert.deepEqual(inventory(destination, {internalLinks: true}), before);
    assert.equal(fs.readlinkSync(path.join(destination, 'tool-link')), 'bin/tool');
  }
});

test('cross-filesystem evidence restores exact directory modes under Ubuntu umask 0002', () => {
  const previous = process.umask(0o002);
  let source, destination, before, copiedMode;
  try {
    ({source, destination, before} = evidenceFixture());
    moveLinuxPackageEvidence(source, destination, {rename: differentFilesystem, copy: (...args) => {
      fs.cpSync(...args);
      // Force the Linux fs.cp directory result on hosts that already preserve it.
      fs.chmodSync(path.join(destination, 'bin'), 0o775);
      copiedMode = fs.lstatSync(path.join(destination, 'bin')).mode & 0o777;
    }});
  } finally {process.umask(previous);}
  assert.equal(copiedMode, 0o775);
  assert.equal(fs.existsSync(source), false);
  assert.deepEqual(inventory(destination, {internalLinks: true}), before);
});

test('mode restoration rejects unexpected copied links before touching their target', () => {
  const {source, destination, before} = evidenceFixture();
  assert.throws(() => moveLinuxPackageEvidence(source, destination, {rename: differentFilesystem, copy: (...args) => {
    fs.cpSync(...args);
    fs.unlinkSync(path.join(destination, 'bin/tool'));
    fs.symlinkSync('../manifest.json', path.join(destination, 'bin/tool'));
  }}), /copy differs/);
  assert.equal(fs.lstatSync(path.join(destination, 'manifest.json')).mode & 0o777, 0o600);
  assert.deepEqual(inventory(source, {internalLinks: true}), before);
});

test('a corrupt cross-filesystem copy preserves the complete source and failed destination', () => {
  const {source, destination, before} = evidenceFixture();
  assert.throws(() => moveLinuxPackageEvidence(source, destination, {rename: differentFilesystem, copy: (...args) => {
    fs.cpSync(...args); fs.writeFileSync(path.join(destination, 'bin/tool'), 'corrupted copy');
  }}), /copy differs/);
  assert.deepEqual(inventory(source, {internalLinks: true}), before);
  assert.equal(fs.readFileSync(path.join(destination, 'bin/tool'), 'utf8'), 'corrupted copy');
  assert.throws(() => moveLinuxPackageEvidence(source, destination), /already exists/);
  assert.deepEqual(inventory(source, {internalLinks: true}), before);
});

test('interrupted evidence copies and unrelated rename failures do not remove the source', () => {
  const interrupted = evidenceFixture();
  assert.throws(() => moveLinuxPackageEvidence(interrupted.source, interrupted.destination, {rename: differentFilesystem, copy: (_source, destination) => {
    fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, 'partial'), 'retained failure evidence');
    throw Object.assign(Error('Injected storage failure'), {code: 'ENOSPC'});
  }}), {code: 'ENOSPC'});
  assert.deepEqual(inventory(interrupted.source, {internalLinks: true}), interrupted.before);
  assert.equal(fs.readFileSync(path.join(interrupted.destination, 'partial'), 'utf8'), 'retained failure evidence');
  const denied = evidenceFixture();
  assert.throws(() => moveLinuxPackageEvidence(denied.source, denied.destination, {rename: () => {
    throw Object.assign(Error('Injected permission failure'), {code: 'EACCES'});
  }, copy: () => assert.fail('Only EXDEV permits a copy fallback')}), {code: 'EACCES'});
  assert.deepEqual(inventory(denied.source, {internalLinks: true}), denied.before);
  assert.equal(fs.existsSync(denied.destination), false);
});
