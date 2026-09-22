/**
 * Inert Stage 3 preparation. Validation is not isolation, permission, byte verification or a loader.
 * A future host must hash the actual admitted bytes and qualify native isolation before execution:
 * separate unprivileged view, no Node/preload/app bridge, no arbitrary filesystem/network/loopback,
 * bounded resources, explicit review, cancellation, stop/reset and readable source/static fallback.
 */
export const ARTIFACT_EXECUTION_AVAILABLE = false as const;
export type ArtifactAsset = Readonly<{path: string; sha256: string; bytes: number; role: 'entry' | 'script' | 'style' | 'data' | 'fallback'}>;
export type ArtifactProposalV1 = Readonly<{
  schemaVersion: 1; id: string; title: string; entryPath: string; fallbackPath: string;
  network: 'none'; assets: readonly ArtifactAsset[];
}>;
/** Identity must be supplied only after the future host verifies exact physical input bytes. */
export type ArtifactContentIdentity = Readonly<{
  manifestSha256: string; runtimePolicyVersion: string;
  assets: readonly Readonly<{path: string; sha256: string; bytes: number}>[];
}>;
export type ArtifactReviewDecision = Readonly<{decision: 'approved' | 'declined'; identity: ArtifactContentIdentity}>;
/** Lifecycle vocabulary only. Stage 2 has no transitions into ready/running. */
export type FutureArtifactState = 'proposed' | 'declined' | 'ready' | 'running' | 'stopped' | 'failed';
type ProposalResult = Readonly<{ok: true; value: ArtifactProposalV1}> | Readonly<{ok: false; code: 'INVALID_ARTIFACT_PROPOSAL'}>;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const bounded = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
const assetPath = (value: unknown): value is string => bounded(value, 240) && !/^[/.]/.test(value) && !/[\\:%?#]/.test(value)
  && value.split('/').every(part => Boolean(part) && part !== '.' && part !== '..' && !['.git', '.asmagicbrain'].includes(part.toLowerCase()) && !part.toLowerCase().startsWith('.asmb-'));

/** A proposal stays inert data even when valid. Unknown authority and transport fields fail closed. */
export function validateArtifactProposal(value: unknown): ProposalResult {
  const invalid = (): ProposalResult => ({ok: false, code: 'INVALID_ARTIFACT_PROPOSAL'});
  if (!record(value) || !keys(value, ['schemaVersion', 'id', 'title', 'entryPath', 'fallbackPath', 'network', 'assets'])
    || value.schemaVersion !== 1 || !bounded(value.id, 80) || !/^[a-z][a-z0-9.-]*$/.test(value.id)
    || !bounded(value.title, 120) || !assetPath(value.entryPath) || !assetPath(value.fallbackPath)
    || !/\.(?:md|txt)$/i.test(value.fallbackPath) || value.entryPath === value.fallbackPath
    || value.network !== 'none' || !Array.isArray(value.assets) || value.assets.length < 2 || value.assets.length > 64) return invalid();
  let totalBytes = 0; const assets: ArtifactAsset[] = [];
  for (const asset of value.assets) {
    if (!record(asset) || !keys(asset, ['path', 'sha256', 'bytes', 'role']) || !assetPath(asset.path) || !sha256(asset.sha256)
      || !Number.isSafeInteger(asset.bytes) || (asset.bytes as number) < 0 || (asset.bytes as number) > 2 * 1024 * 1024
      || !['entry', 'script', 'style', 'data', 'fallback'].includes(asset.role as string)) return invalid();
    totalBytes += asset.bytes as number;
    assets.push(Object.freeze({path: asset.path, sha256: asset.sha256, bytes: asset.bytes as number, role: asset.role as ArtifactAsset['role']}));
  }
  if (totalBytes > 8 * 1024 * 1024 || new Set(assets.map(asset => asset.path.toLowerCase())).size !== assets.length
    || assets.filter(asset => asset.role === 'entry').length !== 1 || assets.filter(asset => asset.role === 'fallback').length !== 1
    || !assets.some(asset => asset.path === value.entryPath && asset.role === 'entry')
    || !assets.some(asset => asset.path === value.fallbackPath && asset.role === 'fallback')) return invalid();
  return {ok: true, value: Object.freeze({schemaVersion: 1, id: value.id, title: value.title, entryPath: value.entryPath,
    fallbackPath: value.fallbackPath, network: 'none', assets: Object.freeze(assets)})};
}

function validIdentity(value: ArtifactContentIdentity): boolean {
  return record(value) && keys(value, ['manifestSha256', 'runtimePolicyVersion', 'assets']) && sha256(value.manifestSha256)
    && bounded(value.runtimePolicyVersion, 80) && Array.isArray(value.assets) && value.assets.length >= 2 && value.assets.length <= 64
    && value.assets.every(asset => record(asset) && keys(asset, ['path', 'sha256', 'bytes']) && assetPath(asset.path) && sha256(asset.sha256)
      && Number.isSafeInteger(asset.bytes) && (asset.bytes as number) >= 0 && (asset.bytes as number) <= 2 * 1024 * 1024)
    && new Set(value.assets.map(asset => asset.path.toLowerCase())).size === value.assets.length;
}

/** Equality can invalidate a prior decision; it cannot authorize execution in this implementation. */
export function isArtifactDecisionCurrent(decision: ArtifactReviewDecision, candidate: ArtifactContentIdentity): boolean {
  if (!record(decision) || !keys(decision, ['decision', 'identity']) || !['approved', 'declined'].includes(decision.decision)
    || !validIdentity(decision.identity) || !validIdentity(candidate)) return false;
  const previous = decision.identity;
  if (previous.manifestSha256 !== candidate.manifestSha256 || previous.runtimePolicyVersion !== candidate.runtimePolicyVersion
    || previous.assets.length !== candidate.assets.length) return false;
  return previous.assets.every(asset => candidate.assets.some(next => next.path === asset.path && next.sha256 === asset.sha256 && next.bytes === asset.bytes));
}
