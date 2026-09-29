import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from '../node_modules/esbuild/lib/main.js';
import {chromium} from '../../tools/playwright.mjs';
import {testRoot} from '../../tools/development-paths.mjs';

// A wholly synthetic fixture verifies the multi-pending case without extending
// or importing any private course reference. All generated files stay in Test.
const output=process.env.ASMB_PENDING_OUTPUT,executablePath=process.env.ASMB_BROWSER;
assert(output&&executablePath,'Set ASMB_PENDING_OUTPUT and ASMB_BROWSER.');
const relative=path.relative(testRoot,output);
assert(path.isAbsolute(output)&&path.resolve(output)===output&&relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Evidence must be a canonical path inside ASMB_TEST_ROOT.');
await fs.mkdir(path.dirname(output),{recursive:true});
assert.equal(await fs.realpath(path.dirname(output)),path.dirname(output),'Evidence parent must be physical.');
await fs.mkdir(output); // Every attempt retains its own evidence.
await fs.mkdir(path.join(output,'tmp'));
for(const key of ['TMPDIR','TMP','TEMP'])process.env[key]=path.join(output,'tmp');
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../src');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const inputNames=['TeachCalendarStudy.tsx','TeachYearSelect.tsx','teach-year-select.css','teach-calendar-study.css','teach-calendar.mjs'];
const inputs={},checks=[],errors=[],network=[],captures=[];
let browser,page,failure,browserVersion;
const fixture=`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {TeachCalendarStudy,TeachCourseCalendarStudy} from './TeachCalendarStudy';
import {currentTeachingSeason} from './teach-calendar.mjs';
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const course=freeze({id:'synthetic-pending-course',code:'QA_PENDING',title:'Synthetic pending classes',year:String(new Date().getFullYear()),season:currentTeachingSeason(),description:'Synthetic calendar qualification',repository:'QA_PENDING_asTeach',sections:[],readOnly:true});
const records=freeze(['First pending class','Second pending class','Third pending class'].map((title,index)=>({id:'pending-'+(index+1),title,date:'',start:'',end:'',status:'unconfirmed',notes:'Synthetic date awaiting confirmation',sourceLine:index+1})));
const initial=freeze({terms:{[course.id]:{monday:'',totalWeeks:3,sessions:[],recordedClasses:records}},noClassDays:[]});
window.fixtureNavigation=[];
window.fixtureInitial={course,state:initial};
function Fixture(){
  const [selected,setSelected]=useState(false),[state,setState]=useState(initial);
  window.fixtureSnapshot=()=>({course,state});
  return <main className="fw-window"><h1>Synthetic pending-class qualification</h1>{selected?<><button type="button" onClick={()=>setSelected(false)}>Return to synthetic Home</button><TeachCourseCalendarStudy course={course} state={state} onChange={setState} onOpenSchedule={()=>{throw Error('The synthetic fixture has no source document.');}}/></>:<TeachCalendarStudy courses={[course]} state={state} onChange={setState} onOpenTerm={id=>{window.fixtureNavigation.push(id);if(id!==course.id)throw Error('Wrong course opened');setSelected(true);return true;}}/>}</main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
try{
  for(const name of inputNames)inputs[name]=sha256(await fs.readFile(path.join(source,name)));
  await build({stdin:{contents:fixture,resolveDir:source,sourcefile:'pending-fixture.tsx',loader:'tsx'},bundle:true,outfile:path.join(output,'fixture.js'),platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'}});
  await fs.writeFile(path.join(output,'fixture.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>body{margin:0;font:14px/1.4 system-ui;background:#fff}.fw-window{padding:24px;--fw-bg:#fff;--fw-panel:#f6f8fa;--fw-text:#1f2328;--fw-line:#d1d9e0;--fw-muted:#59636e;--fw-accent:#0969da}h1{font-size:18px}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  browser=await chromium.launchPersistentContext(path.join(output,'browser-profile'),{headless:true,executablePath,chromiumSandbox:true,viewport:{width:1440,height:1000},args:['--disable-background-networking'],env:{...process.env,TMPDIR:path.join(output,'tmp'),TMP:path.join(output,'tmp'),TEMP:path.join(output,'tmp')}});
  browserVersion=browser.browser()?.version();page=await browser.newPage();page.setDefaultTimeout(7000);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.route(/^https?:/,route=>{network.push(route.request().url());return route.abort();});
  await page.goto(pathToFileURL(path.join(output,'fixture.html')).href);
  const overview=page.locator('.tcal-overview'),courseCalendar=page.locator('.tcal-course-calendar');
  const snapshot=()=>page.evaluate(()=>window.fixtureSnapshot());
  const initial=await page.evaluate(()=>window.fixtureInitial);
  const expectedIds=initial.state.terms[initial.course.id].recordedClasses.map(record=>record.id);
  const capture=async name=>{await page.screenshot({path:path.join(output,name),fullPage:true});captures.push(name);};
  const firstOnly=async()=>{
    await overview.waitFor();
    assert.equal(await overview.locator('.tcal-course-row').count(),1);
    assert.equal(await overview.locator('.tcal-pending-class').count(),1,'Home shows exactly one pending preview for a course with three undated classes.');
    const text=await overview.innerText();
    assert(text.includes('First pending class'),'The preview retains the first undated record.');
    for(const title of ['Second pending class','Third pending class'])assert(!text.includes(title),'Later undated classes stay in the full course list.');
    assert.equal(await overview.locator('.tcal-undated').count(),0,'Home omits the full undated list.');
    assert.deepEqual(await snapshot(),initial,'Home rendering preserves all original synthetic source records.');
  };
  const allPending=async()=>{
    await courseCalendar.waitFor();
    const records=courseCalendar.locator('.tcal-undated [data-recorded-class]');
    assert.equal(await records.count(),3,'Course calendar retains all three undated source classes.');
    assert.deepEqual(await records.evaluateAll(items=>items.map(item=>item.getAttribute('data-recorded-class'))),expectedIds,'Course calendar preserves undated source identity and ordering.');
    for(const title of ['First pending class','Second pending class','Third pending class'])assert((await courseCalendar.innerText()).includes(title));
    assert.equal(await courseCalendar.getByRole('button',{name:'Add class session',exact:true}).count(),0,'The synthetic reference remains read-only.');
    assert.deepEqual(await snapshot(),initial,'Opening the complete pending list does not mutate source records.');
  };
  await firstOnly();await capture('home-first-pending.png');
  await overview.locator('.tcal-pending-class').click();await allPending();await capture('course-all-pending.png');
  checks.push('With three undated source classes, Home shows only the first pending preview; pointer activation opens all three in original source order.');
  await page.getByRole('button',{name:'Return to synthetic Home',exact:true}).click();await firstOnly();
  await overview.locator('.tcal-pending-class').focus();await page.keyboard.press('Enter');await allPending();
  assert.deepEqual(await page.evaluate(()=>window.fixtureNavigation),[initial.course.id,initial.course.id],'Pointer and keyboard activation open the same independent course.');
  checks.push('Returning Home preserves the first-only preview; keyboard activation opens the same complete course list without changing source IDs or state.');
  for(const name of inputNames)assert.equal(sha256(await fs.readFile(path.join(source,name))),inputs[name],`Source input changed during qualification: ${name}`);
  assert.deepEqual(errors,[],'No browser or console errors.');assert.deepEqual(network,[],'The synthetic harness makes no external requests.');
  checks.push('All pinned source hashes remain unchanged; no browser errors or HTTP(S) requests occur.');
}catch(error){failure=error.stack??String(error);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}
finally{
  if(browser)await browser.close();
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify({passed:!failure,checks,failure,errors,network,captures,inputs,chromiumSandbox:true,browserVersion,fixture:'One synthetic read-only course with three undated classes; no private reference data.',limits:['Focused shared-component browser qualification, not a full Storybook or native persistence acceptance.']},null,2));
}
if(failure){console.error(failure);process.exitCode=1;}else console.log(`${checks.length} pending-class qualification groups passed. Evidence: ${output}`);
