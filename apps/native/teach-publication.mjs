import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {studentReferences,rewriteStudentLinks,convertGitBookMarkdown,rewriteGitBookAnchors,studentNavigation} from './dist-host/offline-reader.mjs';
import {pinDirectory,checkDirectory,checkSourceSpelling} from '../../packages/desktop-host/src/physical-roots.mjs';
import {openRawFile} from '../../packages/desktop-host/src/local-git/raw-file.mjs';
import {safePath,createPackageZip} from '../../packages/desktop-host/src/package-exchange/archive.mjs';
import {exportExcludedReason} from '../../packages/desktop-host/src/package-exchange/export-policy.mjs';
const fail=(code,detail)=>{throw Object.assign(Error(detail?`${code}: ${detail}`:code),{code});};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const allowed=/\.(?:md|markdown|png|jpe?g|gif|webp|pdf|txt|csv)$/i;
// No repository code is executed. All reads are physically checked and bounded.
export function readPublicationFile(root,relative){
 if(!safePath(relative))fail('PUBLICATION_PATH');checkDirectory(root);checkSourceSpelling(root.path,relative);
 const parents=[root];let parent=root;
 for(const part of relative.split('/').slice(0,-1)){parent=pinDirectory(path.join(parent.path,part));parents.push(parent);}
 const file=openRawFile(path.join(root.path,relative),8*1024*1024);
 try{const bytes=Buffer.alloc(file.size);let offset=0;while(offset<bytes.length){const n=fs.readSync(file.fd,bytes,offset,bytes.length-offset,offset);if(!n)fail('CONFLICT');offset+=n;}file.verify();for(const pin of parents)checkDirectory(pin);return bytes;}finally{file.close();}
}
export function buildStudentPublication({root,term,studentPath,forbidden,selectedPages,studentText,convertGitBook=false,homeAliases={}}){
 const folder=`${term.year}-${term.season}`,base=path.posix.dirname(studentPath);
 if(base===folder+'/students')return buildAudiencePublication({root,folder,studentPath,studentText,convertGitBook});
 if(base!==folder)fail('PUBLICATION_LAYOUT');
 if(selectedPages!==undefined&&(!Array.isArray(selectedPages)||selectedPages.length>125||selectedPages.some(p=>typeof p!=='string'||!safePath(p)||! /\.(md|markdown)$/i.test(p))||new Set(selectedPages).size!==selectedPages.length))fail('INVALID_REQUEST');
 const approved=new Set([studentPath,...(selectedPages??[]).filter(p=>!homeAliases[p]&&p!==folder+'/SUMMARY.md')]);
 const normalized=new Map(),conversions=[];
 const files=[],visited=new Set(),warnings=new Set(),queue=[...approved];let total=0;
 if(Object.keys(homeAliases).length)warnings.add('An identical course README is represented by the Student home, without a duplicate page.');
 while(queue.length){
  const relative=queue.shift();if(visited.has(relative))continue;
  if(!(relative.startsWith(folder+'/')||relative.startsWith('shared/assets/')&&!/\.(md|markdown)$/i.test(relative))||!safePath(relative)||!allowed.test(relative)||forbidden.some(p=>p.toLowerCase()===relative.toLowerCase())||exportExcludedReason(relative)||/(^|\/)(?:instructor(?:-template)?|teacher|private)(?:\.|\/)/i.test(relative))fail('PUBLICATION_PRIVATE_LINK');
  if(visited.size>=128)fail('LIMIT_EXCEEDED');visited.add(relative);
  let bytes;try{bytes=relative===studentPath&&studentText!==undefined?Buffer.from(studentText):readPublicationFile(root,relative);}catch(error){if(['ENOENT','PARTIAL','NOT_FOUND'].includes(error.code))fail('PUBLICATION_MISSING_LINK');throw error;}
  total+=bytes.length;if(total>32*1024*1024)fail('LIMIT_EXCEEDED');files.push({path:relative,bytes,hash:hash(bytes)});
  if(!/\.(?:md|markdown)$/i.test(relative))continue;
  let source;try{source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('PUBLICATION_ENCODING');}
  if(convertGitBook){const result=convertGitBookMarkdown(source);normalized.set(relative,result);if(result.text!==source){conversions.push({path:relative,changes:result.changes,original:source.slice(0,16000)});source=result.text;}source=rewriteGitBookAnchors(source,relative,normalized,homeAliases);fileBytes(source);}
  function fileBytes(text){const file=files[files.length-1];file.bytes=Buffer.from(text);file.hash=hash(file.bytes);}
  const refs=studentReferences(source,relative);
  if(refs.comments)warnings.add('Source comments are included. Review them for private information.');
  if(refs.external)warnings.add('External links stay external; remote assets are not downloaded.');
  if(/vscode-resource|vscode-file:/i.test(source))warnings.add('VSCode resource links are not portable. Repair these links before sharing.');
  if(refs.htmlLinks)fail('PUBLICATION_HTML_LINK');if(refs.invalid)fail('PUBLICATION_PATH');
  for(const rawTarget of refs.paths){
   const target=homeAliases[rawTarget]??rawTarget;
   if(!(target.startsWith(folder+'/')||target.startsWith('shared/assets/')&&!/\.(md|markdown)$/i.test(target))||forbidden.includes(target)||/(^|\/)(?:instructor(?:-template)?|teacher|private)(?:\.|\/)/i.test(target))fail('PUBLICATION_PRIVATE_LINK');
   if(/\.(md|markdown)$/i.test(target)&&selectedPages!==undefined&&!approved.has(target))fail('PUBLICATION_PAGE_NOT_SELECTED');
   queue.push(target);
  }
 }
 for(const file of files){if(!/\.(md|markdown)$/i.test(file.path))continue;let text=file.bytes.toString('utf8');if(convertGitBook)text=rewriteGitBookAnchors(text,file.path,normalized,homeAliases);text=rewriteStudentLinks(text,file.path,file.path,homeAliases);file.bytes=Buffer.from(text);file.hash=hash(file.bytes);}
 const destinations=Object.fromEntries(files.filter(f=>f.path.startsWith('shared/assets/')).map(f=>[f.path,`${folder}/assets/shared/${f.path.slice('shared/assets/'.length)}`]));
 const keys=new Set();
 for(const file of files){
  const original=file.path;file.path=destinations[original]??original;
  if(keys.has(file.path.normalize('NFC').toLowerCase()))fail('PUBLICATION_COLLISION');keys.add(file.path.normalize('NFC').toLowerCase());
  if(/\.(md|markdown)$/i.test(original)&&Object.keys(destinations).length){
   const text=rewriteStudentLinks(file.bytes.toString('utf8'),original,file.path,destinations);
   if(studentReferences(text,file.path).paths.some(p=>p.startsWith('shared/')))fail('PUBLICATION_REWRITE_REQUIRED');
   file.bytes=Buffer.from(text);file.hash=hash(file.bytes);
  }
 }
 const markdown=files.filter(file=>/\.(?:md|markdown)$/i.test(file.path));
 let sourceSummary='';try{sourceSummary=readPublicationFile(root,folder+'/SUMMARY.md').toString('utf8');}catch(error){if(!['ENOENT','PARTIAL','NOT_FOUND'].includes(error.code))throw error;}
 const summary=studentNavigation({folder,studentPath,homeAliases,sourceSummary,documents:markdown.map(file=>({path:file.path,title:normalized.get(file.path)?.title??/^#{1,6}\s+(.+)$/m.exec(file.bytes.toString('utf8'))?.[1]}))});
 for(const [name,text] of [['SUMMARY.md',summary],['.gitbook.yaml','root: ./\nstructure:\n  readme: student.md\n  summary: SUMMARY.md\n']]){
  const target=`${folder}/${name}`;if(visited.has(target))fail('PUBLICATION_COLLISION');const bytes=Buffer.from(text);files.push({path:target,bytes,hash:hash(bytes),generated:true});
 }
 if(files.reduce((sum,file)=>sum+file.bytes.length,0)>32*1024*1024||files.some(file=>/\.(md|markdown)$/i.test(file.path)&&file.bytes.length>1024*1024))fail('LIMIT_EXCEEDED');
 return {folder,files,warnings:[...warnings],conversions};
}
// Complete candidate-root review: no inferred Instructor siblings, recursive
// private-repository mirror, code execution or silently omitted dependencies.
export function buildAudiencePublication({root,folder,studentPath,studentText,convertGitBook}){
 const prefix=folder+'/students/',files=[],warnings=new Set(),conversions=[];let total=0;
 const packageType=/\.(?:md|markdown|png|jpe?g|gif|webp|svg|pdf|txt|csv|tsv|jsonl?|ya?ml|toml|ini|cfg|xml|urdf|mjcf|obj|stl|mtl|onnx|npy|npz|py|sh|mp4|webm|mov|wav|mp3)$/i;
 const denied=/(^|\/)(?:\.git|\.venv|venv|node_modules|__pycache__|\.cache|cache|runtime|instructors|private|solutions|raw-private)(\/|$)/i;
 const walk=relative=>{
  if(denied.test(relative)||exportExcludedReason(relative))fail('PUBLICATION_PRIVATE_LINK');
  checkDirectory(root);checkSourceSpelling(root.path,relative);const directory=pinDirectory(path.join(root.path,relative));
  for(const name of fs.readdirSync(directory.path).sort()){
   const target=relative+'/'+name;if(!safePath(target)||denied.test(target)||exportExcludedReason(target))fail('PUBLICATION_PRIVATE_LINK');
   const stat=fs.lstatSync(path.join(root.path,target));if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())fail('PUBLICATION_PATH');
   if(stat.isDirectory()){walk(target);continue;}
   if(!packageType.test(target)&&!/(^|\/)(?:[A-Za-z0-9_-]+-)?(?:LICENSE|LICENCE|NOTICE)(?:\.[A-Za-z]+)?$/i.test(target)&&!/(^|\/)\.gitignore$/.test(target))fail('PUBLICATION_UNSUPPORTED_ASSET');
   if(files.length>=4096)fail('LIMIT_EXCEEDED');
   let bytes=target===studentPath&&studentText!==undefined?Buffer.from(studentText):readPublicationFile(root,target);
   total+=bytes.length;if(total>128*1024*1024)fail('LIMIT_EXCEEDED');
   if(/\.(?:md|markdown)$/i.test(target)){
    let source;try{source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('PUBLICATION_ENCODING');}
    if(convertGitBook){const result=convertGitBookMarkdown(source);if(result.text!==source)conversions.push({path:target,changes:result.changes,original:source.slice(0,16000)});source=result.text;}
    const refs=studentReferences(source,target);if(refs.invalid||refs.htmlLinks)fail('PUBLICATION_PATH');
    if(refs.paths.some(p=>!p.startsWith(prefix)||denied.test(p)))fail('PUBLICATION_PRIVATE_LINK');
    if(refs.comments)warnings.add('Source comments are included. Review them for private information.');
    if(refs.external)warnings.add('External links remain external. Check availability and access before delivery.');
    bytes=Buffer.from(source);
   }
   const destination=folder+'/'+target.slice(prefix.length),kind=/\.(?:py|sh|jsonl?|ya?ml|xml|urdf|mjcf|svg|obj|mtl|txt|csv|toml|ini|cfg)$/i.test(target)?'code':'asset';
   files.push({path:destination,sourcePath:target,bytes,hash:hash(bytes),kind});
  }
  checkDirectory(directory);
 };
 walk(prefix.slice(0,-1));
 if(!files.some(f=>f.sourcePath===studentPath))fail('PUBLICATION_STUDENT_REQUIRED');
 const sourceFiles=new Set(files.map(f=>f.sourcePath));
 for(const file of files.filter(f=>/\.(md|markdown)$/i.test(f.path)))if(studentReferences(file.bytes.toString('utf8'),file.sourcePath).paths.some(p=>!sourceFiles.has(p)))fail('PUBLICATION_MISSING_LINK');
 for(const file of files.filter(f=>f.kind==='code')){
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(file.bytes);}catch{fail('PUBLICATION_ENCODING');}
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b|\bAKIA[0-9A-Z]{16}\b/.test(text))fail('PROMOTION_SECRET');
  if(/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)|(?:^|[\/"'\s])instructors[\/]/im.test(text))fail('PUBLICATION_PRIVATE_LINK');
  const dependencies=[];
  if(/\.(xml|urdf|mjcf|svg)$/i.test(file.path))for(const m of text.matchAll(/\b(?:file|href)\s*=\s*["']([^"']+)["']/g))if(!/^(?:https?:|#)/i.test(m[1]))dependencies.push(m[1]);
  if(/\.(py|sh|toml|json|ya?ml)$/i.test(file.path)&&!file.path.endsWith('/package-manifest.json'))for(const m of text.matchAll(/["']([^"'\r\n]+\.(?:xml|urdf|mjcf|obj|stl|onnx|npy|npz|csv|json))["']/g)){const before=text.slice(Math.max(0,m.index-80),m.index);if(/\.(py|sh)$/i.test(file.path)&&(/[$\{]/.test(m[1])||/(?:\[\s*|\/\s*|(?:join|with_name)\s*\([^\n]*|(?:default|dest)\s*=\s*)$/.test(before))){warnings.add('Computed code paths require runtime verification in a separate environment; static packaging does not certify them.');continue;}dependencies.push(m[1]);}
  if(/\.obj$/i.test(file.path))for(const m of text.matchAll(/^mtllib\s+(.+)$/gm))dependencies.push(m[1].trim());
  for(const dependency of dependencies){const target=path.posix.normalize(path.posix.join(path.posix.dirname(file.sourcePath),dependency));if(path.posix.isAbsolute(dependency)||dependency.includes('\\')||!target.startsWith(prefix)||!sourceFiles.has(target))fail('PROMOTION_DEPENDENCY',`${file.sourcePath} → ${dependency}`);}
  if(file.path.endsWith('/package-manifest.json')){
   let manifest;try{manifest=JSON.parse(text);}catch{fail('PUBLICATION_MANIFEST');}
   const entries=Array.isArray(manifest.files)?manifest.files.map(p=>[p,null]):manifest.files&&typeof manifest.files==='object'?Object.entries(manifest.files):null;
   if(!entries)fail('PUBLICATION_MANIFEST');
   for(const [relative,digest] of entries){if(typeof relative!=='string'||!safePath(relative))fail('PUBLICATION_MANIFEST');const target=path.posix.dirname(file.sourcePath)+'/'+relative,item=files.find(f=>f.sourcePath===target);if(!item)fail('PUBLICATION_MISSING_LINK');if(digest!==null&&(!/^[a-f0-9]{64}$/.test(digest)||digest!==item.hash))fail('PUBLICATION_MANIFEST_STALE');}
  }
 }
 // A whole-root translation leaves class-relative code/media paths unchanged.
 // Existing SUMMARY is canonical and must resolve entirely within this output.
 if(!files.some(f=>f.path===folder+'/SUMMARY.md')){const bytes=Buffer.from(studentNavigation({folder,studentPath:folder+'/README.md',homeAliases:{},sourceSummary:'',documents:files.filter(f=>/\.(md|markdown)$/i.test(f.path)).map(f=>({path:f.path,title:/^#{1,6}\s+(.+)$/m.exec(f.bytes.toString('utf8'))?.[1]}))}));files.push({path:folder+'/SUMMARY.md',bytes,hash:hash(bytes),generated:true});}
 if(files.some(f=>f.path===folder+'/.gitbook.yaml'))fail('PUBLICATION_COLLISION');
 const bytes=Buffer.from('root: ./\nstructure:\n  readme: README.md\n  summary: SUMMARY.md\n');files.push({path:folder+'/.gitbook.yaml',bytes,hash:hash(bytes),generated:true});
 warnings.add('Complete Student candidate root included. Source code is packaged as data and has not been executed or certified runnable.');
 return {folder,homePath:folder+'/README.md',files,warnings:[...warnings],conversions};
}
export function createTeachPublication({context,destinations,copy,compare,build=buildStudentPublication}){
 const plans=new Map();
 async function materialize(input){const ctx=await context(input);const output=build(ctx);return {ctx,output};}
 return {
  async review(input){
   const {ctx,output}=await materialize(input);const available=await destinations(input.repo);let target=null;
   if(input.destination!==null){target=available.find(item=>item.name===input.destination);if(!target)fail('PUBLICATION_DESTINATION');}
   const comparison=target&&compare?await compare(target.name,output,ctx):null;
   const planId=randomUUID(),fingerprint=JSON.stringify({source:ctx.identity,record:ctx.recordHash,destination:target,files:output.files.map(f=>[f.path,f.hash])});
   for(const [id,p] of plans)if(p.expiresAt<Date.now())plans.delete(id);if(plans.size>=8)plans.delete(plans.keys().next().value);
   plans.set(planId,{input:{...input},fingerprint,comparison,expiresAt:Date.now()+300000});
   return {planId,comparison,folder:output.folder,destination:target,files:output.files.map(f=>({path:f.path,sourcePath:f.sourcePath??f.path,bytes:f.bytes.length,sha256:f.hash,generated:Boolean(f.generated),preview:(f.kind==='code'||f.kind==='document'||/\.md$/i.test(f.path))?f.bytes.toString('utf8').slice(0,16000):null})),warnings:output.warnings,conversions:output.conversions};
  },
  async finish(planId,kind){
   const plan=plans.get(planId);plans.delete(planId);if(!plan||plan.expiresAt<Date.now())fail('PUBLICATION_EXPIRED');
   const {ctx,output}=await materialize(plan.input),available=await destinations(plan.input.repo),target=plan.input.destination===null?null:available.find(item=>item.name===plan.input.destination);
   if(plan.fingerprint!==JSON.stringify({source:ctx.identity,record:ctx.recordHash,destination:target,files:output.files.map(f=>[f.path,f.hash])}))fail('CONFLICT');
   if(kind==='zip'&&target===null)return {filename:`${output.folder}-student.zip`,bytes:createPackageZip(output.files)};
   if(kind==='copy'&&target)return copy(target.name,output,ctx,plan.comparison);
   fail('INVALID_REQUEST');
  },
  cancel(planId){plans.delete(planId);return {cancelled:true};},
 };
}
