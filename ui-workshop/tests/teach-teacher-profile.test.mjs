import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from '../node_modules/esbuild/lib/main.js';
import {fileURLToPath} from 'node:url';
import {renderSourcePreview} from '../../apps/desktop/ui/markdown-preview.mjs';
const compiled=await build({entryPoints:[fileURLToPath(new URL('../src/teach-teacher-profile.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false});
const {emptyTeacherProfile,emptyTeacherEmployment,normalizeTeacherProfile,validateTeacherProfile,withTeacherProfileSnapshot,formatTeacherDate}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const employment=()=>({...emptyTeacherEmployment(),organization:'Example University',city:'Abu Dhabi',country:'AE'});

test('optional profile, repeatable values and biography survive without aliasing or truncation',()=>{
  const blank=emptyTeacherProfile();assert.equal(validateTeacherProfile(blank),null);
  const profile={...blank,givenNames:' A single name ',biography:'First line\n\nSecond paragraph',emails:['one@example.invalid','two@example.invalid',''],alsoKnownAs:['別名'],websites:[{description:'Faculty',url:'https://example.invalid/profile'}],countries:['AE','GB'],employment:[employment()]};
  const before=JSON.stringify(profile),saved=normalizeTeacherProfile(profile);
  assert.equal(saved.givenNames,'A single name');assert.equal(saved.biography,profile.biography);assert.equal(saved.emails.length,2);assert.equal(validateTeacherProfile(saved),null);
  saved.employment[0].startDate.year='2020';saved.websites[0].description='Changed';assert.equal(JSON.stringify(profile),before);
  const long={...blank,biography:'x'.repeat(5001)};
  assert.equal(normalizeTeacherProfile(long).biography.length,5001);assert.equal(validateTeacherProfile(long)?.field,'biography');
});

test('reject malformed identifiers, unsafe/duplicate URLs, incomplete affiliations and countries',()=>{
  const base=emptyTeacherProfile();
  for(const [orcidId,valid] of [['0000-0002-1825-0097',true],['0000-0002-1825-0098',false],['0000-0002-1694-233X',true]])assert.equal(validateTeacherProfile({...base,orcidId})===null,valid);
  assert.equal(validateTeacherProfile({...base,emails:['invalid']})?.field,'emails.0');
  for(const url of ['javascript:alert(1)','https://name:password@example.invalid','https://exa mple.invalid'])assert.equal(validateTeacherProfile({...base,websites:[{description:'',url}]})?.field,'websites.0.url');
  assert.equal(validateTeacherProfile({...base,websites:[{description:'Missing URL',url:''}]})?.field,'websites.0.url');
  assert.equal(validateTeacherProfile({...base,websites:[{description:'One',url:'https://example.invalid'},{description:'Two',url:'https://example.invalid/'}]})?.field,'websites.1.url');
  assert.equal(validateTeacherProfile({...base,employment:[{...employment(),city:''}]})?.field,'employment.0.city');
  assert.equal(validateTeacherProfile({...base,countries:['XX']})?.field,'countries.0');
});

test('partial dates preserve precision and reject impossible or definitely reversed dates',()=>{
  const check=(start,end={year:'',month:'',day:''})=>validateTeacherProfile({...emptyTeacherProfile(),employment:[{...employment(),startDate:start,endDate:end}]});
  assert.equal(check({year:'2020',month:'',day:''}),null);assert.equal(formatTeacherDate({year:'2020',month:'',day:''}),'2020');
  assert.equal(check({year:'2020',month:'2',day:'29'}),null);assert(check({year:'2021',month:'2',day:'29'}));assert(check({year:'2020',month:'',day:'2'}));
  assert(check({year:'2025',month:'',day:''},{year:'2024',month:'',day:''}));
  assert.equal(check({year:'2020',month:'6',day:''},{year:'2020',month:'',day:''}),null);
});

test('course snapshots retain independent plain text and never overwrite existing teaching content',()=>{
  const original={id:'test',sections:[{id:'teaching-team',title:'Course Instructor & Teaching Team',source:''},{id:'other',title:'Other',source:'Original bytes\n'}]};
  const profile={...emptyTeacherProfile(),givenNames:'Alex [Example]',biography:'# Plain text\n\n<script>not executable</script>',employment:[employment()]};
  const before=JSON.stringify(original),created=withTeacherProfileSnapshot(original,profile),text=created.sections[0].source;
  assert.equal(JSON.stringify(original),before);assert(text.includes('Alex \\[Example\\]'));assert(text.includes('\\# Plain text'));assert(text.includes('\\<script\\>'));
  assert.equal(created.sections[1].source,'Original bytes\n');
  profile.givenNames='Later teacher';profile.employment[0].organization='Another university';assert.equal(created.sections[0].source,text);
  assert.equal(withTeacherProfileSnapshot(created,profile).sections[0].source,text);
  assert.equal(withTeacherProfileSnapshot(original,emptyTeacherProfile()),original);
});


test('plain biography cannot add headings, links, code blocks or interpreted entities to a new course',()=>{
  const course={sections:[{id:'teaching-team',title:'Teaching team',source:''}]};
  const biography='Literal\n===\n\n    Indented paragraph\n\n\tTabbed paragraph\n\nA &copy; &amp; B\n\n[link](https://example.invalid) <script>text</script>';
  const source=withTeacherProfileSnapshot(course,{...emptyTeacherProfile(),biography}).sections[0].source;
  const rendered=renderSourcePreview(source);
  assert.equal(rendered.headings.length,1);
  assert.doesNotMatch(rendered.html,/<pre|<code|<script|<a /);
  assert.match(rendered.html,/&amp;copy; &amp;amp;/);
});

test('date comparison ignores surrounding and optional whitespace consistently with normalization',()=>{
  const startDate={year:' 2020 ',month:'',day:''};
  for(const endDate of [{year:'2020',month:' ',day:''},{year:' ',month:' ',day:''}]){
    assert.equal(validateTeacherProfile({...emptyTeacherProfile(),employment:[{...employment(),startDate,endDate}]}),null);
  }
});
