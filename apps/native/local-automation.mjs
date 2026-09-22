/** Authenticated, same-user, OS-local transport only. The dispatcher owns grants,
 * reviewed plans, idempotency and all filesystem service authority. */
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {AUTOMATION_LIMITS,automationResponseLimit} from './automation-limits.mjs';
export const AUTOMATION_PROTOCOL_VERSION = 1;
export const AUTOMATION_MESSAGE_LIMIT = AUTOMATION_LIMITS.requestBytes;
const failure = (code, message) => Object.assign(new Error(message), {code});
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const shape = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const requestId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const uid = () => {if (typeof process.getuid !== 'function') throw failure('UNSUPPORTED_PLATFORM', 'Local automation requires a supported Unix desktop.'); return process.getuid();};
const envelope = (id, value) => ({protocolVersion: AUTOMATION_PROTOCOL_VERSION, requestId: requestId(id) ? id : null, ...value});
const errorReply = (id, code, message) => envelope(id, {ok: false, error: {code, message}});
const canonical = value => path.resolve(value);
const safeServiceError = error => {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'OPERATION_FAILED';
  // Only the dispatcher can intentionally supply a public message. Arbitrary
  // exceptions can contain private paths or bytes and do not cross this boundary.
  const message = error?.publicMessage && typeof error.publicMessage === 'string' && error.publicMessage.length <= 512 ? error.publicMessage : 'The operation could not be completed.';
  return {code, message};
};
async function privateDirectory(directory, create = false) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw failure('INVALID_CONNECTION', 'Choose a physical private runtime directory.');
  const full = canonical(directory); if (create) await fs.mkdir(full, {recursive: true, mode: 0o700});
  const st = await fs.lstat(full);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid() || (st.mode & 0o7777) !== 0o700 || await fs.realpath(full) !== full) throw failure('PERMISSION_DENIED', 'The runtime directory is not private and owned by this user.');
  return {full, identity: {dev: st.dev, ino: st.ino}};
}
async function privateFile(file) {
  const full = canonical(file), parent = await privateDirectory(path.dirname(full));
  const st = await fs.lstat(full);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== uid() || (st.mode & 0o7777) !== 0o600 || st.size > 4096 || await fs.realpath(full) !== full) throw failure('PERMISSION_DENIED', 'The connection file is not private and owned by this user.');
  const handle = await fs.open(full, 'r');
  try {const opened = await handle.stat(); if (opened.dev !== st.dev || opened.ino !== st.ino) throw failure('CONNECTION_CHANGED', 'The connection changed. Request a new connection.'); return {full, parent, text: await handle.readFile('utf8')};} finally {await handle.close();}
}
export async function readAutomationConnection(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw failure('INVALID_CONNECTION', 'An absolute connection file is required.');
  const checked = await privateFile(file); let value;
  try {value = JSON.parse(checked.text);} catch {throw failure('INVALID_CONNECTION', 'The connection file is invalid.');}
  if (!shape(value, ['protocolVersion', 'endpoint', 'token', 'sessionId', 'createdAt']) || value.protocolVersion !== AUTOMATION_PROTOCOL_VERSION ||
    typeof value.endpoint !== 'string' || path.dirname(value.endpoint) !== checked.parent.full || !/^[a-z0-9-]+\.sock$/.test(path.basename(value.endpoint)) ||
    typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || typeof value.sessionId !== 'string' || !/^[a-f0-9]{16}$/.test(value.sessionId)) throw failure('INVALID_CONNECTION', 'The connection file is invalid or unsupported.');
  const st = await fs.lstat(value.endpoint);
  if (!st.isSocket() || st.uid !== uid() || (st.mode & 0o7777) !== 0o600) throw failure('PERMISSION_DENIED', 'The local endpoint is not private and owned by this user.');
  return value;
}
export function validateAutomationRequest(request) {
  if (!shape(request, ['protocolVersion', 'requestId', 'operation', 'args']) || !requestId(request.requestId) || typeof request.operation !== 'string' || !/^[a-z][a-z0-9.]{0,63}$/.test(request.operation) || !object(request.args)) throw failure('INVALID_REQUEST', 'Use a request ID, operation and object args.');
  if (request.protocolVersion !== AUTOMATION_PROTOCOL_VERSION) throw failure('UNSUPPORTED_VERSION', 'This automation protocol version is unsupported.');
  return request;
}
export function createLocalAutomation({directory, handleRequest, readTimeoutMs = 5000}) {
  if (typeof handleRequest !== 'function') throw TypeError('handleRequest is required');
  let server, descriptor, endpoint, directoryIdentity, token, started = false, accepting = false, stopped = false, stopPromise;
  const sockets = new Set(), executing = new Set(), tasks = new Set();
  async function sameDirectory() {const value = await privateDirectory(directory); if (value.identity.dev !== directoryIdentity.dev || value.identity.ino !== directoryIdentity.ino) throw failure('CONNECTION_CHANGED', 'The runtime directory changed.');}
  async function start() {
    if (started || stopped) throw failure('CONNECTION_CLOSED', 'Create a new automation connection.');
    const checked = await privateDirectory(directory, true); directory = checked.full; directoryIdentity = checked.identity;
    const sessionId = randomBytes(8).toString('hex'); token = randomBytes(32).toString('base64url');
    endpoint = path.join(directory, `a-${sessionId}.sock`); descriptor = path.join(directory, `a-${sessionId}.json`);
    if (Buffer.byteLength(endpoint) > 103) throw failure('IPC_PATH_TOO_LONG', 'Use a shorter private runtime directory.');
    server = net.createServer({allowHalfOpen: true}, socket => {
      if (!accepting || sockets.size >= 16) {socket.destroy(); return;}
      sockets.add(socket); let chunks = [], bytes = 0, admitted = false;
      const timer = setTimeout(() => socket.destroy(), readTimeoutMs);
      socket.on('error', () => {}); socket.once('close', () => {clearTimeout(timer); sockets.delete(socket);});
      const send = reply => {if (socket.destroyed) return; let data; try {data = JSON.stringify(reply) + '\n';} catch {data = JSON.stringify(errorReply(reply.requestId, 'INVALID_RESPONSE', 'The service returned an invalid response.')) + '\n';}
        if (Buffer.byteLength(data) > automationResponseLimit(reply)) data = JSON.stringify(errorReply(reply.requestId, 'LIMIT_EXCEEDED', 'The response exceeds the supported byte limit.')) + '\n'; socket.end(data);};
      socket.on('data', chunk => {
        if (admitted) {socket.destroy(); return;}
        bytes += chunk.length; if (bytes > AUTOMATION_MESSAGE_LIMIT) {clearTimeout(timer); admitted = true; send(errorReply(null, 'LIMIT_EXCEEDED', 'The request exceeds the supported byte limit.')); return;}
        chunks.push(chunk); if (!chunk.includes(10)) return;
        clearTimeout(timer); admitted = true;
        const work = (async () => {
          let input, id = null;
          try {
            const data = Buffer.concat(chunks); chunks = []; const newline = data.indexOf(10);
            if (newline !== data.length - 1) throw failure('INVALID_REQUEST', 'Send exactly one JSON line per connection.');
            input = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(data.subarray(0, newline))); id = requestId(input?.requestId) ? input.requestId : null;
            const offered = typeof input?.token === 'string' ? Buffer.from(input.token) : Buffer.alloc(0), expected = Buffer.from(token);
            if (!accepting || offered.length !== expected.length || !timingSafeEqual(offered, expected)) {send(errorReply(id, 'PERMISSION_DENIED', 'This connection is unavailable or unauthorized.')); return;}
            if (!shape(input, ['protocolVersion', 'requestId', 'operation', 'args', 'token'])) throw failure('INVALID_REQUEST', 'The request has unsupported fields.');
            const {token: _secret, ...request} = input; validateAutomationRequest(request); await sameDirectory();
            if (!accepting) {send(errorReply(id, 'PERMISSION_DENIED', 'This connection is unavailable or unauthorized.')); return;}
            if (executing.size >= 8) {send(errorReply(id, 'BUSY', 'Too many automation operations are active.')); return;}
            executing.add(socket);
            try {send(envelope(id, {ok: true, value: await handleRequest({requestId: request.requestId, operation: request.operation, args: request.args})}));}
            catch (error) {const safe = safeServiceError(error); send(errorReply(id, safe.code, safe.message));}
            finally {executing.delete(socket);}
          } catch (error) {const code = error?.code === 'UNSUPPORTED_VERSION' ? 'UNSUPPORTED_VERSION' : error?.code === 'CONNECTION_CHANGED' || error?.code === 'PERMISSION_DENIED' ? 'PERMISSION_DENIED' : 'INVALID_REQUEST'; send(errorReply(id, code, 'The request is invalid, unavailable or unsupported.'));}
        })(); tasks.add(work); work.finally(() => tasks.delete(work));
      });
      socket.once('end', () => {if (!admitted) socket.destroy();});
    });
    try {
      await new Promise((resolve, reject) => {server.once('error', reject); server.listen(endpoint, resolve);});
      await sameDirectory(); await fs.chmod(endpoint, 0o600);
      await fs.writeFile(descriptor, JSON.stringify({protocolVersion: AUTOMATION_PROTOCOL_VERSION, endpoint, token, sessionId, createdAt: new Date().toISOString()}) + '\n', {flag: 'wx', mode: 0o600});
      started = true; accepting = true; return {connectionFile: descriptor};
    } catch (error) {await stop(); throw error;}
  }
  function stop() {
    if (stopPromise) return stopPromise; stopped = true; accepting = false;
    stopPromise = (async () => {
      const closed = server ? new Promise(resolve => {try {server.close(resolve);} catch {resolve();}}) : Promise.resolve();
      for (const socket of sockets) if (!executing.has(socket)) socket.destroy();
      while (tasks.size) await Promise.allSettled([...tasks]);
      for (const socket of sockets) socket.destroy(); await closed;
      // Only this unique session's descriptor is removed. Unknown old files or
      // endpoints are never reclaimed as part of starting a new session.
      if (descriptor && directoryIdentity) {try {await sameDirectory(); const info = await privateFile(descriptor); const record = JSON.parse(info.text); if (record.token === token && record.endpoint === endpoint) await fs.unlink(descriptor);} catch {}}
      token = null;
    })(); return stopPromise;
  }
  return Object.freeze({start, stop, drain: async () => {while (tasks.size) await Promise.allSettled([...tasks]);}});
}
