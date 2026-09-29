import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAutomationBroker, validateAutomationState} from './automation-broker.mjs';
import {AUTOMATION_LIMITS} from './automation-limits.mjs';
function memoryStore() {
  let events = [];
  const value = () => ({events: structuredClone(events), blocked: false, tailRecords: events.length, coveredFiles: []});
  return {scan: value, ensureDurable: scan => scan, append(_scan, kind, payload) {events.push({kind, payload: structuredClone(payload)}); return value();}, compact(_scan, payload) {events = [{kind: 'draft', payload: structuredClone(payload)}]; return value();}};
}
const catalog = [{name: 'Granted', stableId: 'repo-one'}, {name: 'Other', stableId: 'repo-two'}];
const input = (requestId, operation, args = {}) => ({requestId, operation, args});
const textHash = value => createHash('sha256').update(value).digest('hex');
function setup(overrides = {}) {
  const store = overrides.store ?? memoryStore(); let applyCount = 0, prepareCount = 0, version = 1;
  const broker = createAutomationBroker({store, catalog: async () => structuredClone(catalog), read: async args => ({path: args.path, text: 'Saved'}), search: async () => ({matches: []}),
    prepare: async (_kind, args) => {prepareCount++; return {kind: 'write', repo: `Granted-v${version}`, repoId: args.repoId, path: args.path, before: null, after: args.text, expectedHash: null, afterHash: textHash(args.text)};}, apply: async (_kind, args) => {applyCount++; return {path: args.path, saved: true};}, inspectInterrupted: async () => null, ...overrides});
  return {store, broker, get applyCount() {return applyCount;}, get prepareCount() {return prepareCount;}, changed() {version++;}};
}
const grant = (broker, scopes = ['read', 'write']) => broker.setGrants({enabled: true, grants: [{repoId: 'repo-one', scopes}]});
const write = requestId => input(requestId, 'write.plan', {repoId: 'repo-one', path: 'note.md', expectedHash: null, text: 'New note'});
test('capabilities/catalog/read remain scoped and disabled/revoked/unknown operations fail', async () => {
  const f = setup(); await assert.rejects(f.broker.request(input('off', 'capabilities')), {code: 'PERMISSION_DENIED'});
  await grant(f.broker, ['read']);
  assert.deepEqual((await f.broker.request(input('catalog', 'catalog'))).map(entry => entry.name), ['Granted']);
  assert.equal((await f.broker.request(input('read', 'read', {repoId: 'repo-one', path: 'note.md'}))).text, 'Saved');
  await assert.rejects(f.broker.request(input('other', 'read', {repoId: 'repo-two', path: 'note.md'})), {code: 'PERMISSION_DENIED'});
  await assert.rejects(f.broker.request(write('unauthorized-write')), {code: 'PERMISSION_DENIED'});
  await assert.rejects(f.broker.request(input('unknown', 'shell.run', {repoId: 'repo-one'})), {code: 'UNKNOWN_OPERATION'});
  assert.ok((await f.broker.request(input('capabilities', 'capabilities'))).forbidden.includes('artifact.run'));
  await f.broker.setGrants({enabled: false, grants: []}); await assert.rejects(f.broker.request(input('revoked', 'read', {repoId: 'repo-one', path: 'note.md'})), {code: 'PERMISSION_DENIED'}); await f.broker.close();
});
test('exact approved request is reviewed once and concurrent idempotent retries do not duplicate apply', async () => {
  const f = setup(); await grant(f.broker);
  const plans = await Promise.all(Array.from({length: 8}, () => f.broker.request(write('same-token'))));
  assert.equal(new Set(plans.map(plan => plan.operationId)).size, 1); assert.equal(f.prepareCount, 1); assert.equal(f.applyCount, 0);
  const plan = plans[0]; await assert.rejects(f.broker.request({...write('same-token'), args: {...write('same-token').args, text: 'Different'}}), {code: 'REQUEST_CONFLICT'});
  await assert.rejects(f.broker.approve({operationId: plan.operationId, digest: 'wrong'}), {code: 'STALE_PLAN'});
  const applied = await f.broker.approve({operationId: plan.operationId, digest: plan.digest}); assert.equal(applied.status, 'completed');
  await f.broker.approve({operationId: plan.operationId, digest: plan.digest}); await f.broker.request(write('same-token')); assert.equal(f.applyCount, 1); await f.broker.close();
});
test('changed saved/draft plan cannot reuse approval and cancellation never publishes', async () => {
  const f = setup(); await grant(f.broker); const plan = await f.broker.request(write('stale')); f.changed();
  await assert.rejects(f.broker.approve({operationId: plan.operationId, digest: plan.digest}), {code: 'STALE_PLAN'}); assert.equal(f.applyCount, 0);
  assert.equal((await f.broker.cancel({operationId: plan.operationId})).status, 'cancelled');
  await assert.rejects(f.broker.approve({operationId: plan.operationId, digest: plan.digest}), {code: 'OPERATION_NOT_REVIEWABLE'}); assert.equal(f.applyCount, 0); await f.broker.close();
});
test('durable completed request survives restart but grants require explicit renewal', async () => {
  const f = setup(); await grant(f.broker); const plan = await f.broker.request(write('persisted')); await f.broker.approve({operationId: plan.operationId, digest: plan.digest}); await f.broker.close();
  const again = setup({store: f.store}); await assert.rejects(again.broker.request(input('status-off', 'status', {operationId: plan.operationId})), {code: 'PERMISSION_DENIED'});
  await grant(again.broker); assert.equal((await again.broker.request(input('status', 'status', {operationId: plan.operationId}))).status, 'completed'); assert.equal((await again.broker.request(write('persisted'))).status, 'completed'); assert.equal(again.applyCount, 0); await again.broker.close();
});
test('permission grants reject unknown repositories and authority expansion', async () => {
  const f = setup(); for (const grants of [[{repoId: 'unknown', scopes: ['read']}], [{repoId: 'repo-one', scopes: ['artifact.run']}], [{repoId: 'repo-one', scopes: ['read', 'read']}], [{repoId: 'repo-one', scopes: ['read'], root: '/tmp'}]]) await assert.rejects(f.broker.setGrants({enabled: true, grants}), {code: 'INVALID_GRANT'});
  await f.broker.close();
});
test('close immediately rejects new admission while draining prior work', async () => {
  let enter, release; const entered = new Promise(resolve => {enter = resolve;}), wait = new Promise(resolve => {release = resolve;});
  const f = setup({catalog: async () => {enter(); await wait; return catalog;}});
  const setting = grant(f.broker); await entered; const close = f.broker.close();
  const late = f.broker.setGrants({enabled: true, grants: []}); release();
  await setting; await assert.rejects(late, {code: 'SERVICE_CLOSED'}); await close;
});

