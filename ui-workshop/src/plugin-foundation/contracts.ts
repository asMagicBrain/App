/** Stage 2 is a trusted bundled-module API, not an execution sandbox or an installer. */
export const PLUGIN_HOST_API_VERSION = 1 as const;
export const PLUGIN_MANIFEST_VERSION = 1 as const;
export const PLUGIN_CAPABILITIES = ['document.read', 'document.edit'] as const;
export type PluginCapability = typeof PLUGIN_CAPABILITIES[number];
export type PluginContributionKind = 'command' | 'editor-tool' | 'reader-view' | 'navigation';
export type PluginContribution = Readonly<{
  id: string; kind: PluginContributionKind; title: string; commandId?: string;
}>;
export type PluginManifest = Readonly<{
  schemaVersion: 1; id: string; name: string; version: string;
  hostApi: Readonly<{min: number; max: number}>;
  capabilities: readonly PluginCapability[]; contributions: readonly PluginContribution[];
}>;
export type PluginErrorCode =
  | 'INVALID_MANIFEST' | 'INCOMPATIBLE' | 'MISSING_PLUGIN' | 'DISABLED' | 'DUPLICATE'
  | 'CAPABILITY_UNSUPPORTED' | 'DENIED' | 'STALE' | 'READ_ONLY' | 'CONFLICT' | 'COMPOSING'
  | 'CANCELLED' | 'REVOKED' | 'INVALID_REQUEST' | 'LIMIT' | 'RUNTIME_FAILURE' | 'CLOSED';
const errorMessages: Record<PluginErrorCode, string> = {
  INVALID_MANIFEST: 'This plugin manifest is not supported.', INCOMPATIBLE: 'This plugin requires a different host API version.',
  MISSING_PLUGIN: 'This plugin is not available.', DISABLED: 'Enable this plugin to use its commands.',
  DUPLICATE: 'This plugin or contribution is already registered.', CAPABILITY_UNSUPPORTED: 'This host operation is not supported.',
  DENIED: 'This plugin has not been granted this operation.', STALE: 'The document changed. Review it and try again.',
  READ_ONLY: 'This document is read-only.', CONFLICT: 'Resolve the document conflict before editing.',
  COMPOSING: 'Finish text composition before using this command.',
  CANCELLED: 'This operation was cancelled.', REVOKED: 'This operation is no longer available.',
  INVALID_REQUEST: 'This operation request is not valid.', LIMIT: 'This operation exceeds the supported limit.',
  RUNTIME_FAILURE: 'The plugin could not complete this operation.', CLOSED: 'The plugin host is closed.',
};
export type PluginError = Readonly<{code: PluginErrorCode; message: string; operationId: string}>;
export type PluginResult<T> = Readonly<{ok: true; value: T}> | Readonly<{ok: false; error: PluginError}>;
export function pluginFailure(code: PluginErrorCode, operationId: string): PluginResult<never> {
  return Object.freeze({ok: false, error: Object.freeze({code, message: errorMessages[code], operationId})});
}
/** Only this bounded error type is carried across the adapter; raw error messages are never published. */
export class PluginOperationError extends Error {
  readonly code: PluginErrorCode;
  constructor(code: PluginErrorCode) { super(errorMessages[code]); this.name = 'PluginOperationError'; this.code = code; }
}
export type PluginDocumentSnapshot = Readonly<{
  repositoryId: string; revision: string; sessionId: string; path: string; sourceHash: string | null;
  version: number; readOnly: boolean; conflict: boolean;
}>;
export type PluginTextChange = Readonly<{from: number; to: number; insert: string}>;
export type PluginEdit = Readonly<{changes: readonly PluginTextChange[]; selection?: Readonly<{anchor: number; head: number}>}>;
export type PluginHostRequest = Readonly<{
  operationId: string; pluginId: string; capability: PluginCapability;
  expected: PluginDocumentSnapshot; payload?: PluginEdit;
}>;
export interface PluginHostAdapter {
  getSnapshot(): PluginDocumentSnapshot | null;
  /** Recheck expected identity/version/status and signal at the mutation boundary; never retry a mutation. */
  perform(request: PluginHostRequest, signal: AbortSignal): Promise<unknown>;
}
export type PluginDisposable = () => void;
export type PluginCapabilityLease = Readonly<{
  signal: AbortSignal; request(payload?: PluginEdit): Promise<PluginResult<unknown>>; revoke(): void;
}>;
export type PluginCommandContext = Readonly<{signal: AbortSignal; document: PluginDocumentSnapshot | null}>;
export type PluginCommandHandler = (context: PluginCommandContext) => unknown | Promise<unknown>;
export interface PluginContext {
  readonly manifest: PluginManifest;
  readonly signal: AbortSignal;
  readonly document: {
    snapshot(): PluginDocumentSnapshot | null;
    read(expected: PluginDocumentSnapshot): Promise<PluginResult<unknown>>;
    edit(expected: PluginDocumentSnapshot, payload: PluginEdit): Promise<PluginResult<unknown>>;
  };
  registerCommand(id: string, handler: PluginCommandHandler): PluginDisposable;
  addDisposable(dispose: PluginDisposable): PluginDisposable;
  acquire(capability: PluginCapability, expected: PluginDocumentSnapshot): PluginCapabilityLease;
  run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
}
export interface BundledPlugin {
  activate(context: PluginContext): void | PluginDisposable | Promise<void | PluginDisposable>;
}
export type PluginState = 'disabled' | 'enabling' | 'enabled' | 'incompatible' | 'failed';
export type PluginStatus = Readonly<{manifest: PluginManifest; state: PluginState; error?: PluginError}>;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const validId = (value: unknown): value is string => boundedText(value, 100) && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(value);

