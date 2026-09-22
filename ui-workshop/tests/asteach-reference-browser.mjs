import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {chromium} from '../../tools/playwright.mjs';
import {testRoot} from '../../tools/development-paths.mjs';
import {referenceTeachCalendarState} from '../src/teach-reference-calendar.mjs';
import {staticHandler, createTeachReferenceHandler, teachReferencePrefix} from '../.storybook/static-server.mjs';

// Opt-in private fixture qualification. No course source belongs in this file.
const output=process.env.ASMB_REFERENCE_OUTPUT, fixtureRoot=process.env.ASMB_TEACH_REFERENCE_ROOT, executablePath=process.env.ASMB_BROWSER;
assert(output&&fixtureRoot&&executablePath,'Set ASMB_REFERENCE_OUTPUT, ASMB_TEACH_REFERENCE_ROOT and ASMB_BROWSER.');
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
const checks=[], errors=[], externalRequests=[], transportRequests=[], consoleErrors=[], geometry=[];
let browser,page,server,failure,browserVersion,referenceMode='live';
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
  let staticFiles,liveReference,absentReference;
  const json=(res,value)=>{res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  server=createServer(async(req,res)=>{
    try{
      const pathname=new URL(req.url,'http://localhost').pathname;
      if(pathname.startsWith(teachReferencePrefix)){
        transportRequests.push({path:pathname,method:req.method,mode:referenceMode});
        if(referenceMode==='absent')return absentReference(req,res);
        if(referenceMode==='error'){res.writeHead(503,{'cache-control':'no-store'});return res.end();}
        if(referenceMode==='malformed'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end('{invalid');}
        if(referenceMode==='invalid'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify({schemaVersion:1,label:'Invalid fixture',courses:[{}]}));}
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
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port,origin=`http://127.0.0.1:${port}`;
  [staticFiles,liveReference,absentReference]=await Promise.all([staticHandler(buildRoot,port),createTeachReferenceHandler({root:fixtureRoot,port,allowedRoot:testRoot}),createTeachReferenceHandler({port,allowedRoot:testRoot})]);
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
  const selectYear=async(scope,year,verifyRange=false,captureName)=>{
    await scope.getByRole('button',{name:'Year',exact:true}).click();
    const menu=page.getByRole('menu',{name:'Year',exact:true});await menu.waitFor();await frame();
    if(verifyRange){
      const values=await menu.getByRole('menuitemradio').allTextContents();
      assert.deepEqual(values,Array.from({length:152},(_,index)=>String(1949+index)),'Every year from 1949 through 2100 appears exactly once in chronological order with a plain year label.');
      const visibleYears=await menu.evaluate(element=>{
        const bounds=element.getBoundingClientRect();
        return [...element.querySelectorAll('[role=menuitemradio]')].filter(item=>{const row=item.getBoundingClientRect();return row.top>=bounds.top-1&&row.bottom<=bounds.bottom+1;}).map(item=>item.textContent);
      });
      assert.deepEqual(visibleYears,Array.from({length:6},(_,index)=>String(new Date().getFullYear()+index)),'The initial viewport shows the current year and next five years while earlier years remain above it.');
    }
    if(captureName)await capture(captureName,[['C4 · New course setup','.tcs-dialog[open]'],['C4 · Complete year menu, current year first','.tyear-menu']]);
    await menu.getByRole('menuitemradio',{name:String(year),exact:true}).click();await frame();
    assert.equal(await menu.count(),0,'Selecting a year closes its menu.');
  };
  const capture=async(name,regions)=>{
    if(regions)await page.evaluate(items=>{
      const overlay=document.createElement('div');overlay.id='reference-qa-overlay';overlay.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      for(const [label,selector] of items){const element=[...document.querySelectorAll(selector)].find(item=>item.getClientRects().length&&!item.closest('[hidden]'));if(!element)throw Error('Missing overlay region '+label);const r=element.getBoundingClientRect(),box=document.createElement('div');box.style.cssText=`position:fixed;box-sizing:border-box;border:2px dashed #8054ff;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;const caption=document.createElement('span');caption.textContent=label;caption.style.cssText='position:absolute;left:2px;top:2px;background:#6435d6;color:white;font:600 11px/18px system-ui;padding:0 5px;border-radius:3px';box.append(caption);overlay.append(box);}(document.querySelector('dialog[open]')??document.body).append(overlay);
    },regions);
    try{await page.screenshot({path:path.join(output,name)});}finally{if(regions)await page.locator('#reference-qa-overlay').evaluate(element=>element.remove());}
  };
  const readOnly=async()=>{
    assert.equal(await study.locator('[contenteditable="true"]:visible').count(),0,'Reference cannot enter an editable document.');
    for(const name of ['Edit','Save','Cancel'])assert.equal(await study.getByRole('button',{name,exact:true}).count(),0,`No ${name} control in read-only course.`);
    assert.equal(await study.getByRole('button',{name:/^Edit /}).count(),0);
  };
  const openStory=async()=>{await page.goto(`${origin}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`);await frame();};
  await openStory();await page.getByRole('heading',{name:'Home',exact:true}).waitFor();
  const home=page.locator('.ths-home:visible');
  assert.equal(await home.locator('.ths-recent,.tcs-continue,.ths-recent-list').count(),0,'Home does not show continuation or recent-document sections.');
  assert.equal(await home.getByRole('button',{name:'Continue',exact:true}).count(),0);
  assert(await home.getByRole('button',{name:'Create a new course',exact:true}).isVisible(),'Reference Home can create an independent synthetic course.');
  assert.equal(await home.getByRole('button',{name:'Add existing course',exact:true}).count(),0);
  await button('Edit teacher details').click();
  const profile=page.getByRole('dialog',{name:'Teacher details',exact:true});
  assert(await profile.getByRole('button',{name:'Import from ORCID',exact:true}).isDisabled());
  await profile.getByRole('textbox',{name:'Given names',exact:true}).fill('Local reference teacher');
  await profile.getByRole('button',{name:'Save teacher details',exact:true}).click();
  assert.equal(await page.locator('.ths-profile').count(),0,'Teacher summary is absent from Home.');
  await button('Edit teacher details').click();
  assert.equal(await profile.getByRole('textbox',{name:'Given names',exact:true}).inputValue(),'Local reference teacher');
  await profile.getByRole('textbox',{name:'Given names',exact:true}).fill('Cancelled change');
  await profile.getByRole('button',{name:'Cancel',exact:true}).click();
  await button('Edit teacher details').click();
  assert.equal(await profile.getByRole('textbox',{name:'Given names',exact:true}).inputValue(),'Local reference teacher');
  await profile.getByRole('button',{name:'Cancel',exact:true}).click();
  checks.push('The built reference story exposes the same editable local ORCID profile and disabled import; Save/Cancel keep profile changes separate from read-only course data.');
  await button('Courses — all courses').click();await page.getByRole('heading',{name:'Courses',exact:true}).waitFor();
  assert.equal(await page.locator('.tcs-row').count(),1,'Four offerings appear as one top-level course.');
  for(const name of ['New course','Add existing course'])assert.equal(await button(name).count(),0);
  assert(await button('Create a new course').isVisible(),'Reference Courses can create an independent synthetic course.');
  const course=fixture.courses[0],courseRow=page.locator('.tcs-row');
  assert.match(await courseRow.innerText(),/4 terms/);
  assert.equal(await page.locator('.tcs-list-heading .pws-count').innerText(),'1','Courses count reflects course identities.');
  const courseSearch=page.getByRole('searchbox',{name:'Search courses',exact:true});
  for(const query of [course.code,course.title,'2024','Spring']){
    await courseSearch.fill(query);
    assert.equal(await courseRow.count(),1,'Searching course metadata or any term retains one course group.');
    assert.match(await courseRow.innerText(),/4 terms/,'Search does not discard other terms in the group.');
  }
  await courseSearch.fill('no-matching-course');assert.equal(await courseRow.count(),0);
  assert.equal(await page.locator('.tcs-list-heading .pws-count').innerText(),'0');
  await courseSearch.fill('');
  const quickTrigger=button(`Choose term for ${course.code}`);
  await quickTrigger.click();
  const quickMenu=page.getByRole('menu');
  await quickMenu.waitFor();
  assert.equal(await quickMenu.getAttribute('aria-label'),`${course.code} terms`);
  assert.equal(await quickMenu.getByRole('menuitem').count(),4);
  for(const item of fixture.courses)assert(await quickMenu.getByRole('menuitem',{name:`Open ${item.code} ${item.year} ${item.season}`,exact:true}).isVisible());
  await capture('reference-courses-grouped.png');
  await capture('reference-terms-marked.png',[['R1 / C0 Course navigation','.fw-titlebar'],['R2 Four terms for one course','[role="menu"]'],['R3 One read-only course','.tcs-list']]);
  await dismiss({menu:quickMenu,trigger:quickTrigger});
  await button(`Open course ${course.code}`).click();await frame();
  const current=fixture.courses.find(item=>item.reference.home.kind==='composed');assert(current);
  assert.equal(await study.getAttribute('data-course-id'),current.id,'Opening the course goes directly to its current term');
  assert.match(await breadcrumb.innerText(),/Courses/);
  assert(await study.evaluate(element=>element.contains(document.activeElement)),'Opening the course focuses its content');
  await breadcrumb.getByRole('button',{name:'asTeach — Home',exact:true}).click();await frame();
  assert(await page.getByRole('heading',{name:'Home',exact:true}).isVisible(),'asTeach returns to plugin Home.');
  await button('Courses — all courses').click();await frame();
  assert.equal(await page.locator('.tcs-row').count(),1,'Home opens the grouped Courses catalog.');
  await breadcrumb.getByRole('button',{name:'Courses — all courses',exact:true}).click();await frame();
  assert.equal(await page.locator('.tcs-row').count(),1,'Courses entry uses the same grouped landing.');
  let menu=await openMenu('courses');assert.equal(await menu.menu.getByRole('menuitem').count(),1,'Four terms share one course identity.');
  await menu.menu.getByRole('menuitem',{name:`${course.code} — ${course.title}`,exact:true}).click();await frame();
  assert.equal(await study.getAttribute('data-course-id'),current.id,'The course menu also opens the current term directly');
  menu=await openMenu('terms');
  assert.equal(await menu.menu.getByRole('menuitem').count(),fixture.courses.length);
  for(const item of fixture.courses)assert(await menu.menu.getByRole('menuitem',{name:`${item.year} ${item.season}`,exact:true}).isVisible());
  await capture('reference-terms.png');
  await dismiss(menu);
  checks.push('The actual built reference story starts on Home, opens a separate catalog with one course and four terms, searches across every term while retaining the complete group, opens the current term directly and provides a four-item quick term dropdown.');
  await selectMenu('terms',`${current.year} ${current.season}`);
  assert.equal(await study.getAttribute('data-course-id'),current.id);await readOnly();
  assert.equal(await study.locator('.teach-home-section').count(),13,'Current instructor Home uses thirteen include sources.');
  assert.deepEqual(await study.locator('.teach-home-section').evaluateAll(items=>items.map(item=>item.dataset.sourcePath)),current.sections.map(item=>item.path),'Composed Home uses every original include path.');
  await capture('reference-current-home.png');
  await capture('reference-current-home-marked.png',[['R1 / C0 Term and page navigation','.fw-titlebar'],['R4 Instructor Home','.teach-reading'],['R5 Saved source sections','.teach-sidebar'],['R6 Reference status','.teach-status']]);
  const currentHomeText=await study.locator('.teach-reading').innerText();
  const preserved=current.reference.pages[0];assert(preserved);
  await selectMenu('pages',preserved.title);await readOnly();
  assert.equal(await study.locator('.teach-home-section').count(),0,'Flattened term source is a separate document, not the current composed Home.');
  assert((await study.locator('.teach-reading').innerText())!==currentHomeText);
  await capture('reference-preserved-2026.png');
  checks.push('Current instructor Home composes thirteen sources; the preserved 2026 term page is a distinct selectable read-only document.');
  // The source view is an exact-byte read-only escape hatch for legacy GitBook HTML.
  const verifySource=async expected=>{
    await button('Source').click();
    const sourceView=study.locator('.teach-reference-source');
    assert.equal(await sourceView.textContent(),expected,'Reference source preserves exact original text.');
    assert.equal(await sourceView.getAttribute('contenteditable'),null);
    await button('Preview').click();await frame();
  };
  await verifySource(preserved.source);
  await selectMenu('pages',current.reference.home.title);
  await verifySource(current.reference.home.source);
  for(const section of current.sections){
    await selectMenu('pages',section.title);await readOnly();await verifySource(section.source);
  }
  checks.push('All thirteen current section sources and the instructor Home source remain byte-for-byte readable without an editor, Save or content mutation.');
  await selectMenu('pages','Course calendar');
  const courseCalendar=study.locator('.tcal-course-calendar');
  const recordedCalendar=referenceTeachCalendarState(fixture.courses).terms[current.id];
  assert(recordedCalendar.recordedClasses.length>0,'Pinned reference must populate the calendar.');
  const recordedCount=recordedCalendar.recordedClasses.length;
  assert.equal(await courseCalendar.locator('[data-recorded-class]').count(),recordedCount);
  assert.equal(await courseCalendar.getByRole('button',{name:'Add class session',exact:true}).count(),0);
  assert.equal(await courseCalendar.getByRole('button',{name:'Save calendar settings',exact:true}).count(),0);
  await courseCalendar.getByRole('button',{name:'View teaching schedule',exact:true}).click();
  await readOnly();await verifySource(current.sections.find(section=>section.id==='teaching-schedule').source);
  await breadcrumb.getByRole('button',{name:'asTeach — Home',exact:true}).click();
  const overview=page.locator('.tcal-overview');
  await selectYear(overview,current.year,true);
  await overview.getByRole('combobox',{name:'Season',exact:true}).selectOption(current.season);
  const undatedRecords=recordedCalendar.recordedClasses.filter(record=>!record.date);
  assert.equal(await overview.locator('.tcal-grid [data-recorded-class]').count(),recordedCount-undatedRecords.length,'Home shows every dated source class in the calendar.');
  assert.equal(await overview.locator('.tcal-undated').count(),0,'The complete undated list belongs to Course calendar.');
  assert.equal(await overview.locator('.tcal-pending-class').count(),undatedRecords.length?1:0,'Home shows only the first pending-date class for this course.');
  if(undatedRecords.length){
    const pending=overview.locator('.tcal-pending-class');
    assert((await pending.innerText()).includes(undatedRecords[0].title),'The pending preview uses the first undated source class.');
    await home.locator('.ths-heading').scrollIntoViewIfNeeded();
    await capture('reference-plugin-home-marked.png',[['TH1 · Home actions','.ths-heading'],['TH1.1 · Inline office details','.ths-office-details'],['TH3 · Year and season','.tcal-controls'],['TH4 · First pending class opens Course calendar','.tcal-pending-class']]);
    await pending.click();await frame();
    assert.equal(await courseCalendar.locator('.tcal-undated [data-recorded-class]').count(),undatedRecords.length,'The pending preview opens the complete undated list in Course calendar.');
    await breadcrumb.getByRole('button',{name:'asTeach — Home',exact:true}).click();await frame();
  }
  assert.equal(await overview.getByRole('button',{name:'Add class session',exact:true}).count(),0);
  assert.equal(await overview.locator('.tcal-heading').getByRole('button',{name:'Add no-class day',exact:true}).count(),0,'The calendar header has no no-class-day add button.');
  await overview.locator('.tcal-course-summary').filter({hasText:current.code}).click();
  assert.equal(await courseCalendar.locator('[data-recorded-class]').count(),recordedCount,'Recorded schedule survives Home navigation.');
  await selectMenu('pages',current.reference.home.title);await readOnly();await verifySource(current.reference.home.source);
  checks.push('DES5002 Home shows every dated source class and only the first pending-date preview; that preview opens the full undated Course calendar list. The chronological 1949–2100 year menu initially shows the current year and next five. Source notes and original syllabus remain read-only and unchanged.');
  for(const historical of fixture.courses.filter(item=>item.reference.home.kind==='document')){
    await selectMenu('terms',`${historical.year} ${historical.season}`);
    assert.equal(await study.getAttribute('data-course-id'),historical.id);await readOnly();
    assert.equal(await study.locator('.teach-home-section').count(),0);
    await verifySource(historical.reference.home.source);
    const headingLines=historical.reference.home.source.split(/\r?\n/).filter(line=>/^#{1,6}\s/.test(line)).map(line=>line.replace(/^#{1,6}\s+/,''));
    const extra=headingLines.filter(title=>/Project Reachy Fusion/.test(title));
    for(const title of extra)assert(await study.getByRole('heading',{name:title,exact:true}).count()>0,'Historical extra content survives outside the thirteen mapped sections.');
    menu=await openMenu('pages');
    for(const section of historical.sections.filter(item=>!item.source.trim()))assert.equal(await menu.menu.getByRole('menuitem',{name:`${section.title} — No content yet`,exact:true}).getAttribute('aria-disabled'),'true');
    await dismiss(menu);
    await capture(`reference-${historical.year}-${historical.season.toLowerCase()}.png`);
  }
  checks.push('All historical terms retain their complete document Home and exact source bytes, including extra content outside the mapped thirteen sections; unavailable section menu entries stay disabled.');
  const oldest=fixture.courses.at(-1);
  await selectMenu('terms',`${oldest.year} ${oldest.season}`);
  await button('Source').click();
  await capture('reference-historical-source-marked.png',[['R1 / C0 Selected term','.fw-titlebar'],['R7 Read-only original source','.teach-reference-source'],['R8 Reading mode','.teach-toolbar']]);
  await button('Preview').click();
  const images=study.locator('img.teach-reference-image');
  assert(await images.count()>0,'Historical reference maps local images.');
  for(let i=0;i<await images.count();i++){await images.nth(i).scrollIntoViewIfNeeded();await images.nth(i).evaluate(image=>image.decode());}
  assert(await images.evaluateAll(items=>items.every(item=>item.complete&&item.naturalWidth>0&&new URL(item.src).origin===location.origin)));
  await capture('reference-historical-local-image.png');
  checks.push('Reference images load only through the approved same-origin asset endpoint; imported course links execute no external request.');
  for(const scheme of ['light-default','dark-default']){
    await button('asMagicBrain Theme').click();await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption(scheme);await button('Done').click();
    for(const width of [1440,760,600,430]){
      await page.setViewportSize({width,height:1000});await frame();
      menu=await openMenu('terms');
      const bounds=await menu.menu.evaluate(element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};});
      geometry.push({scheme,width,...bounds});assert(bounds.left>=0&&bounds.right<=width&&bounds.top>=0&&bounds.bottom<=1000);
      assert(await page.locator('.fw-window').evaluate(element=>element.scrollWidth<=element.clientWidth+1));
      await capture(`reference-menu-${scheme}-${width}.png`);await dismiss(menu);await readOnly();
    }
  }
  checks.push('Reference menus and reading view fit 1440/760/600/430 px in light and dark; Escape restores trigger focus.');
  await page.setViewportSize({width:1440,height:1000});
  // Keep synthetic creation after all four-term reference assertions above.
  await breadcrumb.getByRole('button',{name:'asTeach — Home',exact:true}).click();await frame();
  const newCourse=page.getByRole('dialog',{name:'New course',exact:true});
  await home.getByRole('button',{name:'Create a new course',exact:true}).click();
  await newCourse.getByRole('textbox',{name:'Course Code',exact:true}).fill(course.code.toLowerCase());
  await selectYear(newCourse,'2100',true);
  await newCourse.getByRole('combobox',{name:'Season',exact:true}).selectOption('Winter');
  await newCourse.locator('button[type="submit"]').click();
  assert.match(await newCourse.getByRole('alert').innerText(),/read.only/i,'A reference course code cannot be extended with an editable term.');
  assert.equal(await newCourse.count(),1,'A blocked reference extension keeps the setup dialog open.');
  await newCourse.getByRole('button',{name:'Cancel',exact:true}).click();
  assert(await home.getByRole('button',{name:'Create a new course',exact:true}).evaluate(element=>element===document.activeElement),'Cancel restores the Home creation trigger.');
  const syntheticCourses=[{surface:'Home',code:'QA_REFERENCE_HOME',title:'Synthetic Home course'},{surface:'Courses',code:'QA_REFERENCE_COURSES',title:'Synthetic Courses course'}];
  for(const [index,synthetic] of syntheticCourses.entries()){
    if(synthetic.surface==='Courses'){await button('Courses — all courses').click();await page.getByRole('heading',{name:'Courses',exact:true}).waitFor();}
    assert.equal(await button('Add existing course').count(),0,'Reference mode does not expose repository adoption after synthetic creation.');
    await button('Create a new course').click();await newCourse.waitFor();
    await newCourse.getByRole('textbox',{name:'Course Code',exact:true}).fill(synthetic.code);
    await newCourse.getByRole('textbox',{name:'Course Name',exact:true}).fill(synthetic.title);
    await selectYear(newCourse,'2100',false,synthetic.surface==='Home'?'reference-new-course-year-annotated.png':undefined);
    await newCourse.getByRole('combobox',{name:'Season',exact:true}).selectOption('Winter');
    await capture(`reference-${synthetic.surface.toLowerCase()}-new-course.png`);
    await newCourse.getByRole('button',{name:'Create course',exact:true}).click();await frame();
    assert.equal(await newCourse.count(),0);
    assert(await study.getByRole('heading',{name:synthetic.title,exact:true}).isVisible(),`${synthetic.surface} creation opens its new course.`);
    const createdCourseId=await study.getAttribute('data-course-id');
    assert(createdCourseId&&!fixture.courses.some(item=>item.id===createdCourseId),'The new course has an independent identity.');
    assert.equal(await study.getAttribute('data-read-only'),null,'Only the independent synthetic course is editable.');
    await selectMenu('pages','Course Instructor & Teaching Team');
    assert((await study.locator('.teach-reading').innerText()).includes('Local reference teacher'),'Saved local teacher details initialize the new course.');
    assert(await study.getByRole('button',{name:'Edit',exact:true}).isVisible());
    await study.getByRole('button',{name:'Back to Courses',exact:true}).click();await frame();
    assert.equal(await page.locator('.tcs-row').count(),index+2,'Each synthetic course adds one independent course group.');
    const referenceRow=page.locator('.tcs-row').filter({has:page.getByRole('button',{name:`Open course ${course.code}`,exact:true})});
    assert.match(await referenceRow.innerText(),/4 terms/,'Reference terms are unchanged after blocked extension and synthetic creation.');
  }
  await button(`Open course ${course.code}`).click();await frame();
  assert.equal(await study.getAttribute('data-course-id'),current.id);
  const retainedTerms=await openMenu('terms');
  assert.equal(await retainedTerms.menu.getByRole('menuitem').count(),4,'The reference retains exactly its four original terms.');
  assert.equal(await retainedTerms.menu.getByRole('menuitem',{name:'Add term',exact:true}).count(),0,'The reference course has no editable-term entry point.');
  await dismiss(retainedTerms);
  await selectMenu('terms',`${current.year} ${current.season}`);await readOnly();
  await selectMenu('pages',current.reference.home.title);await verifySource(current.reference.home.source);
  await selectMenu('pages','Course Instructor & Teaching Team');await verifySource(current.sections.find(section=>section.id==='teaching-team').source);
  checks.push('Home and Courses create separate editable synthetic courses and copy only local teacher defaults. The reference code rejects new terms, retains its four original terms and exact source bytes, and never exposes Add existing course.');
  for(const mode of ['absent','error','malformed','invalid']){
    referenceMode=mode;await openStory();await page.getByRole('heading',{name:'DES5002 reference unavailable',exact:true}).waitFor();
    assert.equal(await page.locator('.teach-study,.tcs-row').count(),0,'Unavailable fixture never falls back to invented course data.');
    assert(await button('Retry reference').isVisible());await capture(`reference-${mode}.png`);
  }
  referenceMode='live';await button('Retry reference').click();await page.getByRole('heading',{name:'Home',exact:true}).waitFor();await button('Courses — all courses').click();await page.getByRole('heading',{name:'Courses',exact:true}).waitFor();assert.equal(await page.locator('.tcs-row').count(),1);
  checks.push('Absent, server-error, malformed and invalid-schema fixtures show a safe unavailable state; Retry recovers when the valid local fixture becomes available.');
  assert.equal(externalRequests.length,0);assert.equal(errors.length,0);
  assert.equal(consoleErrors.filter(item=>item.mode==='live').length,0,'No browser console errors in the valid reference flow.');
  assert(transportRequests.every(item=>item.method==='GET'||item.operation==='getCommitPreferences'),'No content mutation was requested.');
  assert.deepEqual(await inventory(fixtureRoot),fixtureInputs,'Browser qualification does not mutate fixture bytes.');
  assert.deepEqual(await inventory(sourceRoot),sourceInputs,'Source stayed stable through qualification.');
  assert.deepEqual(await inventory(buildRoot),buildInputs,'Static build stayed stable through qualification.');
  checks.push('Reference reads and in-memory synthetic creation issue no content write, leave all fixture/source/static hashes unchanged, and make no external network request.');
}catch(error){failure=error.stack??String(error);if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}
finally{
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify({passed:!failure,checks,failure,errors,consoleErrors,externalRequests,transportRequests,geometry,chromiumSandbox:true,browserVersion,story:story.id,fixtureInputs,sourceInputs,buildInputs,limits:['Storybook-only read-only reference with independent in-memory synthetic course creation; not native or persistent storage acceptance.','Legacy GitBook HTML remains inert and may require the exact-source view.']},null,2));
}
if(failure){console.error(failure);process.exitCode=1;}else console.log(`${checks.length} reference qualification groups passed. Evidence: ${output}`);
