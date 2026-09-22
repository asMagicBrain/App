import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorState, Facet} from '@codemirror/state';
import {redo, undo, undoDepth} from '@codemirror/commands';
import {createFileSession} from '../src/repository-file-session.ts';
import {createRepositoryDocumentSession, getRepositoryDocumentSession} from '../src/repository-document-session.ts';

const identity = {repositoryId: 'test-workspace', revision: ''};
const makeFile = (text = '\ufeff# Heading\r\nFirst\nLast\r') => createFileSession({
  path: 'note.md', documentId: 'host-document', sourceHash: 'a'.repeat(64), text, readOnly: false,
});
const failure = code => error => error.code === code;
const fakeView = state => ({state, composing: false, compositionStarted: false,
  update(transactions) {for (const transaction of transactions) {assert.equal(transaction.startState, this.state); this.state = transaction.state;}},
  setState(next) {this.state = next;},
});
const command = (session, operation) => operation({state: session.state, dispatch: transaction => session.dispatch([transaction])});

test('one retained CM6 state preserves raw draft, selection and undo across ordinary/plugin switches and remounts', async () => {
  const file = makeFile(), original = file.saved;
  const session = getRepositoryDocumentSession(file, identity), first = fakeView(session.state);
  let notifications = 0;
  session.attach(first, {onChange() {notifications++;}});
  await session.transact(session.getSnapshot(), {changes: [{from: 2, to: 2, insert: 'Draft '}], selection: {anchor: 8}});
  assert.equal(file.buffer.getRawText(), '\ufeff# Draft Heading\r\nFirst\nLast\r');
  const selected = session.state.selection, historyDepth = undoDepth(session.state);
  const tool = Facet.define();
  session.setContribution(tool.of('first-party-tool'));
  assert.deepEqual(session.state.facet(tool), ['first-party-tool']);
  session.setContribution([]);
  assert.deepEqual(session.state.facet(tool), []);
  assert.equal(session.state.selection, selected);
  assert.equal(undoDepth(session.state), historyDepth);
  const beforeUnmount = session.state;
  session.detach(first);
  const remounted = getRepositoryDocumentSession(file, identity), second = fakeView(EditorState.create());
  remounted.attach(second);
  assert.equal(remounted, session); assert.equal(second.state, beforeUnmount);
  assert.equal(session.state.selection.main.anchor, 8);
  assert.equal(command(remounted, undo), true);
  assert.equal(file.buffer.getRawText(), original);
  assert.equal(command(remounted, redo), true);
  assert.equal(file.buffer.getRawText(), '\ufeff# Draft Heading\r\nFirst\nLast\r');
  assert.equal(notifications, 1, 'detached observers must not retain old React consumers');
});

test('Save rebase and new-file identity/rename changes preserve history and invalidate stale requests', async () => {
  const file = makeFile(), session = getRepositoryDocumentSession(file, identity), original = file.saved;
  await session.transact(session.getSnapshot(), {changes: [{from: 2, to: 2, insert: 'Saved '}], selection: {anchor: 8}});
  const beforeSave = session.getSnapshot(), retainedState = session.state;
  file.saved = file.buffer.getRawText(); file.buffer.rebase(file.saved); file.sourceHash = 'b'.repeat(64);
  file.id = 'new-host-identity'; file.path = 'folder/renamed.md'; file.proposedPath = file.path;
  assert.equal(getRepositoryDocumentSession(file, identity).state, retainedState);
  const current = session.getSnapshot();
  assert.equal(current.sessionId, 'new-host-identity'); assert.equal(current.path, 'folder/renamed.md');
  assert.equal(current.sourceHash, file.sourceHash);
  await assert.rejects(session.transact(beforeSave, {changes: [{from: 0, to: 0, insert: 'lost'}]}), failure('stale'));
  assert.equal(command(session, undo), true); assert.equal(file.buffer.getRawText(), original);
  assert.equal(command(session, redo), true); assert.equal(file.buffer.getRawText(), file.saved);
});

