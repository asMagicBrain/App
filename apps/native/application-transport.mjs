/** Restricted transport shared by the official Auth SDK clients. No provider text escapes. */
export class ApplicationAuthError extends Error {
  constructor(code, message) {super(message); this.name = 'ApplicationAuthError'; this.code = code;}
}
export const authError = (code, message) => new ApplicationAuthError(code, message);
export const cancelled = () => authError('ACCOUNT_CANCELLED', 'Sign-in was cancelled.');
export const unavailable = () => authError('ACCOUNT_UNAVAILABLE', 'The account service is unavailable. Check your connection and try again.');
const MAX_BODY = 128 * 1024;
const allowed = new Map([['/auth/v1/token', ['POST']], ['/auth/v1/user', ['GET', 'PUT']], ['/auth/v1/otp', ['POST']], ['/auth/v1/verify', ['POST']], ['/auth/v1/logout', ['POST']]]);

export function createAuthTransport({origin, fetch: fetcher = globalThis.fetch, timeoutMs = 15000}) {
  const contexts = new Set();
  function context() {
    const current = {cancelled: false, failure: null, controllers: new Set()};
    contexts.add(current);
    return current;
  }
  function cancel(current) {current.cancelled = true; for (const controller of current.controllers) controller.abort();}
  function release(current) {contexts.delete(current);}
  function forContext(current) {
    return async (input, init = {}) => {
      const reject = reason => {
        current.failure = reason;
        // AuthApiError suppresses SDK refresh retry loops. The host classifies
        // this fixed, private error from the context instead of provider text.
        return new Response(JSON.stringify({message: 'Account request did not finish.', code: 'asmb_request_failed'}), {status: 400, headers: {'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01'}});
      };
      if (current.cancelled) return reject(cancelled());
      let url;
      try {url = new URL(input);} catch {return reject(authError('ACCOUNT_INVALID_RESPONSE', 'The account service returned an invalid response.'));}
      if (url.origin !== origin || url.username || url.password || url.hash || !allowed.get(url.pathname)?.includes(init.method ?? 'GET')) return reject(authError('ACCOUNT_INVALID_RESPONSE', 'The account service returned an invalid response.'));
      const controller = new AbortController(); current.controllers.add(controller);
      let timer, timedOut = false, reader, responseBody;
      const interruption = new Promise((_, rejectPromise) => {
        controller.signal.addEventListener('abort', () => {void reader?.cancel().catch(() => {}); rejectPromise(current.cancelled ? cancelled() : authError('ACCOUNT_TIMEOUT', 'The account service did not respond in time. Try again.'));}, {once: true});
        timer = setTimeout(() => {timedOut = true; controller.abort();}, timeoutMs); timer.unref?.();
      });
      try {
        const request = (async () => {
          const response = await fetcher(url.href, {...init, redirect: 'error', signal: controller.signal});
          responseBody = response.body;
          if (controller.signal.aborted) {void response.body?.cancel().catch(() => {}); throw current.cancelled ? cancelled() : unavailable();}
          if (response.url && response.url !== url.href) throw authError('ACCOUNT_INVALID_RESPONSE', 'The account service returned an invalid response.');
          if (Number(response.headers?.get('content-length')) > MAX_BODY) throw authError('ACCOUNT_INVALID_RESPONSE', 'The account service returned an oversized response.');
          const chunks = []; let size = 0;
          if (response.body) {
            reader = response.body.getReader();
            while (true) {const {done, value} = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BODY) throw authError('ACCOUNT_INVALID_RESPONSE', 'The account service returned an oversized response.'); chunks.push(Buffer.from(value));}
          }
          if (current.cancelled) throw cancelled();
          if (!response.ok) {
            const reason = response.status >= 500 ? unavailable() : response.status === 429 ? authError('ACCOUNT_RATE_LIMITED', 'Too many attempts. Wait before trying again.') : authError('ACCOUNT_REAUTH_REQUIRED', 'The account request was not accepted. Check the sign-in link or code and try again.');
            return reject(reason);
          }
          // Error payloads never reach SDK logging; success data stays host-only.
          const body = Buffer.concat(chunks);
          if (response.status !== 204) {try {const json = JSON.parse(body.toString('utf8')); if (!json || typeof json !== 'object' || Array.isArray(json)) throw Error();} catch {throw authError('ACCOUNT_INVALID_RESPONSE', 'The account service returned an invalid response.');}}
          return new Response(response.status === 204 ? null : body, {status: response.status, headers: {'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01'}});
        })();
        return await Promise.race([request, interruption]);
      } catch (reason) {
        return reject(current.cancelled ? cancelled() : timedOut ? authError('ACCOUNT_TIMEOUT', 'The account service did not respond in time. Try again.') : reason instanceof ApplicationAuthError ? reason : unavailable());
      } finally {clearTimeout(timer); current.controllers.delete(controller); if (reader) void reader.cancel().catch(() => {}); else if (responseBody && !responseBody.locked) void responseBody.cancel().catch(() => {});}
    };
  }
  return {context, cancel, release, forContext, cancelAll: () => {for (const current of contexts) cancel(current);}};
}
