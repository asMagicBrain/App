import {getNativeBridge, nativeOperation} from './native-bridge.mjs';
import type {RepositoryApplyProgress, RepositoryUpdateApplied, RepositoryUpdateApplyInput, RepositoryUpdateComparison, RepositoryUpdateFile, RepositoryUpdateProgress, RepositoryUpdateReview, RepositoryUpdates} from './native-types';

const relations = new Set(['up-to-date', 'remote-ahead', 'local-ahead', 'diverged', 'unrelated', 'remote-branch-missing', 'local-empty']);
const statuses = new Set(['added', 'modified', 'deleted', 'type-changed']);
const phases = new Set(['connecting', 'receiving', 'comparing', 'complete', 'cancelled', 'failed']);
const oid = (value: unknown) => value === null || typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value);
const count = (value: unknown) => value === null || Number.isSafeInteger(value) && Number(value) >= 0;
const invalid = () => {throw Object.assign(new Error('The GitHub update response could not be verified. Close this dialog and try again.'), {code: 'UPDATES_RESPONSE_INVALID'});};
const bridge = () => {const value = getNativeBridge(); if (!value?.getRepositoryUpdates) throw new Error('GitHub update checks require the current native application.'); return value;};

function comparison(value: RepositoryUpdateComparison): RepositoryUpdateComparison {
  if (!value || typeof value.checkId !== 'string' || !value.checkId || typeof value.sourceUrl !== 'string' ||
      typeof value.branch !== 'string' || !Number.isFinite(value.checkedAt) || !oid(value.localHead) || !oid(value.remoteHead) ||
      !relations.has(value.relation) || !count(value.ahead) || !count(value.behind) || typeof value.stale !== 'boolean' ||
      !Array.isArray(value.files) || !value.files.every(file => typeof file?.path === 'string' && statuses.has(file.status)) ||
      !Number.isSafeInteger(value.totalFiles) || value.totalFiles < value.files.length || typeof value.truncated !== 'boolean') invalid();
  return value;
}

export async function getRepositoryUpdates(repo: string): Promise<RepositoryUpdates> {
  const value = await nativeOperation(() => bridge().getRepositoryUpdates({repo}));
  if (!value || typeof value.eligible !== 'boolean' || value.reason !== undefined && typeof value.reason !== 'string' ||
      value.sourceUrl !== undefined && typeof value.sourceUrl !== 'string' || value.branch !== undefined && typeof value.branch !== 'string') invalid();
  if (value.lastCheck) comparison(value.lastCheck);
  return value;
}

export async function checkRepositoryUpdates({repo, requestId, useAccount}: {repo: string; requestId: string; useAccount: boolean}): Promise<RepositoryUpdateComparison> {
  return comparison(await nativeOperation(() => bridge().checkRepositoryUpdates({repo, requestId, useAccount})));
}

export async function getRepositoryUpdateProgress(requestId: string): Promise<RepositoryUpdateProgress | null> {
  const value = await nativeOperation(() => bridge().getRepositoryUpdateProgress({requestId}));
  if (value !== null && (!value || !phases.has(value.phase))) invalid();
  return value;
}

export async function cancelRepositoryUpdate(requestId: string): Promise<void> {
  await nativeOperation(() => bridge().cancelRepositoryUpdate({requestId}));
}

export async function readRepositoryUpdateFile({repo, checkId, path}: {repo: string; checkId: string; path: string}): Promise<RepositoryUpdateFile> {
  const value = await nativeOperation(() => bridge().readRepositoryUpdateFile({repo, checkId, path}));
  if (!value || value.checkId !== checkId || value.path !== path || !statuses.has(value.status) || typeof value.binary !== 'boolean' ||
      typeof value.unsupported !== 'boolean' || typeof value.previewOmitted !== 'boolean' || !count(value.beforeSize) || !count(value.afterSize) ||
      ![value.before, value.after, value.beforeMode, value.afterMode].every(item => item === null || typeof item === 'string')) invalid();
  return value;
}