/** Validate and detach manifest data. No entry path, URL, executable or extra property is admitted. */
export function validatePluginManifest(value: unknown, operationId = 'manifest'): PluginResult<PluginManifest> {
  const invalid = () => pluginFailure('INVALID_MANIFEST', operationId);
  if (!isRecord(value) || !hasKeys(value, ['schemaVersion', 'id', 'name', 'version', 'hostApi', 'capabilities', 'contributions'])
    || value.schemaVersion !== 1 || !validId(value.id) || !boundedText(value.name, 80)
    || typeof value.version !== 'string' || value.version.length > 40 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version)
    || !isRecord(value.hostApi) || !hasKeys(value.hostApi, ['min', 'max'])
    || !Number.isSafeInteger(value.hostApi.min) || !Number.isSafeInteger(value.hostApi.max)
    || (value.hostApi.min as number) < 1 || (value.hostApi.max as number) < (value.hostApi.min as number)
    || !Array.isArray(value.capabilities) || value.capabilities.length > PLUGIN_CAPABILITIES.length
    || value.capabilities.some(capability => !PLUGIN_CAPABILITIES.includes(capability))
    || new Set(value.capabilities).size !== value.capabilities.length
    || !Array.isArray(value.contributions) || value.contributions.length > 32) return invalid();
  const contributions: PluginContribution[] = [];
  for (const item of value.contributions) {
    if (!isRecord(item) || !hasKeys(item, ['id', 'kind', 'title', 'commandId']) || !validId(item.id)
      || !item.id.startsWith(`${value.id}.`) || !boundedText(item.title, 80)
      || !['command', 'editor-tool', 'reader-view', 'navigation'].includes(item.kind as string)
      || (item.kind === 'command' && item.commandId !== undefined)
      || (item.kind !== 'command' && (!validId(item.commandId) || !item.commandId.startsWith(`${value.id}.`)))) return invalid();
    contributions.push(Object.freeze({id: item.id, kind: item.kind as PluginContributionKind, title: item.title,
      ...(item.commandId !== undefined ? {commandId: item.commandId as string} : {})}));
  }
  if (new Set(contributions.map(item => item.id)).size !== contributions.length
    || contributions.some(item => item.commandId && !contributions.some(command => command.kind === 'command' && command.id === item.commandId))) return invalid();
  return {ok: true, value: Object.freeze({schemaVersion: 1, id: value.id, name: value.name, version: value.version,
    hostApi: Object.freeze({min: value.hostApi.min as number, max: value.hostApi.max as number}),
    capabilities: Object.freeze([...value.capabilities]) as readonly PluginCapability[], contributions: Object.freeze(contributions)})};
}

export function samePluginDocument(a: PluginDocumentSnapshot, b: PluginDocumentSnapshot, includeVersion = true): boolean {
  return a.repositoryId === b.repositoryId && a.revision === b.revision && a.sessionId === b.sessionId && a.path === b.path
    && (!includeVersion || (a.version === b.version && a.sourceHash === b.sourceHash && a.readOnly === b.readOnly && a.conflict === b.conflict));
}
export function validatePluginEdit(value: unknown): value is PluginEdit {
  if (!isRecord(value) || !hasKeys(value, ['changes', 'selection']) || !Array.isArray(value.changes) || value.changes.length < 1 || value.changes.length > 128) return false;
  let end = 0; let inserted = 0;
  for (const change of value.changes) {
    if (!isRecord(change) || !hasKeys(change, ['from', 'to', 'insert']) || !Number.isSafeInteger(change.from)
      || !Number.isSafeInteger(change.to) || (change.from as number) < end || (change.to as number) < (change.from as number)
      || typeof change.insert !== 'string') return false;
    end = change.to as number; inserted += change.insert.length;
    if (inserted > 1024 * 1024) return false;
  }
  return value.selection === undefined || (isRecord(value.selection) && hasKeys(value.selection, ['anchor', 'head'])
    && Number.isSafeInteger(value.selection.anchor) && Number.isSafeInteger(value.selection.head)
    && (value.selection.anchor as number) >= 0 && (value.selection.head as number) >= 0);
}
