/** Complete, external textbook fixtures; never read or edit personal workspaces. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {testRoot as allowedRoot} from '../../../tools/development-paths.mjs';
import {renderSourcePreview} from '../../desktop/ui/markdown-preview.mjs';
import {createDriver,nativeTarget,testRoot,until,sha} from './native-driver.mjs';
assert.deepEqual(process.argv.slice(2),['--run-isolated']);
const fixture=await fs.realpath(process.env.ASMB_PRESENTATION_FIXTURE??'');
assert.ok(fixture.startsWith(allowedRoot+path.sep),'Use a previously isolated Test fixture, not personal files');
await fs.mkdir(testRoot,{recursive:true});
const output=await fs.mkdtemp(path.join(testRoot,'textbook-')),data=path.join(output,'data'),repo=path.join(data,'workspaces/asMagicBrain/Workspace');
const driver=await createDriver({...nativeTarget(data),output,workspacePath:repo});
const capturePath=process.env.ASMB_PRESENTATION_CAPTURE_SPEC;if(capturePath)assert.ok((await fs.realpath(capturePath)).startsWith(allowedRoot+path.sep));
const captures=capturePath?JSON.parse(await fs.readFile(capturePath,'utf8')):{};
const chapters=[14,15,16],results=[],fontEvidence=[];let page,live=false,failure;
const button=name=>page.getByRole('button',{name,exact:true});
const content=()=>page.locator('.document-presentation-content');
const settle=async()=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(180);};
const normalize=s=>s.replace(/\s/g,'');
async function layout(){return content().evaluate(root=>{
 const rect=n=>{const b=n.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom};};
 const style=getComputedStyle(root),left=parseFloat(style.paddingLeft),right=innerWidth-parseFloat(style.paddingRight);
 const mathInk=n=>{const boxes=[...n.querySelectorAll('.katex-base')].map(rect);return {left:Math.min(...boxes.map(b=>b.x)),right:Math.max(...boxes.map(b=>b.right))};};
 const broken=[];for(const cell of root.querySelectorAll('td,th')){const walk=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);let t;while((t=walk.nextNode())){if(t.parentElement.closest('code,.preview-math'))continue;for(const m of t.textContent.matchAll(/[A-Za-z]{4,}/g)){const r=document.createRange();r.setStart(t,m.index);r.setEnd(t,m.index+m[0].length);const ys=[...r.getClientRects()].map(b=>Math.round(b.y));if(new Set(ys).size>1)broken.push(m[0]);}}}
 return {page:Number(root.dataset.page),total:Number(root.dataset.pages),viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},body:parseFloat(style.fontSize),left,right,brokenWords:broken,
 tables:[...root.querySelectorAll('table')].map(t=>({line:t.dataset.sourceLine,box:rect(t),client:t.clientWidth,scroll:t.scrollWidth,headers:[...t.querySelectorAll('th')].map(n=>({text:n.textContent,box:rect(n),wrap:getComputedStyle(n).whiteSpace})),html:t.outerHTML,prefixOnlyHeadings:[...t.parentElement.children].slice(0,[...t.parentElement.children].indexOf(t)).every(n=>/^H[1-6]$/.test(n.tagName)),rows:[...t.querySelectorAll('tbody tr')].map(r=>({text:r.textContent,html:r.outerHTML,box:rect(r)})),codes:[...t.querySelectorAll('code')].map(n=>({text:n.textContent,box:rect(n),family:getComputedStyle(n).fontFamily,breaks:n.querySelectorAll('wbr').length}))})),
 math:[...root.querySelectorAll('.preview-math-display')].map(n=>({line:n.dataset.sourceLine,source:n.dataset.mathSource,box:rect(n),ink:mathInk(n),font:parseFloat(getComputedStyle(n.querySelector('.katex')).fontSize),scale:Number(n.dataset.presentationMathScale??1)})),
 allMath:[...root.querySelectorAll('[data-math-source]')].map(n=>n.dataset.mathSource),html:root.querySelector('article')?.innerHTML??root.innerHTML};
 });}
async function fonts(){
 await page.evaluate(async()=>{const p=document.createElement('div');p.dataset.presentationFontProbe='true';p.innerHTML='<span data-font="prose">Learning evidence</span><span data-font="hans" lang="zh-CN">机器人课程</span><span data-font="hant" lang="zh-TW">機器人課程</span><code data-font="code">qvel_rad_s</code>';p.style.cssText='position:fixed;left:0;top:0;font-size:24px';document.querySelector('.document-presentation').append(p);await Promise.all([document.fonts.load('24px "asMagicBrain MiSans UI"','Learning机器人'),document.fonts.load('24px "asMagicBrain MiSans TC UI"','機器人課程')]);await document.fonts.ready;});
 await content().locator('h1').first().waitFor();await content().locator('h1').first().evaluate(n=>n.dataset.font='heading');
 const cdp=await page.context().newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable');
 const {root}=await cdp.send('DOM.getDocument',{depth:1});const evidence={};
 for(const key of ['prose','heading','hans','hant','code']){const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector:`[data-font="${key}"]`});evidence[key]=(await cdp.send('CSS.getPlatformFontsForNode',{nodeId})).fonts;}
 driver.record('runtime-font-glyph-selection',evidence);
 for(const key of ['prose','heading','hans'])assert.ok(evidence[key].some(f=>f.familyName.includes('MiSans')&&f.isCustomFont&&f.glyphCount>0),'actual bundled MiSans glyphs: '+key);
 assert.ok(evidence.hant.some(f=>/MiSans.*TC|MiSansTC/i.test(f.familyName+' '+f.postScriptName)&&f.isCustomFont&&f.glyphCount>0),'actual Traditional Chinese variant glyphs');
 assert.ok(evidence.code.some(f=>f.glyphCount>0&&!f.familyName.includes('MiSans')),'code remains monospace');
 await page.evaluate(()=>document.querySelector('[data-presentation-font-probe]').remove());await cdp.detach();return evidence;
}
async function scan(chapter,viewport,baseline){
 await settle();await content().press('Meta+0');await settle();await content().press('Home');
 const total=Number(await content().getAttribute('data-pages')),pages=[],texts=[],math=[],codes=new Map(),rows=new Map(),headers=new Set(),saved=new Set(),tableFragments=new Map();
 for(let n=1;n<=total;n++){
  const state=await layout();assert.equal(state.page,n);
  if(state.allMath.length&&!fontEvidence.some(e=>e.chapter===chapter&&e.kind==='math')){
   await content().evaluate(root=>{const ink=root.querySelector('.katex-html'),walk=document.createTreeWalker(ink,NodeFilter.SHOW_TEXT);let t;while((t=walk.nextNode()))if(t.textContent.trim()){t.parentElement.dataset.actualMathFont='true';break;}});
   const cdp=await page.context().newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable');const {root}=await cdp.send('DOM.getDocument',{depth:1});const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector:'[data-actual-math-font]'});const usage=(await cdp.send('CSS.getPlatformFontsForNode',{nodeId})).fonts;assert.ok(usage.some(f=>f.familyName.startsWith('KaTeX')&&f.isCustomFont&&f.glyphCount>0),'actual KaTeX glyph selection');fontEvidence.push({chapter,kind:'math',usage});await cdp.detach();
  }assert.deepEqual(state.brokenWords,[],'no arbitrary prose-word splits in table cells');
  for(const table of state.tables){assert.ok(table.box.x>=state.left-2&&table.box.right<=state.right+2,'whole table within teaching canvas');assert.ok(table.scroll<=table.client+3,'no hidden table columns');for(const h of table.headers){assert.equal(h.wrap,'normal');assert.ok(h.box.right<=state.right+2);}const list=rows.get(table.line)??[];list.push(...table.rows.map(r=>normalize(r.text)));rows.set(table.line,list);const fragments=tableFragments.get(table.line)??[];fragments.push({...table,page:n});tableFragments.set(table.line,fragments);for(const code of table.codes)assert.ok(/monospace|Menlo|Courier|Consolas/.test(code.family),'table code font preserved');}
  for(const eq of state.math){assert.ok(eq.ink.left>=state.left-2&&eq.ink.right<=state.right+2,'all equation terms within teaching canvas');assert.ok(eq.font>=19.99,'default fitted display math stays legible');assert.ok(eq.scale<=1,'local equation fitting never enlarges type');}
  const reading=await page.evaluate(({html,seen})=>{const copy=document.createElement('article');copy.innerHTML=html;for(const table of copy.querySelectorAll('table'))if(seen.includes(table.dataset.sourceLine))table.querySelector('thead')?.remove();for(const node of copy.querySelectorAll('[data-math-source]'))node.textContent=node.dataset.mathSource;copy.querySelectorAll('button,[hidden],dialog:not([open])').forEach(n=>n.remove());return {text:copy.textContent.replace(/\s/g,''),math:[...copy.querySelectorAll('[data-math-source]')].map(n=>n.dataset.mathSource),code:[...copy.querySelectorAll('pre')].map(n=>({line:n.dataset.sourceLine,text:n.textContent}))};},{html:state.html,seen:[...headers]});
  texts.push(reading.text);math.push(...reading.math);for(const code of reading.code)codes.set(code.line,(codes.get(code.line)??'')+code.text);state.tables.forEach(t=>headers.add(t.line));
  const supported=viewport==='fullscreen'?(captures[chapter]??[]).map((value,index)=>state.allMath.some(source=>source.includes(value))?index:null).filter(n=>n!==null):[];
  if(state.tables.length||state.math.some(e=>e.scale<1)||supported.length){
   const key=state.tables.map(t=>'table-'+t.line).concat(state.math.filter(e=>e.scale<1).map(e=>'math-'+e.line),supported.map(n=>'supported-math-'+n)).join('-');
   if(!saved.has(key)){await driver.screenshot(`chapter${chapter}-${viewport}-page${n}-${key}`);saved.add(key);}
  }
  pages.push({...state,html:undefined});
  if(n<total){await content().press('ArrowRight');await until(()=>content().getAttribute('data-page').then(i=>Number(i)===n+1));}
 }
 assert.equal(sha(texts.join('')),sha(baseline.text),'complete chapter text and math source retained in order');assert.deepEqual(math,baseline.math,'every math payload retained exactly once, excluding repeated headers');
 for(const expected of baseline.tables){
  assert.deepEqual(rows.get(expected.line),expected.rows,'each complete table row exactly once and in order');
  const fragments=tableFragments.get(expected.line),first=fragments[0];
  for(const part of fragments)assert.deepEqual(part.headers.map(h=>Math.round(h.box.width)),first.headers.map(h=>Math.round(h.box.width)),'continued column widths stable');
  const fit=await page.evaluate(({fragments})=>{const holder=document.createElement('div');holder.className='document-presentation-probe';document.querySelector('.document-presentation-measure').append(holder);holder.innerHTML=fragments[0].html;const table=holder.querySelector('table');table.querySelector('tbody').innerHTML=fragments.flatMap(f=>f.rows.map(r=>r.html)).join('');const full=table.getBoundingClientRect().height,available=holder.parentElement.clientHeight,top=parseFloat(getComputedStyle(document.querySelector('.document-presentation-content')).paddingTop);const first=fragments[0];const budget=available-(first.prefixOnlyHeadings?Math.max(0,first.box.y-top):0);const underfilled=[];for(let i=0;i<fragments.length-1;i++){holder.innerHTML=fragments[i].html;holder.querySelector('tbody').insertAdjacentHTML('beforeend',fragments[i+1].rows[0].html);const combined=holder.querySelector('table').getBoundingClientRect().height;if(combined<=innerHeight-top-24-fragments[i].box.y+1)underfilled.push(fragments[i].page);}holder.remove();return {full,budget,underfilled};},{fragments});
  if(fit.full<=fit.budget+1)assert.equal(fragments.length,1,'retry complete table on a fresh page before splitting');assert.deepEqual(fit.underfilled,[],'continued pages use available height before moving the next complete row');
 }
 for(const code of baseline.code)assert.equal(codes.get(code.line),code.text,'complete code and indentation retained');
 results.push({chapter,viewport,total,pages});return {total,pages};
}
async function keyboard(total){
 await content().press('Home');await content().press('PageDown');assert.equal(Number(await content().getAttribute('data-page')),2);await content().press('PageUp');assert.equal(Number(await content().getAttribute('data-page')),1);await content().press('End');assert.equal(Number(await content().getAttribute('data-page')),total);await content().press('Home');
 for(let n=1;n<Math.floor(total/2);n++)await content().press('ArrowRight');const at=await content().evaluate(n=>({line:Number(n.querySelector('[data-source-line]')?.dataset.sourceLine),page:n.dataset.page}));
 await content().press('?');await button('Next page').focus();const original=await content().evaluate(n=>parseFloat(getComputedStyle(n).fontSize));
 for(const modifier of ['Meta','Control']){
  await page.keyboard.press(modifier+'+-');await until(()=>content().evaluate(n=>parseFloat(getComputedStyle(n).fontSize)).then(n=>Math.abs(n-(original-2))<.1));await page.keyboard.press(modifier+'+0');await settle();assert.ok(Math.abs(await content().evaluate(n=>parseFloat(getComputedStyle(n).fontSize))-original)<.1);
  await page.keyboard.press(modifier+'+=');await until(()=>content().evaluate(n=>parseFloat(getComputedStyle(n).fontSize)).then(n=>Math.abs(n-(original+2))<.1));await page.keyboard.press(modifier+'+0');await settle();
 }
 assert.ok(await content().locator(`[data-source-line="${at.line}"]`).count()>0,'reset retains relevant source block');
 const now=Number(await content().getAttribute('data-page'));await button('Next page').click();await page.keyboard.press('ArrowLeft');assert.equal(Number(await content().getAttribute('data-page')),now,'arrows work with navigation focus');
 await button('Previous page').focus();await page.keyboard.press('Meta+-');await until(()=>content().evaluate(n=>parseFloat(getComputedStyle(n).fontSize)).then(n=>Math.abs(n-(original-2))<.1));await page.keyboard.press('Meta+0');await settle();
 const restored=Number(await content().getAttribute('data-page'));await page.keyboard.press('PageDown');assert.equal(Number(await content().getAttribute('data-page')),restored+1);await page.keyboard.press('PageUp');assert.equal(Number(await content().getAttribute('data-page')),restored);await page.keyboard.press('Home');assert.equal(Number(await content().getAttribute('data-page')),1);await button('Next page').focus();await page.keyboard.press('End');assert.equal(Number(await content().getAttribute('data-page')),total);await button('Previous page').focus();await page.keyboard.press('Home');assert.equal(Number(await content().getAttribute('data-page')),1);await button('Next page').click();await button('Previous page').click();assert.equal(Number(await content().getAttribute('data-page')),1);
 await page.keyboard.press('Escape');await content().press('Space');await content().press('Shift+Space');assert.equal(Number(await content().getAttribute('data-page')),1);await content().press('0');assert.ok(Math.abs(await content().evaluate(n=>parseFloat(getComputedStyle(n).fontSize))-original)<.1,'plain 0 has no advertised text-size action');
 await page.evaluate(()=>{const root=document.querySelector('.document-presentation');root.insertAdjacentHTML('beforeend','<input data-shortcut-input aria-label="Synthetic shortcut input"><div data-presentation-interactive><button data-shortcut-interactive>Interactive guard</button></div>');window.__presentKeys=[];window.__presentKeyListener=e=>window.__presentKeys.push({key:e.key,prevented:e.defaultPrevented});window.addEventListener('keydown',window.__presentKeyListener);});
 const sizeBefore=await page.locator('.document-presentation').evaluate(n=>n.style.getPropertyValue('--presentation-size'));
 for(const selector of ['[data-shortcut-input]','[data-shortcut-interactive]']){await page.locator(selector).focus();await page.keyboard.press('Meta+-');assert.equal(await page.locator('.document-presentation').evaluate(n=>n.style.getPropertyValue('--presentation-size')),sizeBefore);}
 const events=await page.evaluate(()=>{window.removeEventListener('keydown',window.__presentKeyListener);document.querySelector('[data-shortcut-input]').remove();document.querySelector('[data-shortcut-interactive]').parentElement.remove();return window.__presentKeys;});assert.ok(events.filter(e=>e.key==='-').every(e=>!e.prevented),'editable/interactive shortcuts yield');
 await driver.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>!w.getParentWindow()).webContents.setZoomFactor(1));await settle();await content().focus();await content().press('m');assert.equal(await content().getAttribute('data-page'),null);await content().press('m');assert.equal(await content().getAttribute('data-page'),null);await content().press('ArrowRight');await content().press('ArrowLeft');await content().press('m');assert.ok(Number(await content().getAttribute('data-pages'))>1);await content().press('?');assert.match(await page.locator('.document-presentation-controls').innerText(),/⌘\/Ctrl\+0: reset/);await page.keyboard.press('Escape');driver.record('navigation-sizing-reset-focus-guards-modes',{chapterPosition:at});
}
try{
 page=await driver.launch();live=true;await page.getByRole('heading',{name:'Workspace',exact:true}).first().waitFor();await driver.closeNormally();live=false;
 await fs.cp(fixture,repo,{recursive:true});await fs.rename(path.join(repo,'README.md'),path.join(repo,'TextbookIndex.md'));await fs.writeFile(path.join(repo,'README.md'),'# Isolated textbook review\n\n'+chapters.map(n=>`[Chapter ${n}](chapters/chapter${n}/README.md)`).join('\n\n'));
 page=await driver.launch();live=true;await button('README.md').first().click();
 for(const chapter of chapters){
  const source=await fs.readFile(path.join(fixture,`chapters/chapter${chapter}/README.md`),'utf8'),html=renderSourcePreview(source,`chapters/chapter${chapter}/README.md`,{technical:true,sourceMap:true}).html;
  const baseline=await page.evaluate(html=>{const root=document.createElement('article');root.innerHTML=html;const tables=[...root.querySelectorAll('table')].map(t=>({line:t.dataset.sourceLine,rows:[...t.querySelectorAll('tbody tr')].map(r=>r.textContent.replace(/\s/g,''))})),math=[...root.querySelectorAll('[data-math-source]')].map(n=>n.dataset.mathSource);root.querySelectorAll('[data-math-source]').forEach(n=>n.textContent=n.dataset.mathSource);root.querySelectorAll('button').forEach(n=>n.remove());return {text:root.textContent.replace(/\s/g,''),math,tables,code:[...root.querySelectorAll('pre')].map(n=>({line:n.dataset.sourceLine,text:n.textContent}))};},html);
  await page.getByRole('link',{name:'Chapter '+chapter,exact:true}).click();await button('Present').click();await content().waitFor({timeout:30000});await until(()=>driver.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>!w.getParentWindow()).isFullScreen()),{label:'native fullscreen'});
  fontEvidence.push({chapter,...await fonts()});
  for(const viewport of ['fullscreen',[1920,1000],[1280,800],[1024,700],[1024,1000]]){
   const win=()=>driver.app.evaluate(({BrowserWindow})=>({full:BrowserWindow.getAllWindows().find(w=>!w.getParentWindow()).isFullScreen()}));
   if(viewport!=='fullscreen'){if((await win()).full)await driver.app.evaluate(async({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>!w.getParentWindow());await new Promise(resolve=>{w.once('leave-full-screen',resolve);w.setFullScreen(false);});});await driver.app.evaluate(({BrowserWindow},s)=>BrowserWindow.getAllWindows().find(w=>!w.getParentWindow()).setContentSize(...s),viewport);await until(()=>page.evaluate(s=>innerWidth===s[0]&&innerHeight===s[1],viewport),{label:'actual requested native dimensions'});}
   const measured=await scan(chapter,typeof viewport==='string'?viewport:viewport.join('x'),baseline);if(viewport==='fullscreen')await keyboard(measured.total);
  }
  await content().press('Escape');await content().waitFor({state:'detached'});await button('Workspace').first().click();await button('README.md').first().click();
 }
 await driver.closeNormally();live=false;assert.deepEqual(driver.errors,[]);assert.deepEqual(driver.consoleErrors,[]);
}catch(e){failure=e;console.error(e);await driver.screenshot('failure').catch(()=>{});await fs.writeFile(path.join(output,'failure-ui.txt'),await page?.locator('body').innerText().catch(()=>''));}
finally{if(live)await driver.closeNormally().catch(()=>{});await fs.writeFile(path.join(output,'measurements.json'),JSON.stringify({results,fontEvidence},null,2));await driver.report({passed:!failure,failure:failure?.stack??null,scope:'Complete isolated chapters: automated text/math/table/code/order/geometry at actual native dimensions; selected screenshots and keyboard/font glyph checks. Not an exhaustive human visual or projector review.'});}
console.log(output);if(failure)process.exitCode=1;
