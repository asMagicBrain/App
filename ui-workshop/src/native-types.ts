import type {RepositoryCatalog, ImportedRepository, CreatedRepository} from './repository-catalog';
import type {WorkspaceBootstrap} from './local-workspace-client';

export type RepositoryPins = {defaultRepository: string; pinnedRepositories: string[]};
export type RepositoryFileInventory = {requestId: string; repo: string; ref: string; commit: string | null; paths: string[]; truncated: boolean; reason?: 'limit' | 'timeout'};
export type RepositoryTextMatch = {repo: string; path: string; line: number; column: number; endColumn: number; lineText: string; sourceHash?: string};
/** Positions are one-based UTF-16 columns, matching the saved line, never a live draft. */
export type RepositoryTextSearch = {requestId: string; matches: RepositoryTextMatch[]; truncated: boolean; reason?: 'limit' | 'timeout'; searchedFiles: number; skippedFiles: number};
export type NativeAppearance = {themeId: string | null; hideUnavailable: boolean};
export type NativeBuildConfiguration =
  | {channel: 'development'; presentation: 'full-with-grey'; canToggleUnavailable: true; validationOnly: false}
  | {channel: 'preview'; presentation: 'implemented-only'; canToggleUnavailable: false; validationOnly: false};
export type NativeRepositoryAsset = {mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'video/webm' | 'video/mp4'; data: ArrayBuffer};
export type RepositoryManagementResult = {repository: string; organization: 'asMagicBrain'; defaultRepository: string; repositories: RepositoryCatalog['repositories']};
export type DuplicatedRepository = RepositoryManagementResult & {sourceRepository: string};
export type TrashedRepository = RepositoryManagementResult & {trashId: string};
export type RepositoryTrashEntry = {trashId: string; name: string; trashedAt: string};
export type RenamedRepository = {repository: string; previousName: string; organization: 'asMagicBrain'; defaultRepository: string; repositories: RepositoryCatalog['repositories']};
export type ExternalFileTicket = {ticket: string; expiresAt: number; entries: {name: string; kind: 'file' | 'directory'}[]};
export type ExternalFileImport = {status: 'completed'; operation: 'import'; importedPaths: string[]; changedPaths: string[]; skippedMetadata: number; pathMoves: []; createdDirectories: string[]; items: {path: string; newPath: string}[]};
export type ClonedRepository = {name: string; organization: 'asMagicBrain'; head: string | null; files: number; bytes: number; branch: string; sourceUrl: string};
export type GitHubCloneInput = {url: string; name: string; requestId: string; useAccount: boolean};
export type GitHubCloneProgress = {phase: 'connecting' | 'receiving' | 'checking' | 'publishing' | 'complete' | 'cancelled' | 'failed'; message?: string};
export type GitHubAccount = {id: number; username: string; displayName?: string; email: string | null};
export type ApplicationAccount = {id: string; displayName: string; email: string | null; github?: {id: string; username: string | null}};
export type ApplicationAccountState = {configured: boolean; providers: {github: boolean; email: boolean}; persistence?: 'session' | 'device'; state: 'signed-out' | 'signed-in' | 'offline' | 'expired' | 'unavailable'; account?: ApplicationAccount; error?: string; notice?: string};
export type ApplicationSignInInput = {method: 'github'} | {method: 'email'; email: string};
export type ApplicationAuthorization = {requestId: string; state: 'awaiting-browser' | 'awaiting-email'; expiresAt: number; error?: string};
export type ApplicationAuthorizationResult = ApplicationAuthorization | {requestId: string; state: 'signed-in'; account: ApplicationAccount} | {requestId: string; state: 'failed' | 'expired' | 'cancelled'; error?: string};
export type GitHubConnection = {configured: boolean; persistence?: 'session' | 'device'; state: 'signed-out' | 'connected' | 'expired' | 'unavailable'; account?: GitHubAccount; error?: string};
export type GitHubAuthorization = {requestId: string; state: 'awaiting-authorization'; userCode: string; verificationUri: 'https://github.com/login/device'; expiresAt: number; pollInterval: number};
export type GitHubAuthorizationResult = GitHubAuthorization | {requestId: string; state: 'connected'; account: GitHubAccount} | {requestId: string; state: 'failed' | 'expired' | 'cancelled'; error?: string};
export type RepositoryUpdatePath = {path: string; status: 'added' | 'modified' | 'deleted' | 'type-changed'};
export type RepositoryUpdateComparison = {
  checkId: string; sourceUrl: string; branch: string; checkedAt: number; localHead: string | null; remoteHead: string | null;
  relation: 'up-to-date' | 'remote-ahead' | 'local-ahead' | 'diverged' | 'unrelated' | 'remote-branch-missing' | 'local-empty';
  ahead: number | null; behind: number | null; stale: boolean; files: RepositoryUpdatePath[]; totalFiles: number; truncated: boolean;
};
export type RepositoryUpdates = {eligible: boolean; reason?: string; sourceUrl?: string; branch?: string; lastCheck?: RepositoryUpdateComparison};
export type RepositoryUpdateProgress = {phase: 'connecting' | 'receiving' | 'comparing' | 'complete' | 'cancelled' | 'failed'};
export type RepositoryUpdateReview = {
  checkId: string; reviewId: string | null; canApply: boolean; reason?: string;
  localHead: string | null; remoteHead: string | null; branch: string;
  totalFiles: number; behind: number | null; expiresAt: number | null; dirtyFileCount: number; draftCount: number;
};
export type RepositoryUpdateApplyInput = {repo: string; checkId: string; reviewId: string; requestId: string};
export type RepositoryUpdateApplied = {status: 'applied'; requestId: string; checkId: string; previousHead: string; head: string; branch: string};
export type RepositoryApplyProgress = {requestId: string; phase: 'preparing' | 'applying' | 'complete' | 'failed'};
export type RepositoryUpdateFile = RepositoryUpdatePath & {
  checkId: string;
  beforeMode: string | null; afterMode: string | null; unsupported: boolean; previewOmitted: boolean; binary: boolean;
  beforeSize: number | null; afterSize: number | null; before: string | null; after: string | null;
};
export type NativeBridge = {
  readonly native: true;
  catalog(): Promise<RepositoryCatalog>;
  read(input: {repo: string; path: string; ref: string}): Promise<unknown>;
  readAsset(input: {repo: string; path: string; ref: string}): Promise<NativeRepositoryAsset>;
  revealItem(input: {repo: string; path: string; ref?: string}): Promise<void>;
  bootstrap(repo: string): Promise<WorkspaceBootstrap>;
  request(input: {repo: string; operation: string; args: Record<string, unknown>}): Promise<unknown>;
  importArchive(input: {name: string; bytes: ArrayBuffer}): Promise<ImportedRepository>;
  createRepository(input: {name: string; requestId: string}): Promise<CreatedRepository>;
  cloneRepository(input: GitHubCloneInput): Promise<ClonedRepository>;
  getCloneProgress(input: {requestId: string}): Promise<GitHubCloneProgress | null>;
  cancelClone(input: {requestId: string}): Promise<void>;
  getGitHubConnection(): Promise<GitHubConnection>;
  startGitHubConnection(): Promise<GitHubAuthorization>;
  pollGitHubConnection(input: {requestId: string}): Promise<GitHubAuthorizationResult>;
  cancelGitHubConnection(input: {requestId: string}): Promise<void>;
  cancelPendingGitHubConnection(): Promise<void>;
  openGitHubVerification(input: {requestId: string}): Promise<void>;
  disconnectGitHub(): Promise<void>;
  getApplicationAccount(): Promise<ApplicationAccountState>;
  startApplicationSignIn(input: ApplicationSignInInput): Promise<ApplicationAuthorizationResult>;
  pollApplicationSignIn(input: {requestId: string}): Promise<ApplicationAuthorizationResult>;
  verifyApplicationEmail(input: {requestId: string; token: string}): Promise<ApplicationAuthorizationResult>;
  cancelApplicationSignIn(input: {requestId: string}): Promise<ApplicationAuthorizationResult | void>;
  cancelPendingApplicationSignIn(): Promise<void>;
  refreshApplicationAccount(): Promise<ApplicationAccountState>;
  updateApplicationProfile(input: {displayName: string}): Promise<ApplicationAccountState>;
  signOutApplicationAccount(): Promise<ApplicationAccountState>;
  getRepositoryUpdates(input: {repo: string}): Promise<RepositoryUpdates>;
  checkRepositoryUpdates(input: {repo: string; requestId: string; useAccount: boolean}): Promise<RepositoryUpdateComparison>;
  getRepositoryUpdateProgress(input: {requestId: string}): Promise<RepositoryUpdateProgress | null>;
  cancelRepositoryUpdate(input: {requestId: string}): Promise<void>;
  readRepositoryUpdateFile(input: {repo: string; checkId: string; path: string}): Promise<RepositoryUpdateFile>;
  reviewRepositoryUpdate(input: {repo: string; checkId: string}): Promise<RepositoryUpdateReview>;
  applyRepositoryUpdate(input: RepositoryUpdateApplyInput): Promise<RepositoryUpdateApplied>;
  getRepositoryApplyProgress(input: {requestId: string}): Promise<RepositoryApplyProgress | null>;
  duplicateRepository(input: {repository: string; name: string; requestId: string}): Promise<DuplicatedRepository>;
  trashRepository(input: {repository: string; requestId: string}): Promise<TrashedRepository>;
  listTrashedRepositories(): Promise<RepositoryTrashEntry[]>;
  restoreRepository(input: {trashId: string; name: string}): Promise<RepositoryManagementResult>;
  renameRepository(input: {repository: string; name: string}): Promise<RenamedRepository>;
  prepareExternalFiles(files: File[]): Promise<ExternalFileTicket>;
  pickExternalFiles(): Promise<ExternalFileTicket | null>;
  importExternalFiles(input: {repo: string; destination: string; ticket: string}): Promise<ExternalFileImport>;
  cancelExternalFiles(input: {ticket: string}): Promise<void>;
  getRepositoryPins(): Promise<RepositoryPins>;
  setRepositoryPinned(input: {repo: string; pinned: boolean}): Promise<RepositoryPins>;
  listRepositoryFiles(input: {requestId: string; repo: string; ref?: string}): Promise<RepositoryFileInventory>;
  searchRepositoryText(input: {requestId: string; query: string; caseSensitive: boolean; repo: string | null; path?: string}): Promise<RepositoryTextSearch>;
  cancelRepositorySearch(input: {requestId: string}): Promise<void>;
  getBuildConfiguration(): Promise<NativeBuildConfiguration>;
  getAppearance(): Promise<NativeAppearance>;
  setAppearance(input: NativeAppearance): Promise<NativeAppearance>;
  windowAction(action: 'close' | 'minimize' | 'maximize'): Promise<void>;
  onPrepareClose(callback: (input: {requestId: string; cancelled?: boolean; error?: string}) => void): () => void;
  closeReady(input: {requestId: string; ok: boolean; error?: string}): void;
};

/** Plain data crossing Electron's isolated-world boundary; Errors are rebuilt
 * only in the renderer-facing NativeBridge adapter. */
export type NativeReply<T> = {ok:true;value:T}|{ok:false;error:{code:string;message:string}};
export type NativeWireBridge = {
  readonly native:true;
  readonly responseVersion:1;
} & {
  [Key in keyof NativeBridge]: NativeBridge[Key] extends (...args:infer Args)=>Promise<infer Result>
    ? (...args:Args)=>Promise<NativeReply<Result>> : NativeBridge[Key];
};

declare global {
  interface Window {asMagicBrain?: NativeWireBridge}
}
