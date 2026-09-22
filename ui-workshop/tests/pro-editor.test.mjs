import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorSelection, EditorState} from '@codemirror/state';
import {undo, redo, undoDepth} from '@codemirror/commands';
import {findProVisualBlocks, PRO_VISUAL_LIMITS} from '../src/pro-editor/blocks.mjs';
import {createProVisualExtension, proVisualState, proComposition} from '../src/pro-editor/visual.ts';
import {proEditor, proEditorManifest, proInsertion} from '../src/pro-editor/manifest.ts';
import {createPluginRegistry} from '../src/plugin-foundation/registry.ts';
import {PluginOperationError} from '../src/plugin-foundation/contracts.ts';
import {createRepositoryDocumentSession, RepositoryDocumentSessionError} from '../src/repository-document-session.ts';
import {createFileSession} from '../src/repository-file-session.ts';

const id = proEditorManifest.id;
const codes = {cancelled:'CANCELLED', stale:'STALE', denied:'DENIED', 'read-only':'READ_ONLY', conflict:'CONFLICT', composing:'COMPOSING', invalid:'INVALID_REQUEST', unavailable:'STALE'};
async function fixture(raw = '\ufeff# Draft\r\n\r\n$$\nE = mc^2\n$$\r\n\r\nLast\r', path = 'note.md') {
  const file = createFileSession({documentId: 'pro-fixture', path, sourceHash: 'a'.repeat(64), text: raw, readOnly: false});
  const session = createRepositoryDocumentSession(file, {repositoryId: 'fixture-repository', revision: ''}, EditorState.allowMultipleSelections.of(true));
  let visible = true, beforeRead;
  const registry = createPluginRegistry({grants: {[id]: ['document.read', 'document.edit']}, host: {
    getSnapshot: () => visible ? session.getSnapshot() : null,
    async perform(operation, signal) {
      const admit = () => {if (!visible) throw new PluginOperationError('STALE');};
      try {
        if (operation.capability === 'document.read') {await beforeRead?.(); return await session.read(operation.expected, signal, admit);}
        return await session.transact(operation.expected, operation.payload, signal, admit);
      } catch (error) {
        if (error instanceof RepositoryDocumentSessionError) throw new PluginOperationError(codes[error.code]);
        throw error;
      }
    },
  }});
  assert.equal(registry.registerBundled(proEditorManifest, proEditor).ok, true);
  assert.equal((await registry.enable(id)).ok, true);
  return {file, session, registry, set visible(value) {visible = value;}, set beforeRead(value) {beforeRead = value;}};
}
const command = (session, operation) => operation({state: session.state, dispatch: transaction => session.dispatch([transaction])});
const failure = result => {assert.equal(result.ok, false); return result.error.code;};
const visualize = session => {session.setContribution(createProVisualExtension()); return session.state.field(proVisualState);};

test('visual range discovery follows Markdown blocks and leaves inline, code, nested and incomplete source intact', () => {
  const source = '# Note\n\n$$\nx^2\n$$\n\n\\[y^2\\]\n\n```mermaid\nflowchart LR\n A-->B\n```\n\n`$x$` and $y$\n\n> $$\n> nested\n> $$\n\n```text\n$$ code $$\n```\n\n    $$ indented $$\n\n```mermaid\nunfinished';
  const blocks = findProVisualBlocks(source);
  assert.deepEqual(blocks.map(block => block.kind), ['equation', 'equation', 'diagram']);
  assert.deepEqual(blocks.map(block => block.source), ['$$\nx^2\n$$', '\\[y^2\\]', '```mermaid\nflowchart LR\n A-->B\n```']);
  for (const block of blocks) assert.equal(source.slice(block.from, block.to), block.source);
  assert.deepEqual(findProVisualBlocks('~~~mermaid\nflowchart LR\n A-->B\n~~~~').map(block => block.kind), ['diagram']);
  assert.deepEqual(findProVisualBlocks('```mermaid\nflowchart LR\n A-->B\n~~'), []);
});

test('visual admission bounds parsing and rendered work while surplus text stays source', () => {
  assert.deepEqual(findProVisualBlocks('x'.repeat(PRO_VISUAL_LIMITS.document + 1)), []);
  assert.equal(findProVisualBlocks(('$$x$$\n\n').repeat(100)).length, PRO_VISUAL_LIMITS.blocks);
  assert.equal(findProVisualBlocks(('```mermaid\nflowchart LR\n A-->B\n```\n\n').repeat(30)).length, PRO_VISUAL_LIMITS.diagrams);
  assert.deepEqual(findProVisualBlocks(`$$${'x'.repeat(4097)}$$`), []);
});

test('visual/source contribution swaps preserve raw BOM/endings, selection, unsaved draft and undo', async () => {
  const {file, session, registry} = await fixture();
  const original = file.buffer.getRawText();
  await session.transact(session.getSnapshot(), {changes: [{from: 2, to: 2, insert: 'Edited '}]});
  const changed = file.buffer.getRawText(), selection = session.state.selection, depth = undoDepth(session.state);
  for (let index = 0; index < 6; index++) {
    assert.equal(visualize(session).decorations.size, 1);
    assert.equal(session.state.selection, selection); assert.equal(undoDepth(session.state), depth);
    assert.equal(file.buffer.getRawText(), changed); session.setContribution([]);
  }
  assert.equal(command(session, undo), true); assert.equal(file.buffer.getRawText(), original);
  assert.equal(command(session, redo), true); assert.equal(file.buffer.getRawText(), changed);
  assert.equal(file.saved, original); registry.dispose();
});

