import MarkdownIt from 'markdown-it';
import {installMath, MATH_LIMITS} from '../../../apps/desktop/ui/markdown-math.mjs';

const parser = new MarkdownIt({html: false, linkify: false, typographer: false, maxNesting: 32});
installMath(parser);
export const PRO_VISUAL_LIMITS = Object.freeze({document: 524288, blocks: 32, diagrams: 16, block: 8192, renderedSource: 32768});

/** Recognize source ranges, never serialize Markdown. Only complete top-level
 * display equations and fenced Mermaid have a visual replacement. Everything
 * else (including nested blocks, inline math and unfinished fences) stays source. */
export function findProVisualBlocks(source) {
  if (typeof source !== 'string' || source.length > PRO_VISUAL_LIMITS.document) return [];
  const offsets = [0];
  for (let index = 0; index < source.length; index++) if (source[index] === '\n') offsets.push(index + 1);
  let renderedSource = 0, diagrams = 0;
  const result = [];
  for (const token of parser.parse(source, {technical: true})) {
    if (token.level !== 0 || !token.map || result.length >= PRO_VISUAL_LIMITS.blocks) continue;
    const kind = token.type === 'math_block' ? 'equation' : token.type === 'fence' && token.info.trim().toLowerCase() === 'mermaid' ? 'diagram' : null;
    if (!kind) continue;
    const from = offsets[token.map[0]], next = offsets[token.map[1]] ?? source.length;
    const to = next > from && source[next - 1] === '\n' ? next - 1 : next;
    const raw = source.slice(from, to);
    if (raw.length > PRO_VISUAL_LIMITS.block || (kind === 'equation' && token.content.length > MATH_LIMITS.source)
      || renderedSource + raw.length > PRO_VISUAL_LIMITS.renderedSource) continue;
    if (kind === 'diagram') {
      const rows = raw.split('\n'), opening = /^ {0,3}(`{3,}|~{3,})mermaid\s*$/i.exec(rows[0]);
      if (!opening || rows.length < 2 || !new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}\\s*$`).test(rows.at(-1))
        || diagrams >= PRO_VISUAL_LIMITS.diagrams) continue;
      diagrams++;
    }
    renderedSource += raw.length;
    result.push(Object.freeze({kind, from, to, source: raw}));
  }
  return Object.freeze(result);
}

export function proBlockSelected(block, selection) {
  return selection.ranges.some(range => range.from <= block.to && range.to >= block.from);
}
