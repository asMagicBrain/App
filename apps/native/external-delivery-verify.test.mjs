import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {inventory} from './package-support.mjs';
import {verifyExternalArtifact, parseSignature, verifyTransformation, readJson, validateExpected} from './external-delivery-verify.mjs';
import {artifactFixture, signatureText, write, json, fixtureRoot} from './external-delivery-fixture.mjs';
const verify = fixture => verifyExternalArtifact(fixture);

test('external delivery admits canonical metadata revision identity and rejects cross-version or malformed tags', () => {
  const expected = {...artifactFixture().expected, version: '0.2.11', buildNumber: 33, sourceTag: 'native-v0.2.11-metadata.1'};
  assert.doesNotThrow(() => validateExpected(expected));
  assert.doesNotThrow(() => validateExpected({...expected, sourceTag: 'native-v0.2.11'}));
  for (const sourceTag of ['native-v0.2.10-metadata.1','native-v0.2.11-metadata.0','native-v0.2.11-metadata.01','native-v0.2.11-metadata.1\n','native-v0.2.11-metadata.1/other']) {
    assert.throws(() => validateExpected({...expected, sourceTag}), {code: 'EXTERNAL_SOURCE_IDENTITY'});
  }
});

test('synthetic verifier independently inspects all code, cert identity, runtime and metadata', () => {
  const fixture = artifactFixture(), before = inventory(fixture.bundle, {internalLinks: true}), result = verify(fixture);
  assert.equal(result.status, 'verified'); assert.equal(result.evidenceMode, 'injected-command-test'); assert.equal(result.codeChecks.length, 25);
  assert.ok(result.codeChecks.every(c => c.identitySha1 === fixture.expected.identitySha1 && c.identitySha1.toLowerCase() !== c.cdHash));
  assert.deepEqual(inventory(fixture.bundle, {internalLinks: true}), before);
});
test('codesign timestamps accept real locale-C at format and ISO; missing/invalid timestamps fail', () => {
  for (const timestamp of ['Sep 18, 2026 at 11:24:00 PM', 'Sep 18, 2026 23:24:00', '2026-09-18T23:24:00Z']) assert.equal(parseSignature(signatureText({timestamp}), {teamId: 'ABCDEFGHIJ', hardenedRuntime: true}).timestamp, timestamp);
  for (const timestamp of ['none', 'garbage', 'Sep 99, 2026 at 11:24:00 PM']) assert.throws(() => parseSignature(signatureText({timestamp}), {teamId: 'ABCDEFGHIJ', hardenedRuntime: true}), /EXTERNAL_SIGNATURE_TIMESTAMP/);
});
test('cert SHA1 cannot be substituted with a matching CDHash or wrong extracted certificate', () => {
  const fixture = artifactFixture(), original = fixture.runCommand;
  fixture.runCommand = (exe, args, opts) => {const r = original(exe, args, opts); if (args.includes('--extract-certificates')) write(args[args.indexOf('--extract-certificates') + 1] + '0', 'wrong cert'); return r;};
  assert.throws(() => verify(fixture), /EXTERNAL_CERTIFICATE_IDENTITY/);
});
for (const [label, rewrite, code] of [
  ['wrong team', text => text.replaceAll('ABCDEFGHIJ', '0123456789'), 'EXTERNAL_SIGNATURE_TEAM'],
  ['ad-hoc authority', text => text.replace('Authority=Developer ID Application:', 'Authority=Developer ID Installer:'), 'EXTERNAL_SIGNATURE_AUTHORITY'],
  ['no hardened runtime', text => text.replace('flags=0x10000(runtime)', 'flags=0x0()'), 'EXTERNAL_HARDENED_RUNTIME'],
]) test(label + ' fails actual command-result admission', () => {
  const fixture = artifactFixture(), original = fixture.runCommand;
  fixture.runCommand = (exe, args, opts) => {const r = original(exe, args, opts); return {...r, stderr: rewrite(r.stderr)};};
  assert.throws(() => verify(fixture), new RegExp(code));
});
test('unexpected entitlement cannot hide in a correctly signed object', () => {
  const fixture = artifactFixture(), original = fixture.runCommand;
  fixture.runCommand = (exe, args, opts) => args.includes('--entitlements') ? {status: 0, stdout: '{"com.apple.security.get-task-allow":true}', stderr: ''} : original(exe, args, opts);
  assert.throws(() => verify(fixture), /EXTERNAL_ENTITLEMENTS/);
});
test('input/output overlap refuses before certificate scratch or any bundle mutation', () => {
  const fixture = artifactFixture(), before = inventory(fixture.bundle, {internalLinks: true});
  fixture.workDirectory = path.join(fixture.bundle, 'Contents');
  assert.throws(() => verify(fixture), /EXTERNAL_INPUT_OUTPUT_OVERLAP/);
  assert.deepEqual(inventory(fixture.bundle, {internalLinks: true}), before);
});
test('resource fork and arbitrary extended attributes fail admission without exposing values', () => {
  const fixture = artifactFixture(), original = fixture.runCommand;
  fixture.runCommand = (exe, args, opts) => exe.endsWith('/xattr') ? {status: 0, stdout: 'app: com.apple.ResourceFork', stderr: ''} : original(exe, args, opts);
  assert.throws(() => verify(fixture), /EXTERNAL_EXTENDED_ATTRIBUTES/);
});
test('signature-shaped extra content is refused outside enumerated bundle seals', () => {
  const fixture = artifactFixture();
  write(path.join(fixture.bundle, 'Contents/Resources/app/apps/native/_CodeSignature/CodeResources'), 'private extra content');
  fixture.signed.entries = inventory(fixture.bundle, {internalLinks: true}); json(fixture.manifest, fixture.signed);
  assert.throws(() => verify(fixture), /EXTERNAL_UNEXPECTED_ADDED_CONTENT/);
});
test('non-code modes/links/content and derived runtime tampering cannot be admitted by a new inventory', () => {
  for (const edit of [f => fs.chmodSync(path.join(f.bundle, 'Contents/Info.plist'), 0o600), f => write(path.join(f.bundle, 'Contents/Info.plist'), 'changed'), f => write(path.join(f.bundle, 'Contents/Resources/app/apps/native/dist-host/git/licenses/Git-COPYING'), 'changed')]) {
    const fixture = artifactFixture(); edit(fixture); fixture.signed.entries = inventory(fixture.bundle, {internalLinks: true}); json(fixture.manifest, fixture.signed);
    assert.throws(() => verify(fixture), /EXTERNAL_(INPUT_MEMBERSHIP_MODE|UNEXPECTED_CONTENT_CHANGE)/);
  }
});
test('manifest shape and bounded file size are rejected before parsing or commands', () => {
  const fixture = artifactFixture(); delete fixture.signed.signing.identitySha1; json(fixture.manifest, fixture.signed);
  assert.throws(() => verify(fixture), /EXTERNAL_POLICY_IDENTITY/);
  delete fixture.signed.entries; json(fixture.manifest, fixture.signed); assert.throws(() => verify(fixture), /EXTERNAL_INVENTORY_SCHEMA/);
  const file = path.join(fixtureRoot('oversize'), 'huge.json'); const fd = fs.openSync(file, 'wx'); fs.ftruncateSync(fd, 16 * 1024 * 1024 + 1); fs.closeSync(fd);
  assert.throws(() => readJson(file), /EXTERNAL_JSON_LIMIT/);
});
test('changing input during independent signature verification fails final readback', () => {
  const fixture = artifactFixture(), original = fixture.runCommand; let changed = false;
  fixture.runCommand = (exe, args, opts) => {const r = original(exe, args, opts); if (!changed && args.includes('--deep')) {write(path.join(fixture.bundle, 'Contents/Info.plist'), 'changed during check'); changed = true;} return r;};
  assert.throws(() => verify(fixture), /EXTERNAL_CHANGED_DURING_VERIFICATION/);
});
test('native registration and unknown metadata changes fail even after inventory is regenerated', () => {
  for (const edit of [m => {m.githubRegistration = {configured: true, clientId: 'different'};}, m => {m.accountConfiguration.id = 'substituted';}, m => {m.bundledDocumentation.digest = 'd'.repeat(64);}, m => {m.unplannedMetadata = 'extra';}, m => {delete m.buildConfiguration.channel;}, m => {m.searchRuntime.extra = true;}]) {
    const fixture = artifactFixture(), filename = path.join(fixture.bundle, 'Contents/Resources/app/native-package.json');
    const metadata = readJson(filename); edit(metadata); json(filename, metadata);
    fixture.signed.entries = inventory(fixture.bundle, {internalLinks: true}); json(fixture.manifest, fixture.signed);
    assert.throws(() => verify(fixture), /EXTERNAL_NATIVE_METADATA_DRIFT/);
  }
});
test('only OS provenance xattr is allowed; resource-fork/private attribute names still fail', () => {
  const fixture = artifactFixture(), original = fixture.runCommand;
  fixture.runCommand = (exe, args, opts) => exe.endsWith('/xattr') ? {status: 0, stdout: fixture.bundle + ': com.apple.provenance\n' + fixture.bundle + '/Contents: com.apple.provenance\n', stderr: ''} : original(exe, args, opts);
  assert.equal(verify(fixture).status, 'verified');
  fixture.runCommand = (exe, args, opts) => exe.endsWith('/xattr') ? {status: 0, stdout: fixture.bundle + ': com.apple.provenance\n' + fixture.bundle + ': private-data\n', stderr: ''} : original(exe, args, opts);
  assert.throws(() => verify(fixture), /EXTERNAL_EXTENDED_ATTRIBUTES/);
});
test('metadata-revision attribution survives signing and independent verification with synthetic Apple commands', async () => {
  const {packageExternalPreview} = await import('./external-package.mjs');
  const {createExternalPackageFixture, mockPackageRunner, fixtureAttribution} = await import('./external-package-test-fixture.mjs');
  const {externalCodeLayout} = await import('./external-package-policy.mjs');
  const {certificate, identitySha1} = await import('./external-delivery-fixture.mjs');
  const fixture = createExternalPackageFixture({metadataRevision: 1, attribution: fixtureAttribution}); fixture.options.identitySha1 = identitySha1;
  const runner = mockPackageRunner({identityOutput: `  1) ${identitySha1} "Developer ID Application: Synthetic Test (ABCDEFGHIJ)"\n`});
  const runCommand = (exe, args, options) => {
    if (exe === '/usr/bin/codesign' && args.includes('--display')) {
      const item = externalCodeLayout.find(row => row.path === '.' ? args.at(-1).endsWith('/asMagicBrain.app') : args.at(-1).endsWith('/' + row.path));
      assert.ok(item);
      if (args.includes('--extract-certificates')) {write(args[args.indexOf('--extract-certificates') + 1] + '0', certificate); return {status: 0, stdout: '', stderr: ''};}
      if (args.includes('--entitlements')) return {status: 0, stdout: JSON.stringify(Object.fromEntries(item.entitlements.map(k => [k, true]))), stderr: ''};
      return {status: 0, stdout: '', stderr: signatureText({hardenedRuntime: item.hardenedRuntime})};
    }
    if (exe === '/usr/bin/plutil' && options.input) return {status: 0, stdout: options.input, stderr: ''};
    return runner(exe, args, options);
  };
  const before = inventory(fixture.options.bundle, {internalLinks: true});
  const receipt = packageExternalPreview(fixture.options, {runCommand});
  assert.equal(receipt.evidenceMode, 'injected-command-test');
  assert.deepEqual(inventory(fixture.options.bundle, {internalLinks: true}), before);
  const result = verifyExternalArtifact({bundle: path.join(fixture.options.outputDirectory, 'asMagicBrain.app'), manifest: path.join(fixture.options.outputDirectory, 'external-package-manifest.json'), inputManifest: fixture.options.inputManifest,
    expected: {...fixture.options.expected, teamId: fixture.options.teamId, identitySha1, inputManifestSha256: fixture.options.inputManifestSha256}, workDirectory: fixture.options.workDirectory, runCommand});
  assert.equal(result.codeChecks.length, 25); assert.equal(result.evidenceMode, 'injected-command-test');
});
test('convincing certificate display cannot bypass Apple Developer ID anchor requirement', () => {
  const fixture = artifactFixture(), original = fixture.runCommand; let checked = false;
  fixture.runCommand = (exe, args, opts) => {
    if (exe === '/usr/bin/codesign' && args.includes('-R')) {
      checked = true; const requirement = args[args.indexOf('-R') + 1];
      assert.match(requirement, /^=anchor apple generic and certificate 1\[field\.1\.2\.840\.113635\.100\.6\.2\.6\] exists/);
      assert.match(requirement, /certificate leaf\[field\.1\.2\.840\.113635\.100\.6\.1\.13\] exists/);
      assert.match(requirement, /subject\.OU\] = "ABCDEFGHIJ"$/);
      return {status: 1, stdout: '', stderr: 'synthetic invalid Apple anchor; display would look valid'};
    }
    return original(exe, args, opts);
  };
  assert.throws(() => verify(fixture), /EXTERNAL_COMMAND_FAILED/); assert.equal(checked, true);
});
