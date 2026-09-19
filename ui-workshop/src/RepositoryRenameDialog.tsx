import React, {useId, useLayoutEffect, useRef, useState} from 'react';
import {validateRepositoryName} from './repository-catalog';

type Props = {repository: string; onRename(name: string): Promise<void>; onClose(): void};
const failureMessages: Record<string, string> = {
  INVALID_REPOSITORY_NAME: 'This name cannot be used for a repository. Choose another name.',
  NAME_EXISTS: 'A repository already uses that name. Choose a different name; changing only letter case is not supported.',
  UNKNOWN_REPOSITORY: 'This repository is no longer available. Check the repository list before trying again.',
  RECOVERY_REQUIRED: 'Resolve the pending repository recovery before renaming it.',
  GIT_BUSY: 'Git is busy. Finish the current Git operation, then try again.',
  SERVICE_BUSY: 'Another repository operation is in progress. Try again when it finishes.',
};

/** The owner prepares drafts and performs the managed rename; this dialog owns only its form. */
export function RepositoryRenameDialog({repository, onRename, onClose}: Props) {
  const [name, setName] = useState(repository);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const pending = useRef(false), mounted = useRef(true);
  const id = useId();
  useLayoutEffect(() => {
    mounted.current = true;
    const element = dialog.current;
    element?.showModal();
    input.current?.select();
    return () => {mounted.current = false; element?.close();};
  }, []);
  const dismiss = () => {if (!pending.current) onClose();};
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending.current) return;
    const next = name.trim(), invalid = validateRepositoryName(next);
    if (invalid) {setError(invalid); input.current?.focus(); return;}
    if (next === repository) {onClose(); return;}
    pending.current = true; setBusy(true); setError('');
    try {
      await onRename(next);
      if (mounted.current) onClose();
    } catch (reason) {
      if (mounted.current) {
        const failure = reason as Error & {code?: string};
        setError(failureMessages[failure?.code ?? ''] ?? failure?.message ?? 'The repository could not be renamed. Try again.');
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return <dialog ref={dialog} className="rfe-commit-dialog rfe-repository-rename-dialog" aria-labelledby={`${id}-title`}
    onCancel={event => {event.preventDefault(); dismiss();}} onKeyDown={event => event.stopPropagation()}>
    <form onSubmit={event => {void submit(event);}} aria-busy={busy}>
      <header><h2 id={`${id}-title`}>Rename repository</h2><p id={`${id}-help`}>Rename the managed repository folder. Saved files, local Git history and retained drafts stay with this repository.</p></header>
      <label>Repository name<input ref={input} required maxLength={100} autoComplete="off" spellCheck={false} value={name} disabled={busy}
        aria-invalid={Boolean(error)} aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
        onChange={event => {setName(event.target.value); setError('');}}/></label>
      {error && <p id={`${id}-error`} role="alert" className="rfe-error">{error}</p>}
      {busy && <p role="status">Preserving local work and renaming the repository…</p>}
      <footer><button type="button" disabled={busy} onClick={dismiss}>Cancel</button><button type="submit" disabled={busy}>{busy ? 'Renaming…' : 'Rename repository'}</button></footer>
    </form>
  </dialog>;
}
