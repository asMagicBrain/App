import {validateAudiences,newAudienceStructure} from './audiences.mjs';
import {isPortableRelativePath,portablePathKey} from '../source-foundation/src/domain/path-policy.mjs';
export const COURSE_FILE='asteach-course.json';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const text=v=>typeof v==='string'&&v.isWellFormed()&&v.trim()===v&&v.length>0&&v.length<=240&&!/[\x00-\x1f]/.test(v);
export function courseKey(code){
 if(typeof code!=='string'||code.length>32||!/^[A-Za-z0-9][A-Za-z0-9_\/-]*$/.test(code))fail('INVALID_COURSE_CODE');
 const key=code.replaceAll('/','_');if(!isPortableRelativePath(key)||key.includes('/'))fail('INVALID_COURSE_CODE');return key;
}
export function termId(year,season){if(!Number.isInteger(year)||year<1949||year>2100||!['spring','summer','autumn','winter'].includes(season))fail('INVALID_TERM');return `${year}-${season}`;}
export function validateCourse(value){
 if(!exact(value,['schemaVersion','courseId','code','name','terms'])||value.schemaVersion!==1)fail('COURSE_SCHEMA_UNSUPPORTED');
 if(typeof value.courseId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.courseId)||!text(value.name))fail('INVALID_COURSE');courseKey(value.code);
 if(!Array.isArray(value.terms)||!value.terms.length||value.terms.length>128)fail('INVALID_TERM');
 const ids=new Set(),paths=new Set();
 for(const term of value.terms){
  if(!exact(term,['year','season','source'])&&!exact(term,['year','season','source','audiences']))fail('INVALID_TERM');const id=termId(term.year,term.season);if(ids.has(id))fail('DUPLICATE_TERM');ids.add(id);
  if(Object.hasOwn(term,'audiences')){validateAudiences(term.audiences,term);if(term.source?.kind!=='document'||term.source.paths?.[0]!==term.audiences.instructors.root+'/README.md')fail('INVALID_SOURCE');}
  const source=term.source;
  if(!exact(source,['kind','paths'])||!['document','legacy'].includes(source.kind)||!Array.isArray(source.paths)||!source.paths.length||source.paths.length>64||source.kind==='document'&&source.paths.length!==1)fail('INVALID_SOURCE');
  for(const p of source.paths){if(typeof p!=='string'||!isPortableRelativePath(p)||!p.toLowerCase().endsWith('.md')||p.split('/').some(s=>s.startsWith('.')))fail('INVALID_SOURCE');const key=portablePathKey(p);if(paths.has(key))fail('DUPLICATE_SOURCE');paths.add(key);}
 }
 return structuredClone(value);
}
export function parseCourse(text){if(typeof text!=='string'||Buffer.byteLength(text)>65536)fail('INVALID_COURSE');let value;try{value=JSON.parse(text);}catch{fail('INVALID_COURSE');}return validateCourse(value);}
export function serializeCourse(value){const text=JSON.stringify(validateCourse(value),null,2)+'\n';if(Buffer.byteLength(text)>65536)fail('INVALID_COURSE');return text;}
export function newTerm(year,season,audiences=false){const term={year,season,source:{kind:'document',paths:[`${termId(year,season)}/instructor.md`]}};if(audiences){term.audiences=newAudienceStructure(term);term.source.paths=[`${termId(year,season)}/instructors/README.md`];}return term;}
export function initialDocument(course,teacher){
 const headings=['Course Description','Teaching Goals','Learning Outcomes','Content Summary','Assumed Knowledge','Co-Requisite Courses','Course Instructor & Teaching Team','Grading Policy','Academic Integrity','University Calendar','Recommended Textbook(s)','Teaching Schedule','Important Deadlines'];
 const plain=value=>String(value).replace(/[\\`*_{}\[\]()#+.!<>|~=&-]/g,'\\$&').replace(/\r?\n/g,'  \n  ');
 const rows=teacher?[
  ['Given names',teacher.givenNames],['Family names',teacher.familyNames],['Published name',teacher.publishedName],['ORCID iD (unverified)',teacher.orcidId],
  ['Email addresses',teacher.emails.join('\n')],['Websites',teacher.websites.map(w=>[w.description,w.url].filter(Boolean).join(' — ')).join('\n')],
  ['Biography',teacher.biography],['Also known as',teacher.alsoKnownAs.join(', ')],['Keywords',teacher.keywords.join(', ')],['Countries',teacher.countries.join(', ')],
  ...teacher.employment.map((e,i)=>[`Employment ${i+1}`,[e.roleTitle,e.department,e.organization,e.city,e.region,e.country,e.link].filter(Boolean).join(', ')])
 ].filter(([,value])=>value):[];
 const team=rows.map(([label,value])=>`- **${label}:** ${plain(value)}`).join('\n');
 return `# ${plain(course.code)} — ${plain(course.name)}\n\n`+headings.map(title=>`## ${title}\n\n${title==='Course Instructor & Teaching Team'&&team?team+'\n\n':''}`).join('');
}
// Version 1 is the first durable format. Unknown schemas require an explicit future migration.
export const migrateCourse=validateCourse;
