import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createArtifactHost, clipArtifactBounds, artifactCSP, ARTIFACT_BOOTSTRAP} from './artifact-host.mjs';
import {ARTIFACT_LIMITS} from './artifact-snapshot.mjs';
const snapshot = () => ({identity: 'digest', standalone: true, contentIdentity: {assets: [{path: 'index.html', sha256: 'a'.repeat(64), bytes: 9}]},
  manifest: {title: 'Demo', entryPath: 'index.html', fallbackPath: null}, assets: new Map([['index.html', {bytes: Buffer.from('<h1>A</h1>'), mime: 'text/html', role: 'entry'}]]), sourcePath: 'index.html', entrySourcePath: 'index.html', source: '<h1>A</h1>', fallback: 'Source available'});
function setup(options = {}) {
  const views = [], sessions = [], states = [], attached = new Set(); let reads = 0, proxyCloses = 0;
  class View {
    constructor(config) {this.config = config; const wc = new EventEmitter(); wc.id = views.length + 1; wc.destroyed = false;
      Object.assign(wc, {getOSProcessId: () => 4321, isDestroyed: () => wc.destroyed, close: () => {wc.destroyed = true;},
        setWebRTCIPHandlingPolicy: policy => {wc.rtc = policy;}, setWindowOpenHandler: handler => {wc.popup = handler;}, loadURL: async url => {wc.url = url; await options.load?.(wc);}});
      this.webContents = wc; views.push(this); }
    setBounds(bounds) {if (options.boundsError) throw Error("bounds failed"); this.bounds = bounds;}
    setVisible(value) {this.visible = value;}
  }
  const session = {fromPartition(partition, config) {const ses = new EventEmitter();
    Object.assign(ses, {partition, config, protocol: {handle: (scheme, handler) => {ses.handler = handler;}, unhandle: () => {ses.handler = null;}},
      webRequest: {onBeforeRequest: handler => {ses.request = handler;}}, setPermissionRequestHandler: fn => {ses.permission = fn;},
      setPermissionCheckHandler: fn => {ses.check = fn;}, setDevicePermissionHandler: fn => {ses.device = fn;}, setDisplayMediaRequestHandler: () => {},
      setSpellCheckerEnabled: () => {}, setProxy: async value => {ses.proxy = value;}, enableNetworkEmulation: value => {ses.network = value;},
      closeAllConnections: async () => {}, clearStorageData: async () => {}, clearCache: async () => {}});
    sessions.push(ses); return ses; }};
  const owner = new EventEmitter(); owner.size = [1000, 800];
  Object.assign(owner, {isDestroyed: () => false, getContentSize: () => owner.size, contentView: {addChildView: v => attached.add(v), removeChildView: v => attached.delete(v)}});
  const host = createArtifactHost({owner, WebContentsView: View, session, app: {getAppMetrics: () => [{pid: 4321, memory: {workingSetSize: 100}}]},
    readSnapshot: async request => {reads++; return options.read ? options.read(request, reads) : snapshot();}, onState: value => states.push(value),
    limits: {...ARTIFACT_LIMITS, sampleMs: 10, ...options.limits}, geometryTimeoutMs: options.geometryTimeoutMs ?? 1200, createProxy: async () => ({port: 1111, close: async () => {proxyCloses++;}})});
  return {host, owner, views, sessions, states, attached, get reads() {return reads;}, get proxyCloses() {return proxyCloses;}};
}
const bounds = {x: 50, y: 100, width: 500, height: 300};
test('review never runs, explicit approval rereads immutable bytes and native preferences are restrictive', async () => {
  const t = setup(), review = await t.host.review({repo: 'Test', path: 'index.html'}); assert.equal(t.views.length, 0);
  await assert.rejects(t.host.run({reviewId: review.reviewId, bounds}), {code: 'ARTIFACT_REVIEW_REQUIRED'});
  const running = await t.host.run({reviewId: review.reviewId, approved: true, bounds}); assert.equal(running.state, 'running'); assert.equal(t.reads, 2);
  assert.equal(t.views[0].config.webPreferences.sandbox, true); assert.equal(t.views[0].config.webPreferences.nodeIntegration, false);
  assert.equal(t.views[0].config.webPreferences.preload, undefined); assert.equal(t.views[0].webContents.rtc, 'disable_non_proxied_udp');
  assert.equal(t.sessions[0].partition.startsWith('persist:'), false); assert.equal(t.sessions[0].proxy.proxyBypassRules, '<-loopback>');
  assert.deepEqual(t.sessions[0].network, {offline: true}); await t.host.close(); assert.equal(t.attached.size, 0); assert.equal(t.proxyCloses, 1);
});
test('changed bytes or physical binding revoke review before any renderer is created', async () => {
  const t = setup({read: (_req, count) => ({...snapshot(), identity: count === 1 ? 'a' : 'b'})});
  const review = await t.host.review({repo: 'Test', path: 'index.html'});
  await assert.rejects(t.host.run({reviewId: review.reviewId, approved: true, bounds}), {code: 'ARTIFACT_REVIEW_STALE'});
  assert.equal(t.views.length, 0); assert.equal(t.host.status().reviewId, null); await t.host.close();
});
test('runtime denies external, loopback, unknown resources, permissions, navigation, popup and download', async () => {
  const t = setup(), review = await t.host.review({repo: 'Test', path: 'index.html'}); await t.host.run({reviewId: review.reviewId, approved: true, bounds});
  const ses = t.sessions[0], wc = t.views[0].webContents;
  for (const url of ['https://example.test/x', 'http://127.0.0.1/x', 'ws://localhost/x', 'file:///tmp/a', wc.url.replace('index.html', 'unknown.js')]) {
    let answer; ses.request({url, method: 'GET', resourceType: 'xhr'}, value => {answer = value;}); assert.equal(answer.cancel, true);
  }
  let permission; ses.permission(wc, 'clipboard-read', value => {permission = value;}); assert.equal(permission, false); assert.equal(ses.check(), false); assert.equal(ses.device(), false);
  assert.deepEqual(wc.popup(), {action: 'deny'}); let prevented = 0;
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) wc.emit(name, {preventDefault: () => prevented++});
  ses.emit('will-download', {preventDefault: () => prevented++}, {cancel: () => {}}); assert.equal(prevented, 4);
  const response = ses.handler({url: wc.url, method: 'GET'}); const html = await response.text(); assert.ok(html.indexOf(ARTIFACT_BOOTSTRAP) < html.indexOf('<h1>A'));
  assert.match(response.headers.get('Content-Security-Policy'), /sandbox allow-scripts;/); assert.doesNotMatch(response.headers.get('Content-Security-Policy'), /allow-same-origin|unsafe-eval/);
  await t.host.close();
});
test('stop/reset close old view, bounded lifetime removes live renderer, twenty cycles have no active view', async () => {
  const t = setup({limits: {lifetimeMs: 5000}}), review = await t.host.review({repo: 'Test', path: 'index.html'});
  for (let i = 0; i < 20; i++) {await t.host.run({reviewId: review.reviewId, approved: true, bounds}); t.host.stop(); assert.equal(t.attached.size, 0);}
  await t.host.close(); assert.equal(t.host.status().activeViews, 0); assert.equal(t.host.status().disposed, 20); assert.equal(t.proxyCloses, 20); assert.ok(t.views.every(view => view.webContents.destroyed));
  const limited = setup({limits: {lifetimeMs: 10}}), r = await limited.host.review({repo: 'Test', path: 'index.html'});
  await limited.host.run({reviewId: r.reviewId, approved: true, bounds}); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(limited.host.status().errorCode, 'ARTIFACT_TIME_LIMIT'); assert.equal(limited.attached.size, 0); await limited.host.close();
});
test('bounds cannot cover the titlebar or escape the owner window', () => {
  assert.deepEqual(clipArtifactBounds({x: -50, y: 0, width: 10000, height: 10000}, [1000, 800]), {x: 0, y: 40, width: 1000, height: 760});
  for (const value of [{...bounds, x: NaN}, {...bounds, width: 1}, {...bounds, extra: 1}]) assert.throws(() => clipArtifactBounds(value, [1000, 800]), {code: 'ARTIFACT_INVALID_BOUNDS'});
  assert.match(artifactCSP('asmb-artifact://x'), /worker-src 'none'/);
});
test('stale stop/reset cannot destroy the current renderer and Escape returns to host', async () => {
  const t = setup(), r = await t.host.review({repo: 'Test', path: 'index.html'});
  const first = await t.host.run({reviewId: r.reviewId, approved: true, bounds}); t.host.stop();
  const second = await t.host.run({reviewId: r.reviewId, approved: true, bounds});
  t.host.stop({runId: first.runId}); assert.equal(t.host.status().runId, second.runId);
  await assert.rejects(t.host.reset({reviewId: r.reviewId, runId: first.runId, approved: true, bounds}), {code: 'ARTIFACT_NOT_RUNNING'});
  let prevented = false; t.views.at(-1).webContents.emit('before-input-event', {preventDefault: () => {prevented = true;}}, {type: 'keyDown', key: 'Escape'});
  assert.equal(prevented, true); assert.equal(t.host.status().activeViews, 0); await t.host.close();
});
test('memory budget and unresponsive renderer dispose the view without beforeunload', async () => {
  const t = setup({limits: {memoryKiB: 50}}), r = await t.host.review({repo: 'Test', path: 'index.html'});
  await t.host.run({reviewId: r.reviewId, approved: true, bounds}); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(t.host.status().errorCode, 'ARTIFACT_MEMORY_LIMIT'); assert.equal(t.views[0].webContents.destroyed, true); await t.host.close();
  const u = setup(), q = await u.host.review({repo: 'Test', path: 'index.html'}); await u.host.run({reviewId: q.reviewId, approved: true, bounds});
  u.views[0].webContents.emit('unresponsive'); assert.equal(u.host.status().errorCode, 'ARTIFACT_UNRESPONSIVE'); assert.equal(u.attached.size, 0); await u.host.close();
});
test('public lifecycle requests cannot spoof state or carry undeclared authority', async () => {
  const t = setup(), r = await t.host.review({repo: 'Test', path: 'index.html'});
  for (const value of ['running', null, [], {}, {runId: undefined}, {runId: 'wrong'}, {reviewId: 'wrong'}, {runId: r.reviewId, reviewId: r.reviewId}, {reason: 'running'}]) assert.throws(() => t.host.stop(value), {code: 'ARTIFACT_INVALID_REQUEST'});
  await assert.rejects(t.host.run({reviewId: r.reviewId, approved: true, bounds, network: true}), {code: 'ARTIFACT_INVALID_REQUEST'});
  await assert.rejects(t.host.reset({reviewId: r.reviewId, approved: true, bounds, preload: 'bridge'}), {code: 'ARTIFACT_INVALID_REQUEST'});
  assert.equal(t.host.status().state, 'review'); await t.host.close();
});
test('review-scoped stop cancels a pending Run before its run ID exists and cannot stop a newer review', async () => {
  let unblock, pendingRead;
  const held = new Promise(resolve => {unblock = resolve;});
  const began = new Promise(resolve => {pendingRead = resolve;});
  const t = setup({read: async (_request, count) => {if (count === 2) {pendingRead(); await held;} return snapshot();}});
  const first = await t.host.review({repo: 'Test', path: 'index.html'});
  const work = t.host.run({reviewId: first.reviewId, approved: true, bounds});
  await began; assert.equal(t.host.status().state, 'loading'); assert.equal(t.host.status().runId, null);
  t.host.stop({reviewId: first.reviewId}); unblock(); await assert.rejects(work, {code: 'ARTIFACT_CANCELLED'});
  assert.equal(t.views.length, 0); assert.equal(t.host.status().activeViews, 0);
  const second = await t.host.review({repo: 'Test', path: 'index.html'});
  const running = await t.host.run({reviewId: second.reviewId, approved: true, bounds});
  t.host.stop({reviewId: first.reviewId}); assert.equal(t.host.status().runId, running.runId);
  t.host.stop({reviewId: second.reviewId}); assert.equal(t.host.status().activeViews, 0); await t.host.close();
});
test('closing while native load is pending removes the attached view immediately, before late reply', async () => {
  let releaseLoad, entered; const held = new Promise(resolve => {releaseLoad = resolve;}), loading = new Promise(resolve => {entered = resolve;});
  const t = setup({load: async () => {entered(); await held;}}), review = await t.host.review({repo: 'Test', path: 'index.html'});
  const work = t.host.run({reviewId: review.reviewId, approved: true, bounds}); await loading;
  assert.equal(t.attached.size, 1); assert.equal(t.host.status().state, 'loading');
  t.host.stop({reviewId: review.reviewId}); assert.equal(t.attached.size, 0); assert.equal(t.views[0].webContents.destroyed, true);
  releaseLoad(); await assert.rejects(work, {code: 'ARTIFACT_CANCELLED'}); await t.host.close(); assert.equal(t.host.status().activeViews, 0);
});

