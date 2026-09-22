/** Standalone Node module and explicit Electron --automation-cli entry. It is a
 * client only: no profile, service, filesystem writer or second host is opened. */
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AUTOMATION_PROTOCOL_VERSION, AUTOMATION_MESSAGE_LIMIT, readAutomationConnection, validateAutomationRequest} from './local-automation.mjs';
import {AUTOMATION_LIMITS,automationResponseLimit} from './automation-limits.mjs';
const failure = (code, message) => Object.assign(new Error(message), {code});
const errorReply = (requestId, error) => ({protocolVersion: AUTOMATION_PROTOCOL_VERSION, requestId, ok: false, error: {code: /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code ?? '') ? error.code : 'CONNECTION_UNAVAILABLE', message: error?.publicMessage ?? 'The request was not confirmed. Check operation status using the same request ID before retrying.'}});
export async function sendAutomationRequest({connectionFile, request, timeoutMs = 30000}) {
  validateAutomationRequest(request);
  const connection = await readAutomationConnection(connectionFile), data = JSON.stringify({...request, token: connection.token}) + '\n';
  if (Buffer.byteLength(data) > AUTOMATION_MESSAGE_LIMIT) throw failure('LIMIT_EXCEEDED', 'The request exceeds the supported byte limit.');
  return new Promise((resolve, reject) => {
    let settled = false, bytes = 0, chunks = [];
    const socket = net.createConnection(connection.endpoint);
    const finish = (error, value) => {if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value);};
    const timer = setTimeout(() => finish(failure('TIMEOUT', 'The request was not confirmed.')), timeoutMs);
    socket.once('error', () => finish(failure('CONNECTION_UNAVAILABLE', 'The connection is unavailable.')));
    socket.once('connect', () => socket.write(data));
    socket.on('data', chunk => {bytes += chunk.length; if (bytes > AUTOMATION_LIMITS.responseBytes) {finish(failure('LIMIT_EXCEEDED', 'The response exceeds the supported byte limit.')); return;}
      chunks.push(chunk); if (!chunk.includes(10)) return;
      try {const bytes = Buffer.concat(chunks), newline = bytes.indexOf(10); if (newline !== bytes.length - 1) throw Error(); const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, newline)));
        if (value.protocolVersion !== AUTOMATION_PROTOCOL_VERSION || value.requestId !== request.requestId || typeof value.ok !== 'boolean' || value.ok === false && (typeof value.error?.code !== 'string' || typeof value.error?.message !== 'string')) throw Error();
        if(bytes.length>automationResponseLimit(value)){finish(failure('LIMIT_EXCEEDED','The response exceeds the supported byte limit.'));return;}
        finish(null, value);
      } catch {finish(failure('INVALID_RESPONSE', 'The response could not be verified.'));}
    });
    socket.once('end', () => {if (!settled) finish(failure('INCOMPLETE_RESPONSE', 'The request was not confirmed.'));});
  });
}
async function inputBytes(input) {const chunks = []; let size = 0; for await (const chunk of input) {const value = Buffer.from(chunk); size += value.length; if (size > AUTOMATION_MESSAGE_LIMIT) throw failure('LIMIT_EXCEEDED', 'The request exceeds the supported byte limit.'); chunks.push(value);} return Buffer.concat(chunks);}
export async function runCli(args, {stdin = process.stdin, stdout = process.stdout} = {}) {
  let id = null;
  try {
    if (args.includes('--help')) {stdout.write('asMagicBrain --automation-cli --connection /absolute/connection.json [--request /absolute/request.json]\nWithout --request, read one JSON request from standard input. No automatic retries.\n'); return 0;}
    const values = {};
    for (let index = 0; index < args.length; index += 2) {const key = args[index], value = args[index + 1]; if (!['--connection', '--request', '--timeout-ms'].includes(key) || !value || values[key] !== undefined) throw failure('INVALID_ARGUMENT', 'Use --connection and optional --request/--timeout-ms.'); values[key] = value;}
    if (!values['--connection'] || !path.isAbsolute(values['--connection'])) throw failure('INVALID_ARGUMENT', 'An absolute connection file is required.');
    let bytes;
    if (values['--request']) {const st = await fs.stat(values['--request']); if (!st.isFile() || st.size > AUTOMATION_MESSAGE_LIMIT) throw failure('LIMIT_EXCEEDED', 'Use a bounded request file.'); bytes = await fs.readFile(values['--request']); if (bytes.length > AUTOMATION_MESSAGE_LIMIT) throw failure('LIMIT_EXCEEDED', 'Use a bounded request file.');}
    else bytes = await inputBytes(stdin);
    let request; try {request = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));} catch {throw failure('INVALID_REQUEST', 'Use a valid UTF-8 JSON request.');} if (typeof request?.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(request.requestId)) id = request.requestId;
    const timeoutMs = values['--timeout-ms'] ? Number(values['--timeout-ms']) : 30000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 300000) throw failure('INVALID_ARGUMENT', 'Timeout must be between 10 and 300000 ms.');
    const reply = await sendAutomationRequest({connectionFile: values['--connection'], request, timeoutMs}); stdout.write(JSON.stringify(reply) + '\n'); return reply.ok ? 0 : 1;
  } catch (error) {stdout.write(JSON.stringify(errorReply(id, error)) + '\n'); return 1;}
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runCli(process.argv.slice(2));
