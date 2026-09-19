import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
/** Actual packaged repository management acceptance. Fresh isolated Test data only.
 * Whole-repository actions use production UI/IPC; direct writes are labelled fixture setup. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
assert.deepEqual(process.argv.slice(2),['--run-isolated']);
const appRoot=fileURLToPath(new URL('../../../',import.meta.url));
const testRoot=developmentTestRoot;
process.env.ASMB_ACCEPTANCE_RUN_ROOT??=path.join(testRoot,'runs/native-repository-management-20260918/qa');
assert.ok(process.env.ASMB_PACKAGED_EXECUTABLE,'Supply the root-admitted candidate/final executable.');
const {createDriver,nativeTarget,testRoot:runRoot,until,sha}=await import('./native-driver.mjs');
await fs.mkdir(runRoot,{recursive:true});
const output=await fs.mkdtemp(path.join(runRoot,'repository-management-'));
const data=path.join(output,'data'),workRoot=path.join(data,'workspaces/asMagicBrain'),workspacePath=path.join(workRoot,'Workspace');
const definition=await fs.readFile(fileURLToPath(import.meta.url));
await fs.writeFile(path.join(output,'driver-at-launch.mjs'),definition);
const driver=await createDriver({...nativeTarget(data),output,workspacePath});
const record=driver.record;driver.record=(name,detail)=>{record(name,detail);console.log(JSON.stringify({event:name}));};
const executable=process.env.ASMB_PACKAGED_EXECUTABLE,bundle=executable.slice(0,executable.indexOf('.app/Contents/MacOS/')+4);
const metadata=JSON.parse(await fs.readFile(path.join(bundle,'Contents/Resources/app/native-package.json'),'utf8'));
const original='Management-Source-QA',renamed='Management-Renamed-QA',copy='Management-Copy-QA',restored='Management-Restored-QA',unrelated='Unrelated-QA';
const source='# Repository management fixture\n\nSaved source Ω remains independent of drafts.\n\n## Saved section\n\nBody text.\n';
const draft='\n## Private draft heading\n\nUnsaved retained text Ω.\n';
let page,running=false,failure,recorder,cdp,baseline,documentId,head,rootIdentity;
const errors=[],networkRequests=[];
const button=name=>page.getByRole('button',{name,exact:true});
const catalog=()=>page.locator('.ar-view');
const editor=()=>page.locator('.cm-content[contenteditable=true]');
const row=name=>catalog().locator('.ar-repository-row').filter({has:page.getByRole('button',{name:'Open repository '+name,exact:true})});
const exists=async filename=>Boolean(await fs.lstat(filename).catch(()=>null));
const identity=async filename=>{const stat=await fs.lstat(filename);return `${stat.dev}:${stat.ino}`;};
const git=(repo,...args)=>execFileSync('/usr/bin/git',['--no-pager','-c','core.hooksPath=/dev/null','-C',path.join(workRoot,repo),...args],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',TMPDIR:path.join(output,'tmp'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'}}).trim();
async function inventory(root){
 const files=[];async function visit(relative=''){for(const name of (await fs.readdir(path.join(root,relative))).sort()){
  const key=relative?relative+'/'+name:name,file=path.join(root,key),s=await fs.lstat(file);assert.equal(s.isSymbolicLink(),false,'Synthetic repository has no symlink');
  files.push({path:key,kind:s.isDirectory()?'directory':'file',mode:s.mode&0o777,...(s.isFile()?{bytes:s.size,sha256:sha(await fs.readFile(file))}:{})});if(s.isDirectory())await visit(key);
 }}await visit();return files;
}
async function bridge(method,args){return page.evaluate(async({method,args})=>{const reply=await window.asMagicBrain[method](args);if(!reply.ok)throw Object.assign(Error(`${reply.error.code}: ${reply.error.message}`),{code:reply.error.code});return reply.value;},{method,args});}
const request=(repo,operation,args={})=>bridge('request',{repo,operation,args});
async function launch(){
 page=await driver.launch();running=true;page.setDefaultTimeout(15000);page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});page.on('request',request=>{if(/^https?:/.test(request.url()))networkRequests.push(request.url());});
 await page.context().setOffline(true);await resize(1440,1000);await button('asMagicBrain home').waitFor();await page.locator('.rc-document').waitFor();assert.equal(await page.locator('.rc-page [role=alert]').count(),0);
}
async function resize(width,height=900){await driver.app.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows()[0].setContentSize(width,height),{width,height});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function closeNormally(){await stopVideo();await driver.closeNormally();running=false;}
async function leaveIfPrompt(){if(await button('Leave editor').isVisible())await button('Leave editor').click();}
async function settleCatalog(){await catalog().waitFor();await until(async()=>!(await catalog().getByRole('status').allTextContents()).some(text=>/Loading repositories/.test(text)),{label:'catalog settled'});assert.equal(await catalog().getByRole('button',{name:'Collapse sidebar',exact:true}).count(),0);}
async function openCatalog(){await button('All repositories').click();await until(async()=>await catalog().isVisible()||await button('Leave editor').isVisible(),{label:'catalog or draft guard'});await leaveIfPrompt();await settleCatalog();}
async function openRepository(name){await row(name).getByRole('button',{name:'Open repository '+name,exact:true}).click();await leaveIfPrompt();await catalog().waitFor({state:'detached'});await until(async()=>await page.locator('.rc-identity h1').innerText()===name,{label:'repository selected'});}
async function createRepository(name){await openCatalog();await catalog().getByRole('button',{name:'New repository',exact:true}).click();await page.getByLabel('Repository name',{exact:true}).fill(name);await page.locator('.nr-dialog').getByRole('button',{name:'Create repository',exact:true}).click();await page.locator('.nr-dialog').waitFor({state:'detached'});await until(()=>exists(path.join(workRoot,name,'.git')),{label:'managed fixture repository exists'});}
async function openReadme(){await button('README.md').first().click();await until(()=>button('Edit this file').isEnabled(),{label:'README settled'});}
async function edit(){await button('Edit this file').click();await editor().waitFor();}
async function append(value){await editor().click();await editor().press('Meta+ArrowDown');await page.keyboard.insertText(value);}
async function mode(hide){const target=page.getByRole('switch',{name:'Hide unavailable functions'});await target.focus();if((await target.getAttribute('aria-checked')==='true')!==hide)await target.press('Space');await until(async()=>await target.getAttribute('aria-checked')===String(hide),{label:'availability mode'});assert.equal(await button('Focus document outline').isVisible(),true);}
async function theme(label){await button('asMagicBrain Theme').click();await page.locator('.fw-theme-picker select').selectOption({label});await page.locator('.fw-theme-picker').getByRole('button',{name:'Done',exact:true}).click();}

async function startVideo() {
  cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1440; canvas.height = 1000;
    const context = canvas.getContext('2d'), chunks = [], mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm;codecs=vp8';
    const stream = canvas.captureStream(12), recording = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 1500000});
    window.__asmbRepositoryManagementQAVideo = {canvas, context, chunks, recording, stream, mime};
    recording.ondataavailable = event => {if (event.data.size) chunks.push(event.data);}; recording.start(1000);
  });
  const state = recorder = {started: Date.now(), frames: 0, dropped: 0, busy: false, frameErrors: 0, listener: null};
  state.listener = async event => {
    void cdp.send('Page.screencastFrameAck', {sessionId: event.sessionId}).catch(() => {});
    if (state.busy) {state.dropped++; return;} state.busy = true;
    try {
      await page.evaluate(async jpeg => {
        const video = window.__asmbRepositoryManagementQAVideo; if (!video) return;
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
  await until(() => !state.busy, {label: 'Repository management video frame drain'});
  const result = await page.evaluate(async () => {
    const video = window.__asmbRepositoryManagementQAVideo;
    await new Promise(resolve => {video.recording.onstop = resolve; video.recording.stop();});
    video.stream.getTracks().forEach(track => track.stop());
    const blob = new Blob(video.chunks, {type: video.mime});
    const base64 = await new Promise(resolve => {const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob);});
    delete window.__asmbRepositoryManagementQAVideo; return {base64, mime: video.mime};
  });
  const bytes = Buffer.from(result.base64, 'base64'), filename = 'repository-management-walkthrough.webm';
  await fs.writeFile(path.join(output, filename), bytes); await cdp.detach();
  driver.record('real-repository-management-walkthrough-recording', {file: filename, mime: result.mime, durationMs: Date.now() - state.started, capturedFrames: state.frames, droppedFrames: state.dropped, frameErrors: state.frameErrors, canvasRate: 12, bytes: bytes.length, scope: 'Regular-width first-launch navigation only; actual native renderer frames encoded with MediaRecorder. Narrow views have separate raw captures. No account/provider or live-profile operation.'});
  assert.ok(bytes.length > 0 && state.frames > 0); assert.equal(state.frameErrors, 0);
}

const activeMenu=()=>page.getByRole('menu').filter({visible:true});
const gear=name=>button('Repository actions for '+name);
const mutationDialog=()=>page.locator('.ar-repository-dialog[open], .rfe-repository-rename-dialog[open]');
async function openGear(name,keyboard=false){const target=gear(name);if(keyboard){await target.focus();await target.press('Enter');}else await target.click();await activeMenu().waitFor();return target;}
async function contextRepository(name,keyboard=false){const target=row(name);await target.focus();if(keyboard)await target.press('Shift+F10');else await target.click({button:'right'});await activeMenu().waitFor();return target;}
async function closeMenu(target){await activeMenu().press('Escape');await activeMenu().waitFor({state:'detached'});if(target)await until(()=>target.evaluate(node=>node===document.activeElement),{label:'menu returns focus to its trigger'});}
async function menuSignature(){return activeMenu().getByRole('menuitem').evaluateAll(nodes=>nodes.map(node=>({label:node.textContent.trim(),disabled:node.getAttribute('aria-disabled')==='true'||node.hasAttribute('data-disabled')})));}
async function choose(label){await activeMenu().getByRole('menuitem',{name:label,exact:true}).click();}
async function namedMutation(name,command,newName,{context=false}={}){if(context)await contextRepository(name);else await openGear(name);await choose(command);await mutationDialog().waitFor();await mutationDialog().getByLabel('Repository name',{exact:true}).fill(newName);await mutationDialog().getByRole('button',{name:command==='Rename'?'Rename repository':'Duplicate repository',exact:true}).click();await mutationDialog().waitFor({state:'detached',timeout:30000});await settleCatalog();}
async function openTreeRootMenu(){const target=page.getByRole('treeitem',{name:'asMagicBrain work directory',exact:true});await target.click({button:'right'});await activeMenu().waitFor();return target;}
async function expand(repo,relative=''){const label=[repo,relative].filter(Boolean).join('/');const control=button('Expand '+label);if(await control.isVisible())await control.click();await until(async()=>!(await page.locator('.wde [role=status]').allTextContents()).some(value=>/Loading/.test(value)),{label:'work-directory folder loaded'});}
async function treeContext(repo,relative,keyboard=false){const target=page.getByRole('treeitem',{name:repo+'/'+relative,exact:true});await target.focus();if(keyboard)await target.press('Shift+F10');else await target.click({button:'right'});await activeMenu().waitFor();return target;}
async function capture(name){
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const bounds=await page.evaluate(()=>{
  const box=selector=>{const e=document.querySelector(selector),r=e?.getBoundingClientRect();return e?.checkVisibility()&&r?.width&&r.height?{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}:null;};
  const buttons=[...document.querySelectorAll('.fw-titlebar button')].filter(e=>e.checkVisibility()).map(e=>{const r=e.getBoundingClientRect();return {label:e.getAttribute('aria-label')??e.textContent.trim(),x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};});
  return {viewport:{width:innerWidth,height:innerHeight},header:box('.fw-titlebar'),main:box('.fw-main'),outline:box('.do-panel'),tree:box('.wde'),rows:box('.ar-repositories'),menu:box('.ar-actions-menu[data-state=open]'),dialog:box('.ar-repository-dialog[open],.rfe-repository-rename-dialog[open],.rfe-management-dialog[open]'),buttons};
 });
 await fs.writeFile(path.join(output,name+'-bounds.json'),JSON.stringify(bounds,null,2));
 for(const item of bounds.buttons)assert.ok(item.x>=-1&&item.right<=bounds.viewport.width+1&&item.bottom<=bounds.header.bottom+1,'titlebar control contained: '+JSON.stringify(item));
 for(let i=0;i<bounds.buttons.length;i++)for(let j=i+1;j<bounds.buttons.length;j++){const a=bounds.buttons[i],b=bounds.buttons[j];assert.ok(Math.min(a.right,b.right)-Math.max(a.x,b.x)<=1||Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)<=1,'titlebar buttons do not overlap: '+a.label+' / '+b.label);}
 for(const key of ['menu','dialog','outline']){const b=bounds[key];if(b)assert.ok(b.x>=-1&&b.y>=0&&b.right<=bounds.viewport.width+1&&b.bottom<=bounds.viewport.height+1,key+' is contained');}
 assert.ok(bounds.outline,'Outline panel remains visible');
 if(bounds.viewport.width<=760){assert.ok(bounds.main.bottom<=bounds.outline.y+1,'narrow outline docks below rather than obscuring document');assert.ok(bounds.outline.height<=Math.min(170,bounds.viewport.height*.28)+1,'narrow outline remains bounded');assert.ok(bounds.main.height>=250,'narrow document remains usable');}
 await driver.screenshot(name);
 await page.evaluate(bounds=>{const layer=document.createElement('div');layer.id='repository-management-qa-overlay';layer.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483647';for(const[label,key]of [['E1 / V1','header'],['WD1','tree'],['AR5','rows'],['RM1 Management menu','menu'],['RM2 Management dialog','dialog'],['DO1 Outline','outline']]){const r=bounds[key];if(!r)continue;const item=document.createElement('div'),title=document.createElement('span');item.style.cssText=`position:fixed;box-sizing:border-box;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;border:1px solid #006c70`;title.textContent=label;title.style.cssText='background:white;color:#006c70;font:700 10px system-ui;padding:1px 3px';item.append(title);layer.append(item);}(document.querySelector('dialog[open]')??document.body).append(layer);},bounds);
 try{await page.screenshot({path:path.join(output,name+'-overlay.png')});}finally{await page.evaluate(()=>document.getElementById('repository-management-qa-overlay')?.remove());}
 driver.record('measured-management-outline-capture',{name,bounds});
}


async function assertOutlineEmpty(){assert.equal(await page.locator('.do-panel').isVisible(),true);assert.equal(await page.locator('.do-entry').count(),0);assert.equal(await button('Focus document outline').isDisabled(),true);assert.equal(await button('Close document outline').count(),0);}
async function assertOriginal(repo){
 assert.equal(await identity(path.join(workRoot,repo)),rootIdentity,'original repository directory identity preserved');
 assert.deepEqual(await inventory(path.join(workRoot,repo)),baseline.original,'original source and Git bytes/modes preserved');
 const retained=await request(repo,'open',{path:'README.md'});assert.equal(retained.documentId,documentId);assert.equal(retained.text,source);assert.equal(retained.draft?.text,source+draft);assert.equal(git(repo,'rev-parse','HEAD'),head);
}
async function assertUnrelated(){assert.deepEqual(await inventory(path.join(workRoot,unrelated)),baseline.unrelated,'unrelated saved/Git files and modes unchanged');assert.deepEqual(await inventory(workspacePath),baseline.workspace,'default saved/Git files and modes unchanged');}
async function showReadmeFromCatalog(name){await openRepository(name);await openReadme();}
try{
 assert.equal(metadata.version,'0.2.3');
 await launch();assert.equal(await page.locator('.do-panel').isVisible(),true);assert.equal(await page.locator('.do-header h2').evaluate(node=>node===document.activeElement),false,'initial outline does not steal focus');
 // Actual UI creates managed bindings. Synthetic file/Git population below is setup only.
 for(const name of [original,unrelated])await createRepository(name);
 for(const name of [original,unrelated]){
  const root=path.join(workRoot,name);await fs.mkdir(path.join(root,'notes'),{mode:0o700});await fs.mkdir(path.join(root,'destination'),{mode:0o700});
  await fs.writeFile(path.join(root,'README.md'),name===original?source:'# Unrelated repository\n\nPreserve these bytes.\n',{mode:0o600});
  await fs.writeFile(path.join(root,'notes/second.md'),'# Nested saved file\n\nSecond file Ω.\n',{mode:0o600});await fs.writeFile(path.join(root,'plain.txt'),'No Markdown headings here.\n',{mode:0o600});await fs.writeFile(path.join(root,'asset.bin'),Buffer.from([0,1,2,127,255,0,42]),{mode:0o600});
  git(name,'add','--all');git(name,'-c','user.name=Native Management QA','-c','user.email=management@example.invalid','commit','--quiet','-m','Synthetic initial history');
  await fs.writeFile(path.join(root,'history.txt'),'Second commit preserved.\n',{mode:0o600});git(name,'add','history.txt');git(name,'-c','user.name=Native Management QA','-c','user.email=management@example.invalid','commit','--quiet','-m','Synthetic second history');git(name,'branch','qa-history');git(name,'tag','qa-history-tag');
 }
 driver.record('isolated-managed-fixture-setup',{repositories:[original,unrelated],scope:'UI created production managed bindings; explicit local files and two-commit branches/tags are disposable fixture setup. No remote.'});
 await openCatalog();await showReadmeFromCatalog(original);await edit();await editor().focus();await editor().press('Meta+a');await page.keyboard.insertText(source+draft);await openCatalog();
 const opened=await request(original,'open',{path:'README.md'});documentId=opened.documentId;assert.equal(opened.draft.text,source+draft);assert.equal(opened.text,source);head=git(original,'rev-parse','HEAD');rootIdentity=await identity(path.join(workRoot,original));
 baseline={original:await inventory(path.join(workRoot,original)),unrelated:await inventory(path.join(workRoot,unrelated)),workspace:await inventory(workspacePath),history:git(original,'rev-list','--all','--objects'),refs:git(original,'for-each-ref','--format=%(refname) %(objectname)')};await fs.writeFile(path.join(output,'fixture-baseline.json'),JSON.stringify(baseline,null,2));
 await startVideo();
 for(const hide of [false,true]){
  await mode(hide);await assertOutlineEmpty();const trigger=await openGear(original,true),gearItems=await menuSignature();await closeMenu(trigger);const target=await contextRepository(original),contextItems=await menuSignature();assert.deepEqual(contextItems,gearItems);await closeMenu(target);
  await contextRepository(original,true);assert.deepEqual(await menuSignature(),gearItems);await closeMenu(row(original));
  const move=gearItems.find(item=>item.label==='Move to…');if(hide)assert.equal(move,undefined);else assert.equal(move?.disabled,true);
  assert.equal(gearItems.find(item=>item.label==='Move to Trash')?.disabled,false);driver.record('gear-pointer-keyboard-context-parity',{hideUnavailable:hide,items:gearItems});
 }
 await mode(false);await openGear(original);await capture('repository-gear-wide');await closeMenu(gear(original));const workDirectory=page.locator('.wde');assert.equal(await workDirectory.evaluate(node=>node.tabIndex),-1);const workBox=await workDirectory.boundingBox();await workDirectory.click({button:'right',position:{x:workBox.width-8,y:workBox.height-8}});await page.getByRole('menu',{name:'Work directory actions',exact:true}).waitFor();await closeMenu(workDirectory);driver.record('blank-work-directory-context-Escape-restores-programmatic-section-focus');
 await button('Unpin '+original).isVisible().then(async pinned=>{if(!pinned)await button('Pin '+original).click();});await until(()=>button('Unpin '+original).isEnabled(),{label:'pin persisted'});
 // Merely opening and cancelling the catalog menus must retain the mounted buffer and undo.
 await catalog().locator('.ar-return').click();await editor().waitFor();await editor().press('Meta+z');assert.doesNotMatch(await editor().innerText(),/Private draft heading/);await editor().press('Meta+Shift+z');assert.match(await editor().innerText(),/Private draft heading/);
 // A hidden filename intent must reject whole-repository mutation, rather than disappear.
 await page.getByRole('textbox',{name:'File path',exact:true}).fill('unsaved-name.md');await openCatalog();await openGear(original);await choose('Duplicate…');await mutationDialog().waitFor();await mutationDialog().getByLabel('Repository name',{exact:true}).fill(copy);await mutationDialog().getByRole('button',{name:'Duplicate repository',exact:true}).click();await mutationDialog().getByRole('alert').waitFor();assert.match(await mutationDialog().getByRole('alert').innerText(),/filename|file name|path/i);assert.equal(await exists(path.join(workRoot,copy)),false);await mutationDialog().getByRole('button',{name:'Cancel',exact:true}).click();await catalog().locator('.ar-return').click();await editor().waitFor();assert.equal(await page.getByRole('textbox',{name:'File path',exact:true}).inputValue(),'unsaved-name.md');await page.getByRole('textbox',{name:'File path',exact:true}).fill('README.md');await openCatalog();driver.record('menu-cancel-preserves-undo-and-hidden-filename-intent-blocks-mutation');
 // Rename via the same context actions; retained draft and stable pin follow it.
 await namedMutation(original,'Rename',renamed,{context:true});assert.equal(await exists(path.join(workRoot,original)),false);await until(()=>button('Unpin '+renamed).isEnabled(),{label:'pin follows renamed identity'});await assertOriginal(renamed);driver.record('context-rename-retains-source-history-draft-identity-and-pin');
 // Default safety follows a renamed identity, and is enforced by the actual host too.
 await namedMutation('Workspace','Rename','Default-Renamed-QA');for(const hide of [false,true]){await mode(hide);await openGear('Default-Renamed-QA');assert.equal((await menuSignature()).find(item=>item.label==='Move to Trash')?.disabled,true);await closeMenu(gear('Default-Renamed-QA'));}
 const refusal=await page.evaluate(async()=>window.asMagicBrain.trashRepository({repository:'Default-Renamed-QA',requestId:crypto.randomUUID()}));assert.equal(refusal.ok,false);assert.match(refusal.error.code,/DEFAULT/);await namedMutation('Default-Renamed-QA','Rename','Workspace');assert.equal(await button('Workspace is always pinned').isDisabled(),true);driver.record('renamed-default-repository-protected-in-menu-and-host');
 // Failed destination preserves everything; the same dialog can then publish a valid independent copy.
 await mode(false);await openGear(renamed);await choose('Duplicate…');await mutationDialog().waitFor();assert.match(await mutationDialog().innerText(),/Unsaved drafts stay with the original/);await mutationDialog().getByLabel('Repository name',{exact:true}).fill(unrelated);await mutationDialog().getByRole('button',{name:'Duplicate repository',exact:true}).click();await mutationDialog().getByRole('alert').waitFor();assert.match(await mutationDialog().getByRole('alert').innerText(),/already|uses this name/i);await assertOriginal(renamed);await assertUnrelated();await mutationDialog().getByLabel('Repository name',{exact:true}).fill(copy);await capture('duplicate-repository-dialog');await mutationDialog().getByRole('button',{name:'Duplicate repository',exact:true}).click();await mutationDialog().waitFor({state:'detached',timeout:30000});await settleCatalog();
 assert.notEqual(await identity(path.join(workRoot,copy)),rootIdentity);assert.equal(git(copy,'rev-parse','HEAD'),head);assert.equal(git(copy,'rev-list','--all','--objects'),baseline.history);assert.equal(git(copy,'for-each-ref','--format=%(refname) %(objectname)'),baseline.refs);for(const file of baseline.original.filter(item=>item.kind==='file'&&!item.path.startsWith('.git/'))){assert.equal(sha(await fs.readFile(path.join(workRoot,copy,file.path))),file.sha256);}
 const copied=await request(copy,'open',{path:'README.md'});assert.equal(copied.text,source);assert.equal(copied.draft,null);assert.notEqual(copied.documentId,documentId);assert.deepEqual((await bridge('bootstrap',copy)).newDrafts,[]);assert.deepEqual(await request(copy,'listTrash'),[]);assert.equal(await button('Pin '+copy).isEnabled(),true);assert.equal((await bridge('getRepositoryUpdates',{repo:copy})).eligible,false);await assertOriginal(renamed);driver.record('duplicate-copies-saved-bytes-complete-Git-history-with-independent-unpinned-private-identity');
 // Independent edits to the copied repository never publish into the original draft/source.
 await showReadmeFromCatalog(copy);await edit();await append('\nIndependent copy edit.\n');await button('Save').click();await until(async()=>String(await fs.readFile(path.join(workRoot,copy,'README.md'))).includes('Independent copy edit.'),{label:'copy Save completed'});await assertOriginal(renamed);driver.record('copy-edits-and-Save-independent-of-original');
 // Nested tree context actions delegate to the existing file manager.
 await openCatalog();await expand(copy);await expand(copy,'notes');const nested=await treeContext(copy,'notes/second.md',true);const nestedActions=await menuSignature();assert.ok(nestedActions.some(item=>item.label==='Rename'&&!item.disabled));await capture('nested-file-context-wide');await choose('Rename');await leaveIfPrompt();const renameItem=page.getByRole('dialog',{name:'Rename item',exact:true});await renameItem.waitFor();await renameItem.getByLabel('Name',{exact:true}).fill('renamed-note.md');await renameItem.getByRole('button',{name:'Rename',exact:true}).click();await renameItem.waitFor({state:'detached'});assert.equal(await exists(path.join(workRoot,copy,'notes/second.md')),false);assert.equal(await fs.readFile(path.join(workRoot,copy,'notes/renamed-note.md'),'utf8'),'# Nested saved file\n\nSecond file Ω.\n');
 await openCatalog();await expand(copy);await expand(copy,'notes');await treeContext(copy,'notes/renamed-note.md');await choose('Copy path');await activeMenu().waitFor({state:'detached'});assert.equal(await driver.app.evaluate(({clipboard})=>clipboard.readText()),'notes/renamed-note.md');await treeContext(copy,'notes/renamed-note.md');await choose('Move to…');await leaveIfPrompt();const moveItem=page.getByRole('dialog',{name:'Move to folder',exact:true});await moveItem.waitFor();await moveItem.getByLabel('Destination folder',{exact:true}).fill('destination');await moveItem.getByRole('button',{name:'Move',exact:true}).click();await moveItem.waitFor({state:'detached'});assert.equal(await exists(path.join(workRoot,copy,'notes/renamed-note.md')),false);assert.equal(await fs.readFile(path.join(workRoot,copy,'destination/renamed-note.md'),'utf8'),'# Nested saved file\n\nSecond file Ω.\n');await openCatalog();await expand(copy);await treeContext(copy,'destination');assert.ok((await menuSignature()).some(item=>item.label==='Duplicate'&&!item.disabled));await choose('Duplicate');await leaveIfPrompt();await until(()=>exists(path.join(workRoot,copy,'destination copy/renamed-note.md')),{label:'nested folder duplicate completed'});await until(async()=>!(await page.locator('.rfe-main').evaluate(node=>node.inert))&&(await page.locator('.rfe-notice').allTextContents()).some(text=>text.includes('Copied 1 item.')),{label:'folder duplicate UI completion and editor unlock'});assert.equal(await fs.readFile(path.join(workRoot,copy,'destination copy/renamed-note.md'),'utf8'),'# Nested saved file\n\nSecond file Ω.\n');await assertOriginal(renamed);driver.record('nested-file-keyboard-context-Rename-Copy-path-Move-and-folder-Duplicate-use-real-file-manager');
 // Outline is a permanent surface, follows live draft, and returns focus without closing.
 await openCatalog();await showReadmeFromCatalog(renamed);await edit();await until(async()=>await page.locator('.do-entry').allTextContents().then(items=>items.some(item=>item.includes('Private draft heading'))),{label:'outline follows restored draft'});await button('Focus document outline').click();await until(()=>page.locator('.do-header h2').evaluate(node=>node===document.activeElement),{label:'outline header focus'});await page.locator('.do-header h2').press('End');await page.locator('.do-entry').last().press('Enter');await until(()=>editor().evaluate(node=>node.contains(document.activeElement)),{label:'outline selects live source'});assert.equal(await page.locator('.do-panel').isVisible(),true);await button('Focus document outline').click();const editorFocusState=await editor().evaluate(node=>({tabIndex:node.tabIndex,attribute:node.getAttribute('tabindex')}));await page.locator('.do-header h2').press('Escape');await until(()=>editor().evaluate(node=>node.contains(document.activeElement)),{label:'outline Escape returns source focus'});assert.deepEqual(await editor().evaluate(node=>({tabIndex:node.tabIndex,attribute:node.getAttribute('tabindex')})),editorFocusState,'outline Escape preserves CM6 natural tab focus');driver.record('outline-Escape-retains-CM6-tab-focus',{before:editorFocusState,after:await editor().evaluate(node=>({tabIndex:node.tabIndex,attribute:node.getAttribute('tabindex')}))});assert.equal(await button('Close document outline').count(),0);await capture('permanent-outline-live-draft-wide');
 await stopVideo();await theme('GitHub Dark Default');await resize(390,780);await mode(true);await capture('permanent-outline-narrow-dark');await resize(360,780);await mode(false);await capture('permanent-outline-minimum-width-full');await resize(1440,1000);await theme('GitHub Light Default');
 await openCatalog();await assertOutlineEmpty();await button('asMagicBrain home').click();await page.locator('.wh-view').waitFor();await assertOutlineEmpty();await openCatalog();await openRepository(copy);await button('plain.txt').first().click();await until(()=>button('Edit this file').isEnabled(),{label:'plain file ready'});for(const hide of [true,false]){await mode(hide);await assertOutlineEmpty();}await capture('permanent-outline-no-headings');driver.record('permanent-outline-live-selection-focus-Escape-empty-contexts-and-both-mode-narrow-layout');
 await openCatalog();await theme('GitHub Dark Default');await resize(390,780);await mode(false);await openGear(copy);await capture('repository-menu-narrow-dark');await closeMenu(gear(copy));await button('Toggle repository sidebar').click();const drawer=page.getByRole('dialog',{name:'Repository navigation',exact:true});await drawer.waitFor();await openTreeRootMenu();await capture('root-context-inside-narrow-drawer');await activeMenu().press('Escape');await activeMenu().waitFor({state:'detached'});assert.equal(await drawer.isVisible(),true,'menu Escape preserves the underlying navigation drawer');await drawer.press('Escape');await drawer.waitFor({state:'hidden'});await until(()=>button('Toggle repository sidebar').evaluate(node=>node===document.activeElement),{label:'drawer Escape restores header focus'});await resize(1440,1000);await theme('GitHub Light Default');driver.record('narrow-menus-contained-and-Escape-closes-menu-before-drawer');
 // Trash the active original while its retained draft exists; Cancel is side-effect free.
 await openCatalog();await showReadmeFromCatalog(renamed);await edit();await openCatalog();await openGear(renamed);await choose('Move to Trash');await mutationDialog().waitFor();await mutationDialog().getByRole('button',{name:'Cancel',exact:true}).click();await assertOriginal(renamed);await openGear(renamed);await choose('Move to Trash');await mutationDialog().waitFor();await capture('trash-repository-confirmation');await mutationDialog().getByRole('button',{name:'Move to Trash',exact:true}).click();await mutationDialog().waitFor({state:'detached',timeout:30000});await until(async()=>await row(renamed).count()===0,{label:'trashed repository removed from catalog'});assert.equal(await exists(path.join(workRoot,renamed)),false);const trash=await bridge('listTrashedRepositories');assert.equal(trash.filter(item=>item.name===renamed).length,1);assert.equal(await page.locator('.rh-repository-name strong').innerText(),'Workspace');await assertUnrelated();await closeNormally();driver.record('active-repository-Trash-retains-private-work-and-closes-normally',{trashId:trash.find(item=>item.name===renamed).trashId});
 // Restart with the repository in Trash, then force an explicit restore name collision.
 await launch();await openCatalog();assert.equal(await row(renamed).count(),0);assert.equal((await bridge('listTrashedRepositories')).filter(item=>item.name===renamed).length,1);await createRepository(renamed);const collisionBefore=await inventory(path.join(workRoot,renamed));await openCatalog();await openTreeRootMenu();await choose('Restore repository…');await mutationDialog().waitFor();await mutationDialog().getByRole('button',{name:'Choose '+renamed+' to restore',exact:true}).click();await mutationDialog().getByRole('button',{name:'Restore repository',exact:true}).click();await mutationDialog().getByRole('alert').waitFor();assert.match(await mutationDialog().getByRole('alert').innerText(),/already|uses this name/i);assert.deepEqual(await inventory(path.join(workRoot,renamed)),collisionBefore);await mutationDialog().getByLabel('Repository name',{exact:true}).fill(restored);await capture('restore-repository-collision-alternate-name');await mutationDialog().getByRole('button',{name:'Restore repository',exact:true}).click();await mutationDialog().waitFor({state:'detached',timeout:30000});await settleCatalog();await assertOriginal(restored);await until(()=>button('Unpin '+restored).isEnabled(),{label:'restored stable pin'});assert.equal((await bridge('listTrashedRepositories')).filter(item=>item.name===renamed).length,0);assert.deepEqual(await inventory(path.join(workRoot,renamed)),collisionBefore);driver.record('restart-restore-alternate-name-retains-original-inode-history-draft-identity-pin-and-collision');
 await showReadmeFromCatalog(restored);await edit();assert.match(await editor().innerText(),/Private draft heading/);await capture('restored-private-draft-final');await assertOriginal(restored);await assertUnrelated();assert.match(await fs.readFile(path.join(workRoot,copy,'README.md'),'utf8'),/Independent copy edit/);assert.equal(git(copy,'rev-parse','HEAD'),head);await closeNormally();
 assert.deepEqual(driver.errors,[]);assert.deepEqual(errors,[]);assert.deepEqual(networkRequests,[]);
}catch(error){failure={message:error.message,stack:error.stack};process.exitCode=1;console.error(error.stack);try{await driver.screenshot('failure');await fs.writeFile(path.join(output,'failure-dom.txt'),await page.locator('body').innerText());}catch{}}
finally{
 if(running)try{await closeNormally();}catch(error){failure??={message:error.message,stack:error.stack};process.exitCode=1;}
 await driver.report({status:failure?'failed':'passed',failure,sourceDefinition:{path:fileURLToPath(import.meta.url),sha256:sha(definition)},metadata,consoleErrors:errors,networkRequests,scope:'Actual isolated packaged repository gear/context/menu/dialog workflows and production host services; permanent outline layout/focus. Synthetic managed local Git corpus and private draft only. No default/live profile, credentials, remote operations or real OS Trash.',limits:'Low-level interrupted copy/publication, unknown destination, storage failure and Git-safety cases remain covered by host tests; the native campaign checks ordinary UI persistence and preserved bytes.'});console.log(JSON.stringify({output,status:failure?'failed':'passed'}));
}
