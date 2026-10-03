import path from 'node:path';
import {createHash} from 'node:crypto';
import {readPublicationFile} from './teach-publication.mjs';
import {safePath} from '../../packages/desktop-host/src/package-exchange/archive.mjs';
import {exportExcludedReason} from '../../packages/desktop-host/src/package-exchange/export-policy.mjs';
import {studentReferences,studentNavigation} from './dist-host/offline-reader.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
export const PROMOTION_LIMITS=Object.freeze({files:128,fileBytes:4*1024*1024,totalBytes:32*1024*1024});
const admitted=p=>/\.(?:md|markdown|png|jpe?g|gif|webp|pdf|txt|csv|py|xml|obj|mtl|json|toml|yaml|yml|stl|safetensors)$/i.test(p)||/^(?:LICENSE|NOTICE|COPYING)(?:\.[A-Za-z0-9]+)?$/.test(path.posix.basename(p));
const privatePath=p=>p.split('/').some(s=>s.startsWith('.')||/^(?:private|teacher|solutions?|credentials?)(?:\.|$)/i.test(s))||exportExcludedReason(p);
// Explicit manifest: no implicit code discovery, downloads, imports or execution.
export function buildRolePromotion({root,folder,paths,toRole}){
 if(!Array.isArray(paths)||!paths.length||paths.length>PROMOTION_LIMITS.files||new Set(paths).size!==paths.length)fail('INVALID_REQUEST');
 const selected=new Set(paths),files=[],warnings=new Set(['Review code dependencies and licenses. Publishing does not run or validate repository code.']);let total=0;
 for(const relative of paths){
  if(typeof relative!=='string'||!safePath(relative)||!relative.startsWith(folder+'/')||privatePath(relative)||!admitted(relative)||toRole==='students'&&/(^|\/)(?:instructor(?:-template)?)(?:\.|\/)/i.test(relative))fail('PROMOTION_PRIVATE_FILE');
  const bytes=readPublicationFile(root,relative);total+=bytes.length;if(bytes.length>PROMOTION_LIMITS.fileBytes||total>PROMOTION_LIMITS.totalBytes)fail('PROMOTION_LIMIT');
  const binary=/\.(png|jpe?g|gif|webp|pdf|stl|safetensors)$/i.test(relative);let text;
  if(!binary){try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('PROMOTION_ENCODING');}
   if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b|\bAKIA[0-9A-Z]{16}\b/.test(text))fail('PROMOTION_SECRET');
   const dependencies=[];
   if(/\.(md|markdown)$/i.test(relative)){const refs=studentReferences(text,relative);if(refs.invalid||refs.htmlLinks)fail('PUBLICATION_PATH');dependencies.push(...refs.paths);if(refs.comments)warnings.add('Markdown comments remain in the output; review them for private information.');if(refs.external)warnings.add('External links remain external and are not verified.');}
   if(/\.xml$/i.test(relative))for(const m of text.matchAll(/\bfile\s*=\s*["']([^"']+)["']/g)){if(path.posix.isAbsolute(m[1])||m[1].includes('\\'))fail('PROMOTION_DEPENDENCY');dependencies.push(path.posix.normalize(path.posix.join(path.posix.dirname(relative),m[1])));}
   if(/\.(?:py|toml|json|ya?ml)$/i.test(relative))for(const m of text.matchAll(/["']([^"'\r\n]+\.(?:xml|obj|json|safetensors|csv))["']/g)){if(path.posix.isAbsolute(m[1])||m[1].includes('\\'))fail('PROMOTION_DEPENDENCY');dependencies.push(path.posix.normalize(path.posix.join(path.posix.dirname(relative),m[1])));}
   if(/\.obj$/i.test(relative))for(const m of text.matchAll(/^mtllib\s+(.+)$/gm))dependencies.push(path.posix.normalize(path.posix.join(path.posix.dirname(relative),m[1].trim())));
   for(const target of dependencies)if(!safePath(target)||privatePath(target)||!target.startsWith(folder+'/')||!selected.has(target))fail('PROMOTION_DEPENDENCY');
  }
  files.push({path:relative,bytes,hash:createHash('sha256').update(bytes).digest('hex'),kind:binary?'asset':/\.(py|xml|obj|mtl|json|toml|ya?ml)$/i.test(relative)?'code':'document'});
 }
 if(toRole==='students'&&selected.has(folder+'/student.md')){
  const documents=files.filter(f=>/\.(md|markdown)$/i.test(f.path)).map(f=>({path:f.path,title:/^#{1,6}\s+(.+)$/m.exec(f.bytes.toString('utf8'))?.[1]}));
  const summary=studentNavigation({folder,studentPath:folder+'/student.md',documents});
  for(const [name,text] of [['SUMMARY.md',summary],['.gitbook.yaml','root: ./\nstructure:\n  readme: student.md\n  summary: SUMMARY.md\n']]){const relative=folder+'/'+name;if(selected.has(relative))fail('PUBLICATION_COLLISION');const bytes=Buffer.from(text);files.push({path:relative,bytes,hash:createHash('sha256').update(bytes).digest('hex'),kind:'document',generated:true});}
 }
 if(files.length>PROMOTION_LIMITS.files||files.reduce((sum,f)=>sum+f.bytes.length,0)>PROMOTION_LIMITS.totalBytes)fail('PROMOTION_LIMIT');
 if(toRole==='instructors'){const targetFolder=folder+'/contributions/assistants';warnings.add('Assistant contributions are copied into a separate folder. Compare and incorporate them explicitly; authoritative Instructor pages are preserved.');return {folder:targetFolder,files:files.map(file=>({...file,path:targetFolder+'/'+file.path.slice(folder.length+1)})),warnings:[...warnings],conversions:[]};}
 return {folder,files,warnings:[...warnings],conversions:[]};
}
