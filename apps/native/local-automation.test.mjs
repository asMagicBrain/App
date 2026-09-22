import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {Readable} from 'node:stream';
import {testRoot} from '../../tools/development-paths.mjs';
import {createLocalAutomation, readAutomationConnection, AUTOMATION_MESSAGE_LIMIT} from './local-automation.mjs';
import {sendAutomationRequest, runCli} from './automation-cli.mjs';
import {AUTOMATION_LIMITS} from './automation-limits.mjs';
const request = (requestId = 'test-1', extra = {}) => ({protocolVersion: 1, requestId, operation: 'repo.list', args: {}, ...extra});
async function fixture(t, handleRequest = async input => ({operation: input.operation}), options = {}) {
  await fs.mkdir(testRoot, {recursive: true}); const directory = await fs.mkdtemp(path.join(await fs.realpath(testRoot), 'ipc-'));
  await fs.chmod(directory, 0o700); const host = createLocalAutomation({directory, handleRequest, ...options}); const {connectionFile} = await host.start();
  t.after(async () => {await host.stop(); await fs.rm(directory, {recursive: true, force: true});});
  return {directory, host, connectionFile, descriptor: JSON.parse(await fs.readFile(connectionFile))};
}
async function raw(endpoint, value) {
  return new Promise((resolve, reject) => {const socket = net.createConnection(endpoint); let chunks = []; socket.on('error', reject); socket.on('connect', () => socket.write(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value) + '\n')); socket.on('data', chunk => chunks.push(chunk)); socket.on('end', () => {socket.destroy(); try {resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));} catch (error) {reject(error);}});});
}
const invokeCli = async (args, input = '') => {let output = ''; const code = await runCli(args, {stdin: Readable.from([input]), stdout: {write(value) {output += value;}}}); return {code, output, reply: JSON.parse(output)};};
test('private same-user endpoint authenticates one versioned request and strips token from service', async t => {
  let received; const f = await fixture(t, async input => {received = input; return {repositories: ['Granted']};});
  assert.equal((await fs.stat(f.directory)).mode & 0o7777, 0o700); assert.equal((await fs.stat(f.connectionFile)).mode & 0o7777, 0o600);
  assert.equal((await fs.stat(f.descriptor.endpoint)).mode & 0o7777, 0o600); assert.ok(!f.descriptor.endpoint.startsWith('http'));
  const reply = await sendAutomationRequest({connectionFile: f.connectionFile, request: request()});
  assert.deepEqual(received, {requestId: 'test-1', operation: 'repo.list', args: {}}); assert.deepEqual(reply, {protocolVersion: 1, requestId: 'test-1', ok: true, value: {repositories: ['Granted']}});
  assert.ok(!JSON.stringify(reply).includes(f.descriptor.token)); await f.host.stop();
  assert.equal(await fs.lstat(f.connectionFile).then(() => true, () => false), false); assert.equal(await fs.lstat(f.descriptor.endpoint).then(() => true, () => false), false);
});
test('wrong or missing token, protocol versions, extra envelope fields and malformed frames never reach service', async t => {
  let calls = 0; const f = await fixture(t, async () => {calls++; return true;});
  for (const token of [undefined, 'wrong', 'x'.repeat(43)]) {
    const result = await raw(f.descriptor.endpoint, {...request(), token}); assert.equal(result.error.code, 'PERMISSION_DENIED'); assert.ok(!JSON.stringify(result).includes(f.descriptor.token));
  }
  for (const [change, code] of [[{protocolVersion: 2}, 'UNSUPPORTED_VERSION'], [{requestId: '../bad'}, 'INVALID_REQUEST'], [{operation: 'unknown/op'}, 'INVALID_REQUEST'], [{privateRoot: '/home/secret'}, 'INVALID_REQUEST'], [{args: null}, 'INVALID_REQUEST']]) {
    const result = await raw(f.descriptor.endpoint, {...request(), token: f.descriptor.token, ...change}); assert.equal(result.error.code, code);
  }
  for (const value of ['bad-json\n', '{}\n{}\n']) assert.equal((await raw(f.descriptor.endpoint, value)).error.code, 'INVALID_REQUEST');
  const invalidUtf8 = Buffer.concat([Buffer.from('{"bad":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}\n')]);
  assert.equal((await raw(f.descriptor.endpoint, invalidUtf8)).error.code, 'INVALID_REQUEST');
  assert.equal(calls, 0);
});
test('request and response byte limits fail without exposing input or private exception', async t => {
  let calls = 0; const f = await fixture(t, async input => {calls++; if (input.operation === 'large') return 'x'.repeat(AUTOMATION_MESSAGE_LIMIT); throw Object.assign(Error('/private/password'), {code: 'CONFLICT'});});
  const large = await raw(f.descriptor.endpoint, 'x'.repeat(AUTOMATION_MESSAGE_LIMIT + 1) + '\n'); assert.equal(large.error.code, 'LIMIT_EXCEEDED'); assert.equal(calls, 0);
  let result = await sendAutomationRequest({connectionFile: f.connectionFile, request: request('response-large', {operation: 'large'})}); assert.equal(result.error.code, 'LIMIT_EXCEEDED');
  result = await sendAutomationRequest({connectionFile: f.connectionFile, request: request('failure')}); assert.equal(result.error.code, 'CONFLICT'); assert.ok(!JSON.stringify(result).includes('/private'));
});
test('permissions, symlinks and connection tampering refuse before client transmission', async t => {
  const f = await fixture(t); await fs.chmod(f.connectionFile, 0o644);
  await assert.rejects(readAutomationConnection(f.connectionFile), {code: 'PERMISSION_DENIED'}); await fs.chmod(f.connectionFile, 0o600);
  const link = path.join(f.directory, 'alias.json'); await fs.symlink(f.connectionFile, link); await assert.rejects(readAutomationConnection(link), {code: 'PERMISSION_DENIED'});
  await fs.chmod(f.directory, 0o755); await assert.rejects(readAutomationConnection(f.connectionFile), {code: 'PERMISSION_DENIED'}); await fs.chmod(f.directory, 0o700);
  const external = {...f.descriptor, endpoint: '/tmp/unrelated.sock'}; await fs.writeFile(f.connectionFile, JSON.stringify(external)); await assert.rejects(readAutomationConnection(f.connectionFile), {code: 'INVALID_CONNECTION'});
  await fs.writeFile(f.connectionFile, JSON.stringify(f.descriptor));
});
test('revocation rejects admission, drains already admitted work and removes only own descriptor', async t => {
  let entered, finish; const began = new Promise(resolve => {entered = resolve;}), held = new Promise(resolve => {finish = resolve;});
  const f = await fixture(t, async () => {entered(); await held; return {completed: true};});
  const unknown = path.join(f.directory, 'unrelated.json'); await fs.writeFile(unknown, 'keep', {mode: 0o600});
  const pending = sendAutomationRequest({connectionFile: f.connectionFile, request: request('drain')}); await began;
  let stopped = false; const close = f.host.stop().then(() => {stopped = true;}); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(stopped, false);
  await assert.rejects(sendAutomationRequest({connectionFile: f.connectionFile, request: request('revoked')})); finish();
  assert.equal((await pending).ok, true); await close; assert.equal(await fs.readFile(unknown, 'utf8'), 'keep'); await assert.rejects(f.host.start(), {code: 'CONNECTION_CLOSED'});
});
test('CLI JSON stdin/file, correlation and timeout preserve request ID without automatic retry', async t => {
  let calls = 0; const f = await fixture(t, async input => {calls++; if (input.requestId === 'slow') await new Promise(resolve => setTimeout(resolve, 80)); return {saved: true};});
  const args = ['--connection', f.connectionFile]; let result = await invokeCli(args, JSON.stringify(request('stdin'))); assert.equal(result.code, 0); assert.equal(result.reply.requestId, 'stdin');
  const file = path.join(f.directory, 'request.json'); await fs.writeFile(file, JSON.stringify(request('file')));
  result = await invokeCli([...args, '--request', file]); assert.equal(result.code, 0); assert.equal(result.reply.requestId, 'file');
  result = await invokeCli([...args, '--timeout-ms', '10'], JSON.stringify(request('slow'))); assert.equal(result.code, 1); assert.equal(result.reply.error.code, 'TIMEOUT'); assert.equal(result.reply.requestId, 'slow');
  assert.ok(!result.output.includes(f.descriptor.token)); await f.host.drain(); assert.equal(calls, 3, 'No timeout retry');
  result = await invokeCli(args, JSON.stringify(request('unsupported', {protocolVersion: 99}))); assert.equal(result.reply.error.code, 'UNSUPPORTED_VERSION'); assert.equal(result.reply.requestId, 'unsupported');
});
test('new session token rejects prior descriptor token; transport has no persisted grant itself', async t => {
  const first = await fixture(t), old = first.descriptor.token; await first.host.stop();
  const next = createLocalAutomation({directory: first.directory, handleRequest: async () => true}); const current = await next.start(); t.after(() => next.stop());
  const descriptor = JSON.parse(await fs.readFile(current.connectionFile)); assert.notEqual(descriptor.token, old);
  const denied = await raw(descriptor.endpoint, {...request(), token: old}); assert.equal(denied.error.code, 'PERMISSION_DENIED');
});

