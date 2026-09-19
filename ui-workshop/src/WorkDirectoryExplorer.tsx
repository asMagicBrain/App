import React, {createContext,useContext,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Tree,type NodeRendererProps,type RowRendererProps,type TreeApi} from 'react-arborist';
import {readRepository} from './native-bridge.mjs';
import type {RepositoryCatalogEntry} from './repository-catalog';
import {CatalogContextMenu} from './CatalogActionMenu';
import type {CatalogTarget,CatalogCommand,CatalogMenuAction} from './catalog-management';
import './repository-explorer.css';
import './work-directory-explorer.css';

type LocationType='file'|'directory';
type DirectoryEntry={path:string;name:string;type:LocationType};
type WorkNode={id:string;name:string;repository:string;path:string;kind:'root'|'repository'|LocationType;children?:WorkNode[]};
type LoadState={entries:DirectoryEntry[];status:'loading'|'loaded'|'failed';error?:string};
type Props={
  repositories:readonly RepositoryCatalogEntry[];
  currentRepository:string;
  onOpenRoot():void;
  onOpenRepository(name:string):void|Promise<void>;
  onOpenLocation?:(repository:string,path:string,type:LocationType)=>void|Promise<void>;
  busy?:boolean;
  actionsFor?(target:CatalogTarget):CatalogMenuAction[];
  onAction?(target:CatalogTarget,command:CatalogCommand,trigger:HTMLElement|null):void;
};
const locationId=(repository:string,path:string)=>JSON.stringify([repository,path]);
const ROOT_ID='managed-work-directory';
const ExplorerContext=createContext<{loading:ReadonlySet<string>;host:HTMLElement|null;busy:boolean;actionsFor?:Props['actionsFor'];onAction?:Props['onAction']}>({loading:new Set(),host:null,busy:false});
const targetFor=(node:WorkNode):CatalogTarget=>node.kind==='root'?{kind:'root'}:node.kind==='repository'?{kind:'repository',repository:node.repository}:{kind:node.kind,repository:node.repository,path:node.path};
function ExplorerIcon({folder=false,chevron=false}:{folder?:boolean;chevron?:boolean}) {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={chevron?'m6 4 4 4-4 4':folder?'M1 3h5l2 2h7v9H1Z':'M4 1h7l4 4v10H4ZM11 1v4h4'}/></svg>;
}
function WorkNodeView({node,style}:NodeRendererProps<WorkNode>) {
  const {loading}=useContext(ExplorerContext),folder=node.data.kind!=='file',path=node.data.kind==='root'?'asMagicBrain':[node.data.repository,node.data.path].filter(Boolean).join('/');
  return <div className={`rex-node wde-node ${node.isSelected?'is-selected':''}`} style={{...style,paddingLeft:8+node.level*16}} title={path} data-work-directory-path={path} aria-busy={loading.has(node.id)||undefined}>
    {folder?<button type="button" className={`rex-chevron ${node.isOpen?'is-open':''}`} tabIndex={-1} aria-label={`${node.isOpen?'Collapse':'Expand'} ${path}`} onClick={event=>{event.stopPropagation();node.toggle();}} onKeyDown={event=>event.stopPropagation()}><ExplorerIcon chevron/></button>:<span className="rex-chevron"/>}
    <span className={`rex-file-icon ${folder?'is-folder':''}`}><ExplorerIcon folder={folder}/></span><span className="rex-name">{node.data.name}</span>{loading.has(node.id)&&<span className="wde-loading" aria-label="Loading folder">…</span>}
  </div>;
}
function WorkRow({node,attrs,innerRef,children}:RowRendererProps<WorkNode>) {
  const context=useContext(ExplorerContext),target=targetFor(node.data);
  const row=<div {...attrs} ref={innerRef} className="rex-row wde-row" data-work-directory-node={node.id} aria-label={node.data.kind==='root'?'asMagicBrain work directory':[node.data.repository,node.data.path].filter(Boolean).join('/')} onFocus={event=>event.stopPropagation()} onClick={node.handleClick} onKeyDown={event=>{if(!context.busy&&event.key==='Enter'&&!event.nativeEvent.isComposing&&!event.altKey&&!event.ctrlKey&&!event.metaKey){event.preventDefault();event.stopPropagation();if(!event.repeat)node.activate();}}}>{children}</div>;
  return context.actionsFor&&context.onAction?<CatalogContextMenu host={context.host} label={node.data.kind==='root'?'Work directory actions':node.data.kind==='repository'?`Repository actions for ${node.data.repository}`:`Actions for ${node.data.repository}/${node.data.path}`} actions={context.actionsFor(target)} onAction={(command,trigger)=>context.onAction?.(target,command,trigger)} busy={context.busy} onPrepare={()=>node.select()}>{row}</CatalogContextMenu>:row;
}
function admittedEntries(value:unknown,path:string):DirectoryEntry[] {
  if(!value||typeof value!=='object'||!('type' in value)||value.type!=='directory'||!('entries' in value)||!Array.isArray(value.entries))throw Error('This folder is no longer available.');
  const result=new Map<string,DirectoryEntry>();
  for(const raw of value.entries){
    if(!raw||typeof raw.path!=='string'||!['file','directory'].includes(raw.type))continue;
    const parts=raw.path.split('/'),name=parts.at(-1)!;
    if(!name||parts.slice(0,-1).join('/')!==path||/[\\\u0000-\u001f]/u.test(raw.path)||parts.some((part:string)=>!part||part==='.'||part==='..'||part.toLowerCase()==='.git'||part.toLowerCase()==='.asmagicbrain'||part.toLowerCase().startsWith('.asmb-')))continue;
    result.set(raw.path,{path:raw.path,name,type:raw.type});
  }
  return [...result.values()].sort((a,b)=>(a.type===b.type?0:a.type==='directory'?-1:1)||a.name.localeCompare(b.name));
}

