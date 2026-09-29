import {documentationLast} from './repository-capabilities.mjs';
import React, { useLayoutEffect, useRef, useState } from 'react';
import type {RepositoryCatalogEntry} from './repository-catalog';
import './repository-header.css';
function VisibilityIcon({privateRepo}:{privateRepo:boolean}) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">{privateRepo?<><rect x="6" y="10" width="12" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>:<><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></>}</svg>;
}
type Props={context?:React.ReactNode;contextReplacesOwner?:boolean;onHome?:()=>void;onApplicationHome?:()=>void;onOrganization?:()=>void;currentView?:'repository'|'home'|'organization'|'repositories';onSelect?:(name:string)=>boolean|void;initialRepository?:string;selectedRepository?:string;repositories:RepositoryCatalogEntry[];loading?:boolean;error?:string;onRetry?():void};
export function RepositoryHeader({context,contextReplacesOwner=false,onHome,onApplicationHome,onOrganization,currentView='repository',onSelect,initialRepository='Workspace',selectedRepository,repositories,loading=false,error='',onRetry}:Props) {
  const [localSelected,setSelected]=useState(initialRepository),[open,setOpen]=useState(false),[query,setQuery]=useState('');
  const selectedName=selectedRepository??localSelected;
  const selected=repositories.find(item=>item.name===selectedName)??{name:selectedName,privateRepo:true};
  const matching=documentationLast(repositories).filter(item=>item.name.toLowerCase().includes(query.toLowerCase()));
  const trigger=useRef<HTMLButtonElement>(null);
  const [placement,setPlacement]=useState({left:0,top:0,width:320,maxHeight:400});
  useLayoutEffect(()=>{
    if(context!=null){setOpen(false);return;}
    if(!open)return;
    const position=()=>{
      const button=trigger.current;
      if(!button)return;
      const anchor=button.getBoundingClientRect();
      const windowRect=button.closest('.fw-window')!.getBoundingClientRect();
      const leftBound=Math.max(8,windowRect.left+8),rightBound=Math.min(window.innerWidth-8,windowRect.right-8);
      const width=Math.min(320,Math.max(0,rightBound-leftBound));
      const top=anchor.bottom+4;
      setPlacement({left:Math.max(leftBound,Math.min(anchor.left,rightBound-width)),top,width,maxHeight:Math.max(0,Math.min(window.innerHeight,windowRect.bottom)-top-8)});
    };
    position();window.addEventListener('resize',position);
    const observer=new ResizeObserver(position);observer.observe(trigger.current!.closest('.fw-window')!);
    return ()=>{window.removeEventListener('resize',position);observer.disconnect();};
  },[open,currentView,context!=null]);
  const dismiss=()=>{setOpen(false);trigger.current?.focus();};
  return <div className="rh-header" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();dismiss();}}}>
    <button type="button" className="fw-icon rh-home" disabled={!onApplicationHome} aria-label="asMagicBrain home" title="asMagicBrain home" aria-current={currentView==='home'?'page':undefined} onClick={onApplicationHome}><span aria-hidden="true">as</span></button>
    <>{!(context!=null&&contextReplacesOwner)&&<><button type="button" className="rh-owner" disabled={!onOrganization} aria-label="asMagicBrain organization" title="asMagicBrain organization · On this device" aria-current={currentView==='organization'||currentView==='repositories'?'page':undefined} onClick={onOrganization}>asMagicBrain</button><span className="rh-slash">/</span></>}
    {context??<div className={`rh-repository ${open?'is-open':''}`}><button className="rh-repository-name" onClick={onHome} title={onHome?"Repository overview":"Repository home (placeholder)"}><VisibilityIcon privateRepo={selected.privateRepo}/><strong>{selected.name}</strong></button><div className="rh-anchor"><button ref={trigger} className="rh-trigger" aria-label={`Switch local repository: ${selected.name}, ${selected.privateRepo?'private':'public'}`} aria-expanded={open} aria-controls="local-repository-picker" onClick={()=>{setOpen(value=>!value);setQuery('');}}><svg className="rh-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4Z" fill="currentColor"/></svg></button>
    {open&&<><button className="rh-backdrop" aria-label="Dismiss repository switcher" tabIndex={-1} onClick={dismiss}/><section style={placement} className="rh-picker" id="local-repository-picker" aria-label="Switch local repository"><h2>Switch repository</h2><div className="rh-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></svg><input autoFocus type="search" aria-label="Search repositories" placeholder="Search repositories…" value={query} onChange={event=>setQuery(event.target.value)}/></div><div className="rh-list">{matching.map(item=><button key={item.name} aria-current={item.name===selected.name?'true':undefined} onClick={()=>{const accepted=onSelect?.(item.name);if(accepted!==false)setSelected(item.name);dismiss();}}><span className="rh-check">{item.name===selected.name?'✓':''}</span><VisibilityIcon privateRepo={item.privateRepo}/><span>{item.name}</span><span className="rh-sr-only">{item.privateRepo?'Private':'Public'}</span></button>)}{!matching.length&&!loading&&!error&&<p>No matching repositories</p>}</div><footer>{loading?<span role="status">Loading repositories…</span>:error?<><p role="alert">{error}</p><button onClick={onRetry}>Retry</button></>:'Managed local repositories'}</footer></section></>}</div></div>}</>
  </div>;
}
