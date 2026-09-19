import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createApplicationCallback} from './application-callback.mjs';

const request = (url, {method = 'GET', host, path} = {}) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const outgoing = http.request({hostname: target.hostname, port: target.port, method, path: path ?? target.pathname + target.search, headers: host ? {host} : {}}, response => {
    let body = ''; response.setEncoding('utf8'); response.on('data', chunk => {body += chunk;}); response.on('end', () => resolve({status: response.statusCode, headers: response.headers, body}));
  });
  outgoing.on('error', reject); outgoing.end();
});
test('loopback rejects malformed, duplicate, Unicode, hostile-host callbacks without consuming the flow', async t => {
  const codes = [], failures = [], server = await createApplicationCallback({onCode: code => codes.push(code), onError: error => failures.push(error)});
  t.after(() => server.close());
  const valid = new URL(server.redirectTo); valid.searchParams.set('code', 'synthetic-code');
  for (const change of [
    url => url.searchParams.set('app_state', 'é'.repeat(43)),
    url => url.searchParams.set('app_state', 'A'.repeat(43)),
    url => url.searchParams.append('app_state', url.searchParams.get('app_state')),
    url => url.searchParams.append('code', 'second-code'),
    url => url.searchParams.set('token', 'should-not-be-admitted'),
    url => {url.pathname = '/unexpected';},
    url => url.searchParams.set('code', 'x'.repeat(1025)),
  ]) {
    const bad = new URL(valid); change(bad); assert.equal((await request(bad)).status, 400);
  }
  assert.equal((await request(valid, {host: 'evil.invalid'})).status, 400);
  assert.equal((await request(valid, {method: 'POST'})).status, 400);
  assert.equal((await request(valid, {path: 'https://evil.invalid/auth/callback' + valid.search})).status, 400);
  assert.deepEqual(codes, []); assert.deepEqual(failures, []);
  const accepted = await request(valid);
  assert.equal(accepted.status, 200); assert.equal(accepted.headers['cache-control'], 'no-store'); assert.equal(accepted.headers['referrer-policy'], 'no-referrer');
  assert.ok(accepted.headers['content-security-policy'].includes("default-src 'none'"));
  assert.ok(!accepted.body.includes('synthetic-code')); assert.ok(!accepted.body.includes(valid.searchParams.get('app_state')));
  assert.deepEqual(codes, ['synthetic-code']); assert.equal((await request(valid)).status, 409);
});
test('provider denial returns fixed static content without reflecting provider errors', async t => {
  const codes = [], failures = [], server = await createApplicationCallback({onCode: code => codes.push(code), onError: error => failures.push(error)});
  t.after(() => server.close());
  const url = new URL(server.redirectTo); url.searchParams.set('error', 'access_denied'); url.searchParams.set('error_description', 'synthetic-secret-<script>');
  const reply = await request(url); assert.equal(reply.status, 200); assert.ok(!reply.body.includes('synthetic-secret')); assert.deepEqual(codes, []);
  assert.equal(failures[0].code, 'ACCOUNT_DECLINED'); assert.ok(!failures[0].message.includes('synthetic-secret'));
});
