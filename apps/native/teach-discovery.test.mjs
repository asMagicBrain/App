import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeachService} from './teach-service.mjs';
import {newTerm,serializeCourse} from '../../packages/asteach-plugin/course.mjs';
test('canonical homes are probed independently of an exhausted repository inventory',async()=>{
 const course={schemaVersion:1,courseId:'11111111-1111-4111-8111-111111111111',code:'TEST101',name:'Synthetic course',terms:[newTerm(2026,'autumn')]};
 const files=new Map([['asteach-course.json',serializeCourse(course)],['2026-autumn/instructors/README.md','# Instructor'],['2026-autumn/students/README.md','# Candidate']]);
 const request=createTeachService({repositories:()=>[{name:'Course'}],read:async(repo,path)=>files.has(path)?{text:files.get(path),sourceHash:'a'.repeat(64)}:null,discover:()=>{throw Error('Whole-tree inventory must not be used');}});
 const result=await request({operation:'list'});
 assert.equal(result[0].course.courseId,course.courseId);
 assert.equal(result[0].audiences['2026-autumn'].instructors.root,'2026-autumn/instructors');
 files.delete('2026-autumn/students/README.md');
 assert.equal((await request({operation:'list'}))[0].audiences['2026-autumn'],null);
});
test('home probes preserve drafts and unsafe probe failures do not select legacy layout',async()=>{
 const course={schemaVersion:1,courseId:'22222222-2222-4222-8222-222222222222',code:'TEST102',name:'Synthetic draft course',terms:[newTerm(2026,'autumn')]};
 const read=async(repo,path)=>{if(path==='asteach-course.json')return {text:serializeCourse(course),sourceHash:'b'.repeat(64)};if(path.endsWith('/README.md'))throw Object.assign(Error('Draft must remain private'),{code:'DRAFT_CONFLICT'});return null;};
 const options={repositories:()=>[{name:'Course'}],read};
 const request=createTeachService({...options,probe:async()=>true});
 assert.equal((await request({operation:'list'}))[0].audiences['2026-autumn'].structureVersion,2);
 const unsafe=createTeachService({...options,probe:async()=>{throw Object.assign(Error('Unsafe home'),{code:'DENIED'});}});
 await assert.rejects(unsafe({operation:'list'}),{code:'DENIED'});
});
