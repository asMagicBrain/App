import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
/** Actual packaged clone lifecycle. Network timing is controlled only by the
 * acceptance driver through the debugger; the signed bundle is not modified. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const appRoot=fileURLToPath(new URL('../../../',import.meta.url)),testRoot=developmentTestRoot,runRoot=path.join(testRoot,'runs/native-github-clone-20260917/host');
const executable=process.env.ASMB_PACKAGED_EXECUTABLE;
assert.deepEqual(process.argv.slice(2),['--run-isolated']);assert.ok(executable&&path.isAbsolute(executable)&&executable.includes('.app/Contents/MacOS/')&&(executable.startsWith(appRoot+'releases/')||executable.startsWith(testRoot+'/runs/')));
const bundle=executable.slice(0,executable.indexOf('.app/Contents/MacOS/')+4),metadata=JSON.parse(await fs.readFile(bundle+'/Contents/Resources/app/native-package.json','utf8'));
import {_electron,chromium} from '../../../tools/playwright.mjs';
await fs.mkdir(runRoot,{recursive:true});const output=await fs.mkdtemp(runRoot+'/lifecycle-'),data=output+'/data',tmp=output+'/tmp';await fs.mkdir(tmp);
const events=[],errors=[];let application,page,failure,reconnected;
const record=(name,details={})=>{events.push({name,at:new Date().toISOString(),...details});console.log(name);};
const button=name=>page.getByRole('button',{name,exact:true});
const readme=data+'/workspaces/asMagicBrain/Workspace/README.md',marker='\nRetained clone lifecycle draft Ω.\n';
async function until(check,label,timeout=20000){const end=Date.now()+timeout;let result;do{try{result=await check();if(result)return result;}catch(error){result=error.message;}await new Promise(resolve=>setTimeout(resolve,60));}while(Date.now()<end);throw Error(`Timeout ${label}: ${result}`);}
async function launch(){application=await _electron.launch({executablePath:executable,args:['--test-data-root='+data],cwd:output,env:{PATH:process.env.PATH,TMPDIR:tmp}});page=await application.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));await button(/^Switch local repository:/).waitFor();const runtime=await application.evaluate(({app})=>({packaged:app.isPackaged,executable:process.execPath,profile:app.getPath('userData')}));assert.equal(runtime.packaged,true);assert.equal(runtime.executable,executable);assert.equal(runtime.profile,data+'-electron-profile');record('actual-packaged-launch',{runtime});}
async function instrument(){
 await application.evaluate(async({app,dialog})=>{
  const cp=process.getBuiltinModule('node:child_process'),mod=process.getBuiltinModule('node:module'),original=cp.spawn;
  const ownedGit=process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:fs').realpathSync(app.getAppPath()),'apps/native/dist-host/git/bin/git');
  // Exact current bundle path plus the explicit legacy-release executable.
  const isGit=file=>file===ownedGit||file==='/usr/bin/git';
  globalThis.__cloneLifecycle={mode:'fail',calls:[],dialogs:[]};
  cp.spawn=(file,args,options)=>{
   if(!isGit(file)||!Array.isArray(args)||!args.includes('clone'))return original(file,args,options);
   const mode=globalThis.__cloneLifecycle.mode,child=original(mode==='sleep'?'/bin/sleep':'/usr/bin/false',mode==='sleep'?['30']:[],options),entry={mode,pid:child.pid,closed:false};
   globalThis.__cloneLifecycle.calls.push(entry);child.once('close',(code,signal)=>Object.assign(entry,{closed:true,code,signal}));return child;
  };mod.syncBuiltinESMExports();
  const show=dialog.showMessageBox.bind(dialog);dialog.showMessageBox=async(...args)=>{const options=args.at(-1);if(options.title==='The editor stopped'){globalThis.__cloneLifecycle.dialogs.push({title:options.title,detail:options.detail});return {response:0,checkboxChecked:false};}return show(...args);};
 });
 record('acceptance-only-controlled-network-child',{scope:'Main-process debugger replaces only Git clone spawn with a sleeping/failing child. Production code and bundle are unchanged; UI, preload, coordinator, staging and cancellation remain real. Renderer recovery dialog chooses Reopen editor at presentation boundary.'});
}
async function mode(value){await application.evaluate((_,value)=>{globalThis.__cloneLifecycle.mode=value;},value);}
async function catalog(){const response=await page.evaluate(()=>window.asMagicBrain.catalog());assert.equal(response.ok,true);return response.value.repositories.map(item=>item.name);}
async function noPublished(){assert.deepEqual(await catalog(),['Workspace']);assert.deepEqual((await fs.readdir(data+'/workspaces/asMagicBrain')).filter(name=>name.startsWith('.asmb-import-')),[]);}
async function importDialog(){await button('Create new options').click();await button('Import repository').click();await until(async()=>await page.locator('.zi-dialog').isVisible()||await button('Leave editor').isVisible(),'import dialog or leave confirmation');if(await button('Leave editor').isVisible())await button('Leave editor').click();await page.locator('.zi-dialog').waitFor();await button('Clone from GitHub').click();await page.getByLabel('GitHub repository URL').fill('https://github.com/ancorasir/asTeach-App');}
async function startClone(name){await page.getByLabel('Repository name',{exact:true}).fill(name);const count=await application.evaluate(()=>globalThis.__cloneLifecycle.calls.length);await button('Clone repository').click();await until(()=>application.evaluate((_,count)=>globalThis.__cloneLifecycle.calls.length>count,count),'controlled clone child started');return await application.evaluate(()=>globalThis.__cloneLifecycle.calls.at(-1));}
async function openReadme(){await button(/^Switch local repository:/).click();await page.locator('.rh-list').getByRole('button',{name:/\bWorkspace\b/}).click();if(await button('Leave editor').isVisible())await button('Leave editor').click();await button('README.md').first().click();await until(async()=>await button('Edit this file').isVisible()||await page.locator('.cm-content[contenteditable=true]').isVisible(),'README view');}
async function close(){const start=Date.now(),closed=application.waitForEvent('close',{timeout:15000});await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close()).catch(error=>{if(!/closed|destroyed/i.test(String(error)))throw error;});await closed;application=null;record('normal-native-close',{milliseconds:Date.now()-start});}
const exited=pid=>{try{process.kill(pid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}};
try{
 await launch();await instrument();const initial=await fs.readFile(readme);
 await openReadme();await button('Edit this file').click();const editor=page.locator('.cm-content[contenteditable=true]');await editor.click();await editor.press('Meta+ArrowDown');await page.keyboard.insertText(marker);await importDialog();
 await startClone('Failure-QA');await page.locator('.zi-dialog [role=alert]').waitFor();assert.equal(await button('Clone repository').isEnabled(),true);await noPublished();await page.screenshot({path:output+'/clone-failure.png'});record('failed-acquisition-restores-form-and-preserves-catalog',{message:await page.locator('.zi-dialog [role=alert]').innerText()});
 await mode('sleep');const cancelled=await startClone('Cancelled-QA');await button('Cancel clone').click();await until(()=>page.locator('.zi-progress').innerText().then(text=>text==='Cloning cancelled.'),'cancel result');assert.equal(await button('Clone repository').isEnabled(),true);await noPublished();assert.equal(exited(cancelled.pid),true);await page.screenshot({path:output+'/clone-cancelled.png'});record('cancel-button-drains-child-and-removes-only-owned-stage',{pid:cancelled.pid});
 const closing=await startClone('Closing-QA');await close();assert.equal(exited(closing.pid),true);assert.deepEqual(await fs.readFile(readme),initial);assert.equal((await fs.readdir(data+'/workspaces/asMagicBrain')).includes('Closing-QA'),false);record('native-close-cancels-download-before-draft-drain',{pid:closing.pid});
 await launch();await instrument();await noPublished();await openReadme();if(await button('Edit this file').isVisible())await button('Edit this file').click();await until(()=>page.locator('.cm-content[contenteditable=true]').innerText().then(text=>text.includes(marker.trim())),'draft restored after close');assert.deepEqual(await fs.readFile(readme),initial);record('restart-restores-draft-with-saved-bytes-unchanged');
 await importDialog();await mode('sleep');const crashing=await startClone('Crashing-QA'),started=Date.now(),oldRenderer=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getOSProcessId());
 await application.evaluate(({BrowserWindow})=>{setTimeout(()=>BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),0);});
 await until(()=>application.evaluate(()=>globalThis.__cloneLifecycle.dialogs.length===1),'renderer recovery dialog after cancelled clone',10000);
 await until(()=>application.evaluate(({BrowserWindow},oldRenderer)=>{const wc=BrowserWindow.getAllWindows()[0].webContents;return !wc.isLoading()&&wc.getOSProcessId()>0&&wc.getOSProcessId()!==oldRenderer;},oldRenderer),'new renderer finished loading');
 const port=(await fs.readFile(data+'-electron-profile/session/DevToolsActivePort','utf8')).split('\n')[0];reconnected=await chromium.connectOverCDP('http://127.0.0.1:'+port);page=reconnected.contexts()[0].pages().find(item=>item.url()==='app://asmagicbrain/index.html');assert.ok(page);page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));
 await button(/^Switch local repository:/).waitFor();assert.equal(exited(crashing.pid),true);await noPublished();record('renderer-crash-cancels-download-and-reopens-editor',{milliseconds:Date.now()-started,pid:crashing.pid,dialogs:await application.evaluate(()=>globalThis.__cloneLifecycle.dialogs)});
 await openReadme();if(await button('Edit this file').isVisible())await button('Edit this file').click();await until(()=>page.locator('.cm-content[contenteditable=true]').innerText().then(text=>text.includes(marker.trim())),'acknowledged draft recovered after renderer crash');assert.deepEqual(await fs.readFile(readme),initial);record('renderer-recovery-preserves-acknowledged-draft');
 await importDialog();await mode('fail');await startClone('Resumed-QA');await page.locator('.zi-dialog [role=alert]').waitFor();await noPublished();record('clone-coordinator-resumes-after-renderer-recovery');await button('Cancel').click();await close();assert.deepEqual(errors,[]);
}catch(error){failure=error;record('failure',{message:error.message,stack:error.stack});if(page)await page.screenshot({path:output+'/failure.png'}).catch(()=>{});}
finally{if(application)await application.close().catch(()=>{});if(reconnected)await reconnected.close().catch(()=>{});await fs.writeFile(output+'/receipt.json',JSON.stringify({passed:!failure,metadata,executable,data,events,errors,qualification:'Actual packaged UI/preload/main/host lifecycle with deterministic acceptance-only network subprocess replacement. Public GitHub acquisition is tested separately. No credentials, remote writes, production backdoor, source changes or live profile used.'},null,2)+'\n');console.log(output);}
if(failure)throw failure;
