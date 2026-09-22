import {Compartment, EditorState, Transaction, type Extension} from '@codemirror/state';
import {history, isolateHistory} from '@codemirror/commands';
import {createRawHistory, dispatchSourceTransactions, type RawHistory} from '../../apps/desktop/ui/cm6-history.mjs';
import type {FileSession} from './repository-file-session.ts';

/** Renderer host authority. Plugins receive snapshots and bounded operations,
 * never this object, its FileSession, raw history, or a writable EditorView. */
export type RepositoryDocumentIdentity = Readonly<{repositoryId: string; revision: string}>;
export type RepositoryDocumentSnapshot = RepositoryDocumentIdentity & Readonly<{
  sessionId: string; path: string; sourceHash: string | null; version: number;
  readOnly: boolean; conflict: boolean;
}>;
export type RepositoryDocumentEdit = Readonly<{
  changes: readonly {from: number; to: number; insert: string}[];
  selection?: {anchor: number; head?: number};
}>;
type SessionView = {
  readonly state: EditorState; readonly composing?: boolean; readonly compositionStarted?: boolean;
  update(transactions: readonly Transaction[]): void;
  setState(state: EditorState): void;
};
type SessionObservers = {onChange?(): void; onError?(message: string): void};
export type RepositoryDocumentSessionErrorCode = 'cancelled' | 'stale' | 'denied' | 'read-only' | 'conflict' | 'composing' | 'invalid' | 'unavailable';
export class RepositoryDocumentSessionError extends Error {
  readonly code: RepositoryDocumentSessionErrorCode;
  constructor(code: RepositoryDocumentSessionErrorCode) {
    const messages: Record<RepositoryDocumentSessionErrorCode, string> = {
      cancelled: 'The document operation was cancelled.', stale: 'The document changed. Review it and try again.',
      denied: 'The document operation is not allowed.', 'read-only': 'This document is read-only.',
      conflict: 'Resolve the document conflict before using this command.', composing: 'Finish text composition before using this command.',
      invalid: 'The document change is invalid.', unavailable: 'The document session is unavailable.',
    };
    super(messages[code]); this.name = 'RepositoryDocumentSessionError'; this.code = code;
  }
}
const fail = (code: RepositoryDocumentSessionErrorCode): never => {throw new RepositoryDocumentSessionError(code);};
const snapshotKeys = ['repositoryId', 'revision', 'sessionId', 'path', 'sourceHash', 'version', 'readOnly', 'conflict'] as const;

