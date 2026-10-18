/** Copy a reading selection as Markdown. Equations are atomic: even a partial
 * rendered-symbol selection copies the whole original equation, never KaTeX's
 * duplicated visual/accessibility trees. Editable descendants keep native copy. */
export function selectionMarkdown(root, range) {
  const doc = root.ownerDocument;
  const intersects = node => {try {return range.intersectsNode(node);} catch {return false;}};
  const full = node => {
    const inside = doc.createRange(); inside.selectNodeContents(node);
    return range.compareBoundaryPoints(0, inside) <= 0 && range.compareBoundaryPoints(2, inside) >= 0;
  };
  const visit = node => {
    if (!intersects(node)) return '';
    if (node.nodeType === 3) {
      const start = range.startContainer === node ? range.startOffset : 0;
      const end = range.endContainer === node ? range.endOffset : node.textContent.length;
      return node.textContent.slice(start, end);
    }
    if (node.nodeType !== 1) return '';
    if (node.matches('button,[role="status"],input,textarea,[contenteditable="true"]')) return '';
    if (node.hasAttribute('data-math-source')) {
      const display = node.classList.contains('preview-math-display');
      const delimiter = display ? '$$' : '$';
      const source = node.dataset.mathSource;
      return display ? `\n\n$$${source.startsWith('\n') ? '' : '\n'}${source}${source.endsWith('\n') ? '' : '\n'}$$\n\n` : `${delimiter}${source}${delimiter}`;
    }
    if (node.hasAttribute('data-copy-source') && full(node)) return `\n\n${node.dataset.copySource}\n\n`;
    const text = [...node.childNodes].map(visit).join('');
    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${text}\n\n`;
    if (tag === 'strong') return text ? `**${text}**` : '';
    if (tag === 'em') return text ? `*${text}*` : '';
    if (tag === 's') return text ? `~~${text}~~` : '';
    if (tag === 'code' && node.parentElement?.tagName !== 'PRE') {
      const ticks = '`'.repeat(Math.max(1, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
      return text ? `${ticks}${text}${ticks}` : '';
    }
    if (tag === 'pre') {
      const language = node.querySelector('code')?.className.match(/(?:^|\s)language-(\S+)/)?.[1] ?? '';
      const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
      return `\n\n${fence}${language}\n${text.replace(/\n$/, '')}\n${fence}\n\n`;
    }
    if (tag === 'a') {
      const target = node.dataset.localLink ?? node.getAttribute('href');
      return target && text ? `[${text}](${target})` : text;
    }
    if (tag === 'li') {
      const ordered = node.parentElement?.tagName === 'OL';
      const index = [...node.parentElement.children].indexOf(node) + Number(node.parentElement.getAttribute('start') ?? 1);
      return `\n${ordered ? `${index}.` : '-'} ${text.trim()}\n`;
    }
    if (tag === 'blockquote') return `\n\n${text.trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
    if (tag === 'br') return '\n';
    if (['p','div','ul','ol','table','figure'].includes(tag)) return `\n\n${text}\n\n`;
    return text;
  };
  return [...root.childNodes].filter(node => node.nodeType !== 3 || node.textContent.trim()).map(visit).filter(Boolean).map(text => text.replace(/^\n+|\n+$/g, '')).join('\n\n');
}

export function installDocumentClipboard(root, signal) {
  root.ownerDocument.addEventListener('keydown', event => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'a') return;
    if (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable="true"]')) return;
    const selection = root.ownerDocument.getSelection();
    if (!selection?.anchorNode || !root.contains(selection.anchorNode)) return;
    const range = root.ownerDocument.createRange(); range.selectNodeContents(root);
    selection.removeAllRanges(); selection.addRange(range); event.preventDefault();
  }, {signal});
  root.ownerDocument.addEventListener('copy', event => {
    if (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable="true"]')) return;
    const selection = root.ownerDocument.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !event.clipboardData) return;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    const markdown = selectionMarkdown(root, range);
    if (!markdown) return;
    event.clipboardData.setData('text/plain', markdown);
    event.preventDefault();
  }, {signal});
}
