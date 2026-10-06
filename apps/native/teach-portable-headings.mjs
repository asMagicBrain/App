import {createHash} from 'node:crypto';
import MarkdownIt from 'markdown-it';
import {headingAnchor} from '../desktop/ui/markdown-preview.mjs';
import {visibleInlineText} from '../desktop/ui/markdown-comments.mjs';
const parser=new MarkdownIt({html:true,maxNesting:32});

// GitBook transliterates non-ASCII anchors. Pin only those headings to an
// ASCII identifier, derived from the original unique Markdown anchor. This
// transforms reviewed delivery bytes; it never writes the authoring source.
export function portableHeadingOutput(source){
 const front=/^\ufeff?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
 const metadata=front&&/^[A-Za-z_][\w-]*:/m.test(front[1])?front[0]:'';
 const lineOffset=(metadata.match(/\n/g)??[]).length;
 const tokens=parser.parse(source.slice(metadata.length).replace(/^\ufeff/,''),{}),used=new Set(),anchors=Object.create(null),edits=[];
 const lines=source.split(/(?<=\n)/),starts=[0];for(const line of lines)starts.push(starts.at(-1)+line.length);
 for(let index=0;index<tokens.length;index++){
  const heading=tokens[index],inline=tokens[index+1];if(heading.type!=='heading_open'||inline?.type!=='inline'||!heading.map)continue;
  const title=visibleInlineText(inline.children),original=headingAnchor(title,used);
  const existing=/\s+<a(?: href="#[A-Za-z][A-Za-z0-9_-]{0,127}")? id="([A-Za-z][A-Za-z0-9_-]{0,127})"><\/a>\s*$/.exec(inline.content);
  if(existing){anchors[original]=existing[1];continue;}
  if(!/[^\x00-\x7f]/.test(original))continue;
  const id='asmb-h-'+createHash('sha256').update(original).digest('hex').slice(0,24);
  anchors[original]=id;
  const line=heading.map[0]+lineOffset,raw=lines[line]??'',ending=/\r?\n$/.exec(raw)?.[0]??'';
  let text=raw.slice(0,raw.length-ending.length);
  // Preserve optional ATX closing markers, indentation, and original EOLs.
  if(/^\ufeff? {0,3}#{1,6}\s/.test(text))text=text.replace(/[ \t]+#+[ \t]*$/,'');
  const atx=/^\ufeff? {0,3}#{1,6}\s/.test(text);
  const separation=atx&&ending&&lines[line+1]?.trim()?ending:'';
  edits.push({from:starts[line],to:starts[line+1],text:text+` <a id="${id}"></a>`+ending+separation});
 }
 for(const edit of edits.sort((a,b)=>b.from-a.from))source=source.slice(0,edit.from)+edit.text+source.slice(edit.to);
 return {text:source,anchors};
}
