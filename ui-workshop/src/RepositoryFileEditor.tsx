import {getNativeBridge, isNativeClosing, readRepository, revealRepositoryItem} from './native-bridge.mjs';
import {assertFilenameIntentRetained} from './native-close.mjs';
import React, {useEffect, useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Compartment, EditorState} from '@codemirror/state';
import {EditorView, drawSelection, keymap, lineNumbers} from '@codemirror/view';
import {defaultKeymap, history, historyKeymap, indentWithTab} from '@codemirror/commands';
import {search,searchKeymap,openSearchPanel} from '@codemirror/search';
import {buildDocumentOutline,type DocumentOutlineEntry} from './outline-model';
import {searchSelection,type NavigationRequest,type OutlineState,type SearchRequest} from './workspace-navigation';
import {foldGutter, indentUnit, syntaxHighlighting} from '@codemirror/language';
import {markdown} from '@codemirror/lang-markdown';
import {sourceHighlightStyle} from '../../apps/desktop/ui/cm6-theme.mjs';
import {createRawHistory, dispatchSourceTransactions} from '../../apps/desktop/ui/cm6-history.mjs';
import {renderSourcePreview} from '../../apps/desktop/ui/markdown-preview.mjs';
import {RepositoryDocument, RepositoryMedia, isRepositoryMedia} from './RepositoryDocument';
import {FileNavigationControls} from './FileNavigationControls';
import {RepositoryRenameDialog} from './RepositoryRenameDialog';
import {FileEntryRenameDialog} from './FileEntryRenameDialog';
import {RepositoryUpdatesDialog, useRepositoryUpdatesAvailability} from './RepositoryUpdatesDialog';
import {repositoryUpdatesUnavailable} from './repository-updates';
import type {RepositoryUpdateApplied} from './native-types';
import {DirectoryMoreActions, DirectoryAddActions, FileMoreActions, FileEditOptions, FileSpaceActions} from './FileViewActions';
import {createLocalWorkspaceClient, type LocalWorkspaceClient, type WorkspaceDocument, type WorkspaceEntry, type GitReview} from './local-workspace-client';
import {createFileSession, createMediaSession, isReadOnlyMediaSession, createNewFileSession, replaceFileSession, confirmedDiscardSession, completeNewDraftCleanup, fileModes, hasFileChanges, isMarkdownFile, validateFilePath, type FileSession} from './repository-file-session';
import {RepositoryExplorer} from './RepositoryExplorer';
import {PanelResizeHandle} from './PanelResizeHandle';
import {useRepositoryManagement, RepositoryManagementDialog} from './RepositoryManagement';
import {insidePath, remapPath, remapSessions, restoreRetainedSessions, parentPath, type ManagementResult} from './repository-management';
import './repository-file-editor.css';
import {useCommitPreferences} from './CommitPreferencesContext';
import {authorValid, resolveCommitAuthor, type CommitPreferences} from './commit-preferences';

type Entry = {name: string; path: string; type: 'file' | 'directory'; message?: string; date?: string};
type Commit = {author: string; message: string; sha: string; date: string} | null;
type Snapshot = {entries: Entry[]; type: 'file' | 'directory'; content: string | null; commit?: Commit; readmePath?: string | null; readme?: string | null};
type DirectoryView = {path: string; snapshot: Snapshot | null};
type Props = {readOnly?:boolean;navigationRequest?:NavigationRequest|null;onNavigationHandled?(id:number):void;onOutlineChange?(outline:OutlineState|null):void;onDocumentContextChange?(value:{repo:string;path:string;ref:string}):void;onSearch?(value:SearchRequest):void;repository: string; initialPath: string; initialFragment?: string; initialSource: string; initialDirectory?: string; revision: string; branch: string; branches: string[]; tags: string[]; commit?: Commit; workspace?: LocalWorkspaceClient; initialCreate?: boolean; panelResizePreview?: boolean; fileSidebarOpen?: boolean; onFileSidebarOpenChange?(open: boolean): void; onRenameRepository?(name: string, location: {path: string; directory: boolean}): Promise<void>; onRepositoryUpdated?(result: RepositoryUpdateApplied): Promise<void>; registerBeforeLeave?(fn: (reason?: 'close') => Promise<void>): void; onClose(): void; onRevisionChange?(ref: string, path: string): Promise<void>; onDirtyChange?(dirty: boolean): void};
type CommitForm = {sessionId: string; paths: string[]; available: {path: string; status: string}[]; review: GitReview | null; initialized: boolean; message: string; description: string; name: string; email: string; authorSource: 'asmagicbrain'|'github'|'manual'; preferencesRevision: number|null; authorSettingsError: string; error: string};
const icons: Record<string, string> = {copy:'M6 6h8v9H6ZM10 3V1H1v10h2',pencil:'m3 10 7-7 3 3-7 7-4 1ZM9 4l3 3',search:'M11 6a5 5 0 1 1-10 0 5 5 0 0 1 10 0m-1 4 5 5',file:'M4 1h7l4 4v10H4ZM11 1v4h4',folder:'M1 3h5l2 2h7v9H1Z',panel:'M1 2h14v12H1Zm5 0v12',chevron:'m6 4 4 4-4 4'};
function Icon({name}: {name: string}) {return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[name] || icons.file}/></svg>;}

