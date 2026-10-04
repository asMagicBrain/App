import {audienceStructure,audienceHome} from '../../packages/asteach-plugin/audiences.mjs';
import {internalTeachPath} from '../../packages/asteach-plugin/metadata.mjs';
import {generateClassPages} from '../../packages/asteach-plugin/class-pages.mjs';
import {defaultCalendar,validateTermSettings,emptyTeacher} from '../../packages/asteach-plugin/settings.mjs';
import {COURSE_FILE,courseKey,parseCourse,serializeCourse,validateCourse,newTerm,initialDocument} from '../../packages/asteach-plugin/course.mjs';
import {createPackageZip} from '../../packages/desktop-host/src/package-exchange/archive.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
// Host-only service: callers must serialize the complete operation using the host queue.
export function createTeachService({repositories,read,writeBatch,importCourse,prepare,defaults,checkCreatePaths,ensurePair=async()=>{},discover=async()=>[]}){
 async function record(repo){const file=await read(repo,COURSE_FILE);if(!file)return null;const course=parseCourse(file.text),settings={};for(const term of course.terms){const id=`${term.year}-${term.season}`,stored=await read(repo,`${id}/teaching.json`);settings[id]=stored?{hash:stored.sourceHash,value:validateTermSettings(JSON.parse(stored.text))}:null;}const entries=await discover(repo),audiences=Object.fromEntries(course.terms.map(t=>[`${t.year}-${t.season}`,audienceStructure(t,entries)]));return {repo,hash:file.sourceHash,course,settings,audiences};}
 async function list(){const result=[];for(const entry of repositories()){const found=await record(entry.name);if(found)result.push(found);}return result;}
 async function unique(course,except){for(const entry of await list())if(entry.repo!==except&&(entry.course.courseId===course.courseId||courseKey(entry.course.code).toLowerCase()===courseKey(course.code).toLowerCase()))fail('DUPLICATE_COURSE');}
 return async request=>{
  if(exact(request,['operation'])&&request.operation==='defaults')return defaults.get();
  if(exact(request,['operation','expectedRevision','value'])&&request.operation==='setDefaults')return defaults.set(request.expectedRevision,request.value);
  if(exact(request,['operation','repo','year','season','expectedHash','calendar'])&&request.operation==='setCalendar'){
   await prepare(request.repo);const found=await record(request.repo),id=`${request.year}-${request.season}`;
   if(!found?.course.terms.some(t=>t.year===request.year&&t.season===request.season))fail('INVALID_TERM');
   const previous=found.settings[id];if((previous?.hash??null)!==request.expectedHash)fail('CONFLICT');
   const value=validateTermSettings({schemaVersion:1,teacherSnapshot:previous?.value.teacherSnapshot??emptyTeacher(),calendar:request.calendar});
   await writeBatch(request.repo,[{path:`${id}/teaching.json`,baseHash:request.expectedHash,text:JSON.stringify(value,null,2)+'\n'}]);return record(request.repo);
  }

  if(exact(request,['operation','repo','year','season','expectedHash'])&&request.operation==='generateClassPages'){
   await prepare(request.repo);const found=await record(request.repo),id=`${request.year}-${request.season}`;
   const term=found?.course.terms.find(t=>t.year===request.year&&t.season===request.season);
   if(!term)fail('INVALID_TERM');
   const settings=found.settings[id];if(!settings||settings.hash!==request.expectedHash)fail('CONFLICT');
   return generateClassPages({repo:request.repo,term,audiences:found.audiences[id],calendar:settings.value.calendar,noClassDays:defaults.get().value.noClassDays,read,writeBatch,checkCreatePaths});
  }
  if(exact(request,['operation','repo','year','season'])&&['studentReview','editTemplate'].includes(request.operation)){
   await prepare(request.repo);const found=await record(request.repo),term=found?.course.terms.find(t=>t.year===request.year&&t.season===request.season);
   if(!term)fail('INVALID_TERM');
   if(request.operation==='editTemplate'){
    const target='instructor-template.md';if(found.course.terms.some(t=>t.source.paths.includes(target)))fail('INVALID_SOURCE');await checkCreatePaths(request.repo,[target]);let existing;try{existing=await read(request.repo,target);}catch(error){if(error.code==='DRAFT_CONFLICT')return {path:target};throw error;}if(!existing)await writeBatch(request.repo,[{path:target,baseHash:null,text:initialDocument(found.course,defaults.get().value.teacher)}]);return {path:target};
   }
   if(term.source.kind!=='document')fail('STUDENT_SINGLE_DOCUMENT_REQUIRED');
   const structure=found.audiences[`${term.year}-${term.season}`],sourcePath=structure?audienceHome(structure,'instructors'):term.source.paths[0],studentPath=structure?audienceHome(structure,'students'):sourcePath.replace(/[^/]+$/, 'student.md');if(found.course.terms.some(t=>t.source.paths.includes(studentPath)))fail('INVALID_SOURCE');
   const instructor=await read(request.repo,sourcePath),student=await read(request.repo,studentPath);if(!instructor)fail('SOURCE_NOT_FOUND');
   return {sourcePath,studentPath,instructor,student};
  }
  if(exact(request,['operation','repo','year','season','sourceHash','studentHash','text'])&&request.operation==='saveStudent'){
   fail('STUDENT_DESTINATION_REQUIRED');
  }
  if(exact(request,['operation'])&&request.operation==='list')return list();
  if(exact(request,['operation','repo','year','season','number'])&&request.operation==='createClassPackage'){
   await prepare(request.repo);const found=await record(request.repo),id=`${request.year}-${request.season}`,structure=found?.audiences[id];
   if(!structure||!Number.isInteger(request.number)||request.number<1||request.number>255)fail('INVALID_AUDIENCE_STRUCTURE');
   const classId='class'+String(request.number).padStart(2,'0'),student=`${structure.students.root}/classes/${classId}`,instructor=`${structure.instructors.root}/classes/${classId}`;
   const files=[{path:student+'/lesson.md',text:`# Class ${String(request.number).padStart(2,'0')}\n\n## Lesson\n\n## Practice\n`},{path:instructor+'/delivery.md',text:`# ${classId} — Instructor delivery\n\n## Delivery notes\n\n## Questions and expected answers\n`},{path:instructor+'/technical.md',text:`# ${classId} — Technical preparation\n\n## Preparation and verification\n`},{path:student+'/package-manifest.json',text:JSON.stringify({schemaVersion:1,classId,lesson:'lesson.md',files:['lesson.md']},null,2)+'\n'}];
   await checkCreatePaths(request.repo,files.map(f=>f.path));for(const file of files)if(await read(request.repo,file.path))fail('CLASS_PAGES_COLLISION');
   await writeBatch(request.repo,files.map(file=>({...file,baseHash:null})));return {classId,lesson:student+'/lesson.md',delivery:instructor+'/delivery.md'};
  }
  if((exact(request,['operation','requestId','code','name','year','season'])||exact(request,['operation','requestId','code','name','year','season','structureVersion'])&&request.structureVersion===2)&&request.operation==='create'){
   const course=validateCourse({schemaVersion:1,courseId:request.requestId,code:request.code,name:request.name,terms:[newTerm(request.year,request.season,request.structureVersion===2)]});
   const repo=courseKey(course.code)+'_asTeach',existing=(await list()).find(e=>e.course.courseId===course.courseId);
   if(existing){if(serializeCourse(existing.course)!==serializeCourse(course))fail('REQUEST_CONFLICT');await ensurePair(existing);return existing;}
   await unique(course);const bytes=createPackageZip([{path:internalTeachPath(COURSE_FILE),bytes:Buffer.from(serializeCourse(course))},{path:'instructor-template.md',bytes:Buffer.from(initialDocument(course,defaults.get().value.teacher))},{path:course.terms[0].source.paths[0],bytes:Buffer.from(initialDocument(course,defaults.get().value.teacher))},...(course.terms[0].audiences?[{path:audienceHome(course.terms[0].audiences,'students'),bytes:Buffer.from(`# ${course.code} — ${course.name}\n\n`)}]:[]),{path:internalTeachPath(`${request.year}-${request.season}/teaching.json`),bytes:Buffer.from(JSON.stringify({schemaVersion:1,teacherSnapshot:defaults?.get().value.teacher??{},calendar:defaultCalendar()},null,2)+'\n')}]);
   const imported=await importCourse({name:repo,requestId:request.requestId,bytes});const created=await record(imported.name);await ensurePair(created);return created;
  }
  if((exact(request,['operation','repo','expectedHash','year','season'])||exact(request,['operation','repo','expectedHash','year','season','structureVersion'])&&request.structureVersion===2)&&request.operation==='addTerm'){
   await prepare(request.repo);const existing=await record(request.repo);if(!existing||existing.hash!==request.expectedHash)fail('CONFLICT');
   const term=newTerm(request.year,request.season,request.structureVersion===2),course=validateCourse({...existing.course,terms:[...existing.course.terms,term]});
   await writeBatch(request.repo,[{path:COURSE_FILE,baseHash:existing.hash,text:serializeCourse(course)},{path:term.source.paths[0],baseHash:null,text:(await read(request.repo,'instructor-template.md'))?.text??initialDocument(course,existing.settings[`${existing.course.terms[0].year}-${existing.course.terms[0].season}`]?.value.teacherSnapshot)},...(term.audiences?[{path:audienceHome(term.audiences,'students'),baseHash:null,text:`# ${course.code} — ${course.name}\n\n`}]:[]),{path:`${request.year}-${request.season}/teaching.json`,baseHash:null,text:JSON.stringify({schemaVersion:1,teacherSnapshot:existing.settings[`${existing.course.terms[0].year}-${existing.course.terms[0].season}`]?.value.teacherSnapshot??emptyTeacher(),calendar:defaultCalendar()},null,2)+'\n'}]);const updated=await record(request.repo);await ensurePair(updated);return updated;
  }
  if(exact(request,['operation','repo','course'])&&request.operation==='adopt'){
   await prepare(request.repo);if(await record(request.repo))fail('ALREADY_EXISTS');const course=validateCourse(request.course);await unique(course,request.repo);
   for(const term of course.terms)for(const path of term.source.paths)if(!await read(request.repo,path))fail('SOURCE_NOT_FOUND');
   await writeBatch(request.repo,[{path:COURSE_FILE,baseHash:null,text:serializeCourse(course)}]);const adopted=await record(request.repo);await ensurePair(adopted);return adopted;
  }
  fail('INVALID_REQUEST');
 };
}
