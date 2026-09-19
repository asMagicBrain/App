import {isDocumentationRepository} from './repository-capabilities.mjs';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FrameIcon, type FrameIconName } from '../../apps/desktop/ui/shared/editor-frame';
import './focused-writing.css';
import { RepositoryHeader } from './RepositoryHeader';
import { WorkspaceHome } from './WorkspaceHome';
import { AllRepositories } from './AllRepositories';
import type {CatalogEntryAction,CatalogRepositoryOperation} from './catalog-management';
import {WorkspaceSearch} from './WorkspaceSearch';
import {IntegratedDocumentOutline} from './IntegratedDocumentOutline';
import {isTypingTarget,type NavigationRequest,type OutlineState,type SearchRequest,type WorkspaceLocation} from './workspace-navigation';
import { RepositoryActions } from './RepositoryActions';
import { RepositoryCodePage } from './RepositoryCodePage';
import { ZipImportDialog } from './ZipImportDialog';
import { NewRepositoryDialog } from './NewRepositoryDialog';
import {GitHubConnectionDialog, invalidateGitHubConnection, useGitHubConnection} from './GitHubConnection';
import {ApplicationProfileDialog, ApplicationSignInDialog, useApplicationAccount} from './AppAccount';
import type {ClonedRepository,NativeBuildConfiguration} from './native-types';
import { loadRepositoryCatalog, type CreatedRepository, type ImportedRepository, type RepositoryCatalog } from './repository-catalog';
import themes from './github-themes/themes.json';
import './workspace-preferences.css';
import {AccountControls} from './AccountControls';
import {CommitPreferencesProvider, useCommitPreferences} from './CommitPreferencesContext';
import {useNativeWindow} from './useNativeWindow';
import {getNativeBridge,isNativeClosing,nativeOperation,revealRepositoryItem,renameRepository as renameManagedRepository} from './native-bridge.mjs';

