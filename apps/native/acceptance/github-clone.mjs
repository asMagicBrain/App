import {testRoot as developmentTestRoot} from '../../../tools/development-paths.mjs';
/** Native GitHub clone UI acceptance; disposable Test profile and a public read-only source. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const testRoot = developmentTestRoot;
const runRoot = path.join(testRoot, 'runs/native-github-clone-20260917/ui');
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
const repo = 'GitHub-Clone-QA', sourceUrl = 'https://github.com/ancorasir/asTeach-App';
const repositoryPath = data + '/workspaces/asMagicBrain/' + repo;
const workspaceReadme = data + '/workspaces/asMagicBrain/Workspace/README.md';
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
  if (launches === 1) {cdp = await page.context().newCDPSession(page); await startVideo();}
}
async function startVideo(){
 await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=1440;canvas.height=1000;const context=canvas.getContext('2d'),chunks=[],mime=MediaRecorder.isTypeSupported('video/webm;codecs=vp9')?'video/webm;codecs=vp9':'video/webm;codecs=vp8';const stream=canvas.captureStream(12),recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:1500000});window.__asmbQaVideo={canvas,context,chunks,recorder,stream,started:Date.now(),mime};recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.start(1000);});
 recorder={started:Date.now(),frames:0,dropped:0,busy:false,listener:null};const state=recorder;
 state.listener=async event=>{void cdp.send('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(()=>{});if(state.busy){state.dropped++;return;}state.busy=true;try{await page.evaluate(async jpeg=>{const v=window.__asmbQaVideo;if(!v)return;const img=new Image();img.src='data:image/jpeg;base64,'+jpeg;await img.decode();v.context.drawImage(img,0,0,v.canvas.width,v.canvas.height);},event.data);state.frames++;}catch(error){state.frameErrors??=[];state.frameErrors.push(String(error));}finally{state.busy=false;}};
 cdp.on('Page.screencastFrame',state.listener);await cdp.send('Page.startScreencast',{format:'jpeg',quality:75,maxWidth:1440,maxHeight:1000,everyNthFrame:1});
}
async function stopVideo(){if(!recorder)return;const state=recorder;await cdp.send('Page.stopScreencast');cdp.off('Page.screencastFrame',state.listener);await until(()=>!state.busy,'video frame drained');const result=await page.evaluate(async()=>{const v=window.__asmbQaVideo;await new Promise(resolve=>{v.recorder.onstop=resolve;v.recorder.stop();});v.stream.getTracks().forEach(t=>t.stop());const blob=new Blob(v.chunks,{type:v.mime}),base64=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(blob);});delete window.__asmbQaVideo;return{base64,mime:v.mime};});const filename='clone-walkthrough.webm';await fs.writeFile(path.join(output,filename),Buffer.from(result.base64,'base64'));record('real-gesture-recording',{file:filename,mime:result.mime,durationMs:Date.now()-state.started,capturedFrames:state.frames,droppedFrames:state.dropped,frameErrors:state.frameErrors??[],canvasRate:12,method:'Actual CDP screencast frames encoded through browser MediaRecorder; no reenactment.'});recorder=null;}

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
async function createSavedFile(name, text) {
  await button('Create new Markdown document').click();
  await until(async () => await page.getByLabel('File path', {exact: true}).isVisible() || await button('Leave editor').isVisible(), 'new file or draft preservation');
  if (await button('Leave editor').isVisible()) await button('Leave editor').click();
  await until(() => page.getByLabel('File path', {exact: true}).inputValue().then(value => /^untitled(?:-\d+)?\.md$/.test(value)), 'new draft filename ready');
  await page.getByLabel('File path', {exact: true}).fill(name); await appendDraft(text); await button('Save').click();
  await until(() => fs.readFile(repositoryPath + '/' + name, 'utf8').then(value => value.includes(text.trim())), 'saved local file ' + name);
  await until(() => button('Commit changes…').isEnabled(), 'saved file ready to review');
}
async function capture(name, overlay = false) {
  await page.screenshot({path: output + '/' + name + '.png'});
  if (overlay) {
    const areas = await page.evaluate(() => [
      ['GI1 import title', '.zi-dialog header'], ['GI2 acquisition method', '.zi-methods'],
      ['GI3 GitHub URL', '.zi-dialog form > .zi-field'], ['GI4 managed destination', '.zi-destination'],
      ['GI5 local history behavior', '.zi-note'], ['GI6 progress and errors', '.zi-progress'], ['GI7 actions', '.zi-dialog footer'],
    ].flatMap(([name, selector]) => {const element = document.querySelector(selector), r = element?.getBoundingClientRect(); return r && r.width && r.height ? [{name, x: r.x, y: r.y, width: r.width, height: r.height}] : [];}));
    await fs.writeFile(output + '/' + name + '-bounds.json', JSON.stringify(areas, null, 2));
    await page.evaluate(areas => {
      const layer = document.createElement('div'); layer.id = 'github-clone-qa-overlay'; layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      areas.forEach((area, index) => {const color = ['#ef8f37', '#468ded', '#ba7ae0', '#1faf90', '#e9b63c', '#dd749e', '#5ab9d6'][index]; const box = document.createElement('div'); box.style.cssText = `position:fixed;left:${area.x}px;top:${area.y}px;width:${area.width}px;height:${area.height}px;box-sizing:border-box;border:2px solid ${color};background:${color}22`; const label = document.createElement('span'); label.textContent = area.name; label.style.cssText = `position:absolute;top:-17px;left:0;white-space:nowrap;background:#161b22;color:${color};font:700 11px system-ui;padding:1px 4px`; box.append(label); layer.append(box);});
      document.querySelector('.zi-dialog').append(layer);
    }, areas);
    try {await page.screenshot({path: output + '/' + name + '-overlay.png'});} finally {await page.evaluate(() => document.getElementById('github-clone-qa-overlay')?.remove());}
  }
  record('screenshot', {file: name + '.png', overlay});
}

try {
  await launch();
  await button('Account menu').click();
  const connection = await page.evaluate(() => window.asMagicBrain.getGitHubConnection());
  const authStatus = connection.ok ? connection.value : connection;
  assert.ok(['signed-out', 'unavailable'].includes(authStatus.state), 'Fresh isolated profile must not inherit an account.');
  assert.equal(await page.getByRole('menuitem', {name: 'Connect GitHub', exact: true}).isEnabled(), authStatus.configured);
  record('fresh-account-status-honest', {configured: authStatus.configured, state: authStatus.state, interactiveAuthorization: 'Not attempted; no account approval or token supplied by this UI test.'});
  await capture('account-menu'); await page.keyboard.press('Escape');
  await theme('GitHub Light Default');
  await mode(true); await importDialog();
  assert.equal(await page.getByLabel('ZIP archive', {exact: true}).count(), 1); record('zip-remains-default-and-import-visible-in-implemented-mode');
  await button('Clone from GitHub').click();
  await button('Clone repository').click(); await page.locator('#gc-url-error').waitFor();
  assert.equal(await page.getByLabel('GitHub repository URL').getAttribute('aria-invalid'), 'true');
  await page.getByLabel('GitHub repository URL').fill(sourceUrl); assert.equal(await page.getByLabel('Repository name', {exact: true}).inputValue(), 'asTeach-App');
  await page.getByLabel('Repository name', {exact: true}).fill('Workspace'); assert.match(await page.locator('#gc-name-error').innerText(), /already exists/);
  await page.getByLabel('Repository name', {exact: true}).fill(repo); await capture('clone-dialog-light', true);
  await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(520, 660));
  const bounds = await page.locator('.zi-dialog').evaluate(element => {const r = element.getBoundingClientRect(); return {x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight};});
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.right <= bounds.width + 1 && bounds.bottom <= bounds.height + 1, JSON.stringify(bounds));
  await capture('clone-dialog-narrow'); record('narrow-dialog-contained', {bounds});
  await page.keyboard.press('Escape'); await page.locator('.zi-dialog').waitFor({state: 'detached'}); assert.equal(await button('Create new options').evaluate(element => element === document.activeElement), true);
  await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1280, 860));
  await theme('GitHub Dark Default'); await mode(false);
  const initialBytes = await fs.readFile(workspaceReadme);
  await button('README.md').first().click(); await button('Edit this file').click();
  const marker = '\nGitHub clone preserves the previous local draft Ω.\n';
  const editor = page.locator('.cm-content[contenteditable=true]'); await editor.click(); await editor.press('Meta+ArrowDown'); await page.keyboard.insertText(marker);
  await importDialog(); await button('Clone from GitHub').click(); await page.getByLabel('GitHub repository URL').fill(sourceUrl); await page.getByLabel('Repository name', {exact: true}).fill(repo);
  await capture('clone-dialog-dark', true); await button('Clone repository').click();
  await until(() => page.locator('.rc-identity h1').innerText().then(text => text === repo), 'actual public GitHub clone and repository selection', 180000);
  assert.deepEqual(await fs.readFile(workspaceReadme), initialBytes);
  const head = git('rev-parse', 'HEAD'), tags = git('tag', '--list').split('\n').filter(Boolean), remote = git('remote', 'get-url', 'origin');
  assert.match(head, /^[0-9a-f]{40}$/); assert.equal(remote.replace(/\.git$/, ''), sourceUrl); assert.ok(tags.length > 0, 'Known sample has tag history'); assert.equal(git('status', '--porcelain'), '');
  record('public-clone-retains-history-tags-origin-and-clean-files', {sourceUrl, localName: repo, head, tags, accountRequired: false});
  await capture('cloned-repository'); await close();
  await launch(); await select(repo); assert.equal(git('rev-parse', 'HEAD'), head);
  const originalReadme = await fs.readFile(repositoryPath + '/README.md');
  await button('README.md').first().click(); await button('Edit this file').waitFor(); await button('Edit this file').click();
  await appendDraft('\nPrivate cloned-repository draft stays outside commits.\n');
  await createSavedFile('clone-selected.md', '# Selected local file\n');
  await createSavedFile('clone-unselected.md', '# Unchecked local file\n');
  await button('Commit changes…').click();
  const commit = page.locator('.rfe-commit-dialog[open]').filter({has: page.getByRole('heading', {name: 'Commit changes', exact: true})});
  await commit.getByLabel('Commit message', {exact: true}).fill('Selected local commit after GitHub clone');
  await commit.getByLabel('Local author name', {exact: true}).fill('GitHub Clone QA');
  await commit.getByLabel('Local author email', {exact: true}).fill('clone-qa@example.invalid');
  for (const label of await commit.locator('.rfe-change-selection label').all()) {
    const text = await label.locator('span').innerText(); await label.locator('input').setChecked(text.startsWith('clone-selected.md '));
  }
  await commit.getByRole('button', {name: 'Refresh review', exact: true}).click();
  await until(() => commit.getByRole('button', {name: 'Commit changes', exact: true}).isEnabled(), 'selected cloned-repository commit review');
  await capture('cloned-repository-selected-commit'); await commit.getByRole('button', {name: 'Commit changes', exact: true}).click();
  await until(() => git('rev-parse', 'HEAD') !== head, 'local commit created'); await commit.waitFor({state: 'hidden'});
  const localHead = git('rev-parse', 'HEAD');
  assert.equal(git('rev-parse', 'HEAD^'), head); assert.equal(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'clone-selected.md');
  assert.equal(git('show', '-s', '--format=%an <%ae>', 'HEAD'), 'GitHub Clone QA <clone-qa@example.invalid>');
  assert.equal(git('ls-tree', '--name-only', 'HEAD', 'clone-unselected.md'), '');
  assert.deepEqual(await fs.readFile(repositoryPath + '/README.md'), originalReadme);
  assert.equal(git('remote', 'get-url', 'origin'), remote);
  await button('More actions for README.md').click(); await page.getByRole('menuitem', {name: 'Open', exact: true}).click();
  await button('Edit this file').waitFor(); await button('Edit this file').click();
  // CM6 virtualizes lines; scroll to the retained tail before checking visible text.
  await page.locator('.cm-content[contenteditable=true]').click();
  await page.locator('.cm-content[contenteditable=true]').press('Meta+ArrowDown');
  await until(() => page.locator('.cm-content[contenteditable=true]').innerText().then(text => text.includes('Private cloned-repository draft stays outside commits.')), 'uncommitted cloned-repository draft still available');
  const privateRecords = data + '/state/native/' + repo + '/files/records';
  const privateRecordNames = (await fs.readdir(privateRecords)).filter(name => /^\d+\.json$/.test(name)).sort();
  const durable = JSON.parse(await fs.readFile(privateRecords + '/' + privateRecordNames.at(-1), 'utf8')).body.payload;
  const readmeDocument = durable.documents.find(item => item.path === 'README.md');
  assert.ok(readmeDocument, 'Retained README identity exists in durable private state');
  const durableDraft = durable.drafts.find(item => item.documentId === readmeDocument.documentId);
  assert.ok(durableDraft?.text.includes('Private cloned-repository draft stays outside commits.'), 'The actual durable private draft retains its bytes');
  assert.ok(!originalReadme.includes(Buffer.from('Private cloned-repository draft stays outside commits.')));

  record('actual-ui-selected-local-commit-after-clone-restart', {head: localHead, parent: head, selected: ['clone-selected.md'], excludedSaved: ['clone-unselected.md'], excludedDraft: ['README.md'], remoteUnchanged: true});
  await select('Workspace'); await button('README.md').first().click();
  await button('Edit this file').waitFor(); await button('Edit this file').click();
  await until(() => page.locator('.cm-content[contenteditable=true]').innerText().then(text => text.includes(marker.trim())), 'previous draft restored after clone and restart');
  assert.deepEqual(await fs.readFile(workspaceReadme), initialBytes); record('restart-retains-cloned-catalog-and-previous-unsaved-draft');
  await close();
  assert.deepEqual(errors, []);
} catch (error) {failure = error; record('failure', {message: error.message, stack: error.stack}); if (page) await page.screenshot({path: output + '/failure.png'}).catch(() => {});}
finally {
  if (application) {await stopVideo().catch(() => {}); await application.close().catch(() => {});}
  await fs.writeFile(output + '/receipt.json', JSON.stringify({passed: !failure, metadata, executable, data, sourceUrl, events, errors, limitations: ['Real account authorization is not automated by this test.', 'Public source is cloned read-only; no push, fetch or synchronization is invoked.']}, null, 2));
  console.log(output);
}
if (failure) throw failure;
