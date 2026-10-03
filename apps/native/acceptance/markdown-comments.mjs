import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createDriver,nativeTarget,testRoot,until} from './native-driver.mjs';
const output=await fs.mkdtemp(path.join(await fs.mkdir(testRoot,{recursive:true}).then(()=>testRoot),'markdown-comments-'));
const data=path.join(output,'data'),root=path.join(data,'workspaces/asMagicBrain/Workspace');
const driver=await createDriver({...nativeTarget(data),output,workspacePath:root});
let page,running=false,failure;
const button=name=>page.getByRole('button',{name,exact:true});
const editor=()=>page.locator('.cm-content[contenteditable=true]');
const source='# Public heading\n\n<!--\n## Hidden heading\n![Hidden asset](not-present.png)\n```mermaid\nflowchart LR\n A---B\n```\n-->\n\n## Visible section\n\nBefore <!-- private note --> after.\n\n`<!-- code example -->`\n\n<script>window.commentMustNotRun=true</script>\n';
try{
 page=await driver.launch();running=true;await button('Manage plugins').waitFor();await button('README.md').first().click();await button('Edit this file').click();
 await editor().click();await page.keyboard.press('Meta+a');await page.keyboard.insertText('Teacher note');await page.keyboard.press('Meta+a');await page.keyboard.press('Meta+/');assert.equal(await editor().innerText(),'<!-- Teacher note -->');
 await page.getByRole('tab',{name:'Split',exact:true}).click();await until(async()=>!(await page.locator('.rfe-preview').innerText()).includes('Teacher note'));await editor().click();await page.keyboard.press('Meta+/');assert.equal(await editor().innerText(),'Teacher note');
 await page.keyboard.press('Meta+a');await page.keyboard.insertText(source);await until(async()=>(await page.locator('.rfe-preview').innerText()).includes('Visible section'));
 const preview=await page.locator('.rfe-preview').innerText();assert.doesNotMatch(preview,/Hidden heading|Hidden asset|private note/);assert.match(preview,/code example/);assert.match(preview,/window.commentMustNotRun=true/);assert.equal(await page.evaluate(()=>window.commentMustNotRun),undefined);assert.equal(await page.locator('.technical-diagram').count(),0);
 await button('Save').click();await until(async()=>await fs.readFile(path.join(root,'README.md'),'utf8')===source);
 await driver.screenshot('01-comments-source-preview');
 await page.locator('.rfe-editor-frame').evaluate(el=>{const label=document.createElement('p');label.id='qa-comments';label.textContent='V9 · Source retains comments / Preview hides comments';Object.assign(label.style,{position:'absolute',top:'4px',right:'12px',background:'#8250df',color:'white',zIndex:'99',padding:'4px 8px',pointerEvents:'none'});el.style.position='relative';el.append(label);});await driver.screenshot('01-comments-source-preview-annotated');await page.locator('#qa-comments').evaluate(el=>el.remove());
 await driver.closeNormally();running=false;page=await driver.launch();running=true;await button('README.md').first().click();await button('Edit this file').click();await page.getByRole('tab',{name:'Split',exact:true}).click();await until(async()=>(await editor().innerText()).includes('private note'));assert.doesNotMatch(await page.locator('.rfe-preview').innerText(),/private note|Hidden heading/);assert.equal(await fs.readFile(path.join(root,'README.md'),'utf8'),source);
 assert.deepEqual(driver.errors,[]);await driver.closeNormally();running=false;
}catch(error){failure=error;if(page)await fs.writeFile(path.join(output,'failure-aria.yml'),await page.locator('body').ariaSnapshot().catch(()=>''));}
finally{if(running)await driver.closeNormally().catch(()=>{});await driver.report({passed:!failure,failure:failure?.stack});}
if(failure)throw failure;console.log(JSON.stringify({passed:true,output}));
