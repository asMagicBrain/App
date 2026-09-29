import MarkdownIt from 'markdown-it';
import {localLink,renderSourcePreview} from '../desktop/ui/markdown-preview.mjs';
const parser=new MarkdownIt({html:false,linkify:false,typographer:false,breaks:false,maxNesting:32});
const markup=value=>value.replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
/** Bundled with the existing offline reader. Imported Markdown is parsed as data;
 * repository HTML, scripts and diagrams are never executed by validation. */
export function analyzeReferences({path,text,limit=1000}){
 const references=[];let truncated=false;
 const visit=tokens=>{for(const token of tokens){if(token.type==='link_open'||token.type==='image'){if(references.length>=limit){truncated=true;continue;}const raw=token.attrGet(token.type==='image'?'src':'href')??'',local=localLink(raw,path);references.push({kind:token.type==='image'?'image':'link',value:raw,local});}if(token.children)visit(token.children);}};
 visit(parser.parse(text,{}));const rendered=renderSourcePreview(text,path,{externalLinks:false,technical:false});
 return{references,truncated,hasFragment(fragment){const value=markup(fragment);return rendered.html.includes(`id="${value}"`)||rendered.html.includes(`data-heading-anchor="${value}"`);}};
}
