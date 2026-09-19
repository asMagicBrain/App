import {documentationLast} from './repository-capabilities.mjs';
import React,{useEffect,useId,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {AsyncFzf} from 'fzf';
import {getNativeBridge,nativeOperation} from './native-bridge.mjs';
import type {RepositoryCatalogEntry} from './repository-catalog';
import type {SearchRequest,WorkspaceLocation} from './workspace-navigation';
import './workspace-search.css';

type FileResult={repo:string;path:string;ref:string};
type Result=WorkspaceLocation & {positions?:Set<number>};
type Props={request:SearchRequest;repositories:RepositoryCatalogEntry[];onClose():void;onOpen(result:WorkspaceLocation):void;returnFocus:HTMLElement|null};
const MAX_FILES=30000,MAX_ROWS=100;

export function WorkspaceSearch({request,repositories,onClose,onOpen,returnFocus}:Props){
  const [mode,setMode]=useState(request.mode),[scope,setScope]=useState(request.repo??''),[query,setQuery]=useState(''),[caseSensitive,setCaseSensitive]=useState(false);
  const [files,setFiles]=useState<FileResult[]>([]),[rows,setRows]=useState<Result[]>([]),[selected,setSelected]=useState(0),[loading,setLoading]=useState(false),[error,setError]=useState(''),[detail,setDetail]=useState(''),[inventoryNote,setInventoryNote]=useState(''),[epoch,setEpoch]=useState(0);
  const dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null),ids=useRef(new Set<string>()),id=useId();
  const bridge=getNativeBridge();
  const catalogNames=JSON.stringify(repositories.map(item=>item.name));
  const stopSearch=useRef<()=>void>(()=>{});
  const cancellations=useRef<Promise<unknown>>(Promise.resolve());
  const cancelRequests=(requestIds:Iterable<string>)=>{const pending=[...requestIds].map(requestId=>nativeOperation(()=>bridge?.cancelRepositorySearch({requestId})).catch(()=>{}));cancellations.current=Promise.allSettled([cancellations.current,...pending]);};
  const abort=()=>{cancelRequests(ids.current);ids.current.clear();};
  useLayoutEffect(()=>{const element=dialog.current!;element.showModal();input.current?.focus();return()=>{element.close();if(returnFocus?.isConnected)returnFocus.focus();};},[]);
  useEffect(()=>()=>abort(),[]);
  // Host inventories admit paths; fuzzy matching stays in the renderer and never opens files.
  useEffect(()=>{
    if(mode!=='files')return;
    let stale=false;const running=new Set<string>();
    setFiles([]);setRows([]);setError('');setInventoryNote('');setDetail('');setLoading(true);
    stopSearch.current=()=>{stale=true;abort();setLoading(false);setDetail('Search stopped. Use Retry to search again.');};
    const load=async()=>{
      if(!bridge?.listRepositoryFiles)throw new Error('File search requires the native application.');
      const pending=(scope?[scope]:repositories.map(item=>item.name));const collected:FileResult[]=[];let limited=false;
      // At most two host inventories at once; each request can be cancelled on scope change.
      await Promise.all(Array.from({length:Math.min(2,pending.length)},async()=>{
        while(pending.length&&!stale&&collected.length<MAX_FILES){
          await cancellations.current;if(stale)return;const repo=pending.shift()!;const requestId=crypto.randomUUID();running.add(requestId);ids.current.add(requestId);
          try{const ref=request.finder?(request.ref??''):'';const result=await nativeOperation(()=>bridge.listRepositoryFiles({requestId,repo,ref}));
            if(stale)return;limited ||= result.truncated;for(const path of result.paths){if(collected.length===MAX_FILES){limited=true;break;}collected.push({repo,path,ref});}
          }finally{running.delete(requestId);ids.current.delete(requestId);}
        }
      }));
      if(!stale){setFiles(collected);setInventoryNote(limited||pending.length?'Showing a limited file inventory. Choose one repository to narrow the search.':'');}
    };
    void load().catch(reason=>{if(!stale)setError(reason.message);}).finally(()=>{if(!stale)setLoading(false);});
    return()=>{stale=true;cancelRequests(running);for(const requestId of running)ids.current.delete(requestId);};
  },[mode,scope,request.ref,request.finder,epoch,catalogNames]);
  const matcher=useMemo(()=>new AsyncFzf(files,{selector:item=>item.path,limit:MAX_ROWS}),[files]);
  useEffect(()=>{
    if(mode!=='files')return;let stale=false;setRows([]);setSelected(0);
    if(!query.trim()){setRows(files.slice(0,MAX_ROWS));setSelected(0);return;}
    void matcher.find(query).then(matches=>{if(!stale){setRows(matches.map(match=>({...match.item,positions:match.positions})));setSelected(0);}}).catch(()=>{});
    return()=>{stale=true;};
  },[mode,files,query,matcher]);
  useEffect(()=>{
    if(mode!=='content')return;
    let stale=false;const requestId=crypto.randomUUID();setRows([]);setSelected(0);setError('');setDetail('');
    if(!query.trim()){setLoading(false);return;}
    setLoading(true);
    stopSearch.current=()=>{stale=true;clearTimeout(timer);abort();setLoading(false);setDetail('Search stopped. Use Retry to search again.');};
    const timer=setTimeout(()=>{
      ids.current.add(requestId);
      void nativeOperation(async()=>{
        await cancellations.current;if(stale)throw new Error('Search cancelled.');if(!bridge?.searchRepositoryText)throw new Error('Content search requires the native application.');
        return bridge.searchRepositoryText({requestId,query,caseSensitive,repo:scope||null});
      }).then(result=>{if(!stale){setRows(result.matches);setDetail(result.truncated?'Results are limited. Narrow your query or choose a repository.':result.skippedFiles?`${result.skippedFiles} ${result.skippedFiles===1?'file':'files'} could not be searched.`:'');}})
      .catch(reason=>{if(!stale)setError(reason.message);}).finally(()=>{ids.current.delete(requestId);if(!stale)setLoading(false);});
    },220);
    return()=>{stale=true;clearTimeout(timer);if(ids.current.delete(requestId))cancelRequests([requestId]);};
  },[mode,query,scope,caseSensitive,epoch]);
  const open=(row:Result)=>{abort();onOpen({...row,type:'file'});};
  const heading=request.finder?'Go to file':'Search repositories';
  const status=loading?'Searching…':error?'Search unavailable':rows.length?`${rows.length}${mode==='files'&&rows.length===MAX_ROWS?' or more':''} results`:query.trim()?'No results. Try fewer words or a different repository.':mode==='content'?'Search saved file contents. Unsaved drafts stay in the editor.':'No files in this scope.';
  return <dialog ref={dialog} className="ws-search-dialog" aria-labelledby={`${id}-title`} onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===event.currentTarget){const r=event.currentTarget.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)onClose();}}} onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape'&&!event.nativeEvent.isComposing){event.preventDefault();onClose();}}}>
    <header><h2 id={`${id}-title`}>{heading}</h2><button aria-label="Close search" onClick={onClose}>×</button></header>
    <div className="ws-search-controls">
      {!request.finder&&<><div role="group" aria-label="Search type"><button aria-pressed={mode==='content'} onClick={()=>setMode('content')}>Contents</button><button aria-pressed={mode==='files'} onClick={()=>setMode('files')}>Files</button></div><label>Scope<select aria-label="Search scope" value={scope} onChange={event=>setScope(event.target.value)}><option value="">All repositories</option>{documentationLast(repositories).map(item=><option key={item.name} value={item.name}>{item.name}</option>)}</select></label></>}
      {request.finder&&<p>{scope}{request.ref?` · ${request.ref.replace(/^refs\/(heads|tags)\//,'')}`:''}</p>}
      <input ref={input} type="search" aria-label={request.finder?'Find a file':'Search query'} placeholder={mode==='files'?'Type a filename or path…':'Search saved text…'} value={query} maxLength={512} role="combobox" aria-controls={`${id}-results`} aria-expanded="true" aria-autocomplete="list" aria-activedescendant={rows[selected]?`${id}-result-${selected}`:undefined} onChange={event=>{setRows([]);setSelected(0);setQuery(event.target.value);}} onKeyDown={event=>{if(event.nativeEvent.isComposing)return;if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const next=Math.max(0,Math.min(rows.length-1,selected+(event.key==='ArrowDown'?1:-1)));setSelected(next);document.getElementById(`${id}-result-${next}`)?.scrollIntoView({block:'nearest'});}else if(event.key==='Enter'&&rows[selected]){event.preventDefault();open(rows[selected]);}}}/>
      {mode==='content'&&<label className="ws-search-case"><input type="checkbox" checked={caseSensitive} onChange={event=>setCaseSensitive(event.target.checked)}/>Match case</label>}
    </div>
    <p className="ws-search-status" role="status" aria-live="polite">{status}</p>
    {error&&<div className="ws-search-error" role="alert">{error} <button onClick={()=>setEpoch(value=>value+1)}>Retry</button></div>}
    <div id={`${id}-results`} role="listbox" aria-label="Search results" className="ws-search-results" aria-busy={loading}>
      {rows.map((row,index)=><div key={`${row.repo}:${row.path}:${row.line??''}:${row.column??''}:${index}`} role="option" id={`${id}-result-${index}`} aria-selected={selected===index} className="ws-search-result" onMouseMove={()=>setSelected(index)} onMouseDown={event=>event.preventDefault()} onClick={()=>open(row)}><div><strong>{row.path}</strong>{row.line&&<span>:{row.line}</span>}<small>{row.repo}</small></div>{row.lineText!==undefined&&<pre>{row.lineText.slice(0,Math.max(0,(row.column??1)-1))}<mark>{row.lineText.slice(Math.max(0,(row.column??1)-1),Math.max(0,(row.endColumn??row.column??1)-1))}</mark>{row.lineText.slice(Math.max(0,(row.endColumn??row.column??1)-1))}</pre>}</div>)}
    </div>
    <footer>{detail||mode==='files'&&inventoryNote||'↑ ↓ to select · Enter to open · Esc to close'}{loading&&<button onClick={()=>{stopSearch.current();}}>Stop</button>}{detail.startsWith('Search stopped')&&<button onClick={()=>setEpoch(value=>value+1)}>Retry</button>}</footer>
  </dialog>;
}
