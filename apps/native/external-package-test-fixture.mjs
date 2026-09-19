// Synthetic Mach-O headers exercise orchestration, never Apple signature validity.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inventory, sha256} from './package-support.mjs';
import {externalCodeLayout, externalFramework, externalGit} from './external-package-policy.mjs';
import {runExternalCommand} from './external-delivery-verify.mjs';
import {testRoot as root} from '../../tools/development-paths.mjs';
import {releaseSourceTag} from './release-identity.mjs';

export const fixtureIdentity = 'A'.repeat(40), fixtureTeam = 'ABCDEFGHIJ';
export const fixtureAttribution = {author: {name: 'Fixture Author', email: 'fixture@example.invalid', url: 'https://example.invalid/'}, organization: {name: 'Fixture Group', url: 'https://example.invalid/'}, homepage: 'https://example.invalid/', copyright: 'Copyright (c) 2026 Fixture Author'};
const write = (filename, content, mode = 0o644) => {fs.mkdirSync(path.dirname(filename), {recursive: true}); fs.writeFileSync(filename, content, {mode});};
const json = (filename, value) => write(filename, JSON.stringify(value, null, 2) + '\n');

export function createExternalPackageFixture({metadataRevision, sourceTag, attribution, binaryInput = false} = {}) {
  const parent = path.join(root, 'runs/external-preview-packaging-20260918/signing'); fs.mkdirSync(parent, {recursive: true});
  const directory = fs.mkdtempSync(path.join(parent, 'unit-')), sourceRoot = path.join(directory, 'source'), workDirectory = path.join(directory, 'tmp');
  const inputDirectory = path.join(directory, 'input'), bundle = path.join(inputDirectory, 'asMagicBrain.app');
  for (const dir of [sourceRoot, workDirectory, bundle]) fs.mkdirSync(dir, {recursive: true});
  for (const item of externalCodeLayout) {
    const bytes = Buffer.alloc(128); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(item.type, 12);
    if (item.executable === externalFramework) Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX\x01\x09101100011', 'binary').copy(bytes, 64);
    write(path.join(bundle, item.executable), bytes, 0o755);
  }
  const gitRoot = path.join(bundle, externalGit);
  write(path.join(gitRoot, 'licenses/SOURCE.md'), 'Original ad-hoc preparation notice.\n');
  write(path.join(gitRoot, 'licenses/Git-COPYING'), 'Synthetic test license\n');
  write(path.join(gitRoot, 'licenses/provenance.json'), '{"synthetic":true}\n');
  fs.mkdirSync(path.join(gitRoot, 'share/git-core/templates'), {recursive: true});
  fs.symlinkSync('git-remote-http', path.join(gitRoot, 'libexec/git-core/git-remote-https'));
  const gitManifest = {schemaVersion: 1, distribution: 'desktop/dugite-native', release: 'v2.53.0-4', gitVersion: '2.53.0', platform: 'darwin', arch: 'arm64', signing: 'ad-hoc-before-inventory', machO: externalCodeLayout.filter(item => item.role === 'git').map(item => ({path: item.executable.slice(externalGit.length + 1), beforeSha256: sha256('upstream'), afterSha256: sha256(fs.readFileSync(path.join(bundle, item.executable)))})), entries: inventory(gitRoot, {internalLinks: true}).filter(row => row.path)};
  json(path.join(gitRoot, 'runtime-manifest.json'), gitManifest);
  const preparedManifestSha256 = sha256(fs.readFileSync(path.join(gitRoot, 'runtime-manifest.json')));
  const runtime = {version: '44.4.0', platform: 'darwin', arch: 'arm64', archive: 'synthetic-electron.zip', archiveSha256: sha256('synthetic archive')};
  const release = {schemaVersion: 1, version: '0.2.8', buildNumber: metadataRevision === undefined ? 29 : 30, bundleId: 'org.asmagicbrain.preview', ...(metadataRevision === undefined ? {} : {metadataRevision})};
  if (attribution !== undefined) json(path.join(sourceRoot, 'package.json'), {name: 'synthetic-application', version: '0.0.0', ...attribution});
  json(path.join(sourceRoot, 'apps/native/release.json'), release); json(path.join(sourceRoot, 'apps/native/runtime.json'), runtime);
  json(path.join(sourceRoot, 'apps/native/git-runtime.json'), {preparedManifestSha256});
  write(path.join(sourceRoot, 'apps/native/main.mjs'), '// Synthetic tracked source fixture\n');
  const binaryPath = 'docs/assets/fixture.png';
  const binaryBytes = binaryInput ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8kkAAAAASUVORK5CYII=', 'base64') : null;
  if (binaryBytes) write(path.join(sourceRoot, binaryPath), binaryBytes);
  const git = (...args) => {const r = spawnSync('/usr/bin/git', ['-C', sourceRoot, ...args], {env: {PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', TMPDIR: workDirectory}, encoding: 'utf8'}); if (r.status !== 0) throw Error('fixture Git failed'); return r.stdout.trim();};
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'synthetic external package fixture');
  const sourceCommit = git('rev-parse', 'HEAD'), tag = sourceTag ?? releaseSourceTag(release); git('tag', tag);
  const expected = {sourceCommit, sourceTag: tag, version: release.version, buildNumber: release.buildNumber};
  const source = fs.readFileSync(path.join(sourceRoot, 'apps/native/main.mjs'));
  write(path.join(bundle, 'Contents/Resources/app/apps/native/main.mjs'), source);
  if (binaryBytes) write(path.join(bundle, 'Contents/Resources/app', binaryPath), binaryBytes);
  const rg = fs.readFileSync(path.join(bundle, 'Contents/Resources/app/apps/native/dist-host/rg'));
  const searchRuntime = {schemaVersion: 1, platform: 'darwin', arch: 'arm64', version: '1.18.0', ripgrepVersion: '15.0.0', sha256: sha256(rg), bytes: rg.length};
  const metadata = {schemaVersion: 1, ...expected, candidate: false, channel: 'preview', buildConfiguration: {channel: 'preview', presentation: 'implemented-only', canToggleUnavailable: false, validationOnly: false}, accountRuntimePolicy: {persistence: 'session', electronFuses: {version: 1, wire: '101100011', cookieEncryption: false}}, searchRuntime, bundledGit: {manifestSha256: preparedManifestSha256, platform: 'darwin', arch: 'arm64', gitVersion: '2.53.0', release: 'v2.53.0-4', distribution: 'desktop/dugite-native'}};
  if (attribution !== undefined) {
    metadata.attribution = attribution;
    json(path.join(bundle, 'Contents/Resources/app/package.json'), {name: 'asmagicbrain-preview', version: release.version, ...attribution});
  }
  json(path.join(bundle, 'Contents/Resources/app/apps/native/dist-host/search-runtime.json'), searchRuntime);
  json(path.join(bundle, 'Contents/Resources/app/native-package.json'), metadata);
  json(path.join(bundle, 'Contents/Info.plist'), {CFBundleIdentifier: 'org.asmagicbrain.app.preview', CFBundleVersion: String(release.buildNumber), CFBundleShortVersionString: release.version, ...(attribution === undefined ? {} : {NSHumanReadableCopyright: attribution.copyright})});
  const original = {schemaVersion: 1, kind: 'versioned-preview', ...metadata, candidateDirty: false, bundleId: 'org.asmagicbrain.app.preview', runtime, inputs: [{path: 'apps/native/main.mjs', bytes: source.length, sha256: sha256(source)}], entries: inventory(bundle, {internalLinks: true})};
  if (binaryBytes) original.inputs.push({path: binaryPath, bytes: binaryBytes.length, sha256: sha256(binaryBytes)});
  const inputManifest = path.join(inputDirectory, 'package-manifest.json'); json(inputManifest, original);
  const options = {bundle, inputManifest, inputManifestSha256: sha256(fs.readFileSync(inputManifest)), sourceRoot, workDirectory, expected, outputDirectory: path.join(directory, 'new output with spaces'), identitySha1: fixtureIdentity, teamId: fixtureTeam};
  return {directory, options, original};
}

export function mockPackageRunner({commands = [], failSignAt = -1, identityOutput, mutateDuringCopy} = {}) {
  let signs = 0;
  return (exe, args, options) => {
    commands.push({exe, args: [...args]});
    if (exe === '/usr/bin/git' || exe === '/usr/bin/plutil') return runExternalCommand(exe, args, options);
    if (exe === '/usr/bin/security') return {status: 0, stdout: identityOutput ?? `  1) ${fixtureIdentity} "Developer ID Application: Synthetic Test (${fixtureTeam})"\n     1 valid identities found\n`, stderr: ''};
    if (exe === '/usr/bin/ditto') {
      fs.cpSync(args.at(-2), args.at(-1), {recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false});
      for (const row of inventory(args.at(-2), {internalLinks: true})) if (row.type !== 'symlink') fs.chmodSync(path.join(args.at(-1), row.path), row.mode);
      mutateDuringCopy?.(args.at(-1));
    }
    if (exe === '/usr/bin/codesign' && args.includes('--sign')) {
      if (signs++ === failSignAt) return {status: 1, stdout: '', stderr: 'synthetic failure'};
      const target = args.at(-1), item = externalCodeLayout.find(row => row.path === '.' ? target.endsWith('/asMagicBrain.app') : target.endsWith('/' + row.path));
      const filename = item.kind === 'file' ? target : path.join(target, path.relative(item.path === '.' ? '.' : item.path, item.executable));
      fs.appendFileSync(filename, Buffer.from('synthetic-signature'));
    }
    return {status: 0, stdout: '', stderr: ''};
  };
}