export async function reviewRepositoryUpdate({repo, checkId}: {repo: string; checkId: string}): Promise<RepositoryUpdateReview> {
  const native = bridge();
  if (!native.reviewRepositoryUpdate) throw Object.assign(new Error('Applying updates requires the current native application.'), {code: 'APPLY_UNAVAILABLE'});
  const value = await nativeOperation(() => native.reviewRepositoryUpdate({repo, checkId}));
  if (!value || value.checkId !== checkId || typeof value.canApply !== 'boolean' ||
      !(value.reviewId === null || typeof value.reviewId === 'string' && value.reviewId.length > 0) ||
      value.reason !== undefined && typeof value.reason !== 'string' || !oid(value.localHead) || !oid(value.remoteHead) ||
      typeof value.branch !== 'string' || !value.branch || !Number.isSafeInteger(value.totalFiles) || value.totalFiles < 0 || !count(value.behind) ||
      !(value.expiresAt === null || Number.isFinite(value.expiresAt) && value.expiresAt > 0) ||
      !Number.isSafeInteger(value.dirtyFileCount) || value.dirtyFileCount < 0 || !Number.isSafeInteger(value.draftCount) || value.draftCount < 0 ||
      value.canApply && (!value.reviewId || !value.localHead || !value.remoteHead || value.localHead === value.remoteHead || !value.expiresAt || value.behind === null || value.behind < 1 || value.dirtyFileCount > 0 || value.draftCount > 0)) invalid();
  return value;
}

export async function applyRepositoryUpdate({repo, checkId, reviewId, requestId}: RepositoryUpdateApplyInput, reviewed: RepositoryUpdateReview): Promise<RepositoryUpdateApplied> {
  const native = bridge();
  if (!native.applyRepositoryUpdate) throw Object.assign(new Error('Applying updates requires the current native application.'), {code: 'APPLY_UNAVAILABLE'});
  if (!reviewed.canApply || reviewed.checkId !== checkId || reviewed.reviewId !== reviewId || !reviewed.localHead || !reviewed.remoteHead) invalid();
  const value = await nativeOperation(() => native.applyRepositoryUpdate({repo, checkId, reviewId, requestId}));
  if (!value || value.status !== 'applied' || value.requestId !== requestId || value.checkId !== checkId ||
      value.previousHead !== reviewed.localHead || value.head !== reviewed.remoteHead || value.branch !== reviewed.branch) invalid();
  return value;
}

export async function getRepositoryApplyProgress(requestId: string): Promise<RepositoryApplyProgress | null> {
  const native = bridge();
  if (!native.getRepositoryApplyProgress) return null;
  const value = await nativeOperation(() => native.getRepositoryApplyProgress({requestId}));
  if (value !== null && (!value || value.requestId !== requestId || !['preparing', 'applying', 'complete', 'failed'].includes(value.phase))) invalid();
  return value;
}

export function repositoryApplyUnavailable(reason?: string): string {
  const reasons: Record<string, string> = {
    'saved-changes': 'Saved local changes must be resolved before this update can be applied.',
    drafts: 'Retained drafts must be resolved before this update can be applied.',
    'not-fast-forward': 'This update cannot be applied without combining different histories. Only a direct update to incoming commits is available.',
    stale: 'The local branch or comparison changed. Check for updates again.',
    partial: 'This comparison is incomplete. Applying a partial review is unavailable.',
    unsupported: 'This update contains files that cannot be applied by this version.',
    'recovery-required': 'A previous local operation needs recovery before another update can be applied.',
  };
  return reason && reasons[reason] || 'This update cannot be applied. Review the repository state and try again.';
}

