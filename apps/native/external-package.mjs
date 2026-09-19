import fs from 'node:fs';
import {releaseSourceTag} from './release-identity.mjs';
import {packageAttribution} from './product-attribution.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {inventory, sha256, requireUnencryptedCookieStore} from './package-support.mjs';
import {verifyGitRuntime} from '../../packages/desktop-host/src/git-executable.mjs';
import {externalPolicy, externalFramework, externalGit, enumerateExternalCode, applyExternalFuses} from './external-package-policy.mjs';
import {physical, testDirectory, readJson, parseJson, runExternalCommand, checkedCommand, validateExpected, verifyExternalArtifact, assertExternalAttributes} from './external-delivery-verify.mjs';

const nativePath = 'Contents/Resources/app/native-package.json';
const searchPath = 'Contents/Resources/app/apps/native/dist-host/search-runtime.json';
const application = 'Contents/Resources/app/';
const fail = code => {throw Object.assign(new Error(code), {code});};
const requireThat = (condition, code) => {if (!condition) fail(code);};
const equal = (a, b, code) => requireThat(isDeepStrictEqual(a, b), code);
const writeJson = (filename, data, flag = 'w') => fs.writeFileSync(filename, JSON.stringify(data, null, 2) + '\n', {flag, mode: 0o644});
const contained = (a, b) => a === b || b.startsWith(a + path.sep);
const disjoint = (a, b) => !contained(a, b) && !contained(b, a);
const allowed = new Set(['bundle', 'inputManifest', 'inputManifestSha256', 'sourceRoot', 'expected', 'workDirectory', 'outputDirectory', 'identitySha1', 'teamId']);

function optionsCheck(options, signing) {
  requireThat(options && Object.keys(options).every(key => allowed.has(key)), 'EXTERNAL_OPTIONS');
  const {bundle, inputManifest, inputManifestSha256, sourceRoot, workDirectory, expected, outputDirectory} = options;
  requireThat(expected && Object.keys(expected).sort().join(',') === 'buildNumber,sourceCommit,sourceTag,version', 'EXTERNAL_EXPECTED_OPTIONS');
  physical(bundle, true); physical(inputManifest); physical(sourceRoot, true); testDirectory(workDirectory);
  requireThat(path.basename(bundle) === 'asMagicBrain.app' && path.dirname(bundle) === path.dirname(inputManifest), 'EXTERNAL_INPUT_LOCATION');
  requireThat(disjoint(workDirectory, path.dirname(inputManifest)) && disjoint(workDirectory, sourceRoot), 'EXTERNAL_SCRATCH_OVERLAP');
  requireThat(/^[a-f0-9]{64}$/.test(inputManifestSha256), 'EXTERNAL_INPUT_MANIFEST_PIN');
  validateExpected({...expected, inputManifestSha256, identitySha1: signing ? options.identitySha1 : 'A'.repeat(40), teamId: signing ? options.teamId : 'ABCDEFGHIJ'});
  if (outputDirectory !== undefined) {
    requireThat(typeof outputDirectory === 'string' && path.isAbsolute(outputDirectory) && path.resolve(outputDirectory) === outputDirectory && !fs.existsSync(outputDirectory), 'EXTERNAL_OUTPUT_EXISTS');
    testDirectory(path.dirname(outputDirectory));
    requireThat(disjoint(outputDirectory, path.dirname(inputManifest)) && disjoint(outputDirectory, sourceRoot) && disjoint(outputDirectory, workDirectory), 'EXTERNAL_OUTPUT_OVERLAP');
  }
  if (signing) requireThat(outputDirectory !== undefined, 'EXTERNAL_OUTPUT_REQUIRED');
}

/** Read-only planning checks the immutable tag, not the current checkout HEAD:
 * packaging tools can advance while an earlier qualified package stays pinned. */