/** Catalog-scoped Arborist navigation; menus delegate guarded management to the owner. */
export function WorkDirectoryExplorer({repositories,currentRepository,onOpenRoot,onOpenRepository,onOpenLocation,busy=false,actionsFor,onAction}:Props) {
  const tree=useRef<TreeApi<WorkNode>>(null),mounted=useRef(true),requests=useRef(new Map<string,AbortController>());
  const [host,setHost]=useState<HTMLElement|null>(null),[viewport,setViewport]=useState<HTMLDivElement|null>(null),[height,setHeight]=useState(240),[loads,setLoads]=useState<Map<string,LoadState>>(()=>new Map());
  const [failure,setFailure]=useState<{repository:string;path:string;message:string}|null>(null),[navigationError,setNavigationError]=useState('');
  const admitted=useRef(new Set<string>());admitted.current=new Set(repositories.map(item=>item.name));
  const loadCache=useRef(loads);loadCache.current=loads;
  useLayoutEffect(()=>{
    if(!viewport)return;
    setHost(viewport.closest<HTMLElement>('dialog')??viewport.closest<HTMLElement>('.fw-window')??viewport);
    const resize=new ResizeObserver(records=>{const next=Math.floor(records[0].contentRect.height);if(next>0)setHeight(next);});resize.observe(viewport);return()=>resize.disconnect();
  },[viewport]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;for(const request of requests.current.values())request.abort();requests.current.clear();};},[]);
  const catalogNames=repositories.map(item=>item.name).sort().join('\u0000');
  useEffect(()=>{
    for(const [id,request] of requests.current){const [repository]=JSON.parse(id);if(!admitted.current.has(repository)){request.abort();requests.current.delete(id);}}
    setLoads(previous=>new Map([...previous].filter(([id])=>admitted.current.has(JSON.parse(id)[0]))));
    setFailure(previous=>previous&&!admitted.current.has(previous.repository)?null:previous);
  },[catalogNames]);
  const load=async(repository:string,path:string,retry=false)=>{
    const id=locationId(repository,path);
    if(!admitted.current.has(repository)||requests.current.has(id)||(!retry&&loadCache.current.get(id)?.status==='loaded'))return;
    const controller=new AbortController();requests.current.set(id,controller);setLoads(previous=>new Map(previous).set(id,{entries:previous.get(id)?.entries??[],status:'loading'}));setFailure(null);
    try {
      const snapshot=await readRepository({repo:repository,path,ref:''},controller.signal);
      if(controller.signal.aborted||!mounted.current||!admitted.current.has(repository))return;
      const entries=admittedEntries(snapshot,path);setLoads(previous=>new Map(previous).set(id,{entries,status:'loaded'}));
    }catch(reason){
      if(controller.signal.aborted||!mounted.current||!admitted.current.has(repository))return;
      const message=reason instanceof Error?reason.message:'Could not load this folder.';
      setLoads(previous=>new Map(previous).set(id,{entries:[],status:'failed',error:message}));setFailure({repository,path,message});
    }finally{if(requests.current.get(id)===controller)requests.current.delete(id);}
  };
  const data=useMemo(()=>{
    const children=(repository:string,path:string):WorkNode[]=>(loads.get(locationId(repository,path))?.entries??[]).map(entry=>({id:locationId(repository,entry.path),name:entry.name,repository,path:entry.path,kind:entry.type,...(entry.type==='directory'?{children:children(repository,entry.path)}:{})}));
    return [{id:ROOT_ID,name:'asMagicBrain',repository:'',path:'',kind:'root' as const,children:repositories.map(item=>({id:locationId(item.name,''),name:item.name,repository:item.name,path:'',kind:'repository' as const,children:children(item.name,'')}))}];
  },[repositories,loads]);
  const loading=useMemo(()=>new Set([...loads].filter(([,value])=>value.status==='loading').map(([id])=>id)),[loads]);
  const activate=(node:WorkNode)=>{
    if(busy)return;
    if(node.kind==='root'){onOpenRoot();return;}
    if(!admitted.current.has(node.repository))return;
    setNavigationError('');
    Promise.resolve().then(()=>node.kind==='repository'?onOpenRepository(node.repository):onOpenLocation?.(node.repository,node.path,node.kind as LocationType)).catch(reason=>{if(mounted.current)setNavigationError(reason instanceof Error?reason.message:'Could not open this location.');});
  };
  const content=<section tabIndex={-1} className="wde rex" aria-label="Work directory explorer" aria-busy={busy||undefined}>
    <div className="wde-heading"><h2>Work directory</h2><span>On this device</span></div>
    <div ref={setViewport} className="wde-viewport rex-viewport"><ExplorerContext.Provider value={{loading,host,busy,actionsFor,onAction}}>{viewport&&<Tree<WorkNode> ref={tree} data={data} width="100%" height={height} rowHeight={32} indent={16} overscanCount={6} openByDefault={false} initialOpenState={{[ROOT_ID]:true}} selection={locationId(currentRepository,'')} selectionFollowsFocus={false} disableMultiSelection disableEdit disableDrag disableDrop dndRootElement={viewport} aria-label="Work directory" renderRow={WorkRow} onActivate={node=>activate(node.data)} onToggle={id=>{if(busy)return;const node=tree.current?.get(id);if(node?.isOpen&&node.data.kind!=='root'&&node.data.kind!=='file')void load(node.data.repository,node.data.path);}}>{WorkNodeView}</Tree>}</ExplorerContext.Provider></div>
    {loading.size>0&&<span className="wde-status" role="status">Loading folders…</span>}
    {failure&&<div className="wde-error" role="alert"><p>{failure.repository}{failure.path?'/'+failure.path:''}: {failure.message}</p><button onClick={()=>{void load(failure.repository,failure.path,true);}}>Retry folder</button></div>}
    {navigationError&&<p className="wde-error" role="alert">{navigationError}</p>}
  </section>;
  return actionsFor&&onAction?<CatalogContextMenu host={host} label="Work directory actions" actions={actionsFor({kind:'root'})} onAction={(command,trigger)=>onAction({kind:'root'},command,trigger)} busy={busy}>{content}</CatalogContextMenu>:content;
}
