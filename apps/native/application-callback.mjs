import {createServer} from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {authError} from './application-transport.mjs';

const page = '<!doctype html><meta charset="utf-8"><title>asMagicBrain</title><p>Return to asMagicBrain to finish signing in. You may close this browser tab.</p>';
/** A one-shot loopback return. The callback code/state never reaches the renderer. */
export async function createApplicationCallback({onCode, onError}) {
  const state = randomBytes(32).toString('base64url');
  let consumed = false, closed = false, closeTask;
  const server = createServer({maxHeaderSize: 8192}, (request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const fail = status => {response.statusCode = status; response.end('This sign-in return was not accepted. Return to asMagicBrain.');};
    const address = server.address();
    if (closed || !address || request.method !== 'GET' || request.headers.host !== `127.0.0.1:${address.port}` || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) || !request.url?.startsWith('/') || request.url.length > 4096) {fail(400); return;}
    let url;
    try {url = new URL(request.url, `http://127.0.0.1:${address.port}`);} catch {fail(400); return;}
    const fields = [...url.searchParams.keys()], supplied = url.searchParams.get('app_state') ?? '';
    const accepted = new Set(['app_state', 'code', 'error', 'error_code', 'error_description']);
    if (url.origin !== `http://127.0.0.1:${address.port}` || url.pathname !== '/auth/callback' || url.hash || fields.some(key => !accepted.has(key)) || fields.length !== new Set(fields).size || !/^[A-Za-z0-9_-]{43}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(state))) {fail(400); return;}
    if (consumed) {fail(409); return;}
    const code = url.searchParams.get('code'), denied = url.searchParams.get('error');
    if ((code && denied) || (!denied && (typeof code !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(code)))) {fail(400); return;}
    consumed = true;
    response.statusCode = 200; response.end(page);
    // Provider error details deliberately remain unobserved and unlogged.
    if (denied) onError(authError('ACCOUNT_DECLINED', 'Sign-in did not finish. Start again when you are ready.'));
    else onCode(code);
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxConnections = 8;
  server.on('clientError', (_reason, socket) => {socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen({host: '127.0.0.1', port: 0, exclusive: true}, () => {server.removeListener('error', reject); resolve();});});
  server.on('error', () => onError(authError('ACCOUNT_CALLBACK_UNAVAILABLE', 'The local sign-in return is unavailable. Start again.')));
  server.unref();
  const address = server.address();
  return {
    redirectTo: `http://127.0.0.1:${address.port}/auth/callback?app_state=${state}`,
    close() {
      if (!closeTask) {closed = true; closeTask = new Promise(resolve => {server.close(() => resolve()); server.closeAllConnections();});}
      return closeTask;
    },
  };
}
