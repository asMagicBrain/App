import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inventory, sha256} from './package-support.mjs';
import {assertExternalAttributes, checkedCommand, deliveryError, parseJson, physical, readJson, requireDisjoint, runExternalCommand, testDirectory, validateExpected, verifyExternalArtifact} from './external-delivery-verify.mjs';

const keys = ['bundle', 'manifest', 'inputManifest', 'expected', 'outputParent', 'outputName', 'temporaryDirectory', 'keychainProfile', 'authorizeNotarySubmission', 'pollAttempts', 'pollIntervalMs', 'commandTimeoutMs'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => { throw deliveryError(code); };
const hashFile = filename => { physical(filename); return sha256(fs.readFileSync(filename)); };
const inventoryHash = bundle => sha256(JSON.stringify(inventory(bundle, {internalLinks: true})));
function absent(filename) { try { fs.lstatSync(filename); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } }
function writeJson(filename, value) {
  const descriptor = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  const parent = fs.openSync(path.dirname(filename), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
function syncFile(filename) {
  const descriptor = fs.openSync(filename, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
export function validateDeliveryOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !keys.includes(key))) fail('EXTERNAL_DELIVERY_OPTIONS');
  validateExpected(options.expected);
  if (Object.keys(options.expected).some(key => !['sourceCommit', 'sourceTag', 'version', 'buildNumber', 'teamId', 'identitySha1', 'inputManifestSha256'].includes(key))) fail('EXTERNAL_EXPECTED_OPTIONS');
  physical(options.bundle, true); physical(options.manifest); physical(options.inputManifest);
  testDirectory(options.outputParent); testDirectory(options.temporaryDirectory);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,119}$/.test(options.outputName) || !/^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,79}$/.test(options.keychainProfile)) fail('EXTERNAL_OUTPUT_OR_PROFILE_NAME');
  const output = path.join(options.outputParent, options.outputName);
  if (!absent(output) || output.startsWith(options.bundle + path.sep) || options.bundle.startsWith(output + path.sep)) fail('EXTERNAL_OUTPUT_COLLISION');
  requireDisjoint(output, [options.bundle, options.manifest, options.inputManifest]);
  requireDisjoint(options.temporaryDirectory, [options.bundle, options.manifest, options.inputManifest]);
  if (options.authorizeNotarySubmission !== undefined && typeof options.authorizeNotarySubmission !== 'boolean') fail('EXTERNAL_AUTHORIZATION_SHAPE');
  const pollAttempts = options.pollAttempts ?? 30, pollIntervalMs = options.pollIntervalMs ?? 10_000, commandTimeoutMs = options.commandTimeoutMs ?? 300_000;
  if (!Number.isSafeInteger(pollAttempts) || pollAttempts < 1 || pollAttempts > 60 || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 60_000 || !Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs < 1 || commandTimeoutMs > 600_000) fail('EXTERNAL_DELIVERY_BOUNDS');
  return {...options, output, pollAttempts, pollIntervalMs, commandTimeoutMs};
}

/** This is metadata inspection only. Never prompts for a private key, registers
 * credentials, reads Keychain items, or falls back to another signing identity. */
