import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {inventory, sha256, requireUnencryptedCookieStore} from './package-support.mjs';
import {verifyGitRuntime} from '../../packages/desktop-host/src/git-executable.mjs';
import {externalPolicy, enumerateExternalCode} from './external-package-policy.mjs';
import {testRoot} from '../../tools/development-paths.mjs';
import {releaseTagMatchesVersion} from './release-identity.mjs';
import {packageAttribution} from './product-attribution.mjs';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
export const externalTestRoot = testRoot;
const digest = /^[a-f0-9]{64}$/;
const jsonLimit = 16 * 1024 * 1024;
export function deliveryError(code) { return Object.assign(new Error(code), {code}); }
function requireThat(condition, code) { if (!condition) throw deliveryError(code); }
export function physical(filename, directory = false) {
  requireThat(typeof filename === 'string' && path.isAbsolute(filename) && path.resolve(filename) === filename, 'EXTERNAL_PATH');
  requireThat(fs.realpathSync(filename) === filename, 'EXTERNAL_PATH_LINK');
  const stat = fs.lstatSync(filename);
  requireThat(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1, 'EXTERNAL_PATH_TYPE');
  return stat;
}
export function testDirectory(directory) {
  physical(directory, true);
  requireThat(directory.startsWith(externalTestRoot + path.sep), 'EXTERNAL_OUTPUT_OUTSIDE_TEST');
  return directory;
}
export function requireDisjoint(output, inputs) {
  for (const input of inputs) requireThat(output !== input && !output.startsWith(input + path.sep) && !input.startsWith(output + path.sep), 'EXTERNAL_INPUT_OUTPUT_OVERLAP');
}
export function readJson(filename) {
  const stat = physical(filename);
  requireThat(stat.size <= jsonLimit, 'EXTERNAL_JSON_LIMIT');
  return parseJson(fs.readFileSync(filename, 'utf8'));
}
function jsonBytes(filename) {
  requireThat(physical(filename).size <= jsonLimit, 'EXTERNAL_JSON_LIMIT');
  return fs.readFileSync(filename);
}
export function parseJson(value) {
  requireThat(typeof value === 'string' && Buffer.byteLength(value) <= jsonLimit, 'EXTERNAL_JSON_LIMIT');
  try { const parsed = JSON.parse(value); requireThat(parsed && !Array.isArray(parsed) && typeof parsed === 'object', 'EXTERNAL_JSON_SHAPE'); return parsed; }
  catch { throw deliveryError('EXTERNAL_JSON_INVALID'); }
}
export function runExternalCommand(command, args, {tmp, timeout = 60_000, input, binary = false} = {}) {
  testDirectory(tmp);
  requireThat(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 600_000, 'EXTERNAL_TIMEOUT');
  requireThat(typeof binary === 'boolean', 'EXTERNAL_COMMAND_OUTPUT');
  return spawnSync(command, args, {env: {PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0'},
    encoding: binary ? null : 'utf8', input, timeout, maxBuffer: jsonLimit, stdio: ['pipe', 'pipe', 'pipe']});
}
export function checkedCommand(runCommand, command, args, options) {
  const result = runCommand(command, args, options);
  // Never surface raw tool errors: Apple replies may contain account details or private paths.
  if (result?.error?.code === 'ETIMEDOUT' || result?.signal) throw deliveryError('EXTERNAL_COMMAND_TIMEOUT');
  if (result?.error || result?.status !== 0) throw deliveryError('EXTERNAL_COMMAND_FAILED');
  const validOutput = options?.binary === true ? Buffer.isBuffer(result.stdout) && Buffer.isBuffer(result.stderr) : typeof result.stdout === 'string' && typeof result.stderr === 'string';
  requireThat(validOutput && Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= jsonLimit, 'EXTERNAL_COMMAND_OUTPUT');
  return result;
}
function equal(left, right, code) { requireThat(isDeepStrictEqual(left, right), code); }
export function assertExternalAttributes(bundle, runCommand, {tmp}) {
  const output = checkedCommand(runCommand, '/usr/bin/xattr', ['-r', bundle], {tmp, timeout: 60_000}).stdout;
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const suffix = ': com.apple.provenance', filename = line.slice(0, -suffix.length);
    requireThat(line.endsWith(suffix) && (filename === bundle || filename.startsWith(bundle + path.sep)), 'EXTERNAL_EXTENDED_ATTRIBUTES');
  }
  return {permittedSystemAttribute: 'com.apple.provenance', resourceForksPermitted: false};
}
function sorted(value) { return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))); }
function rows(value) { return new Map(value.map(row => [row.path, row])); }
const application = 'Contents/Resources/app/';
const gitRelative = application + 'apps/native/dist-host/git/';
const metadataRelative = application + 'native-package.json';
const searchRelative = application + 'apps/native/dist-host/search-runtime.json';
const sha1 = bytes => createHash('sha1').update(bytes).digest('hex').toUpperCase();

