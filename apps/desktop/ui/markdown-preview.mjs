import {contentLanguage} from './content-language.mjs';
import {installComments, visibleInlineText} from './markdown-comments.mjs';
import MarkdownIt from 'markdown-it';
import { installMath } from './markdown-math.mjs';

const parser = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false, maxNesting: 32 });
// Metadata remains in saved source; it does not become a heading or prose.
parser.block.ruler.before('hr','frontmatter',(state,startLine,endLine,silent)=>{
  if(startLine!==0||state.src.slice(state.bMarks[0],state.eMarks[0]).trim()!=='---')return false;
  for(let line=1;line<Math.min(endLine,256);line++)if(state.src.slice(state.bMarks[line],state.eMarks[line]).trim()==='---'){
    const metadata=state.src.slice(state.bMarks[1],state.bMarks[line]);
    if(!/^[A-Za-z_][\w-]*:[ \t]*(?:.*)$/m.test(metadata))return false;
    if(!silent)state.line=line+1;return true;
  }return false;
});
installComments(parser);
installMath(parser);
// GitBook's portable heading anchors are inert metadata, not general HTML.
// Accept only an empty, trailing anchor with a bounded ASCII identifier and
// an optional matching fragment href. Everything else remains literal source.
parser.core.ruler.before('inline', 'portable_heading_anchor', state => {
  const used = new Set();
  for (let index = 0; index < state.tokens.length; index++) {
    const heading = state.tokens[index], inline = state.tokens[index + 1];
    if (heading.type !== 'heading_open' || inline?.type !== 'inline') continue;
    const match = /[ \t]+<a(?: href="#([A-Za-z][A-Za-z0-9_-]{0,127})")? id="([A-Za-z][A-Za-z0-9_-]{0,127})"><\/a>[ \t]*$/.exec(inline.content);
    if (!match || match[1] && match[1] !== match[2] || used.has(match[2])) continue;
    used.add(match[2]);
    heading.attrSet('data-explicit-heading-anchor', match[2]);
    inline.content = inline.content.slice(0, match.index);
  }
});
// Recognize only attribute-free breaks, and only render them inside table cells.
// Escapes, code spans, other HTML and non-table text retain their literal meaning.
parser.inline.ruler.before('html_inline', 'table_break_candidate', (state, silent) => {
  const match = /^<br\s*\/?\s*>/i.exec(state.src.slice(state.pos));
  if (!match || /[\r\n]/.test(match[0])) return false;
  if (!silent) {const token = state.push('table_break_candidate', '', 0); token.content = match[0];}
  state.pos += match[0].length;
  return true;
});
parser.core.ruler.after('inline', 'table_cell_breaks', state => {
  const resolve = (tokens, allowBreak) => {
    for (const token of tokens) {
      if (token.type === 'table_break_candidate') {
        token.type = allowBreak ? 'hardbreak' : 'text';
        token.tag = allowBreak ? 'br' : '';
        if (allowBreak) token.content = '';
      }
      if (token.children) resolve(token.children, allowBreak && token.type !== 'image');
    }
  };
  let inCell = false;
  for (const token of state.tokens) {
    if (token.type === 'th_open' || token.type === 'td_open') inCell = true;
    if (token.type === 'inline') resolve(token.children ?? [], inCell);
    if (token.type === 'th_close' || token.type === 'td_close') inCell = false;
  }
});

const escape = value => parser.utils.escapeHtml(String(value));
export const PREVIEW_LIMIT = 512 * 1024;

// Opt-in location hints for source/preview scrolling. They describe input lines,
// never executable markup; ordinary application previews keep their exact HTML.
const sourceLine = (env, index) => Number.isSafeInteger(env.sourceLineMap?.[index]) && env.sourceLineMap[index] > 0 ? env.sourceLineMap[index] : index + 1;
parser.core.ruler.after('block', 'source_line_locations', state => {
  if (!state.env.sourceMap) return;
  for (const token of state.tokens) {
    if (!token.block || !token.map || token.nesting < 0 || ['fence', 'code_block'].includes(token.type)) continue;
    token.attrSet('data-source-line', String(sourceLine(state.env, token.map[0])));
    token.attrSet('data-source-end-line', String(Math.max(sourceLine(state.env, token.map[0]), sourceLine(state.env, token.map[1]))));
  }
});
for (const type of ['fence', 'code_block']) {
  const render = parser.renderer.rules[type];
  parser.renderer.rules[type] = (tokens, index, options, env, self) => {
    const html = render(tokens, index, options, env, self), map = tokens[index].map;
    if (!env.sourceMap || !map) return html;
    const start = sourceLine(env, map[0]), end = Math.max(start, sourceLine(env, map[1]));
    return html.replace(/^<pre(?=[ >])/, `<pre data-source-line="${start}" data-source-end-line="${end}"`);
  };
}

