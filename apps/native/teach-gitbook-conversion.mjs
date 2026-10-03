import {parseFragment} from 'parse5';
import MarkdownIt from 'markdown-it';
import {parser as sourceParser} from '@lezer/markdown';
import {visibleInlineText} from '../desktop/ui/markdown-comments.mjs';
import {headingAnchor,localLink} from '../desktop/ui/markdown-preview.mjs';
const md=new MarkdownIt({html:true,maxNesting:32});
const fail=()=>{throw Object.assign(Error('Unsupported GitBook HTML. Review or replace this block before conversion.'),{code:'PUBLICATION_UNSUPPORTED_HTML'});};
const escapeLabel=s=>s.replace(/[\[\]\\]/g,'\\$&');
const url=s=>{if(/[\r\n\0]/.test(s)||/^(?:javascript|data|file|vbscript):/i.test(s))fail();return s.replace(/ /g,'%20').replace(/\(/g,'%28').replace(/\)/g,'%29');};
// HTML is parsed as data only. No DOM, scripts, network requests or project code.
export function convertGitBookMarkdown(source){
 if(typeof source!=='string'||source.length>1024*1024||source.includes('ASMBPROTECTEDCODE'))fail();
 const changes=new Set(),aliases=[],protectedParts=[];
 const codeRanges=[];sourceParser.parse(source).iterate({enter(node){if(['FencedCode','CodeBlock','InlineCode'].includes(node.name)){codeRanges.push({from:node.from,to:node.to});return false;}}});
 let text=source;for(const range of codeRanges.sort((a,b)=>b.from-a.from)){const key=`ASMBPROTECTEDCODE${protectedParts.length}END`;protectedParts.push(source.slice(range.from,range.to));text=text.slice(0,range.from)+key+text.slice(range.to);}
 // Keep metadata in the output; readers should not present it as document text.
 const front=/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text);let metadata='';if(front){metadata=front[0];text=text.slice(metadata.length);}
 let count=0;
 const render=(node,depth=0)=>{
  if(++count>20000||depth>32)fail();if(node.nodeName==='#text')return node.value;
  if(node.nodeName==='#comment')return `<!--${node.data}-->`;
  const tag=node.tagName,attrs=Object.fromEntries((node.attrs??[]).map(a=>[a.name,a.value]));
  if(Object.keys(attrs).some(k=>/^on/i.test(k)||['srcdoc','formaction'].includes(k)))fail();
  const children=()=> (node.childNodes??[]).map(n=>render(n,depth+1)).join('');
  if(!tag)return children();
  if(tag==='a'){const inner=children();if(!inner.trim()&&attrs.id)return '';if(!attrs.href)return inner;return `[${escapeLabel(inner)}](${url(attrs.href)})`;}
  if(tag==='img'){if(!attrs.src)fail();changes.add('Images and captions converted to Markdown.');return `![${escapeLabel(attrs.alt??'')}](${url(attrs.src)})`;}
  if(tag==='br')return '<br>';
  if(['strong','b'].includes(tag))return '**'+children()+'**';
  if(['em','i'].includes(tag))return '*'+children()+'*';
  if(tag==='code')return '`'+children().replace(/`/g,'\\`')+'`';
  if(tag==='pre')return '\n\n```\n'+(node.childNodes??[]).map(n=>n.nodeName==='#text'?n.value:(n.childNodes??[]).map(c=>c.value??'').join('')).join('')+'\n```\n\n';
  if(tag==='table'){
   const rows=[];const gather=(n,d=0)=>{if(d>32||++count>20000)fail();if(n.tagName==='tr')rows.push(n);else for(const child of n.childNodes??[])gather(child,d+1);};gather(node);
   if(!rows.length||rows.length>256)fail();const cells=rows.map(row=>(row.childNodes??[]).filter(n=>['td','th'].includes(n.tagName)).map(n=>{if((n.attrs??[]).some(a=>['colspan','rowspan'].includes(a.name)&&a.value!=='1'))fail();return render(n,depth+1).trim().replace(/\r?\n+/g,'<br>').replace(/\|/g,'\\|');}));
   const width=cells[0].length;if(!width||width>32||cells.some(row=>row.length!==width))fail();changes.add('HTML tables converted to Markdown; presentation widths removed.');
   return '\n\n'+[cells[0],Array(width).fill('---'),...cells.slice(1)].map(row=>'| '+row.join(' | ')+' |').join('\n')+'\n\n';
  }
  if(['td','th','tbody','thead','tr'].includes(tag))return children();
  if(tag==='figcaption')return '\n\n_'+children().trim()+'_\n\n';
  if(tag==='figure')return '\n\n'+children()+'\n\n';
  if(tag==='details'){changes.add('Collapsible details expanded; all content retained.');return '\n\n'+children()+'\n\n';}
  if(tag==='summary')return '\n\n**'+children().trim()+'**\n\n';
  if(['div','p'].includes(tag))return '\n\n'+children()+'\n\n';
  if(tag==='span')return children();
  fail();
 };
 const html=s=>render(parseFragment(s));
 text=text.replace(/^(#{1,6}\s+.*?)[ \t]*<a\b[^>]*\bid=["']([^"']+)["'][^>]*>\s*<\/a>[ \t]*$/gm,(_all,title,id)=>{aliases.push({id,title});changes.add('Explicit heading anchors mapped to Markdown headings.');return title;});
 text=text.replace(/<(table|figure|details|div)\b[^>]*>[\s\S]*?<\/\1>/gi,part=>html(part));
 text=text.replace(/<(a|code|strong|b|em|i|span)\b[^>]*>[\s\S]*?<\/\1>/gi,part=>html(part));
 text=text.replace(/<img\b[^>]*>/gi,part=>html(part));
 // Unsupported active markup stays blocked. Comments and table breaks remain data.
 for(const token of md.parse(text,{})){const check=t=>{if(['html_block','html_inline'].includes(t.type)&&!/^\s*(?:<!--[\s\S]*?-->|<br\s*\/?\s*>)\s*$/i.test(t.content))fail();for(const child of t.children??[])check(child);};check(token);}
 for(let i=0;i<protectedParts.length;i++)text=text.replace(`ASMBPROTECTEDCODE${i}END`,()=>protectedParts[i]);
 const anchors=Object.create(null),used=new Set();
 const tokens=md.parse(text,{});for(let i=0;i<tokens.length;i++)if(tokens[i].type==='heading_open'){
  const title=visibleInlineText(tokens[i+1]?.children),anchor=headingAnchor(title,used);
  const alias=aliases.find(a=>!a.done&&visibleInlineText(md.parseInline(a.title.replace(/^#+\s*/,''),{})[0]?.children)===title);
  if(alias){anchors[alias.id]=anchor;alias.done=true;}
 }
 if(aliases.some(a=>!a.done))fail();
 return {text:metadata+text,title:tokens.find((t,i)=>t.type==='inline'&&tokens[i-1]?.type==='heading_open')?.content??null,anchors,changes:[...changes]};
}

export function rewriteGitBookAnchors(source,relative,documents,homeAliases={}){
 const edits=[];
 sourceParser.parse(source).iterate({enter(node){if(node.name!=='URL')return;let raw=source.slice(node.from,node.to);if(raw.startsWith('<')&&raw.endsWith('>'))raw=raw.slice(1,-1);const decoded=md.utils.unescapeAll(raw);
  if(!decoded.includes('#'))return;
  const [prefix,fragment]=decoded.split('#');let target=prefix===''||prefix==='./'?relative:localLink(decoded,relative)?.path;target=homeAliases[target]??target;
  const alias=documents.get(target)?.anchors?.[decodeURIComponentSafe(fragment)];if(!alias&&prefix!=='./'&&!homeAliases[localLink(decoded,relative)?.path])return;
  if(!target)return;const file=target===relative?'':relativePath(relative,target);edits.push({from:node.from,to:node.to,text:file+'#'+(alias??fragment)});
 }});for(const e of edits.sort((a,b)=>b.from-a.from))source=source.slice(0,e.from)+e.text+source.slice(e.to);return source;
}
function decodeURIComponentSafe(s){try{return decodeURIComponent(s);}catch{return s;}}
function relativePath(from,to){const a=from.split('/');a.pop();const b=to.split('/');while(a.length&&b.length&&a[0]===b[0]){a.shift();b.shift();}return [...a.map(()=>'..'),...b].map(encodeURIComponent).join('/');}
