import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {inventory, sha256, requireUnencryptedCookieStore} from './package-support.mjs';
import {verifyGitRuntime} from '../../packages/desktop-host/src/git-executable.mjs';
import {externalCodeLayout, externalFramework, externalGit, enumerateExternalCode, applyExternalFuses} from './external-package-policy.mjs';
import {inspectExternalPackageInput, packageExternalPreview, selectDeveloperIdentity, externalPackageCLI} from './external-package.mjs';
import {createExternalPackageFixture, mockPackageRunner, fixtureIdentity, fixtureTeam, fixtureAttribution} from './external-package-test-fixture.mjs';
import {externalTestRoot, testDirectory} from './external-delivery-verify.mjs';
import {testRoot} from '../../tools/development-paths.mjs';

test('external fixtures and output admission share the configured external test root', () => {
  assert.equal(externalTestRoot, testRoot);
  const fixture = createExternalPackageFixture();
  assert.ok(fixture.directory.startsWith(testRoot + path.sep));
  assert.equal(testDirectory(fixture.options.workDirectory), fixture.options.workDirectory);
  assert.throws(() => testDirectory(path.dirname(testRoot)), {code: 'EXTERNAL_OUTPUT_OUTSIDE_TEST'});
});

const syntheticVerify = ({bundle, manifest}) => {
  const declared = JSON.parse(fs.readFileSync(manifest));
  assert.deepEqual(inventory(bundle, {internalLinks: true}), declared.entries);
  assert.equal(requireUnencryptedCookieStore(fs.readFileSync(path.join(bundle, externalFramework))).wire, '100000011');
  verifyGitRuntime(path.join(bundle, externalGit), {manifestSha256: declared.bundledGit.manifestSha256});
  return {status: 'verified', evidenceMode: 'injected-command-test'};
};
function expectRefusal(fixture, change, code) {
  const commands = [], options = {...fixture.options}; change(options);
  assert.throws(() => packageExternalPreview(options, {runCommand: mockPackageRunner({commands}), verifyArtifact: syntheticVerify}), {code});
  assert.equal(fs.existsSync(fixture.options.outputDirectory), false);
  assert.equal(commands.some(row => row.exe === '/usr/bin/codesign' && row.args.includes('--sign')), false);
  return commands;
}

test('finite code policy covers every physical target and orders children before enclosing seals', () => {
  const fixture = createExternalPackageFixture(), targets = enumerateExternalCode(fixture.options.bundle);
  assert.equal(targets.length, 25); assert.equal(new Set(targets.map(row => row.executable)).size, 25);
  assert.equal(targets.at(-1).path, '.');
  assert.equal(targets.filter(row => row.entitlements.length).length, 5);
  for (const target of targets) {
    assert.deepEqual(target.entitlements, ['main', 'electron-helper'].includes(target.role) ? ['com.apple.security.cs.allow-jit'] : []);
    for (const child of targets) if (child.path !== target.path && child.path.startsWith(target.path + '/')) assert.ok(targets.indexOf(child) < targets.indexOf(target));
  }
  const surprise = path.join(fixture.options.bundle, 'Contents/Resources/extra');
  fs.copyFileSync(path.join(fixture.options.bundle, targets[0].executable), surprise);
  assert.throws(() => enumerateExternalCode(fixture.options.bundle), {code: 'EXTERNAL_UNEXPECTED_MACHO'});
});

test('fuse transform changes exactly NODE_OPTIONS and CLI inspect bytes, retains RunAsNode/cookies policy', () => {
  const fixture = createExternalPackageFixture(), filename = path.join(fixture.options.bundle, externalFramework), before = fs.readFileSync(filename);
  assert.deepEqual(applyExternalFuses(fixture.options.bundle), {before: {version: 1, wire: '101100011', cookieEncryption: false}, after: {version: 1, wire: '100000011', cookieEncryption: false}});
  const after = fs.readFileSync(filename), differences = [...before.keys()].filter(i => before[i] !== after[i]);
  assert.deepEqual(differences, [100, 101]);
  assert.throws(() => applyExternalFuses(fixture.options.bundle), {code: 'EXTERNAL_INPUT_FUSES'});
});

test('read-only plan binds tag and exact inputs without identity lookup or any writes', () => {
  const fixture = createExternalPackageFixture(), commands = [], before = inventory(fixture.directory, {internalLinks: true});
  const plan = inspectExternalPackageInput(fixture.options, {runCommand: mockPackageRunner({commands})});
  assert.equal(plan.status, 'planned'); assert.equal(plan.codeTargets.length, 25); assert.equal(plan.taggedInputs, 1);
  assert.equal(commands.some(row => row.exe === '/usr/bin/security' || row.exe === '/usr/bin/ditto' || row.args.includes('--sign')), false);
  assert.deepEqual(inventory(fixture.directory, {internalLinks: true}), before);
});

