import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createDriver,nativeTarget,testRoot,until} from './native-driver.mjs';
const output=await fs.mkdtemp(path.join(await fs.mkdir(testRoot,{recursive:true}).then(()=>testRoot),'empty-trash-'));
const data=path.join(output,'data'),root=path.join(data,'workspaces/asMagicBrain/Workspace');
const driver=await createDriver({...nativeTarget(data),output,workspacePath:root});
let page,running=false,failure;
const button=name=>page.getByRole('button',{name,exact:true});
const request=(operation,args={})=>page.evaluate(async input=>{const r=await window.asMagicBrain.request(input);if(!r.ok)throw Error(r.error.message);return r.value;},{repo:'Workspace',operation,args});
const openTrash=async()=>{await page.locator('.rex-viewport').click({button:'right',position:{x:15,y:350}});await page.getByRole('menuitem',{name:'Restore from Trash…',exact:true}).click();await page.getByRole('dialog',{name:'Local Trash',exact:true}).waitFor();};
try{
 page=await driver.launch();running=true;await button('Manage plugins').waitFor();
 await request('create',{path:'Discard.md',text:'# Discard\n'});await request('create',{path:'Keep.md',text:'# Keep\n'});
 await page.reload();await button('README.md').first().click();
 await page.getByRole('treeitem',{name:/^Discard\.md /}).click();await button('Edit this file').click();await page.locator('.cm-content[contenteditable=true]').click();await page.keyboard.press('Meta+End');await page.keyboard.insertText('\nRetained draft to remove.');
 await page.getByRole('treeitem',{name:/^Discard\.md /}).click({button:'right'});await page.getByRole('menuitem',{name:'Move to Trash',exact:true}).click();await page.getByRole('dialog',{name:'Move to Trash?',exact:true}).getByRole('button',{name:'Move to Trash',exact:true}).click();
 await until(async()=>(await request('listTrash')).length===1);
 await openTrash();await driver.screenshot('00-local-trash');await button('Empty Trash…').click();const confirm=page.getByRole('dialog',{name:'Empty Local Trash?',exact:true});await confirm.waitFor();assert.equal(await confirm.getByRole('button',{name:'Cancel',exact:true}).evaluate(el=>el===document.activeElement),true);
 await driver.screenshot('01-confirm-empty-trash');
 await confirm.evaluate(el=>{for(const [selector,label] of [['.rfe-management-paths','V5-T1 · Reviewed Trash items'],['footer','V5-T2 · Cancel / permanent deletion']]){const target=el.querySelector(selector),mark=document.createElement('span');mark.className='qa-mark';mark.textContent=label;Object.assign(mark.style,{display:'block',fontSize:'12px',color:'#8250df'});target.style.outline='2px solid #8250df';target.before(mark);}});await driver.screenshot('01-confirm-empty-trash-annotated');await confirm.evaluate(el=>{el.querySelectorAll('.qa-mark').forEach(e=>e.remove());el.querySelectorAll('[style]').forEach(e=>e.style.removeProperty('outline'));});await confirm.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal((await request('listTrash')).length,1);
 await button('Empty Trash…').click();await confirm.getByRole('button',{name:'Empty Trash',exact:true}).click();await page.getByText('Trash is empty.',{exact:true}).waitFor();assert.equal(await button('Empty Trash…').isDisabled(),true);assert.deepEqual(await request('listTrash'),[]);
 assert.equal((await request('runtimeStatus')).draftPaths.includes('Discard.md'),false);assert.equal(await fs.readFile(path.join(root,'Keep.md'),'utf8'),'# Keep\n');
 await driver.screenshot('02-empty-trash');await button('Close').click();await request('create',{path:'Discard.md',text:'# Fresh file\n'});
 await driver.closeNormally();running=false;page=await driver.launch();running=true;await button('Manage plugins').waitFor();assert.deepEqual(await request('listTrash'),[]);const fresh=await request('open',{path:'Discard.md'});assert.equal(fresh.text,'# Fresh file\n');assert.equal(fresh.draft,null);assert.equal((await request('runtimeStatus')).recoveryRequired,false);
 assert.deepEqual(driver.errors,[]);await driver.closeNormally();running=false;
}catch(error){failure=error;if(page)await fs.writeFile(path.join(output,'failure-aria.yml'),await page.locator('body').ariaSnapshot().catch(()=>''));}
finally{if(running)await driver.closeNormally().catch(()=>{});await driver.report({passed:!failure,failure:failure?.stack});}
if(failure)throw failure;console.log(JSON.stringify({passed:true,output}));
