import React, {useCallback, useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import {getNativeBridge, isNativeClosing, nativeOperation} from './native-bridge.mjs';
import {invalidateGitHubConnection, useGitHubConnection} from './GitHubConnection';
import {applyRepositoryUpdate, cancelRepositoryUpdate, checkRepositoryUpdates, getRepositoryApplyProgress, getRepositoryUpdateProgress, getRepositoryUpdates, readRepositoryUpdateFile, repositoryApplyUnavailable, repositoryUpdateError, repositoryUpdateSummary, repositoryUpdatesUnavailable, reviewRepositoryUpdate} from './repository-updates';
import type {RepositoryApplyProgress, RepositoryUpdateApplied, RepositoryUpdateComparison, RepositoryUpdateFile, RepositoryUpdatePath, RepositoryUpdateProgress, RepositoryUpdateReview, RepositoryUpdates} from './native-types';
import './ZipImportDialog.css';
import './repository-updates.css';

export function useRepositoryUpdatesAvailability(repository: string, enabled: boolean) {
  const [status, setStatus] = useState<RepositoryUpdates | null>(null);
  useEffect(() => {
    setStatus(null);
    if (!enabled || !getNativeBridge()?.getRepositoryUpdates) return;
    let active = true;
    const refresh = () => {
      if (isNativeClosing()) return;
      void getRepositoryUpdates(repository).then(value => {if (active) setStatus(value);}).catch(() => {if (active) setStatus(null);});
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {active = false; window.removeEventListener('focus', refresh);};
  }, [repository, enabled]);
  return status;
}

const phaseLabels: Record<RepositoryUpdateProgress['phase'], string> = {
  connecting: 'Connecting to GitHub…', receiving: 'Downloading GitHub history…', comparing: 'Comparing committed files…',
  complete: 'Update check complete.', cancelled: 'Update check cancelled.', failed: 'Update check could not complete.',
};
const applyPhaseLabels: Record<RepositoryApplyProgress['phase'], string> = {
  preparing: 'Preparing the reviewed update…', applying: 'Applying the reviewed update…',
  complete: 'Update applied. Refreshing repository…', failed: 'The update could not complete.',
};
const shortHead = (value: string | null) => value?.slice(0, 7) ?? 'No commits';

function UpdateFile({repository, comparison, file, onStale}: {repository: string; comparison: RepositoryUpdateComparison; file: RepositoryUpdatePath; onStale(): void}) {
  const [value, setValue] = useState<RepositoryUpdateFile | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const pending = useRef(false), active = useRef(true);
  useEffect(() => {active.current = true; return () => {active.current = false;};}, []);
  const load = async () => {
    if (pending.current || value || isNativeClosing()) return;
    pending.current = true; setLoading(true); setError('');
    try {const next = await readRepositoryUpdateFile({repo: repository, checkId: comparison.checkId, path: file.path}); if (active.current) setValue(next);}
    catch (reason) {if (active.current) {setError(repositoryUpdateError(reason)); if (reason && typeof reason === 'object' && 'code' in reason && ['UPDATES_STALE', 'COMPARISON_EXPIRED'].includes(String(reason.code))) onStale();}}
    finally {pending.current = false; if (active.current) setLoading(false);}
  };
  return <details className="ru-file" onToggle={event => {if (event.currentTarget.open) void load();}}>
    <summary><span>{file.path}</span><small>{file.status.replace('-', ' ')}</small></summary>
    {loading && <p role="status">Loading comparison…</p>}
    {error && <div className="ru-file-error"><p role="alert">{error}</p><button type="button" disabled={comparison.stale} onClick={() => void load()}>Retry preview</button></div>}
    {value && <>
      {value.beforeMode !== value.afterMode && <p className="ru-file-note">File mode: {value.beforeMode ?? 'absent'} → {value.afterMode ?? 'absent'}</p>}
      {value.unsupported ? <p className="ru-file-note">This file type cannot be previewed.</p> : value.previewOmitted ? <p className="ru-file-note">Text preview is unavailable for this large file ({value.beforeSize ?? 0} → {value.afterSize ?? 0} bytes).</p> : value.binary ? <p className="ru-file-note">Binary file changed ({value.beforeSize ?? 0} → {value.afterSize ?? 0} bytes).</p> :
        <div className="ru-diff"><div><h4>Local · {shortHead(comparison.localHead)}</h4><pre>{value.before ?? 'File does not exist'}</pre></div><div><h4>GitHub · {shortHead(comparison.remoteHead)}</h4><pre>{value.after ?? 'File does not exist'}</pre></div></div>}
    </>}
  </details>;
}

type Props = {
  repository: string; returnFocus?: HTMLElement | null; onClose(): void;
  beforeReview?(): Promise<void>; beforeApply?(): Promise<void>;
  onApplyingChange?(applying: boolean): void; onApplied?(result: RepositoryUpdateApplied): Promise<void>;
  onApplyError?(reason: unknown): void;
};
export function RepositoryUpdatesDialog({repository, returnFocus, onClose, beforeReview, beforeApply, onApplyingChange, onApplied, onApplyError}: Props) {
  const id = useId(), dialog = useRef<HTMLDialogElement>(null), checkButton = useRef<HTMLButtonElement>(null);
  const active = useRef(true), request = useRef<string | null>(null), submitting = useRef(false), cancelling = useRef(false);
  const operationRef = useRef<'check' | 'review' | 'apply' | null>(null), reviewPanel = useRef<HTMLElement>(null);
  const [info, setInfo] = useState<RepositoryUpdates | null>(null), [loading, setLoading] = useState(true), [operation, setOperation] = useState<'check' | 'review' | 'apply' | null>(null);
  const [error, setError] = useState(''), [progress, setProgress] = useState(''), [cancelRequested, setCancelRequested] = useState(false);
  const [comparison, setComparison] = useState<RepositoryUpdateComparison | null>(null), [showFiles, setShowFiles] = useState(false), [useAccount, setUseAccount] = useState(false);
  const [review, setReview] = useState<RepositoryUpdateReview | null>(null), [reviewExpired, setReviewExpired] = useState(false), [applied, setApplied] = useState(false);
  const busy = operation !== null;
  const {connection} = useGitHubConnection();
  const account = connection?.state === 'connected' ? connection.account : undefined;

  useLayoutEffect(() => {
    const element = dialog.current!, previousFocus = returnFocus ?? document.activeElement;
    element.showModal(); checkButton.current?.focus();
    return () => {element.close(); if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();};
  }, [returnFocus]);
  useEffect(() => {
    active.current = true;
    return () => {active.current = false; if (operationRef.current === 'check' && request.current && !isNativeClosing()) void cancelRepositoryUpdate(request.current).catch(() => {});};
  }, []);
  const inspect = useCallback(async () => {
    if (isNativeClosing()) return;
    setLoading(true); setError('');
    try {const value = await getRepositoryUpdates(repository); if (active.current) {setInfo(value); setComparison(value.lastCheck ?? null);}}
    catch (reason) {if (active.current) setError(repositoryUpdateError(reason));}
    finally {if (active.current) setLoading(false);}
  }, [repository]);
  useEffect(() => {void inspect();}, [inspect]);
  useEffect(() => {
    if (operation !== 'check' && operation !== 'apply' || !request.current) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const requestId = request.current;
    const poll = async () => {
      if (stopped) return;
      if (!isNativeClosing()) {
        try {
          if (operation === 'apply') {const value = await getRepositoryApplyProgress(requestId); if (!stopped && value) setProgress(applyPhaseLabels[value.phase]);}
          else {const value = await getRepositoryUpdateProgress(requestId); if (!stopped && !cancelling.current && value) setProgress(phaseLabels[value.phase]);}
        }
        catch { /* The check result settles errors; progress never unlocks it. */ }
      }
      if (!stopped) timer = setTimeout(() => void poll(), 700);
    };
    void poll();
    return () => {stopped = true; clearTimeout(timer);};
  }, [operation]);
  useEffect(() => {
    setReviewExpired(false);
    if (!review?.expiresAt) return;
    const timer = setTimeout(() => setReviewExpired(true), Math.max(0, review.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [review]);
  useEffect(() => {if (review && !busy) reviewPanel.current?.focus();}, [review, busy]);

  const check = async () => {
    if (submitting.current || !info?.eligible || isNativeClosing()) return;
    request.current = crypto.randomUUID(); submitting.current = true; cancelling.current = false;
    operationRef.current = 'check'; setOperation('check'); setReview(null); setError(''); setProgress(phaseLabels.connecting); setCancelRequested(false); setShowFiles(false);
    try {
      const result = await checkRepositoryUpdates({repo: repository, requestId: request.current, useAccount: Boolean(account && useAccount)});
      if (active.current) {setComparison(result); setProgress('Update check complete.');}
    } catch (reason) {
      if (active.current) {
        if (reason && typeof reason === 'object' && 'code' in reason && ['UPDATES_STALE', 'COMPARISON_EXPIRED'].includes(String(reason.code))) setComparison(value => value && {...value, stale: true});
        if (reason && typeof reason === 'object' && 'code' in reason && ['UPDATES_CANCELLED', 'UPDATE_CANCELLED'].includes(String(reason.code))) setProgress('Update check cancelled.');
        else {setProgress(''); setError(repositoryUpdateError(reason));}
      }
    } finally {
      submitting.current = false; cancelling.current = false; request.current = null;
      operationRef.current = null;
      invalidateGitHubConnection();
      if (active.current) {setOperation(null); setCancelRequested(false);}
    }
  };
  const cancel = async () => {
    if (!request.current || cancelling.current) return;
    cancelling.current = true; setCancelRequested(true); setProgress('Cancelling update check…');
    try {await cancelRepositoryUpdate(request.current);}
    catch (reason) {if (active.current) {setError(repositoryUpdateError(reason)); cancelling.current = false; setCancelRequested(false);}}
    // Only the original request settles the operation; completed publication wins a late cancellation.
  };
  const markStale = () => {setReview(null); setComparison(value => value && {...value, stale: true});};
  const canCompare = comparison && !comparison.stale && comparison.files.length > 0;
  const applyAvailable = Boolean(getNativeBridge()?.reviewRepositoryUpdate && getNativeBridge()?.applyRepositoryUpdate && beforeReview && beforeApply && onApplyingChange && onApplied);
  const canReview = Boolean(applyAvailable && !applied && info?.eligible && comparison && !comparison.stale && comparison.relation === 'remote-ahead');
  const prepareReview = async () => {
    if (submitting.current || !canReview || !comparison || !beforeReview || isNativeClosing()) return;
    const captured = comparison;
    submitting.current = true; operationRef.current = 'review'; setOperation('review'); setReview(null); setError(''); setProgress('Checking local files and retained drafts…');
    try {
      const result = await nativeOperation(async () => {await beforeReview(); return reviewRepositoryUpdate({repo: repository, checkId: captured.checkId});});
      if (result.localHead !== captured.localHead || result.remoteHead !== captured.remoteHead || result.branch !== captured.branch) throw Object.assign(new Error('This comparison is no longer current. Check for updates again.'), {code: 'UPDATES_STALE'});
      if (active.current) {setReview(result); setProgress('');}
    } catch (reason) {
      if (active.current) {setError(repositoryUpdateError(reason)); setProgress(''); if (reason && typeof reason === 'object' && 'code' in reason && ['UPDATES_STALE', 'COMPARISON_EXPIRED'].includes(String(reason.code))) markStale();}
    } finally {
      submitting.current = false; operationRef.current = null; if (active.current) setOperation(null);
    }
  };
  const apply = async () => {
    if (submitting.current || !canReview || !review?.canApply || !review.reviewId || !review.expiresAt || review.expiresAt <= Date.now() || !beforeApply || !onApplied || !onApplyingChange || isNativeClosing()) return;
    const reviewed = review, requestId = crypto.randomUUID(); let completed = false, hostAttempted = false;
    submitting.current = true; operationRef.current = 'apply'; request.current = requestId; setOperation('apply'); setError(''); setProgress(applyPhaseLabels.preparing); onApplyingChange(true);
    // Close waits for the whole admitted renderer scope, including error
    // handling and the synchronous editor unlock after the fresh source loads.
    await nativeOperation(async () => {
     try {
        await beforeApply();
        hostAttempted = true;
        const result = await applyRepositoryUpdate({repo: repository, checkId: reviewed.checkId, reviewId: reviewed.reviewId!, requestId}, reviewed);
        completed = true; if (active.current) {setApplied(true); setProgress(applyPhaseLabels.complete);}
        await onApplied(result);
      if (active.current) onClose();
    } catch (reason) {
      if (!completed && hostAttempted) onApplyError?.(reason);
      if (active.current) {
        setReview(null); setProgress('');
        setError(completed ? 'The update was applied, but the document could not refresh. Close and reopen this repository.' : repositoryUpdateError(reason));
        if (!completed && !isNativeClosing()) {
          try {const current = await getRepositoryUpdates(repository); if (active.current) {setInfo(current); setComparison(current.lastCheck ?? null);}} catch { /* Preserve the original apply error. */ }
        }
      }
    } finally {
      submitting.current = false; operationRef.current = null; request.current = null; onApplyingChange(false);
      if (active.current) setOperation(null);
     }
    });
  };

  return <dialog ref={dialog} className="zi-dialog ru-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={event => {event.preventDefault(); if (!submitting.current) onClose();}} onKeyDown={event => event.stopPropagation()}>
    <header><h2 id={`${id}-title`}>GitHub updates</h2><button type="button" className="zi-close" aria-label="Close GitHub updates" disabled={busy} onClick={onClose}>×</button></header>
    <p id={`${id}-description`}>Check for new GitHub commits and compare them with your local committed files.</p>
    <dl className="ru-source"><div><dt>Repository</dt><dd>{repository}</dd></div><div><dt>GitHub</dt><dd>{info?.sourceUrl ?? '—'}</dd></div><div><dt>Working branch</dt><dd>{info?.branch ?? '—'}</dd></div></dl>
    {loading && <p role="status">Reading repository connection…</p>}
    {!loading && info && !info.eligible && <p className="zi-help">{repositoryUpdatesUnavailable(info.reason)}</p>}
    <div className="ru-access">{account && <label className="gc-account"><input type="checkbox" checked={useAccount} disabled={busy} onChange={event => setUseAccount(event.target.checked)}/><span>Use GitHub account <strong>{account.username}</strong> for private repository access</span></label>}
    <p className="zi-help ru-description">Checking downloads repository history. Your saved files and retained drafts stay unchanged.</p></div>
    {error && <p role="alert" className="zi-error">{error}</p>}
    {!loading && !info && <button type="button" disabled={busy} onClick={() => void inspect()}>Retry connection details</button>}
    {comparison && <section className="ru-result" aria-label="Committed history comparison">
      <h3>{repositoryUpdateSummary(comparison)}</h3>
      <p className="zi-help">Last checked {new Date(comparison.checkedAt).toLocaleString()} · Local {shortHead(comparison.localHead)} · GitHub {shortHead(comparison.remoteHead)}</p>
      {comparison.stale && <p className="ru-stale" role="status">This is a previous comparison. Check again before viewing or applying changes.</p>}
      {!comparison.stale && comparison.files.length === 0 && comparison.relation !== 'remote-branch-missing' && <p className="zi-help">No committed file differences.</p>}
      {comparison.truncated && <p className="ru-stale">Showing {comparison.files.length} of {comparison.totalFiles} changed paths. This is a partial comparison.</p>}
      <div className="ru-result-actions">{canCompare && <button type="button" disabled={busy} aria-expanded={showFiles} onClick={() => setShowFiles(value => !value)}>{showFiles ? 'Hide changes' : `View changes (${comparison.files.length})`}</button>}
      {canReview && !review && <button type="button" disabled={busy} onClick={() => void prepareReview()}>{operation === 'review' ? 'Reviewing…' : 'Review update…'}</button>}</div>
      {review && <section ref={reviewPanel} tabIndex={-1} className="ru-apply-review" aria-labelledby={`${id}-review-title`}>
        <h3 id={`${id}-review-title`}>Review update</h3>
        <p>Update local <strong>{review.branch}</strong> from <code>{shortHead(review.localHead)}</code> to <code>{shortHead(review.remoteHead)}</code>.</p>
        <p className="zi-help">{review.behind ?? comparison.behind} incoming commit{(review.behind ?? comparison.behind) === 1 ? '' : 's'} · {review.totalFiles} changed path{review.totalFiles === 1 ? '' : 's'}. Applying updates the saved files and local branch to these reviewed commits.</p>
        {review.canApply ? <p className="ru-ready">Local files are unchanged and there are no retained drafts.</p> : <div className="ru-apply-blocked" role="status"><p>{repositoryApplyUnavailable(review.reason)}</p>
          {(review.dirtyFileCount > 0 || review.draftCount > 0) && <p className="zi-help">{review.dirtyFileCount} changed saved path{review.dirtyFileCount === 1 ? '' : 's'} · {review.draftCount} retained draft{review.draftCount === 1 ? '' : 's'}. Your work stays unchanged.</p>}</div>}
        {reviewExpired && <p className="ru-stale" role="status">This review has expired. Review again before applying the update.</p>}
        {(!review.canApply || reviewExpired) && <button type="button" disabled={busy} onClick={() => void prepareReview()}>Review again</button>}
      </section>}
      {showFiles && canCompare && <section className="ru-files" aria-label="Read-only file changes"><p className="zi-help">Local committed content and fetched GitHub content. Saved edits and retained drafts are excluded.</p>{comparison.files.map(file => <UpdateFile key={`${comparison.checkId}:${file.path}`} repository={repository} comparison={comparison} file={file} onStale={markStale}/>)}</section>}
    </section>}
    <p className="zi-progress" role="status" aria-live="polite">{progress}</p>
    <footer>{review ? <><button type="button" disabled={busy} onClick={() => {setReview(null); setError(''); setProgress(''); checkButton.current?.focus();}}>Back</button><button type="button" className="zi-primary" disabled={busy || !review.canApply || reviewExpired || !canReview} onClick={() => void apply()}>{operation === 'apply' ? 'Applying…' : 'Apply update'}</button></> : <>{operation === 'check' ? <button type="button" disabled={cancelRequested} onClick={() => void cancel()}>{cancelRequested ? 'Cancelling…' : 'Cancel check'}</button> : <button type="button" disabled={busy} onClick={onClose}>Close</button>}<button ref={checkButton} type="button" className="zi-primary" disabled={loading || busy || applied || !info?.eligible} onClick={() => void check()}>{operation === 'check' ? 'Checking…' : 'Check for updates'}</button></>}</footer>
  </dialog>;
}