export function validateExpected(expected) {
  requireThat(expected && /^[a-f0-9]{40}$/.test(expected.sourceCommit) && /^\d+\.\d+\.\d+$/.test(expected.version) && releaseTagMatchesVersion(expected.sourceTag, expected.version) && Number.isSafeInteger(expected.buildNumber) && expected.buildNumber > 0, 'EXTERNAL_SOURCE_IDENTITY');
  requireThat(/^[A-Fa-f0-9]{40}$/.test(expected.identitySha1) && /^[A-Z0-9]{10}$/.test(expected.teamId) && digest.test(expected.inputManifestSha256), 'EXTERNAL_SIGNING_IDENTITY');
}

/** Signature text contains CDHashes as well as certificates. They are deliberately
 * different checks: the selected signing identity is the SHA-1 of extracted DER. */
export function parseSignature(text, {teamId, hardenedRuntime}) {
  requireThat(typeof text === 'string' && Buffer.byteLength(text) < 1024 * 1024, 'EXTERNAL_SIGNATURE_DETAILS');
  const lines = text.split(/\r?\n/);
  const values = key => lines.filter(line => line.startsWith(key + '=')).map(line => line.slice(key.length + 1));
  const authorities = values('Authority'), teams = values('TeamIdentifier'), timestamps = values('Timestamp'), hashes = values('CDHash');
  requireThat(teams.length === 1 && teams[0] === teamId, 'EXTERNAL_SIGNATURE_TEAM');
  requireThat(authorities.length >= 3 && /^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(authorities[0]) && authorities[0].endsWith(`(${teamId})`) && authorities.at(-1) === 'Apple Root CA' && authorities.some(a => a.startsWith('Developer ID Certification Authority')), 'EXTERNAL_SIGNATURE_AUTHORITY');
  requireThat(!lines.some(line => /^Signature=adhoc/.test(line)) && timestamps.length === 1 &&
    /^(?:[A-Z][a-z]{2} \d{1,2}, \d{4}(?: at)? \d{1,2}:\d{2}:\d{2}(?: [AP]M)?(?: [A-Z+0-9:-]+)?|\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z?)$/.test(timestamps[0]) &&
    Number.isFinite(Date.parse(timestamps[0].replace(' at ', ' '))), 'EXTERNAL_SIGNATURE_TIMESTAMP');
  requireThat(hashes.length === 1 && /^[a-f0-9]{40,64}$/i.test(hashes[0]), 'EXTERNAL_CODE_DIRECTORY_HASH');
  const flags = text.match(/^CodeDirectory .*flags=0x([a-f0-9]+)\(([^)]*)\)/m);
  requireThat(flags && (!hardenedRuntime || (Number.parseInt(flags[1], 16) & 0x10000) !== 0), 'EXTERNAL_HARDENED_RUNTIME');
  return {teamId, authority: authorities[0], timestamp: timestamps[0], cdHash: hashes[0].toLowerCase(), hardenedRuntime: (Number.parseInt(flags[1], 16) & 0x10000) !== 0};
}

