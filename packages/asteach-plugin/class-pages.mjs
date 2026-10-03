import path from 'node:path';
import {createHash} from 'node:crypto';
import {teachingScheduleBundle} from './schedule.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
// Called only within the native host queue, using physically guarded repository I/O.
export async function generateClassPages({repo,term,calendar,noClassDays,read,writeBatch,checkCreatePaths=async()=>{}}){
 const directory=`${term.year}-${term.season}`,manifestPath=`${directory}/class-pages.json`;
 let pageDirectory=`${directory}/classes`,stored=await read(repo,manifestPath),manifest;
 if(stored){
  try{manifest=JSON.parse(stored.text);}catch{fail('CLASS_PAGES_RECORD_INVALID');}
  if(!exact(manifest,['schemaVersion','phase','signature','paths'])||manifest.schemaVersion!==1||!['creating','ready'].includes(manifest.phase)||!/^[a-f0-9]{64}$/.test(manifest.signature)||!Array.isArray(manifest.paths)||!manifest.paths.length||manifest.paths.length>255||typeof manifest.paths[0]!=='string'||!manifest.paths.every((p,i)=>p===`${directory}${manifest.paths[0].includes('/classes/')?'/classes':''}/Class${String(i+1).padStart(2,'0')}.md`))fail('CLASS_PAGES_RECORD_INVALID');
  // Preserve previous paths, lesson edits and pasted links until that set is removed.
  if(!manifest.paths[0].includes('/classes/'))for(const p of manifest.paths)if(await read(repo,p)){pageDirectory=directory;break;}
 }
 const prefix=path.posix.relative(path.posix.dirname(term.source.paths[0]),pageDirectory);
 const bundle=teachingScheduleBundle(calendar,noClassDays,prefix?prefix.split('/').map(encodeURIComponent).join('/')+'/':'');
 if(!bundle.pages.length||bundle.pages.length>255)fail('CLASS_PAGES_LIMIT');
 const signature=hash(JSON.stringify(bundle.pages.map(({text,...occurrence})=>occurrence)));
 const paths=bundle.pages.map(page=>`${pageDirectory}/${page.name}`);
 await checkCreatePaths(repo,[manifestPath,...paths]);
 if(manifest){
  const existing=[];for(const name of manifest.paths)existing.push(await read(repo,name));
  const count=existing.filter(Boolean).length;
  if(count){
   if(manifest.signature===signature&&JSON.stringify(manifest.paths)!==JSON.stringify(paths))fail('CLASS_PAGES_RECORD_INVALID');
   if(manifest.signature!==signature)fail('CLASS_PAGES_SCHEDULE_CHANGED');
   if(manifest.phase==='ready'&&count!==manifest.paths.length)fail('CLASS_PAGES_INCOMPLETE');
   if(manifest.phase==='ready')return {markdown:bundle.markdown,created:0,reused:count};
  }
  // An interrupted creation can resume; a finished generation starts anew only
  // when every previously generated file is absent. No existing bytes are replaced.
  if(count===0)manifest=null;
 }
 if(!manifest||manifest.signature!==signature){
  for(const name of paths)if(await read(repo,name))fail('CLASS_PAGES_COLLISION');
  manifest={schemaVersion:1,phase:'creating',signature,paths};
  await writeBatch(repo,[{path:manifestPath,baseHash:stored?.sourceHash??null,text:JSON.stringify(manifest,null,2)+'\n'}]);
  stored=await read(repo,manifestPath);
 }
 let created=0,reused=0,chunk=[];
 for(const page of bundle.pages){
  const target=`${pageDirectory}/${page.name}`;
  if(await read(repo,target)){reused++;continue;}
  chunk.push({path:target,baseHash:null,text:page.text});
  if(chunk.length===8){await writeBatch(repo,chunk);created+=chunk.length;chunk=[];}
 }
 if(chunk.length){await writeBatch(repo,chunk);created+=chunk.length;}
 await writeBatch(repo,[{path:manifestPath,baseHash:stored.sourceHash,text:JSON.stringify({...manifest,phase:'ready'},null,2)+'\n'}]);
 return {markdown:bundle.markdown,created,reused};
}
