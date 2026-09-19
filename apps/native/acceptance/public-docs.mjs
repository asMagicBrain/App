/** Real packaged documentation acceptance. Uses only disposable local Test data. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {testRoot as testBase} from '../../../tools/development-paths.mjs';
assert.deepEqual(process.argv.slice(2), ['--run-isolated']);
assert.ok(process.env.ASMB_PACKAGED_EXECUTABLE, 'Supply the packaged application executable.');
process.env.ASMB_ACCEPTANCE_RUN_ROOT ??= path.join(testBase, 'runs/public-docs');
const {createDriver, nativeTarget, testRoot: runRoot, until, sha} = await import(process.platform==='linux'?'./linux-driver.mjs':'./native-driver.mjs');
await fs.mkdir(runRoot, {recursive:true});
const output = await fs.mkdtemp(path.join(runRoot, 'docs-'));
const executable = process.env.ASMB_PACKAGED_EXECUTABLE;
const bundle = process.platform==='linux'?path.dirname(executable):executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
const appPayload=path.join(bundle,process.platform==='linux'?'resources/app':'Contents/Resources/app');
const metadata = JSON.parse(await fs.readFile(path.join(appPayload,'native-package.json')));
const home = path.join(output, 'home');
const data = metadata.channel === 'preview' ? path.join(home, 'asMagicBrain') : path.join(output, 'data');
const organization = path.join(data, 'workspaces/asMagicBrain');
const docsName = 'asMagicBrain-Docs';
const target = metadata.channel === 'preview' ? {executablePath:executable,args:['--test-root='+testBase,'--test-user-home='+home]} : nativeTarget(data);
const driver = await createDriver({...target,output,workspacePath:path.join(organization,'Workspace')});
await fs.copyFile(new URL(import.meta.url),path.join(output,'driver-at-launch.mjs'));
let page, running=false, failure;
const button = name => page.getByRole('button',{name,exact:true});
const catalogNames = () => page.locator('.ar-repositories > li').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-repository-name')));
const record = (event,details={}) => {driver.record(event,details);console.log(JSON.stringify({event}));};
const git = (...args) => execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',path.join(organization,docsName),...args],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
async function launch(){page=await driver.launch();running=true;await page.context().setOffline(true);if(process.platform!=='linux')await driver.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,1000));await button('asMagicBrain organization').waitFor();await page.locator('.rc-document').waitFor();}
async function close(){await driver.closeNormally();running=false;}
async function catalog(){await button('asMagicBrain organization').click();await page.locator('.ar-view').waitFor();await until(async()=>!(await page.locator('.ar-loading').count()),{label:'repository catalog'});}
async function waitForGuide(filename){
  const expectedTitle=(await fs.readFile(path.join(organization,docsName,filename),'utf8')).match(/^# (.+)$/m)?.[1];
  assert.ok(expectedTitle,'Guide has a title in its saved source');
  await until(async()=>await page.locator('.rfe-file-name').innerText()===filename&&await page.locator('.rfe-preview h1').innerText()===expectedTitle,{label:'render guide '+filename});
}
async function openDocs(){await button('Open repository '+docsName).click();await page.locator('.rc-document').waitFor();await page.getByRole('table',{name:'Directory contents'}).getByRole('button',{name:'README.md',exact:true}).click();await waitForGuide('README.md');}
async function screenshot(name,overlay=false){
  await driver.screenshot(name);
  if(!overlay)return;
  const areas=await page.evaluate(()=>Object.entries({'V1 / E1 · Application bar':'.fw-titlebar','V2 · Account & appearance':'.fw-rail','V4 / E3 · Repository controls':'.rfe-sidebar-header','V5 · Files':'.rfe-tree','V7 · File path':'.rfe-context','V8 · Last local commit':'.rfe-file-commit','V9 · Preview / Code actions':'.rfe-toolbar','V12 / E8 · Document':'.rfe-editor-frame [role=tabpanel]:not([hidden])','Outline · Heading navigation':'.ido-panel'}).flatMap(([label,selector])=>{const element=document.querySelector(selector);if(!element||!element.checkVisibility())return [];const r=element.getBoundingClientRect();return [{label,x:r.x,y:r.y,width:r.width,height:r.height}];}));
  await fs.writeFile(path.join(output,name+'-areas.json'),JSON.stringify(areas,null,2)+'\n');
  await page.evaluate(areas=>{const layer=document.createElement('div');layer.id='docs-area-overlay';layer.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483647';areas.forEach((r,i)=>{const color=['#a32638','#6639b0','#08714c','#00738b','#a36a0c'][i%5],box=document.createElement('div'),badge=document.createElement('span');box.style.cssText=`position:fixed;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;border:2px solid ${color};background:${color}12;box-sizing:border-box`;badge.textContent=r.label;badge.style.cssText=`background:white;color:${color};font:700 11px system-ui;padding:2px 4px`;box.append(badge);layer.append(box);});document.body.append(layer);},areas);
  await driver.screenshot(name+'-overlay');await page.evaluate(()=>document.getElementById('docs-area-overlay').remove());
}
try{
  await launch();
  const manifest=JSON.parse(await fs.readFile(path.join(appPayload,'docs-manifest.json')));
  for(const file of manifest.files)assert.equal(sha(await fs.readFile(path.join(organization,docsName,file.path))),file.sha256);
  const docsHead=git('rev-parse','HEAD'),workspaceOriginal=await fs.readFile(path.join(organization,'Workspace/README.md'));
  assert.equal(git('status','--porcelain'),'');assert.equal(git('remote'),'');
  record('fresh-offline-docs-local-git-exact-payload',{files:manifest.files.length,digest:manifest.digest});
  await button('asMagicBrain Theme').click();await page.locator('.fw-theme-picker select').selectOption({label:'GitHub Light Default'});await page.locator('.fw-theme-picker').getByRole('button',{name:'Done'}).click();
  await catalog();assert.deepEqual(await catalogNames(),['Workspace',docsName]);assert.equal(await button(docsName+' stays last').isDisabled(),true);
  await page.getByRole('combobox',{name:'Sort repositories'}).selectOption('desc');assert.deepEqual(await catalogNames(),['Workspace',docsName]);
  await button('New repository').click();await page.getByLabel('Repository name',{exact:true}).fill('Notes');await page.locator('.nr-dialog').getByRole('button',{name:'Create repository',exact:true}).click();await page.locator('.nr-dialog').waitFor({state:'detached'});
  await catalog();await button('Pin Notes').click();await until(()=>button('Unpin Notes').isEnabled(),{label:'pin persisted'});assert.deepEqual(await catalogNames(),['Workspace','Notes',docsName]);
  await driver.screenshot('catalog-docs-last');
  await button('asMagicBrain home').click();await page.locator('.wh-view').waitFor();assert.equal(await page.locator('.wh-repository-name').last().innerText(),docsName);
  await page.locator('.rh-trigger').click();assert.equal(await page.locator('.rh-list > button').last().innerText().then(v=>v.replace(/Public|Private|✓/g,'').trim()),docsName);await page.keyboard.press('Escape');
  record('docs-last-catalog-desc-sort-pins-home-switcher');
  await catalog();await openDocs();
  assert.equal(await button('Edit this file').isDisabled(),true);assert.equal(await button('Rename repository').isDisabled(),true);
  assert.equal(await page.locator('.cm-content[contenteditable=true]').count(),0);
  await button('Copy file path').click();await until(()=>page.locator('.rfe-path-copy-status').innerText().then(v=>v==='Path copied'),{label:'inline copy feedback'});
  const link=page.locator('.rfe-preview').getByRole('link',{name:'Getting started',exact:true});await link.click();await waitForGuide('getting-started.md');
  await page.getByRole('tab',{name:'Code',exact:true}).click();await page.locator('.rfe-source:not([hidden]) .cm-content').waitFor({state:'visible'});assert.equal(await page.locator('.cm-content[contenteditable=true]').count(),0);await page.getByRole('tab',{name:'Preview',exact:true}).click();await waitForGuide('getting-started.md');
  const outlineButton=page.getByRole('button',{name:/^(Show|Open|Toggle) document outline$/});
  if(await outlineButton.count())await outlineButton.click();
  await screenshot('public-docs-reading',true);
  await page.locator('.rfe-preview').getByRole('link',{name:'Documentation',exact:true}).click();
  await waitForGuide('README.md');
  const guideLinks=await page.locator('.rfe-preview a[data-local-link]').evaluateAll(links=>links.map(link=>link.getAttribute('data-local-link')).filter(href=>href.endsWith('.md')&&href!=='README.md'));
  assert.deepEqual([...new Set(guideLinks)].sort(),manifest.files.map(file=>file.path).filter(name=>name.endsWith('.md')&&name!=='README.md').sort(),'Every bundled guide is reachable from the contents');
  for(const guide of guideLinks){
    await page.locator('.rfe-preview a[data-local-link='+JSON.stringify(guide)+']').click();
    await waitForGuide(guide);
    await page.locator('.rfe-preview').getByRole('link',{name:'Documentation',exact:true}).click();
    await waitForGuide('README.md');
  }
  await page.locator('.rfe-preview a[data-local-link="interface.md"]').click();
  await waitForGuide('interface.md');
  for(const illustration of await page.locator('.rfe-preview img').all()){
    await illustration.scrollIntoViewIfNeeded();
    await until(()=>illustration.evaluate(image=>image.complete&&image.naturalWidth>0),{label:'native documentation image decode'});
  }
  record('all-bundled-user-guides-open-from-contents',{guides:guideLinks});
  const refused=await page.evaluate(async repo=>{const b=window.asMagicBrain;return Promise.all([b.renameRepository({repository:repo,name:'Changed'}),b.trashRepository({repository:repo,requestId:crypto.randomUUID()}),b.setRepositoryPinned({repo,pinned:true}),b.request({repo,operation:'checkpointNew',args:{draftId:crypto.randomUUID(),path:'modified.md',text:'no'}})]);},docsName);
  assert.ok(refused.every(value=>!value.ok&&value.error.code==='DOCS_READ_ONLY'),JSON.stringify(refused));
  record('docs-ui-readonly-preview-code-links-copy-host-mutation-guards');
  await catalog();await button('Repository actions for '+docsName).click();await page.getByRole('menuitem',{name:'Duplicate…',exact:true}).click();await page.getByLabel('Repository name',{exact:true}).fill('Documentation-notes');await page.getByRole('dialog',{name:'Duplicate repository'}).getByRole('button',{name:'Duplicate repository',exact:true}).click();await page.getByRole('dialog',{name:'Duplicate repository'}).waitFor({state:'detached',timeout:60000});
  await button('Open repository Documentation-notes').click();await page.locator('.rc-document').waitFor();await page.getByRole('table',{name:'Directory contents'}).getByRole('button',{name:'README.md',exact:true}).click();await waitForGuide('README.md');await until(()=>button('Edit this file').isEnabled(),{label:'editable duplicate'});await button('Edit this file').click();const editor=page.locator('.cm-content[contenteditable=true]');await editor.click();await editor.press(process.platform==='darwin'?'Meta+End':'Control+End');await page.keyboard.insertText('\n\nPersonal documentation note.\n');await button('Save').click();await until(()=>fs.readFile(path.join(organization,'Documentation-notes/README.md'),'utf8').then(v=>v.includes('Personal documentation note.')),{label:'duplicate saved'});
  assert.equal(git('rev-parse','HEAD'),docsHead);assert.equal(git('status','--porcelain'),'');assert.deepEqual(await fs.readFile(path.join(organization,'Workspace/README.md')),workspaceOriginal);
  record('duplicate-docs-edits-independent-copy-original-and-Workspace-preserved');
  await close();await launch();await catalog();assert.equal((await catalogNames()).at(-1),docsName);assert.equal(await button('Unpin Notes').isEnabled(),true);await openDocs();assert.equal(await button('Edit this file').isDisabled(),true);assert.equal(git('rev-parse','HEAD'),docsHead);record('normal-restart-preserves-docs-Git-pins-and-readonly-policy');
  assert.equal(driver.errors.length,0);await close();
}catch(error){failure={message:error.message,stack:error.stack};console.error(error.stack);try{await driver.screenshot('failure');await fs.writeFile(path.join(output,'failure-dom.txt'),await page.locator('body').innerText());}catch{}try{if(running||driver.app||process.platform==='linux')await close();}catch(e){failure.close=e.message;}process.exitCode=1;}
finally{await driver.report({status:failure?'failed':'passed',failure,metadata,scope:'Fresh offline packaged managed Docs, repository ordering, readonly enforcement, reader links, editable duplicate and normal restart. No live profile or remote account operation.'});console.log(JSON.stringify({status:failure?'failed':'passed',output}));}