export function verifyTransformation(original, entries, targets, stapled = false) {
  const before = rows(original.entries), after = rows(entries);
  requireThat(before.size === original.entries.length && after.size === entries.length, 'EXTERNAL_DUPLICATE_ENTRY');
  const machO = new Set(targets.map(t => t.executable));
  const mutable = new Set([metadataRelative, searchRelative, gitRelative + 'runtime-manifest.json', gitRelative + 'licenses/SOURCE.md']);
  const added = new Set(['SOURCE.prepared.md', 'prepared-runtime-manifest.json', 'external-signing.json'].map(n => gitRelative + 'licenses/' + n));
  const sealDirectories = new Set(targets.filter(target => target.kind === 'bundle').map(target =>
    target.path === '.' ? 'Contents/_CodeSignature' : target.path.endsWith('.app') ? target.path + '/Contents/_CodeSignature' : path.posix.dirname(target.executable) + '/_CodeSignature'));
  const seals = new Set([...sealDirectories].map(directory => directory + '/CodeResources'));
  for (const [name, row] of before) {
    const next = after.get(name); requireThat(next && row.type === next.type && row.mode === next.mode, 'EXTERNAL_INPUT_MEMBERSHIP_MODE');
    if (row.type === 'symlink') equal(next, row, 'EXTERNAL_INPUT_LINK');
    else if (!machO.has(name) && !mutable.has(name) && !seals.has(name)) equal(next, row, 'EXTERNAL_UNEXPECTED_CONTENT_CHANGE');
  }
  for (const [name, row] of after) if (!before.has(name)) {
    const signature = row.type === 'file' && seals.has(name) || row.type === 'directory' && sealDirectories.has(name);
    const ticket = stapled && name === 'Contents/CodeResources' && row.type === 'file' && row.bytes > 0 && row.bytes < 10 * 1024 * 1024;
    requireThat(signature || added.has(name) && row.type === 'file' || ticket, 'EXTERNAL_UNEXPECTED_ADDED_CONTENT');
  }
  for (const [copy, previous] of [['SOURCE.prepared.md', 'licenses/SOURCE.md'], ['prepared-runtime-manifest.json', 'runtime-manifest.json']]) {
    const row = after.get(gitRelative + 'licenses/' + copy), baseline = before.get(gitRelative + previous);
    requireThat(row && baseline && row.sha256 === baseline.sha256 && row.bytes === baseline.bytes, 'EXTERNAL_PREPARED_RUNTIME_PRESERVATION');
  }
}
function validateInventory(entries) {
  requireThat(Array.isArray(entries) && entries.length > 0 && entries.length < 10000, 'EXTERNAL_INVENTORY_SCHEMA');
  for (const row of entries) {
    requireThat(row && typeof row.path === 'string' && (row.path === '' || !path.isAbsolute(row.path) && !row.path.includes('\\') && row.path.split('/').every(p => p && p !== '.' && p !== '..')) &&
      Number.isInteger(row.mode) && row.mode >= 0 && row.mode <= 0o777 && ['directory', 'file', 'symlink'].includes(row.type), 'EXTERNAL_INVENTORY_SCHEMA');
    if (row.type === 'file') requireThat(Number.isSafeInteger(row.bytes) && row.bytes >= 0 && digest.test(row.sha256), 'EXTERNAL_INVENTORY_SCHEMA');
    if (row.type === 'symlink') requireThat(typeof row.target === 'string' && !path.isAbsolute(row.target), 'EXTERNAL_INVENTORY_SCHEMA');
  }
}

/** This verifier never signs or changes the supplied app. Certificate extraction
 * uses a new owned Test scratch directory. Injected command results are synthetic. */
