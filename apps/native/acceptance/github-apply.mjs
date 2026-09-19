import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
/** Packaged reviewed fast-forward updates in a disposable Test profile. No remote writes. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const driverSource = await fs.readFile(fileURLToPath(import.meta.url));
const definitionSha256 = createHash('sha256').update(driverSource).digest('hex');
const testRoot = developmentTestRoot;
const runRoot = path.join(testRoot, 'runs/native-github-apply-20260917/ui');
const executable = process.env.ASMB_PACKAGED_EXECUTABLE;
assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
assert.ok(executable && path.isAbsolute(executable) && executable.includes('.app/Contents/MacOS/'), 'Supply ASMB_PACKAGED_EXECUTABLE.');
assert.ok(executable.startsWith(appRoot + 'releases/') || executable.startsWith(testRoot + '/runs/'), 'Use an isolated candidate or a retained release.');
const bundle = executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
const metadata = JSON.parse(await fs.readFile(bundle + '/Contents/Resources/app/native-package.json', 'utf8'));
import {_electron} from '../../../tools/playwright.mjs';
await fs.mkdir(runRoot, {recursive: true});
const output = await fs.mkdtemp(runRoot + '/acceptance-'), data = output + '/data', tmp = output + '/tmp';
await fs.mkdir(tmp);
await fs.writeFile(output + '/driver-at-launch.mjs', driverSource);
const sourceUrl = 'https://github.com/ancorasir/asTeach-App';
let repo = 'GitHub-Apply-QA';
let repositoryPath = data + '/workspaces/asMagicBrain/' + repo;
const events = [], errors = [];
let application, page, failure, cdp, recorder, launches = 0;
const record = (name, details = {}) => events.push({name, at: new Date().toISOString(), ...details});
const button = name => page.getByRole('button', {name, exact: true});
const git = (...args) => execFileSync('/usr/bin/git', ['-C', repositoryPath, ...args], {encoding: 'utf8', env: {PATH: '/usr/bin:/bin', TMPDIR: tmp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0'}}).trim();
async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout; let result;
  do {try {result = await check(); if (result) return result;} catch (error) {result = error.message;} await new Promise(resolve => setTimeout(resolve, 80));} while (Date.now() < end);
  throw Error(`Timeout ${label}: ${result}`);
}
async function launch() {
  application = await _electron.launch({executablePath: executable, args: ['--test-data-root=' + data], cwd: output, env: {PATH: process.env.PATH, TMPDIR: tmp}});
  page = await application.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await button(/^Switch local repository:/).waitFor();
  const runtime = await application.evaluate(({app}) => ({packaged: app.isPackaged, exe: process.execPath, profile: app.getPath('userData'), version: app.getVersion()}));
  assert.equal(runtime.packaged, true); assert.equal(runtime.exe, executable); assert.equal(runtime.profile, data + '-electron-profile');
  record('actual-packaged-launch', {runtime}); launches++;

}
async function startVideo(){
 await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=1440;canvas.height=1000;const context=canvas.getContext('2d'),chunks=[],mime=MediaRecorder.isTypeSupported('video/webm;codecs=vp9')?'video/webm;codecs=vp9':'video/webm;codecs=vp8';const stream=canvas.captureStream(12),recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:1500000});window.__asmbQaVideo={canvas,context,chunks,recorder,stream,started:Date.now(),mime};recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.start(1000);});
 recorder={started:Date.now(),frames:0,dropped:0,busy:false,listener:null};const state=recorder;
 state.listener=async event=>{void cdp.send('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(()=>{});if(state.busy){state.dropped++;return;}state.busy=true;try{await page.evaluate(async jpeg=>{const v=window.__asmbQaVideo;if(!v)return;const img=new Image();img.src='data:image/jpeg;base64,'+jpeg;await img.decode();v.context.drawImage(img,0,0,v.canvas.width,v.canvas.height);},event.data);state.frames++;}catch(error){state.frameErrors??=[];state.frameErrors.push(String(error));}finally{state.busy=false;}};
 cdp.on('Page.screencastFrame',state.listener);await cdp.send('Page.startScreencast',{format:'jpeg',quality:75,maxWidth:1440,maxHeight:1000,everyNthFrame:1});
}
async function stopVideo(){if(!recorder)return;const state=recorder;await cdp.send('Page.stopScreencast');cdp.off('Page.screencastFrame',state.listener);await until(()=>!state.busy,'video frame drained');const result=await page.evaluate(async()=>{const v=window.__asmbQaVideo;await new Promise(resolve=>{v.recorder.onstop=resolve;v.recorder.stop();});v.stream.getTracks().forEach(t=>t.stop());const blob=new Blob(v.chunks,{type:v.mime}),base64=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(blob);});delete window.__asmbQaVideo;return{base64,mime:v.mime};});const filename='apply-walkthrough.webm';await fs.writeFile(path.join(output,filename),Buffer.from(result.base64,'base64'));record('real-gesture-recording',{file:filename,mime:result.mime,durationMs:Date.now()-state.started,capturedFrames:state.frames,droppedFrames:state.dropped,frameErrors:state.frameErrors??[],canvasRate:12,method:'Actual CDP screencast frames encoded through browser MediaRecorder; no reenactment.'});recorder=null;}

async function close() {
  await stopVideo();
  const closed = application.waitForEvent('close', {timeout: 20000});
  await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].close()).catch(error => {if (!/closed|destroyed/i.test(String(error))) throw error;});
  await closed; application = null; record('normal-native-close');
}
async function select(name) {
  await button(/^Switch local repository:/).click(); await page.locator('.rh-list').getByRole('button', {name: new RegExp('\\b' + name + '\\b')}).click();
  if (await button('Leave editor').isVisible()) await button('Leave editor').click();
  await until(() => page.locator('.rc-identity h1').innerText().then(text => text === name), 'repository ' + name);
}
async function mode(enabled) {const toggle = page.getByRole('switch', {name: 'Hide unavailable functions'}); if ((await toggle.getAttribute('aria-checked') === 'true') !== enabled) await toggle.click();}
async function theme(label) {await button('asMagicBrain Theme').click(); await page.locator('.fw-theme-picker select').selectOption({label}); await page.locator('.fw-theme-picker').getByRole('button', {name: 'Done', exact: true}).click();}
async function importDialog() {
  await button('Create new options').click(); await button('Import repository').click();
  await until(async () => await page.locator('.zi-dialog').isVisible() || await button('Leave editor').isVisible(), 'import or preserved draft confirmation');
  if (await button('Leave editor').isVisible()) {await button('Leave editor').click(); record('draft-preservation-confirmed-before-import');}
  await page.locator('.zi-dialog').waitFor();
  assert.equal(await button('Import ZIP').getAttribute('aria-pressed'), 'true');
}
async function appendDraft(text) {
  const editor = page.locator('.cm-content[contenteditable=true]'); await editor.waitFor(); await editor.click(); await editor.press('Meta+ArrowDown'); await page.keyboard.insertText(text);
}
async function capture(name, overlay = false) {
  await page.screenshot({path: output + '/' + name + '.png'});
  if (overlay) {
    const areas = await page.evaluate(() => [
      ['GU1 identity', '.ru-dialog > header'], ['GU2 source', '.ru-source'],
      ['GU3 access/scope', '.ru-access'], ['GU4 history and apply review', '.ru-result'],
      ['GU5 file comparison', '.ru-files'], ['GU6 feedback', '.zi-progress'], ['GU7 actions', '.ru-dialog > footer'],
    ].flatMap(([name, selector]) => {const element = document.querySelector(selector), r = element?.getBoundingClientRect(); return r && r.width && r.height ? [{name, x: r.x, y: r.y, width: r.width, height: r.height}] : [];}));
    await fs.writeFile(output + '/' + name + '-bounds.json', JSON.stringify(areas, null, 2));
    await page.evaluate(areas => {
      const layer = document.createElement('div'); layer.id = 'github-updates-qa-overlay'; layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      areas.forEach((area, index) => {const color = ['#ef8f37', '#468ded', '#ba7ae0', '#1faf90', '#e9b63c', '#dd749e', '#5ab9d6'][index]; const box = document.createElement('div'); box.style.cssText = `position:fixed;left:${area.x}px;top:${area.y}px;width:${area.width}px;height:${area.height}px;box-sizing:border-box;border:2px solid ${color};background:${color}22`; const label = document.createElement('span'); label.textContent = area.name; label.style.cssText = `position:absolute;top:-17px;left:0;white-space:nowrap;background:#161b22;color:${color};font:700 11px system-ui;padding:1px 4px`; box.append(label); layer.append(box);});
      document.querySelector('.zi-dialog').append(layer);
    }, areas);
    try {await page.screenshot({path: output + '/' + name + '-overlay.png'});} finally {await page.evaluate(() => document.getElementById('github-updates-qa-overlay')?.remove());}
  }
  record('screenshot', {file: name + '.png', overlay});
}

async function native(method, args) {
  const reply = await page.evaluate(async ({method,args}) => window.asMagicBrain[method](args), {method,args});
  if (reply?.ok === false) throw Object.assign(Error(reply.error.message), {code: reply.error.code});
  return reply?.ok === true ? reply.value : reply;
}
async function openUpdates() {
  if (!await button('Repository file actions').isVisible()) await button('Toggle file sidebar').click();
  await button('Repository file actions').click();
  await page.getByRole('menuitem', {name: 'Check GitHub updates…', exact: true}).click();
  await page.locator('.ru-dialog').waitFor(); await until(() => button('Check for updates').isEnabled(), 'eligible repository connection');
}
async function sourceManifest() {
  const result = {};
  async function walk(directory, relative = '') {
    for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
      if (entry.name === '.git' || entry.name === '.asmagicbrain' || entry.name.startsWith('.asmb-')) continue;
      const name = relative ? relative + '/' + entry.name : entry.name, absolute = directory + '/' + entry.name;
      if (entry.isDirectory()) await walk(absolute, name);
      else if (entry.isFile()) result[name] = (await fs.readFile(absolute)).toString('base64');
    }
  }
  await walk(repositoryPath); return result;
}
async function retainedDraft(marker) {
  const directory = data + '/state/native/' + repo + '/files/records';
  const names = (await fs.readdir(directory)).filter(name => /^\d+\.json$/.test(name)).sort();
  const snapshot = JSON.parse(await fs.readFile(directory + '/' + names.at(-1), 'utf8')).body.payload;
  const document = snapshot.documents.find(item => item.path === 'README.md');
  return snapshot.drafts.find(item => item.documentId === document?.documentId)?.text.includes(marker);
}

async function qualifyDialogColors(themeName) {
  const primary = button('Apply update'), secondary = button('Back');
  await until(() => primary.isEnabled(), 'primary action enabled for contrast qualification');
  const colors = async locator => {
    const styles = await locator.evaluate(element => {
      const css = getComputedStyle(element);
      return {foreground:css.color,background:css.backgroundColor,backdrop:getComputedStyle(element.closest('dialog')).backgroundColor,filter:css.filter,opacity:Number(css.opacity),outlineStyle:css.outlineStyle,outlineWidth:css.outlineWidth};
    });
    const rgb = value => {
      const parts = value.match(/[\d.]+/g)?.map(Number);
      assert.ok(parts && parts.length >= 3, `Computed RGB color: ${value}`);
      return {channels:parts.slice(0,3),alpha:parts[3]??1};
    };
    const brightness = styles.filter === 'none' ? 1 : Number(/^brightness\(([\d.]+)\)$/.exec(styles.filter)?.[1]);
    assert.ok(Number.isFinite(brightness), `Supported computed filter: ${styles.filter}`);
    assert.equal(styles.opacity,1,'Enabled control has full opacity');
    const over=(color,base)=>color.channels.map((channel,index)=>Math.min(255,channel*brightness)*color.alpha+base[index]*(1-color.alpha));
    const background=over(rgb(styles.background),rgb(styles.backdrop).channels),foreground=over(rgb(styles.foreground),background);
    const luminance = channels => channels.map(channel => channel/255).map(value => value <= .04045 ? value/12.92 : ((value+.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
    const first=luminance(foreground),second=luminance(background);
    return {...styles,contrast:(Math.max(first,second)+.05)/(Math.min(first,second)+.05)};
  };
  await page.mouse.move(10,10); const normal = await colors(primary); assert.ok(normal.contrast>=4.5,`${themeName} primary contrast ${normal.contrast}`);
  await primary.hover(); const hover = await colors(primary); assert.ok(hover.contrast>=4.5,`${themeName} primary hover contrast ${hover.contrast}`);
  await capture(`apply-primary-hover-${themeName}`);
  await secondary.hover(); const secondaryHover = await colors(secondary); assert.ok(secondaryHover.contrast>=4.5,`${themeName} secondary hover contrast ${secondaryHover.contrast}`);
  await primary.focus(); await page.keyboard.press('Shift+Tab');
  assert.equal(await secondary.evaluate(element=>element===document.activeElement),true);
  const focus = await secondary.evaluate(element=>{const css=getComputedStyle(element);return {outlineStyle:css.outlineStyle,outlineWidth:parseFloat(css.outlineWidth)};});
  assert.ok(focus.outlineStyle!=='none'&&focus.outlineWidth>=2,'Keyboard focus remains visible');
  record('dialog-control-contrast-and-focus',{theme:themeName,primaryDefault:normal,primaryHover:hover,secondaryHover,secondaryKeyboardFocus:focus});
  await page.mouse.move(10,10);
}

async function review() {
  await button('Review update…').click();
  await page.locator('.ru-apply-review').waitFor();
}
async function closeDialog() {await button('Close GitHub updates').click(); await page.locator('.ru-dialog').waitFor({state:'detached'});}
async function rawText() {
  if (await button('Cancel changes').isVisible()) await button('Cancel changes').click();
  await button('Copy raw file').click();
  await until(() => page.locator('.rfe-path-copy-status').innerText().then(text => text === 'Raw file copied'), 'copied displayed source');
  return application.evaluate(({clipboard}) => clipboard.readText());
}


async function useFixtureTransport(upstream) {
  assert.ok(upstream.startsWith(output + '/'), 'Synthetic upstream stays inside this isolated run');
  await application.evaluate(({app}, {sourceUrl, upstream}) => {
    const cp = process.getBuiltinModule('node:child_process'), modules = process.getBuiltinModule('node:module'), original = cp.spawn;
    const ownedGit = process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:fs').realpathSync(app.getAppPath()), 'apps/native/dist-host/git/bin/git');
    // Preserve legacy-release testing without accepting arbitrary Git paths.
    const isGit = file => file === ownedGit || file === '/usr/bin/git';
    globalThis.__applyFixtureTransport = {original, calls: []};
    cp.spawn = (file, args, options) => {
      if (isGit(file) && Array.isArray(args) && args.some(arg => arg === 'fetch' || arg === 'ls-remote') && args.some(arg => typeof arg === 'string' && arg.replace(/\.git$/, '') === sourceUrl)) {
        const replaced = args.map(arg => typeof arg === 'string' && arg.replace(/\.git$/, '') === sourceUrl ? upstream : arg);
        const command = replaced.findIndex(arg => arg === 'fetch' || arg === 'ls-remote');
        replaced.splice(command, 0, '-c', 'protocol.file.allow=always');
        globalThis.__applyFixtureTransport.calls.push({command: replaced[command + 2], upstream});
        return original(file, replaced, {...options, env: {...options.env, GIT_ALLOW_PROTOCOL: 'file'}});
      }
      return original(file, args, options);
    };
    modules.syncBuiltinESMExports();
  }, {sourceUrl, upstream});
}
async function restoreFixtureTransport() {
  return application.evaluate(() => {
    const state = globalThis.__applyFixtureTransport;
    if (!state) return [];
    process.getBuiltinModule('node:child_process').spawn = state.original;
    process.getBuiltinModule('node:module').syncBuiltinESMExports();
    delete globalThis.__applyFixtureTransport;
    return state.calls;
  });
}

try {
  await launch(); await theme('GitHub Light Default'); await mode(false);
  await importDialog(); await button('Clone from GitHub').click();
  await page.getByLabel('GitHub repository URL').fill(sourceUrl);
  await page.getByLabel('Repository name', {exact:true}).fill(repo); await button('Clone repository').click();
  await until(() => page.locator('.rc-identity h1').innerText().then(text => text === repo), 'actual public clone', 180000);
  const targetHead = git('rev-parse','HEAD'), targetSource = await sourceManifest(), origin = git('remote','get-url','origin');
  const targetReadme = await fs.readFile(repositoryPath+'/README.md','utf8');
  await close();
  // Only the disposable local clone moves back. GitHub is never written.
  const ancestor = git('rev-parse','HEAD^'); git('reset','--hard',ancestor);
  const initialSource = await sourceManifest(), oldReadme = await fs.readFile(repositoryPath+'/README.md','utf8');
  assert.notEqual(oldReadme,targetReadme,'Fixture README changes in incoming history');
  record('isolated-public-incoming-fixture',{targetHead,ancestor,origin,remoteWrites:false});
  await launch(); await select(repo); await button('README.md').first().click(); await button('Edit this file').click();
  const marker = 'Private draft must block applying GitHub updates Ω.';
  await appendDraft('\n'+marker+'\n');
  await openUpdates(); await button('Check for updates').click();
  await until(() => page.locator('.ru-result h3').first().innerText().then(text => /incoming commit/.test(text)), 'incoming comparison',180000);
  const comparison=(await native('getRepositoryUpdates',{repo})).lastCheck;
  assert.equal(comparison.localHead,ancestor); assert.equal(comparison.remoteHead,targetHead); assert.equal(comparison.relation,'remote-ahead');
  await review(); assert.equal(await button('Apply update').isEnabled(),false);
  assert.match(await page.locator('.ru-apply-review').innerText(),/retained draft/i);
  assert.equal(await retainedDraft(marker),true); assert.deepEqual(await sourceManifest(),initialSource); assert.equal(git('rev-parse','HEAD'),ancestor);
  await capture('apply-blocked-draft',true); record('review-checkpoints-and-preserves-draft-without-applying');
  await closeDialog(); await button('Cancel changes').click(); await button('Discard changes').click();
  await until(() => button('Edit this file').isVisible(),'explicit fixture draft discard');
  await fs.writeFile(repositoryPath+'/saved-qa.md','# Saved local work\n');
  const dirtySource=await sourceManifest();
  await openUpdates(); await review(); assert.equal(await button('Apply update').isEnabled(),false);
  assert.match(await page.locator('.ru-apply-review').innerText(),/saved (local )?change/i);
  assert.deepEqual(await sourceManifest(),dirtySource); assert.equal(git('rev-parse','HEAD'),ancestor);
  await capture('apply-blocked-saved',true); record('review-refuses-saved-changes-without-mutation');
  await closeDialog(); await close();
  // Remove only the driver's own disposable blocker, never user content.
  await fs.unlink(repositoryPath+'/saved-qa.md'); assert.equal(git('status','--porcelain'),'');
  await launch(); await select(repo); await button('README.md').first().click(); await button('Edit this file').click();
  await openUpdates(); await review(); await until(() => button('Apply update').isEnabled(),'clean review');
  const reviewed=(await native('getRepositoryUpdates',{repo})).lastCheck;
  assert.equal(reviewed.checkId,comparison.checkId,'Opening/reviewing after restart does not implicitly fetch');
  assert.deepEqual(await sourceManifest(),initialSource); assert.equal(git('rev-parse','HEAD'),ancestor);
  assert.match(await page.locator('.ru-apply-review').innerText(),new RegExp(ancestor.slice(0,7)));
  assert.match(await page.locator('.ru-apply-review').innerText(),new RegExp(targetHead.slice(0,7)));
  cdp=await page.context().newCDPSession(page); await startVideo();
  await qualifyDialogColors('light'); await capture('apply-review-light',true);
  await closeDialog(); await theme('GitHub Dark Default'); await mode(true); await openUpdates(); await review();
  await qualifyDialogColors('dark'); await capture('apply-review-dark',true);
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(520,660));
  const bounds=await page.locator('.ru-dialog').evaluate(element=>{const r=element.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};});
  assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.right<=bounds.width+1&&bounds.bottom<=bounds.height+1);
  await capture('apply-review-narrow');
  await button('Apply update').scrollIntoViewIfNeeded();
  const narrowApply=await button('Apply update').boundingBox();
  assert.ok(narrowApply&&narrowApply.y>=0&&narrowApply.y+narrowApply.height<=660,'Narrow review actions remain reachable by scrolling');
  await capture('apply-review-narrow-actions'); await closeDialog();
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000));
  await theme('GitHub Light Default'); await openUpdates(); await review();
  record('clean-review-bound-commits-no-mutation-themes-focus-and-narrow',{bounds,checkId:comparison.checkId});
  // A new local file after review must be caught by the final host guard.
  await fs.writeFile(repositoryPath+'/late-local-qa.md','# Appeared after review\n');
  const lateSource=await sourceManifest(); await button('Apply update').click();
  await page.locator('.ru-dialog [role=alert]').waitFor();
  await until(() => button('Close GitHub updates').isEnabled(),'refused apply settles');
  assert.equal(git('rev-parse','HEAD'),ancestor); assert.deepEqual(await sourceManifest(),lateSource);
  assert.equal(await button('Apply update').count(),0,'Failed review cannot be reused');
  await capture('apply-refused-after-review',true); record('final-guard-refuses-post-review-local-change');
  await closeDialog(); await fs.unlink(repositoryPath+'/late-local-qa.md');
  await openUpdates(); await review(); await until(() => button('Apply update').isEnabled(),'fresh review after refusal');
  await button('Apply update').click();
  await page.locator('.ru-dialog').waitFor({state:'detached',timeout:60000});
  assert.equal(git('rev-parse','HEAD'),targetHead); assert.deepEqual(await sourceManifest(),targetSource); assert.equal(git('status','--porcelain'),''); assert.equal(git('remote','get-url','origin'),origin);
  assert.equal(await rawText(),targetReadme,'Selected-file source is reloaded to the incoming content');
  await capture('apply-completed-file'); record('explicit-apply-matches-reviewed-target-tree-head-and-clean-index');
  // Editing afterward must start from the new source, with old undo history gone.
  await button('Edit this file').click();
  const editor=page.locator('.cm-content[contenteditable=true]'); await editor.click(); await editor.press('Meta+z');
  assert.equal(await rawText(),targetReadme,'Undo after apply cannot restore the previous source');
  await button('Edit this file').click();
  // Insert a single-line marker. Chromium's contenteditable insertText command
  // normalizes a leading line break; that transport behavior is not this test.
  const afterMarker='Local edit after reviewed update.'; await appendDraft(afterMarker); await button('Save').click();
  await until(async()=>await fs.readFile(repositoryPath+'/README.md','utf8')===targetReadme+afterMarker,'save uses refreshed target baseline');
  assert.equal(git('rev-parse','HEAD'),targetHead,'Ordinary Save does not create a commit');
  await capture('apply-following-edit'); record('CM6-new-baseline-and-undo-cannot-overwrite-with-old-source');
  await stopVideo(); await close(); await launch(); await select(repo); await button('README.md').first().click();
  assert.equal(await rawText(),targetReadme+afterMarker); assert.equal(git('rev-parse','HEAD'),targetHead);
  await capture('apply-restart'); record('applied-head-and-following-local-save-survive-restart');
  await close();

  // A locally prepared upstream supplies a deletion absent from this small
  // public sample's newest commit. Only the native Git transport is redirected;
  // snapshot capture, review, apply, and selected-file reload remain actual UI.
  const upstream=output+'/deleted-file-upstream';
  const fixtureEnv={PATH:'/usr/bin:/bin',TMPDIR:tmp,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
  execFileSync('/usr/bin/git',['clone','--no-hardlinks','--',repositoryPath,upstream],{env:fixtureEnv,stdio:'pipe'});
  await fs.unlink(upstream+'/README.md');
  const constructorNote='# Incoming constructor folder\n';
  await fs.mkdir(upstream+'/constructor'); await fs.writeFile(upstream+'/constructor/note.md',constructorNote);
  execFileSync('/usr/bin/git',['-C',upstream,'add','--','README.md','constructor/note.md'],{env:fixtureEnv});
  execFileSync('/usr/bin/git',['-C',upstream,'-c','user.name=Apply QA','-c','user.email=apply@example.invalid','commit','-m','Delete selected README in isolated fixture'],{env:fixtureEnv,stdio:'pipe'});
  const deletedTarget=execFileSync('/usr/bin/git',['-C',upstream,'rev-parse','HEAD'],{env:fixtureEnv,encoding:'utf8'}).trim();
  repo='GitHub-Deleted-File-QA'; repositoryPath=data+'/workspaces/asMagicBrain/'+repo;
  await launch(); await importDialog(); await button('Clone from GitHub').click();
  await page.getByLabel('GitHub repository URL').fill(sourceUrl); await page.getByLabel('Repository name',{exact:true}).fill(repo); await button('Clone repository').click();
  await until(()=>page.locator('.rc-identity h1').innerText().then(text=>text===repo),'second actual public clone',180000);
  assert.equal(git('rev-parse','HEAD'),targetHead,'Synthetic deletion starts from the captured public HEAD');
  await button('README.md').first().click(); await button('Edit this file').click();
  await useFixtureTransport(upstream); await openUpdates(); await button('Check for updates').click();
  await until(()=>page.locator('.ru-result h3').first().innerText().then(text=>/incoming commit/.test(text)),'synthetic captured deletion',180000);
  const deletedComparison=(await native('getRepositoryUpdates',{repo})).lastCheck;
  assert.equal(deletedComparison.remoteHead,deletedTarget); assert.ok(deletedComparison.files.some(file=>file.path==='README.md'&&file.status==='deleted'));
  assert.ok(deletedComparison.files.some(file=>file.path==='constructor/note.md'&&file.status==='added'));
  await review(); await button('Apply update').click(); await page.locator('.ru-dialog').waitFor({state:'detached',timeout:60000});
  await page.locator('.rfe-directory-table').waitFor(); assert.equal(await page.locator('.rfe-breadcrumbs').innerText(),'');
  assert.equal(await fs.stat(repositoryPath+'/README.md').then(()=>true,()=>false),false);
  assert.equal(git('rev-parse','HEAD'),deletedTarget); assert.equal(git('status','--porcelain'),'');
  assert.equal(await page.locator('.cm-content[contenteditable=true]').count(),0,'Deleted source cannot remain editable');
  assert.equal(await page.locator('.rfe-directory-table').getByRole('button',{name:'README.md',exact:true}).count(),0);
  const transportCalls=await restoreFixtureTransport(); assert.ok(transportCalls.length>0);
  await capture('apply-deleted-file-fallback');
  record('synthetic-captured-deletion-falls-back-to-surviving-root',{repo,upstream,deletedTarget,transportCalls,remoteWrites:false,method:'Acceptance debugger rewrites only exact source GitHub fetch/ls-remote child transport to this local fixture; signed app code and all snapshot/apply logic are unchanged.'});
  const constructorFolder=page.locator('.rex-node[data-explorer-path="constructor"] .rex-name');
  await constructorFolder.waitFor(); await constructorFolder.dblclick();
  await page.locator('.rfe-directory-table').getByRole('button',{name:'note.md',exact:true}).click();
  assert.equal(await rawText(),constructorNote,'Incoming special-name folder opens the actual newly applied file');
  assert.equal(await fs.readFile(repositoryPath+'/constructor/note.md','utf8'),constructorNote);
  await capture('apply-incoming-constructor-folder'); record('incoming-constructor-folder-renders-and-opens-after-fresh-tree-reload');
  await close(); assert.deepEqual(errors,[]);
} catch(error) {
  failure=error; record('failure',{message:error.message,stack:error.stack});
  if(page){await page.screenshot({path:output+'/failure.png'}).catch(()=>{});await fs.writeFile(output+'/failure-dom.txt',await page.locator('body').innerText()).catch(()=>{});}
} finally {
  if(application){await stopVideo().catch(()=>{});await application.close().catch(()=>{});}
  await fs.writeFile(output+'/receipt.json',JSON.stringify({passed:!failure,metadata,executable,data,sourceUrl,events,errors,definitionSha256,limitations:['Actual public clone/check plus separately labelled synthetic local-upstream deletion capture; no remote writes or account authorization.','Only the disposable local clone is rewound to prepare actual incoming commits.','Crash/recovery/cross-process races are separately qualified by host/lifecycle acceptance.']},null,2));
  console.log(output);
}
if(failure)throw failure;
