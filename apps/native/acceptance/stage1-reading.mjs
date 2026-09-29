/** Stage 1 actual-package interaction diagnostics. Synthetic data only.
 * Pointer/keyboard actions use Playwright's actual Electron renderer input.
 * Main and renderer listeners observe state only; no product callbacks are replaced.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {testRoot as testBase} from '../../../tools/development-paths.mjs';
assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
assert.ok(process.env.ASMB_PACKAGED_EXECUTABLE, 'Bind to an exact package executable.');
process.env.ASMB_ACCEPTANCE_RUN_ROOT ??= path.join(testBase, 'runs/stage1-reading-20260922/qa');
const {createDriver, nativeTarget, testRoot: runRoot, until, sha} = await import('./native-driver.mjs');
await fs.mkdir(runRoot, {recursive:true});
const output = await fs.mkdtemp(path.join(runRoot, 'ab007-'));
const executable = process.env.ASMB_PACKAGED_EXECUTABLE;
const bundle = executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
const metadata = JSON.parse(await fs.readFile(path.join(bundle, 'Contents/Resources/app/native-package.json')));
const home = path.join(output, 'home');
const data = metadata.channel === 'preview' ? path.join(home, 'asMagicBrain') : path.join(output, 'data');
const organization = path.join(data, 'workspaces/asMagicBrain');
const target = metadata.channel === 'preview' ? {executablePath:executable,args:['--test-root='+testBase,'--test-user-home='+home]} : nativeTarget(data);
const driver = await createDriver({...target,output,workspacePath:path.join(organization,'Workspace')});
await fs.copyFile(new URL(import.meta.url), path.join(output,'driver-at-launch.mjs'));
const fixtures = path.join(output,'fixtures'); await fs.mkdir(fixtures);
const content = '# AB-007 synthetic repository\n\nFocus, menu, cancel, import, and navigation. Ω\n';
await fs.writeFile(path.join(fixtures,'README.md'),content);
for(let index=0;index<96;index++)await fs.writeFile(path.join(fixtures,`note-${index}.md`),`# Note ${index}\n\n`+'Synthetic archive content. Ω\n'.repeat(700));
const smallZip=path.join(output,'small.zip'), moderateZip=path.join(output,'moderate.zip');
execFileSync('/usr/bin/zip',['-q',smallZip,'README.md'],{cwd:fixtures});
execFileSync('/usr/bin/zip',['-q',moderateZip,...await fs.readdir(fixtures)],{cwd:fixtures});
const invalidZip=path.join(output,'invalid.zip');await fs.writeFile(invalidZip,'synthetic invalid archive; no executable content\n');
let page,running=false,failure;const cycles=[], imports=[],nativeRuns=[],network=[],failures=[];
const button=name=>page.getByRole('button',{name,exact:true});
const record=(event,detail={})=>{driver.record(event,detail);console.log(JSON.stringify({event,...(detail.cycle ? {cycle:detail.cycle,kind:detail.kind,status:detail.status} : {})}));};
async function nativeState(){return driver.app.evaluate(({app,BrowserWindow})=>({hidden:app.isHidden(),windows:BrowserWindow.getAllWindows().map(w=>({id:w.id,focused:w.isFocused(),visible:w.isVisible(),minimized:w.isMinimized(),bounds:w.getBounds(),url:w.webContents.getURL()}))}));}
async function frame(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function capture(label){await fs.writeFile(path.join(output,label+'-aria.yml'),await page.locator('body').ariaSnapshot());await driver.screenshot(label);return {native:await nativeState(),renderer:await page.evaluate(()=>({focused:document.hasFocus(),active:document.activeElement?.outerHTML?.slice(0,600),menu:!!document.querySelector('.ra-menu-create'),dialogs:[...document.querySelectorAll('dialog[open]')].map(n=>n.innerText),statuses:[...document.querySelectorAll('[role=status],[role=alert]')].map(n=>({role:n.getAttribute('role'),text:n.textContent})),observations:window.__ab007}))};}
async function launch(){
 page=await driver.launch();running=true;await page.context().setOffline(true);page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});
 await button('asMagicBrain organization').waitFor();await page.locator('.rc-document').waitFor();
 await driver.app.evaluate(({app,BrowserWindow})=>{
  globalThis.__ab007Native={events:[],exceptions:[],gone:[],created:[]};const s=globalThis.__ab007Native;
  process.on('uncaughtExceptionMonitor',error=>s.exceptions.push({at:Date.now(),message:error.message}));
  app.on('render-process-gone',(_e,w,d)=>s.gone.push({id:w.id,details:d}));app.on('browser-window-created',(_e,w)=>s.created.push(w.id));
  for(const w of BrowserWindow.getAllWindows())for(const type of ['focus','blur','show','hide','minimize','restore','unresponsive','responsive','close','closed'])w.on(type,()=>s.events.push({at:Date.now(),type,id:w.id}));
  const w=BrowserWindow.getAllWindows()[0];w.setContentSize(1280,850);w.show();w.focus();
 });
 await page.evaluate(()=>{
  const s=window.__ab007={events:[],states:[],frameCount:0};const observe=()=>{const state={at:Date.now(),menu:!!document.querySelector('.ra-menu-create'),dialog:!!document.querySelector('.zi-dialog[open]'),statuses:[...document.querySelectorAll('.zi-dialog [role=status],.zi-dialog [role=alert]')].map(n=>({role:n.getAttribute('role'),text:n.textContent})),submitDisabled:document.querySelector('.zi-primary')?.disabled};if(JSON.stringify({...state,at:0})!==JSON.stringify({...s.states.at(-1),at:0}))s.states.push(state);};
  new MutationObserver(observe).observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
  for(const type of ['pointerdown','pointerup','keydown','keyup','focusin','focusout'])document.addEventListener(type,e=>s.events.push({at:Date.now(),type,key:e.key,target:e.target?.getAttribute?.('aria-label')||e.target?.textContent?.slice(0,80),focused:document.hasFocus()}),true);
  function tick(){s.frameCount++;requestAnimationFrame(tick);}requestAnimationFrame(tick);observe();
 });
 await until(()=>page.evaluate(()=>document.hasFocus()),{label:'native focus'});record('launch-ready',{metadata,pid:driver.app.process().pid});
}
async function close(){nativeRuns.push(await driver.app.evaluate(()=>globalThis.__ab007Native));await driver.closeNormally();running=false;}
async function activate(locator,kind){if(kind==='keyboard'){await locator.focus();await locator.press('Enter');}else{const r=await locator.boundingBox();assert.ok(r);await page.mouse.click(r.x+r.width/2,r.y+r.height/2);}}
async function foreground(cycle){await driver.app.evaluate(({app})=>app.hide());await until(()=>nativeState().then(s=>s.hidden&&!s.windows.some(w=>w.focused)),{label:'native background'});const background=await nativeState();await driver.app.evaluate(({app,BrowserWindow})=>{app.show();const w=BrowserWindow.getAllWindows()[0];w.show();w.focus();});await until(()=>page.evaluate(()=>document.hasFocus()),{label:'native foreground'});record('background-foreground',{cycle,background,foreground:await nativeState()});}
async function openImport(kind){await activate(button('Create new options'),kind);await page.locator('.ra-menu-create').waitFor();assert.equal(await button('Create new options').getAttribute('aria-expanded'),'true');await activate(page.locator('.ra-menu-create').getByRole('button',{name:'Import repository',exact:true}),kind);await page.locator('.zi-dialog[open]').waitFor();await page.locator('.ra-menu-create').waitFor({state:'detached'});}
async function navigate(){await button('asMagicBrain organization').click();await page.locator('.ar-view').waitFor();await button('Open repository Workspace').click();await page.locator('.rc-document').waitFor();await page.getByRole('table',{name:'Directory contents'}).getByRole('button',{name:'README.md',exact:true}).click();await page.locator('.rfe-preview h1').waitFor();}
async function importFixture(name,zip){
 await openImport('mouse');await page.getByLabel('ZIP archive',{exact:true}).setInputFiles(zip);await page.getByLabel('Repository name',{exact:true}).fill(name);
 const started=Date.now();await page.locator('.zi-dialog').getByRole('button',{name:'Import repository',exact:true}).dblclick();
 await page.locator('.zi-dialog').waitFor({state:'detached',timeout:60000});await until(()=>fs.readFile(path.join(organization,name,'README.md'),'utf8').then(v=>v===content),{label:'imported exact bytes'});
 const states=await page.evaluate(()=>window.__ab007.states.filter(s=>s.at>=0));const progress=states.filter(s=>s.at>=started&&s.statuses.some(x=>x.role==='status'&&x.text.includes('Importing archive')));
 assert.ok(progress.length,'Import progress observed through accessible status');assert.ok(progress.every(s=>s.submitDisabled),'Submit remains disabled while importing');
 const directories=(await fs.readdir(organization)).filter(x=>x.startsWith(name));assert.deepEqual(directories,[name],'Double click created only one repository');
 const result={name,elapsedMs:Date.now()-started,progress,files:(await fs.readdir(path.join(organization,name))).length,sha256:sha(await fs.readFile(path.join(organization,name,'README.md'))),state:await capture(name+'-complete')};imports.push(result);record('import-completion-progress-and-no-duplicate',result);await navigate();
}
try{
 await launch();const baseline=await fs.readFile(path.join(organization,'Workspace/README.md'));await capture('baseline');
 for(let cycle=1;cycle<=10;cycle++){
  const kind=cycle%2?'mouse':'keyboard';const started=Date.now();try{
   if(cycle>=3)await foreground(cycle);const before=await nativeState();await openImport(kind);const opened=await capture(`cycle-${cycle}-open`);assert.equal(opened.native.windows.length,1);assert.ok(opened.renderer.dialogs.length===1);
   if(cycle%3===0)await page.keyboard.press('Escape');else await activate(page.locator('.zi-dialog').getByRole('button',{name:'Cancel',exact:true}),kind);
   await page.locator('.zi-dialog').waitFor({state:'detached'});await navigate();const after=await capture(`cycle-${cycle}-after`);assert.equal(after.renderer.dialogs.length,0);assert.equal(after.native.windows.length,1);assert.ok(after.renderer.observations.frameCount>opened.renderer.observations.frameCount);
   cycles.push({cycle,kind,status:'passed',elapsedMs:Date.now()-started,before,opened,after});record('menu-import-cancel-navigation-cycle',{cycle,kind,status:'passed'});
  }catch(error){const observation=await capture(`cycle-${cycle}-failure`).catch(e=>({captureError:e.message}));cycles.push({cycle,kind,status:'failed',message:error.message,observation});failures.push({cycle,message:error.message});record('menu-import-cancel-navigation-cycle',{cycle,kind,status:'failed',message:error.message});await page.keyboard.press('Escape').catch(()=>{});if(await page.locator('.zi-dialog').count())await button('Close import dialog').click().catch(()=>{});await navigate();}
 }
 await importFixture('AB007-Small',smallZip);await importFixture('AB007-Moderate',moderateZip);
 await openImport('keyboard');await page.getByLabel('ZIP archive',{exact:true}).setInputFiles(invalidZip);await page.getByLabel('Repository name',{exact:true}).fill('AB007-Invalid');await page.locator('.zi-dialog').getByRole('button',{name:'Import repository',exact:true}).click();await page.locator('.zi-dialog [role=alert]').waitFor();const invalid=await capture('invalid-archive-error');assert.ok(invalid.renderer.statuses.some(x=>x.role==='alert'&&x.text));assert.ok(!await fs.stat(path.join(organization,'AB007-Invalid')).catch(()=>null));record('accessible-import-error-no-repository',{invalid});await button('Close import dialog').click();
 assert.deepEqual(await fs.readFile(path.join(organization,'Workspace/README.md')),baseline);await close();await launch();await navigate();for(const name of ['AB007-Small','AB007-Moderate'])assert.equal(await fs.readFile(path.join(organization,name,'README.md'),'utf8'),content);assert.deepEqual(await fs.readFile(path.join(organization,'Workspace/README.md')),baseline);await capture('restart');await close();
 for(const s of nativeRuns){assert.deepEqual(s.exceptions,[]);assert.deepEqual(s.gone,[]);assert.equal(s.events.filter(x=>x.type==='unresponsive').length,0);}assert.equal(driver.errors.length,0);assert.deepEqual(failures,[]);
}catch(error){failure={message:error.message,stack:error.stack};console.error(error.stack);if(page&&!page.isClosed())await capture('failure').catch(()=>{});if(running)await close().catch(error=>{failure.close=error.message;});process.exitCode=1;}
finally{await driver.report({status:failure?'failed':'passed',failure,metadata,host:{platform:process.platform,arch:process.arch,release:os.release(),node:process.version},cycles,imports,nativeRuns,network,failures,scope:'AB007 exact package diagnostics: ten renderer pointer/keyboard menu/import/cancel/navigation cycles; eight native background/foreground cycles; two synthetic imports; invalid archive; close/restart. Renderer ARIA snapshots are not macOS accessibility-service snapshots. Programmatic file input selection does not qualify native OS chooser.'});console.log(JSON.stringify({status:failure?'failed':'passed',output}));}
