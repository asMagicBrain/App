import path from 'node:path';
import MarkdownIt from 'markdown-it';
import {installMath} from '../../../../apps/desktop/ui/markdown-math.mjs';
import {localLink} from '../../../../apps/desktop/ui/markdown-preview.mjs';
import {sha256} from './archive.mjs';
import {loadOfflineAssets,KATEX_READER_CSS} from './offline-assets.mjs';

const escape = value => String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const url = relative => relative.split('/').map(encodeURIComponent).join('/');
const PAGE_LIMIT=512*1024, IMAGE=/\.(?:png|jpe?g|gif|webp)$/i;
const CSS=`:root{color-scheme:light dark;font-family:system-ui,sans-serif;line-height:1.6;background:Canvas;color:CanvasText}body{max-width:1012px;margin:32px auto;padding:0 24px}nav{font-size:.9rem;border-bottom:1px solid GrayText;padding-bottom:12px}h1,h2{border-bottom:1px solid color-mix(in srgb,CanvasText 20%,transparent);padding-bottom:.3em}img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:color-mix(in srgb,CanvasText 6%,Canvas);padding:16px;border-radius:6px}code{font-family:ui-monospace,monospace}table{border-collapse:collapse}th,td{border:1px solid GrayText;padding:8px}.notice,figure{border:1px solid GrayText;border-radius:6px;padding:12px;margin:16px 0}.katex-display{overflow-x:auto;overflow-y:hidden;padding:4px 0}.source{font-size:.9em}a{color:LinkText}`;
// KaTeX emits trusted layout style attributes. Markdown HTML remains disabled;
// repository HTML is escaped. Stylesheets/fonts remain local and scripts never run.
const CSP="default-src 'none'; script-src 'none'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const mimeText=bytes=>{try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);return text.includes('\0')?null:text;}catch{return null;}};

/** Trusted build-time bundled renderer. Only generated static HTML enters the
 * reader. Repository HTML, scripts and SVG are displayed as escaped source. */
