import {
  PLUGIN_CAPABILITIES, PLUGIN_HOST_API_VERSION, PluginOperationError, pluginFailure, samePluginDocument,
  validatePluginEdit, validatePluginManifest,
} from './contracts.ts';
import type {
  BundledPlugin, PluginCapability, PluginCapabilityLease, PluginCommandHandler, PluginContext, PluginContribution,
  PluginDisposable, PluginDocumentSnapshot, PluginEdit, PluginErrorCode, PluginHostAdapter, PluginManifest, PluginResult, PluginStatus,
} from './contracts.ts';

type Scope = {
  controller: AbortController; commands: Map<string, PluginCommandHandler>; disposables: Set<PluginDisposable>;
  tasks: Set<AbortController>; leases: Set<AbortController>;
};
type Entry = {manifest: PluginManifest; module: BundledPlugin; status: PluginStatus; scope?: Scope; enabling?: Promise<PluginResult<PluginStatus>>};
const success = <T>(value: T): PluginResult<T> => ({ok: true, value});
const errorCode = (error: unknown): PluginErrorCode => error instanceof PluginOperationError ? error.code : 'RUNTIME_FAILURE';
const abortCode = (signal: AbortSignal) => errorCode(signal.reason);
const abort = (controller: AbortController, code: PluginErrorCode) => controller.abort(new PluginOperationError(code));
const copySnapshot = (snapshot: PluginDocumentSnapshot | null) => snapshot ? Object.freeze({...snapshot}) : null;

