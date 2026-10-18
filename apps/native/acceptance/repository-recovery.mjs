/** Actual startup with replaced repositories; no personal profile or binding edits. */
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {createDriver,nativeTarget,testRoot} from './native-driver.mjs';
assert.deepEqual(process.argv.slice(2),['--run-isolated']);await fs.mkdir(testRoot,{recursive:true});
const output=await fs.mkdtemp(path.join(testRoot,'repository-recovery-')),data=path.join(output,'data'),org=path.join(data,'workspaces/asMagicBrain'),source=path.join(org,'Assistants'),preserved=path.join(output,'preserved-assistants');
const driver=await createDriver({...nativeTarget(data),output,workspacePath:path.join(org,'Workspace')});let page,live=false,failure;
async function call(method,input){const reply=await page.evaluate(async({method,input})=>window.asMagicBrain[method](input),{method,input});assert.equal(reply.ok,true,JSON.stringify(reply));return reply.value;}
try{
 page=await driver.launch();live=true;await page.getByRole('heading',{name:'Workspace',exact:true}).first().waitFor();
 await call('createRepository',{name:'Assistants',requestId:'11111111-1111-4111-8111-111111111111'});
 await call('request',{repo:'Assistants',operation:'checkpointNew',args:{draftId:'retained',path:'private.md',text:'retained private draft'}});
 await driver.closeNormally();live=false;await fs.rename(source,preserved);await fs.mkdir(source);await fs.writeFile(path.join(source,'README.md'),'replacement stays unchanged');
 page=await driver.launch();live=true;await page.locator('.fw-repository-recovery').waitFor();await page.locator('.fw-repository-recovery summary').click();await page.getByText('Assistants:',{exact:false}).first().waitFor();await page.getByRole('button',{name:'Recheck repositories',exact:true}).click();await page.getByRole('heading',{name:'Workspace',exact:true}).first().waitFor();
 const catalog=await call('catalog');assert.equal(catalog.repositoryRecovery[0].name,'Assistants');assert.ok(!catalog.repositories.some(r=>r.name==='Assistants'));assert.match((await call('read',{repo:'Workspace'})).readme,/Workspace/);
 const blocked=await page.evaluate(()=>window.asMagicBrain.bootstrap('Assistants'));assert.equal(blocked.ok,false);assert.equal(blocked.error.code,'REPOSITORY_RECOVERY_REQUIRED');await driver.screenshot('secondary-held-healthy-workspace');
 await driver.closeNormally();live=false;assert.equal(await fs.readFile(path.join(source,'README.md'),'utf8'),'replacement stays unchanged');await fs.rename(source,path.join(output,'replacement-preserved'));await fs.rename(preserved,source);
 page=await driver.launch();live=true;await page.getByRole('heading',{name:'Workspace',exact:true}).first().waitFor();assert.deepEqual((await call('bootstrap','Assistants')).newDrafts,[{draftId:'retained',path:'private.md',text:'retained private draft'}]);assert.deepEqual((await call('catalog')).repositoryRecovery,[]);await driver.closeNormally();live=false;
 await fs.rename(path.join(org,'Workspace'),path.join(output,'preserved-default'));
 page=await driver.launch();live=true;await page.getByRole('heading',{name:'Assistants',exact:true}).first().waitFor();await driver.screenshot('missing-default-healthy-fallback');await driver.closeNormally();live=false;
 if(!catalog.repositories.some(r=>r.builtin==='documentation')){await fs.rename(source,preserved);page=await driver.launch();live=true;await page.getByRole('heading',{name:'Repositories need recovery',exact:true}).waitFor();await page.getByRole('button',{name:'Recheck repositories',exact:true}).click();await page.getByRole('heading',{name:'Repositories need recovery',exact:true}).waitFor();await driver.screenshot('all-held-recovery-screen');await driver.closeNormally();live=false;}
 assert.deepEqual(driver.errors,[]);driver.record('startup-isolation-restoration-private-drafts-fallback-and-empty-recovery');
}catch(error){failure=error;console.error(error);await driver.screenshot('failure').catch(()=>{});}finally{if(live)await driver.closeNormally().catch(()=>{});await driver.report({passed:!failure,failure:failure?.stack??null,scope:'Synthetic replaced and missing repositories; actual packaged launch required separately'});}console.log(output);if(failure)process.exitCode=1;
