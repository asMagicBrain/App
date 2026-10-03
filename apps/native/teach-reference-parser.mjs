import path from 'node:path';
import {parser as sourceParser} from '@lezer/markdown';
// Build-time bundled Markdown parser; no repository HTML is executed.
import MarkdownIt from 'markdown-it';
import {localLink} from '../desktop/ui/markdown-preview.mjs';
const parser=new MarkdownIt({html:true,linkify:false,maxNesting:32});
export function studentReferences(source,relative){
 const result={paths:[],comments:false,htmlLinks:false,external:false,invalid:false};
 const walk=tokens=>{for(const token of tokens){
  if(token.type==='html_block'||token.type==='html_inline'){if(/<!--/.test(token.content))result.comments=true;if(/(?:src|href)\s*=/i.test(token.content))result.htmlLinks=true;}
  const target=token.type==='link_open'?token.attrGet('href'):token.type==='image'?token.attrGet('src'):null;
  if(target){if(/^(?:https?:|mailto:)/i.test(target))result.external=true;else{const local=localLink(target,relative);if(local)result.paths.push(local.path);else result.invalid=true;}}
  if(token.children)walk(token.children);
 }};walk(parser.parse(source,{}));return result;
}

// Lezer is the existing CM6 Markdown parser. Its source spans let output links
// change without reserializing headings, comments, tables or code examples.
export function rewriteStudentLinks(source,relative,outputPath,destinations){
 const edits=[];
 sourceParser.parse(source).iterate({enter(node){
  if(node.name!=='URL')return;
  let raw=source.slice(node.from,node.to);if(raw.startsWith('<')&&raw.endsWith('>'))raw=raw.slice(1,-1);
  const decoded=parser.utils.unescapeAll(raw),local=localLink(decoded,relative),target=local&&destinations[local.path];
  if(!target)return;
  const prefix=path.posix.relative(path.posix.dirname(outputPath),target).split('/').map(encodeURIComponent).join('/');
  const suffix=decoded.includes('#')?decoded.slice(decoded.indexOf('#')):'';
  edits.push({from:node.from,to:node.to,text:prefix+suffix});
 }});
 for(const edit of edits.sort((a,b)=>b.from-a.from))source=source.slice(0,edit.from)+edit.text+source.slice(edit.to);
 return source;
}