test('scope, source hash and monotonic document version are all required, including undo to equal source', async () => {
  const file = makeFile(), session = getRepositoryDocumentSession(file, identity), original = session.getSnapshot();
  for (const [key, value] of Object.entries({repositoryId: 'other', revision: 'tag', sessionId: 'other', path: 'other.md', sourceHash: null, version: 5})) {
    await assert.rejects(session.read({...original, [key]: value}), failure('stale'));
  }
  await session.transact(original, {changes: [{from: 0, to: 0, insert: 'x'}]});
  assert.equal(command(session, undo), true); assert.equal(file.buffer.getRawText(), file.saved);
  assert.equal(session.getSnapshot().version, 2);
  await assert.rejects(session.transact(original, {changes: [{from: 0, to: 0, insert: 'stale'}]}), failure('stale'));
  assert.throws(() => getRepositoryDocumentSession(file, {...identity, revision: 'main'}), failure('stale'));
});

test('cancellation and authority changes after request admission cannot mutate the source', async () => {
  const file = makeFile(), session = createRepositoryDocumentSession(file, identity), expected = session.getSnapshot();
  const controller = new AbortController();
  const cancelled = session.transact(expected, {changes: [{from: 0, to: 0, insert: 'cancelled'}]}, controller.signal);
  controller.abort(); await assert.rejects(cancelled, failure('cancelled'));
  await assert.rejects(session.read(expected, controller.signal), failure('cancelled'));
  for (const invalidate of [() => session.cancelOperations(), () => session.setContribution([])]) {
    const operation = session.transact(session.getSnapshot(), {changes: [{from: 0, to: 0, insert: 'late'}]});
    invalidate(); await assert.rejects(operation, failure('cancelled'));
  }
  const pending = session.transact(expected, {changes: [{from: 0, to: 0, insert: 'late'}]});
  session.dispatch([session.state.update({changes: {from: 0, insert: 'typed '}})]);
  await assert.rejects(pending, failure('stale'));
  assert.equal(file.buffer.getRawText(), '\ufefftyped # Heading\r\nFirst\nLast\r');
});

test('read-only, ref, conflict and composition deny plugin edits while source stays readable', async () => {
  for (const boundary of ['readOnly', 'media', 'conflict', 'ref']) {
    const file = makeFile();
    if (boundary !== 'ref') file[boundary] = true;
    const session = createRepositoryDocumentSession(file, {...identity, revision: boundary === 'ref' ? 'v1' : ''});
    await assert.rejects(session.transact(session.getSnapshot(), {changes: [{from: 0, to: 0, insert: 'forbidden'}]}), failure(boundary === 'conflict' ? 'conflict' : 'read-only'));
    const read = await session.read(session.getSnapshot()); assert.equal(read.rawText, file.saved);
  }
  const file = makeFile(), session = createRepositoryDocumentSession(file, identity), view = fakeView(session.state);
  session.attach(view); view.compositionStarted = true;
  await assert.rejects(session.transact(session.getSnapshot(), {changes: [{from: 0, to: 0, insert: 'forbidden'}]}), failure('composing'));
  for (const action of [() => session.detach(view), () => session.setContribution([]), () => session.dispose()]) assert.throws(action, failure('composing'));
  // Ordinary IME transactions remain owned by the same view while plugin edits
  // and view teardown are held. No state recreation discards composing text.
  assert.equal(session.dispatch([session.state.update({changes: {from: 0, insert: '文'}})], view), true);
  view.compositionStarted = false; session.detach(view);
  assert.equal(file.buffer.getRawText(), '\ufeff文# Heading\r\nFirst\nLast\r');
});

test('single-view ownership, detach and disposal cancel pending work and remove callbacks', async () => {
  const file = makeFile(), session = createRepositoryDocumentSession(file, identity), first = fakeView(session.state), second = fakeView(session.state);
  session.attach(first);
  assert.throws(() => session.attach(second), failure('denied'));
  assert.throws(() => session.dispatch([session.state.update({selection: {anchor: 1}})], second), failure('stale'));
  const read = session.read(session.getSnapshot()); session.detach(first);
  await assert.rejects(read, failure('cancelled'));
  const edit = session.transact(session.getSnapshot(), {changes: [{from: 0, to: 0, insert: 'late'}]}); session.dispose();
  await assert.rejects(edit, failure('cancelled'));
  assert.throws(() => session.getSnapshot(), failure('unavailable'));
  assert.equal(file.buffer.getRawText(), file.saved);
});

