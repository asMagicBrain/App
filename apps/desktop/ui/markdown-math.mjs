import katex from 'katex';

// Admission bounds, not a JavaScript execution timeout. A synchronous KaTeX
// call cannot be interrupted by a timer; limit its input/expansion before entry.
export const MATH_LIMITS = Object.freeze({
  equations: 128, source: 4096, documentSource: 32768,
  tokens: 1024, documentTokens: 8192, nesting: 32,
  expansions: 256, sizeEm: 20, output: 128 * 1024, documentOutput: 1024 * 1024,
});

const forbiddenCommands = new Set([
  // No repository-defined macros, dynamic command construction, or state shared
  // with another equation. Built-in KaTeX commands are the supported vocabulary.
  'def', 'gdef', 'edef', 'xdef', 'let', 'futurelet', 'newcommand', 'renewcommand',
  'providecommand', 'global', 'long', 'expandafter', 'csname', 'endcsname', 'catcode',
  // trust:false is also enforced in KaTeX. Reject these early so the reader gets
  // a useful local diagnostic instead of a colored unsupported command.
  'href', 'url', 'includegraphics', 'htmlClass', 'htmlId', 'htmlStyle', 'htmlData',
  'input', 'include', 'write', 'openout', 'read', 'usepackage', 'documentclass',
]);

function preflight(source) {
  if (source.length > MATH_LIMITS.source) return { error: 'Equation exceeds the 4,096-character reading limit.' };
  let tokens = 0, depth = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (/\s/u.test(char)) continue;
    if (++tokens > MATH_LIMITS.tokens) return { error: 'Equation exceeds the 1,024-token reading limit.' };
    if (char === '%') {
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end;
    } else if (char === '\\') {
      const match = /^[a-zA-Z]+/u.exec(source.slice(index + 1));
      if (!match) { index++; continue; }
      const command = match[0];
      if (forbiddenCommands.has(command)) return { error: `The command \\${command} is disabled in reading view.` };
      if (command === 'begin') depth++;
      if (command === 'end') depth--;
      index += command.length;
    } else if (char === '{') depth++;
    else if (char === '}') depth--;
    if (depth > MATH_LIMITS.nesting) return { error: 'Equation exceeds the 32-level nesting limit.' };
  }
  return { tokens };
}

const escapedAt = (source, position) => {
  let backslashes = 0;
  while (position > 0 && source[--position] === '\\') backslashes++;
  return backslashes % 2 === 1;
};

function inlineMath(state, silent) {
  if (!state.env.technical) return false;
  const start = state.pos, source = state.src;
  const dollar = source[start] === '$';
  const opening = dollar ? '$' : source.slice(start, start + 2) === '\\(' ? '\\(' : '';
  if (!opening || (dollar && (source[start + 1] === '$' || source[start - 1] === '$'))) return false;
  // Dollar math is deliberately conservative: no initial digit/whitespace,
  // no trailing whitespace, and no adjacent alphanumeric prose. Use \(...\)
  // for numeric-leading formulas; $5, $10 and ordinary prices stay text.
  if (dollar && (/[\s\d]/u.test(source[start + 1] ?? ' ') || /[\p{L}\p{N}]/u.test(source[start - 1] ?? ''))) return false;
  const close = dollar ? '$' : '\\)';
  // An unsuccessful scan proves there is no closing delimiter before its code
  // or line boundary for every later opener in that same interval. Cache that
  // boundary to avoid quadratic rescans of hostile unmatched-dollar prose.
  const misses = state.mathMissingCloses ??= Object.create(null);
  if ((misses[close] ?? -1) >= start) return false;
  const contentStart = start + opening.length;
  for (let index = contentStart; index < state.posMax; index++) {
    if (source[index] === '\n' || source[index] === '`') { misses[close] = index; return false; }
    if (!source.startsWith(close, index) || escapedAt(source, index)) continue;
    if (dollar && (/\s/u.test(source[index - 1] ?? ' ') || /[\p{L}\p{N}$]/u.test(source[index + 1] ?? ''))) return false;
    if (index === contentStart) return false;
    if (!silent) {
      const count = state.env.mathTokenCount ?? 0;
      state.env.mathTokenCount = count + 1;
      if (count > MATH_LIMITS.equations) {
        // Emit one document-limit diagnostic, then coalesce surplus inline math
        // into ordinary escaped text instead of amplifying it into a large DOM.
        state.pending += source.slice(start, index + close.length);
      } else {
        const token = state.push('math_inline', 'span', 0);
        token.content = source.slice(contentStart, index);
        token.markup = opening;
      }
    }
    state.pos = index + close.length;
    return true;
  }
  misses[close] = state.posMax;
  return false;
}