export function RepositoryFileEditor(props: Props) {
 const {repository, initialPath, initialSource, revision, branch, onClose} = props;
 const local = !revision;
 const [repositoryReadOnly,setRepositoryReadOnly]=useState(Boolean(props.readOnly)),repositoryReadOnlyRef=useRef(Boolean(props.readOnly));
 const authorPreferences = useCommitPreferences();
 const suspendedCommit = useRef<CommitForm|null>(null);
 const lastSettingsClosed = useRef(authorPreferences?.settingsClosed??0);
 const savedMessages = useRef(new Map<string,string>());
 const workspace = useMemo(() => props.workspace ?? createLocalWorkspaceClient(repository), [props.workspace, repository]);
 const first = useRef<FileSession | null>(null);
 if (!first.current) first.current = isRepositoryMedia(initialPath)&&!props.initialCreate ? createMediaSession(initialPath,revision) : createFileSession({path: initialPath, documentId: `initial:${initialPath}`, sourceHash: null, text: initialSource, readOnly: true});
 const sessions = useRef(new Map<string, FileSession>([[first.current.id, first.current]])), active = useRef(first.current);
 const [path,setPath]=useState(initialPath),[source,setSource]=useState<string>(first.current.buffer.getText()),[editing,setEditing]=useState(false),[preview,setPreview]=useState(isMarkdownFile(initialPath));
 const [fragment,setFragment]=useState(props.initialFragment??'');
 const [directoryView,setDirectoryView]=useState<DirectoryView|null>(props.initialDirectory===undefined?null:{path:props.initialDirectory,snapshot:null});
 const directoryRef=useRef(directoryView);directoryRef.current=directoryView;
 const [commit,setCommit]=useState<Commit>(props.commit??null),[uncontrolledCollapsed,setUncontrolledCollapsed]=useState(false),[width,setWidth]=useState(280),[space,setSpace]=useState('spaces'),[size,setSize]=useState(2),[wrap,setWrap]=useState(false);
 const collapsed=props.fileSidebarOpen===undefined?uncontrolledCollapsed:!props.fileSidebarOpen;
 const [renamingRepository,setRenamingRepository]=useState(false),renameButton=useRef<HTMLButtonElement>(null);
 const [renamingEntry,setRenamingEntry]=useState<string|null>(null);
 const [viewWrap,setViewWrap]=useState(false),[folding,setFolding]=useState(true),[center,setCenter]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[ready,setReady]=useState(false);
 const [rootActionsContainer,setRootActionsContainer]=useState<HTMLDivElement|null>(null);
 const [checkingGitHub,setCheckingGitHub]=useState(false);
 const [applyBusy,setApplyBusy]=useState(false),[applyHeld,setApplyHeld]=useState(false);
 const applyBusyRef=useRef(false),applyHeldRef=useRef(false);
 const updateAvailability=useRepositoryUpdatesAvailability(repository,local&&ready);
 const [managementHeld,setManagementHeld]=useState(false),[dirty,setDirty]=useState(false),[narrow,setNarrow]=useState(false),[confirmDiscard,setConfirmDiscard]=useState<string|null>(null),[copyStatus,setCopyStatus]=useState('');
 const copySequence=useRef(0),copyTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const clearCopyFeedback=()=>{copySequence.current++;if(copyTimer.current)clearTimeout(copyTimer.current);copyTimer.current=null;setCopyStatus('');};
 const [directories,setDirectories]=useState<Record<string,Entry[]>>({}),[expanded,setExpanded]=useState(new Set([''])),[commitForm,setCommitForm]=useState<CommitForm|null>(null),[folderName,setFolderName]=useState<string|null>(null),[,render]=useState(0);
 const root=useRef<HTMLElement>(null),mount=useRef<HTMLDivElement>(null),view=useRef<EditorView|null>(null),settings=useRef(new Compartment());
 const trashedSessions=useRef(new Map<string,FileSession>());
 const states=useRef(new Map<string,EditorState>()),rawHistories=useRef(new Map<string,ReturnType<typeof createRawHistory>>());
 const discardDialog=useRef<HTMLDialogElement>(null),commitDialog=useRef<HTMLDialogElement>(null),folderDialog=useRef<HTMLDialogElement>(null),cancelButton=useRef<HTMLButtonElement>(null),saveButton=useRef<HTMLButtonElement>(null),reviewButton=useRef<HTMLButtonElement>(null);
 const narrowRef=useRef(false),request=useRef<AbortController|null>(null),treeRequests=useRef(new Map<string,AbortController>()),mounted=useRef(true),callbacks=useRef(props);
 const outlineSelectionFrame=useRef<number|null>(null);
 const cancelOutlineSelection=()=>{if(outlineSelectionFrame.current!==null)cancelAnimationFrame(outlineSelectionFrame.current);outlineSelectionFrame.current=null;};
 const setCollapsed=(next:boolean)=>{if(callbacks.current.fileSidebarOpen===undefined)setUncontrolledCollapsed(next);callbacks.current.onFileSidebarOpenChange?.(!next);};
 const collapseSidebar=()=>{setCollapsed(true);root.current?.closest('.fw-window')?.querySelector<HTMLButtonElement>('[aria-label="Toggle file sidebar"]')?.focus({preventScroll:true});};
 const managementHeldRef=useRef(false);managementHeldRef.current=managementHeld;
 const operationPaths=useRef(new Set<string>());
 const pending=useRef(new Map<string,FileSession>()),timer=useRef<ReturnType<typeof setTimeout>|null>(null),checkpointChain=useRef(Promise.resolve()),flushAction=useRef<()=>Promise<void>>(async()=>{});
 const saveAction=useRef<()=>void>(()=>{}),changedPaths=useRef(new Map<string,Set<string>>()),busyRef=useRef(false);
 const id=useId(),editorOptions=useRef({editing,space,size,wrap,viewWrap,folding,busy,loading});
 editorOptions.current={editing,space,size,wrap,viewWrap,folding,busy:busy||managementHeld||applyBusy||applyHeld,loading}; callbacks.current=props;
 const refresh=()=>{if(!mounted.current)return;setSource(active.current.buffer.getText());setPath(active.current.path);setDirty([...sessions.current.values()].some(hasFileChanges));render(value=>value+1);};
 const findPath=(next:string)=>[...sessions.current.values()].find(item=>!item.isNew&&item.path===next);
 const readOnlyMedia=(item:FileSession)=>isReadOnlyMediaSession(item,Boolean(getNativeBridge()));
 const read=(next:string,signal?:AbortSignal):Promise<Snapshot>=>readRepository({repo:repository,path:next,ref:revision},signal);
 const currentDirectory=()=>directoryRef.current?.path??active.current.path.split('/').slice(0,-1).join('/');
 const showDirectory=(next:string,snapshot:Snapshot)=>{const value={path:next,snapshot};directoryRef.current=value;setDirectoryView(value);setEditing(false);clearCopyFeedback();setDirectories(previous=>({...previous,[next]:snapshot.entries}));setExpanded(previous=>{const result=new Set(previous),parts=next.split('/');for(let index=1;index<=parts.length;index++)result.add(parts.slice(0,index).join('/'));return result;});if(narrowRef.current)setCollapsed(true);};
 const flush=()=>{
  if(managementHeldRef.current)return Promise.reject(new Error('Recover the local file operation before saving drafts or leaving this view.'));
  if(timer.current)clearTimeout(timer.current);timer.current=null;
  const next=checkpointChain.current.then(async()=>{
   while(pending.current.size){const [key,item]=pending.current.entries().next().value!;const version=item.version;
    if(item.isNew)await workspace.request('checkpointNew',{draftId:item.draftId,path:item.proposedPath,text:item.buffer.getRawText()});
    else if(!item.readOnly&&item.sourceHash)await workspace.request('checkpoint',{path:item.path,baseHash:item.sourceHash,text:item.buffer.getRawText()});
    if(version===item.version){pending.current.delete(key);item.checkpointedVersion=version;}
   }
  });checkpointChain.current=next.catch(()=>{});return next;
 };
 flushAction.current=flush;
 const checkpoint=(item:FileSession)=>{if(!local||item.readOnly)return;item.version++;pending.current.set(item.id,item);if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>{void flush().then(()=>{if(mounted.current)setNotice('Draft retained locally.');}).catch(reason=>{if(mounted.current)setError(`Draft could not be retained: ${reason.message}`);});},200);};
 const configuration=()=>{const current=editorOptions.current,writable=current.editing&&!active.current.readOnly&&!readOnlyMedia(active.current)&&local&&!current.busy&&!current.loading;return[EditorState.readOnly.of(!writable),EditorView.editable.of(writable),EditorView.contentAttributes.of(writable?{}:{tabindex:'0'}),indentUnit.of(current.space==='tabs'?'\t':' '.repeat(current.size)),EditorState.tabSize.of(current.size),...((current.editing?current.wrap:current.viewWrap)?[EditorView.lineWrapping]:[]),...(!current.editing&&current.folding?[foldGutter()]:[]),...(isMarkdownFile(active.current.proposedPath)?[markdown()]:[])];};
 const makeState=(item:FileSession)=>{const rawHistory=createRawHistory(()=>item.buffer.captureHistory());rawHistories.current.set(item.id,rawHistory);return EditorState.create({doc:item.buffer.getText(),extensions:[lineNumbers(),drawSelection(),history(),search({top:true}),rawHistory.extension,syntaxHighlighting(sourceHighlightStyle),keymap.of([{key:'Mod-s',run:()=>{saveAction.current();return true;}},...searchKeymap,...defaultKeymap,...historyKeymap,indentWithTab]),settings.current.of(configuration()),EditorView.contentAttributes.of({'aria-label':'File source',spellcheck:'false'})]});};
 const activate=(item:FileSession,edit=editing)=>{directoryRef.current=null;setDirectoryView(null);if(view.current)states.current.set(active.current.id,view.current.state);active.current=item;if(view.current){view.current.setState(states.current.get(item.id)??makeState(item));view.current.dispatch({effects:settings.current.reconfigure(configuration())});}setEditing(edit&&local&&!item.readOnly&&!readOnlyMedia(item));setPreview(!edit&&isMarkdownFile(item.proposedPath));clearCopyFeedback();setError('');refresh();if(narrowRef.current)setCollapsed(true);};
 const refreshTree=async(signal?:AbortSignal)=>{
  if(local){const result=await workspace.request<{entries:WorkspaceEntry[]}>('discover');const tree:Record<string,Entry[]>=Object.create(null);tree['']=[];for(const item of result.entries){const parent=item.path.split('/').slice(0,-1).join('/');(tree[parent]??=[]).push({...item,name:item.path.split('/').at(-1)!});if(item.type==='directory')tree[item.path]??=[];}for(const list of Object.values(tree))list.sort((a,b)=>(a.type===b.type?0:a.type==='directory'?-1:1)||a.name.localeCompare(b.name));if(mounted.current&&!signal?.aborted)setDirectories(tree);}
  else{const result=await read('',signal);if(mounted.current&&!signal?.aborted)setDirectories(previous=>({...previous,'':result.entries}));}
 };
 const newDraft=async(force=false,parentOverride?:string)=>{if(repositoryReadOnlyRef.current||managementHeld||applyBusyRef.current||applyHeldRef.current||!local||(!ready&&!force)||busyRef.current||confirmDiscard!==null||commitForm!==null||folderName!==null)return;if(view.current?.composing)throw new Error('Finish text composition before creating another file.');busyRef.current=true;setBusy(true);if(!force){request.current?.abort();setLoading(false);}try{await flush();const listing=await workspace.request<{entries:WorkspaceEntry[]}>('discover');const parent=parentOverride??currentDirectory(),preferred=force?(initialPath||'untitled.md'):`${parent?parent+'/':''}untitled.md`;let next=preferred,number=2;const stem=preferred.replace(/\.(md|markdown)$/i,'');const paths=new Set([...listing.entries.map(item=>item.path),...[...sessions.current.values()].map(item=>item.proposedPath)]);while(paths.has(next))next=`${stem}-${number++}.md`;const item=createNewFileSession(crypto.randomUUID(),next);sessions.current.set(item.id,item);checkpoint(item);await flush();activate(item,true);setTimeout(()=>root.current?.querySelector<HTMLInputElement>('.rfe-path input')?.select(),0);}finally{busyRef.current=false;if(mounted.current)setBusy(false);}};
 useLayoutEffect(()=>{if(!mount.current)return;const editor=new EditorView({parent:mount.current,state:makeState(active.current),dispatchTransactions(transactions,current){const item=active.current,rawHistory=rawHistories.current.get(item.id)!;dispatchSourceTransactions(transactions,current,{onChanges(changes,historyRestore){item.buffer.applyChanges(changes,historyRestore);refresh();checkpoint(item);},onError:setError},rawHistory);}});view.current=editor;return()=>{cancelOutlineSelection();view.current=null;editor.destroy();};},[]);
 useLayoutEffect(()=>{view.current?.dispatch({effects:settings.current.reconfigure(configuration())});},[space,size,wrap,editing,viewWrap,folding,busy,managementHeld,applyBusy,applyHeld,loading,path,active.current.proposedPath]);
 useLayoutEffect(()=>{if(!preview)view.current?.requestMeasure();},[preview,collapsed,width,center,directoryView]);
 useLayoutEffect(()=>{if(!root.current)return;const observer=new ResizeObserver(entries=>{const measured=entries[0].contentRect.width;if(!measured)return;const next=measured<=520;if(next&&!narrowRef.current)setCollapsed(true);narrowRef.current=next;setNarrow(next);});observer.observe(root.current);return()=>observer.disconnect();},[]);
 useEffect(()=>{
  mounted.current=true;const controller=new AbortController();request.current=controller;
  void(async()=>{try{
   if(local){const bootstrap=await workspace.bootstrap();if(controller.signal.aborted)return;repositoryReadOnlyRef.current=Boolean(props.readOnly)||bootstrap.readOnly===true;setRepositoryReadOnly(repositoryReadOnlyRef.current);for(const draft of bootstrap.newDrafts??[]){const item=createNewFileSession(draft.draftId,draft.path,draft.text);item.checkpointedVersion=item.version;sessions.current.set(item.id,item);}
    if(props.initialCreate&&!repositoryReadOnlyRef.current){sessions.current.delete(first.current!.id);await newDraft(true);}
    else if(props.initialDirectory===undefined&&!isRepositoryMedia(initialPath)){const result=await workspace.request<WorkspaceDocument>('open',{path:initialPath});if(controller.signal.aborted)return;const item=createFileSession(result);sessions.current.delete(first.current!.id);sessions.current.set(item.id,item);activate(item);if(result.draft)setNotice('Your retained local draft has been restored.');}
   }
   if(props.initialDirectory!==undefined){sessions.current.delete(first.current!.id);const data=await read(props.initialDirectory,controller.signal);if(controller.signal.aborted)return;if(data.type!=='directory')throw new Error('This directory is unavailable.');showDirectory(props.initialDirectory,data);refresh();}
   setReady(true);await refreshTree(controller.signal);if(controller.signal.aborted)return;const parts=(props.initialDirectory===undefined?initialPath:`${props.initialDirectory}/`).split('/');for(let index=1;index<parts.length;index++){const directory=parts.slice(0,index).join('/');setExpanded(previous=>new Set([...previous,directory]));if(!local){const data=await read(directory,controller.signal);if(controller.signal.aborted)return;setDirectories(previous=>({...previous,[directory]:data.entries}));}}
  }catch(reason){if(!controller.signal.aborted)setError((reason as Error).message);}finally{if(!controller.signal.aborted)setLoading(false);}})();
  return()=>{mounted.current=false;copySequence.current++;if(copyTimer.current)clearTimeout(copyTimer.current);controller.abort();request.current?.abort();for(const item of treeRequests.current.values())item.abort();treeRequests.current.clear();void flushAction.current().catch(()=>{});};
 },[]);
 useEffect(()=>{props.registerBeforeLeave?.((reason)=>{if(reason==='close')assertFilenameIntentRetained(sessions.current.values());if(busyRef.current||applyBusyRef.current)throw new Error('Wait for the current local operation before leaving.');if(view.current?.compositionStarted)throw new Error('Finish text composition before leaving.');return flushAction.current();});},[props.registerBeforeLeave]);
 useEffect(()=>{callbacks.current.onDirtyChange?.(dirty);if(getNativeBridge())return;const guard=(event:BeforeUnloadEvent)=>{if(dirty){event.preventDefault();event.returnValue='';void flushAction.current().catch(()=>{});}};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[dirty]);
 useEffect(()=>()=>callbacks.current.onDirtyChange?.(false),[]);
 useEffect(()=>{
  // External files are accepted only by the tree. Do not turn a grey editor
  // attachment surface into an implicit file loader; text drags remain native.
  const guard=(event:DragEvent)=>{if(!Array.from(event.dataTransfer?.types??[]).includes('Files'))return;if(event.target instanceof Element&&event.target.closest('.rex'))return;event.preventDefault();if(event.type==='dragover'&&event.dataTransfer)event.dataTransfer.dropEffect='none';};
  window.addEventListener('dragover',guard,true);window.addEventListener('drop',guard,true);
  return()=>{window.removeEventListener('dragover',guard,true);window.removeEventListener('drop',guard,true);};
 },[]);
 useLayoutEffect(()=>{if(confirmDiscard)discardDialog.current?.showModal();else discardDialog.current?.close();},[confirmDiscard]);
 useLayoutEffect(()=>{if(commitForm)commitDialog.current?.showModal();else commitDialog.current?.close();},[Boolean(commitForm)]);
 useLayoutEffect(()=>{if(folderName!==null)folderDialog.current?.showModal();else folderDialog.current?.close();},[folderName!==null]);
 const run=async(action:()=>Promise<void>)=>{if(applyHeldRef.current){setError('Close and reopen asMagicBrain to recover the interrupted update.');return;}if(managementHeldRef.current){setError('Recover the local file operation before continuing.');return;}if(busyRef.current||applyBusyRef.current)return;busyRef.current=true;setBusy(true);setError('');try{await action();}catch(reason){setError((reason as Error).message);}finally{busyRef.current=false;if(mounted.current)setBusy(false);}};
 const openPath=async(next:string,kind?:'file'|'directory',nextFragment='')=>{
  if(managementHeldRef.current){setError('Recover the local file operation before navigating.');return;}
  if(!ready||busyRef.current||applyBusyRef.current||applyHeldRef.current||confirmDiscard!==null||commitForm!==null||folderName!==null)return;
  if(kind==='file'&&next===active.current.path&&!active.current.isNew&&!directoryRef.current)return;
  if(view.current?.composing){setError('Finish text composition before navigating.');return;}
  request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setError('');
  try{
   await flush();if(controller.signal.aborted)return;
   const metadata=kind==='file'?undefined:await read(next,controller.signal);if(controller.signal.aborted)return;
   if(metadata?.type==='directory'){
    setFragment(nextFragment);showDirectory(next,metadata);
    if(!local){const parts=next.split('/');for(let index=1;index<parts.length;index++){const parent=parts.slice(0,index).join('/');if(directories[parent])continue;const data=await read(parent,controller.signal);if(controller.signal.aborted)return;setDirectories(previous=>({...previous,[parent]:data.entries}));}}
    return;
   }
   if(kind==='directory')throw new Error('This directory is unavailable.');
   let item=findPath(next);
   if(!item){
    if(isRepositoryMedia(next)){item=createMediaSession(next,revision);}
    else if(local){const document=await workspace.request<WorkspaceDocument>('open',{path:next});item=trashedSessions.current.get(document.documentId)??createFileSession(document);trashedSessions.current.delete(document.documentId);}
    else{const data=metadata??await read(next,controller.signal);if(data.type!=='file'||data.content===null)throw new Error('This file cannot be displayed as text.');item=createFileSession({path:next,documentId:`${revision}:${next}`,sourceHash:null,text:data.content,readOnly:true});}
    if(controller.signal.aborted)return;sessions.current.set(item.id,item);
   }
   if(controller.signal.aborted)return;setFragment(nextFragment);activate(item,nextFragment?false:editing);setCommit(metadata?.commit??null);
   if(!metadata)void read(next,controller.signal).then(data=>{if(!controller.signal.aborted)setCommit(data.commit??null);}).catch(()=>{});
  }catch(reason){if(!controller.signal.aborted)setError((reason as Error).message);}finally{if(!controller.signal.aborted)setLoading(false);}
 };
 const navigationHandled=useRef(0);
 useEffect(()=>{const target=props.navigationRequest;if(!target||target.repo!==repository||(target.ref??'')!==revision||target.id===navigationHandled.current||!ready||busy||applyBusy||applyHeld||managementHeld||loading)return;
  navigationHandled.current=target.id;
  void(async()=>{await openPath(target.path,target.type);if(!mounted.current||request.current?.signal.aborted)return;
   if(target.entryAction){
    if(!local||directoryRef.current?.path!==target.path)throw new Error('Open the current local folder before managing this item.');
    const action=target.entryAction;
    if(action.command==='rename')setRenamingEntry(action.path);
    else await management.command(action.command,[action.path],action.type==='directory'?action.path:parentPath(action.path));
    return;
   }
   if(target.type==='directory'||!target.line){requestAnimationFrame(()=>{if(!mounted.current)return;const destination=root.current?.querySelector<HTMLElement>('.rfe-preview article, .rfe-file-name, .rfe-path>button');if(!directoryRef.current&&mount.current&&!mount.current.hidden){view.current?.focus();}else if(destination){destination.tabIndex=-1;destination.focus({preventScroll:true});}});return;}
   if(active.current.path!==target.path)return;
   if(target.line){setPreview(false);const selection=searchSelection(active.current.buffer.getText(),target);if(!selection){setNotice('This file has changed since the search. Search again to locate the text.');requestAnimationFrame(()=>view.current?.focus());return;}requestAnimationFrame(()=>{const editor=view.current;if(editor&&active.current.path===target.path){editor.dispatch({selection:{anchor:selection.from,head:selection.to},effects:EditorView.scrollIntoView(selection.from,{y:'center'})});editor.focus();}});}
  })().catch(reason=>{if(mounted.current)setError(reason.message);}).finally(()=>callbacks.current.onNavigationHandled?.(target.id));
 },[props.navigationRequest,ready,busy,applyBusy,applyHeld,managementHeld,loading,repository,revision]);
 useEffect(()=>{const find=(event:KeyboardEvent)=>{if(event.defaultPrevented||event.isComposing||!(event.ctrlKey||event.metaKey)||event.key.toLowerCase()!=='f'||event.altKey||document.querySelector('dialog[open]')||root.current?.closest('[hidden]')||directoryRef.current||readOnlyMedia(active.current))return;if(event.target instanceof Element&&event.target.closest('input,textarea,select')&&!event.target.closest('.cm-editor'))return;event.preventDefault();setPreview(false);requestAnimationFrame(()=>{if(view.current){openSearchPanel(view.current);view.current.requestMeasure();}});};window.addEventListener('keydown',find);return()=>window.removeEventListener('keydown',find);},[]);
 const openFile=(next:string)=>openPath(next,'file');
 const openDirectory=(next:string)=>openPath(next,'directory');
 const toggleDirectory=async(next:string)=>{
  const opening=!expanded.has(next);setExpanded(previous=>{const result=new Set(previous);opening?result.add(next):result.delete(next);return result;});
  treeRequests.current.get(next)?.abort();if(!opening||directories[next])return;
  const controller=new AbortController();treeRequests.current.set(next,controller);
  try{const result=await read(next,controller.signal);if(!controller.signal.aborted&&mounted.current)setDirectories(previous=>({...previous,[next]:result.entries}));}
  catch(reason){if(!controller.signal.aborted&&mounted.current)setError((reason as Error).message);}
  finally{if(treeRequests.current.get(next)===controller)treeRequests.current.delete(next);}
 };
 const returnToView=()=>{setEditing(false);setPreview(isMarkdownFile(active.current.path));};
 const keepEditing=()=>{setConfirmDiscard(null);cancelButton.current?.focus();};
 const cancelChanges=()=>{if(loading||busyRef.current||applyBusyRef.current||applyHeldRef.current||confirmDiscard!==null)return;if(view.current?.composing){setError('Finish text composition before cancelling changes.');return;}if(!hasFileChanges(active.current)){returnToView();return;}request.current?.abort();setError('');setConfirmDiscard(active.current.id);};
 const discard=()=>run(async()=>{const item=confirmedDiscardSession(sessions.current,confirmDiscard,active.current.id);request.current?.abort();await flush();if(item.isNew){await workspace.request('discardNew',{draftId:item.draftId});sessions.current.delete(item.id);states.current.delete(item.id);const next=[...sessions.current.values()].find(value=>!value.isNew);if(next){activate(next,false);returnToView();}else onClose();}else{await completeNewDraftCleanup(item,draftId=>workspace.request('discardNew',{draftId}));await workspace.request('discard',{path:item.path});const result=createFileSession(await workspace.request<WorkspaceDocument>('open',{path:item.path}));replaceFileSession(sessions.current,item,result);states.current.delete(item.id);rawHistories.current.delete(item.id);if(view.current){active.current=result;view.current.setState(makeState(result));}activate(result,false);returnToView();}setConfirmDiscard(null);refresh();});
 const leaveRepository=()=>run(async()=>{await flush();onClose();});
 const selectRevision=(ref:string)=>run(async()=>{if(ref===revision||!props.onRevisionChange||confirmDiscard!==null||commitForm!==null||folderName!==null)return;if(view.current?.composing)throw new Error('Finish text composition before switching revisions.');if(!directoryRef.current&&active.current.isNew)throw new Error('Save the new file before selecting another revision. Its draft remains local.');request.current?.abort();setLoading(false);await flush();await props.onRevisionChange(ref,directoryRef.current?.path??active.current.path);});
 const enterEdit=()=>{if(!local||!ready||active.current.readOnly||readOnlyMedia(active.current)||busyRef.current||applyBusyRef.current||applyHeldRef.current||loading)return;setEditing(true);setPreview(false);clearCopyFeedback();};
 const copyText=async(text:string,label:'Path'|'Raw file')=>{
  clearCopyFeedback();const sequence=copySequence.current;let copied=false;
  try{await navigator.clipboard.writeText(text);copied=true;}catch{}
  if(!mounted.current||sequence!==copySequence.current)return;
  setCopyStatus(copied?`${label} copied`:'Copy failed');
  copyTimer.current=setTimeout(()=>{setCopyStatus('');copyTimer.current=null;},copied?2000:4000);
 };
 const saveCurrentFile=async()=>{
  if(directoryRef.current||!local||!ready||active.current.readOnly||readOnlyMedia(active.current)||loading)return;if(view.current?.composing)throw new Error('Finish text composition before saving.');
  const item=active.current,proposed=item.proposedPath,invalid=validateFilePath(proposed);if(invalid)throw new Error(invalid);if(item.isNew&&!isMarkdownFile(proposed))throw new Error('Use .md or .markdown for a new Markdown file.');
  await flush();const wasNew=item.isNew,previousPath=item.path,paths=changedPaths.current.get(item.id)??new Set<string>();changedPaths.current.set(item.id,paths);
  if(item.isNew){const result=await workspace.request<WorkspaceDocument>('create',{path:proposed,text:item.buffer.getRawText()});const draftSessionId=item.id;sessions.current.delete(draftSessionId);item.id=result.documentId;sessions.current.set(item.id,item);if(states.current.has(draftSessionId)){states.current.set(item.id,states.current.get(draftSessionId)!);states.current.delete(draftSessionId);}if(rawHistories.current.has(draftSessionId)){rawHistories.current.set(item.id,rawHistories.current.get(draftSessionId)!);rawHistories.current.delete(draftSessionId);}changedPaths.current.delete(draftSessionId);changedPaths.current.set(item.id,paths);item.isNew=false;item.path=proposed;item.sourceHash=result.sourceHash;item.saved=result.text!;item.buffer.rebase(result.text!);paths.add(proposed);setNotice(`File saved locally at ${item.path}.`);refresh();await completeNewDraftCleanup(item,draftId=>workspace.request('discardNew',{draftId}));}
  else{await completeNewDraftCleanup(item,draftId=>workspace.request('discardNew',{draftId}));let result=await workspace.request<WorkspaceDocument>('save',{path:item.path,baseHash:item.sourceHash,text:item.buffer.getRawText()});item.sourceHash=result.sourceHash;item.saved=result.text!;item.buffer.rebase(result.text!);item.conflict=false;paths.add(item.path);setNotice(`Content saved locally at ${item.path}.`);refresh();if(proposed!==item.path){result=await workspace.request('rename',{path:item.path,newPath:proposed,baseHash:item.sourceHash});item.path=proposed;item.sourceHash=result.sourceHash;paths.add(proposed);}}
  refresh();await refreshTree();setExpanded(previous=>{const next=new Set(previous),parts=item.path.split('/');for(let i=1;i<parts.length;i++)next.add(parts.slice(0,i).join('/'));return next;});
  for(const changed of paths)operationPaths.current.add(changed);
  savedMessages.current.set(item.id,`${wasNew?'Add':previousPath!==proposed?'Rename':'Update'} ${proposed}`);
  setNotice(`Saved locally: ${item.path}.`);
  if(readOnlyMedia(item)){setEditing(false);setPreview(true);}
 };
 const saveFile=()=>run(saveCurrentFile);
 saveAction.current=()=>{void saveFile();};
 const authorFields=(preferences:CommitPreferences|null)=>{
  const author=resolveCommitAuthor(preferences);
  return {name:author.name,email:author.email,authorSource:author.source,preferencesRevision:preferences?.revision??null,authorSettingsError:''};
 };
 const currentAuthor=async()=>{
  try{return authorFields(authorPreferences?await authorPreferences.refresh():null);}
  catch{return {...authorFields(null),authorSettingsError:'Author settings could not be loaded. Enter a name and email for this commit, or open Settings to retry.'};}
 };
 const reviewFileChanges=()=>run(async()=>{
  if(directoryRef.current||!local||!ready||active.current.readOnly||loading)return;
  if(hasFileChanges(active.current))throw new Error('Save this file locally before reviewing a commit.');
  await flush();
  const item=active.current,paths=[...(changedPaths.current.get(item.id)??new Set([item.path]))];
  const [status,author]=await Promise.all([workspace.request<{initialized:boolean;recoveryRequired?:boolean;files:{path:string;status:string}[]}>('gitStatus'),currentAuthor()]);
  if(status.recoveryRequired)throw new Error('Local Git needs recovery before committing. Your saved files are retained.');
  const selected=paths.length>256?[]:paths;
  const review=status.initialized&&selected.length?await workspace.request<GitReview>('gitReview',{paths:selected}):null;
  setCommitForm({sessionId:item.id,paths:selected,available:status.files??[],review,initialized:status.initialized,message:savedMessages.current.get(item.id)??`Update ${item.path}`,description:'',...author,error:paths.length>256?'Choose up to 256 saved paths for this commit.':''});
 });
 const editAuthorSettings=()=>{
  if(!commitForm||!authorPreferences||busyRef.current)return;
  suspendedCommit.current=commitForm;setCommitForm(null);authorPreferences.openSettings();
 };
 useEffect(()=>{
  const closed=authorPreferences?.settingsClosed??0;
  if(closed===lastSettingsClosed.current)return;
  lastSettingsClosed.current=closed;
  const retained=suspendedCommit.current;if(!retained)return;
  suspendedCommit.current=null;
  const preferences=authorPreferences?.preferences??null;
  setCommitForm((preferences?.revision??null)===retained.preferencesRevision?retained:{...retained,...authorFields(preferences)});
 },[authorPreferences?.settingsClosed,authorPreferences?.preferences]);
 const loadReview=async(initialize=false)=>{if(!commitForm||busyRef.current||applyBusyRef.current||applyHeldRef.current)return;busyRef.current=true;setBusy(true);try{if(commitForm.paths.length>256)throw new Error('Select at most 256 paths for one local commit.');if(initialize)await workspace.request('gitInitialize',{branch:'main'});const status=await workspace.request<{files:{path:string;status:string}[]}>('gitStatus');const review=commitForm.paths.length?await workspace.request<GitReview>('gitReview',{paths:commitForm.paths}):null;setCommitForm(previous=>previous&&{...previous,initialized:true,available:status.files??[],review,error:review?'':'Select at least one saved file to review.'});}catch(reason){setCommitForm(previous=>previous&&{...previous,error:(reason as Error).message});}finally{busyRef.current=false;setBusy(false);}};
 const commitChanges=async(event:React.FormEvent)=>{event.preventDefault();if(!commitForm?.review||busyRef.current||applyBusyRef.current||applyHeldRef.current)return;const form=commitForm;if(!authorValid(form.name.trim(),form.email.trim())){setCommitForm({...form,error:'Enter a valid author name and email, or configure them in Settings.'});return;}busyRef.current=true;setBusy(true);try{const message=form.message.trim()+(form.description.trim()?`\n\n${form.description.trim()}`:'');const result=await workspace.request<{head:string;branch:string}>('gitCommit',{expectedHead:form.review!.expectedHead,expectedIndexHash:form.review!.expectedIndexHash,files:form.review!.files.map(({path,expectedSourceHash,expectedSourceMode})=>({path,expectedSourceHash,expectedSourceMode})),message,author:{name:form.name.trim(),email:form.email.trim()}});changedPaths.current.delete(form.sessionId);setCommitForm(null);setCommit({sha:result.head,author:form.name.trim(),message:form.message.trim(),date:new Date().toISOString()});setNotice(`Committed locally on ${result.branch}: ${result.head.slice(0,7)}. Nothing was pushed.`);returnToView();await refreshTree();try{const metadata=await read(active.current.path);setCommit(metadata.commit??null);}catch{setNotice(`Committed locally: ${result.head.slice(0,7)}. Commit metadata could not be refreshed.`);}}catch(reason){setCommitForm(previous=>previous&&{...previous,error:(reason as Error).message});}finally{busyRef.current=false;setBusy(false);}};
 const media=!directoryView&&readOnlyMedia(active.current);
 const newDrafts=[...sessions.current.values()].filter(item=>item.isNew),canEdit=!managementHeld&&!applyHeld&&!applyBusy&&!directoryView&&!media&&local&&ready&&!active.current.readOnly&&!busy&&!loading,modes: ('source'|'preview')[]=media?['preview']:fileModes(active.current.proposedPath,editing),actualPreview=!directoryView&&(media||preview)&&modes.includes('preview');
 const rendered=useMemo(()=>actualPreview&&!media?renderSourcePreview(source,active.current.proposedPath,{externalLinks:true}):null,[actualPreview,media,source,active.current.proposedPath]);
 const shownPath=directoryView?.path??path,shownCommit=directoryView?directoryView.snapshot?.commit??null:commit,directoryReadmePath=directoryView?.snapshot?.readmePath,directoryReadme=directoryView?.snapshot?.readme;
 const renderedDirectoryReadme=useMemo(()=>typeof directoryReadme==='string'&&directoryReadmePath?renderSourcePreview(directoryReadme,directoryReadmePath,{externalLinks:true}):null,[directoryReadme,directoryReadmePath]);
 const outlineSource=directoryView?directoryReadme??'':source,outlinePath=directoryView?directoryReadmePath??'':active.current.proposedPath;
 const outlineEntries=useMemo(()=>isMarkdownFile(outlinePath)&&(Boolean(directoryView)||!media)?buildDocumentOutline(outlineSource):[],[outlineSource,outlinePath,media,Boolean(directoryView)]);
 const selectOutline=useRef<(entry:DocumentOutlineEntry)=>void>(()=>{});
 selectOutline.current=entry=>{
  cancelOutlineSelection();
  if(isNativeClosing()||document.querySelector('dialog[open]'))return;
  if(directoryRef.current||actualPreview&&!rendered?.limited){const target=root.current?.querySelector<HTMLElement>(`[id="${entry.id}"]`);if(target){target.tabIndex=-1;target.focus({preventScroll:true});target.scrollIntoView({block:'start'});return;}}
  if(directoryRef.current&&directoryReadmePath){void openPath(directoryReadmePath,'file',entry.id);return;}
  const editor=view.current;if(!editor)return;
  const session=active.current,documentPath=session.proposedPath,sourceDocument=editor.state.doc;
  setPreview(false);outlineSelectionFrame.current=requestAnimationFrame(()=>{
   outlineSelectionFrame.current=null;
   // CM6 is reused across files. A queued jump belongs only to this exact
   // session/document and must not take focus after a modal or close begins.
   if(!mounted.current||!root.current?.isConnected||view.current!==editor||active.current!==session||session.proposedPath!==documentPath||editor.state.doc!==sourceDocument||directoryRef.current||isNativeClosing()||root.current.closest('[hidden], [inert]')||editor.dom.closest('[hidden]')||document.querySelector('dialog[open]'))return;
   const from=Math.min(entry.from,editor.state.doc.length);editor.dispatch({selection:{anchor:from},effects:EditorView.scrollIntoView(from,{y:'center'})});editor.focus();
  });
 };
 const limitedFragment=useRef('');
 useEffect(()=>{if(!ready||!fragment||!rendered?.limited)return;const key=`${path}:${fragment}`;if(limitedFragment.current===key)return;const heading=outlineEntries.find(entry=>entry.id===fragment);if(heading){limitedFragment.current=key;selectOutline.current(heading);}},[ready,path,fragment,rendered?.limited,outlineEntries]);
 useEffect(()=>{props.onOutlineChange?.({documentName:outlinePath,entries:loading?[]:outlineEntries,onSelect:entry=>selectOutline.current(entry)});props.onDocumentContextChange?.({repo:repository,path:shownPath,ref:revision});},[outlineEntries,outlinePath,shownPath,loading,repository,revision,props.onOutlineChange,props.onDocumentContextChange]);

 const directoryEntries=useMemo(()=>[...(directoryView?.snapshot?.entries??[])].sort((a,b)=>(a.type===b.type?0:a.type==='directory'?-1:1)||a.name.localeCompare(b.name)),[directoryView?.snapshot]);
 const lines=source.split('\n'),lineCount=source.endsWith('\n')?lines.length-1:lines.length,byteSize=new TextEncoder().encode(active.current.buffer.getRawText()).length,fileMetadata=`${lineCount} lines (${lines.filter(line=>line.trim()).length} loc) · ${byteSize<1024?`${byteSize} Bytes`:`${(byteSize/1024).toFixed(2)} KB`}`;
 const explorerEntries=useMemo(()=>[...new Map(Object.values(directories).flat().map(entry=>[entry.path,entry])).values()],[directories]);
 const afterManagement=async(result:ManagementResult)=>{
  request.current?.abort();setLoading(false);
  for(const changed of result.changedPaths??[])operationPaths.current.add(changed);
  if(result.operation==='move')remapSessions(sessions.current.values(),result.pathMoves);
  if(result.operation==='restore')restoreRetainedSessions(sessions.current,trashedSessions.current,result.items.map(item=>item.path));
  const removed=result.operation==='trash'?result.items.map(item=>item.path):[];
  for(const [key,item] of sessions.current){if(!item.isNew&&removed.some(path=>insidePath(item.path,path))){trashedSessions.current.set(key,item);sessions.current.delete(key);}}
  const directory=directoryRef.current;
  if(directory){let next=remapPath(directory.path,result.pathMoves);if(removed.some(path=>insidePath(next,path)))next=parentPath(removed.find(path=>insidePath(next,path))!);showDirectory(next,await read(next));}
  else if(removed.some(path=>insidePath(active.current.path,path))){const next=parentPath(removed.find(path=>insidePath(active.current.path,path))!);showDirectory(next,await read(next));}
  if(readOnlyMedia(active.current)){setEditing(false);setPreview(true);}
  await refreshTree();refresh();
 };
 const management=useRepositoryManagement({repository,workspace,local,entries:explorerEntries,enabled:local&&!repositoryReadOnly&&ready&&!loading&&!managementHeld&&!applyHeld&&!applyBusy,busy:busy||applyBusy,
  execute:async (action,recovering)=>{if(applyHeldRef.current)throw new Error('Close and reopen asMagicBrain to recover the interrupted update.');if(busyRef.current||applyBusyRef.current)throw new Error('Wait for the current local operation.');if(view.current?.composing||view.current?.compositionStarted)throw new Error('Finish text composition before managing files.');for(const item of sessions.current.values())if(!item.isNew&&item.proposedPath!==item.path)throw new Error('Save or revert filename changes before managing files.');busyRef.current=true;setBusy(true);setError('');setNotice('');try{request.current?.abort();if(!recovering)await flush();await action();}finally{busyRef.current=false;if(mounted.current)setBusy(false);}},
  onChanged:afterManagement,onNewFile:parent=>{void newDraft(false,parent).catch(reason=>setError(reason.message));},onNewFolder:parent=>setFolderName(parent?`${parent}/`:''),onHeldChange:value=>{managementHeldRef.current=value;setManagementHeld(value);},onError:setError,onNotice:setNotice});
 const closeRepositoryRename=()=>{setRenamingRepository(false);renameButton.current?.focus();};
 const renameRepository=async(name:string)=>{
  const rename=callbacks.current.onRenameRepository;
  if(!rename||!local)throw new Error('Select the current local branch to rename this repository.');
  if(!ready||loading)throw new Error('Wait for the repository to finish loading before renaming it.');
  if(busyRef.current||applyBusyRef.current||applyHeldRef.current||confirmDiscard!==null||commitForm!==null||folderName!==null||management.dialog)throw new Error('Finish the current local operation before renaming this repository.');
  if(managementHeldRef.current)throw new Error('Recover the local file operation before renaming this repository.');
  if(view.current?.compositionStarted)throw new Error('Finish text composition before renaming this repository.');
  for(const item of sessions.current.values())if(!item.isNew&&item.proposedPath!==item.path)throw new Error('Save or revert filename changes before renaming this repository.');
  busyRef.current=true;setBusy(true);setError('');
  try{
   await flushAction.current();
   // New-file names may describe folders that do not exist yet. Reopen their
   // retained drafts from the root, never by reading the proposed path on disk.
   const directory=directoryRef.current,location=directory?{path:directory.path,directory:true}:active.current.isNew?{path:'',directory:true}:{path:active.current.path,directory:false};
   await rename(name,location);
  }finally{busyRef.current=false;if(mounted.current)setBusy(false);}
 };
 const reviewManagedChanges=()=>run(async()=>{await flush();const [status,author]=await Promise.all([workspace.request<{initialized:boolean;files:{path:string;status:string}[]}>('gitStatus'),currentAuthor()]);const affected=status.files.filter(file=>operationPaths.current.has(file.path)).map(file=>file.path);const paths=affected.length>256?[]:affected;const review=status.initialized&&paths.length?await workspace.request<GitReview>('gitReview',{paths}):null;setCommitForm({sessionId:'file-management',paths,available:status.files??[],review,initialized:status.initialized,message:'Manage local files',description:'',...author,error:affected.length>256?'Choose up to 256 saved paths for this commit. The folder operation is complete; remaining paths can be committed in another batch.':paths.length?'':'Select saved files to review.'});});
 const setApplyingUpdate=(value:boolean)=>{
  applyBusyRef.current=value;setApplyBusy(value);
  editorOptions.current.busy=busyRef.current||managementHeldRef.current||value||applyHeldRef.current;
  view.current?.dispatch({effects:settings.current.reconfigure(configuration())});
 };
 const holdAppliedRepository=()=>{
  applyHeldRef.current=true;setApplyHeld(true);editorOptions.current.busy=true;
  view.current?.dispatch({effects:settings.current.reconfigure(configuration())});
  setError('Close and reopen asMagicBrain to recover this interrupted update. Unrecognized file changes remain preserved.');
 };
 const prepareRepositoryUpdate=async(applying=false)=>{
  if(!local||!ready||loading)throw new Error('Wait for the local repository to finish loading.');
  if(applyHeldRef.current)throw Object.assign(new Error('Close and reopen asMagicBrain to recover this interrupted update.'),{code:'APPLY_RECOVERY_REQUIRED'});
  if(busyRef.current||managementHeldRef.current||!applying&&applyBusyRef.current||confirmDiscard!==null||commitForm!==null||folderName!==null||management.dialog)throw new Error('Finish the current local operation before reviewing updates.');
  if(view.current?.composing||view.current?.compositionStarted)throw new Error('Finish text composition before reviewing updates.');
  for(const item of sessions.current.values())if(!item.isNew&&item.proposedPath!==item.path)throw new Error('Save or revert filename changes before reviewing updates.');
  await flushAction.current();
  if(applying&&[...sessions.current.values()].some(hasFileChanges))throw Object.assign(new Error('Retained drafts prevent this update. Resolve them before reviewing again.'),{code:'APPLY_DRAFTS'});
 };
 const appliedRepositoryUpdate=async(result:RepositoryUpdateApplied)=>{
  try{
   // Admission required clean sessions. Never replace a buffer which became
   // dirty while an update was settling, even if the host already completed it.
   if(pending.current.size||[...sessions.current.values()].some(hasFileChanges))throw new Error('The editor changed while the update was applied. Reopen this repository before continuing.');
   request.current?.abort();for(const item of treeRequests.current.values())item.abort();treeRequests.current.clear();setLoading(true);
   const selected=directoryRef.current?.path??active.current.path,wasDirectory=Boolean(directoryRef.current),wasEditing=editing,wasPreview=preview;
   const listing=await workspace.request<{entries:WorkspaceEntry[]}>('discover');
   const entries=new Map(listing.entries.map(entry=>[entry.path,entry]));
   let target=selected,nextFile:FileSession|null=null,nextDirectory:DirectoryView|null=null,metadata:Snapshot|null=null;
   if(!wasDirectory&&entries.get(selected)?.type==='file'){
    if(isRepositoryMedia(selected))nextFile=createMediaSession(selected);
    else{const document=await workspace.request<WorkspaceDocument>('open',{path:selected});if(typeof document.text==='string')nextFile=createFileSession(document);}
    if(nextFile)metadata=await read(selected);
   }
   if(!nextFile){
    if(!wasDirectory||entries.get(target)?.type!=='directory')target=parentPath(target);
    while(target&&entries.get(target)?.type!=='directory')target=parentPath(target);
    const snapshot=await read(target);if(snapshot.type!=='directory')throw new Error('The updated repository could not be reopened.');
    nextDirectory={path:target,snapshot};
   }
   // Clear only clean, replaceable caches. Persistent drafts/Trash are never
   // deleted here; the host refuses admission when retained drafts exist.
   states.current.clear();rawHistories.current.clear();sessions.current.clear();trashedSessions.current.clear();changedPaths.current.clear();operationPaths.current.clear();savedMessages.current.clear();suspendedCommit.current=null;
   const next=nextFile??createFileSession({path:'',documentId:`directory:${result.head}`,sourceHash:null,text:'',readOnly:true});
   active.current=next;if(nextFile)sessions.current.set(next.id,next);
   view.current?.setState(makeState(next));
   setFragment('');setNotice('');setError('');clearCopyFeedback();setCommit(metadata?.commit??null);
   directoryRef.current=nextDirectory;setDirectoryView(nextDirectory);
   setEditing(Boolean(nextFile&&wasEditing&&!nextFile.readOnly&&!readOnlyMedia(nextFile)));
   setPreview(Boolean(nextFile&&(readOnlyMedia(nextFile)||wasPreview&&isMarkdownFile(nextFile.path))));
   setDirectories({});setExpanded(previous=>new Set([...previous].filter(path=>!path||entries.get(path)?.type==='directory')));
   await refreshTree();refresh();
   await callbacks.current.onRepositoryUpdated?.(result);
  }catch(reason){holdAppliedRepository();throw reason;}
  finally{if(mounted.current)setLoading(false);}
 };
 const failedRepositoryUpdate=(reason:unknown)=>{
  const code=reason&&typeof reason==='object'&&'code'in reason?String(reason.code):'';
  // Only an explicit pre-admission refusal proves that saved files did not
  // change. A lost/unknown reply must not unlock an old editable buffer.
  const refused=['APPLY_BUSY','APPLY_NOT_FOUND','APPLY_UNAVAILABLE','APPLY_SAVED_CHANGES','APPLY_DRAFTS','APPLY_NOT_FAST_FORWARD','APPLY_PARTIAL','APPLY_UNSUPPORTED','APPLY_LIMIT_EXCEEDED','APPLY_REQUEST_REUSED','APPLY_REVIEW_EXPIRED','APPLY_STALE','APPLY_TIMEOUT','APPLY_GIT_FAILED','COMPARISON_EXPIRED','UPDATES_STALE','INVALID_REQUEST'];
  if(!refused.includes(code))holdAppliedRepository();
 };
 return <section ref={root} className={`rfe rfe-resizable ${narrow?'rfe-narrow':''} ${editing?'rfe-edit-mode':'rfe-file-mode'} ${directoryView?'rfe-directory-mode':''} ${center?'rfe-centered-source':''}`} aria-label="Repository file editor" style={{'--rfe-sidebar-width':`${width}px`} as React.CSSProperties}>
 {narrow&&!collapsed&&<button className="rfe-drawer-backdrop" aria-label="Close file sidebar" onClick={()=>setCollapsed(true)}/>}
 {!collapsed&&<aside inert={busy||applyBusy} className="rfe-sidebar" aria-label="Repository files" style={{'--panel-resize-width':`${width}px`} as React.CSSProperties}><header className="rfe-sidebar-header"><button ref={renameButton} className="rfe-icon rfe-repository-rename" aria-label="Rename repository" title={repositoryReadOnly?'Bundled documentation is read only':props.onRenameRepository?"Rename repository":"Repository rename — unavailable in this preview"} disabled={repositoryReadOnly||!props.onRenameRepository||!local||!ready||busy||loading||managementHeld||applyBusy||applyHeld} onClick={()=>{if(view.current?.compositionStarted){setError('Finish text composition before renaming this repository.');return;}setRenamingRepository(true);}}><Icon name="pencil"/></button><strong title={repository}>{repository}</strong><button disabled={!props.onSearch} className="rfe-icon rfe-sidebar-search" aria-label="Search files" title="Search repository contents" onClick={()=>props.onSearch?.({mode:'content',repo:repository})}><Icon name="search"/></button></header><FileNavigationControls onGoToFile={props.onSearch?()=>props.onSearch?.({mode:'files',repo:repository,ref:revision,finder:true}):undefined} repository={repository} branch={branch} branches={props.branches} tags={props.tags} revision={revision} onRevisionChange={ref=>void selectRevision(ref)} disabled={busy||applyBusy||applyHeld||!props.onRevisionChange} onNewFile={local&&!repositoryReadOnly&&ready&&!managementHeld&&!applyBusy&&!applyHeld?()=>{void newDraft().catch(reason=>setError(reason.message));}:undefined} rootActionsRef={setRootActionsContainer}/><nav className="rfe-tree rfe-managed-tree" aria-label="File tree">{newDrafts.length>0&&<div className="rfe-new-drafts"><h3>Unsaved files</h3>{newDrafts.map(item=><button key={item.id} className="rfe-tree-row" onClick={()=>void run(async()=>{if(view.current?.composing)throw new Error('Finish text composition before switching files.');request.current?.abort();setLoading(false);await flush();activate(item,true);})} aria-current={active.current.id===item.id?'page':undefined}><Icon name="file"/><span className="rfe-tree-name">{item.proposedPath||'Untitled file'}</span><span>●</span></button>)}</div>}<RepositoryExplorer rootActionsContainer={rootActionsContainer} entries={explorerEntries} activePath={shownPath} readOnly={repositoryReadOnly||!local||!ready||managementHeld||applyHeld} busy={busy||loading||applyBusy} dirtyPaths={[...sessions.current.values()].filter(hasFileChanges).map(item=>item.path)} clipboard={management.clipboard} onOpen={openPath} onToggle={(path,open)=>{if(open&&!directories[path])void toggleDirectory(path);}} onCommand={management.command} onRename={management.rename} onMove={management.move} onImportFiles={getNativeBridge()?.importExternalFiles?management.importFiles:undefined} onPickFiles={getNativeBridge()?.pickExternalFiles?destination=>management.importFiles(null,destination):undefined} onReveal={local&&ready&&getNativeBridge()?.revealItem?path=>revealRepositoryItem({repo:repository,path}):undefined} onCheckGitHubUpdates={local&&ready&&!applyBusy&&!applyHeld&&updateAvailability?.eligible?()=>setCheckingGitHub(true):undefined} githubUpdatesUnavailableReason={repositoryUpdatesUnavailable(updateAvailability?.reason)}/></nav><PanelResizeHandle width={width} defaultWidth={280} minWidth={180} maxWidth={480} collapseWidth={140} onResize={setWidth} onCollapse={collapseSidebar} label="File sidebar width"/></aside>}
 <div className="rfe-document-pane"><div inert={busy} className="rfe-main"><div className="rfe-main-scroll"><header className="rfe-context"><div className="rfe-path">
  {collapsed&&props.fileSidebarOpen===undefined&&<button className="rfe-icon" aria-label="Show file sidebar" onClick={()=>setCollapsed(false)}><Icon name="panel"/></button>}
  <button className="rfe-repository" onClick={()=>void leaveRepository()}>{repository}</button>
  {editing?<><span>/</span><input aria-label="File path" disabled={busy||applyBusy||applyHeld} value={active.current.proposedPath} onChange={event=>{active.current.proposedPath=event.target.value;if(active.current.isNew)checkpoint(active.current);refresh();}} placeholder="folder/new-file.md"/><span>in</span><strong>{branch||'main'}</strong></>:<>
   <nav className="rfe-breadcrumbs" aria-label="Repository path">{shownPath.split('/').filter(Boolean).map((part,index,parts)=><React.Fragment key={index}><span aria-hidden="true">/</span>{index===parts.length-1?<strong className="rfe-file-name" aria-current="page">{part}</strong>:<button onClick={()=>void openDirectory(parts.slice(0,index+1).join('/'))}>{part}</button>}</React.Fragment>)}</nav>
   <span className="rfe-path-copy"><button className="rfe-icon" aria-label={directoryView?'Copy directory path':'Copy file path'} title="Copy path" onClick={()=>void copyText(shownPath||'.','Path')}><Icon name="copy"/></button><span className="rfe-path-copy-status" role="status" aria-atomic="true">{copyStatus}</span></span>
  </>}
 </div>{editing?<div className="rfe-actions"><button ref={cancelButton} disabled={busy||applyBusy||applyHeld||loading} onClick={cancelChanges}>Cancel changes</button><button ref={saveButton} className="rfe-local-commit" disabled={!canEdit} onClick={()=>void saveFile()}>Save</button><button ref={reviewButton} disabled={!canEdit||hasFileChanges(active.current)} title={hasFileChanges(active.current)?'Save this file locally before committing':'Review saved files and create a local Git commit'} onClick={()=>void reviewFileChanges()}>Commit changes…</button></div>:directoryView?<div className="rfe-directory-actions"><DirectoryAddActions onNewFile={local&&!repositoryReadOnly&&ready&&!managementHeld&&!applyBusy&&!applyHeld&&!loading?()=>{void newDraft().catch(reason=>setError(reason.message));}:undefined}/><DirectoryMoreActions onCopyPath={()=>void copyText(shownPath||'.','Path')}/></div>:<FileMoreActions onCopyPath={()=>void copyText(path,'Path')} sourceOptions={!media} wrap={viewWrap} onWrapChange={setViewWrap} folding={folding} onFoldingChange={setFolding} center={center} onCenterChange={setCenter}/>}</header>
 {!editing&&<div className="rfe-file-commit" aria-label="Local revision commit"><span className="rfe-author-avatar">{shownCommit?.author.slice(0,1)||'as'}</span><strong>{shownCommit?.author||repository}</strong><span className="rfe-commit-message">{shownCommit?.message||(loading?'Loading commit…':'No commits yet')}</span><span className="rfe-commit-sha">{shownCommit?.sha.slice(0,7)}</span><time>{shownCommit?.date.slice(0,10)}</time></div>}
 {!local&&<p className="rfe-notice">Historical revision · read only. Select the current branch to edit local files.</p>}{!directoryView&&active.current.conflict&&<p className="rfe-error">This file changed outside the app. Your retained draft is available; saving requires resolving the source conflict.</p>}{error&&<div role="alert" className="rfe-error">{error}</div>}{loading&&<div role="status" className="rfe-loading">{directoryView?'Loading directory…':'Loading repository path…'}</div>}{busy&&<div role="status" className="rfe-loading">Working locally…</div>}
 {directoryView&&directoryView.snapshot&&<section className="rfe-directory-content" aria-label="Directory view">
  <div className="rfe-directory-table-frame"><table className="rfe-directory-table" aria-label={`Files in ${directoryView.path||repository}`}><colgroup><col className="rfe-directory-name-column"/><col className="rfe-directory-message-column"/><col className="rfe-directory-date-column"/></colgroup><thead><tr><th scope="col">Name</th><th scope="col" className="rfe-directory-message">Last commit message</th><th scope="col" className="rfe-directory-date">Last commit date</th></tr></thead><tbody>
   {directoryView.path&&<tr><td colSpan={narrow?2:3}><button className="rfe-parent-directory" aria-label="Go to parent directory" onClick={()=>void openDirectory(directoryView.path.split('/').slice(0,-1).join('/'))}><Icon name="folder"/><span>..</span></button></td></tr>}
   {directoryEntries.map(entry=><tr key={entry.path}><td><button className="rfe-directory-entry" data-directory={entry.type==='directory'||undefined} onClick={()=>void openPath(entry.path,entry.type)}><Icon name={entry.type==='directory'?'folder':'file'}/><span>{entry.name}</span></button></td><td className="rfe-directory-message" title={entry.message}>{entry.message||'—'}</td><td className="rfe-directory-date"><time dateTime={entry.date}>{entry.date?.slice(0,10)||'—'}</time></td></tr>)}
  </tbody></table>{!directoryEntries.length&&<p className="rfe-directory-empty">This directory is empty.</p>}</div>
  {directoryReadmePath&&<section className="rfe-directory-readme rc-document" aria-label="Directory README"><header><strong>{directoryReadmePath.split('/').at(-1)}</strong><button className="rfe-icon" aria-label="Open directory README" title="Open README" onClick={()=>void openFile(directoryReadmePath)}><Icon name="file"/></button></header>
   {typeof directoryReadme!=='string'?<p className="rfe-directory-empty">Preview is unavailable for this README.</p>:renderedDirectoryReadme?.limited?<p className="rfe-directory-empty">This README is too large for the rendered preview.</p>:!directoryReadme?<p className="rfe-directory-empty">This README is empty.</p>:isMarkdownFile(directoryReadmePath)?<RepositoryDocument repository={repository} revision={revision} sourcePath={directoryReadmePath} fragment={fragment} rendered={renderedDirectoryReadme!} onNavigate={(next,hash)=>void openPath(next,undefined,hash)}/>:<pre className="rc-plain-document">{directoryReadme}</pre>}
  </section>}
 </section>}
 <section className="rfe-editor-frame" hidden={Boolean(directoryView)}><div className="rfe-toolbar"><div className="rfe-file-toolbar-left"><div className="rfe-modes" role="tablist" aria-label={editing?'Editor mode':'File view'} onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const index=modes.indexOf(actualPreview?'preview':'source'),next=event.key==='Home'?modes[0]:event.key==='End'?modes.at(-1)!:modes[(index+(event.key==='ArrowRight'?1:-1)+modes.length)%modes.length];setPreview(next==='preview');event.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus();}}>{modes.map(mode=><button key={mode} id={`${id}-${mode}-tab`} data-mode={mode} role="tab" aria-controls={`${id}-${mode}-panel`} tabIndex={actualPreview===(mode==='preview')?0:-1} aria-selected={actualPreview===(mode==='preview')} onClick={()=>setPreview(mode==='preview')}>{mode==='preview'?'Preview':editing?'Edit':'Code'}</button>)}</div>{!editing&&<span className="rfe-file-metadata">{media?'Local media · read only':fileMetadata}</span>}</div>{editing?(actualPreview?<button disabled data-unavailable className="rfe-show-diff">Show diff</button>:<div className="rfe-settings"><select aria-label="Indentation mode" value={space} onChange={event=>setSpace(event.target.value)}><option value="spaces">Spaces</option><option value="tabs">Tabs</option></select><select aria-label="Indentation size" value={size} onChange={event=>setSize(Number(event.target.value))}>{[2,4,8].map(value=><option key={value}>{value}</option>)}</select><select aria-label="Line wrapping" value={wrap?'soft':'off'} onChange={event=>setWrap(event.target.value==='soft')}><option value="soft">Soft wrap</option><option value="off">No wrap</option></select></div>):<div className="rfe-file-actions"><FileSpaceActions/><button className="rfe-icon" aria-label="Copy raw file" title="Copy raw file" disabled={media} onClick={()=>void copyText(active.current.buffer.getRawText(),'Raw file')}><Icon name="copy"/></button><span className="rfe-action-group"><button className="rfe-icon" aria-label="Edit this file" title="Edit this file" disabled={!canEdit} onClick={enterEdit}><Icon name="pencil"/></button>{canEdit?<FileEditOptions onEdit={enterEdit}/>:<button disabled className="rfe-icon" aria-label="More editing options"><span className="rfe-triangle"/></button>}</span></div>}</div>
 <div id={`${id}-source-panel`} role="tabpanel" aria-labelledby={`${id}-source-tab`} ref={mount} className="rfe-source" hidden={actualPreview||Boolean(directoryView)}/>{actualPreview&&<div id={`${id}-preview-panel`} className="rfe-preview rc-document" role="tabpanel" aria-labelledby={`${id}-preview-tab`}>{media?<RepositoryMedia key={JSON.stringify([repository,revision,path])} repository={repository} revision={revision} path={path}/>:rendered?.limited?<p className="rfe-error">This file is too large for the rendered preview. Its source remains available in Edit.</p>:<RepositoryDocument repository={repository} revision={revision} sourcePath={path} fragment={fragment} rendered={rendered??{html:'',images:[]}} onNavigate={(next,hash)=>void openPath(next,undefined,hash)}/>}</div>}
 {editing&&<footer className="rfe-footer">{notice&&<p role="status" className="rfe-notice">{notice}</p>}<div>Use <kbd>Esc</kbd> then <kbd>Tab</kbd> to move focus out of the editor.{hasFileChanges(active.current)&&<span>Unsaved changes</span>}</div><p className="rfe-path-help">Use folder/notes.md to create folders or move this file. Existing filename changes are retained for this session.</p><button disabled data-unavailable>Attach files by dragging &amp; dropping, selecting or pasting them.</button></footer>}</section></div>{((!editing&&notice)||(local&&operationPaths.current.size>0)||management.recovery)&&<footer className="rfe-view-footer">{!editing&&notice&&<p role="status" className="rfe-notice">{notice}</p>}{local&&operationPaths.current.size>0&&<div className="rfe-management-review"><button disabled={busy||applyBusy||applyHeld||loading} onClick={()=>void reviewManagedChanges()}>Review saved changes…</button></div>}{management.recovery&&<div className="rfe-management-review"><button disabled={busy||applyBusy||applyHeld} onClick={()=>void management.reconcile()}>Recover local file operation</button></div>}</footer>}
 </div></div>
 {renamingRepository&&<RepositoryRenameDialog repository={repository} onRename={renameRepository} onClose={closeRepositoryRename}/>}
 {renamingEntry&&<FileEntryRenameDialog path={renamingEntry} onRename={name=>management.rename(renamingEntry,name)} onClose={()=>{setRenamingEntry(null);requestAnimationFrame(()=>root.current?.querySelector<HTMLElement>('[role="tree"]')?.focus());}}/>}
 {checkingGitHub&&<RepositoryUpdatesDialog repository={repository} returnFocus={rootActionsContainer?.querySelector('button')} onClose={()=>setCheckingGitHub(false)} beforeReview={()=>prepareRepositoryUpdate()} beforeApply={()=>prepareRepositoryUpdate(true)} onApplyingChange={setApplyingUpdate} onApplied={appliedRepositoryUpdate} onApplyError={failedRepositoryUpdate}/>}
 <RepositoryManagementDialog manager={management} busy={busy}/>
 <dialog ref={discardDialog} className="rfe-discard-dialog" aria-labelledby={`${id}-discard-title`} onCancel={event=>{event.preventDefault();if(!busy)keepEditing();}} onKeyDown={event=>event.stopPropagation()}><h2 id={`${id}-discard-title`}>Discard changes?</h2><p>This removes this file’s retained draft and filename changes. Saved files and commits remain unchanged.</p>{error&&<p role="alert" className="rfe-error">{error}</p>}<div><button disabled={busy} autoFocus onClick={keepEditing}>Keep editing</button><button disabled={busy} className="rfe-discard-action" onClick={()=>void discard()}>Discard changes</button></div></dialog>
 <dialog ref={folderDialog} className="rfe-commit-dialog rfe-folder-dialog" aria-labelledby={`${id}-folder-title`} onCancel={event=>{event.preventDefault();if(!busy)setFolderName(null);}}>{folderName!==null&&<form onSubmit={event=>{event.preventDefault();void run(async()=>{const invalid=validateFilePath(folderName);if(invalid)throw new Error(invalid);await flush();await workspace.request('createFolder',{path:folderName});setFolderName(null);setNotice('Folder created locally. Git tracks files inside folders.');await refreshTree();const directory=directoryRef.current;if(directory){const snapshot=await read(directory.path);if(directoryRef.current===directory)showDirectory(directory.path,snapshot);}});}}><h2 id={`${id}-folder-title`}>New folder</h2><label>Folder path<input autoFocus required value={folderName} disabled={busy} placeholder="notes/research" onChange={event=>setFolderName(event.target.value)}/></label>{error&&<p role="alert" className="rfe-error">{error}</p>}<footer><button type="button" disabled={busy} onClick={()=>setFolderName(null)}>Cancel</button><button type="submit" disabled={busy}>Create folder</button></footer></form>}</dialog>
 <dialog ref={commitDialog} className="rfe-commit-dialog" aria-labelledby={`${id}-commit-title`} onCancel={event=>{event.preventDefault();if(!busy){setCommitForm(null);reviewButton.current?.focus();}}} onKeyDown={event=>event.stopPropagation()}>{commitForm&&<form onSubmit={event=>void commitChanges(event)}><header><h2 id={`${id}-commit-title`}>Commit changes</h2><p>Saved files in {repository}. This creates a local Git commit.</p></header>{commitForm.error&&<p role="alert" className="rfe-error">{commitForm.error}</p>}{!commitForm.initialized?<section><p>This folder has no local Git repository yet.</p><button type="button" disabled={busy} onClick={()=>void loadReview(true)}>Initialize local Git and review</button></section>:<><label>Commit message<input required maxLength={500} disabled={busy} value={commitForm.message} onChange={event=>setCommitForm({...commitForm,message:event.target.value})}/></label><label>Extended description<textarea disabled={busy} value={commitForm.description} onChange={event=>setCommitForm({...commitForm,description:event.target.value})}/></label><div className="rfe-author-preference"><span>{commitForm.authorSource==='manual'?'Enter the author for this commit.':`Filled from ${commitForm.authorSource==='github'?'GitHub identity':'asMagicBrain profile'}. Changes here apply to this commit only.`}</span>{authorPreferences&&<button type="button" disabled={busy} onClick={editAuthorSettings}>Author settings…</button>}</div>{commitForm.authorSettingsError&&<p role="status">{commitForm.authorSettingsError}</p>}<div className="rfe-author-fields"><label>Local author name<input required maxLength={256} autoComplete="off" disabled={busy} value={commitForm.name} onChange={event=>setCommitForm({...commitForm,name:event.target.value})}/></label><label>Local author email<input required type="email" maxLength={256} autoComplete="off" disabled={busy} value={commitForm.email} onChange={event=>setCommitForm({...commitForm,email:event.target.value})}/></label></div><label className="rfe-radio"><input type="radio" checked readOnly/>Commit directly to the local {commitForm.review?.branch||branch||'main'} branch</label><label className="rfe-radio rfe-unavailable" data-unavailable><input type="radio" disabled/>Create a new branch and open a pull request</label><fieldset className="rfe-change-selection"><legend>Saved files to include</legend><p>Only selected, reviewed files enter this commit. Retained drafts remain separate.</p>{[...new Map([...commitForm.available,...commitForm.paths.filter(path=>!commitForm.available.some(file=>file.path===path)).map(path=>({path,status:'selected'}))].map(file=>[file.path,file])).values()].map(file=><label key={file.path}><input type="checkbox" disabled={busy} checked={commitForm.paths.includes(file.path)} onChange={event=>setCommitForm({...commitForm,paths:event.target.checked?[...commitForm.paths,file.path]:commitForm.paths.filter(path=>path!==file.path),review:null,error:'Selection changed. Refresh the review before committing.'})}/><span>{file.path} <small>{file.status}</small></span></label>)}</fieldset><section className="rfe-review" aria-label="Saved changes to commit"><h3>Review saved changes</h3>{commitForm.review?.files.map(file=><details key={file.path} open><summary>{file.path} · {file.status}</summary>{file.beforeMode!==file.afterMode&&(file.beforeMode==='100755'||file.afterMode==='100755')&&<p className="rfe-file-mode-change">Executable permission: {file.afterMode==='100755'?'enabled':'removed'}</p>}{file.previewOmitted?<p>Diff preview omitted for this large file. Saved bytes are verified by hash ({file.beforeSize??0} → {file.afterSize??0} bytes).</p>:file.binary?<p>Binary changes cannot be displayed here.</p>:<div className="rfe-diff"><div><h4>Before</h4><pre>{file.before??'File does not exist'}</pre></div><div><h4>After</h4><pre>{file.after??'File does not exist'}</pre></div></div>}</details>)}</section><button type="button" disabled={busy} onClick={()=>void loadReview()}>Refresh review</button></>}<footer><button type="button" disabled={busy} onClick={()=>{setCommitForm(null);reviewButton.current?.focus();}}>Cancel</button><button className="rfe-local-commit" disabled={busy||!commitForm.review||!commitForm.review.files.some(file=>file.status!=='unchanged')} type="submit">{busy?'Working…':'Commit changes'}</button></footer></form>}</dialog>
 </section>;
}