test('three sessions each retain one run across ten 1280/960/1280 cycles and never expose stale geometry', async () => {
  for (let session = 0; session < 3; session++) {
    const t = setup(), review = await t.host.review({repo: 'Test', path: 'index.html'});
    const initial = await t.host.run({reviewId: review.reviewId, approved: true, bounds});
    assert.equal(t.views[0].visible, false, 'Initial native view stays hidden until renderer confirms current geometry');
    for (let cycle = 0; cycle < 10; cycle++) for (const width of [1280, 960, 1280]) {
      t.owner.size = [width, 900]; t.owner.emit('resize');
      assert.equal(t.views[0].visible, false, 'Owner resize hides native child immediately');
      assert.equal(t.host.status().geometryPending, true);
      const stale = t.host.resize({runId: initial.runId, bounds, viewport: {width: width + 1, height: 900}});
      assert.equal(stale.runId, initial.runId); assert.equal(stale.geometryPending, true); assert.equal(t.views[0].visible, false);
      const latest = {x: 40, y: 100, width: width - 80, height: 700};
      const ready = t.host.resize({runId: initial.runId, bounds: latest, viewport: {width, height: 900}});
      assert.equal(ready.runId, initial.runId); assert.equal(ready.geometryPending, false); assert.equal(t.views[0].visible, true);
      assert.deepEqual(t.views[0].bounds, latest); assert.equal(ready.activeViews, 1); assert.equal(ready.started, 1);
    }
    const status = t.host.status(); assert.equal(status.diagnostics.length, 32); assert.equal(status.diagnostics.at(-1).event, 'geometry-applied');
    assert.ok(!JSON.stringify(status.diagnostics).includes('index.html')); await t.host.close(); assert.equal(t.attached.size, 0);
  }
});
test('invalid geometry disposes immediately, and cleanup Stop preserves original failure diagnostics', async () => {
  const t = setup(), review = await t.host.review({repo: 'Test', path: 'index.html'});
  const run = await t.host.run({reviewId: review.reviewId, approved: true, bounds});
  assert.throws(() => t.host.resize({runId: run.runId, bounds: {...bounds, width: 1}, viewport: {width: 1000, height: 800}}), {code: 'ARTIFACT_INVALID_BOUNDS'});
  assert.equal(t.attached.size, 0); assert.equal(t.host.status().state, 'failed');
  const failure = t.host.status().lastFailure; assert.equal(failure.code, 'ARTIFACT_INVALID_BOUNDS'); assert.equal(failure.runId, run.runId);
  t.host.stop({reviewId: review.reviewId}); assert.equal(t.host.status().errorCode, failure.code); assert.equal(t.host.status().state, 'failed');
  assert.deepEqual(t.host.status().lastFailure, failure); await t.host.close();
});
test('missing fresh geometry times out hidden; repeated stale messages cannot extend the deadline', async context => {
  // Advance the deadline deterministically: emulated/loaded hosts can pause for
  // longer than this test's deliberately tiny timeout between ordinary awaits.
  context.mock.timers.enable({apis: ['setTimeout']});
  const t = setup({geometryTimeoutMs: 30}), review = await t.host.review({repo: 'Test', path: 'index.html'});
  const run = await t.host.run({reviewId: review.reviewId, approved: true, bounds});
  for (let index = 0; index < 3; index++) {
    context.mock.timers.tick(5);
    t.host.resize({runId: run.runId, bounds, viewport: {width: 999, height: 800}});
    assert.equal(t.views[0].visible, false);
  }
  context.mock.timers.tick(14);
  assert.equal(t.host.status().state, 'running');
  context.mock.timers.tick(1);
  assert.equal(t.host.status().errorCode, 'ARTIFACT_GEOMETRY_TIMEOUT'); assert.equal(t.attached.size, 0); await t.host.close();
});
test('real hide/minimize, native geometry failure and renderer failure dispose rather than retry', async () => {
  for (const [event, reason] of [['hide', 'owner-hidden'], ['minimize', 'owner-minimized']]) {
    const t = setup(), review = await t.host.review({repo: 'Test', path: 'index.html'});
    const run = await t.host.run({reviewId: review.reviewId, approved: true, bounds});
    t.host.resize({runId: run.runId, bounds, viewport: {width: 1000, height: 800}}); t.owner.emit(event); if (event === 'minimize') t.owner.emit('hide');
    assert.equal(t.host.status().lastStopReason, reason); assert.equal(t.attached.size, 0);
    assert.throws(() => t.host.resize({runId: run.runId, bounds, viewport: {width: 1000, height: 800}}), {code: 'ARTIFACT_NOT_RUNNING'});
    await t.host.close(); assert.equal(t.owner.listenerCount(event), 0);
  }
  const options = {}, t = setup(options), review = await t.host.review({repo: 'Test', path: 'index.html'});
  const run = await t.host.run({reviewId: review.reviewId, approved: true, bounds}); options.boundsError = true;
  assert.throws(() => t.host.resize({runId: run.runId, bounds, viewport: {width: 1000, height: 800}}));
  assert.equal(t.host.status().errorCode, 'ARTIFACT_GEOMETRY_FAILED'); assert.equal(t.attached.size, 0); await t.host.close();
  const u = setup(), r = await u.host.review({repo: 'Test', path: 'index.html'}); await u.host.run({reviewId: r.reviewId, approved: true, bounds});
  u.views[0].webContents.emit('render-process-gone'); u.host.stop({reviewId: r.reviewId});
  assert.equal(u.host.status().errorCode, 'ARTIFACT_RENDERER_EXITED'); assert.equal(u.host.status().state, 'failed'); await u.host.close();
});