/** Cancellation stops admission and drops late results. Trusted tasks must still honor their signal. */
function cancellable<T>(signal: AbortSignal, task: () => T | Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, {once: true});
    Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason;
      return task();
    }).then(value => { if (signal.aborted) reject(signal.reason); else resolve(value); }, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export interface PluginRegistry {
  registerBundled(manifest: unknown, module: BundledPlugin): PluginResult<PluginStatus>;
  enable(pluginId: string): Promise<PluginResult<PluginStatus>>;
  disable(pluginId: string): PluginResult<PluginStatus>;
  invoke(commandId: string): Promise<PluginResult<unknown>>;
  snapshot(): readonly PluginStatus[];
  contributions(kind?: PluginContribution['kind']): readonly Readonly<PluginContribution & {pluginId: string}>[];
  subscribe(listener: () => void): PluginDisposable;
  /** Call before a document/repository/ref replacement becomes available to plugin work. */
  replaceDocument(): void;
  dispose(): void;
  diagnostics(): Readonly<{plugins: number; commands: number; tasks: number; leases: number; disposables: number; listeners: number; closed: boolean}>;
}

/** Only application-imported modules enter here. There is no module loader or imported-content execution path. */
export function createPluginRegistry({host, hostApiVersion = PLUGIN_HOST_API_VERSION, grants = {}}: {
  host: PluginHostAdapter; hostApiVersion?: number; grants?: Readonly<Record<string, readonly PluginCapability[]>>;
}): PluginRegistry {
  const entries = new Map<string, Entry>();
  // This admission decision is application-owned. A declaration never grants its own authority.
  const allowed = new Map(Object.entries(grants).map(([id, capabilities]) => [id, new Set(capabilities)]));
  const listeners = new Set<() => void>();
  const transitioning = new Set<string>();
  let closed = false; let replacingDocument = false; let sequence = 0;
  const operationId = () => `plugin-${++sequence}`;
  const notify = () => { for (const listener of [...listeners]) { try { listener(); } catch { /* One UI subscriber cannot fail another. */ } } };
  const status = (entry: Entry, state: PluginStatus['state'], code?: PluginErrorCode, id = operationId()) => {
    const failure = code ? pluginFailure(code, id) : undefined;
    entry.status = Object.freeze({manifest: entry.manifest, state, ...(failure && !failure.ok ? {error: failure.error} : {})});
    notify(); return entry.status;
  };
  const disposeScope = (entry: Entry) => {
    const scope = entry.scope; entry.scope = undefined; entry.enabling = undefined;
    if (!scope) return;
    abort(scope.controller, 'REVOKED');
    for (const lease of scope.leases) abort(lease, 'REVOKED');
    for (const task of scope.tasks) abort(task, 'CANCELLED');
    scope.leases.clear(); scope.tasks.clear(); scope.commands.clear();
    for (const dispose of [...scope.disposables].reverse()) { try { dispose(); } catch { /* Continue releasing every owned resource. */ } }
    scope.disposables.clear();
  };
  const fail = (entry: Entry, id: string) => {
    transitioning.add(entry.manifest.id);
    try { disposeScope(entry); status(entry, 'failed', 'RUNTIME_FAILURE', id); }
    finally { transitioning.delete(entry.manifest.id); }
  };
  const assertLive = (entry: Entry, scope: Scope) => {
    if (closed) throw new PluginOperationError('CLOSED');
    if (replacingDocument || entry.scope !== scope || scope.controller.signal.aborted) throw new PluginOperationError('REVOKED');
  };
  const withTask = async <T>(entry: Entry, scope: Scope, task: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    assertLive(entry, scope);
    if (scope.tasks.size >= 32) throw new PluginOperationError('LIMIT');
    const controller = new AbortController(); scope.tasks.add(controller);
    try { return await cancellable(controller.signal, () => task(controller.signal)); }
    finally { scope.tasks.delete(controller); }
  };
  const acquire = (entry: Entry, scope: Scope, capability: PluginCapability, input: PluginDocumentSnapshot): PluginCapabilityLease => {
    assertLive(entry, scope);
    if (!PLUGIN_CAPABILITIES.includes(capability)) throw new PluginOperationError('CAPABILITY_UNSUPPORTED');
    if (!entry.manifest.capabilities.includes(capability) || !allowed.get(entry.manifest.id)?.has(capability)) throw new PluginOperationError('DENIED');
    if (scope.leases.size >= 32) throw new PluginOperationError('LIMIT');
    const expected = copySnapshot(input);
    if (!expected) throw new PluginOperationError('INVALID_REQUEST');
    const controller = new AbortController(); scope.leases.add(controller);
    const revoke = () => { abort(controller, 'REVOKED'); scope.leases.delete(controller); };
    return Object.freeze({signal: controller.signal, revoke, async request(payload?: PluginEdit): Promise<PluginResult<unknown>> {
      const id = operationId();
      try {
        assertLive(entry, scope);
        if (controller.signal.aborted) throw new PluginOperationError(abortCode(controller.signal));
        const current = host.getSnapshot();
        if (!current || !samePluginDocument(expected, current)) throw new PluginOperationError('STALE');
        if (capability === 'document.edit' && current.readOnly) throw new PluginOperationError('READ_ONLY');
        if (capability === 'document.edit' && current.conflict) throw new PluginOperationError('CONFLICT');
        if ((capability === 'document.edit' && !validatePluginEdit(payload)) || (capability === 'document.read' && payload !== undefined)) throw new PluginOperationError('INVALID_REQUEST');
        // Detach caller-owned edits before asynchronous admission; callers cannot alter checked bytes afterward.
        const edit = payload ? Object.freeze({changes: Object.freeze(payload.changes.map(change => Object.freeze({...change}))),
          ...(payload.selection ? {selection: Object.freeze({...payload.selection})} : {})}) : undefined;
        const value = await cancellable(controller.signal, () => {
          assertLive(entry, scope);
          const latest = host.getSnapshot();
          if (!latest || !samePluginDocument(expected, latest)) throw new PluginOperationError('STALE');
          return host.perform(Object.freeze({operationId: id, pluginId: entry.manifest.id, capability, expected, ...(edit ? {payload: edit} : {})}), controller.signal);
        });
        assertLive(entry, scope);
        const latest = host.getSnapshot();
        if (!latest || !samePluginDocument(expected, latest, capability === 'document.read')) throw new PluginOperationError('STALE');
        return success(value);
      } catch (error) { return pluginFailure(errorCode(error), id); }
    }});
  };
  const createContext = (entry: Entry, scope: Scope): PluginContext => {
    const request = async (capability: PluginCapability, expected: PluginDocumentSnapshot, payload?: PluginEdit) => {
      let lease: PluginCapabilityLease | undefined;
      try { lease = acquire(entry, scope, capability, expected); return await lease.request(payload); }
      catch (error) { return pluginFailure(errorCode(error), operationId()); }
      finally { lease?.revoke(); }
    };
    return Object.freeze({manifest: entry.manifest, signal: scope.controller.signal,
      document: Object.freeze({snapshot: () => { assertLive(entry, scope); return copySnapshot(host.getSnapshot()); },
        read: (expected: PluginDocumentSnapshot) => request('document.read', expected),
        edit: (expected: PluginDocumentSnapshot, payload: PluginEdit) => request('document.edit', expected, payload)}),
      acquire: (capability: PluginCapability, expected: PluginDocumentSnapshot) => acquire(entry, scope, capability, expected),
      run: <T>(task: (signal: AbortSignal) => Promise<T>) => withTask(entry, scope, task),
      registerCommand(id: string, handler: PluginCommandHandler) {
        assertLive(entry, scope);
        if (!entry.manifest.contributions.some(item => item.kind === 'command' && item.id === id) || typeof handler !== 'function') throw new PluginOperationError('DENIED');
        if (scope.commands.has(id)) throw new PluginOperationError('DUPLICATE');
        scope.commands.set(id, handler);
        if (entry.status.state === 'enabled') notify();
        return () => { if (scope.commands.get(id) === handler) { scope.commands.delete(id); if (entry.status.state === 'enabled') notify(); } };
      },
      addDisposable(dispose: PluginDisposable) {
        assertLive(entry, scope);
        if (typeof dispose !== 'function') throw new PluginOperationError('INVALID_REQUEST');
        if (scope.disposables.size >= 128) throw new PluginOperationError('LIMIT');
        let active = true;
        const once = () => { if (!active) return; active = false; scope.disposables.delete(once); dispose(); };
        scope.disposables.add(once); return once;
      },
    });
  };
  const registry: PluginRegistry = {
    registerBundled(input, module) {
      const id = operationId();
      if (closed) return pluginFailure('CLOSED', id);
      const validated = validatePluginManifest(input, id);
      if (!validated.ok) return validated;
      const manifest = validated.value;
      if (!module || typeof module.activate !== 'function') return pluginFailure('INVALID_REQUEST', id);
      if (entries.has(manifest.id) || [...entries.values()].some(entry => entry.manifest.contributions.some(item => manifest.contributions.some(next => next.id === item.id)))) return pluginFailure('DUPLICATE', id);
      if (entries.size >= 32) return pluginFailure('LIMIT', id);
      const entry: Entry = {manifest, module: {activate: module.activate.bind(module)}, status: {manifest, state: 'disabled'}};
      entries.set(manifest.id, entry);
      return success(status(entry, hostApiVersion >= manifest.hostApi.min && hostApiVersion <= manifest.hostApi.max ? 'disabled' : 'incompatible',
        hostApiVersion >= manifest.hostApi.min && hostApiVersion <= manifest.hostApi.max ? undefined : 'INCOMPATIBLE', id));
    },
    async enable(pluginId) {
      const id = operationId();
      if (closed) return pluginFailure('CLOSED', id);
      if (transitioning.has(pluginId)) return pluginFailure('REVOKED', id);
      const entry = entries.get(pluginId);
      if (!entry) return pluginFailure('MISSING_PLUGIN', id);
      if (entry.status.state === 'incompatible') return pluginFailure('INCOMPATIBLE', id);
      if (entry.status.state === 'enabled') return success(entry.status);
      if (entry.enabling) return entry.enabling;
      const scope: Scope = {controller: new AbortController(), commands: new Map(), disposables: new Set(), tasks: new Set(), leases: new Set()};
      entry.scope = scope; entry.status = Object.freeze({manifest: entry.manifest, state: 'enabling'});
      const context = createContext(entry, scope);
      entry.enabling = (async () => {
        try {
          await cancellable(scope.controller.signal, async () => {
            const cleanup = await entry.module.activate(context);
            if (typeof cleanup === 'function') {
              if (scope.controller.signal.aborted) { try { cleanup(); } catch { /* Late activation still releases its own resources. */ } }
              else context.addDisposable(cleanup);
            }
          });
          assertLive(entry, scope);
          if (entry.manifest.contributions.some(item => item.kind === 'command' && !scope.commands.has(item.id))) throw new PluginOperationError('RUNTIME_FAILURE');
          return success(status(entry, 'enabled'));
        } catch (error) {
          if (entry.scope === scope) fail(entry, id);
          return pluginFailure(errorCode(error), id);
        } finally { if (entry.scope === scope) entry.enabling = undefined; }
      })();
      const pending = entry.enabling;
      notify();
      return pending;
    },
    disable(pluginId) {
      const id = operationId();
      if (closed) return pluginFailure('CLOSED', id);
      const entry = entries.get(pluginId);
      if (!entry) return pluginFailure('MISSING_PLUGIN', id);
      if (entry.status.state === 'incompatible') return success(entry.status);
      if (transitioning.has(pluginId)) return pluginFailure('REVOKED', id);
      transitioning.add(pluginId);
      try { disposeScope(entry); return success(status(entry, 'disabled')); }
      finally { transitioning.delete(pluginId); }
    },
    async invoke(commandId) {
      const id = operationId();
      if (closed) return pluginFailure('CLOSED', id);
      const entry = [...entries.values()].find(item => item.manifest.contributions.some(contribution => contribution.kind === 'command' && contribution.id === commandId));
      if (!entry) return pluginFailure('MISSING_PLUGIN', id);
      if (entry.status.state !== 'enabled' || !entry.scope) return pluginFailure(entry.status.state === 'incompatible' ? 'INCOMPATIBLE' : entry.status.state === 'failed' ? 'RUNTIME_FAILURE' : 'DISABLED', id);
      const scope = entry.scope; const handler = scope.commands.get(commandId);
      if (!handler) return pluginFailure('DISABLED', id);
      try {
        return success(await withTask(entry, scope, signal => Promise.resolve(handler(Object.freeze({signal, document: copySnapshot(host.getSnapshot())})))));
      } catch (error) {
        const code = errorCode(error);
        if (code === 'RUNTIME_FAILURE' && entry.scope === scope) fail(entry, id);
        return pluginFailure(code, id);
      }
    },
    snapshot: () => Object.freeze([...entries.values()].map(entry => entry.status)),
    contributions: kind => Object.freeze([...entries.values()].filter(entry => entry.status.state === 'enabled').flatMap(entry => entry.manifest.contributions
      .filter(item => (!kind || item.kind === kind) && entry.scope?.commands.has(item.commandId ?? item.id))
      .map(item => Object.freeze({...item, pluginId: entry.manifest.id})))),
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    replaceDocument() {
      if (replacingDocument) return;
      replacingDocument = true;
      try {
        for (const entry of entries.values()) {
          if (!entry.scope) continue;
          for (const lease of [...entry.scope.leases]) abort(lease, 'REVOKED');
          for (const task of [...entry.scope.tasks]) abort(task, 'CANCELLED');
          entry.scope.leases.clear(); entry.scope.tasks.clear();
        }
      } finally { replacingDocument = false; }
    },
    dispose() {
      if (closed) return;
      closed = true;
      for (const entry of entries.values()) { disposeScope(entry); if (entry.status.state !== 'incompatible') entry.status = Object.freeze({manifest: entry.manifest, state: 'disabled'}); }
      notify(); listeners.clear();
    },
    diagnostics() {
      const scopes = [...entries.values()].flatMap(entry => entry.scope ? [entry.scope] : []);
      return Object.freeze({plugins: entries.size, commands: scopes.reduce((sum, scope) => sum + scope.commands.size, 0),
        tasks: scopes.reduce((sum, scope) => sum + scope.tasks.size, 0), leases: scopes.reduce((sum, scope) => sum + scope.leases.size, 0),
        disposables: scopes.reduce((sum, scope) => sum + scope.disposables.size, 0), listeners: listeners.size, closed});
    },
  };
  return Object.freeze(registry);
}
