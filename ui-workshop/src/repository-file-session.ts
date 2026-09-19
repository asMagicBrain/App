import {createSourceBuffer} from '../../apps/desktop/ui/source-buffer.mjs';
import type {WorkspaceDocument} from './local-workspace-client';

export const isMarkdownFile = (path: string) => /\.(md|markdown)$/i.test(path);
export const isMediaFile = (path: string) => /\.(png|jpe?g|gif|webp|webm|mp4)$/i.test(path);
export function fileModes(path: string, editing: boolean): ('source' | 'preview')[] {
  return isMarkdownFile(path) ? editing ? ['source', 'preview'] : ['preview', 'source'] : ['source'];
}
export function validateFilePath(path: string): string | null {
  if (!path || path.startsWith('/') || /[\\\u0000-\u001f]/.test(path)) return 'Enter a relative file path, such as notes/example.md.';
  if (path.split('/').some(part => !part || part === '.' || part === '..' || ['.git', '.asmagicbrain'].includes(part.toLowerCase()) || part.toLowerCase().startsWith('.asmb-'))) return 'Use a file path without empty, parent, or reserved folder names.';
  return null;
}
export type FileSession = {
  id: string; path: string; proposedPath: string; sourceHash: string | null; saved: string;
  buffer: ReturnType<typeof createSourceBuffer>; readOnly: boolean; conflict: boolean;
  isNew: boolean; media?: boolean; draftId?: string; version: number; checkpointedVersion: number;
};
export function createFileSession(document: WorkspaceDocument): FileSession {
  if (typeof document.text !== 'string') throw new Error('This file cannot be displayed as editable UTF-8 text.');
  return {
    id: document.documentId, path: document.path, proposedPath: document.path,
    sourceHash: document.draft?.baseHash ?? document.sourceHash, saved: document.text,
    buffer: createSourceBuffer(document.draft?.text ?? document.text),
    readOnly: document.readOnly || Boolean(document.recoveryRequired), conflict: Boolean(document.conflict),
    isNew: false, version: 0, checkpointedVersion: 0,
  };
}
/** Media placeholders never stand in for decoded text, including after rename. */
export function createMediaSession(path: string, revision = ''): FileSession {
  return {...createFileSession({path,documentId:`media:${revision}:${path}`,sourceHash:null,text:'',readOnly:true}),media:true};
}
export function isReadOnlyMediaSession(session: FileSession, native: boolean) {
  return session.media === true || (native && !session.isNew && isMediaFile(session.path));
}
export function createNewFileSession(draftId: string, path: string, text = ''): FileSession {
  return {id: draftId, draftId, path, proposedPath: path, sourceHash: null, saved: '', buffer: createSourceBuffer(text), readOnly: false, conflict: false, isNew: true, version: 1, checkpointedVersion: 0};
}
export const hasFileChanges = (session: FileSession) => session.isNew || session.proposedPath !== session.path || session.buffer.getRawText() !== session.saved;
export function replaceFileSession(sessions: Map<string, FileSession>, previous: FileSession, replacement: FileSession) {
  sessions.delete(previous.id);
  sessions.set(replacement.id, replacement);
}
export async function completeNewDraftCleanup(session: FileSession, discard: (draftId: string) => Promise<unknown>) {
  if (session.isNew || !session.draftId) return;
  await discard(session.draftId);
  session.draftId = undefined;
}

export function confirmedDiscardSession(sessions: Map<string, FileSession>, confirmedId: string | null, activeId: string): FileSession {
  const session = confirmedId === null ? undefined : sessions.get(confirmedId);
  if (!session || activeId !== confirmedId) throw new Error('The selected file changed. Close this dialog and review its changes before discarding.');
  return session;
}
