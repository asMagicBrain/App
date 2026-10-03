import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDriver,nativeTarget,testRoot,until} from './native-driver.mjs';
const output=await fs.mkdtemp(path.join(await fs.mkdir(testRoot,{recursive:true}).then(()=>testRoot),'course-workflow-'));
const data=path.join(output,'data'),driver=await createDriver({...nativeTarget(data),output,workspacePath:path.join(data,'workspaces/asMagicBrain/Workspace')});
let page,running=false,failure;const button=name=>page.getByRole('button',{name,exact:true});
async function capture(name){await page.evaluate(()=>{for(const [selector,label] of [['.pws-breadcrumb','C0 · Course navigation'],['.teach-review-form','T9 · Student review'],['.rfe-sidebar','V5 · Explorer']]){const el=document.querySelector(selector);if(!el||!el.getClientRects().length)continue;const r=el.getBoundingClientRect(),box=document.createElement('div');box.className='qa-overlay';box.textContent=label;Object.assign(box.style,{position:'fixed',pointerEvents:'none',zIndex:'2147483647',left:r.left+'px',top:r.top+'px',outline:'2px solid #8250df',background:'#8250df',color:'white',font:'12px system-ui',padding:'2px 5px'});document.body.append(box);}});await driver.screenshot(name);await page.evaluate(()=>document.querySelectorAll('.qa-overlay').forEach(el=>el.remove()));}
const call=input=>page.evaluate(async value=>{const r=await window.asMagicBrain.nativeTeachRequest(value);if(!r.ok)throw Error(r.error.message);return r.value;},input);
try{
 page=await driver.launch();running=true;await button('Manage plugins').waitFor();
 await driver.app.evaluate(({dialog},filename)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[filename]});},process.env.ASMB_TEACH_PACKAGE);
 await button('Manage plugins').click();await button('Install plugin…').click();await button('Install plugin').click();await page.getByRole('switch',{name:'Enable asTeach',exact:true}).click();
 await button('asTeach').click();await button('Create a new course').click();const setup=page.getByRole('dialog',{name:'New course'});await setup.getByLabel('Course Code',{exact:true}).fill('TEST101');await setup.getByLabel('Course Name',{exact:true}).fill('Teaching workflow');await setup.locator('[name=season]').selectOption('Autumn');await setup.getByRole('button',{name:'Create course',exact:true}).click();await setup.waitFor({state:'detached'});
 const record=(await call({operation:'list'}))[0];await button('Open course TEST101').click();await button('Edit this file').click();
 const editor=page.locator('.cm-content[contenteditable=true]');await editor.click();await page.keyboard.press('Meta+a');await page.keyboard.insertText('# Test course\n\n## Custom section\nContent for students.\n\n## Private section\nDo not select this.\n');await button('Save').click();
 await button('Choose course page').click();await page.getByRole('menuitem',{name:'Student page',exact:true}).click();await button('Review Instructor content').click();
 const review=page.getByRole('dialog',{name:'Review student copy'});await review.getByLabel('Custom section',{exact:true}).check();await capture('01-student-review');await review.getByRole('button',{name:'Create student version',exact:true}).click();await review.waitFor({state:'detached'});
 const root=path.join(data,'workspaces/asMagicBrain',record.repo);await until(async()=>fs.readFile(path.join(root,'2026-autumn/student.md'),'utf8').then(t=>t.includes('Content for students.')&&!t.includes('Do not select')));
 await until(()=>page.getByRole('textbox',{name:'File path',exact:true}).inputValue().then(t=>t==='2026-autumn/student.md'));
 await button('Choose course page').click();await page.getByRole('menuitem',{name:'Instructor template',exact:true}).click();await until(()=>page.getByRole('textbox',{name:'File path',exact:true}).inputValue().then(t=>t==='instructor-template.md'));
 await capture('02-template');
 // Course generation uses actual guarded native paths, and repeated clicks preserve edits.
 const calendar={monday:'2026-10-19',totalWeeks:2,sessions:[{id:'lecture',title:'Lecture',weekday:1,start:'09:00',end:'10:20',location:'CR6',weekFrom:1,weekTo:2}]};
 const next=await call({operation:'setCalendar',repo:record.repo,year:2026,season:'autumn',expectedHash:record.settings['2026-autumn'].hash,calendar});
 const generation={operation:'generateClassPages',repo:record.repo,year:2026,season:'autumn',expectedHash:next.settings['2026-autumn'].hash};const result=await call(generation);assert.match(result.markdown,/classes\/Class01.md/);assert.equal((await call(generation)).created,0);assert.match(await fs.readFile(path.join(root,'2026-autumn/classes/Class01.md'),'utf8'),/Class 01/);
 await button('Choose course page').click();await page.getByRole('menuitem',{name:'Instructor page',exact:true}).click();
 await page.evaluate(()=>{const write=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=async text=>{window.__relativeCopy=text;return write(text);};});
 await until(()=>page.getByRole('textbox',{name:'File path',exact:true}).inputValue().then(t=>t==='2026-autumn/instructor.md'));await button('More actions for 2026-autumn/instructor.md').click();await page.getByRole('menuitem',{name:'Copy relative path',exact:true}).click();await until(()=>page.evaluate(()=>typeof window.__relativeCopy==='string'));assert.equal(await page.evaluate(()=>window.__relativeCopy),'instructor.md');await until(()=>driver.app.evaluate(async({clipboard})=>(await clipboard.readText())==='instructor.md'),{label:'relative path copied'});
 await driver.screenshot('03-instructor');assert.deepEqual(driver.errors,[]);assert.deepEqual(driver.consoleErrors,[]);await driver.closeNormally();running=false;
 page=await driver.launch();running=true;await button('asTeach').waitFor();assert.match(await fs.readFile(path.join(root,'2026-autumn/student.md'),'utf8'),/Content for students/);assert.match(await fs.readFile(path.join(root,'instructor-template.md'),'utf8'),/Teaching Schedule/);await driver.closeNormally();running=false;
}catch(e){failure=e;if(page)await fs.writeFile(path.join(output,'failure-aria.yml'),await page.locator('body').ariaSnapshot().catch(()=>''));}
finally{if(running)await driver.closeNormally().catch(()=>{});await driver.report({passed:!failure,failure:failure?.stack});}
if(failure)throw failure;console.log(JSON.stringify({passed:true,output}));