test('tracked PNG bytes survive source admission and altered binary input fails even with a regenerated manifest', () => {
  const fixture = createExternalPackageFixture({binaryInput: true});
  const input = fixture.original.inputs.find(row => row.path.endsWith('.png'));
  const filename = path.join(fixture.options.bundle, 'Contents/Resources/app', input.path), bytes = fs.readFileSync(filename);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.notEqual(sha256(Buffer.from(bytes.toString('utf8'))), input.sha256, 'Fixture must expose lossy text decoding.');
  const before = inventory(fixture.directory, {internalLinks: true}), commands = [];
  const plan = inspectExternalPackageInput(fixture.options, {runCommand: mockPackageRunner({commands})});
  assert.equal(plan.status, 'planned'); assert.equal(plan.taggedInputs, 2);
  assert.deepEqual(inventory(fixture.directory, {internalLinks: true}), before);
  assert.equal(commands.some(row => row.exe === '/usr/bin/security' || row.exe === '/usr/bin/ditto' || row.args.includes('--sign')), false);
  bytes[bytes.length - 1] ^= 1; fs.writeFileSync(filename, bytes);
  input.sha256 = sha256(bytes); fixture.original.entries = inventory(fixture.options.bundle, {internalLinks: true});
  fs.writeFileSync(fixture.options.inputManifest, JSON.stringify(fixture.original));
  fixture.options.inputManifestSha256 = sha256(fs.readFileSync(fixture.options.inputManifest));
  expectRefusal(fixture, () => {}, 'EXTERNAL_TAGGED_SOURCE_CHANGED');
});

test('metadata reissue planning requires the revision declared in the tagged release', () => {
  const fixture = createExternalPackageFixture({metadataRevision: 1}), commands = [];
  const before = inventory(fixture.directory, {internalLinks: true});
  const plan = inspectExternalPackageInput(fixture.options, {runCommand: mockPackageRunner({commands})});
  assert.equal(plan.status, 'planned'); assert.equal(plan.sourceTag, 'native-v0.2.8-metadata.1');
  assert.deepEqual(inventory(fixture.directory, {internalLinks: true}), before);
  assert.equal(commands.some(row => row.exe === '/usr/bin/security' || row.exe === '/usr/bin/ditto' || row.args.includes('--sign')), false);
  for (const options of [{metadataRevision: 1, sourceTag: 'native-v0.2.8'}, {metadataRevision: 1, sourceTag: 'native-v0.2.8-metadata.2'}, {sourceTag: 'native-v0.2.8-metadata.1'}]) {
    expectRefusal(createExternalPackageFixture(options), () => {}, 'EXTERNAL_TAGGED_RELEASE');
  }
});

test('tagged attribution binds manifest, native metadata, generated package and copyright before signing', () => {
  const healthy = createExternalPackageFixture({metadataRevision: 1, attribution: fixtureAttribution});
  assert.equal(inspectExternalPackageInput(healthy.options, {runCommand: mockPackageRunner()}).status, 'planned');
  for (const change of ['substitute', 'omit', 'package', 'copyright']) {
    const fixture = createExternalPackageFixture({metadataRevision: 1, attribution: fixtureAttribution});
    const nativePath = path.join(fixture.options.bundle, 'Contents/Resources/app/native-package.json');
    const metadata = JSON.parse(fs.readFileSync(nativePath));
    if (change === 'substitute') {
      metadata.attribution.author.name = 'Uncommitted Other Author';
      fixture.original.attribution = metadata.attribution;
    } else if (change === 'omit') {
      delete metadata.attribution; delete fixture.original.attribution;
    } else {
      const filename = path.join(fixture.options.bundle, change === 'package' ? 'Contents/Resources/app/package.json' : 'Contents/Info.plist');
      const value = JSON.parse(fs.readFileSync(filename));
      if (change === 'package') value.author.email = 'other@example.invalid'; else value.NSHumanReadableCopyright = 'Substituted copyright';
      fs.writeFileSync(filename, JSON.stringify(value));
    }
    fs.writeFileSync(nativePath, JSON.stringify(metadata));
    fixture.original.entries = inventory(fixture.options.bundle, {internalLinks: true});
    fs.writeFileSync(fixture.options.inputManifest, JSON.stringify(fixture.original));
    fixture.options.inputManifestSha256 = sha256(fs.readFileSync(fixture.options.inputManifest));
    expectRefusal(fixture, () => {}, change === 'package' ? 'EXTERNAL_PACKAGE_ATTRIBUTION' : change === 'copyright' ? 'EXTERNAL_ATTRIBUTION_PLIST' : 'EXTERNAL_TAGGED_ATTRIBUTION');
  }
});

