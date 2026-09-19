import {randomUUID} from 'node:crypto';
import {createAccountVault, validateAccountStoragePolicy} from './account-vault.mjs';

const DEVICE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const VERIFICATION_URL = 'https://github.com/login/device';
const MAX_BODY = 64 * 1024;
const TIMEOUT_MS = 15000;
export class GitHubAuthError extends Error {
  constructor(code, message) {super(message); this.name = 'GitHubAuthError'; this.code = code;}
}
const error = (code, message) => new GitHubAuthError(code, message);
const cancelled = () => error('GITHUB_CANCELLED', 'GitHub connection was cancelled.');
const dtoError = reason => ({code: reason.code, error: reason.message});
const secret = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && /^[\x21-\x7e]+$/.test(value);
const seconds = value => Number.isSafeInteger(value) && value > 0 && value <= 366 * 86400;
const cleanText = (value, maximum = 256) => typeof value === 'string' && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
function accountFrom(body) {
  if (!body || !Number.isSafeInteger(body.id) || body.id < 1 || !cleanText(body.login, 39) || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(body.login)) throw error('GITHUB_INVALID_RESPONSE', 'GitHub returned an unexpected account response.');
  return {id: body.id, username: body.login, ...(cleanText(body.name) && body.name ? {displayName: body.name} : {}), email: cleanText(body.email, 254) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) ? body.email : null};
}
function tokenFrom(body, now) {
  if (!body || !secret(body.access_token) || body.token_type !== 'bearer' || !seconds(body.expires_in) || !secret(body.refresh_token) || !seconds(body.refresh_token_expires_in)) throw error('GITHUB_INVALID_RESPONSE', 'GitHub must provide an expiring connection token. Check the app registration and reconnect.');
  return {token: body.access_token, refreshToken: body.refresh_token, expiresAt: now + body.expires_in * 1000, refreshExpiresAt: now + body.refresh_token_expires_in * 1000};
}
function validRecord(record) {
  if (!record || !secret(record.token) || !secret(record.refreshToken) || !Number.isSafeInteger(record.expiresAt) || !Number.isSafeInteger(record.refreshExpiresAt)) return false;
  try {return accountFrom({id: record.account?.id, login: record.account?.username, name: record.account?.displayName, email: record.account?.email}).id === record.account.id;} catch {return false;}
}
function normalizedFailure(reason) {
  if (reason instanceof GitHubAuthError) return reason;
  if (reason?.code === 'GITHUB_STORAGE_UNAVAILABLE') return error(reason.code, 'The GitHub connection could not be stored securely. Check local storage, then reconnect.');
  return error('GITHUB_UNAVAILABLE', 'GitHub is unavailable. Check your connection and try again.');
}

