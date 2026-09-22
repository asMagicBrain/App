import MarkdownIt from 'markdown-it';
import {commonmarkLanguage} from '@codemirror/lang-markdown';
import {localLink} from '../../apps/desktop/ui/markdown-preview.mjs';
import {approvedTeachAssetUrl, teachDisplaySource} from './teach-content.mjs';

// These helpers operate only on strings supplied by the course session. They do
// not read files, fetch assets, publish, or change the reference fixture.
const parser = new MarkdownIt({html:false,linkify:false,typographer:false,breaks:false,maxNesting:32});
export const teachDocumentSections = Object.freeze([
  ['course-description','Course Description'], ['teaching-goals','Teaching Goals'],
  ['learning-outcomes','Learning Outcomes'], ['content-summary','Content Summary'],
  ['assumed-knowledge','Assumed Knowledge'], ['co-requisite-courses','Co-Requisite Courses'],
  ['teaching-team','Course Instructor & Teaching Team'], ['grading-policy','Grading Policy'],
  ['academic-integrity','Academic Integrity'], ['university-calendar','University Calendar'],
  ['recommended-textbooks','Recommended Textbook(s)'], ['teaching-schedule','Teaching Schedule'],
  ['important-deadlines','Important Deadlines'],
].map(([id,title]) => Object.freeze({id,title})));
const normalize = value => value.trim().toLowerCase().replace(/\s+/gu,' ');
const recognized = new Map(teachDocumentSections.map(item => [normalize(item.title),item.id]));
const slug = value => value.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu,'').replace(/\s+/gu,'-') || 'section';

function lineStarts(source) {
  const starts=[0];
  for(let index=0;index<source.length;index++) {
    if(source[index]==='\r') {if(source[index+1]==='\n')index++;starts.push(index+1);}
    else if(source[index]==='\n')starts.push(index+1);
  }
  return starts;
}

// Frontmatter remains in the exact preamble slice, but cannot become a fake
// setext heading in the review selector. Never interpret YAML or execute it.
function withoutMetadata(source) {
  const match=/^\uFEFF?---[ \t]*\r?\n[\s\S]*?^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(source);
  return match?.index===0 ? source.slice(0,match[0].length).replace(/[^\r\n]/g,' ')+source.slice(match[0].length) : source;
}

function visibleTitle(tokens) {
  return tokens.map(token => ['text','code_inline','image'].includes(token.type)?token.content:
    ['softbreak','hardbreak'].includes(token.type)?' ':token.children?visibleTitle(token.children):'').join('').replace(/\s+/gu,' ').trim();
}

function headings(source) {
  const starts=lineStarts(source), tokens=parser.parse(withoutMetadata(source),{}), result=[];
  for(let index=0;index<tokens.length;index++) {
    const token=tokens[index];
    // Quoted/list-contained headings belong to their enclosing section.
    if(token.type!=='heading_open'||token.level!==0||!token.map)continue;
    const title=visibleTitle(tokens[index+1]?.children??[]);
    result.push({title,level:Number(token.tag.slice(1)),from:starts[token.map[0]]??source.length,to:starts[token.map[1]]??source.length});
  }
  return result;
}

/** Exact, ordered source slices for an explicit student-content review. */
export function splitTeachStudentSections(source) {
  const all=headings(source), known=all.filter(item=>recognized.has(normalize(item.title)));
  const level=known.length?Math.min(...known.map(item=>item.level)):
    all.length>1&&all[0].level<all[1].level?all[1].level:all[0]?.level??1;
  const boundaries=all.filter(item=>item.level<=level), result=[], counts=new Map();
  const add=(heading,from,to) => {
    const title=heading?.title||'Document introduction and metadata';
    const knownId=heading&&recognized.get(normalize(title));
    const base=knownId||(!heading?'introduction':`heading-${slug(title)}`), count=(counts.get(base)??0)+1;
    counts.set(base,count);
    const body=source.slice(heading?.to??from,to);
    result.push({id:count===1?base:`${base}-${count}`,title,source:source.slice(from,to),recognized:Boolean(knownId),empty:!body.trim(),from,to,level:heading?.level??0});
  };
  if(!boundaries.length) {if(source)add(undefined,0,source.length);return result;}
  if(boundaries[0].from>0)add(undefined,0,boundaries[0].from);
  boundaries.forEach((item,index)=>add(item,item.from,boundaries[index+1]?.from??source.length));
  return result;
}

/** Selection is opt-in. Empty recognized scaffolding never enters an edition. */
export function composeTeachStudentSource(sections, ids) {
  const selected=new Set(ids);
  return sections.filter(item=>selected.has(item.id)&&!(item.recognized&&item.empty)).map(item=>item.source).join('');
}

function relativePath(fromPath,toPath) {
  const from=fromPath.split('/').slice(0,-1), to=toPath.split('/');
  while(from.length&&to.length&&from[0]===to[0]) {from.shift();to.shift();}
  return [...from.map(()=>'..'),...to].join('/')||fromPath.split('/').at(-1)||'';
}

