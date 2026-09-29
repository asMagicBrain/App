import React, {createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createPluginRegistry} from './plugin-foundation/registry';
import {PluginOperationError, type PluginHostAdapter} from './plugin-foundation/contracts';
import {markdownTools, markdownToolsManifest} from './bundled-markdown-tools';
import {proEditor, proEditorManifest} from './pro-editor/manifest';
import {isTrustedProPackage} from './pro-editor/trusted-package';
import {getNativeBridge, isNativeClosing, nativeOperation} from './native-bridge.mjs';
import type {PluginPackageEntry,PluginPackageReview} from './native-types';
import './plugin-workspace-study.css';
import './native-plugin-host.css';

function createHost() {
  let document: PluginHostAdapter | null = null;
  let packages:PluginPackageEntry[]=[];
  let packageError='';
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
  const synchronizePackages=async(next:PluginPackageEntry[])=>{
    packages=next;
    const trusted=next.find(isTrustedProPackage),registered=registry.snapshot().some(item=>item.manifest.id===proEditorManifest.id);
    if(trusted&&!registered)registry.registerBundled(proEditorManifest,proEditor);
    if(!trusted&&registered)registry.unregister(proEditorManifest.id);
    if(trusted){if(trusted.enabled)await registry.enable(proEditorManifest.id);else registry.disable(proEditorManifest.id);}
    notify();
  };
  return {
    registry,
    getPackages:()=>packages,
    getPackageError:()=>packageError,
    async refreshPackages(){const bridge=getNativeBridge();try{await synchronizePackages(bridge?.listPluginPackages?await nativeOperation(()=>bridge.listPluginPackages()):[]);packageError='';}
      catch(reason){packageError=(reason as Error).message;notify();throw reason;}},
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
    void host.registry.enable(markdownToolsManifest.id);
    void host.refreshPackages().catch(()=>{});
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
  const [query,setQuery]=useState(''),[details,setDetails]=useState<string[]>([]),[feedback,setFeedback]=useState(''),[busy,setBusy]=useState(false);
  const [review,setReview]=useState<PluginPackageReview|null>(null),[removing,setRemoving]=useState<PluginPackageEntry|null>(null);
  if (!host) return null;
  const bridge=getNativeBridge(),entries=host.getPackages();
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setFeedback('');try{await action();await host.refreshPackages();}catch(reason){setFeedback((reason as Error).message);}finally{setBusy(false);}};
  const choose=()=>run(async()=>{if(!bridge?.selectPluginPackage)throw Error('Plugin installation requires the native application.');const value=await nativeOperation(()=>bridge.selectPluginPackage());if(value)setReview(value);});
  const cancelReview=()=>{const value=review;setReview(null);if(value&&bridge?.cancelPluginPackageReview)void nativeOperation(()=>bridge.cancelPluginPackageReview({ticket:value.ticket})).catch(()=>{});};
  const install=()=>run(async()=>{if(!review||!bridge?.installPluginPackage)return;await nativeOperation(()=>bridge.installPluginPackage({ticket:review.ticket,requestId:crypto.randomUUID()}));setFeedback(`${review.manifest.name} installed.`);setReview(null);});
  const toggle=(entry:PluginPackageEntry)=>run(async()=>{if(!bridge?.setPluginPackageEnabled)throw Error('Plugin controls require the native application.');await nativeOperation(()=>bridge.setPluginPackageEnabled({pluginId:entry.id,enabled:!entry.enabled}));});
  const rollback=(entry:PluginPackageEntry)=>run(async()=>{if(!bridge?.rollbackPluginPackage)return;await nativeOperation(()=>bridge.rollbackPluginPackage({pluginId:entry.id,requestId:crypto.randomUUID()}));setFeedback(`${entry.name} restored to its previous version.`);});
  const uninstall=()=>run(async()=>{const entry=removing;if(!entry||!bridge?.uninstallPluginPackage)return;await nativeOperation(()=>bridge.uninstallPluginPackage({pluginId:entry.id,requestId:crypto.randomUUID()}));setFeedback(`${entry.name} uninstalled.`);setRemoving(null);});
  const matching=entries.filter(item=>item.name.toLowerCase().includes(query.trim().toLowerCase()));
  const description=(entry:PluginPackageEntry)=>isTrustedProPackage(entry)?'Edit equations and diagrams visually using the existing CM6 editor.':'Declarative resources stored locally. This package cannot run application code.';
  return <section className="pws-manager" aria-label="Plugins"><div className="pws-manager-content">
    <header className="pws-heading"><div><h1>Plugins</h1><p>Install and manage optional tools stored on this computer.</p></div><div className="pws-heading-actions"><button className="pws-button pws-primary" disabled={!bridge?.selectPluginPackage||busy} onClick={()=>void choose()}>Install plugin…</button><button className="pws-button" onClick={onReturn}>Return to workspace</button></div></header>
    <div className="pws-list-heading"><h2>Bundled <span className="pws-count">0</span></h2></div>
    <p className="pws-empty pws-compact-empty">No optional plugins are bundled. Markdown editing is part of asMagicBrain.</p>
    <div className="pws-list-heading"><h2>Installed <span className="pws-count">{entries.length}</span></h2><label className="pws-search"><span className="pws-sr-only">Search installed plugins</span><input type="search" placeholder="Search plugins…" value={query} onChange={event=>setQuery(event.target.value)}/></label></div>
    {matching.map(entry=>{const expanded=details.includes(entry.id);return <article className="pws-plugin" key={entry.id}><div className="pws-plugin-row"><span className="pws-plugin-icon">{isTrustedProPackage(entry)?<ProIcon/>:<ToolsIcon/>}</span><div className="pws-plugin-description"><div className="pws-plugin-title"><h3>{entry.name}</h3><span className="pws-badge">Installed</span>{isTrustedProPackage(entry)&&<span className="pws-badge">Verified first-party</span>}</div><p>{description(entry)}</p><span className="pws-publisher">{entry.manifest.publisher.name} · {entry.version}</span></div><div className="pws-plugin-actions"><button className="pws-enable" role="switch" aria-label={`Enable ${entry.name}`} aria-checked={entry.enabled} disabled={busy} onClick={()=>void toggle(entry)}><span>{entry.enabled?'Enabled':'Disabled'}</span><span className="pws-switch-track" aria-hidden="true"><span/></span></button></div></div><div className="pws-plugin-footer"><button className="pws-details-toggle" aria-expanded={expanded} onClick={()=>setDetails(current=>expanded?current.filter(id=>id!==entry.id):[...current,entry.id])}>{expanded?'Hide details':'View details'}</button><span className="pws-publisher">Works offline</span></div>{expanded&&<div className="pws-details"><h4>Package access</h4><p>This package is stored in private application state. It cannot access repositories, accounts, the network or application code.</p>{isTrustedProPackage(entry)&&<><h4>Trusted binding</h4><p>The exact verified package identity activates Pro Editor code already reviewed and compiled with asMagicBrain. Replacing any package byte breaks that binding.</p></>}<div className="pws-detail-actions"><button className="pws-button" disabled={busy||!entry.rollbackAvailable} onClick={()=>void rollback(entry)}>Restore previous version</button><button className="pws-button pws-danger" disabled={busy} onClick={()=>setRemoving(entry)}>Uninstall…</button></div></div>}</article>;})}
    {!matching.length&&<p className="pws-empty">{entries.length?'No matching plugins':'No plugins installed'}</p>}
    <p className="pws-hint">Install only plugin files you intended to use. Packages are checked before installation and remain offline.</p><p className="pws-feedback" role="status">{busy?'Working…':feedback||host.getPackageError()}</p>
    {review&&<dialog open className="np-tools-dialog pws-package-dialog" aria-labelledby="pws-review-title"><h2 id="pws-review-title">Install {review.manifest.name}?</h2><dl><div><dt>Publisher</dt><dd>{review.manifest.publisher.name}</dd></div><div><dt>Version</dt><dd>{review.manifest.version}</dd></div><div><dt>File</dt><dd>{review.filename}</dd></div><div><dt>Access</dt><dd>No permissions · declarative content only</dd></div></dl>{!review.compatible&&<p className="np-error" role="alert">This plugin requires a different asMagicBrain version.</p>}<div className="pws-dialog-actions"><button className="pws-button" onClick={cancelReview}>Cancel</button><button className="pws-button pws-primary" disabled={busy||!review.compatible} onClick={()=>void install()}>Install plugin</button></div></dialog>}
    {removing&&<dialog open className="np-tools-dialog pws-package-dialog" aria-labelledby="pws-uninstall-title"><h2 id="pws-uninstall-title">Uninstall {removing.name}?</h2><p>The plugin and its retained previous package will be removed. Repository files, drafts and Git history remain unchanged.</p><div className="pws-dialog-actions"><button className="pws-button" onClick={()=>setRemoving(null)}>Cancel</button><button className="pws-button pws-danger" disabled={busy} onClick={()=>void uninstall()}>Uninstall</button></div></dialog>}
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
