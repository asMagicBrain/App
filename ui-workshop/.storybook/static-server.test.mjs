import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { staticHandler } from './static-server.mjs';

test('static Storybook serves exact regular files and refuses other authorities', async () => {
  const cache = fileURLToPath(new URL('../.cache/', import.meta.url));
  await mkdir(cache, { recursive: true });
  const fixture = await mkdtemp(path.join(cache, 'static-test-'));
  try {
    const root = path.join(fixture, 'build');
    await mkdir(path.join(root, 'assets'), { recursive: true });
    await writeFile(path.join(root, 'index.html'), '<h1>Generated fixture</h1>');
    await writeFile(path.join(root, 'assets/main.js'), 'export const fixture = true;');
    await writeFile(path.join(fixture, 'outside.txt'), 'not served');
    await symlink(path.join(fixture, 'outside.txt'), path.join(root, 'linked.txt'));
    await symlink(fixture, path.join(root, 'linked-directory'));
    const handle = await staticHandler(root);
    const request = async (url, method = 'GET', host = '127.0.0.1:6006') => {
      const result = {};
      await handle({ url, method, headers: { host } }, {
        writeHead(status, headers) { result.status = status; result.headers = headers; },
        end(body) { result.body = body?.toString(); },
        destroy() { result.destroyed = true; },
      });
      return result;
    };
    const index = await request('/?path=/story/workshop');
    assert.equal(index.status, 200);
    assert.equal(index.body, '<h1>Generated fixture</h1>');
    assert.equal(index.headers['Cache-Control'], 'no-store');
    const js = await request('/assets/main.js');
    assert.equal(js.body, 'export const fixture = true;');
    assert.equal(js.headers['Content-Type'], 'text/javascript; charset=utf-8');
    const head = await request('/assets/main.js', 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.body, undefined);
    for (const url of ['/../outside.txt', '/%2e%2e/outside.txt', '/linked.txt',
      '/linked-directory/outside.txt', '/assets', '/assets/', '/missing', '/%ZZ',
      '/assets%5cmain.js', '/%00', '//example.test/index.html']) {
      assert.notEqual((await request(url)).status, 200, url);
    }
    assert.equal((await request('/', 'POST')).status, 405);
    assert.equal((await request('/', 'GET', 'example.test:6006')).status, 403);
    await writeFile(path.join(root, 'assets/main.js'), 'export const rebuilt = true;');
    assert.equal((await request('/assets/main.js')).body, 'export const rebuilt = true;');
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