export function inspectExternalPackageInput(options, {runCommand = runExternalCommand} = {}) {
  optionsCheck(options, false);
  const {bundle, inputManifest, inputManifestSha256, sourceRoot, workDirectory, expected} = options;
  const command = (exe, args, options = {}) => checkedCommand(runCommand, exe, args, {tmp: workDirectory, ...options});
  requireThat(physical(inputManifest).size <= 16 * 1024 * 1024, 'EXTERNAL_JSON_LIMIT');
  const originalBytes = fs.readFileSync(inputManifest), original = parseJson(originalBytes.toString('utf8'));
  requireThat(sha256(originalBytes) === inputManifestSha256, 'EXTERNAL_INPUT_MANIFEST_PIN');
  const metadata = readJson(path.join(bundle, nativePath));
  for (const key of ['sourceCommit', 'sourceTag', 'version', 'buildNumber']) {
    equal(original[key], expected[key], 'EXTERNAL_SOURCE_MISMATCH'); equal(metadata[key], expected[key], 'EXTERNAL_NATIVE_METADATA');
  }
  requireThat(original.schemaVersion === 1 && metadata.schemaVersion === 1 && original.kind === 'versioned-preview' && original.candidate === false && original.candidateDirty === false && original.channel === 'preview' && original.bundleId === 'org.asmagicbrain.app.preview', 'EXTERNAL_PREVIEW_REQUIRED');
  for (const key of Object.keys(metadata)) equal(original[key], metadata[key], 'EXTERNAL_NATIVE_METADATA');
  requireThat(metadata.candidate === false && metadata.channel === 'preview' && !Object.hasOwn(metadata, 'testRoot') && !Object.hasOwn(metadata, 'externalPackaging'), 'EXTERNAL_PORTABLE_METADATA');
  equal(metadata.buildConfiguration, {channel: 'preview', presentation: 'implemented-only', canToggleUnavailable: false, validationOnly: false}, 'EXTERNAL_PREVIEW_CONFIGURATION');
  equal(original.buildConfiguration, metadata.buildConfiguration, 'EXTERNAL_PREVIEW_CONFIGURATION');
  const entries = inventory(bundle, {internalLinks: true}), codeTargets = enumerateExternalCode(bundle);
  equal(entries, original.entries, 'EXTERNAL_INPUT_CHANGED');
  assertExternalAttributes(bundle, runCommand, {tmp: workDirectory});
  const fuses = requireUnencryptedCookieStore(fs.readFileSync(path.join(bundle, externalFramework)));
  requireThat(fuses.wire === externalPolicy.fuseBefore && metadata.accountRuntimePolicy?.persistence === 'session', 'EXTERNAL_INPUT_FUSES');
  equal(metadata.accountRuntimePolicy.electronFuses, fuses, 'EXTERNAL_FUSE_METADATA');
  equal(original.accountRuntimePolicy, metadata.accountRuntimePolicy, 'EXTERNAL_ACCOUNT_METADATA');
  const git = (...args) => command('/usr/bin/git', ['--no-replace-objects', '-C', sourceRoot, ...args]).stdout;
  const taggedBytes = relative => command('/usr/bin/git', ['--no-replace-objects', '-C', sourceRoot, 'show', `${expected.sourceCommit}:${relative}`], {binary: true}).stdout;
  requireThat(git('rev-parse', '--show-toplevel').trim() === sourceRoot && git('rev-parse', `refs/tags/${expected.sourceTag}^{commit}`).trim() === expected.sourceCommit, 'EXTERNAL_SOURCE_TAG');
  const taggedJson = relative => JSON.parse(git('show', `${expected.sourceCommit}:${relative}`));
  const release = taggedJson('apps/native/release.json'), runtime = taggedJson('apps/native/runtime.json'), gitPin = taggedJson('apps/native/git-runtime.json');
  requireThat(release.version === expected.version && release.buildNumber === expected.buildNumber && releaseSourceTag(release) === expected.sourceTag, 'EXTERNAL_TAGGED_RELEASE');
  const tracked = new Set(git('ls-tree', '-r', '--name-only', expected.sourceCommit).trim().split('\n'));
  const sourcePackage = tracked.has('package.json') ? taggedJson('package.json') : {};
  const attributionKeys = ['author', 'organization', 'homepage', 'copyright'];
  // Historical packages without attribution remain valid. Once source declares
  // it, omission or substitution in a regenerated manifest cannot bypass it.
  if (attributionKeys.some(key => Object.hasOwn(sourcePackage, key)) || Object.hasOwn(original, 'attribution') || Object.hasOwn(metadata, 'attribution')) {
    const attribution = packageAttribution(sourcePackage);
    equal(original.attribution, attribution, 'EXTERNAL_TAGGED_ATTRIBUTION');
    equal(metadata.attribution, attribution, 'EXTERNAL_TAGGED_ATTRIBUTION');
    const packaged = readJson(path.join(bundle, application, 'package.json'));
    equal(Object.fromEntries(attributionKeys.map(key => [key, packaged[key]])), attribution, 'EXTERNAL_PACKAGE_ATTRIBUTION');
    const plist = parseJson(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(bundle, 'Contents/Info.plist')]).stdout);
    equal(plist.NSHumanReadableCopyright, attribution.copyright, 'EXTERNAL_ATTRIBUTION_PLIST');
  }
  requireThat(original.runtime && typeof original.runtime === 'object', 'EXTERNAL_RUNTIME_PIN');
  for (const key of ['version', 'platform', 'arch', 'archive', 'archiveSha256']) equal(original.runtime[key], runtime[key], 'EXTERNAL_RUNTIME_PIN');
  requireThat(runtime.platform === 'darwin' && runtime.arch === 'arm64' && metadata.bundledGit?.manifestSha256 === gitPin.preparedManifestSha256, 'EXTERNAL_PREPARED_GIT_PIN');
  equal(original.bundledGit, metadata.bundledGit, 'EXTERNAL_GIT_METADATA');
  verifyGitRuntime(path.join(bundle, externalGit), {manifestSha256: gitPin.preparedManifestSha256});
  const search = readJson(path.join(bundle, searchPath));
  equal(search, metadata.searchRuntime, 'EXTERNAL_SEARCH_METADATA'); equal(search, original.searchRuntime, 'EXTERNAL_SEARCH_METADATA');
  const rg = fs.readFileSync(path.join(bundle, application, 'apps/native/dist-host/rg'));
  requireThat(search.sha256 === sha256(rg) && search.bytes === rg.length && search.platform === 'darwin' && search.arch === 'arm64', 'EXTERNAL_SEARCH_HASH');
  requireThat(Array.isArray(original.inputs) && original.inputs.length > 0, 'EXTERNAL_SOURCE_INPUTS');
  const inputNames = new Set(); let taggedInputs = 0;
  for (const row of original.inputs) {
    requireThat(typeof row.path === 'string' && row.path.split('/').every(part => part && part !== '.' && part !== '..') && !row.path.includes('\\') && !inputNames.has(row.path), 'EXTERNAL_SOURCE_INPUT_PATH');
    inputNames.add(row.path); const filename = path.join(bundle, application, row.path); physical(filename);
    const bytes = fs.readFileSync(filename);
    requireThat(bytes.length === row.bytes && sha256(bytes) === row.sha256, 'EXTERNAL_SOURCE_INPUT_CHANGED');
    if (tracked.has(row.path)) {requireThat(sha256(taggedBytes(row.path)) === row.sha256, 'EXTERNAL_TAGGED_SOURCE_CHANGED'); taggedInputs++;}
  }
  requireThat(taggedInputs > 0, 'EXTERNAL_TAGGED_SOURCE_MISSING');
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]);
  equal(inventory(bundle, {internalLinks: true}), entries, 'EXTERNAL_INPUT_CHANGED_DURING_PLAN');
  requireThat(sha256(fs.readFileSync(inputManifest)) === inputManifestSha256, 'EXTERNAL_INPUT_MANIFEST_CHANGED');
  return {status: 'planned', policy: externalPolicy.name, sourceCommit: expected.sourceCommit, sourceTag: expected.sourceTag, inputManifestSha256, codeTargets, taggedInputs, entries: entries.length,
    fuses: {before: fuses, after: {...fuses, wire: externalPolicy.fuseAfter}}, signingRequired: 'Developer ID Application; explicit identity SHA-1 and Team ID; secure timestamp', notarizationPerformed: false};
}

