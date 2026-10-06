/** Actual native clipboard, direct Students generation and repeat-click preservation. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDriver,nativeTarget,testRoot} from './native-driver.mjs';
const output=await fs.mkdtemp(path.join(testRoot,'teach-calendar-copy-')),data=path.join(output,'data'),driver=await createDriver({...nativeTarget(data),output,workspacePath:data});let page,running=false,failure;
const call=input=>page.evaluate(async input=>{const reply=await window.asMagicBrain.nativeTeachRequest(input);if(!reply.ok)throw Error(reply.error.message);return reply.value;},input);
const button=name=>page.getByRole('button',{name,exact:true});
try{
 page=await driver.launch();running=true;await page.locator('.rc-document').waitFor();if(await page.locator('dialog.ws-search-dialog[open]').count())await page.keyboard.press('Escape');
 await driver.app.evaluate(({dialog},filename)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[filename]});},process.env.ASMB_TEACH_PACKAGE);
 await button('Manage plugins').click();await button('Install plugin…').click();await button('Install plugin').click();await page.getByRole('switch',{name:'Enable asTeach',exact:true}).click();
 const course=await call({operation:'create',requestId:randomUUID(),code:'COPY101',name:'Synthetic copy test',year:2026,season:'autumn',structureVersion:2});
 await driver.closeNormally();running=false;page=await driver.launch();running=true;
 await button('asTeach').click();await button('Courses — all courses').click();await button('Open course COPY101').click();await button('Choose course page').click();await page.getByRole('menuitem',{name:'Course calendar',exact:true}).click();
 await page.locator('.tcal-settings input[type=text]').fill('20261019');await page.getByLabel('Total number of weeks').fill('3');await page.locator('.tcal-settings').getByRole('button',{name:'Save',exact:true}).click();
 await button('Add class session').click();const session=page.getByRole('dialog',{name:'Add class session'});await session.getByLabel('Class name').fill('Lecture');await session.locator('select').selectOption('1');await session.getByLabel('Start time').fill('09:00');await session.getByLabel('End time').fill('10:20');await session.getByLabel('Room or location (optional)').fill('CR6');await session.getByRole('button',{name:'Add session',exact:true}).click();await session.waitFor({state:'hidden'});
 // Only read back clipboard content after overwriting it with our synthetic marker.
 await driver.app.evaluate(({clipboard})=>clipboard.writeText('Synthetic clipboard marker'));
 await button('One-Page Course').click();await page.getByText('Schedule copied',{exact:true}).waitFor();let copied=await driver.app.evaluate(({clipboard})=>clipboard.readText());assert.match(copied,/Oct 20: Class 01/);assert.match(copied,/Nov 03: Class 03/);
 await button('Multi-Page Course').click();await page.getByText('Class pages saved. Schedule copied.',{exact:true}).waitFor();copied=await driver.app.evaluate(({clipboard})=>clipboard.readText());assert.match(copied,/\[ClassContent\]\(classes\/Class03.md\)/);
 const descriptor=await call({operation:'workspaceDescriptor',repo:course.repo}),student=descriptor.roles.find(r=>r.role==='students').name,folder=path.join(data,'workspaces/asMagicBrain',student,'2026-autumn/classes'),names=await fs.readdir(folder),before=await Promise.all(names.map(n=>fs.readFile(path.join(folder,n),'utf8')));assert.equal(names.length,3);
 await driver.app.evaluate(({clipboard})=>clipboard.writeText('Synthetic second-copy marker'));await button('Multi-Page Course').click();await page.getByText('Class pages saved. Schedule copied.',{exact:true}).waitFor();assert.equal(await driver.app.evaluate(({clipboard})=>clipboard.readText()),copied);assert.deepEqual(await Promise.all(names.map(n=>fs.readFile(path.join(folder,n),'utf8'))),before);
 driver.record('native-one-and-multi-page-clipboard-and-idempotence');await driver.screenshot('calendar-copy-passed');await driver.closeNormally();running=false;
}catch(error){failure=error;if(page)await driver.screenshot('failure').catch(()=>{});}finally{if(running)await driver.closeNormally().catch(()=>{});await driver.report({passed:!failure,failure:failure?.stack});}
console.log(output);if(failure)throw failure;