function rebaseTarget(target,fromPath,toPath) {
  const destination=localLink(target,fromPath);
  if(!destination||fromPath===toPath)return target;
  // encode each path component, keeping separators structural. The same narrow
  // localLink boundary will decode it at render time; no browser URL is emitted.
  const path=relativePath(toPath,destination.path).split('/').map(part=>encodeURIComponent(part).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
  const fragment=destination.fragment?`#${encodeURIComponent(destination.fragment)}`:'';
  return path+fragment;
}

function sourceNodes(source) {
  const cursor=commonmarkLanguage.parser.parse(withoutMetadata(source)).cursor(), nodes=[];
  do {nodes.push({name:cursor.name,from:cursor.from,to:cursor.to,parent:cursor.node.parent?.name??'',parentFrom:cursor.node.parent?.from});} while(cursor.next());
  return nodes;
}

function referenceUse(source,node,nodes) {
  if(!['Link','Image'].includes(node.name))return null;
  const children=nodes.filter(item=>item.parent===node.name&&item.parentFrom===node.from);
  if(children.some(item=>item.name==='URL'))return null;
  const labelNode=children.find(item=>item.name==='LinkLabel'), contentEnd=labelNode?.from??node.to;
  const content=source.slice(node.from,contentEnd), explicitLabel=labelNode?source.slice(labelNode.from+1,labelNode.to-1):'';
  const label=explicitLabel||content.slice(node.name==='Image'?2:1,-1);
  return {contentEnd,label,normalized:parser.utils.normalizeReference(parser.utils.unescapeAll(label))};
}

/** Rebase only a composed copy. Code, prose and original source stay untouched. */
export function rebaseTeachSource(source,fromPath,toPath) {
  if(fromPath===toPath)return source;
  const changes=[],nodes=sourceNodes(source),environment={};
  parser.parse(withoutMetadata(source),environment);
  for(const node of nodes) {
    const reference=referenceUse(source,node,nodes),definition=reference&&environment.references?.[reference.normalized];
    if(definition) {
      // An include's [label] must retain its own definition even when another
      // include uses that same label. Inline only already-resolved references
      // in the assembled copy; never guess a missing definition.
      const href=rebaseTarget(definition.href,fromPath,toPath),title=definition.title?` "${definition.title.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`:'';
      changes.push({from:reference.contentEnd,to:node.to,value:`(<${href}>${title})`});
    } else if(node.name==='URL'&&['Link','Image','LinkReference'].includes(node.parent)) {
      const raw=source.slice(node.from,node.to), angle=raw.startsWith('<')&&raw.endsWith('>');
      const target=angle?raw.slice(1,-1):raw;
      const value=rebaseTarget(parser.utils.unescapeAll(target),fromPath,toPath);
      if(value!==target)changes.push({from:node.from,to:node.to,value:angle?`<${value}>`:value});
    } else if(node.name==='HTMLTag'||node.name==='HTMLBlock') {
      // Imported HTML is still inert. Preserve the same source-relative image
      // identity for renderTeachSource's deliberately narrow figure adapter.
      const html=source.slice(node.from,node.to);
      for(const tag of html.matchAll(/<(?:img|a)\b[^>]*>/gi)) {
        for(const attr of tag[0].matchAll(/\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi)) {
          const start=node.from+tag.index+attr.index+attr[0].indexOf(attr[1])+1;
          const value=rebaseTarget(parser.utils.unescapeAll(attr[2]),fromPath,toPath);
          if(value!==attr[2])changes.push({from:start,to:start+attr[2].length,value});
        }
      }
    }
  }
  for(const change of changes.sort((a,b)=>b.from-a.from))source=source.slice(0,change.from)+change.value+source.slice(change.to);
  return source;
}

function sectionDocument(section,path) {
  let source=rebaseTeachSource(teachDisplaySource(section.source),section.path,path).trim();
  const all=headings(source), first=all[0];
  if(first?.from===0&&normalize(first.title)===normalize(section.title)) {
    // The assembled course title is H1; section headings are H2. Promote the
    // whole local hierarchy together instead of flattening authored subheads.
    const shift=2-first.level;
    for(const heading of [...all].reverse()) {
      const level=Math.min(6,Math.max(1,heading.level+shift));
      const raw=source.slice(heading.from,heading.to), eol=raw.endsWith('\r\n')?'\r\n':'\n';
      const atx=/^ {0,3}#{1,6}(?=[ \t]|$)/.exec(raw);
      const replacement=atx?raw.replace(/^ {0,3}#{1,6}/,'#'.repeat(level)):`${'#'.repeat(level)} ${heading.title}${eol}`;
      source=source.slice(0,heading.from)+replacement+source.slice(heading.to);
    }
    return source+'\n\n';
  }
  return `## ${section.title}\n\n${source}${source?'\n\n':''}`;
}

/** Creates one term-scoped session document; legacy section inputs are adapters. */
export function createTeachInstructorDocument(course) {
  const home=course.reference?.home;
  if(home?.kind==='document')return {source:home.source,path:home.path,parts:[],aliases:splitTeachStudentSections(home.source).map(({id,title,from})=>({id,title,from}))};
  const path=home?.path??`${course.year}-${course.season.toLowerCase().replace(/\s+/g,'-')}/instructor.md`, parts=[];
  let source='';
  if(home?.kind==='composed') {
    // Substitute only admitted include records in place, preserving the Home
    // preamble and extra authored text. Missing includes remain visible data.
    const opaque=sourceNodes(home.source).filter(node=>['FencedCode','CodeBlock','InlineCode'].includes(node.name));
    const used=new Set();let offset=0;
    for(const include of home.source.matchAll(/\{%\s*include\s+(["'])(.*?)\1\s*%\}/g)) {
      if(opaque.some(node=>include.index>=node.from&&include.index<node.to))continue;
      const target=localLink(include[2],path), section=course.sections.find(item=>item.path===target?.path);
      if(!section)continue;
      source+=home.source.slice(offset,include.index);
      const body=rebaseTeachSource(teachDisplaySource(section.source),section.path,path), from=source.length;
      source+=body;parts.push({id:section.id,title:section.title,from,to:source.length,originalSource:section.source,originalPath:section.path});
      offset=include.index+include[0].length;used.add(section.id);
    }
    source+=home.source.slice(offset);
    for(const section of course.sections.filter(item=>!used.has(item.id))) {
      if(!source.endsWith('\n\n'))source+='\n\n';
      const from=source.length;source+=sectionDocument(section,path);
      parts.push({id:section.id,title:section.title,from,to:source.length,originalSource:section.source,originalPath:section.path});
    }
  } else {
    const title=`${course.code} · ${course.title}`.replace(/[\r\n]/g,' ').replace(/([\\`*_[\]<>])/g,'\\$1');
    source=`# ${title}\n\n`;
    const sections=course.sections.length?course.sections:teachDocumentSections.map(item=>({...item,path,source:''}));
    for(const section of sections) {
      const from=source.length;source+=sectionDocument(section,path);
      parts.push({id:section.id,title:section.title,from,to:source.length,originalSource:section.source,originalPath:section.path});
    }
  }
  return {source,path,parts,aliases:splitTeachStudentSections(source).map(({id,title,from})=>({id,title,from}))};
}

/** Bounded source inventory, never an export/asset-completeness assertion. */
export function inspectTeachStudentDependencies(source,path,assets={}) {
  const results=[], seen=new Set(), environment={};
  const add=(kind,target) => {
    const key=`${kind}\0${target}`;if(seen.has(key))return;seen.add(key);
    const destination=kind==='reference'?null:localLink(target,path);
    const status=kind==='reference'?'Unresolved reference label':kind==='include'?'Unresolved include; source not expanded':
      destination?kind==='image'&&approvedTeachAssetUrl(assets[destination.path])?'Mapped reference image; redistribution not checked':
        kind==='image'?'Local image; availability not verified':'Local link; destination not verified':
      /^(?:https?:|mailto:)/i.test(target)?'External destination; not fetched':'Unsafe or unsupported destination; inert';
    results.push({kind,target,status,...(destination?{path:destination.path}:{} )});
  };
  const tokens=parser.parse(withoutMetadata(source),environment);
  const visit=items=>{for(const token of items) {
    if(token.type==='image')add('image',token.attrGet('src')??'');
    if(token.type==='link_open')add('link',token.attrGet('href')??'');
    if(token.children)visit(token.children);
  }};visit(tokens);
  const nodes=sourceNodes(source), opaque=nodes.filter(node=>['FencedCode','CodeBlock','InlineCode'].includes(node.name));
  const ordinary=index=>!opaque.some(node=>index>=node.from&&index<node.to);
  for(const node of nodes)if(node.name==='HTMLTag'||node.name==='HTMLBlock') {
    for(const tag of source.slice(node.from,node.to).matchAll(/<(img|a)\b[^>]*>/gi)) {
      const attribute=tag[0].match(tag[1].toLowerCase()==='img'?/\bsrc\s*=\s*(["'])(.*?)\1/i:/\bhref\s*=\s*(["'])(.*?)\1/i);
      if(attribute)add(tag[1].toLowerCase()==='img'?'image':'link',parser.utils.unescapeAll(attribute[2]));
    }
  }
  for(const include of source.matchAll(/\{%\s*include\s+(["'])(.*?)\1\s*%\}/g))if(ordinary(include.index))add('include',include[2]);
  // CommonMark leaves missing reference links as text. Full, collapsed and
  // shortcut labels still deserve review if a definition was excluded.
  for(const node of nodes) {
    const reference=referenceUse(source,node,nodes);
    if(reference&&!environment.references?.[reference.normalized])add('reference',reference.label);
  }
  return results;
}
