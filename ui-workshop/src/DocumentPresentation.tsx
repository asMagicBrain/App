import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {localLink} from '../../apps/desktop/ui/markdown-preview.mjs';
import {hydrateTechnicalDiagrams} from './technical-diagrams';
import './document-presentation.css';

export type PresentationPosition={line:number;offset:number};
export type PresentationProps={html:string;path:string;initialPosition:PresentationPosition;onExit:(position:PresentationPosition)=>void;renderDocument?:(html:string)=>React.ReactNode;onNavigate?:(link:string,back?:boolean)=>Promise<boolean>};
export function visiblePresentationPosition(root:HTMLElement):PresentationPosition {
  const parent=root.closest<HTMLElement>('.rfe-main-scroll');
  const inset=root.classList.contains('document-presentation-content')?parseFloat(getComputedStyle(root).paddingTop)||0:0;
  const top=Math.max(root.getBoundingClientRect().top+inset,parent?.getBoundingClientRect().top??-Infinity);
  const blocks=Array.from(root.querySelectorAll<HTMLElement>('[data-source-line]')).filter(node=>node.getBoundingClientRect().height>0);
  const visible=blocks.filter(node=>node.getBoundingClientRect().bottom>top+1);
  const node=visible.find(node=>!visible.some(child=>child!==node&&node.contains(child)))??blocks.at(-1);
  return {line:Number(node?.dataset.sourceLine)||1,offset:node?node.getBoundingClientRect().top-top:0};
}
export function restorePresentationPosition(root:HTMLElement,position:PresentationPosition){
  const nodes=Array.from(root.querySelectorAll<HTMLElement>('[data-source-line]'));
  const node=nodes.filter(node=>Number(node.dataset.sourceLine)<=position.line&&Number(node.dataset.sourceEndLine)>position.line).at(-1)??nodes.find(node=>Number(node.dataset.sourceLine)>=position.line)??nodes.at(-1);
  const parent=root.closest<HTMLElement>('.rfe-main-scroll');
  const scroller=root.scrollHeight>root.clientHeight+1?root:parent??root;
  const inset=scroller.classList.contains('document-presentation-content')?parseFloat(getComputedStyle(scroller).paddingTop)||0:0;
  if(node)scroller.scrollTop+=node.getBoundingClientRect().top-scroller.getBoundingClientRect().top-inset-position.offset;
}
export default function DocumentPresentation({html,path,initialPosition,onExit,onNavigate,renderDocument}:PresentationProps){
  const [mode,setMode]=useState<'document'|'sections'>('document'),[section,setSection]=useState(0),[size,setSize]=useState(24),[help,setHelp]=useState(false),[error,setError]=useState(''),[navigating,setNavigating]=useState(false);
  const content=useRef<HTMLDivElement>(null),shell=useRef<HTMLDivElement>(null),positions=useRef(new Map<string,PresentationPosition>()),previousPath=useRef(path),position=useRef(initialPosition),stack=useRef<string[]>([]);
  const restoring=useRef(false),restoreFrame=useRef<number|null>(null);
  const restorePosition=(root:HTMLElement)=>{restoring.current=true;if(restoreFrame.current!==null)cancelAnimationFrame(restoreFrame.current);restorePresentationPosition(root,position.current);restoreFrame.current=requestAnimationFrame(()=>{restoreFrame.current=requestAnimationFrame(()=>{restoring.current=false;restoreFrame.current=null;});});};
  useEffect(()=>()=>{if(restoreFrame.current!==null)cancelAnimationFrame(restoreFrame.current);},[]);
  const theme=useMemo(()=>{const owner=document.querySelector<HTMLElement>('.fw-window');if(!owner)return {};const style=getComputedStyle(owner);return {colorScheme:style.colorScheme,'--fw-bg':style.getPropertyValue('--fw-bg'),'--fw-text':style.getPropertyValue('--fw-text')};},[]);
  const sections=useMemo(()=>{const root=document.createElement('div');root.innerHTML=html;const result:Array<{line:number;html:string}>=[];for(const node of Array.from(root.children)){if(node.matches('h1,h2')||!result.length)result.push({line:Number((node as HTMLElement).dataset.sourceLine)||1,html:''});result[result.length-1].html+=node.outerHTML;}return result;},[html]);
  const sectionAt=(line:number)=>{let found=0;sections.forEach((item,index)=>{if(item.line<=line)found=index;});return found;};
  const shown=mode==='document'?html:sections[Math.min(section,sections.length-1)]?.html??'';
  useLayoutEffect(()=>{if(previousPath.current!==path){previousPath.current=path;position.current=positions.current.get(path)??{line:1,offset:0};setSection(sectionAt(position.current.line));}},[path]);
  useLayoutEffect(()=>{const root=content.current;if(!root)return;restorePosition(root);if(!renderDocument)void hydrateTechnicalDiagrams(root).then(()=>{if(root===content.current)restorePosition(root);}).catch(()=>setError('Some diagrams could not be displayed.'));},[shown,path]);
  useEffect(()=>{const focus=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow;const owners=Array.from(document.querySelectorAll<HTMLElement>('.fw-window'));const inert=owners.map(node=>node.inert);owners.forEach(node=>node.inert=true);document.body.style.overflow='hidden';content.current?.focus();return()=>{owners.forEach((node,index)=>node.inert=inert[index]);document.body.style.overflow=overflow;focus?.focus({preventScroll:true});};},[]);
  useEffect(()=>{const node=content.current;if(!node)return;const restore=()=>restorePosition(node);const observer=new ResizeObserver(restore);observer.observe(node);if(node.firstElementChild)observer.observe(node.firstElementChild);node.addEventListener('load',restore,true);return()=>{observer.disconnect();node.removeEventListener('load',restore,true);};},[shown,path]);
  const exit=()=>onExit(position.current);
  const changeSection=(delta:number)=>{const next=Math.max(0,Math.min(sections.length-1,section+delta));position.current={line:sections[next]?.line??1,offset:0};setSection(next);};
  const changeMode=()=>{setSection(sectionAt(position.current.line));setMode(value=>value==='document'?'sections':'document');};
  const navigate=async(link:string,back=false)=>{if(!onNavigate||navigating)return;positions.current.set(path,position.current);setNavigating(true);setError('');try{if(await onNavigate(link,back)){if(!back)stack.current.push(path);else stack.current.pop();}else setError('This document could not be opened.');}catch(reason){setError((reason as Error).message);}finally{setNavigating(false);content.current?.focus();}};
  return createPortal(<div ref={shell} className="document-presentation" role="dialog" aria-modal="true" aria-label="Document presentation" tabIndex={-1} style={{...theme,'--presentation-size':`${size}px`} as React.CSSProperties & Record<string,string>} onKeyDown={event=>{
    if(event.defaultPrevented||event.nativeEvent.isComposing)return;
    const control=(event.target as HTMLElement).closest('input,textarea,select,button,a,[contenteditable=true]');
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(help){setHelp(false);content.current?.focus({preventScroll:true});}else exit();return;}
    if(control)return;
    if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))restoring.current=false;
    const modified=event.metaKey||event.ctrlKey;
    if(modified&&['+','=','-','0'].includes(event.key)){event.preventDefault();event.stopPropagation();setSize(value=>event.key==='0'?24:Math.max(16,Math.min(48,value+(event.key==='-'?-2:2))));return;}
    if(modified||event.altKey)return;
    if(event.key==='?'||event.key.toLowerCase()==='m'){event.preventDefault();event.stopPropagation();if(event.key==='?')setHelp(value=>!value);else changeMode();}
    else if(mode==='sections'&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();event.stopPropagation();changeSection(event.key==='ArrowRight'?1:-1);}
  }}>
    <div ref={content} className="document-presentation-content" tabIndex={0} onWheel={()=>{restoring.current=false;}} onTouchStart={()=>{restoring.current=false;}} onScroll={()=>{if(content.current&&!restoring.current)position.current=visiblePresentationPosition(content.current);}} onClick={event=>{const link=(event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-local-link]');if(link){event.preventDefault();const target=localLink(link.dataset.localLink!,path);if(target?.path===path&&target.fragment){const parsed=document.createElement('div');parsed.innerHTML=html;const heading=Array.from(parsed.querySelectorAll<HTMLElement>('[id],[data-heading-anchor]')).find(node=>node.id===target.fragment||node.dataset.headingAnchor===target.fragment);if(heading){position.current={line:Number(heading.dataset.sourceLine)||1,offset:0};setSection(sectionAt(position.current.line));requestAnimationFrame(()=>{if(content.current)restorePosition(content.current);});}else setError('This section could not be found.');}else void navigate(link.dataset.localLink!);}}} {...(renderDocument?{}:{dangerouslySetInnerHTML:{__html:shown}})}>{renderDocument?.(shown)}</div>
    <button className="document-presentation-help" aria-label="Presentation controls" title="Presentation controls (?)" onClick={()=>setHelp(value=>!value)}>?</button>
    {help&&<aside className="document-presentation-controls" aria-label="Presentation controls"><button onClick={changeMode}>{mode==='document'?'Use Sections':'Use Document'}</button>{stack.current.length>0&&<button disabled={navigating} onClick={()=>void navigate(stack.current.at(-1)!,true)}>Back to previous document</button>}<p>⌘/Ctrl + / −: text size · 0: reset<br/>M: Document/Sections · ← →: sections<br/>Scroll: long content · Esc: return</p><button onClick={exit}>Exit presentation</button></aside>}
    {(error||navigating)&&<div className="document-presentation-notice" role="status">{error||'Opening document…'}</div>}
  </div>,document.body);
}
