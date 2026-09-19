import { StateEffect, StateField } from '@codemirror/state';
import { invertedEffects } from '@codemirror/commands';
import { sourceChanges } from './cm6-commands.mjs';

/** Keep the real CM6 state and its raw-source inversion mapping together. The
 * session owns scope lifetime and invalidates it when fresh host state differs.
 * Weak keys cannot extend a retired document/session's lifetime. */
export function createEditorHistoryCache() {
  const entries = new WeakMap();
  return Object.freeze({
    take(scope, value) {
      if (!scope) return null;
      const entry = entries.get(scope); entries.delete(scope);
      return entry?.state.doc.toString() === value ? entry : null;
    },
    retain(scope, state, rawHistory) {
      if (scope) entries.set(scope, { state, rawHistory });
    },
  });
}

/** CM6 may compute transaction states before dispatch, and dispatch arrays of
 * related transactions. Immutable per-state holders are resolved only after the
 * source accepts that state's edit. Inversions retain holders, not eager copies. */
export function createRawHistory(capture) {
  const restore = StateEffect.define(), snapshots = new WeakMap();
  const holder = () => Object.freeze({});
  const current = StateField.define({
    create: () => { const value = holder(); snapshots.set(value, capture()); return value; },
    update: (value, transaction) => transaction.docChanged ? holder() : value,
  });
  return Object.freeze({
    bindCapture(next) { capture = next; },
    extension: [current, invertedEffects.of(transaction => transaction.docChanged
      ? [restore.of(transaction.startState.field(current))] : [])],
    restoreFrom(transaction) {
      const history = transaction.isUserEvent('undo') ? 'undo' : transaction.isUserEvent('redo') ? 'redo' : null;
      if (!history) return undefined;
      const effects = transaction.effects.filter(effect => effect.is(restore));
      const token = effects.length ? snapshots.get(effects.at(-1).value) : undefined;
      if (!token) throw Error('Raw source history is unavailable.');
      return { history, restore: token };
    },
    accept(state) {
      const value = state.field(current), token = capture();
      if (snapshots.has(value) && snapshots.get(value) !== token) throw Error('Raw history state already resolved.');
      snapshots.set(value, token);
    },
  });
}

/** The original CM6 transaction array is committed intact. No supplemental state
 * is interleaved between related transactions. A refused suffix retains only the
 * accepted prefix, keeping the visible state equal to the source session. */
export function dispatchSourceTransactions(transactions, view, bridge, rawHistory) {
  const accepted = [];
  try {
    for (const transaction of transactions) {
      if (transaction.docChanged) {
        bridge.onChanges(sourceChanges(transaction.changes), rawHistory.restoreFrom(transaction));
        rawHistory.accept(transaction.state);
      }
      accepted.push(transaction);
    }
  } catch {
    if (accepted.length) view.update(accepted);
    bridge.onError('A source change was refused. The last confirmed editor state remains displayed.');
    return false;
  }
  view.update(accepted); return true;
}