test('partial requests expire without service admission and stop drains an idle client', async t => {
  let calls = 0; const f = await fixture(t, async () => {calls++;}, {readTimeoutMs: 30});
  await new Promise((resolve, reject) => {const socket = net.createConnection(f.descriptor.endpoint); socket.once('error', reject); socket.once('connect', () => socket.write('{"requestId":"unfinished"')); socket.once('close', resolve);});
  assert.equal(calls, 0);
  const idle = net.createConnection(f.descriptor.endpoint); idle.on('error', () => {}); await new Promise(resolve => idle.once('connect', resolve));
  await f.host.stop(); assert.equal(calls, 0); idle.destroy();
});

test('only completed export receipts use the larger outbound frame; request and ordinary response limits stay fixed',async t=>{
  const payload='A'.repeat(1400000);
  const f=await fixture(t,async input=>({kind:input.args.kind??'export.plan',status:input.args.status??'completed',result:{archiveBase64:input.args.oversized?'A'.repeat(AUTOMATION_LIMITS.responseBytes):payload}}));
  for(const operation of ['status','export.plan']){
    const response=await invokeCli(['--connection',f.connectionFile],JSON.stringify(request(`large-${operation.replace('.','-')}`,{operation,args:{}})));
    assert.equal(response.code,0);assert.equal(response.reply.value.result.archiveBase64,payload);
  }
  for(const args of [{kind:'write.plan'},{status:'review'},{oversized:true}]){const response=await sendAutomationRequest({connectionFile:f.connectionFile,request:request('denied-frame',{operation:'status',args})});assert.equal(response.error.code,'LIMIT_EXCEEDED');}
  await assert.rejects(sendAutomationRequest({connectionFile:f.connectionFile,request:request('large-input',{operation:'export.plan',args:{data:'x'.repeat(AUTOMATION_MESSAGE_LIMIT)}})}),{code:'LIMIT_EXCEEDED'});
});
