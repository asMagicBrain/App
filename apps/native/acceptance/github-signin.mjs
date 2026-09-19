import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
/** Packaged account UI. Configured cases use bundled production services with an
 * explicitly synthetic host-only provider; no live GitHub account or consent. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const testRoot = developmentTestRoot;
const runRoot = path.resolve(process.env.ASMB_ACCEPTANCE_RUN_ROOT ?? testRoot + '/runs/native-signin-readiness-20260917/ui');
assert.ok(runRoot.startsWith(testRoot + '/runs/'), 'Acceptance output must remain inside Test/runs.');
const executable = process.env.ASMB_PACKAGED_EXECUTABLE;
assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
assert.ok(executable && path.isAbsolute(executable) && executable.includes('.app/Contents/MacOS/'));
assert.ok(executable.startsWith(appRoot + 'releases/') || executable.startsWith(testRoot + '/runs/native-package/'));
const bundle = executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
const resources = bundle + '/Contents/Resources/app';
const metadata = JSON.parse(await fs.readFile(resources + '/native-package.json', 'utf8'));
const {githubApp: packagedRegistration} = await import(pathToFileURL(resources + '/apps/native/github-config.mjs').href);
const {registrationSummary} = await import(pathToFileURL(resources + '/apps/native/github-registration.mjs').href);
const shippedRegistration = registrationSummary(packagedRegistration);
assert.deepEqual(metadata.githubRegistration, shippedRegistration, 'Package metadata must match its bundled public registration.');
const definition = await fs.readFile(fileURLToPath(import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
import {_electron} from '../../../tools/playwright.mjs';
await fs.mkdir(runRoot, {recursive: true});
const output = await fs.mkdtemp(runRoot + '/acceptance-'), data = output + '/data', tmp = output + '/tmp';
await fs.mkdir(tmp); await fs.writeFile(output + '/github-signin-driver.mjs', definition);
const events = [], errors = [];
let app, page, failure, originalClipboard, cdp, recorder;
const record = (name, detail = {}) => events.push({name, at: new Date().toISOString(), ...detail});
const button = name => page.getByRole('button', {name, exact: true});
const dialog = () => page.getByRole('dialog', {name: 'Connect GitHub', exact: true});
const item = name => page.getByRole('menuitem', {name, exact: true});
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout; let last;
  do {try {last = await check(); if (last) return last;} catch (error) {last = error.message;} await new Promise(resolve => setTimeout(resolve, 50));} while (Date.now() < end);
  throw Error('Timeout ' + label + ': ' + last);
}
async function refresh() {await page.evaluate(() => window.dispatchEvent(new Event('asmb:github-connection-changed')));}
async function controls(value) {await app.evaluate((_, value) => Object.assign(globalThis.__signinQA.controls, value), value);}
async function release(key) {await app.evaluate((_, key) => {globalThis.__signinQA.gates[key]?.(); delete globalThis.__signinQA.gates[key];}, key);}
async function stats() {return app.evaluate(() => ({...globalThis.__signinQA.stats}));}
async function menu() {if (!await page.locator('.ac-menu').isVisible()) await button('Account menu').click();}
async function dismissMenu() {await page.keyboard.press('Escape');}
async function connect() {await menu(); await item('Connect GitHub').click(); await dialog().waitFor(); await dialog().getByRole('button', {name: 'Connect GitHub', exact: true}).click();}
async function code() {await page.locator('.gc-user-code').waitFor(); return page.locator('.gc-user-code').innerText();}
async function cancel() {await dialog().getByRole('button', {name: 'Cancel', exact: true}).click(); await dialog().waitFor({state: 'hidden'});}
async function theme(label) {await button('asMagicBrain Theme').click(); await page.locator('.fw-theme-picker select').selectOption({label}); await button('Done').click();}
async function capture(name, overlay = false) {
  await page.screenshot({path: output + '/' + name + '.png'});
  if (overlay) {
    const areas = await page.evaluate(() => [
      ['GA1 account', '.ac-github-connection'], ['GA2 connection', '.gc-connect-dialog > header'], ['GA3 scope', '#gc-connect-description'],
      ['GA4 authorization code', '.gc-code-row'], ['GA5 browser action', '.gc-connect-dialog > .zi-primary'],
      ['GA6 feedback', '.gc-connect-dialog > .zi-progress'], ['GA7 actions', '.gc-connect-dialog > footer'],
    ].flatMap(([name, selector]) => {const element = document.querySelector(selector), r = element?.getBoundingClientRect(); return r && r.width && r.height ? [{name, x:r.x,y:r.y,width:r.width,height:r.height}] : [];}));
    await fs.writeFile(output + '/' + name + '-bounds.json', JSON.stringify(areas, null, 2));
    await page.evaluate(areas => {
      const layer=document.createElement('div');layer.id='signin-qa-overlay';layer.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      areas.forEach((a,i)=>{const color=['#ef8f37','#468ded','#ba7ae0','#1faf90','#e9b63c','#dd749e','#5ab9d6'][i],box=document.createElement('div');box.style.cssText=`position:fixed;left:${a.x}px;top:${a.y}px;width:${a.width}px;height:${a.height}px;box-sizing:border-box;border:2px solid ${color};background:${color}22`;const label=document.createElement('span');label.textContent=a.name;label.style.cssText=`position:absolute;top:-17px;left:0;background:#161b22;color:${color};font:700 11px system-ui;white-space:nowrap;padding:1px 4px`;box.append(label);layer.append(box);});
      (document.querySelector('.gc-connect-dialog')??document.querySelector('.fw-window')).append(layer);
    }, areas);
    try {await page.screenshot({path: output+'/'+name+'-overlay.png'});} finally {await page.evaluate(()=>document.getElementById('signin-qa-overlay')?.remove());}
  }
  record('screenshot',{file:name+'.png',overlay});
}
async function startVideo(){
 cdp=await page.context().newCDPSession(page);
 await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=1440;canvas.height=1000;const context=canvas.getContext('2d'),chunks=[],mime=MediaRecorder.isTypeSupported('video/webm;codecs=vp9')?'video/webm;codecs=vp9':'video/webm;codecs=vp8';const stream=canvas.captureStream(12),recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:1500000});window.__asmbQaVideo={canvas,context,chunks,recorder,stream,started:Date.now(),mime};recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.start(1000);});
 recorder={started:Date.now(),frames:0,dropped:0,busy:false,listener:null};const state=recorder;
 state.listener=async event=>{void cdp.send('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(()=>{});if(state.busy){state.dropped++;return;}state.busy=true;try{await page.evaluate(async jpeg=>{const v=window.__asmbQaVideo;if(!v)return;const img=new Image();img.src='data:image/jpeg;base64,'+jpeg;await img.decode();v.context.drawImage(img,0,0,v.canvas.width,v.canvas.height);},event.data);state.frames++;}catch(error){state.frameErrors??=[];state.frameErrors.push(String(error));}finally{state.busy=false;}};
 cdp.on('Page.screencastFrame',state.listener);await cdp.send('Page.startScreencast',{format:'jpeg',quality:75,maxWidth:1440,maxHeight:1000,everyNthFrame:1});
}
async function stopVideo(){if(!recorder)return;const state=recorder;await cdp.send('Page.stopScreencast');cdp.off('Page.screencastFrame',state.listener);await until(()=>!state.busy,'video frame drained');const result=await page.evaluate(async()=>{const v=window.__asmbQaVideo;await new Promise(resolve=>{v.recorder.onstop=resolve;v.recorder.stop();});v.stream.getTracks().forEach(t=>t.stop());const blob=new Blob(v.chunks,{type:v.mime}),base64=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(blob);});delete window.__asmbQaVideo;return{base64,mime:v.mime};});const filename='signin-walkthrough.webm';await fs.writeFile(path.join(output,filename),Buffer.from(result.base64,'base64'));record('real-gesture-recording',{file:filename,mime:result.mime,durationMs:Date.now()-state.started,capturedFrames:state.frames,droppedFrames:state.dropped,frameErrors:state.frameErrors??[],canvasRate:12,method:'Actual CDP screencast frames encoded through browser MediaRecorder; no reenactment.'});recorder=null;}

async function installConfiguredSeam() {
  const seam = await app.evaluate(async ({app,ipcMain,safeStorage}, resources) => {
    const require=process.getBuiltinModule('node:module').createRequire(resources+'/package.json');
    const {createGitHubAuth}=require(resources+'/apps/native/github-auth.mjs');
    const {createGitHubAccountCoordinator,githubAccountMethods}=require(resources+'/apps/native/github-account-coordinator.mjs');
    const qa={controls:{token:'pending',expires:900,holdDevice:false,holdOpen:false,holdDisconnect:false},gates:{},stats:{devices:0,polls:0,pollTimes:[],users:0,opened:[],methods:[]},offset:0};
    const wait=key=>new Promise(resolve=>{qa.gates[key]=resolve;});
    const reply=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
    const options={clientId:'Iv1.SYNTHETIC_UI_ONLY',profileRoot:app.getPath('userData'),storage:{isAvailable:()=>safeStorage.isEncryptionAvailable(),encrypt:value=>safeStorage.encryptString(value),decrypt:value=>safeStorage.decryptString(value)},now:()=>Date.now()+qa.offset,
      openExternal:async url=>{qa.stats.opened.push(url);if(qa.controls.holdOpen){await wait('open');throw Error('Synthetic external browser failure');}},
      fetch:async url=>{
        if(url==='https://github.com/login/device/code'){qa.stats.devices++;const number=qa.stats.devices;if(qa.controls.holdDevice)await wait('device');return reply({device_code:'synthetic_private_device_'+number,user_code:'TEST-'+String(number).padStart(4,'0'),verification_uri:'https://github.com/login/device',expires_in:qa.controls.expires,interval:1});}
        if(url==='https://github.com/login/oauth/access_token'){qa.stats.polls++;qa.stats.pollTimes.push(Date.now());if(qa.controls.token==='hold'){await wait('poll');return reply({access_token:'synthetic_access_never_renderer',token_type:'bearer',expires_in:2,refresh_token:'synthetic_refresh_never_renderer',refresh_token_expires_in:3});}if(qa.controls.token==='success')return reply({access_token:'synthetic_access_never_renderer',token_type:'bearer',expires_in:2,refresh_token:'synthetic_refresh_never_renderer',refresh_token_expires_in:3});if(qa.controls.token==='denied')return reply({error:'access_denied',error_description:'synthetic_private_never_display'});if(qa.controls.token==='slow'){qa.controls.token='pending';return reply({error:'slow_down'});}return reply({error:'authorization_pending'});}
        if(url==='https://api.github.com/user'){qa.stats.users++;return reply({id:9917,login:'synthetic-ui-user',name:'Synthetic UI Identity',email:null});}
        throw Error('Unexpected synthetic provider request');
      }};
    qa.make=()=>{qa.auth=createGitHubAuth(options);const downloads={disconnect:async action=>{if(qa.controls.holdDisconnect)await wait('disconnect');return action();}};qa.coordinator=createGitHubAccountCoordinator({auth:qa.auth,cloneCoordinator:downloads,updateCoordinator:{disconnect:action=>action()}});};qa.make();
    const original=ipcMain._invokeHandlers.get('asmb:native');if(typeof original!=='function')throw Error('Native IPC handler not found');qa.original=original;
    ipcMain.removeHandler('asmb:native');ipcMain.handle('asmb:native',async(event,input)=>{
      if(!githubAccountMethods.has(input?.method))return original(event,input);
      qa.stats.methods.push(input.method);
      try{const value=await qa.coordinator.request(input.method,input.args);if(JSON.stringify(value)?.match(/synthetic_(?:access|refresh|private)/))throw Error('Credential reached public DTO');return{ok:true,value};}
      catch(error){return{ok:false,error:{code:error.code??'TEST_ERROR',message:error.message}};}
    });globalThis.__signinQA=qa;
    return{secureStorage:safeStorage.isEncryptionAvailable(),methods:[...githubAccountMethods],profile:app.getPath('userData'),authModule:resources+'/apps/native/github-auth.mjs',coordinatorModule:resources+'/apps/native/github-account-coordinator.mjs'};
  },resources);
  assert.equal(seam.secureStorage,true); record('configured-debugger-seam',{...seam,scope:'Bundled production auth, encrypted vault, account coordinator, preload and React; synthetic host-only provider and empty-download disconnect barrier. No registration or bundle modified. No real account or external browser consent.'});
  await refresh();
}
async function clipboardGate() {await page.evaluate(()=>{window.__signinClipboard={descriptor:Object.getOwnPropertyDescriptor(navigator.clipboard,'writeText')};Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:()=>new Promise(resolve=>{window.__signinClipboard.resolve=resolve;})});});}
async function releaseClipboard() {await page.evaluate(()=>{const q=window.__signinClipboard;q.resolve();if(q.descriptor)Object.defineProperty(navigator.clipboard,'writeText',q.descriptor);else delete navigator.clipboard.writeText;delete window.__signinClipboard;});}

try {
  app=await _electron.launch({executablePath:executable,args:['--test-data-root='+data],cwd:output,env:{PATH:process.env.PATH,TMPDIR:tmp}});
  page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await button('Account menu').waitFor();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,1000));
  const runtime=await app.evaluate(({app})=>({packaged:app.isPackaged,executable:process.execPath,profile:app.getPath('userData')}));
  assert.equal(runtime.packaged,true);assert.equal(runtime.executable,executable);assert.equal(runtime.profile,data+'-electron-profile');record('actual-packaged-launch',{runtime});
  originalClipboard=await app.evaluate(({clipboard})=>clipboard.readText());
  // Reading a pristine profile never starts live authorization. Every subsequent
  // account mutation is routed through installConfiguredSeam's synthetic host.
  const shippedConnection=await page.evaluate(()=>window.asMagicBrain.getGitHubConnection());
  assert.deepEqual(shippedConnection,{ok:true,value:{configured:shippedRegistration.configured,state:shippedRegistration.configured?'signed-out':'unavailable'}});
  const toggle=page.getByRole('switch',{name:'Hide unavailable functions'});if(await toggle.getAttribute('aria-checked')==='true')await toggle.click();
  await menu();assert.equal(await item('Connect GitHub').isEnabled(),shippedRegistration.configured);await capture(shippedRegistration.configured?'configured-signed-out-account':'unconfigured-account');await dismissMenu();record('shipped-registration-state-honest',{registration:shippedRegistration,connection:shippedConnection.value,productionAuthorizationStarted:false});
  const beforePreferences=await page.evaluate(()=>window.asMagicBrain.request({repo:'Workspace',operation:'getCommitPreferences',args:{}}));
  await installConfiguredSeam();await menu();await until(()=>item('Connect GitHub').isEnabled(),'configured Connect');await dismissMenu();

  await controls({holdDevice:true});await connect();await until(async()=>(await stats()).devices===1,'delayed start');assert.equal(await button('Connecting…').isDisabled(),true);await cancel();await release('device');await controls({holdDevice:false});
  assert.equal((await page.evaluate(()=>window.asMagicBrain.getGitHubConnection())).value.state,'signed-out');record('cancel-before-request-id-late-start-discarded');
  await startVideo();await theme('GitHub Light Default');await connect();const publicCode=await code();await button('Copy code').click();await until(()=>page.locator('.gc-copy-status').innerText().then(t=>t==='Copied'),'copied code');assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),publicCode);await button('Open GitHub').click();await until(async()=>(await stats()).opened.length===1,'fixed browser route');assert.deepEqual((await stats()).opened,['https://github.com/login/device']);await capture('configured-code-light',true);record('actual-public-code-clipboard-and-fixed-url');await until(()=>page.locator('.gc-copy-status').innerText().then(t=>t===''),'copy feedback expiry');record('copy-confirmation-expires-without-new-row');
  await controls({token:'denied'});await until(()=>dialog().getByRole('alert').innerText().then(t=>t.includes('declined')),'denial');assert.ok(!(await dialog().innerText()).includes('synthetic_private'));await cancel();record('provider-denial-no-secret-text');

  await controls({token:'pending'});await connect();const oldCode=await code();await clipboardGate();await button('Copy code').click();await button('Copying…').waitFor();await cancel();await connect();assert.notEqual(await code(),oldCode);await releaseClipboard();await until(()=>button('Copy code').isEnabled(),'new copy remains usable');assert.equal(await page.locator('.gc-copy-status').innerText(),'');record('late-copy-feedback-does-not-cross-attempts');
  await controls({holdOpen:true});await button('Open GitHub').click();await button('Opening GitHub…').waitFor();await cancel();await connect();await code();await release('open');await controls({holdOpen:false});await until(()=>button('Open GitHub').isEnabled(),'new browser action usable');assert.equal(await dialog().getByRole('alert').count(),0);record('late-browser-failure-does-not-cross-attempts');await cancel();

  await controls({token:'slow'});const slowStart=(await stats()).polls;await connect();await code();await until(async()=>(await stats()).polls>slowStart,'slow down received');const slowAt=(await stats()).pollTimes.at(-1);await until(async()=>(await stats()).polls>slowStart+1,'slower renderer polling',10000);assert.ok((await stats()).pollTimes.at(-1)-slowAt>=5900,'renderer respects increased six-second polling interval');await cancel();record('slow-down-respected-by-renderer-polling');
  await stopVideo();
  await controls({token:'hold'});await connect();await code();await until(async()=>(await app.evaluate(()=>Boolean(globalThis.__signinQA.gates.poll))),'pending token');await cancel();await release('poll');assert.equal((await page.evaluate(()=>window.asMagicBrain.getGitHubConnection())).value.state,'signed-out');record('cancel-pending-token-does-not-connect');
  await controls({token:'pending',expires:2});await connect();await code();await until(()=>dialog().getByRole('alert').innerText().then(t=>t.includes('expired')),'local expiry');assert.equal(await page.locator('.gc-user-code').count(),0);assert.equal(await dialog().getByRole('button',{name:'Connect GitHub',exact:true}).isEnabled(),true);record('expired-code-removed-and-retry-available');await cancel();

  await controls({token:'pending',expires:900});await theme('GitHub Dark Default');await connect();await code();await capture('configured-code-dark',true);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(720,760));await capture('configured-code-narrow',true);
  const bounds=await page.evaluate(()=>{const r=document.querySelector('.gc-connect-dialog').getBoundingClientRect();return{left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth};});assert.ok(bounds.left>=0&&bounds.right<=bounds.width&&bounds.bottom<=bounds.height&&bounds.scroll<=bounds.width);record('narrow-dialog-contained',{bounds});await cancel();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,1000));
  await controls({token:'success'});await connect();await code();await dialog().waitFor({state:'hidden'});await menu();await until(()=>page.locator('.ac-github-connection').innerText().then(t=>t.includes('synthetic-ui-user')),'validated identity');await capture('connected-account');assert.equal(await item('Disconnect GitHub').isEnabled(),true);
  assert.ok(!(await page.locator('.ac-profile').innerText()).includes('synthetic-ui-user'),'GitHub connection remains separate from the application profile');assert.equal((await page.evaluate(()=>window.asMagicBrain.getApplicationAccount())).value.state,'signed-out');record('github-identity-stays-in-separate-connection-group');
  assert.deepEqual(await page.evaluate(()=>window.asMagicBrain.request({repo:'Workspace',operation:'getCommitPreferences',args:{}})),beforePreferences,'connecting never changes commit preferences');record('validated-connected-identity-no-automatic-author-change');
  await item('Settings').click();const settings=page.getByRole('dialog',{name:'Commit author'});await settings.getByRole('radio',{name:/GitHub identity/}).check();const email=settings.locator('input[name="author-email"]');await email.fill('chosen@example.invalid');await settings.getByRole('button',{name:'Use connected GitHub identity'}).click();assert.equal(await email.inputValue(),'chosen@example.invalid');assert.equal(await settings.locator('input[name="author-name"]').inputValue(),'Synthetic UI Identity');await capture('explicit-commit-identity');await settings.getByRole('button',{name:'Cancel',exact:true}).click();record('explicit-identity-choice-preserves-user-email-when-profile-private');
  await app.evaluate(()=>{globalThis.__signinQA.offset+=60000;});await refresh();await menu();await until(()=>page.locator('.ac-github-connection').innerText().then(t=>t.includes('expired')),'expired account');assert.equal(await item('Connect GitHub').isEnabled(),true);assert.equal(await item('Disconnect GitHub').isEnabled(),true);await capture('expired-account');record('expired-state-keeps-reconnect-and-disconnect');
  await controls({holdDisconnect:true});await item('Disconnect GitHub').click();await menu();await until(()=>page.locator('.ac-github-connection').innerText().then(t=>t.includes('Disconnecting')),'disconnect busy');assert.equal(await item('Connect GitHub').isDisabled(),true);assert.equal(await item('Disconnect GitHub').isDisabled(),true);assert.equal(await item('Disconnect GitHub').getAttribute('data-unavailable'),null);await capture('disconnect-busy');await release('disconnect');await controls({holdDisconnect:false});await until(()=>page.locator('.ac-github-connection').innerText().then(t=>!t.includes('Disconnecting')&&!t.includes('expired')),'disconnect settled');record('disconnect-busy-controls-visible-disabled');await dismissMenu();
  await app.evaluate(async()=>{const qa=globalThis.__signinQA;await qa.auth.close();const fs=process.getBuiltinModule('node:fs/promises'),crypto=process.getBuiltinModule('node:crypto'),root=process.argv.find(x=>x.startsWith('--test-data-root=')).slice('--test-data-root='.length)+'-electron-profile';await fs.writeFile(root+'/github-auth/'+crypto.createHash('sha256').update('Iv1.SYNTHETIC_UI_ONLY').digest('hex')+'.bin','invalid encrypted content',{mode:0o600});qa.make();});await refresh();await menu();await until(()=>page.locator('.ac-github-connection').innerText().then(t=>t.includes('unavailable')),'corrupt state');assert.equal(await item('Connect GitHub').isDisabled(),true);assert.equal(await item('Disconnect GitHub').isEnabled(),true);await capture('corrupt-account-recovery');await item('Disconnect GitHub').click();await menu();await until(()=>item('Connect GitHub').isEnabled(),'repaired signed-out account');record('corrupt-vault-disconnect-recovery-without-fake-identity');await dismissMenu();
  assert.ok(!(await page.locator('body').innerText()).match(/synthetic_(?:access|refresh|private)/));
  const finalStats=await stats();record('synthetic-host-provider-summary',{...finalStats,methodCount:finalStats.methods.length,methods:[...new Set(finalStats.methods)]});
  assert.equal(errors.length,0);await app.evaluate(async({ipcMain,clipboard},original)=>{const qa=globalThis.__signinQA;await qa.coordinator.prepareClose();await qa.auth.close();ipcMain.removeHandler('asmb:native');ipcMain.handle('asmb:native',qa.original);delete globalThis.__signinQA;clipboard.writeText(original);},originalClipboard);
  const closed=app.waitForEvent('close',{timeout:20000});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await closed;app=null;record('ordinary-native-close-after-seam-restored');
} catch(error) {failure=error.stack??String(error);try{await stopVideo();}catch{}try{await page?.screenshot({path:output+'/failure.png'});}catch{} }
finally {
  if(app){try{await app.evaluate(async({clipboard},original)=>{const qa=globalThis.__signinQA;if(qa){for(const resolve of Object.values(qa.gates))resolve();await qa.coordinator.prepareClose();await qa.auth.close();}if(typeof original==='string')clipboard.writeText(original);},originalClipboard);}catch{}await app.close().catch(()=>{});}
  await fs.writeFile(output+'/receipt.json',JSON.stringify({status:failure?'failed':'passed',failure,executable,metadata,shippedRegistration,data,events,errors,definitionSha256:sha(definition),scope:'Actual immutable bundled account UI. Its public registration metadata and matching pristine-profile account state are checked first without starting production authorization. All account mutations then use bundled production auth/vault/account coordinator plus synthetic host-only transport under Electron debugger; no live OAuth or registration/secret/bundle writes.'},null,2));
  process.stdout.write(JSON.stringify({status:failure?'failed':'passed',output,events:events.length,failure})+'\n');if(failure)process.exitCode=1;
}
