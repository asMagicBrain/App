/** Course surface regression: legacy and direct workflows share the full viewport. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDriver,nativeTarget,testRoot} from './native-driver.mjs';
const output=await fs.mkdtemp(path.join(await fs.mkdir(testRoot,{recursive:true}).then(()=>testRoot),'course-loading-'));
const data=path.join(output,'data'),driver=await createDriver({...nativeTarget(data),output,workspacePath:data});
let page,running=false,failure;
const bridge=(method,input)=>page.evaluate(async({method,input})=>{const r=await window.asMagicBrain[method](input);if(!r.ok)throw Error(r.error.code??r.error.message);return r.value;},{method,input});
const call=input=>bridge('nativeTeachRequest',input);
async function courses(){await page.getByRole('button',{name:'Courses — all courses',exact:true}).click();await page.getByRole('heading',{name:'Courses',exact:true}).waitFor();}
async function fullArea(selector,name){
 const element=page.locator(selector);await element.waitFor();
 const geometry=await element.evaluate(node=>{const main=node.closest('.fw-main'),a=main.getBoundingClientRect(),b=node.getBoundingClientRect();return {top:b.top-a.top,height:b.height,availableHeight:a.height};});
 assert.ok(geometry.top<=24,`${name} starts at the top: ${JSON.stringify(geometry)}`);
 assert.ok(geometry.height>=geometry.availableHeight-32,`${name} fills the course area: ${JSON.stringify(geometry)}`);
 driver.record(name,geometry);
}
try{
 page=await driver.launch();running=true;await page.locator('.rc-document').waitFor();
 const plugin=process.env.ASMB_TEACH_PACKAGE;assert.ok(plugin);
 await driver.app.evaluate(({dialog},filename)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[filename]});},plugin);
 await page.getByRole('button',{name:'Manage plugins',exact:true}).click();await page.getByRole('button',{name:'Install plugin…',exact:true}).click();await page.getByRole('button',{name:'Install plugin',exact:true}).click();await page.getByRole('switch',{name:'Enable asTeach',exact:true}).click();
 const repo='LEGACY_LAYOUT',source='2026-autumn/instructors/README.md',text='# Legacy course\n\nSaved course content.\n';
 await bridge('createRepository',{name:repo,requestId:randomUUID()});await bridge('request',{repo,operation:'create',args:{path:source,text}});
 await call({operation:'adopt',repo,course:{schemaVersion:1,courseId:randomUUID(),code:'LEGACY_LAYOUT',name:'Legacy layout',terms:[{year:2026,season:'autumn',source:{kind:'document',paths:[source]}}]}});
 await call({operation:'create',requestId:randomUUID(),code:'DIRECT_LAYOUT',name:'Direct layout',year:2026,season:'autumn',structureVersion:2});
 await driver.closeNormally();running=false;page=await driver.launch();running=true;await page.getByRole('button',{name:'asTeach',exact:true}).click();await courses();
 for(const code of ['LEGACY_LAYOUT','DIRECT_LAYOUT','LEGACY_LAYOUT']){
  await page.getByRole('button',{name:'Open course '+code,exact:true}).click();
  if(code==='LEGACY_LAYOUT'){
   await page.getByRole('heading',{name:'Legacy course',exact:true}).waitFor();await fullArea('.fw-repository-surface:not([hidden])','legacy-course-full-area');
   assert.equal(await page.locator('.native-teach-view:not([hidden])').count(),0,'No empty course panel remains visible');
   assert.equal((await bridge('request',{repo,operation:'open',args:{path:source}})).text,text);
  }else{await fullArea('.ncw:not([hidden])','direct-course-full-area');}
  await driver.screenshot(code.toLowerCase());
  await page.getByRole('button',{name:'Choose course page',exact:true}).click();await page.getByRole('menuitem',{name:'Course settings',exact:true}).click();
  await page.getByRole('navigation',{name:'Course settings pages',exact:true}).waitFor();await fullArea('.native-teach-view:not([hidden])','settings-full-area');
  await courses();await fullArea('.native-teach-view:not([hidden])','courses-full-area');
 }
 assert.deepEqual(driver.errors,[]);assert.deepEqual(driver.consoleErrors,[]);await driver.closeNormally();running=false;
}catch(error){failure=error;if(page)await driver.screenshot('failure').catch(()=>{});}
finally{if(running)await driver.closeNormally().catch(()=>{});await driver.report({passed:!failure,scope:'Synthetic local legacy/direct course geometry and navigation; no personal files or provider writes',failure:failure?.stack??null});}
console.log(JSON.stringify({passed:!failure,output}));if(failure)throw failure;
