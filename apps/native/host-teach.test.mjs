import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createNativeService} from './host-service.mjs';
import {parseCourse,courseKey} from '../../packages/asteach-plugin/course.mjs';
async function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'teach-'));let service=await createNativeService({dataRoot:path.join(root,'profile')});t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});return {root,get service(){return service;},restart:async()=>{await service.close();service=await createNativeService({dataRoot:path.join(root,'profile')});}};}
const create=()=>({operation:'create',requestId:randomUUID(),code:'ROB7103/8103',name:'Robotics',year:2026,season:'autumn'});
test('create is durable and idempotent, slash display preserved; term writes remain uncommitted',async t=>{
 const f=await fixture(t),input=create();const first=await f.service.teachRequest(input);assert.equal(first.repo,'ROB7103_8103_asTeach');assert.equal(first.course.code,input.code);
 assert.deepEqual(await f.service.teachRequest(input),first);await f.restart();assert.deepEqual(await f.service.teachRequest({operation:'list'}),[first]);
 const next=await f.service.teachRequest({operation:'addTerm',repo:first.repo,expectedHash:first.hash,year:2027,season:'spring'});assert.equal(next.course.terms.length,2);
 await assert.rejects(f.service.teachRequest({operation:'addTerm',repo:first.repo,expectedHash:first.hash,year:2028,season:'spring'}),{code:'CONFLICT'});
 const view=await f.service.read({repo:first.repo});assert.equal(view.commitCount,0);await f.restart();assert.equal((await f.service.teachRequest({operation:'list'}))[0].course.terms.length,2);
 await assert.rejects(f.service.teachRequest({...create(),code:'ROB7103_8103'}),{code:'DUPLICATE_COURSE'});
});
test('explicit adoption preserves legacy source and refuses metadata drafts',async t=>{
 const f=await fixture(t);await f.service.createRepository({name:'Legacy',requestId:randomUUID()});
 await f.service.request({repo:'Legacy',operation:'create',args:{path:'home.md',text:'# Legacy\n'}});
 const course={schemaVersion:1,courseId:randomUUID(),code:'DES5002',name:'Design',terms:[{year:2024,season:'spring',source:{kind:'legacy',paths:['home.md']}}]};
 const adopted=await f.service.teachRequest({operation:'adopt',repo:'Legacy',course});assert.equal((await f.service.request({repo:'Legacy',operation:'open',args:{path:'home.md'}})).text,'# Legacy\n');
 await f.service.request({repo:'Legacy',operation:'checkpoint',args:{path:'asteach-course.json',baseHash:adopted.hash,text:'unsaved'}});
 await assert.rejects(f.service.teachRequest({operation:'addTerm',repo:'Legacy',expectedHash:adopted.hash,year:2025,season:'spring'}),{code:'DRAFT_CONFLICT'});
});
test('future schema and invalid paths are refused',()=>{
 assert.throws(()=>parseCourse('{"schemaVersion":2}'),{code:'COURSE_SCHEMA_UNSUPPORTED'});assert.throws(()=>courseKey('../bad'));assert.throws(()=>courseKey('CON'));
});
test('teacher defaults and course calendars persist without overwriting course snapshots',async t=>{
 const f=await fixture(t);let settings=await f.service.teachRequest({operation:'defaults'});
 settings.value.teacher.givenNames='Original';settings=await f.service.teachRequest({operation:'setDefaults',expectedRevision:settings.revision,value:settings.value});
 const created=await f.service.teachRequest(create());assert.equal(created.settings['2026-autumn'].value.teacherSnapshot.givenNames,'Original');
 const doc=await f.service.request({repo:created.repo,operation:'open',args:{path:'2026-autumn/instructor.md'}});assert.match(doc.text,/Original/);
 settings.value.teacher.givenNames='Changed';await f.service.teachRequest({operation:'setDefaults',expectedRevision:settings.revision,value:settings.value});
 const calendar={monday:'2026-09-07',totalWeeks:14,sessions:[{id:'lecture',title:'Lecture',weekday:0,start:'10:00',end:'12:00',location:'Lab',weekFrom:1,weekTo:14}]};
 const updated=await f.service.teachRequest({operation:'setCalendar',repo:created.repo,year:2026,season:'autumn',expectedHash:created.settings['2026-autumn'].hash,calendar});
 assert.equal(updated.settings['2026-autumn'].value.teacherSnapshot.givenNames,'Original');await f.restart();
 assert.deepEqual((await f.service.teachRequest({operation:'list'}))[0].settings['2026-autumn'].value.calendar,calendar);
 assert.equal((await f.service.teachRequest({operation:'defaults'})).value.teacher.givenNames,'Changed');
 await assert.rejects(f.service.teachRequest({operation:'setCalendar',repo:created.repo,year:2026,season:'autumn',expectedHash:created.settings['2026-autumn'].hash,calendar}),{code:'CONFLICT'});
 await assert.rejects(f.service.nativeTeachRequest({operation:'list'}),{code:'PLUGIN_DISABLED'});
});