export function selectDeveloperIdentity(output, identitySha1, teamId) {
  requireThat(/^[A-Fa-f0-9]{40}$/.test(identitySha1) && /^[A-Z0-9]{10}$/.test(teamId), 'EXTERNAL_SIGNING_IDENTITY');
  const selected = output.split(/\r?\n/).map(line => /^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"([^"]+)"\s*$/.exec(line)).filter(Boolean).filter(row => row[1].toUpperCase() === identitySha1.toUpperCase());
  requireThat(selected.length === 1 && /^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(selected[0][2]) && selected[0][2].endsWith(`(${teamId})`), 'EXTERNAL_IDENTITY_UNAVAILABLE');
  return {identitySha1: identitySha1.toUpperCase(), teamId};
}

function deriveRuntimeMetadata(bundle, original, signing, evidenceMode, fuses) {
  const directory = path.join(bundle, externalGit), manifestPath = path.join(directory, 'runtime-manifest.json');
  const preparedBytes = fs.readFileSync(manifestPath), prepared = JSON.parse(preparedBytes), notice = path.join(directory, 'licenses/SOURCE.md');
  fs.copyFileSync(notice, path.join(directory, 'licenses/SOURCE.prepared.md'), fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(path.join(directory, 'licenses/prepared-runtime-manifest.json'), preparedBytes, {flag: 'wx', mode: 0o644});
  const externalSigning = {...signing, evidenceMode, preparedManifestSha256: original.bundledGit.manifestSha256};
  writeJson(path.join(directory, 'licenses/external-signing.json'), externalSigning, 'wx');
  fs.writeFileSync(notice, `# Bundled Git — external signing derivation\n\nThis output derives from the unchanged upstream archives, source and selection recorded in provenance.json. SOURCE.prepared.md and prepared-runtime-manifest.json preserve the exact original preparation record.\n\nSigning policy: ${signing.policy}. Team: ${signing.teamId}. Identity SHA-1: ${signing.identitySha1}. Evidence mode: ${evidenceMode}.\n\n${evidenceMode === 'actual-signing' ? 'Every physical Git Mach-O was signed with Developer ID before this inventory.' : 'This is an injected-command test artifact; it does not establish a Developer ID signature.'} No notarization or distribution qualification is asserted here. Corresponding source archives and license notices remain unchanged in this directory.\n`);
  const derived = {...prepared, signing: 'developer-id-before-inventory', preparedManifestSha256: original.bundledGit.manifestSha256, externalSigning,
    machO: prepared.machO.map(row => ({...row, preparedSha256: row.afterSha256, afterSha256: sha256(fs.readFileSync(path.join(directory, row.path)))})),
    entries: inventory(directory, {internalLinks: true}).filter(row => row.path && row.path !== 'runtime-manifest.json')};
  writeJson(manifestPath, derived);
  const bundledGit = {...original.bundledGit, preparedManifestSha256: original.bundledGit.manifestSha256, manifestSha256: sha256(fs.readFileSync(manifestPath))};
  verifyGitRuntime(directory, {manifestSha256: bundledGit.manifestSha256});
  const rg = fs.readFileSync(path.join(bundle, application, 'apps/native/dist-host/rg'));
  const searchRuntime = {...original.searchRuntime, preparedSha256: original.searchRuntime.sha256, bytes: rg.length, sha256: sha256(rg), signing: {...signing, evidenceMode}};
  writeJson(path.join(bundle, searchPath), searchRuntime);
  const metadata = readJson(path.join(bundle, nativePath));
  metadata.bundledGit = bundledGit; metadata.searchRuntime = searchRuntime;
  metadata.accountRuntimePolicy.electronFuses = fuses.after;
  metadata.externalPackaging = {schemaVersion: 1, ...signing, evidenceMode};
  writeJson(path.join(bundle, nativePath), metadata);
  return metadata;
}

/** A transform never overwrites a release. An injected runner/verifier is useful
 * for local engineering but can only produce an explicitly synthetic receipt. */
export function packageExternalPreview(options, {runCommand = runExternalCommand, verifyArtifact = verifyExternalArtifact} = {}) {
  optionsCheck(options, true);
  const plan = inspectExternalPackageInput(options, {runCommand});
  const {bundle: inputBundle, inputManifest, inputManifestSha256, outputDirectory, workDirectory, expected} = options;
  const command = (exe, args, extra = {}) => checkedCommand(runCommand, exe, args, {tmp: workDirectory, ...extra});
  const selected = selectDeveloperIdentity(command('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']).stdout, options.identitySha1, options.teamId);
  const evidenceMode = runCommand === runExternalCommand && verifyArtifact === verifyExternalArtifact ? 'actual-signing' : 'injected-command-test';
  const original = readJson(inputManifest), signing = {policy: externalPolicy.name, ...selected, inputManifestSha256};
  requireThat(sha256(fs.readFileSync(inputManifest)) === inputManifestSha256, 'EXTERNAL_INPUT_MANIFEST_CHANGED');
  const bundle = path.join(outputDirectory, 'asMagicBrain.app'), manifest = path.join(outputDirectory, 'external-package-manifest.json');
  fs.mkdirSync(outputDirectory, {mode: 0o700});
  const steps = [];
  try {
    command('/usr/bin/ditto', ['--norsrc', '--noextattr', '--noqtn', inputBundle, bundle]);
    equal(inventory(bundle, {internalLinks: true}), original.entries, 'EXTERNAL_COPY_CHANGED');
    assertExternalAttributes(bundle, runCommand, {tmp: workDirectory});
    const fuses = applyExternalFuses(bundle), targets = enumerateExternalCode(bundle);
    equal(targets, plan.codeTargets, 'EXTERNAL_COPY_CODE_POLICY');
    const entitlementFile = path.join(outputDirectory, 'jit-entitlements.plist');
    fs.writeFileSync(entitlementFile, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>\n', {flag: 'wx', mode: 0o600});
    function sign(target) {
      const args = ['--force', '--sign', selected.identitySha1, '--timestamp'];
      if (target.hardenedRuntime) args.push('--options', 'runtime');
      if (target.entitlements.length) args.push('--entitlements', entitlementFile);
      // Standalone helper IDs must be stable across relocated output paths.
      if (target.kind === 'file') args.push('--identifier', `org.asmagicbrain.app.preview.code.${sha256(target.path).slice(0, 20)}`);
      args.push(path.join(bundle, target.path)); command('/usr/bin/codesign', args);
      steps.push({action: 'signed', path: target.path});
    }
    for (const target of targets) if (target.path !== '.') sign(target);
    const metadata = deriveRuntimeMetadata(bundle, original, signing, evidenceMode, fuses);
    steps.push({action: 'derived-runtime-inventories', git: metadata.bundledGit.manifestSha256, search: metadata.searchRuntime.sha256});
    sign(targets.find(target => target.path === '.'));
    // No bundle writes after this seal. Receipts and verifier scratch stay outside.
    const resultManifest = {...original, kind: 'developer-id-external-preview', ...metadata, candidate: false, evidenceMode,
      input: {manifestSha256: inputManifestSha256, sourceCommit: expected.sourceCommit, sourceTag: expected.sourceTag, version: expected.version, buildNumber: expected.buildNumber}, signing, fuses, codeTargets: targets,
      createdAt: new Date().toISOString(), entries: inventory(bundle, {internalLinks: true})};
    writeJson(manifest, resultManifest, 'wx');
    const verification = verifyArtifact({bundle, manifest, inputManifest, expected: {...expected, ...selected, inputManifestSha256}, workDirectory, runCommand});
    requireThat(verification.status === 'verified' && (evidenceMode !== 'actual-signing' || verification.evidenceMode === 'actual-verification'), 'EXTERNAL_FINAL_VERIFICATION');
    equal(inventory(bundle, {internalLinks: true}), resultManifest.entries, 'EXTERNAL_CHANGED_AFTER_SEAL');
    equal(inventory(inputBundle, {internalLinks: true}), original.entries, 'EXTERNAL_ORIGINAL_CHANGED');
    requireThat(sha256(fs.readFileSync(inputManifest)) === inputManifestSha256, 'EXTERNAL_INPUT_MANIFEST_CHANGED');
    const receipt = {schemaVersion: 1, status: evidenceMode === 'actual-signing' ? 'signed-and-verified' : 'test-passed', evidenceMode,
      bundle, manifest, manifestSha256: sha256(fs.readFileSync(manifest)), inputManifestSha256, ...expected, signing, steps,
      verification, originalPreserved: true, notarizationPerformed: false, readyToDistribute: false};
    writeJson(path.join(outputDirectory, 'receipt.json'), receipt, 'wx');
    return receipt;
  } catch (error) {
    writeJson(path.join(outputDirectory, 'failure.json'), {schemaVersion: 1, status: 'failed', evidenceMode, code: error.code ?? 'EXTERNAL_TRANSFORM_FAILED', steps, inputManifestSha256, notarizationPerformed: false}, 'wx');
    throw error;
  }
}

export function externalPackageCLI(argv) {
  const usage = 'Usage: native:package:external --plan|--sign --bundle PATH --input-manifest PATH --input-manifest-sha256 SHA256 --source-root PATH --source-commit COMMIT --source-tag native-vX.Y.Z --version X.Y.Z --build-number N --work-directory TEST_PATH [--output-directory NEW_TEST_PATH --identity-sha1 SHA1 --team-id TEAM]\n--plan is read-only and never queries signing credentials. --sign requires a Developer ID identity and performs real signing; there is no ad-hoc fallback.';
  if (argv.length === 1 && argv[0] === '--help') return {help: usage};
  requireThat(['--plan', '--sign'].includes(argv[0]), 'EXTERNAL_CLI_MODE');
  const names = {bundle: 'bundle', 'input-manifest': 'inputManifest', 'input-manifest-sha256': 'inputManifestSha256', 'source-root': 'sourceRoot', 'work-directory': 'workDirectory', 'output-directory': 'outputDirectory', 'identity-sha1': 'identitySha1', 'team-id': 'teamId', 'source-commit': 'sourceCommit', 'source-tag': 'sourceTag', version: 'version', 'build-number': 'buildNumber'};
  const parsed = {};
  for (let i = 1; i < argv.length; i += 2) {
    const key = names[argv[i]?.replace(/^--/, '')];
    requireThat(key && argv[i].startsWith('--') && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--') && !Object.hasOwn(parsed, key), 'EXTERNAL_CLI_ARGUMENT');
    parsed[key] = argv[i + 1];
  }
  const expected = Object.fromEntries(['sourceCommit', 'sourceTag', 'version', 'buildNumber'].map(key => [key, key === 'buildNumber' ? Number(parsed[key]) : parsed[key]]));
  for (const key of Object.keys(expected)) delete parsed[key];
  return argv[0] === '--plan' ? inspectExternalPackageInput({...parsed, expected}) : packageExternalPreview({...parsed, expected});
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {console.log(JSON.stringify(externalPackageCLI(process.argv.slice(2)), null, 2));}
  catch (error) {console.error(error.code ?? 'EXTERNAL_PACKAGE_FAILED'); process.exitCode = 1;}
}
