import type { ChangeSet, EditorState, TransactionSpec } from '@codemirror/state';
export type SourceChange = { from: number; to: number; insert: string };
export type FormatAction = 'bold' | 'italic' | 'code' | 'link' | 'heading' | 'bullet' | 'quote' | 'task';
export function sourceChanges(changes: ChangeSet): SourceChange[];
export function formatSource(state: EditorState, action: FormatAction): TransactionSpec;
