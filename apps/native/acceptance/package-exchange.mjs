import {assertPackageIdentity} from './package-identity.mjs';
/** Real native package dialogs; all source mutations are confined to this
 * disposable fixture. Save sheets are operated through OS controls separately,
 * never by substituting Electron's dialog or the product bridge. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {testRoot as testBase} from '../../../tools/development-paths.mjs';
import {readZipFiles} from '../../../packages/desktop-host/src/zip-import/index.mjs';
import {recordParentWindow} from './recording.mjs';
assert.deepEqual(process.argv.slice(2),['--run-isolated']);
const pilot=process.env.ASMB_EXCHANGE_SOURCE_PILOT==='1',executable=process.env.ASMB_PACKAGED_EXECUTABLE;
assert.ok(Boolean(pilot)!==Boolean(executable),'Choose explicit source pilot or exact package');
assert.ok(process.env.ASMB_TECHNICAL_FIXTURES);
process.env.ASMB_ACCEPTANCE_RUN_ROOT??=path.join(testBase,'runs/package-exchange');
const {createDriver,nativeTarget,testRoot:runRoot,until,sha}=await import(process.platform==='linux'?'./linux-driver.mjs':'./native-driver.mjs');
await fs.mkdir(runRoot,{recursive:true});const output=await fs.mkdtemp(path.join(runRoot,'exchange-'));
const bundle=pilot?null:process.platform==='linux'?path.dirname(executable):executable.slice(0,executable.indexOf('.app/Contents/MacOS/')+4);
const metadata=pilot?{channel:'development',sourcePilot:true}:JSON.parse(await fs.readFile(path.join(bundle,process.platform==='linux'?'resources/app/native-package.json':'Contents/Resources/app/native-package.json')));
if(!pilot){assertPackageIdentity(metadata);if(process.env.ASMB_EXPECTED_BUILD_NUMBER)assert.equal(metadata.buildNumber,Number(process.env.ASMB_EXPECTED_BUILD_NUMBER));if(process.env.ASMB_EXPECTED_SOURCE_COMMIT)assert.equal(metadata.sourceCommit,process.env.ASMB_EXPECTED_SOURCE_COMMIT);}
const home=path.join(output,'home'),data=metadata.channel==='preview'?path.join(home,'asMagicBrain'):path.join(output,'data');
const organization=path.join(data,'workspaces/asMagicBrain'),repo='Package-Qualification',source=path.join(organization,repo);
const target=metadata.channel==='preview'?{executablePath:executable,args:['--test-root='+testBase,'--test-user-home='+home]}:nativeTarget(data);
const driver=await createDriver({...target,output,workspacePath:path.join(organization,'Workspace')});
await fs.copyFile(new URL('package-exchange.mjs',import.meta.url),path.join(output,'driver-at-launch.mjs'));
const fixtures=path.join(process.env.ASMB_TECHNICAL_FIXTURES,'update-fixtures'),baseZip=path.join(fixtures,'Base-v1.zip'),incomingZip=path.join(fixtures,'Incoming-v2.zip');
const base=new Map();for(const name of ['current.md','notes.md','old.md'])base.set(name,await fs.readFile(path.join(fixtures,'base-v1',name)));
const localNotes=await fs.readFile(path.join(fixtures,'local-edits/notes.md')),personal=await fs.readFile(path.join(fixtures,'local-edits/personal.md'));
let page,live=false,failure,stopRecording;const captures=[],exports=[],videos=[];
const button=name=>page.getByRole('button',{name,exact:true}),dialog=()=>page.getByRole('dialog',{name:'Packages · '+repo,exact:true});
const record=(name,detail={})=>{driver.record(name,detail);console.log(JSON.stringify({event:name,...detail}));};
async function launch(){page=await driver.launch();live=true;await button('asMagicBrain organization').waitFor();await page.context().setOffline(true);if(driver.app)await driver.app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setContentSize(1280,900);w.show();w.focus();});}
async function close(){if(stopRecording){videos.push(await stopRecording());stopRecording=null;}await driver.closeNormally();live=false;}
async function capture(name){await driver.screenshot(name);await fs.writeFile(path.join(output,name+'.yml'),await page.locator('body').ariaSnapshot());captures.push(name+'.png');}
async function annotateReview(){
 await dialog().locator('details').evaluateAll(nodes=>nodes.forEach(node=>{node.open=node.querySelector('summary strong')?.textContent==='notes.md';}));
 await dialog().evaluate(node=>node.scrollTop=0);
 const areas=await page.evaluate(()=>[['PX1 · Packages','.package-dialog header'],['PX3 · Three-way review','.package-dialog .package-rows'],['PX3 · Explicit choices','.package-dialog footer']].map(([name,selector])=>{const r=document.querySelector(selector).getBoundingClientRect();return{name,x:r.x,y:r.y,width:r.width,height:r.height};}));
 await fs.writeFile(path.join(output,'02-package-areas.json'),JSON.stringify(areas,null,2));
 await page.evaluate(areas=>{const root=document.createElement('div');root.id='stage4-overlay';root.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483647';for(const area of areas){const box=document.createElement('div'),label=document.createElement('span');box.style.cssText=`position:fixed;left:${area.x}px;top:${area.y}px;width:${area.width}px;height:${area.height}px;box-sizing:border-box;border:2px solid #8c248b`;label.textContent=area.name;label.style.cssText='position:absolute;right:0;top:0;padding:2px 5px;background:white;color:#8c248b;font:700 11px system-ui';box.append(label);root.append(box);}document.querySelector('dialog[open]').append(root);},areas);
 try{await capture('02-package-review-annotated');}finally{await page.evaluate(()=>document.getElementById('stage4-overlay')?.remove());}
}
async function select(){await button('asMagicBrain organization').click();if(await button('Leave editor').isVisible())await button('Leave editor').click();await button('Open repository '+repo).click();}
async function openPackages(){await button('Create new options').click();await page.locator('.ra-menu-create').getByRole('button',{name:'Update or export package…',exact:true}).click();await dialog().waitFor();await until(()=>dialog().getByRole('button',{name:'Review export',exact:true}).isEnabled(),{label:'package status ready'});}
async function dismiss(){await dialog().getByRole('button',{name:'Close packages',exact:true}).click();await dialog().waitFor({state:'detached'});}
async function review(zip,version,semantics){await dialog().getByLabel('Package ZIP',{exact:true}).setInputFiles(zip);await dialog().getByLabel(semantics?'Incoming version':'Original version',{exact:true}).fill(version);if(semantics)await dialog().getByRole('combobox',{name:'Package contents',exact:true}).selectOption(semantics);await dialog().getByRole('button',{name:'Review package',exact:true}).click();await dialog().getByRole('heading',{name:semantics?'Review changes':'Review original package',exact:true}).waitFor();}
async function resolve(name,choice){const row=dialog().locator('details').filter({has:page.locator('summary strong').filter({hasText:new RegExp('^'+name.replaceAll('.','\\.')+'$')})});if(!await row.evaluate(n=>n.open))await row.locator('summary').click();await dialog().getByLabel('Resolution for '+name,{exact:true}).selectOption(choice);}
async function apply(){await dialog().getByRole('button',{name:'Apply reviewed changes',exact:true}).click();await dialog().getByRole('status').filter({hasText:'Package update saved.'}).waitFor();}
async function checkBase(){for(const[name,bytes]of base)assert.deepEqual(await fs.readFile(path.join(source,name)),name==='notes.md'?localNotes:bytes);assert.deepEqual(await fs.readFile(path.join(source,'personal.md')),personal);const names=await fs.readdir(source);assert.ok(!names.includes('notes incoming.md'));assert.ok(!names.includes('new.md'));}
function verifyOfflineMathAssets(files){
 const byPath=new Map(files.map(file=>[file.path,file.bytes]));
 const stylesheet='reader-assets/katex/katex.min.css',css=byPath.get(stylesheet)?.toString();
 assert.ok(css,'Offline math includes its own stylesheet');
 assert.ok(!/@import\b/i.test(css),'No external stylesheet imports');
 const references=[...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(match=>match[1]);
 assert.ok(references.length>0,'The bundled stylesheet declares physical fonts');
 const fontPaths=[...new Set(references.map(relative=>{
  assert.match(relative,/^fonts\/[A-Za-z0-9_-]+\.(?:woff2?|ttf)$/,'Every CSS font is a relative bundled asset');
  const filename='reader-assets/katex/'+relative;assert.ok(byPath.get(filename)?.length>0,filename+' has bytes');return filename;
 }))];
 const math=byPath.get('reader/math.md.html')?.toString();assert.ok(math);
 assert.match(math,/class="katex-html"/);assert.match(math,/class="katex-mathml"/);
 assert.match(math,/reader-assets\/katex\/katex\.min\.css/);
 assert.match(math,/font-src &#39;self&#39;/);assert.match(math,/script-src &#39;none&#39;/);
 assert.ok(!/<script\b/i.test(math),'Static math needs no JavaScript');
 record('offline-math-bundled-assets',{stylesheet,fontCount:fontPaths.length,fontPaths,accessibleMathml:true,staticHtml:true});
}
async function saveExport(kind){
 const name='qualification-'+kind+'.zip',destination=path.join(output,name);
 await fs.writeFile(path.join(output,'native-save-request.json'),JSON.stringify({kind,destination,nativeDialog:'Export saved files',instruction:'Use native Save sheet to save to this exact disposable output. Do not replace the dialog callback.'},null,2));
 console.log(JSON.stringify({nativeSaveRequired:true,kind,destination,output}));
 await dialog().getByRole('button',{name:kind==='source'?'Save source ZIP…':'Save offline reader…',exact:true}).click({noWaitAfter:true});
 await until(async()=>{try{return(await fs.stat(destination)).isFile();}catch{return false;}},{timeout:240000,interval:250,label:'native Save sheet destination '+kind});
 await dialog().getByRole('status').filter({hasText:'Saved '+name}).waitFor();
 const bytes=await fs.readFile(destination),parsed=readZipFiles(bytes,{stripRoot:false}),names=parsed.files.map(file=>file.path);
 const sourceNames=names.filter(n=>kind==='source'||n.startsWith('source/')).map(n=>kind==='source'?n:n.slice('source/'.length));
 assert.ok(!sourceNames.some(n=>n==='.env'||n.split('/').some(part=>part==='.git'||part.startsWith('.asmb-')||part==='.asmagicbrain')));
 assert.ok(sourceNames.includes('asmagicbrain-package.json'));const manifest=JSON.parse(parsed.files.find(f=>f.path===(kind==='source'?'':'source/')+'asmagicbrain-package.json').bytes);assert.ok(manifest.excluded.some(entry=>entry.path==='.env'&&entry.reason==='suspected-credential-filename'));
 if(kind==='source'){for(const n of ['current.md','notes.md','personal.md'])assert.deepEqual(parsed.files.find(f=>f.path===n)?.bytes,await fs.readFile(path.join(source,n)));assert.ok(names.includes('interactive/slider.html'));}
 else{assert.ok(names.includes('index.html'));verifyOfflineMathAssets(parsed.files);const html=name=>{const file=parsed.files.find(f=>f.path===name);assert.ok(file,name+' is present');return file.bytes.toString();};assert.ok(!/<script\b/i.test(html('index.html')));assert.match(html('reader/math.md.html'),/<math[\s>]/);assert.match(html('reader/diagrams.md.html'),/Mermaid diagram — source fallback/);const slider=html('reader/interactive/slider.html.html');assert.match(slider,/Source view\. Executable content is not run/);assert.match(slider,/&lt;script/);assert.ok(!/<(?:script|iframe|input|canvas)\b/i.test(slider));assert.deepEqual(parsed.files.find(f=>f.path==='source/interactive/poster.png').bytes,await fs.readFile(path.join(source,'interactive/poster.png')));}
 exports.push({kind,file:destination,sha256:sha(bytes),fileCount:names.length});await capture('export-'+kind+'-saved');record('native-save-'+kind+'-portable-copy',{sha256:sha(bytes),fileCount:names.length});
}
async function reimportSource(){
 const exported=exports.find(entry=>entry.kind==='source');assert.ok(exported,'A real native source export must exist before reimport');const importedRepo=repo+'-Reimport',importedRoot=path.join(organization,importedRepo),expected=readZipFiles(await fs.readFile(exported.file),{stripRoot:false}).files;
 await button('Create new options').click();await page.locator('.ra-menu-create').getByRole('button',{name:'Import repository',exact:true}).click();await page.getByLabel('ZIP archive',{exact:true}).setInputFiles(exported.file);await page.getByLabel('Repository name',{exact:true}).fill(importedRepo);await page.locator('.zi-dialog').getByRole('button',{name:'Import repository',exact:true}).click();await page.locator('.zi-dialog').waitFor({state:'detached',timeout:120000});
 await button('asMagicBrain organization').click();if(await button('Leave editor').isVisible())await button('Leave editor').click();await button('Open repository '+importedRepo).click();
 for(const file of expected)assert.deepEqual(await fs.readFile(path.join(importedRoot,file.path)),file.bytes,file.path+' preserved after native import');assert.notEqual(await fs.realpath(importedRoot),await fs.realpath(source));await assert.rejects(fs.stat(path.join(importedRoot,'.env')),{code:'ENOENT'});
 await button('Create new options').click();await page.locator('.ra-menu-create').getByRole('button',{name:'Update or export package…',exact:true}).click();const importedDialog=page.getByRole('dialog',{name:'Packages · '+importedRepo,exact:true});await importedDialog.getByRole('heading',{name:'Record original package',exact:true}).waitFor();await importedDialog.getByRole('button',{name:'Close packages',exact:true}).click();await importedDialog.waitFor({state:'detached'});
 await capture('06-source-reimport-new-repository');record('U06-native-source-ZIP-reimport-different-repository-exact-bytes',{repository:importedRepo,sourceZipSha256:exported.sha256,exactFiles:expected.length,ownership:'Unregistered; portable manifest did not grant package ownership.'});
}
try{
 await launch();if(!pilot&&process.platform==='darwin')stopRecording=await recordParentWindow(page,path.join(output,'package-walkthrough.webm'));await button('Create new options').click();await page.locator('.ra-menu-create').getByRole('button',{name:'Import repository',exact:true}).click();await page.getByLabel('ZIP archive',{exact:true}).setInputFiles(baseZip);await page.getByLabel('Repository name',{exact:true}).fill(repo);await page.locator('.zi-dialog').getByRole('button',{name:'Import repository',exact:true}).click();await page.locator('.zi-dialog').waitFor({state:'detached',timeout:120000});await select();
 const gitHead=spawnSync('/usr/bin/git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();assert.ok(gitHead);
 await openPackages();await review(baseZip,'1');await capture('01-original-package-review');await dialog().getByRole('button',{name:'Record original package',exact:true}).click();await dialog().getByRole('status').filter({hasText:'Original package recorded.'}).waitFor();await dismiss();record('U01-explicit-original-package-registration');
 await fs.writeFile(path.join(source,'notes.md'),localNotes);await fs.writeFile(path.join(source,'personal.md'),personal);
 await openPackages();await review(incomingZip,'2','snapshot');await resolve('current.md','use-incoming');await resolve('notes.md','keep-both');await resolve('new.md','use-incoming');await resolve('old.md','use-incoming');await annotateReview();await capture('02-exact-update-review');await apply();await capture('03-update-completed');
 assert.deepEqual(await fs.readFile(path.join(source,'current.md')),await fs.readFile(path.join(fixtures,'incoming-v2/current.md')));assert.deepEqual(await fs.readFile(path.join(source,'notes.md')),localNotes);assert.deepEqual(await fs.readFile(path.join(source,'personal.md')),personal);assert.ok(!(await fs.readdir(source)).includes('old.md'));assert.ok((await fs.readdir(source)).some(n=>n.includes('incoming')&&n.endsWith('.md')));assert.equal(spawnSync('/usr/bin/git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),gitHead);record('U01-U04-reviewed-update-keep-both-add-owned-remove-personal-preserve-no-commit');
 await dialog().getByRole('button',{name:'Roll back update',exact:true}).click();await dialog().getByRole('status').filter({hasText:'Update rolled back.'}).waitFor();await checkBase();record('U08-exact-backup-rollback');
 await review(incomingZip,'2','patch');await resolve('current.md','use-incoming');await resolve('notes.md','keep-current');await resolve('new.md','use-incoming');await fs.writeFile(path.join(source,'current.md'),'External change after review\n');await dialog().getByRole('button',{name:'Apply reviewed changes',exact:true}).click();await dialog().getByRole('alert').filter({hasText:'Prepare a new review'}).waitFor();assert.equal(await fs.readFile(path.join(source,'current.md'),'utf8'),'External change after review\n');await capture('04-stale-review-refused');await dialog().getByRole('button',{name:'Back',exact:true}).click();await fs.writeFile(path.join(source,'current.md'),base.get('current.md'));record('U02-stale-plan-refuses-without-overwriting-external-change');
 await review(incomingZip,'2','patch');await resolve('current.md','use-incoming');await resolve('notes.md','keep-current');await resolve('new.md','use-incoming');await apply();assert.deepEqual(await fs.readFile(path.join(source,'old.md')),base.get('old.md'));record('U04-patch-absence-preserves-owned-file');await dismiss();
 // Add unchanged, reviewed neutral reproduction files to the disposable copy.
 for(const name of ['math.md','diagrams.md','interactive/slider.html','interactive/poster.png']){const bytes=await fs.readFile(path.join(process.env.ASMB_TECHNICAL_FIXTURES,'repro',name));await fs.mkdir(path.dirname(path.join(source,name)),{recursive:true});await fs.writeFile(path.join(source,name),bytes);}
 await fs.writeFile(path.join(source,'.env'),'SYNTHETIC_NOT_A_CREDENTIAL=example\n');
 await openPackages();await dialog().getByRole('button',{name:'Review export',exact:true}).click();await dialog().getByRole('heading',{name:'Review export',exact:true}).waitFor();await dialog().locator('.package-warning').filter({hasText:'.env'}).waitFor();await capture('05-portable-export-review');
 if(!pilot){await saveExport('source');await saveExport('offline');}else record('source-pilot-native-save-pending-exact-candidate');
 await dismiss();if(!pilot)await reimportSource();assert.deepEqual(await fs.readFile(path.join(source,'personal.md')),personal);assert.equal(spawnSync('/usr/bin/git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),gitHead);assert.deepEqual(driver.errors,[]);assert.deepEqual(driver.consoleErrors,[]);await close();
 await launch();await select();await openPackages();assert.ok((await dialog().innerText()).includes('Recorded collection: '+repo+' · 2'));await capture('07-restart-package-state');await dismiss();await close();record('native-restart-private-registration-and-normal-close');
}catch(error){failure=error;try{if(page)await capture('failure');}catch{}record('failure',{message:String(error),stack:error.stack});}
finally{if(live)try{await close();}catch(error){failure??=error;}await driver.report({status:failure?'failed':'passed',metadata,captures,exports,videos,fixture:fixtures,limitations:['Crash phases, hostile ZIPs, draft-protected rows and later-edit rollback conflicts have separate host/core tests.','Native Save sheets are real OS UI; this driver waits for explicitly operated output paths.','Offline export has static fallback for diagrams and interactive code; no promise of live HTML in this static copy.'],failure:failure?String(failure):null});}
console.log(JSON.stringify({output,passed:!failure}));if(failure)throw failure;