test('missing or mismatched signing identity refuses before output and signing', () => {
  const fixture = createExternalPackageFixture();
  assert.equal(expectRefusal(fixture, options => {delete options.identitySha1;}, 'EXTERNAL_SIGNING_IDENTITY').length, 0);
  const commands = [];
  assert.throws(() => packageExternalPreview(fixture.options, {runCommand: mockPackageRunner({commands, identityOutput: `1) ${fixtureIdentity} "Developer ID Application: Wrong Team (XXXXXXXXXX)"`}), verifyArtifact: syntheticVerify}), {code: 'EXTERNAL_IDENTITY_UNAVAILABLE'});
  assert.equal(fs.existsSync(fixture.options.outputDirectory), false); assert.equal(commands.some(row => row.exe === '/usr/bin/ditto'), false);
  assert.throws(() => selectDeveloperIdentity(`1) ${fixtureIdentity} "Apple Development: Test (${fixtureTeam})"`, fixtureIdentity, fixtureTeam), {code: 'EXTERNAL_IDENTITY_UNAVAILABLE'});
  assert.throws(() => selectDeveloperIdentity(`1) ${fixtureIdentity} "Developer ID Application: Test (${fixtureTeam})"\n2) ${fixtureIdentity} "Developer ID Application: Test (${fixtureTeam})"`, fixtureIdentity, fixtureTeam), {code: 'EXTERNAL_IDENTITY_UNAVAILABLE'});
});

test('tampered inputs, manifest pins, source tags and unknown options fail before output', () => {
  const fixture = createExternalPackageFixture();
  expectRefusal(fixture, options => {options.inputManifestSha256 = 'f'.repeat(64);}, 'EXTERNAL_INPUT_MANIFEST_PIN');
  expectRefusal(fixture, options => {options.password = 'must-not-be-used';}, 'EXTERNAL_OPTIONS');
  expectRefusal(fixture, options => {options.expected = {...options.expected, extra: 'must-not-be-used'};}, 'EXTERNAL_EXPECTED_OPTIONS');
  expectRefusal(fixture, options => {options.expected = {...options.expected, sourceCommit: 'b'.repeat(40)};}, 'EXTERNAL_SOURCE_MISMATCH');
  fs.appendFileSync(path.join(fixture.options.bundle, 'Contents/Resources/app/apps/native/main.mjs'), '// changed');
  expectRefusal(fixture, () => {}, 'EXTERNAL_INPUT_CHANGED');
});

test('oversized manifest is rejected before commands or output', () => {
  const fixture = createExternalPackageFixture(), commands = [];
  fs.truncateSync(fixture.options.inputManifest, 16 * 1024 * 1024 + 1);
  assert.throws(() => packageExternalPreview(fixture.options, {runCommand: mockPackageRunner({commands})}), {code: 'EXTERNAL_JSON_LIMIT'});
  assert.equal(commands.length, 0); assert.equal(fs.existsSync(fixture.options.outputDirectory), false);
});

test('scratch, output links and existing output are rejected without writes', () => {
  const fixture = createExternalPackageFixture();
  expectRefusal(fixture, options => {options.workDirectory = options.bundle;}, 'EXTERNAL_SCRATCH_OVERLAP');
  fs.mkdirSync(fixture.options.outputDirectory);
  assert.throws(() => packageExternalPreview(fixture.options), {code: 'EXTERNAL_OUTPUT_EXISTS'});
  assert.deepEqual(fs.readdirSync(fixture.options.outputDirectory), []);
  const linked = path.join(fixture.directory, 'linked-output-parent'); fs.symlinkSync(fixture.options.workDirectory, linked);
  assert.throws(() => packageExternalPreview({...fixture.options, outputDirectory: path.join(linked, 'child')}), {code: 'EXTERNAL_PATH_LINK'});
});

