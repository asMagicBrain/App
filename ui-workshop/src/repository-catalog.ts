import {getNativeBridge, nativeOperation} from './native-bridge.mjs';
import type {ClonedRepository, GitHubCloneInput, GitHubCloneProgress} from './native-types';

export type RepositoryCatalogEntry = {stableId?:string; name: string; privateRepo: boolean; builtin?: 'documentation'; readOnly?: boolean};
export type RepositoryCatalog = {
  capability?: string;
  organization: 'asMagicBrain';
  defaultRepository?: string;
  repositories: RepositoryCatalogEntry[];
  limits: {archiveBytes: number; expandedBytes?: number; memberBytes?: number; extractedEntries?: number; pathDepth?: number};
};
export type ImportedRepository = {
  name: string;
  head: string;
  files: number;
  bytes: number;
  excludedEntries: number;
  organization: 'asMagicBrain';
};
export type CreatedRepository = {
  name: string;
  organization: 'asMagicBrain';
  head: null;
  files: 0;
  bytes: 0;
};

export function repositoryCreationError(reason: unknown): string {
  const messages: Record<string, string> = {
    NAME_EXISTS: 'A repository or folder with this name already exists. Choose another name.',
    INVALID_REPOSITORY_NAME: 'This repository name is not supported. Choose another name.',
    INVALID_REQUEST: 'The repository request is invalid. Close this dialog and try again.',
    REQUEST_CONFLICT: 'This request already belongs to another repository. Close this dialog and try again.',
    IMPORT_BUSY: 'Another repository operation is still running. Wait for it to finish, then try again.',
    RECOVERY_REQUIRED: 'Repository creation needs recovery. Close and reopen asMagicBrain before trying again. Existing files will be preserved.',
    ENOSPC: 'There is not enough free space to create the repository. Free up space, then try again.',
    EDQUOT: 'The workspace has reached its storage quota. Make space available, then try again.',
    EACCES: 'asMagicBrain cannot write to the workspace. Check its folder permissions, then try again.',
    EPERM: 'asMagicBrain cannot write to the workspace. Check its folder permissions, then try again.',
    EROFS: 'The workspace is on a read-only drive. Make it writable, then try again.',
    EIO: 'The drive could not complete the write. Check the drive connection before trying again.',
    SERVICE_CLOSED: 'The application is closing. Reopen it to create a repository.',
  };
  const code = reason && typeof reason === 'object' && 'code' in reason ? String(reason.code) : '';
  return messages[code] ?? (reason instanceof Error ? reason.message : 'The repository could not be created. Please try again.');
}

function requestFailure(body: {error?: {code?: string; message?: string}} | null, status: number) {
  return Object.assign(new Error(body?.error?.message || `Repository request failed (${status}).`), {
    code: body?.error?.code || 'REPOSITORY_IMPORT_UNAVAILABLE',
  });
}

async function readResponse(response: Response) {
  try { return await response.json(); }
  catch { throw new Error('The local repository service is unavailable. Retry when it is running.'); }
}

export async function loadRepositoryCatalog(transport?: typeof fetch, signal?: AbortSignal): Promise<RepositoryCatalog> {
  const bridge = transport ? undefined : getNativeBridge();
  if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
  const response = bridge ? null : await (transport ?? fetch)('/__repository-import', {cache: 'no-store', signal});
  const body = bridge ? await nativeOperation(() => bridge.catalog()) : await readResponse(response!);
  if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
  if (response && !response.ok) throw requestFailure(body, response.status);
  if (body?.organization !== 'asMagicBrain' || (!bridge && (typeof body.capability !== 'string' || !body.capability)) ||
      !Array.isArray(body.repositories) || !body.repositories.every((item: RepositoryCatalogEntry) =>
        item && typeof item.name === 'string' && typeof item.privateRepo === 'boolean') ||
      !Number.isSafeInteger(body.limits?.archiveBytes) || body.limits.archiveBytes <= 0) {
    throw new Error('The local repository catalog is unavailable.');
  }
  return body as RepositoryCatalog;
}

