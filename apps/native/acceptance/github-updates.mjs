import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
/** Packaged GitHub update checks and read-only comparisons in a disposable Test profile. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const testRoot = developmentTestRoot;
const runRoot = path.join(testRoot, 'runs/native-github-updates-20260917/ui');
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
const repo = 'GitHub-Updates-QA', sourceUrl = 'https://github.com/ancorasir/asTeach-App';
const repositoryPath = data + '/workspaces/asMagicBrain/' + repo;
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
async function stopVideo(){if(!recorder)return;const state=recorder;await cdp.send('Page.stopScreencast');cdp.off('Page.screencastFrame',state.listener);await until(()=>!state.busy,'video frame drained');const result=await page.evaluate(async()=>{const v=window.__asmbQaVideo;await new Promise(resolve=>{v.recorder.onstop=resolve;v.recorder.stop();});v.stream.getTracks().forEach(t=>t.stop());const blob=new Blob(v.chunks,{type:v.mime}),base64=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(blob);});delete window.__asmbQaVideo;return{base64,mime:v.mime};});const filename='updates-walkthrough.webm';await fs.writeFile(path.join(output,filename),Buffer.from(result.base64,'base64'));record('real-gesture-recording',{file:filename,mime:result.mime,durationMs:Date.now()-state.started,capturedFrames:state.frames,droppedFrames:state.dropped,frameErrors:state.frameErrors??[],canvasRate:12,method:'Actual CDP screencast frames encoded through browser MediaRecorder; no reenactment.'});recorder=null;}

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
      ['GU3 access/scope', '.ru-access'], ['GU4 history result', '.ru-result'],
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
  const primary = button('Check for updates'), secondary = button('Close');
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
  await capture(`updates-primary-hover-${themeName}`);
  await secondary.hover(); const secondaryHover = await colors(secondary); assert.ok(secondaryHover.contrast>=4.5,`${themeName} secondary hover contrast ${secondaryHover.contrast}`);
  await primary.focus(); await page.keyboard.press('Shift+Tab');
  assert.equal(await secondary.evaluate(element=>element===document.activeElement),true);
  const focus = await secondary.evaluate(element=>{const css=getComputedStyle(element);return {outlineStyle:css.outlineStyle,outlineWidth:parseFloat(css.outlineWidth)};});
  assert.ok(focus.outlineStyle!=='none'&&focus.outlineWidth>=2,'Keyboard focus remains visible');
  record('dialog-control-contrast-and-focus',{theme:themeName,primaryDefault:normal,primaryHover:hover,secondaryHover,secondaryKeyboardFocus:focus});
  await page.mouse.move(10,10);
}

try {
  await launch(); await theme('GitHub Light Default'); await mode(false);
  await button('README.md').first().click(); await button('Repository file actions').click();
  assert.equal(await page.getByRole('menuitem', {name: 'Check GitHub updates…', exact: true}).getAttribute('aria-disabled'), 'true');
  await page.keyboard.press('Escape'); await mode(true); await button('Repository file actions').click();
  assert.equal(await page.getByRole('menuitem', {name: 'Check GitHub updates…', exact: true}).isVisible(), false);
  await page.keyboard.press('Escape'); record('local-only-repository-command-grey-or-hidden');

  await importDialog(); await button('Clone from GitHub').click(); await page.getByLabel('GitHub repository URL').fill(sourceUrl); await page.getByLabel('Repository name', {exact: true}).fill(repo); await button('Clone repository').click();
  await until(() => page.locator('.rc-identity h1').innerText().then(text => text === repo), 'actual public clone', 180000);
  const origin = git('remote', 'get-url', 'origin'), clonedHead = git('rev-parse', 'HEAD'); await close();
  // Only the disposable local clone is moved back; the public GitHub repository
  // is never changed. This creates real incoming history for a repeatable check.
  const ancestor = git('rev-parse', 'HEAD^'); git('reset', '--hard', ancestor);
  await fs.writeFile(repositoryPath + '/update-qa-saved.md', '# Saved local work excluded from comparison\n');
  const beforeSource = await sourceManifest(), beforeHead = git('rev-parse', 'HEAD'), beforeIndex = (await fs.readFile(repositoryPath + '/.git/index')).toString('base64');
  record('isolated-incoming-history-fixture', {clonedHead, localHead: ancestor, remoteWrites: false});
  await launch(); await select(repo); await button('README.md').first().click(); await button('Edit this file').click();
  const marker = 'Private draft survives GitHub update checks Ω.'; await appendDraft('\n' + marker + '\n');
  await until(() => retainedDraft(marker), 'durable draft before checking');
  await page.locator('.cm-editor').evaluate(element => element.dataset.updateQaMount = 'retained');
  await button('More actions for README.md').click();
  assert.equal(await page.getByRole('menuitem', {name: 'Check GitHub updates…', exact: true}).count(), 0, 'The repository operation is absent from file menus');
  await page.keyboard.press('Escape');
  const before = await native('getRepositoryUpdates', {repo}); assert.equal(before.eligible, true); assert.equal(before.lastCheck, undefined);
  await openUpdates(); assert.equal(await page.locator('.ru-result').count(), 0); assert.equal((await native('getRepositoryUpdates', {repo})).lastCheck, undefined, 'Opening dialog does not fetch');
  cdp = await page.context().newCDPSession(page); await startVideo();
  await qualifyDialogColors('light');
  await capture('updates-ready-light', true);
  await button('Check for updates').click();
  await until(() => page.locator('.ru-result h3').innerText().then(text => /incoming commit/.test(text)), 'explicit public fetch and comparison', 180000);
  const current = (await native('getRepositoryUpdates', {repo})).lastCheck;
  assert.equal(current.localHead, beforeHead); assert.equal(current.remoteHead, clonedHead); assert.equal(current.relation, 'remote-ahead'); assert.ok(current.behind > 0);
  assert.deepEqual(await sourceManifest(), beforeSource); assert.equal(git('rev-parse', 'HEAD'), beforeHead); assert.equal((await fs.readFile(repositoryPath + '/.git/index')).toString('base64'), beforeIndex); assert.equal(await retainedDraft(marker), true);
  assert.equal(await page.locator('.cm-editor[data-update-qa-mount=retained]').count(), 1, 'Editor stays mounted behind dialog');
  assert.equal(git('remote', 'get-url', 'origin'), origin); record('explicit-public-check-retains-source-index-head-draft-and-editor', {comparison: current});
  await button(`View changes (${current.files.length})`).click();
  let verified;
  for (const item of current.files) {
    const value = await native('readRepositoryUpdateFile', {repo, checkId: current.checkId, path: item.path});
    if (!value.binary && !value.previewOmitted && !value.unsupported) {verified = value; break;}
  }
  assert.ok(verified, 'Public sample has a textual changed file');
  const rawAt = (head, file) => {try {return execFileSync('/usr/bin/git', ['-C', repositoryPath, 'show', `${head}:${file}`], {encoding: 'utf8', stdio: ['ignore','pipe','pipe']});} catch {return null;}};
  assert.equal(verified.before, rawAt(current.localHead, verified.path)); assert.equal(verified.after, rawAt(current.remoteHead, verified.path));
  const details = page.locator('.ru-file').filter({has: page.locator('summary span', {hasText: verified.path})}).first(); await details.locator('summary').click(); await details.locator('.ru-diff').waitFor();
  assert.equal(await details.locator('.ru-diff pre').nth(0).textContent(), verified.before ?? 'File does not exist'); assert.equal(await details.locator('.ru-diff pre').nth(1).textContent(), verified.after ?? 'File does not exist');
  await capture('updates-incoming-light', true); record('read-only-text-comparison-matches-immutable-git-objects', {path: verified.path, checkId: current.checkId});
  await page.keyboard.press('Escape'); await page.locator('.ru-dialog').waitFor({state: 'detached'}); assert.equal(await button('Repository file actions').evaluate(element => element === document.activeElement), true);
  const tree = await page.locator('.rex-viewport').boundingBox(); await page.mouse.click(tree.x + tree.width / 2, tree.y + tree.height - 30, {button:'right'});
  await page.getByRole('menuitem', {name:'Check GitHub updates…',exact:true}).click(); await button('Check for updates').waitFor();
  await until(() => page.locator('.ru-result h3').innerText().then(text => /incoming commit/.test(text)), 'last comparison opens locally from tree background');
  await button('Close').click(); await theme('GitHub Dark Default'); await mode(false); await openUpdates(); await qualifyDialogColors('dark'); await capture('updates-incoming-dark', true);
  await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(520, 660));
  const bounds = await page.locator('.ru-dialog').evaluate(element => {const r=element.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};});
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.right <= bounds.width + 1 && bounds.bottom <= bounds.height + 1); await capture('updates-narrow');
  await button('Close').click(); await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1280,860));
  record('root-context-command-themes-narrow-containment-and-focus', {bounds});
  // An external commit in this disposable fixture exercises stale-result
  // detection without changing any remote or saving the retained README draft.
  git('add', '--', 'update-qa-saved.md'); git('-c','user.name=Update QA','-c','user.email=updates@example.invalid','commit','-m','Local QA commit');
  await openUpdates(); await page.locator('.ru-stale').waitFor(); assert.equal(await page.getByRole('button',{name:/^View changes/}).count(),0);
  await capture('updates-stale'); record('changed-local-head-disables-stale-preview');
  await button('Check for updates').click(); await until(() => page.locator('.ru-result h3').innerText().then(text => /diverged/.test(text)), 'explicit recheck of diverged history',180000);
  const diverged = (await native('getRepositoryUpdates',{repo})).lastCheck; assert.equal(diverged.relation,'diverged'); assert.equal(diverged.ahead,1); assert.ok(diverged.behind>0);
  assert.equal(await retainedDraft(marker),true); assert.deepEqual(await sourceManifest(),beforeSource); await capture('updates-diverged',true); record('recheck-compares-diverged-commits-without-applying', {comparison:diverged});
  await button('Close').click(); await page.locator('.cm-content[contenteditable=true]').click(); await page.locator('.cm-content[contenteditable=true]').press('Meta+ArrowDown');
  await until(() => page.locator('.cm-content[contenteditable=true]').innerText().then(text=>text.includes(marker)), 'same editor retained draft after modal');
  await close(); await launch(); await select(repo); await button('README.md').first().click(); await button('Edit this file').click(); await page.locator('.cm-content[contenteditable=true]').click(); await page.locator('.cm-content[contenteditable=true]').press('Meta+ArrowDown');
  await until(() => page.locator('.cm-content[contenteditable=true]').innerText().then(text=>text.includes(marker)), 'private draft survives normal close and restart');
  assert.equal(await retainedDraft(marker),true); assert.deepEqual(await sourceManifest(),beforeSource);
  const restarted = await native('getRepositoryUpdates',{repo}); assert.equal(restarted.lastCheck.checkId,diverged.checkId); assert.equal(restarted.lastCheck.stale,false);
  await openUpdates(); await until(() => page.locator('.ru-result h3').innerText().then(text=>text.includes('diverged')), 'durable last comparison without fetching'); await button('Close').click();
  record('restart-retains-local-source-private-draft-and-last-comparison');
  await close(); assert.deepEqual(errors,[]);
} catch (error) {failure=error;record('failure',{message:error.message,stack:error.stack});if(page)await page.screenshot({path:output+'/failure.png'}).catch(()=>{});}
finally {
  if(application){await stopVideo().catch(()=>{});await application.close().catch(()=>{});}
  await fs.writeFile(output+'/receipt.json',JSON.stringify({passed:!failure,metadata,executable,data,sourceUrl,events,errors,limitations:['GitHub is read-only: no push, merge, pull, remote commit or account consent.','Incoming/diverged history is prepared only in the disposable local clone.','Controlled transfer failures and unsupported/binary edge cases are separately qualified by host tests.']},null,2));console.log(output);
}
if(failure)throw failure;
