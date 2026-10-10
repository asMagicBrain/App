import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createDriver,nativeTarget,testRoot,until} from './native-driver.mjs';

// Read-only copies of selected lessons and their image dependencies. No course writes.
const source=process.env.ASMB_PRESENT_LESSONS_ROOT;
assert.ok(source,'Set ASMB_PRESENT_LESSONS_ROOT to the classes directory');
const output=await fs.mkdtemp(path.join(testRoot,'presentation-teaching-'));
const data=path.join(output,'data'),repo=path.join(data,process.env.ASMB_PRESENT_PREVIEW==='1'?'asMagicBrain':'','workspaces/asMagicBrain/Workspace');
const target=nativeTarget(data);
if(process.env.ASMB_PRESENT_PREVIEW==='1')target.args=[`--test-root=${output}`,`--test-user-home=${data}`];
const driver=await createDriver({...target,output,workspacePath:repo});
let page,running=false,failure;const originals=[],evidence=[];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
 page=await driver.launch();running=true;await page.getByRole('heading',{name:'Workspace',exact:true}).first().waitFor();await driver.closeNormally();running=false;
 for(const id of ['class02','class03','class04']){
  const lesson=path.join(source,id,'lesson.md'),bytes=await fs.readFile(lesson),text=bytes.toString('utf8');originals.push({lesson,sha256:digest(bytes)});
  const destination=path.join(repo,id);await fs.mkdir(destination,{recursive:true});await fs.writeFile(path.join(destination,'lesson.md'),bytes);
  for(const match of text.matchAll(/!\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)){
   const relative=decodeURIComponent(match[1]);if(/^[a-z]+:/i.test(relative))continue;
   const from=path.resolve(source,id,relative),to=path.resolve(destination,relative);
   assert.ok(from.startsWith(path.resolve(source)+path.sep));assert.ok(to.startsWith(repo+path.sep));
   await fs.mkdir(path.dirname(to),{recursive:true});await fs.copyFile(from,to);
  }
 }
 await fs.writeFile(path.join(repo,'README.md'),'# Teaching acceptance\n\n'+['class02','class03','class04'].map(id=>`[${id}](${id}/lesson.md)`).join('\n\n'));
 page=await driver.launch();running=true;page.setDefaultTimeout(60000);
 const open=async id=>{if(!await page.getByRole('button',{name:'README.md',exact:true}).count())await page.getByRole('button',{name:'Workspace',exact:true}).first().click();await page.getByRole('button',{name:'README.md',exact:true}).first().click();await page.getByRole('link',{name:id,exact:true}).click();await page.getByRole('button',{name:'Present',exact:true}).click();await page.locator('.document-presentation-content article').waitFor();};
 for(const id of ['class02','class03','class04']){
  await open(id);assert.equal(await driver.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>!w.getParentWindow()).webContents.getBackgroundThrottling()),false,'presentation rendering stays active across focus changes');const content=page.locator('.document-presentation-content');
  await driver.app.evaluate(async ({BrowserWindow,app})=>{const w=BrowserWindow.getAllWindows().find(w=>!w.getParentWindow());app.focus({steal:true});w.focus();if(w.isFullScreen())await new Promise(resolve=>{w.once('leave-full-screen',resolve);w.setFullScreen(false);});});
  await until(()=>driver.app.evaluate(({BrowserWindow})=>!BrowserWindow.getAllWindows().find(w=>!w.getParentWindow()).isFullScreen()),{timeout:15000,label:'native fullscreen exit before resize'});
  for(const [width,height] of [[1280,800],[1920,1080]]){
   await driver.app.evaluate(({BrowserWindow},{width,height})=>{BrowserWindow.getAllWindows().find(w=>!w.getParentWindow()).setContentSize(width,height);},{width,height});
   await new Promise(resolve=>setTimeout(resolve,750));const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));const windowState=await driver.app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>!w.getParentWindow());return {bounds:w.getBounds(),content:w.getContentBounds(),fullscreen:w.isFullScreen(),zoom:w.webContents.getZoomFactor()};});console.log(JSON.stringify({requested:{width,height},viewport,windowState}));assert.ok(Math.abs(viewport.width-width)<10,'requested native viewport settled');
   await content.press('Home');await content.press('?');await page.getByRole('button',{name:'Next page',exact:true}).click();
   const second=Number(await content.getAttribute('data-page'));await page.keyboard.press('ArrowRight');
   await until(async()=>Number(await content.getAttribute('data-page'))===second+1,{label:'focused control keyboard navigation'});
   await content.press('Escape');await content.press('Home');
   const total=Number(await content.getAttribute('data-pages'));let figures=0,tables=0,math=0,code=0;
   for(let index=1;index<=total;index++){
    await until(async()=>Number(await content.getAttribute('data-page'))===index,{label:'page counter and committed content'});
    if(await content.locator('[data-local-image]').count())await until(async()=>await content.locator('[data-local-image]').count()===0,{timeout:15000,label:'admitted lesson image loaded'});if(await content.locator('img').count())await until(()=>content.locator('img').evaluateAll(nodes=>nodes.every(n=>n.complete&&n.naturalWidth>0)),{timeout:15000,label:'decoded landscape figures'});
    const state=await content.evaluate(node=>({label:node.getAttribute('aria-label'),page:Number(node.dataset.page),pages:Number(node.dataset.pages),width:node.clientWidth,scrollWidth:node.scrollWidth,text:node.innerText,prose:[...node.querySelectorAll('article > p')].map(p=>({width:p.getBoundingClientRect().width,scroll:p.scrollWidth,client:p.clientWidth})),images:[...node.querySelectorAll('img')].map(img=>({complete:img.complete,w:img.getBoundingClientRect().width,h:img.getBoundingClientRect().height,nw:img.naturalWidth,nh:img.naturalHeight})),tables:node.querySelectorAll('table').length,math:node.querySelectorAll('.preview-math').length,code:node.querySelectorAll('pre').length,codeBoxes:[...node.querySelectorAll('pre')].map(n=>({left:n.getBoundingClientRect().left,width:n.getBoundingClientRect().width,font:getComputedStyle(n).fontSize})),proseBoxes:[...node.querySelectorAll('article > p:not(:has(img)):not(:has(.preview-math))')].map(n=>({left:n.getBoundingClientRect().left,width:n.getBoundingClientRect().width}))}));
    assert.equal(state.label,`Page ${index} of ${state.pages}`);assert.ok(state.text.trim(),'visible page has content');assert.ok(state.scrollWidth<=state.width+2,'no horizontal page clipping');
    for(const p of state.prose)assert.ok(p.scroll<=p.client+2,'prose wraps without clipping');
    for(const img of state.images){assert.ok(img.complete&&img.nw>0);assert.ok(Math.abs(img.w/img.h-img.nw/img.nh)<0.02,'figure aspect ratio preserved');}
    for(const box of state.codeBoxes){assert.ok(box.width<state.width,'code is bounded to the reading column');if(state.proseBoxes.length)assert.ok(Math.abs(box.left-state.proseBoxes[0].left)<3,'code and prose align');}figures+=state.images.length;tables+=state.tables;math+=state.math;code+=state.code;
    if(index===1||state.images.length&&figures<=2||state.tables&&tables===1||state.math&&math===1||state.code&&code===1){await driver.screenshot(`${id}-${width}-page-${index}`);evidence.push({id,width,height,page:index,total:state.pages,text:state.text.slice(0,180)});}
    if(index<total)await content.press('ArrowRight');
   }
   const last=Number(await content.getAttribute('data-page'));await content.press('ArrowRight');assert.equal(Number(await content.getAttribute('data-page')),last);
   await content.press('Home');await content.press('ArrowLeft');assert.equal(Number(await content.getAttribute('data-page')),1);
   driver.record('teaching-lesson-responsive-pages',{id,width,height,total,figures,tables,math,code});
  }
  await content.press('Escape');await page.getByRole('dialog',{name:'Document presentation'}).waitFor({state:'detached'});
  await until(()=>driver.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>!w.getParentWindow()).webContents.getBackgroundThrottling()),{timeout:15000,label:'normal rendering policy restored after exit'});assert.ok((await page.locator('.rc-document article,.rfe-preview article').first().innerText()).length>500,'detailed Preview remains available');
 }
 for(const item of originals)assert.equal(digest(await fs.readFile(item.lesson)),item.sha256,'original lesson preserved');
 await fs.writeFile(path.join(output,'teaching-evidence.json'),JSON.stringify({originals,evidence},null,2));
 assert.deepEqual(driver.errors,[]);await driver.closeNormally();running=false;
}catch(error){failure=error;if(page)await fs.writeFile(path.join(output,'failure-ui.txt'),await page.locator('body').innerText().catch(()=>''));}
finally{if(running)await driver.closeNormally().catch(()=>{});await driver.report({passed:!failure,failure:failure?.stack,scope:'Read-only copies of three real lessons; native viewport, keyboard/control focus, boundaries, wrapping, technical blocks, screenshots and original byte preservation.'});}
console.log(JSON.stringify({passed:!failure,output}));if(failure)throw failure;
