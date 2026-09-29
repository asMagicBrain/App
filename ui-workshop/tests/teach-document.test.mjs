import test from 'node:test';
import assert from 'node:assert/strict';
import {localLink} from '../../apps/desktop/ui/markdown-preview.mjs';
import {renderTeachSource} from '../src/teach-content.mjs';
import {createTeachInstructorDocument,splitTeachStudentSections,composeTeachStudentSource,rebaseTeachSource,inspectTeachStudentDependencies,teachDocumentSections} from '../src/teach-document.mjs';

const course=overrides=>({id:'example-2026',code:'EX101',title:'Example course',year:'2026',season:'Autumn',sections:[],...overrides});
const section=(id,title,source,path=`course/.gitbook/includes/${id}.md`)=>({id,title,source,path});
const selectedSource=source=>{const sections=splitTeachStudentSections(source);return composeTeachStudentSource(sections,sections.map(item=>item.id));};

test('new courses get one term-scoped document and editable blank heading scaffolding',()=>{
  const input=course(),before=JSON.stringify(input),document=createTeachInstructorDocument(input);
  assert.equal(document.path,'2026-autumn/instructor.md');
  assert.equal(JSON.stringify(input),before);
  const sections=splitTeachStudentSections(document.source),blank=sections.filter(item=>item.recognized);
  assert.deepEqual(blank.map(item=>item.id),teachDocumentSections.map(item=>item.id));
  assert(blank.every(item=>item.empty));
  assert.equal(selectedSource(document.source),'# EX101 · Example course\n\n');
  assert.equal(composeTeachStudentSource(sections,[]),'','Selection never defaults to all content.');
  const later=createTeachInstructorDocument(course({id:'example-2027',year:'2027'}));
  assert.equal(later.path,'2027-autumn/instructor.md');
  assert.notStrictEqual(later,document);
});

test('historical home is preserved byte-for-byte including all nonstandard content',()=>{
  const source='\uFEFF---\r\nprivate: preserved\r\n---\r\n# Course\r\n\r\n## Course Description\r\nOriginal.\r\n\r\n## Unknown workshop\r\nExtra content.\r\n\r\n## Project archive\r\n![x](../shared/old.png)\r\n';
  const input=course({sections:[section('course-description','Course Description','Excerpt is not the document.')],reference:{home:{kind:'document',path:'course/2022/readme.md',source},pages:[]}});
  const result=createTeachInstructorDocument(input);
  assert.equal(result.source,source);assert.equal(result.path,'course/2022/readme.md');
  const slices=splitTeachStudentSections(source);
  assert.equal(slices.map(item=>item.source).join(''),source);
  assert.equal(selectedSource(source),source);
  assert(slices.some(item=>item.title==='Unknown workshop'));
  assert(slices.some(item=>item.title==='Project archive'));
});

test('section review ignores fenced, indented, quoted and metadata fake headings',()=>{
  const source='---\ntitle: Course\nnotes: |\n  ## Grading Policy\n---\n# Course\n\n## Course Description\n\n```md\n## Teaching Goals\n```\n\n~~~\n## Learning Outcomes\n~~~\n\n    ## Assumed Knowledge\n\n> ## Grading Policy\n\n## Important Deadlines\n\nNone\n';
  const sections=splitTeachStudentSections(source);
  assert.deepEqual(sections.filter(item=>item.recognized).map(item=>item.id),['course-description','important-deadlines']);
  assert.equal(sections.map(item=>item.source).join(''),source);
  assert.equal(selectedSource(source),source);
});

test('blank recognized headings are omitted; None, unknown and nested content survive',()=>{
  const source='# Course\n\n## Teaching Goals ##\n\nLearning Outcomes\n-----------------\n\nNone\n\n## Unknown empty heading\n\n## Assumed Knowledge\n\n### Bring a sketchbook\n\n## Important Deadlines\n\n';
  const sections=splitTeachStudentSections(source),output=selectedSource(source);
  assert.equal(sections.find(item=>item.id==='teaching-goals').empty,true);
  assert.equal(sections.find(item=>item.id==='learning-outcomes').empty,false);
  assert.equal(sections.find(item=>item.id==='assumed-knowledge').empty,false);
  assert(!output.includes('Teaching Goals'));
  assert(!output.includes('Important Deadlines'));
  assert(output.includes('None'));assert(output.includes('Unknown empty heading'));assert(output.includes('Bring a sketchbook'));
});