export function verifyExternalArtifact({bundle, manifest, inputManifest, expected, workDirectory, runCommand = runExternalCommand, stapled = false}) {
  validateExpected(expected); physical(bundle, true); testDirectory(workDirectory);
  requireDisjoint(workDirectory, [bundle, manifest, inputManifest]);
  const manifestBytes = jsonBytes(manifest), originalBytes = jsonBytes(inputManifest);
  requireThat(sha256(originalBytes) === expected.inputManifestSha256, 'EXTERNAL_INPUT_MANIFEST_PIN');
  const declared = parseJson(manifestBytes.toString()), original = parseJson(originalBytes.toString());
  validateInventory(declared.entries); validateInventory(original.entries);
  requireThat(declared.schemaVersion === 1 && original.schemaVersion === 1 && Array.isArray(declared.inputs) && Array.isArray(original.inputs), 'EXTERNAL_MANIFEST_SCHEMA');
  equal(declared.inputs, original.inputs, 'EXTERNAL_COPIED_INPUT_PROVENANCE');
  for (const doc of [declared, original]) {
    for (const key of ['sourceCommit', 'sourceTag', 'version', 'buildNumber']) equal(doc[key], expected[key], 'EXTERNAL_SOURCE_MISMATCH');
    requireThat(doc.channel === 'preview' && doc.bundleId === 'org.asmagicbrain.app.preview' && doc.candidate === false, 'EXTERNAL_PREVIEW_REQUIRED');
  }
  requireThat(declared.kind === 'developer-id-external-preview' && original.kind === 'versioned-preview', 'EXTERNAL_ARTIFACT_KIND');
  equal(declared.attribution, original.attribution, 'EXTERNAL_ATTRIBUTION');
  if (Object.hasOwn(original, 'attribution')) {
    equal(packageAttribution(original.attribution), original.attribution, 'EXTERNAL_ATTRIBUTION');
    const packaged = readJson(path.join(bundle, application, 'package.json'));
    equal(Object.fromEntries(Object.keys(original.attribution).map(key => [key, packaged[key]])), original.attribution, 'EXTERNAL_PACKAGE_ATTRIBUTION');
  }
  equal(declared.input, {manifestSha256: expected.inputManifestSha256, sourceCommit: expected.sourceCommit, sourceTag: expected.sourceTag, version: expected.version, buildNumber: expected.buildNumber}, 'EXTERNAL_INPUT_PROVENANCE');
  requireThat(typeof declared.signing?.identitySha1 === 'string' && declared.signing.identitySha1.toUpperCase() === expected.identitySha1.toUpperCase() && declared.signing.teamId === expected.teamId && declared.signing.policy === externalPolicy.name, 'EXTERNAL_POLICY_IDENTITY');
  const entries = inventory(bundle, {internalLinks: true}), targets = enumerateExternalCode(bundle);
  equal(targets, declared.codeTargets, 'EXTERNAL_CODE_POLICY');
  const declaredEntries = declared.entries;
  requireThat(Array.isArray(declaredEntries), 'EXTERNAL_INVENTORY');
  if (stapled) equal(entries.filter(row => row.path !== 'Contents/CodeResources'), declaredEntries.filter(row => row.path !== 'Contents/CodeResources'), 'EXTERNAL_ARTIFACT_CHANGED');
  else equal(entries, declaredEntries, 'EXTERNAL_ARTIFACT_CHANGED');
  verifyTransformation(original, entries, targets, stapled);
  const metadata = readJson(path.join(bundle, metadataRelative));
  for (const key of ['sourceCommit', 'sourceTag', 'version', 'buildNumber', 'channel']) equal(metadata[key], declared[key], 'EXTERNAL_NATIVE_METADATA');
  requireThat(metadata.candidate === false && !Object.hasOwn(metadata, 'testRoot'), 'EXTERNAL_PORTABLE_METADATA');
  requireThat(metadata.buildConfiguration?.presentation === 'implemented-only' && metadata.buildConfiguration.canToggleUnavailable === false && metadata.buildConfiguration.validationOnly === false, 'EXTERNAL_PREVIEW_CONFIGURATION');
  const signing = {policy: externalPolicy.name, identitySha1: expected.identitySha1.toUpperCase(), teamId: expected.teamId, inputManifestSha256: expected.inputManifestSha256};
  equal(declared.signing, signing, 'EXTERNAL_SIGNING_METADATA');
  requireThat(['actual-signing', 'injected-command-test'].includes(declared.evidenceMode), 'EXTERNAL_EVIDENCE_MODE');
  const expectedNative = Object.fromEntries(['schemaVersion', 'version', 'buildNumber', 'attribution', 'channel', 'buildConfiguration', 'sourceCommit', 'sourceTag', 'candidate', 'githubRegistration', 'accountConfiguration', 'bundledDocumentation', 'accountRuntimePolicy', 'searchRuntime', 'bundledGit'].filter(key => Object.hasOwn(original, key)).map(key => [key, original[key]]));
  Object.assign(expectedNative, {accountRuntimePolicy: {...original.accountRuntimePolicy, electronFuses: {version: 1, wire: externalPolicy.fuseAfter, cookieEncryption: false}},
    bundledGit: {...original.bundledGit, manifestSha256: metadata.bundledGit?.manifestSha256, preparedManifestSha256: original.bundledGit?.manifestSha256},
    searchRuntime: {...original.searchRuntime, sha256: metadata.searchRuntime?.sha256, bytes: metadata.searchRuntime?.bytes, preparedSha256: original.searchRuntime?.sha256, signing: {...signing, evidenceMode: declared.evidenceMode}},
    externalPackaging: {schemaVersion: 1, ...signing, evidenceMode: declared.evidenceMode}});
  equal(metadata, expectedNative, 'EXTERNAL_NATIVE_METADATA_DRIFT');
  const framework = path.join(bundle, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework');
  const fuse = requireUnencryptedCookieStore(fs.readFileSync(framework));
  requireThat(fuse.wire === externalPolicy.fuseAfter && metadata.accountRuntimePolicy?.persistence === 'session', 'EXTERNAL_FUSE_POLICY');
  equal(metadata.accountRuntimePolicy.electronFuses, fuse, 'EXTERNAL_FUSE_METADATA');
  equal(declared.accountRuntimePolicy, metadata.accountRuntimePolicy, 'EXTERNAL_ACCOUNT_METADATA');
  equal(declared.fuses.after, fuse, 'EXTERNAL_FUSE_DECLARATION');
  equal(declared.fuses, {before: {version: 1, wire: externalPolicy.fuseBefore, cookieEncryption: false}, after: fuse}, 'EXTERNAL_FUSE_DECLARATION');
  const gitDirectory = path.resolve(bundle, gitRelative), runtime = verifyGitRuntime(gitDirectory, {manifestSha256: metadata.bundledGit?.manifestSha256});
  equal(metadata.bundledGit, declared.bundledGit, 'EXTERNAL_GIT_METADATA');
  const gitManifest = readJson(path.join(gitDirectory, 'runtime-manifest.json'));
  requireThat(gitManifest.signing === 'developer-id-before-inventory' && metadata.bundledGit.preparedManifestSha256 === original.bundledGit.manifestSha256 && gitManifest.preparedManifestSha256 === original.bundledGit.manifestSha256, 'EXTERNAL_GIT_PROVENANCE');
  const externalSigning = {...signing, evidenceMode: declared.evidenceMode, preparedManifestSha256: original.bundledGit.manifestSha256};
  equal(gitManifest.externalSigning, externalSigning, 'EXTERNAL_GIT_SIGNING_METADATA');
  equal(readJson(path.join(gitDirectory, 'licenses/external-signing.json')), externalSigning, 'EXTERNAL_GIT_SIGNING_METADATA');
  const preparedGit = readJson(path.join(gitDirectory, 'licenses/prepared-runtime-manifest.json'));
  requireThat(Array.isArray(preparedGit.machO), 'EXTERNAL_PREPARED_GIT_SCHEMA');
  const expectedGit = {...preparedGit, signing: 'developer-id-before-inventory', preparedManifestSha256: original.bundledGit.manifestSha256, externalSigning,
    machO: preparedGit.machO.map(row => ({...row, preparedSha256: row.afterSha256, afterSha256: sha256(fs.readFileSync(path.join(gitDirectory, row.path)))})),
    entries: inventory(gitDirectory, {internalLinks: true}).filter(row => row.path && row.path !== 'runtime-manifest.json')};
  equal(gitManifest, expectedGit, 'EXTERNAL_GIT_MANIFEST_DRIFT');
  const search = readJson(path.join(bundle, searchRelative)), rg = path.join(bundle, application + 'apps/native/dist-host/rg');
  equal(search, metadata.searchRuntime, 'EXTERNAL_SEARCH_METADATA'); equal(search, declared.searchRuntime, 'EXTERNAL_SEARCH_MANIFEST');
  requireThat(sha256(fs.readFileSync(rg)) === search.sha256 && physical(rg).size === search.bytes && search.preparedSha256 === original.searchRuntime.sha256, 'EXTERNAL_SEARCH_HASH');
  const scratch = path.join(workDirectory, 'verify-' + randomUUID()); fs.mkdirSync(scratch, {mode: 0o700});
  const command = (exe, args, options = {}) => checkedCommand(runCommand, exe, args, {tmp: scratch, ...options});
  assertExternalAttributes(bundle, runCommand, {tmp: scratch});
  const plist = parseJson(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(bundle, 'Contents/Info.plist')]).stdout);
  requireThat(plist.CFBundleIdentifier === 'org.asmagicbrain.app.preview' && plist.CFBundleShortVersionString === expected.version && plist.CFBundleVersion === String(expected.buildNumber), 'EXTERNAL_INFO_PLIST');
  if (Object.hasOwn(original, 'attribution')) equal(plist.NSHumanReadableCopyright, original.attribution.copyright, 'EXTERNAL_ATTRIBUTION_PLIST');
  const checks = [];
  // Apple TN3127: display labels are not a trust anchor. Require the Apple
  // Developer ID intermediate/leaf OIDs and the selected Team independently.
  const requirement = `=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${expected.teamId}"`;
  for (const [index, target] of targets.entries()) {
    const filename = path.join(bundle, target.path);
    command('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', '-R', requirement, filename]);
    const output = command('/usr/bin/codesign', ['--display', '--verbose=4', filename]);
    const signature = parseSignature(output.stdout + '\n' + output.stderr, {teamId: expected.teamId, hardenedRuntime: target.hardenedRuntime});
    const entitlementOutput = command('/usr/bin/codesign', ['--display', '--entitlements', '-', '--xml', filename]);
    const xml = entitlementOutput.stdout.trim();
    const entitlements = xml ? parseJson(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {input: xml}).stdout) : {};
    equal(sorted(entitlements), sorted(Object.fromEntries(target.entitlements.map(key => [key, true]))), 'EXTERNAL_ENTITLEMENTS');
    const prefix = path.join(scratch, `certificate-${index}-`);
    command('/usr/bin/codesign', ['--display', '--extract-certificates', prefix, filename]);
    physical(prefix + '0'); const identitySha1 = sha1(fs.readFileSync(prefix + '0'));
    requireThat(identitySha1 === expected.identitySha1.toUpperCase(), 'EXTERNAL_CERTIFICATE_IDENTITY');
    checks.push({path: target.path, ...signature, identitySha1, entitlements});
  }
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]);
  equal(inventory(bundle, {internalLinks: true}), entries, 'EXTERNAL_CHANGED_DURING_VERIFICATION');
  requireThat(sha256(fs.readFileSync(manifest)) === sha256(manifestBytes) && sha256(fs.readFileSync(inputManifest)) === expected.inputManifestSha256, 'EXTERNAL_MANIFEST_CHANGED');
  return {status: 'verified', evidenceMode: runCommand === runExternalCommand ? 'actual-verification' : 'injected-command-test',
    sourceCommit: expected.sourceCommit, sourceTag: expected.sourceTag, manifestSha256: sha256(manifestBytes), inputManifestSha256: expected.inputManifestSha256,
    entriesSha256: sha256(JSON.stringify(entries)), entries, codeChecks: checks, bundledGitManifestSha256: runtime.manifestSha256, searchSha256: search.sha256, stapled};
}
