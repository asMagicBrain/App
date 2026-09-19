import React,{useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {RepositoryRenameDialog} from './RepositoryRenameDialog';
import {validateRepositoryName} from './repository-catalog';
import type {RepositoryTrashEntry} from './native-types';
import {suggestDuplicateRepositoryName,type CatalogRepositoryOperation} from './catalog-management';

export type CatalogDialogRequest={kind:'rename'|'duplicate'|'trash';repository:string}|{kind:'restore'};
type Props={request:CatalogDialogRequest;repositories:readonly string[];defaultRepository:string;busy?:boolean;onOperation(input:CatalogRepositoryOperation):Promise<void>;onListTrash?():Promise<RepositoryTrashEntry[]>;onClose():void};
function failureMessage(reason:unknown){
  const failure=reason as {code?:string;message?:string};
  const messages:Record<string,string>={NAME_EXISTS:'A repository or folder already uses this name. Choose another name.',INVALID_REPOSITORY_NAME:'Use a supported repository name.',DEFAULT_REPOSITORY:'The default repository must remain available.',DEFAULT_REPOSITORY_PROTECTED:'The default repository must remain available.',DEFAULT_REPOSITORY_REQUIRED:'The default repository must remain available.',RECOVERY_REQUIRED:'Resolve the pending repository recovery before trying again.',SERVICE_BUSY:'Another repository operation is in progress. Try again when it finishes.',UNKNOWN_REPOSITORY:'This repository is no longer available. Check the repository list.',GIT_BUSY:'Git is busy. Finish the current Git operation, then try again.'};
  return messages[failure?.code??'']??failure?.message??'The repository operation could not be completed. Try again.';
}
export function CatalogRepositoryDialog(props:Props){
  if(props.request.kind==='rename')return <RepositoryRenameDialog repository={props.request.repository} onClose={props.onClose} onRename={name=>props.onOperation({kind:'rename',repository:(props.request as Extract<CatalogDialogRequest,{repository:string}>).repository,name})}/>;
  return <RepositoryMutationDialog {...props} request={props.request}/>;
}
function RepositoryMutationDialog({request,repositories,defaultRepository,busy:externalBusy=false,onOperation,onListTrash,onClose}:Props&{request:Exclude<CatalogDialogRequest,{kind:'rename'}>}){
  const [name,setName]=useState(()=>request.kind==='duplicate'?suggestDuplicateRepositoryName(request.repository,repositories):'');
  const [entries,setEntries]=useState<RepositoryTrashEntry[]>([]),[selected,setSelected]=useState<RepositoryTrashEntry|null>(null);
  const [loading,setLoading]=useState(request.kind==='restore'),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null),mounted=useRef(true),pending=useRef(false),requestSequence=useRef(0);
  const logicalRequest=useRef<{name:string;id:string}|null>(null),callbacks=useRef({onListTrash});callbacks.current={onListTrash};
  const id=useId(),blocked=busy||externalBusy;
  useLayoutEffect(()=>{mounted.current=true;dialog.current?.showModal();if(request.kind==='duplicate')input.current?.select();return()=>{mounted.current=false;requestSequence.current++;dialog.current?.close();};},[]);
  const loadTrash=async()=>{
    if(!callbacks.current.onListTrash)return;
    const sequence=++requestSequence.current;setLoading(true);setError('');
    try{const result=await callbacks.current.onListTrash();if(mounted.current&&sequence===requestSequence.current)setEntries(result);}
    catch(reason){if(mounted.current&&sequence===requestSequence.current)setError(failureMessage(reason));}
    finally{if(mounted.current&&sequence===requestSequence.current)setLoading(false);}
  };
  useEffect(()=>{if(request.kind==='restore')void loadTrash();},[]);
  useEffect(()=>{if(selected)input.current?.select();},[selected]);
  const dismiss=()=>{if(!pending.current&&!externalBusy)onClose();};
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();if(pending.current||externalBusy)return;
    const next=name.trim();let operation:CatalogRepositoryOperation;
    if(request.kind==='trash'){
      if(request.repository===defaultRepository){setError('The default repository must remain available.');return;}
      logicalRequest.current??={name:request.repository,id:crypto.randomUUID()};operation={kind:'trash',repository:request.repository,requestId:logicalRequest.current.id};
    }else{
      if(request.kind==='restore'&&!selected)return;
      const problem=validateRepositoryName(next);if(problem){setError(problem);input.current?.focus();return;}
      if(request.kind==='duplicate'){
        if(logicalRequest.current?.name!==next)logicalRequest.current={name:next,id:crypto.randomUUID()};
        operation={kind:'duplicate',repository:request.repository,name:next,requestId:logicalRequest.current.id};
      }else operation={kind:'restore',trashId:selected!.trashId,name:next};
    }
    pending.current=true;setBusy(true);setError('');
    try{await onOperation(operation);if(mounted.current)onClose();}
    catch(reason){if(mounted.current)setError(failureMessage(reason));}
    finally{pending.current=false;if(mounted.current)setBusy(false);}
  };
  const title=request.kind==='duplicate'?'Duplicate repository':request.kind==='trash'?'Move repository to Trash?':'Repository Trash';
  return <dialog ref={dialog} className="rfe-commit-dialog ar-repository-dialog" aria-labelledby={`${id}-title`} onCancel={event=>{event.preventDefault();dismiss();}} onKeyDown={event=>event.stopPropagation()}>
    <form onSubmit={event=>{void submit(event);}} aria-busy={blocked||loading}>
      <h2 id={`${id}-title`}>{title}</h2>
      {request.kind==='duplicate'&&<p id={`${id}-help`}>Copy saved files and local Git history from <strong>{request.repository}</strong> to an independent local repository. Unsaved drafts stay with the original.</p>}
      {request.kind==='trash'&&<><p className="ar-dialog-repository">{request.repository}</p><p id={`${id}-help`}>Saved files, local Git history and retained drafts can be restored from Repository Trash. This does not delete a GitHub repository.</p></>}
      {request.kind==='restore'&&<><p id={`${id}-help`}>Restore a local repository with its retained drafts and history. Choose a different name if its original name is already in use.</p>{loading?<p role="status">Loading Repository Trash…</p>:entries.length?<ul className="rfe-trash-list ar-repository-trash-list">{entries.map(entry=><li key={entry.trashId}><span>{entry.name}</span><button type="button" disabled={blocked} aria-pressed={selected?.trashId===entry.trashId} aria-label={`Choose ${entry.name} to restore`} onClick={()=>{setSelected(entry);setName(entry.name);setError('');}}>{selected?.trashId===entry.trashId?'Selected':'Choose'}</button></li>)}</ul>:!error&&<p>Repository Trash is empty.</p>}{error&&!selected&&<button type="button" className="ar-button" disabled={loading||blocked} onClick={()=>{void loadTrash();}}>Retry Repository Trash</button>}</>}
      {(request.kind==='duplicate'||request.kind==='restore'&&selected)&&<label>Repository name<input ref={input} required maxLength={100} autoComplete="off" spellCheck={false} value={name} disabled={blocked} aria-invalid={Boolean(error)} aria-describedby={`${id}-help${error?` ${id}-error`:''}`} onChange={event=>{setName(event.target.value);setError('');}}/></label>}
      {error&&<p id={`${id}-error`} className="rfe-error" role="alert">{error}</p>}
      {blocked&&<p role="status">{request.kind==='duplicate'?'Duplicating repository…':request.kind==='trash'?'Moving repository to Trash…':'Restoring repository…'}</p>}
      <footer><button type="button" autoFocus={request.kind!=='duplicate'} disabled={blocked} onClick={dismiss}>{request.kind==='restore'&&!selected?'Close':'Cancel'}</button>{(request.kind!=='restore'||selected)&&<button type="submit" disabled={blocked||loading} data-danger={request.kind==='trash'||undefined}>{request.kind==='duplicate'?'Duplicate repository':request.kind==='trash'?'Move to Trash':'Restore repository'}</button>}</footer>
    </form>
  </dialog>;
}
