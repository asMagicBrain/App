import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {chromium} from '../../tools/playwright.mjs';
import {testRoot} from '../../tools/development-paths.mjs';
import {staticHandler, createTeachReferenceHandler, teachReferencePrefix} from '../.storybook/static-server.mjs';

// Focused Split-mode qualification; previous instructor/student behavior has its own retained suite.
// Only metadata expectations belong in this file; original course text stays external.
const output=process.env.ASMB_SPLIT_EDITOR_OUTPUT, fixtureRoot=process.env.ASMB_TEACH_REFERENCE_ROOT, executablePath=process.env.ASMB_BROWSER;
assert(output&&fixtureRoot&&executablePath,'Set ASMB_SPLIT_EDITOR_OUTPUT, ASMB_TEACH_REFERENCE_ROOT and ASMB_BROWSER.');
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
    if(regions)await page.evaluate(items=>{
      const overlay=document.createElement('div');overlay.id='split-editor-qa-overlay';overlay.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      for(const [label,selector] of items){const element=[...document.querySelectorAll(selector)].find(item=>item.getClientRects().length&&!item.closest('[hidden]'));if(!element)throw Error('Missing overlay region '+label);const r=element.getBoundingClientRect(),box=document.createElement('div');box.style.cssText=`position:fixed;box-sizing:border-box;border:2px dashed #8054ff;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;const caption=document.createElement('span');caption.textContent=label;caption.style.cssText='position:absolute;left:2px;top:100%;margin-top:4px;white-space:nowrap;background:#6435d6;color:white;font:600 11px/18px system-ui;padding:0 5px;border-radius:3px';if(label.startsWith('T1 ')){caption.style.top='50%';caption.style.left='8px';}if(label.startsWith('T3 ')){caption.style.top='-24px';caption.style.marginTop='0';}box.append(caption);overlay.append(box);}(document.querySelector('dialog[open]')??document.body).append(overlay);
    },regions);
    try{await page.screenshot({path:path.join(output,name)});captures.push(name);}finally{if(regions)await page.locator('#split-editor-qa-overlay').evaluate(element=>element.remove());}
  };
  const pluginHome=page.locator('[data-plugin-view="home"]:visible');
  const catalog=page.locator('[data-plugin-view="courses"]:visible');
  const courses=async()=>{await breadcrumb.getByRole('button',{name:'Courses — all courses',exact:true}).click();await catalog.waitFor();await frame();};
  const assertTerm=async id=>{await study.waitFor();await frame();assert.equal(await study.getAttribute('data-course-id'),id);};
  const theme=async value=>{await button('asMagicBrain Theme').click();await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption(value);await button('Done').click();await frame();};
  const editor=study.locator('.teach-source .cm-content'),sourceScroller=study.locator('.teach-source .cm-scroller');
  const body=study.locator('.teach-document-body'),live=study.locator('.teach-reading[aria-label="Instructor page draft preview"]');
  const mode=async name=>{await study.locator('[aria-label="Instructor page mode"]').getByRole('button',{name,exact:true}).click();await settle();};
  const settle=()=>page.evaluate(()=>new Promise(resolve=>{let count=0;const next=()=>++count>=6?resolve():requestAnimationFrame(next);requestAnimationFrame(next);}));
  const scrollSamples=[],headerSamples=[],limitations=['Focused Split changed-boundary Storybook qualification; prior broad navigation/reference/student suites are not repeated.','No native-package, persistent-storage, actual IME, full screen-reader or contrast acceptance.'];
  const exact=(actual,expected,message)=>assert.equal(sha256(actual??''),sha256(expected),message);
  const runGroup=async(id,fn)=>{try{await fn();stepResults.push({id,status:'PASS'});console.log(`STEP_PASS|${id}|${checks.at(-1)}`);}catch(error){const screenshot=`failure-${id}.png`;await page.screenshot({path:path.join(output,screenshot)}).catch(()=>{});failures.push({id,error:error.stack??String(error),screenshot});stepResults.push({id,status:'FAIL',screenshot});console.error(`STEP_FAIL|${id}|${error.message}|${path.join(output,screenshot)}`);}};
  const genericStory=Object.values(index.entries).find(item=>item.name==='asTeach — Courses and workspace');assert(genericStory);
  const loadGeneric=async()=>{await page.setViewportSize({width:1440,height:1000});await page.goto(`${origin}/iframe.html?id=${encodeURIComponent(genericStory.id)}&viewMode=story`);await pluginHome.waitFor();await courses();await button('Open course DES101').click();await study.waitFor();await settle();};
  const saved='# Course Description\n\nQA saved content for Student and saved Preview.\n\n# Teaching Goals\n\nQA saved learning goal.\n';
  const longBlocks=Array.from({length:25},(_,index)=>{
    const number=String(index+1).padStart(2,'0'),title=`## Block ${number}`;
    switch(index%5){
      case 0:return `${title}\n\n`+Array.from({length:2+index%4},(_,p)=>`Block ${number} paragraph ${p+1}. `+Array.from({length:14+index},(_,i)=>`Uneven prose ${i+1} has **emphasis**, carefully spaced words, and a different rendered width.`).join(' ')).join('\n\n')+'\n\n';
      case 1:return `${title}\n\n\`\`\`text\n`+Array.from({length:10+index},(_,i)=>`Block ${number} code row ${i+1} = value_${i+1};`).join('\n')+'\n```\n\n';
      case 2:return `${title}\n\n| Item | Detail |\n| --- | --- |\n`+Array.from({length:8+index%7},(_,i)=>`| Block ${number} row ${i+1} | ${'Uneven table content '.repeat(1+i%3)} |`).join('\n')+'\n\n';
      case 3:return `${title}\n\n`+Array.from({length:9+index%8},(_,i)=>`- Block ${number} list item ${i+1}: ${'longer list text with Markdown **weight** '.repeat(2+i%3)}`).join('\n')+'\n\n';
      default:return `${title}\n\n`+Array.from({length:8+index%6},(_,i)=>`> Block ${number} quote line ${i+1}. ${'A quoted explanation wraps differently in the rendered view. '.repeat(2)}`).join('\n')+'\n\n';
    }
  }).join('');
  const draft='# Course Description\n\nQA live unsaved draft introduction.\n\n'+longBlocks+'# Teaching Goals\n\nQA live draft ending.\n\n[QA missing local link](missing.md)\n\n![QA blocked remote image](https://example.invalid/split-should-never-load.png)\n\n<script>window.__splitQaExecuted=true</script>\n';
  const prepare=async()=>{await loadGeneric();await mode('Edit');await editor.fill(saved);await button('Save').click();await editor.fill(draft);await mode('Split');await live.waitFor();await settle();};
  const liveFingerprint=async()=>sha256(await live.textContent());
  const ensureSplit=async()=>{assert.equal(await body.getAttribute('data-split'),'true');assert.equal(await study.locator('.teach-source .cm-editor').count(),1,'Split reuses exactly one CM6 editor.');assert(await editor.isVisible());assert(await live.isVisible());};
  const noSearch=async()=>{assert.equal(await study.getByRole('button',{name:'Find',exact:true}).count(),0,'asTeach has no Find action.');assert.equal(await study.locator('.cm-search').count(),0,'asTeach has no CM6 search panel.');};
  const headers=async()=>study.evaluate(element=>{
    const sourceHeader=element.querySelector('.teach-editor-pane > .teach-pane-label'),previewHeader=element.querySelector('.teach-preview-pane > .teach-pane-label');
    if(!sourceHeader||!previewHeader)return null;
    const box=node=>{const value=node.getBoundingClientRect();return {x:value.x,y:value.y,width:value.width,height:value.height,bottom:value.bottom};};
    return {direction:getComputedStyle(element.querySelector('.teach-document-body')).flexDirection,left:box(sourceHeader),right:box(previewHeader),sourceTop:element.querySelector('.cm-scroller').getBoundingClientRect().top,previewTop:element.querySelector('.teach-reading').getBoundingClientRect().top,previewHeaderOutsideScrollport:!previewHeader.closest('.teach-reading')};
  });
  const assertHeaders=async(label,before)=>{
    const value=await headers();assert(value,`${label}: both fixed pane headers exist.`);headerSamples.push({label,...value});
    assert(Math.abs(value.left.height-34)<=1&&Math.abs(value.right.height-34)<=1,`${label}: both headers retain equal34px height.`);
    assert(Math.abs(value.left.width-value.right.width)<=2,`${label}: both header widths match.`);
    if(value.direction==='row')assert(Math.abs(value.left.y-value.right.y)<=1,`${label}: desktop headers align horizontally.`);
    assert(Math.abs(value.sourceTop-value.left.bottom)<=1&&Math.abs(value.previewTop-value.right.bottom)<=1,`${label}: each scrollport starts directly below its fixed header.`);
    assert(value.previewHeaderOutsideScrollport,`${label}: preview header is outside the content scrollport.`);
    if(before)for(const side of ['left','right'])for(const field of ['x','y','width','height'])assert(Math.abs(value[side][field]-before[side][field])<=1,`${label}: ${side} header ${field} remains fixed during scroll.`);
    return value;
  };
  const scrollPosition=async locator=>locator.evaluate(element=>({top:element.scrollTop,max:element.scrollHeight-element.clientHeight,height:element.clientHeight}));
  const setScroll=async(locator,fraction)=>{await locator.evaluate((element,value)=>{element.scrollTop=(element.scrollHeight-element.clientHeight)*value;},fraction);await settle();};
  const linePair=async()=>study.evaluate(element=>{
    const source=element.querySelector('.teach-source .cm-scroller'),preview=element.querySelector('.teach-reading[aria-label="Instructor page draft preview"]');
    const sourceY=source.getBoundingClientRect().top+20,previewY=preview.getBoundingClientRect().top+20;
    const rows=[...source.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].map(item=>({line:Number(item.textContent),box:item.getBoundingClientRect()})).filter(item=>Number.isInteger(item.line)&&item.line>0&&item.box.height>0).sort((a,b)=>a.box.top-b.box.top);
    const row=rows.find(item=>item.box.top<=sourceY&&item.box.bottom>sourceY)??[...rows].reverse().find(item=>item.box.top<=sourceY)??rows[0];
    const sourceLine=row?row.line+Math.max(0,Math.min(1,(sourceY-row.box.top)/row.box.height)):null;
    const blocks=[...preview.querySelectorAll('[data-source-line][data-source-end-line]')].map(item=>({line:Number(item.dataset.sourceLine),end:Number(item.dataset.sourceEndLine),box:item.getBoundingClientRect()})).filter(item=>item.line>=1&&item.end>=item.line&&item.box.height>0);
    const contains=blocks.filter(item=>item.box.top<=previewY&&item.box.bottom>previewY).sort((a,b)=>a.box.height-b.box.height);
    const block=contains[0]??[...blocks].sort((a,b)=>Math.abs(a.box.top-previewY)-Math.abs(b.box.top-previewY))[0];
    const previewLine=block?block.line+Math.max(0,Math.min(1,(previewY-block.box.top)/block.box.height))*Math.max(1,block.end-block.line):null;
    return {sourceLine,previewLine,sourceTop:source.scrollTop,previewTop:preview.scrollTop,sourceMax:source.scrollHeight-source.clientHeight,previewMax:preview.scrollHeight-preview.clientHeight,block:block?{line:block.line,end:block.end}:null};
  });
  const assertMapped=async(direction,fraction)=>{const sample=await linePair();scrollSamples.push({direction,fraction,...sample});assert.notEqual(sample.sourceLine,null,'CM6 visible line numbers are measurable.');assert.notEqual(sample.previewLine,null,'Preview source-line map is measurable.');assert(Math.abs(sample.sourceLine-sample.previewLine)<=6,`${direction} corresponding content differs by ${Math.abs(sample.sourceLine-sample.previewLine).toFixed(2)} logical lines at ${fraction}.`);};
  const splitMarkers=[['C0 · Course and page breadcrumb','.pws-breadcrumb'],['T1 · Course navigation','.teach-sidebar'],['T3 · Split mode and document actions','.teach-toolbar'],['T4.1 · Continuous source editor','.teach-editor-pane'],['T4.2 · Live unsaved preview','.teach-preview-pane']];

  await runGroup('live-split-and-saved-isolation',async()=>{
    await prepare();await ensureSplit();await noSearch();await assertHeaders('initial editable Split');assert.deepEqual(await study.locator('[aria-label="Instructor page mode"] button').allTextContents(),['Preview','Edit','Split'],'Instructor modes are exactly Preview, Edit and Split.');
    const left=await sourceScroller.boundingBox(),right=await live.boundingBox();assert(left&&right&&left.x+left.width<=right.x+2,'At desktop width source is left of preview.');assert((await live.textContent()).includes('QA live unsaved draft introduction.'));
    await editor.press(process.platform==='darwin'?'Meta+End':'Control+End');await editor.press('End');await editor.press('Enter');await page.keyboard.insertText('QA typed live marker');await settle();assert((await live.textContent()).includes('QA typed live marker'),'Typing changes the live preview before Save.');const fingerprint=await liveFingerprint();
    await mode('Preview');assert((await study.locator('.teach-reading:visible').textContent()).includes('QA saved content for Student'));assert(!(await study.locator('.teach-reading:visible').textContent()).includes('QA typed live marker'),'Saved Preview excludes the Split draft.');
    await selectMenu('pages','Student page');const studentText=await study.locator('.teach-reading:visible').textContent();assert(studentText.includes('QA saved content for Student'));assert(!studentText.includes('QA live unsaved'));await button('Review student copy').click();const review=page.getByRole('dialog',{name:'Review student copy',exact:true});await review.waitFor();await review.getByRole('checkbox',{name:'Course Description',exact:true}).check();const proposed=await review.locator('[aria-label="Student copy review preview"]').textContent();assert(proposed.includes('QA saved content for Student'));assert(!proposed.includes('QA typed live marker'));await review.getByRole('button',{name:'Cancel review',exact:true}).click();
    await selectMenu('pages','Instructor page');await mode('Split');assert.equal(await liveFingerprint(),fingerprint,'Returning from saved Preview and Student preserves the complete rendered draft.');
    await setScroll(sourceScroller,0);await capture('instructor-split-annotated.png',splitMarkers);
    checks.push('Split follows Edit, reuses one CM6 editor on the left, renders typed unsaved text on the right, and leaves saved Preview and Student review isolated from the draft.');
  });

  await runGroup('bidirectional-content-scroll',async()=>{
    await prepare();const fixedHeaders=await assertHeaders('before bidirectional scroll');assert((await scrollPosition(sourceScroller)).max>2500);assert((await scrollPosition(live)).max>2500);
    for(const fraction of [.12,.47,.78]){await setScroll(sourceScroller,fraction);await assertMapped('source-to-preview',fraction);await assertHeaders(`source-to-preview ${fraction}`,fixedHeaders);if(fraction===.47)await capture('instructor-split-scrolled-annotated.png',splitMarkers);}
    for(const fraction of [.22,.6,.9]){await setScroll(live,fraction);await assertMapped('preview-to-source',fraction);await assertHeaders(`preview-to-source ${fraction}`,fixedHeaders);}
    await setScroll(sourceScroller,0);let pair=await linePair();assert(pair.sourceTop<2&&pair.previewTop<2,'Top synchronizes without oscillation.');await setScroll(live,1);pair=await linePair();assert(pair.sourceTop>=pair.sourceMax-3&&pair.previewTop>=pair.previewMax-3,'Bottom synchronizes in reverse.');
    await assertHeaders('after top and bottom scrolling',fixedHeaders);const settled=await linePair();await settle();const stable=await linePair();assert(Math.abs(stable.sourceTop-settled.sourceTop)<2&&Math.abs(stable.previewTop-settled.previewTop)<2,'Scroll synchronization settles without a feedback loop.');
    checks.push('Both scroll directions track corresponding logical content across long uneven paragraphs, code, tables, lists and quotations; top/bottom synchronize and settle without oscillation, while equal fixed pane headers keep their original bounds.');
  });

  await runGroup('split-mode-term-undo-retention',async()=>{
    await prepare();await editor.press(process.platform==='darwin'?'Meta+End':'Control+End');await editor.press('End');await editor.press('Enter');await page.keyboard.insertText('QA Split undo sentinel');await settle();const fingerprint=await liveFingerprint(),currentId=await study.getAttribute('data-course-id'),originalEditor=await study.locator('.cm-editor').elementHandle();
    await mode('Edit');await noSearch();await mode('Split');await noSearch();assert.equal(await liveFingerprint(),fingerprint);assert(await study.locator('.cm-editor').evaluate((element,original)=>element===original,originalEditor),'Mode changes retain the same CM6 editor node.');await mode('Preview');await mode('Split');assert.equal(await liveFingerprint(),fingerprint);
    await selectMenu('pages','Course calendar');await selectMenu('pages','Instructor page');await mode('Split');assert.equal(await liveFingerprint(),fingerprint);
    await selectMenu('terms','Add term');const add=page.getByRole('dialog',{name:'Add term',exact:true});await add.waitFor();await add.getByRole('button',{name:'Year',exact:true}).click();await page.getByRole('menu',{name:'Year',exact:true}).getByRole('menuitemradio',{name:'2024',exact:true}).click();await add.getByRole('combobox',{name:'Season',exact:true}).selectOption('Spring');await add.getByRole('button',{name:'Create term',exact:true}).click();await settle();assert.notEqual(await study.getAttribute('data-course-id'),currentId);
    await mode('Split');assert(!(await live.textContent()).includes('QA Split undo sentinel'));await selectMenu('terms','2026 Autumn');await mode('Split');assert.equal(await liveFingerprint(),fingerprint);
    await courses();await button('Open course DES101').click();await mode('Split');assert.equal(await liveFingerprint(),fingerprint);await editor.press(process.platform==='darwin'?'Meta+z':'Control+z');await settle();assert(!(await live.textContent()).includes('QA Split undo sentinel'),'Undo survives Split/mode/term/calendar/catalog navigation.');await editor.press(process.platform==='darwin'?'Meta+Shift+z':'Control+Shift+z');await settle();assert.equal(await liveFingerprint(),fingerprint);
    checks.push('Split/Edit/Preview, calendar, another term and the catalog preserve the draft; term content stays separate and native CM6 undo/redo still works on return.');
  });

  await runGroup('split-resize-fixed-headers-and-inert-links',async()=>{
    await prepare();await setScroll(sourceScroller,.47);await button('Toggle file sidebar').click();await settle();await assertMapped('sidebar-resize',.47);await button('Toggle file sidebar').click();await settle();
    await editor.focus();await editor.press(process.platform==='darwin'?'Meta+f':'Control+f');await settle();await noSearch();await page.keyboard.press('Escape');await settle();
    const fingerprint=await liveFingerprint();
    for(const scheme of ['light-default','dark-default']){await theme(scheme);for(const width of [1100,760,430]){await page.setViewportSize({width,height:1000});await settle();await ensureSplit();const sourceBox=await sourceScroller.boundingBox(),previewBox=await live.boundingBox();geometry.push({scheme,width,source:sourceBox,preview:previewBox});assert(sourceBox.width>80&&previewBox.width>80&&sourceBox.height>80&&previewBox.height>80,'Both Split panes remain usable.');assert(await page.locator('.fw-window').evaluate(element=>element.scrollWidth<=element.clientWidth+1),'Split introduces no horizontal app overflow.');const toolbar=await study.locator('.teach-toolbar').boundingBox();for(const action of await study.locator('.teach-toolbar button').all()){const bounds=await action.boundingBox();assert(bounds&&bounds.x>=toolbar.x-1&&bounds.x+bounds.width<=toolbar.x+toolbar.width+1&&bounds.y>=toolbar.y-1&&bounds.y+bounds.height<=toolbar.y+toolbar.height+1,`Toolbar action ${await action.innerText()} is fully visible at ${width}px in ${scheme}.`);}assert.equal(await liveFingerprint(),fingerprint);const fixedHeaders=await assertHeaders(`before resize scroll ${scheme}-${width}`);await setScroll(sourceScroller,.3);await assertMapped(`resize-${scheme}-${width}`,.3);await assertHeaders(`after resize scroll ${scheme}-${width}`,fixedHeaders);await noSearch();if(width===430){assert(sourceBox.y+sourceBox.height<=previewBox.y+2,'Compact Split stacks source above preview.');await capture(`instructor-split-compact-${scheme}.png`);}}}
    await page.setViewportSize({width:1440,height:1000});await theme('light-default');await settle();const url=page.url(),pages=browser.pages().length;await live.getByRole('link',{name:'QA missing local link',exact:true}).click();await settle();assert.equal(page.url(),url);assert.equal(browser.pages().length,pages);assert.equal(await body.getAttribute('data-split'),'true');assert.equal(await liveFingerprint(),fingerprint);assert.equal(await page.evaluate(()=>window.__splitQaExecuted),undefined,'Imported script text is inert.');
    checks.push('Split survives sidebar and 1100/760/430 px light/dark resizing, stacks at compact width, retains synchronized content and fixed equal pane headers, exposes no Find action or CM6 search panel, and keeps untrusted links/images/script text inert.');
  });

  await runGroup('readonly-reference-split-assets-integrity',async()=>{
    await page.setViewportSize({width:1440,height:1000});await page.goto(`${origin}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`);await pluginHome.waitFor();await courses();await button('Open course DES5002').click();await study.waitFor();const reference=fixture.courses.findLast(course=>Object.keys(course.reference.assets??{}).length>0);assert(reference);await selectMenu('terms',`${reference.year} ${reference.season}`);await selectMenu('pages','Instructor page');await study.locator('[aria-label="Reference mode"]').getByRole('button',{name:'Split',exact:true}).click();await settle();
    await noSearch();assert.deepEqual(await study.locator('[aria-label="Reference mode"] button').allTextContents(),['Preview','Source','Split']);const fixedHeaders=await assertHeaders('before readonly reference scrolling');assert.equal(await body.getAttribute('data-split'),'true');assert.equal(await study.locator('.teach-source .cm-editor').count(),1);assert.equal(await editor.getAttribute('contenteditable'),'false');assert.equal(await editor.getAttribute('aria-readonly'),'true');const before=await editor.textContent();await editor.focus();await page.keyboard.insertText('QA forbidden reference change');await settle();exact(await editor.textContent(),before,'Read-only reference Split cannot modify original source.');for(const name of ['Save','Cancel'])assert.equal(await study.getByRole('button',{name,exact:true}).count(),0);
    const referencePreview=study.locator('.teach-reading:visible'),images=referencePreview.locator('img.teach-reference-image');assert(await images.count()>0);for(let index=0;index<await images.count();index++){await images.nth(index).scrollIntoViewIfNeeded();await images.nth(index).evaluate(image=>image.decode());}assert(await images.evaluateAll(items=>items.every(item=>item.complete&&item.naturalWidth>0&&new URL(item.src).origin===location.origin)));
    await assertHeaders('after readonly mapped images scrolling',fixedHeaders);await referencePreview.evaluate(element=>{element.scrollTop=0;});await settle();await assertHeaders('readonly reference returned to top',fixedHeaders);await capture('reference-instructor-split-annotated.png',[['C0 · Reference term breadcrumb','.pws-breadcrumb'],['T1 · Course navigation','.teach-sidebar'],['T3 · Read-only Split mode','.teach-toolbar'],['T4.1 · Original reference source','.teach-editor-pane'],['T4.2 · Mapped reference preview','.teach-preview-pane']]);
    assert.equal(errors.length,0);assert.equal(consoleErrors.length,0);assert.equal(externalRequests.length,0);assert(transportRequests.every(item=>item.method==='GET'||item.operation==='getCommitPreferences'));assert.deepEqual(await inventory(fixtureRoot),fixtureInputs);assert.deepEqual(await inventory(sourceRoot),sourceInputs);assert.deepEqual(await inventory(buildRoot),buildInputs);
    checks.push('The mapped-image reference term supports read-only Split with fixed equal headers, no Find/Save/Cancel or text mutation; approved local images decode, every input hash stays unchanged, and no runtime/console/external-network/content-write request occurs.');
  });
  await fs.writeFile(path.join(output,'scroll-samples.json'),JSON.stringify(scrollSamples,null,2));
  await fs.writeFile(path.join(output,'header-samples.json'),JSON.stringify(headerSamples,null,2));
}catch(error){failures.push({id:'harness',error:error.stack??String(error)});if(page)await page.screenshot({path:path.join(output,'failure-harness.png')}).catch(()=>{});}
finally{
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify({passed:failures.length===0,mode:'split-editor-cleanup',checks,stepResults,failures,errors,consoleErrors,externalRequests,transportRequests,geometry,captures,captureHashes:Object.fromEntries(await Promise.all(captures.map(async name=>[name,sha256(await fs.readFile(path.join(output,name)))]))),chromiumSandbox:true,browserVersion,story:story.id,fixtureInputs,sourceInputs,buildInputs,testSourceSha256:sha256(await fs.readFile(fileURLToPath(import.meta.url))),limits:['Focused Split changed-boundary Storybook qualification; previous broad navigation/reference/Student suites are not repeated.','No native-package, persistent-storage, actual IME, full screen-reader or contrast acceptance.']},null,2));
}
if(failures.length){console.error(`${failures.length} Split qualification groups failed. Evidence: ${output}`);process.exitCode=1;}else console.log(`${checks.length} focused Split checks passed. Evidence: ${output}`);
