import React, {createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {Tree, type CursorProps, type DragPreviewProps, type NodeApi, type NodeRendererProps, type RowRendererProps, type TreeApi} from 'react-arborist';
import {useDrop} from 'react-dnd';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {activeDirectDropDestination, buildExplorerTree, directFolderDropDestination, externalDropDestination, moveSelectionProblem, parentPath, renameProblem, selectedRoots, type DirectDropHover, type ExplorerClipboard, type ExplorerCommand, type ExplorerEntry, type ExplorerNode} from './repository-explorer-model';
import './repository-explorer.css';

export type {ExplorerClipboard, ExplorerCommand, ExplorerEntry} from './repository-explorer-model';
export type RepositoryExplorerProps = {
  entries: readonly ExplorerEntry[];
  activePath: string | null;
  readOnly?: boolean;
  busy?: boolean;
  dirtyPaths?: readonly string[];
  clipboard?: ExplorerClipboard | null;
  rootActionsContainer?: HTMLElement | null;
  onOpen(path: string, type: ExplorerEntry['type']): void | Promise<void>;
  onToggle?(path: string, open: boolean): void;
  onCommand(command: ExplorerCommand, paths: string[], destination?: string): void | Promise<void>;
  onRename(path: string, newName: string): Promise<void>;
  onMove(paths: string[], destination: string): Promise<void>;
  onImportFiles?(files: File[], destination: string): Promise<void>;
  onPickFiles?(destination: string): Promise<void>;
  onReveal?(path: string): Promise<void>;
  onCheckGitHubUpdates?(): void;
  githubUpdatesUnavailableReason?: string;
};

type Action = {id: ExplorerCommand | 'open' | 'rename' | 'collapse' | 'reveal' | 'github-updates'; label: string; disabled?: boolean; separator?: boolean; danger?: boolean; title?: string};
type ExplorerContextValue = {
  props: RepositoryExplorerProps;
  host: HTMLElement | null;
  blocked: boolean;
  pending: boolean;
  dirty: Set<string>;
  viewport: HTMLElement | null;
  tree: TreeApi<ExplorerNode> | null;
  external: {destination: string | null; problem: string | null} | null;
  internalHover: DirectDropHover | null;
  moveProblem(paths: string[], destination: string): string | null;
  move(paths: string[], destination: string): Promise<void>;
  actions(path: string | null): Action[];
  selectContext(path: string | null): void;
  runAction(action: Action['id'], path: string | null): void;
};
const ExplorerContext = createContext<ExplorerContextValue | null>(null);
const useExplorer = () => useContext(ExplorerContext)!;
const iconPaths = {
  file: 'M4 1h7l4 4v10H4ZM11 1v4h4',
  folder: 'M1 3h5l2 2h7v9H1Z',
  chevron: 'm6 4 4 4-4 4',
  more: 'M3 8h.01M8 8h.01M13 8h.01',
};
function ExplorerIcon({name}: {name: keyof typeof iconPaths}) {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={name === 'more' ? 3 : 1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name]}/></svg>;
}

function ExplorerDropCursor({top,left,indent}: CursorProps) {
  return <div className="rex-drop-cursor" style={{top:top-1,left,right:indent}} aria-hidden="true"/>;
}

/** Reuses Arborist's DnD provider, including multi-selection and native drag end. */
function ExplorerRootDrop({active,paths}: {active:boolean;paths:string[]}) {
  const context=useExplorer();
  const [{over},drop]=useDrop<{dragIds:string[]},unknown,{over:boolean}>(()=>({
    accept:'NODE',
    canDrop:item=>Boolean(context.tree?.dragNodes.length)&&!context.moveProblem(item.dragIds,''),
    hover:()=>{if(context.tree?.dragNodes.length)context.tree.hover({parentId:null,index:0},{type:'none'});},
    drop:(item,monitor)=>{if(!monitor.didDrop())void context.move(item.dragIds,'');return {handled:true};},
    collect:monitor=>({over:monitor.isOver({shallow:true})&&monitor.canDrop()}),
  }),[context]);
  const external=context.external,problem=external?external.problem:context.moveProblem(paths,'');
  const direct=activeDirectDropDestination(context.internalHover,context.tree?.state.dnd.dragId),highlight=external?external.destination===''&&!external.problem:direct!==null?direct===''&&!problem:over;
  return <div ref={element=>{drop(element);}} data-explorer-root-drop className={`rex-root-drop ${highlight?'is-over':''} ${problem?'is-blocked':''}`} hidden={!active}>
    <ExplorerIcon name="folder"/><span>{external?'Copy to repository root':'Move to repository root'}</span>
  </div>;
}

