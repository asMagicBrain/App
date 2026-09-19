import MarkdownIt from 'markdown-it';

const parser = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false, maxNesting: 32 });
const escape = value => parser.utils.escapeHtml(String(value));
export const PREVIEW_LIMIT = 512 * 1024;

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
  const token = tokens[index], alt = token.content || token.attrGet('alt') || 'Image';
  const relativeUrl = token.attrGet('src') ?? '', local = localLink(relativeUrl, env.sourcePath);
  const id = `local-image-${env.images.length}`;
  if (local && !local.fragment) env.images.push({ id, relativeUrl, alt });
  return `<span class="preview-image-placeholder"${local && !local.fragment ? ` data-local-image="${id}"` : ''} role="img" aria-label="${escape(alt)}">${escape(alt)} <small>${local && !local.fragment ? 'Loading local image…' : 'External or unsafe image stays inert.'}</small></span>`;
};
parser.renderer.rules.heading_open = (tokens, index, options, env, self) => {
  const heading = { id: `source-heading-${env.headings.length + 1}`, level: Number(tokens[index].tag.slice(1)),
    title: tokens[index + 1]?.content ?? '' };
  // Keep the source-outline IDs, and expose stable document anchors separately.
  const inline = tokens[index + 1]?.children ?? [];
  const title = inline.filter(token => ['text', 'code_inline', 'image'].includes(token.type)).map(token => token.content).join('');
  const base = title.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/gu, '-') || 'section';
  let anchor = base, suffix = 0;
  while (env.anchors.has(anchor)) anchor = `${base}-${++suffix}`;
  env.anchors.add(anchor);
  tokens[index].attrSet('data-heading-anchor', anchor);
  env.headings.push(heading); tokens[index].attrSet('id', heading.id);
  return self.renderToken(tokens, index, options);
};

/** External navigation is an explicit caller capability. Rendering only creates
 * markup; links require a user click and remote images remain inert. */
export function renderSourcePreview(source, sourcePath = '', options = {}) {
  if (typeof source !== 'string') throw Error('Preview requires source text.');
  if (source.length > PREVIEW_LIMIT) return { html: '', headings: [], images: [], limited: true };
  const environment = { sourcePath, externalLinks: options.externalLinks === true, linkTags: [], headings: [], images: [], anchors: new Set() };
  const html = parser.render(source, environment);
  return { html, headings: environment.headings, images: environment.images, limited: false };
}