test('lost completion journal preserves applying receipt for restart inspection rather than declaring a saved write failed', async () => {
  const underlying = memoryStore(); let appendCount = 0, effectCount = 0;
  const store = {...underlying, append(...args) {if (++appendCount === 3) throw Object.assign(Error('synthetic disk interruption'), {code: 'EIO'}); return underlying.append(...args);}};
  const f = setup({store, apply: async () => {effectCount++; return {path: 'note.md', saved: true};}}); await grant(f.broker);
  const plan = await f.broker.request(write('lost-completion'));
  await assert.rejects(f.broker.approve({operationId: plan.operationId, digest: plan.digest}), {code: 'EIO'}); assert.equal(effectCount, 1);
  await assert.rejects(f.broker.request(write('later')), {code: 'AUTOMATION_RECOVERY_REQUIRED'}); await f.broker.close();
  assert.equal(underlying.scan().events.at(-1).payload.operations[0].status, 'applying', 'uncertain durable completion must retain its applying record');
  const again = setup({store: underlying, inspectInterrupted: async operation => ({completed: operation.requestId === 'lost-completion', result: {path: 'note.md', recovered: true}})});
  await grant(again.broker); const receipt = await again.broker.request(input('recover', 'status', {operationId: plan.operationId}));
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.result.recovered, true); assert.equal(again.applyCount, 0); await again.broker.close();
});

