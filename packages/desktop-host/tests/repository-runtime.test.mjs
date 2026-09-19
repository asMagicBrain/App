import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRepositoryRuntime } from '../src/repository-runtime/index.mjs';
function fixture(t, hooks = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'asmb-repository-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source'), privateRoot = path.join(base, 'private');
  fs.mkdirSync(sourceRoot); fs.mkdirSync(privateRoot, { mode: 0o700 }); fs.mkdirSync(path.join(sourceRoot, 'docs'));
  fs.writeFileSync(path.join(sourceRoot, 'docs', 'A.md'), '\ufeff# A\r\nText\r\n');
  const options = { sourceRoot, privateRoot, localOwnerId: 'owner', localRootId: 'root', checkoutId: 'checkout', hooks };
  return { base, options, runtime: createRepositoryRuntime(options) };
}
test('ordinary nested folder discovery and exact no-op Save need no source manifest', t => {
  const { runtime, options } = fixture(t);
  assert.equal(runtime.discover().entries.some(v => v.path === 'docs/A.md'), true);
  const opened = runtime.open('docs/A.md'); assert.equal(opened.text, '\ufeff# A\r\nText\r\n');
  const before = fs.readFileSync(path.join(options.sourceRoot, 'docs/A.md'));
  assert.equal(runtime.save({ path: opened.path, baseHash: opened.sourceHash, text: opened.text }).status, 'saved');
  assert.deepEqual(fs.readFileSync(path.join(options.sourceRoot, 'docs/A.md')), before);
  assert.equal(fs.existsSync(path.join(options.sourceRoot, '.asmagicbrain')), false);
});
test('draft checkpoint is private and restored with stable document identity after close', t => {
  const { runtime, options } = fixture(t); const opened = runtime.open('docs/A.md');
  runtime.checkpoint({ path: opened.path, baseHash: opened.sourceHash, text: 'draft' }); runtime.close();
  const reopened = createRepositoryRuntime(options).open(opened.path);
  assert.equal(reopened.documentId, opened.documentId); assert.equal(reopened.draft.text, 'draft');
  assert.equal(reopened.text, opened.text);
});
test('source CAS conflict preserves drafts and rejects overwrite', t => {
  const { runtime, options } = fixture(t); const opened = runtime.open('docs/A.md');
  runtime.checkpoint({ path: opened.path, baseHash: opened.sourceHash, text: 'draft' });
  fs.writeFileSync(path.join(options.sourceRoot, opened.path), 'external');
  assert.equal(runtime.open(opened.path).conflict, true);
  assert.throws(() => runtime.save({ path: opened.path, baseHash: opened.sourceHash, text: 'draft' }), { code: 'CONFLICT' });
  assert.equal(runtime.open(opened.path).draft.text, 'draft');
});
test('create and changed Save use source transaction; discard remains durable', t => {
  const { runtime, options } = fixture(t);
  const created = runtime.create({ path: 'docs/B.md', text: 'B\n' });
  assert.equal(runtime.save({ path: created.path, baseHash: created.sourceHash, text: 'Changed\r\n' }).text, 'Changed\r\n');
  const opened = runtime.open(created.path); runtime.checkpoint({ path: opened.path, baseHash: opened.sourceHash, text: 'private' });
  runtime.discard(opened.path); runtime.close(); assert.equal(createRepositoryRuntime(options).open(opened.path).draft, null);
});
test('private store cannot be rebound to another owner or checkout or physical root', t => {
  const { runtime, options, base } = fixture(t); runtime.close();
  for (const changed of [{localOwnerId:'other'}, {checkoutId:'other'}]) assert.throws(() => createRepositoryRuntime({ ...options, ...changed }), { code: 'RECOVERY_REQUIRED' });
  const other = path.join(base, 'other'); fs.mkdirSync(other);
  assert.throws(() => createRepositoryRuntime({ ...options, sourceRoot: other }), { code: 'RECOVERY_REQUIRED' });
});
test('symlinks, traversal and Git metadata cannot be opened or overwritten', t => {
  const { runtime, options, base } = fixture(t);
  fs.writeFileSync(path.join(base, 'outside'), 'outside'); fs.symlinkSync(path.join(base, 'outside'), path.join(options.sourceRoot, 'link.md'));
  fs.symlinkSync(path.join(base), path.join(options.sourceRoot, 'linked'));
  fs.mkdirSync(path.join(options.sourceRoot, '.git')); fs.writeFileSync(path.join(options.sourceRoot, '.git', 'config'), 'private');
  for (const p of ['../outside', '.git/config', 'link.md', 'linked/outside']) assert.throws(() => runtime.open(p));
  assert.equal(runtime.discover().entries.some(v => v.path.startsWith('.git')), false);
  assert.equal(fs.readFileSync(path.join(base, 'outside'), 'utf8'), 'outside');
});
test('invalid UTF8 is read-only; failed save never normalizes bytes', t => {
  const { runtime, options } = fixture(t); const raw = Buffer.from([0xff, 0x00, 0x81]);
  fs.writeFileSync(path.join(options.sourceRoot, 'binary.md'), raw);
  const opened = runtime.open('binary.md'); assert.equal(opened.readOnly, true); assert.equal(opened.text, null);
  assert.throws(() => runtime.save({ path: opened.path, baseHash: opened.sourceHash, text: 'x' }), { code: 'READ_ONLY' });
  assert.deepEqual(fs.readFileSync(path.join(options.sourceRoot, 'binary.md')), raw);
});
test('interruption after intent retains draft and blocks further mutation after reopen', t => {
  const { runtime, options } = fixture(t, { at: point => { if (point === 'after-intent') throw new Error('injected'); } });
  const opened = runtime.open('docs/A.md'); assert.throws(() => runtime.save({ path: opened.path, baseHash: opened.sourceHash, text: 'retained draft' }), /injected/u);
  runtime.close(); const reopened = createRepositoryRuntime({ ...options, hooks: {} });
  assert.equal(reopened.state().recoveryRequired, true); assert.equal(reopened.open(opened.path).draft.text, 'retained draft');
  assert.throws(() => reopened.discard(opened.path), { code: 'RECOVERY_REQUIRED' });
});
test('rename keeps document and draft identity; trash/restore survives reopen and preserves exact bytes', t => {
  const { runtime, options } = fixture(t); const opened = runtime.open('docs/A.md');
  runtime.checkpoint({ path: opened.path, baseHash: opened.sourceHash, text: 'private draft' });
  const renamed = runtime.rename({ path: opened.path, newPath: 'docs/Renamed.md', baseHash: opened.sourceHash });
  assert.equal(renamed.documentId, opened.documentId); assert.equal(renamed.draft.text, 'private draft');
  assert.equal(fs.existsSync(path.join(options.sourceRoot, opened.path)), false);
  const trashed = runtime.trash({ path: renamed.path, baseHash: renamed.sourceHash }); runtime.close();
  const reopened = createRepositoryRuntime(options); assert.equal(reopened.listTrash()[0].trashId, trashed.trashId);
  const restored = reopened.restore({ trashId: trashed.trashId });
  assert.equal(restored.documentId, opened.documentId); assert.equal(restored.text, opened.text); assert.equal(restored.draft.text, 'private draft');
  assert.equal(reopened.listTrash().length, 0);
});
test('restore and rename reject occupied destinations without changing original or private records', t => {
  const { runtime, options } = fixture(t); const a = runtime.open('docs/A.md'); runtime.create({ path: 'docs/B.md', text: 'B' });
  assert.throws(() => runtime.rename({ path: a.path, newPath: 'docs/B.md', baseHash: a.sourceHash }), { code: 'ALREADY_EXISTS' });
  const trash = runtime.trash({ path: a.path, baseHash: a.sourceHash }); fs.writeFileSync(path.join(options.sourceRoot, a.path), 'new occupant');
  assert.throws(() => runtime.restore({ trashId: trash.trashId }), { code: 'ALREADY_EXISTS' }); assert.equal(runtime.listTrash().length, 1);
  assert.equal(fs.readFileSync(path.join(options.sourceRoot, a.path), 'utf8'), 'new occupant');
});
test('interruption after published Save reconciles durable metadata without rewriting source', t => {
  const { runtime, options } = fixture(t, { at: point => { if (point === 'after-source-write') throw new Error('injected'); } });
  const a = runtime.open('docs/A.md'); assert.throws(() => runtime.save({ path: a.path, baseHash: a.sourceHash, text: 'published' }), /injected/u);
  runtime.close(); const reopened = createRepositoryRuntime({ ...options, hooks: {} });
  const before = fs.statSync(path.join(options.sourceRoot, a.path)).mtimeMs;
  assert.equal(reopened.reconcile().status, 'completed'); assert.equal(reopened.open(a.path).draft, null);
  assert.equal(fs.statSync(path.join(options.sourceRoot, a.path)).mtimeMs, before);
});
test('external change immediately before source transaction cannot be absorbed as expected baseline', t => {
  let mutate; const { runtime, options } = fixture(t, { at: point => { if (point === 'before-source-preflight') mutate(); } });
  const a = runtime.open('docs/A.md'); mutate = () => fs.writeFileSync(path.join(options.sourceRoot, a.path), 'external');
  assert.throws(() => runtime.save({ path: a.path, baseHash: a.sourceHash, text: 'my draft' }), { code: 'CONFLICT' });
  assert.equal(runtime.open(a.path).draft.text, 'my draft'); assert.equal(runtime.open(a.path).text, 'external');
});
test('oversized and NUL-containing source remains read-only and untouched', t => {
  const { runtime, options } = fixture(t); fs.writeFileSync(path.join(options.sourceRoot, 'large.md'), Buffer.alloc(1024 * 1024 + 1, 65));
  fs.writeFileSync(path.join(options.sourceRoot, 'nul.md'), 'a\u0000b');
  assert.equal(runtime.open('large.md').encoding, 'oversized'); assert.equal(runtime.open('nul.md').readOnly, true);
  assert.equal(fs.statSync(path.join(options.sourceRoot, 'large.md')).size, 1024 * 1024 + 1);
});
test('new occupant at trashed path cannot inherit the trashed document private draft', t => {
  const { runtime, options } = fixture(t); const a = runtime.open('docs/A.md');
  runtime.checkpoint({ path: a.path, baseHash: a.sourceHash, text: 'private original' });
  runtime.trash({ path: a.path, baseHash: a.sourceHash }); fs.writeFileSync(path.join(options.sourceRoot, a.path), 'different file');
  assert.throws(() => runtime.open(a.path), { code: 'TRASH_PATH_RESERVED' });
  assert.equal(runtime.state().draftCount, 1);
});
test('checkpoints compact beyond a tail cycle and reopen the latest state', t => {
  const { runtime, options } = fixture(t); const a = runtime.open('docs/A.md');
  for (let i = 0; i < 27; i++) runtime.checkpoint({ path: a.path, baseHash: a.sourceHash, text: `draft ${i}` });
  runtime.close(); assert.equal(createRepositoryRuntime(options).open(a.path).draft.text, 'draft 26');
});
test('interrupted create exposes durable recovered text after retained-old reconciliation and reopen', t => {
  const { runtime, options } = fixture(t, { at: point => { if (point === 'after-intent') throw new Error('injected'); } });
  assert.throws(() => runtime.create({ path: 'new.md', text: 'unsaved new text' }), /injected/u); runtime.close();
  const reopened = createRepositoryRuntime({ ...options, hooks: {} }); assert.equal(reopened.reconcile().status, 'retained-old'); reopened.close();
  const again = createRepositoryRuntime({ ...options, hooks: {} }); assert.deepEqual(again.state().recoveredDrafts, [{path:'new.md',text:'unsaved new text'}]);
  again.create({ path: 'new.md', text: 'unsaved new text' }); assert.equal(again.state().recoveredDrafts.length, 0);
});
test('legacy source metadata remains inaccessible through the ordinary writer', t => {
  const { runtime, options } = fixture(t); fs.mkdirSync(path.join(options.sourceRoot, '.asmagicbrain'));
  fs.writeFileSync(path.join(options.sourceRoot, '.asmagicbrain', 'space.json'), '{}');
  assert.throws(() => runtime.open('.asmagicbrain/space.json'), { code: 'RESERVED_PATH' });
  assert.equal(runtime.discover().entries.some(v => v.path.includes('.asmagicbrain')), false);
});
test('trusted legacy references are adopted before open, persisted, and never overwrite existing identities', t => {
  const { runtime, options } = fixture(t); const refs = [{path:'docs/A.md',documentId:'preserved-legacy-id'}];
  assert.equal(runtime.adoptReferences(refs).status, 'adopted'); assert.equal(runtime.adoptReferences(refs).status, 'adopted');
  const a = runtime.open('docs/A.md'); assert.equal(a.documentId, 'preserved-legacy-id');
  runtime.checkpoint({ path:a.path,baseHash:a.sourceHash,text:'private' });
  assert.throws(() => runtime.adoptReferences([{path:a.path,documentId:'replacement'}]), {code:'REFERENCE_COLLISION'});
  fs.writeFileSync(path.join(options.sourceRoot,'docs/B.md'), 'B');
  assert.throws(() => runtime.adoptReferences([{path:'docs/B.md',documentId:a.documentId}]), {code:'REFERENCE_COLLISION'});
  assert.throws(() => runtime.adoptReferences([{path:'docs/B.md',documentId:'new'},{path:'missing.md',documentId:'missing'}]));
  runtime.close(); const reopened=createRepositoryRuntime(options);
  assert.equal(reopened.open(a.path).documentId, a.documentId); assert.equal(reopened.open(a.path).draft.text,'private');
  assert.notEqual(reopened.open('docs/B.md').documentId,'new');
});
test('nested create and rename create missing parents while preserving identity and drafts', t => {
  const {runtime,options}=fixture(t);
  const created=runtime.create({path:'new/deep/note.md',text:'Exact\r\n'});
  assert.deepEqual(created.createdDirectories,['new','new/deep']);
  runtime.checkpoint({path:created.path,baseHash:created.sourceHash,text:'private draft'});
  const renamed=runtime.rename({path:created.path,newPath:'moved/deeper/note.md',baseHash:created.sourceHash});
  assert.deepEqual(renamed.createdDirectories,['moved','moved/deeper']);
  assert.equal(renamed.documentId,created.documentId);assert.equal(renamed.draft.text,'private draft');
  assert.equal(fs.readFileSync(path.join(options.sourceRoot,renamed.path),'utf8'),'Exact\r\n');
  assert.equal(fs.existsSync(path.join(options.sourceRoot,created.path)),false);
});
test('createFolder is idempotent and refuses files, aliases, symlinks and reserved paths', t => {
  const {runtime,options,base}=fixture(t);
  assert.deepEqual(runtime.createFolder({path:'empty/nested'}),{status:'created',path:'empty/nested',createdDirectories:['empty','empty/nested']});
  assert.deepEqual(runtime.createFolder({path:'empty/nested'}),{status:'exists',path:'empty/nested',createdDirectories:[]});
  fs.mkdirSync(path.join(options.sourceRoot,'MixedCase'));
  fs.symlinkSync(base,path.join(options.sourceRoot,'linked'));
  const original=runtime.open('docs/A.md');
  for(const name of ['docs/A.md','docs/A.md/child','mixedcase/child','linked/child','../outside','.git/data','a/.GIT/data','a/.asmb-stage/data','empty/../outside','bad./x']){
    assert.throws(()=>runtime.createFolder({path:name}));
    assert.throws(()=>runtime.create({path:`${name}/note.md`,text:'X'}));
    assert.throws(()=>runtime.rename({path:original.path,newPath:`${name}/note.md`,baseHash:original.sourceHash}));
  }
  assert.equal(fs.existsSync(path.join(base,'child')),false);
  assert.equal(fs.readFileSync(path.join(options.sourceRoot,'docs/A.md'),'utf8'),'\ufeff# A\r\nText\r\n');
});
test('failed nested rename retains original bytes and reports retained empty parents', t => {
  let interrupted=false;
  const {runtime,options}=fixture(t,{at(point){if(interrupted&&point==='after-directory-create')throw Object.assign(new Error('injected'),{code:'INJECTED'});}});
  const opened=runtime.open('docs/A.md');interrupted=true;
  assert.throws(()=>runtime.rename({path:opened.path,newPath:'new/deep/A.md',baseHash:opened.sourceHash}),error=>{
    assert.equal(error.code,'INJECTED');assert.deepEqual(error.createdDirectories,['new']);return true;
  });
  assert.equal(fs.readFileSync(path.join(options.sourceRoot,opened.path),'utf8'),opened.text);
  assert.equal(fs.statSync(path.join(options.sourceRoot,'new')).isDirectory(),true);
  interrupted=false;
  assert.equal(runtime.rename({path:opened.path,newPath:'new/deep/A.md',baseHash:opened.sourceHash}).documentId,opened.documentId);
});
test('stale source and invalid create text fail before creating parents', t => {
  const {runtime,options}=fixture(t),opened=runtime.open('docs/A.md');
  assert.throws(()=>runtime.rename({path:opened.path,newPath:'must/not/exist.md',baseHash:'0'.repeat(64)}),{code:'CONFLICT'});
  assert.throws(()=>runtime.create({path:'must/not/exist.md',text:'\u0000'}),{code:'INVALID_TEXT'});
  assert.equal(fs.existsSync(path.join(options.sourceRoot,'must')),false);
});
test('directory parent replacement is detected before mkdir and source mutation', t => {
  let replaced=false;
  const {runtime,options,base}=fixture(t,{at(point){if(point==='before-directory-create'&&!replaced){replaced=true;fs.renameSync(path.join(options.sourceRoot,'docs'),path.join(options.sourceRoot,'old-docs'));fs.symlinkSync(base,path.join(options.sourceRoot,'docs'));}}});
  assert.throws(()=>runtime.create({path:'docs/new/file.md',text:'new'}),{code:'DENIED'});
  assert.equal(fs.existsSync(path.join(base,'new')),false);
  assert.equal(fs.readFileSync(path.join(options.sourceRoot,'old-docs/A.md'),'utf8'),'\ufeff# A\r\nText\r\n');
});