export function createRepositoryDocumentSession(
  file: FileSession, identity: RepositoryDocumentIdentity,
  extensions: Extension | ((rawHistory: RawHistory) => Extension) = [],
) {
  const scope = Object.freeze({...identity}), contribution = new Compartment();
  const rawHistory = createRawHistory(() => file.buffer.captureHistory());
  let state = EditorState.create({doc: file.buffer.getText(), extensions: [
    history(), rawHistory.extension, typeof extensions === 'function' ? extensions(rawHistory) : extensions, contribution.of([]),
  ]});
  let view: SessionView | null = null, observers: SessionObservers = {}, version = 0, epoch = 0, disposed = false;
  const available = () => {if (disposed) fail('unavailable');};
  const composing = () => Boolean(view?.composing || view?.compositionStarted);
  const getSnapshot = (): RepositoryDocumentSnapshot => {
    available();
    return Object.freeze({...scope, sessionId: file.id, path: file.path, sourceHash: file.sourceHash,
      version, readOnly: file.readOnly || Boolean(file.media) || scope.revision !== '', conflict: file.conflict});
  };
  const check = (expected: RepositoryDocumentSnapshot, signal?: AbortSignal, operationEpoch = epoch) => {
    if (signal?.aborted || operationEpoch !== epoch) fail('cancelled');
    const current = getSnapshot();
    if (!expected || snapshotKeys.some(key => current[key] !== expected[key])) fail('stale');
    return current;
  };
  const checkWritable = () => {
    const snapshot = getSnapshot();
    if (snapshot.readOnly || state.readOnly) fail('read-only');
    if (snapshot.conflict) fail('conflict');
    if (composing()) fail('composing');
  };
  const report = (message: string) => {try {observers.onError?.(message);} catch {/* An observer cannot roll back accepted source. */}};

  const dispatch = (transactions: readonly Transaction[], origin?: SessionView): boolean => {
    available();
    if (origin && origin !== view) fail('stale');
    let expectedState = state, changed = false;
    return dispatchSourceTransactions(transactions, {update(accepted) {
      // The primitive commits only an accepted prefix. Its final state and raw
      // source move together even when a later transaction is refused.
      if (accepted.length) state = accepted[accepted.length - 1].state;
      // Commands may depend on a selection they just read. Moving the cursor
      // invalidates that operation even when its source hash is unchanged.
      version += accepted.filter(transaction => transaction.docChanged || !transaction.startState.selection.eq(transaction.newSelection)).length;
      if (view) view.update(accepted);
      if (changed) {try {observers.onChange?.();} catch {report('The source changed, but its local draft checkpoint needs attention.');}}
    }}, {
      beforeTransaction(transaction) {
        if (transaction.startState !== expectedState) fail('stale');
        if (transaction.docChanged && (getSnapshot().readOnly || transaction.startState.readOnly)) fail('read-only');
        expectedState = transaction.state;
      },
      onChanges(changes, restore) {file.buffer.applyChanges(changes, restore); changed = true;},
      onError: report,
    }, rawHistory);
  };
  const session = {
    get state() {available(); return state;}, rawHistory, getSnapshot,
    get isComposing() {return composing();},
    attach(next: SessionView, nextObservers: SessionObservers = {}) {
      available();
      if (view && view !== next) fail('denied');
      if (next.state !== state) next.setState(state);
      view = next; observers = nextObservers;
    },
    detach(previous: SessionView) {
      if (view !== previous) return;
      if (composing()) fail('composing');
      epoch++; view = null; observers = {};
    },
    dispatch,
    /** Trusted first-party contributions share this state and its undo field. */
    setContribution(extension: Extension) {
      available(); if (composing()) fail('composing');
      epoch++;
      return dispatch([state.update({effects: contribution.reconfigure(extension)})]);
    },
    cancelOperations() {epoch++;},
    async read(expected: RepositoryDocumentSnapshot, signal?: AbortSignal, admit?: () => void) {
      const operationEpoch = epoch; check(expected, signal, operationEpoch);
      await Promise.resolve();
      admit?.();
      const snapshot = check(expected, signal, operationEpoch), selection = state.selection.main;
      return Object.freeze({...snapshot, text: state.doc.toString(), rawText: file.buffer.getRawText(),
        selection: Object.freeze({anchor: selection.anchor, head: selection.head})});
    },
    async transact(expected: RepositoryDocumentSnapshot, edit: RepositoryDocumentEdit, signal?: AbortSignal, admit?: () => void) {
      const operationEpoch = epoch; check(expected, signal, operationEpoch); checkWritable();
      await Promise.resolve();
      admit?.(); check(expected, signal, operationEpoch); checkWritable();
      if (!edit || !Array.isArray(edit.changes) || edit.changes.length > 1024) fail('invalid');
      // Do not allow CM6 to silently sort overlapping/out-of-order requests or
      // convert arbitrary plugin-supplied objects into inserted text.
      let lastEnd = -1, lastStart = -1, insertedLength = 0;
      for (const change of edit.changes) {
        if (!change || !Number.isSafeInteger(change.from) || !Number.isSafeInteger(change.to)
          || change.from < 0 || change.to < change.from || change.to > state.doc.length
          || change.from < lastEnd || change.from === lastStart || typeof change.insert !== 'string') fail('invalid');
        insertedLength += change.insert.length; lastStart = change.from; lastEnd = change.to;
      }
      if (insertedLength > 1024 * 1024) fail('invalid');
      if (edit.selection && (!Number.isSafeInteger(edit.selection.anchor)
        || (edit.selection.head !== undefined && !Number.isSafeInteger(edit.selection.head)))) fail('invalid');
      let transaction: Transaction;
      try {transaction = state.update({changes: edit.changes, selection: edit.selection,
        annotations: [Transaction.userEvent.of('input.plugin'), isolateHistory.of('full')]});} catch {return fail('invalid');}
      // Admission and source application are synchronous: cancellation cannot
      // arrive between this last check and the accepted transaction.
      check(expected, signal, operationEpoch); checkWritable();
      if (!dispatch([transaction])) fail('invalid');
      return getSnapshot();
    },
    dispose() {
      if (composing()) fail('composing');
      epoch++; view = null; observers = {}; disposed = true;
    },
  };
  return session;
}

export type RepositoryDocumentSession = ReturnType<typeof createRepositoryDocumentSession>;
const retainedSessions = new WeakMap<FileSession, RepositoryDocumentSession>();
/** A FileSession survives view swaps and new-file Save identity changes. Its
 * weak owner retains CM6 selection, history and raw-source tokens as one unit. */
export function getRepositoryDocumentSession(file: FileSession, identity: RepositoryDocumentIdentity,
  extensions: Extension | ((rawHistory: RawHistory) => Extension) = []) {
  let session = retainedSessions.get(file);
  if (!session) {session = createRepositoryDocumentSession(file, identity, extensions); retainedSessions.set(file, session);}
  const snapshot = session.getSnapshot();
  if (snapshot.repositoryId !== identity.repositoryId || snapshot.revision !== identity.revision) fail('stale');
  return session;
}