function blockMath(state, startLine, endLine, silent) {
  if (!state.env.technical || state.sCount[startLine] - state.blkIndent >= 4) return false;
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const opening = state.src.slice(start, start + 2);
  if (!['$$', '\\['].includes(opening)) return false;
  const close = opening === '$$' ? '$$' : '\\]';
  let content = '';
  for (let line = startLine; line < endLine; line++) {
    if (line > startLine && (state.isEmpty(line) || state.sCount[line] < state.blkIndent)) return false;
    const text = line === startLine ? state.src.slice(start + 2, state.eMarks[line])
      : state.getLines(line, line + 1, state.sCount[startLine], false);
    let position = text.indexOf(close);
    while (position >= 0 && escapedAt(text, position)) position = text.indexOf(close, position + 2);
    if (position >= 0) {
      // Display delimiters occupy their own block. Never consume prose or a
      // second equation after the closing delimiter on the same line.
      if (text.slice(position + 2).trim()) return false;
      if (silent) return true;
      const count = state.env.mathTokenCount ?? 0;
      state.env.mathTokenCount = count + 1;
      const token = state.push(count > MATH_LIMITS.equations ? 'math_literal' : 'math_block', 'div', 0);
      token.content = content + text.slice(0, position);
      token.markup = opening;
      token.map = [startLine, line + 1];
      state.line = line + 1;
      return true;
    }
    content += `${text}\n`;
    // Bound unmatched delimiter scanning as well as rendering. Oversized math
    // with a nearby closing delimiter still receives its local diagnostic.
    if (content.length > MATH_LIMITS.source * 2) return false;
  }
  return false;
}

function renderMath(tokens, index, _options, env, renderer, escape, settings) {
  const token = tokens[index], display = token.type === 'math_block';
  const budget = env.mathBudget ??= { equations: 0, source: 0, tokens: 0, output: 0 };
  const admitted = preflight(token.content);
  budget.equations++;
  budget.source += token.content.length;
  budget.tokens += admitted.tokens ?? 0;
  let error = admitted.error;
  if (budget.equations > MATH_LIMITS.equations || budget.source > MATH_LIMITS.documentSource || budget.tokens > MATH_LIMITS.documentTokens || budget.output >= MATH_LIMITS.documentOutput) {
    error = 'Document math reading limit reached. Split equations into smaller documents.';
  }
  let html = '';
  if (!error) {
    try {
      html = katex.renderToString(token.content, {
        displayMode: display, output: settings.output, throwOnError: true,
        trust: false, strict: 'error', maxSize: MATH_LIMITS.sizeEm,
        maxExpand: MATH_LIMITS.expansions, macros: Object.create(null), globalGroup: false,
      });
      if (html.length > MATH_LIMITS.output || budget.output + html.length > MATH_LIMITS.documentOutput) {
        error = 'Equation output exceeds the reading limit.';
        html = '';
      }
    } catch (cause) {
      error = String(cause?.message ?? 'Unsupported or invalid TeX.').slice(0, 300);
    }
  }
  budget.output += html.length;
  const tag = display ? 'div' : 'span';
  const attributes = renderer.renderAttrs(token);
  // Attribute escaping retains the source for Copy TeX without accepting markup.
  // A source fallback is visible on error, including when a work budget is hit.
  const body = error ? `<span class="preview-math-diagnostic">Math: ${escape(error)}</span> <code class="preview-math-source">${escape(token.content)}</code>` : `<span class="preview-math-render">${html}</span>`;
  const copy = !settings.copyButton || env.linkTags?.includes('a') ? '' : '<button type="button" class="preview-math-copy" data-copy-math aria-label="Copy TeX source" title="Copy TeX source">Copy TeX</button>';
  return `<${tag}${attributes} class="preview-math preview-math-${display ? 'display' : 'inline'}${error ? ' preview-math-error' : ''}" data-math-source="${escape(token.content)}">${body}${copy}</${tag}>${display ? '\n' : ''}`;
}

/** No source rewriting or auto-render pass: code is consumed by Markdown's code
 * rules, and explicit math tokens reach KaTeX before Markdown emphasis runs. */
export function installMath(parser, {output = 'htmlAndMathml', copyButton = true} = {}) {
  if (!['htmlAndMathml', 'mathml'].includes(output) || typeof copyButton !== 'boolean') throw Error('Invalid math rendering options.');
  const settings = {output, copyButton};
  parser.inline.ruler.before('escape', 'math_inline', inlineMath);
  parser.block.ruler.before('fence', 'math_block', blockMath, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  for (const type of ['math_inline', 'math_block']) {
    parser.renderer.rules[type] = (tokens, index, options, env, renderer) => renderMath(tokens, index, options, env, renderer, parser.utils.escapeHtml, settings);
  }
  parser.renderer.rules.math_literal = (tokens, index) => {
    const token = tokens[index], close = token.markup === '$$' ? '$$' : '\\]';
    return `<pre><code>${parser.utils.escapeHtml(token.markup + token.content + close)}</code></pre>\n`;
  };
}
