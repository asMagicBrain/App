import React, {createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createPluginRegistry} from './plugin-foundation/registry';
import {PluginOperationError, type PluginHostAdapter} from './plugin-foundation/contracts';
import {markdownTools, markdownToolsManifest} from './bundled-markdown-tools';
import {proEditor, proEditorManifest} from './pro-editor/manifest';
import {isNativeClosing} from './native-bridge.mjs';
import './plugin-workspace-study.css';
import './native-plugin-host.css';

const preferenceKey = 'asmagicbrain.bundled-plugins.v1';
function createHost() {
  let document: PluginHostAdapter | null = null;
  const listeners = new Set<() => void>();
  let previousIdentity = '';
  const notify = () => {for (const listener of listeners) listener();};
  const registry = createPluginRegistry({
    grants: {[markdownToolsManifest.id]: ['document.read', 'document.edit'], [proEditorManifest.id]: ['document.read', 'document.edit']},
    host: {
      getSnapshot: () => isNativeClosing() ? null : document?.getSnapshot() ?? null,
      async perform(request, signal) {
        const adapter = document;
        if (!adapter || isNativeClosing()) throw new PluginOperationError('CLOSED');
        return adapter.perform(request, signal);
      },
    },
  });
  registry.registerBundled(markdownToolsManifest, markdownTools);
  registry.registerBundled(proEditorManifest, proEditor);
  return {
    registry,
    subscribe(listener: () => void) {listeners.add(listener); const stop = registry.subscribe(listener); return () => {listeners.delete(listener); stop();};},
    registerDocument(adapter: PluginHostAdapter) {
      registry.replaceDocument(); document = adapter; previousIdentity = ''; notify();
      return () => {if (document === adapter) {registry.replaceDocument(); document = null; previousIdentity = ''; notify();}};
    },
    documentChanged() {
      const value = document?.getSnapshot();
      const identity = value ? JSON.stringify([value.repositoryId, value.revision, value.sessionId, value.path, value.sourceHash, value.readOnly, value.conflict]) : '';
      if (identity !== previousIdentity) {registry.replaceDocument(); previousIdentity = identity;}
      notify();
    },
    getSnapshot: () => isNativeClosing() ? null : document?.getSnapshot() ?? null,
    cancelOperations() {registry.replaceDocument();},
    dispose() {registry.dispose(); document = null; listeners.clear();},
  };
}
type PluginHost = ReturnType<typeof createHost>;
const HostContext = createContext<PluginHost | null>(null);
export const usePluginHost = () => useContext(HostContext);
/** Opt-in native host and its dedicated story. Existing asTeach studies keep their own UI. */
export function NativePluginProvider({children}: {children: React.ReactNode}) {
  const [host] = useState(createHost);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    try {const stored = JSON.parse(localStorage.getItem(preferenceKey) ?? '{}'); if (stored.markdownTools === true) void host.registry.enable(markdownToolsManifest.id); if (stored.proEditor === true) void host.registry.enable(proEditorManifest.id);} catch {/* Invalid preferences leave optional tools off. */}
    const closing = () => host.cancelOperations();
    window.addEventListener('pagehide', closing);
    return () => {mounted.current = false; window.removeEventListener('pagehide', closing); host.cancelOperations();
      queueMicrotask(() => {if (!mounted.current) host.dispose();});};
  }, [host]);
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}
function usePluginState() {
  const host = usePluginHost();
  const [, refresh] = useState(0);
  useEffect(() => host?.subscribe(() => refresh(value => value + 1)), [host]);
  return host;
}
export function PluginsIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><path d="M18 14v8m-4-4h8"/></svg>;
}
function ProIcon() {return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M5 4h14v16H5zM8 8h8M8 12h5M8 16h8"/></svg>;}
function ToolsIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M6 15V9l3 4 3-4v6m3-3 2 3 2-3m-2-4v7"/></svg>;
}
export function useProEditorEnabled() {
  const host = usePluginState();
  return host?.registry.snapshot().some(item => item.manifest.id === proEditorManifest.id && item.state === 'enabled') ?? false;
}
export function NativePluginManager({onReturn}: {onReturn(): void}) {
  const host = usePluginState();
  const [query, setQuery] = useState(''), [details, setDetails] = useState<string[]>([]), [feedback, setFeedback] = useState('');
  if (!host) return null;
  const entries = host.registry.snapshot();
  const toggle = async (id: string, enabled: boolean) => {
    setFeedback('');
    const result = enabled ? host.registry.disable(id) : await host.registry.enable(id);
    if (!result.ok) {setFeedback(result.error.message); return;}
    try {localStorage.setItem(preferenceKey, JSON.stringify(Object.fromEntries(host.registry.snapshot().map(item => [item.manifest.id === proEditorManifest.id ? 'proEditor' : 'markdownTools', item.state === 'enabled']))));}
    catch {setFeedback('This choice applies until the app closes.');}
  };
  const matching = entries.filter(item => item.manifest.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="pws-manager" aria-label="Plugins"><div className="pws-manager-content">
    <header className="pws-heading"><div><h1>Plugins</h1><p>Choose the tools you use in asMagicBrain.</p></div><button className="pws-button" onClick={onReturn}>Return to workspace</button></header>
    <div className="pws-list-heading"><h2>Installed <span className="pws-count">{entries.length}</span></h2><label className="pws-search"><span className="pws-sr-only">Search installed plugins</span><input type="search" placeholder="Search plugins…" value={query} onChange={event => setQuery(event.target.value)}/></label></div>
    {matching.map(status => {const enabled = status.state === 'enabled', pro = status.manifest.id === proEditorManifest.id, expanded = details.includes(status.manifest.id); return <article className="pws-plugin" key={status.manifest.id}><div className="pws-plugin-row"><span className="pws-plugin-icon">{pro?<ProIcon/>:<ToolsIcon/>}</span><div className="pws-plugin-description"><div className="pws-plugin-title"><h3>{status.manifest.name}</h3><span className="pws-badge">Included</span></div><p>{pro ? 'Edit equations and diagrams visually. Run reviewed local interactive views.' : 'Format selected text and check document statistics.'}</p><span className="pws-publisher">asMagicBrain · {status.manifest.version}</span></div><div className="pws-plugin-actions"><button className="pws-enable" role="switch" aria-label={`Enable ${status.manifest.name}`} aria-checked={enabled} disabled={status.state === 'enabling' || status.state === 'incompatible'} onClick={() => void toggle(status.manifest.id, enabled)}><span>{enabled ? 'Enabled' : status.state === 'enabling' ? 'Enabling…' : 'Disabled'}</span><span className="pws-switch-track" aria-hidden="true"><span/></span></button></div></div><div className="pws-plugin-footer"><button className="pws-details-toggle" aria-expanded={expanded} onClick={() => setDetails(current => expanded ? current.filter(id => id !== status.manifest.id) : [...current, status.manifest.id])}>{expanded ? 'Hide details' : 'View details'}</button><span className="pws-publisher">Works offline</span></div>{expanded && <div className="pws-details"><h4>Document access</h4><p>When enabled, these tools can read the open document and edit its text. Edits stay in the document’s draft until you save them.</p>{pro && <><h4>Interactive views</h4><p>Local interactive content requires a separate review and Run decision. It has no access to your account, workspace or network.</p></>}<h4>Your workspace</h4><p>Disabling the plugin removes its tools. Your files, drafts and undo history stay available.</p></div>}{status.error && <p className="np-error" role="alert">{status.error.message}</p>}</article>;})}
    {!matching.length && <p className="pws-empty">No matching plugins</p>}
    <p className="pws-hint">Optional tools share your existing editor. Disabling them preserves files, drafts and undo history.</p><p className="pws-feedback" role="status">{feedback}</p>
  </div></section>;
}
function useCommand() {
  const host = usePluginState();
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const current = host?.getSnapshot();
  useEffect(() => {setMessage('');}, [current?.sessionId, current?.version, current?.path]);
  useEffect(() => () => {sequence.current++;}, []);
  const invoke = useCallback(async (id: string) => {
    if (!host || isNativeClosing()) return false;
    const captured = host.getSnapshot();
    if (!captured) return false;
    const own = ++sequence.current; setBusy(true); setMessage('');
    const result = await host.registry.invoke(id);
    if (own !== sequence.current) return false;
    setBusy(false);
    if (isNativeClosing()) return false;
    const latest = host.getSnapshot();
    if (!latest || latest.repositoryId !== captured.repositoryId || latest.revision !== captured.revision ||
        latest.sessionId !== captured.sessionId || latest.path !== captured.path) return false;
    if (!result.ok) {setMessage(result.error.message); return true;}
    const value = result.value as {kind?: string; words?: number; characters?: number; lines?: number} | undefined;
    if (value?.kind === 'statistics' && latest.version !== captured.version) return false;
    setMessage(value?.kind === 'statistics' ? `${value.words} words · ${value.characters} characters · ${value.lines} lines` : value?.kind === 'pro-editor' ? 'Use Source or Visual while editing Markdown. Open a local HTML file or artifact manifest to review an interactive view.' : id.endsWith('.bold') ? 'Bold formatting added.' : 'Content inserted.');
    return true;
  }, [host]);
  return {host, invoke, message, busy};
}
export function PluginDocumentTools({editable, disabled = false}: {editable: boolean; disabled?: boolean}) {
  const {host, invoke, message, busy} = useCommand();
  const tools = host?.registry.contributions().filter(item => item.kind === 'editor-tool' || item.kind === 'reader-view') ?? [];
  if (!tools.length) return null;
  return <div className="np-document-tools" role="group" aria-label={tools.some(tool=>tool.id.startsWith('asmagicbrain.pro-editor.'))?'Pro Editor tools':'Markdown tools'}>
    {tools.map(tool => <button key={tool.id} type="button" disabled={disabled || busy || (tool.kind === 'editor-tool' && (!editable || tool.id.startsWith('asmagicbrain.pro-editor.') && !/\.(md|markdown)$/i.test(host?.getSnapshot()?.path??'')))} onMouseDown={event => event.preventDefault()} onClick={() => void invoke(tool.commandId!)}>{tool.title}</button>)}
    <span role="status">{message}</span>
  </div>;
}
export function NativePluginRail({disabled = false}: {disabled?: boolean}) {
  const {host, invoke, message, busy} = useCommand();
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const contributions = host?.registry.contributions('navigation') ?? [];
  const [selectedTitle, setSelectedTitle] = useState('Markdown tools');
  const available = Boolean(host?.getSnapshot());
  useLayoutEffect(() => {if (open && contributions.length) dialog.current?.showModal(); else dialog.current?.close();}, [open, contributions.length]);
  const close = () => {setOpen(false); trigger.current?.focus();};
  if (!contributions.length) return null;
  return <>{contributions.map(contribution => <button key={contribution.id} ref={contribution.title === selectedTitle ? trigger : undefined} className="fw-icon" aria-label={contribution.title} title={contribution.title} disabled={disabled || !available || busy} onClick={() => {setSelectedTitle(contribution.title); void invoke(contribution.commandId!).then(current => {if (current && !isNativeClosing()) setOpen(true);});}}>{contribution.title==='Pro Editor'?<ProIcon/>:<ToolsIcon/>}</button>)}
    <dialog ref={dialog} className="np-tools-dialog" aria-labelledby="np-tools-title" onCancel={event => {event.preventDefault(); close();}}><h2 id="np-tools-title">{selectedTitle === 'Markdown tools' ? 'Document statistics' : selectedTitle}</h2><p role="status">{busy ? 'Reading document…' : message}</p><button className="pws-button" autoFocus onClick={close}>Done</button></dialog></>;
}
