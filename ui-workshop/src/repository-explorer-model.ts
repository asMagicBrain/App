export type ExplorerEntry = {path: string; type: 'file' | 'directory'};
export type ExplorerNode = ExplorerEntry & {id: string; name: string; children?: ExplorerNode[]};
export type ExplorerCommand = 'new-file' | 'new-folder' | 'import-files' | 'duplicate' | 'cut' | 'copy' | 'paste' | 'move' | 'copy-path' | 'trash' | 'restore-trash';
export type ExplorerClipboard = {mode: 'cut' | 'copy'; paths: string[]};

export const parentPath = (path: string) => path.split('/').slice(0, -1).join('/');
const validPath = (path: string) => Boolean(path) && !path.startsWith('/') && !/[\\\u0000-\u001f]/u.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');

/** Missing ancestors may be unloaded directories in a historical revision. */
export function buildExplorerTree(entries: readonly ExplorerEntry[]): ExplorerNode[] {
  const nodes = new Map<string, ExplorerNode>();
  for (const entry of entries) {
    if (!validPath(entry.path)) continue;
    nodes.set(entry.path, {...entry, id: entry.path, name: entry.path.split('/').at(-1)!, ...(entry.type === 'directory' ? {children: []} : {})});
  }
  for (const path of [...nodes.keys()]) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/');
      if (!nodes.has(parent)) nodes.set(parent, {id: parent, path: parent, name: parts[index - 1], type: 'directory', children: []});
    }
  }
  const root: ExplorerNode[] = [];
  for (const node of nodes.values()) {
    const parent = parentPath(node.path);
    if (!parent) root.push(node);
    else nodes.get(parent)?.children?.push(node);
  }
  const sort = (list: ExplorerNode[]) => {
    list.sort((a, b) => (a.type === b.type ? 0 : a.type === 'directory' ? -1 : 1) || a.name.localeCompare(b.name));
    for (const node of list) if (node.children) sort(node.children);
  };
  sort(root);
  return root;
}

/** A selected folder already includes its selected descendants in host operations. */
export function selectedRoots(paths: readonly string[]): string[] {
  const unique = new Set(paths.filter(validPath));
  return [...unique].filter(path => {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) if (unique.has(parts.slice(0, index).join('/'))) return false;
    return true;
  });
}

export function canMoveSelection(paths: readonly string[], destination: string): boolean {
  const roots = selectedRoots(paths);
  return (destination === '' || validPath(destination)) && roots.length > 0 && roots.every(path =>
    destination !== path && !destination.startsWith(`${path}/`) && parentPath(path) !== destination);
}

/** UI feedback is advisory; the host rechecks source tokens and collisions. */
export function moveSelectionProblem(paths: readonly string[], destination: string, entries: ReadonlyMap<string, ExplorerEntry>): string | null {
  const roots = selectedRoots(paths);
  if (!roots.length || roots.some(path => !entries.has(path))) return 'The dragged selection is no longer available.';
  if (destination !== '' && entries.get(destination)?.type !== 'directory') return 'Choose an existing destination folder.';
  if (roots.some(path => path === destination || destination.startsWith(path + '/'))) return 'A folder cannot move into itself.';
  if (roots.some(path => parentPath(path) === destination)) return 'An item is already in this folder.';
  const targets = new Set<string>();
  for (const path of roots) {
    const target = [destination, path.split('/').at(-1)!].filter(Boolean).join('/');
    if (targets.has(target) || entries.has(target)) return 'An item with that name is already in the destination.';
    targets.add(target);
  }
  return null;
}

export type DirectDropHover = {dragId: string; destination: string};
/** Only the current drag may override the backend's deferred visual target. */
export function activeDirectDropDestination(hover: DirectDropHover | null, dragId: string | null | undefined): string | null {
  return dragId && hover?.dragId === dragId ? hover.destination : null;
}

/** Match Arborist's unambiguous folder center; edges/files retain its insertion semantics. */
export function directFolderDropDestination(path: string | null, offsetY: number, height: number, entries: ReadonlyMap<string, ExplorerEntry>): string | null {
  if (!path || !Number.isFinite(offsetY) || !Number.isFinite(height) || height <= 0 || offsetY <= height / 4 || offsetY >= height * 3 / 4) return null;
  return entries.get(path)?.type === 'directory' ? path : null;
}

/** Finder drops over files copy beside them; blank space explicitly means root. */
export function externalDropDestination(path: string | null, entries: ReadonlyMap<string, ExplorerEntry>): string | null {
  if (path === null || path === '') return '';
  const entry = entries.get(path);
  return !entry ? null : entry.type === 'directory' ? entry.path : parentPath(entry.path);
}

export function renameProblem(name: string): string | null {
  if (!name || name === '.' || name === '..' || /[/\\\u0000-\u001f]/u.test(name)) return 'Enter a name without slashes or control characters.';
  return null;
}
