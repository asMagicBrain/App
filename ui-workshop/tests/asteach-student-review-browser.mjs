import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import MarkdownIt from 'markdown-it';
import {chromium} from '../../tools/playwright.mjs';
import {testRoot} from '../../tools/development-paths.mjs';
import {staticHandler, createTeachReferenceHandler, teachReferencePrefix} from '../.storybook/static-server.mjs';

// Focused continuous instructor document and reviewed Student-copy qualification.
// Only metadata expectations belong in this file; original course text stays external.
const output=process.env.ASMB_STUDENT_REVIEW_OUTPUT, fixtureRoot=process.env.ASMB_TEACH_REFERENCE_ROOT, executablePath=process.env.ASMB_BROWSER;
assert(output&&fixtureRoot&&executablePath,'Set ASMB_STUDENT_REVIEW_OUTPUT, ASMB_TEACH_REFERENCE_ROOT and ASMB_BROWSER.');
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
const referenceHeadingParser=new MarkdownIt({html:false});
const headingText=tokens=>tokens.map(token=>token.children?headingText(token.children):['text','code_inline','image'].includes(token.type)?token.content:['softbreak','hardbreak'].includes(token.type)?' ':'').join('').replace(/\s+/gu,' ').trim();
const originalHeadings=source=>{const tokens=referenceHeadingParser.parse(source.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m,''),{});return tokens.flatMap((token,index)=>token.type==='heading_open'?[headingText(tokens[index+1]?.children??[])]:[]);};
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
const checks=[], stepResults=[], failures=[], errors=[], externalRequests=[], transportRequests=[], consoleErrors=[], geometry=[], captures=[];
let browser,page,server,browserVersion,referenceMode='live';
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
      const overlay=document.createElement('div');overlay.id='student-review-qa-overlay';overlay.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      for(const [label,selector] of items){const element=[...document.querySelectorAll(selector)].find(item=>item.getClientRects().length&&!item.closest('[hidden]'));if(!element)throw Error('Missing overlay region '+label);const r=element.getBoundingClientRect(),box=document.createElement('div');box.style.cssText=`position:fixed;box-sizing:border-box;border:2px dashed #8054ff;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;const caption=document.createElement('span');caption.textContent=label;caption.style.cssText='position:absolute;left:2px;top:100%;margin-top:4px;white-space:nowrap;background:#6435d6;color:white;font:600 11px/18px system-ui;padding:0 5px;border-radius:3px';box.append(caption);overlay.append(box);}(document.querySelector('dialog[open]')??document.body).append(overlay);
    },regions);
    try{await page.screenshot({path:path.join(output,name)});}finally{if(regions)await page.locator('#student-review-qa-overlay').evaluate(element=>element.remove());}
  };
  const pluginHome=page.locator('[data-plugin-view="home"]:visible');
  const catalog=page.locator('[data-plugin-view="courses"]:visible');
  const courses=async()=>{await breadcrumb.getByRole('button',{name:'Courses — all courses',exact:true}).click();await catalog.waitFor();await frame();};
  const assertTerm=async id=>{await study.waitFor();await frame();assert.equal(await study.getAttribute('data-course-id'),id);};
  const theme=async value=>{await button('asMagicBrain Theme').click();await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption(value);await button('Done').click();await frame();};
  const noLegacyControls=async()=>{
    assert.equal(await study.locator('.teach-home-edit,.teach-section-edit').count(),0,'No per-section edit controls remain.');
    assert.equal(await study.getByRole('button',{name:/^Edit (?:Course|Teaching|Learning|Content|Assumed|Co-Requisite|Grading|Academic|University|Recommended|Important)/}).count(),0);
    assert.equal(await study.locator('.teach-section-number').count(),0,'The old numbered section navigation is absent.');
  };
  const checkBounds=async(locator,label)=>{
    const box=await locator.boundingBox(),size=page.viewportSize();assert(box);geometry.push({label,viewport:size,...box});
    assert(box.x>=-1&&box.y>=-1&&box.x+box.width<=size.width+1&&box.y+box.height<=size.height+1,`${label} fits the viewport.`);
    assert(await page.locator('.fw-window').evaluate(element=>element.scrollWidth<=element.clientWidth+1),'No horizontal page overflow.');
  };
  const editor=study.locator('.teach-source .cm-content');
  const instructor=async()=>{await selectMenu('pages','Instructor page');await study.locator('[aria-label="Instructor page mode"]').getByRole('button',{name:'Edit',exact:true}).click();await editor.waitFor();await frame();};
  const student=async()=>{await selectMenu('pages','Student page');await study.locator('.teach-student-page').waitFor();await frame();};
  const editionSource=async()=>{
    const modes=study.locator('[aria-label="Student page mode"]');
    await modes.getByRole('button',{name:'Source',exact:true}).click();const source=await study.locator('[aria-label="Student version source"]').textContent();
    await modes.getByRole('button',{name:'Preview',exact:true}).click();await frame();return source;
  };
  const review=page.getByRole('dialog',{name:'Review student copy',exact:true});
  const reviewPreview=review.locator('[aria-label="Student copy review preview"]');
  const openReview=async(update=false)=>{const trigger=button(update?'Review update':'Review student copy');await trigger.click();await review.waitFor();await frame();return trigger;};
  const cancelReview=async()=>{await review.getByRole('button',{name:'Cancel review',exact:true}).click();await review.waitFor({state:'detached'});await frame();};
  const exactSource=(actual,expected,message)=>assert.equal(sha256(actual??''),sha256(expected),message);
  const runGroup=async(id,body)=>{
    try{await body();stepResults.push({id,status:'PASS'});console.log(`STEP_PASS|${id}|${checks.at(-1)??'Deterministic browser assertions passed.'}`);}
    catch(error){const screenshot=`failure-${id}.png`;await page.screenshot({path:path.join(output,screenshot)}).catch(()=>{});const failure={id,error:error.stack??String(error),screenshot};failures.push(failure);stepResults.push({id,status:'FAIL',screenshot});console.error(`STEP_FAIL|${id}|${error.message}|${path.join(output,screenshot)}`);}
  };
  const genericStory=Object.values(index.entries).find(item=>item.name==='asTeach — Courses and workspace');assert(genericStory);
  const loadGeneric=async()=>{await page.goto(`${origin}/iframe.html?id=${encodeURIComponent(genericStory.id)}&viewMode=story`);await pluginHome.waitFor();await courses();await button('Open course DES101').click();await study.waitFor();await frame();};
  const base='# Course Description\n\nQA saved description revised across the complete document.\n\n# Teaching Goals\n\nQA saved goals revised in the same edit.\n\n# Co-Requisite Courses\n\nNone\n\n# Important Deadlines\n\n';
  const updated=base.replace('QA saved description','QA updated description');
  const draftMarker='QA unpublished instructor draft';
  const prepareSaved=async()=>{await loadGeneric();await study.locator('[aria-label="Instructor page mode"]').getByRole('button',{name:'Edit',exact:true}).click();await editor.fill(base);await button('Save').click();await frame();};
  const appendDraft=async()=>{await editor.press(process.platform==='darwin'?'Meta+End':'Control+End');await editor.press('End');await editor.press('Enter');await page.keyboard.insertText(draftMarker);await frame();return editor.innerText();};
  const markers=[['T1 · Course and page navigation','.pws-breadcrumb'],['T3 · One document action bar','.teach-toolbar'],['T4 · Complete instructor document','.teach-source'],['T5 · Document outline','.teach-outline']];

  await runGroup('continuous-document-save-cancel-preview',async()=>{
    await prepareSaved();await noLegacyControls();if(!await study.locator('.teach-outline').isVisible())await button('Toggle document outline').click();
    assert.equal(await study.locator('.teach-source .cm-editor').count(),1,'Only one CodeMirror editor handles the instructor document.');
    assert.equal(await study.getByRole('button',{name:'Save',exact:true}).count(),1);assert.equal(await study.getByRole('button',{name:'Cancel',exact:true}).count(),1);
    assert.match(await editor.innerText(),/QA saved description/);assert.match(await editor.innerText(),/QA saved goals/);
    const saved=await editor.innerText();await appendDraft();
    await study.locator('[aria-label="Instructor page mode"]').getByRole('button',{name:'Preview',exact:true}).click();await frame();
    const reading=study.locator('.teach-reading:visible');assert.match(await reading.innerText(),/QA saved description/);assert.match(await reading.innerText(),/QA saved goals/);assert(!(await reading.innerText()).includes(draftMarker),'Instructor Preview uses only saved text.');
    await capture('instructor-continuous-preview-annotated.png',markers.map(([label,selector])=>[label,selector==='.teach-source'?'.teach-reading':selector]));
    await study.locator('[aria-label="Instructor page mode"]').getByRole('button',{name:'Edit',exact:true}).click();assert((await editor.innerText()).includes(draftMarker));
    await capture('instructor-continuous-editor-annotated.png',markers);
    await button('Cancel').click();await frame();assert.equal(await editor.innerText(),saved,'One Cancel restores the complete saved document.');
    const {menu,trigger}=await openMenu('pages');for(const name of ['Instructor page','Student page','Course calendar'])assert(await menu.getByRole('menuitem',{name,exact:true}).isVisible());assert.equal(await menu.getByRole('menuitem',{name:'Course Description',exact:true}).count(),0);await dismiss({menu,trigger});
    checks.push('One CodeMirror edit changes Course Description and Teaching Goals together; one Save/Cancel controls the document, saved-only Preview excludes draft text, and the page menu contains the three page destinations without former section controls.');
  });

  await runGroup('draft-undo-navigation',async()=>{
    await prepareSaved();const currentId=await study.getAttribute('data-course-id'),saved=await editor.innerText(),draft=await appendDraft();
    for(const pageName of ['Student page','Course calendar']){
      await selectMenu('pages',pageName);await instructor();assert.equal(await editor.innerText(),draft,`${pageName} retains the instructor draft.`);
    }
    await selectMenu('terms','Add term');const add=page.getByRole('dialog',{name:'Add term',exact:true});await add.waitFor();
    await add.getByRole('button',{name:'Year',exact:true}).click();await page.getByRole('menu',{name:'Year',exact:true}).getByRole('menuitemradio',{name:'2024',exact:true}).click();await add.getByRole('combobox',{name:'Season',exact:true}).selectOption('Spring');await add.getByRole('button',{name:'Create term',exact:true}).click();await frame();assert.notEqual(await study.getAttribute('data-course-id'),currentId);
    await selectMenu('terms','2026 Autumn');await assertTerm(currentId);await instructor();assert.equal(await editor.innerText(),draft,'A different term retains the current instructor draft.');
    await courses();await button('Open course DES101').click();await assertTerm(currentId);await instructor();assert.equal(await editor.innerText(),draft,'Full catalog round trip retains the draft.');
    const undo=process.platform==='darwin'?'Meta+z':'Control+z',redo=process.platform==='darwin'?'Meta+Shift+z':'Control+Shift+z';
    await editor.press(undo);assert(!(await editor.innerText()).includes(draftMarker),'Undo history survives Student/calendar/term/catalog navigation.');await editor.press(redo);assert.equal(await editor.innerText(),draft);
    await button('Cancel').click();assert.equal(await editor.innerText(),saved);
    checks.push('Draft and CodeMirror undo/redo survive Student page, Course calendar, another term, and the full Courses catalog; Cancel still restores the saved full document.');
  });

  await runGroup('student-positive-review-and-stable-edition',async()=>{
    await prepareSaved();const firstId=await study.getAttribute('data-course-id');await appendDraft();await student();const unreviewed=await study.locator('.teach-reading:visible').innerText();assert(unreviewed.includes('QA saved description'));assert(!unreviewed.includes(draftMarker),'Student preview excludes the unpublished Instructor draft.');assert(unreviewed.includes('None'));assert(!unreviewed.includes('Important Deadlines'),'Student preview omits a blank-body section.');
    for(const name of ['Export','GitHub','GitBook'])assert(await study.getByRole('button',{name,exact:true}).isDisabled(),'Student output actions are unavailable.');const trigger=await openReview();assert(await review.evaluate(element=>element.contains(document.activeElement)),'Review opens with focus inside the dialog.');
    assert(!(await reviewPreview.innerText()).includes(draftMarker));assert.equal(await review.getByRole('checkbox',{checked:true}).count(),0,'Every candidate starts unselected.');assert(await review.getByRole('button',{name:'Create student version',exact:true}).isDisabled());await review.getByRole('checkbox',{name:'Course Description',exact:true}).check();await review.getByRole('checkbox',{name:'Co-Requisite Courses',exact:true}).check();assert.match(await reviewPreview.innerText(),/QA saved description/);assert.match(await reviewPreview.innerText(),/None/);
    assert.equal(await review.getByRole('checkbox',{name:'Important Deadlines',exact:true}).count(),0,'A heading with a blank body is omitted from student selection.');
    const goals=review.getByRole('checkbox',{name:'Teaching Goals',exact:true});await goals.check();assert((await reviewPreview.innerText()).includes('QA saved goals'));await goals.uncheck();await frame();assert(!(await reviewPreview.innerText()).includes('QA saved goals'));
    assert(await review.getByRole('checkbox',{name:'Co-Requisite Courses',exact:true}).isChecked(),'The explicit None body remains eligible.');
    await review.locator('summary').filter({hasText:'Review selected source'}).click();const reviewedSource=await review.locator('[aria-label="Selected student source"]').textContent();assert(reviewedSource.includes('None'));assert(!reviewedSource.includes(draftMarker));assert(!reviewedSource.includes('QA saved goals'));assert(!reviewedSource.includes('Important Deadlines'));await review.locator('summary').filter({hasText:'Review selected source'}).click();
    await capture('student-review-annotated.png',[['T9 · Review selected saved content','dialog[open]'],['T9 · Student copy preview','[aria-label="Student copy review preview"]']]);
    await review.getByRole('button',{name:'Create student version',exact:true}).click();await review.waitFor({state:'detached'});await frame();
    const firstEdition=await editionSource();exactSource(firstEdition,reviewedSource,'Created Student version exactly matches the selected source reviewed before approval.');assert(firstEdition.includes('QA saved description'));assert(!firstEdition.includes('QA saved goals'));assert(!firstEdition.includes(draftMarker));assert(firstEdition.includes('None'));assert(!firstEdition.includes('Important Deadlines'));
    await capture('student-page-annotated.png',[['T1 · Student destination','.pws-breadcrumb'],['T8 · Reviewed Student version','.teach-student-page']]);
    await instructor();assert((await editor.innerText()).includes(draftMarker));await editor.fill(updated);await button('Save').click();await student();exactSource(await editionSource(),firstEdition,'Saving the instructor document cannot silently replace a student edition.');
    await openReview(true);assert.equal(await review.getByRole('checkbox',{checked:true}).count(),0);await review.getByRole('checkbox',{name:'Course Description',exact:true}).check();assert((await reviewPreview.innerText()).includes('QA updated description'));await review.getByRole('checkbox',{name:'Teaching Goals',exact:true}).check();await capture('student-review-update-annotated.png',[['T9 · Current and proposed Student versions','dialog[open]'],['T9 · Proposed Student copy','[aria-label="Student copy review preview"]']]);await cancelReview();exactSource(await editionSource(),firstEdition,'Cancel review preserves the prior exact student edition.');
    const reviewTrigger=await openReview(true);await page.keyboard.press('Escape');await review.waitFor({state:'detached'});await frame();assert(await reviewTrigger.evaluate(element=>element===document.activeElement),'Escape restores review action focus.');exactSource(await editionSource(),firstEdition,'Escape cannot update the edition.');
    await openReview(true);await review.getByRole('checkbox',{name:'Course Description',exact:true}).check();await review.getByRole('checkbox',{name:'Co-Requisite Courses',exact:true}).check();await review.getByRole('button',{name:'Update student version',exact:true}).click();await review.waitFor({state:'detached'});await frame();const secondEdition=await editionSource();assert(secondEdition.includes('QA updated description'));assert.notEqual(secondEdition,firstEdition);await study.getByRole('combobox',{name:'Student version',exact:true}).selectOption('1');exactSource(await editionSource(),firstEdition,'An earlier version remains exactly readable after a reviewed update.');await study.getByRole('combobox',{name:'Student version',exact:true}).selectOption('2');exactSource(await editionSource(),secondEdition,'Latest reviewed version remains distinct.');
    await selectMenu('terms','Add term');const add=page.getByRole('dialog',{name:'Add term',exact:true});await add.waitFor();await add.getByRole('button',{name:'Year',exact:true}).click();await page.getByRole('menu',{name:'Year',exact:true}).getByRole('menuitemradio',{name:'2024',exact:true}).click();await add.getByRole('combobox',{name:'Season',exact:true}).selectOption('Spring');await add.getByRole('button',{name:'Create term',exact:true}).click();await frame();const historicalId=await study.getAttribute('data-course-id');assert.notEqual(historicalId,firstId);
    await instructor();await editor.fill('# Course Description\n\nQA historical student body.\n');await button('Save').click();await student();await openReview();await review.getByRole('checkbox',{name:'Course Description',exact:true}).check();await review.getByRole('button',{name:'Create student version',exact:true}).click();await review.waitFor({state:'detached'});const historicalEdition=await editionSource();assert(historicalEdition.includes('QA historical student body'));assert(!historicalEdition.includes('QA updated description'));
    await selectMenu('terms','2026 Autumn');await student();exactSource(await editionSource(),secondEdition,'Current term edition is independent of the historical term.');await selectMenu('terms','2024 Spring');await student();exactSource(await editionSource(),historicalEdition,'Historical edition remains independent.');
    checks.push('Student review takes only saved populated sections, retains explicit None, supports deselection and positive Create, preserves the exact old edition after instructor Save or cancelled review, and updates only on explicit approval; each term has an independent edition.');
  });

  await runGroup('review-keyboard-compact-dark',async()=>{
    await prepareSaved();await student();
    for(const scheme of ['light-default','dark-default']){
      await theme(scheme);await page.setViewportSize({width:430,height:900});await frame();
      let state=await openMenu('pages');await checkBounds(state.menu,`Compact ${scheme} page menu`);for(const name of ['Instructor page','Student page','Course calendar'])assert(await state.menu.getByRole('menuitem',{name,exact:true}).isVisible());await dismiss(state);
      const trigger=button('Review student copy');await trigger.focus();await page.keyboard.press('Enter');await review.waitFor();await frame();await checkBounds(review,`Compact ${scheme} review dialog`);
      assert(await review.evaluate(element=>element.contains(document.activeElement)));for(let index=0;index<18;index++){await page.keyboard.press('Tab');assert(await review.evaluate(element=>element.contains(document.activeElement)),'Keyboard focus stays in the modal.');}
      await page.keyboard.press('Shift+Tab');assert(await review.evaluate(element=>element.contains(document.activeElement)));await capture(`student-review-compact-${scheme}.png`);
      await page.keyboard.press('Escape');await review.waitFor({state:'detached'});await frame();assert(await trigger.evaluate(element=>element===document.activeElement));await capture(`student-page-compact-${scheme}.png`);
    }
    await page.setViewportSize({width:1440,height:1000});await theme('light-default');
    checks.push('At 430 px in light and dark, page menus and review dialogs fit; Enter opens review, Tab/Shift+Tab remain inside, and Escape cancels with focus restored.');
  });

  await runGroup('four-reference-terms-original-content-assets',async()=>{
    await page.setViewportSize({width:1440,height:1000});await page.goto(`${origin}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`);await pluginHome.waitFor();await courses();assert.equal(await catalog.locator('.tcs-row').count(),1);await button('Open course DES5002').click();await study.waitFor();await frame();
    let decodedImages=0,preservedPages=0,extraHeadings=0;
    for(const course of fixture.courses){
      await selectMenu('terms',`${course.year} ${course.season}`);await assertTerm(course.id);await selectMenu('pages','Instructor page');await noLegacyControls();
      assert.equal(await study.locator('[contenteditable="true"]:visible').count(),0);for(const name of ['Edit','Save','Cancel'])assert.equal(await study.getByRole('button',{name,exact:true}).count(),0,`Reference has no ${name} action.`);
      const source=async expected=>{await study.locator('[aria-label="Reference mode"]').getByRole('button',{name:'Source',exact:true}).click();const text=await study.locator('.teach-reference-source').textContent();exactSource(text,expected,'Original reference source remains byte-for-byte readable.');await study.locator('[aria-label="Reference mode"]').getByRole('button',{name:'Preview',exact:true}).click();await frame();};
      if(course.reference.home.kind==='composed'){
        await study.locator('[aria-label="Reference mode"]').getByRole('button',{name:'Source',exact:true}).click();const originals=study.locator('.teach-original-sources');await originals.locator('summary').click();
        exactSource(await originals.locator('[aria-label="Original Instructor reference source"]').textContent(),course.reference.home.source,'Composed home retains exact original source.');
        for(const section of course.sections)exactSource(await originals.getByLabel(`${section.title} original source`,{exact:true}).textContent(),section.source,'Every composed include retains exact original bytes.');
        await study.locator('[aria-label="Reference mode"]').getByRole('button',{name:'Preview',exact:true}).click();await frame();
        if(!await study.locator('.teach-outline').isVisible())await button('Toggle document outline').click();
        await study.locator('.teach-reading:visible').evaluate(element=>{element.scrollTop=0;});await frame();
        await capture('reference-instructor-continuous-annotated.png',[['T1 · Course and page navigation','.pws-breadcrumb'],['T3 · Read-only reference mode','.teach-toolbar'],['T4 · Continuous Instructor page','.teach-reading'],['T5 · Document outline','.teach-outline']]);
      }else await source(course.reference.home.source);
      const standardTitles=new Set(course.sections.map(section=>section.title.trim().toLowerCase()));const extra=originalHeadings(course.reference.home.source).filter(title=>title&&!standardTitles.has(title.toLowerCase())&&title!==course.title&&title!==course.code);
      for(const title of extra){assert(await study.getByRole('heading',{name:title,exact:true}).count()>0,`Original extra heading remains visible (${course.id}; heading sha256 ${sha256(title)}).`);extraHeadings++;}
      const state=await openMenu('pages');for(const name of ['Instructor page','Student page','Course calendar',...course.reference.pages.map(item=>item.title)])assert(await state.menu.getByRole('menuitem',{name,exact:true}).isVisible());await dismiss(state);
      for(const preserved of course.reference.pages){await selectMenu('pages',preserved.title);await source(preserved.source);preservedPages++;}await selectMenu('pages','Instructor page');
      const images=study.locator('img.teach-reference-image');for(let index=0;index<await images.count();index++){const img=images.nth(index);await img.scrollIntoViewIfNeeded();await img.evaluate(image=>image.decode());assert(await img.evaluate(image=>image.complete&&image.naturalWidth>0&&new URL(image.src).origin===location.origin));decodedImages++;}
      await capture(`reference-instructor-${course.year}-${course.season.toLowerCase()}.png`);
    }
    assert(extraHeadings>0,'Private reference includes preserved extra original headings.');assert(preservedPages>0);assert(decodedImages>0,'Mapped local reference image loads.');
    checks.push(`All four reference terms retain exact original source and preserved page bytes, ${extraHeadings} original extra headings, and ${decodedImages} mapped same-origin images; instructor surfaces remain read-only and preserved references stay in the page menu.`);
  });

  await runGroup('transport-and-input-integrity',async()=>{
    assert.equal(errors.length,0);assert.equal(consoleErrors.length,0);assert.equal(externalRequests.length,0);
    assert(transportRequests.every(item=>item.method==='GET'||item.operation==='getCommitPreferences'),'Student actions cause no native/repository/publication writes.');
    assert.deepEqual(await inventory(fixtureRoot),fixtureInputs);assert.deepEqual(await inventory(sourceRoot),sourceInputs);assert.deepEqual(await inventory(buildRoot),buildInputs);
    checks.push('Fixture, product source and static-build hashes are unchanged; no runtime/console error, external request, native export or content-write request occurred.');
  });
}catch(error){failures.push({id:'harness',error:error.stack??String(error)});if(page)await page.screenshot({path:path.join(output,'failure-harness.png')}).catch(()=>{});}
finally{
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify({passed:failures.length===0,mode:'continuous-instructor-student-review',checks,stepResults,failures,errors,consoleErrors,externalRequests,transportRequests,geometry,captures,chromiumSandbox:true,browserVersion,story:story.id,fixtureInputs,sourceInputs,buildInputs,testSourceSha256:sha256(await fs.readFile(fileURLToPath(import.meta.url))),limits:['Focused changed-boundary Storybook browser checks only; native package/persistence/export behavior is not accepted by this run.','IME composition guarding is source-only; this run does not claim actual input-method browser qualification.','Keyboard focus and geometry are deterministic checks; full screen-reader and contrast qualification are not included.']},null,2));
}
if(failures.length){console.error(`${failures.length} browser qualification groups failed. Evidence: ${output}`);process.exitCode=1;}else console.log(`${checks.length} focused instructor/student groups passed. Evidence: ${output}`);