export function preflightExternalDelivery(options, {runCommand = runExternalCommand, verifyArtifact = verifyExternalArtifact} = {}) {
  const config = validateDeliveryOptions(options);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') fail('EXTERNAL_PLATFORM');
  const original = readJson(config.inputManifest), declared = readJson(config.manifest);
  if (hashFile(config.inputManifest) !== config.expected.inputManifestSha256 || original.sourceCommit !== config.expected.sourceCommit || declared.input?.manifestSha256 !== config.expected.inputManifestSha256) fail('EXTERNAL_INPUT_MANIFEST_PIN');
  const result = checkedCommand(runCommand, '/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {tmp: config.temporaryDirectory, timeout: 30_000});
  const matches = [...result.stdout.matchAll(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"(Developer ID Application: [^"\r\n]+)"\s*$/gm)]
    .filter(match => match[1].toUpperCase() === config.expected.identitySha1.toUpperCase() && match[2].endsWith(`(${config.expected.teamId})`));
  if (matches.length !== 1) fail('EXTERNAL_DEVELOPER_ID_UNAVAILABLE');
  const verification = verifyArtifact({bundle: config.bundle, manifest: config.manifest, inputManifest: config.inputManifest, expected: config.expected, workDirectory: config.temporaryDirectory, runCommand});
  if (verification.status !== 'verified') fail('EXTERNAL_ARTIFACT_UNVERIFIED');
  const synthetic = runCommand !== runExternalCommand || verifyArtifact !== verifyExternalArtifact || verification.evidenceMode !== 'actual-verification';
  if (!synthetic && declared.evidenceMode !== 'actual-signing') fail('EXTERNAL_SYNTHETIC_ARTIFACT');
  return {status: 'passed', evidenceMode: synthetic ? 'injected-command-test' : 'actual-preflight', verification,
    output: config.output, keychainProfile: config.keychainProfile, credentialAccess: false, submissionPerformed: false};
}

/** Retain only non-sensitive service fields and a digest of the complete reply.
 * Arbitrary messages, account values and paths are never echoed or persisted. */
function statusRecord(bytes, expectedId) {
  const value = parseJson(bytes);
  if (!uuid.test(value.id) || expectedId && value.id !== expectedId) fail('EXTERNAL_NOTARY_ID');
  if (!['In Progress', 'Accepted', 'Invalid', 'Rejected'].includes(value.status)) fail('EXTERNAL_NOTARY_STATUS');
  return {id: value.id, status: value.status, responseSha256: sha256(bytes)};
}
export function validateNotaryLog(bytes, {id, submissionSha256, submissionFilename}) {
  const value = parseJson(bytes);
  if (value.jobId !== id || value.sha256 !== submissionSha256 || value.archiveFilename !== submissionFilename) fail('EXTERNAL_NOTARY_LOG_ARTIFACT');
  if (value.status !== 'Accepted' || value.statusCode !== 0) fail('EXTERNAL_NOTARY_LOG_REJECTED');
  if (value.issues !== null && (!Array.isArray(value.issues) || value.issues.length !== 0)) fail('EXTERNAL_NOTARY_LOG_ISSUES');
  return {jobId: value.jobId, status: value.status, statusCode: value.statusCode, sha256: value.sha256, archiveFilename: value.archiveFilename, issues: [], responseSha256: sha256(bytes)};
}
function sanitizeLog(bytes) {
  const value = parseJson(bytes);
  return {responseSha256: sha256(bytes), ...(uuid.test(value.jobId) ? {jobId: value.jobId} : {}),
    status: ['Accepted', 'Invalid', 'Rejected', 'In Progress'].includes(value.status) ? value.status : 'unrecognized',
    ...(Number.isSafeInteger(value.statusCode) ? {statusCode: value.statusCode} : {}),
    issues: Array.isArray(value.issues) ? value.issues.map(issue => ({severity: ['error', 'warning'].includes(issue?.severity) ? issue.severity : 'unrecognized', code: Number.isSafeInteger(issue?.code) ? issue.code : null})) : []};
}

/** Explicit submission is a separate operation from preflight. There is no
 * automatic resume or resubmit path: an uncertain upload retains that fact. */
export async function deliverExternalPreview(options, {runCommand = runExternalCommand, verifyArtifact = verifyExternalArtifact, wait = sleep} = {}) {
  const config = validateDeliveryOptions(options);
  if (config.authorizeNotarySubmission !== true) fail('EXTERNAL_SUBMISSION_NOT_AUTHORIZED');
  const preflight = preflightExternalDelivery(options, {runCommand, verifyArtifact});
  const synthetic = preflight.evidenceMode !== 'actual-preflight' || wait !== sleep;
  fs.mkdirSync(config.output, {mode: 0o700}); // Exclusive claim; never replaces a prior or interrupted run.
  syncFile(config.outputParent);
  const receipt = {schemaVersion: 1, status: 'running', evidenceMode: synthetic ? 'injected-command-test' : 'actual-delivery',
    sourceCommit: config.expected.sourceCommit, sourceTag: config.expected.sourceTag, version: config.expected.version, buildNumber: config.expected.buildNumber,
    teamId: config.expected.teamId, identitySha1: config.expected.identitySha1.toUpperCase(), inputManifestSha256: config.expected.inputManifestSha256,
    signedManifestSha256: hashFile(config.manifest), output: config.output, keychainProfile: config.keychainProfile,
    submissionPerformed: false, submissionMayHaveOccurred: false, notaryAccepted: false, stapleValidated: false,
    readyForIndependentGatekeeperAssessment: false, readyToDistribute: false, commands: [], statuses: [], failure: null};
  const originalHash = inventoryHash(config.bundle), originalManifest = hashFile(config.manifest), inputManifest = hashFile(config.inputManifest);
  const auth = ['--keychain-profile', config.keychainProfile];
  const command = (tool, args, {timeout = config.commandTimeoutMs, ...other} = {}) => {
    receipt.commands.push({tool: path.basename(tool), action: args[0], at: new Date().toISOString()});
    return checkedCommand(runCommand, tool, args, {tmp: config.temporaryDirectory, timeout, ...other});
  };
  const preserved = () => {
    if (inventoryHash(config.bundle) !== originalHash || hashFile(config.manifest) !== originalManifest || hashFile(config.inputManifest) !== inputManifest) fail('EXTERNAL_INPUT_CHANGED');
    if (receipt.submission && hashFile(receipt.submission.path) !== receipt.submission.sha256) fail('EXTERNAL_SUBMISSION_CHANGED');
    assertExternalAttributes(config.bundle, runCommand, {tmp: config.temporaryDirectory});
  };
  const verify = (bundle, stapled = false) => {
    const result = verifyArtifact({bundle, manifest: config.manifest, inputManifest: config.inputManifest, expected: config.expected, workDirectory: config.temporaryDirectory, runCommand, stapled});
    if (result.status !== 'verified' || !synthetic && result.evidenceMode !== 'actual-verification') fail('EXTERNAL_ARTIFACT_UNVERIFIED');
    return result;
  };
  const zip = (bundle, destination) => {
    if (!absent(destination)) fail('EXTERNAL_OUTPUT_COLLISION');
    command('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noqtn', '--keepParent', bundle, destination]);
    physical(destination); syncFile(destination); syncFile(path.dirname(destination));
    return {path: destination, bytes: fs.statSync(destination).size, sha256: hashFile(destination)};
  };
  const extract = (zipFile, directory) => {
    fs.mkdirSync(directory, {mode: 0o700});
    command('/usr/bin/ditto', ['-x', '-k', '--norsrc', '--noextattr', '--noqtn', zipFile, directory]);
    const names = fs.readdirSync(directory);
    if (names.length !== 1 || names[0] !== path.basename(config.bundle)) fail('EXTERNAL_ZIP_MEMBERSHIP');
    const bundle = path.join(directory, names[0]); physical(bundle, true); return bundle;
  };
  try {
    const submissionDirectory = path.join(config.output, 'submission'); fs.mkdirSync(submissionDirectory, {mode: 0o700});
    const submissionApp = path.join(submissionDirectory, path.basename(config.bundle));
    command('/usr/bin/ditto', ['--norsrc', '--noextattr', '--noqtn', config.bundle, submissionApp]);
    const signed = verify(submissionApp); if (inventoryHash(submissionApp) !== originalHash) fail('EXTERNAL_COPY_CHANGED');
    receipt.submission = zip(submissionApp, path.join(config.output, 'submission.zip'));
    const extractedSubmission = extract(receipt.submission.path, path.join(config.output, 'submission-check'));
    verify(extractedSubmission); if (inventoryHash(extractedSubmission) !== signed.entriesSha256) fail('EXTERNAL_SUBMISSION_ZIP_CHANGED');
    preserved(); receipt.submissionMayHaveOccurred = true;
    writeJson(path.join(config.output, 'submission-intent.json'), {submissionMayHaveOccurred: true, submission: receipt.submission,
      sourceCommit: receipt.sourceCommit, signedManifestSha256: receipt.signedManifestSha256,
      policy: 'An interrupted upload must be reconciled manually; never resubmit automatically.'});
    const submitted = command('/usr/bin/xcrun', ['notarytool', 'submit', receipt.submission.path, ...auth, '--no-wait', '--output-format', 'json']);
    receipt.notarySubmitResponseSha256 = sha256(submitted.stdout);
    const value = parseJson(submitted.stdout); if (!uuid.test(value.id)) fail('EXTERNAL_NOTARY_ID');
    receipt.submissionId = value.id; receipt.submissionPerformed = true;
    writeJson(path.join(config.output, 'submission-response.json'), {id: value.id, responseSha256: sha256(submitted.stdout), submission: receipt.submission});
    // Persist the ID immediately: a later process interruption cannot invite a blind retry.
    let terminal;
    for (let attempt = 0; attempt < config.pollAttempts; attempt++) {
      preserved();
      const result = command('/usr/bin/xcrun', ['notarytool', 'info', value.id, ...auth, '--output-format', 'json']);
      receipt.lastStatusResponseSha256 = sha256(result.stdout);
      const status = statusRecord(result.stdout, value.id); receipt.statuses.push(status);
      writeJson(path.join(config.output, `status-${attempt + 1}.json`), status);
      if (status.status !== 'In Progress') { terminal = status; break; }
      if (attempt + 1 < config.pollAttempts) await wait(config.pollIntervalMs);
    }
    if (!terminal) fail('EXTERNAL_NOTARY_PENDING');
    const log = command('/usr/bin/xcrun', ['notarytool', 'log', value.id, ...auth]);
    receipt.notaryLogResponseSha256 = sha256(log.stdout);
    writeJson(path.join(config.output, 'notary-log.sanitized.json'), sanitizeLog(log.stdout));
    if (terminal.status !== 'Accepted') fail('EXTERNAL_NOTARY_REJECTED');
    receipt.notaryLog = validateNotaryLog(log.stdout, {id: value.id, submissionSha256: receipt.submission.sha256, submissionFilename: path.basename(receipt.submission.path)});
    receipt.notaryAccepted = !synthetic;
    preserved(); verify(submissionApp);
    const finalDirectory = path.join(config.output, 'stapled'); fs.mkdirSync(finalDirectory, {mode: 0o700});
    const finalApp = path.join(finalDirectory, path.basename(config.bundle));
    command('/usr/bin/ditto', ['--norsrc', '--noextattr', '--noqtn', submissionApp, finalApp]); verify(finalApp);
    command('/usr/bin/xcrun', ['stapler', 'staple', finalApp]);
    command('/usr/bin/xcrun', ['stapler', 'validate', finalApp]);
    const finalVerification = verify(finalApp, true); receipt.finalApp = {path: finalApp, entriesSha256: finalVerification.entriesSha256};
    receipt.finalZip = zip(finalApp, path.join(config.output, 'asMagicBrain-preview.zip'));
    const finalExtracted = extract(receipt.finalZip.path, path.join(config.output, 'delivery-check'));
    const extractedVerification = verify(finalExtracted, true);
    if (extractedVerification.entriesSha256 !== finalVerification.entriesSha256) fail('EXTERNAL_FINAL_ZIP_CHANGED');
    command('/usr/bin/xcrun', ['stapler', 'validate', finalExtracted]);
    assertExternalAttributes(finalApp, runCommand, {tmp: config.temporaryDirectory});
    assertExternalAttributes(finalExtracted, runCommand, {tmp: config.temporaryDirectory});
    // Verify again after the last external tool before declaring a sealed result.
    if (inventoryHash(finalApp) !== finalVerification.entriesSha256 || inventoryHash(finalExtracted) !== finalVerification.entriesSha256 || hashFile(receipt.finalZip.path) !== receipt.finalZip.sha256) fail('EXTERNAL_FINAL_CHANGED');
    preserved(); receipt.stapleValidated = !synthetic;
    receipt.status = synthetic ? 'synthetic-workflow-passed' : 'notarized-stapled-delivery-prepared';
    receipt.readyForIndependentGatekeeperAssessment = !synthetic;
    receipt.independentGatekeeperAssessment = 'pending; this workflow does not assess a downloaded/quarantined copy or an independent environment';
  } catch (error) {
    receipt.status = 'failed'; receipt.failure = {code: /^EXTERNAL_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'EXTERNAL_WORKFLOW_FAILED'};
    receipt.resumePolicy = 'No automatic resume/resubmit. Preserve the submission ID and reconcile uncertain service state before a separately reviewed operation.';
    throw Object.assign(deliveryError(receipt.failure.code), {receipt: path.join(config.output, 'delivery-receipt.json')});
  } finally {
    receipt.finishedAt = new Date().toISOString();
    writeJson(path.join(config.output, 'delivery-receipt.json'), receipt);
  }
  return receipt;
}