// Mermaid is admitted as text here, never executable Markdown. The document
// view performs bounded offline rendering and sanitizes the resulting SVG.
const renderFence = parser.renderer.rules.fence;
parser.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index];
  if (!env.technical || token.info.trim().toLowerCase() !== 'mermaid') return renderFence(tokens, index, options, env, self);
  const id = `diagram-${env.diagramCount = (env.diagramCount ?? 0) + 1}`;
  // Sixteen renderable blocks plus one local limit explanation. Additional
  // blocks remain ordinary source instead of multiplying controls/error DOM.
  if (env.diagramCount > 17) return renderFence(tokens, index, options, env, self);
  const map = token.map;
  const hints = env.sourceMap && map ? ` data-source-line="${sourceLine(env, map[0])}" data-source-end-line="${Math.max(sourceLine(env, map[0]), sourceLine(env, map[1]))}"` : '';
  return `<figure class="technical-diagram" data-mermaid-diagram="${id}"${hints}><pre class="technical-diagram-source"><code>${escape(token.content)}</code></pre></figure>\n`;
};

/** This is only local reading, never a source serializer. URL text is data for
 * an explicit host/catalog navigation handler, not browser navigation authority. */
export function localLink(value, currentPath = '') {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f\\]/u.test(value)) return null;
  let decoded; try { decoded = decodeURIComponent(value); } catch { return null; }
  if (/[\u0000-\u001f\u007f\\]/u.test(decoded) || /^(?:[a-z][a-z\d+.-]*:|\/)/iu.test(decoded) || decoded !== decoded.trim()) return null;
  const hash = decoded.indexOf('#'), fragment = hash < 0 ? '' : decoded.slice(hash + 1), target = hash < 0 ? decoded : decoded.slice(0, hash);
  if (target.includes('?') || fragment.includes('#')) return null;
  if (!target) return { path: currentPath, fragment };
  const parts = currentPath.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  return parts.length ? { path: parts.join('/'), fragment } : null;
}

function externalLink(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f\\]/u.test(value)) return null;
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  if (/[\u0000-\u001f\u007f\\]/u.test(decoded) || value !== value.trim()) return null;
  const web = /^https?:\/\/[^/?#]+(?:[/?#]|$)/iu.test(value);
  const mail = /^mailto:(?!\/\/)[^?]/iu.test(value);
  if (!web && !mail) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (web && ['http:', 'https:'].includes(url.protocol) && url.hostname) return { href: value, web: true };
  if (mail && url.protocol === 'mailto:' && url.pathname && !url.host) return { href: value, web: false };
  return null;
}

parser.renderer.rules.link_open = (tokens, index, _options, env) => {
  const target = tokens[index].attrGet('href') ?? '', local = localLink(target, env.sourcePath);
  const external = !local && env.externalLinks ? externalLink(target) : null;
  env.linkTags.push(local || external ? 'a' : 'span');
  if (local) return `<a href="#" class="document-link" data-local-link="${escape(target)}">`;
  if (external) return `<a href="${escape(external.href)}" class="document-link"${external.web ? ' target="_blank" rel="noopener noreferrer"' : ''}>`;
  return '<span class="inert-link" title="External or unsafe navigation is disabled in this local view">';
};
parser.renderer.rules.link_close = (_tokens, _index, _options, env) => `</${env.linkTags.pop() ?? 'span'}>`;
parser.renderer.rules.image = (tokens, index, _options, env) => {
  const token = tokens[index], alt = visibleInlineText(token.children) || 'Image';
  const relativeUrl = token.attrGet('src') ?? '', local = localLink(relativeUrl, env.sourcePath);
  const id = `local-image-${env.images.length}`;
  if (local && !local.fragment) env.images.push({ id, relativeUrl, alt });
  return `<span class="preview-image-placeholder"${local && !local.fragment ? ` data-local-image="${id}"` : ''} role="img" aria-label="${escape(alt)}">${escape(alt)} <small>${local && !local.fragment ? 'Loading local image…' : 'External or unsafe image stays inert.'}</small></span>`;
};
export function headingAnchor(title, used = new Set()) {
  const base = title.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/gu, '-') || 'section';
  let anchor = base, suffix = 0;
  while (used.has(anchor)) anchor = `${base}-${++suffix}`;
  used.add(anchor); return anchor;
}
parser.renderer.rules.heading_open = (tokens, index, options, env, self) => {
  const heading = { id: `source-heading-${env.headings.length + 1}`, level: Number(tokens[index].tag.slice(1)),
    title: visibleInlineText(tokens[index + 1]?.children) };
  // Keep the source-outline IDs, and expose stable document anchors separately.
  const inline = tokens[index + 1]?.children ?? [];
  const title = visibleInlineText(inline);
  const anchor = headingAnchor(title, env.anchors);
  tokens[index].attrSet('data-heading-anchor', anchor);
  env.headings.push(heading); tokens[index].attrSet('id', heading.id);
  return self.renderToken(tokens, index, options);
};

/** External navigation is an explicit caller capability. Rendering only creates
 * markup; links require a user click and remote images remain inert. */
export function renderSourcePreview(source, sourcePath = '', options = {}) {
  if (typeof source !== 'string') throw Error('Preview requires source text.');
  if (source.length > PREVIEW_LIMIT) return { html: '', headings: [], images: [], language: contentLanguage(source), limited: true };
  const environment = { sourcePath, technical: options.technical === true, externalLinks: options.externalLinks === true, sourceMap: options.sourceMap === true, sourceLineMap: options.sourceLineMap, linkTags: [], headings: [], images: [], anchors: new Set() };
  const html = parser.render(source, environment);
  return { html, headings: environment.headings, images: environment.images, language: contentLanguage(source), limited: false };
}
