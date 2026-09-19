import React, {useId, useLayoutEffect, useRef, useState} from 'react';
import {renameProblem} from './repository-explorer-model';

/** Catalog entry points reuse the owning editor's normal guarded rename. */
export function FileEntryRenameDialog({path,onRename,onClose}:{path:string;onRename(name:string):Promise<void>;onClose():void}) {
  const [name,setName]=useState(path.split('/').at(-1)??''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null),pending=useRef(false),id=useId();
  useLayoutEffect(()=>{const element=dialog.current!;element.showModal();input.current?.select();return()=>element.close();},[]);
  const close=()=>{if(!pending.current)onClose();};
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();if(pending.current)return;
    const invalid=renameProblem(name);if(invalid){setError(invalid);input.current?.focus();return;}
    pending.current=true;setBusy(true);setError('');
    try{await onRename(name);onClose();}catch(reason){setError((reason as Error).message);}finally{pending.current=false;setBusy(false);}
  };
  return <dialog ref={dialog} className="rfe-commit-dialog rfe-management-dialog" aria-labelledby={`${id}-title`} onCancel={event=>{event.preventDefault();close();}} onKeyDown={event=>event.stopPropagation()}>
    <form onSubmit={event=>void submit(event)} aria-busy={busy}>
      <h2 id={`${id}-title`}>Rename item</h2><p>{path}</p>
      <label>Name<input ref={input} required autoComplete="off" spellCheck={false} value={name} disabled={busy} onChange={event=>{setName(event.target.value);setError('');}}/></label>
      {error&&<p role="alert" className="rfe-error">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={close}>Cancel</button><button type="submit" disabled={busy}>{busy?'Renaming…':'Rename'}</button></footer>
    </form>
  </dialog>;
}
