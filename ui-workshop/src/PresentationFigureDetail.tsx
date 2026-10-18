import React,{useLayoutEffect,useRef,useState} from 'react';

export type FigureDetail={src:string;alt:string;width:number;height:number;returnFocus:HTMLElement};

/** Read-only magnification of the already admitted image. No new asset loading policy. */
export default function PresentationFigureDetail({figure,onClose}:{figure:FigureDetail;onClose:()=>void}){
  const root=useRef<HTMLDivElement>(null),viewport=useRef<HTMLDivElement>(null);
  const [zoom,setZoom]=useState(2),[fit,setFit]=useState({width:0,height:0});
  useLayoutEffect(()=>{
    const node=viewport.current!;
    const resize=()=>{const scale=Math.min(node.clientWidth/figure.width,node.clientHeight/figure.height);setFit({width:figure.width*scale,height:figure.height*scale});};
    resize();const observer=new ResizeObserver(resize);observer.observe(node);node.focus();
    const siblings=Array.from(root.current!.parentElement!.children).filter(n=>n!==root.current) as HTMLElement[];
    const prior=siblings.map(n=>n.inert);siblings.forEach(n=>n.inert=true);
    return()=>{observer.disconnect();siblings.forEach((n,i)=>n.inert=prior[i]);figure.returnFocus.focus({preventScroll:true});};
  },[figure]);
  useLayoutEffect(()=>{const node=viewport.current!;node.scrollLeft=0;node.scrollTop=0;},[zoom,fit]);
  const change=(delta:number)=>setZoom(value=>Math.max(1,Math.min(8,value+delta)));
  return <div ref={root} className="presentation-figure-detail" role="dialog" aria-modal="true" aria-label={`Figure detail: ${figure.alt}`} onKeyDown={event=>{
    if(event.nativeEvent.isComposing)return;
    event.stopPropagation();
    if(event.key==='Escape'){event.preventDefault();onClose();}
    else if(['+','=','-','0'].includes(event.key)){event.preventDefault();if(event.key==='0')setZoom(1);else change(event.key==='-'?-.5:.5);}
    else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();viewport.current?.scrollBy({left:event.key==='ArrowLeft'?-120:event.key==='ArrowRight'?120:0,top:event.key==='ArrowUp'?-120:event.key==='ArrowDown'?120:0});}
    else if(event.key==='Tab'){
      const targets=Array.from(root.current!.querySelectorAll<HTMLElement>('button:not(:disabled),[tabindex="0"]'));
      const index=targets.indexOf(document.activeElement as HTMLElement),next=(index+(event.shiftKey?-1:1)+targets.length)%targets.length;
      event.preventDefault();targets[next]?.focus();
    }
  }}>
    <div className="presentation-figure-detail-controls"><span>{figure.alt}</span><button disabled={zoom<=1} onClick={()=>change(-.5)} aria-label="Zoom out figure">−</button><output aria-live="polite">{zoom.toFixed(1)}×</output><button disabled={zoom>=8} onClick={()=>change(.5)} aria-label="Zoom in figure">+</button><button onClick={()=>setZoom(1)}>Fit figure</button><button onClick={onClose}>Back to presentation</button></div>
    <div ref={viewport} className="presentation-figure-detail-viewport" tabIndex={0} aria-label="Figure viewport; scroll or use arrow keys to pan">
      <div className="presentation-figure-detail-plane" style={{width:`max(100%,${fit.width*zoom}px)`,height:`max(100%,${fit.height*zoom}px)`}}><img src={figure.src} alt={figure.alt} draggable={false} style={{width:fit.width*zoom,height:fit.height*zoom}}/></div>
    </div>
    <p className="presentation-figure-detail-hint">+ / −: zoom · 0: fit · Scroll or arrows: pan · Esc: back</p>
  </div>;
}
