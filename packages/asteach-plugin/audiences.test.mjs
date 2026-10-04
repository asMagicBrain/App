import test from 'node:test';
import assert from 'node:assert/strict';
import {audienceStructure,newAudienceStructure,validateAudiences,audienceHome} from './audiences.mjs';
import {newTerm,validateCourse} from './course.mjs';
test('audience discovery requires both canonical homes and never changes legacy term',()=>{
 const term=newTerm(2026,'autumn'),before=JSON.stringify(term);assert.equal(audienceStructure(term,[{path:'2026-autumn/students/README.md',type:'file'}]),null);
 const roots=audienceStructure(term,['instructors','students'].map(a=>({type:'file',path:`2026-autumn/${a}/README.md`})));assert.equal(roots.structureVersion,2);assert.equal(audienceHome(roots,'students'),'2026-autumn/students/README.md');assert.equal(JSON.stringify(term),before);
});
test('new structure validates exact term boundaries; legacy identity remains supported',()=>{
 const term=newTerm(2026,'autumn',true),course={schemaVersion:1,courseId:'00000000-0000-4000-8000-000000000001',code:'ROB7103/8103',name:'Synthetic',terms:[term]};assert.deepEqual(validateCourse(course),course);
 assert.throws(()=>validateAudiences({...newAudienceStructure(term),students:{root:'2026-autumn/instructors',home:'README.md'}},term),{code:'INVALID_AUDIENCE_STRUCTURE'});
 assert.throws(()=>validateCourse({...course,terms:[{...term,audiences:{...term.audiences,students:{root:'../private',home:'README.md'}}}]}),{code:'INVALID_AUDIENCE_STRUCTURE'});
});
