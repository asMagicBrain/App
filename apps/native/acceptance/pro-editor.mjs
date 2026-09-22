import {assertPackageIdentity} from './package-identity.mjs';
/** Stage 3 actual native acceptance. Uses shipped controls and read-only CDP
 * observations. No app callback, bridge result, module or source is replaced.
 * Adversarial artifact scripts execute only after explicit review and Run.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import dgram from 'node:dgram';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {createProEditorFixtures} from './pro-editor-fixtures.mjs';
import {createArtifactProbe} from './pro-editor-probe.mjs';
import {testRoot as testBase} from '../../../tools/development-paths.mjs';

assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
assert.ok(process.env.ASMB_PACKAGED_EXECUTABLE, 'Bind acceptance to an exact candidate');
assert.ok(process.env.ASMB_TECHNICAL_FIXTURES, 'Supply the reviewed reproduction directory');
process.env.ASMB_ACCEPTANCE_RUN_ROOT ??= path.join(testBase, 'runs/pro-editor');
const {createDriver, nativeTarget, testRoot: runRoot, until, sha} = await import(process.platform === 'linux' ? './linux-driver.mjs' : './native-driver.mjs');
await fs.mkdir(runRoot,{recursive:true});
const output=await fs.mkdtemp(path.join(runRoot,'pro-'));
const executable=process.env.ASMB_PACKAGED_EXECUTABLE;
const bundle=process.platform==='linux'?path.dirname(executable):executable.slice(0,executable.indexOf('.app/Contents/MacOS/')+4);
const payload=path.join(bundle,process.platform==='linux'?'resources/app':'Contents/Resources/app');
const metadata=JSON.parse(await fs.readFile(path.join(payload,'native-package.json')));
assertPackageIdentity(metadata);
if(process.env.ASMB_EXPECTED_SOURCE_COMMIT)assert.equal(metadata.sourceCommit,process.env.ASMB_EXPECTED_SOURCE_COMMIT);
if(process.env.ASMB_EXPECTED_BUILD_NUMBER)assert.equal(metadata.buildNumber,Number(process.env.ASMB_EXPECTED_BUILD_NUMBER));
const home=path.join(output,'home'),data=metadata.channel==='preview'?path.join(home,'asMagicBrain'):path.join(output,'data');
const organization=path.join(data,'workspaces/asMagicBrain'),repo='Pro-Qualification';
const target=metadata.channel==='preview'?{executablePath:executable,args:['--test-root='+testBase,'--test-user-home='+home]}:nativeTarget(data);
const driver=await createDriver({...target,output,workspacePath:path.join(organization,'Workspace')});
for(const name of ['pro-editor.mjs','pro-editor-fixtures.mjs','pro-editor-probe.mjs'])await fs.copyFile(new URL(name,import.meta.url),path.join(output,name));
const endpointRequests=[],udpPackets=[],turnPackets=[];
const turnSockets=new Set();
const turn=net.createServer(socket=>{turnSockets.add(socket);socket.on('data',bytes=>turnPackets.push({bytes:bytes.length}));socket.once('close',()=>turnSockets.delete(socket));});
await new Promise((resolve,reject)=>{turn.once('error',reject);turn.listen(0,'127.0.0.1',resolve);});
const listener=http.createServer((req,res)=>{endpointRequests.push({method:req.method,url:req.url});res.writeHead(200,{'Content-Type':'text/plain','Access-Control-Allow-Origin':'*'});res.end('synthetic endpoint');});
listener.on('upgrade',(req,socket)=>{endpointRequests.push({method:'WEBSOCKET',url:req.url});socket.destroy();});
await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
const udp=dgram.createSocket('udp4');udp.on('message',(message,remote)=>udpPackets.push({bytes:message.length,address:remote.address}));
await new Promise((resolve,reject)=>{udp.once('error',reject);udp.bind(0,'127.0.0.1',resolve);});
// Verify observers actually receive traffic, then reset counters. A blanket
// network-offline browser setting would not prove artifact policy enforcement.
await fetch('http://127.0.0.1:'+listener.address().port+'/observer-self-test');endpointRequests.length=0;
await new Promise((resolve,reject)=>udp.send(Buffer.from('observer'),udp.address().port,'127.0.0.1',error=>error?reject(error):resolve()));
await until(()=>udpPackets.length===1,{label:'UDP observer self-test'});udpPackets.length=0;
const rtcProbe=async({udpPort,tcpPort})=>{const states=[],errors=[];let pc;try{pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:'+udpPort},{urls:'turn:127.0.0.1:'+tcpPort+'?transport=tcp',username:'dummy',credential:'dummy'}]});pc.onicegatheringstatechange=()=>states.push(pc.iceGatheringState);pc.onicecandidateerror=event=>errors.push(event.errorCode);pc.createDataChannel('synthetic');await pc.setLocalDescription(await pc.createOffer());await new Promise(resolve=>setTimeout(resolve,2200));return{started:true,states,errors};}catch(error){return{started:false,error:error.name,states,errors};}finally{pc?.close();}};
const fixture=path.join(output,'fixture');
const fixtures=await createProEditorFixtures({output:fixture,reproductionDirectory:process.env.ASMB_TECHNICAL_FIXTURES,httpPort:listener.address().port,udpPort:udp.address().port});
const zip=path.join(output,'pro-qualification.zip');execFileSync('/usr/bin/zip',['-qr',zip,'.'],{cwd:fixture});
const originalFiles=new Map();
async function inventory(directory,prefix=''){for(const entry of await fs.readdir(directory,{withFileTypes:true})){const rel=path.posix.join(prefix,entry.name);if(entry.isDirectory())await inventory(path.join(directory,entry.name),rel);else originalFiles.set(rel,await fs.readFile(path.join(directory,entry.name)));}}
await inventory(fixture);
let page,probe,running=false,failure;
const artifactRequests=[];
const observations=[],cycles=[],captures=[];
const button=name=>page.getByRole('button',{name,exact:true});
const record=(name,detail={})=>{driver.record(name,detail);console.log(JSON.stringify({event:name}));};
const source=name=>fs.readFile(path.join(organization,repo,name));
const editor=()=>page.locator('.rfe-source:not([hidden]) .cm-content[contenteditable=true]');
const sourceText=()=>page.locator('.rfe-source .cm-line').evaluateAll(lines=>lines.map(line=>line.textContent).join('\n'));
const mod=process.platform==='darwin'?'Meta':'Control',end=process.platform==='darwin'?'Meta+ArrowDown':'Control+End',redo=process.platform==='linux'?'Control+Shift+Z':'Meta+Shift+z';
async function launch(){page=await driver.launch();running=true;await page.context().setOffline(false);probe=await createArtifactProbe(page);await button('asMagicBrain organization').waitFor();if(driver.app)await driver.app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setContentSize(1280,900);w.show();w.focus();});}
async function close(){if(probe)artifactRequests.push(...probe.requests);await probe?.dispose();probe=null;await driver.closeNormally();running=false;}
async function capture(label,artifact){await fs.writeFile(path.join(output,label+'-aria.yml'),await page.locator('body').ariaSnapshot());await driver.screenshot(label);captures.push(label+'.png');if(artifact){const image=await artifact.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(output,label+'-artifact.png'),Buffer.from(image.data,'base64'));captures.push(label+'-artifact.png');
  if(driver.app){const screenshot=await driver.app.evaluate(async({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return typeof w.capturePage==='function'?(await w.capturePage()).toPNG().toString('base64'):null;});if(screenshot){await fs.writeFile(path.join(output,label+'-window.png'),Buffer.from(screenshot,'base64'));captures.push(label+'-window.png');}}
}}
async function annotated(label,definitions,artifact){const areas=await page.evaluate(definitions=>definitions.map(([name,selector])=>{const node=document.querySelector(selector);if(!node||!node.checkVisibility())throw Error('Missing annotated region '+name);const r=node.getBoundingClientRect();return{name,x:r.x,y:r.y,width:r.width,height:r.height};}),definitions);await fs.writeFile(path.join(output,label+'-areas.json'),JSON.stringify(areas,null,2)+'\n');
  await page.evaluate(areas=>{const layer=document.createElement('div');layer.id='stage3-qa-overlay';layer.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483647';areas.forEach((area,index)=>{const color=['#a32638','#6639b0','#08714c','#00738b'][index%4],box=document.createElement('div'),badge=document.createElement('span');box.style.cssText=`position:fixed;left:${area.x}px;top:${area.y}px;width:${area.width}px;height:${area.height}px;border:2px solid ${color};box-sizing:border-box`;badge.textContent=area.name;badge.style.cssText=`background:white;color:${color};font:700 11px system-ui;padding:2px 4px;position:absolute;left:0;top:0;white-space:nowrap`;box.append(badge);layer.append(box);});(document.querySelector('dialog[open]')??document.body).append(layer);},areas);
  try{await capture(label+'-annotated',artifact);}finally{await page.evaluate(()=>document.getElementById('stage3-qa-overlay')?.remove());}
}
async function openFile(name){await button('asMagicBrain organization').click();if(await button('Leave editor').isVisible())await button('Leave editor').click();await button('Open repository '+repo).click();for(const part of name.split('/'))await page.getByRole('table',{name:/^(?:Directory contents$|Files in )/}).getByRole('button',{name:part,exact:true}).click();await until(()=>page.locator('.rfe-file-view,.rfe-source,.rfe-preview').count().then(n=>n>0),{label:'file view'});}
async function enablePro(value){await button('Manage plugins').click();const toggle=page.getByRole('switch',{name:'Enable Pro Editor',exact:true});await toggle.waitFor();if((await toggle.getAttribute('aria-checked')==='true')!==value)await toggle.click();await button('Return to workspace').click();}
async function openReview(name){await openFile(name);await button('Review interactive view').click();await button('Run interactive view').waitFor();}
async function runReviewed(){await button('Run interactive view').click();const target=await until(async()=>{const list=await probe.targets();assert.ok(list.length<=1,'One artifact target per host');return list[0];},{timeout:120000,label:'one admitted artifact target'});const artifact=await probe.attach(target.targetId);await artifact.send('Page.enable');return artifact;}
async function stop(artifact){await button('Stop').click();await artifact?.detach();await until(()=>probe.targets().then(list=>list.length===0),{timeout:30000,label:'artifact target disposed'});}
async function closeInteractive(){const close=button('Close interactive view');if(await close.isVisible())await close.click();await until(()=>probe.targets().then(list=>list.length===0),{label:'no active artifact after close'});}
async function memorySample(){const targets=await probe.targets();let processes=[];if(driver.app)processes=await driver.app.evaluate(({app,webContents})=>({metrics:app.getAppMetrics().map(({pid,type,memory,cpu})=>({pid,type,memory,cpu})),contents:webContents.getAllWebContents().filter(w=>!w.isDestroyed()).map(w=>({id:w.id,url:w.getURL(),pid:w.getOSProcessId()}))}));else{const rows=execFileSync('/bin/ps',['-eo','pid,ppid,rss,args'],{encoding:'utf8'}).split('\n');processes=rows.filter(line=>line.includes(executable)&&!line.includes('/bin/ps')).map(line=>line.trim());}const status=await page.evaluate(()=>window.asMagicBrain.artifactStatus());return{at:new Date().toISOString(),targets,processes,status};}
async function unchanged(except=[]){for(const [name,bytes]of originalFiles)if(!except.includes(name))assert.deepEqual(await source(name),bytes,'Unchanged imported bytes: '+name);}

try{
  await launch();
  // Trusted QA observation only: the primary application has no artifact
  // policy. Its real native RTC implementation provides a reachable local
  // positive control, without changing app source, preferences or security.
  const rtcPositive=await page.evaluate(rtcProbe,{udpPort:udp.address().port,tcpPort:turn.address().port});
  assert.equal(rtcPositive.started,true);assert.ok(udpPackets.length>0,'Positive control emits STUN packets');assert.ok(turnPackets.length>0,'Positive control emits TURN TCP bytes');
  record('RTC-controlled-endpoint-positive-control',{rtcPositive,udpPackets:[...udpPackets],turnPackets:[...turnPackets]});
  udpPackets.length=0;turnPackets.length=0;
  await button('Create new options').click();await page.locator('.ra-menu-create').getByRole('button',{name:'Import repository',exact:true}).click();
  await page.getByLabel('ZIP archive',{exact:true}).setInputFiles(zip);await page.getByLabel('Repository name',{exact:true}).fill(repo);
  await page.locator('.zi-dialog').getByRole('button',{name:'Import repository',exact:true}).click();await page.locator('.zi-dialog').waitFor({state:'detached',timeout:120000});
  await openFile('README.md');assert.equal((await probe.targets()).length,0);await enablePro(true);assert.equal((await probe.targets()).length,0);
  record('I01-import-reading-plugin-enable-remain-inert');
  await button('Edit this file').click();await editor().waitFor();await editor().focus();await editor().press(end);
  await page.evaluate(()=>{window.__proCM6=document.querySelector('.rfe-source .cm-editor');});
  const presentation=page.getByRole('group',{name:'Pro presentation',exact:true});await presentation.getByRole('button',{name:'Visual',exact:true}).click();
  await page.locator('.pro-visual-widget[data-pro-block=equation]').waitFor();await page.locator('.pro-visual-widget[data-pro-block=diagram]').waitFor();
  assert.equal(await page.locator('.rfe-source .cm-editor').count(),1);
  await capture('01-pro-visual');
  const controls=await page.locator('.pro-visual-widget').evaluateAll(widgets=>widgets.map(widget=>{const button=widget.querySelector('button'),scroller=widget.closest('.cm-scroller');return{buttonRight:button.getBoundingClientRect().right,scrollerRight:scroller.getBoundingClientRect().right};}));assert.ok(controls.every(item=>item.buttonRight<=item.scrollerRight+1),'Visual source controls remain within source viewport');
  await annotated('01-pro-visual',[['PE1 · Pro presentation','.np-document-tools'],['PE2 · Shared CM6 source','.rfe-source:not([hidden])'],['PE3 · Save and commit','.rfe-actions']]);
  await page.getByRole('tab',{name:'Split',exact:true}).click();await page.locator('.rfe-preview .katex').first().waitFor();
  assert.equal(await page.locator('.rfe-source .cm-editor').count(),1);
  await capture('01b-pro-split');await annotated('01b-pro-split',[['PE1 · Pro presentation','.np-document-tools'],['PE2 · Shared source and preview','.rfe-document-panes'],['PE3 · Save and commit','.rfe-actions']]);
  await page.getByRole('tab',{name:'Edit',exact:true}).click();
  await page.getByRole('button',{name:'Edit equation source',exact:true}).first().click();await editor().waitFor();
  assert.equal(await page.evaluate(()=>document.querySelector('.rfe-source .cm-editor')===window.__proCM6),true);
  await presentation.getByRole('button',{name:'Source',exact:true}).click();
  assert.equal(await sourceText(),fixtures.source);
  await editor().focus();await editor().press(end);await button('Insert equation').click();
  const changed=await sourceText();assert.notEqual(changed,fixtures.source);assert.deepEqual(await source('README.md'),Buffer.from(fixtures.source));
  await editor().focus();await editor().press(mod+'+z');await until(async()=>await sourceText()===fixtures.source,{label:'Pro insert undo'});
  await editor().press(redo);await until(async()=>await sourceText()===changed,{label:'Pro insert redo'});
  await enablePro(false);assert.equal(await sourceText(),changed);await enablePro(true);assert.equal(await sourceText(),changed);
  await capture('02-pro-private-draft');await close();await launch();await openFile('README.md');await button('Edit this file').click();await editor().waitFor();
  assert.equal(await sourceText(),changed);assert.deepEqual(await source('README.md'),Buffer.from(fixtures.source));
  await button('Save').click();await until(async()=>await source('README.md').then(bytes=>bytes.equals(Buffer.from(changed))),{label:'explicit Save exact source'});
  await button('Commit changes…').click();const commit=page.getByRole('dialog',{name:'Commit changes',exact:true});await commit.waitFor();const initialize=commit.getByRole('button',{name:'Initialize local Git and review',exact:true});if(await initialize.isVisible())await initialize.click();
  await commit.getByLabel('Commit message',{exact:true}).fill('Qualify optional Pro editing');await commit.getByLabel('Local author name',{exact:true}).fill('Native QA');await commit.getByLabel('Local author email',{exact:true}).fill('native-qa@example.invalid');
  const selected=await commit.locator('fieldset input[type=checkbox]:checked').evaluateAll(nodes=>nodes.map(node=>node.closest('label')?.textContent));assert.equal(selected.length,1);assert.ok(selected[0].includes('README.md'));
  await commit.getByRole('button',{name:'Commit changes',exact:true}).click();await commit.waitFor({state:'hidden'});
  const git=args=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',path.join(organization,repo),...args],{env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},encoding:'utf8'});
  assert.equal(git(['show','HEAD:README.md']),changed);assert.deepEqual(git(['diff-tree','--root','--no-commit-id','--name-only','-r','HEAD']).trim().split('\n'),['README.md']);await unchanged(['README.md']);
  record('Pro-one-CM6-visual-source-undo-restart-draft-save-selected-commit',{savedSha256:sha(changed)});

  await openFile('slider/view.artifact.json');
  for(let iteration=1;iteration<=3;iteration++){await button('Review interactive view').click();await button('Close interactive view').click();await until(()=>button('Review interactive view').isEnabled(),{label:'review reopen after rapid close'});}
  record('rapid-review-close-reopen-remains-available');
  await button('Review interactive view').click();await button('Run interactive view').waitFor();await capture('03-interactive-review');
  await annotated('03-interactive-review',[['IA1 · Review identity','.artifact-dialog header'],['IA2 · Lifecycle controls','.artifact-actions'],['IA3 · Content and fallback','.artifact-surface'],['IA4 · Limits','.artifact-dialog footer']]);
  await button('Keep reading').click();assert.equal((await probe.targets()).length,0);record('I01-review-decline-does-not-execute');
  await button('Review interactive view').click();let artifact=await runReviewed();
  await until(()=>artifact.evaluate('document.querySelector("#value")?.value').then(v=>v==='45°'),{label:'original slider neutral state'});
  await artifact.click('#angle');await artifact.key('End','End',35);assert.equal(await artifact.evaluate('document.querySelector("#value").value'),'180°');
  await capture('04-original-slider',artifact);await stop(artifact);await closeInteractive();record('I02-I04-original-slider-pointer-keyboard');

  await openReview('frames/view.artifact.json');
  const poster=page.locator('.artifact-dialog img');await poster.waitFor();await until(()=>poster.evaluate(image=>image.complete&&image.naturalWidth>0),{label:'verified poster available before execution'});
  await button('Source').click();await until(()=>page.locator('.artifact-reading pre').innerText().then(text=>text.includes('const rad=Math.PI/180')),{label:'source text after host Stop'});assert.equal((await probe.targets()).length,0);await button('Static fallback').click();
  artifact=await runReviewed();await until(()=>artifact.evaluate('document.querySelector("#readout")?.textContent').then(v=>v?.includes('(0.300, 0.000, 0.260)')),{label:'neutral TCP'});
  await artifact.click('#yaw');await artifact.key('Home','Home',36);for(let i=0;i<270;i++)await artifact.key('ArrowRight','ArrowRight',39);
  const yaw=await artifact.evaluate('({yaw:document.querySelector("#yaw").value,readout:document.querySelector("#readout").textContent})');assert.equal(yaw.yaw,'90');assert.match(yaw.readout,/World T = \(0\.000, 0\.300, 0\.260\) m/);
  await artifact.click('#orbit');await artifact.key('End','End',35);assert.equal(await artifact.evaluate('document.querySelector("#readout").textContent'),yaw.readout);await capture('05-frames-yaw-orbit',artifact);
  await annotated('05-frames-yaw-orbit',[['IA1 · Artifact identity','.artifact-dialog header'],['IA2 · Host controls','.artifact-actions'],['IA3 · Isolated content','.artifact-surface'],['IA4 · Lifecycle limits','.artifact-dialog footer']],artifact);
  await button('Reset').click();await artifact.detach();const resetTarget=await until(async()=>{const list=await probe.targets();return list[0];},{label:'reset artifact'});artifact=await probe.attach(resetTarget.targetId);
  await until(()=>artifact.evaluate('document.querySelector("#yaw")?.value').then(v=>v==='0'),{label:'Reset example neutral source'});await stop(artifact);await closeInteractive();record('I02-I09-frame-model-view-distinction-reset-no-source-write',{yaw});

  await openReview('webgl/view.artifact.json');artifact=await runReviewed();await until(()=>artifact.evaluate('document.querySelector("#status")?.value').then(v=>v&&v!=='Starting…'),{label:'explicit WebGL outcome'});
  const webgl=await artifact.evaluate('document.querySelector("#status").value');observations.push({kind:'WebGL2',result:webgl});
  if(webgl.includes('ready')){await artifact.click('#change');assert.match(await artifact.evaluate('document.querySelector("#status").value'),/green/);}
  else assert.match(webgl,/unavailable|error|Context lost/i);
  await capture('06-webgl-outcome',artifact);await stop(artifact);await closeInteractive();record('I06-WebGL2-outcome',{webgl,scope:'Capability probe, not full production 3D or physics'});

  await openReview('modules/view.artifact.json');artifact=await runReviewed();
  await until(()=>artifact.evaluate('document.querySelector("#result")?.value').then(value=>value&&value!=='Not started'),{timeout:30000,label:'local module and texture outcome'});
  const modules=await artifact.evaluate('document.querySelector("#result").value');observations.push({kind:'local-module-texture',result:modules});
  assert.equal(modules,'Local module and texture ready');await capture('06b-module-texture',artifact);await stop(artifact);await closeInteractive();
  record('I03-I06-local-module-texture-drawn',{modules,scope:'Small synthetic WebGL2 textured quad; not production3D or physics'});

  await openReview('hostile/view.artifact.json');artifact=await runReviewed();await until(()=>artifact.evaluate('JSON.parse(document.querySelector("#results").textContent).finished'),{label:'hostile probes complete'});
  await artifact.click('#permission');await artifact.click('#popup');await artifact.click('#download');
  await until(()=>artifact.evaluate('JSON.parse(document.querySelector("#results").textContent).requests.geolocation'),{label:'permission denied'});
  const hostile=await artifact.evaluate('JSON.parse(document.querySelector("#results").textContent)');observations.push({kind:'hostile',...hostile});
  assert.equal(hostile.process,'undefined');assert.equal(hostile.require,'undefined');assert.equal(hostile.bridge,'undefined');assert.notEqual(hostile.rtcCreated,true);assert.notEqual(hostile.frameRTCCreated,true);assert.notEqual(hostile.popup,'ALLOWED');assert.notEqual(hostile.worker,'ALLOWED');
  assert.ok(Object.values(hostile.requests).every(value=>value!=='ALLOWED'));assert.deepEqual(endpointRequests,[]);assert.deepEqual(udpPackets,[]);
  // Defense-in-depth probe, not an attacker-reachable realm: QA CDP creates
  // an isolated world to bypass only the main-world constructor stubs. This
  // checks the native session/IP/proxy restrictions with actual RTC gathering.
  const {frameTree}=await artifact.send('Page.getFrameTree');const {executionContextId}=await artifact.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'qualification-transport-defense',grantUniveralAccess:false});
  const rtcDenied=await artifact.evaluate('('+rtcProbe.toString()+')('+JSON.stringify({udpPort:udp.address().port,tcpPort:turn.address().port})+')',{contextId:executionContextId});
  assert.deepEqual(udpPackets,[]);assert.deepEqual(turnPackets,[]);record('RTC-native-session-defense-in-depth',{rtcDenied,scope:'Debugger-created world unavailable to imported scripts; no production controls weakened'});
  await capture('07-denied-capabilities',artifact);await stop(artifact);await closeInteractive();record('I07-runtime-denied-capabilities',{hostile,endpointRequests,udpPackets});

  // Simulate an external change only inside this disposable repository, after
  // review and before Run. The app must not reuse the old approval or snapshot.
  await openReview('slider/view.artifact.json');
  const sliderPath=path.join(organization,repo,'slider/slider.html'),manifestPath=path.join(organization,repo,'slider/view.artifact.json');
  const originalSlider=await fs.readFile(sliderPath),originalManifest=await fs.readFile(manifestPath);
  const revised=Buffer.concat([originalSlider,Buffer.from('\n<!-- Changed after review: synthetic test -->\n')]);
  const revisedManifest=JSON.parse(originalManifest);const revisedAsset=revisedManifest.assets.find(asset=>asset.path==='slider.html');revisedAsset.bytes=revised.length;revisedAsset.sha256=sha(revised);
  await fs.writeFile(sliderPath,revised);await fs.writeFile(manifestPath,JSON.stringify(revisedManifest,null,2)+'\n');
  await button('Run interactive view').click();await page.locator('.artifact-dialog [role=alert]').waitFor();assert.equal((await probe.targets()).length,0);
  const staleMessage=await page.locator('.artifact-dialog [role=alert]').innerText();
  await closeInteractive();await openReview('slider/view.artifact.json');artifact=await runReviewed();await until(()=>artifact.evaluate('document.querySelector("#value")?.value').then(value=>value==='45°'),{label:'explicit re-review accepts new identity'});
  // Bytes are restored while an admitted immutable snapshot is active. Reading
  // or moving the slider must not consult the subsequently changed disk entry.
  await fs.writeFile(sliderPath,originalSlider);await fs.writeFile(manifestPath,originalManifest);
  await artifact.click('#angle');await artifact.key('End','End',35);assert.equal(await artifact.evaluate('document.querySelector("#value").value'),'180°');await stop(artifact);await closeInteractive();
  record('I08-stale-review-refused-and-fresh-review-required',{staleMessage});

  await openReview('delayed/view.artifact.json');await button('Run interactive view').click();
  await until(()=>probe.targets().then(targets=>targets.length===1),{label:'delayed view begins loading'});const cancelStarted=Date.now();
  await button('Close interactive view').click();await until(()=>probe.targets().then(targets=>targets.length===0),{timeout:30000,label:'close cancels pending Run'});
  await until(()=>button('Review interactive view').isEnabled(),{label:'cancelled loading does not leave busy trigger'});
  record('pending-Run-close-is-scoped-and-disposes-loading-view',{elapsedMs:Date.now()-cancelStarted});

  await openReview('busy/view.artifact.json');artifact=await runReviewed();await artifact.click('#busy');
  await new Promise(resolve=>setTimeout(resolve,150));const stopStarted=Date.now();await stop(artifact);await closeInteractive();
  record('I05-host-Stop-remains-responsive-with-busy-child',{elapsedMs:Date.now()-stopStarted});

  const baseline=await memorySample();
  for(let cycle=1;cycle<=20;cycle++){
    await openReview('slider/view.artifact.json');artifact=await runReviewed();await until(()=>artifact.evaluate('document.querySelector("#value")?.value').then(v=>v==='45°'),{label:'cycle neutral load'});
    const active=await artifact.metrics();assert.equal((await probe.targets()).length,1);
    await stop(artifact);await closeInteractive();cycles.push({cycle,active,disposed:await memorySample()});record('I05-lifecycle-cycle',{cycle});
  }
  const final=await memorySample();assert.equal(final.targets.length,baseline.targets.length);await fs.writeFile(path.join(output,'lifecycle.json'),JSON.stringify({baseline,cycles,final},null,2)+'\n');
  await unchanged(['README.md']);assert.deepEqual(endpointRequests,[]);assert.deepEqual(udpPackets,[]);assert.deepEqual(turnPackets,[]);record('I03-I05-I09-lifecycle-source-and-offline-preservation',{cycles:20});
  await openReview('slider/view.artifact.json');artifact=await runReviewed();assert.equal((await probe.targets()).length,1);
  await close();await launch();assert.equal((await probe.targets()).length,0);await openFile('README.md');assert.equal((await probe.targets()).length,0);await unchanged(['README.md']);
  assert.deepEqual(await source('README.md'),Buffer.from(changed));record('normal-close-disposes-active-artifact-and-restart-never-autoruns');
  assert.deepEqual(driver.errors,[]);assert.deepEqual(driver.consoleErrors,[]);await close();
}catch(error){failure=error;try{if(page)await capture('failure');}catch{};record('failure',{message:String(error),stack:error.stack});}
finally{
  if(running)try{await close();}catch(error){failure??=error;record('normal-close-failed',{message:String(error)});}
  await new Promise(resolve=>listener.close(resolve));udp.close();for(const socket of turnSockets)socket.destroy();await new Promise(resolve=>turn.close(resolve));
  await driver.report({status:failure?'failed':'passed',metadata,observations,cycles,captures,endpointRequests,udpPackets,turnPackets,artifactRequests,limitations:['No physics engine, general production 3D certification, persisted view state, real user credentials or Stage 4 export.'],failure:failure?String(failure):null});
}
if(failure)throw failure;
console.log(JSON.stringify({status:'passed',output}));
