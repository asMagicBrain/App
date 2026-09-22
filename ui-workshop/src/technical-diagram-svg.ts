import DOMPurify from 'dompurify';
import {DIAGRAM_LIMITS} from './technical-diagram-policy';

const SVG_NS = 'http://www.w3.org/2000/svg';
const tags = ['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'title', 'desc', 'defs', 'marker', 'clipPath'];
const attributes = ['id', 'class', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'transform', 'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'opacity', 'fill-opacity', 'stroke-opacity', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'font-size', 'font-weight', 'dy', 'dx', 'marker-start', 'marker-mid', 'marker-end', 'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient', 'clip-path', 'preserveAspectRatio'];
let nextSvg = 0;

/** Final narrow SVG boundary: no CSS, HTML, links, external references or events. */
export function sanitizeDiagramSvg(markup: string): SVGSVGElement {
  if (markup.length > DIAGRAM_LIMITS.svgBytes || /<!DOCTYPE|<!ENTITY/i.test(markup)) throw Error('Diagram output exceeded the static SVG limits.');
  const original = new DOMParser().parseFromString(markup, 'image/svg+xml');
  if (original.querySelector('parsererror')) throw Error('The renderer returned invalid SVG.');
  // Preserve only finite presentation enums that Mermaid sometimes emits inline.
  // No CSS text, colors, URLs or arbitrary property values cross this boundary.
  for (const element of original.querySelectorAll('[style]')) {
    for (const declaration of (element.getAttribute('style') ?? '').split(';')) {
      const anchor = /^\s*text-anchor\s*:\s*(start|middle|end)\s*$/.exec(declaration);
      if (anchor) element.setAttribute('text-anchor', anchor[1]);
    }
    element.removeAttribute('style');
  }
  const clean = DOMPurify.sanitize(new XMLSerializer().serializeToString(original), {
    ALLOWED_TAGS: [...tags, '#text'], ALLOWED_ATTR: [...attributes, 'xmlns'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: ['style', 'script', 'foreignObject', 'image', 'use', 'a', 'animate', 'set'], FORBID_ATTR: ['style', 'href', 'xlink:href'],
    KEEP_CONTENT: false, RETURN_TRUSTED_TYPE: false,
  });
  const parsed = new DOMParser().parseFromString(clean, 'image/svg+xml');
  const root = parsed.documentElement;
  if (root.localName !== 'svg' || root.namespaceURI !== SVG_NS || parsed.querySelector('parsererror')) throw Error('The renderer returned invalid SVG.');
  const elements = [root, ...root.querySelectorAll('*')];
  if (elements.length > DIAGRAM_LIMITS.svgNodes) throw Error('Diagram output exceeded the static SVG limits.');
  const prefix = `asmb-diagram-svg-${++nextSvg}-`, ids = new Map<string, string>();
  for (const element of elements) {
    if (element.namespaceURI !== SVG_NS || !tags.includes(element.localName)) throw Error('Unexpected content in the diagram.');
    if (element.id) {const id = `${prefix}${ids.size}`; ids.set(element.id, id); element.id = id;}
  }
  for (const element of elements) for (const attr of [...element.attributes]) {
    const name = attr.name, value = attr.value;
    if (name === 'xmlns' && element === root && value === SVG_NS) continue;
    if (!attributes.includes(name) || attr.namespaceURI || /^on/i.test(name)) {element.removeAttributeNode(attr); continue;}
    if (name === 'class' && !/^[a-z\d_\s-]{0,512}$/i.test(value)) element.removeAttribute(name);
    if (/url\s*\(|(?:https?|file|data|javascript):|[<>\\]/i.test(value)) {
      const local = /^(?:marker-start|marker-mid|marker-end|clip-path)$/.test(name) && /^url\(#([a-z\d_-]+)\)$/i.exec(value);
      const target = local && ids.get(local[1]);
      if (target) element.setAttribute(name, `url(#${target})`); else element.removeAttribute(name);
    }
  }
  // Never trust renderer-selected dimensions for page layout.
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0 || box.some(value => Math.abs(value) > 100000)) throw Error('The diagram has invalid dimensions.');
  root.setAttribute('width', String(Math.ceil(box[2]))); root.setAttribute('height', String(Math.ceil(box[3])));
  root.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  return document.importNode(root, true) as unknown as SVGSVGElement;
}