test('native class generation creates 42 pages durably, reuses edits and refuses stale settings',async t=>{
 const f=await fixture(t),created=await f.service.teachRequest(create());
 const calendar={monday:'2026-09-07',totalWeeks:14,sessions:[0,2,4].map(weekday=>({id:String(weekday),title:'Class',weekday,start:'09:00',end:'10:00',location:'R',weekFrom:1,weekTo:14}))};
 const saved=await f.service.teachRequest({operation:'setCalendar',repo:created.repo,year:2026,season:'autumn',expectedHash:created.settings['2026-autumn'].hash,calendar});
 const input={operation:'generateClassPages',repo:created.repo,year:2026,season:'autumn',expectedHash:saved.settings['2026-autumn'].hash};
 await assert.rejects(f.service.teachRequest({...input,expectedHash:created.settings['2026-autumn'].hash}),{code:'CONFLICT'});
 assert.equal((await f.service.teachRequest(input)).created,42);
 const file=await f.service.request({repo:created.repo,operation:'open',args:{path:'2026-autumn/classes/Class01.md'}});
 await f.service.request({repo:created.repo,operation:'save',args:{path:file.path,baseHash:file.sourceHash,text:'# Edited class\n'}});
 await f.restart();assert.equal((await f.service.teachRequest(input)).reused,42);
 assert.equal((await f.service.request({repo:created.repo,operation:'open',args:{path:file.path}})).text,'# Edited class\n');assert.equal((await f.service.read({repo:created.repo})).commitCount,0);
});
test('native Trash preserves recovery reservations; external deletion permits a new set',async t=>{
 const f=await fixture(t),created=await f.service.teachRequest(create()),repo=created.repo;
 const calendar={monday:'2026-09-07',totalWeeks:2,sessions:[{id:'lecture',title:'Class',weekday:0,start:'09:00',end:'10:00',location:'R',weekFrom:1,weekTo:2}]};
 const saved=await f.service.teachRequest({operation:'setCalendar',repo,year:2026,season:'autumn',expectedHash:created.settings['2026-autumn'].hash,calendar});
 const input={operation:'generateClassPages',repo,year:2026,season:'autumn',expectedHash:saved.settings['2026-autumn'].hash};await f.service.teachRequest(input);
 const request=(operation,args)=>f.service.request({repo,operation,args});
 const trash=async path=>{const item=await request('inspectEntry',{path});await request('manage',{operation:'trash',items:[{path,token:item.token}]});};
 const manifestBefore=(await request('open',{path:'.asteach/terms/2026-autumn/class-pages.json'})).text;
 await trash('2026-autumn/classes/Class01.md');await assert.rejects(f.service.teachRequest(input),{code:'TRASH_PATH_RESERVED'});
 await trash('2026-autumn/classes/Class02.md');await assert.rejects(f.service.teachRequest(input),{code:'TRASH_PATH_RESERVED'});
 assert.equal((await request('open',{path:'.asteach/terms/2026-autumn/class-pages.json'})).text,manifestBefore);
 const retained=await request('listTrash',{});assert.equal(retained.length,2);
 for(const item of retained)await request('restore',{trashId:item.trashId});
 for(const name of ['Class01.md','Class02.md'])fs.unlinkSync(path.join(f.root,'profile/workspaces/asMagicBrain',repo,'2026-autumn/classes',name));
 assert.equal((await f.service.teachRequest(input)).created,2);
 const entries=(await request('discover',{})).entries;assert.equal(entries.filter(e=>/Class\d+\.md$/.test(e.path)).length,2);
});