test('cursor/range/multiple selection and composition reveal real source; no source transaction is issued', async () => {
  const {file, session, registry} = await fixture(); const original = file.buffer.getRawText();
  const block = visualize(session).blocks[0];
  session.dispatch([session.state.update({selection: {anchor: block.from + 2}})]);
  assert.equal(session.state.field(proVisualState).decorations.size, 0);
  session.dispatch([session.state.update({selection: {anchor: 0, head: block.to + 1}})]);
  assert.equal(session.state.field(proVisualState).decorations.size, 0);
  session.dispatch([session.state.update({selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(block.from + 2)])})]);
  assert.equal(session.state.field(proVisualState).decorations.size, 0);
  session.dispatch([session.state.update({selection: {anchor: 0}})]);
  assert.equal(session.state.field(proVisualState).decorations.size, 1);
  session.dispatch([session.state.update({effects: proComposition.of(true)})]);
  assert.equal(session.state.field(proVisualState).decorations.size, 0);
  session.dispatch([session.state.update({effects: proComposition.of(false)})]);
  assert.equal(session.state.field(proVisualState).decorations.size, 1);
  assert.equal(file.buffer.getRawText(), original); assert.equal(undoDepth(session.state), 0); registry.dispose();
});

test('equation/diagram insertion is a checked source edit with selection, raw-byte identity and undo/redo', async () => {
  for (const kind of ['equation', 'diagram']) {
    const {file, session, registry} = await fixture('\ufeffAlpha\r\nBeta\nGamma\r'); const original = file.saved;
    session.dispatch([session.state.update({selection: {anchor: session.state.doc.length, head: 0}})]);
    assert.equal((await registry.invoke(`${id}.${kind}`)).ok, true);
    const changed = file.buffer.getRawText();
    assert.ok(changed.includes('Alpha\r\nBeta\nGamma\r'), 'selected line-ending bytes survive delimiters');
    assert.equal(changed[0], '\ufeff'); assert.equal(session.state.sliceDoc(session.state.selection.main.from, session.state.selection.main.to), 'Alpha\nBeta\nGamma\n');
    assert.equal(command(session, undo), true); assert.equal(file.buffer.getRawText(), original);
    assert.equal(command(session, redo), true); assert.equal(file.buffer.getRawText(), changed);
    assert.equal(file.saved, original); assert.equal(file.sourceHash, 'a'.repeat(64)); registry.dispose();
  }
});

test('empty selection inserts a bounded template and preserves surrounding text', () => {
  for (const kind of ['equation', 'diagram']) {
    const result = proInsertion(kind, {text: 'beforeafter', selection: {anchor: 6, head: 6}});
    assert.equal(result.changes.length, 1); assert.equal(result.changes[0].from, 6); assert.equal(result.changes[0].to, 6);
    assert.ok(result.changes[0].insert.startsWith('\n\n')); assert.ok(result.changes[0].insert.endsWith('\n\n'));
    assert.ok(result.selection.head > result.selection.anchor);
  }
});

test('race, visibility, readonly, conflict, composition and unsupported types refuse Pro mutations', async () => {
  for (const boundary of ['race', 'hidden', 'readOnly', 'conflict', 'composing', 'type']) {
    const f = await fixture(undefined, boundary === 'type' ? 'data.json' : 'note.md'), original = f.file.saved;
    if (boundary === 'hidden') f.visible = false;
    if (boundary === 'readOnly' || boundary === 'conflict') f.file[boundary] = true;
    if (boundary === 'race') f.beforeRead = () => f.session.dispatch([f.session.state.update({selection: {anchor: 4}})]);
    if (boundary === 'composing') f.session.attach({state: f.session.state, composing: true, update() {}, setState() {}});
    assert.equal(failure(await f.registry.invoke(`${id}.equation`)), {race:'STALE', hidden:'STALE', readOnly:'READ_ONLY', conflict:'CONFLICT', composing:'COMPOSING', type:'DENIED'}[boundary]);
    assert.equal(f.file.buffer.getRawText(), original); assert.equal(f.registry.snapshot()[0].state, 'enabled'); f.registry.dispose();
  }
});

test('disable while Pro reads revokes edits and toggling contribution cancels a queued request', async () => {
  const f = await fixture(); let finish, start;
  const started = new Promise(resolve => {start = resolve;});
  f.beforeRead = () => {start(); return new Promise(resolve => {finish = resolve;});};
  const pending = f.registry.invoke(`${id}.diagram`); await started; f.registry.disable(id); finish();
  assert.ok(['CANCELLED', 'REVOKED'].includes(failure(await pending))); assert.equal(f.file.buffer.getRawText(), f.file.saved);
  const request = f.session.transact(f.session.getSnapshot(), {changes: [{from: 0, to: 0, insert: 'late'}]});
  visualize(f.session); await assert.rejects(request, error => error.code === 'cancelled');
  assert.equal(f.file.buffer.getRawText(), f.file.saved); f.registry.dispose();
});
