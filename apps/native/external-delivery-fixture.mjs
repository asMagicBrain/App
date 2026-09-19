// Synthetic test data only. These byte stubs are not Apple-signed executables.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inventory, sha256} from './package-support.mjs';
import {externalCodeLayout, externalFramework, externalGit, enumerateExternalCode, applyExternalFuses} from './external-package-policy.mjs';
import {externalTestRoot} from './external-delivery-verify.mjs';
export const certificate = Buffer.from('SYNTHETIC certificate DER test seam; not a real certificate');
export const identitySha1 = createHash('sha1').update(certificate).digest('hex').toUpperCase();
export function fixtureRoot(prefix) {
  const parent = path.join(externalTestRoot, 'runs/external-preview-packaging-20260918/delivery/tests'); fs.mkdirSync(parent, {recursive: true, mode: 0o700});
  return fs.mkdtempSync(path.join(parent, prefix + '-'));
}
export const write = (filename, bytes, mode = 0o644) => {fs.mkdirSync(path.dirname(filename), {recursive: true, mode: 0o755}); fs.writeFileSync(filename, bytes, {mode});};
export const json = (filename, value) => write(filename, JSON.stringify(value, null, 2) + '\n');
export function artifactFixture() {
  const root = fixtureRoot('artifact'), bundle = path.join(root, 'asMagicBrain.app'), tmp = path.join(root, 'tmp'); fs.mkdirSync(tmp, {mode: 0o700});
  for (const item of externalCodeLayout) {
    let bytes = Buffer.alloc(40); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(item.type, 12);
    if (item.executable === externalFramework) bytes = Buffer.concat([bytes, Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, 9]), Buffer.from('101100011')]);
    write(path.join(bundle, item.executable), bytes, 0o755);
  }
  const app = path.join(bundle, 'Contents/Resources/app'), git = path.join(bundle, externalGit);
  write(path.join(git, 'licenses/SOURCE.md'), 'Original corresponding source notice\n');
  write(path.join(git, 'licenses/Git-COPYING'), 'Synthetic GPL fixture\n');
  fs.mkdirSync(path.join(git, 'share/git-core/templates'), {recursive: true});
  fs.symlinkSync('git-remote-http', path.join(git, 'libexec/git-core/git-remote-https'));
  const gitManifest = {schemaVersion: 1, distribution: 'desktop/dugite-native', gitVersion: '2.53.0', release: 'v2.53.0-4', platform: 'darwin', arch: 'arm64', machO: [], entries: inventory(git, {internalLinks: true}).filter(row => row.path)};
  json(path.join(git, 'runtime-manifest.json'), gitManifest);
  const preparedGit = sha256(fs.readFileSync(path.join(git, 'runtime-manifest.json')));
  const search = {sha256: sha256(fs.readFileSync(path.join(app, 'apps/native/dist-host/rg'))), bytes: 40};
  json(path.join(app, 'apps/native/dist-host/search-runtime.json'), search);
  const source = {sourceCommit: 'a'.repeat(40), sourceTag: 'native-v0.2.9', version: '0.2.9', buildNumber: 30, channel: 'preview', candidate: false};
  const native = {schemaVersion: 1, ...source, buildConfiguration: {channel: 'preview', presentation: 'implemented-only', canToggleUnavailable: false, validationOnly: false},
    accountConfiguration: {id: 'offline', sha256: 'b'.repeat(64)}, bundledDocumentation: {version: source.version, digest: 'c'.repeat(64), fileCount: 3},
    accountRuntimePolicy: {persistence: 'session', electronFuses: {version: 1, wire: '101100011', cookieEncryption: false}}, bundledGit: {manifestSha256: preparedGit}, searchRuntime: search};
  json(path.join(app, 'native-package.json'), native);
  write(path.join(bundle, 'Contents/Info.plist'), 'synthetic plist interpreted by mocked plutil');
  const original = {schemaVersion: 1, kind: 'versioned-preview', ...JSON.parse(JSON.stringify(native)), bundleId: 'org.asmagicbrain.app.preview', inputs: [], entries: inventory(bundle, {internalLinks: true})};
  const inputManifest = path.join(root, 'input-manifest.json'); json(inputManifest, original);
  const expected = {...source, teamId: 'ABCDEFGHIJ', identitySha1, inputManifestSha256: sha256(fs.readFileSync(inputManifest))}; delete expected.channel; delete expected.candidate;
  const signing = {policy: 'macos-external-v1', identitySha1, teamId: expected.teamId, inputManifestSha256: expected.inputManifestSha256};
  const externalSigning = {...signing, evidenceMode: 'injected-command-test', preparedManifestSha256: preparedGit};
  const fuses = applyExternalFuses(bundle);
  fs.copyFileSync(path.join(git, 'licenses/SOURCE.md'), path.join(git, 'licenses/SOURCE.prepared.md'));
  fs.copyFileSync(path.join(git, 'runtime-manifest.json'), path.join(git, 'licenses/prepared-runtime-manifest.json'));
  json(path.join(git, 'licenses/external-signing.json'), externalSigning);
  write(path.join(git, 'licenses/SOURCE.md'), 'Derived synthetic test signing; not notarized\n');
  Object.assign(gitManifest, {signing: 'developer-id-before-inventory', preparedManifestSha256: preparedGit, externalSigning});
  gitManifest.entries = inventory(git, {internalLinks: true}).filter(row => row.path && row.path !== 'runtime-manifest.json');
  json(path.join(git, 'runtime-manifest.json'), gitManifest);
  native.bundledGit = {manifestSha256: sha256(fs.readFileSync(path.join(git, 'runtime-manifest.json'))), preparedManifestSha256: preparedGit};
  native.searchRuntime = {...search, preparedSha256: search.sha256, signing: {...signing, evidenceMode: 'injected-command-test'}}; native.accountRuntimePolicy.electronFuses = fuses.after;
  native.externalPackaging = {schemaVersion: 1, ...signing, evidenceMode: 'injected-command-test'};
  json(path.join(app, 'apps/native/dist-host/search-runtime.json'), native.searchRuntime); json(path.join(app, 'native-package.json'), native);
  const manifest = path.join(root, 'signed-manifest.json');
  const signed = {...original, kind: 'developer-id-external-preview', evidenceMode: 'injected-command-test', input: {manifestSha256: expected.inputManifestSha256, ...Object.fromEntries(['sourceCommit', 'sourceTag', 'version', 'buildNumber'].map(k => [k, expected[k]]))},
    signing, fuses, accountRuntimePolicy: native.accountRuntimePolicy, bundledGit: native.bundledGit, searchRuntime: native.searchRuntime, codeTargets: enumerateExternalCode(bundle), entries: inventory(bundle, {internalLinks: true})};
  json(manifest, signed);
  const runCommand = (exe, args, options = {}) => {
    let stdout = '', stderr = '';
    if (exe === '/usr/bin/plutil') stdout = options.input ?? JSON.stringify({CFBundleIdentifier: original.bundleId, CFBundleShortVersionString: expected.version, CFBundleVersion: String(expected.buildNumber)});
    else if (exe === '/usr/bin/codesign') {
      const target = signed.codeTargets.find(t => path.join(bundle, t.path) === args.at(-1));
      if (args.includes('--extract-certificates')) write(args[args.indexOf('--extract-certificates') + 1] + '0', certificate, 0o600);
      else if (args.includes('--entitlements')) stdout = JSON.stringify(Object.fromEntries(target.entitlements.map(k => [k, true])));
      else if (args.includes('--display')) stderr = signatureText({hardenedRuntime: target.hardenedRuntime});
    } else if (exe !== '/usr/bin/xattr') throw Error('Unexpected mock command');
    return {status: 0, stdout, stderr};
  };
  return {root, bundle, manifest, inputManifest, expected, workDirectory: tmp, runCommand, signed, original};
}
export function signatureText({teamId = 'ABCDEFGHIJ', hardenedRuntime = true, timestamp = 'Sep 18, 2026 at 11:24:00 PM'} = {}) {
  return `CodeDirectory v=20500 size=123 flags=0x${hardenedRuntime ? '10000' : '0'}(${hardenedRuntime ? 'runtime' : ''}) hashes=3+5 location=embedded\nCDHash=${'1'.repeat(40)}\nAuthority=Developer ID Application: Synthetic Fixture (${teamId})\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTimestamp=${timestamp}\nTeamIdentifier=${teamId}\n`;
}
