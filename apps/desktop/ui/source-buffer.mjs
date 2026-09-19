// CM6 uses LF-separated UTF-16 positions. Source authority remains the original
// raw UTF-8 byte sequence; unchanged pieces never pass through serialization.
const fail = () => { throw Object.assign(new Error('Invalid source change or Unicode boundary.'), { code: 'INVALID' }); };
const normalize = text => text.replace(/\r\n|\r/g, '\n');
const valid = text => typeof text === 'string' && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);
export function createSourceBuffer(rawSourceText, edits = []) {
  if (!valid(rawSourceText)) fail();
  let original = rawSourceText;
  const bom = original.startsWith('\ufeff') ? 1 : 0;
  let eol = original.match(/\r\n|\r|\n/)?.[0] ?? '\n';
  let pieces = [{ from: 0, to: original.length }];
  const historySnapshots = new WeakMap(); let currentHistoryToken = null;
  const value = piece => Object.hasOwn(piece, 'text') ? piece.text : original.slice(piece.from, piece.to);
  const raw = () => pieces.map(value).join('');
  const visible = text => normalize(text.slice(bom && text.startsWith('\ufeff') ? 1 : 0));
  function slice(start, end) {
    const result = []; let offset = 0;
    for (const piece of pieces) {
      const size = value(piece).length, from = Math.max(0, start - offset), to = Math.min(size, end - offset);
      if (from < to) result.push(Object.hasOwn(piece, 'text') ? { text: piece.text.slice(from, to) }
        : { from: piece.from + from, to: piece.from + to });
      offset += size;
    }
    return result;
  }
  function replace(changes) {
    currentHistoryToken = null;
    const next = []; let offset = 0;
    for (const change of changes) {
      next.push(...slice(offset, change.from));
      if (change.insert) next.push({ text: change.insert });
      offset = change.to;
    }
    next.push(...slice(offset, raw().length));
    pieces = [];
    for (const piece of next) {
      const last = pieces.at(-1);
      if (last && Object.hasOwn(last, 'text') && Object.hasOwn(piece, 'text')) last.text += piece.text;
      else if (last && !Object.hasOwn(last, 'text') && !Object.hasOwn(piece, 'text') && last.to === piece.from) last.to = piece.to;
      else pieces.push(piece);
    }
  }
  function positions(text, hideBom) {
    const map = new Map([[0, hideBom]]); let visible = 0, offset = hideBom;
    while (offset < text.length) {
      const point = text.codePointAt(offset), size = point > 0xffff ? 2 : 1;
      if (text[offset] === '\r') { offset += text[offset + 1] === '\n' ? 2 : 1; visible++; }
      else { offset += size; visible += size; }
      map.set(visible, offset);
    }
    return map;
  }
  // Restored drafts use original UTF-8 byte offsets, not CM6 positions.
  if (!Array.isArray(edits)) fail();
  let bytePositions, byteOffset;
  function indexOriginal(withRestoredPositions = false) {
    // Byte→UTF-16 lookup is needed only while decoding restored byte edits.
    // Save/rebase and ordinary editing use the typed UTF-16→byte index below;
    // rebuilding a per-code-point Map on every Save supplied no later consumer.
    bytePositions = withRestoredPositions ? new Map([[0, 0]]) : null;
    byteOffset = new Uint32Array(original.length + 1);
    let byte = 0;
    for (let offset = 0; offset < original.length;) {
      const point = original.codePointAt(offset), size = point > 0xffff ? 2 : 1;
      byte += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
      offset += size; bytePositions?.set(byte, offset); byteOffset[offset] = byte;
    }
  }
  indexOriginal(edits.length > 0);
  let previous = -1;
  const restored = edits.map(edit => {
    if (!edit || !Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) || edit.end < edit.start
      || edit.start < previous || !bytePositions.has(edit.start) || !bytePositions.has(edit.end) || !valid(edit.text)) fail();
    previous = edit.end;
    return { from: bytePositions.get(edit.start), to: bytePositions.get(edit.end), insert: edit.text };
  });
  if (restored.length) replace(restored);
  return Object.freeze({
    getText: () => visible(raw()),
    getRawText: raw,
    // Opaque shared-piece snapshots travel only in CM6 invertedEffects. CM6
    // owns event grouping/retention; no full-document copy or typing quota here.
    captureHistory() {
      if (!currentHistoryToken) {
        currentHistoryToken = Object.freeze(Object.create(null));
        historySnapshots.set(currentHistoryToken, { original, pieces: pieces.map(piece => ({ ...piece })) });
      }
      return currentHistoryToken;
    },
    rebase(sourceText) {
      if (!valid(sourceText) || sourceText !== raw()) fail();
      original = sourceText; eol = original.match(/\r\n|\r|\n/)?.[0] ?? '\n';
      pieces = [{ from: 0, to: original.length }]; currentHistoryToken = null; indexOriginal();
    },
    getEdits() {
      if (raw() === original) return [];
      const result = []; let offset = 0, pending = '';
      const emit = end => {
        if (pending !== original.slice(offset, end)) result.push({ start: byteOffset[offset], end: byteOffset[end], text: pending });
        offset = end; pending = '';
      };
      for (const piece of pieces) {
        if (Object.hasOwn(piece, 'text')) { pending += piece.text; continue; }
        if (piece.from !== offset || pending) emit(piece.from);
        offset = piece.to;
      }
      if (offset < original.length || pending) emit(original.length);
      return result;
    },
    applyChanges(changes, options = {}) {
      if (!Array.isArray(changes)) fail();
      if (options.history !== undefined && !['undo', 'redo'].includes(options.history)) fail();
      if (options.history && !historySnapshots.has(options.restore) || !options.history && options.restore !== undefined) fail();
      const text = raw(), map = positions(text, bom && text.startsWith('\ufeff') ? 1 : 0);
      let previousEnd = -1, previousStart = -1;
      const replacements = changes.map(change => {
        if (!change || !Number.isSafeInteger(change.from) || !Number.isSafeInteger(change.to) || change.to < change.from
          || change.from < previousEnd || change.from === previousStart || !map.has(change.from) || !map.has(change.to) || !valid(change.insert)) fail();
        previousEnd = change.to; previousStart = change.from;
        return { from: map.get(change.from), to: map.get(change.to), insert: normalize(change.insert).replace(/\n/g, eol) };
      });
      const beforeVisible = visible(text); let cursor = 0, intended = '';
      for (const change of changes) { intended += beforeVisible.slice(cursor, change.from) + normalize(change.insert); cursor = change.to; }
      intended += beforeVisible.slice(cursor);
      const previousPieces = pieces, previousToken = currentHistoryToken; replace(replacements);
      const nextText = visible(raw());
      if (options.history) {
        const saved = historySnapshots.get(options.restore);
        const restoredText = saved.pieces.map(piece => Object.hasOwn(piece, 'text') ? piece.text : saved.original.slice(piece.from, piece.to)).join('');
        if (visible(restoredText) !== intended) { pieces = previousPieces; currentHistoryToken = previousToken; fail(); }
        pieces = saved.original === original ? saved.pieces.map(piece => ({ ...piece })) : [{ text: restoredText }];
        currentHistoryToken = options.restore;
      } else {
        // Joining a bare CR directly to an LF can collapse two CM6 line breaks.
        // Refuse this ambiguous change instead of silently changing the view or
        // normalizing original separators outside the user's explicit edit.
        if (nextText !== intended) {
          pieces = previousPieces; currentHistoryToken = previousToken;
          throw Object.assign(new Error('This edit would join incompatible original line endings.'), { code: 'UNSUPPORTED' });
        }
        if (nextText === visible(original)) pieces = [{ from: 0, to: original.length }];
      }
      return visible(raw());
    },
  });
}