function ExplorerDragPreview({mouse,dragIds,isDragging}: DragPreviewProps) {
  const context=useExplorer(),internal=isDragging&&dragIds.length>0&&Boolean(context.tree?.dragNodes.length);
  // Arborist clears its accepted destination on a blocked hover, but retains
  // the attempted parent in DnD state. Do not mislabel that rejection as root.
  const attempted=context.tree?.state.dnd.parentId,node=attempted?context.tree?.get(attempted):null;
  const direct=activeDirectDropDestination(context.internalHover,context.tree?.state.dnd.dragId);
  const paths=selectedRoots(dragIds),destination=direct??(node&&!node.isRoot?node.id:'');
  const problem=internal?context.moveProblem(paths,destination):null;
  return <>
    {internal&&mouse&&context.host&&createPortal(<div className={`rex-drag-preview ${problem?'is-blocked':''}`} style={{left:Math.max(8,Math.min(mouse.x+12,window.innerWidth-Math.min(360,window.innerWidth*.7)-8)),top:Math.max(8,Math.min(mouse.y+12,window.innerHeight-88))}}>
      <ExplorerIcon name={paths.length===1&&context.tree?.get(paths[0])?.data.type==='file'?'file':'folder'}/>
      <span>{problem||`Move ${paths.length} item${paths.length===1?'':'s'} to ${destination||'repository root'}`}</span>
    </div>,context.host)}
    {context.viewport&&createPortal(<ExplorerRootDrop active={internal||Boolean(context.external)} paths={paths}/>,context.viewport)}
  </>;
}

function ExplorerMenuItems({path, kind}: {path: string | null; kind: 'context' | 'dropdown'}) {
  const context = useExplorer();
  const Item = kind === 'context' ? ContextMenu.Item : DropdownMenu.Item;
  const Separator = kind === 'context' ? ContextMenu.Separator : DropdownMenu.Separator;
  return <>{context.actions(path).map(action => <React.Fragment key={action.id}>
    {action.separator && <Separator className="rex-menu-separator"/>}
    <Item className="rex-menu-item" disabled={action.disabled} title={action.title} data-danger={action.danger || undefined} onSelect={() => context.runAction(action.id, path)}>{action.label}</Item>
  </React.Fragment>)}</>;
}

function ExplorerDropdown({path}: {path: string | null}) {
  const context = useExplorer();
  return <DropdownMenu.Root modal={false} onOpenChange={open => {if (open) context.selectContext(path);}}>
    <DropdownMenu.Trigger asChild><button type="button" className="rex-more" aria-label={path === null ? 'Repository file actions' : `More actions for ${path}`} title={path === null ? 'Repository file actions' : `More actions for ${path}`} disabled={context.blocked} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}><ExplorerIcon name="more"/></button></DropdownMenu.Trigger>
    {context.host && <DropdownMenu.Portal container={context.host}><DropdownMenu.Content className="rex-menu" aria-label={path === null ? 'Repository file actions' : `Actions for ${path}`} align="end" sideOffset={4} collisionBoundary={context.host} collisionPadding={8} loop onKeyDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <ExplorerMenuItems path={path} kind="dropdown"/>
    </DropdownMenu.Content></DropdownMenu.Portal>}
  </DropdownMenu.Root>;
}

