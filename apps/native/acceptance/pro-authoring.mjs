import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createDriver,nativeTarget,testRoot,until} from './native-driver.mjs';
const output=await fs.mkdtemp(path.join(await fs.mkdir(testRoot,{recursive:true}).then(()=>testRoot),'authoring-'));
const data=path.join(output,'data'),root=path.join(data,'workspaces/asMagicBrain/Workspace');
const driver=await createDriver({...nativeTarget(data),output,workspacePath:root});
let page,running=false,failure;
const button=name=>page.getByRole('button',{name,exact:true});
const editor=()=>page.locator('.cm-content[contenteditable=true]');
const replace=async text=>{await editor().click();await page.keyboard.press('Meta+a');await page.keyboard.insertText(text);};
const text=()=>editor().innerText();
try{
 page=await driver.launch();running=true;await button('Manage plugins').waitFor();
 await page.evaluate(async()=>{const r=await window.asMagicBrain.request({repo:'Workspace',operation:'create',args:{path:'Other file.md',text:'# Other\n'}});if(!r.ok)throw Error(r.error.message);});
 await driver.app.evaluate(({dialog},filename)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[filename]});},path.resolve('packages/pro-editor-plugin/asMagicBrain-Pro-Editor-0.1.0.asmbplugin'));
 await button('Manage plugins').click();await button('Install plugin…').click();await button('Install plugin').click();await page.getByRole('switch',{name:'Enable Pro Editor',exact:true}).click();
 await button('Return to workspace').click();
 // Open README through the existing repository table.
 await page.getByRole('button',{name:'README.md',exact:true}).first().click();await button('Edit this file').click();
 await page.getByRole('group',{name:'Markdown formatting',exact:true}).waitFor();
 await replace('hello');await page.keyboard.press('Meta+a');await page.keyboard.press('Meta+b');assert.equal(await text(),'**hello**');await page.keyboard.press('Meta+b');assert.equal(await text(),'hello');
 await page.keyboard.press('Meta+i');assert.equal(await text(),'*hello*');await page.keyboard.press('Meta+z');assert.equal(await text(),'hello');
 await page.keyboard.press('Meta+2');assert.equal(await text(),'## hello');
 await replace('/tab');await page.getByRole('option',{name:/table/}).waitFor();await page.keyboard.press('Tab');assert.match(await text(),/Column 1/);await page.keyboard.insertText('Name');await page.keyboard.press('Tab');await page.keyboard.insertText('Value');assert.match(await text(),/Name \| Value/);
 await replace('```py');await page.getByRole('option',{name:/python/}).waitFor();await page.keyboard.press('Tab');assert.equal(await text(),'```python');
 await replace('[Other](');await page.getByRole('option',{name:/Other%20file.md/}).waitFor();await page.getByRole('option',{name:/Other%20file.md/}).click();await page.keyboard.insertText(')');assert.equal(await text(),'[Other](Other%20file.md)');
 await button('Save').click();await until(async()=> (await fs.readFile(path.join(root,'README.md'),'utf8')).includes('[Other](Other%20file.md)'));
 await page.getByRole('tab',{name:'Split',exact:true}).click();await page.getByLabel('Insert Markdown',{exact:true}).selectOption('table');await until(async()=> (await text()).includes('Column 1'));
 await page.evaluate(()=>{for(const [selector,label] of [['.pro-authoring','PA1 · Formatting and snippets'],['.rfe-editor-frame','PA2 · One CM6 document / live preview']]){const el=document.querySelector(selector),r=el.getBoundingClientRect(),mark=document.createElement('div');mark.className='qa-mark';Object.assign(mark.style,{position:'fixed',pointerEvents:'none',zIndex:99999,left:r.left+'px',top:r.top+'px',width:r.width+'px',height:Math.min(r.height,innerHeight-r.top)+'px',outline:'2px solid #8250df'});const badge=document.createElement('span');badge.textContent=label;Object.assign(badge.style,{background:'#8250df',color:'white',fontSize:'12px'});mark.append(badge);document.body.append(mark);}});await driver.screenshot('authoring-annotated');await page.evaluate(()=>document.querySelectorAll('.qa-mark').forEach(e=>e.remove()));
 await driver.closeNormally();running=false;page=await driver.launch();running=true;
 await page.getByRole('button',{name:'README.md',exact:true}).first().click();await button('Edit this file').waitFor();await button('Edit this file').click();await until(async()=> (await text()).includes('Column 1'));
 await button('Manage plugins').click();await page.getByRole('switch',{name:'Enable Pro Editor',exact:true}).click();await button('Return to workspace').click();assert.equal(await page.getByRole('group',{name:'Markdown formatting',exact:true}).count(),0);
 assert.deepEqual(driver.errors,[]);await driver.closeNormally();running=false;
}catch(e){failure=e;if(page)await fs.writeFile(path.join(output,'failure-aria.yml'),await page.locator('body').ariaSnapshot().catch(()=>''));}
finally{if(running)await driver.closeNormally().catch(()=>{});await driver.report({passed:!failure,failure:failure?.stack});}
if(failure)throw failure;console.log(JSON.stringify({passed:true,output}));