export function repositoryUpdateError(reason: unknown): string {
  const code = reason && typeof reason === 'object' && 'code' in reason ? String(reason.code) : '';
  const messages: Record<string, string> = {
    APPLY_UNAVAILABLE: 'Applying updates requires the current native application.',
    APPLY_BUSY: 'A repository update is already running. Wait for it to finish.',
    APPLY_NOT_FOUND: 'This update is no longer available. Review it again.',
    APPLY_STALE: 'The repository changed after review. Check for updates and review again.',
    APPLY_REVIEW_EXPIRED: 'This review has expired. Review the update again.',
    APPLY_DIRTY: 'Saved local changes or retained drafts prevent this update. Resolve them before reviewing again.',
    APPLY_SAVED_CHANGES: 'Saved local changes prevent this update. Resolve them before reviewing again.',
    APPLY_DRAFTS: 'Retained drafts prevent this update. Resolve them before reviewing again.',
    APPLY_NOT_FAST_FORWARD: 'The local and incoming histories can no longer be updated directly. Check for updates again.',
    APPLY_PARTIAL: 'This comparison is incomplete. Applying a partial review is unavailable.',
    APPLY_UNSUPPORTED: 'This update contains files or repository features that cannot be applied by this version.',
    APPLY_LIMIT_EXCEEDED: 'This update exceeds the current supported size or file count.',
    APPLY_REQUEST_REUSED: 'This update request is no longer valid. Review the update again.',
    APPLY_TIMEOUT: 'Applying the update took too long. Review the repository state before trying again.',
    APPLY_GIT_FAILED: 'The local Git update could not complete. Review the repository state before trying again.',
    APPLY_FAILED: 'The update could not be applied. Review the repository state before trying again.',
    APPLY_RECOVERY_REQUIRED: 'Close and reopen asMagicBrain to recover this interrupted update. Unrecognized file changes remain preserved.',
    UPDATE_CANCELLED: 'Update check cancelled.',
    UPDATE_BUSY: 'An update check is already running. Wait for it to finish.',
    UPDATE_NOT_FOUND: 'This update check is no longer available. Check for updates again.',
    UPDATES_CANCELLED: 'Update check cancelled.',
    UPDATES_AUTH_REQUIRED: 'GitHub access is required, or the repository is unavailable. Check your connection and repository access.',
    UPDATES_TIMEOUT: 'The update check took too long. Check your connection and try again.',
    UPDATES_FAILED: 'The update check could not complete. Check your connection and try again.',
    UPDATES_BUSY: 'An update check is already running. Wait for it to finish.',
    UPDATES_STALE: 'This comparison is no longer current. Check for updates again.',
    COMPARISON_EXPIRED: 'This comparison has expired. Check for updates again.',
    UPDATES_LIMIT_EXCEEDED: 'These updates exceed the current download or comparison limit.',
    UPDATES_UNAVAILABLE: 'This repository is not available for GitHub update checks.',
    RECOVERY_REQUIRED: 'A local operation needs recovery. Close and reopen asMagicBrain; unrecognized file changes remain preserved.',
    INVALID_REQUEST: 'The update request is invalid. Close this dialog and try again.',
    GIT_UNAVAILABLE: 'Git is unavailable on this computer. Install Git, then reopen asMagicBrain.',
    GITHUB_BUSY: 'The GitHub connection is busy. Wait for it to finish, then try again.',
    INVALID_CREDENTIAL: 'The GitHub connection could not be used. Disconnect and connect your account again.',
    ENOSPC: 'There is not enough free space to download updates. Free up space and try again.',
    EACCES: 'asMagicBrain cannot access the repository. Check its folder permissions.',
    EPERM: 'asMagicBrain cannot access the repository. Check its folder permissions.',
  };
  return messages[code] ?? (reason instanceof Error ? reason.message : 'The update check could not complete.');
}

export function repositoryUpdatesUnavailable(reason?: string): string {
  const reasons: Record<string, string> = {
    'local-only': 'GitHub update checks are available for repositories cloned from GitHub.',
    'branch-changed': 'The working branch has changed since this repository was cloned. Update checks for this branch are unavailable.',
    'recovery-required': 'Recover the local repository operation before checking for updates.',
  };
  return reason && reasons[reason] || 'GitHub update checks are unavailable for this repository.';
}

export function repositoryUpdateSummary(value: RepositoryUpdateComparison): string {
  switch (value.relation) {
    case 'up-to-date': return 'No new commits. Local and GitHub history match.';
    case 'remote-ahead': return `${value.behind} incoming commit${value.behind === 1 ? '' : 's'} on GitHub.`;
    case 'local-ahead': return `${value.ahead} local commit${value.ahead === 1 ? '' : 's'} ahead of GitHub.`;
    case 'diverged': return `History has diverged: ${value.behind} incoming and ${value.ahead} local commits.`;
    case 'unrelated': return 'Local and GitHub histories have no common ancestor.';
    case 'remote-branch-missing': return 'The corresponding branch was not found on GitHub.';
    case 'local-empty': return 'The local branch has no commits yet.';
  }
}
