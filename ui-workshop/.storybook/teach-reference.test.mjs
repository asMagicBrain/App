import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { testRoot } from '../../tools/development-paths.mjs';
import { createTeachReferenceHandler } from './static-server.mjs';

const prefix = '/__asteach-reference';
const invoke = async (handler, url, { method = 'GET', headers = {} } = {}) => {
  const result = {};
  await handler({ url, method, headers: { host: '127.0.0.1:6006', ...headers } }, {
    writeHead(status, responseHeaders) { result.status = status; result.headers = responseHeaders; },
    end(body) { result.body = body; },
    destroy() { result.destroyed = true; },
  });
  return result;
};

test('external reference is opt-in, same-origin, bounded and read-only', async () => {
  await mkdir(path.join(testRoot, 'runs'), { recursive: true });
  const campaign = await mkdtemp(path.join(testRoot, 'runs', 'teach-reference-handler-'));
  const root = path.join(campaign, 'fixture');
  await mkdir(path.join(root, 'assets'), { recursive: true });
  const source = '{"schemaVersion":1,"label":"Synthetic","courses":[]}\n';
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile(path.join(root, 'fixture.json'), source);
  await writeFile(path.join(root, 'assets', 'calendar.png'), image);
  await writeFile(path.join(root, 'private.md'), 'Never exposed by this route.');
  await symlink(path.join(root, 'private.md'), path.join(root, 'assets', 'linked.png'));
  const handler = await createTeachReferenceHandler({ root });
  const disabled = await createTeachReferenceHandler();
  assert.equal((await invoke(disabled, `${prefix}/fixture.json`)).status, 404);
  const fixture = await invoke(handler, `${prefix}/fixture.json`, { headers: {
    origin: 'http://127.0.0.1:6006', referer: 'http://127.0.0.1:6006/iframe.html', 'sec-fetch-site': 'same-origin',
  } });
  assert.equal(fixture.status, 200);
  assert.equal(fixture.body.toString(), source);
  assert.equal(fixture.headers['Cache-Control'], 'no-store');
  assert.equal(fixture.headers['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(fixture.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(fixture.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.deepEqual((await invoke(handler, `${prefix}/assets/calendar.png`)).body, image);
  const head = await invoke(handler, `${prefix}/fixture.json`, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.body, undefined);
  for (const headers of [
    { host: 'foreign.example:6006' }, { origin: 'https://foreign.example' }, { origin: 'null' },
    { referer: 'https://foreign.example/path' }, { referer: 'not a URL' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
  ]) assert.equal((await invoke(handler, `${prefix}/fixture.json`, { headers })).status, 403);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await invoke(handler, `${prefix}/fixture.json`, { method })).status, 405);
  }
  assert.equal(await readFile(path.join(root, 'fixture.json'), 'utf8'), source);
  for (const suffix of [
    '', '/', '/private.md', '/assets', '/assets/', '/assets/linked.png', '/assets/missing.png',
    '/../private.md', '/%2e%2e/private.md', '/assets/%2e%2e/fixture.json',
    '/assets/a%2fcalendar.png', '/assets/calendar.png%00', '/assets/calendar.svg', '/assets/nested/calendar.png',
  ]) assert.equal((await invoke(handler, `${prefix}${suffix}`)).status, 404, suffix);
  await assert.rejects(() => createTeachReferenceHandler({ root: '.' }), /external Test root/);
  await assert.rejects(() => createTeachReferenceHandler({ root: testRoot }), /external Test root/);
  const link = path.join(campaign, 'linked-fixture');
  await symlink(root, link);
  await assert.rejects(() => createTeachReferenceHandler({ root: link }), /Invalid static build directory/);
  await rename(root, path.join(campaign, 'retained-original'));
  await mkdir(root);
  await writeFile(path.join(root, 'fixture.json'), 'replacement must not inherit authority');
  assert.equal((await invoke(handler, `${prefix}/fixture.json`)).status, 503);
});

test('reference errors stay within its explicit route and custom loopback port', async () => {
  await mkdir(path.join(testRoot, 'runs'), { recursive: true });
  const campaign = await mkdtemp(path.join(testRoot, 'runs', 'teach-reference-errors-'));
  const handler = await createTeachReferenceHandler({ root: campaign, port: 6109 });
  assert.equal((await invoke(handler, `${prefix}/fixture.json`, { headers: { host: '127.0.0.1:6109' } })).status, 404);
  await writeFile(path.join(campaign, 'fixture.json'), 'malformed JSON remains data for the reader to reject');
  const response = await invoke(handler, `${prefix}/fixture.json`, { headers: { host: '127.0.0.1:6109' } });
  assert.equal(response.status, 200);
  assert.throws(() => JSON.parse(response.body.toString()));
  assert.equal((await invoke(handler, `${prefix}/fixture.json`)).status, 403);
  assert.equal((await invoke(handler, '/fixture.json', { headers: { host: '127.0.0.1:6109' } })).status, 404);
});
