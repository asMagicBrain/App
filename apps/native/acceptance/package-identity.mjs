import assert from 'node:assert/strict';
import {releaseTagMatchesVersion} from '../release-identity.mjs';

/** Admit both internal candidates and immutable releases without relabelling
 * either. The native driver separately records the actual bundle inventory. */
export function assertPackageIdentity(metadata, expected = {}) {
  assert.equal(typeof metadata?.candidate, 'boolean', 'Package must declare candidate/release status');
  assert.match(metadata.sourceCommit, /^[a-f0-9]{40}$/, 'Package must identify its exact source');
  assert.ok(Number.isSafeInteger(metadata.buildNumber) && metadata.buildNumber > 0, 'Package must identify its build');
  if (metadata.candidate) assert.equal(metadata.sourceTag, null, 'Candidates must not claim a final tag');
  else assert.ok(releaseTagMatchesVersion(metadata.sourceTag, metadata.version), 'Release tag must match the packaged version');
  if (expected.sourceCommit !== undefined) assert.equal(metadata.sourceCommit, expected.sourceCommit);
  if (expected.buildNumber !== undefined) assert.equal(metadata.buildNumber, Number(expected.buildNumber));
}