export function renderOffline({files,analyzeOnly=false}){
  const source=new Map(files.map(file=>[file.path,{...file,bytes:Buffer.from(file.bytes)}])),warnings=[],warningKeys=new Set();
  const warn=(file,code,message)=>{const key=JSON.stringify([file,code,message]);if(warningKeys.has(key))return;warningKeys.add(key);warnings.push({path:file,code,message});};
  const parser=new MarkdownIt({html:false,linkify:false,typographer:false,maxNesting:32});installMath(parser,{output:'htmlAndMathml',copyButton:false});
  const targetFor=(value,from)=>{const local=localLink(value,from);if(!local){warn(from,/^https?:|^mailto:/i.test(value)?'EXTERNAL_REFERENCE':'UNRESOLVED_REFERENCE',`Reference remains offline: ${String(value).slice(0,300)}`);return null;}if(!source.has(local.path)){warn(from,'MISSING_DEPENDENCY',`Missing local reference: ${local.path}`);return null;}return local;};
  parser.renderer.rules.link_open=(tokens,index,options,env)=>{const raw=tokens[index].attrGet('href')??'',target=targetFor(raw,env.sourcePath);env.linkTags.push(target?'a':'span');return target?`<a href="${escape(url(path.posix.relative(path.posix.dirname(env.sourcePath),target.path+'.html'))+(target.fragment?'#'+encodeURIComponent(target.fragment):''))}">`:'<span class="unavailable-link">';};
  parser.renderer.rules.link_close=(_tokens,_index,_options,env)=>`</${env.linkTags.pop()??'span'}>`;
  parser.renderer.rules.image=(tokens,index,options,env)=>{const token=tokens[index],raw=token.attrGet('src')??'',alt=token.content||token.attrGet('alt')||'Image',target=targetFor(raw,env.sourcePath);if(!target||target.fragment||!IMAGE.test(target.path)){if(target)warn(env.sourcePath,'UNSUPPORTED_IMAGE',`Image stays source-only: ${target.path}`);return `<span class="notice">${escape(alt)} — image unavailable in offline reading.</span>`;}return `<img src="${escape(url(path.posix.relative(path.posix.dirname('reader/'+env.sourcePath+'.html'),'source/'+target.path)))}" alt="${escape(alt)}" loading="lazy">`;};
  const fence=parser.renderer.rules.fence;
  parser.renderer.rules.fence=(tokens,index,options,env,self)=>{
    if(tokens[index].info.trim().toLowerCase()!=='mermaid')return fence(tokens,index,options,env,self);
    warn(env.sourcePath,'DIAGRAM_SOURCE_FALLBACK','Mermaid is included as readable source; the offline reader does not run a diagram engine.');
    return `<figure><figcaption>Mermaid diagram — source fallback</figcaption><p>Open this document in asMagicBrain to render supported diagrams. The complete diagram source is preserved below.</p><pre><code>${escape(tokens[index].content)}</code></pre></figure>`;
  };
  parser.renderer.rules.heading_open=(tokens,index,options,env,self)=>{const inline=tokens[index+1]?.children??[],title=inline.filter(token=>['text','code_inline','image','math_inline'].includes(token.type)).map(token=>token.content).join('');const base=title.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu,'').replace(/\s/gu,'-')||'section';let anchor=base,n=0;while(env.anchors.has(anchor))anchor=`${base}-${++n}`;env.anchors.add(anchor);tokens[index].attrSet('id',anchor);return self.renderToken(tokens,index,options);};
  const pages=[];
  for(const [relative,file] of source){
    const text=mimeText(file.bytes),markdown=/\.(?:md|markdown)$/i.test(relative);let body;
    if(markdown&&text!==null&&text.length<=PAGE_LIMIT)body=parser.render(text,{sourcePath:relative,technical:true,linkTags:[],anchors:new Set()});
    else if(IMAGE.test(relative))body=`<img src="${escape(url(path.posix.relative(path.posix.dirname('reader/'+relative+'.html'),'source/'+relative)))}" alt="${escape(relative)}">`;
    else if(text!==null&&text.length<=PAGE_LIMIT){body=`<h1>${escape(relative)}</h1><p class="notice">Source view. Executable content is not run in the offline reader.</p><pre>${escape(text)}</pre>`;if(/\.(?:html?|svg|js|mjs|wasm|artifact\.json)$/i.test(relative))warn(relative,'STATIC_ARTIFACT_FALLBACK','Interactive content is source-only. Included poster images remain available; no artifact code runs during export or offline reading.');}
    else{body=`<h1>${escape(relative)}</h1><p class="notice">This file is included unchanged under the source folder. A readable preview is unavailable (${file.bytes.length} bytes).</p>`;warn(relative,'SOURCE_ONLY','A readable preview is unavailable; original bytes remain in the source folder.');}
    if(!analyzeOnly){const page=`reader/${relative}.html`,up=path.posix.relative(path.posix.dirname(page),'index.html'),css=path.posix.relative(path.posix.dirname(page),'reader.css'),mathCss=path.posix.relative(path.posix.dirname(page),KATEX_READER_CSS);pages.push({path:page,bytes:Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escape(CSP)}"><title>${escape(relative)}</title><link rel="stylesheet" href="${url(mathCss)}"><link rel="stylesheet" href="${url(css)}"></head><body><nav><a href="${url(up)}">Contents</a> / ${escape(relative)}</nav><main>${body}</main><footer><p class="source">Saved source SHA-256: ${sha256(file.bytes)}</p></footer></body></html>`) });}
  }
  if(analyzeOnly)return {warnings};
  const bundled=typeof __ASMB_READER_ASSETS__==='object'?__ASMB_READER_ASSETS__:loadOfflineAssets();
  const notices=bundled.notices;
  pages.push(...bundled.assets.map(asset=>({path:asset.path,bytes:Buffer.from(asset.base64,'base64')})));
  const list=files.map(file=>`<li><a href="${url('reader/'+file.path+'.html')}">${escape(file.path)}</a></li>`).join('');
  const warningList=warnings.map(warning=>`<li><strong>${escape(warning.path)}</strong>: ${escape(warning.message)}</li>`).join('');
  pages.push({path:'index.html',bytes:Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escape(CSP)}"><title>Offline collection</title><link rel="stylesheet" href="reader.css"></head><body><h1>Offline collection</h1><p>Saved documents and local assets. Equations use bundled KaTeX fonts with accessible MathML. Diagrams and interactive artifacts have explicit source fallback. No scripts run in this reader.</p><ul>${list}</ul>${warnings.length?`<h2>Reading notes</h2><ul>${warningList}</ul>`:''}<p>Original files are included under <code>source/</code>. <a href="READER-NOTICES.txt">Reader notices</a></p></body></html>`)});
  pages.push({path:'reader.css',bytes:Buffer.from(CSS)},{path:'READER-NOTICES.txt',bytes:Buffer.from(notices)},{path:'EXPORT-REPORT.json',bytes:Buffer.from(JSON.stringify({schemaVersion:1,offline:true,executableContent:'never activated',files:files.map(file=>({path:file.path,sha256:sha256(file.bytes)})),warnings},null,2)+'\n')});
  return {files:pages,warnings};
}
