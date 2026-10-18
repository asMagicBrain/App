import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createDriver,nativeTarget,testRoot,until} from './native-driver.mjs';
import {createArtifactProbe} from './pro-editor-probe.mjs';
import {buildArtifactManifest} from '../../../tools/create-artifact-manifest.mjs';
import {createInteractiveFixtures} from './interactive-fixtures.mjs';
assert.deepEqual(process.argv.slice(2),['--run-isolated']);
await fs.mkdir(testRoot,{recursive:true});
const output=await fs.mkdtemp(path.join(testRoot,'interactive-examples-')),data=path.join(output,'data'),repo=path.join(data,'workspaces/asMagicBrain/Workspace');
const driver=await createDriver({...nativeTarget(data),output,workspacePath:repo});
let page,probe,child,live=false,failure,presenting=false;const results=[];
const status=()=>page.evaluate(async()=>{const r=await window.asMagicBrain.artifactStatus();return r.value??r;});
const surface=name=>page.locator(`${presenting?'.document-presentation-content ':''}[data-artifact="${name}.artifact.json"]`);
async function activate(name){const slot=surface(name);await slot.getByRole('button',{name:'Open interactive example',exact:true}).click();await slot.getByRole('button',{name:'Run interactive view',exact:true}).click();const target=await until(async()=>(await probe.targets())[0],{label:'explicitly activated example'});child=await probe.attach(target.targetId);await until(async()=>(await status()).state==='running',{label:'running example'});await child.evaluate('document.fonts.ready');await new Promise(resolve=>setTimeout(resolve,500));await driver.app.evaluate(({webContents})=>webContents.getAllWebContents().find(w=>w.getURL().startsWith('asmb-artifact:')).focus());return slot;}
try{
 page=await driver.launch();live=true;await page.getByRole('heading',{name:'Workspace',exact:true}).first().waitFor();await driver.closeNormally();live=false;
 const names=await createInteractiveFixtures(repo);
 await fs.writeFile(path.join(repo,'failure.html'),'<html><body><p>Static explanation</p><script>setTimeout(()=>{throw Error("Synthetic example failure")},100);</script></body></html>');
 await fs.writeFile(path.join(repo,'failure.md'),'Synthetic fallback remains readable.');
 await fs.writeFile(path.join(repo,'missing.json'),'{}');
 for(const name of ['failure','missing']){const manifest=buildArtifactManifest({root:repo,id:'teaching.'+name,title:'Synthetic '+name,entry:'failure.html',fallback:'failure.md',assets:name==='missing'?['missing.json']:[]});await fs.writeFile(path.join(repo,name+'.artifact.json'),JSON.stringify(manifest));await fs.appendFile(path.join(repo,'README.md'),'\n## Synthetic '+name+'\n\n```asmb-interactive\n'+JSON.stringify({path:name+'.artifact.json',caption:'Synthetic '+name,fallback:'Static explanation remains available.'})+'\n```\n');}
 await fs.unlink(path.join(repo,'missing.json'));

 page=await driver.launch();live=true;probe=await createArtifactProbe(page);await page.getByRole('button',{name:'README.md',exact:true}).first().click();
 for(const mode of ['Preview','Present']){
  if(mode==='Present'){presenting=true;await page.getByRole('button',{name:'Present',exact:true}).click();await page.locator('.document-presentation-content').waitFor();}
  for(const name of names){
   if(mode==='Present'){const content=page.locator('.document-presentation-content');await content.press('Home');let steps=0;while(!await surface(name).count()){assert.ok(++steps<100,'example is reachable');await content.press('ArrowRight');}}
   const slot=await activate(name),run=(await status()).runId;
   assert.ok(await child.evaluate('[...document.fonts].some(f=>f.family==="MiSans"&&f.status==="loaded")'));
   const initial=await child.evaluate('document.querySelector("#control").value');const before=await child.evaluate('document.querySelector("#result").textContent');const plotBefore=await child.evaluate('document.querySelector("svg").innerHTML');
   await child.click('#control');assert.equal(await child.evaluate('document.activeElement.id'),'control');await child.key('End','End',35);
   assert.notEqual(await child.evaluate('document.querySelector("#result").textContent'),before);assert.notEqual(await child.evaluate('document.querySelector("svg").innerHTML'),plotBefore);
   await driver.screenshot(name+'-'+mode);const shot=await child.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(output,name+'-'+mode+'-widget.png'),Buffer.from(shot.data,'base64'));
   const oldTarget=(await probe.targets())[0].targetId;await slot.getByRole('button',{name:'Reset',exact:true}).click();await child.detach();const target=await until(async()=>(await probe.targets()).find(t=>t.targetId!==oldTarget),{label:'new reset target'});child=await probe.attach(target.targetId);await until(()=>child.evaluate('document.querySelector("#control")?.value').then(v=>v===initial),{label:'reset original state'});assert.notEqual((await status()).runId,run);
   await slot.getByRole('button',{name:'Close interactive view',exact:true}).click();await child.detach();child=null;results.push({name,mode,livePlot:true,reset:true});
  }
  if(mode==='Present'){await page.locator('.document-presentation-content').press('Escape');await page.locator('.document-presentation-content').waitFor({state:'detached'});presenting=false;}
 }
 const missing=surface('missing');await missing.getByRole('button',{name:'Open interactive example',exact:true}).click();await missing.getByRole('alert').waitFor();assert.equal((await probe.targets()).length,0);await missing.getByRole('button',{name:'Close interactive view',exact:true}).click();results.push({case:'missing declared asset',refused:true});
 const failed=surface('failure');await failed.getByRole('button',{name:'Open interactive example',exact:true}).click();await failed.getByRole('button',{name:'Run interactive view',exact:true}).click();await until(async()=>(await status()).errorCode==='ARTIFACT_SCRIPT_ERROR',{label:'script error visible'});await failed.getByRole('alert').waitFor();assert.equal((await probe.targets()).length,0);await failed.getByRole('button',{name:'Close interactive view',exact:true}).click();results.push({case:'script error',disposed:true});
 await page.reload();await page.getByRole('button',{name:'README.md',exact:true}).first().click();assert.equal((await probe.targets()).length,0,'refresh does not implicitly run examples');
 await driver.closeNormally();live=false;assert.deepEqual(driver.errors,[]);assert.deepEqual(driver.consoleErrors,[]);
}catch(error){failure=error;console.error(error);await driver.screenshot('failure').catch(()=>{});}
finally{await child?.detach().catch(()=>{});await probe?.dispose().catch(()=>{});if(live)await driver.closeNormally().catch(()=>{});await driver.report({passed:!failure,failure:failure?.stack??null,results,scope:'Four original illustrative mathematical examples, actual native Preview/Present, local MiSans, live SVG, reset and explicit activation after refresh.'});}
console.log(output);if(failure)process.exitCode=1;
