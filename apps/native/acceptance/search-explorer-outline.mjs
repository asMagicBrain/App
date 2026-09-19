import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
/** Actual packaged search/explorer/outline acceptance. All repository mutations are
 * disposable Test fixtures. Production IPC/search/CM6/Arborist remain in use. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
const appRoot=fileURLToPath(new URL('../../../',import.meta.url));
const testRoot=developmentTestRoot;
process.env.ASMB_ACCEPTANCE_RUN_ROOT??=path.join(testRoot,'runs/native-search-explorer-outline-20260918/qa');
assert.ok(process.env.ASMB_PACKAGED_EXECUTABLE,'Supply an admitted candidate/final executable.');
const {createDriver,nativeTarget,testRoot:runRoot,until,sha}=await import('./native-driver.mjs');
await fs.mkdir(runRoot,{recursive:true});
const output=await fs.mkdtemp(path.join(runRoot,'search-explorer-outline-'));
const data=path.join(output,'data'),workRoot=path.join(data,'workspaces/asMagicBrain'),workspacePath=path.join(workRoot,'Workspace');
const definition=await fs.readFile(fileURLToPath(import.meta.url));
await fs.writeFile(path.join(output,'driver-at-launch.mjs'),definition);
const driver=await createDriver({...nativeTarget(data),output,workspacePath});
const record=driver.record;driver.record=(name,detail)=>{record(name,detail);console.log(JSON.stringify({event:name}));};
const executable=process.env.ASMB_PACKAGED_EXECUTABLE,bundle=executable.slice(0,executable.indexOf('.app/Contents/MacOS/')+4);
const metadata=JSON.parse(await fs.readFile(path.join(bundle,'Contents/Resources/app/native-package.json'),'utf8'));
const binary=path.join(bundle,'Contents/Resources/app/apps/native/dist-host/rg');
assert.ok(metadata.searchRuntime,'Package records its actual search runtime.');
assert.equal(sha(await fs.readFile(binary)),metadata.searchRuntime.sha256);
const binaryVersion=execFileSync(binary,['--version'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',TMPDIR:path.join(output,'tmp')}});
assert.match(binaryVersion,/ripgrep 15\./);
let page,running=false,failure,recorder,cdp,initialReadme,fixtureHead;
const errors=[],networkRequests=[],fixtureHashes={};
const alpha='Alpha-Search-QA',beta='Zeta-Search-QA',renamed='Renamed-Search-QA';
const docPath='notes/outline.md',unicode='😀 Ω needle',staleQuery='slow-first-marker',freshQuery='latest-second-marker';
const source='# Search outline fixture\n\n😀 Ω needle saved line\n\nSetext heading\n--------------\n\n## Duplicate\n\n```md\n# Not an outline heading\n```\n\n## Duplicate\n\nslow-first-marker\nlatest-second-marker\n';
const draft='\n## Draft live heading\n\nPrivate draft remains local. Ω\n';
const button=name=>page.getByRole('button',{name,exact:true});
const catalog=()=>page.locator('.ar-view');
const dialog=()=>page.locator('.ws-search-dialog');
const input=()=>dialog().getByRole('combobox',{name:/^(Search query|Find a file)$/});
const editor=()=>page.locator('.cm-content[contenteditable=true]');
const cm=()=>page.locator('.cm-content').filter({visible:true});
const sourceText=()=>cm().innerText();
const near=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<2,`${label}: ${actual} vs ${expected}`);
const exists=async filename=>Boolean(await fs.lstat(filename).catch(()=>null));
async function bridge(method,args){return page.evaluate(async({method,args})=>{const reply=await window.asMagicBrain[method](args);if(!reply.ok)throw Error(`${reply.error.code}: ${reply.error.message}`);return reply.value;},{method,args});}
async function launch(){
 page=await driver.launch();running=true;page.setDefaultTimeout(15000);
 page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 page.on('request',request=>{if(/^https?:/.test(request.url()))networkRequests.push(request.url());});
 await page.context().setOffline(true);await resize(1440,1000);
 await button('asMagicBrain home').waitFor();await page.locator('.rc-document').waitFor();
 assert.equal(await page.locator('.rc-page [role=alert]').count(),0);
}
async function resize(width,height=900){await driver.app.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows()[0].setContentSize(width,height),{width,height});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function closeNormally(){await stopVideo();await driver.closeNormally();running=false;}
async function mode(hide){const control=page.getByRole('switch',{name:'Hide unavailable functions'});await control.focus();if((await control.getAttribute('aria-checked')==='true')!==hide)await control.press('Space');await until(async()=>await control.getAttribute('aria-checked')===String(hide),{label:'availability mode'});assert.equal(await button('Toggle document outline').isVisible(),true);}
async function theme(label){await button('asMagicBrain Theme').click();await page.locator('.fw-theme-picker select').selectOption({label});await page.locator('.fw-theme-picker').getByRole('button',{name:'Done',exact:true}).click();}
async function leaveIfPrompt(){if(await button('Leave editor').isVisible())await button('Leave editor').click();}
async function settledCatalog(){await catalog().waitFor();await until(async()=>!(await catalog().getByRole('status').allTextContents()).some(text=>/Loading repositories/.test(text)),{label:'catalog ready'});}
async function openCatalog(owner=false){await button(owner?'asMagicBrain organization':'All repositories').click();await until(async()=>await catalog().isVisible()||await button('Leave editor').isVisible(),{label:'catalog or guard'});await leaveIfPrompt();await settledCatalog();}
async function openRepository(name){await catalog().getByRole('button',{name:'Open repository '+name,exact:true}).click();await leaveIfPrompt();await catalog().waitFor({state:'detached'});await until(async()=>await page.locator('.rc-identity h1').innerText()===name,{label:'repository overview'});}
async function openSearch(name='Search all repositories'){await button(name).click();await dialog().waitFor();assert.equal(await input().evaluate(node=>node===document.activeElement),true);}
async function closeSearch(){await input().press('Escape');await dialog().waitFor({state:'detached'});}
async function results(query){await input().fill(query);await until(async()=>await dialog().locator('[role=listbox]').getAttribute('aria-busy')==='false'&&(await dialog().locator('.ws-search-result').count())>0,{label:'search results '+query});}
async function findFile(repo,filename){await openSearch();await dialog().getByRole('button',{name:'Files',exact:true}).click();await dialog().getByRole('combobox',{name:'Search scope'}).selectOption(repo);await results(filename);await dialog().locator('.ws-search-result').filter({has:page.locator('strong',{hasText:filename})}).first().click();await leaveIfPrompt();await dialog().waitFor({state:'detached'});await until(async()=>await page.locator('.rfe-file-name').innerText().catch(()=> '')===path.basename(filename)||await page.getByRole('textbox',{name:'File path',exact:true}).inputValue().catch(()=> '')===filename,{label:'file opened '+filename});}
async function edit(){if(await button('Edit this file').isVisible()){await until(()=>button('Edit this file').isEnabled(),{label:'edit ready'});await button('Edit this file').click();}await editor().waitFor();}
async function append(value){await editor().click();await editor().press('Meta+ArrowDown');await page.keyboard.insertText(value);}
async function fixtureFile(repo,name,bytes){const filename=path.join(workRoot,repo,name);assert.ok(filename.startsWith(workRoot+path.sep));await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,bytes);fixtureHashes[`${repo}/${name}`]=sha(await fs.readFile(filename));}
async function assertFixtureBytes(){for(const [name,hash]of Object.entries(fixtureHashes)){const filename=path.join(workRoot,name.startsWith(alpha+'/')?renamed+name.slice(alpha.length):name);assert.equal(sha(await fs.readFile(filename)),hash,name+' saved bytes');}assert.deepEqual(await fs.readFile(path.join(workspacePath,'README.md')),initialReadme);}
async function selectedText(){return page.evaluate(()=>window.getSelection()?.toString()??'');}
async function startVideo() {
  cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1440; canvas.height = 1000;
    const context = canvas.getContext('2d'), chunks = [], mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm;codecs=vp8';
    const stream = canvas.captureStream(12), recording = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 1500000});
    window.__asmbSearchQAVideo = {canvas, context, chunks, recording, stream, mime};
    recording.ondataavailable = event => {if (event.data.size) chunks.push(event.data);}; recording.start(1000);
  });
  const state = recorder = {started: Date.now(), frames: 0, dropped: 0, busy: false, frameErrors: 0, listener: null};
  state.listener = async event => {
    void cdp.send('Page.screencastFrameAck', {sessionId: event.sessionId}).catch(() => {});
    if (state.busy) {state.dropped++; return;} state.busy = true;
    try {
      await page.evaluate(async jpeg => {
        const video = window.__asmbSearchQAVideo; if (!video) return;
        const image = new Image(); image.src = 'data:image/jpeg;base64,' + jpeg; await image.decode();
        video.context.drawImage(image, 0, 0, video.canvas.width, video.canvas.height);
      }, event.data); state.frames++;
    } catch {state.frameErrors++;} finally {state.busy = false;}
  };
  cdp.on('Page.screencastFrame', state.listener);
  await cdp.send('Page.startScreencast', {format: 'jpeg', quality: 75, maxWidth: 1440, maxHeight: 1000, everyNthFrame: 1});
}
async function stopVideo() {
  if (!recorder) return;
  const state = recorder; recorder = null;
  await cdp.send('Page.stopScreencast'); cdp.off('Page.screencastFrame', state.listener);
  await until(() => !state.busy, {label: 'Search video frame drain'});
  const result = await page.evaluate(async () => {
    const video = window.__asmbSearchQAVideo;
    await new Promise(resolve => {video.recording.onstop = resolve; video.recording.stop();});
    video.stream.getTracks().forEach(track => track.stop());
    const blob = new Blob(video.chunks, {type: video.mime});
    const base64 = await new Promise(resolve => {const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob);});
    delete window.__asmbSearchQAVideo; return {base64, mime: video.mime};
  });
  const bytes = Buffer.from(result.base64, 'base64'), filename = 'search-explorer-outline-walkthrough.webm';
  await fs.writeFile(path.join(output, filename), bytes); await cdp.detach();
  driver.record('real-search-explorer-outline-walkthrough-recording', {file: filename, mime: result.mime, durationMs: Date.now() - state.started, capturedFrames: state.frames, droppedFrames: state.dropped, frameErrors: state.frameErrors, canvasRate: 12, bytes: bytes.length, scope: 'Regular-width first-launch navigation only; actual native renderer frames encoded with MediaRecorder. Narrow views have separate raw captures. No account/provider or live-profile operation.'});
  assert.ok(bytes.length > 0 && state.frames > 0); assert.equal(state.frameErrors, 0);
}
async function readHeaderGeometry() {
  return page.evaluate(() => {
    const box = element => {const r = element?.getBoundingClientRect(); return element?.checkVisibility() && r.width && r.height ? {x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom} : null;};
    const visible = [...document.querySelectorAll('.fw-titlebar button')].map(element => ({name: element.getAttribute('aria-label') ?? element.textContent.trim(), disabled: element.disabled, ...box(element)})).filter(row => row.width > 0);
    return {viewport: {width: innerWidth, height: innerHeight}, title: box(document.querySelector('.fw-titlebar')), visibleButtons: visible,
      activeControls: ['.rh-home', '.fw-titlebar > [aria-label="Toggle repository sidebar"], .fw-titlebar > [aria-label="Toggle file sidebar"]', '.ra-all-repositories'].map(selector => box(document.querySelector(selector)))};
  });
}
function assertHeaderGeometry(header) {
  near(header.title.height, 41, 'retained titlebar height');
  for (const control of header.activeControls) assert.ok(control && control.width >= 24 && control.x >= 0 && control.right <= header.viewport.width + 1, 'active titlebar control within viewport: ' + JSON.stringify(control));
  for (const control of header.visibleButtons) assert.ok(control.x >= -1 && control.right <= header.viewport.width + 1 && control.y >= 0 && control.bottom <= header.title.bottom + 1, 'visible titlebar button within bounds: ' + JSON.stringify(control));
  for (let i = 0; i < header.visibleButtons.length; i++) for (let j = i + 1; j < header.visibleButtons.length; j++) {
    const a = header.visibleButtons[i], b = header.visibleButtons[j];
    const width = Math.min(a.right, b.right) - Math.max(a.x, b.x), height = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
    assert.ok(width <= 1 || height <= 1, 'visible titlebar buttons overlap: ' + JSON.stringify({a, b, width, height}));
  }
}

async function capture(name){
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const bounds=await page.evaluate(()=>{const box=selector=>{const e=document.querySelector(selector),r=e?.getBoundingClientRect();return e?.checkVisibility()&&r?.width&&r.height?{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}:null;};return{viewport:{width:innerWidth,height:innerHeight},header:box('.fw-titlebar'),tree:box('.wde'),catalog:box('.ar-repositories'),search:box('.ws-search-dialog[open]'),sidebar:box('.rfe-sidebar'),editor:box('.rfe-document-pane'),outline:box('.do-panel')};});
 bounds.branchText=await page.locator('.rfe-path > strong, .rfe-path > span').evaluateAll(nodes=>nodes.filter(node=>node.checkVisibility()&&(node.tagName==='STRONG'||node.textContent.trim()==='in')).map(node=>{const range=document.createRange();range.selectNodeContents(node);return{text:node.textContent,lineFragments:[...range.getClientRects()].map(rect=>({x:rect.x,y:rect.y,width:rect.width,height:rect.height}))};}));bounds.buttons=await readHeaderGeometry();await fs.writeFile(path.join(output,name+'-bounds.json'),JSON.stringify(bounds,null,2));assertHeaderGeometry(bounds.buttons);for(const part of bounds.branchText)assert.equal(part.lineFragments.length,1,'Repository branch context stays legible on one line: '+JSON.stringify(part));
 for(const key of ['search','outline']){const r=bounds[key];if(r)assert.ok(r.x>=-1&&r.right<=bounds.viewport.width+1&&r.y>=0&&r.bottom<=bounds.viewport.height+1,`${key} contained`);}
 await driver.screenshot(name);
 await page.evaluate(bounds=>{const layer=document.createElement('div');layer.id='search-qa-overlay';layer.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483647';for(const [label,key]of [['E1 / V1','header'],['WD1 Work directory','tree'],['AR5 Pins','catalog'],['SE1 Search','search'],['E3 / V4–V5','sidebar'],['Document','editor'],['DO1 Outline','outline']]){const r=bounds[key];if(!r)continue;const b=document.createElement('div'),t=document.createElement('span');b.style.cssText=`position:fixed;box-sizing:border-box;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;border:2px solid #0c7384`;t.textContent=label;t.style.cssText='background:white;color:#084b56;font:700 11px system-ui;padding:2px 4px';b.append(t);layer.append(b);}(document.querySelector('dialog[open]')??document.body).append(layer);},bounds);
 try{await page.screenshot({path:path.join(output,name+'-overlay.png')});}finally{await page.evaluate(()=>document.getElementById('search-qa-overlay')?.remove());}
 driver.record('measured-search-explorer-outline-layout',{name,bounds});
}
async function installTiming(){await driver.app.evaluate(({ipcMain})=>{const original=ipcMain._invokeHandlers.get('asmb:native');if(!original)throw Error('Native handler missing');const state=globalThis.__searchTimingQA={original,seen:[],delivered:[],cancelled:[]};ipcMain.removeHandler('asmb:native');ipcMain.handle('asmb:native',async(event,input)=>{if(input?.method==='cancelRepositorySearch')state.cancelled.push(input.args.requestId);if(input?.method!=='searchRepositoryText')return original(event,input);state.seen.push({query:input.args.query,id:input.args.requestId});const result=await original(event,input);if(input.args.query==='slow-first-marker')await new Promise(resolve=>setTimeout(resolve,900));state.delivered.push({query:input.args.query,id:input.args.requestId});return result;});});}
async function removeTiming(){return driver.app.evaluate(({ipcMain})=>{const state=globalThis.__searchTimingQA;if(!state)return null;ipcMain.removeHandler('asmb:native');ipcMain.handle('asmb:native',state.original);delete globalThis.__searchTimingQA;return{seen:state.seen,delivered:state.delivered,cancelled:state.cancelled};});}
try{
 await launch();initialReadme=await fs.readFile(path.join(workspacePath,'README.md'));
 driver.record('bundled-ripgrep-identity',{metadata:metadata.searchRuntime,version:binaryVersion.trim()});
 // Real managed repository creation through UI; files below are explicit isolated fixture setup.
 for(const name of [alpha,beta]){await openCatalog();await catalog().getByRole('button',{name:'New repository',exact:true}).click();await page.getByLabel('Repository name',{exact:true}).fill(name);await page.locator('.nr-dialog').getByRole('button',{name:'Create repository',exact:true}).click();await page.locator('.nr-dialog').waitFor({state:'detached'});await until(()=>exists(path.join(workRoot,name,'.git')),{label:'new managed fixture repository'});}
 await fixtureFile(alpha,docPath,source);await fixtureFile(alpha,'README.md','# Alpha fixture\n\n'+unicode+' alpha\n');await fixtureFile(alpha,'RELEASE_PLAN.md','# Release plan\n');
 await fixtureFile(alpha,'plain.txt','No headings here.\n');await fixtureFile(alpha,'100% complete.md','# Existing name\n\nexisting-name-marker Ω\n');await fixtureFile(alpha,'notes:2026.md','# Existing colon name\n\nexisting-name-marker Ω\n');await fixtureFile(alpha,'.ordinary-note','hidden ordinary needle\n');
 await fixtureFile(alpha,'.gitignore','ignored/\n');await fixtureFile(alpha,'.ignore','excluded.txt\n');
 await fixtureFile(alpha,'ignored/must-not-match.md','needle\n');await fixtureFile(alpha,'excluded.txt','needle\n');await fixtureFile(alpha,'.asmb-search-fixture/hidden.md','needle\n');await fixtureFile(alpha,'binary.dat',Buffer.from('binary\0needle'));
 await fixtureFile(beta,'README.md','# Beta fixture\n\n'+unicode+' beta\n');
 await fs.writeFile(path.join(output,'outside.txt'),'needle outside admitted repository\n');await fs.symlink(path.join(output,'outside.txt'),path.join(workRoot,alpha,'external-link.txt'));
 execFileSync('/usr/bin/git',['add','--','README.md','RELEASE_PLAN.md','notes/outline.md','plain.txt','.ordinary-note','.gitignore','.ignore','binary.dat'],{cwd:path.join(workRoot,alpha)});
 execFileSync('/usr/bin/git',['-c','user.name=Native QA','-c','user.email=native-qa@example.invalid','commit','-m','Disposable search fixture'],{cwd:path.join(workRoot,alpha)});
 fixtureHead=execFileSync('/usr/bin/git',['rev-parse','HEAD'],{cwd:path.join(workRoot,alpha),encoding:'utf8'}).trim();
 execFileSync('/usr/bin/git',['tag','qa-search-fixture'],{cwd:path.join(workRoot,alpha)});
 driver.record('isolated-corpus-created',{repositories:[alpha,beta],files:Object.keys(fixtureHashes),sourceFixtureSha256:sha(source),fixtureHead,scope:'Host UI creates repositories; direct Test-only writes and local Git seed deterministic saved-file/ignore/binary/symlink corpus.'});
 await mode(false);await openCatalog(true);
 assert.equal(await page.locator('.rh-repository-name strong').innerText(),beta);assert.equal(await button('asMagicBrain organization').getAttribute('aria-current'),'page');
 const names=()=>catalog().locator('.ar-repository-link').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label').replace('Open repository ','')));
 assert.deepEqual(await names(),['Workspace',alpha,beta]);assert.equal(await button('Workspace is always pinned').isDisabled(),true);
 await button('Pin '+beta).click();await until(async()=>await button('Unpin '+beta).isEnabled(),{label:'pin saved'});assert.deepEqual(await names(),['Workspace',beta,alpha]);
 await catalog().getByRole('combobox',{name:'Sort repositories'}).selectOption('desc');assert.equal((await names())[0],'Workspace');
 await catalog().getByRole('combobox',{name:'Sort repositories'}).selectOption('asc');
 await button('Pin '+alpha).click();await until(()=>button('Unpin '+alpha).isEnabled(),{label:'second pin saved'});
 await startVideo();await capture('work-directory-pins-wide');driver.record('mandatory-Workspace-top-and-real-pins-with-both-name-sorts');
 // Arborist lazy folder expansion and keyboard activation invoke actual guarded navigation.
 await button('Expand '+alpha).click();await button('Expand '+alpha+'/notes').waitFor();await button('Expand '+alpha+'/notes').click();
 const treeFile=page.getByRole('treeitem',{name:alpha+'/'+docPath,exact:true});await treeFile.waitFor();const treeControl=page.getByRole('tree',{name:'Work directory',exact:true});await treeControl.focus();await page.keyboard.press('Home');for(let step=0;step<30;step++){if(await treeFile.evaluate(node=>node===document.activeElement))break;await page.keyboard.press('ArrowDown');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));}assert.equal(await treeFile.evaluate(node=>node===document.activeElement),true,'Arborist arrow navigation focuses admitted file');await page.keyboard.press('Enter');
 await catalog().waitFor({state:'detached'});await until(()=>button('Edit this file').isEnabled(),{label:'tree file opened'});assert.equal(await page.locator('.rfe-file-name').innerText(),'outline.md');
 driver.record('Arborist-lazy-real-directory-and-keyboard-file-open');
 // Rename the pinned managed repository; source/Git and stable pin identity must move together.
 await button('Rename repository').click();const renameDialog=page.getByRole('dialog',{name:'Rename repository',exact:true});await renameDialog.getByLabel('Repository name',{exact:true}).fill(renamed);await renameDialog.getByRole('button',{name:'Rename repository',exact:true}).click();await renameDialog.waitFor({state:'detached'});
 await until(()=>exists(path.join(workRoot,renamed,docPath)),{label:'managed rename'});assert.equal(await exists(path.join(workRoot,alpha)),false);
 await openCatalog();assert.equal(await button('Unpin '+renamed).isEnabled(),true);assert.equal((await names())[0],'Workspace');await capture('work-directory-renamed-pin');
 driver.record('managed-rename-preserves-pinned-state-key');
 const inventory=await bridge('listRepositoryFiles',{requestId:crypto.randomUUID(),repo:renamed,ref:''});
 for(const expected of [docPath,'binary.dat','.ordinary-note','ignored/must-not-match.md','excluded.txt','100% complete.md','notes:2026.md'])assert.ok(inventory.paths.includes(expected),expected+' filename admitted');
 assert.ok(!inventory.paths.some(value=>value.includes('.git/')||value.startsWith('.asmb-')||value==='external-link.txt'));
 const historical=await bridge('listRepositoryFiles',{requestId:crypto.randomUUID(),repo:renamed,ref:'refs/tags/qa-search-fixture'});assert.equal(historical.commit,fixtureHead);assert.ok(historical.paths.includes(docPath));assert.ok(!historical.paths.includes('ignored/must-not-match.md'));
 const matches=await bridge('searchRepositoryText',{requestId:crypto.randomUUID(),repo:renamed,query:'needle',caseSensitive:false});
 assert.ok(matches.matches.some(value=>value.path===docPath));assert.ok(matches.matches.some(value=>value.path==='.ordinary-note'));
 assert.ok(!matches.matches.some(value=>['binary.dat','excluded.txt','external-link.txt'].includes(value.path)||value.path.startsWith('ignored/')||value.path.startsWith('.asmb-')));
 const unicodeResult=await bridge('searchRepositoryText',{requestId:crypto.randomUUID(),repo:renamed,query:unicode,caseSensitive:true});const actualMatch=unicodeResult.matches.find(value=>value.path===docPath);assert.equal(actualMatch.line,3);assert.equal(actualMatch.column,1);assert.equal(actualMatch.endColumn,unicode.length+1);
 const noCase=await bridge('searchRepositoryText',{requestId:crypto.randomUUID(),repo:renamed,query:'NEEDLE',caseSensitive:true});assert.equal(noCase.matches.length,0);
 await fs.writeFile(path.join(output,'host-search-results.json'),JSON.stringify({inventory,historical,matches,unicodeResult,noCase},null,2));driver.record('actual-ripgrep-and-inventory-Unicode-case-ignore-binary-private-symlink-ref-contract');
 await openSearch();await results('existing-name-marker');await dialog().locator('.ws-search-result').filter({has:page.locator('strong',{hasText:'100% complete.md'})}).click();await dialog().waitFor({state:'detached'});await until(async()=>await page.locator('.rfe-file-name').innerText()==='100% complete.md',{label:'inspect existing percent filename'});assert.match(await page.locator('.rfe-document-pane').innerText(),/existing-name-marker/);driver.record('existing-nonportable-filename-real-result-open-without-creation-UI');
 await findFile(renamed,docPath);await openSearch('Search files');assert.equal(await dialog().getByRole('combobox',{name:'Search scope'}).inputValue(),renamed);await results(unicode);assert.equal(await dialog().locator('mark').first().innerText(),unicode);await capture('current-repository-content-search');await closeSearch();assert.equal(await button('Search files').evaluate(node=>node===document.activeElement),true);
 await openSearch();assert.equal(await dialog().getByRole('combobox',{name:'Search scope'}).inputValue(),'');await results(unicode);assert.ok((await dialog().locator('.ws-search-result small').allTextContents()).includes(beta));await closeSearch();
 await button('Search documents').click();await dialog().waitFor();assert.equal(await dialog().getByRole('combobox',{name:'Search scope'}).inputValue(),'');await closeSearch();
 driver.record('E1-and-rail-shared-search-E3-current-scope-Escape-focus');
 await openSearch('Go to file');assert.equal(await dialog().getByRole('heading',{name:'Go to file',exact:true}).count(),1);assert.equal(await dialog().getByRole('button',{name:'Contents',exact:true}).count(),0);await results('read');const fuzzyNames=await dialog().locator('strong').allTextContents();assert.ok(fuzzyNames.includes('README.md'));assert.ok(fuzzyNames.includes('RELEASE_PLAN.md'),'fzf matches noncontiguous path characters');await input().press('ArrowDown');const selected=await input().getAttribute('aria-activedescendant');assert.ok(selected);await capture('go-to-file-fuzzy-keyboard');await closeSearch();
 await page.locator('.rh-repository-name').focus();await page.keyboard.press('t');await dialog().waitFor();await results('outline');await input().press('Enter');await dialog().waitFor({state:'detached'});await leaveIfPrompt();
 driver.record('Go-to-file-fzf-separate-dialog-T-keyboard-navigation');
 await installTiming();await openSearch();await input().fill(staleQuery);await until(()=>driver.app.evaluate(()=>globalThis.__searchTimingQA.seen.some(item=>item.query==='slow-first-marker')),{label:'real delayed query started'});await results(freshQuery);await until(()=>driver.app.evaluate(()=>globalThis.__searchTimingQA.delivered.some(item=>item.query==='slow-first-marker')),{label:'old result delivered'});assert.ok((await dialog().locator('pre').allTextContents()).every(text=>text.includes(freshQuery)));await input().fill(staleQuery);await button('Stop').click();assert.match(await dialog().locator('footer').innerText(),/Search stopped/);assert.equal(await dialog().locator('.ws-search-result').count(),0);await closeSearch();const timing=await removeTiming();assert.ok(timing.cancelled.length);driver.record('latest-query-wins-and-Stop-clears-pending-query',{timing,scope:'Only reply timing for slow-first-marker is delayed after the actual production native search. Results, filesystem, ripgrep and service are unchanged. Stop is exercised during the next query debounce; running-worker cancellation is covered by separate host tests.'});
 await page.locator('.rp-trigger').click();await page.locator('.rp-popup').getByRole('tab',{name:'Tags',exact:true}).click();await page.locator('.rp-list').getByRole('button',{name:'qa-search-fixture',exact:true}).click();await until(()=>button('Edit this file').isDisabled(),{label:'historical view read only'});assert.match(await page.locator('.rfe-notice').innerText(),/Historical revision/);await openSearch('Go to file');assert.match(await dialog().locator('.ws-search-controls').innerText(),/qa-search-fixture/);await results('README.md');await input().press('Enter');await dialog().waitFor({state:'detached'});await until(async()=>await page.locator('.rfe-file-name').innerText()==='README.md',{label:'historical file picked'});assert.equal(await button('Edit this file').isDisabled(),true);assert.match(await page.locator('.rp-trigger').innerText(),/qa-search-fixture/);await page.locator('.rp-trigger').click();await page.locator('.rp-popup').getByRole('tab',{name:'Branches',exact:true}).click();const branch=execFileSync('/usr/bin/git',['symbolic-ref','--short','HEAD'],{cwd:path.join(workRoot,renamed),encoding:'utf8'}).trim();await page.locator('.rp-list').getByRole('button').filter({hasText:branch}).click();await until(()=>button('Edit this file').isEnabled(),{label:'working branch restored'});await findFile(renamed,docPath);driver.record('Go-to-file-respects-historical-tag-and-read-only-state');
 await edit();await append(draft);await until(async()=>await sourceText().then(text=>text.includes('Draft live heading')),{label:'live draft'});
 await button('Toggle document outline').click();await page.locator('.do-panel').waitFor();assert.equal(await page.locator('.do-header h2').evaluate(node=>node===document.activeElement),true);
 const titles=await page.locator('.do-entry').allTextContents();assert.equal(titles.length,5);assert.ok(!titles.some(text=>text.includes('Not an outline')));assert.equal(titles.filter(text=>text.includes('Duplicate')).length,2);assert.ok(titles.some(text=>text.includes('Setext heading')));await capture('outline-live-draft-wide');
 const entries=page.locator('.do-entry');await entries.first().focus();await entries.first().press('End');assert.equal(await entries.last().evaluate(node=>node===document.activeElement),true);await entries.last().press('Enter');await until(async()=>await editor().evaluate(node=>node.contains(document.activeElement)||node===document.activeElement),{label:'outline source jump focus'});assert.match(await page.evaluate(()=>{const node=window.getSelection()?.anchorNode;return (node?.nodeType===1?node:node?.parentElement)?.closest?.('.cm-line')?.textContent??'';}),/Draft live heading/);
 await page.getByRole('tab',{name:'Preview',exact:true}).click();await entries.nth(2).click();assert.equal(await page.locator('.rfe-preview #source-heading-3').evaluate(node=>node===document.activeElement),true);
 await page.getByRole('tab',{name:'Edit',exact:true}).click();await button('Close document outline').click();await until(()=>button('Toggle document outline').evaluate(node=>node===document.activeElement),{label:'outline close returns focus after layout'});
 await editor().focus();await editor().press('Meta+f');await page.locator('.cm-search').waitFor();await page.locator('.cm-search input[name=search]').fill('Private draft');await capture('CodeMirror-document-find');await page.locator('.cm-search input[name=search]').press('Escape');await page.locator('.cm-search').waitFor({state:'detached'});
 driver.record('live-Markdown-outline-parser-keyboard-preview-source-jumps-and-CM6-Mod-f');
 // Saved search does not see unsaved draft text, while matching saved text can select in the retained buffer.
 await openSearch();await input().fill('Private draft remains');await until(async()=>await dialog().locator('[role=listbox]').getAttribute('aria-busy')==='false',{label:'saved content search complete'});assert.equal(await dialog().locator('.ws-search-result').count(),0);await results(unicode);await dialog().getByRole('combobox',{name:'Search scope'}).selectOption(renamed);await results(unicode);await dialog().locator('.ws-search-result').filter({has:page.locator('strong',{hasText:docPath})}).click();await leaveIfPrompt();await dialog().waitFor({state:'detached'});await until(async()=>await selectedText()===unicode,{label:'UTF16 source match selected'});assert.match(await sourceText(),/Private draft remains/);
 // Keep editing refuses cross-repository result navigation, then explicit Leave retains the draft.
 await openSearch();await results(unicode);await dialog().getByRole('combobox',{name:'Search scope'}).selectOption(beta);await results(unicode);await dialog().locator('.ws-search-result').first().click();await button('Keep editing').waitFor();await button('Keep editing').click();assert.equal(await page.locator('.rh-repository-name strong').innerText(),renamed);assert.match(await sourceText(),/Private draft remains/);
 await editor().press('Meta+z');assert.doesNotMatch(await sourceText(),/Draft live heading/);await editor().press('Meta+Shift+z');assert.match(await sourceText(),/Draft live heading/);await findFile(beta,'README.md');await findFile(renamed,docPath);await edit();assert.match(await sourceText(),/Private draft remains/);
 driver.record('search-result-draft-guard-preservation-undo-and-saved-content-only');
 // A changed matching line is reported as stale, without replacing the current draft.
 await editor().press('Meta+Home');await editor().press('Meta+a');await page.keyboard.insertText((source+draft).replace(unicode,'Changed draft Unicode line'));
 await openSearch('Search files');await results(unicode);await dialog().locator('.ws-search-result').filter({has:page.locator('strong',{hasText:docPath})}).click();await leaveIfPrompt();await until(async()=>await page.locator('.rfe-notice').allTextContents().then(items=>items.some(value=>value.includes('changed since the search'))),{label:'stale saved result notice'});assert.match(await sourceText(),/Changed draft Unicode line/);await editor().press('Meta+z');assert.match(await sourceText(),/😀 Ω needle/);
 driver.record('stale-saved-line-refuses-incorrect-jump-without-overwriting-draft');
 await button('Toggle document outline').click();await page.locator('.do-panel').waitFor();await stopVideo();await theme('GitHub Dark Default');await resize(390,780);await mode(true);await capture('outline-narrow-dark-hidden');await page.locator('.do-entry').last().click();await page.locator('.do-panel').waitFor({state:'detached'});await resize(360,780);await mode(false);await capture('source-minimum-width-full');
 await resize(1440,1000);await theme('GitHub Light Default');await button('Toggle document outline').click();await page.locator('.do-panel').waitFor();await findFile(renamed,'plain.txt');await page.locator('.do-empty').waitFor();assert.match(await page.locator('.do-empty').innerText(),/No headings/);await mode(true);assert.equal(await button('Toggle document outline').isVisible(),true);assert.equal(await button('Toggle document outline').isDisabled(),true);await mode(false);assert.equal(await button('Toggle document outline').isVisible(),true);assert.equal(await button('Toggle document outline').isDisabled(),true);await capture('outline-disabled-no-headings');await button('Close document outline').click();driver.record('open-outline-empty-state-and-disabled-toggle-visible-in-both-modes');
 await openCatalog();await resize(390,780);await button('Toggle repository sidebar').click();await page.getByRole('dialog',{name:'Repository navigation',exact:true}).waitFor();await capture('work-directory-narrow-drawer');await page.getByRole('dialog',{name:'Repository navigation',exact:true}).press('Escape');await resize(1440,1000);await mode(true);await capture('catalog-hidden-mode-pins');
 await assertFixtureBytes();await closeNormally();driver.record('first-normal-close-preserves-source-private-drafts-and-pins');
 await launch();await openCatalog();assert.equal((await names())[0],'Workspace');assert.equal(await button('Unpin '+renamed).isEnabled(),true);assert.equal(await button('Unpin '+beta).isEnabled(),true);assert.equal(await button('Workspace is always pinned').isDisabled(),true);
 await findFile(renamed,docPath);await edit();assert.match(await sourceText(),/Private draft remains local/);assert.match(await sourceText(),/Draft live heading/);assert.equal(execFileSync('/usr/bin/git',['rev-parse','HEAD'],{cwd:path.join(workRoot,renamed),encoding:'utf8'}).trim(),fixtureHead);await assertFixtureBytes();await capture('restart-restored-draft');await closeNormally();
 assert.deepEqual(driver.errors,[]);assert.deepEqual(errors,[]);assert.deepEqual(networkRequests,[]);driver.record('restart-pins-renamed-identity-draft-Git-source-preservation-and-normal-close');
}catch(error){failure={name:error.name,message:error.message,stack:error.stack};try{if(page&&!page.isClosed()){await fs.writeFile(path.join(output,'failure-dom.txt'),await page.locator('body').innerText());await page.screenshot({path:path.join(output,'failure.png')});}}catch{}throw error;}
finally{
 if(running)try{await removeTiming();await closeNormally();}catch(error){driver.record('normal-cleanup-close-failed',{message:error.message});}
 await driver.report({status:failure?'failed':'passed',failure,sourceDefinition:{path:fileURLToPath(import.meta.url),sha256:sha(definition)},metadata,binaryVersion,fixtureHashes,consoleErrors:errors,networkRequests,scope:'Actual packaged host IPC, bundled ripgrep, native local repositories/pins, fzf, Arborist and CM6. Deterministic stale-query case delays genuine replies only. Offline renderer; no account/provider/network/default-profile access.',limits:'Synthetic local corpus only; no remote GitHub/account workflows or OS-wide network monitoring. Large-resource limits use separate host unit evidence.'});console.log(JSON.stringify({output,status:failure?'failed':'passed'}));
}
