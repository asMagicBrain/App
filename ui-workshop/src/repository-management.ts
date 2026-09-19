import type {FileSession} from './repository-file-session';
export type PathMove = {from: string; to: string};
export type ManagementResult = {status: string; operation: 'move'|'copy'|'trash'|'restore'|'import'; items: {path: string; newPath?: string; trashId?: string}[]; pathMoves: PathMove[]; changedPaths: string[]};
export const insidePath = (path: string, parent: string) => path === parent || path.startsWith(parent + '/');
export const parentPath = (path: string) => path.split('/').slice(0,-1).join('/');
export const fileName = (path: string) => path.split('/').at(-1)!;
/** Preserve recovery guidance; translate admission failures into a useful next step. */
export function externalImportProblem(reason: unknown): string {
 const failure=reason as {code?:string;message?:string};
 const messages:Record<string,string>={
  SYMLINK_UNSUPPORTED:'Choose regular files or folders. Symbolic links are not imported.',
  UNSUPPORTED_FILE:'Choose regular files or folders. Special and hardlinked files are not supported.',
  UNSAFE_FILE:'Choose regular files or folders. Special and hardlinked files are not supported.',
  PRIVATE_SOURCE_UNSUPPORTED:'Private application or state folders cannot be imported. Choose ordinary files or folders.',
  NO_IMPORTABLE_FILES:'No importable files remain after Git and application metadata are omitted.',
  IMPORT_TICKET_EXPIRED:'The file selection expired. Drop the files or choose them again.',
  INVALID_PATH:'The source or destination path is not supported. Choose regular files and an existing repository folder.',
  LIMIT_EXCEEDED:'This import exceeds the item count, folder depth or path limits. Choose fewer items or a shallower folder.',
  CONFLICT:'A source or destination changed during import. Check the files and try again.',
 };
 return messages[failure?.code??'']??failure?.message??'The files could not be imported. Try again.';
}
export function remapPath(path: string, moves: readonly PathMove[]) {
 const match = moves.find(move => insidePath(path, move.from));
 return match ? match.to + path.slice(match.from.length) : path;
}
/** A path move never saves or rebuilds a CM6 buffer; identity and undo stay intact. */
export function remapSessions(sessions: Iterable<FileSession>, moves: readonly PathMove[]) {
 for (const session of sessions) {
  if (session.isNew) continue; // An unsaved filename is a proposal, not a filesystem entry.
  session.path = remapPath(session.path, moves);
  session.proposedPath = remapPath(session.proposedPath, moves);
 }
}
/** Restored drafts rejoin the live set before later path moves can occur. */
export function restoreRetainedSessions(sessions: Map<string, FileSession>, trashed: Map<string, FileSession>, paths: readonly string[]) {
 for (const [id, session] of trashed) {
  if (!paths.some(path => insidePath(session.path, path))) continue;
  sessions.set(id, session);
  trashed.delete(id);
 }
}
export function uniqueCopyPath(path: string, type: 'file'|'directory', occupied: ReadonlySet<string>) {
 const parent = parentPath(path), name = fileName(path), dot = type === 'file' ? name.lastIndexOf('.') : -1;
 const stem = dot > 0 ? name.slice(0,dot) : name, extension = dot > 0 ? name.slice(dot) : '';
 let index=1, candidate='';
 do { candidate = `${parent ? parent+'/' : ''}${stem} copy${index===1?'':' '+index}${extension}`; index++; } while (occupied.has(candidate));
 return candidate;
}
