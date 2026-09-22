import type { EditorState, Extension, Transaction } from '@codemirror/state';
export type RawHistoryRestore = { history: 'undo' | 'redo'; restore: object };
export type RawHistory = Readonly<{
  bindCapture(capture: () => object): void;
  extension: Extension; restoreFrom(transaction: Transaction): RawHistoryRestore | undefined;
  accept(state: EditorState): void;
}>;
export function createRawHistory(capture: () => object): RawHistory;
export type EditorHistoryCache = Readonly<{
  take(scope: object | null | undefined, value: string): { state: EditorState; rawHistory: RawHistory } | null;
  retain(scope: object | null | undefined, state: EditorState, rawHistory: RawHistory): void;
}>;
export function createEditorHistoryCache(): EditorHistoryCache;
export function dispatchSourceTransactions(transactions: readonly Transaction[], view: { update(transactions: readonly Transaction[]): void },
  bridge: { beforeTransaction?(transaction: Transaction): void; onChanges(changes: { from: number; to: number; insert: string }[], history?: RawHistoryRestore): void; onError(message: string): void }, rawHistory: RawHistory): boolean;