test('test transform signs all targets in order, rebinds runtimes before outer seal and preserves originals', () => {
  const fixture = createExternalPackageFixture(), commands = [], initial = inventory(fixture.options.bundle, {internalLinks: true});
  const receipt = packageExternalPreview(fixture.options, {runCommand: mockPackageRunner({commands}), verifyArtifact: syntheticVerify});
  assert.equal(receipt.status, 'test-passed'); assert.equal(receipt.evidenceMode, 'injected-command-test'); assert.equal(receipt.readyToDistribute, false);
  const signs = commands.filter(row => row.exe === '/usr/bin/codesign' && row.args.includes('--sign'));
  assert.equal(signs.length, 25); assert.equal(signs.at(-1).args.at(-1), receipt.bundle);
  for (const row of signs) {assert.equal(row.args[row.args.indexOf('--sign') + 1], fixtureIdentity); assert.ok(row.args.includes('--timestamp')); assert.ok(!row.args.includes('--deep'));}
  assert.equal(signs.filter(row => row.args.includes('--entitlements')).length, 5);
  assert.equal(signs.filter(row => row.args.includes('--options')).length, 19);
  assert.equal(receipt.steps.at(-2).action, 'derived-runtime-inventories'); assert.equal(receipt.steps.at(-1).path, '.');
  const declared = JSON.parse(fs.readFileSync(receipt.manifest)), gitDir = path.join(receipt.bundle, externalGit);
  assert.equal(declared.bundledGit.preparedManifestSha256, fixture.original.bundledGit.manifestSha256);
  assert.notEqual(declared.bundledGit.manifestSha256, fixture.original.bundledGit.manifestSha256);
  assert.equal(sha256(fs.readFileSync(path.join(gitDir, 'licenses/prepared-runtime-manifest.json'))), fixture.original.bundledGit.manifestSha256);
  assert.deepEqual(fs.readFileSync(path.join(gitDir, 'licenses/SOURCE.prepared.md')), fs.readFileSync(path.join(fixture.options.bundle, externalGit, 'licenses/SOURCE.md')));
  assert.match(fs.readFileSync(path.join(gitDir, 'licenses/SOURCE.md'), 'utf8'), /injected-command test artifact/);
  assert.equal(declared.searchRuntime.preparedSha256, fixture.original.searchRuntime.sha256);
  assert.notEqual(declared.searchRuntime.sha256, fixture.original.searchRuntime.sha256);
  assert.deepEqual(inventory(fixture.options.bundle, {internalLinks: true}), initial);
});

test('copy tamper or failed signing retains evidence and cannot emit successful receipt', () => {
  for (const opts of [{mutateDuringCopy: bundle => fs.appendFileSync(path.join(bundle, 'Contents/Info.plist'), 'tamper')}, {failSignAt: 2}]) {
    const fixture = createExternalPackageFixture(), commands = [];
    assert.throws(() => packageExternalPreview(fixture.options, {runCommand: mockPackageRunner({commands, ...opts}), verifyArtifact: syntheticVerify}));
    assert.equal(fs.existsSync(path.join(fixture.options.outputDirectory, 'receipt.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.options.outputDirectory, 'failure.json'))).status, 'failed');
    assert.deepEqual(inventory(fixture.options.bundle, {internalLinks: true}), fixture.original.entries);
    if (opts.mutateDuringCopy) assert.equal(commands.some(row => row.args.includes('--sign')), false);
  }
});

test('final verification failure or post-seal mutation cannot be promoted as signed', () => {
  for (const verifyArtifact of [() => ({status: 'failed'}), ({bundle}) => {fs.appendFileSync(path.join(bundle, 'Contents/Info.plist'), 'tamper'); return {status: 'verified', evidenceMode: 'injected-command-test'};}]) {
    const fixture = createExternalPackageFixture();
    assert.throws(() => packageExternalPreview(fixture.options, {runCommand: mockPackageRunner(), verifyArtifact}));
    assert.equal(fs.existsSync(path.join(fixture.options.outputDirectory, 'receipt.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.options.outputDirectory, 'failure.json'))).evidenceMode, 'injected-command-test');
  }
});

test('CLI requires explicit plan or sign and rejects credential-like/duplicate arguments', () => {
  assert.match(externalPackageCLI(['--help']).help, /no ad-hoc fallback/);
  assert.throws(() => externalPackageCLI([]), {code: 'EXTERNAL_CLI_MODE'});
  assert.throws(() => externalPackageCLI(['--sign', '--password', 'secret']), {code: 'EXTERNAL_CLI_ARGUMENT'});
  assert.throws(() => externalPackageCLI(['--plan', '--bundle', 'a', '--bundle', 'b']), {code: 'EXTERNAL_CLI_ARGUMENT'});
});
