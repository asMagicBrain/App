import {isDocumentationRepository} from './repository-capabilities.mjs';
import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {RepositoryCatalogEntry} from './repository-catalog';
import {WorkDirectoryExplorer} from './WorkDirectoryExplorer';
import {PanelResizeHandle} from './PanelResizeHandle';
import {isRepositoryPinned,orderRepositories} from './repository-pins';
import {CatalogGearMenu,CatalogContextMenu} from './CatalogActionMenu';
import {CatalogRepositoryDialog,type CatalogDialogRequest} from './CatalogRepositoryDialog';
import {repositoryMenuActions,type CatalogRepositoryOperation,type CatalogEntryAction,type CatalogTarget,type CatalogCommand,type CatalogMenuAction} from './catalog-management';
import type {RepositoryTrashEntry} from './native-types';
import './all-repositories.css';

type Props={
  repositories:RepositoryCatalogEntry[];
  loading:boolean;
  error:string;
  onRetry():void;
  currentRepository:string;
  onOpenRepository(name:string):void;
  onOpenLocation?:(repository:string,path:string,type:'file'|'directory')=>void|Promise<void>;
  defaultRepository?:string;
  pinnedRepositories?:readonly string[];
  pinsLoading?:boolean;
  pinsBusy?:boolean;
  pinsError?:string;
  onTogglePin?:(name:string,pinned:boolean)=>void|Promise<void>;
  onRetryPins?():void;
  managementBusy?:boolean;
  onRepositoryOperation?(input:CatalogRepositoryOperation):Promise<void>;
  onListTrashedRepositories?():Promise<RepositoryTrashEntry[]>;
  onEntryAction?(input:CatalogEntryAction):void|Promise<void>;
  onRevealRepository?(repository:string):void|Promise<void>;
  onMoveRepository?(repository:string):void|Promise<void>;
  onReturnToRepository():void;
  onNewRepository?:()=>void;
  sidebarOpen:boolean;
  onSidebarOpenChange(open:boolean):void;
  panelResizePreview?:boolean;
};
type IconName='repository'|'collapse'|'search'|'pin'|'settings';
const NO_PINS:readonly string[]=[];
function RepositoryIcon({name}:{name:IconName}) {
  const paths={repository:<><path d="M4 3h12v14H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 0v10h12M6 6h7"/></>,collapse:<><rect x="2" y="3" width="16" height="14" rx="2"/><path d="M7 3v14m6-10-3 3 3 3"/></>,search:<><circle cx="8" cy="8" r="5"/><path d="m12 12 5 5"/></>,pin:<><path d="m7 2 6 0-1 6 3 3v2H5v-2l3-3-1-6Z"/><path d="M10 13v5"/></>,settings:<><circle cx="10" cy="10" r="3"/><path d="m8 2-.5 2-2 .9-1.9-.5-2 3.3L3 9v2l-1.4 1.3 2 3.3 1.9-.5 2 .9.5 2h4l.5-2 2-.9 1.9.5 2-3.3L17 11V9l1.4-1.3-2-3.3-1.9.5-2-.9L12 2Z"/></>};
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function AllRepositories({repositories,loading,error,onRetry,currentRepository,onOpenRepository,onReturnToRepository,onNewRepository,sidebarOpen,onSidebarOpenChange,onOpenLocation,defaultRepository='Workspace',pinnedRepositories=NO_PINS,pinsLoading=false,pinsBusy=false,pinsError='',onTogglePin,onRetryPins,managementBusy=false,onRepositoryOperation,onListTrashedRepositories,onEntryAction,onRevealRepository,onMoveRepository}:Props) {
  const root=useRef<HTMLElement>(null),returnFocus=useRef<HTMLElement|null>(null);
  const [sidebarWidth,setSidebarWidth]=useState(280);
  const collapseSidebar=()=>{if(dialog.current?.open)dialog.current.close();onSidebarOpenChange(false);root.current?.closest('.fw-window')?.querySelector<HTMLButtonElement>('[aria-label="Toggle repository sidebar"]')?.focus({preventScroll:true});};
  const [menuHost,setMenuHost]=useState<HTMLElement|null>(null),[managementDialog,setManagementDialog]=useState<CatalogDialogRequest|null>(null),[actionError,setActionError]=useState(''),[actionErrorInTree,setActionErrorInTree]=useState(false),[actionPending,setActionPending]=useState(false);
  const actionRequest=useRef(false);
  const [query,setQuery]=useState(''),[sort,setSort]=useState<'asc'|'desc'>('asc'),[density,setDensity]=useState<'comfortable'|'compact'>('comfortable');
  const [narrow,setNarrow]=useState(()=>window.matchMedia('(max-width:760px)').matches);
  const heading=useRef<HTMLHeadingElement>(null),dialog=useRef<HTMLDialogElement>(null);
  const pinRequest=useRef(false),mounted=useRef(true);
  const [pinPending,setPinPending]=useState<string|null>(null),[localPinError,setLocalPinError]=useState('');
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const updateSidebar=useRef(onSidebarOpenChange);updateSidebar.current=onSidebarOpenChange;
  const sidebarWasOpen=useRef(sidebarOpen);sidebarWasOpen.current=sidebarOpen;
  useLayoutEffect(()=>{heading.current?.focus();setMenuHost(root.current?.closest<HTMLElement>('.fw-window')??root.current);},[]);
  useEffect(()=>{
    const media=window.matchMedia('(max-width:760px)');
    const change=()=>{setNarrow(media.matches);if(media.matches&&sidebarWasOpen.current)updateSidebar.current(false);};
    change();media.addEventListener('change',change);
    return()=>media.removeEventListener('change',change);
  },[]);
  useLayoutEffect(()=>{
    const element=dialog.current;
    if(!narrow||!sidebarOpen||!element)return;
    element.showModal();
    return()=>element.close();
  },[narrow,sidebarOpen]);
  const filter=query.trim().toLocaleLowerCase();
  const ordered=orderRepositories(repositories,defaultRepository,pinnedRepositories,sort);
  const matching=ordered.filter(item=>item.name.toLocaleLowerCase().includes(filter));
  const togglePin=async(name:string)=>{
    if(!onTogglePin||isDocumentationRepository(repositories.find(item=>item.name===name))||name===defaultRepository||pinRequest.current||pinsBusy||pinsLoading)return;
    pinRequest.current=true;setPinPending(name);setLocalPinError('');
    try{await onTogglePin(name,!isRepositoryPinned(name,defaultRepository,pinnedRepositories));}
    catch(reason){if(mounted.current)setLocalPinError(reason instanceof Error?reason.message:'Could not update this pin. Try again.');}
    finally{pinRequest.current=false;if(mounted.current)setPinPending(null);}
  };
  const blocked=managementBusy||actionPending;
  const actionsFor=(target:CatalogTarget):CatalogMenuAction[]=>{
    if(target.kind==='repository')return repositoryMenuActions(target.repository,{defaultRepository,busy:blocked,manage:Boolean(onRepositoryOperation),reveal:Boolean(onRevealRepository),move:Boolean(onMoveRepository),readOnly:isDocumentationRepository(repositories.find(item=>item.name===target.repository))});
    if(target.kind==='root')return [{id:'open',label:'Open',disabled:blocked},{id:'new-repository',label:'New repository',disabled:blocked||!onNewRepository,separator:true},{id:'restore-repository',label:'Restore repository…',disabled:blocked||!onRepositoryOperation||!onListTrashedRepositories}];
    const readable=Boolean(onEntryAction),manage=readable&&!isDocumentationRepository(repositories.find(item=>item.name===target.repository)),folder=target.kind==='directory';
    return [{id:'open',label:'Open',disabled:blocked||!onOpenLocation},...(folder?[{id:'new-file' as const,label:'New Markdown file',disabled:blocked||!manage},{id:'new-folder' as const,label:'New folder',disabled:blocked||!manage}]:[]),{id:'rename',label:'Rename',disabled:blocked||!manage,separator:true},{id:'duplicate',label:'Duplicate',disabled:blocked||!manage},{id:'move',label:'Move to…',disabled:blocked||!manage},{id:'copy-path',label:'Copy path',disabled:blocked||!readable,separator:true},{id:'reveal',label:'Reveal the file',disabled:blocked||!readable},{id:'trash',label:'Move to Trash',disabled:blocked||!manage,danger:true,separator:true}];
  };
  const closeManagementDialog=()=>{setManagementDialog(null);requestAnimationFrame(()=>{if(mounted.current)(returnFocus.current?.isConnected?returnFocus.current:heading.current)?.focus();});};
  const runAction=(target:CatalogTarget,command:CatalogCommand,trigger:HTMLElement|null)=>{
    if(blocked||actionRequest.current||actionsFor(target).find(action=>action.id===command)?.disabled)return;
    trigger?.focus();setActionError('');
    if(command==='restore-repository'){returnFocus.current=trigger;setManagementDialog({kind:'restore'});return;}
    if(target.kind==='repository'&&['rename','duplicate','trash'].includes(command)){returnFocus.current=trigger;setManagementDialog({kind:command as 'rename'|'duplicate'|'trash',repository:target.repository});return;}
    actionRequest.current=true;setActionPending(true);
    Promise.resolve().then(()=>{
      if(target.kind==='root'){if(command==='new-repository')onNewRepository?.();else{setQuery('');heading.current?.focus();if(narrow)onSidebarOpenChange(false);}return;}
      if(target.kind==='repository')return command==='open'?onOpenRepository(target.repository):command==='reveal'?onRevealRepository?.(target.repository):onMoveRepository?.(target.repository);
      if(command==='open')return onOpenLocation?.(target.repository,target.path,target.kind);
      return onEntryAction?.({repository:target.repository,path:target.path,type:target.kind,command:command as CatalogEntryAction['command']});
    }).catch(reason=>{if(mounted.current){setActionError(reason instanceof Error?reason.message:'The operation could not be completed.');setActionErrorInTree(Boolean(trigger?.closest('.wde')));trigger?.focus();}}).finally(()=>{actionRequest.current=false;if(mounted.current)setActionPending(false);});
  };
  const navigation=<nav className="ar-navigation" aria-label="Repository navigation" data-area="AR1">
    <WorkDirectoryExplorer repositories={ordered} currentRepository={currentRepository} onOpenRoot={()=>{setQuery('');heading.current?.focus();if(narrow)onSidebarOpenChange(false);}} onOpenRepository={onOpenRepository} onOpenLocation={onOpenLocation} busy={blocked} actionsFor={actionsFor} onAction={runAction}/>
    {actionError&&actionErrorInTree&&<p className="wde-error" role="alert">{actionError}</p>}
    <div className="ar-navigation-bottom"><button className="ar-return" onClick={onReturnToRepository} title={`Return to ${currentRepository}`}>Return to {currentRepository}</button></div>
  </nav>;
  return <section ref={root} className="ar-view ar-resizable" aria-labelledby="ar-heading" data-density={density}>
    {!narrow&&sidebarOpen&&<aside className="ar-sidebar" style={{'--panel-resize-width':`${sidebarWidth}px`} as React.CSSProperties}>{navigation}<PanelResizeHandle width={sidebarWidth} defaultWidth={280} minWidth={180} maxWidth={480} collapseWidth={140} onResize={setSidebarWidth} onCollapse={collapseSidebar} label="Repository sidebar width"/></aside>}
    {narrow&&<dialog ref={dialog} className="ar-navigation-dialog" style={{'--panel-resize-width':`${sidebarWidth}px`} as React.CSSProperties} aria-label="Repository navigation" onCancel={event=>{event.preventDefault();onSidebarOpenChange(false);}} onClick={event=>{if(event.target!==event.currentTarget)return;const rect=event.currentTarget.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)onSidebarOpenChange(false);}}>{navigation}<PanelResizeHandle width={sidebarWidth} defaultWidth={280} minWidth={180} maxWidth={480} collapseWidth={140} onResize={setSidebarWidth} onCollapse={collapseSidebar} label="Repository sidebar width"/></dialog>}
    <div className="ar-content">
      <header className="ar-heading-row" data-area="AR2"><div><h1 id="ar-heading" ref={heading} tabIndex={-1}>My repositories</h1><p>Local repositories <span>· On this device</span></p></div><button className="ar-new" disabled={!onNewRepository} onClick={onNewRepository}><RepositoryIcon name="repository"/>New repository</button></header>
      <label className="ar-search" data-area="AR3"><RepositoryIcon name="search"/><span className="rh-sr-only">Search repositories</span><input type="search" placeholder="Search repositories" value={query} onChange={event=>setQuery(event.target.value)} aria-describedby="ar-search-help"/></label>
      <p className="ar-search-help" id="ar-search-help">Filter local repositories by name.</p>
      {actionError&&(!actionErrorInTree||!sidebarOpen)&&<p className="ar-feedback" role="alert">{actionError}</p>}
      {error&&<div className="ar-feedback" role="alert"><p>{error}</p><button className="ar-button" disabled={loading} onClick={onRetry}>Retry</button></div>}
      {loading&&<p className="ar-loading" role="status">Loading repositories…</p>}
      {(pinsError||localPinError)&&<div className="ar-feedback ar-pin-feedback" role="alert"><p>{pinsError||localPinError}</p>{onRetryPins&&<button className="ar-button" disabled={pinsLoading||pinsBusy} onClick={()=>{setLocalPinError('');onRetryPins();}}>Retry pins</button>}</div>}
      {pinsLoading&&<p className="ar-loading" role="status">Loading pins…</p>}
      <div className="ar-list">
        <div className="ar-list-toolbar" data-area="AR4"><span className="ar-count" aria-live="polite" aria-atomic="true">{filter?`${matching.length} of ${repositories.length} repositories`:`${repositories.length} ${repositories.length===1?'repository':'repositories'}`}</span><div className="ar-list-controls"><select aria-label="Sort repositories" value={sort} onChange={event=>setSort(event.target.value as 'asc'|'desc')}><option value="asc">Name A–Z</option><option value="desc">Name Z–A</option></select><div className="ar-density" role="group" aria-label="Repository list density"><button aria-label="Comfortable" title="Comfortable" aria-pressed={density==='comfortable'} onClick={()=>setDensity('comfortable')}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12v3H2Zm0 7h12v3H2Z"/></svg></button><button aria-label="Compact" title="Compact" aria-pressed={density==='compact'} onClick={()=>setDensity('compact')}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h12v2H2Zm0 5h12v2H2Zm0 5h12v2H2Z"/></svg></button></div></div></div>
        <ul className="ar-repositories" data-area="AR5">{matching.map(item=>{const docs=isDocumentationRepository(item),mandatory=docs||item.name===defaultRepository,pinned=!docs&&isRepositoryPinned(item.name,defaultRepository,pinnedRepositories);return <CatalogContextMenu key={item.name} host={menuHost} label={`Repository actions for ${item.name}`} actions={actionsFor({kind:'repository',repository:item.name})} onAction={(command,trigger)=>runAction({kind:'repository',repository:item.name},command,trigger)} busy={blocked}><li tabIndex={-1} data-repository-name={item.name} className="ar-repository-row" data-pinned={pinned||undefined}><div className="ar-repository-details"><div className="ar-repository-title"><button className="ar-repository-link" aria-label={`Open repository ${item.name}`} onClick={()=>onOpenRepository(item.name)}><span>asMagicBrain / </span><strong>{item.name}</strong></button><span className="ar-visibility" title="Visibility recorded in the local catalog; not current GitHub permissions.">{item.privateRepo?'Private':'Public'}</span></div><p>{docs?'Documentation · Read only':'On this device'}{item.name===currentRepository&&<span className="ar-current">Current repository</span>}</p></div><div className="ar-row-actions"><button className="ar-pin" disabled={mandatory||!onTogglePin||pinsLoading||pinsBusy||Boolean(pinPending)||blocked} aria-label={docs?`${item.name} stays last`:mandatory?`${item.name} is always pinned`:`${pinned?'Unpin':'Pin'} ${item.name}`} title={docs?'Documentation stays at the bottom':mandatory?'Always pinned':pinned?'Unpin repository':'Pin repository'} aria-pressed={pinned} aria-busy={pinPending===item.name||undefined} onClick={()=>{void togglePin(item.name);}}><RepositoryIcon name="pin"/></button><CatalogGearMenu repository={item.name} host={menuHost} actions={actionsFor({kind:'repository',repository:item.name})} onAction={(command,trigger)=>runAction({kind:'repository',repository:item.name},command,trigger)} busy={blocked}><RepositoryIcon name="settings"/></CatalogGearMenu></div></li></CatalogContextMenu>;})}</ul>
        {!matching.length&&!loading&&!error&&<p className="ar-empty">{filter?'No repositories match this name.':'No local repositories yet.'}</p>}
      </div>
    </div>
    {managementDialog&&onRepositoryOperation&&<CatalogRepositoryDialog key={managementDialog.kind+('repository' in managementDialog?managementDialog.repository:'')} request={managementDialog} repositories={repositories.map(item=>item.name)} defaultRepository={defaultRepository} busy={managementBusy} onOperation={onRepositoryOperation} onListTrash={onListTrashedRepositories} onClose={closeManagementDialog}/>}
  </section>;
}
