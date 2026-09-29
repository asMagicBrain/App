import test from 'node:test';
import assert from 'node:assert/strict';
import {createPluginRegistry} from '../src/plugin-foundation/registry.ts';
import {PluginOperationError, validatePluginManifest} from '../src/plugin-foundation/contracts.ts';
import {ARTIFACT_EXECUTION_AVAILABLE, isArtifactDecisionCurrent, validateArtifactProposal} from '../src/plugin-foundation/future-artifact.ts';

const pluginId = 'asmagicbrain.fixture';
const commandId = `${pluginId}.run`;
const manifest = (overrides = {}) => ({schemaVersion: 1, id: pluginId, name: 'Fixture', version: '1.0.0',
  hostApi: {min: 1, max: 1}, capabilities: ['document.read', 'document.edit'],
  contributions: [{id: commandId, kind: 'command', title: 'Read fixture'},
    {id: `${pluginId}.tool`, kind: 'editor-tool', title: 'Fixture tool', commandId}], ...overrides});
const snapshot = (overrides = {}) => ({repositoryId: 'fixture-repository', revision: 'worktree', sessionId: 'fixture-document',
  path: 'notes/example.md', sourceHash: 'a'.repeat(64), version: 1, readOnly: false, conflict: false, ...overrides});
const grants = {[pluginId]: ['document.read', 'document.edit']};
const edit = {changes: [{from: 0, to: 0, insert: '**'}], selection: {anchor: 0, head: 2}};
const deferred = () => {let resolve; let reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({module, permissionGrants = grants, value = snapshot(), perform, pluginManifest = manifest()} = {}) {
  let current = value; let context; const calls = [];
  const registry = createPluginRegistry({grants: permissionGrants, host: {getSnapshot: () => current, perform: async (...args) => {
    calls.push(args); return perform ? perform(...args) : {text: 'fixture source', rawText: '\ufefffixture source\r\n', selection: {anchor: 0, head: 0}};
  }}});
  const bundled = module ?? {activate(ctx) {context = ctx; ctx.registerCommand(commandId, ({document}) => ctx.document.read(document));}};
  assert.equal(registry.registerBundled(pluginManifest, bundled).ok, true);
  return {registry, calls, get context() {return context;}, set current(next) {current = next;}, get current() {return current;}};
}
const code = result => {assert.equal(result.ok, false); return result.error.code;};

test('v1 manifests detach/freeze data and refuse code entry points, malformed IDs and schema ambiguity', () => {
  const input = manifest(); const result = validatePluginManifest(input);
  assert.equal(result.ok, true); input.name = 'changed'; input.contributions[0].title = 'changed'; input.capabilities.pop();
  assert.equal(result.value.name, 'Fixture'); assert.equal(result.value.contributions[0].title, 'Read fixture'); assert.equal(result.value.capabilities.length, 2);
  assert.equal(Object.isFrozen(result.value.contributions[0]), true);
  for (const invalid of [null, [], {}, manifest({schemaVersion: 2}), manifest({entry: './imported.js'}), manifest({url: 'https://example.invalid/plugin.js'}),
    manifest({version: 'latest'}), manifest({id: '../plugin'}), manifest({name: 'fixture\nforged-log'}), manifest({capabilities: ['fs.write']}),
    manifest({capabilities: ['document.read', 'document.read']}), manifest({hostApi: {min: 2, max: 1}}), manifest({hostApi: {min: 0, max: 1}}),
    manifest({hostApi: {min: 1, max: 1, permissive: true}}), manifest({contributions: [{id: 'other.module.run', kind: 'command', title: 'Bad'}]}),
    manifest({contributions: [{id: commandId, kind: 'navigation', title: 'No target', commandId: `${pluginId}.missing`}]}),
    manifest({contributions: [{id: commandId, kind: 'command', title: 'Code entry', run: 'eval()'}]})]) assert.equal(code(validatePluginManifest(invalid)), 'INVALID_MANIFEST');
});

test('API upgrades and downgrades produce incompatible states without activating the module', async () => {
  for (const [hostApiVersion, hostApi] of [[1, {min: 2, max: 3}], [3, {min: 1, max: 2}]]) {
    let activated = 0; const registry = createPluginRegistry({hostApiVersion, host: {getSnapshot: () => null, perform: async () => assert.fail('incompatible host operation')}});
    assert.equal(registry.registerBundled(manifest({hostApi}), {activate() {activated++;}}).value.state, 'incompatible');
    assert.equal(code(await registry.enable(pluginId)), 'INCOMPATIBLE'); assert.equal(code(await registry.invoke(commandId)), 'INCOMPATIBLE');
    assert.equal(registry.disable(pluginId).value.state, 'incompatible'); assert.deepEqual(registry.contributions(), []); assert.equal(activated, 0);
  }
});

test('missing, disabled and duplicate registrations remain truthful', async () => {
  const f = fixture();
  assert.equal(code(await f.registry.enable('missing.plugin')), 'MISSING_PLUGIN');
  assert.equal(code(await f.registry.invoke('missing.command')), 'MISSING_PLUGIN');
  assert.equal(code(await f.registry.invoke(commandId)), 'DISABLED');
  assert.equal(code(f.registry.registerBundled(manifest(), {activate() {}})), 'DUPLICATE');
  assert.deepEqual(f.registry.contributions(), []);
  assert.equal((await f.registry.enable(pluginId)).ok, true);
  assert.equal(f.registry.contributions().length, 2); assert.equal(f.registry.contributions('editor-tool').length, 1);
});

test('declarations do not grant authority; omitted grants and omitted declarations both deny host access', async () => {
  for (const options of [{permissionGrants: {}}, {pluginManifest: manifest({capabilities: []})}]) {
    const f = fixture(options); await f.registry.enable(pluginId);
    assert.equal(code(await f.context.document.read(f.current)), 'DENIED'); assert.equal(f.calls.length, 0);
    assert.throws(() => f.context.acquire('shell.exec', f.current), error => error.code === 'CAPABILITY_UNSUPPORTED');
  }
});

test('host grants are detached from caller mutation', async () => {
  const admission = {[pluginId]: ['document.read']}; const f = fixture({permissionGrants: admission}); admission[pluginId].push('document.edit');
  await f.registry.enable(pluginId); assert.equal(code(await f.context.document.edit(f.current, edit)), 'DENIED'); assert.equal(f.calls.length, 0);
});

test('every repository/ref/path/session/hash/version/status stale identity is refused before the adapter', async () => {
  const f = fixture(); await f.registry.enable(pluginId); const expected = f.current;
  for (const next of [null, snapshot({repositoryId: 'different-repository'}), snapshot({revision: 'other-ref'}), snapshot({sessionId: 'other-session'}),
    snapshot({path: 'different.md'}), snapshot({sourceHash: 'b'.repeat(64)}), snapshot({version: 2}), snapshot({readOnly: true}), snapshot({conflict: true})]) {
    f.current = next; assert.equal(code(await f.context.document.edit(expected, edit)), 'STALE');
  }
  assert.equal(f.calls.length, 0);
});

test('read-only/conflict documents remain readable but edits cannot reach host operations', async () => {
  for (const [state, expectedCode] of [[{readOnly: true}, 'READ_ONLY'], [{conflict: true}, 'CONFLICT']]) {
    const f = fixture({value: snapshot(state)}); await f.registry.enable(pluginId);
    assert.equal((await f.context.document.read(f.current)).ok, true);
    assert.equal(code(await f.context.document.edit(f.current, edit)), expectedCode); assert.equal(f.calls.length, 1);
  }
});

test('edit payload bounds and overlap checks deny malformed requests without invoking the host', async () => {
  const f = fixture(); await f.registry.enable(pluginId);
  for (const payload of [undefined, {}, {changes: []}, {changes: [{from: -1, to: 0, insert: ''}]}, {changes: [{from: 2, to: 1, insert: ''}]},
    {changes: [{from: 0, to: 3, insert: ''}, {from: 1, to: 2, insert: ''}]}, {changes: [{from: 0, to: 0, insert: 'x'.repeat(1024 * 1024 + 1)}]},
    {changes: [{from: 0, to: 0, insert: '', command: 'exec'}]}, {...edit, selection: {anchor: -1, head: 0}}, {...edit, path: '../outside'}]) {
    assert.equal(code(await f.context.document.edit(f.current, payload)), 'INVALID_REQUEST');
  }
  const lease = f.context.acquire('document.read', f.current);
  assert.equal(code(await lease.request(edit)), 'INVALID_REQUEST'); lease.revoke(); assert.equal(f.calls.length, 0);
});

test('queued checked edits are detached and a changed snapshot is rechecked before host entry', async () => {
  const f = fixture(); await f.registry.enable(pluginId);
  const mutable = {changes: [{from: 0, to: 0, insert: 'checked'}]};
  const request = f.context.document.edit(f.current, mutable); mutable.changes[0].insert = 'changed after admission';
  assert.equal((await request).ok, true); assert.equal(f.calls[0][0].payload.changes[0].insert, 'checked');
  assert.equal(Object.isFrozen(f.calls[0][0].payload.changes[0]), true);
  const pending = f.context.document.edit(f.current, edit); f.current = snapshot({version: 2});
  assert.equal(code(await pending), 'STALE'); assert.equal(f.calls.length, 1);
});

test('async adapter recheck refuses late stale mutation and no automatic retry occurs', async () => {
  const ready = deferred(); let writes = 0;
  const f = fixture({perform: async (request, signal) => {await ready.promise;
    if (signal.aborted) throw new PluginOperationError('CANCELLED');
    if (request.expected.version !== f.current.version) throw new PluginOperationError('STALE');
    writes++; return null;
  }}); await f.registry.enable(pluginId);
  const pending = f.context.document.edit(f.current, edit); await tick(); f.current = snapshot({version: 2}); ready.resolve();
  assert.equal(code(await pending), 'STALE'); assert.equal(writes, 0); assert.equal(f.calls.length, 1);
});

test('20 enable/disable cycles release commands, leases, tasks and disposables exactly once', async () => {
  let activated = 0; let disposed = 0; let context;
  const f = fixture({module: {activate(ctx) {activated++; context = ctx; ctx.registerCommand(commandId, () => null);
    ctx.addDisposable(() => {disposed++;}); return () => {disposed++;};
  }}});
  for (let cycle = 0; cycle < 20; cycle++) {
    await Promise.all([f.registry.enable(pluginId), f.registry.enable(pluginId)]);
    assert.equal(f.registry.contributions().length, 2);
    const lease = context.acquire('document.read', f.current);
    assert.equal(f.registry.diagnostics().leases, 1);
    assert.equal((await f.registry.invoke(commandId)).ok, true);
    f.registry.disable(pluginId); f.registry.disable(pluginId);
    assert.equal(lease.signal.aborted, true); assert.equal(code(await lease.request()), 'REVOKED');
    const counts = f.registry.diagnostics(); for (const name of ['commands', 'leases', 'tasks', 'disposables']) assert.equal(counts[name], 0);
  }
  assert.equal(activated, 20); assert.equal(disposed, 40);
});

test('disable cancels a pending command without waiting for an uncooperative task and rejects late results', async () => {
  const work = deferred(); let signal;
  const f = fixture({module: {activate(ctx) {ctx.registerCommand(commandId, args => {signal = args.signal; return work.promise;});}}});
  await f.registry.enable(pluginId); const pending = f.registry.invoke(commandId); await tick(); f.registry.disable(pluginId);
  assert.equal(code(await pending), 'CANCELLED'); assert.equal(signal.aborted, true); assert.equal(f.registry.diagnostics().tasks, 0);
  work.resolve('private late result'); await tick(); assert.equal(f.registry.snapshot()[0].state, 'disabled');
});

test('document replacement revokes leases/cancels commands, preserving enabled contributions for the next document', async () => {
  const work = deferred(); let context; let signal;
  const f = fixture({module: {activate(ctx) {context = ctx; ctx.registerCommand(commandId, args => {signal = args.signal; return work.promise;});}}});
  await f.registry.enable(pluginId); const lease = context.acquire('document.read', f.current);
  const pending = f.registry.invoke(commandId); await tick(); f.registry.replaceDocument(); f.current = snapshot({sessionId: 'new-document'});
  assert.equal(code(await pending), 'CANCELLED'); assert.equal(signal.aborted, true); assert.equal(code(await lease.request()), 'REVOKED');
  assert.equal(f.registry.snapshot()[0].state, 'enabled'); assert.equal(f.registry.contributions().length, 2);
  assert.equal((await context.document.read(f.current)).ok, true); work.resolve();
});

test('in-flight host request receives revocation and late source is not delivered after replacement', async () => {
  const work = deferred(); let signal;
  const f = fixture({perform: async (_request, cancellation) => {signal = cancellation; return work.promise;}}); await f.registry.enable(pluginId);
  const pending = f.context.document.read(f.current); await tick(); f.registry.replaceDocument();
  assert.equal(code(await pending), 'REVOKED'); assert.equal(signal.aborted, true); work.resolve({text: 'late secret'}); await tick();
  assert.equal(f.registry.diagnostics().leases, 0);
});

test('late activation cleanup runs after disable and cannot publish contributions', async () => {
  const work = deferred(); let disposed = 0;
  const f = fixture({module: {async activate(ctx) {ctx.registerCommand(commandId, () => null); await work.promise; return () => {disposed++;};}}});
  const enabling = f.registry.enable(pluginId); await tick(); f.registry.disable(pluginId);
  assert.equal(code(await enabling), 'REVOKED'); assert.equal(f.registry.contributions().length, 0);
  work.resolve(); await tick(); assert.equal(disposed, 1); assert.equal(f.registry.snapshot()[0].state, 'disabled');
});

test('activation/command failures release resources and preserve bounded source-free error state', async () => {
  for (const duringActivation of [true, false]) {
    let cleaned = 0; const f = fixture({module: {activate(ctx) {
      ctx.addDisposable(() => {throw new Error('sensitive cleanup detail');}); ctx.addDisposable(() => {cleaned++;});
      if (duringActivation) throw new Error('private source and credentials');
      ctx.registerCommand(commandId, () => {throw new Error('private source and credentials');});
    }}});
    const result = duringActivation ? await f.registry.enable(pluginId) : (await f.registry.enable(pluginId), await f.registry.invoke(commandId));
    assert.equal(code(result), 'RUNTIME_FAILURE'); assert.equal(f.registry.snapshot()[0].state, 'failed'); assert.equal(cleaned, 1);
    assert.equal(f.registry.contributions().length, 0); assert.equal(JSON.stringify(f.registry.snapshot()).includes('private source'), false);
    assert.equal(JSON.stringify(result).includes('credentials'), false); assert.equal(f.registry.diagnostics().disposables, 0);
  }
});

test('missing or undeclared command handlers fail local activation', async () => {
  for (const module of [{activate() {}}, {activate(ctx) {ctx.registerCommand('other.module.command', () => null);}},
    {activate(ctx) {ctx.registerCommand(commandId, () => null); ctx.registerCommand(commandId, () => null);}}]) {
    const f = fixture({module}); assert.equal((await f.registry.enable(pluginId)).ok, false); assert.equal(f.registry.snapshot()[0].state, 'failed');
    assert.equal(f.registry.contributions().length, 0);
  }
});

test('unhandled provider details are sanitized; known bounded adapter codes remain distinct', async () => {
  for (const error of [new Error('secret provider payload'), new PluginOperationError('DENIED'), new PluginOperationError('CONFLICT')]) {
    const f = fixture({perform: async () => {throw error;}}); await f.registry.enable(pluginId);
    const result = await f.context.document.read(f.current);
    assert.equal(code(result), error instanceof PluginOperationError ? error.code : 'RUNTIME_FAILURE');
    assert.equal(JSON.stringify(result).includes('secret'), false); assert.match(result.error.operationId, /^plugin-\d+$/);
  }
});

test('lease and task admission is bounded and context tasks cancel on replacement', async () => {
  const f = fixture(); await f.registry.enable(pluginId);
  const leases = Array.from({length: 32}, () => f.context.acquire('document.read', f.current));
  assert.throws(() => f.context.acquire('document.read', f.current), error => error.code === 'LIMIT'); leases.forEach(lease => lease.revoke());
  const tasks = Array.from({length: 32}, () => f.context.run(async () => new Promise(() => {})).catch(error => error.code));
  await assert.rejects(f.context.run(async () => null), error => error.code === 'LIMIT'); f.registry.replaceDocument();
  assert.deepEqual(await Promise.all(tasks), Array(32).fill('CANCELLED')); assert.equal(f.registry.diagnostics().tasks, 0);
});

test('normal close is idempotent, aborts work and releases subscriptions without affecting source', async () => {
  const f = fixture(); let notifications = 0;
  f.registry.subscribe(() => {throw new Error('subscriber failure');}); f.registry.subscribe(() => {notifications++;});
  await f.registry.enable(pluginId); const sourceBefore = {...f.current}; const context = f.context;
  f.registry.dispose(); f.registry.dispose();
  assert.equal(context.signal.aborted, true); assert.deepEqual(f.current, sourceBefore); assert.equal(f.calls.length, 0);
  assert.equal(f.registry.diagnostics().listeners, 0); assert.equal(f.registry.diagnostics().closed, true); assert.equal(notifications >= 2, true);
  assert.equal(code(await f.registry.enable(pluginId)), 'CLOSED'); assert.equal(code(await f.registry.invoke(commandId)), 'CLOSED');
  assert.equal(code(f.registry.disable(pluginId)), 'CLOSED'); assert.equal(code(await context.document.read(f.current)), 'CLOSED');
});

test('a read completed against an older version is not delivered after an edit', async () => {
  const work = deferred(); const f = fixture({perform: async () => work.promise}); await f.registry.enable(pluginId);
  const pending = f.context.document.read(f.current); await tick(); f.current = snapshot({version: 2}); work.resolve({text: 'outdated source'});
  assert.equal(code(await pending), 'STALE');
});

test('reentrant subscribers cannot duplicate activation and disable during enabling returns a bounded result', async () => {
  let activations = 0; let nested;
  const f = fixture({module: {activate(ctx) {activations++; ctx.registerCommand(commandId, () => null);}}});
  f.registry.subscribe(() => {if (f.registry.snapshot()[0].state === 'enabling') nested = f.registry.enable(pluginId);});
  assert.equal((await f.registry.enable(pluginId)).ok, true); assert.equal((await nested).ok, true); assert.equal(activations, 1);
  const second = fixture(); second.registry.subscribe(() => {if (second.registry.snapshot()[0].state === 'enabling') second.registry.disable(pluginId);});
  assert.equal(code(await second.registry.enable(pluginId)), 'REVOKED'); assert.equal(second.registry.diagnostics().commands, 0);
});

test('reactivation during revocation is refused until teardown completes', async () => {
  let nested;
  const f = fixture({module: {activate(ctx) {ctx.registerCommand(commandId, () => null);
    ctx.signal.addEventListener('abort', () => {nested = f.registry.enable(pluginId);}, {once: true});
  }}}); await f.registry.enable(pluginId); f.registry.disable(pluginId);
  assert.equal(code(await nested), 'REVOKED'); assert.equal(f.registry.snapshot()[0].state, 'disabled'); assert.equal(f.registry.diagnostics().commands, 0);
  assert.equal((await f.registry.enable(pluginId)).ok, true);
});

const artifact = () => ({schemaVersion: 1, id: 'fixture-artifact', title: 'Inert fixture', entryPath: 'view.html', fallbackPath: 'source.md', network: 'none', assets: [
  {path: 'view.html', role: 'entry', sha256: 'a'.repeat(64), bytes: 100},
  {path: 'source.md', role: 'fallback', sha256: 'b'.repeat(64), bytes: 100},
  {path: 'code.js', role: 'script', sha256: 'c'.repeat(64), bytes: 100},
]});
test('future artifact schema remains inert, bounded and without executable/transport admission', () => {
  assert.equal(ARTIFACT_EXECUTION_AVAILABLE, false); const input = artifact(); const parsed = validateArtifactProposal(input);
  assert.equal(parsed.ok, true); input.assets[0].sha256 = 'd'.repeat(64); assert.equal(parsed.value.assets[0].sha256, 'a'.repeat(64));
  for (const invalid of [null, {...artifact(), schemaVersion: 2}, {...artifact(), network: '*'}, {...artifact(), preload: 'app-bridge'},
    {...artifact(), entryPath: '../view.html'}, {...artifact(), entryPath: 'http://127.0.0.1/view.html'}, {...artifact(), fallbackPath: 'fallback.html'},
    {...artifact(), assets: [...artifact().assets, {...artifact().assets[0], path: 'VIEW.html'}]},
    {...artifact(), assets: artifact().assets.map((asset, index) => index ? asset : {...asset, bytes: 2 * 1024 * 1024 + 1})},
    {...artifact(), assets: artifact().assets.map((asset, index) => index ? asset : {...asset, path: 'folder/.git/config'})}]) assert.equal(validateArtifactProposal(invalid).ok, false);
});
test('future content review binds exact manifest, dependency bytes/path/size and runtime-policy version', () => {
  const identity = {manifestSha256: 'd'.repeat(64), runtimePolicyVersion: 'future-policy-1', assets: artifact().assets.map(({path, sha256, bytes}) => ({path, sha256, bytes}))};
  const decision = {decision: 'approved', identity}; assert.equal(isArtifactDecisionCurrent(decision, structuredClone(identity)), true);
  for (const changed of [{...identity, manifestSha256: 'e'.repeat(64)}, {...identity, runtimePolicyVersion: 'future-policy-2'},
    {...identity, assets: identity.assets.slice(0, 2)}, {...identity, assets: identity.assets.map((asset, index) => index === 2 ? {...asset, sha256: 'f'.repeat(64)} : asset)},
    {...identity, assets: identity.assets.map((asset, index) => index === 2 ? {...asset, path: 'other.js'} : asset)},
    {...identity, assets: identity.assets.map((asset, index) => index === 2 ? {...asset, bytes: 101} : asset)},
    {...identity, assets: [...identity.assets, identity.assets[0]]}]) assert.equal(isArtifactDecisionCurrent(decision, changed), false);
  assert.equal(isArtifactDecisionCurrent({decision: 'declined', identity}, identity), true);
  assert.equal(ARTIFACT_EXECUTION_AVAILABLE, false);
});
