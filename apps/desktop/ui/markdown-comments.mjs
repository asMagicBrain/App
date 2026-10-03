/** Comment-only Markdown extension. General HTML stays disabled. Parsing emits
 * inert tokens, never HTML nodes or rewritten source. Code/escape rules retain
 * precedence; block maps preserve original line numbers for editor navigation. */
export function installComments(parser) {
  parser.block.ruler.before('html_block', 'markdown_comment_block', (state, start, end, silent) => {
    const pos = state.bMarks[start] + state.tShift[start];
    if (state.sCount[start] - state.blkIndent >= 4 || !state.src.startsWith('<!--', pos)) return false;
    if (silent) return true;
    // CommonMark comment blocks consume the closing line, or the remainder of
    // their current container when unfinished. A blank line does not end one.
    let next = start + 1;
    if (!state.src.slice(pos, state.eMarks[start]).includes('-->')) {
      for (; next < end; next++) {
        if (state.sCount[next] < state.blkIndent && !state.isEmpty(next)) break;
        if (state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]).includes('-->')) { next++; break; }
      }
    }
    const token = state.push('markdown_comment', '', 0);
    token.block = true; token.map = [start, next];
    state.line = next;
    return true;
  }, {alt: ['paragraph', 'reference', 'blockquote']});
  parser.inline.ruler.before('html_inline', 'markdown_comment_inline', (state, silent) => {
    if (!state.src.startsWith('<!--', state.pos)) return false;
    // The comment alternatives used by Markdown-it's HTML grammar, without
    // accepting tags, processing instructions, declarations or CDATA.
    const match = /^(?:<!---?>|<!--(?:[^-]|-[^-]|--[^>])*-->)/.exec(state.src.slice(state.pos, state.posMax));
    if (!match) return false;
    if (!silent) { const token = state.push('markdown_comment', '', 0); }
    state.pos += match[0].length;
    return true;
  });
  parser.renderer.rules.markdown_comment = () => '';
}

/** Plain accessible labels: comments must not leak through image alt text or
 * heading metadata even when custom renderers bypass Markdown-it's defaults. */
export function visibleInlineText(tokens = []) {
  return tokens.map(token => token.type === 'markdown_comment' ? ''
    : token.children ? visibleInlineText(token.children)
    : ['text', 'code_inline', 'math_inline'].includes(token.type) ? token.content
    : ['softbreak', 'hardbreak'].includes(token.type) ? ' ' : '').join('');
}