test('duplicate headings receive separate IDs and selecting one cannot publish the other',()=>{
  const source='## Teaching Goals\n\nReviewed.\n\n## Teaching Goals\n\nPrivate.\n\n## Notes\n\nA.\n\n## Notes\n\nB.\n';
  const sections=splitTeachStudentSections(source);
  assert.deepEqual(sections.map(item=>item.id),['teaching-goals','teaching-goals-2','heading-notes','heading-notes-2']);
  assert.equal(composeTeachStudentSource(sections,['teaching-goals']),'## Teaching Goals\n\nReviewed.\n\n');
});

test('assembled includes retain home extra content and resolve assets from original source paths',()=>{
  const homeSource='---\ndescription: Term\n---\n\n# Course\n\nIntro retained.\n\n## University Calendar\n\n{% include ".gitbook/includes/calendar.md" %}\n\n## Extra home material\n\nRetained after include.\n';
  const original='---\ntitle: calendar\n---\n\n![Calendar](../assets/calendar.png)\n\n[Reading](../../reading.md#week-one)\n\n<figure><img src="../assets/calendar.png" alt="Calendar"><figcaption>Caption</figcaption></figure>\n';
  const input=course({sections:[section('university-calendar','University Calendar',original,'course/.gitbook/includes/calendar.md')],reference:{home:{kind:'composed',path:'course/README.md',source:homeSource},pages:[],assets:{'course/.gitbook/assets/calendar.png':'/__asteach-reference/assets/calendar.png'}}});
  const before=JSON.stringify(input),document=createTeachInstructorDocument(input);
  assert.equal(JSON.stringify(input),before);
  assert(document.source.includes('Intro retained.'));assert(document.source.includes('Retained after include.'));
  assert(!document.source.includes('{% include'));assert(!document.source.includes('title: calendar'));
  assert(document.source.includes('![Calendar](.gitbook/assets/calendar.png)'));
  assert(document.source.includes('[Reading](reading.md#week-one)'));
  assert.equal(document.parts[0].originalSource,original);
  assert.equal(document.parts[0].originalPath,'course/.gitbook/includes/calendar.md');
  const rendered=renderTeachSource(document.source,document.path,input.reference.assets);
  assert.equal((rendered.html.match(/src="\/__asteach-reference\/assets\/calendar.png"/g)??[]).length,2);
  assert(!document.source.includes('/__asteach-reference/'),'Mapped runtime URLs never enter document bytes.');
});

test('composition preserves unmatched includes and does not expand includes inside code',()=>{
  const source='# Course\n\n```md\n{% include ".gitbook/includes/teaching-goals.md" %}\n```\n\n{% include "missing.md" %}\n';
  const original=section('teaching-goals','Teaching Goals','None\n');
  const document=createTeachInstructorDocument(course({sections:[original],reference:{home:{kind:'composed',path:'course/README.md',source},pages:[]}}));
  assert(document.source.startsWith(source));
  assert(document.source.endsWith('## Teaching Goals\n\nNone\n\n'));
  assert.equal(inspectTeachStudentDependencies(document.source,document.path).filter(item=>item.kind==='include').length,1);
});

test('source rebasing preserves fenced and inline code, external URLs and encoded path identity',()=>{
  const source='![Image](<../assets/a b(1).png> "Caption")\n\n[Read][reading]\n\n[reading]: ../../guide.md#step-1 "Title"\n\n`[not a link](../private.md)`\n\n```md\n![not an image](../private.png)\n```\n\n[External](https://example.invalid/a)\n';
  const output=rebaseTeachSource(source,'course/.gitbook/includes/body.md','course/README.md');
  assert(output.includes('<.gitbook/assets/a%20b%281%29.png> "Caption"'));
  assert(output.includes('[reading]: guide.md#step-1 "Title"'));
  assert(output.includes('`[not a link](../private.md)`'));
  assert(output.includes('![not an image](../private.png)'));
  assert(output.includes('https://example.invalid/a'));
  assert.deepEqual(localLink('.gitbook/assets/a%20b%281%29.png','course/README.md'),localLink('../assets/a%20b(1).png','course/.gitbook/includes/body.md'));
});