test('status inspects an interrupted request once and never invokes apply or creates a new review', async () => {
  const store = memoryStore(); const initial = setup({store}); await grant(initial.broker); const plan = await initial.broker.request(write('interrupted'));
  await initial.broker.close(); const state = store.scan().events.at(-1).payload; state.operations[0].status = 'applying'; store.append(store.scan(), 'draft', state);
  let inspected = 0; const again = setup({store, inspectInterrupted: async () => {inspected++; return null;}}); await grant(again.broker);
  assert.equal((await again.broker.request(input('status', 'status', {operationId: plan.operationId}))).status, 'failed');
  assert.equal((await again.broker.request(write('interrupted'))).error.code, 'REVIEW_REQUIRED');
  assert.equal(inspected, 1); assert.equal(again.applyCount, 0); assert.equal(again.prepareCount, 0); await again.broker.close();
});

test('private operation decoder refuses unknown shapes, collision IDs, unsupported status and invalid digest relationships', async () => {
  const f = setup(); await grant(f.broker); await f.broker.request(write('decoder')); await f.broker.close();
  const clean = f.store.scan().events.at(-1).payload; assert.equal(validateAutomationState(clean), true);
  const malformed = [
    state => {state.unknown = true;}, state => {state.schemaVersion = 2;}, state => {state.operations[0].root = '/tmp';},
    state => {state.operations[0].kind = 'shell.run';}, state => {state.operations[0].args.root = '/tmp';},
    state => {state.operations[0].status = 'new-state';}, state => {state.operations[0].createdAt = -1;},
    state => {state.operations[0].plan.path = 'tampered.md';}, state => {state.operations[0].args.text = 'tampered';},
    state => {state.operations[0].reviewDigest = 'f'.repeat(64);}, state => {state.operations[0].digest = 'f'.repeat(64);},
    state => {state.operations[0].repoId = 'different-repository';}, state => {state.operations[0].status = 'completed';},
    state => {state.operations.push({...structuredClone(state.operations[0]), requestId: 'unique'});},
    state => {state.operations.push({...structuredClone(state.operations[0]), operationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'});},
    state => {state.operations[0].error = {code: 'EIO', message: 'error', privatePath: '/private'};},
  ];
  for (const mutate of malformed) {const state = structuredClone(clean); mutate(state); assert.throws(() => validateAutomationState(state), {code: 'INVALID_AUTOMATION_STATE'});}
});

test('private decoder rejects reserved/traversal arguments even with recomputed digest and enforces bounds', async () => {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
  const f = setup(); await grant(f.broker); await f.broker.request(write('decoder-path')); await f.broker.close(); const clean = f.store.scan().events.at(-1).payload;
  for (const relative of ['../outside.md', '/private/file.md', '.git/config', '.GIT/config', '.asmb-private/x', '.ASMB-private/x', '.asmagicbrain/x', 'folder/../x', 'folder\\x', 'CON.md']) {
    const state = structuredClone(clean), op = state.operations[0]; op.args.path = relative; op.digest = digest({kind: op.kind, args: op.args});
    assert.throws(() => validateAutomationState(state), {code: 'INVALID_AUTOMATION_STATE'}, `Refuse ${relative}`);
  }
  for (const change of [op => {op.args.text = 'valid changed text';}, op => {op.plan.after = 'valid changed plan';}, op => {op.plan.path = 'different.md';}]) {
    const state = structuredClone(clean), op = state.operations[0]; change(op); op.digest = digest({kind: op.kind, args: op.args}); op.reviewDigest = digest(op.plan);
    assert.throws(() => validateAutomationState(state), {code: 'INVALID_AUTOMATION_STATE'}, 'Matching independent hashes cannot hide mismatched reviewed intent');
  }
  for (const [mutate, recompute] of [
    [op => {op.args.text = 'x'.repeat(65537);}, true], [op => {op.result = 'x'.repeat(524289);}, false],
    [op => {op.plan = {entries: Array.from({length: 4097}, () => 'x')};}, false],
    [op => {let value = {}; for (let index = 0; index < 26; index++) value = {next: value}; op.plan = value;}, false],
  ]) {
    const state = structuredClone(clean), op = state.operations[0]; mutate(op); if (recompute) op.digest = digest({kind: op.kind, args: op.args}); else op.reviewDigest = digest(op.plan);
    assert.throws(() => validateAutomationState(state), {code: 'INVALID_AUTOMATION_STATE'});
  }
  const tooMany = {schemaVersion: 1, operations: Array.from({length: 17}, () => structuredClone(clean.operations[0]))}; assert.throws(() => validateAutomationState(tooMany), {code: 'INVALID_AUTOMATION_STATE'});
});

test('operation history is bounded without silently expiring idempotency identities', async () => {
  const f = setup(); await grant(f.broker); const plans = [];
  for (let index = 0; index < 16; index++) plans.push(await f.broker.request(write(`bounded-${index}`)));
  await assert.rejects(f.broker.request(write('overflow')), {code: 'LIMIT_EXCEEDED'});
  await f.broker.cancel({operationId: plans[0].operationId});
  await assert.rejects(f.broker.request(write('still-full')), {code: 'OPERATION_HISTORY_FULL'});
  assert.equal((await f.broker.request(write('bounded-0'))).status, 'cancelled');
  assert.equal((await f.broker.uiStatus()).operations.length, 16); assert.equal(f.applyCount, 0); await f.broker.close();
});

test('invalid new reviewed intent is rejected before persistence without disabling healthy authority', async () => {
  const f = setup({prepare: async (_kind, args) => ({kind: 'write', repo: 'Granted', repoId: args.repoId, path: args.path, before: null, after: args.text === 'invalid-plan' ? 'mismatched' : args.text, expectedHash: null, afterHash: textHash(args.text)})});
  await grant(f.broker); await assert.rejects(f.broker.request({...write('invalid'), args: {...write('invalid').args, text: 'invalid-plan'}}), {code: 'INVALID_REQUEST'});
  assert.equal(f.store.scan().events.length, 0); assert.equal((await f.broker.uiStatus()).enabled, true);
  assert.equal((await f.broker.request(write('valid-after'))).status, 'review'); await f.broker.close();
});

test('pending package recovery keeps one applying identity until explicit shared-service recovery completes', async () => {
  let resumed = false, applies = 0, inspections = 0;
  const bytes = Buffer.from('Broker-only immutable archive fixture'), args = {repoId: 'repo-one', archiveBase64: bytes.toString('base64'), semantics: 'patch', version: '2', choices: []};
  const f = setup({prepare: async () => ({kind: 'update', packageDigest: textHash(bytes), collectionId: 'neutral', version: '2', semantics: 'patch', rows: [], drafts: [], warnings: [], fileCount: 1, choices: []}),
    apply: async () => {applies++; throw Object.assign(Error('Interrupted package'), {code: 'RECOVERY_REQUIRED'});},
    inspectInterrupted: async operation => {inspections++; return resumed ? {completed: true, result: {operationId: operation.operationId, status: 'completed'}} : {pending: true};}});
  await grant(f.broker, ['import']); const request = input('recover-package', 'package.plan', args), plan = await f.broker.request(request);
  await assert.rejects(f.broker.approve({operationId: plan.operationId, digest: plan.digest}), {code: 'RECOVERY_REQUIRED'});
  const durableRecords = f.store.scan().events.length;
  assert.equal((await f.broker.request(input('pending-status', 'status', {operationId: plan.operationId}))).status, 'applying');
  assert.equal((await f.broker.request(request)).status, 'applying'); assert.equal((await f.broker.uiStatus()).operations[0].status, 'applying');
  await assert.rejects(f.broker.cancel({operationId: plan.operationId}), {code: 'OPERATION_BUSY'});
  assert.equal(f.store.scan().events.length, durableRecords, 'Read-only inspection cannot fabricate a failed completion'); assert.equal(applies, 1);
  resumed = true; const done = await f.broker.request(input('recovered-status', 'status', {operationId: plan.operationId}));
  assert.equal(done.status, 'completed'); assert.equal(done.result.operationId, plan.operationId); assert.equal((await f.broker.request(request)).status, 'completed');
  assert.equal(applies, 1); assert.ok(inspections >= 4); await f.broker.close();
});

function exportSetup(overrides={}){
  let effects=0;const archive=Buffer.alloc(AUTOMATION_LIMITS.exportArchiveBytes,17),result={filename:'neutral-1-offline.zip',sha256:textHash(archive),archiveBase64:archive.toString('base64'),warnings:[]};
  const f=setup({prepare:async()=>({kind:'export',packageDigest:null,collectionId:'neutral',version:'1',semantics:null,rows:[],drafts:[],warnings:[],fileCount:0,exportKind:'offline'}),apply:async()=>{effects++;return structuredClone(result);},...overrides});
  return {...f,result,get effects(){return effects;},request:id=>input(id,'export.plan',{repoId:'repo-one',kind:'offline',collectionId:'neutral',version:'1'})};
}
test('bounded export receipts survive restart and reserve completion space before a third effect',async()=>{
  const f=exportSetup();await grant(f.broker,['export']);
  const cap=await f.broker.request(input('limits','capabilities'));assert.deepEqual(cap.limits,AUTOMATION_LIMITS);
  const plans=[];for(let i=0;i<2;i++){const plan=await f.broker.request(f.request(`export-${i}`));plans.push(plan);assert.equal((await f.broker.approve({operationId:plan.operationId,digest:plan.digest})).status,'completed');}
  const next=await f.broker.request(f.request('export-no-room'));
  await assert.rejects(f.broker.approve({operationId:next.operationId,digest:next.digest}),{code:'OPERATION_HISTORY_FULL'});
  assert.equal(f.effects,2);assert.equal((await f.broker.uiStatus()).enabled,true);assert.equal((await f.broker.request(input('pending','status',{operationId:next.operationId}))).status,'review');
  const state=f.store.scan().events.at(-1).payload;assert.ok(Buffer.byteLength(JSON.stringify(state))<AUTOMATION_LIMITS.journalBytes);assert.equal(validateAutomationState(state),true);await f.broker.close();
  const again=exportSetup({store:f.store});await grant(again.broker,['export']);
  for(const plan of plans){const status=await again.broker.request(input(`retained-${plan.requestId}`,'status',{operationId:plan.operationId}));assert.equal(status.status,'completed');assert.deepEqual(status.result,f.result);assert.equal((await again.broker.request(again.request(plan.requestId))).operationId,plan.operationId);}
  assert.equal(again.effects,0);await again.broker.close();
});
test('export decoder rejects corrupt or excessive results and a failed result does not poison healthy state',async()=>{
  const f=exportSetup();await grant(f.broker,['export']);const plan=await f.broker.request(f.request('export-decoder'));await f.broker.approve({operationId:plan.operationId,digest:plan.digest});await f.broker.close();
  const clean=f.store.scan().events.at(-1).payload;
  for(const mutate of [result=>{result.sha256='f'.repeat(64);},result=>{result.filename='../escape.zip';},result=>{result.extra='authority';},result=>{result.archiveBase64+='!';},result=>{const bytes=Buffer.alloc(AUTOMATION_LIMITS.exportArchiveBytes+1);result.archiveBase64=bytes.toString('base64');result.sha256=textHash(bytes);}]){const state=structuredClone(clean);mutate(state.operations[0].result);assert.throws(()=>validateAutomationState(state),{code:'INVALID_AUTOMATION_STATE'});}
  const bad=exportSetup({apply:async()=>({value:'x'.repeat(AUTOMATION_LIMITS.exportResultBytes)})});await grant(bad.broker,['export']);const invalid=await bad.broker.request(bad.request('bad-result'));await assert.rejects(bad.broker.approve({operationId:invalid.operationId,digest:invalid.digest}),{code:'LIMIT_EXCEEDED'});assert.equal((await bad.broker.uiStatus()).enabled,true);assert.equal((await bad.broker.request(input('bad-status','status',{operationId:invalid.operationId}))).status,'failed');assert.equal(validateAutomationState(bad.store.scan().events.at(-1).payload),true);await bad.broker.close();
});

test('interrupted effects retain completion capacity until recovery and do not admit later changes',async()=>{
  let recovered=false,effects=0;
  const f=setup({apply:async()=>{effects++;if(!recovered)throw Object.assign(Error('interrupted'),{code:'EIO'});return {saved:true};},inspectInterrupted:async()=>recovered?{completed:true,result:{saved:true}}:{pending:true}});
  await grant(f.broker);const first=await f.broker.request(write('first')),waiting=await f.broker.request(write('waiting'));
  await assert.rejects(f.broker.approve({operationId:first.operationId,digest:first.digest}),{code:'EIO'});
  await assert.rejects(f.broker.request(write('later')),{code:'OPERATION_BUSY'});
  await assert.rejects(f.broker.approve({operationId:waiting.operationId,digest:waiting.digest}),{code:'OPERATION_BUSY'});
  assert.equal((await f.broker.request(input('read-while-pending','read',{repoId:'repo-one',path:'note.md'}))).text,'Saved');assert.equal(effects,1);
  recovered=true;assert.equal((await f.broker.request(input('resolved','status',{operationId:first.operationId}))).status,'completed');
  assert.equal((await f.broker.approve({operationId:waiting.operationId,digest:waiting.digest})).status,'completed');assert.equal(effects,2);await f.broker.close();
});

test('malformed recovered result retains the durable applying record instead of poisoning state',async()=>{
  const f=setup({apply:async()=>{throw Object.assign(Error('interrupted'),{code:'EIO',publicMessage:'x'.repeat(4096)});},inspectInterrupted:async()=>({completed:true,result:'x'.repeat(AUTOMATION_LIMITS.resultBytes+1)})});
  await grant(f.broker);const plan=await f.broker.request(write('bad-recovery'));await assert.rejects(f.broker.approve({operationId:plan.operationId,digest:plan.digest}),{code:'EIO'});
  assert.ok(f.store.scan().events.at(-1).payload.operations[0].error.message.length<512);
  await assert.rejects(f.broker.request(input('inspect','status',{operationId:plan.operationId})),{code:'AUTOMATION_RECOVERY_REQUIRED'});
  const durable=f.store.scan().events.at(-1).payload;assert.equal(durable.operations[0].status,'applying');assert.equal(durable.operations[0].result,undefined);assert.equal(validateAutomationState(durable),true);
  await assert.rejects(grant(f.broker),{code:'AUTOMATION_RECOVERY_REQUIRED'});await f.broker.close();
  const again=setup({store:f.store,inspectInterrupted:async()=>({completed:true,result:{saved:true}})});await grant(again.broker);assert.equal((await again.broker.request(input('valid-inspect','status',{operationId:plan.operationId}))).status,'completed');await again.broker.close();
});

test('already queued grants and effects cannot bypass a preceding durability hold',async()=>{
  const underlying=memoryStore();let appends=0,effects=0;
  const store={...underlying,append(...args){if(++appends===4)throw Object.assign(Error('completion durability failure'),{code:'EIO'});return underlying.append(...args);}};
  const f=setup({store,apply:async()=>{effects++;return {saved:true};}});await grant(f.broker);const first=await f.broker.request(write('first-queued')),second=await f.broker.request(write('second-queued'));
  const result=await Promise.allSettled([f.broker.approve({operationId:first.operationId,digest:first.digest}),grant(f.broker),f.broker.approve({operationId:second.operationId,digest:second.digest})]);
  assert.deepEqual(result.map(item=>item.reason.code),['EIO','AUTOMATION_RECOVERY_REQUIRED','AUTOMATION_RECOVERY_REQUIRED']);assert.equal(effects,1);assert.equal(underlying.scan().events.at(-1).payload.operations[0].status,'applying');await f.broker.close();
});
