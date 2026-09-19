import React, {useEffect, useRef, useState} from 'react';
import {cancelGitHubClone, cloneGitHubRepository, getGitHubCloneProgress, githubCloneError, githubRepositoryName} from './repository-catalog';
import {validateRepositoryName, type RepositoryCatalog} from './repository-catalog';
import {isNativeClosing} from './native-bridge.mjs';
import type {ClonedRepository, GitHubAccount, GitHubCloneInput, GitHubCloneProgress} from './native-types';

type Props = {
  catalog: RepositoryCatalog | null; loading: boolean; catalogError: string;
  account?: GitHubAccount; connectionConfigured?: boolean;
  onRetry(): void; onClose(): void; onBusy(busy: boolean): void;
  onCloned(repository: ClonedRepository): void;
};
const phaseLabels: Record<GitHubCloneProgress['phase'], string> = {
  connecting: 'Connecting to GitHub…', receiving: 'Downloading repository history and files…',
  checking: 'Checking the local copy…', publishing: 'Adding the repository to your workspace…',
  complete: 'Repository cloned.', cancelled: 'Cloning cancelled.', failed: 'Cloning could not complete.',
};

export function GitHubCloneForm({catalog, loading, catalogError, account, connectionConfigured, onRetry, onClose, onBusy, onCloned}: Props) {
  const urlInput = useRef<HTMLInputElement>(null), nameInput = useRef<HTMLInputElement>(null);
  const attempt = useRef<GitHubCloneInput | null>(null), submitting = useRef(false), active = useRef(true);
  const nameEdited = useRef(false), cancelling = useRef(false);
  const [url, setUrl] = useState(''), [name, setName] = useState(''), [useAccount, setUseAccount] = useState(false);
  const [busy, setBusy] = useState(false), [cancelRequested, setCancelRequested] = useState(false);
  const [submitted, setSubmitted] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const invalidName = validateRepositoryName(name);
  const existingName = catalog?.repositories.some(item => item.name.toLowerCase() === name.toLowerCase());
  const nameError = existingName ? 'A repository with this name already exists. Choose another name.' : submitted ? invalidName : null;
  const urlError = submitted && !githubRepositoryName(url) ? 'Enter a GitHub repository URL, such as https://github.com/owner/repository.' : null;

  useEffect(() => {
    active.current = true; urlInput.current?.focus();
    return () => {active.current = false; if (submitting.current && attempt.current) void cancelGitHubClone(attempt.current.requestId).catch(() => {});};
  }, []);
  useEffect(() => {
    if (!busy || !attempt.current) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const requestId = attempt.current.requestId;
    const poll = async () => {
      if (stopped) return;
      if (isNativeClosing()) {timer = setTimeout(() => {void poll();}, 700); return;}
      try {const progress = await getGitHubCloneProgress(requestId); if (!stopped && !cancelling.current && progress) setStatus(phaseLabels[progress.phase] ?? 'Cloning repository…');}
      catch { /* The clone result owns errors; temporary progress failures do not unlock the form. */ }
      if (!stopped) timer = setTimeout(() => {void poll();}, 700);
    };
    void poll();
    return () => {stopped = true; clearTimeout(timer);};
  }, [busy]);

  const cancel = async () => {
    if (!submitting.current) {onClose(); return;}
    if (!attempt.current || cancelling.current) return;
    cancelling.current = true; setCancelRequested(true); setStatus('Cancelling clone…');
    try {await cancelGitHubClone(attempt.current.requestId);}
    catch (reason) {if (active.current) {setError(githubCloneError(reason)); cancelling.current = false; setCancelRequested(false);}}
    // The clone promise owns completion. A publication already completed on the
    // host wins the cancellation race and opens its registered repository.
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current || isNativeClosing()) return;
    setSubmitted(true); setError(''); setStatus('');
    if (!githubRepositoryName(url)) {urlInput.current?.focus(); return;}
    if (invalidName || existingName) {nameInput.current?.focus(); return;}
    if (!catalog || loading || catalogError) {setError('Refresh the repository list before cloning.'); return;}
    const input = {url: url.trim(), name, useAccount: Boolean(account && useAccount)};
    if (!attempt.current || attempt.current.url !== input.url || attempt.current.name !== input.name || attempt.current.useAccount !== input.useAccount) {
      attempt.current = {...input, requestId: crypto.randomUUID()};
    }
    submitting.current = true; cancelling.current = false; setBusy(true); setCancelRequested(false); onBusy(true); setStatus('Connecting to GitHub…');
    try {const cloned = await cloneGitHubRepository(attempt.current); if (active.current) onCloned(cloned);}
    catch (reason) {
      if (active.current) {
        if (reason && typeof reason === 'object' && 'code' in reason && reason.code === 'CLONE_CANCELLED') {
          setStatus('Cloning cancelled.'); attempt.current = null;
        } else {setStatus(''); setError(githubCloneError(reason));}
      }
    } finally {
      submitting.current = false; cancelling.current = false;
      if (active.current) {setBusy(false); setCancelRequested(false); onBusy(false);}
    }
  };

  return <form onSubmit={event => {void submit(event);}} aria-busy={busy}>
    <p id="zi-description">Clone a GitHub repository into your local asMagicBrain workspace.</p>
    <label className="zi-field">GitHub repository URL<input ref={urlInput} autoFocus type="url" value={url} disabled={busy} placeholder="https://github.com/owner/repository" autoComplete="off" spellCheck={false}
      aria-invalid={Boolean(urlError)} aria-describedby={urlError ? 'gc-url-error' : 'gc-url-help'} onChange={event => {
        const value = event.target.value; setUrl(value); setError(''); setStatus('');
        if (!nameEdited.current) setName(githubRepositoryName(value) ?? '');
      }}/></label>
    {urlError ? <p id="gc-url-error" className="zi-error">{urlError}</p> : <p id="gc-url-help" className="zi-help">Public repositories can be cloned without signing in.</p>}
    <div className="zi-destination">
      <label className="zi-field zi-owner">Organization<input value="asMagicBrain" readOnly aria-readonly="true"/></label><span className="zi-slash" aria-hidden="true">/</span>
      <label className="zi-field zi-name">Repository name<input ref={nameInput} value={name} disabled={busy} maxLength={100} autoComplete="off" spellCheck={false}
        aria-invalid={Boolean(nameError)} aria-describedby={nameError ? 'gc-name-error' : 'gc-name-help'} onChange={event => {nameEdited.current = true; setName(event.target.value); setError(''); setStatus('');}}/></label>
    </div>
    {nameError ? <p id="gc-name-error" className="zi-error">{nameError}</p> : <p id="gc-name-help" className="zi-help">Choose a unique name for the local copy.</p>}
    {account ? <label className="gc-account"><input type="checkbox" checked={useAccount} disabled={busy} onChange={event => setUseAccount(event.target.checked)}/><span>Use GitHub account <strong>{account.username}</strong> for private repositories</span></label> : <p className="zi-help">{connectionConfigured === false ? 'Private repositories require a GitHub connection, which is unavailable in this build.' : 'For private repositories, connect GitHub from the account menu first.'}</p>}
    <div className="zi-note"><strong>Keep repository history</strong><p>Branches, tags and Git history are copied with the files. Your local edits stay on this device; synchronization is not available yet.</p></div>
    {loading && <p role="status" className="zi-help">Loading local repositories…</p>}
    {catalogError && <div className="zi-service-error"><p role="alert">{catalogError}</p><button type="button" disabled={loading || busy} onClick={onRetry}>Retry connection</button></div>}
    {error && <p role="alert" className="zi-error">{error}</p>}
    <p className="zi-progress" role="status" aria-live="polite">{status}</p>
    <footer><button type="button" disabled={cancelRequested} onClick={() => {void cancel();}}>{cancelRequested ? 'Cancelling…' : busy ? 'Cancel clone' : 'Cancel'}</button><button className="zi-primary" type="submit" disabled={busy || !catalog || loading || Boolean(catalogError)}>{busy ? 'Cloning…' : 'Clone repository'}</button></footer>
  </form>;
}