test('synthetic legacy sections become a coherent hierarchy without modifying input records',()=>{
  const original=section('course-description','Course Description','# Course Description\n\nBody.\n\n## Details\n\n![Image](../assets/a.png)\n','2026-autumn/Teacher/.gitbook/includes/course-description.md');
  const input=course({sections:[original]}),before=JSON.stringify(input),result=createTeachInstructorDocument(input);
  assert.equal(JSON.stringify(input),before);
  assert(result.source.includes('## Course Description\n\nBody.\n\n### Details'));
  assert(result.source.includes('Teacher/.gitbook/assets/a.png'));
});

test('same reference labels in separate includes retain their independent destinations',()=>{
  const first=section('course-description','Course Description','[Read][guide]\n\n![guide][]\n\n[guide]: ../assets/one.png "First"\n');
  const second=section('teaching-goals','Teaching Goals','[Read][guide]\n\n[guide]\n\n[guide]: ../assets/two.png "Second"\n');
  const result=createTeachInstructorDocument(course({sections:[first,second]}));
  const dependencies=inspectTeachStudentDependencies(result.source,result.path);
  const targets=dependencies.filter(item=>item.kind==='link').map(item=>item.path);
  assert(targets.includes('course/.gitbook/assets/one.png'));
  assert(targets.includes('course/.gitbook/assets/two.png'));
  assert(dependencies.some(item=>item.kind==='image'&&item.path==='course/.gitbook/assets/one.png'));
  assert.equal(first.source,'[Read][guide]\n\n![guide][]\n\n[guide]: ../assets/one.png "First"\n');
});

test('review candidate and past edition bytes remain independent of edits and other terms',()=>{
  let saved='# Course\n\n## Course Description\n\nSaved only.\n\n## Instructor planning\n\nPrivate.\n';
  const snapshot=splitTeachStudentSections(saved),edition=Object.freeze({termId:'2026',source:composeTeachStudentSource(snapshot,['course-description'])});
  const draft=saved.replace('Saved only.','Unsaved replacement.');
  assert(!edition.source.includes('Unsaved'));assert(!edition.source.includes('Private'));
  saved=draft;
  const next=composeTeachStudentSource(splitTeachStudentSections(saved),['course-description']);
  assert(next.includes('Unsaved replacement.'));
  assert(edition.source.includes('Saved only.'));
  assert(snapshot.find(item=>item.id==='course-description').source.includes('Saved only.'));
  const otherTerm=composeTeachStudentSource(splitTeachStudentSections('## Course Description\n\nOther term.\n'),['course-description']);
  assert(otherTerm.includes('Other term.'));assert(!edition.source.includes('Other term.'));
});

test('dependency review reports only evidence it has and flags definitions removed by selection',()=>{
  const source='## Course Description\n\n![Mapped](assets/a.png) ![Missing](assets/b.png)\n\n[Read](notes.md) [Remote](https://example.invalid) [Required][private-ref]\n\n## Instructor planning\n\n[private-ref]: private.md\n';
  const selected=composeTeachStudentSource(splitTeachStudentSections(source),['course-description']);
  const dependencies=inspectTeachStudentDependencies(selected,'term/instructor.md',{'term/assets/a.png':'/__asteach-reference/assets/a.png','term/assets/b.png':'https://example.invalid/b.png'});
  assert(dependencies.some(item=>item.target==='assets/a.png'&&item.status==='Mapped reference image; redistribution not checked'));
  assert(dependencies.some(item=>item.target==='assets/b.png'&&item.status==='Local image; availability not verified'));
  assert(dependencies.some(item=>item.target==='notes.md'&&item.status==='Local link; destination not verified'));
  assert(dependencies.some(item=>item.target==='https://example.invalid'&&item.status==='External destination; not fetched'));
  assert(dependencies.some(item=>item.target==='private-ref'&&item.status==='Unresolved reference label'));
  assert(!inspectTeachStudentDependencies(source,'term/instructor.md').some(item=>item.kind==='reference'));
  assert.equal(inspectTeachStudentDependencies('`[Example][missing]`\n\n```md\n[Example][missing]\n```','term/instructor.md').length,0);
  const shortcuts=inspectTeachStudentDependencies('[short]\n\n[collapsed][]\n\n![image]\n','term/instructor.md');
  assert.deepEqual(shortcuts.map(item=>item.target),['short','collapsed','image']);
  assert(shortcuts.every(item=>item.kind==='reference'&&!item.path));
});
