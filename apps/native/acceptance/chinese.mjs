/** Exact app + separately distributed teaching-package qualification on Mac or Ubuntu.
 * Synthetic courses only. Mac chooser is redirected; Ubuntu uses the real GTK chooser.
 * No provider credentials or remote writes. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {testRoot as base} from '../../../tools/development-paths.mjs';
import {assertPackageIdentity} from './package-identity.mjs';
assert.deepEqual(process.argv.slice(2),['--run-isolated']);
assert.ok(process.env.ASMB_PACKAGED_EXECUTABLE);
process.env.ASMB_ACCEPTANCE_RUN_ROOT??=path.join(base,'runs/chinese-support-20261004/native');
const {createDriver,testRoot,until}=await import(process.platform==='linux'?'./linux-driver.mjs':'./native-driver.mjs');
await fs.mkdir(testRoot,{recursive:true});const output=await fs.mkdtemp(path.join(testRoot,'qualification-'));
const executable=process.env.ASMB_PACKAGED_EXECUTABLE;
const payload=process.platform==='linux'?path.join(path.dirname(executable),'resources/app'):path.join(executable.slice(0,executable.indexOf('.app/Contents/MacOS/')+4),'Contents/Resources/app');
const meta=JSON.parse(await fs.readFile(path.join(payload,'native-package.json')));
assertPackageIdentity(meta,{sourceCommit:process.env.ASMB_EXPECTED_SOURCE_COMMIT,buildNumber:process.env.ASMB_EXPECTED_BUILD_NUMBER});
const home=path.join(output,'home'),data=meta.channel==='preview'?path.join(home,'asMagicBrain'):path.join(output,'data');
const args=meta.channel==='preview'?['--test-root='+base,'--test-user-home='+home]:['--test-data-root='+data];
const driver=await createDriver({executablePath:executable,args,output,workspacePath:path.join(data,'workspaces/asMagicBrain/Workspace')});
const plugin=path.resolve(process.env.ASMB_TEACH_PACKAGE);const legacy=path.resolve(process.env.ASMB_LEGACY_TEACH_PACKAGE);
let page,running=false,failure;const checks={};
const button=name=>page.getByRole('button',{name,exact:true});
const invoke=(method,input)=>page.evaluate(async({method,input})=>{const r=await window.asMagicBrain[method](input);if(!r.ok)throw Error(r.error.message);return r.value;},{method,input});
async function choose(file){
 if(driver.app){await driver.app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await button('Install plugin…').click();return;}
 await button('Install plugin…').click();
 const win=await until(()=>{try{return execFileSync('/usr/bin/xdotool',['search','--onlyvisible','--name','^Install plugin$'],{encoding:'utf8'}).trim().split('\n').at(-1)||false;}catch(e){if(e.status===1)return false;throw e;}},{timeout:30000,label:'GTK plugin picker'});
 execFileSync('/usr/bin/xdotool',['windowactivate','--sync',win]);execFileSync('/usr/bin/xdotool',['key','--clearmodifiers','ctrl+l']);execFileSync('/usr/bin/xdotool',['type','--clearmodifiers','--delay','1','--',file]);execFileSync('/usr/bin/xdotool',['key','--clearmodifiers','Return']);
 // A second unconditional Return can dismiss the app's subsequent review
 // dialog once GTK has closed. Wait for this exact chooser to disappear.
 await until(()=>{try{return !execFileSync('/usr/bin/xdotool',['search','--onlyvisible','--name','^Install plugin$'],{encoding:'utf8'}).trim().split('\n').includes(win);}catch(e){if(e.status===1)return true;throw e;}},{timeout:30000,label:'GTK chooser closes after file selection'});
}
async function install(file){await choose(file);await page.getByRole('dialog',{name:'Install asTeach?',exact:true}).waitFor();await button('Install plugin').click();await page.getByRole('switch',{name:'Enable asTeach',exact:true}).waitFor();}
async function launch(){page=await driver.launch();running=true;if(driver.app)await driver.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));await button('Manage plugins').waitFor();}
async function close(){await driver.closeNormally();running=false;}
try{
 await launch();assert.equal(await button('asTeach').count(),0);assert.equal(await button('Pro Editor').count(),0);
 if(meta.channel==='preview'){assert.equal(await button('Ask agent').count(),0);assert.equal(await page.getByRole('switch',{name:/unavailable functions/}).count(),0);}
 await button('Manage plugins').click();await page.getByText('No plugins installed',{exact:true}).waitFor();checks.optionalNotPreinstalled=true;
 await install(legacy);await page.getByRole('switch',{name:'Enable asTeach',exact:true}).check();await button('asTeach').waitFor();checks.legacyIdentityAccepted=true;
 await install(plugin);await button('asTeach').waitFor();await page.locator('.pws-publisher').filter({hasText:' · 0.1.4'}).waitFor();await driver.screenshot('01-plugin');checks.packageUpgrade=true;
 await close();await launch();await button('asTeach').click();await button('Create a new course').click();const create=page.getByRole('dialog',{name:'New course'});
 await create.getByLabel('Course Code',{exact:true}).fill('TEST101/201');await create.getByLabel('Course Name',{exact:true}).fill('机器人系统设计 / 機器人系統設計');await create.getByRole('button',{name:'Year',exact:true}).click();await page.getByRole('menuitemradio',{name:'2026',exact:true}).click();await create.locator('[name=season]').selectOption('Autumn');await create.getByRole('button',{name:'Create course',exact:true}).click();
 await page.getByRole('heading',{name:'Courses',exact:true}).waitFor();await button('Open course TEST101/201').click();await button('Edit this file').waitFor();
 const courses=await invoke('nativeTeachRequest',{operation:'list'});const course=courses.find(c=>c.course.code==='TEST101/201');assert.ok(course);const org=path.join(data,'workspaces/asMagicBrain'),author=path.join(org,course.repo),student=path.join(org,'TEST101_201_Students');await fs.stat(student);checks.pairedCreation=true;
 const source='---\nlang: zh-Hant\n---\n# 机器人系統课程\n\n## Course Description\n\n机器人课程：数据、模型与实验。\n\n## Teaching Schedule\n\n[Class 01](classes/系统辨识.md)\n\n[Class 02](classes/模型验证.md)\n\n## Private teacher notes\n\nPRIVATE_SENTINEL_DO_NOT_PUBLISH\n';
 await button('Edit this file').click();const edit=page.locator('.cm-content[contenteditable=true]');await edit.click();await page.keyboard.press(process.platform==='darwin'?'Meta+a':'Control+a');await page.keyboard.insertText(source);await button('Save').click();await until(async()=>await fs.readFile(path.join(author,'2026-autumn/instructor.md'),'utf8')===source);
 await page.getByRole('tab',{name:'Split',exact:true}).click();await page.locator('.rfe-preview article').getByText('机器人课程：数据、模型与实验。',{exact:true}).waitFor();await page.getByRole('group',{name:'Markdown formatting',exact:true}).waitFor();checks.coreEditorWithoutPro=true;
 await page.locator('.rfe-preview article').evaluate(async element=>{await document.fonts.ready;if(!document.fonts.check("16px 'asMagicBrain MiSans'",'机器人系統'))throw Error('Chinese font did not load');});
 const cdp=await page.context().newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable');const document=await cdp.send('DOM.getDocument');const node=await cdp.send('DOM.querySelector',{nodeId:document.root.nodeId,selector:'.rfe-preview article p'});const fonts=await cdp.send('CSS.getPlatformFontsForNode',{nodeId:node.nodeId});assert.ok(fonts.fonts.some(f=>f.isCustomFont&&/MiSans/i.test(f.familyName)),JSON.stringify(fonts));await fs.writeFile(path.join(output,'chinese-platform-fonts.json'),JSON.stringify(fonts,null,2));checks.bundledFontDecoded=true;
 assert.equal(await page.locator('.rfe-preview article').getAttribute('lang'),'zh-Hant');await driver.screenshot('chinese-split-fonts');

 await invoke('request',{repo:course.repo,operation:'create',args:{path:'2026-autumn/classes/系统辨识.md',text:'# 系统辨识 / 系統辨識\n\n系統辨識：保持原始數據。\n\n[下一课](模型验证.md)\n\n![实验示意图](../images/实验示意图.png)\n\n| 周次 | 内容 |\n| --- | --- |\n| 01 | 数据采集<br>模型验证 |\n\n$$\ny = ax + b\n$$\n\n```mermaid\nflowchart LR\n  A[数据] --> B[模型] --> C[实验]\n```\n'}});
 await invoke('request',{repo:course.repo,operation:'create',args:{path:'2026-autumn/classes/模型验证.md',text:'# 模型验证 / 模型驗證\n\n[返回系统辨识](系统辨识.md)\n\n验证预测，而不是把拟合误差当作泛化能力。\n'}});
 const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');await fs.mkdir(path.join(author,'2026-autumn/images'),{recursive:true});await fs.writeFile(path.join(author,'2026-autumn/images/实验示意图.png'),image);
 await button('Choose course page').click();await page.getByRole('menuitem',{name:'Student page',exact:true}).click();await page.locator('.rfe-sidebar-header strong').filter({hasText:'TEST101_201_Students'}).waitFor();checks.studentExplorerRoute=true;
 await button('Review Instructor changes').click();await button('Main page sections').click();const selection=page.getByRole('dialog',{name:'Review student copy'});await selection.getByRole('checkbox').first().waitFor();
 for(const box of await selection.getByRole('checkbox').all()){if((await box.getAttribute('aria-label'))?.includes('Private'))continue;await box.check();}
 // Explicitly unselect the instructor-only section, using its visible section label.
 const privateSection=selection.getByRole('checkbox',{name:/Private teacher notes/});if(await privateSection.count())await privateSection.uncheck();
 await selection.getByRole('button',{name:'Continue to Student output',exact:true}).click();const review=page.getByRole('dialog',{name:'Prepare Student output'});await review.getByRole('checkbox',{name:'2026-autumn/classes/系统辨识.md',exact:true}).check();await review.getByRole('checkbox',{name:'2026-autumn/classes/模型验证.md',exact:true}).check();await review.getByRole('button',{name:'Review output',exact:true}).click();await review.getByRole('heading',{name:'Review files (6)'}).waitFor();assert.equal(await review.getByRole('button',{name:'Save to student repository',exact:true}).isEnabled(),false);await driver.screenshot('02-student-review');
 await review.getByRole('checkbox',{name:/I reviewed all listed files/}).check();await review.getByRole('button',{name:'Save to student repository',exact:true}).click();await review.waitFor({state:'detached'});await page.locator('.rfe-preview article').getByText('机器人课程：数据、模型与实验。',{exact:true}).waitFor();
 assert.equal(await fs.readFile(path.join(author,'2026-autumn/instructor.md'),'utf8'),source);const studentText=await fs.readFile(path.join(student,'2026-autumn/student.md'),'utf8');assert.ok(!studentText.includes('PRIVATE_SENTINEL'));assert.match(studentText,/classes\/(?:系统辨识|%E7%B3%BB%E7%BB%9F%E8%BE%A8%E8%AF%86).md/);assert.match(await fs.readFile(path.join(student,'2026-autumn/classes/系统辨识.md'),'utf8'),/系統辨識/);await fs.stat(path.join(student,'2026-autumn/SUMMARY.md'));await fs.stat(path.join(student,'2026-autumn/.gitbook.yaml'));checks.reviewedMultipageOutput=true;
 await driver.screenshot('03-student');await close();await launch();await button('asTeach').click();await button('Courses — all courses').click();await button('Open course TEST101/201').click();await page.locator('.rfe-sidebar-header strong').filter({hasText:'TEST101_201_asTeach'}).waitFor();await page.locator('.rfe-preview article').getByText('机器人课程：数据、模型与实验。',{exact:true}).waitFor();await button('Choose course page').click();await page.getByRole('menuitem',{name:'Student page',exact:true}).click();await page.locator('.rfe-sidebar-header strong').filter({hasText:'TEST101_201_Students'}).waitFor();checks.courseRestart=true;
 assert.deepEqual(driver.errors,[]);assert.deepEqual(driver.consoleErrors,[]);await close();
}catch(e){failure=e;if(page)await fs.writeFile(path.join(output,'failure-aria.yml'),await page.locator('body').ariaSnapshot().catch(()=>''));}
finally{if(running)await driver.closeNormally().catch(()=>{});await driver.report({passed:!failure,checks,failure:failure?.stack,picker:process.platform==='darwin'?'redirected fixture chooser':'real GTK chooser',scope:'offline app/plugin/course workflows; no live provider qualification'});}
if(failure)throw failure;console.log(JSON.stringify({passed:true,output,checks}));
