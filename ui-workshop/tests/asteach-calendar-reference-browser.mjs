import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {referenceTeachCalendarState} from '../src/teach-reference-calendar.mjs';
import {chromium} from '../../tools/playwright.mjs';
import {testRoot} from '../../tools/development-paths.mjs';
import {staticHandler, createTeachReferenceHandler, teachReferencePrefix} from '../.storybook/static-server.mjs';

// Opt-in date qualification against the separately supplied private fixture.
// Only metadata expectations belong in this file; original course text stays external.
const output=process.env.ASMB_CALENDAR_REFERENCE_OUTPUT, fixtureRoot=process.env.ASMB_TEACH_REFERENCE_ROOT, executablePath=process.env.ASMB_BROWSER;
assert(output&&fixtureRoot&&executablePath,'Set ASMB_CALENDAR_REFERENCE_OUTPUT, ASMB_TEACH_REFERENCE_ROOT and ASMB_BROWSER.');
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
const recordedState=referenceTeachCalendarState(fixture.courses);
const sourceInputs=await inventory(sourceRoot), fixtureInputs=await inventory(fixtureRoot), buildInputs=await inventory(buildRoot);
const index=JSON.parse(await fs.readFile(path.join(buildRoot,'index.json'),'utf8'));
const story=Object.values(index.entries).find(item=>item.name==='asTeach — DES5002 reference');
assert(story,'Build the dedicated reference story before qualification.');
const checks=[], errors=[], externalRequests=[], transportRequests=[], consoleErrors=[], geometry=[], terms=[], captures=[];
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
      for(const [label,selector] of items){const element=[...document.querySelectorAll(selector)].find(item=>item.getClientRects().length&&!item.closest('[hidden]'));if(!element)throw Error('Missing overlay region '+label);const r=element.getBoundingClientRect(),box=document.createElement('div');box.style.cssText=`position:fixed;box-sizing:border-box;border:2px dashed #8054ff;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;const caption=document.createElement('span');caption.textContent=label;caption.style.cssText='position:absolute;left:2px;top:2px;background:#6435d6;color:white;font:600 11px/18px system-ui;padding:0 5px;border-radius:3px';box.append(caption);overlay.append(box);}document.body.append(overlay);
    },regions);
    try{await page.screenshot({path:path.join(output,name)});}finally{if(regions)await page.locator('#calendar-reference-qa-overlay').evaluate(element=>element.remove());}
  };
  const pluginHome=page.locator('[data-plugin-view="home"]:visible');
  const overview=pluginHome.locator('.tcal-overview'),courseCalendar=study.locator('.tcal-course-calendar');
  const home=async()=>{await breadcrumb.getByRole('button',{name:'asTeach — Home',exact:true}).click();await pluginHome.waitFor();await frame();};
  const selectYear=async(trigger,value)=>{await trigger.click();await page.getByRole('menu',{name:'Year',exact:true}).getByRole('menuitemradio',{name:String(value),exact:true}).click();await frame();};
  const filter=async course=>{await selectYear(overview.getByRole('button',{name:'Year',exact:true}),course.year);await overview.getByRole('combobox',{name:'Season',exact:true}).selectOption(course.season);await frame();};
  const openCourseCalendar=async course=>{await overview.locator('.tcal-course-summary').filter({hasText:course.code}).click();await courseCalendar.waitFor();await frame();assert.equal(await study.getAttribute('data-course-id'),course.id);assert.match(await breadcrumb.innerText(),/Course calendar/);assert.equal(await courseCalendar.getAttribute('aria-label'),`${course.code} · ${course.year} ${course.season} teaching calendar`);};
  const verifySource=async(expected,title)=>{await selectMenu('pages',title);await button('Source').click();assert.equal(await study.locator('.teach-reference-source').textContent(),expected,'Original course source bytes remain exactly readable.');assert.equal(await study.locator('[contenteditable="true"]:visible').count(),0);await button('Preview').click();await frame();};
  const verifyGrid=async(scope,expected,label)=>{
    const grid=scope.locator('.tcal-grid'),rows=grid.locator('tbody tr');
    await grid.waitFor();
    assert.equal(await grid.count(),1,`${label}: one complete dated calendar.`);
    assert.equal(await rows.count(),expected.weeks,`${label}: all continuous calendar weeks render.`);
    assert.deepEqual(await rows.locator('th>time').evaluateAll(items=>items.map(item=>item.dateTime)),Array.from({length:expected.weeks},(_,index)=>{const date=new Date(`${expected.monday}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+index*7);return date.toISOString().slice(0,10);}));
    assert.equal(await grid.locator('td').count(),expected.weeks*7,`${label}: seven weekday cells per week.`);
    assert.equal(await grid.locator(`td[data-date="${expected.end}"]`).count(),1,`${label}: final Sunday retained.`);
    if(scope===overview){assert.equal(await scope.locator('.tcal-undated').count(),0,`${label}: Home has no undated block.`);assert.equal(await scope.locator('.tcal-pending-class').count(),expected.undated?1:0,`${label}: Home shows only the first pending class link.`);}else assert.equal(await scope.locator('.tcal-undated [data-recorded-class]').count(),expected.undated,`${label}: course retains every undated record.`);
    assert.equal(await grid.locator('[data-recorded-class]').count(),expected.dated,`${label}: dated source classes appear exactly once.`);
    assert.equal(await grid.locator('.tcal-cancelled').count(),expected.cancelled,`${label}: cancelled records remain visible.`);
    assert.equal(await grid.locator('td .tcal-no-class').count(),0,`${label}: source cancellation creates no global no-class date.`);
    assert(!/00:00/.test(await scope.innerText()),`${label}: missing source times never become midnight.`);
    assert(await grid.locator(`td[data-date="${expected.last}"] .tcal-session`).count()>0,`${label}: last recorded date appears in its real day cell.`);
  };
  const verifyGeometry=async(scope,view,theme,width)=>{
    const measured=await scope.evaluate(element=>({clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,rect:{left:element.getBoundingClientRect().left,right:element.getBoundingClientRect().right},grids:[...element.querySelectorAll('.tcal-grid')].map(grid=>({clientWidth:grid.clientWidth,scrollWidth:grid.scrollWidth,clientHeight:grid.clientHeight,scrollHeight:grid.scrollHeight})),sessions:[...element.querySelectorAll('.tcal-session')].map(record=>({clientWidth:record.clientWidth,scrollWidth:record.scrollWidth}))}));
    geometry.push({view,theme,width,...measured});
    assert(measured.scrollWidth<=measured.clientWidth+1,`${view} ${theme} ${width}: no horizontal content clipping.`);
    assert(measured.rect.left>=0&&measured.rect.right<=width+1,`${view} ${theme} ${width}: calendar fits viewport.`);
    assert(measured.grids.every(grid=>grid.scrollWidth<=grid.clientWidth+1&&grid.scrollHeight<=grid.clientHeight+1),`${view} ${theme} ${width}: calendar never clips or nests scrolling.`);
    assert(measured.sessions.every(record=>record.scrollWidth<=record.clientWidth+1),`${view} ${theme} ${width}: class text stays inside each record.`);
    assert(await page.locator('.fw-window').evaluate(element=>element.scrollWidth<=element.clientWidth+1),`${view} ${width}: shell fits viewport.`);
  };
  const expectedTerms={
    '2026':{monday:'2026-09-07',end:'2026-12-27',last:'2026-12-25',weeks:16,dated:23,undated:1,cancelled:2},
    '2025':{monday:'2025-09-08',end:'2025-12-28',last:'2025-12-24',weeks:16,dated:23,undated:0,cancelled:1},
    '2024':{monday:'2024-02-19',end:'2024-06-09',last:'2024-06-07',weeks:16,dated:24,undated:0,cancelled:1},
    '2022':{monday:'2022-09-05',end:'2023-01-01',last:'2022-12-27',weeks:17,dated:24,undated:0,cancelled:1},
  };
  await page.goto(`${origin}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`);await pluginHome.waitFor();await frame();
  const current=fixture.courses.find(course=>course.year==='2026');assert(current);
  for(const course of fixture.courses){
    const expected=expectedTerms[course.year];assert(expected);
    await filter(course);
    assert.equal(await overview.locator('.tcal-course-summary').count(),1,'A year and season selects one recorded offering.');
    assert.equal(await overview.locator('.tcal-relative').count(),0,'A recorded term loads dated weeks immediately.');
    assert.equal(await overview.getByRole('region',{name:'No-class days',exact:true}).locator('li').count(),0,'Source cancellations are course-specific.');
    await verifyGrid(overview,expected,`${course.year} Home`);
    await openCourseCalendar(course);await verifyGrid(courseCalendar,expected,`${course.year} Course calendar`);
    const records=recordedState.terms[course.id].recordedClasses;
    for(const record of records){
      const rendered=courseCalendar.locator(`[data-recorded-class="${record.id}"]`);
      assert.equal(await rendered.count(),1,'Every original class is represented exactly once.');
      if(record.notes)assert.equal(await rendered.locator('.tcal-recorded-note p').textContent(),record.notes,'Every recorded schedule note remains available.');
    }
    assert.equal(await courseCalendar.getByRole('button',{name:'Add class session',exact:true}).count(),0);
    assert.equal(await courseCalendar.getByRole('button',{name:'Save calendar settings',exact:true}).count(),0);
    assert.match(await courseCalendar.locator('.tcal-recorded-summary').innerText(),/Original teaching-week labels stay in the Teaching Schedule/);
    if(course.year==='2022')assert.equal(await courseCalendar.locator('.tcal-open b').filter({hasText:'Time not specified'}).count(),24);
    terms.push({year:course.year,season:course.season,...expected});
    await capture(`T7-${course.year}-${course.season.toLowerCase()}.png`);
    await verifySource(course.reference.home.source,course.reference.home.title);
    const schedule=course.sections.find(section=>/schedule/i.test(section.id)||/schedule/i.test(section.title));assert(schedule);
    if(schedule.source.trim())await verifySource(schedule.source,schedule.title);
    await selectMenu('pages','Course calendar');await verifyGrid(courseCalendar,expected,`${course.year} after source navigation`);
    await home();
  }
  checks.push('Four actual teaching terms load dated Home and Course calendars: 2026/2025/2024 have 16 continuous weeks; 2022 has 17 weeks through its final December 27 class. All weekday cells, dated class records and source cancellations remain visible.');
  checks.push('Year/season filters select the matching offering, Home summaries open its Course calendar, navigation preserves records, and all four original Home/schedule source texts remain byte-for-byte read-only.');
  await filter(current);
  const currentExpected=expectedTerms['2026'];
  for(const date of ['2026-10-02','2026-11-20']){
    const record=overview.locator(`td[data-date="${date}"] [data-recorded-class]`);
    assert.equal(await record.count(),1);assert.equal(await record.getAttribute('data-class-status'),'cancelled');assert.match(await record.innerText(),/Cancelled/);
  }
  const first=overview.locator('td[data-date="2026-09-09"] [data-recorded-class]');
  assert.equal(await first.count(),1);assert.match(await first.innerText(),/Class 01/);
  const makeup=overview.locator('td[data-date="2026-10-10"] [data-recorded-class]');
  assert.equal(await makeup.getAttribute('data-class-status'),'rescheduled');assert.match(await makeup.innerText(),/Class 07/);assert.match(await makeup.innerText(),/Time to be confirmed/);assert.match(await makeup.innerText(),/Rescheduled/);
  const pending=overview.locator('.tcal-pending-class');assert.equal(await pending.count(),1);assert.match(await pending.innerText(),/Class 05/);
  assert.equal(await overview.locator('.tcal-undated').count(),0,'Home removed the standalone undated class block.');
  assert.equal(await overview.locator('.tcal-grid .tcal-class-title').filter({hasText:'Class 05'}).count(),0,'Class 05 has no invented date.');
  await page.setViewportSize({width:1440,height:1150});await pending.scrollIntoViewIfNeeded();await frame();
  await capture('TH4-uncertainties-annotated.png',[['TH4 · First pending class opens its course','.tcal-pending-class']]);
  await pending.click();await courseCalendar.waitFor();await frame();
  const undated=courseCalendar.getByRole('region',{name:'Classes with dates to be confirmed',exact:true});
  assert.equal(await undated.locator('[data-recorded-class]').count(),1);assert.match(await undated.innerText(),/Class 05/);assert.match(await undated.innerText(),/Time to be confirmed/);
  await undated.getByText('Schedule note',{exact:true}).click();await undated.scrollIntoViewIfNeeded();await frame();
  await capture('T7-uncertainties-annotated.png',[['T7 · Full undated record and original note','.tcal-undated']]);
  await home();await filter(current);
  await makeup.locator('summary').click();await makeup.scrollIntoViewIfNeeded();await frame();
  await capture('TH4-makeup-time-unconfirmed.png',[['TH4 · 10 October makeup, time unconfirmed','td[data-date="2026-10-10"] [data-recorded-class]']]);
  await overview.locator('details[open]').evaluateAll(items=>items.forEach(item=>item.open=false));
  checks.push('2026 has 23 dated classes plus Class 05 reachable through the first pending class link and fully shown in Course calendar, starts September 9, ends December 25, retains cancellations on October 2 and November 20, and retains the October 10 makeup with unknown time. No midnight placeholder is introduced; original notes remain available.');

  // Global closures alter presentation while retaining every original record.
  const idsBefore=await overview.locator('[data-recorded-class]').evaluateAll(items=>items.map(item=>item.dataset.recordedClass).sort());
  assert.equal(await overview.getByRole('button',{name:'Add no-class day',exact:true}).count(),0,'Home has no header no-class creation button.');
  await overview.locator('td[data-date="2026-09-07"]').dblclick();
  const dialog=page.getByRole('dialog',{name:'Add no-class day',exact:true});
  assert.equal(await dialog.getByRole('textbox',{name:'Date',exact:true}).inputValue(),'20260907','Double-click pre-fills the selected calendar date.');
  await dialog.getByRole('textbox',{name:'Date',exact:true}).fill('20260909');
  await dialog.getByRole('textbox',{name:'Description (optional)',exact:true}).fill('Calendar QA override');
  await dialog.getByRole('button',{name:'Add no-class day',exact:true}).click();await frame();
  assert.equal(await overview.locator('td[data-date="2026-09-09"] .tcal-cancelled').count(),1);
  assert.deepEqual(await overview.locator('[data-recorded-class]').evaluateAll(items=>items.map(item=>item.dataset.recordedClass).sort()),idsBefore);
  await first.locator('button.tcal-open').click();await courseCalendar.waitFor();await frame();
  assert.equal(await study.getAttribute('data-course-id'),current.id);assert.equal(await courseCalendar.locator('[data-recorded-class]').count(),24);assert.equal(await page.getByRole('dialog').count(),0,'Opening a class does not accidentally open no-class editing.');
  assert.equal(await courseCalendar.locator('td[data-date="2026-09-09"] .tcal-cancelled').count(),1);
  assert.equal(await courseCalendar.locator('[data-class-status="cancelled"]').count(),2,'A user override does not mutate source cancellation statuses.');
  await home();await filter(current);
  await overview.getByRole('button',{name:'Remove no-class day 2026-09-09',exact:true}).click();await frame();
  await verifyGrid(overview,currentExpected,'2026 after no-class override removal');
  assert.deepEqual(await overview.locator('[data-recorded-class]').evaluateAll(items=>items.map(item=>item.dataset.recordedClass).sort()),idsBefore);
  checks.push('Adding/removing a Home no-class day retains all 24 original class identities; Course calendar reflects the override; removing it restores the display and preserves the two source cancellations.');

  await overview.getByRole('combobox',{name:'Season',exact:true}).selectOption('Spring');await frame();
  assert.equal(await overview.locator('.tcal-grid').count(),0);assert.match(await overview.locator('.tcal-empty').innerText(),/No courses in 2026 Spring/);
  await filter(current);
  await page.reload();await pluginHome.waitFor();await filter(current);await verifyGrid(overview,currentExpected,'2026 after reload');
  assert.deepEqual(await overview.locator('[data-recorded-class]').evaluateAll(items=>items.map(item=>item.dataset.recordedClass).sort()),idsBefore);
  checks.push('Unmatched year/season shows an honest empty view; reloading the reference story seeds the same source dates and record identities.');

  await page.setViewportSize({width:1440,height:1000});await frame();
  const homeCaptureHeight=await pluginHome.evaluate(element=>Math.ceil(element.scrollHeight+80));
  await page.setViewportSize({width:1440,height:homeCaptureHeight});await pluginHome.evaluate(element=>element.scrollTop=0);await frame();
  await capture('TH4-home-calendar-annotated.png',[['V1 / C0 · Course navigation','.fw-titlebar'],['TH3 · Year and season','.tcal-controls'],['TH4 · First pending class','.tcal-pending-class'],['TH4 · Complete Monday–Sunday calendar','.tcal-overview .tcal-grid']]);
  await openCourseCalendar(current);
  const summary=await courseCalendar.locator('.tcal-recorded-summary dl').evaluate(element=>Object.fromEntries([...element.children].map(item=>[item.querySelector('dt').textContent,item.querySelector('dd').textContent])));
  assert.equal(summary['Week 1 Monday'],'20260907');assert.equal(summary['Calendar weeks'],'16');assert.match(summary['First recorded class'],/9 Sept? 2026/);assert.match(summary['Last recorded class'],/25 Dec 2026/);
  const courseCaptureHeight=await study.locator('.teach-calendar-page').evaluate(element=>Math.ceil(element.scrollHeight+80));
  await page.setViewportSize({width:1440,height:courseCaptureHeight});await study.locator('.teach-calendar-page').evaluate(element=>element.scrollTop=0);await frame();
  await capture('T7-course-calendar-annotated.png',[['T7 · Course calendar','.teach-calendar-page'],['T7.1 · Derived dates and continuous weeks','.tcal-recorded-summary'],['T7.2 · Undated source class','.tcal-undated'],['T7.3 · Complete dated calendar','.tcal-course-calendar .tcal-grid']]);
  await courseCalendar.getByRole('button',{name:'View teaching schedule',exact:true}).click();await frame();
  const schedule=current.sections.find(section=>/schedule/i.test(section.id)||/schedule/i.test(section.title));
  await button('Source').click();assert.equal(await study.locator('.teach-reference-source').textContent(),schedule.source);await button('Preview').click();
  await selectMenu('pages','Course calendar');await home();await filter(current);
  checks.push('TH4 and T7 annotated evidence identifies the combined calendar, derived date summary and pending class link and course uncertainty. The Course calendar teaching-schedule button opens the exact original schedule.');

  for(const theme of ['light-default','dark-default']){
    await button('asMagicBrain Theme').click();await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption(theme);await button('Done').click();
    for(const width of [1440,760,600,430]){
      await page.setViewportSize({width,height:1000});await pluginHome.evaluate(element=>element.scrollTop=0);await frame();
      await verifyGrid(overview,currentExpected,`${theme} ${width} Home`);await verifyGeometry(overview,'Home',theme,width);
      await capture(`TH4-home-${theme}-${width}.png`);
      await overview.locator('td[data-date="2026-09-09"]').scrollIntoViewIfNeeded();await frame();
      await capture(`TH4-grid-${theme}-${width}.png`);
      await openCourseCalendar(current);await study.locator('.teach-calendar-page').evaluate(element=>element.scrollTop=0);await frame();
      await verifyGrid(courseCalendar,currentExpected,`${theme} ${width} Course calendar`);await verifyGeometry(courseCalendar,'Course calendar',theme,width);
      await capture(`T7-course-${theme}-${width}.png`);
      await courseCalendar.locator('td[data-date="2026-10-10"] summary').click();await courseCalendar.locator('td[data-date="2026-10-10"]').scrollIntoViewIfNeeded();await frame();
      await verifyGeometry(courseCalendar,'Expanded makeup note',theme,width);
      await capture(`T7-makeup-${theme}-${width}.png`);
      await courseCalendar.locator('details[open]').evaluateAll(items=>items.forEach(item=>item.open=false));
      await home();await filter(current);
    }
  }
  checks.push('Home and Course calendar fit 1440/760/600/430 px in light and dark. All 16 weeks and 112 weekday cells stay rendered; no grid or class has horizontal clipping or a nested calendar scrollbar, including expanded original notes.');
  assert.equal(errors.length,0);assert.equal(consoleErrors.length,0);assert.equal(externalRequests.length,0);
  assert(transportRequests.every(item=>item.method==='GET'||item.operation==='getCommitPreferences'),'No source or repository mutation was requested.');
  assert.deepEqual(await inventory(fixtureRoot),fixtureInputs,'Fixture bytes remain unchanged.');
  assert.deepEqual(await inventory(sourceRoot),sourceInputs,'Source stayed stable during qualification.');
  assert.deepEqual(await inventory(buildRoot),buildInputs,'Build stayed stable during qualification.');
  checks.push('Source/build/fixture hashes remained stable, no source mutation or external network request occurred, and browser/server consoles stayed clear.');
}catch(error){failure=error.stack??String(error);if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}
finally{
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
  const limits=['Storybook browser qualification only; no packaged native or persistent-storage acceptance.','Undated Class 05 and unknown source times remain unresolved by design.','2022 calendar uses continuous calendar weeks; original teaching-week labels remain in its schedule.'];
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify({passed:!failure,checks,failure,errors,consoleErrors,externalRequests,transportRequests,geometry,terms,captures,chromiumSandbox:true,browserVersion,story:story.id,fixtureInputs,sourceInputs,buildInputs,limits},null,2));
  const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const embedded=async(name,label)=>{try{return `<figure><img src="data:image/png;base64,${(await fs.readFile(path.join(output,name))).toString('base64')}" alt="${escape(label)}"><figcaption>${escape(name)}</figcaption></figure>`;}catch{return `<p>Screenshot unavailable: ${escape(name)}</p>`;}};
  const report=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DES5002 calendar qualification</title><style>body{font:15px/1.6 system-ui;margin:32px auto;padding:0 24px;max-width:1100px;color:#242530}h1,h2{line-height:1.2}nav{display:flex;gap:20px}img{display:block;width:100%;height:auto;border:1px solid #ddd}figure{margin:24px 0}details{padding:12px;border:1px solid #ddd;margin:8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}.failure{border-color:#c00}figcaption{color:#666;font-size:12px}</style><h1>DES5002 calendar qualification</h1><p>${failure?'Failed':'Passed'} · ${checks.length} check groups · actual built Storybook with a private local reference fixture.</p><nav><a href="#TH4">TH4 · Home calendar</a><a href="#T7">T7 · Course calendar</a><a href="#uncertainties">Uncertainties</a></nav>${failure?`<details class="failure" open><summary>Failure</summary><pre>${escape(failure)}</pre>${await embedded('failure.png','Browser at failure')}</details>`:''}<h2>Checks</h2>${checks.map((check,index)=>`<details><summary>PASS ${index+1}</summary><p>${escape(check)}</p></details>`).join('')}<h2 id="TH4">TH4 · Home calendar</h2>${await embedded('TH4-home-calendar-annotated.png','Annotated Home calendar')}<h2 id="T7">T7 · Course calendar</h2>${await embedded('T7-course-calendar-annotated.png','Annotated Course calendar')}<h2 id="uncertainties">Uncertainties</h2><ul>${limits.map(limit=>`<li>${escape(limit)}</li>`).join('')}</ul>${await embedded('TH4-uncertainties-annotated.png','Class 05 remains explicitly undated')}<p>Detailed pins, transport records and geometry are in results.json beside this report. All browser captures remain in this evidence directory.</p></html>`;
  await fs.writeFile(path.join(output,'report.html'),report);
}
if(failure){console.error(failure);process.exitCode=1;}else console.log(`${checks.length} calendar reference qualification groups passed. Evidence: ${output}`);