function RenameInput({node, tree}: {node: NodeApi<ExplorerNode>; tree: TreeApi<ExplorerNode>}) {
  const context = useExplorer();
  const [name, setName] = useState(node.data.name);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null), submitting = useRef(false);
  useEffect(() => {
    input.current?.focus();
    const dot = node.data.type === 'file' ? node.data.name.lastIndexOf('.') : -1;
    input.current?.setSelectionRange(0, dot > 0 ? dot : node.data.name.length);
  }, [node.id]);
  const submit = async () => {
    if (submitting.current || context.blocked) return;
    const problem = renameProblem(name);
    if (problem) {setError(problem); return;}
    if (name === node.data.name) {node.reset(); return;}
    submitting.current = true;setError('');
    try {await tree.submit(node.id, name);}
    catch (reason) {setError((reason as Error).message);input.current?.focus();}
    finally {submitting.current = false;}
  };
  return <span className="rex-rename">
    <input ref={input} aria-label={`Rename ${node.id}`} aria-invalid={Boolean(error)} aria-busy={context.pending || undefined} title={error || undefined} value={name} readOnly={context.pending} onChange={event => {setName(event.target.value);setError('');}} onClick={event => event.stopPropagation()} onBlur={() => {if (!submitting.current) node.reset();}} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') {event.preventDefault();if (!submitting.current) node.reset();}
      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {event.preventDefault();void submit();}
    }}/>
    {error && <span className="rex-rename-error" role="alert">{error}</span>}
  </span>;
}

function ExplorerNodeView({node, tree, style, dragHandle, preview}: NodeRendererProps<ExplorerNode>) {
  const context = useExplorer(), folder = node.data.type === 'directory';
  const direct=activeDirectDropDestination(context.internalHover,tree.state.dnd.dragId);
  const receivesDrop=direct!==null?direct===node.id&&!context.moveProblem(tree.state.dnd.dragIds,direct):node.willReceiveDrop;
  return <div ref={dragHandle} className={`rex-node ${node.id === context.props.activePath ? 'is-active' : ''} ${node.isSelected ? 'is-selected' : ''} ${receivesDrop ? 'is-drop-target' : ''} ${context.external?.destination===node.id&&!context.external.problem?'is-external-drop-target':''} ${context.props.clipboard?.mode === 'cut' && context.props.clipboard.paths.includes(node.id) ? 'is-cut' : ''}`} style={{...style, paddingLeft: 12 + node.level * 16}} data-explorer-path={node.id} title={node.id}>
    {folder ? <button type="button" className={`rex-chevron ${node.isOpen ? 'is-open' : ''}`} tabIndex={-1} aria-label={`${node.isOpen ? 'Collapse' : 'Expand'} ${node.id}`} disabled={context.blocked} onClick={event => {event.stopPropagation();node.toggle();}} onKeyDown={event => event.stopPropagation()}><ExplorerIcon name="chevron"/></button> : <span className="rex-chevron"/>}
    <span className={`rex-file-icon ${folder ? 'is-folder' : ''}`}><ExplorerIcon name={folder ? 'folder' : 'file'}/></span>
    {node.isEditing && !preview ? <RenameInput node={node} tree={tree}/> : <span className="rex-name">{node.data.name}</span>}
    {context.dirty.has(node.id) && <span className="rex-dirty" aria-label="Unsaved changes">●</span>}
    {!node.isEditing && !preview && <ExplorerDropdown path={node.id}/>}
  </div>;
}

function ExplorerRow({node, attrs, innerRef, children}: RowRendererProps<ExplorerNode>) {
  const {blocked} = useExplorer();
  return <div {...attrs} ref={innerRef} className="rex-row" data-explorer-path={node.id} style={{...attrs.style, minWidth: 0}} onFocus={event => event.stopPropagation()} onClick={event => {if (!blocked && !node.isEditing) node.handleClick(event);}}>{children}</div>;
}