function IconButton({icon,label,onClick,expanded,disabled=false,alwaysVisible=false,unavailable=false}:{icon:FrameIconName;label:string;onClick?:(event:React.MouseEvent<HTMLButtonElement>)=>void;expanded?:boolean;disabled?:boolean;alwaysVisible?:boolean;unavailable?:boolean}) {
  return <button className="fw-icon" title={label} aria-label={label} aria-expanded={expanded} disabled={disabled} data-unavailable={unavailable&&!alwaysVisible||undefined} data-always-visible={alwaysVisible||undefined} onClick={onClick}><FrameIcon name={icon}/></button>;
}
function LeaveEditorDialog({onKeep,onDiscard,error}:{onKeep:()=>void;onDiscard:()=>void;error?:string}) {
  const dialog=useRef<HTMLDialogElement>(null);
  useLayoutEffect(()=>{const element=dialog.current!;element.showModal();return()=>element.close();},[]);
  return <dialog ref={dialog} className="fw-discard-dialog" aria-labelledby="fw-discard-heading" onCancel={event=>{event.preventDefault();onKeep();}}><h2 id="fw-discard-heading">Leave editor?</h2><p>Your content drafts will remain available when you return. Save filename changes before leaving.</p>{error&&<p role="alert" className="rfe-error">{error}</p>}<div><button autoFocus onClick={onKeep}>Keep editing</button><button onClick={onDiscard}>Leave editor</button></div></dialog>;
}
type FocusedWritingProps = {buildChannel?:NativeBuildConfiguration['channel'];initialSidebar?:boolean;repositoryHeader?:boolean;repositoryCode?:boolean;initialRepository?:string;initialEdit?:boolean;initialDirectory?:string;initialTheme?:string|null;initialHideUnavailable?:boolean;initialSettingsOpen?:boolean;accountPreview?:boolean;initialWorkspaceView?:'home'|'organization'|'repositories'|null};
export function FocusedWriting(props:FocusedWritingProps) {
  return <CommitPreferencesProvider enabled={Boolean(props.repositoryHeader)} initialSettingsOpen={props.initialSettingsOpen}><FocusedWritingWindow {...props}/></CommitPreferencesProvider>;
}
function FocusedWritingWindow({buildChannel='development',initialSidebar=false,repositoryHeader=false,repositoryCode=false,initialRepository='Workspace',initialEdit=false,initialDirectory,initialTheme=null,initialHideUnavailable=false,accountPreview=false,initialWorkspaceView=null}:FocusedWritingProps) {
  const accountPreferences=useCommitPreferences()!;
  const [repository,setRepository]=useState(initialRepository);
  const [catalogSidebarOpen,setCatalogSidebarOpen]=useState(()=>!window.matchMedia('(max-width:760px)').matches);
  const [workspaceView,setWorkspaceView]=useState<'home'|'organization'|'repositories'|null>(initialWorkspaceView);
  const [catalog,setCatalog]=useState<RepositoryCatalog|null>(null),[catalogLoading,setCatalogLoading]=useState(false),[catalogError,setCatalogError]=useState('');
  const catalogView=workspaceView==='repositories'||workspaceView==='organization';
  const [pins,setPins]=useState<{defaultRepository:string;pinnedRepositories:string[]}>({defaultRepository:'Workspace',pinnedRepositories:[]}),[pinsLoading,setPinsLoading]=useState(false),[pinsBusy,setPinsBusy]=useState(false),[pinsError,setPinsError]=useState('');
  const pinSequence=useRef(0);
  const reloadPins=useCallback(async()=>{const bridge=getNativeBridge();if(!bridge?.getRepositoryPins)return;const sequence=++pinSequence.current;setPinsLoading(true);setPinsError('');try{const value=await nativeOperation(()=>bridge.getRepositoryPins());if(sequence===pinSequence.current)setPins(value);}catch(reason){if(sequence===pinSequence.current)setPinsError((reason as Error).message);}finally{if(sequence===pinSequence.current)setPinsLoading(false);}},[]);
  const togglePin=async(repo:string,pinned:boolean)=>{const bridge=getNativeBridge();if(!bridge?.setRepositoryPinned||pinsBusy||isNativeClosing())return;++pinSequence.current;setPinsBusy(true);setPinsError('');try{setPins(await nativeOperation(()=>bridge.setRepositoryPinned({repo,pinned})));}catch(reason){setPinsError((reason as Error).message);}finally{setPinsBusy(false);setPinsLoading(false);}};
  const [catalogEpoch,setCatalogEpoch]=useState(0),[importOpen,setImportOpen]=useState(false),[newRepositoryOpen,setNewRepositoryOpen]=useState(false);
  const [managementBusy,setManagementBusy]=useState(false),managementPending=useRef(false);
  const newRepositoryReturnFocus=useRef<HTMLElement|null>(null);
  const importReturnFocus=useRef<HTMLElement|null>(null);
  const github=useGitHubConnection(), [gitHubOpen,setGitHubOpen]=useState(false), [gitHubActionError,setGitHubActionError]=useState('');
  const application=useApplicationAccount(), [appSignInOpen,setAppSignInOpen]=useState(false), [appProfileOpen,setAppProfileOpen]=useState(false);
  const disconnectingGitHub=useRef(false),[gitHubDisconnecting,setGitHubDisconnecting]=useState(false);
  const connectedGitHub=github.connection?.state==='connected'?github.connection.account:undefined;
  const canDisconnectGitHub=Boolean(github.connection?.configured&&(github.connection.state==='connected'||github.connection.state==='expired'||(github.connection.state==='unavailable'&&github.connection.error)));
  const disconnectGitHub=async()=>{
    const bridge=getNativeBridge();if(!bridge?.disconnectGitHub||disconnectingGitHub.current||isNativeClosing())return;
    disconnectingGitHub.current=true;setGitHubDisconnecting(true);setGitHubActionError('');
    await nativeOperation(async()=>{
      try{await bridge.disconnectGitHub();}
      catch(reason){setGitHubActionError(reason instanceof Error?reason.message:'Could not disconnect GitHub. Try again.');}
      finally{await github.refresh();invalidateGitHubConnection();disconnectingGitHub.current=false;setGitHubDisconnecting(false);}
    });
  };
  const initialCatalogLoaded=useRef(false);
  useEffect(()=>{
    if(!repositoryHeader)return;
    const controller=new AbortController();
    setCatalogLoading(true);setCatalogError('');
    void loadRepositoryCatalog(undefined,controller.signal).then(value=>{if(controller.signal.aborted)return;setCatalog(value);if(!initialCatalogLoaded.current){initialCatalogLoaded.current=true;if(initialRepository==='Workspace'&&value.defaultRepository)setRepository(value.defaultRepository);}}).catch(reason=>{if(!controller.signal.aborted)setCatalogError(reason instanceof Error?reason.message:'Could not load local repositories.');}).finally(()=>{if(!controller.signal.aborted)setCatalogLoading(false);});
    return()=>controller.abort();
  },[repositoryHeader,catalogEpoch,initialRepository]);
  useEffect(()=>{void reloadPins();},[catalogEpoch,reloadPins]);
  const [searchRequest,setSearchRequest]=useState<SearchRequest|null>(null),[navigationRequest,setNavigationRequest]=useState<NavigationRequest|null>(null),[outlineState,setOutlineState]=useState<OutlineState|null>(null);
  const searchReturnFocus=useRef<HTMLElement|null>(null),navigationId=useRef(0),currentContext=useRef({repo:initialRepository,path:'',ref:''});
  const reportContext=useCallback((value:{repo:string;path:string;ref:string})=>{currentContext.current=value;},[]);
  const navigationConsumed=useCallback((id:number)=>setNavigationRequest(value=>value?.id===id?null:value),[]);
  const reportOutline=useCallback((value:OutlineState|null)=>setOutlineState(value),[]);
  const openSearch=(value:SearchRequest)=>{if(isNativeClosing())return;searchReturnFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setSearchRequest(value);};
  const editorDirty=useRef(false),beforeLeave=useRef<((reason?:'close')=>Promise<void>)|null>(null);
 const windowRoot=useRef<HTMLDivElement>(null);
 const nativeWindow=useNativeWindow(windowRoot,beforeLeave);
 const [filesRequested,setFilesRequested]=useState(false);
 const [fileViewActive,setFileViewActive]=useState(false),[fileSidebarOpen,setFileSidebarOpen]=useState(true);
 const [renamedLocation,setRenamedLocation]=useState<{path:string;directory:boolean}|null>(null);
 const [navigationError,setNavigationError]=useState('');
 const registerBeforeLeave=useCallback((fn:(reason?:'close')=>Promise<void>)=>{beforeLeave.current=fn;},[]);
 const completeNavigation=async(action:()=>void)=>{if(isNativeClosing())return;try{setNavigationError('');await beforeLeave.current?.();if(isNativeClosing())return;action();setPendingNavigation(null);}catch(reason){setNavigationError(`Could not preserve the draft: ${(reason as Error).message}`);}};
  const reportEditorDirty=useCallback((dirty:boolean)=>{editorDirty.current=dirty;},[]);
  const [pendingNavigation,setPendingNavigation]=useState<(()=>void)|null>(null);
  const leaveEditor=(action:()=>void,preserveMountedEditor=false)=>{if(editorDirty.current&&(!workspaceView||!preserveMountedEditor))setPendingNavigation(()=>action);else void completeNavigation(action);};
  const [showDraft,setShowDraft]=useState(false),[createRepositoryFile,setCreateRepositoryFile]=useState(false);
  const [codeEpoch,setCodeEpoch]=useState(0);
  const focusRepositoryTrigger=()=>requestAnimationFrame(()=>{if(!isNativeClosing())windowRoot.current?.querySelector<HTMLButtonElement>('.rh-repository-name')?.focus();});
  const activateRepository=(name:string,files=false)=>{setNavigationRequest(null);setOutlineState(null);const leavingHome=Boolean(workspaceView);setWorkspaceView(null);setRepository(name);setFilesRequested(files);setRenamedLocation(null);setShowDraft(false);setCreateRepositoryFile(false);setCodeEpoch(value=>value+1);beforeLeave.current=null;editorDirty.current=false;if(leavingHome)focusRepositoryTrigger();};
  const selectRepository=(name:string)=>{if(isNativeClosing()||(name===repository&&!workspaceView))return;leaveEditor(()=>activateRepository(name));};
  const openLocation=(value:WorkspaceLocation)=>{setSearchRequest(null);leaveEditor(()=>{if(value.repo!==repository||showDraft)activateRepository(value.repo,true);else setWorkspaceView(null);setNavigationRequest({...value,id:++navigationId.current});});};
  const openEntryAction=(entry:CatalogEntryAction)=>{
    if(entry.command==='reveal'){void revealRepositoryItem({repo:entry.repository,path:entry.path}).catch(reason=>setNavigationError(reason.message));return;}
    if(entry.command==='copy-path'){void navigator.clipboard.writeText(entry.path).catch(()=>setNavigationError('The path could not be copied.'));return;}
    openLocation({repo:entry.repository,path:entry.path.split('/').slice(0,-1).join('/'),type:'directory',ref:'',entryAction:{path:entry.path,type:entry.type,command:entry.command}});
  };
  const openWorkspaceView=(view:'home'|'organization'|'repositories')=>{if(workspaceView===view||isNativeClosing())return;leaveEditor(()=>{setWorkspaceView(view);setCatalogEpoch(value=>value+1);},true);};
  const setRepositorySidebarOpen=(open:boolean)=>{if(isNativeClosing())return;setCatalogSidebarOpen(open);if(!open)requestAnimationFrame(()=>{if(!isNativeClosing())windowRoot.current?.querySelector<HTMLButtonElement>('[aria-label="Toggle repository sidebar"]')?.focus();});};
  const returnToRepository=()=>{if(isNativeClosing())return;setWorkspaceView(null);focusRepositoryTrigger();};
  const openImport=()=>{importReturnFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;leaveEditor(()=>{setCatalogEpoch(value=>value+1);setImportOpen(true);});};
  const openNewRepository=()=>{newRepositoryReturnFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;leaveEditor(()=>{setCatalogEpoch(value=>value+1);setNewRepositoryOpen(true);});};
  const imported=(value:ImportedRepository|ClonedRepository)=>{
    setImportOpen(false);
    setCatalog(previous=>previous?{...previous,repositories:[...previous.repositories.filter(item=>item.name!==value.name),{name:value.name,privateRepo:true}]}:previous);
    setCatalogEpoch(value=>value+1);
    if(!isNativeClosing())activateRepository(value.name);
  };
  const created=(value:CreatedRepository)=>{
    setNewRepositoryOpen(false);
    setCatalog(previous=>previous?{...previous,repositories:[...previous.repositories.filter(item=>item.name!==value.name),{name:value.name,privateRepo:true}]}:previous);
    setCatalogEpoch(value=>value+1);
    // The current editor was preserved before opening this modal. Open the new
    // empty directory with the existing file/folder controls available.
    if(!isNativeClosing()){setFileSidebarOpen(true);activateRepository(value.name,true);}
  };
  const openRepositoryFiles=()=>{if(fileViewActive){setWorkspaceView(null);setFileSidebarOpen(true);return;}leaveEditor(()=>{setFileSidebarOpen(true);activateRepository(repository,true);});};
  const toggleRepositoryFiles=()=>{if(workspaceView)openRepositoryFiles();else if(fileViewActive)setFileSidebarOpen(value=>!value);else openRepositoryFiles();};
  const repositoryHome=()=>leaveEditor(()=>activateRepository(repository));
  const renameRepository=async(name:string,location:{path:string;directory:boolean})=>{
    const result=await renameManagedRepository({repository,name});
    setCatalog(previous=>previous?{...previous,repositories:result.repositories,defaultRepository:result.defaultRepository}:previous);
    void reloadPins();setRenamedLocation(location);setRepository(result.repository);setShowDraft(false);setCreateRepositoryFile(false);setFilesRequested(location.directory);beforeLeave.current=null;
  };
  const manageRepository=async(operation:CatalogRepositoryOperation)=>{
    const bridge=getNativeBridge();
    if(!bridge||isNativeClosing())throw new Error('Repository management is unavailable while closing.');
    if(managementPending.current)throw new Error('Wait for the current repository operation.');
    managementPending.current=true;setManagementBusy(true);
    try{await nativeOperation(async()=>{
      // The catalog keeps the editor mounted. Preserve every retained buffer and
      // reject unsaved filename intent before changing its repository identity.
      await beforeLeave.current?.('close');
      if(isNativeClosing())throw new Error('The application is closing. Try again after reopening.');
      const result=operation.kind==='rename'?await bridge.renameRepository({repository:operation.repository,name:operation.name}):
        operation.kind==='duplicate'?await bridge.duplicateRepository({repository:operation.repository,name:operation.name,requestId:operation.requestId}):
        operation.kind==='trash'?await bridge.trashRepository({repository:operation.repository,requestId:operation.requestId}):
        await bridge.restoreRepository({trashId:operation.trashId,name:operation.name});
      setCatalog(previous=>previous?{...previous,repositories:result.repositories,defaultRepository:result.defaultRepository}:previous);
      if((operation.kind==='rename'||operation.kind==='trash')&&operation.repository===repository){
        // No stale close hook may write to the old name after publication. Only
        // now replace the mounted editor; failed operations retain its undo.
        beforeLeave.current=null;editorDirty.current=false;setOutlineState(null);setNavigationRequest(null);
        setRepository(operation.kind==='trash'?result.defaultRepository:result.repository);
        setRenamedLocation({path:'',directory:true});setFilesRequested(true);setShowDraft(false);setCreateRepositoryFile(false);setCodeEpoch(value=>value+1);
      }
      setCatalogEpoch(value=>value+1);void reloadPins();
    });}finally{managementPending.current=false;setManagementBusy(false);}
  };
  const next=useRef(2);
  const [themeId,setThemeId]=useState<string|null>(initialTheme),[themeOpen,setThemeOpen]=useState(false),[savedHideUnavailable,setHideUnavailable]=useState(initialHideUnavailable);
  const previewBuild=buildChannel==='preview';
  // Build policy affects rendering; theme saves retain the stored developer preference.
  const hideUnavailable=previewBuild||savedHideUnavailable;
  const changeTheme=(value:string|null)=>{setThemeId(value);nativeWindow.persistAppearance({themeId:value,hideUnavailable:savedHideUnavailable});};
  const changeVisibility=()=>{if(previewBuild)return;const next=!savedHideUnavailable;setHideUnavailable(next);nativeWindow.persistAppearance({themeId,hideUnavailable:next});};
  const themeButton=useRef<HTMLButtonElement>(null);
  const theme=themes.find(item=>item.id===themeId);
  const themeStyle=theme?{...theme.variables,...Object.fromEntries(Object.entries(theme.variables).map(([key,value])=>[key.replace('--ws-','--fw-'),value])),colorScheme:theme.appearance} as React.CSSProperties:undefined;
  const [windowState,setWindowState]=useState<'open'|'minimized'|'closed'>('open');
  const [expanded,setExpanded]=useState(true);
  const [documents,setDocuments]=useState([{id:1,title:'Untitled',text:''}]);
  const [closed,setClosed]=useState<number[]>([]);
  const open=(id:number)=>leaveEditor(()=>{setShowDraft(true);setClosed(items=>items.filter(value=>value!==id));setActive(id);});
  const [active,setActive]=useState(1),[sidebar,setSidebar]=useState(initialSidebar),[reading,setReading]=useState(false),[search,setSearch]=useState(false),[query,setQuery]=useState(''),[menu,setMenu]=useState(false);
  const doc=documents.find(item=>item.id===active);
  const selectedReadOnly=isDocumentationRepository(catalog?.repositories.find(item=>item.name===repository));
  const create=()=>{if(selectedReadOnly)return;leaveEditor(()=>{setWorkspaceView(null);if(repositoryCode){setRenamedLocation(null);setShowDraft(false);setCreateRepositoryFile(true);setCodeEpoch(value=>value+1);beforeLeave.current=null;editorDirty.current=false;return;}setShowDraft(true);const id=next.current++;setDocuments(items=>[...items,{id,title:`Untitled ${id}`,text:''}]);setActive(id);});};
  const close=(id:number)=>{setClosed(items=>[...items,id]);if(active===id)setActive(documents.find(item=>item.id!==id&&!closed.includes(item.id))?.id??0);};
  const update=(key:'title'|'text',value:string)=>setDocuments(items=>items.map(item=>item.id===active?{...item,[key]:value}:item));
  useEffect(()=>{const onKey=(event:KeyboardEvent)=>{if(event.defaultPrevented||event.isComposing||document.querySelector('dialog[open]'))return;const modified=event.metaKey||event.ctrlKey;if(!event.altKey&&modified&&event.key.toLowerCase()==='p'){event.preventDefault();openSearch({mode:'files',repo:repository,ref:currentContext.current.ref,finder:true});}else if(isTypingTarget(event.target))return;else if(!modified&&!event.altKey&&event.key==='/'){event.preventDefault();openSearch({mode:'content',repo:null});}else if(!modified&&!event.altKey&&event.key.toLowerCase()==='t'&&!workspaceView){event.preventDefault();openSearch({mode:'files',repo:repository,ref:currentContext.current.ref,finder:true});}};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[repository,workspaceView]);
  const visibleOutline=workspaceView?null:outlineState;
  const [outlineOpen,setOutlineOpen]=useState(false);
  const [outlineWidth,setOutlineWidth]=useState(240);
  const outlineKeyboardOpen=useRef(false);
  const focusOutlineToggle=()=>windowRoot.current?.querySelector<HTMLButtonElement>('[aria-label="Toggle document outline"]')?.focus({preventScroll:true});
  const closeOutline=()=>{outlineKeyboardOpen.current=false;setOutlineOpen(false);focusOutlineToggle();};
  const toggleOutline=(event:React.MouseEvent<HTMLButtonElement>)=>{
    if(outlineOpen)closeOutline();
    else{outlineKeyboardOpen.current=event.detail===0;setOutlineOpen(true);}
  };
  const focusOpenedOutline=()=>{
    if(!outlineOpen||!outlineKeyboardOpen.current)return;
    outlineKeyboardOpen.current=false;
    if(document.querySelector('dialog[open]')||nativeWindow.closing)return;
    const panel=windowRoot.current?.querySelector('.ido-panel');
    const target=panel?.querySelector<HTMLElement>('.do-entry[aria-current="location"]:not(:disabled)')??panel?.querySelector<HTMLElement>('.do-entry:not(:disabled)')??panel?.querySelector<HTMLElement>('[aria-label="Close document outline"]');
    target?.focus({preventScroll:true});
  };
  const returnFromOutline=()=>{
    const target=[...(windowRoot.current?.querySelectorAll<HTMLElement>('.fw-repository-surface:not([hidden]) .rfe-preview article, .fw-repository-surface:not([hidden]) .rfe-directory-content article, .fw-repository-surface:not([hidden]) .cm-content, .fw-repository-surface:not([hidden]) .rc-document article')??[])].find(element=>element.getClientRects().length>0);
    if(target){if(!target.classList.contains('cm-content'))target.tabIndex=-1;target.focus({preventScroll:true});}else focusRepositoryTrigger();
  };

  const windowRest=windowState!=='open'?<div className="fw-window-rest"><button autoFocus onClick={()=>setWindowState('open')}>{windowState==='closed'?'Reopen window':'Restore window'}</button><span>Session drafts retained</span></div>:null;
  return <>{windowRest}<div ref={windowRoot} inert={nativeWindow.closing} hidden={windowState!=='open'} className={`fw-window ${nativeWindow.native?'fw-native':''} ${expanded?'':'fw-window-restored'} ${hideUnavailable?'fw-hide-unavailable':''}`} style={{...themeStyle,...(windowState!=='open'?{display:'none'}:{})}} onKeyDown={event=>{if(event.key==='Escape'){setMenu(false);if(themeOpen){setThemeOpen(false);themeButton.current?.focus();}}}}>
    {searchRequest&&<WorkspaceSearch request={searchRequest} repositories={catalog?.repositories??[]} returnFocus={searchReturnFocus.current} onClose={()=>setSearchRequest(null)} onOpen={openLocation}/>}
    {pendingNavigation&&<LeaveEditorDialog error={navigationError} onKeep={()=>setPendingNavigation(null)} onDiscard={()=>{void completeNavigation(pendingNavigation);}}/>}
    {importOpen&&<ZipImportDialog catalog={catalog} loading={catalogLoading} catalogError={catalogError} returnFocus={importReturnFocus.current} account={connectedGitHub} connectionConfigured={github.connection?.configured} onConnectionRefresh={()=>{void github.refresh();}} onRetry={()=>setCatalogEpoch(value=>value+1)} onClose={()=>{setImportOpen(false);void github.refresh();}} onImported={imported}/>}
    {newRepositoryOpen&&<NewRepositoryDialog catalog={catalog} loading={catalogLoading} catalogError={catalogError} returnFocus={newRepositoryReturnFocus.current} onRetry={()=>setCatalogEpoch(value=>value+1)} onClose={()=>setNewRepositoryOpen(false)} onCreated={created}/>}
    {gitHubOpen&&<GitHubConnectionDialog connection={github.connection} error={github.error} onRefresh={()=>{void github.refresh();}} onConnected={github.connected} onClose={()=>{setGitHubOpen(false);void github.refresh();}}/>}
    {appSignInOpen&&<ApplicationSignInDialog status={application.status} onSignedIn={()=>{void application.refresh();}} onClose={()=>{setAppSignInOpen(false);void application.refresh();}}/>}
    {appProfileOpen&&application.status?.account&&<ApplicationProfileDialog account={application.status.account} status={application.status} onChanged={value=>{application.accept(value);if(!value.account)setAppProfileOpen(false);}} onReauthenticate={()=>{setAppProfileOpen(false);setAppSignInOpen(true);}} onClose={()=>setAppProfileOpen(false)}/>}
    {nativeWindow.closing&&<div role="status" className="rfe-notice">Preserving local work before closing…</div>}
    {nativeWindow.error&&<div role="alert" className="rfe-error">{nativeWindow.error}</div>}
    {nativeWindow.appearanceError&&<div role="alert" className="rfe-error">{nativeWindow.appearanceError} <button onClick={()=>nativeWindow.persistAppearance({themeId,hideUnavailable:savedHideUnavailable})}>Retry appearance save</button></div>}
    {navigationError&&<div role="alert" className="rfe-error">{navigationError}</div>}
    <header className="fw-titlebar">
      <div className="fw-traffic" role="group" aria-label={nativeWindow.native?'Window controls':'Preview window controls'}>
        <button className="fw-light fw-light-close" aria-label={nativeWindow.native?'Close window':'Close preview window'} title={nativeWindow.native?'Close window':'Close preview window'} onClick={()=>nativeWindow.native?nativeWindow.windowAction('close'):setWindowState('closed')}><span aria-hidden="true">×</span></button>
        <button className="fw-light fw-light-minimize" aria-label={nativeWindow.native?'Minimize window':'Minimize preview window'} title={nativeWindow.native?'Minimize window':'Minimize preview window'} onClick={()=>nativeWindow.native?nativeWindow.windowAction('minimize'):setWindowState('minimized')}><span aria-hidden="true">−</span></button>
        <button className="fw-light fw-light-expand" aria-label={nativeWindow.native?'Maximize or restore window':expanded?'Restore preview size':'Expand preview window'} title={nativeWindow.native?'Maximize or restore window':expanded?'Restore preview size':'Expand preview window'} aria-pressed={nativeWindow.native?undefined:expanded} onClick={()=>nativeWindow.native?nativeWindow.windowAction('maximize'):setExpanded(value=>!value)}><span aria-hidden="true">{expanded?'↙':'↗'}</span></button>
      </div>
      <IconButton icon="left" label={catalogView?"Toggle repository sidebar":"Toggle file sidebar"} expanded={catalogView?catalogSidebarOpen:repositoryCode?!workspaceView&&fileViewActive&&fileSidebarOpen:sidebar} onClick={catalogView?()=>setRepositorySidebarOpen(!catalogSidebarOpen):repositoryCode?toggleRepositoryFiles:()=>setSidebar(value=>!value)}/>
      {repositoryHeader?<RepositoryHeader onHome={repositoryHome} onApplicationHome={()=>openWorkspaceView('home')} onOrganization={()=>openWorkspaceView('repositories')} currentView={workspaceView??'repository'} repositories={catalog?.repositories??[]} loading={catalogLoading} error={catalogError} onRetry={()=>setCatalogEpoch(value=>value+1)} selectedRepository={repository} initialRepository={initialRepository} onSelect={name=>{selectRepository(name);return false;}}/>:<><nav className="fw-tabs" aria-label="Open documents">{documents.filter(item=>!closed.includes(item.id)).map(item=><div className={`fw-tab ${item.id===active?'is-active':''}`} key={item.id}><button aria-current={item.id===active?'page':undefined} onClick={()=>open(item.id)}>{item.title||'Untitled'}</button><IconButton icon="close" label={`Close ${item.title || 'Untitled'} tab; keep session draft`} onClick={()=>close(item.id)}/></div>)}</nav>
      <IconButton icon="plus" label="New document" onClick={create}/></>}<div className="fw-spacer"/>
      {repositoryHeader&&<RepositoryActions showAgentPlaceholder={!previewBuild} onSearch={getNativeBridge()?.searchRepositoryText?()=>openSearch({mode:'content',repo:null}):undefined} onAllRepositories={()=>openWorkspaceView('repositories')} allRepositoriesActive={catalogView} onNew={selectedReadOnly?undefined:create} onImport={openImport} onNewRepository={getNativeBridge()?.createRepository?openNewRepository:undefined}/>}
      <IconButton icon="right" label="Toggle document outline" expanded={outlineOpen} alwaysVisible onClick={toggleOutline}/>
    </header>
    {themeOpen&&<><button className="fw-theme-backdrop" aria-label="Dismiss theme picker" tabIndex={-1} onClick={()=>{setThemeOpen(false);themeButton.current?.focus();}}/><section className="fw-theme-picker" aria-label="asMagicBrain Theme"><h2>asMagicBrain Theme</h2><label>Theme<select autoFocus value={themeId??''} onChange={event=>changeTheme(event.target.value||null)}><option value="">Current reference appearance</option>{themes.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label><button onClick={()=>{setThemeOpen(false);themeButton.current?.focus();}}>Done</button></section></>}
    <div className="fw-body">
      <nav className="fw-rail" aria-label="Workspace tools">
        <div className="fw-spacer"/>
        {repositoryHeader?<AccountControls preferences={accountPreferences.preferences} loading={accountPreferences.loading} error={accountPreferences.error} onReload={()=>{void accountPreferences.refresh().catch(()=>{});}} onSave={accountPreferences.save} settingsRequest={accountPreferences.settingsRequest} onSettingsClose={accountPreferences.closeSettings} onAppearance={()=>setThemeOpen(true)} application={nativeWindow.native?{
          status:application.status,loading:application.loading,busy:application.busy,error:application.error,
          onSignIn:application.status?.configured&&application.status.state!=='unavailable'?()=>{if(!application.busy&&!isNativeClosing())setAppSignInOpen(true);}:undefined,
          onProfile:application.status?.account?()=>setAppProfileOpen(true):undefined,
          onRefresh:()=>{void application.refresh(true);},
          onSignOut:application.status?.configured&&(application.status.account||application.status.state==='expired'||application.status.state==='unavailable')?()=>{void application.signOut();}:undefined,
        }:undefined} account={connectedGitHub??(accountPreview?{username:'example-user',displayName:'Example User',preview:true}:undefined)} connectedIdentity={connectedGitHub?{name:connectedGitHub.displayName||connectedGitHub.username,email:connectedGitHub.email}:undefined} signInLabel={nativeWindow.native?'Connect GitHub':'Sign in'} accountBusy={gitHubDisconnecting} connectionStatus={gitHubDisconnecting?'Disconnecting GitHub…':gitHubActionError||github.error||(nativeWindow.native?(github.connection?.state==='expired'?'GitHub connection expired':github.connection&&!github.connection.configured?'GitHub connection unavailable in this build':github.connection?.state==='unavailable'?'GitHub connection unavailable':undefined):undefined)} onSignIn={github.connection?.configured&&github.connection.state!=='unavailable'?()=>{if(disconnectingGitHub.current||isNativeClosing())return;setGitHubActionError('');setGitHubOpen(true);}:undefined} signOutLabel={nativeWindow.native?'Disconnect GitHub':'Sign out'} allowDisconnect={canDisconnectGitHub} onSignOut={canDisconnectGitHub?()=>{void disconnectGitHub();}:undefined}/>:<IconButton icon="person" label="Account — unavailable" unavailable disabled/>}
        <button ref={themeButton} className="fw-icon" aria-label="asMagicBrain Theme" title="asMagicBrain Theme" aria-expanded={themeOpen} onClick={()=>setThemeOpen(value=>!value)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor"/></svg></button>
        {!previewBuild&&<button className="fw-icon fw-visibility-switch" role="switch" aria-checked={hideUnavailable} aria-label="Hide unavailable functions" title={hideUnavailable?'Show unavailable functions':'Hide unavailable functions'} onClick={changeVisibility}><span className="fw-visibility-light" aria-hidden="true"/></button>}
      </nav>
      {sidebar&&!repositoryCode&&!nativeWindow.native&&<aside className="fw-sidebar" aria-label="Files"><h2>My writing</h2>{search&&<input autoFocus aria-label="Search file names" placeholder="Search files…" value={query} onChange={event=>setQuery(event.target.value)}/>}<button className="fw-new" onClick={create}>+ New document</button>{documents.filter(item=>!search||item.title.toLowerCase().includes(query.toLowerCase())).map(item=><button className="fw-file" aria-current={item.id===active?'page':undefined} key={item.id} onClick={()=>open(item.id)}><FrameIcon name="file"/>{item.title||'Untitled'}</button>)}</aside>}
      <main className="fw-main">
        {catalogView&&<AllRepositories managementBusy={managementBusy} onRepositoryOperation={getNativeBridge()?.duplicateRepository?manageRepository:undefined} onListTrashedRepositories={getNativeBridge()?.listTrashedRepositories?()=>nativeOperation(()=>getNativeBridge()!.listTrashedRepositories()):undefined} onEntryAction={openEntryAction} onRevealRepository={getNativeBridge()?.revealItem?name=>revealRepositoryItem({repo:name,path:''}):undefined} defaultRepository={catalog?.defaultRepository??pins.defaultRepository} pinnedRepositories={pins.pinnedRepositories} pinsLoading={pinsLoading} pinsBusy={pinsBusy} pinsError={pinsError} onTogglePin={getNativeBridge()?.setRepositoryPinned?togglePin:undefined} onRetryPins={()=>{void reloadPins();}} onOpenLocation={(repo,path,type)=>openLocation({repo,path,type,ref:''})} repositories={catalog?.repositories??[]} loading={catalogLoading} error={catalogError} onRetry={()=>setCatalogEpoch(value=>value+1)} currentRepository={repository} onOpenRepository={name=>{leaveEditor(()=>activateRepository(name));}} onReturnToRepository={returnToRepository} onNewRepository={getNativeBridge()?.createRepository?openNewRepository:undefined} sidebarOpen={catalogSidebarOpen} onSidebarOpenChange={setRepositorySidebarOpen}/>}
        {workspaceView==='home'&&<WorkspaceHome view={workspaceView} repositories={catalog?.repositories??[]} catalogLoading={catalogLoading} catalogError={catalogError} onRetry={()=>setCatalogEpoch(value=>value+1)} currentRepository={repository} onOpenRepository={name=>{leaveEditor(()=>activateRepository(name));}} onReturnToRepository={returnToRepository} onNewRepository={getNativeBridge()?.createRepository?openNewRepository:undefined} onImport={openImport} applicationStatus={application.status} applicationLoading={application.loading} applicationBusy={application.busy} applicationError={application.error} onSignIn={nativeWindow.native&&application.status?.configured&&application.status.state!=='unavailable'?()=>{if(!application.busy&&!isNativeClosing())setAppSignInOpen(true);}:undefined} onProfile={nativeWindow.native&&application.status?.account?()=>setAppProfileOpen(true):undefined} onRefresh={nativeWindow.native?()=>{void application.refresh(true);}:undefined}/>}
        {/* Keep the editor and native close/checkpoint hooks mounted while browsing workspace views. */}
        <div className="fw-repository-surface" hidden={Boolean(workspaceView)}>
        {!repositoryHeader&&<div className="fw-documentbar"><div className="fw-history"><button disabled data-unavailable aria-label="Go back">←</button><button disabled data-unavailable aria-label="Go forward">→</button></div><span>{doc?.title||'No document'}</span><div className="fw-actions"><IconButton icon="file" label={reading?'Edit document':'Read document'} expanded={reading} disabled={!doc} onClick={()=>setReading(value=>!value)}/><IconButton icon="more" label="Document options" expanded={menu} onClick={()=>setMenu(value=>!value)}/></div></div>}
        {menu&&<div className="fw-menu"><p>Layout prototype · session only</p><button onClick={()=>{create();setMenu(false);}}>New document</button><button onClick={()=>setMenu(false)}>Close menu</button></div>}
        <div className="rt-code-panel">
        {repositoryCode&&!showDraft?(nativeWindow.native&&!catalog?<p role="status">{catalogError||'Loading repositories…'}</p>:<RepositoryCodePage readOnly={selectedReadOnly} key={`${repository}-${codeEpoch}`} repository={repository} initialEdit={initialEdit&&codeEpoch===0} initialCreate={createRepositoryFile} initialFile={renamedLocation&&!renamedLocation.directory?renamedLocation.path:undefined} initialDirectory={renamedLocation?.directory?renamedLocation.path:filesRequested?'':codeEpoch===0&&repository===initialRepository?initialDirectory:undefined} fileSidebarOpen={fileSidebarOpen} onFileSidebarOpenChange={setFileSidebarOpen} onFileViewChange={setFileViewActive} onRenameRepository={nativeWindow.native?renameRepository:undefined} onDirtyChange={reportEditorDirty} registerBeforeLeave={registerBeforeLeave} navigationRequest={navigationRequest} onNavigationHandled={navigationConsumed} onOutlineChange={reportOutline} onDocumentContextChange={reportContext} onSearch={getNativeBridge()?.searchRepositoryText?openSearch:undefined}/>):doc?<div className="fw-writing" key={doc.id}>{reading?<><h1>{doc.title||'Untitled'}</h1><div className="fw-reading">{doc.text}</div></>:<><input className="fw-heading" aria-label="Document title" value={doc.title} placeholder="Untitled" onChange={event=>update('title',event.target.value)}/><textarea className="fw-editor" aria-label="Document text" spellCheck placeholder="" value={doc.text} onChange={event=>update('text',event.target.value)}/></>}</div>:<div className="fw-empty"><button onClick={create}>New document</button></div>}
        </div>
        {(!repositoryCode||showDraft)&&<footer className="fw-status"><span>{reading?'Reading':'Editing'}</span><span>{doc?.text.trim()?doc.text.trim().split(/\s+/u).length:0} words</span><span>{Array.from(doc?.text??'').length} characters</span></footer>}
        </div>
      </main>
      {outlineOpen&&<IntegratedDocumentOutline mainWindow={windowRoot} outline={visibleOutline} width={outlineWidth}
        onResize={setOutlineWidth} onClose={closeOutline} disabled={nativeWindow.closing} onReady={focusOpenedOutline}
        onReturnToDocument={()=>{outlineKeyboardOpen.current=false;setOutlineOpen(false);returnFromOutline();}}/>}
    </div>
  </div></>;
}
