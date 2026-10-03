/** Native Push review UI; synthetic account/result seam, real guarded review.
 * Live GitHub transport is qualified separately, never against course references. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createNativeService} from '../host-service.mjs';
import {createDriver,nativeTarget,testRoot,until} from './native-driver.mjs';
await fs.mkdir(testRoot,{recursive:true});const output=await fs.mkdtemp(path.join(testRoot,'push-')),data=path.join(output,'data'),original=path.join(output,'source');await fs.mkdir(original);
const env={PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.invalid'};
const git=(root,...args)=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',root,...args],{env,encoding:'utf8',stdio:'pipe'}).trim();
git(original,'init','--initial-branch=main','--template=');await fs.writeFile(path.join(original,'README.md'),'# Synthetic course\n');git(original,'add','.');git(original,'commit','-m','Initial');
const service=await createNativeService({dataRoot:data,hooks:{cloneAcquire:async({destination})=>execFileSync('/usr/bin/git',['clone','--no-checkout','--no-local','--template=','--',original,destination],{env,stdio:'pipe'}),updatesAcquire:async({gitDir})=>{execFileSync('/usr/bin/git',[`--git-dir=${gitDir}`,'fetch','--no-tags','--',original,'refs/heads/main:refs/asmb-check/remote'],{env,stdio:'pipe'});return git(original,'rev-parse','HEAD');}}});
await service.cloneRepository({name:'PushTest',url:'https://github.com/example/push-test',requestId:randomUUID()});const root=path.join(data,'workspaces/asMagicBrain/PushTest');await fs.writeFile(path.join(root,'README.md'),'# Synthetic course\n\nReviewed class schedule.\n');git(root,'add','.');git(root,'commit','-m','Add class schedule');const comparison=await service.checkRepositoryUpdates({repo:'PushTest',requestId:randomUUID()});await service.close();
const driver=await createDriver({...nativeTarget(data),output,workspacePath:data});let page,running=false,failure;
try{
 page=await driver.launch();running=true;await page.getByRole('button',{name:/Switch local repository:/}).waitFor();
 await driver.app.evaluate(({ipcMain},comparison)=>{const original=ipcMain._invokeHandlers.get('asmb:native');globalThis.__pushCount=0;ipcMain.removeHandler('asmb:native');ipcMain.handle('asmb:native',async(event,input)=>{
  if(input.method==='getGitHubConnection')return {ok:true,value:{configured:true,state:'connected',account:{id:123,username:'synthetic-test-account',email:null}}};
  if(input.method==='pushRepository'){globalThis.__pushCount++;return {ok:true,value:{status:'pushed',head:comparison.localHead,branch:comparison.branch,sourceUrl:comparison.sourceUrl}};}
  return original(event,input);
 });},comparison);
 await page.evaluate(()=>window.dispatchEvent(new Event('asmb:github-connection-changed')));
 await page.getByRole('button',{name:/Switch local repository:/}).click();await page.locator('.rh-list').getByRole('button',{name:/PushTest/}).click();
 await page.getByRole('button',{name:'README.md',exact:true}).first().click();await page.getByRole('button',{name:'Repository file actions',exact:true}).click();await page.getByRole('menuitem',{name:'Check GitHub updates…',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'GitHub updates'});await dialog.getByRole('button',{name:'Review Push…',exact:true}).click();await dialog.getByRole('heading',{name:'Review Push',exact:true}).waitFor();
 const push=dialog.getByRole('button',{name:'Push to GitHub',exact:true});assert.equal(await push.isDisabled(),true);
 await dialog.getByText('Outgoing commits (1)',{exact:true}).click();await dialog.getByText('Changed paths (1)',{exact:true}).click();await driver.screenshot('01-push-review');
 await page.evaluate(()=>{const section=document.querySelector('[aria-label="Review Push"]');section.style.outline='3px solid #0969da';const label=document.createElement('p');label.textContent='GP1 — Destination, outgoing history and explicit confirmation';label.id='qa-overlay';label.style.color='#0969da';section.prepend(label);});await driver.screenshot('02-push-review-overlay');await page.evaluate(()=>{document.querySelector('#qa-overlay').remove();document.querySelector('[aria-label="Review Push"]').style.outline='';});
 await dialog.getByLabel('I have reviewed the destination and outgoing history.').check();await push.click();await until(()=>dialog.getByRole('status').filter({hasText:'Commits pushed to GitHub.'}).count().then(n=>n===1));assert.equal(await driver.app.evaluate(()=>globalThis.__pushCount),1);await driver.screenshot('03-push-feedback');
 await dialog.getByRole('button',{name:'Close',exact:true}).click();assert.deepEqual(driver.errors,[]);await driver.closeNormally();running=false;
}catch(error){failure=error;if(page)await fs.writeFile(path.join(output,'failure-aria.yml'),await page.locator('body').ariaSnapshot().catch(()=>''));}
finally{if(running)await driver.closeNormally().catch(()=>{});await driver.report({passed:!failure,failure:failure?.stack,scope:'Actual Electron/bridge/review; debugger synthetic account and Push result. No desktop live authorization claim.'});}
if(failure)throw failure;console.log(JSON.stringify({passed:true,output}));