const help = `External preview delivery (macOS arm64)\n\n  node apps/native/external-delivery.mjs --preflight CONFIG.json\n  node apps/native/external-delivery.mjs --submit-reviewed-package CONFIG.json\n\nPreflight checks immutable input pins, a selected Developer ID identity, the signed\napp and a new Test output target. It does not read credentials or submit anything.\nSubmission additionally requires authorizeNotarySubmission:true and a named\nnotarytool Keychain profile already provisioned by the owner. No passwords, API\nkeys, credential registration, fallback identity or automatic retry are accepted.\nOwner membership, signing and notary credentials must be established separately.\nThe final ZIP remains pending independent downloaded/quarantined Gatekeeper QA.\n`;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, configFile, ...rest] = process.argv.slice(2);
    if ((!operation || operation === '--help') && !configFile && !rest.length) process.stdout.write(help);
    else {
      if (rest.length || !configFile || !['--preflight', '--submit-reviewed-package'].includes(operation)) fail('EXTERNAL_CLI_USAGE');
      const options = readJson(path.resolve(configFile));
      const receipt = operation === '--preflight' ? preflightExternalDelivery(options) : await deliverExternalPreview(options);
      process.stdout.write(JSON.stringify({status: receipt.status, evidenceMode: receipt.evidenceMode, output: receipt.output, readyToDistribute: false}) + '\n');
    }
  } catch (error) {
    process.stderr.write(JSON.stringify({status: 'failed', code: /^EXTERNAL_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'EXTERNAL_WORKFLOW_FAILED', ...(error.receipt ? {receipt: error.receipt} : {})}) + '\n');
    process.exitCode = 1;
  }
}
