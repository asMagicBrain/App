import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeachPublicationPlan,teachStudentRepositoryName,validTeachStudentRepository} from '../src/teach-publication.mjs';

const course={code:'ROB7103/8103',title:'Robotics',year:'2026',season:'Autumn'};
const edition={number:2,source:'# Robotics\n\n## Overview\n\nWelcome.\n\n## Assessment\n\nNone\n'};

test('display codes remain independent from safe student repository names',()=>{
  assert.equal(teachStudentRepositoryName(course.code),'ROB7103_8103');
  assert(validTeachStudentRepository('ROB7103_8103'));
  assert.equal(validTeachStudentRepository('ROB7103/8103'),false);
});

test('multipage output derives stable pages from one reviewed Student document',()=>{
  const plan=createTeachPublicationPlan({course,edition,destination:'export',format:'multiple'});
  assert.equal(plan.ready,true);assert.equal(plan.editionNumber,2);assert.equal(plan.sectionCount,3);
  assert.deepEqual(plan.pages.map(page=>page.path),['2026-autumn/README.md','2026-autumn/heading-overview.md','2026-autumn/heading-assessment.md']);
  assert(plan.files.some(file=>file.path==='asteach-course.json'));
  assert.equal(plan.target,'ROB7103_8103-2026-autumn-student.zip');
});

test('one-page and GitBook adapters change only the derived output plan',()=>{
  const single=createTeachPublicationPlan({course,edition,destination:'github',format:'single'});
  assert.deepEqual(single.pages.map(page=>page.path),['2026-autumn/README.md']);
  const gitbook=createTeachPublicationPlan({course,edition,destination:'gitbook',format:'multiple'});
  assert(gitbook.files.some(file=>file.path==='.gitbook.yaml'));
  assert(gitbook.files.some(file=>file.path==='SUMMARY.md'));
  assert.equal(edition.source,'# Robotics\n\n## Overview\n\nWelcome.\n\n## Assessment\n\nNone\n');
});

test('empty editions and invalid destinations remain blocked',()=>{
  assert.equal(createTeachPublicationPlan({course,edition:{number:1,source:''}}).ready,false);
  assert.equal(createTeachPublicationPlan({course,edition,destination:'github',repository:'bad/name'}).ready,false);
});
