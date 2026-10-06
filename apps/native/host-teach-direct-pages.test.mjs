import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createNativeService} from './host-service.mjs';
test('direct schedule generation owns Students pages, preserves edits/retries and hides its record',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'direct-pages-')),service=await createNativeService({dataRoot:path.join(root,'data')});t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
 const call=v=>service.teachRequest(v),course=await call({operation:'create',requestId:randomUUID(),code:'DIRECT101',name:'中文',year:2026,season:'autumn',structureVersion:2}),repo=course.repo,d=await call({operation:'workspaceDescriptor',repo}),student=d.roles.find(r=>r.role==='students').name;
 const settings=course.settings['2026-autumn'];await call({operation:'setCalendar',repo,year:2026,season:'autumn',expectedHash:settings.hash,calendar:{monday:'2026-10-19',totalWeeks:2,sessions:[{id:'lecture',title:'Lecture',weekday:1,start:'09:00',end:'10:20',location:'CR6',weekFrom:1,weekTo:2}]}});
 const current=(await call({operation:'list'})).find(c=>c.repo===repo),request={operation:'generateClassPages',repo,year:2026,season:'autumn',expectedHash:current.settings['2026-autumn'].hash};let result=await call(request);assert.equal(result.created,2);assert.match(result.markdown,/classes\/Class01.md/);
 const physical=name=>path.join(root,'data/workspaces/asMagicBrain',name);assert.ok(fs.existsSync(path.join(physical(student),'2026-autumn/classes/Class01.md')));assert.ok(!fs.existsSync(path.join(physical(repo),'2026-autumn/students')));assert.ok(!fs.existsSync(path.join(physical(repo),'2026-autumn/classes')));
 const file=await service.request({repo:student,operation:'open',args:{path:'2026-autumn/classes/Class01.md'}});await service.request({repo:student,operation:'save',args:{path:file.path,baseHash:file.sourceHash,text:'# Authored 学生课\n'}});result=await call(request);assert.equal(result.created,0);assert.equal(fs.readFileSync(path.join(physical(student),file.path),'utf8'),'# Authored 学生课\n');const tree=await service.request({repo:student,operation:'discover',args:{}});assert.ok(!tree.entries.some(e=>e.path.startsWith('.asteach')));
 const manual=await call({operation:'createClassPackage',repo,year:2026,season:'autumn',number:3});assert.equal(manual.repo,student);assert.equal(manual.lesson,'2026-autumn/classes/Class03.md');await assert.rejects(call({operation:'createClassPackage',repo,year:2026,season:'autumn',number:3}),{code:'CLASS_PAGES_COLLISION'});
 fs.unlinkSync(path.join(physical(student),'2026-autumn/classes/Class02.md'));await assert.rejects(call(request),{code:'CLASS_PAGES_INCOMPLETE'});
});