/** All credentials remain here in the host. Only getCredential returns a host-use token. */
export function createGitHubAuth({clientId, profileRoot, storage, storagePolicy = 'persistent', fetch: fetcher = globalThis.fetch, openExternal, now = Date.now}) {
  validateAccountStoragePolicy(storagePolicy);
  const normalized = reason => storagePolicy === 'session' && reason?.code === 'GITHUB_STORAGE_UNAVAILABLE' ? error('GITHUB_STORAGE_UNAVAILABLE', 'The GitHub session is unavailable. Disconnect and connect again.') : normalizedFailure(reason);
  const configured = typeof clientId === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(clientId);
  const vault = configured ? createAccountVault({storagePolicy, profileRoot, clientId, storage}) : null;
  const persistence = storagePolicy === 'session' ? {persistence: 'session'} : {};
  let record = null, loaded = false, loadTask, storedError = null, credentialError = null;
  let generation = 0, flow = null, terminal = null, closed = false, paused = false, starting = false, disconnecting = false, refreshTask = null, persistQueue = Promise.resolve();
  const controllers = new Set(), tasks = new Set();
  const track = promise => {tasks.add(promise); promise.then(() => tasks.delete(promise), () => tasks.delete(promise)); return promise;};
  const guard = () => {if (closed) throw error('GITHUB_CLOSED', 'GitHub connection is closed.');};
  const available = () => {guard(); if (paused || disconnecting) throw error('GITHUB_BUSY', 'GitHub connection is busy. Try again shortly.');};
  const needConfig = () => {guard(); if (!configured) throw error('GITHUB_NOT_CONFIGURED', 'GitHub connection is not available in this build. Public repositories can still be cloned.');};
  const current = epoch => {guard(); if (paused || epoch !== generation) throw cancelled();};
  const advance = () => {generation += 1; for (const controller of controllers) controller.abort(); return generation;};
  const serialPersist = operation => {const pending = persistQueue.then(operation); persistQueue = pending.catch(() => {}); return pending;};
  const load = async () => {
    if (!configured || loaded) return;
    if (!loadTask) loadTask = (async () => {
      try {
        const saved = await vault.load();
        if (saved && !validRecord(saved)) throw error('GITHUB_STORAGE_UNAVAILABLE', 'The saved GitHub connection needs recovery. Disconnect and reconnect.');
        record = saved ? {token: saved.token, refreshToken: saved.refreshToken, expiresAt: saved.expiresAt, refreshExpiresAt: saved.refreshExpiresAt,
          account: accountFrom({id: saved.account.id, login: saved.account.username, name: saved.account.displayName, email: saved.account.email})} : null;
      }
      catch (reason) {storedError = normalized(reason);}
      finally {loaded = true;}
    })();
    await loadTask;
  };
  const connection = () => {
    if (!configured) return {configured: false, state: 'unavailable', ...persistence};
    if (storedError) return {configured: true, state: 'unavailable', ...dtoError(storedError), ...persistence};
    if (!record) return {configured: true, state: 'signed-out', ...persistence};
    if (credentialError || (record.expiresAt <= now() && record.refreshExpiresAt <= now())) return {configured: true, state: 'expired', account: {...record.account}, ...(credentialError ? dtoError(credentialError) : {}), ...persistence};
    return {configured: true, state: 'connected', account: {...record.account}, ...persistence};
  };
  const request = async (url, body, token, expectedGeneration) => {
    const controller = new AbortController(); controllers.add(controller);
    let timedOut = false, timer, abort, activeReader, responseBody;
    const interrupted = new Promise((_, reject) => {abort = () => {void activeReader?.cancel().catch(() => {}); reject(cancelled());}; controller.signal.addEventListener('abort', abort, {once: true});});
    const timeout = new Promise((_, reject) => {timer = setTimeout(() => {timedOut = true; controller.abort(); reject(error('GITHUB_TIMEOUT', 'GitHub did not respond in time. Try again.'));}, TIMEOUT_MS); timer.unref?.();});
    try {
      const responseTask = (async () => {
        const response = await fetcher(url, {method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal, headers: {Accept: 'application/json', ...(body ? {'Content-Type': 'application/x-www-form-urlencoded'} : {'X-GitHub-Api-Version': '2026-03-10'}), ...(token ? {Authorization: 'Bearer ' + token} : {})}, ...(body ? {body: new URLSearchParams(body).toString()} : {})});
        responseBody = response.body;
        if (controller.signal.aborted) {void response.body?.cancel().catch(() => {}); throw cancelled();}
        if (response.url && response.url !== url) throw error('GITHUB_INVALID_RESPONSE', 'GitHub returned an unexpected response.');
        const length = Number(response.headers?.get('content-length'));
        if (Number.isFinite(length) && length > MAX_BODY) throw error('GITHUB_INVALID_RESPONSE', 'GitHub returned an unexpected response.');
        const reader = response.body?.getReader(); let bytes = 0, chunks = [];
        if (!reader) throw error('GITHUB_INVALID_RESPONSE', 'GitHub returned an unexpected response.');
        activeReader = reader;
        try {while (true) {const {done, value} = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_BODY) throw error('GITHUB_INVALID_RESPONSE', 'GitHub returned an unexpected response.'); chunks.push(Buffer.from(value));}}
        finally {await reader.cancel().catch(() => {}); activeReader = undefined;}
        let json; try {json = JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw error('GITHUB_INVALID_RESPONSE', 'GitHub returned an unexpected response.');}
        if (!json || typeof json !== 'object' || Array.isArray(json)) throw error('GITHUB_INVALID_RESPONSE', 'GitHub returned an unexpected response.');
        if (response.status === 401) throw error('GITHUB_RECONNECT_REQUIRED', 'GitHub access has expired or was revoked. Connect again.');
        if (response.status === 403 || response.status === 429) throw error('GITHUB_ACCESS_UNAVAILABLE', 'GitHub could not allow this request. Check account access or try again later.');
        if (!response.ok) throw error('GITHUB_UNAVAILABLE', 'GitHub is unavailable. Check your connection and try again.');
        return json;
      })();
      const result = await Promise.race([responseTask, timeout, interrupted]);
      if (closed || expectedGeneration !== generation) throw cancelled();
      return result;
    } catch (reason) {
      if (closed || expectedGeneration !== generation) throw cancelled();
      if (timedOut) throw error('GITHUB_TIMEOUT', 'GitHub did not respond in time. Try again.');
      throw normalized(reason);
    } finally {clearTimeout(timer); controller.signal.removeEventListener('abort', abort); controllers.delete(controller); if (responseBody && !responseBody.locked) void responseBody.cancel().catch(() => {});}
  };
  const publish = (next, expectedGeneration, onCommitted = () => {}) => serialPersist(async () => {
    if (closed || expectedGeneration !== generation) throw cancelled();
    let saved;
    try {saved = await vault.save(next, {isCurrent: () => !closed && expectedGeneration === generation,
      onCommitted: () => {record = next; storedError = null; credentialError = null; onCommitted();}});}
    catch (reason) {const safe = normalized(reason); if (reason?.publicationPending === true) storedError = safe; throw safe;}
    if (!saved) throw cancelled();
  });
  const flowDTO = current => ({requestId: current.requestId, state: 'awaiting-authorization', userCode: current.userCode, verificationUri: VERIFICATION_URL, expiresAt: current.expiresAt, pollInterval: current.interval});
  const finish = (current, state, reason) => {
    const result = {requestId: current.requestId, state, ...(reason ? dtoError(reason) : {}), ...(state === 'connected' ? {account: {...record.account}} : {})};
    if (flow === current) {flow = null; terminal = result;}
    return result;
  };
  const inputId = input => {if (!input || typeof input !== 'object' || Object.keys(input).some(key => key !== 'requestId') || typeof input.requestId !== 'string' || !/^[\da-f-]{36}$/.test(input.requestId)) throw error('GITHUB_INVALID_REQUEST', 'Invalid GitHub connection request.'); return input.requestId;};
  const invalidate = () => {advance(); if (flow) finish(flow, 'cancelled', cancelled());};
  const drain = async () => {await Promise.allSettled([...tasks, ...(loadTask ? [loadTask] : [])]); await persistQueue; await vault?.drain();};

  return {
    getConnection: async () => {guard(); await load(); guard(); return connection();},
    start: () => track((async () => {
      needConfig(); available(); if (starting || flow) throw error('GITHUB_BUSY', 'A GitHub connection is already in progress.');
      starting = true; const epoch = advance(); terminal = null;
      try {
      await load(); current(epoch); if (storedError) throw storedError;
      try {if (!await vault.isAvailable()) throw Error();} catch {throw error('GITHUB_STORAGE_UNAVAILABLE', storagePolicy === 'session' ? 'The GitHub session is unavailable. Connect again.' : 'Secure storage is unavailable. Unlock it before connecting GitHub.');}
      current(epoch);
      const body = await request(DEVICE_URL, {client_id: clientId}, null, epoch);
      if (body.error === 'device_flow_disabled') throw error('GITHUB_NOT_CONFIGURED', 'GitHub device authorization is not enabled for this app.');
      if (!secret(body.device_code) || typeof body.user_code !== 'string' || !/^[A-Z\d]{4}-[A-Z\d]{4}$/.test(body.user_code) || body.verification_uri !== VERIFICATION_URL || !seconds(body.expires_in) || body.expires_in > 3600 || !seconds(body.interval) || body.interval > 300) throw error('GITHUB_INVALID_RESPONSE', 'GitHub returned an unexpected authorization response.');
      flow = {requestId: randomUUID(), generation: epoch, deviceCode: body.device_code, userCode: body.user_code, expiresAt: now() + body.expires_in * 1000, interval: body.interval, nextPollAt: now() + body.interval * 1000, task: null};
      return flowDTO(flow);
      } finally {starting = false;}
    })()),
    poll: input => {
      needConfig(); available(); const requestId = inputId(input), current = flow;
      if (!current || current.requestId !== requestId) return Promise.resolve(terminal?.requestId === requestId ? terminal : {requestId, state: 'cancelled', ...dtoError(cancelled())});
      if (current.task) return current.task;
      if (now() >= current.expiresAt) return Promise.resolve(finish(current, 'expired', error('GITHUB_AUTHORIZATION_EXPIRED', 'The GitHub code expired. Start again.')));
      if (now() < current.nextPollAt) return Promise.resolve(flowDTO(current));
      current.nextPollAt = now() + current.interval * 1000;
      current.task = track((async () => {
        try {
          const body = await request(TOKEN_URL, {client_id: clientId, device_code: current.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code'}, null, current.generation);
          if (body.error === 'authorization_pending') return flowDTO(current);
          if (body.error === 'slow_down') {current.interval = Math.max(current.interval + 5, seconds(body.interval) && body.interval <= 300 ? body.interval : 0); current.nextPollAt = now() + current.interval * 1000; return flowDTO(current);}
          if (body.error === 'expired_token' || body.error === 'token_expired') return finish(current, 'expired', error('GITHUB_AUTHORIZATION_EXPIRED', 'The GitHub code expired. Start again.'));
          if (body.error === 'access_denied') return finish(current, 'failed', error('GITHUB_ACCESS_DENIED', 'GitHub authorization was declined.'));
          if (body.error) return finish(current, 'failed', error('GITHUB_AUTHORIZATION_FAILED', 'GitHub authorization could not finish. Start again.'));
          const next = tokenFrom(body, now());
          next.account = accountFrom(await request(USER_URL, null, next.token, current.generation));
          let result;
          await publish(next, current.generation, () => {result = finish(current, 'connected');});
          return result;
        } catch (reason) {const safe = normalized(reason); return finish(current, safe.code === 'GITHUB_CANCELLED' ? 'cancelled' : 'failed', safe);}
        finally {current.task = null;}
      })());
      return current.task;
    },
    cancel: async input => {
      guard(); const requestId = inputId(input), current = flow;
      if (!current || current.requestId !== requestId) return terminal?.requestId === requestId ? terminal : {requestId, state: 'cancelled', ...dtoError(cancelled())};
      advance(); const task = current.task;
      const result = finish(current, 'cancelled', cancelled());
      await task?.catch(() => {}); await persistQueue;
      return result;
    },
    openVerification: async input => {
      needConfig(); available(); const requestId = inputId(input);
      if (!flow || flow.requestId !== requestId || now() >= flow.expiresAt) throw error('GITHUB_AUTHORIZATION_EXPIRED', 'The GitHub code expired. Start again.');
      if (typeof openExternal !== 'function') throw error('GITHUB_BROWSER_UNAVAILABLE', 'Open github.com/login/device in your browser and enter the code shown.');
      try {await openExternal(VERIFICATION_URL);} catch {throw error('GITHUB_BROWSER_UNAVAILABLE', 'Open github.com/login/device in your browser and enter the code shown.');}
    },
    disconnect: () => track((async () => {
      guard(); if (disconnecting) throw error('GITHUB_BUSY', 'GitHub connection is busy. Try again shortly.');
      disconnecting = true;
      try {
      invalidate(); terminal = null; await load();
      if (vault) await serialPersist(async () => {await vault.remove(); record = null; storedError = null; credentialError = null;});
      return connection();
      } finally {disconnecting = false;}
    })()),
    getCredential: () => track((async () => {
      needConfig(); available(); if (starting || flow) throw error('GITHUB_BUSY', 'Finish or cancel the GitHub connection before accessing repositories.');
      const callGeneration = generation; await load(); current(callGeneration); if (storedError) throw storedError;
      if (!record || credentialError) throw error('GITHUB_RECONNECT_REQUIRED', 'Connect GitHub to access private repositories.');
      if (record.expiresAt > now() + 60000) return {token: record.token};
      if (record.refreshExpiresAt <= now()) {credentialError = error('GITHUB_RECONNECT_REQUIRED', 'GitHub access expired. Connect again.'); throw credentialError;}
      if (!refreshTask) {
        const previous = record, epoch = generation;
        refreshTask = (async () => {
          let rotated = false;
          try {
            const body = await request(TOKEN_URL, {client_id: clientId, grant_type: 'refresh_token', refresh_token: previous.refreshToken}, null, epoch);
            if (body.error) throw error('GITHUB_RECONNECT_REQUIRED', 'GitHub access expired or was revoked. Connect again.');
            const next = tokenFrom(body, now()); rotated = true;
            next.account = accountFrom(await request(USER_URL, null, next.token, epoch));
            if (next.account.id !== previous.account.id) throw error('GITHUB_ACCOUNT_CHANGED', 'GitHub returned a different account. Disconnect and connect again.');
            await publish(next, epoch); return {token: next.token};
          } catch (reason) {
            const safe = normalized(reason);
            if (epoch === generation && (rotated || ['GITHUB_RECONNECT_REQUIRED', 'GITHUB_ACCOUNT_CHANGED'].includes(safe.code))) credentialError = error('GITHUB_RECONNECT_REQUIRED', 'The GitHub connection must be renewed. Connect again.');
            throw safe;
          } finally {refreshTask = null;}
        })();
      }
      return refreshTask;
    })()),
    cancelPending: async () => {guard(); invalidate(); await drain();},
    prepareClose: async () => {guard(); paused = true; invalidate(); await drain();},
    resume: () => {guard(); paused = false;},
    close: async () => {if (closed) return; closed = true; paused = true; invalidate(); await drain(); await vault?.close(); record = null; terminal = null; loadTask = null;},
  };
}
