import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {ARTIFACT_LIMITS, ARTIFACT_POLICY_VERSION, artifactPublicReview, artifactAssetResponse} from './artifact-snapshot.mjs';

/** Register before Electron ready. No application session handles this scheme. */
export const ARTIFACT_SCHEME = Object.freeze({scheme: 'asmb-artifact', privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true}});
const fail = code => {throw Object.assign(new Error(code), {code});};
const token = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const shape = (value, allowed) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const safeError = error => typeof error?.code === 'string' && /^ARTIFACT_[A-Z_]+$/.test(error.code) ? error.code : 'ARTIFACT_FAILED';
// Opaque-origin CSP and native session policy are primary constraints. Removing
// these constructors before repository script executes closes otherwise exposed
// browser transports/realm factories; it is deliberately not a generic bridge.
export const ARTIFACT_BOOTSTRAP = `(()=>{'use strict';const deny=()=>{throw new DOMException('Unavailable in an offline interactive view','NotAllowedError')};for(const name of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','RTCIceTransport','RTCDtlsTransport','RTCSctpTransport','WebTransport','WebSocket','Worker','SharedWorker','open','showOpenFilePicker','showSaveFilePicker','showDirectoryPicker','alert','confirm','prompt','print']){try{Object.defineProperty(globalThis,name,{value:deny,writable:false,configurable:false})}catch{}}for(const name of ['serviceWorker','usb','serial','bluetooth','hid','clipboard','geolocation']){try{Object.defineProperty(navigator,name,{value:undefined,writable:false,configurable:false})}catch{}}})();`;
export function artifactCSP(origin) {
  return `default-src 'none'; sandbox allow-scripts; script-src ${origin} 'unsafe-inline'; style-src ${origin} 'unsafe-inline'; img-src ${origin} data:; font-src ${origin}; connect-src ${origin}; worker-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}
export function clipArtifactBounds(value, size) {
  if (!value || Object.keys(value).some(key => !['x', 'y', 'width', 'height'].includes(key)) || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key]) && Math.abs(value[key]) <= 20000)) fail('ARTIFACT_INVALID_BOUNDS');
  const x = Math.max(0, Math.min(Math.floor(value.x), size[0])), y = Math.max(40, Math.min(Math.floor(value.y), size[1]));
  const width = Math.min(Math.max(0, Math.floor(value.width)), size[0] - x), height = Math.min(Math.max(0, Math.floor(value.height)), size[1] - y);
  if (width < 120 || height < 80) fail('ARTIFACT_INVALID_BOUNDS');
  return {x, y, width, height};
}

async function denyProxy() {
  // Chromium's RTC disable_non_proxied_udp still allows TCP. A mandatory session
  // proxy accepts no tunnel and never forwards bytes. Unlike an assumed unused
  // port, this listener is owned until the artifact session is disposed.
  const sockets = new Set();
  const server = http.createServer((_request, response) => {response.writeHead(403, {'Connection': 'close'}); response.end();});
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('connection', socket => {sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.setTimeout(1000, () => socket.destroy());});
  server.maxConnections = 8; server.requestTimeout = 1000; server.headersTimeout = 1000;
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  return {port: server.address().port, close: () => new Promise(resolve => {for (const socket of sockets) socket.destroy(); server.close(resolve);})};
}

/** Same Electron runtime and owner window, separate sandboxed renderer and
 * ephemeral session. Caller retains all IPC identity/current-document checks. */
export function createArtifactHost({owner, WebContentsView, session, app, readSnapshot, onState = () => {}, limits = ARTIFACT_LIMITS, createProxy = denyProxy, geometryTimeoutMs = 1200}) {
  let review = null, active = null, closed = false, epoch = 0, disposed = 0, started = 0, state = 'idle', errorCode = null, disposing = Promise.resolve();
  let runTail = Promise.resolve();
  const partition = `asmb-artifact-${randomUUID()}`;
  const counts = {deniedRequests: 0, deniedNavigations: 0, deniedPopups: 0, deniedDownloads: 0, deniedPermissions: 0};
  let lastMemoryKiB = 0, peakMemoryKiB = 0, lastFailure = null, lastStopReason = null, eventSequence = 0;
  const diagnostics = [];
  const record = (event, detail = {}) => {diagnostics.push({sequence: ++eventSequence, at: Date.now(), event, runId: active?.id ?? null, ...detail}); if (diagnostics.length > 32) diagnostics.shift();};
  const size = () => owner.isDestroyed() ? [0, 0] : owner.getContentSize();
  const viewportMatches = value => shape(value, ['width', 'height']) && Number.isInteger(value.width) && Number.isInteger(value.height) && value.width === size()[0] && value.height === size()[1];
  const current = () => ({state, errorCode, reviewId: review?.id ?? null, runId: active?.id ?? null, policyVersion: ARTIFACT_POLICY_VERSION,
    activeViews: active ? 1 : 0, started, disposed, webContentsId: active?.view.webContents.id ?? null,
    processId: active && !active.view.webContents.isDestroyed() ? active.view.webContents.getOSProcessId() : null, lastMemoryKiB, peakMemoryKiB, geometryPending: active?.geometryPending ?? false, bounds: active?.bounds ?? null, ownerSize: size(), lastFailure, lastStopReason, diagnostics: diagnostics.map(item => ({...item})), ...counts});
  const emit = () => {try {onState(current());} catch {}};
  async function releaseSession(ses, proxy) {
    if (ses) {
      try {ses.protocol.unhandle('asmb-artifact');} catch {}
      try {ses.webRequest.onBeforeRequest(null);} catch {}
      try {ses.removeAllListeners('will-download'); ses.setPermissionRequestHandler(null); ses.setPermissionCheckHandler(null); ses.setDevicePermissionHandler(null); ses.setDisplayMediaRequestHandler(null);} catch {}
      await Promise.allSettled([ses.closeAllConnections(), ses.clearStorageData(), ses.clearCache()]);
    }
    await proxy?.close();
  }
  function disposeActive() {
    const previous = active; active = null;
    if (!previous) return;
    clearTimeout(previous.lifetime); clearTimeout(previous.loadTimer); clearTimeout(previous.geometryTimer); clearInterval(previous.monitor);
    try {owner.contentView.removeChildView(previous.view);} catch {}
    try {if (!previous.view.webContents.isDestroyed()) previous.view.webContents.close({waitForBeforeUnload: false});} catch {}
    disposed++;
    disposing = disposing.then(() => releaseSession(previous.ses, previous.proxy)).catch(() => {});
  }
  function stop(reason = 'stopped', event = 'explicit-stop') {
    if (typeof reason === 'object') {
      if (reason?.runId && active?.id !== reason.runId || reason?.reviewId && review?.id !== reason.reviewId) return current();
      reason = 'stopped';
    }
    const hadRun = Boolean(active) || state === 'loading';
    record(event, {didDispose: hadRun}); if (hadRun || !lastStopReason) lastStopReason = event;
    const retainFailure = state === 'failed' && !active;
    epoch++; disposeActive(); if (!retainFailure) {state = reason; errorCode = null;} emit(); return current();
  }
  function failed(code) {record('failed', {code}); lastFailure = {code, at: Date.now(), runId: active?.id ?? null}; lastStopReason = 'runtime-failure'; epoch++; disposeActive(); state = 'failed'; errorCode = code; emit();}
  function suspendGeometry(event) {
    if (!active) return;
    const id = active.id;
    try {active.view.setVisible(false);} catch {failed('ARTIFACT_GEOMETRY_FAILED'); return;}
    active.geometryPending = true;
    if (state === 'running' && !active.geometryTimer) active.geometryTimer = setTimeout(() => {if (active?.id === id && active.geometryPending) failed('ARTIFACT_GEOMETRY_TIMEOUT');}, geometryTimeoutMs);
    record(event, {ownerSize: size(), bounds: active.bounds}); emit();
  }
  const ensure = () => {if (closed || owner.isDestroyed()) fail('ARTIFACT_CLOSED');};
  async function prepare(request) {
    ensure(); stop(); review = null; const operation = ++epoch;
    try {
      const snapshot = await readSnapshot(request);
      if (closed || operation !== epoch) fail('ARTIFACT_CANCELLED');
      review = {id: randomUUID(), request: structuredClone(request), snapshot}; state = 'review'; errorCode = null; emit();
      return artifactPublicReview(snapshot, review.id);
    } catch (error) {if (operation === epoch) failed(safeError(error)); throw error;}
  }
  async function runOnce(request) {
    ensure();
    if (!request || !token(request.reviewId) || request.approved !== true || !review || request.reviewId !== review.id) fail('ARTIFACT_REVIEW_REQUIRED');
    const bounds = clipArtifactBounds(request.bounds, owner.getContentSize());
    disposeActive(); const operation = ++epoch, selected = review;
    state = 'loading'; errorCode = null; lastStopReason = null; record('run-request'); emit();
    let proxy, ses, view;
    try {
      const snapshot = await readSnapshot(selected.request);
      if (closed || operation !== epoch || review !== selected) fail('ARTIFACT_CANCELLED');
      if (snapshot.identity !== selected.snapshot.identity) {review = null; fail('ARTIFACT_REVIEW_STALE');}
      await disposing;
      proxy = await createProxy();
      if (closed || operation !== epoch) fail('ARTIFACT_CANCELLED');
      const id = randomUUID(), origin = `asmb-artifact://${id}`, url = `${origin}/${snapshot.manifest.entryPath.split('/').map(encodeURIComponent).join('/')}`;
      // One session per host, reused only after prior view destruction and complete
      // storage/connection cleanup. Every Run still gets a fresh opaque document
      // origin, avoiding unbounded Session objects during repeated open/close.
      ses = session.fromPartition(partition, {cache: false});
      ses.setPermissionRequestHandler((_wc, _permission, callback) => {counts.deniedPermissions++; callback(false);});
      ses.setPermissionCheckHandler(() => {counts.deniedPermissions++; return false;});
      ses.setDevicePermissionHandler(() => false);
      ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
      ses.setSpellCheckerEnabled(false);
      await ses.setProxy({mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${proxy.port}`, proxyBypassRules: '<-loopback>'});
      ses.enableNetworkEmulation({offline: true});
      ses.webRequest.onBeforeRequest((details, callback) => {
        const admitted = active?.id === id && artifactAssetResponse(snapshot, details.url, origin, details.method)
          && details.resourceType !== 'subFrame' && (details.resourceType !== 'mainFrame' || details.url === url);
        if (!admitted) counts.deniedRequests++;
        callback({cancel: !admitted});
      });
      ses.on('will-download', (event, item) => {counts.deniedDownloads++; event.preventDefault(); try {item.cancel();} catch {}});
      ses.protocol.handle('asmb-artifact', request => {
        const asset = active?.id === id && artifactAssetResponse(snapshot, request.url, origin, request.method);
        if (!asset) {counts.deniedRequests++; return new Response('Unavailable', {status: 404});}
        const bytes = asset.entry ? Buffer.concat([Buffer.from(`<!doctype html><meta charset="utf-8"><script>${ARTIFACT_BOOTSTRAP}</script>`), asset.bytes]) : asset.bytes;
        return new Response(bytes, {headers: {'Content-Type': asset.mime, 'Content-Security-Policy': artifactCSP(origin),
          'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
          'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), clipboard-read=(), clipboard-write=(), display-capture=(), fullscreen=(), payment=(), local-network-access=()'}});
      });
      if (closed || operation !== epoch) fail('ARTIFACT_CANCELLED');
      view = new WebContentsView({webPreferences: {session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false,
        nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true, webviewTag: false, plugins: false,
        experimentalFeatures: false, spellcheck: false, safeDialogs: true, navigateOnDragDrop: false, devTools: false,
        backgroundThrottling: true, webgl: true, autoplayPolicy: 'document-user-activation-required'}});
      const wc = view.webContents;
      wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
      wc.setWindowOpenHandler(() => {counts.deniedPopups++; return {action: 'deny'};});
      const navigation = event => {counts.deniedNavigations++; event.preventDefault();};
      wc.on('will-navigate', navigation); wc.on('will-frame-navigate', navigation); wc.on('will-redirect', navigation);
      wc.on('will-attach-webview', event => event.preventDefault());
      wc.on('will-prevent-unload', event => event.preventDefault());
      wc.on('before-input-event', (event, input) => {if (input.type === 'keyDown' && input.key === 'Escape') {event.preventDefault(); stop(); owner.webContents?.focus();}});
      wc.on('unresponsive', () => {if (active?.id === id) failed('ARTIFACT_UNRESPONSIVE');});
      wc.on('render-process-gone', () => {if (active?.id === id) failed('ARTIFACT_RENDERER_EXITED');});
      const lifetime = setTimeout(() => {if (active?.id === id) failed('ARTIFACT_TIME_LIMIT');}, limits.lifetimeMs);
      const loadTimer = setTimeout(() => {if (active?.id === id && state === 'loading') failed('ARTIFACT_LOAD_TIMEOUT');}, limits.loadMs);
      const monitor = setInterval(() => {
        if (active?.id !== id || wc.isDestroyed()) return;
        try {const metrics = app.getAppMetrics().find(item => item.pid === wc.getOSProcessId());
          lastMemoryKiB = metrics?.memory?.workingSetSize ?? 0; peakMemoryKiB = Math.max(peakMemoryKiB, lastMemoryKiB);
          if (lastMemoryKiB > limits.memoryKiB) failed('ARTIFACT_MEMORY_LIMIT');
        } catch {}
      }, limits.sampleMs);
      active = {id, view, ses, proxy, lifetime, loadTimer, monitor, geometryPending: false, geometryTimer: null, bounds}; started++;
      view.setVisible(false); owner.contentView.addChildView(view);
      // Snapshot/proxy setup is asynchronous. Keep the initial child hidden until
      // fresh renderer geometry is confirmed, even if the window resized meanwhile.
      view.setBounds(clipArtifactBounds(bounds, size())); suspendGeometry('initial-geometry'); emit();
      await wc.loadURL(url);
      if (closed || operation !== epoch || active?.id !== id) fail('ARTIFACT_CANCELLED');
      clearTimeout(loadTimer); state = 'running'; suspendGeometry('initial-geometry-ready'); emit(); return current();
    } catch (error) {
      if (!active || active.view !== view) {
        try {if (view && !view.webContents.isDestroyed()) view.webContents.close({waitForBeforeUnload: false});} catch {}
        await releaseSession(ses, proxy).catch(() => {});
      }
      if (operation === epoch) failed(safeError(error));
      throw Object.assign(new Error(safeError(error)), {code: safeError(error)});
    }
  }
  async function run(request) {
    if (!shape(request, ['reviewId', 'approved', 'bounds'])) fail('ARTIFACT_INVALID_REQUEST');
    const admissionEpoch = epoch;
    const result = runTail.then(() => {ensure(); if (epoch !== admissionEpoch) fail('ARTIFACT_CANCELLED'); return runOnce(request);});
    runTail = result.catch(() => {}); return result;
  }
  const hidden = () => stop('stopped', 'owner-hidden'), minimized = () => stop('stopped', 'owner-minimized');
  const resized = () => suspendGeometry('owner-resize');
  owner.on?.('hide', hidden); owner.on?.('minimize', minimized); owner.on?.('resize', resized);
  return Object.freeze({review: prepare, run, async reset(request) {
      if (!shape(request, ['reviewId', 'runId', 'approved', 'bounds']) || request.runId !== undefined && !token(request.runId)) fail('ARTIFACT_INVALID_REQUEST');
      if (active && request.runId !== active.id || request.runId && !active) fail('ARTIFACT_NOT_RUNNING');
      return run({reviewId: request.reviewId, approved: request.approved, bounds: request.bounds});
    },
    resize(request) {
      ensure(); if (!shape(request, ['runId', 'bounds', 'viewport']) || !token(request.runId)) fail('ARTIFACT_INVALID_REQUEST');
      if (!active || request.runId !== active.id) fail('ARTIFACT_NOT_RUNNING');
      let bounds;
      try {
        // Invalid geometry is never retained or retried. A valid rectangle for a
        // superseded viewport is retryable only while the native child is hidden.
        clipArtifactBounds(request.bounds, [20000, 20000]);
        if (!viewportMatches(request.viewport)) {suspendGeometry('stale-viewport'); return current();}
        bounds = clipArtifactBounds(request.bounds, size());
        active.view.setBounds(bounds); active.bounds = bounds; active.view.setVisible(true);
        clearTimeout(active.geometryTimer); active.geometryTimer = null; active.geometryPending = false;
        record('geometry-applied', {bounds, ownerSize: size()}); return current();
      } catch (error) {failed(safeError(error) === 'ARTIFACT_FAILED' ? 'ARTIFACT_GEOMETRY_FAILED' : safeError(error)); throw error;}
    },
    decline(request) {ensure(); if (!shape(request, ['reviewId']) || !token(request.reviewId) || request.reviewId !== review?.id) fail('ARTIFACT_REVIEW_REQUIRED'); stop('declined'); review = null; return current();},
    stop(request) {
      if (request !== undefined && (!shape(request, ['runId', 'reviewId']) || Object.keys(request).length !== 1
        || !(token(request.runId) || token(request.reviewId)))) fail('ARTIFACT_INVALID_REQUEST');
      return stop(request);
    },
    status: current, async close() {if (closed) return disposing; stop(); review = null; closed = true;
      owner.removeListener?.('hide', hidden); owner.removeListener?.('minimize', minimized); owner.removeListener?.('resize', resized); await runTail; await disposing;}});
}