export function RepositoryExplorer(props: RepositoryExplorerProps) {
  const root = useRef<HTMLDivElement>(null), viewport = useRef<HTMLDivElement>(null), tree = useRef<TreeApi<ExplorerNode>>(null);
  const pendingRef = useRef(false), mounted = useRef(true);
  const [host, setHost] = useState<HTMLElement | null>(null), [height, setHeight] = useState(240);
  const [selected, setSelected] = useState<string[]>([]), [contextPath, setContextPath] = useState<string | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const [external,setExternal]=useState<ExplorerContextValue['external']>(null);
  const [internalHover,setInternalHover]=useState<DirectDropHover|null>(null);
  const data = useMemo(() => buildExplorerTree(props.entries), [props.entries]);
  const entries = useMemo(() => new Map(props.entries.map(entry => [entry.path, entry])), [props.entries]);
  const dirty = useMemo(() => new Set(props.dirtyPaths ?? []), [props.dirtyPaths]);
  const blocked = Boolean(props.busy || pending), immutable = Boolean(props.readOnly || blocked);

  useLayoutEffect(() => {
    if (!root.current || !viewport.current) return;
    setHost(root.current.closest<HTMLElement>('.fw-window') ?? root.current);
    const observer = new ResizeObserver(records => {const next = Math.floor(records[0].contentRect.height);if (next > 0) setHeight(next);});
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {mounted.current = true;return () => {mounted.current = false;};}, []);
  useEffect(()=>{
    const clear=()=>setInternalHover(null);
    window.addEventListener('dragstart',clear,true);window.addEventListener('drop',clear);window.addEventListener('dragend',clear);
    return()=>{window.removeEventListener('dragstart',clear,true);window.removeEventListener('drop',clear);window.removeEventListener('dragend',clear);};
  },[]);

  useEffect(() => {
    if (!props.activePath) return;
    tree.current?.openParents(props.activePath);
  }, [props.activePath,data]);

  const perform = async (action: () => void | Promise<void>, propagate = false) => {
    if (pendingRef.current || props.busy) {if (propagate) throw new Error('Wait for the current operation to finish.');return;}
    pendingRef.current = true;setPending(true);setError('');
    try {await action();}
    catch (reason) {if (mounted.current) setError((reason as Error).message || 'The operation could not be completed.');if (propagate) throw reason;}
    finally {pendingRef.current = false;if (mounted.current) setPending(false);}
  };
  const pathsFor = (path: string | null) => path === null ? [] : selectedRoots(tree.current?.isSelected(path) ? [...tree.current.selectedIds] : [path]);
  const selectContext = (path: string | null) => {
    if (path !== null && !tree.current?.isSelected(path)) tree.current?.select(path, {focus: false});
    setContextPath(path);
  };
  const actions = (path: string | null): Action[] => {
    const paths = pathsFor(path), single = path !== null && (!tree.current?.isSelected(path) || tree.current.selectedIds.size === 1);
    const folder = path === null || (entries.get(path) ?? tree.current?.get(path)?.data)?.type === 'directory';
    const result: Action[] = [];
    if (path !== null) result.push({id: 'open', label: 'Open', disabled: blocked || !single});
    if (folder) result.push({id: 'new-file', label: 'New Markdown file', disabled: immutable || !single && path !== null}, {id: 'new-folder', label: 'New folder', disabled: immutable || !single && path !== null}, {id:'import-files',label:'Import files…',disabled:immutable||!props.onPickFiles||!single&&path!==null});
    if (path !== null) {
      result.push({id: 'rename', label: 'Rename', disabled: immutable || !single, separator: true});
      if (!folder) result.push({id: 'duplicate', label: 'Duplicate', disabled: immutable});
      result.push({id: 'cut', label: 'Cut', disabled: immutable}, {id: 'copy', label: 'Copy', disabled: immutable});
    }
    if (folder) result.push({id: 'paste', label: 'Paste', disabled: immutable || !props.clipboard?.paths.length || !single && path !== null});
    if (path !== null) result.push({id: 'move', label: 'Move to…', disabled: immutable}, {id: 'copy-path', label: paths.length > 1 ? 'Copy paths' : 'Copy path', disabled: blocked, separator: true});
    result.push({id: 'reveal', label: 'Reveal the file', disabled: blocked || !props.onReveal, separator: path === null});
    if (path !== null) result.push({id: 'trash', label: 'Move to Trash', disabled: immutable, danger: true, separator: true});
    else result.push({id: 'collapse', label: 'Collapse folders', disabled: blocked, separator: true}, {id: 'restore-trash', label: 'Restore from Trash…', disabled: immutable});
    if (path === null) result.push({id: 'github-updates', label: 'Check GitHub updates…', disabled: blocked || !props.onCheckGitHubUpdates, separator: true, title: props.onCheckGitHubUpdates ? undefined : props.githubUpdatesUnavailableReason});
    return result;
  };
  const runAction = (action: Action['id'], path: string | null) => {
    if (actions(path).find(item => item.id === action)?.disabled) return;
    const paths = pathsFor(path);
    if (action === 'collapse') {tree.current?.closeAll();return;}
    if (action === 'github-updates') {props.onCheckGitHubUpdates?.();return;}
    if (action === 'rename') {setTimeout(() => {if (mounted.current && !pendingRef.current) void tree.current?.edit(paths[0]);}, 0);return;}
    if (action === 'open') {const entry = entries.get(paths[0]) ?? tree.current?.get(paths[0])?.data;if (entry) void perform(() => props.onOpen(entry.path, entry.type));return;}
    if (action === 'import-files') {if(props.onPickFiles)void perform(()=>props.onPickFiles!(path??''));return;}
    if (action === 'reveal') {if(props.onReveal)void perform(()=>props.onReveal!(path??''));return;}
    const destination = ['new-file','new-folder','paste'].includes(action) ? path ?? '' : undefined;
    void perform(() => props.onCommand(action, paths, destination));
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!event.currentTarget.contains(target) || target.closest('input,textarea,select,[contenteditable=true],[role=menu],button') || tree.current?.isEditing) return;
    if (blocked) {if (event.key !== 'Tab') {event.preventDefault();event.stopPropagation();}return;}
    const node = tree.current?.focusedNode, command = event.metaKey || event.ctrlKey;
    let action: Action['id'] | null = null;
    if (event.key === 'Enter' && node) action = 'open';
    else if (event.key === 'F2' && node) action = 'rename';
    else if ((event.key === 'Delete' || event.key === 'Backspace') && node) action = 'trash';
    else if (command && !event.altKey && !event.shiftKey) {
      if (event.key.toLowerCase() === 'x' && node) action = 'cut';
      if (event.key.toLowerCase() === 'c' && node) action = 'copy';
      if (event.key.toLowerCase() === 'v') {
        event.preventDefault();event.stopPropagation();
        const destination = node?.data.type === 'directory' ? node.id : node ? parentPath(node.id) : '';
        if (!immutable && props.clipboard?.paths.length) void perform(() => props.onCommand('paste', [], destination));
        return;
      }
    }
    if (action) {event.preventDefault();event.stopPropagation();runAction(action, node?.id ?? null);}
  };
  const moveProblem=(paths:string[],destination:string)=>immutable?'This view is read only or busy.':tree.current?.isEditing?'Finish renaming before moving files.':moveSelectionProblem(paths,destination,entries);
  const move=(paths:string[],destination:string)=>perform(async()=>{const problem=moveProblem(paths,destination);if(problem)throw new Error(problem);await props.onMove(selectedRoots(paths),destination);});
  const syncInternalHover=(event:React.DragEvent<HTMLDivElement>)=>{
    const api=tree.current;if(hasExternalFiles(event)||!api?.dragNodes.length){setInternalHover(null);return;}
    const element=event.target instanceof Element?event.target:null,row=element?.closest<HTMLElement>('.rex-row[data-explorer-path]');
    const bounds=row?.getBoundingClientRect();
    const destination=element?.closest('[data-explorer-root-drop]')?'':bounds?directFolderDropDestination(row?.dataset.explorerPath??null,event.clientY-bounds.top,bounds.height,entries):null;
    const dragId=api.state.dnd.dragId;
    if(destination===null||!dragId){setInternalHover(null);return;}
    // Keep preview and highlight tied to the actual event target even if the
    // backend's queued RAF later publishes an older hover. No delayed app write.
    setInternalHover(previous=>previous?.dragId===dragId&&previous.destination===destination?previous:{dragId,destination});
    // HTML5Backend batches hover in RAF and can retain a prior row's target IDs
    // on a short native gesture. Set only unambiguous folder/root targets before
    // its synchronous canDrop/dropEffect check; Arborist still performs the drop.
    api.hover({parentId:destination||null,index:destination?null:0},destination?{type:'highlight',id:destination}:{type:'none'});
    event.preventDefault();event.dataTransfer.dropEffect=api.canDrop()?'move':'none';
  };
  const externalTarget=(target:EventTarget|null)=>{
    const element=target instanceof Element?target:null;
    const row=element?.closest<HTMLElement>('[data-explorer-path]');
    const destination=element?.closest('[data-explorer-root-drop]')?'':externalDropDestination(row?.dataset.explorerPath??null,entries);
    const problem=immutable?'This view is read only or busy.':!props.onImportFiles?'File import requires the native app.':tree.current?.isEditing?'Finish renaming before importing files.':destination===null?'Choose an existing destination folder.':null;
    return {destination,problem};
  };
  const hasExternalFiles=(event:React.DragEvent)=>Array.from(event.dataTransfer.types).includes('Files');
  const context: ExplorerContextValue = {props, host, blocked, pending, dirty,viewport:viewport.current,tree:tree.current,external,internalHover,moveProblem,move,actions, selectContext, runAction};
  return <ExplorerContext.Provider value={context}>
    {props.rootActionsContainer && createPortal(<ExplorerDropdown path={null}/>, props.rootActionsContainer)}
    <ContextMenu.Root modal={false}><ContextMenu.Trigger asChild disabled={blocked}>
      <div ref={root} className="rex" aria-label="Repository explorer" onKeyDownCapture={onKeyDown} onDragOverCapture={event=>{
        if(!hasExternalFiles(event)){syncInternalHover(event);return;}event.preventDefault();const next=externalTarget(event.target);event.dataTransfer.dropEffect=next.problem?'none':'copy';setExternal(previous=>previous?.destination===next.destination&&previous.problem===next.problem?previous:next);
      }} onDragLeaveCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null)){setExternal(null);setInternalHover(null);}}} onDropCapture={event=>{
        if(!hasExternalFiles(event)){syncInternalHover(event);return;}event.preventDefault();const next=externalTarget(event.target),files=Array.from(event.dataTransfer.files);setExternal(null);
        if(next.problem){setError(next.problem);return;}if(!files.length){setError('No local files were supplied by the drop.');return;}
        void perform(()=>props.onImportFiles!(files,next.destination!));
      }} onContextMenuCapture={event => {
        const target = (event.target as HTMLElement).closest<HTMLElement>('[data-explorer-path]');
        selectContext(target?.dataset.explorerPath ?? null);
      }}>
        {props.rootActionsContainer === undefined ? <div className="rex-toolbar"><span className="rex-selection" role="status">{selected.length > 1 ? `${selected.length} selected` : ''}</span><ExplorerDropdown path={null}/></div>
          : selected.length > 1 && <div className="rex-selection rex-selection-summary" role="status">{selected.length} selected</div>}
        <div ref={viewport} className="rex-viewport">
          <Tree<ExplorerNode> ref={tree} data={data} width="100%" height={height} rowHeight={32} indent={16} overscanCount={6} openByDefault={false} selection={props.activePath ?? undefined} selectionFollowsFocus={false} disableEdit={immutable} disableDrag={()=>immutable||Boolean(tree.current?.isEditing)} disableDrop={({parentNode,dragNodes}) => Boolean(moveProblem(dragNodes.map(node => node.id), parentNode.isRoot ? '' : parentNode.id))} onSelect={nodes => setSelected(nodes.map(node => node.id))} onToggle={path => {if (entries.has(path) || tree.current?.get(path)) props.onToggle?.(path, Boolean(tree.current?.isOpen(path)));}} onActivate={node => {if (!blocked) void perform(() => props.onOpen(node.id, node.data.type));}} onRename={({id,name}) => perform(async () => {
            if (props.readOnly) throw new Error('Historical revisions are read only.');
            const problem = renameProblem(name);if (problem) throw new Error(problem);
            await props.onRename(id, name);
          }, true)} onMove={({dragIds,parentId}) => move(dragIds,parentId??'')} renderRow={ExplorerRow} renderDragPreview={ExplorerDragPreview} renderCursor={ExplorerDropCursor} aria-label="Repository files">{ExplorerNodeView}</Tree>
          {!data.length && <p className="rex-empty">This repository is empty.</p>}
        </div>
        {external&&<p className="rex-drop-status" role="status">{external.problem||`Copy files to ${external.destination||'repository root'}`}</p>}
        {error && <p className="rex-error" role="alert">{error}</p>}
      </div>
    </ContextMenu.Trigger>
    {host && <ContextMenu.Portal container={host}><ContextMenu.Content className="rex-menu" aria-label={contextPath === null ? 'Repository file actions' : `Actions for ${contextPath}`} collisionBoundary={host} collisionPadding={8} loop onKeyDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <ExplorerMenuItems path={contextPath} kind="context"/>
    </ContextMenu.Content></ContextMenu.Portal>}
    </ContextMenu.Root>
  </ExplorerContext.Provider>;
}
