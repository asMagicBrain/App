import {PluginOperationError, type BundledPlugin, type PluginManifest, type PluginResult} from './plugin-foundation/contracts.ts';

export const markdownToolsManifest: PluginManifest = {
  schemaVersion: 1, id: 'asmagicbrain.markdown', name: 'Markdown tools', version: '0.1.0',
  hostApi: {min: 1, max: 1}, capabilities: ['document.read', 'document.edit'],
  contributions: [
    {id: 'asmagicbrain.markdown.statistics', kind: 'command', title: 'Document statistics'},
    {id: 'asmagicbrain.markdown.bold', kind: 'command', title: 'Bold selection'},
    {id: 'asmagicbrain.markdown.statistics-tool', kind: 'reader-view', title: 'Document statistics', commandId: 'asmagicbrain.markdown.statistics'},
    {id: 'asmagicbrain.markdown.bold-tool', kind: 'editor-tool', title: 'Bold selection', commandId: 'asmagicbrain.markdown.bold'},
    {id: 'asmagicbrain.markdown.navigation', kind: 'navigation', title: 'Markdown tools', commandId: 'asmagicbrain.markdown.statistics'},
  ],
};
type DocumentRead = {text: string; selection: {anchor: number; head: number}};
const unwrap = <T,>(result: PluginResult<unknown>): T => {
  if (!result.ok) throw new PluginOperationError(result.error.code);
  return result.value as T;
};
/** A bundled consumer of the public contract. No editor, file writer or bridge. */
export const markdownTools: BundledPlugin = {
  activate(context) {
    context.registerCommand('asmagicbrain.markdown.statistics', async ({document}) => {
      if (!document) throw new PluginOperationError('STALE');
      const {text} = unwrap<DocumentRead>(await context.document.read(document));
      return {kind: 'statistics', words: text.trim() ? text.trim().split(/\s+/u).length : 0,
        characters: Array.from(text).length, lines: text.split('\n').length};
    });
    context.registerCommand('asmagicbrain.markdown.bold', async ({document}) => {
      if (!document) throw new PluginOperationError('STALE');
      const {text, selection} = unwrap<DocumentRead>(await context.document.read(document));
      const from = Math.min(selection.anchor, selection.head), to = Math.max(selection.anchor, selection.head);
      const content = text.slice(from, to) || 'text';
      // Insert delimiters without rewriting the selection's original line endings.
      unwrap(await context.document.edit(document, {changes: from === to ? [{from, to, insert: `**${content}**`}] :
        [{from, to: from, insert: '**'}, {from: to, to, insert: '**'}],
        selection: {anchor: from + 2, head: from + 2 + content.length}}));
      return {kind: 'edited'};
    });
  },
};
