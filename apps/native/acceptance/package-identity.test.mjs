import test from 'node:test';
import assert from 'node:assert/strict';
import {assertPackageIdentity} from './package-identity.mjs';

const release = {candidate: false, sourceCommit: 'a'.repeat(40), version: '0.2.17', buildNumber: 53, sourceTag: 'native-v0.2.17'};
test('acceptance admits exact final releases and separately labelled candidates', () => {
  assertPackageIdentity(release, {sourceCommit: release.sourceCommit, buildNumber: '53'});
  assertPackageIdentity({...release, candidate: true, sourceTag: null});
  assertPackageIdentity({...release, sourceTag: 'native-v0.2.17-metadata.1'});
});
test('acceptance rejects wrong release identity or a candidate claiming a tag', () => {
  for (const change of [{candidate: true}, {sourceTag: null}, {sourceTag: 'native-v0.2.16'}, {candidate: undefined}, {sourceCommit: 'unknown'}, {buildNumber: 0}]) {
    assert.throws(() => assertPackageIdentity({...release, ...change}));
  }
  assert.throws(() => assertPackageIdentity(release, {sourceCommit: 'b'.repeat(40)}));
  assert.throws(() => assertPackageIdentity(release, {buildNumber: 52}));
});
