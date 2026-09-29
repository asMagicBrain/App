import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Readable, Writable} from 'node:stream';
import {testRoot} from '../../tools/development-paths.mjs';
import {createLocalAutomation} from './local-automation.mjs';
import {runCli} from './automation-cli.mjs';

const request = {protocolVersion: 1, requestId: 'large-output', operation: 'status', args: {}};
const archiveBase64 = Buffer.alloc(1024 * 1024, 37).toString('base64');
const receipt = {kind: 'export.plan', status: 'completed', result: {archiveBase64}};
async function fixture(t) {
  await fs.mkdir(testRoot, {recursive: true});
  const directory = await fs.mkdtemp(path.join(await fs.realpath(testRoot), 'out-'));
  await fs.chmod(directory, 0o700);
  let calls = 0;
  const host = createLocalAutomation({directory, handleRequest: async () => {calls++; return receipt;}});
  const {connectionFile} = await host.start();
  const requestFile = path.join(directory, 'request.json'); await fs.writeFile(requestFile, JSON.stringify(request));
  t.after(async () => {await host.stop(); await fs.rm(directory, {recursive: true, force: true});});
  return {connectionFile, requestFile, calls: () => calls};
}

async function heldOutput(args, input) {
  let release, entered;
  const began = new Promise(resolve => {entered = resolve;});
  let captured = '', finished = false;
  const stdout = new Writable({highWaterMark: 1, write(bytes, _encoding, callback) {captured += bytes; release = callback; entered();}});
  const pending = runCli(args, {stdin: Readable.from([input]), stdout}).then(code => {finished = true; return code;});
  await began; await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false, 'runCli must remain pending until the actual write callback');
  assert.equal(stdout.writableNeedDrain, true, 'exercise a backpressured Writable');
  release(); const code = await pending;
  return {captured, code};
}

test('CLI awaits backpressured help and request-error output', async () => {
  const help = await heldOutput(['--help'], ''); assert.equal(help.code, 0); assert.match(help.captured, /--automation-cli/);
  const error = await heldOutput([], ''); assert.equal(error.code, 1); assert.equal(JSON.parse(error.captured).error.code, 'INVALID_ARGUMENT');
});

test('CLI awaits backpressured large success output without retransmitting the request', async t => {
  const f = await fixture(t);
  const result = await heldOutput(['--connection', f.connectionFile], JSON.stringify(request));
  assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.captured).value, receipt); assert.equal(f.calls(), 1);
});

test('CLI broken output returns failure once without appending a second JSON reply', async t => {
  const f = await fixture(t);
  for (const args of [['--help'], [], ['--connection', f.connectionFile]]) {
    let writes = 0;
    const stdout = new Writable({write(_bytes, _encoding, done) {writes++; done(Object.assign(Error('closed output'), {code: 'EPIPE'}));}});
    assert.equal(await runCli(args, {stdin: Readable.from([JSON.stringify(request)]), stdout}), 1);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(writes, 1);
  }
  assert.equal(f.calls(), 1, 'output failure never retries the request');
});

function child(f, {breakPipe = false} = {}) {
  // This is the exact immediate-exit lifetime used by the Electron CLI entry.
  const source = `import {runCli} from ${JSON.stringify(new URL('./automation-cli.mjs', import.meta.url).href)}; process.exit(await runCli(process.argv.slice(1)));`;
  const env = {...process.env}; for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_SANDBOX']) delete env[key];
  const processChild = spawn(process.execPath, ['--input-type=module', '-e', source, '--', '--connection', f.connectionFile, '--request', f.requestFile], {env, stdio: ['ignore', 'pipe', 'pipe']});
  return new Promise((resolve, reject) => {
    const chunks = []; let stderr = '';
    const deadline = setTimeout(() => {processChild.kill('SIGTERM'); reject(Error('CLI child did not close'));}, 15000);
    processChild.once('error', reject);
    processChild.stderr.on('data', bytes => {stderr += bytes;});
    if (breakPipe) processChild.stdout.once('data', () => processChild.stdout.destroy());
    else {
      processChild.stdout.pause();
      processChild.stdout.on('data', bytes => chunks.push(bytes));
      setTimeout(() => processChild.stdout.resume(), 100);
    }
    processChild.once('close', (code, signal) => {clearTimeout(deadline); resolve({code, signal, bytes: Buffer.concat(chunks), stderr});});
  });
}

test('immediate-exit CLI child flushes a complete >1 MiB JSON frame into a delayed reader pipe', async t => {
  const f = await fixture(t), result = await child(f);
  assert.equal(result.code, 0); assert.equal(result.signal, null); assert.equal(result.stderr, '');
  assert.ok(result.bytes.length > 1024 * 1024);
  assert.deepEqual(JSON.parse(result.bytes.toString('utf8')), {protocolVersion: 1, requestId: request.requestId, ok: true, value: receipt});
  assert.equal(result.bytes.at(-1), 10); assert.equal(result.bytes.toString('utf8').split('\n').length, 2); assert.equal(f.calls(), 1);
});

test('immediate-exit CLI child handles a real broken output pipe without uncaught errors or retries', async t => {
  const f = await fixture(t), result = await child(f, {breakPipe: true});
  assert.equal(result.code, 1); assert.equal(result.signal, null); assert.equal(result.stderr, ''); assert.equal(f.calls(), 1);
});
