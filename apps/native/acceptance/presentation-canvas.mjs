import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {renderSourcePreview} from '../../desktop/ui/markdown-preview.mjs';
import {createDriver,nativeTarget,testRoot,until} from './native-driver.mjs';

const lesson=process.env.ASMB_TEACHING_LESSON;
assert.ok(lesson,'Set ASMB_TEACHING_LESSON to the read-only teaching Markdown');
const output=await fs.mkdtemp(path.join(testRoot,'presentation-canvas-'));
const data=path.join(output,'data'),repo=path.join(data,'workspaces/asMagicBrain/Workspace');
const driver=await createDriver({...nativeTarget(data),output,workspacePath:repo});
const originals=[],figures={},measurements=[];let page,running=false,failure;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
 page=await driver.launch();running=true;await page.getByRole('heading',{name:'Workspace',exact:true}).first().waitFor();await driver.closeNormally();running=false;
 const bytes=await fs.readFile(lesson),source=bytes.toString();originals.push({file:lesson,sha256:hash(bytes)});await fs.writeFile(path.join(repo,'README.md'),bytes);
 for(const match of source.matchAll(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)){
  const relative=decodeURIComponent(match[2]);if(/^[a-z]+:/i.test(relative))continue;const from=path.resolve(path.dirname(lesson),relative),to=path.resolve(repo,relative);
  assert.ok(from.startsWith(path.dirname(lesson)+path.sep));assert.ok(to.startsWith(repo+path.sep));const image=await fs.readFile(from);originals.push({file:from,sha256:hash(image)});await fs.mkdir(path.dirname(to),{recursive:true});await fs.writeFile(to,image);
  // A peer vector export estimates raster label size without regenerating or
  // injecting imported SVG. Report this as an estimate, never an OCR result.
  if(from.endsWith('.png'))try{
   const svg=await fs.readFile(from.replace(/\.png$/,'.svg'),'utf8');const width=Number(svg.match(/viewBox="[^"]*?\s([\d.]+)\s[\d.]+"/)?.[1]);
   const sizes=[...svg.matchAll(/font(?:-size)?:\s*(\d+(?:\.\d+)?)px/g)].map(m=>Number(m[1]));
   if(width&&sizes.length)figures[match[1]]={minimumVectorFont:Math.min(...sizes),vectorWidth:width,method:'matching SVG export font size × displayed PNG width / SVG viewBox width'};
  }catch{}
 }
 page=await driver.launch();running=true;await page.getByRole('button',{name:'README.md',exact:true}).first().click();await driver.app.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});const w=BrowserWindow.getAllWindows().find(w=>!w.getParentWindow());w.show();w.focus();});await new Promise(resolve=>setTimeout(resolve,500));await page.getByRole('button',{name:'Present',exact:true}).click();const content=page.locator('.document-presentation-content');await content.waitFor({timeout:30000});
 const html=renderSourcePreview(source,'README.md',{technical:true,sourceMap:true}).html;
 const baseline=await page.evaluate(html=>{const root=document.createElement('div');root.innerHTML=html;root.querySelectorAll('[data-math-source]').forEach(n=>n.textContent=n.dataset.mathSource);root.querySelectorAll('[data-local-image],button').forEach(n=>n.remove());return {text:root.textContent.replace(/\s/g,''),code:[...root.querySelectorAll('pre')].map(n=>({line:n.dataset.sourceLine,text:n.textContent}))};},html);
 const emulation=await page.context().newCDPSession(page);
 for(const viewport of ['fullscreen',[1280,800],'wide-emulated']){
  await emulation.send('Emulation.clearDeviceMetricsOverride');
  await driver.app.evaluate(async({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>!w.getParentWindow());if(w.isFullScreen())await new Promise(resolve=>{w.once('leave-full-screen',resolve);w.setFullScreen(false);});});
  if(viewport==='fullscreen')await driver.app.evaluate(async({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>!w.getParentWindow());await new Promise(resolve=>{w.once('enter-full-screen',resolve);w.setFullScreen(true);});});
  else if(viewport==='wide-emulated')await emulation.send('Emulation.setDeviceMetricsOverride',{width:5120,height:1440,deviceScaleFactor:1,mobile:false});
  else await driver.app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows().find(w=>!w.getParentWindow()).setContentSize(...size),viewport);
  await new Promise(resolve=>setTimeout(resolve,750));await content.press('Home');
  const dimensions=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));if(Array.isArray(viewport))assert.deepEqual([dimensions.width,dimensions.height],viewport);if(viewport==='wide-emulated')assert.deepEqual([dimensions.width,dimensions.height],[5120,1440]);
  const codes=new Map(),headers=new Set(),parts=[],pages=[];let screenshotCode=false,screenshotMath=false,screenshotTable=false;
  const total=Number(await content.getAttribute('data-pages'));
  for(let index=1;index<=total;index++){
   await until(async()=>Number(await content.getAttribute('data-page'))===index,{label:'committed page'});
   if(await content.locator('[data-local-image]').count())await until(async()=>!await content.locator('[data-local-image]').count(),{timeout:15000,label:'admitted image'});
   if(await content.locator('img').count())await until(()=>content.locator('img').evaluateAll(nodes=>nodes.every(n=>n.complete&&n.naturalWidth)),{label:'decoded figure'});
   const state=await content.evaluate((node,seen)=>{
    const rect=n=>{const b=n.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,font:parseFloat(getComputedStyle(n).fontSize)};};
    const copy=node.querySelector('article').cloneNode(true);copy.querySelectorAll('[data-math-source]').forEach(n=>n.textContent=n.dataset.mathSource);copy.querySelectorAll('[data-local-image],img,button,dialog:not([open]),[hidden]').forEach(n=>n.remove());
    const repeats=[];copy.querySelectorAll('table').forEach(t=>{const key=t.dataset.sourceLine;if(seen.includes(key))t.querySelector('thead')?.remove();else repeats.push(key);});
    const substantive=[...copy.children].some(n=>!n.matches('h1,h2,h3,h4,h5,h6')&&n.textContent.trim());
    const mathFonts=[];node.querySelectorAll('.katex-html').forEach(m=>{const walk=document.createTreeWalker(m,NodeFilter.SHOW_TEXT);let t;while((t=walk.nextNode()))if(t.textContent.replace(/[\s\u200b-\u200f\u2060\ufeff]/g,'')){const range=document.createRange();range.selectNodeContents(t);const box=range.getBoundingClientRect();if(box.width>0&&box.height>0)mathFonts.push(parseFloat(getComputedStyle(t.parentElement).fontSize));}});
    return {index:Number(node.dataset.page),text:copy.textContent.replace(/\s/g,''),repeats,substantive,hasImage:!!node.querySelector('img'),body:parseFloat(getComputedStyle(node).fontSize),family:getComputedStyle(node).fontFamily,proseMeasure:getComputedStyle(node).getPropertyValue('--presentation-prose'),overflow:node.scrollWidth>node.clientWidth+2,
     code:[...node.querySelectorAll('pre')].map(n=>({line:n.dataset.sourceLine,text:n.textContent,box:rect(n),textSize:parseFloat(getComputedStyle(n.querySelector('code')??n).fontSize)})),
     figures:[...node.querySelectorAll('img')].map(n=>({...rect(n),alt:n.alt,ratio:n.naturalWidth/n.naturalHeight,caption:n.closest('.presentation-figure')?.querySelector('.presentation-caption')?rect(n.closest('.presentation-figure').querySelector('.presentation-caption')):null})),
     headings:[...node.querySelectorAll('article>h1,article>h2,article>h3,article>h4,article>h5,article>h6')].map(rect),prose:[...node.querySelectorAll('article>p:not(:has(img))')].map(rect),mathMinimum:mathFonts.length?Math.min(...mathFonts):null,tables:node.querySelectorAll('table').length,
     fonts:[...document.fonts].filter(f=>f.family.includes('MiSans')).map(f=>({family:f.family,status:f.status}))};
   },[...headers]);
   assert.ok(state.substantive||state.hasImage,'no heading-only page');assert.equal(state.overflow,false,'no page horizontal clipping');
   for(const code of state.code)codes.set(code.line,(codes.get(code.line)??'')+code.text);
   for(const key of state.repeats)headers.add(key);parts.push(state.text);
   for(const figure of state.figures){assert.ok(figure.x>=dimensions.width*.055-2&&figure.x+figure.width<=dimensions.width*.945+2,'horizontal figure safe margins');assert.ok(Math.abs(figure.width/figure.height-figure.ratio)<.02,'figure aspect');assert.ok(figure.caption,'figure has same-page caption');assert.ok(figure.caption.y>=figure.y+figure.height-2,'caption below figure');assert.ok(figure.caption.y+figure.caption.height<=dimensions.height*.955-24+4,'caption in teaching area');if(figures[figure.alt])figure.minimumTextEstimate=figures[figure.alt].minimumVectorFont*figure.width/figures[figure.alt].vectorWidth;}
   if(state.prose.length)for(const heading of state.headings)assert.ok(Math.abs(heading.x-state.prose[0].x)<3,'heading and prose left edge');
   if(state.figures.length||state.code.length&&!screenshotCode||state.mathMinimum&&!screenshotMath||state.tables&&!screenshotTable){await driver.screenshot(`canvas-${dimensions.width}-page-${index}`);screenshotCode||=state.code.length>0;screenshotMath||=!!state.mathMinimum;screenshotTable||=!!state.tables;}
   if(state.figures.length){
    await content.locator('img').first().focus();await content.locator('img').first().press('Enter');
    const detail=page.getByRole('dialog',{name:/^Figure detail:/});await detail.waitFor();
    assert.equal(Number(await content.getAttribute('data-page')),index,'detail does not navigate lecture');
    const pane=detail.locator('.presentation-figure-detail-viewport');await pane.press('0');
    for(let zoom=1;zoom<4;zoom+=.5)await pane.press('+');
    await until(async()=>await detail.locator('output').innerText()==='4.0×',{label:'figure detail magnification'});
    const detailState=await detail.locator('img').evaluate(n=>({alt:n.alt,width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height,naturalWidth:n.naturalWidth,naturalHeight:n.naturalHeight,src:n.currentSrc}));
    assert.ok(Math.abs(detailState.width/detailState.height-detailState.naturalWidth/detailState.naturalHeight)<.02,'detail aspect ratio retained');
    assert.ok(detailState.width>state.figures[0].width,'detail magnifies original admitted image');
    if(figures[detailState.alt])detailState.minimumTextEstimate=figures[detailState.alt].minimumVectorFont*detailState.width/figures[detailState.alt].vectorWidth;
    await pane.press('ArrowUp');await pane.press('ArrowLeft');
    await pane.press('Tab');assert.ok(await detail.evaluate(n=>n.contains(document.activeElement)),'detail keyboard focus contained');
    if(detailState.alt==='Measured gain and phase lag'){await pane.evaluate(n=>n.scrollTo(0,0));await driver.screenshot(`figure-detail-${dimensions.width}-4x`);await pane.evaluate(n=>n.scrollTo(0,n.scrollHeight));await driver.screenshot(`figure-phase-detail-${dimensions.width}-4x`);}
    await detail.press('Escape');await detail.waitFor({state:'detached'});
    assert.equal(Number(await content.getAttribute('data-page')),index,'Escape returns to same lecture page');
    assert.ok(await content.locator('img').first().evaluate(n=>n===document.activeElement),'focus restored to figure');
    if(index+2<=total){for(let delta=1;delta<=2;delta++){await page.keyboard.press('ArrowRight');await until(()=>content.getAttribute('data-page').then(n=>Number(n)===index+delta),{label:'natural keyboard navigation after figure return'});}for(let delta=1;delta<=2;delta++){await page.keyboard.press('ArrowLeft');await until(()=>content.getAttribute('data-page').then(n=>Number(n)===index+2-delta),{label:'natural keyboard navigation back to original figure page'});}}
    state.figureDetail=detailState;
   }
   pages.push({...state,text:undefined,code:state.code.map(({text,...rest})=>rest)});
   if(index<total)await content.press('ArrowRight');
  }
  const actualText=parts.join('');if(actualText!==baseline.text){let first=0;while(first<Math.min(actualText.length,baseline.text.length)&&actualText[first]===baseline.text[first])first++;await fs.writeFile(path.join(output,'text-difference.json'),JSON.stringify({first,actualLength:actualText.length,expectedLength:baseline.text.length,actual:actualText.slice(Math.max(0,first-100),first+200),expected:baseline.text.slice(Math.max(0,first-100),first+200)},null,2));}assert.equal(hash(actualText),hash(baseline.text),'all original visible text retained, ignoring whitespace, hidden controls and repeated table headers');
  for(const block of baseline.code)assert.equal(codes.get(block.line),block.text,'code indentation and complete lines retained');
  assert.ok(pages.some(p=>p.fonts.some(f=>f.status==='loaded')),'actual MiSans loaded');
  await content.press('ArrowLeft');if(total>1)assert.equal(Number(await content.getAttribute('data-page')),total-1);await content.press('ArrowRight');assert.equal(Number(await content.getAttribute('data-page')),total);
  measurements.push({viewport,dimensions,total,pages});
 }
 await emulation.send('Emulation.clearDeviceMetricsOverride');await emulation.detach();
 await content.press('Escape');await page.getByRole('dialog',{name:'Document presentation'}).waitFor({state:'detached'});await until(()=>driver.app.evaluate(({BrowserWindow})=>!BrowserWindow.getAllWindows().find(w=>!w.getParentWindow()).isFullScreen()),{label:'native return'});
 await driver.closeNormally();running=false;for(const original of originals)assert.equal(hash(await fs.readFile(original.file)),original.sha256);assert.deepEqual(driver.errors,[]);assert.deepEqual(driver.consoleErrors,[]);
}catch(error){failure=error;console.error(error);await driver.screenshot('failure').catch(()=>{});}
finally{if(running)await driver.closeNormally().catch(()=>{});await fs.writeFile(path.join(output,'measurements.json'),JSON.stringify({measurements,figures,originals},null,2));await driver.report({passed:!failure,failure:failure?.stack??null,scope:'Latest complete teaching notes/code, actual connected fullscreen and1280×800, separately emulated5120×1440 layout; all figures and natural keyboard navigation; projected-size estimates, not classroom/projector validation'});}
console.log(output);if(failure)process.exitCode=1;
