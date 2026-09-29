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

// Focused Home refinements qualification against the separately supplied private fixture.
// Only metadata expectations belong in this file; original course text stays external.
const output=process.env.ASMB_HOME_REFINEMENTS_OUTPUT, fixtureRoot=process.env.ASMB_TEACH_REFERENCE_ROOT, executablePath=process.env.ASMB_BROWSER;
const courseCodeOnly=process.env.ASMB_COURSE_CODE_ONLY==='1';
assert(output&&fixtureRoot&&executablePath,'Set ASMB_HOME_REFINEMENTS_OUTPUT, ASMB_TEACH_REFERENCE_ROOT and ASMB_BROWSER.');
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
      for(const [label,selector] of items){const element=[...document.querySelectorAll(selector)].find(item=>item.getClientRects().length&&!item.closest('[hidden]'));if(!element)throw Error('Missing overlay region '+label);const r=element.getBoundingClientRect(),box=document.createElement('div');box.style.cssText=`position:fixed;box-sizing:border-box;border:2px dashed #8054ff;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;const caption=document.createElement('span');caption.textContent=label;caption.style.cssText='position:absolute;left:2px;bottom:100%;margin-bottom:3px;white-space:nowrap;background:#6435d6;color:white;font:600 11px/18px system-ui;padding:0 5px;border-radius:3px';box.append(caption);overlay.append(box);}(document.querySelector('dialog[open]')??document.body).append(overlay);
    },regions);
    try{await page.screenshot({path:path.join(output,name)});}finally{if(regions)await page.locator('#calendar-reference-qa-overlay').evaluate(element=>element.remove());}
  };
  const pluginHome=page.locator('[data-plugin-view="home"]:visible');
  const overview=pluginHome.locator('.tcal-overview');
  const newCourse=page.getByRole('dialog',{name:/^(New course|Add term)$/});
  const code=newCourse.getByRole('textbox',{name:'Course Code',exact:true}),title=newCourse.getByRole('textbox',{name:'Course Name',exact:true});
  const preview=newCourse.getByRole('region',{name:'Course folder preview',exact:true});
  const currentYear=new Date().getFullYear();
  const home=async()=>{await breadcrumb.getByRole('button',{name:'asTeach — Home',exact:true}).click();await pluginHome.waitFor();await frame();};
  const yearMenu=()=>page.getByRole('menu',{name:'Year',exact:true});
  const menuSnapshot=async()=>yearMenu().evaluate(element=>{
    const box=element.getBoundingClientRect(),top=box.top+element.clientTop,bottom=top+element.clientHeight;
    const rows=[...element.querySelectorAll('[role="menuitemradio"]')].map(item=>{const rect=item.getBoundingClientRect();return {year:item.textContent.trim(),top:rect.top,bottom:rect.bottom,focused:item===document.activeElement,checked:item.getAttribute('aria-checked')};});
    return {top,bottom,height:box.height,scrollTop:element.scrollTop,scrollHeight:element.scrollHeight,clientHeight:element.clientHeight,visible:rows.filter(row=>row.top>=top-1&&row.bottom<=bottom+1).map(row=>row.year),focused:rows.find(row=>row.focused)?.year,checked:rows.find(row=>row.checked==='true')?.year};
  });
  const selectYear=async(trigger,value)=>{await trigger.click();await yearMenu().getByRole('menuitemradio',{name:String(value),exact:true}).click();await frame();};
  const wheel=async(delta)=>{
    const menu=yearMenu(),before=await menu.evaluate(element=>element.scrollTop),box=await menu.boundingBox();assert(box);
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,delta);
    await page.waitForFunction(({before,positive})=>{const element=document.querySelector('[role="menu"][aria-label="Year"]');return element&&(positive?element.scrollTop>before:element.scrollTop<before);},{before,positive:delta>0});
    await frame();return menuSnapshot();
  };
  const verifyYear=async(trigger,label,inDialog=false)=>{
    const selected=(await trigger.innerText()).trim();await trigger.click();await yearMenu().waitFor();await frame();
    assert.deepEqual(await yearMenu().getByRole('menuitemradio').allTextContents(),Array.from({length:152},(_,index)=>String(1949+index)),'Year list is fully chronological.');
    const initial=await menuSnapshot();geometry.push({label,stage:'initial',...initial});
    assert.deepEqual(initial.visible,Array.from({length:6},(_,index)=>String(currentYear+index)),`${label}: current year is the first visible row, followed by five years.`);
    assert(initial.height>=192&&initial.height<=204);assert(initial.scrollTop>0&&initial.scrollTop+initial.clientHeight<initial.scrollHeight,'Both earlier and later years remain scrollable.');
    assert.equal(initial.checked,selected,'Opening never changes the selected year.');
    if(inDialog)assert(await yearMenu().evaluate(element=>Boolean(element.closest('dialog[open]'))),'Year popup is inside the native course dialog.');
    await capture(`${label}-year-current.png`,[[`${label} · Six visible years; earlier years above`,'.tyear-menu']]);
    const earlier=await wheel(-192);geometry.push({label,stage:'wheel-up',...earlier});assert(Number(earlier.visible[0])<currentYear,`${label}: a real upward wheel reveals earlier years.`);
    await capture(`${label}-year-earlier.png`,[[`${label} · Upward wheel reaches earlier years`,'.tyear-menu']]);
    const future=await wheel(448);geometry.push({label,stage:'wheel-down',...future});assert(Number(future.visible[0])>currentYear,`${label}: a real downward wheel reveals future years.`);
    await page.keyboard.press('Escape');await frame();assert.equal(await yearMenu().count(),0,'Escape closes the year menu.');if(inDialog)assert(await newCourse.isVisible(),'Escape closes only the year popup, leaving the native course dialog open.');assert.equal((await trigger.innerText()).trim(),selected);assert(await trigger.evaluate(element=>element===document.activeElement),'Escape restores the Year trigger focus.');
    await trigger.click();await frame();const reopened=await menuSnapshot();assert.equal(reopened.visible[0],String(currentYear),'Pointer reopen starts at current year after scrolling.');
    await wheel(-128);const previous=yearMenu().getByRole('menuitemradio',{name:String(currentYear-1),exact:true});assert(await previous.isVisible());await previous.click();await frame();assert.equal((await trigger.innerText()).trim(),String(currentYear-1));
    await trigger.click();await frame();const historical=await menuSnapshot();assert.equal(historical.visible[0],String(currentYear));assert.equal(historical.checked,String(currentYear-1));
    await page.keyboard.press('ArrowUp');await frame();assert.equal((await menuSnapshot()).focused,String(currentYear-1),'Keyboard moves naturally to the earlier adjacent year.');await page.keyboard.press('Enter');await frame();assert.equal((await trigger.innerText()).trim(),String(currentYear-1));
    await selectYear(trigger,selected);
    checks.push(`${label}: chronological 1949–2100, current-first visible six-row popup, real wheel up/down, historical selection, focus, Escape and keyboard navigation passed${inDialog?' inside a native dialog':''}.`);
  };
  const verifySubtitle=async(width,theme)=>{
    await page.setViewportSize({width,height:1000});await pluginHome.evaluate(element=>element.scrollTop=0);await frame();
    const subtitle=pluginHome.locator('.ths-title > p');assert.equal(await subtitle.innerText(),'Your teaching calendar and courses.');
    const bounds=await subtitle.evaluate(element=>{const range=document.createRange();range.selectNodeContents(element);return {lines:[...range.getClientRects()].map(rect=>({top:rect.top,left:rect.left,right:rect.right})),scrollWidth:element.scrollWidth,clientWidth:element.clientWidth,height:element.getBoundingClientRect().height};});
    geometry.push({width,theme,view:'Home subtitle',...bounds});assert.equal(new Set(bounds.lines.map(line=>Math.round(line.top))).size,1,`Home subtitle stays on one line at ${width}px.`);assert(bounds.scrollWidth<=bounds.clientWidth+1,'Subtitle is not clipped.');
    assert(await page.locator('.fw-window').evaluate(element=>element.scrollWidth<=element.clientWidth+1),'Home has no horizontal page overflow.');
    assert.equal(await pluginHome.getByText('Teacher details saved for future new courses.',{exact:true}).count(),0);
    await capture(`home-${theme}-${width}.png`);
  };
  await page.goto(`${origin}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`);await pluginHome.waitFor();await frame();
  if(!courseCodeOnly){
  for(const theme of ['light-default','dark-default']){
    await button('asMagicBrain Theme').click();await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption(theme);await button('Done').click();
    for(const width of [1440,1280,430])await verifySubtitle(width,theme);
  }
  await page.setViewportSize({width:1440,height:1000});await button('asMagicBrain Theme').click();await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption('light-default');await button('Done').click();
  checks.push('The exact Home subtitle stays on one unclipped line at 1440/1280/430px in light and dark, with no page overflow.');
  await button('Edit teacher details').click();const profile=page.getByRole('dialog',{name:'Teacher details',exact:true});
  await profile.getByRole('textbox',{name:'Given names',exact:true}).fill('Focused QA teacher');await profile.getByRole('button',{name:'Save teacher details',exact:true}).click();await frame();
  assert.equal(await profile.count(),0);assert.equal(await pluginHome.getByText('Teacher details saved for future new courses.',{exact:true}).count(),0);assert.equal(await pluginHome.locator('.ths-feedback').count(),0,'Profile save adds no transient or persistent Home notice.');
  await button('Edit teacher details').click();assert.equal(await profile.getByRole('textbox',{name:'Given names',exact:true}).inputValue(),'Focused QA teacher');await profile.getByRole('button',{name:'Cancel',exact:true}).click();
  await button('Courses — all courses').click();await home();await button('Edit teacher details').click();assert.equal(await profile.getByRole('textbox',{name:'Given names',exact:true}).inputValue(),'Focused QA teacher');await profile.getByRole('button',{name:'Cancel',exact:true}).click();
  await capture('home-refinements-annotated.png',[['TH1 · One-line subtitle','.ths-title'],['TH1.1 · Inline office details','.ths-office-details'],['TH3 · Scrollable year selection','.tcal-controls']]);
  checks.push('Teacher profile Save retains the updated data through reopening and navigation without the removed Home success notice.');
  await verifyYear(overview.getByRole('button',{name:'Year',exact:true}),'TH3');
  }
  await button('Create a new course').click();await newCourse.waitFor();
  if(!courseCodeOnly)await verifyYear(newCourse.getByRole('button',{name:'Year',exact:true}),'C4',true);
  const season=newCourse.getByRole('combobox',{name:'Season',exact:true});
  const submit=newCourse.locator('button[type="submit"]');
  const backToCourses=async()=>{await breadcrumb.getByRole('button',{name:'Courses — all courses',exact:true}).click();await page.getByRole('heading',{name:'Courses',exact:true}).waitFor();await frame();};
  const assertSlashTerm=async(year,term)=>{
    assert(await breadcrumb.getByRole('button',{name:'Courses — all courses',exact:true}).isVisible(),'The Courses catalog remains a stable breadcrumb destination.');
    assert(await breadcrumb.getByRole('button',{name:'ROB7103/8103 — open course',exact:true}).isVisible(),'Created course keeps its display code in direct course navigation.');
    assert(await breadcrumb.getByRole('button',{name:`${year} ${term} — open ROB7103/8103 Instructor page`,exact:true}).isVisible(),'Term navigation retains the slash display identity.');
    assert.equal(await study.getAttribute('data-read-only'),null);
    assert(await study.getByRole('heading',{name:'ROB7103/8103 · Robot studio',exact:true}).isVisible());
  };
  await title.fill('Robot studio');await code.pressSequentially('ROB7103');await code.pressSequentially('/');
  assert.equal(await code.inputValue(),'ROB7103/','Typing a slash preserves it immediately in the visible field.');
  assert.match(await preview.innerText(),/ROB7103__asTeach/,'Even a partial typed code has a separator-safe proposed folder.');
  await code.pressSequentially('8103');assert.equal(await code.inputValue(),'ROB7103/8103');
  assert.match(await preview.innerText(),/ROB7103_8103_asTeach/);assert(!(await preview.innerText()).includes('ROB7103/8103'),'Only the repository folder replaces slashes.');
  await season.selectOption('Autumn');await frame();
  await capture('course-code-display-annotated.png',[
    ['C4.1 · Course code keeps its slash','input[name="code"]'],
    ['C4.4 · Repository folder uses an underscore','.tcs-storage-preview']
  ]);
  checks.push('Typing preserves ROB7103/8103 in the Course Code field at every step; only Proposed teacher repository becomes ROB7103_8103_asTeach.');
  await newCourse.getByRole('button',{name:'Create course',exact:true}).click();await study.waitFor();await frame();await assertSlashTerm(currentYear,'Autumn');
  if(!courseCodeOnly){await selectMenu('pages','Instructor page');assert.match(await study.locator('.teach-reading').innerText(),/Focused QA teacher/,'Silent profile save still initializes a newly created course.');}
  await backToCourses();assert(await button('Open course ROB7103/8103').isVisible());
  const slashGroup=page.getByRole('article',{name:'ROB7103/8103',exact:true});
  assert.equal(await slashGroup.locator('.tcs-code').innerText(),'ROB7103/8103');assert.match(await slashGroup.innerText(),/Source: ROB7103_8103_asTeach/);
  assert.equal(await button('Open course ROB7103_8103').count(),0);assert.equal(await page.locator('.tcs-row').count(),2);
  await capture('created-slash-course.png');
  checks.push('Creation retains ROB7103/8103 in the course group and breadcrumb, with a separate ROB7103_8103_asTeach source folder and one independent synthetic group.');
  await button('Create a new course').click();await newCourse.waitFor();
  await browser.grantPermissions(['clipboard-read','clipboard-write'],{origin});
  await code.evaluate(element=>{window.refinementPaste=false;element.addEventListener('paste',()=>{window.refinementPaste=true;},{once:true});});
  await page.evaluate(async()=>navigator.clipboard.writeText('rob7103/8103'));await code.focus();await page.keyboard.press(process.platform==='darwin'?'Meta+V':'Control+V');await frame();
  assert(await page.evaluate(()=>window.refinementPaste),'The input was exercised by an actual paste event.');
  assert.equal(await code.inputValue(),'rob7103/8103','Paste preserves the supplied casing and slash in the input.');
  assert.equal(await title.inputValue(),'Robot studio','Existing-course lookup matches the same display code case-insensitively.');assert(await title.getAttribute('readonly')!==null);assert.match(await preview.innerText(),/ROB7103_8103_asTeach/);
  await season.selectOption('Autumn');await submit.click();assert.match(await newCourse.getByRole('alert').innerText(),/already has that year and season/);assert.equal(await newCourse.count(),1);
  checks.push('Actual clipboard paste preserves rob7103/8103 visibly, finds the original slash-coded course case-insensitively, and rejects its duplicate year/season.');
  await selectYear(newCourse.getByRole('button',{name:'Year',exact:true}),currentYear+1);await season.selectOption('Spring');
  await newCourse.getByRole('button',{name:'Create term',exact:true}).click();await study.waitFor();await frame();await assertSlashTerm(currentYear+1,'Spring');
  await backToCourses();assert.equal(await page.locator('.tcs-row').count(),2);assert.match(await slashGroup.innerText(),/2 terms/);
  assert.equal(await slashGroup.locator('.tcs-code').innerText(),'ROB7103/8103');assert.match(await slashGroup.innerText(),/Source: ROB7103_8103_asTeach/);
  await button('Open course ROB7103/8103').click();await study.waitFor();await frame();await assertSlashTerm(currentYear+1,'Spring');
  assert.equal(await page.locator('[data-plugin-view="courses"]:visible').count(),0,'Opening the course goes directly to its latest Instructor page without a Terms landing.');
  const slashTerms=await openMenu('terms');
  assert.equal(await slashTerms.menu.getByRole('menuitem').count(),3,'The selector contains both terms and Add term.');
  for(const [year,term] of [[currentYear,'Autumn'],[currentYear+1,'Spring']])assert(await slashTerms.menu.getByRole('menuitem',{name:`${year} ${term}`,exact:true}).isVisible());
  assert(await slashTerms.menu.getByRole('menuitem',{name:'Add term',exact:true}).isVisible());await dismiss(slashTerms);
  for(const [year,term] of [[currentYear,'Autumn'],[currentYear+1,'Spring']]){await selectMenu('terms',`${year} ${term}`);await selectMenu('pages','Instructor page');await assertSlashTerm(year,term);}
  checks.push('Repeated entry of the slash display code adds a new term to the original group; direct course opening selects the latest Instructor page, both term choices retain the slash identity, and the group keeps its shared safe repository.');
  await selectMenu('terms','Add term');await newCourse.waitFor();assert.equal(await newCourse.getAttribute('aria-label'),'Add term');
  assert.equal(await code.inputValue(),'ROB7103/8103');assert(await code.getAttribute('readonly')!==null);assert.equal(await title.inputValue(),'Robot studio');assert.match(await preview.innerText(),/ROB7103_8103_asTeach/);
  await code.focus();await code.press('X');assert.equal(await code.inputValue(),'ROB7103/8103','Add term cannot change the display identity.');
  await selectYear(newCourse.getByRole('button',{name:'Year',exact:true}),currentYear+2);await season.selectOption('Summer');
  await newCourse.getByRole('button',{name:'Create term',exact:true}).click();await study.waitFor();await frame();await assertSlashTerm(currentYear+2,'Summer');
  await backToCourses();assert.match(await slashGroup.innerText(),/3 terms/);assert.equal(await page.locator('.tcs-row').count(),2);
  checks.push('Course-scoped Add term preserves the read-only ROB7103/8103 identity and safe repository; the third term remains in the same course group.');
  await button('Create a new course').click();await newCourse.waitFor();await code.fill('ROB7103_8103');await title.fill('Conflicting underscore identity');await season.selectOption('Winter');
  assert.equal(await code.inputValue(),'ROB7103_8103');assert.equal(await title.getAttribute('readonly'),null,'An underscore code is a different display identity, never an alias of the slash course.');assert.match(await preview.innerText(),/ROB7103_8103_asTeach/);
  await submit.click();assert.match(await newCourse.getByRole('alert').innerText(),/repository belongs to a different course code/i);assert.equal(await code.getAttribute('aria-invalid'),'true');
  await capture('slash-underscore-collision.png');await newCourse.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.locator('.tcs-row').count(),2);assert.match(await slashGroup.innerText(),/3 terms/);
  checks.push('An underscore display code that would reuse the slash course repository is rejected at Course Code; it creates no group or term and never aliases the existing course.');
  await button('Create a new course').click();await code.fill('QA_REVERSE');await title.fill('Reverse collision fixture');await season.selectOption('Winter');await submit.click();await study.waitFor();await frame();await backToCourses();
  assert(await button('Open course QA_REVERSE').isVisible());assert.equal(await page.locator('.tcs-row').count(),3);
  await button('Create a new course').click();await code.fill('QA/REVERSE');await title.fill('Conflicting slash identity');await season.selectOption('Spring');
  assert.equal(await code.inputValue(),'QA/REVERSE');assert.equal(await title.getAttribute('readonly'),null);assert.match(await preview.innerText(),/QA_REVERSE_asTeach/);
  await submit.click();assert.match(await newCourse.getByRole('alert').innerText(),/repository belongs to a different course code/i);await newCourse.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.locator('.tcs-row').count(),3);assert.equal(await button('Open course QA/REVERSE').count(),0);
  checks.push('The reverse collision is also rejected: QA/REVERSE cannot reuse the folder belonging to the existing QA_REVERSE display code.');
  await button('Create a new course').click();await code.fill('DES5002');await season.selectOption('Winter');await submit.click();assert.match(await newCourse.getByRole('alert').innerText(),/read.only/i);
  await code.fill('Workspace');await submit.click();assert.match(await newCourse.getByRole('alert').innerText(),/already used/i);
  for(const invalidCode of ['../unsafe','bad\\code','bad code']){await code.fill(invalidCode);assert.equal(await code.inputValue(),invalidCode);await submit.click();assert.match(await newCourse.getByRole('alert').innerText(),/course code/i);}
  await newCourse.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.locator('.tcs-row').count(),3);
  checks.push('Read-only reference extension, reserved repository names and invalid path-like codes remain rejected while their visible input is preserved.');
  await button('Open course DES5002').click();await study.waitFor();await frame();
  const referenceTerms=await openMenu('terms');assert.equal(await referenceTerms.menu.getByRole('menuitem').count(),4,'Reference keeps all four original terms in its selector.');
  for(const term of fixture.courses)assert(await referenceTerms.menu.getByRole('menuitem',{name:`${term.year} ${term.season}`,exact:true}).isVisible());
  assert.equal(await referenceTerms.menu.getByRole('menuitem',{name:'Add term',exact:true}).count(),0,'Read-only reference terms cannot be extended from navigation.');await dismiss(referenceTerms);
  const current=fixture.courses.find(course=>course.year==='2026');await selectMenu('terms',`${current.year} ${current.season}`);await selectMenu('pages','Instructor page');await button('Source').click();assert.equal(await study.locator('.teach-reference-source').textContent(),createTeachInstructorDocument(current).source);await button('Preview').click();
  assert.equal(errors.length,0);assert.equal(consoleErrors.length,0);assert.equal(externalRequests.length,0);
  assert(transportRequests.every(item=>item.method==='GET'||item.operation==='getCommitPreferences'),'Focused checks request no source/repository write.');
  assert.deepEqual(await inventory(fixtureRoot),fixtureInputs);assert.deepEqual(await inventory(sourceRoot),sourceInputs);assert.deepEqual(await inventory(buildRoot),buildInputs);
  checks.push('Original reference Home source, all fixture bytes and source/static-build pins remain unchanged; no unexpected runtime, console, external-network or content-write request occurred.');
}catch(error){failure=error.stack??String(error);if(page)failureContext=await page.evaluate(()=>({activeElement:document.activeElement?.outerHTML,openDialog:document.querySelector('dialog[open]')?.getAttribute('aria-label'),yearMenu:document.querySelector('[role="menu"][aria-label="Year"]')?.outerHTML.slice(0,1000)})).catch(()=>null);if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}
finally{
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify({passed:!failure,mode:courseCodeOnly?'course-code-display':'home-refinements',checks,failure,failureContext,errors,consoleErrors,externalRequests,transportRequests,geometry,captures,chromiumSandbox:true,browserVersion,story:story.id,fixtureInputs,sourceInputs,buildInputs,limits:['Focused changed-boundary Storybook checks only; unrelated planner/reference suites were not rerun.','No packaged native or persistent-storage acceptance.']},null,2));
}
if(failure){console.error(failure);process.exitCode=1;}else console.log(`${checks.length} focused ${courseCodeOnly?'course-code display':'Home refinement'} groups passed. Evidence: ${output}`);
