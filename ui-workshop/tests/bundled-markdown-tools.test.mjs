import test from 'node:test';
import assert from 'node:assert/strict';
import {undo, redo} from '@codemirror/commands';
import {markdownTools, markdownToolsManifest} from '../src/bundled-markdown-tools.ts';
import {createPluginRegistry} from '../src/plugin-foundation/registry.ts';
import {PluginOperationError} from '../src/plugin-foundation/contracts.ts';
import {createRepositoryDocumentSession, RepositoryDocumentSessionError} from '../src/repository-document-session.ts';
import {createFileSession} from '../src/repository-file-session.ts';

const id = markdownToolsManifest.id;
const initial = '\ufeffFirst\r\nSecond\nThird\r';
const codes = {cancelled:'CANCELLED', stale:'STALE', denied:'DENIED', 'read-only':'READ_ONLY', conflict:'CONFLICT', composing:'COMPOSING', invalid:'INVALID_REQUEST', unavailable:'STALE'};
async function fixture(raw = initial) {
  const file = createFileSession({documentId: 'fixture', path: 'fixture.md', sourceHash: 'a'.repeat(64), text: raw, readOnly: false});
  const session = createRepositoryDocumentSession(file, {repositoryId: 'fixture-repository', revision: ''});
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
  assert.equal(registry.registerBundled(markdownToolsManifest, markdownTools).ok, true);
  assert.equal((await registry.enable(id)).ok, true);
  return {file, session, registry, set visible(value) {visible = value;}, set beforeRead(value) {beforeRead = value;}};
}
const command = (session, operation) => operation({state: session.state, dispatch: transaction => session.dispatch([transaction])});
const resultCode = result => {assert.equal(result.ok, false); return result.error.code;};

test('bundled bold inserts Markdown delimiters without reserializing selected original bytes', async () => {
  const {file, session, registry} = await fixture();
  session.dispatch([session.state.update({selection: {anchor: 0, head: session.state.doc.length}})]);
  assert.equal((await registry.invoke(`${id}.bold`)).ok, true);
  assert.equal(file.buffer.getRawText(), '\ufeff**First\r\nSecond\nThird\r**');
  assert.equal(file.saved, initial); assert.equal(file.sourceHash, 'a'.repeat(64));
  assert.equal(command(session, undo), true); assert.equal(file.buffer.getRawText(), initial);
  assert.equal(command(session, redo), true); assert.equal(file.buffer.getRawText(), '\ufeff**First\r\nSecond\nThird\r**');
  registry.dispose();
});

test('empty and reversed selections use the shared CM6 authority', async () => {
  for (const selection of [{anchor: 0, head: 0}, {anchor: 5, head: 0}]) {
    const {file, session, registry} = await fixture('First 😀');
    session.dispatch([session.state.update({selection})]);
    assert.equal((await registry.invoke(`${id}.bold`)).ok, true);
    assert.equal(file.buffer.getRawText(), selection.anchor === 0 ? '**text**First 😀' : '**First** 😀');
    assert.equal(session.state.selection.main.from, 2);
    assert.equal(session.state.selection.main.to, selection.anchor === 0 ? 6 : 7);
    assert.equal(command(session, undo), true); assert.equal(file.buffer.getRawText(), file.saved);
    registry.dispose();
  }
});

test('enable/disable cycles remove contributions and preserve source, selection and history', async () => {
  const {file, session, registry} = await fixture('One');
  session.dispatch([session.state.update({selection: {anchor: 0, head: 3}})]);
  assert.equal((await registry.invoke(`${id}.bold`)).ok, true);
  const retained = session.state;
  for (let index = 0; index < 3; index++) {
    assert.equal(registry.disable(id).ok, true); assert.equal(registry.contributions().length, 0);
    assert.equal(resultCode(await registry.invoke(`${id}.bold`)), 'DISABLED');
    assert.equal(session.state, retained); assert.equal(file.buffer.getRawText(), '**One**');
    assert.equal((await registry.enable(id)).ok, true); assert.equal(registry.contributions().length, 5);
    assert.equal(registry.diagnostics().commands, 2); assert.equal(registry.diagnostics().tasks, 0); assert.equal(registry.diagnostics().leases, 0);
  }
  assert.equal(command(session, undo), true); assert.equal(file.buffer.getRawText(), 'One');
  registry.dispose(); assert.equal(file.saved, 'One');
});

test('statistics read the current unsaved document without changing saved source', async () => {
  const {file, session, registry} = await fixture('One 😀');
  await session.transact(session.getSnapshot(), {changes: [{from: 0, to: 0, insert: 'Draft\n'}]});
  const retained = session.state;
  const result = await registry.invoke(`${id}.statistics`);
  assert.equal(result.ok, true); assert.deepEqual(result.value, {kind: 'statistics', words: 3, characters: 11, lines: 2});
  assert.equal(session.state, retained); assert.equal(file.saved, 'One 😀'); registry.dispose();
});

test('hidden, read-only and conflicting documents refuse bundled edits without failing the plugin', async () => {
  for (const boundary of ['hidden', 'readOnly', 'conflict']) {
    const f = await fixture();
    if (boundary === 'hidden') f.visible = false; else f.file[boundary] = true;
    assert.equal(resultCode(await f.registry.invoke(`${id}.bold`)), {hidden: 'STALE', readOnly: 'READ_ONLY', conflict: 'CONFLICT'}[boundary]);
    assert.equal(f.file.buffer.getRawText(), initial); assert.equal(f.registry.snapshot()[0].state, 'enabled'); f.registry.dispose();
  }
});

test('a selection changed during a contributed read cannot receive the late bold edit', async () => {
  const f = await fixture();
  f.session.dispatch([f.session.state.update({selection: {anchor: 0, head: 5}})]);
  f.beforeRead = () => f.session.dispatch([f.session.state.update({selection: {anchor: 6, head: 12}})]);
  assert.equal(resultCode(await f.registry.invoke(`${id}.bold`)), 'STALE');
  assert.equal(f.file.buffer.getRawText(), initial); assert.equal(f.session.state.selection.main.anchor, 6); f.registry.dispose();
});

test('disabling a plugin during a pending read revokes its operation and leaves no late source edit', async () => {
  const f = await fixture();
  let finishRead, readStarted;
  const started = new Promise(resolve => {readStarted = resolve;});
  f.beforeRead = () => {readStarted(); return new Promise(resolve => {finishRead = resolve;});};
  const pending = f.registry.invoke(`${id}.bold`); await started;
  f.registry.disable(id); finishRead();
  assert.ok(['CANCELLED', 'REVOKED'].includes(resultCode(await pending)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.file.buffer.getRawText(), initial); assert.equal(f.registry.diagnostics().tasks, 0); assert.equal(f.registry.diagnostics().leases, 0); f.registry.dispose();
});
