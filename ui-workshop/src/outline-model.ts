import MarkdownIt, {type Token} from 'markdown-it';

export type DocumentOutlineEntry = {
  /** Matches the existing Markdown preview's source-heading-N identifier. */
  id: string;
  title: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  /** One-based source line; from/to are UTF-16 offsets in the supplied text. */
  line: number;
  from: number;
  to: number;
};

// Keep these options aligned with markdown-preview.mjs. Heading recognition is
// the parser's job, including fences, indentation, containers and setext syntax.
const parser = new MarkdownIt({html: false, linkify: false, typographer: false, breaks: false, maxNesting: 32});

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (code === 13) {
      if (source.charCodeAt(index + 1) === 10) index++;
      starts.push(index + 1);
    } else if (code === 10) starts.push(index + 1);
  }
  return starts;
}

function visibleTitle(tokens: Token[]): string {
  return tokens.map(token => {
    if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
    if (token.type === 'text' || token.type === 'code_inline' || token.type === 'image') return token.content;
    return token.children ? visibleTitle(token.children) : '';
  }).join('').replace(/\s+/gu, ' ').trim();
}

/** Read-only outline of actual Markdown. Pass the current CM6/buffer text for
 * editor coordinates; this function never serializes or alters source bytes. */
export function buildDocumentOutline(source: string): DocumentOutlineEntry[] {
  const tokens = parser.parse(source, {}), starts = lineStarts(source);
  const entries: DocumentOutlineEntry[] = [];
  let headingNumber = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== 'heading_open') continue;
    // Even a blank heading owns a preview ID. Do not renumber later entries when
    // omitting its empty outline label.
    const id = `source-heading-${++headingNumber}`;
    const inline = tokens[index + 1], title = visibleTitle(inline?.children ?? []);
    const level = Number(token.tag.slice(1));
    if (!title || !token.map || level < 1 || level > 6) continue;
    const [start, end] = token.map;
    entries.push({id, title, level: level as DocumentOutlineEntry['level'], line: start + 1,
      from: starts[start] ?? source.length, to: starts[end] ?? source.length});
  }
  return entries;
}
