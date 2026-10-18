/** Layout-only pagination of already-sanitized markup. It never edits Markdown. */
import {preparePresentationBlock} from './presentation-layout';
export type PresentationPage={html:string;line:number;endLine:number;offset:number;oversized:boolean};
export function paginatePresentation(html:string,probe:HTMLElement,height:number):PresentationPage[]{
 const source=document.createElement('div');source.innerHTML=html;const pages:PresentationPage[]=[],current:HTMLElement[]=[];let oversized=false;
 const fits=(nodes:HTMLElement[])=>{probe.replaceChildren(...nodes.map(n=>n.cloneNode(true)));return probe.getBoundingClientRect().height<=height+1;};
 const flush=()=>{if(!current.length)return;const lead=current.find(n=>n.dataset.sourceLine)??current[0],first=(lead.matches('ul,ol')?lead.querySelector<HTMLElement>('[data-source-line]'):lead.matches('table')?lead.querySelector<HTMLElement>('tbody [data-source-line]'):null)??lead,last=current.at(-1)!;pages.push({html:current.map(n=>n.outerHTML).join(''),line:Number(first.dataset.sourceLine)||1,endLine:Number(last.dataset.sourceEndLine)||Number(last.dataset.sourceLine)||1,offset:first===lead?Number(first.dataset.presentationOffset)||0:0,oversized});current.length=0;oversized=false;};
 const add=(node:HTMLElement)=>{if(current.length&&!current.every(n=>n.matches('h1,h2,h3,h4,h5,h6'))&&!fits([...current,node]))flush();current.push(node);if(!fits(current)){oversized=true;flush();}};
 const textSlice=(node:HTMLElement,from:number,to:number)=>{const clone=node.cloneNode(true) as HTMLElement,walk=document.createTreeWalker(clone,NodeFilter.SHOW_TEXT),texts:Text[]=[];let text,used=0;while((text=walk.nextNode()))texts.push(text as Text);for(const item of texts){const length=item.length,begin=Math.max(0,from-used),end=Math.min(length,to-used);item.data=end>begin?item.data.slice(begin,end):'';used+=length;if(!item.data)item.remove();}for(const element of Array.from(clone.querySelectorAll('*')).reverse())if(!element.childNodes.length&&!element.matches('br,wbr'))element.remove();clone.removeAttribute('data-copy-source');return clone;};
 const blocks=Array.from(source.children);for(let index=0;index<blocks.length;index++){const raw=blocks[index];
  if(pages.length>=255){flush();current.push(...blocks.slice(index) as HTMLElement[]);oversized=true;flush();break;}
  let node=raw as HTMLElement;
  preparePresentationBlock(node,probe);
  // Treat a landscape figure and its following Markdown caption as one unit.
  const caption=blocks[index+1] as HTMLElement|undefined;
  if(node.matches('p')&&node.querySelector('img,[data-local-image]')&&caption&&(caption.matches('blockquote')||caption.matches('p')&&/^(?:Figure\s+\d|Fig\.\s*\d|图\s*\d)/i.test(caption.textContent?.trim()??''))){const group=document.createElement('div');group.className='presentation-figure';group.dataset.sourceLine=node.dataset.sourceLine??'1';group.dataset.sourceEndLine=caption.dataset.sourceEndLine??caption.dataset.sourceLine??'1';const captionCopy=caption.cloneNode(true) as HTMLElement;captionCopy.classList.add('presentation-caption');group.append(node.cloneNode(true),captionCopy);
   if(current.length&&!current.every(n=>n.matches('h1,h2,h3,h4,h5,h6'))&&!fits([...current,group]))flush();
   // Reserve real caption/heading space rather than using an image height that
   // pushes the caption into the navigation margin. Typography stays unchanged.
   probe.replaceChildren(...current.map(n=>n.cloneNode(true)),group.cloneNode(true));
   const excess=probe.getBoundingClientRect().height-height;
   if(excess>0)group.style.setProperty('--presentation-figure-height',`${Math.max(120,window.innerHeight*.6-excess-4)}px`);
   node=group;index++;}
  // Numeric columns retain authored alignment, otherwise use a reading default.
  if(node.matches('table'))for(let col=0;col<(node.querySelector('tr')?.children.length??0);col++){
   const cells=Array.from(node.querySelectorAll('tbody tr')).map(row=>row.children[col] as HTMLElement).filter(Boolean);
   const values=cells.map(cell=>cell.textContent?.trim()??'').filter(value=>value&&!/^[—–-]$/.test(value));
   if(values.length&&values.every(value=>/^[+−-]?(?:\d[\d,]*(?:\.\d*)?|\.\d+)(?:[eE][+−-]?\d+)?%?$/.test(value)))for(const row of Array.from(node.querySelectorAll('tr'))){const cell=row.children[col] as HTMLElement;if(cell&&!cell.style.textAlign)cell.style.textAlign='right';}
  }
  // Keep short related explanations with equations and demonstration commands
  // only when the complete unit fits; longer material retains pagination.
  if(node.matches('.preview-math-display,pre')&&caption?.matches('p')&&!caption.querySelector('img,[data-local-image]')&&(caption.textContent?.length??0)<600){
   const group=document.createElement('div');group.className='presentation-group';group.dataset.sourceLine=node.dataset.sourceLine??'1';group.dataset.sourceEndLine=caption.dataset.sourceEndLine??caption.dataset.sourceLine??'1';group.append(node.cloneNode(true),caption.cloneNode(true));if(fits([group])){node=group;index++;}
  }
  if(node.matches('hr')){flush();continue;}
  // Every heading depth is retained. Consecutive headings stay with their body.
  if(node.matches('h1,h2,h3,h4,h5,h6')&&current.some(n=>!n.matches('h1,h2,h3,h4,h5,h6')))flush();
  if(fits([...current,node])){current.push(node);continue;}
  if(node.matches('p')&&node.textContent&&!node.querySelector('img,svg,math,iframe,.preview-math,[data-local-image],[data-artifact]')){
   const length=node.textContent.length,graphemes=new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(node.textContent);let start=0,offset=0;
   while(start<length){if(pages.length>=255){current.push(textSlice(node,start,length));oversized=true;flush();break;}let low=start,high=length;
    while(low<high){const mid=Math.ceil((low+high)/2);if(fits([...current,textSlice(node,start,mid)]))low=mid;else high=mid-1;}
    if(low===start){if(current.length&&!current.every(n=>n.matches('h1,h2,h3,h4,h5,h6'))){flush();continue;}add(node);break;}
    let end=low;if(end<length){const boundary=node.textContent.lastIndexOf(' ',end);if(boundary>start+Math.floor((end-start)/2))end=boundary+1;}
    end=end===length?end:graphemes.containing(end)?.index??end;if(end<=start){if(current.length){flush();continue;}end=start+(graphemes.containing(start)?.segment.length??1);}const part=textSlice(node,start,end);part.dataset.presentationOffset=String(offset);probe.replaceChildren(part.cloneNode(true));offset+=probe.getBoundingClientRect().height;current.push(part);start=end;if(start<length)flush();
   }continue;
  }
  if(node.matches('pre')&&node.textContent){
   const length=node.textContent.length;let start=0,offset=0;
   while(start<length){
    if(pages.length>=255){add(textSlice(node,start,length));flush();break;}
    let low=start,high=length;while(low<high){const mid=Math.ceil((low+high)/2);if(fits([...current,textSlice(node,start,mid)]))low=mid;else high=mid-1;}
    let end=low===length?length:node.textContent.lastIndexOf('\n',low-1)+1;
    if(end<=start){if(current.length&&!current.every(n=>n.matches('h1,h2,h3,h4,h5,h6'))){flush();continue;}const newline=node.textContent.indexOf('\n',start);end=newline<0?length:newline+1;}
    const part=textSlice(node,start,end);part.dataset.presentationOffset=String(offset);probe.replaceChildren(part.cloneNode(true));offset+=probe.getBoundingClientRect().height;add(part);start=end;if(start<length)flush();
   }continue;
  }
  if(node.matches('ul,ol,table')){
   // A complete table/list may fit on a fresh page even when it cannot fit
   // after the preceding prose. Retry it intact before committing fragments.
   if(current.length&&!current.every(n=>n.matches('h1,h2,h3,h4,h5,h6'))&&fits([node])){flush();current.push(node);continue;}
   const items=node.matches('table')?Array.from(node.querySelectorAll('tbody>tr')):Array.from(node.children);let part=node.cloneNode(true) as HTMLElement;
   const container=(n:HTMLElement)=>node.matches('table')?n.querySelector('tbody')!:n;
   part.removeAttribute('data-copy-source');container(part).replaceChildren();let count=0,offset=0,remainder=false;part.dataset.presentationOffset=String(offset);
   for(let itemIndex=0;itemIndex<items.length;itemIndex++){const item=items[itemIndex];if(pages.length>=255){container(part).append(...items.slice(itemIndex).map(n=>n.cloneNode(true)));oversized=true;add(part);flush();remainder=true;count=0;break;}const candidate=part.cloneNode(true) as HTMLElement;container(candidate).append(item.cloneNode(true));if(!count&&current.length&&!current.every(n=>n.matches('h1,h2,h3,h4,h5,h6'))&&!fits([...current,candidate]))flush();if(count&&!fits([...current,candidate])){probe.replaceChildren(part.cloneNode(true));offset+=probe.getBoundingClientRect().height;add(part);flush();part=node.cloneNode(true) as HTMLElement;part.removeAttribute('data-copy-source');container(part).replaceChildren();part.dataset.presentationOffset=String(offset);if(node.matches('ol'))part.setAttribute('start',String((Number(node.getAttribute('start'))||1)+items.indexOf(item)));count=0;}container(part).append(item.cloneNode(true));count++;}
   if(count)add(part);else if(!remainder)add(node);continue;
  }
  add(node);
 }
 flush();probe.replaceChildren();return pages.length?pages:[{html:'',line:1,endLine:1,offset:0,oversized:false}];
}
export function presentationPageAt(pages:PresentationPage[],line:number,offset=0){let result=0;pages.forEach((p,i)=>{if(p.line<line||p.line===line&&p.offset<=Math.max(0,-offset))result=i;});return result;}
