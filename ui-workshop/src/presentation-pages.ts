/** Layout-only pagination of already-sanitized markup. It never edits Markdown. */
export type PresentationPage={html:string;line:number;endLine:number;offset:number;oversized:boolean};
export function paginatePresentation(html:string,probe:HTMLElement,height:number):PresentationPage[]{
 const source=document.createElement('div');source.innerHTML=html;const pages:PresentationPage[]=[],current:HTMLElement[]=[];let oversized=false;
 const fits=(nodes:HTMLElement[])=>{probe.replaceChildren(...nodes.map(n=>n.cloneNode(true)));return probe.getBoundingClientRect().height<=height+1;};
 const flush=()=>{if(!current.length)return;const lead=current.find(n=>n.dataset.sourceLine)??current[0],first=(lead.matches('ul,ol')?lead.querySelector<HTMLElement>('[data-source-line]'):lead.matches('table')?lead.querySelector<HTMLElement>('tbody [data-source-line]'):null)??lead,last=current.at(-1)!;pages.push({html:current.map(n=>n.outerHTML).join(''),line:Number(first.dataset.sourceLine)||1,endLine:Number(last.dataset.sourceEndLine)||Number(last.dataset.sourceLine)||1,offset:first===lead?Number(first.dataset.presentationOffset)||0:0,oversized});current.length=0;oversized=false;};
 const add=(node:HTMLElement)=>{if(current.length&&!fits([...current,node]))flush();current.push(node);if(!fits(current)){oversized=true;flush();}};
 const textSlice=(node:HTMLElement,from:number,to:number)=>{const clone=node.cloneNode(false) as HTMLElement,walk=document.createTreeWalker(node,NodeFilter.SHOW_TEXT),texts:Text[]=[];let text;while((text=walk.nextNode()))texts.push(text as Text);const point=(offset:number):[Node,number]=>{let used=0;for(const t of texts){if(offset<=used+t.length)return [t,offset-used];used+=t.length;}return [node,node.childNodes.length];};const range=document.createRange(),a=point(from),b=point(to);range.setStart(...a);range.setEnd(...b);clone.append(range.cloneContents());return clone;};
 const blocks=Array.from(source.children);for(let index=0;index<blocks.length;index++){const raw=blocks[index];
  if(pages.length>=255){flush();current.push(...blocks.slice(index) as HTMLElement[]);oversized=true;flush();break;}
  const node=raw as HTMLElement;
  if(node.matches('hr')){flush();continue;}
  // Every heading depth is retained. Consecutive headings stay with their body.
  if(node.matches('h1,h2,h3,h4,h5,h6')&&current.some(n=>!n.matches('h1,h2,h3,h4,h5,h6')))flush();
  if(fits([...current,node])){current.push(node);continue;}
  if(node.matches('p')&&node.textContent&&!node.querySelector('img,svg,math,iframe,[data-local-image],[data-artifact]')){
   const length=node.textContent.length,graphemes=new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(node.textContent);let start=0,offset=0;
   while(start<length){if(pages.length>=255){current.push(textSlice(node,start,length));oversized=true;flush();break;}let low=start,high=length;
    while(low<high){const mid=Math.ceil((low+high)/2);if(fits([...current,textSlice(node,start,mid)]))low=mid;else high=mid-1;}
    if(low===start){if(current.length){flush();continue;}add(node);break;}
    let end=low;if(end<length){const boundary=node.textContent.lastIndexOf(' ',end);if(boundary>start+Math.floor((end-start)/2))end=boundary+1;}
    end=end===length?end:graphemes.containing(end)?.index??end;if(end<=start){if(current.length){flush();continue;}end=start+(graphemes.containing(start)?.segment.length??1);}const part=textSlice(node,start,end);part.dataset.presentationOffset=String(offset);probe.replaceChildren(part.cloneNode(true));offset+=probe.getBoundingClientRect().height;current.push(part);start=end;if(start<length)flush();
   }continue;
  }
  if(node.matches('ul,ol,table')){
   const items=node.matches('table')?Array.from(node.querySelectorAll('tbody>tr')):Array.from(node.children);let part=node.cloneNode(true) as HTMLElement;
   const container=(n:HTMLElement)=>node.matches('table')?n.querySelector('tbody')!:n;
   container(part).replaceChildren();let count=0,offset=0;part.dataset.presentationOffset=String(offset);
   for(let itemIndex=0;itemIndex<items.length;itemIndex++){const item=items[itemIndex];if(pages.length>=255){container(part).append(...items.slice(itemIndex).map(n=>n.cloneNode(true)));oversized=true;add(part);flush();count=0;break;}const candidate=part.cloneNode(true) as HTMLElement;container(candidate).append(item.cloneNode(true));if(count&&!fits([...current,candidate])){probe.replaceChildren(part.cloneNode(true));offset+=probe.getBoundingClientRect().height;add(part);flush();part=node.cloneNode(true) as HTMLElement;container(part).replaceChildren();part.dataset.presentationOffset=String(offset);if(node.matches('ol'))part.setAttribute('start',String((Number(node.getAttribute('start'))||1)+items.indexOf(item)));count=0;}container(part).append(item.cloneNode(true));count++;}
   if(count)add(part);else add(node);continue;
  }
  add(node);
 }
 flush();probe.replaceChildren();return pages.length?pages:[{html:'',line:1,endLine:1,offset:0,oversized:false}];
}
export function presentationPageAt(pages:PresentationPage[],line:number,offset=0){let result=0;pages.forEach((p,i)=>{if(p.line<line||p.line===line&&p.offset<=Math.max(0,-offset))result=i;});return result;}
