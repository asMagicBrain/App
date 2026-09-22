// Rendering transformations retain provenance for synchronized source scrolling.
// Neither this map nor the display text is a replacement for saved Markdown.
function lineStarts(text) {
  const starts = [0];
  for (const match of text.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
  return starts;
}
function lineAt(starts, position) {
  let low = 0, high = starts.length;
  while (low < high) {const middle = (low + high) >>> 1; if (starts[middle] <= position) low = middle + 1; else high = middle;}
  return Math.max(1, low);
}

/** displayed is either the unchanged input or its recognized frontmatter suffix. */
export function mapTeachPreviewSource(original, displayed, reference = false) {
  const offset = original.length - displayed.length;
  if (offset < 0 || original.slice(offset) !== displayed) throw Error('Preview mapping requires an original source suffix.');
  const segments = [], output = [];
  let outputLength = 0;
  const emit = (text, from, literal) => {
    if (!text) return;
    segments.push({from: outputLength, to: outputLength + text.length, origin: offset + from, literal});
    output.push(text); outputLength += text.length;
  };
  const raw = (from, to) => emit(displayed.slice(from, to), from, true);
  const figures = (from, to) => {
    let cursor = from;
    const part = displayed.slice(from, to);
    for (const match of part.matchAll(/<figure>\s*(<img\s+[^>]*>)\s*(?:<figcaption>\s*([^<>]*)\s*<\/figcaption>)?\s*<\/figure>/gi)) {
      const [figure, tag, caption = ''] = match;
      const src = tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2];
      if (!src || /[\s<>"'()]/.test(src)) continue;
      const start = from + match.index;
      raw(cursor, start);
      const alt = tag.match(/\balt\s*=\s*(["'])(.*?)\1/i)?.[2] || caption || 'Reference image';
      emit(`![${alt.replace(/[\[\]\\]/g, '')}](${src})${caption ? `\n\n${caption}` : ''}`, start, false);
      cursor = start + figure.length;
    }
    raw(cursor, to);
  };
  if (!reference) raw(0, displayed.length);
  else {
    let cursor = 0;
    for (const match of displayed.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
      figures(cursor, match.index);
      let fence = '~~~~'; while (match[0].includes(fence)) fence += '~';
      emit(`\n\n**Preserved GitBook table (source)**\n\n${fence}html\n`, match.index, false);
      raw(match.index, match.index + match[0].length);
      emit(`\n${fence}\n\n`, match.index + match[0].length, false);
      cursor = match.index + match[0].length;
    }
    figures(cursor, displayed.length);
  }
  const source = output.join(''), starts = lineStarts(original), renderedStarts = lineStarts(source);
  let segmentIndex = 0;
  const lineMap = renderedStarts.map(position => {
    while (segmentIndex + 1 < segments.length && segments[segmentIndex].to <= position) segmentIndex++;
    const segment = segments[segmentIndex];
    const origin = segment ? segment.origin + (segment.literal ? Math.min(position - segment.from, segment.to - segment.from) : 0) : offset;
    return lineAt(starts, origin);
  });
  // MarkdownIt may give a final exclusive line beyond the last line start.
  lineMap.push(starts.length + 1);
  return {source, lineMap};
}
