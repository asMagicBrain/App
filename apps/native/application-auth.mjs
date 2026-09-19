import {randomUUID} from 'node:crypto';
import {createAccountVault, validateAccountStoragePolicy} from './account-vault.mjs';
import {createApplicationCallback} from './application-callback.mjs';
import {ApplicationAuthError, authError, cancelled, unavailable, createAuthTransport} from './application-transport.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const text = (value, maximum) => typeof value === 'string' && value.length <= maximum && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const token = value => text(value, 8192) && /^[\x21-\x7e]+$/.test(value);
const emailAddress = value => text(value, 254) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const invalid = () => authError('ACCOUNT_INVALID_REQUEST', 'Check the account request and try again.');
const invalidResponse = () => authError('ACCOUNT_INVALID_RESPONSE', 'The account service returned an invalid response.');
const shape = (input, keys) => input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key));
const inputId = input => {if (!shape(input, ['requestId']) || !UUID.test(input.requestId)) throw invalid(); return input.requestId;};
const normalizeFailure = reason => reason instanceof ApplicationAuthError ? reason : reason?.code === 'ACCOUNT_STORAGE_UNAVAILABLE' ? authError('ACCOUNT_STORAGE_UNAVAILABLE', 'The account could not be stored securely. Sign out and try again after checking local storage.') : unavailable();

export function validateApplicationConfig(value) {
  if (!value || value.origin === null) return Object.freeze({origin: null, publishableKey: null, providers: Object.freeze({github: false, email: false})});
  let origin;
  try {origin = new URL(value.origin);} catch {}
  if (!shape(value, ['origin', 'publishableKey', 'providers']) || !origin || origin.protocol !== 'https:' || origin.origin !== value.origin || origin.username || origin.password || typeof value.publishableKey !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]{10,256}$/.test(value.publishableKey) || !shape(value.providers, ['github', 'email']) || Object.values(value.providers).some(item => typeof item !== 'boolean')) throw authError('ACCOUNT_NOT_CONFIGURED', 'Application account configuration is invalid.');
  return Object.freeze({origin: value.origin, publishableKey: value.publishableKey, providers: Object.freeze({...value.providers})});
}
function profileFrom(user) {
  if (!user || !UUID.test(user.id) || user.is_anonymous === true) throw invalidResponse();
  const metadata = user.user_metadata ?? {};
  const name = [metadata.display_name, metadata.full_name, metadata.name].find(value => text(value, 80) && value.trim());
  const account = {id: user.id, displayName: name?.trim() ?? 'asMagicBrain account', email: emailAddress(user.email) ? user.email : null};
  const identity = Array.isArray(user.identities) ? user.identities.find(item => item?.provider === 'github') : null;
  const providerId = identity?.identity_data?.provider_id ?? identity?.identity_data?.sub;
  if (typeof providerId === 'string' && /^[1-9][0-9]{0,19}$/.test(providerId)) {
    const username = identity?.identity_data?.user_name ?? identity?.identity_data?.preferred_username;
    account.github = {id: providerId, username: text(username, 39) && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(username) ? username : null};
  }
  return account;
}
function sessionFrom(session, user, origin, now) {
  const account = profileFrom(user);
  if (!session || !token(session.access_token) || !token(session.refresh_token) || session.token_type !== 'bearer') throw invalidResponse();
  let claims;
  try {const pieces = session.access_token.split('.'); if (pieces.length !== 3) throw Error(); claims = JSON.parse(Buffer.from(pieces[1], 'base64url').toString('utf8'));} catch {throw invalidResponse();}
  // These claims are only cross-checks. Authentication comes from getUser(jwt).
  if (claims.iss !== origin + '/auth/v1' || claims.sub !== account.id || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now || claims.exp * 1000 > now + 367 * 86400000) throw invalidResponse();
  // The SDK may calculate expires_at from receipt time when omitted by the
  // provider. After getUser authenticates this JWT, use its actual exp instead.
  return {schemaVersion: 1, issuer: origin, account, session: {access_token: session.access_token, refresh_token: session.refresh_token, expires_at: claims.exp, expires_in: Math.max(1, claims.exp - Math.floor(now / 1000)), token_type: 'bearer', user: {id: account.id, email: account.email ?? undefined, app_metadata: {}, user_metadata: {display_name: account.displayName}, aud: 'authenticated', created_at: ''}}};
}
function validStored(saved, origin) {
  if (!saved || saved.schemaVersion !== 1 || saved.issuer !== origin || !UUID.test(saved.account?.id) || !text(saved.account?.displayName, 80) || !(saved.account.email === null || emailAddress(saved.account.email)) || saved.session?.user?.id !== saved.account.id || !token(saved.session.access_token) || !token(saved.session.refresh_token) || !Number.isSafeInteger(saved.session.expires_at) || saved.session.token_type !== 'bearer') return false;
  if (saved.account.github && (!/^[1-9][0-9]{0,19}$/.test(saved.account.github.id) || !(saved.account.github.username === null || text(saved.account.github.username, 39)))) return false;
  return !Object.hasOwn(saved.session, 'provider_token') && !Object.hasOwn(saved.session, 'provider_refresh_token');
}

