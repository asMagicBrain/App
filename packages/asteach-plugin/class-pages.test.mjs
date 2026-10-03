import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {generateClassPages} from './class-pages.mjs';
const calendar={monday:'2026-10-19',totalWeeks:14,sessions:[{weekday:1,start:'09:00',end:'10:00',location:'R',weekFrom:1,weekTo:14},{weekday:2,start:'09:00',end:'10:00',location:'R',weekFrom:1,weekTo:14},{weekday:4,start:'09:00',end:'10:00',location:'R',weekFrom:1,weekTo:14}]};
function fixture(){const files=new Map(),calls=[];let stop=0;return {files,calls,set stop(v){stop=v;},input:{repo:'Course',term:{year:2026,season:'autumn',source:{paths:['2026-autumn/instructor.md']}},calendar,noClassDays:[{date:'2026-10-20',description:'Holiday'}],read:async(repo,path)=>files.has(path)?{text:files.get(path),sourceHash:createHash('sha256').update(files.get(path)).digest('hex')}:null,writeBatch:async(repo,batch)=>{calls.push(batch);if(stop&&calls.length===stop)throw Error('interrupted');assert.ok(batch.length<=8);for(const item of batch){const previous=files.has(item.path)?createHash('sha256').update(files.get(item.path)).digest('hex'):null;assert.equal(previous,item.baseHash);}for(const item of batch)files.set(item.path,item.text);}}};}
test('42 linked pages, preserved edits, repeat clicks and full-delete regeneration',async()=>{
 const f=fixture(),first=await generateClassPages(f.input);assert.equal(first.created,42);assert.match(first.markdown,/\[No Class\. Holiday\]\(classes\/Class01.md\)/);assert.match(first.markdown,/\[ClassContent\]\(classes\/Class42.md\)/);
 f.files.set('2026-autumn/classes/Class01.md','Teacher edits');const writes=f.calls.length;const repeat=await generateClassPages(f.input);assert.equal(repeat.reused,42);assert.equal(f.calls.length,writes);assert.equal(f.files.get('2026-autumn/classes/Class01.md'),'Teacher edits');
 f.files.delete('2026-autumn/classes/Class02.md');await assert.rejects(generateClassPages(f.input),{code:'CLASS_PAGES_INCOMPLETE'});assert.equal(f.calls.length,writes);
 for(const key of f.files.keys())if(/Class\d+\.md$/.test(key))f.files.delete(key);
 assert.equal((await generateClassPages(f.input)).created,42);
});
test('collision, changed class mapping, malformed record and imported relative links',async()=>{
 const f=fixture();f.files.set('2026-autumn/classes/Class10.md','existing');await assert.rejects(generateClassPages(f.input),{code:'CLASS_PAGES_COLLISION'});assert.equal(f.calls.length,0);f.files.clear();
 const result=await generateClassPages({...f.input,term:{...f.input.term,source:{paths:['legacy/home.md']}}});assert.match(result.markdown,/\.\.\/2026-autumn\/classes\/Class01.md/);
 await assert.rejects(generateClassPages({...f.input,calendar:{...calendar,monday:'2026-10-26'}}),{code:'CLASS_PAGES_SCHEDULE_CHANGED'});
 f.files.set('2026-autumn/class-pages.json','{}');await assert.rejects(generateClassPages(f.input),{code:'CLASS_PAGES_RECORD_INVALID'});
});
test('interrupted generation resumes without replacing completed or edited pages',async()=>{
 const f=fixture();f.stop=3;await assert.rejects(generateClassPages(f.input),/interrupted/);assert.equal(f.files.size,9);f.files.set('2026-autumn/classes/Class01.md','Edited after interruption');f.stop=0;const result=await generateClassPages(f.input);assert.equal(result.created,34);assert.equal(result.reused,8);assert.equal(f.files.get('2026-autumn/classes/Class01.md'),'Edited after interruption');assert.equal(JSON.parse(f.files.get('2026-autumn/class-pages.json')).phase,'ready');
});
test('legacy generated pages keep edits and old links; full removal uses classes',async()=>{
 const f=fixture();await generateClassPages(f.input);
 for(const [name,text] of [...f.files])if(name.includes('/classes/')){f.files.delete(name);f.files.set(name.replace('/classes/','/'),text);}
 const record=JSON.parse(f.files.get('2026-autumn/class-pages.json'));record.paths=record.paths.map(p=>p.replace('/classes/','/'));f.files.set('2026-autumn/class-pages.json',JSON.stringify(record));f.files.set(record.paths[0],'Keep edited lesson');
 const old=await generateClassPages(f.input);assert.equal(old.reused,42);assert.match(old.markdown,/\(Class01.md\)/);assert.equal(f.files.get(record.paths[0]),'Keep edited lesson');
 for(const p of record.paths)f.files.delete(p);const next=await generateClassPages(f.input);assert.equal(next.created,42);assert.match(next.markdown,/\(classes\/Class01.md\)/);
});