test('empty Trash releases generated class paths for a fresh set',async t=>{
 const f=await fixture(t),created=await f.service.teachRequest(create()),repo=created.repo;
 const calendar={monday:'2026-09-07',totalWeeks:2,sessions:[{id:'lecture',title:'Class',weekday:0,start:'09:00',end:'10:00',location:'R',weekFrom:1,weekTo:2}]};
 const saved=await f.service.teachRequest({operation:'setCalendar',repo,year:2026,season:'autumn',expectedHash:created.settings['2026-autumn'].hash,calendar});
 const input={operation:'generateClassPages',repo,year:2026,season:'autumn',expectedHash:saved.settings['2026-autumn'].hash};await f.service.teachRequest(input);
 const request=(operation,args={})=>f.service.request({repo,operation,args});
 for(const path of ['2026-autumn/classes/Class01.md','2026-autumn/classes/Class02.md']){const entry=await request('inspectEntry',{path});await request('manage',{operation:'trash',items:[{path,token:entry.token}]});}
 await assert.rejects(f.service.teachRequest(input),{code:'TRASH_PATH_RESERVED'});
 await request('emptyTrash',{trashIds:(await request('listTrash')).map(entry=>entry.trashId)});
 await f.restart();assert.deepEqual(await request('listTrash'),[]);assert.equal((await f.service.teachRequest(input)).created,2);
 assert.equal((await request('discover')).entries.filter(entry=>/Class\d+\.md$/.test(entry.path)).length,2);
});
test('editable course template affects new terms only; Student content goes directly to paired repo',async t=>{
 const f=await fixture(t),course=await f.service.teachRequest(create()),repo=course.repo,req={repo,year:2026,season:'autumn'};
 const template=await f.service.request({repo,operation:'open',args:{path:'instructor-template.md'}});
 await f.service.request({repo,operation:'save',args:{path:template.path,baseHash:template.sourceHash,text:'# Custom course\n'}});
 const original=await f.service.teachRequest({operation:'studentReview',...req});
 await f.service.teachRequest({operation:'addTerm',repo,expectedHash:course.hash,year:2027,season:'spring'});
 assert.match((await f.service.request({repo,operation:'open',args:{path:'2027-spring/instructor.md'}})).text,/# Custom course/);
 const pair=await f.service.teachRequest({operation:'ensureStudent',repo});
 const input={operation:'reviewPublication',...req,destination:pair.repo,selectedPages:[],studentText:'# Student course\n',sourceHash:original.instructor.sourceHash};
 await assert.rejects(f.service.teachRequest({...input,sourceHash:'0'.repeat(64)}),{code:'CONFLICT'});
 const plan=await f.service.teachRequest(input);await f.service.teachRequest({operation:'copyPublication',planId:plan.planId});
 assert.equal((await f.service.teachRequest({operation:'studentReview',...req})).student,null);
 await f.restart();assert.equal((await f.service.request({repo:pair.repo,operation:'open',args:{path:'2026-autumn/student.md'}})).text,input.studentText);
 assert.match((await f.service.request({repo:pair.repo,operation:'open',args:{path:'2027-spring/student.md'}})).text,/Review Instructor/);
});
test('paired repositories exist before export; metadata is hidden but ordinary JSON is visible and searchable',async t=>{
 const f=await fixture(t),input=create(),course=await f.service.teachRequest(input),repo=course.repo;
 const pair=await f.service.teachRequest({operation:'ensureStudent',repo});assert.equal(pair.repo,'ROB7103_8103_Students');
 assert.match((await f.service.read({repo:pair.repo,path:'2026-autumn/student.md'})).content,/ROB7103/);
 await f.service.request({repo,operation:'create',args:{path:'2026-autumn/data.json',text:'{"sample":"courseId"}'}});
 const listing=await f.service.request({repo,operation:'discover',args:{}});assert.ok(listing.entries.some(e=>e.path==='2026-autumn/data.json'));assert.ok(!listing.entries.some(e=>e.path.startsWith('.asteach')));
 const root=await f.service.read({repo});assert.ok(!root.entries.some(e=>e.name==='.asteach'));
 const search=await f.service.listRepositoryFiles({repo,requestId:'metadata-files'});assert.ok(search.paths.includes('2026-autumn/data.json'));assert.ok(!search.paths.some(p=>p.startsWith('.asteach')));
 await f.restart();assert.deepEqual(await f.service.teachRequest({operation:'ensureStudent',repo}),pair);
 const actual=path.join(f.root,'profile/workspaces/asMagicBrain',repo);assert.ok(fs.existsSync(path.join(actual,'.asteach/course.json')));assert.ok(!fs.existsSync(path.join(actual,'asteach-course.json')));
});
test('paired destination name collision preserves unrelated files and source course',async t=>{
 const f=await fixture(t);await f.service.createRepository({name:'ROB7103_8103_Students',requestId:randomUUID()});await f.service.request({repo:'ROB7103_8103_Students',operation:'create',args:{path:'keep.md',text:'keep'}});
 await assert.rejects(f.service.teachRequest(create()));assert.equal((await f.service.read({repo:'ROB7103_8103_Students',path:'keep.md'})).content,'keep');assert.equal((await f.service.teachRequest({operation:'list'})).length,1);
});
test('pair identity survives rename and missing owned Student home is not silently recreated',async t=>{
 const f=await fixture(t),course=await f.service.teachRequest(create()),pair=await f.service.teachRequest({operation:'ensureStudent',repo:course.repo});
 await f.service.renameRepository({repository:pair.repo,name:'Students-renamed'});await f.restart();
 assert.deepEqual(await f.service.teachRequest({operation:'ensureStudent',repo:course.repo}),{repo:'Students-renamed'});
 const relative='2026-autumn/student.md',entry=await f.service.request({repo:'Students-renamed',operation:'inspectEntry',args:{path:relative}});
 await f.service.request({repo:'Students-renamed',operation:'manage',args:{operation:'trash',items:[{path:relative,token:entry.token}]}});
 await assert.rejects(f.service.teachRequest({operation:'ensureStudent',repo:course.repo}),{code:'TEACH_STUDENT_PAGE_MISSING'});
 assert.equal((await f.service.request({repo:'Students-renamed',operation:'listTrash',args:{}})).length,1);
});