export const applicationAccountMethods = new Set(['getApplicationAccount', 'startApplicationSignIn', 'pollApplicationSignIn', 'verifyApplicationEmail', 'cancelApplicationSignIn', 'cancelPendingApplicationSignIn', 'refreshApplicationAccount', 'updateApplicationProfile', 'signOutApplicationAccount']);

/** Official host Auth SDK with volatile SDK storage and explicit account-vault publication. */
export function createApplicationAuth({config, AuthClient, profileRoot, storage, storagePolicy = 'persistent', openExternal, fetch, now = Date.now, timeoutMs, flowLifetimeMs = 10 * 60 * 1000, callbackFactory = createApplicationCallback}) {
  validateAccountStoragePolicy(storagePolicy);
  const normalize = reason => storagePolicy === 'session' && reason?.code === 'ACCOUNT_STORAGE_UNAVAILABLE' ? authError('ACCOUNT_STORAGE_UNAVAILABLE', 'The account session is unavailable. Sign out and sign in again.') : normalizeFailure(reason);
  config = validateApplicationConfig(config);
  const configured = Boolean(config.origin), transport = createAuthTransport({origin: config.origin, fetch, timeoutMs});
  const vault = configured ? createAccountVault({storagePolicy, profileRoot, clientId: 'supabase:' + config.origin, storage, namespace: 'application-auth', errorCode: 'ACCOUNT_STORAGE_UNAVAILABLE'}) : null;
  let record = null, loaded = false, loadTask, verified = false, status = 'signed-out', storedError = null, stateError = null, notice = null;
  let flow = null, terminal = null, epoch = 0, busy = null, refreshTask = null, closed = false, paused = false;
  const tasks = new Set();
  const track = task => {tasks.add(task); task.then(() => tasks.delete(task), () => tasks.delete(task)); return task;};
  const guard = () => {if (closed || paused) throw authError('ACCOUNT_CLOSED', 'The application is closing.'); if (!configured) throw authError('ACCOUNT_NOT_CONFIGURED', 'Application accounts are unavailable in this build.');};
  const free = () => {guard(); if (busy || flow) throw authError('ACCOUNT_BUSY', 'Finish or cancel the current account request first.');};
  const dto = () => ({configured, ...(storagePolicy === 'session' ? {persistence: 'session'} : {}), providers: {...config.providers}, state: !configured || storedError ? 'unavailable' : record ? status === 'signed-in' && record.session.expires_at * 1000 <= now() ? 'expired' : status : 'signed-out', ...(record ? {account: structuredClone(record.account)} : {}), ...((storedError ?? stateError) ? {error: (storedError ?? stateError).message} : {}), ...(notice ? {notice} : {})});
  const load = async () => {
    if (!configured || loaded) return;
    loadTask ??= (async () => {
      try {const saved = await vault.load(); if (saved && !validStored(saved, config.origin)) throw authError('ACCOUNT_STORAGE_UNAVAILABLE', 'The saved account needs recovery. Sign out and sign in again.'); record = saved; status = saved ? 'offline' : 'signed-out';}
      catch (reason) {storedError = normalize(reason);}
      finally {loaded = true;}
    })();
    await loadTask;
  };
  const secure = async () => {try {if (await vault.isAvailable()) return;} catch {} throw authError('ACCOUNT_STORAGE_UNAVAILABLE', storagePolicy === 'session' ? 'The account session is unavailable. Sign in again.' : 'Secure storage is unavailable. Unlock it before signing in.');};
  const client = (seed = null) => {
    const ctx = transport.context(), memory = new Map(), key = 'asmb-' + randomUUID();
    if (seed) memory.set(key, JSON.stringify(seed));
    const sdk = new AuthClient({url: config.origin + '/auth/v1', headers: {apikey: config.publishableKey}, storageKey: key, storage: {getItem: name => memory.get(name) ?? null, setItem: (name, value) => {memory.set(name, value);}, removeItem: name => {memory.delete(name);}}, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce', experimental: {appendPkceFlowIdToRedirects: false}, fetch: transport.forContext(ctx), debug: false});
    return {sdk, ctx, async close() {await sdk.dispose(); memory.clear(); transport.release(ctx);}};
  };
  const result = (value, owner) => {if (owner.ctx.failure) throw owner.ctx.failure; if (value.error) throw authError('ACCOUNT_REAUTH_REQUIRED', 'Sign-in could not be verified. Start again.'); return value.data;};
  const publish = async (next, isCurrent = () => true, onCommitted = () => {}) => {
    try {
      const saved = await vault.save(next, {isCurrent, onCommitted: () => {record = next; verified = true; status = 'signed-in'; storedError = null; stateError = null; notice = null; onCommitted();}});
      if (!saved) throw cancelled();
    } catch (reason) {if (reason?.publicationPending || reason?.code === 'ACCOUNT_STORAGE_UNAVAILABLE') storedError = normalize(reason); throw normalize(reason);}
  };
  const verifySession = async (session, owner, previousId) => {
    const user = result(await owner.sdk.getUser(session?.access_token), owner)?.user;
    const next = sessionFrom(session, user, config.origin, now());
    if (previousId && next.account.id !== previousId) throw authError('ACCOUNT_CHANGED', 'The service returned a different account. Sign out and sign in again.');
    return next;
  };
  const pendingDTO = current => ({requestId: current.requestId, state: current.method === 'github' ? 'awaiting-browser' : 'awaiting-email', expiresAt: current.expiresAt, ...(current.error ? {error: current.error.message} : {})});
  const finish = (current, state, reason) => {
    const value = {requestId: current.requestId, state, ...(state === 'signed-in' ? {account: structuredClone(record.account)} : {}), ...(reason ? {error: normalize(reason).message} : {})};
    clearTimeout(current.timer);
    if (flow === current) {flow = null; terminal = value;}
    current.settle?.(value);
    void current.callback?.close();
    return value;
  };
  const flowCurrent = current => !closed && !paused && flow === current && current.epoch === epoch && now() < current.expiresAt;
  const cleanupFlow = async current => {await current.callback?.close(); await current.owner?.close();};
  function complete(current, operation, allowRetry = false) {
    if (current.task) return current.task;
    current.task = track((async () => {
      let keepOpen = false, acquired = false;
      try {
        if (!flowCurrent(current)) throw cancelled(); current.owner.ctx.failure = null;
        const data = result(await operation(), current.owner); acquired = true;
        if (!flowCurrent(current)) throw cancelled();
        const next = await verifySession(data?.session, current.owner);
        if (!flowCurrent(current)) throw cancelled();
        let committed;
        await publish(next, () => flowCurrent(current), () => {committed = finish(current, 'signed-in');});
        return committed;
      } catch (reason) {
        const safe = normalize(reason);
        if (allowRetry && !acquired && flowCurrent(current) && ['ACCOUNT_REAUTH_REQUIRED', 'ACCOUNT_UNAVAILABLE', 'ACCOUNT_TIMEOUT', 'ACCOUNT_RATE_LIMITED'].includes(safe.code)) {keepOpen = true; current.error = safe; return pendingDTO(current);}
        return finish(current, safe.code === 'ACCOUNT_CANCELLED' ? 'cancelled' : 'failed', safe);
      } finally {if (keepOpen) current.task = null; else await cleanupFlow(current);}
    })());
    return current.task;
  }
  async function cancelFlow() {
    epoch += 1; const current = flow;
    if (!current) return;
    transport.cancel(current.owner.ctx);
    const cancelledDTO = finish(current, 'cancelled', cancelled());
    if (current.task) await current.task; else await cleanupFlow(current);
    await vault?.drain();
    return cancelledDTO;
  }
  const refresh = () => {
    if (refreshTask) return refreshTask;
    free(); busy = 'refresh';
    refreshTask = track((async () => {
      let owner, rotated = false;
      try {
        await load(); if (storedError || !record) return dto();
        const previous = record;
        owner = client(previous.session);
        let session = previous.session;
        if (session.expires_at * 1000 <= now() + 120000) {
          await secure();
          session = result(await owner.sdk.refreshSession({refresh_token: session.refresh_token}), owner)?.session;
          rotated = true;
        }
        const next = await verifySession(session, owner, previous.account.id);
        await publish(next);
      } catch (reason) {
        const safe = normalize(reason); stateError = safe; verified = true;
        status = rotated || ['ACCOUNT_REAUTH_REQUIRED', 'ACCOUNT_CHANGED', 'ACCOUNT_INVALID_RESPONSE'].includes(safe.code) ? 'expired' : 'offline';
        if (rotated && safe.code === 'ACCOUNT_STORAGE_UNAVAILABLE') storedError = safe;
      } finally {await owner?.close(); busy = null; refreshTask = null;}
      return dto();
    })());
    return refreshTask;
  };
  const api = {
    async getApplicationAccount() {await load(); if (configured && record && !storedError && !verified && !busy && !flow && !paused) return refresh(); return dto();},
    startApplicationSignIn(input) {
      free();
      if (!input || !['github', 'email'].includes(input.method) || !shape(input, input.method === 'github' ? ['method'] : ['method', 'email']) || (input.method === 'email' && (typeof input.email !== 'string' || !emailAddress(input.email.trim())))) throw invalid();
      if (!config.providers[input.method]) throw authError('ACCOUNT_PROVIDER_UNAVAILABLE', 'This sign-in method is unavailable.');
      busy = 'start'; const expected = ++epoch; terminal = null;
      return track((async () => {
        let current;
        try {
          await load(); if (storedError) throw storedError; await secure();
          if (paused || closed || epoch !== expected) throw cancelled();
          let settle;
          const completion = new Promise(resolve => {settle = resolve;});
          current = {requestId: randomUUID(), method: input.method, email: input.method === 'email' ? input.email.trim() : null, epoch: expected, expiresAt: now() + flowLifetimeMs, owner: client(), task: null, callback: null, completion, settle};
          flow = current;
          current.callback = await callbackFactory({onCode: code => {void complete(current, () => current.owner.sdk.exchangeCodeForSession(code));}, onError: reason => {if (flow !== current) return; transport.cancel(current.owner.ctx); finish(current, 'failed', reason); if (!current.task) void cleanupFlow(current);}});
          if (!flowCurrent(current)) throw cancelled();
          current.timer = setTimeout(() => {if (flow !== current) return; epoch += 1; transport.cancel(current.owner.ctx); finish(current, 'expired', authError('ACCOUNT_EXPIRED', 'The sign-in request expired. Start again.')); if (!current.task) void cleanupFlow(current);}, flowLifetimeMs); current.timer.unref?.();
          if (input.method === 'github') {
            const data = result(await current.owner.sdk.signInWithOAuth({provider: 'github', options: {redirectTo: current.callback.redirectTo, skipBrowserRedirect: true}}), current.owner);
            const url = new URL(data?.url);
            if (url.origin !== config.origin || url.pathname !== '/auth/v1/authorize' || url.username || url.password || url.hash || url.searchParams.get('provider') !== 'github' || url.searchParams.get('redirect_to') !== current.callback.redirectTo || url.searchParams.get('code_challenge_method')?.toLowerCase() !== 's256') throw invalidResponse();
            if (!flowCurrent(current)) throw cancelled();
            let browserTimer;
            try {
              await Promise.race([
                Promise.resolve().then(() => openExternal(url.href)), current.completion,
                new Promise((_, reject) => {browserTimer = setTimeout(() => reject(Error('Browser timeout')), 15000); browserTimer.unref?.();}),
              ]);
            } catch {throw authError('ACCOUNT_BROWSER_UNAVAILABLE', 'The sign-in browser could not open. Try again.');}
            finally {clearTimeout(browserTimer);}
          } else result(await current.owner.sdk.signInWithOtp({email: current.email, options: {shouldCreateUser: true, emailRedirectTo: current.callback.redirectTo}}), current.owner);
          if (!flowCurrent(current)) {if (terminal?.requestId === current.requestId) return terminal; throw cancelled();}
          return pendingDTO(current);
        } catch (reason) {if (current) {if (flow === current) finish(current, 'failed', reason); await cleanupFlow(current);} throw normalize(reason);}
        finally {busy = null;}
      })());
    },
    async pollApplicationSignIn(input) {const requestId = inputId(input); if (flow?.requestId === requestId) return pendingDTO(flow); return terminal?.requestId === requestId ? terminal : {requestId, state: 'cancelled', error: cancelled().message};},
    verifyApplicationEmail(input) {
      guard(); if (!shape(input, ['requestId', 'token']) || typeof input.requestId !== 'string' || !UUID.test(input.requestId) || typeof input.token !== 'string' || !/^[0-9]{6,10}$/.test(input.token)) throw invalid();
      const current = flow;
      if (!current || current.requestId !== input.requestId || current.method !== 'email' || !flowCurrent(current)) throw authError('ACCOUNT_EXPIRED', 'The sign-in request expired. Start again.');
      return complete(current, () => current.owner.sdk.verifyOtp({email: current.email, token: input.token, type: 'email'}), true);
    },
    async cancelApplicationSignIn(input) {const requestId = inputId(input); if (flow?.requestId === requestId) return cancelFlow(); return terminal?.requestId === requestId ? terminal : {requestId, state: 'cancelled', error: cancelled().message};},
    async cancelPendingApplicationSignIn() {await cancelFlow(); await Promise.allSettled([...tasks]);},
    refreshApplicationAccount: refresh,
    updateApplicationProfile(input) {
      free(); if (!shape(input, ['displayName']) || !text(input.displayName, 80) || !input.displayName.trim()) throw invalid();
      busy = 'profile';
      return track((async () => {
        let owner, rotated = false, updated = false;
        try {
          await load(); if (storedError) throw storedError; if (!record) throw authError('ACCOUNT_REAUTH_REQUIRED', 'Sign in before editing your profile.'); await secure();
          const previous = record; owner = client(previous.session); let session = previous.session;
          if (session.expires_at * 1000 <= now() + 120000) {session = result(await owner.sdk.refreshSession({refresh_token: session.refresh_token}), owner)?.session; rotated = true; await publish(await verifySession(session, owner, previous.account.id));}
          updated = true; result(await owner.sdk.updateUser({data: {display_name: input.displayName.trim()}}), owner);
          // updateUser may refresh inside the SDK's own expiry margin. Capture
          // the latest volatile session before publishing our account record.
          session = result(await owner.sdk.getSession(), owner)?.session;
          await publish(await verifySession(session, owner, previous.account.id));
          return dto();
        } catch (reason) {
          const safe = normalize(reason); stateError = safe;
          if (updated) {status = 'offline'; notice = 'The profile may have changed online. Refresh the account to check the saved name.';}
          else if (rotated || safe.code === 'ACCOUNT_REAUTH_REQUIRED') status = 'expired';
          throw safe;
        } finally {await owner?.close(); busy = null;}
      })());
    },
    signOutApplicationAccount() {
      guard(); if (busy) throw authError('ACCOUNT_BUSY', 'Wait for the account request to finish before signing out.');
      busy = 'signout';
      return track((async () => {
        let owner, remoteFailed = false;
        try {
          await cancelFlow(); await load();
          // Clear the selected vault first: offline logout needs no decryption,
          // account lookup or refresh to become locally signed out.
          const previous = record;
          await vault.remove(); record = null; storedError = null; stateError = null; verified = false; status = 'signed-out'; notice = null;
          if (previous && previous.session.expires_at * 1000 > now() + 120000) {
            owner = client(previous.session);
            const reply = await owner.sdk.signOut({scope: 'local'});
            remoteFailed = Boolean(reply.error || owner.ctx.failure);
          } else remoteFailed = Boolean(previous);
          if (remoteFailed) notice = 'Signed out on this device. The service could not confirm remote session invalidation.';
          return dto();
        } catch (reason) {storedError = normalize(reason); throw storedError;}
        finally {await owner?.close(); busy = null;}
      })());
    },
    async request(method, args) {
      if (!applicationAccountMethods.has(method)) throw invalid();
      if (['getApplicationAccount', 'cancelPendingApplicationSignIn', 'refreshApplicationAccount', 'signOutApplicationAccount'].includes(method) && args !== undefined) throw invalid();
      return api[method](args);
    },
    async prepareClose() {paused = true; await cancelFlow(); await Promise.allSettled([...tasks]); await vault?.drain();},
    resume() {if (!closed) paused = false;},
    async close() {if (closed) return; paused = true; await cancelFlow(); await Promise.allSettled([...tasks]); await vault?.close(); closed = true; transport.cancelAll(); record = null; terminal = null; loadTask = null;},
  };
  return api;
}
