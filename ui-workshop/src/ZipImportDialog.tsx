import React, {useLayoutEffect, useRef, useState} from 'react';
import {importRepositoryArchive, suggestRepositoryName, validateRepositoryName,
  type ImportedRepository, type RepositoryCatalog} from './repository-catalog';
import {getNativeBridge} from './native-bridge.mjs';
import {GitHubCloneForm} from './GitHubCloneForm';
import type {ClonedRepository, GitHubAccount} from './native-types';
import './ZipImportDialog.css';

type Props = {
  catalog: RepositoryCatalog | null;
  loading: boolean;
  catalogError: string;
  returnFocus?: HTMLElement | null;
  account?: GitHubAccount;
  connectionConfigured?: boolean;
  onConnectionRefresh?(): void;
  onRetry(): void;
  onClose(): void;
  onImported(repository: ImportedRepository | ClonedRepository): void;
};

export function ZipImportDialog({catalog, loading, catalogError, returnFocus, account, connectionConfigured, onConnectionRefresh, onRetry, onClose, onImported}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [mode, setMode] = useState<'zip' | 'github'>('zip'), [cloning, setCloning] = useState(false);
  const canClone = Boolean(getNativeBridge()?.cloneRepository);
  const modalBusy = busy || cloning;
  const invalidName = validateRepositoryName(name);
  const existingName = catalog?.repositories.some(item => item.name.toLowerCase() === name.toLowerCase());
  const nameError = existingName ? 'A repository with this name already exists. Choose another name.' : submitted ? invalidName : null;
  const sizeLabel = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MiB`;
  const limit = catalog ? sizeLabel(catalog.limits.archiveBytes) : null;

  useLayoutEffect(() => {
    const element = dialog.current!;
    const previousFocus = returnFocus ?? document.activeElement;
    let active = true;
    element.showModal();
    queueMicrotask(() => {if (active && element.open) element.querySelector<HTMLInputElement>('input[type="file"]')?.focus();});
    return () => {active = false; element.close(); if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();};
  }, [returnFocus]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    setSubmitted(true);
    setError('');
    if (!file) {setError('Choose a ZIP archive to import.'); return;}
    if (invalidName || existingName) {nameInput.current?.focus(); return;}
    if (!catalog) {setError('Wait for the local repository service, then try again.'); return;}
    submitting.current = true;
    setBusy(true);
    try {onImported(await importRepositoryArchive(file, name, catalog));}
    catch (reason) {
      if (reason instanceof Error && 'code' in reason && reason.code === 'CAPABILITY_DENIED') {
        setError('The local connection changed. Refreshing the repository list; try importing again when it is ready.');
        onRetry();
      } else setError(reason instanceof Error ? reason.message : 'The import did not complete. Please try again.');
    }
    finally {submitting.current = false; setBusy(false);}
  };

  return <dialog ref={dialog} className="zi-dialog" aria-labelledby="zi-title" aria-describedby="zi-description"
    onCancel={event => {event.preventDefault(); if (!submitting.current && !cloning) onClose();}}>
    <header><h2 id="zi-title">Import repository</h2><button type="button" className="zi-close" aria-label="Close import dialog" disabled={modalBusy} onClick={onClose}>×</button></header>
    {canClone && <div className="zi-methods" role="group" aria-label="Import method">
      <button type="button" aria-pressed={mode === 'zip'} disabled={modalBusy} onClick={() => setMode('zip')}>Import ZIP</button>
      <button type="button" aria-pressed={mode === 'github'} disabled={modalBusy} onClick={() => setMode('github')}>Clone from GitHub</button>
    </div>}
    {mode === 'github' ? <GitHubCloneForm catalog={catalog} loading={loading} catalogError={catalogError} account={account} connectionConfigured={connectionConfigured} onRetry={onRetry} onClose={onClose} onBusy={value => {setCloning(value); if (!value) onConnectionRefresh?.();}} onCloned={onImported}/> :
    <form onSubmit={event => {void submit(event);}} aria-busy={busy}>
      <p id="zi-description">Import a ZIP archive as a new local repository.</p>
      <label className="zi-field">ZIP archive
        <input autoFocus type="file" accept=".zip,application/zip,application/x-zip-compressed" disabled={busy}
          aria-describedby="zi-archive-help" onChange={event => {
            const selected = event.target.files?.[0] ?? null;
            setFile(selected); setName(selected ? suggestRepositoryName(selected.name) : ''); setError(''); setSubmitted(false);
          }}/>
      </label>
      <p id="zi-archive-help" className="zi-help">{limit ? `ZIP archives up to ${limit}. ` : ''}Your original archive stays unchanged.</p>
      {catalog && <details className="zi-limits"><summary>Import limits</summary><ul>
        <li>Archive: {sizeLabel(catalog.limits.archiveBytes)}</li>
        {catalog.limits.expandedBytes && <li>Total extracted size: {sizeLabel(catalog.limits.expandedBytes)}</li>}
        {catalog.limits.memberBytes && <li>Each file: {sizeLabel(catalog.limits.memberBytes)}</li>}
        {catalog.limits.extractedEntries && <li>Files and folders: {catalog.limits.extractedEntries.toLocaleString()}</li>}
        {catalog.limits.pathDepth && <li>Path depth: {catalog.limits.pathDepth} levels</li>}
      </ul></details>}
      <div className="zi-destination">
        <label className="zi-field zi-owner">Organization<input value="asMagicBrain" readOnly aria-readonly="true"/></label>
        <span className="zi-slash" aria-hidden="true">/</span>
        <label className="zi-field zi-name">Repository name<input ref={nameInput} value={name} disabled={busy} maxLength={100}
          spellCheck={false} autoComplete="off" aria-invalid={Boolean(nameError)} aria-describedby={nameError ? 'zi-name-error' : 'zi-name-help'}
          onChange={event => {setName(event.target.value); setError('');}}/></label>
      </div>
      {nameError ? <p id="zi-name-error" className="zi-error">{nameError}</p> : <p id="zi-name-help" className="zi-help">Choose a unique name for the imported repository.</p>}
      <div className="zi-note"><strong>A managed copy with fresh Git history</strong><p>Files are copied into the asMagicBrain repository folder. The import starts a new local Git history; archive history and remote connections are not carried over.</p></div>
      {loading && <p role="status" className="zi-help">Connecting to local repositories…</p>}
      {catalogError && <div className="zi-service-error"><p role="alert">{catalogError}</p><button type="button" disabled={loading || busy} onClick={onRetry}>Retry connection</button></div>}
      {error && <p role="alert" className="zi-error">{error}</p>}
      <p className="zi-progress" role="status" aria-live="polite">{busy ? 'Importing archive and creating local Git history… Keep this window open.' : ''}</p>
      <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="zi-primary" type="submit" disabled={busy || !catalog || loading}>{busy ? 'Importing…' : 'Import repository'}</button></footer>
    </form>}
  </dialog>;
}
