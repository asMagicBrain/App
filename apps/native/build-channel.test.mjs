import test from 'node:test';
import assert from 'node:assert/strict';
import {buildConfiguration, resolveBuildConfiguration, packageOptions, packageIdentity, packageOutputName} from './build-channel.mjs';

test('development keeps the full presentation contract and preview is implemented-only', () => {
  assert.deepEqual(resolveBuildConfiguration(), {channel: 'development', presentation: 'full-with-grey', canToggleUnavailable: true, validationOnly: false});
  assert.deepEqual(resolveBuildConfiguration({args: ['electron', '--channel=preview']}), {channel: 'preview', presentation: 'implemented-only', canToggleUnavailable: false, validationOnly: false});
  assert.equal(Object.isFrozen(buildConfiguration('preview')), true);
  for (const value of ['', 'production', 'Preview', null, {}, '__proto__', 'constructor']) assert.throws(() => buildConfiguration(value), /Unknown/);
  for (const args of [['--channel'], ['--channel='], ['--channel=preview', '--channel=preview'], ['--channel=preview', '--channel=development']]) assert.throws(() => resolveBuildConfiguration({args}));
});

test('packaged channel requires generated metadata and cannot be overridden at launch', () => {
  for (const channel of ['development', 'preview']) assert.equal(resolveBuildConfiguration({packaged: true, metadata: {schemaVersion: 1, channel}}).channel, channel);
  for (const metadata of [null, {}, {schemaVersion: 1}, {schemaVersion: 2, channel: 'preview'}, {schemaVersion: 1, channel: 'release'}]) {
    assert.throws(() => resolveBuildConfiguration({packaged: true, metadata}));
  }
  assert.throws(() => resolveBuildConfiguration({packaged: true, metadata: {schemaVersion: 1, channel: 'preview'}, args: ['--channel=development']}), /cannot override/);
});

test('packaging defaults to development and preview receives a separate final release', () => {
  assert.equal(packageOptions([]).candidate, false);
  assert.equal(packageOptions([]).configuration.channel, 'development');
  assert.deepEqual(packageOptions(['--channel=preview', '--candidate']), {candidate: true, configuration: buildConfiguration('preview')});
  assert.equal(packageOptions(['--channel=preview']).candidate, false);
  for (const args of [['--release'], ['--candidate', '--candidate'], ['--channel=unknown', '--candidate'], ['--channel=preview', '--channel=development', '--candidate']]) assert.throws(() => packageOptions(args));
});

test('variant identities and candidate paths are distinct without changing development release output', () => {
  const development = packageIdentity({channel: 'development', bundleId: 'org.asmagicbrain.preview'});
  const preview = packageIdentity({channel: 'preview', bundleId: 'org.asmagicbrain.preview'});
  assert.deepEqual(development, {bundleId: 'org.asmagicbrain.preview', productName: 'asMagicBrain', packageName: 'asmagicbrain'});
  assert.deepEqual(preview, {bundleId: 'org.asmagicbrain.app.preview', productName: 'asMagicBrain Preview', packageName: 'asmagicbrain-preview'});
  assert.notEqual(development.bundleId, preview.bundleId);
  const common = {version: '0.2.6', candidate: true, id: 'same-unique-id'};
  assert.notEqual(packageOutputName({...common, channel: 'development'}), packageOutputName({...common, channel: 'preview'}));
  assert.equal(packageOutputName({...common, channel: 'development', candidate: false}), '0.2.6');
  assert.equal(packageOutputName({...common, channel: 'preview', candidate: false}), '0.2.6-preview');
});
