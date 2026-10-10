import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {localLink} from '../../apps/desktop/ui/markdown-preview.mjs';
import {hydrateTechnicalDiagrams} from './technical-diagrams';
import './document-presentation.css';
import {paginatePresentation,presentationPageAt,type PresentationPage} from './presentation-pages';

export type PresentationPosition={line:number;offset:number};
export type PresentationProps={html:string;path:string;language?:string;initialPosition:PresentationPosition;onExit:(position:PresentationPosition)=>void;renderDocument?:(html:string)=>React.ReactNode;onNavigate?:(link:string,back?:boolean)=>Promise<boolean>};
export function visiblePresentationPosition(root:HTMLElement):PresentationPosition {
  const parent=root.closest<HTMLElement>('.rfe-main-scroll');
  const inset=root.classList.contains('document-presentation-content')?parseFloat(getComputedStyle(root).paddingTop)||0:0;
  const top=Math.max(root.getBoundingClientRect().top+inset,parent?.getBoundingClientRect().top??-Infinity);
  const blocks=Array.from(root.querySelectorAll<HTMLElement>('[data-source-line]')).filter(node=>node.getBoundingClientRect().height>0);
  const visible=blocks.filter(node=>node.getBoundingClientRect().bottom>top+1);
  const node=visible.find(node=>!visible.some(child=>child!==node&&node.contains(child)))??blocks.at(-1);
  return {line:Number(node?.dataset.sourceLine)||1,offset:node?node.getBoundingClientRect().top-top-(Number(node.dataset.presentationOffset)||0):0};
}
export function restorePresentationPosition(root:HTMLElement,position:PresentationPosition){
  const nodes=Array.from(root.querySelectorAll<HTMLElement>('[data-source-line]'));
  const node=nodes.filter(node=>Number(node.dataset.sourceLine)<=position.line&&Number(node.dataset.sourceEndLine)>position.line).at(-1)??nodes.find(node=>Number(node.dataset.sourceLine)>=position.line)??nodes.at(-1);
  const parent=root.closest<HTMLElement>('.rfe-main-scroll');
  const scroller=root.scrollHeight>root.clientHeight+1?root:parent??root;
  const inset=scroller.classList.contains('document-presentation-content')?parseFloat(getComputedStyle(scroller).paddingTop)||0:0;
  if(node)scroller.scrollTop+=node.getBoundingClientRect().top-scroller.getBoundingClientRect().top-inset-position.offset;
}
export default function DocumentPresentation({html,path,initialPosition,onExit,onNavigate,renderDocument,language}:PresentationProps){
  const [mode,setMode]=useState<'document'|'sections'|'pages'>('pages'),[section,setSection]=useState(0),[size,setSize]=useState(24),[help,setHelp]=useState(false),[error,setError]=useState(''),[navigating,setNavigating]=useState(false);
  const [pages,setPages]=useState<PresentationPage[]>([]),[pageIndex,setPageIndex]=useState(0);const measure=useRef<HTMLDivElement>(null),probe=useRef<HTMLDivElement>(null);
  const content=useRef<HTMLDivElement>(null),shell=useRef<HTMLDivElement>(null),positions=useRef(new Map<string,PresentationPosition>()),previousPath=useRef(path),position=useRef(initialPosition),stack=useRef<string[]>([]);
  const restoring=useRef(false),restoreFrame=useRef<number|null>(null);
  const restorePosition=(root:HTMLElement)=>{restoring.current=true;if(restoreFrame.current!==null)cancelAnimationFrame(restoreFrame.current);restorePresentationPosition(root,{...position.current,offset:mode==='pages'?0:position.current.offset});restoreFrame.current=requestAnimationFrame(()=>{restoreFrame.current=requestAnimationFrame(()=>{restoring.current=false;restoreFrame.current=null;});});};
  useEffect(()=>()=>{if(restoreFrame.current!==null)cancelAnimationFrame(restoreFrame.current);},[]);
  const theme=useMemo(()=>{const owner=document.querySelector<HTMLElement>('.fw-window');if(!owner)return {};const style=getComputedStyle(owner);return {colorScheme:style.colorScheme,'--fw-bg':style.getPropertyValue('--fw-bg'),'--fw-text':style.getPropertyValue('--fw-text')};},[]);
  const sections=useMemo(()=>{const root=document.createElement('div');root.innerHTML=html;const result:Array<{line:number;html:string}>=[];for(const node of Array.from(root.children)){if(node.matches('h1,h2')||!result.length)result.push({line:Number((node as HTMLElement).dataset.sourceLine)||1,html:''});result[result.length-1].html+=node.outerHTML;}return result;},[html]);
  const sectionAt=(line:number)=>{let found=0;sections.forEach((item,index)=>{if(item.line<=line)found=index;});return found;};
  const shown=mode==='document'?html:mode==='pages'?pages[pageIndex]?.html??'':sections[Math.min(section,sections.length-1)]?.html??'';
  useLayoutEffect(()=>{if(previousPath.current!==path){previousPath.current=path;position.current=positions.current.get(path)??{line:1,offset:0};setSection(sectionAt(position.current.line));}const layout=()=>{if(!probe.current||!measure.current)return;const next=paginatePresentation(html,probe.current,measure.current.clientHeight);setPages(next);setPageIndex(presentationPageAt(next,position.current.line,position.current.offset));};layout();const observer=new ResizeObserver(layout);if(measure.current)observer.observe(measure.current);void document.fonts.ready.then(layout);return()=>observer.disconnect();},[html,size,path]);
  useLayoutEffect(()=>{const root=content.current;if(!root)return;restorePosition(root);if(!renderDocument)void hydrateTechnicalDiagrams(root).then(()=>{if(root===content.current)restorePosition(root);}).catch(()=>setError('Some diagrams could not be displayed.'));},[shown,path]);
  useEffect(()=>{const focus=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow;const owners=Array.from(document.querySelectorAll<HTMLElement>('.fw-window'));const inert=owners.map(node=>node.inert);owners.forEach(node=>node.inert=true);document.body.style.overflow='hidden';content.current?.focus();return()=>{owners.forEach((node,index)=>node.inert=inert[index]);document.body.style.overflow=overflow;focus?.focus({preventScroll:true});};},[]);
  useEffect(()=>{const node=content.current;if(!node)return;const restore=()=>restorePosition(node);const observer=new ResizeObserver(restore);observer.observe(node);if(node.firstElementChild)observer.observe(node.firstElementChild);node.addEventListener('load',restore,true);return()=>{observer.disconnect();node.removeEventListener('load',restore,true);};},[shown,path]);
  const exit=()=>onExit(position.current);
  const changePage=(delta:number)=>{setPageIndex(current=>{const next=Math.max(0,Math.min(pages.length-1,current+delta));position.current={line:pages[next]?.line??1,offset:-(pages[next]?.offset??0)};return next;});};
  const changeSection=(delta:number)=>{const next=Math.max(0,Math.min(sections.length-1,section+delta));position.current={line:sections[next]?.line??1,offset:0};setSection(next);};
  const changeMode=()=>{setSection(sectionAt(position.current.line));setPageIndex(presentationPageAt(pages,position.current.line,position.current.offset));setMode(value=>value==='pages'?'document':value==='document'?'sections':'pages');};
  const navigate=async(link:string,back=false)=>{if(!onNavigate||navigating)return;positions.current.set(path,position.current);setNavigating(true);setError('');try{if(await onNavigate(link,back)){if(!back)stack.current.push(path);else stack.current.pop();}else setError('This document could not be opened.');}catch(reason){setError((reason as Error).message);}finally{setNavigating(false);content.current?.focus();}};
  return createPortal(<div ref={shell} lang={language} className="document-presentation" role="dialog" aria-modal="true" aria-label="Document presentation" tabIndex={-1} style={{...theme,'--presentation-size':`${size}px`} as React.CSSProperties & Record<string,string>} onKeyDown={event=>{
    if(event.defaultPrevented||event.nativeEvent.isComposing)return;
    const control=(event.target as HTMLElement).closest('input,textarea,select,button,a,[contenteditable=true]');
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(help){setHelp(false);content.current?.focus({preventScroll:true});}else exit();return;}
    if(control&&!(control.matches('button')&&['ArrowLeft','ArrowRight','PageUp','PageDown','Home','End'].includes(event.key)))return;
    if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))restoring.current=false;
    const modified=event.metaKey||event.ctrlKey;
    if(modified&&['+','=','-','0'].includes(event.key)){event.preventDefault();event.stopPropagation();setSize(value=>event.key==='0'?24:Math.max(16,Math.min(48,value+(event.key==='-'?-2:2))));return;}
    if(modified||event.altKey)return;
    if(event.key==='?'||event.key.toLowerCase()==='m'){event.preventDefault();event.stopPropagation();if(event.key==='?')setHelp(value=>!value);else changeMode();}
    else if(mode==='pages'&&['ArrowLeft','ArrowRight','PageUp','PageDown',' '].includes(event.key)){event.preventDefault();event.stopPropagation();changePage(['ArrowLeft','PageUp'].includes(event.key)||event.shiftKey?-1:1);}
    else if(mode==='pages'&&['Home','End'].includes(event.key)){event.preventDefault();event.stopPropagation();changePage(event.key==='Home'?-pages.length:pages.length);}
    else if(mode==='sections'&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();event.stopPropagation();changeSection(event.key==='ArrowRight'?1:-1);}
  }}>
    <div ref={content} className={`document-presentation-content ${mode==='pages'?'document-presentation-page':''}`} data-page={mode==='pages'?pageIndex+1:undefined} data-pages={pages.length} aria-label={mode==='pages'?`Page ${pageIndex+1} of ${pages.length}`:'Presentation content'} tabIndex={0} onWheel={()=>{restoring.current=false;}} onTouchStart={()=>{restoring.current=false;}} onScroll={()=>{if(content.current&&!restoring.current)position.current=visiblePresentationPosition(content.current);}} onClick={event=>{if(!(event.target as HTMLElement).closest('button,a,input,textarea,select,[contenteditable=true]'))content.current?.focus({preventScroll:true});const link=(event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-local-link]');if(link){event.preventDefault();const target=localLink(link.dataset.localLink!,path);if(target?.path===path&&target.fragment){const parsed=document.createElement('div');parsed.innerHTML=html;const heading=Array.from(parsed.querySelectorAll<HTMLElement>('[id],[data-heading-anchor],[data-explicit-heading-anchor]')).find(node=>node.id===target.fragment||node.dataset.headingAnchor===target.fragment||node.dataset.explicitHeadingAnchor===target.fragment);if(heading){position.current={line:Number(heading.dataset.sourceLine)||1,offset:0};setSection(sectionAt(position.current.line));setPageIndex(presentationPageAt(pages,position.current.line));requestAnimationFrame(()=>{if(content.current)restorePosition(content.current);});}else setError('This section could not be found.');}else void navigate(link.dataset.localLink!);}}} {...(renderDocument?{}:{dangerouslySetInnerHTML:{__html:shown}})}>{renderDocument?.(shown)}</div>
    <div ref={measure} className="document-presentation-measure" inert aria-hidden="true"><div ref={probe} className="document-presentation-probe"/></div>
    <button className="document-presentation-help" aria-label="Presentation controls" title="Presentation controls (?)" onClick={()=>setHelp(value=>!value)}>?</button>
    {help&&<aside className="document-presentation-controls" aria-label="Presentation controls"><button onClick={changeMode}>{mode==='pages'?'Use Document':mode==='document'?'Use Sections':'Use Pages'}</button>{mode==='pages'&&<><p>Page {pageIndex+1} of {pages.length}</p><button disabled={pageIndex===0} onClick={()=>changePage(-1)}>Previous page</button><button disabled={pageIndex>=pages.length-1} onClick={()=>changePage(1)}>Next page</button></>}{stack.current.length>0&&<button disabled={navigating} onClick={()=>void navigate(stack.current.at(-1)!,true)}>Back to previous document</button>}<p>⌘/Ctrl + / −: text size · 0: reset<br/>M: Pages/Document/Sections · ← →: pages or sections<br/>Page Up/Down or Space: pages · Scroll: oversized blocks · Esc: return</p><button onClick={exit}>Exit presentation</button></aside>}
    {(error||navigating)&&<div className="document-presentation-notice" role="status">{error||'Opening document…'}</div>}
  </div>,document.body);
}
