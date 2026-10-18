/** Reading-only layout hints. Saved Markdown, math source and code text stay intact. */
export function preparePresentationBlock(node:HTMLElement,probe:HTMLElement){
 if(node.matches('table'))for(const code of node.querySelectorAll<HTMLElement>('code')){
  // Prefer identifier/path boundaries to arbitrary per-character wrapping. A
  // wbr adds a layout opportunity without adding a character to copied text.
  if(code.children.length)continue;
  const pieces=(code.textContent??'').split(/(?<=[_./-])(?=.)|(?<=[a-z0-9])(?=[A-Z])/u);
  if(pieces.length<2)continue;
  code.replaceChildren();pieces.forEach((piece,index)=>{if(index)code.append(document.createElement('wbr'));code.append(document.createTextNode(piece));});
 }
 if(node.matches('table')){
  const measured=node.cloneNode(true) as HTMLElement;probe.replaceChildren(measured);
  const cells=Array.from(measured.querySelector('tr')?.children??[]),widths=cells.map(cell=>cell.getBoundingClientRect().width),total=widths.reduce((a,b)=>a+b,0);
  // Allocate from the complete table, then retain those column proportions on
  // every continued page. A short fragment must not reallocate its columns.
  if(total>0&&measured.getBoundingClientRect().width<=probe.clientWidth+1){
   const columns=document.createElement('colgroup');columns.dataset.presentationColumns='true';
   for(const width of widths){const col=document.createElement('col');col.style.width=`${width/total*100}%`;columns.append(col);}
   node.prepend(columns);node.style.tableLayout='fixed';
  }
 }
 const equations=[...(node.matches('.preview-math-display')?[node]:[]),...node.querySelectorAll<HTMLElement>('.preview-math-display')];
 if(!equations.length)return;
 const measured=node.cloneNode(true) as HTMLElement;probe.replaceChildren(measured);
 const copies=[...(measured.matches('.preview-math-display')?[measured]:[]),...measured.querySelectorAll<HTMLElement>('.preview-math-display')];
 equations.forEach((equation,index)=>{
  const copy=copies[index],display=copy.querySelector<HTMLElement>('.katex-display'),math=copy.querySelector<HTMLElement>('.katex'),ink=copy.querySelector<HTMLElement>('.katex-html');
  const target=equation.querySelector<HTMLElement>('.katex');if(!display||!math||!ink||!target)return;
  const style=getComputedStyle(display),available=display.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-4;
  const width=ink.getBoundingClientRect().width,original=parseFloat(getComputedStyle(math).fontSize);
  if(available>0&&width>available){
   const fitted=Math.max(Math.min(20,original),original*available/width);
   target.style.fontSize=`${fitted.toFixed(3)}px`;
   equation.dataset.presentationMathScale=String(fitted/original);
  }
 });
}
