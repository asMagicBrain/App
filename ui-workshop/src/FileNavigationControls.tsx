import React,{useId,useLayoutEffect,useRef,useState} from 'react';
import {RevisionPicker} from './RevisionPicker';
import {RevisionListing} from './RevisionListing';
import './file-navigation-controls.css';

type Props={repository:string;branch:string;branches:string[];tags:string[];revision:string;onRevisionChange:(ref:string)=>void;disabled?:boolean;onNewFile?():void;onGoToFile?():void;rootActionsRef?:React.RefCallback<HTMLDivElement>};
function Icon({name}:{name:'plus'|'search'}){return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true"><path d={name==='plus'?'M8 2v12M2 8h12':'M11 6a5 5 0 1 1-10 0 5 5 0 0 1 10 0m-1 4 5 5'}/></svg>;}

export function FileNavigationControls({repository,branch,branches,tags,revision,onRevisionChange,disabled=false,onNewFile,onGoToFile,rootActionsRef}:Props){
 const [listing,setListing]=useState<'branches'|'tags'|null>(null);
 const root=useRef<HTMLDivElement>(null),dialog=useRef<HTMLDialogElement>(null);
 const id=useId();
 const closeListing=()=>{dialog.current?.close();setListing(null);root.current?.querySelector<HTMLButtonElement>('.rp-trigger')?.focus();};
 useLayoutEffect(()=>{
  if(!listing||!dialog.current||!root.current)return;
  const element=dialog.current,frame=root.current.closest('.rfe')||root.current.closest('.fw-main');
  const place=()=>{if(!frame)return;const box=frame.getBoundingClientRect();Object.assign(element.style,{left:`${box.left}px`,top:`${box.top}px`,width:`${box.width}px`,height:`${box.height}px`});};
  place();element.showModal();element.querySelector<HTMLButtonElement>('.fnc-back')?.focus();
  const observer=new ResizeObserver(place);if(frame)observer.observe(frame);
  window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
  return()=>{observer.disconnect();window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);element.close();};
 },[listing]);
 const select=(ref:string)=>{closeListing();onRevisionChange(ref===`refs/heads/${branch}`?'':ref);};
 return <div className="fnc" ref={root}>
  <div className="fnc-controls">
   <RevisionPicker compact branch={branch} branches={branches} tags={tags} value={revision} disabled={disabled} onChange={onRevisionChange} onList={setListing}/>
   <button disabled={disabled||!onNewFile} onClick={onNewFile} className="fnc-icon fnc-new-file" aria-label="New Markdown file" title={onNewFile?'New Markdown file':'Select the current branch to create a file'}><Icon name="plus"/></button>
   <div ref={rootActionsRef} className="fnc-root-actions"/>
   <button disabled={disabled||!onGoToFile} className="fnc-search" aria-label="Go to file" title="Go to file (T)" onClick={onGoToFile}><Icon name="search"/><span>Go to file</span><kbd>T</kbd></button>
  </div>
  <dialog ref={dialog} className="fnc-listing-dialog" aria-labelledby={`${id}-listing-title`} onCancel={event=>{event.preventDefault();closeListing();}} onKeyDown={event=>event.stopPropagation()}>
   {listing&&<><div className="fnc-listing-heading"><button className="fnc-back" onClick={closeListing}>← Back to file</button><h2 id={`${id}-listing-title`}>{repository} {listing}</h2><button className="fnc-icon" aria-label="Close revision listing" onClick={closeListing}>×</button></div><div className="fnc-listing-content"><RevisionListing kind={listing} repository={repository} branch={branch} branches={branches} tags={tags} onBack={closeListing} onSelect={select}/></div></>}
  </dialog>
 </div>;
}
