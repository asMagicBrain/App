import assert from 'node:assert/strict';
import {createTeachInstructorDocument} from '../src/teach-document.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {chromium} from '../../tools/playwright.mjs';
import {testRoot} from '../../tools/development-paths.mjs';
import {staticHandler, createTeachReferenceHandler, teachReferencePrefix} from '../.storybook/static-server.mjs';

// Focused course-navigation qualification against the private reference and synthetic Storybook stories.
// Only metadata expectations belong in this file; original course text stays external.
const output=process.env.ASMB_COURSE_NAVIGATION_OUTPUT, fixtureRoot=process.env.ASMB_TEACH_REFERENCE_ROOT, executablePath=process.env.ASMB_BROWSER;
assert(output&&fixtureRoot&&executablePath,'Set ASMB_COURSE_NAVIGATION_OUTPUT, ASMB_TEACH_REFERENCE_ROOT and ASMB_BROWSER.');
for(const candidate of [output,fixtureRoot]){
  const relative=path.relative(testRoot,candidate);
  assert(path.isAbsolute(candidate)&&path.resolve(candidate)===candidate&&relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Fixture and evidence must be canonical paths inside ASMB_TEST_ROOT.');
}
await fs.mkdir(path.dirname(output),{recursive:true});
assert.equal(await fs.realpath(path.dirname(output)),path.dirname(output));
assert.equal(await fs.realpath(fixtureRoot),fixtureRoot);
await fs.mkdir(output); // Preserve all previous attempts.
await fs.mkdir(path.join(output,'tmp'));
for(const key of ['TMPDIR','TMP','TEMP'])process.env[key]=path.join(output,'tmp');
const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'), sourceRoot=path.join(appRoot,'ui-workshop/src'), buildRoot=path.join(appRoot,'ui-workshop/storybook-static');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const inventory=async root=>{
  const result={};
  const visit=async folder=>{for(const entry of await fs.readdir(folder,{withFileTypes:true})){
    const full=path.join(folder,entry.name);
    assert(!entry.isSymbolicLink(),'Qualification inputs cannot be symlinks.');
    if(entry.isDirectory())await visit(full);else if(entry.isFile())result[path.relative(root,full)]=sha256(await fs.readFile(full));
  }};
  await visit(root);return result;
};
const fixture=JSON.parse(await fs.readFile(path.join(fixtureRoot,'fixture.json'),'utf8'));
assert.equal(fixture.schemaVersion,1);
assert.equal(fixture.courses.length,4,'Reference has four distinct real teaching terms.');
const sourceInputs=await inventory(sourceRoot), fixtureInputs=await inventory(fixtureRoot), buildInputs=await inventory(buildRoot);
const index=JSON.parse(await fs.readFile(path.join(buildRoot,'index.json'),'utf8'));
const story=Object.values(index.entries).find(item=>item.name==='asTeach — DES5002 reference');
assert(story,'Build the dedicated reference story before qualification.');
const checks=[], errors=[], externalRequests=[], transportRequests=[], consoleErrors=[], geometry=[], captures=[];
let browser,page,server,failure,failureContext,browserVersion,referenceMode='live';
const shellBody='# Synthetic shell\n\nRepository transport is an in-memory fixture.\n';
try{
  // Runtime-derived long source fragments detect accidental fixture inclusion
  // without copying private course text into source control or the result log.
  const sourceTexts=fixture.courses.flatMap(course=>[course.reference.home.source,...course.sections.map(item=>item.source),...course.reference.pages.map(item=>item.source)]);
  const sentinels=[...new Set(sourceTexts.flatMap(source=>source.split(/\r?\n/).map(line=>line.trim()).filter(line=>line.length>=100&&/[a-z]{5}/i.test(line)&&!line.startsWith('|'))))];
  assert(sentinels.length>=10,'Use substantial body fragments for the private text scan.');
  let scanned=0;
  for(const [root,names] of [[sourceRoot,sourceInputs],[buildRoot,buildInputs]]){
    for(const name of Object.keys(names).filter(name=>/\.(?:[cm]?js|tsx?|json|html|map)$/.test(name))){
      const text=await fs.readFile(path.join(root,name),'utf8');scanned++;
      for(const sentinel of sentinels)assert(!text.includes(sentinel)&&!text.includes(JSON.stringify(sentinel).slice(1,-1)),`Private body text leaked into ${path.relative(appRoot,root)}/${name}; sentinel ${sha256(sentinel)}.`);
    }
  }
  checks.push(`No private source fragments in ${scanned} source/static text files (${sentinels.length} runtime-derived long fragments; only hashes recorded).`);
  let staticFiles,liveReference;
  const json=(res,value)=>{res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  server=createServer(async(req,res)=>{
    try{
      const pathname=new URL(req.url,'http://localhost').pathname;
      if(pathname.startsWith(teachReferencePrefix)){
        transportRequests.push({path:pathname,method:req.method,mode:referenceMode});
        return liveReference(req,res);
      }
      if(['/__repository-import','/__local-repositories','/__local-workspace'].includes(pathname)){
        const chunks=[];for await(const chunk of req)chunks.push(chunk);
        const operation=chunks.length?JSON.parse(Buffer.concat(chunks).toString()).operation:undefined;
        transportRequests.push({path:pathname,method:req.method,operation});
        if(pathname==='/__repository-import'&&req.method==='GET')return json(res,{capability:'synthetic-only',organization:'asMagicBrain',defaultRepository:'Workspace',repositories:[{name:'Workspace',privateRepo:true}],limits:{archiveBytes:268435456}});
        if(pathname==='/__local-repositories'&&req.method==='GET')return json(res,{repo:'Workspace',path:'',type:'directory',branch:'main',branches:['main'],tags:[],entries:[{path:'README.md',name:'README.md',type:'file'}],content:null,readme:shellBody,readmePath:'README.md',license:null,commitCount:1,commit:{author:'Fixture',message:'Synthetic shell',sha:'1234567890abcdef',date:'2026-09-20'}});
        if(pathname==='/__local-workspace'&&req.method==='GET')return json(res,{capability:'synthetic-only',local:true,newDrafts:[]});
        if(pathname==='/__local-workspace'&&operation==='getCommitPreferences')return json(res,{ok:true,value:{revision:0,mode:'asmagicbrain',asmagicbrain:{name:'Fixture',email:'fixture@example.invalid'},github:{name:'',email:''}}});
        throw Error('Unexpected shell operation '+JSON.stringify({pathname,method:req.method,operation}));
      }
      return staticFiles(req,res);
    }catch(error){errors.push(error.message);if(!res.headersSent)res.writeHead(500);res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port,origin=`http://127.0.0.1:${port}`;
  [staticFiles,liveReference]=await Promise.all([staticHandler(buildRoot,port),createTeachReferenceHandler({root:fixtureRoot,port,allowedRoot:testRoot})]);
  browser=await chromium.launchPersistentContext(path.join(output,'browser-profile'),{headless:true,executablePath,chromiumSandbox:true,viewport:{width:1440,height:1000},args:['--disable-background-networking'],env:{...process.env,TMPDIR:path.join(output,'tmp'),TMP:path.join(output,'tmp'),TEMP:path.join(output,'tmp')}});
  browserVersion=browser.browser()?.version();page=await browser.newPage();page.setDefaultTimeout(8000);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push({mode:referenceMode,text:message.text()});});
  await page.route(/^https?:/,route=>{if(new URL(route.request().url()).origin===origin)return route.continue();externalRequests.push(route.request().url());return route.abort();});
  const frame=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const button=name=>page.getByRole('button',{name,exact:true});
  const study=page.locator('.teach-study:visible'),breadcrumb=page.getByRole('navigation',{name:'asTeach breadcrumb',exact:true});
  const openMenu=async kind=>{
    const compact=breadcrumb.getByRole('button',{name:'Open course navigation',exact:true});
    const trigger=await compact.isVisible()?compact:breadcrumb.getByRole('button',{name:{courses:'Choose course',terms:'Choose year and term',pages:'Choose course page'}[kind],exact:true});
    await trigger.click();const menu=page.getByRole('menu');await menu.waitFor();return {menu,trigger};
  };
  const selectMenu=async(kind,name)=>{const {menu}=await openMenu(kind);await menu.getByRole('menuitem',{name,exact:true}).click();await frame();};
  const dismiss=async({menu,trigger})=>{await page.keyboard.press('Escape');await frame();assert.equal(await menu.count(),0);assert(await trigger.evaluate(element=>element===document.activeElement));};
  const capture=async(name,regions)=>{
    captures.push(name);
    if(regions)await page.evaluate(items=>{
      const overlay=document.createElement('div');overlay.id='calendar-reference-qa-overlay';overlay.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      for(const [label,selector] of items){const element=[...document.querySelectorAll(selector)].find(item=>item.getClientRects().length&&!item.closest('[hidden]'));if(!element)throw Error('Missing overlay region '+label);const r=element.getBoundingClientRect(),box=document.createElement('div');box.style.cssText=`position:fixed;box-sizing:border-box;border:2px dashed #8054ff;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;const caption=document.createElement('span');caption.textContent=label;caption.style.cssText='position:absolute;left:2px;top:100%;margin-top:4px;white-space:nowrap;background:#6435d6;color:white;font:600 11px/18px system-ui;padding:0 5px;border-radius:3px';box.append(caption);overlay.append(box);}(document.querySelector('dialog[open]')??document.body).append(overlay);
    },regions);
    try{await page.screenshot({path:path.join(output,name)});}finally{if(regions)await page.locator('#calendar-reference-qa-overlay').evaluate(element=>element.remove());}
  };
  const pluginHome=page.locator('[data-plugin-view="home"]:visible');
  const catalog=page.locator('[data-plugin-view="courses"]:visible');
  const current=fixture.courses.find(course=>course.year==='2026'&&course.season==='Autumn');
  const historical=fixture.courses.find(course=>course.year==='2024'&&course.season==='Spring');
  assert(current&&historical);
  const courses=async()=>{
    const link=breadcrumb.getByRole('button',{name:'Courses — all courses',exact:true});
    assert(await link.isVisible(),'Courses is a stable visible breadcrumb at every width.');
    await link.click();await catalog.waitFor();await frame();
    assert(await catalog.getByRole('heading',{name:'Courses',exact:true}).isVisible());
    assert(await catalog.locator('#tcs-heading').evaluate(element=>element===document.activeElement),'Courses receives heading focus.');
    assert.equal(await catalog.getByRole('searchbox',{name:'Search terms',exact:true}).count(),0,'No intermediate term landing remains.');
  };
  const assertTerm=async id=>{await study.waitFor();await frame();assert.equal(await study.getAttribute('data-course-id'),id);assert.equal(await catalog.count(),0,'Opening a course goes directly to its term.');};
  const courseFocus=async()=>assert(await study.evaluate(element=>element.contains(document.activeElement)),'Direct opening hands focus to the active course content.');
  const checkMenuBounds=async(menu,label)=>{
    const box=await menu.boundingBox();assert(box);const size=page.viewportSize();geometry.push({label,viewport:size,...box});
    assert(box.x>=-1&&box.y>=-1&&box.x+box.width<=size.width+1&&box.y+box.height<=size.height+1,`${label} stays in the viewport.`);
    assert(await page.locator('.fw-window').evaluate(element=>element.scrollWidth<=element.clientWidth+1),'Navigation creates no horizontal page overflow.');
  };
  const readSource=async course=>{await selectMenu('pages','Instructor page');await button('Source').click();assert.equal(await study.locator('.teach-reference-source').textContent(),createTeachInstructorDocument(course).source);await button('Preview').click();};
  const openCurrent=async code=>{await breadcrumb.getByRole('button',{name:`${code} — open course`,exact:true}).click();await frame();};
  const referenceChoice=async term=>{await selectMenu('terms',`${term.year} ${term.season}`);await assertTerm(term.id);};
  const theme=async value=>{await button('asMagicBrain Theme').click();await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption(value);await button('Done').click();await frame();};
  await page.goto(`${origin}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`);await pluginHome.waitFor();await frame();
  await courses();assert.equal(await catalog.locator('.tcs-row').count(),1);assert(await button('Open course DES5002').isVisible());
  await button('Choose term for DES5002').click();let menu=page.getByRole('menu');await menu.waitFor();
  assert.equal(await menu.getByRole('menuitem',{name:/^Open DES5002 /}).count(),4);assert.equal(await menu.getByRole('menuitem',{name:'Open DES5002 2026 Autumn',exact:true}).getAttribute('aria-description'),'Current term');assert.equal(await menu.getByRole('menuitem',{name:/Add term/}).count(),0,'Read-only reference exposes no Add term action.');
  await checkMenuBounds(menu,'Reference catalog terms');await capture('reference-courses-navigation-annotated.png',[
    ['C0 · Courses always returns to this full list','.pws-breadcrumb'],
    ['C1 · Open course goes to its current term','.tcs-row'],
    ['C3 · Choose an earlier teaching term','.pws-ancestor-menu']
  ]);await page.keyboard.press('Escape');await frame();assert(await button('Choose term for DES5002').evaluate(element=>element===document.activeElement));
  const referenceTitle=catalog.locator('.tcs-row h3 button');await referenceTitle.click();await assertTerm(current.id);await courseFocus();
  await readSource(current);await courses();await button('Open course DES5002').click();await assertTerm(current.id);await courseFocus();
  checks.push('Courses is a stable full-catalog destination; the reference title and Open course button open DES5002 2026 Autumn directly, while its four-term selector remains read-only.');
  await referenceChoice(historical);await readSource(historical);
  let state=await openMenu('terms');
  assert.equal(await state.menu.getByRole('menuitem',{name:'2024 Spring',exact:true}).getAttribute('aria-current'),'page');
  assert.match(await state.menu.getByRole('menuitem',{name:'2024 Spring',exact:true}).innerText(),/Selected/);assert.equal(await state.menu.getByRole('menuitem',{name:'2024 Spring',exact:true}).getAttribute('aria-description'),'Selected');
  assert.match(await state.menu.getByRole('menuitem',{name:'2026 Autumn',exact:true}).innerText(),/Current term/);assert.equal(await state.menu.getByRole('menuitem',{name:'2026 Autumn',exact:true}).getAttribute('aria-description'),'Current term');
  assert.notEqual(await state.menu.getByRole('menuitem',{name:'2026 Autumn',exact:true}).getAttribute('aria-current'),'page');
  assert.equal(await state.menu.getByRole('menuitem',{name:/Add term/}).count(),0);
  await capture('reference-c0-navigation-annotated.png',[
    ['C0 · Courses and term navigation','.pws-breadcrumb'],
    ['C0 · Current and selected terms are distinct','.pws-ancestor-menu']
  ]);await dismiss(state);await openCurrent('DES5002');await assertTerm(current.id);
  await referenceChoice(historical);await selectMenu('courses',`DES5002 — ${current.title}`);await assertTerm(current.id);
  await referenceChoice(historical);await courses();assert.equal(await catalog.locator('.tcs-row').count(),1);await referenceTitle.click();await assertTerm(current.id);
  checks.push('Historical 2024 Spring opens its exact source; selected and current term labels are distinct, and clicking the course or choosing it from the course menu restores 2026 Autumn. Courses returns from either term to the full catalog.');
  state=await openMenu('courses');await state.menu.getByRole('menuitem',{name:`DES5002 — ${current.title}`,exact:true}).click();await frame();assert(await state.trigger.evaluate(element=>element===document.activeElement),'Choosing the already-open default course restores its menu trigger focus.');
  for(const value of ['light-default','dark-default']){
    await theme(value);await page.setViewportSize({width:430,height:1000});await frame();
    assert(await breadcrumb.getByRole('button',{name:'Courses — all courses',exact:true}).isVisible());
    const trigger=breadcrumb.getByRole('button',{name:'Open course navigation',exact:true});await trigger.focus();await page.keyboard.press('Enter');menu=page.getByRole('menu');await menu.waitFor();await checkMenuBounds(menu,`Reference compact ${value}`);
    assert(await menu.getByRole('menuitem',{name:'2024 Spring',exact:true}).isVisible());assert.equal(await menu.getByRole('menuitem',{name:/Add term/}).count(),0);
    await capture(`reference-compact-${value}.png`);await page.keyboard.press('Escape');await frame();assert(await trigger.evaluate(element=>element===document.activeElement));
    await referenceChoice(historical);await courses();assert.equal(await catalog.locator('.tcs-row').count(),1);await button('Open course DES5002').click();await assertTerm(current.id);
  }
  await page.setViewportSize({width:1440,height:1000});await theme('light-default');
  checks.push('Compact 430px navigation keeps Courses visible; light/dark menus fit the viewport, keyboard opening and Escape restore focus, and historical selection and full-catalog return remain available.');
  const genericStory=Object.values(index.entries).find(item=>item.name==='asTeach — Courses and workspace');assert(genericStory);
  await page.goto(`${origin}/iframe.html?id=${encodeURIComponent(genericStory.id)}&viewMode=story`);await pluginHome.waitFor();await courses();assert.equal(await catalog.locator('.tcs-row').count(),2);
  await catalog.getByRole('button',{name:'Design foundations',exact:true}).click();await study.waitFor();await frame();const firstId=await study.getAttribute('data-course-id');await courseFocus();
  const editor=study.locator('.teach-source .cm-content');
  const description=()=>study.getByRole('navigation',{name:'Course navigation',exact:true}).getByRole('button',{name:/^Instructor page(?: Unsaved changes)?$/});
  await description().click();await button('Edit').click();await editor.fill('# Current term draft\n\nRetained in the current term only.\n');const firstDraft=await editor.innerText();
  const resumeCurrentDraft=async(checkFocus=true)=>{assert(await study.locator('.teach-reading[aria-label="Instructor page preview"]').isVisible(),'Opening a course explicitly lands at Instructor page.');if(checkFocus)assert(await study.locator('.teach-reading').evaluate(element=>element===document.activeElement),'Returning from a retained editor to Instructor page focuses the reading surface.');assert.equal(await study.getByRole('heading',{name:'Current term draft',exact:true}).count(),0,'Instructor page never publishes an unsaved draft.');if(!await description().isVisible()){await button('Toggle file sidebar').click();await frame();}await description().click();await button('Edit').click();assert.equal(await editor.innerText(),firstDraft);};
  await selectMenu('terms','Add term');const addTerm=page.getByRole('dialog',{name:'Add term',exact:true});await addTerm.waitFor();assert.equal(await addTerm.getByRole('textbox',{name:'Course Code',exact:true}).inputValue(),'DES101');
  await addTerm.getByRole('button',{name:'Year',exact:true}).click();await page.getByRole('menu',{name:'Year',exact:true}).getByRole('menuitemradio',{name:'2024',exact:true}).click();await addTerm.getByRole('combobox',{name:'Season',exact:true}).selectOption('Spring');await addTerm.getByRole('button',{name:'Create term',exact:true}).click();await study.waitFor();await frame();const secondId=await study.getAttribute('data-course-id');assert.notEqual(secondId,firstId);
  await description().click();await button('Edit').click();const secondInitial=await editor.innerText();assert.match(secondInitial,/Course Description/);await editor.fill('# Historical term draft\n\nRetained in the historical term only.\n');const secondDraft=await editor.innerText();
  await openCurrent('DES101');await assertTerm(firstId);assert.match(await breadcrumb.innerText(),/Instructor page/);await resumeCurrentDraft();
  await selectMenu('terms','2024 Spring');await assertTerm(secondId);assert.equal(await editor.innerText(),secondDraft);
  const undo=process.platform==='darwin'?'Meta+z':'Control+z',redo=process.platform==='darwin'?'Meta+Shift+z':'Control+Shift+z';await editor.press(undo);assert.equal(await editor.innerText(),secondInitial);await editor.press(redo);assert.equal(await editor.innerText(),secondDraft);
  await courses();assert.equal(await catalog.locator('.tcs-row').count(),2);await button('Open course DES101').click();await assertTerm(firstId);await resumeCurrentDraft();
  checks.push('Editable Add term is available from the term selector; creating a historical term preserves separate current/historical drafts, Edit mode and undo history. Opening the course goes to its current/latest Home; reopening its editor restores the unpublished draft.');
  await courses();await button('Choose term for DES101').click();menu=page.getByRole('menu');await menu.getByRole('menuitem',{name:'Open DES101 2024 Spring',exact:true}).click();await assertTerm(secondId);assert.equal(await editor.innerText(),secondDraft,'The catalog term selector restores the chosen term editor and draft.');await courses();await button('Choose term for DES101').click();menu=page.getByRole('menu');await menu.waitFor();assert(await menu.getByRole('menuitem',{name:'Add term',exact:true}).isVisible());assert.equal(await menu.getByRole('menuitem',{name:'Open DES101 2026 Autumn',exact:true}).getAttribute('aria-description'),'Latest term');
  await capture('courses-navigation-annotated.png',[
    ['C0 · Stable Courses destination','.pws-breadcrumb'],
    ['C3 · Open current or latest Instructor page','.tcs-row'],
    ['C3 · Historical terms and Add term','.pws-ancestor-menu']
  ]);
  await menu.getByRole('menuitem',{name:'Add term',exact:true}).click();await addTerm.waitFor();await addTerm.getByRole('button',{name:'Cancel',exact:true}).click();await frame();assert(await button('Choose term for DES101').evaluate(element=>element===document.activeElement));
  await button('Open course DES101').click();await assertTerm(firstId);state=await openMenu('terms');await capture('c0-navigation-annotated.png',[
    ['C0 · Courses and term navigation','.pws-breadcrumb'],
    ['C0 · Choose term or add another','.pws-ancestor-menu']
  ]);await dismiss(state);
  state=await openMenu('terms');await state.menu.getByRole('menuitem',{name:'Add term',exact:true}).click();await addTerm.waitFor();await addTerm.getByRole('button',{name:'Cancel',exact:true}).click();await frame();assert(await state.trigger.evaluate(element=>element===document.activeElement),'Breadcrumb Add term Cancel restores the term trigger.');
  checks.push('The full Courses list offers existing terms and Add term in its selector; Cancel restores its trigger focus and all existing course groups remain in the catalog.');
  await page.setViewportSize({width:430,height:1000});await theme('dark-default');state=await openMenu('terms');await checkMenuBounds(state.menu,'Editable compact menu');assert(await state.menu.getByRole('menuitem',{name:'Add term',exact:true}).isVisible());
  await state.menu.getByRole('menuitem',{name:'Add term',exact:true}).click();await addTerm.waitFor();await addTerm.getByRole('button',{name:'Cancel',exact:true}).click();await frame();assert(await state.trigger.evaluate(element=>element===document.activeElement),'Compact Add term Cancel restores the overflow trigger.');state=await openMenu('terms');
  await state.menu.getByRole('menuitem',{name:'2024 Spring',exact:true}).focus();await page.keyboard.press('Enter');await assertTerm(secondId);assert.equal(await editor.innerText(),secondDraft);await courseFocus();
  await capture('editable-compact-dark.png');await selectMenu('courses','All courses');await catalog.waitFor();await frame();assert(await catalog.locator('#tcs-heading').evaluate(element=>element===document.activeElement),'Compact All courses focuses the complete catalog.');assert.equal(await catalog.locator('.tcs-row').count(),2);await button('Open course DES101').click();await assertTerm(firstId);await resumeCurrentDraft();
  checks.push('Compact keyboard term selection restores the historical draft; persistent Courses returns to all groups and reopening restores the current draft without overflow.');
  assert.equal(errors.length,0);assert.equal(consoleErrors.length,0);assert.equal(externalRequests.length,0);
  assert(transportRequests.every(item=>item.method==='GET'||item.operation==='getCommitPreferences'),'Navigation qualification requests no source/repository write.');
  assert.deepEqual(await inventory(fixtureRoot),fixtureInputs);assert.deepEqual(await inventory(sourceRoot),sourceInputs);assert.deepEqual(await inventory(buildRoot),buildInputs);
  checks.push('All fixture bytes and pinned product-source/static-build inputs remain unchanged; no unexpected runtime, console, external-network or content-write request occurs.');
}catch(error){failure=error.stack??String(error);if(page)failureContext=await page.evaluate(()=>({activeElement:document.activeElement?.outerHTML.slice(0,2000),openDialog:document.querySelector('dialog[open]')?.getAttribute('aria-label'),yearMenu:document.querySelector('[role="menu"][aria-label="Year"]')?.outerHTML.slice(0,1000)})).catch(()=>null);if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}
finally{
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify({passed:!failure,mode:'course-navigation',checks,failure,failureContext,errors,consoleErrors,externalRequests,transportRequests,geometry,captures,chromiumSandbox:true,browserVersion,story:story.id,fixtureInputs,sourceInputs,buildInputs,limits:['Focused changed-boundary Storybook checks only; unrelated planner/reference suites were not rerun.','No packaged native or persistent-storage acceptance. Composition guard was source-reviewed only: the preserved attempt02 synthetic compositionstart did not activate CodeMirror composing state; this run does not browser-qualify IME guarding.']},null,2));
}
if(failure){console.error(failure);process.exitCode=1;}else console.log(`${checks.length} focused course-navigation groups passed. Evidence: ${output}`);
