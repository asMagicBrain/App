import {localLink, renderSourcePreview} from '../../apps/desktop/ui/markdown-preview.mjs';
import {mapTeachPreviewSource} from './teach-preview-map.mjs';

/** Reading transformation only. The caller retains the original Markdown bytes. */
export function teachDisplaySource(source) {
  const opening=source.match(/^\uFEFF?---[ \t]*\r?\n/);
  if(!opening)return source;
  const remainder=source.slice(opening[0].length);
  const closing=/^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(remainder);
  if(!closing)return source;
  const metadata=remainder.slice(0,closing.index);
  const lines=metadata.split(/\r?\n/).filter(line=>line.trim()&&!/^[ \t]*#/.test(line));
  if(lines.length&&(!/^(?:title|description)[ \t]*:/.test(lines[0])||!lines.every(line=>/^(?:title|description)[ \t]*:/.test(line)||/^[ \t]+/.test(line))))return source;
  return remainder.slice(closing.index+closing[0].length);
}

/** A recognized section heading is structure; another authored heading is content. */
export function hasTeachSectionContent(source, title) {
  const displayed = teachDisplaySource(source).trim();
  const heading = displayed.match(/^#{1,6}[ \t]+([^\r\n]+)(?:\r?\n|$)/);
  const normalize = value => value.replace(/[ \t]+#+[ \t]*$/, '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  if (heading && normalize(heading[1]) === normalize(title)) return Boolean(displayed.slice(heading[0].length).trim());
  const setext = displayed.match(/^([^\r\n]+)\r?\n(?:=+|-+)[ \t]*(?:\r?\n|$)/);
  if (setext && normalize(setext[1]) === normalize(title)) return Boolean(displayed.slice(setext[0].length).trim());
  return Boolean(displayed);
}

export function teachSectionDisplay(source, title) {
  const displayed=teachDisplaySource(source).trim();
  const heading=displayed.match(/^#{1,6}[ \t]+([^\r\n]+)(?:\r?\n|$)/);
  const normalized=value=>value.replace(/[ \t]+#+[ \t]*$/, '').trim().replace(/\s+/g,' ').toLocaleLowerCase();
  const setext=displayed.match(/^([^\r\n]+)\r?\n(?:=+|-+)[ \t]*(?:\r?\n|$)/);
  return (heading&&normalized(heading[1])===normalized(title))||(setext&&normalized(setext[1])===normalized(title))?displayed:`# ${title}\n\n${displayed}`;
}

const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
export const approvedTeachAssetUrl = value => typeof value === 'string' && /^\/__asteach-reference\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp)$/i.test(value);

/** Admits only explicitly mapped same-origin fixture images; imported HTML stays inert. */
export function renderTeachSource(source, path, assets, options = {}) {
  const displayed = teachDisplaySource(source);
  const mapped = assets || options.sourceMap ? mapTeachPreviewSource(source, displayed, Boolean(assets)) : {source: displayed};
  const rendered = renderSourcePreview(mapped.source, path, {sourceMap: options.sourceMap === true, sourceLineMap: mapped.lineMap});
  if (!assets) return rendered;
  const images = new Map(rendered.images.map(image => {
    const destination = localLink(image.relativeUrl, path);
    const url = destination ? assets[destination.path] : undefined;
    return [image.id, approvedTeachAssetUrl(url)
      ? `<img class="teach-reference-image" src="${escape(url)}" alt="${escape(image.alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
      : `<span class="teach-reference-image-unavailable" role="img" aria-label="${escape(image.alt)}">${escape(image.alt)} <small>Image not included in this reference.</small></span>`];
  }));
  return {...rendered, html:rendered.html.replace(/<span class="preview-image-placeholder" data-local-image="(local-image-\d+)"[^>]*>[\s\S]*?<\/span>/g, (placeholder, id) => images.get(id) ?? placeholder)};
}