test('invalid Unicode, overlapping ranges, bounds and oversized operations fail without changing original bytes', async () => {
  const file = makeFile('😀\r\ntext'), session = createRepositoryDocumentSession(file, identity);
  for (const changes of [
    [{from: 1, to: 1, insert: 'inside-surrogate'}], [{from: 0, to: 0, insert: '\ud800'}],
    [{from: 3, to: 4, insert: 'x'}, {from: 2, to: 4, insert: 'y'}],
    [{from: 0, to: 0, insert: 'x'}, {from: 0, to: 0, insert: 'y'}],
    [{from: 0, to: 500, insert: 'x'}], [{from: -1, to: 1, insert: 'x'}],
    [{from: 0, to: 0, insert: 'x'.repeat(1024 * 1024 + 1)}],
    Array.from({length: 1025}, () => ({from: 0, to: 0, insert: ''})),
  ]) {
    await assert.rejects(session.transact(session.getSnapshot(), {changes}), failure('invalid'));
    assert.equal(file.buffer.getRawText(), file.saved); assert.equal(session.state.doc.toString(), file.buffer.getText());
    assert.equal(session.getSnapshot().version, 0);
  }
});

test('stale CM6 transaction suffix is refused before its raw source changes while accepted prefix remains', () => {
  const file = makeFile('one'), session = createRepositoryDocumentSession(file, identity), view = fakeView(session.state), errors = [];
  session.attach(view, {onError(message) {errors.push(message);}});
  const accepted = session.state.update({changes: {from: 0, insert: 'a'}});
  const stale = session.state.update({changes: {from: 0, insert: 'b'}});
  assert.equal(session.dispatch([accepted, stale], view), false);
  assert.equal(file.buffer.getRawText(), 'aone'); assert.equal(view.state, accepted.state);
  assert.equal(session.state, accepted.state); assert.equal(session.getSnapshot().version, 1); assert.equal(errors.length, 1);
  assert.equal(command(session, undo), true); assert.equal(file.buffer.getRawText(), 'one');
});

test('independent operation reads contain a frozen snapshot and do not imply Save or Git commit', async () => {
  const file = makeFile(), session = createRepositoryDocumentSession(file, identity), saved = file.saved, hash = file.sourceHash;
  await session.transact(session.getSnapshot(), {changes: [{from: 0, to: 0, insert: 'draft '}]});
  const snapshot = await session.read(session.getSnapshot());
  assert.equal(snapshot.text, file.buffer.getText()); assert.equal(snapshot.rawText, file.buffer.getRawText());
  assert.equal(file.saved, saved); assert.equal(file.sourceHash, hash);
  assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.selection));
});

test('a moved selection invalidates an operation based on the previous selection', async () => {
  const file = makeFile(), session = createRepositoryDocumentSession(file, identity), expected = session.getSnapshot();
  const pending = session.transact(expected, {changes: [{from: 0, to: 0, insert: 'late'}]});
  session.dispatch([session.state.update({selection: {anchor: 2, head: 9}})]);
  await assert.rejects(pending, failure('stale'));
  assert.equal(session.getSnapshot().version, 1); assert.equal(file.buffer.getRawText(), file.saved);
});

test('the host read-only CM6 compartment is enforced for direct and contributed transactions', async () => {
  const file = makeFile(), session = createRepositoryDocumentSession(file, identity, EditorState.readOnly.of(true));
  await assert.rejects(session.transact(session.getSnapshot(), {changes: [{from: 0, to: 0, insert: 'forbidden'}]}), failure('read-only'));
  assert.equal(session.dispatch([session.state.update({changes: {from: 0, insert: 'forbidden'}})]), false);
  assert.equal(file.buffer.getRawText(), file.saved);
});

test('host admission is rechecked after the cancellation yield before source access', async () => {
  const file = makeFile(), session = createRepositoryDocumentSession(file, identity), expected = session.getSnapshot();
  const denied = () => {throw Object.assign(new Error('Host view changed'), {code: 'DENIED'});};
  await assert.rejects(session.read(expected, undefined, denied), failure('DENIED'));
  await assert.rejects(session.transact(expected, {changes: [{from: 0, to: 0, insert: 'forbidden'}]}, undefined, denied), failure('DENIED'));
  assert.equal(file.buffer.getRawText(), file.saved); assert.equal(session.getSnapshot().version, 0);
});
