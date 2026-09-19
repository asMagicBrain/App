/** Source identity only; metadata reissues do not select application behavior.
 * Keep this module dependency-free so source export needs only Node and Git. */
const versionPattern = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)?$/;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const matchesExactly = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;

export function validateRelease(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 ||
      !matchesExactly(versionPattern, value.version) || !positiveInteger(value.buildNumber) ||
      !matchesExactly(/^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+$/, value.bundleId) ||
      (Object.hasOwn(value, 'metadataRevision') && !positiveInteger(value.metadataRevision))) {
    throw Error('Invalid native release.json.');
  }
  return {schemaVersion: 1, version: value.version, buildNumber: value.buildNumber, bundleId: value.bundleId,
    ...(Object.hasOwn(value, 'metadataRevision') ? {metadataRevision: value.metadataRevision} : {})};
}

/** A reissue gets a new immutable tag; the original version tag is unchanged. */
export function releaseSourceTag(value) {
  const release = validateRelease(value);
  return `native-v${release.version}${release.metadataRevision === undefined ? '' : `-metadata.${release.metadataRevision}`}`;
}

/** Shape admission for manifests without the full tagged release declaration.
 * Source-aware callers must also compare releaseSourceTag(taggedRelease). */
export function releaseTagMatchesVersion(sourceTag, version) {
  if (typeof sourceTag !== 'string' || !matchesExactly(versionPattern, version)) return false;
  const base = `native-v${version}`;
  if (sourceTag === base) return true;
  const prefix = `${base}-metadata.`;
  if (!sourceTag.startsWith(prefix)) return false;
  const revision = sourceTag.slice(prefix.length);
  return matchesExactly(/^[1-9]\d*$/, revision) && positiveInteger(Number(revision));
}
