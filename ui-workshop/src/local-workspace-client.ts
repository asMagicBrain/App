import {getNativeBridge, nativeOperation} from './native-bridge.mjs';

export type WorkspaceEntry = {path: string; type: 'file' | 'directory'; name?: string};
export type WorkspaceDocument = {
  path: string; documentId: string; sourceHash: string | null; text: string | null;
  readOnly: boolean; encoding?: string; recoveryRequired?: boolean; conflict?: boolean;
  draft?: {text: string; baseHash: string} | null;
};
export type NewWorkspaceDraft = {draftId: string; path: string; text: string};
export type WorkspaceBootstrap = {capability?: string; local: true; readOnly?: boolean; newDrafts?: NewWorkspaceDraft[]};
export type GitReview = {
  expectedHead: string | null; expectedIndexHash: string | null; head?: string | null; branch?: string;
  files: {path: string; expectedSourceHash: string | null; expectedSourceMode: string | null; beforeMode?: string | null; afterMode?: string | null; status: string; before: string | null; after: string | null; binary: boolean; previewOmitted?: boolean; beforeSize?: number|null; afterSize?: number|null}[];
  staged?: unknown; recoveryRequired?: boolean;
};
export type LocalWorkspaceClient = {
  bootstrap(): Promise<WorkspaceBootstrap>;
  request<T = unknown>(operation: string, args?: Record<string, unknown>): Promise<T>;
};

/** The UI depends only on this adapter. Native IPC can implement the same seam. */
export function createLocalWorkspaceClient(repo: string, transport?: typeof fetch): LocalWorkspaceClient {
  const bridge = transport ? undefined : getNativeBridge();
  if (bridge) return {
    bootstrap: () => nativeOperation(() => bridge.bootstrap(repo)),
    request: <T,>(operation: string, args: Record<string, unknown> = {}) => nativeOperation(() => bridge.request({repo, operation, args})) as Promise<T>,
  };
  const http = transport ?? fetch;
  let bootstrap: Promise<WorkspaceBootstrap> | null = null;
  const failure = (body: {error?: {code?: string; message?: string}}, status: number) => Object.assign(
    new Error(body.error?.message || `Local workspace request failed (${status}).`),
    {code: body.error?.code || 'LOCAL_WORKSPACE_UNAVAILABLE'},
  );
  const connect = () => {
    if (!bootstrap) bootstrap = http(`/__local-workspace?${new URLSearchParams({repo})}`, {cache: 'no-store'})
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw failure(body, response.status);
        if (typeof body.capability !== 'string' || body.local !== true) throw new Error('Local workspace is unavailable.');
        return body as WorkspaceBootstrap;
      }).catch(error => {bootstrap = null; throw error;});
    return bootstrap;
  };
  return {
    bootstrap: connect,
    async request<T>(operation: string, args: Record<string, unknown> = {}) {
      const {capability} = await connect();
      if (!capability) throw new Error('Local workspace is unavailable.');
      const response = await http('/__local-workspace', {
        method: 'POST', headers: {'Content-Type': 'application/json', 'X-asMagicBrain-Capability': capability},
        body: JSON.stringify({repo, operation, args}), cache: 'no-store',
      });
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw failure(body, response.status);
      return body.value as T;
    },
  };
}
