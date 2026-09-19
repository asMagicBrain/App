import React, {useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import type {LocalWorkspaceClient, WorkspaceEntry} from './local-workspace-client';
import type {ExplorerCommand} from './RepositoryExplorer';
import {externalImportProblem,fileName, parentPath, uniqueCopyPath, type ManagementResult} from './repository-management';
import {getNativeBridge,nativeOperation} from './native-bridge.mjs';

type Item = {path:string; token:string; newPath?:string};
type TrashItem = {trashId:string; path:string; type?:string; byteLength?:number};
type Dialog = {kind:'move'|'trash'; paths:string[]; destination:string}|{kind:'restore'; entries:TrashItem[]};
type ImportOwner = {repository:string;active:boolean;ticket:string|null;cancelRequested:boolean};
type Options = {
 repository:string; workspace:LocalWorkspaceClient; local:boolean; entries:WorkspaceEntry[]; enabled:boolean; busy:boolean;
 execute(action:()=>Promise<void>,recovery?:boolean):Promise<void>;
 onChanged(result:ManagementResult):Promise<void>;
 onNewFile(parent:string):void; onNewFolder(parent:string):void;
 onHeldChange(held:boolean):void; onError(message:string):void; onNotice(message:string):void;
};
export function useRepositoryManagement(options:Options) {
 const [clipboard,setClipboard]=useState<{mode:'cut'|'copy';paths:string[];items:Item[]}|null>(null);
 const [dialog,setDialog]=useState<Dialog|null>(null),[dialogError,setDialogError]=useState('');
 const [recovery,setRecovery]=useState(false),unfinishedRefresh=useRef<ManagementResult|null>(null);
 const [importing,setImporting]=useState(false),[cancelling,setCancelling]=useState(false);
 const importOwner=useRef<ImportOwner>({repository:options.repository,active:true,ticket:null,cancelRequested:false});
 useEffect(()=>{
  const owner:ImportOwner={repository:options.repository,active:true,ticket:null,cancelRequested:false};importOwner.current=owner;
  return()=>{owner.active=false;owner.cancelRequested=true;const bridge=getNativeBridge(),ticket=owner.ticket;if(ticket&&bridge)void nativeOperation(()=>bridge.cancelExternalFiles({ticket})).catch(()=>{});};
 },[options.repository]);
 const hold=(value:boolean)=>{setRecovery(value);options.onHeldChange(value);};
 useEffect(()=>{if(!options.local)return;let disposed=false;void options.workspace.request<{recoveryRequired:boolean}>('runtimeStatus').then(status=>{if(!disposed&&status.recoveryRequired)hold(true);}).catch(()=>{});return()=>{disposed=true;};},[options.workspace,options.local]);
 const report=(error:unknown)=>{const message=(error as Error).message;options.onError(message);setDialogError(message);if((error as {code?:string}).code==='RECOVERY_REQUIRED')hold(true);};
 const execute=async(action:()=>Promise<void>,recovering=false)=>{if(recovery&&!recovering)throw new Error('Recover the local file operation before making more changes.');if(!options.enabled&&!recovering)throw new Error('Select the current local branch to manage files.');setDialogError('');try{await options.execute(action,recovering);}catch(error){report(error);throw error;}};
 const inspect=async(paths:string[])=>{const items:Item[]=[];for(const path of paths){const entry=await options.workspace.request<{token:string}>('inspectEntry',{path});items.push({path,token:entry.token});}return items;};
 const mutate=async(operation:'move'|'copy'|'trash',items:Item[])=>{
  const result=await options.workspace.request<ManagementResult>('manage',{operation,items});
  try{await options.onChanged(result);}catch(error){unfinishedRefresh.current=result;hold(true);throw new Error(`The file operation completed, but the view could not refresh: ${(error as Error).message}. Reload before trying another operation.`);}
  options.onNotice(`${operation==='copy'?'Copied':'Moved'} ${items.length} item${items.length===1?'':'s'}${operation==='trash'?' to Trash':''}.`);
 };
 const move=async(paths:string[],destination:string)=>execute(async()=>{const items=await inspect(paths);await mutate('move',items.map(item=>({...item,newPath:[destination,fileName(item.path)].filter(Boolean).join('/')})));});
 const rename=async(path:string,name:string)=>execute(async()=>{if(!name||/[\/\\]/.test(name))throw new Error('Enter a filename without folder separators.');if(fileName(path)===name)return;await mutate('move',(await inspect([path])).map(item=>({...item,newPath:[parentPath(path),name].filter(Boolean).join('/')})));});
 const command=async(command:ExplorerCommand,paths:string[],destination='')=>{
  try{
   if(command==='copy-path'){await navigator.clipboard.writeText(paths.length?paths.join('\n'):'.');options.onNotice('Path copied.');return;}
   if(!options.enabled||recovery)return;
   if(command==='new-file'){options.onNewFile(destination);return;}
   if(command==='new-folder'){options.onNewFolder(destination);return;}
   if(command==='move'||command==='trash'){setDialogError('');setDialog({kind:command,paths,destination:command==='move'?parentPath(paths[0]||''):''});return;}
   if(command==='restore-trash'){await execute(async()=>{const entries=await options.workspace.request<TrashItem[]>('listTrash');setDialog({kind:'restore',entries});});return;}
   await execute(async()=>{
    if(command==='cut'||command==='copy'){setClipboard({mode:command,paths,items:await inspect(paths)});options.onNotice(`${paths.length} item${paths.length===1?'':'s'} ready to ${command==='cut'?'move':'copy'}.`);}
    if(command==='paste'&&clipboard){await mutate(clipboard.mode==='cut'?'move':'copy',clipboard.items.map(item=>({...item,newPath:[destination,fileName(item.path)].filter(Boolean).join('/')})));if(clipboard.mode==='cut')setClipboard(null);}
    if(command==='duplicate'){
     const occupied=new Set(options.entries.map(entry=>entry.path));const items=await inspect(paths);
     for(const item of items){item.newPath=uniqueCopyPath(item.path,options.entries.find(entry=>entry.path===item.path)?.type??'file',occupied);occupied.add(item.newPath);}
     await mutate('copy',items);
    }
   });
  }catch(error){report(error);}
 };
 const submit=async()=>{if(!dialog||dialog.kind==='restore')return;try{await execute(async()=>{const items=await inspect(dialog.paths);await mutate(dialog.kind==='trash'?'trash':'move',items.map(item=>dialog.kind==='trash'?item:{...item,newPath:[dialog.destination.trim().replace(/\/$/,''),fileName(item.path)].filter(Boolean).join('/')}));setDialog(null);});}catch{/* Keep dialog and original selection for correction. */}};
 const restore=async(trashId:string)=>{try{await execute(async()=>{const result=await options.workspace.request<Partial<ManagementResult>&{path:string}>('restore',{trashId});const restored:ManagementResult={status:'completed',operation:'restore',items:[{path:result.path}],pathMoves:[],changedPaths:result.changedPaths??[result.path]};try{await options.onChanged(restored);setDialog({kind:'restore',entries:await options.workspace.request<TrashItem[]>('listTrash')});}catch(error){unfinishedRefresh.current=restored;hold(true);throw new Error(`Restored files were retained, but this view needs recovery: ${(error as Error).message}`);}options.onNotice(`Restored ${result.path}.`);});}catch{/* Recovery/collision remains visible. */}};
 const reconcile=async()=>{try{await execute(async()=>{const result=unfinishedRefresh.current??await options.workspace.request<ManagementResult>('reconcile');if(result.status==='completed'&&result.operation)await options.onChanged(result);else await options.onChanged({status:result.status,operation:'move',items:[],pathMoves:[],changedPaths:[]});if(dialog?.kind==='restore')setDialog({kind:'restore',entries:await options.workspace.request<TrashItem[]>('listTrash')});unfinishedRefresh.current=null;hold(false);options.onNotice('Local file-operation recovery completed.');},true);}catch{/* Preserve the actionable recovery state. */}};
 const cancelImport=async()=>{const owner=importOwner.current;if(!owner.active)return;owner.cancelRequested=true;setCancelling(true);const bridge=getNativeBridge(),ticket=owner.ticket;if(ticket&&bridge)try{await nativeOperation(()=>bridge.cancelExternalFiles({ticket}));}catch(error){if(owner.active)report(error);}};
 const importFiles=async(files:File[]|null,destination:string)=>{const owner=importOwner.current;return execute(async()=>{
  if(!owner.active||owner.repository!==options.repository)return;
  const bridge=getNativeBridge();if(!bridge?.prepareExternalFiles||!bridge.pickExternalFiles||!bridge.importExternalFiles)throw new Error('File import requires the current native app.');
  owner.cancelRequested=false;setCancelling(false);setImporting(true);
  try{
   const choice=await nativeOperation(()=>files?bridge.prepareExternalFiles(files):bridge.pickExternalFiles());
   if(!choice)return;
   owner.ticket=choice.ticket;
   if(!owner.active||owner.cancelRequested){await nativeOperation(()=>bridge.cancelExternalFiles({ticket:choice.ticket}));if(owner.active)options.onNotice('Import cancelled.');return;}
   const result=await nativeOperation(()=>bridge.importExternalFiles({repo:options.repository,destination,ticket:choice.ticket}));
   if(!owner.active)return;
   try{await options.onChanged(result);}catch(error){unfinishedRefresh.current=result;hold(true);throw new Error(`Files were imported, but this view could not refresh: ${(error as Error).message}. Recover the local operation before continuing.`);}
   const count=result.importedPaths.length;
   options.onNotice(`Imported ${count} item${count===1?'':'s'}.${result.skippedMetadata?' Git/application metadata was omitted.':''}`);
  }catch(error){if(!owner.active)return;if((error as {code?:string}).code==='IMPORT_CANCELLED')options.onNotice('Import cancelled.');else throw Object.assign(new Error(externalImportProblem(error)),{code:(error as {code?:string}).code});}
  finally{const ticket=owner.ticket;owner.ticket=null;if(ticket)await nativeOperation(()=>bridge.cancelExternalFiles({ticket})).catch(()=>{});if(owner.active){setImporting(false);setCancelling(false);}}
 });};
 return {clipboard,dialog,setDialog,dialogError,recovery,command,rename,move,submit,restore,reconcile,importFiles,importing,cancelling,cancelImport};
}
export function RepositoryManagementDialog({manager,busy}:{manager:ReturnType<typeof useRepositoryManagement>;busy:boolean}) {
 const ref=useRef<HTMLDialogElement>(null),id=useId(),dialog=manager.dialog;
 useLayoutEffect(()=>{if(dialog)ref.current?.showModal();else ref.current?.close();},[Boolean(dialog)]);
 const close=()=>{if(!busy)manager.setDialog(null);};
 return <>{manager.importing&&<div className="rfe-import-progress" role="status"><span>{manager.cancelling?'Cancelling import…':'Importing files…'}</span><button type="button" disabled={manager.cancelling} onClick={()=>void manager.cancelImport()}>Cancel</button></div>}<dialog ref={ref} className="rfe-commit-dialog rfe-management-dialog" aria-labelledby={`${id}-title`}
  onCancel={event=>{event.preventDefault();close();}} onKeyDown={event=>event.stopPropagation()}>
  {dialog&&<form onSubmit={event=>{event.preventDefault();void manager.submit();}}>
   <h2 id={`${id}-title`}>{dialog.kind==='restore'?'Local Trash':dialog.kind==='trash'?'Move to Trash?':'Move to folder'}</h2>
   {dialog.kind==='restore' ? <>
    <p>Restore files and folders to their original paths.</p>
    {dialog.entries.length ? <ul className="rfe-trash-list">{dialog.entries.map(item=><li key={item.trashId}>
     <span>{item.path}</span><button type="button" disabled={busy} onClick={()=>void manager.restore(item.trashId)}>Restore</button>
    </li>)}</ul> : <p>Trash is empty.</p>}
   </> : <>
    <ul className="rfe-management-paths">{dialog.paths.map(path=><li key={path}>{path}</li>)}</ul>
    {dialog.kind==='trash' ? <p>The saved files and their retained drafts can be restored from Local Trash. This does not create a Git commit.</p> : <>
     <label>Destination folder<input autoFocus value={dialog.destination} disabled={busy} placeholder="Repository root (leave empty)" onChange={event=>manager.setDialog({...dialog,destination:event.target.value})}/></label>
     <p>Choose an existing folder. Leave empty for the repository root.</p>
    </>}
   </>}
   {manager.dialogError&&<p role="alert" className="rfe-error">{manager.dialogError}</p>}
   <footer><button type="button" autoFocus={dialog.kind!=='move'} disabled={busy} onClick={close}>{dialog.kind==='restore'?'Close':'Cancel'}</button>
    {dialog.kind!=='restore'&&<button type="submit" disabled={busy}>{dialog.kind==='trash'?'Move to Trash':'Move'}</button>}
   </footer>
  </form>}
 </dialog></>;
}
