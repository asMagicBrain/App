import path from 'node:path';
import {localLink} from '../desktop/ui/markdown-preview.mjs';
const label=s=>s.replace(/[\r\n]/g,' ').replace(/[\[\]\\]/g,'\\$&');
export function studentNavigation({folder,studentPath,documents,sourceSummary='',homeAliases={}}){
 const eligible=new Map(documents.map(d=>[d.path,d])),included=new Set();const segments=[{heading:null,lines:[]}];let segment=segments[0];
 for(const line of sourceSummary.split(/\r?\n/)){
  const heading=/^#{2,6}\s+(.+)$/.exec(line);if(heading){segment={heading:heading[1],lines:[]};segments.push(segment);continue;}
  const item=/^(\s*)[-*+]\s+\[([^\]]+)\]\(([^)]+)\)\s*$/.exec(line);if(!item)continue;
  const target=localLink(item[3],folder+'/SUMMARY.md')?.path,relative=homeAliases[target]??target;
  if(!eligible.has(relative)||included.has(relative))continue;included.add(relative);
  segment.lines.push({path:relative,title:item[2],indent:Math.min(8,Math.floor(item[1].length/2))*2});
 }
 const line=d=>' '.repeat(d.indent??0)+`* [${label(d.title)}](${d.path.slice(folder.length+1).split('/').map(encodeURIComponent).join('/')})`;
 // Entry page stays first even if the imported summary omits it.
 const home=eligible.get(studentPath);const out=['# Summary','',line({path:studentPath,title:home?.title??'Student course'})];included.add(studentPath);
 for(const group of segments){const rows=group.lines.filter(d=>d.path!==studentPath);if(!rows.length)continue;if(group.heading)out.push('', '## '+group.heading.replace(/[\r\n]/g,' '),'');out.push(...rows.map(line));}
 const remaining=documents.filter(d=>!included.has(d.path)).sort((a,b)=>a.path.localeCompare(b.path,'en',{numeric:true})||(a.path<b.path?-1:1));
 if(remaining.length){if(sourceSummary.trim())out.push('','## Additional pages','');out.push(...remaining.map(d=>line({path:d.path,title:d.title??path.posix.basename(d.path).replace(/\.[^.]+$/,'')})));}
 return out.join('\n')+'\n';
}
