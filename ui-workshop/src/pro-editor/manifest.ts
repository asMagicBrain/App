import {PluginOperationError, type BundledPlugin, type PluginEdit, type PluginManifest, type PluginResult} from '../plugin-foundation/contracts.ts';

export const proEditorManifest: PluginManifest = {
  schemaVersion: 1, id: 'asmagicbrain.pro-editor', name: 'Pro Editor', version: '0.1.0',
  hostApi: {min: 1, max: 1}, capabilities: ['document.read', 'document.edit'],
  contributions: [
    {id: 'asmagicbrain.pro-editor.open', kind: 'command', title: 'Pro Editor'},
    {id: 'asmagicbrain.pro-editor.equation', kind: 'command', title: 'Insert equation'},
    {id: 'asmagicbrain.pro-editor.diagram', kind: 'command', title: 'Insert diagram'},
    {id: 'asmagicbrain.pro-editor.equation-tool', kind: 'editor-tool', title: 'Insert equation', commandId: 'asmagicbrain.pro-editor.equation'},
    {id: 'asmagicbrain.pro-editor.diagram-tool', kind: 'editor-tool', title: 'Insert diagram', commandId: 'asmagicbrain.pro-editor.diagram'},
    {id: 'asmagicbrain.pro-editor.navigation', kind: 'navigation', title: 'Pro Editor', commandId: 'asmagicbrain.pro-editor.open'},
  ],
};
type DocumentRead = {text: string; selection: {anchor: number; head: number}};
const unwrap = <T,>(result: PluginResult<unknown>): T => {
  if (!result.ok) throw new PluginOperationError(result.error.code);
  return result.value as T;
};

/** Delimiters are inserted around a nonempty selection, preserving every
 * selected original byte/line-ending token. An empty selection gets a template. */
export function proInsertion(kind: 'equation' | 'diagram', read: DocumentRead): PluginEdit {
  const {text, selection} = read;
  const from = Math.min(selection.anchor, selection.head), to = Math.max(selection.anchor, selection.head);
  const content = text.slice(from, to) || (kind === 'equation' ? 'E = mc^2' : 'flowchart LR\n  A[Start] --> B[Finish]');
  const opening = `${from > 0 && text[from - 1] !== '\n' ? '\n\n' : ''}${kind === 'equation' ? '$$' : '```mermaid'}\n`;
  const closing = `\n${kind === 'equation' ? '$$' : '```'}${to < text.length && text[to] !== '\n' ? '\n\n' : '\n'}`;
  return {changes: from === to ? [{from, to, insert: opening + content + closing}] :
    [{from, to: from, insert: opening}, {from: to, to, insert: closing}],
    selection: {anchor: from + opening.length, head: from + opening.length + content.length}};
}

export const proEditor: BundledPlugin = {
  activate(context) {
    context.registerCommand('asmagicbrain.pro-editor.open', () => ({kind: 'pro-editor'}));
    for (const kind of ['equation', 'diagram'] as const) {
      context.registerCommand(`asmagicbrain.pro-editor.${kind}`, async ({document}) => {
        if (!document) throw new PluginOperationError('STALE');
        if (!/\.(?:md|markdown)$/i.test(document.path)) throw new PluginOperationError('DENIED');
        const read = unwrap<DocumentRead>(await context.document.read(document));
        unwrap(await context.document.edit(document, proInsertion(kind, read)));
        return {kind: 'edited', tool: kind};
      });
    }
  },
};