export function suggestRepositoryName(filename: string): string {
  return filename.replace(/\.zip$/i, '').replace(/-(?:main|master)$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '').slice(0, 100);
}

export function validateRepositoryName(name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
    return 'Use 1–100 letters, numbers, dots, hyphens or underscores, starting with a letter or number.';
  }
  if (name.endsWith('.')) return 'Repository names cannot end with a dot.';
  return null;
}

/** Creation stays inside the native managed workspace; it does not create a commit. */
export async function createLocalRepository({name, requestId}: {name: string; requestId: string}): Promise<CreatedRepository> {
  const invalidName = validateRepositoryName(name);
  if (invalidName) throw new Error(invalidName);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new Error('The repository request is invalid. Close this dialog and try again.');
  }
  const bridge = getNativeBridge();
  if (!bridge?.createRepository) throw Object.assign(new Error('Creating repositories requires the current native application.'), {code: 'CREATE_UNAVAILABLE'});
  const value = await nativeOperation(() => bridge.createRepository({name, requestId}));
  if (value?.name !== name || value?.organization !== 'asMagicBrain' || value.head !== null || value.files !== 0 || value.bytes !== 0) {
    throw Object.assign(new Error('The new repository response could not be verified. Check the repository list before retrying.'), {code: 'CREATE_UNVERIFIED'});
  }
  return value;
}

/** The host owns extraction, managed storage and the initial local Git commit. */
export async function importRepositoryArchive(file: File, name: string, catalog: RepositoryCatalog,
  transport?: typeof fetch): Promise<ImportedRepository> {
  const invalidName = validateRepositoryName(name);
  if (invalidName) throw new Error(invalidName);
  if (!/\.zip$/i.test(file.name)) throw new Error('Choose a ZIP archive.');
  if (file.size === 0) throw new Error('This ZIP archive is empty. Choose another file.');
  if (file.size > catalog.limits.archiveBytes) throw new Error('This ZIP archive exceeds the import size limit.');
  const bridge = transport ? undefined : getNativeBridge();
  if (bridge) {
    const value = await nativeOperation(async () => bridge.importArchive({name, bytes: await file.arrayBuffer()}));
    if (value?.name !== name || value?.organization !== 'asMagicBrain') throw new Error('The import response could not be verified. Check the repository list before retrying.');
    return value;
  }
  if (!catalog.capability) throw new Error('The local repository service is unavailable. Refresh the repository list.');
  const response = await (transport ?? fetch)(`/__repository-import?${new URLSearchParams({name})}`, {
    method: 'POST', headers: {'Content-Type': 'application/zip', 'X-asMagicBrain-Capability': catalog.capability},
    body: file, cache: 'no-store',
  });
  const body = await readResponse(response);
  if (!response.ok || body?.ok !== true) throw requestFailure(body, response.status);
  if (body.value?.name !== name || body.value?.organization !== 'asMagicBrain') {
    throw new Error('The import response could not be verified. Check the repository list before retrying.');
  }
  return body.value as ImportedRepository;
}

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const githubUrlPattern = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i;

export function githubRepositoryName(url: string): string | null {
  if (typeof url !== 'string') return null;
  const match = githubUrlPattern.exec(url.trim());
  return match && !['.', '..'].includes(match[2]) ? match[2] : null;
}

