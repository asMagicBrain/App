/** Existing-file rename intent is session-only; closing must not discard it. */
export function assertFilenameIntentRetained(sessions) {
  for (const item of sessions) {
    if (!item.isNew && item.proposedPath !== item.path) throw new Error('Save or revert filename changes before closing.');
  }
}

/**
 * Refuse composition before changing focus. Lock synchronously before awaiting
 * drafts, and retain the lock after a successful acknowledgement until destruction.
 * All callbacks are injected so the shutdown protocol can be tested without Electron.
 */
export function createNativeCloseHandler({composing, prepare, lock, settle, acknowledge, report}) {
  let active = false;
  let generation = 0;
  /** @param {{requestId:string,cancelled?:boolean,error?:string}} input */
  const handle = async ({requestId, cancelled = false, error: cancellationError}) => {
    if (cancelled) {
      generation++;
      active = false;
      lock(false);
      if (cancellationError) report(cancellationError);
      return;
    }
    if (active) {acknowledge({requestId, ok: false, error: 'A close request is already being prepared.'}); return;}
    active = true;
    const attempt = ++generation;
    try {
      if (composing()) throw new Error('Finish text composition before closing the window.');
      // Start preparation, then lock before its first asynchronous continuation.
      // It may need to finish an admitted renderer reload before draft checks.
      const preserving = prepare();
      lock(true);
      await preserving;
      await settle();
      if (attempt !== generation) return;
      acknowledge({requestId, ok: true});
    } catch (reason) {
      if (attempt !== generation) return;
      lock(false);
      const error = reason instanceof Error ? reason.message : 'Local work could not be preserved.';
      report(error);
      acknowledge({requestId, ok: false, error});
      active = false;
    }
  };
  return handle;
}
