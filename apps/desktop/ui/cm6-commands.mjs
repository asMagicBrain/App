import { EditorSelection } from '@codemirror/state';

/** Edits are simultaneous UTF-16 ranges in the transaction's ORIGINAL document.
 * Only inserted text is serialized; original file bytes belong to the host. */
export function sourceChanges(changes) {
  const result = [];
  changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
    result.push({ from, to, insert: inserted.toString() });
  });
  return result;
}

export function formatSource(state, action) {
  const wrappers = { bold: ['**', '**'], italic: ['*', '*'], code: ['`', '`'], link: ['[', '](relative-path.md)'] };
  if (Object.hasOwn(wrappers, action)) {
    const [before, after] = wrappers[action];
    return state.changeByRange(range => ({
      changes: range.empty ? { from: range.from, insert: before + after }
        : [{ from: range.from, insert: before }, { from: range.to, insert: after }],
      range: EditorSelection.range(range.from + before.length, range.to + before.length),
    }));
  }
  const prefix = { heading: '## ', bullet: '- ', quote: '> ', task: '- [ ] ' }[action];
  if (!prefix) throw Error('Unknown source-formatting action.');
  const positions = new Set();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.empty ? range.to : range.to - 1).number;
    for (let number = first; number <= last; number++) positions.add(state.doc.line(number).from);
  }
  return { changes: [...positions].sort((a, b) => a - b).map(from => ({ from, insert: prefix })), userEvent: 'input.format' };
}
