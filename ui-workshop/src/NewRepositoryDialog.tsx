import React, {useLayoutEffect, useRef, useState} from 'react';
import {createLocalRepository, repositoryCreationError, validateRepositoryName, type CreatedRepository, type RepositoryCatalog} from './repository-catalog';
import './ZipImportDialog.css';

type Props = {
  catalog: RepositoryCatalog | null;
  loading: boolean;
  catalogError: string;
  returnFocus?: HTMLElement | null;
  onRetry(): void;
  onClose(): void;
  onCreated(repository: CreatedRepository): void;
};

export function NewRepositoryDialog({catalog, loading, catalogError, returnFocus, onRetry, onClose, onCreated}: Props) {
  const dialog = useRef<HTMLDialogElement>(null), nameInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false), attempt = useRef<{name: string; requestId: string} | null>(null);
  const [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [submitted, setSubmitted] = useState(false);
  const invalidName = validateRepositoryName(name);
  const existingName = catalog?.repositories.some(item => item.name.toLowerCase() === name.toLowerCase());
  const nameError = existingName ? 'A repository with this name already exists. Choose another name.' : submitted ? invalidName : null;

  useLayoutEffect(() => {
    const element = dialog.current!, previousFocus = returnFocus ?? document.activeElement;
    let active = true;
    element.showModal();
    // Closing the leave-editor dialog in the same commit restores its previous
    // focus. Set this dialog's initial focus after that restoration has settled.
    queueMicrotask(() => {if (active && element.open) nameInput.current?.focus();});
    return () => {active = false; element.close(); if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();};
  }, [returnFocus]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    setSubmitted(true); setError('');
    if (invalidName || existingName) {nameInput.current?.focus(); return;}
    if (!catalog || loading || catalogError) {setError('Refresh the repository list before creating a repository.'); return;}
    submitting.current = true; setBusy(true);
    try {
      // A retry of the same name keeps its identity if a host reply was interrupted.
      if (attempt.current?.name !== name) attempt.current = {name, requestId: crypto.randomUUID()};
      onCreated(await createLocalRepository(attempt.current));
    }
    catch (reason) {setError(repositoryCreationError(reason));}
    finally {submitting.current = false; setBusy(false);}
  };

  return <dialog ref={dialog} className="zi-dialog nr-dialog" aria-labelledby="nr-title" aria-describedby="nr-description"
    onCancel={event => {event.preventDefault(); if (!submitting.current) onClose();}}>
    <form onSubmit={event => {void submit(event);}} aria-busy={busy}>
      <header><h2 id="nr-title">New repository</h2><button type="button" className="zi-close" aria-label="Close new repository dialog" disabled={busy} onClick={onClose}>×</button></header>
      <p id="nr-description">Create an empty local repository in your asMagicBrain workspace.</p>
      <div className="zi-destination">
        <label className="zi-field zi-owner">Organization<input value="asMagicBrain" readOnly aria-readonly="true"/></label>
        <span className="zi-slash" aria-hidden="true">/</span>
        <label className="zi-field zi-name">Repository name<input ref={nameInput} autoFocus value={name} disabled={busy} maxLength={100}
          spellCheck={false} autoComplete="off" aria-invalid={Boolean(nameError)} aria-describedby={nameError ? 'nr-name-error' : 'nr-name-help'}
          onChange={event => {setName(event.target.value); setError('');}}/></label>
      </div>
      {nameError ? <p id="nr-name-error" className="zi-error">{nameError}</p> : <p id="nr-name-help" className="zi-help">Choose a unique repository name.</p>}
      {loading && <p role="status" className="zi-help">Loading local repositories…</p>}
      {catalogError && <div className="zi-service-error"><p role="alert">{catalogError}</p><button type="button" disabled={loading || busy} onClick={onRetry}>Retry connection</button></div>}
      {error && <p role="alert" className="zi-error">{error}</p>}
      <p className="zi-progress" role="status" aria-live="polite">{busy ? 'Creating repository…' : ''}</p>
      <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="zi-primary" type="submit" disabled={busy || !catalog || loading || Boolean(catalogError)}>{busy ? 'Creating…' : 'Create repository'}</button></footer>
    </form>
  </dialog>;
}
