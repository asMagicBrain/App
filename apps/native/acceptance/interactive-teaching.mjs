import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createDriver,nativeTarget,testRoot,until,sha} from './native-driver.mjs';
import {createArtifactProbe} from './pro-editor-probe.mjs';
assert.deepEqual(process.argv.slice(2),['--run-isolated']);
const fixture=process.env.ASMB_TEACHING_FIXTURE;
assert.ok(fixture&&path.isAbsolute(fixture),'Set ASMB_TEACHING_FIXTURE to an isolated prepared repository.');
await fs.mkdir(testRoot,{recursive:true});
const output=await fs.mkdtemp(path.join(testRoot,'interactive-teaching-')),data=path.join(output,'data'),repo=path.join(data,'workspaces/asMagicBrain/Workspace');
const driver=await createDriver({...nativeTarget(data),output,workspacePath:repo});
const results=[];let page,probe,live=false,failure,artifact;
const button=name=>page.getByRole('button',{name,exact:true});
const widgetButton=name=>page.locator('.document-presentation-content').count().then(n=>n?page.locator('.document-presentation-content').getByRole('button',{name,exact:true}):button(name));
const status=()=>page.evaluate(async()=>{const r=await window.asMagicBrain.artifactStatus();if(r.ok===false)throw Error(r.error.code);return r.value??r;});
const begin=async()=>{
 await (await widgetButton('Open interactive example')).last().click();await (await widgetButton('Run interactive view')).last().click();
 const target=await until(async()=>(await probe.targets())[0],{label:'sandboxed inline target'});artifact=await probe.attach(target.targetId);
 await until(async()=>{const r=await status();return r.state==='running'&&!r.geometryPending?r:false;},{label:'inline running geometry'});
 await artifact.evaluate('document.fonts.ready');await new Promise(resolve=>setTimeout(resolve,500));await until(async()=>!(await status()).geometryPending,{label:'settled font and native geometry'});
 await driver.app.evaluate(({webContents})=>webContents.getAllWebContents().find(w=>w.getURL().startsWith('asmb-artifact:')).focus());
 assert.ok(await artifact.evaluate('[...document.fonts].some(f=>f.family==="MiSans"&&f.status==="loaded")'),'local MiSans actually loaded');
 assert.equal(await artifact.evaluate('typeof window.asMagicBrain'),'undefined');assert.equal(await artifact.evaluate('typeof require'),'undefined');
 return (await status()).runId;
};
async function exercise({className,panels,sliders,outputs},view){
 const run=await begin();const traces=[];const emulated=view.endsWith('wide-layout');if(emulated)await artifact.send('Emulation.setDeviceMetricsOverride',{width:5120,height:1440,deviceScaleFactor:1,mobile:false});
 for(let i=0;i<panels.length;i++){
  await artifact.click('#'+panels[i]);assert.equal(await artifact.evaluate(`document.querySelector('#${panels[i]}').getAttribute('aria-selected')`),'true');
  await artifact.click('#'+sliders[i]);assert.equal(await artifact.evaluate('document.activeElement.id'),sliders[i],'actual native slider focus');await artifact.key('Home','Home',36);
  const before=await artifact.evaluate(`document.querySelector('#${outputs[i]}').textContent`);
  await artifact.key('End','End',35);
  const after=await artifact.evaluate(`document.querySelector('#${outputs[i]}').textContent`);assert.notEqual(after,before,'live panel output changes');
  traces.push({panel:panels[i],before,after});
  await driver.screenshot(`${className}-${view}-${i+1}`);const shot=await artifact.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile(path.join(output,`${className}-${view}-${i+1}-widget.png`),Buffer.from(shot.data,'base64'));
 }
 if(emulated)await artifact.send('Emulation.clearDeviceMetricsOverride');
 const values=await artifact.evaluate('[...document.querySelectorAll("input")].map(n=>n.value)');
 await (await widgetButton('Expand example')).click();await until(async()=>! (await status()).geometryPending,{label:'expanded geometry'});
 assert.equal((await status()).runId,run);assert.deepEqual(await artifact.evaluate('[...document.querySelectorAll("input")].map(n=>n.value)'),values,'expansion retains controls');
 // Native widget input belongs to the widget, never the parent slide handler.
 const content=page.locator('.document-presentation-content'),present=await content.count(),position=present?await content.getAttribute('data-page'):null;
 await artifact.click('#'+sliders.at(-1));await artifact.key('ArrowLeft','ArrowLeft',37);await artifact.key(' ','Space',32);
 if(present)assert.equal(await content.getAttribute('data-page'),position);
 await driver.app.evaluate(({webContents})=>{const wc=webContents.getAllWebContents().find(w=>w.getURL().startsWith('asmb-artifact:'));wc.focus();wc.sendInputEvent({type:'keyDown',keyCode:'Escape'});wc.sendInputEvent({type:'keyUp',keyCode:'Escape'});});
 await until(()=>page.locator('.artifact-expanded').count().then(n=>n===0),{label:'Escape returned inline'});
 assert.equal((await status()).runId,run,'Escape keeps example state');
 if(present){await until(()=>content.evaluate(n=>document.activeElement===n),{label:'keyboard focus returns to lesson after native escape'});await page.keyboard.press('ArrowLeft');if(Number(position)>1)assert.equal(Number(await content.getAttribute('data-page')),Number(position)-1);}
 else await button('Close interactive view').last().click();
 await artifact.detach();artifact=null;
 if(present)await until(()=>probe.targets().then(t=>t.length===0),{label:'page transition releases widget'});
 results.push({className,view,panels:traces,run,focusAndExpansion:'passed'});
}
try{
 page=await driver.launch();live=true;await page.getByRole('heading',{name:'Workspace',exact:true}).first().waitFor();await driver.closeNormally();live=false;
 await fs.cp(fixture,repo,{recursive:true});
 page=await driver.launch();live=true;const displays=await driver.app.evaluate(({screen,BrowserWindow})=>{const displays=screen.getAllDisplays(),wide=displays.toSorted((a,b)=>b.bounds.width-a.bounds.width)[0],w=BrowserWindow.getAllWindows().find(w=>!w.getParentWindow());w.setPosition(wide.bounds.x+40,wide.bounds.y+40);return displays.map(d=>({id:d.id,bounds:d.bounds,workArea:d.workArea,scaleFactor:d.scaleFactor}));});driver.record('display-inventory',{displays});console.log(JSON.stringify({displays}));probe=await createArtifactProbe(page);await button('README.md').first().click();
 const classes=[{className:'class02',panels:['tab-effort','tab-phase','tab-sampling'],sliders:['e','f','s'],outputs:['effort-result','phase-result','sample-result']},{className:'class03',panels:['tab-placement','tab-axis','tab-frame'],sliders:['r1','tilt','angle'],outputs:['result-placement','result-axis','result-frame']},{className:'class04',panels:['tab-aggregation','tab-regression','tab-residual'],sliders:['n2','scale','amp'],outputs:['result-aggregation','result-regression','result-residual']}];
 for(const info of classes){
  if(info.className!=='class02'){await page.locator('a[data-local-link="../README.md"]').first().click();}
  await page.locator(`a[data-local-link="${info.className}/lesson.md"]`).first().click();
  await page.locator('[data-artifact]').waitFor();await button('Open interactive example').last().scrollIntoViewIfNeeded();await exercise(info,'Preview');
  await button('Present').click();const content=page.locator('.document-presentation-content');await content.waitFor();await until(()=>content.getAttribute('data-pages').then(n=>Number(n)>1),{label:'pages ready'});
  for(const [label,dimensions] of [['1280',[1280,800]],['1920',[1920,1080]],['wide-layout',[1920,1080]]]){
   await driver.app.evaluate(async({BrowserWindow},size)=>{const w=BrowserWindow.getAllWindows().find(w=>!w.getParentWindow());if(w.isFullScreen())await new Promise(resolve=>{w.once('leave-full-screen',resolve);w.setFullScreen(false);});if(size[0]===1920){await new Promise(resolve=>{w.once('enter-full-screen',resolve);w.setFullScreen(true);});}else{await new Promise(resolve=>setTimeout(resolve,750));w.setContentSize(...size);await new Promise(resolve=>setTimeout(resolve,500));if(w.getContentSize().some((v,i)=>v!==size[i])){const frame=w.getSize(),content=w.getContentSize();w.setSize(size[0]+frame[0]-content[0],size[1]+frame[1]-content[1]);}}w.show();w.focus();},dimensions);
   await new Promise(resolve=>setTimeout(resolve,750));const actual=await page.evaluate(()=>[innerWidth,innerHeight]);if(dimensions[0]!==1920&&actual.some((v,i)=>v!==dimensions[i]))await driver.app.evaluate(({BrowserWindow},{wanted,actual})=>{BrowserWindow.getAllWindows().find(w=>!w.getParentWindow()).setContentSize(wanted[0]+wanted[0]-actual[0],wanted[1]+wanted[1]-actual[1]);},{wanted:dimensions,actual});
   await until(()=>page.evaluate(size=>innerWidth===size[0]&&innerHeight===size[1],dimensions),{label:'test display geometry'});
   await new Promise(resolve=>setTimeout(resolve,750));await content.press('End');await until(async()=>{const at=await content.getAttribute('data-page'),total=await content.getAttribute('data-pages');return at===total&&await content.getByRole('button',{name:'Open interactive example',exact:true}).count()>0;},{label:'final interactive page after layout'});await exercise(info,'Present-'+label);
   // Native activation and actual DOM replacement must not require a mouse click.
   await driver.app.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});BrowserWindow.getAllWindows().find(w=>!w.getParentWindow()).focus();});
   await page.keyboard.press('ArrowLeft');const at=Number(await content.getAttribute('data-page'));await page.keyboard.press('ArrowRight');assert.equal(Number(await content.getAttribute('data-page')),at+1);
  }
  const at=await content.getAttribute('data-page');await content.press('Escape');await content.waitFor({state:'detached'});await button('Present').click();await content.waitFor();await until(()=>content.getAttribute('data-page').then(n=>n===at),{label:'exact re-entry reading position'});
  await content.press('Escape');await content.waitFor({state:'detached'});
 }
 await driver.closeNormally();live=false;await probe.dispose().catch(()=>{});probe=null;
 page=await driver.launch();live=true;probe=await createArtifactProbe(page);await button('README.md').first().click();await page.locator('a[data-local-link="class02/lesson.md"]').first().click();await button('Open interactive example').last().scrollIntoViewIfNeeded();const run=await begin();assert.ok(run);await button('Close interactive view').last().click();await artifact.detach();artifact=null;
 await driver.closeNormally();live=false;assert.deepEqual(driver.errors,[]);assert.deepEqual(driver.consoleErrors,[]);
}catch(error){failure=error;console.error(error);console.error(JSON.stringify(await status().catch(()=>null)));console.error(await page.evaluate(()=>({active:document.activeElement?.outerHTML.slice(0,300),expanded:!!document.querySelector('.artifact-expanded')})).catch(()=>null));await driver.screenshot('failure').catch(()=>{});}
finally{await artifact?.detach().catch(()=>{});await probe?.dispose().catch(()=>{});if(live)await driver.closeNormally().catch(()=>{});await fs.writeFile(path.join(output,'interactive-results.json'),JSON.stringify(results,null,2));await driver.report({passed:!failure,failure:failure?.stack??null,results,fixture,scope:'Actual native Preview and Present1280×800/1920×1080; three panels, fonts, state, keyboard, restart. Wide5120×1440 child-layout is emulated, not physical-display qualification. Numerical engines are not executed.'});}
console.log(output);if(failure)process.exitCode=1;