export function githubCloneError(reason: unknown): string {
  const code = reason && typeof reason === 'object' && 'code' in reason ? String(reason.code) : '';
  const messages: Record<string, string> = {
    INVALID_GITHUB_URL: 'Enter a GitHub repository URL, such as https://github.com/owner/repository.',
    INVALID_REPOSITORY_NAME: 'This repository name is not supported. Choose another name.',
    NAME_EXISTS: 'A repository or folder with this name already exists. Choose another name.',
    CLONE_FAILED: 'Cloning could not complete. Check the repository URL and your connection, then try again.',
    CLONE_AUTH_REQUIRED: 'This repository needs GitHub access, or it could not be found. Check its URL and your connected account.',
    CLONE_CANCELLED: 'Cloning cancelled.',
    CLONE_UNSUPPORTED_ENTRY: 'This repository contains files that cannot be imported yet. Its local copy was not opened.',
    CLONE_LIMIT_EXCEEDED: 'This repository exceeds the current clone size or file-count limit. Its local copy was not opened.',
    CLONE_TIMEOUT: 'Cloning took too long. Check your connection and try again.',
    CLONE_EMPTY_OR_UNSUPPORTED: 'This repository has an unsupported default revision and could not be cloned.',
    GIT_UNAVAILABLE: 'Git is unavailable on this computer. Install Git, then reopen asMagicBrain.',
    GIT_EXECUTABLE_CHANGED: 'Git changed while cloning. Reopen asMagicBrain before trying again.',
    GITHUB_BUSY: 'The GitHub connection is busy. Wait for it to finish, then try again.',
    INVALID_CREDENTIAL: 'The GitHub connection could not be used. Disconnect and connect your account again.',
    REQUEST_CONFLICT: 'This request belongs to a different repository. Close this dialog and try again.',
    CLONE_BUSY: 'Another clone is still running. Wait for it to finish, then try again.',
    IMPORT_BUSY: 'Another repository operation is still running. Wait for it to finish, then try again.',
    ENOSPC: 'There is not enough free space to clone this repository. Free up space, then try again.',
    EACCES: 'asMagicBrain cannot write to the workspace. Check its folder permissions, then try again.',
    EPERM: 'asMagicBrain cannot write to the workspace. Check its folder permissions, then try again.',
    RECOVERY_REQUIRED: 'Repository import needs recovery. Close and reopen asMagicBrain before trying again. Existing files will be preserved.',
  };
  return messages[code] ?? (reason instanceof Error ? reason.message : 'Cloning could not complete. Check your connection and try again.');
}

export async function cloneGitHubRepository({url, name, requestId, useAccount}: GitHubCloneInput): Promise<ClonedRepository> {
  url = url.trim();
  if (!githubRepositoryName(url)) throw Object.assign(new Error(githubCloneError({code: 'INVALID_GITHUB_URL'})), {code: 'INVALID_GITHUB_URL'});
  const invalidName = validateRepositoryName(name);
  if (invalidName) throw new Error(invalidName);
  if (!requestIdPattern.test(requestId) || typeof useAccount !== 'boolean') throw new Error('The clone request is invalid. Close this dialog and try again.');
  const bridge = getNativeBridge();
  if (!bridge?.cloneRepository) throw Object.assign(new Error('Cloning requires the current native application.'), {code: 'CLONE_UNAVAILABLE'});
  const result = await nativeOperation(() => bridge.cloneRepository({url, name, requestId, useAccount}));
  const canonicalUrl = (value: string) => value.replace(/\/$/, '').replace(/\.git$/i, '').toLowerCase();
  if (result?.name !== name || result?.organization !== 'asMagicBrain' ||
      (result.head !== null && !/^[0-9a-f]{40,64}$/.test(result.head)) || typeof result.branch !== 'string' ||
      !githubRepositoryName(result.sourceUrl) || canonicalUrl(result.sourceUrl) !== canonicalUrl(url) || !Number.isSafeInteger(result.files) || result.files < 0 ||
      !Number.isSafeInteger(result.bytes) || result.bytes < 0) {
    throw Object.assign(new Error('The clone response could not be verified. Check the repository list before retrying.'), {code: 'CLONE_UNVERIFIED'});
  }
  return result;
}

export async function getGitHubCloneProgress(requestId: string): Promise<GitHubCloneProgress | null> {
  const bridge = getNativeBridge();
  if (!bridge?.getCloneProgress) return null;
  return nativeOperation(() => bridge.getCloneProgress({requestId}));
}

export async function cancelGitHubClone(requestId: string): Promise<void> {
  const bridge = getNativeBridge();
  if (!bridge?.cancelClone) throw new Error('Cancellation is unavailable. Wait for the current clone to finish.');
  await nativeOperation(() => bridge.cancelClone({requestId}));
}
