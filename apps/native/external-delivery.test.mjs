import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {inventory, sha256} from './package-support.mjs';
import {deliverExternalPreview, preflightExternalDelivery, validateNotaryLog} from './external-delivery.mjs';
import {fixtureRoot, identitySha1, write, json} from './external-delivery-fixture.mjs';

const submissionId = '12345678-1234-1234-1234-123456789abc';
const hash = p => sha256(fs.readFileSync(p));
function fixture(behavior = {}) {
  const root = fixtureRoot('delivery'), bundle = path.join(root, 'asMagicBrain.app'), tmp = path.join(root, 'tmp'), outputs = path.join(root, 'outputs');
  fs.mkdirSync(tmp); fs.mkdirSync(outputs); write(path.join(bundle, 'Contents/source.txt'), 'immutable source\n');
  const source = {sourceCommit: 'a'.repeat(40), sourceTag: 'native-v0.2.9', version: '0.2.9', buildNumber: 30};
  const inputManifest = path.join(root, 'input.json'); json(inputManifest, source);
  const expected = {...source, identitySha1, teamId: 'ABCDEFGHIJ', inputManifestSha256: hash(inputManifest)};
  const manifest = path.join(root, 'signed.json'); json(manifest, {...source, evidenceMode: 'actual-signing', input: {manifestSha256: expected.inputManifestSha256}});
  const options = {bundle, manifest, inputManifest, expected, outputParent: outputs, outputName: 'delivery', temporaryDirectory: tmp, keychainProfile: 'notary-test-name', authorizeNotarySubmission: true, pollAttempts: 2, pollIntervalMs: 1, commandTimeoutMs: 1000};
  const original = inventory(bundle, {internalLinks: true}), commands = [], archives = new Map();
  let infoCalls = 0;
  const ok = (stdout = '') => ({status: 0, stdout, stderr: ''});
  const verifyArtifact = ({bundle: input, stapled}) => {
    const current = inventory(input, {internalLinks: true});
    assert.deepEqual(current.filter(row => row.path !== 'Contents/CodeResources'), original);
    if (!stapled) assert.deepEqual(current, original);
    return {status: 'verified', evidenceMode: 'injected-command-test', entriesSha256: sha256(JSON.stringify(current))};
  };
  const runCommand = (exe, args, commandOptions) => {
    commands.push({exe, args, commandOptions});
    if (exe.endsWith('/security')) return ok(behavior.noIdentity ? '0 valid identities found' : `  1) ${identitySha1} "Developer ID Application: Synthetic Fixture (ABCDEFGHIJ)"\n`);
    if (exe.endsWith('/xattr')) return ok();
    if (exe.endsWith('/ditto')) {
      assert.ok(args.includes('--norsrc') && args.includes('--noextattr') && args.includes('--noqtn'));
      const [from, to] = args.slice(-2);
      if (args.includes('-c')) {
        const snapshot = path.join(root, 'archive-snapshot-' + archives.size); fs.cpSync(from, snapshot, {recursive: true});
        const bytes = Buffer.from(JSON.stringify(inventory(snapshot, {internalLinks: true}))); write(to, bytes, 0o600); archives.set(to, snapshot);
      } else if (args.includes('-x')) {
        fs.cpSync(archives.get(from), path.join(to, path.basename(bundle)), {recursive: true});
        if (behavior.extraZipMember) write(path.join(to, '__MACOSX/private'), 'unexpected private fork');
      } else fs.cpSync(from, to, {recursive: true});
      return ok();
    }
    assert.equal(exe, '/usr/bin/xcrun');
    if (args[0] === 'notarytool') {
      assert.ok(args.includes('--keychain-profile') && !args.includes('--password') && !args.includes('--key'));
      if (args[1] === 'submit') {
        const intentPath = path.join(outputs, 'delivery/submission-intent.json');
        assert.ok(fs.existsSync(intentPath), 'upload intent exists before any submit command');
        const intent = JSON.parse(fs.readFileSync(intentPath)); assert.equal(intent.submission.sha256, hash(args[2])); assert.equal(intent.submissionMayHaveOccurred, true);
        if (behavior.submitTimeout) return {status: null, stdout: 'account=private@example.test', stderr: 'secret-credential', error: {code: 'ETIMEDOUT'}};
        if (behavior.malformedSubmit) return ok('{broken account=private@example.test');
        return ok(JSON.stringify({id: behavior.badId ? 'not-a-UUID' : submissionId, message: 'account=private@example.test'}));
      }
      if (args[1] === 'info') {
        infoCalls++;
        if (behavior.mutateInput && infoCalls === 1) write(path.join(bundle, 'Contents/source.txt'), 'input drift');
        return ok(JSON.stringify({id: behavior.wrongInfoId ? 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' : submissionId, status: behavior.status ?? 'Accepted', message: 'private@example.test'}));
      }
      if (args[1] === 'log') {
        const log = {jobId: submissionId, status: behavior.status ?? 'Accepted', statusCode: 0, sha256: hash(path.join(outputs, 'delivery/submission.zip')), archiveFilename: 'submission.zip', issues: null, privateAccount: 'secret@example.test'};
        Object.assign(log, behavior.log ?? {}); return ok(JSON.stringify(log));
      }
    }
    if (args[0] === 'stapler') {
      if (behavior.stapleFailure) return {status: 65, stdout: '', stderr: 'private@example.test'};
      if (args[1] === 'staple') write(path.join(args[2], 'Contents/CodeResources'), 'synthetic ticket, not Apple notarization');
      if (behavior.mutateFinal && args[1] === 'validate' && args[2].includes('delivery-check')) write(path.join(args[2], 'Contents/source.txt'), 'changed after check');
      return ok();
    }
    throw Error('Unexpected mocked command');
  };
  const dependencies = {runCommand, verifyArtifact, wait: async () => {}};
  return {root, options, dependencies, commands, readReceipt: () => JSON.parse(fs.readFileSync(path.join(outputs, 'delivery/delivery-receipt.json'))), output: path.join(outputs, 'delivery')};
}

test('synthetic notarization flow keeps submission and stapled final ZIP hashes separate without actual readiness claims', async () => {
  const f = fixture(), before = inventory(f.options.bundle, {internalLinks: true});
  const receipt = await deliverExternalPreview(f.options, f.dependencies);
  assert.equal(receipt.status, 'synthetic-workflow-passed'); assert.equal(receipt.evidenceMode, 'injected-command-test');
  assert.notEqual(receipt.submission.sha256, receipt.finalZip.sha256);
  for (const gate of ['notaryAccepted', 'stapleValidated', 'readyForIndependentGatekeeperAssessment', 'readyToDistribute']) assert.equal(receipt[gate], false);
  assert.equal(receipt.submissionId, submissionId); assert.deepEqual(inventory(f.options.bundle, {internalLinks: true}), before);
  assert.equal(f.commands.filter(c => c.args[0] === 'notarytool' && c.args[1] === 'submit').length, 1);
  assert.equal(f.commands.filter(c => c.args[0] === 'stapler' && c.args[1] === 'validate').length, 2);
  const evidence = fs.readdirSync(f.output).filter(n => n.endsWith('.json')).map(n => fs.readFileSync(path.join(f.output, n), 'utf8')).join('');
  assert.doesNotMatch(evidence, /private@example|secret@example|secret-credential/);
});
test('preflight missing membership/identity performs no copy, upload or output creation', () => {
  const f = fixture({noIdentity: true}); assert.throws(() => preflightExternalDelivery(f.options, f.dependencies), /EXTERNAL_DEVELOPER_ID_UNAVAILABLE/);
  assert.equal(fs.existsSync(f.output), false); assert.equal(f.commands.length, 1);
});
test('explicit authorization, bounded options and unknown credential keys fail before tools', async () => {
  for (const change of [{authorizeNotarySubmission: false}, {password: 'not-permitted'}, {pollAttempts: 10000}, {keychainProfile: '--password=secret'}]) {
    const f = fixture(); await assert.rejects(deliverExternalPreview({...f.options, ...change}, f.dependencies), /EXTERNAL_/); assert.equal(f.commands.length, 0); assert.equal(fs.existsSync(f.output), false);
  }
});
test('existing or symlinked output refuses without overwriting previous evidence', async () => {
  const f = fixture(); fs.mkdirSync(f.output); write(path.join(f.output, 'prior'), 'keep');
  await assert.rejects(deliverExternalPreview(f.options, f.dependencies), /EXTERNAL_OUTPUT_COLLISION/); assert.equal(fs.readFileSync(path.join(f.output, 'prior'), 'utf8'), 'keep'); assert.equal(f.commands.length, 0);
  const link = path.join(f.root, 'output-link'); fs.symlinkSync(f.options.outputParent, link);
  await assert.rejects(deliverExternalPreview({...f.options, outputParent: link}, f.dependencies), /EXTERNAL_PATH_LINK/);
});
test('scratch inside immutable app is refused before verifier or any mutation', async () => {
  const f = fixture(), before = inventory(f.options.bundle, {internalLinks: true});
  await assert.rejects(deliverExternalPreview({...f.options, temporaryDirectory: path.join(f.options.bundle, 'Contents')}, f.dependencies), /EXTERNAL_INPUT_OUTPUT_OVERLAP/);
  assert.deepEqual(inventory(f.options.bundle, {internalLinks: true}), before); assert.equal(f.commands.length, 0);
});
test('uncertain upload timeout retains durable intent with exact ZIP and never retries', async () => {
  const f = fixture({submitTimeout: true}); await assert.rejects(deliverExternalPreview(f.options, f.dependencies), /EXTERNAL_COMMAND_TIMEOUT/);
  const receipt = f.readReceipt(); assert.equal(receipt.submissionMayHaveOccurred, true); assert.equal(receipt.submissionPerformed, false); assert.equal(receipt.submissionId, undefined);
  assert.ok(fs.existsSync(path.join(f.output, 'submission-intent.json'))); assert.equal(receipt.status, 'failed');
  assert.equal(f.commands.filter(c => c.args[1] === 'submit').length, 1); assert.doesNotMatch(JSON.stringify(receipt), /private@example|secret-credential/);
});
for (const [name, behavior, code] of [
  ['malformed submit JSON', {malformedSubmit: true}, 'EXTERNAL_JSON_INVALID'],
  ['invalid submit UUID', {badId: true}, 'EXTERNAL_NOTARY_ID'],
  ['mismatched status UUID', {wrongInfoId: true}, 'EXTERNAL_NOTARY_ID'],
  ['pending timeout', {status: 'In Progress'}, 'EXTERNAL_NOTARY_PENDING'],
  ['rejected submission', {status: 'Invalid'}, 'EXTERNAL_NOTARY_REJECTED'],
  ['unknown status', {status: 'Maybe'}, 'EXTERNAL_NOTARY_STATUS'],
  ['wrong log artifact', {log: {sha256: 'b'.repeat(64)}}, 'EXTERNAL_NOTARY_LOG_ARTIFACT'],
  ['contradictory accepted log', {log: {status: 'Invalid'}}, 'EXTERNAL_NOTARY_LOG_REJECTED'],
  ['accepted log with error', {log: {issues: [{severity: 'error', code: 42, message: 'private@example.test'}]}}, 'EXTERNAL_NOTARY_LOG_ISSUES'],
  ['accepted log with warning', {log: {issues: [{severity: 'warning', message: 'private@example.test'}]}}, 'EXTERNAL_NOTARY_LOG_ISSUES'],
  ['app changed while polling', {mutateInput: true}, 'EXTERNAL_INPUT_CHANGED'],
  ['stapler failure', {stapleFailure: true}, 'EXTERNAL_COMMAND_FAILED'],
  ['extra ZIP resource fork member', {extraZipMember: true}, 'EXTERNAL_ZIP_MEMBERSHIP'],
  ['final app changed after verification', {mutateFinal: true}, 'EXTERNAL_FINAL_CHANGED'],
]) test(name + ' fails closed with retained evidence', async () => {
  const f = fixture(behavior); await assert.rejects(deliverExternalPreview(f.options, f.dependencies), new RegExp(code));
  const receipt = f.readReceipt(); assert.equal(receipt.status, 'failed'); assert.equal(receipt.failure.code, code); assert.equal(receipt.readyToDistribute, false); assert.equal(receipt.readyForIndependentGatekeeperAssessment, false);
  if (receipt.submissionPerformed) assert.equal(receipt.submissionId, submissionId);
  assert.ok(f.commands.filter(c => c.args[1] === 'submit').length <= 1);
  if (!behavior.stapleFailure && !behavior.mutateFinal) assert.equal(f.commands.filter(c => c.args[0] === 'stapler').length, 0);
});
test('strict log parser requires exact accepted result, matching ZIP/job and no warnings', () => {
  const expected = {id: submissionId, submissionSha256: 'a'.repeat(64), submissionFilename: 'submission.zip'};
  const base = {jobId: submissionId, sha256: expected.submissionSha256, archiveFilename: expected.submissionFilename, status: 'Accepted', statusCode: 0, issues: []};
  assert.equal(validateNotaryLog(JSON.stringify(base), expected).status, 'Accepted');
  for (const change of [{jobId: 'b'.repeat(36)}, {archiveFilename: 'other.zip'}, {statusCode: 1}, {issues: undefined}]) assert.throws(() => validateNotaryLog(JSON.stringify({...base, ...change}), expected), /EXTERNAL_NOTARY_LOG_/);
});
