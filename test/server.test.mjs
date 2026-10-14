import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createController, AppError } from '../server.mjs';

const password = 'test-only-password-32-characters-long';
const id = '16155eeb-4c2f-4d72-bbf9-8f72b90b4201';
const requestId = 'ad030999-554b-4268-8b02-3592e81e53fd';

async function fixture(t, bridge = async () => ({ connected: true, sessions: [] })) {
  const server = createController({ password, origin: 'http://127.0.0.1:8765', bridge });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function call(route, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const request = http.request(base + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Host: '127.0.0.1:8765', Origin: 'http://127.0.0.1:8765', Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode, headers: { get: key => response.headers[key]?.toString() }, json: async () => JSON.parse(text), text: async () => text });
        });
      });
      request.on('error', reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function login() {
    const response = await call('/api/login', { username: 'local', password });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  }
  return { call, login };
}

test('requires authentication before accessing any desktop data', async t => {
  let calls = 0;
  const app = await fixture(t, async () => { calls++; });
  assert.equal((await app.call('/api/snapshot')).status, 401);
  assert.equal((await app.call('/api/select', { id })).status, 401);
  assert.equal((await app.call('/api/history', { id })).status, 401);
  assert.equal(calls, 0);
});
test('history requires authenticated UUID and narrow cursor fields', async t => {
  const operations = [];
  const app = await fixture(t, async operation => { operations.push(operation); return { id, messages: [] }; });
  await app.login();
  assert.equal((await app.call('/api/history', { id: '..\\private' })).status, 400);
  assert.equal((await app.call('/api/history', { id, path: 'private' })).status, 400);
  assert.equal((await app.call('/api/history', { id })).status, 200);
  assert.deepEqual(operations, [{ action: 'history', id, before: undefined, after: undefined }]);
});
test('login uses an HttpOnly SameSite cookie; logout revokes it', async t => {
  const app = await fixture(t);
  const response = await app.login();
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await app.call('/api/snapshot')).status, 200);
  assert.equal((await app.call('/api/logout', {})).status, 200);
  assert.equal((await app.call('/api/snapshot')).status, 401);
});
test('rejects foreign host and origin without bridge calls', async t => {
  let calls = 0;
  const app = await fixture(t, async () => { calls++; });
  await app.login();
  assert.equal((await app.call('/api/snapshot', undefined, { Host: 'attacker.example' })).status, 403);
  assert.equal((await app.call('/api/select', { id }, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await app.call('/api/snapshot', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(calls, 0);
});
test('limits login guessing', async t => {
  const app = await fixture(t);
  for (let i = 0; i < 5; i++) assert.equal((await app.call('/api/login', { password: 'wrong' })).status, 401);
  assert.equal((await app.call('/api/login', { username: 'local', password })).status, 429);
});
test('only narrow validated select/send operations reach the bridge', async t => {
  const operations = [];
  const app = await fixture(t, async operation => { operations.push(operation); return { selected: { id } }; });
  await app.login();
  assert.equal((await app.call('/api/select', { id: '..\\other-project' })).status, 400);
  assert.equal((await app.call('/api/send', { id, text: ' ', requestId })).status, 400);
  assert.equal((await app.call('/api/send', { id, text: 'x'.repeat(8001), requestId })).status, 400);
  assert.equal((await app.call('/api/send', { id, text: 'x\0', requestId })).status, 400);
  assert.equal((await app.call('/api/send', { id, text: 'hello' })).status, 400);
  assert.equal((await app.call('/api/exec', { command: 'whoami' })).status, 404);
  assert.equal((await app.call('/api/select', { id, command: 'whoami' })).status, 200);
  assert.deepEqual(operations, [{ action: 'select', id }]);
});
test('failed and unknown desktop deliveries are not represented as success', async t => {
  const app = await fixture(t, async () => { throw new AppError(409, 'DELIVERY_UNKNOWN', 'Inspect the PC before retrying.'); });
  await app.login();
  const response = await app.call('/api/send', { id, text: 'hello', requestId });
  assert.equal(response.status, 409);
  const data = await response.json();
  assert.equal(data.ok, false);
  assert.equal(data.code, 'DELIVERY_UNKNOWN');
  assert.equal(data.delivered, undefined);
});
test('deduplicates repeated send IDs including uncertain failures', async t => {
  let calls = 0;
  const app = await fixture(t, async () => { calls++; throw new AppError(409, 'DELIVERY_UNKNOWN', 'unknown'); });
  await app.login();
  const message = { id, text: 'hello', requestId };
  assert.equal((await app.call('/api/send', message)).status, 409);
  assert.equal((await app.call('/api/send', message)).status, 409);
  assert.equal(calls, 1);
  const conflict = await app.call('/api/send', { ...message, text: 'another' });
  assert.equal((await conflict.json()).code, 'REQUEST_CONFLICT');
  assert.equal(calls, 1);
});
test('serializes desktop operations rather than allowing focus competition', async t => {
  let finish;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const app = await fixture(t, () => { started(); return new Promise(resolve => { finish = resolve; }); });
  await app.login();
  const first = app.call('/api/send', { id, text: 'hello', requestId });
  await entered;
  assert.equal((await app.call('/api/select', { id })).status, 409);
  assert.equal((await app.call('/api/send', { id, text: 'hello', requestId })).status, 409);
  finish({ delivered: true, id, receipt: 'desktop-transcript' });
  assert.equal((await first).status, 200);
});
test('static mobile page has no third party scripts and no command interface', async t => {
  const app = await fixture(t);
  const response = await app.call('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await response.text();
  assert.match(html, /width=device-width/);
  assert.match(html, /maxlength="8000"/);
  assert.doesNotMatch(html, /https?:\/\/|command|exec/);
});
test('enforces JSON request type and message byte limits', async t => {
  const app = await fixture(t);
  await app.login();
  assert.equal((await app.call('/api/select', { id }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await app.call('/api/send', { id, text: 'x'.repeat(41000), requestId })).status, 413);
});
test('image upload and retrieval requires authentication and validates file types', async t => {
  const app = await fixture(t);
  assert.equal((await app.call('/api/upload', { files: [] })).status, 401);
  assert.equal((await app.call('/api/attachment?name=test.png')).status, 401);
  await app.login();

  // Test invalid upload
  assert.equal((await app.call('/api/upload', { files: [] })).status, 400);
  assert.equal((await app.call('/api/upload', { files: [{ name: 'test.exe', type: 'application/exe', data: 'AQID' }] })).status, 400);

  // Test valid upload
  const base64Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const uploadRes = await app.call('/api/upload', {
    files: [{ name: 'test.png', type: 'image/png', data: base64Png }]
  });
  assert.equal(uploadRes.status, 200);
  const uploadData = await uploadRes.json();
  assert.equal(uploadData.ok, true);
  assert.equal(uploadData.files.length, 1);
  assert.match(uploadData.files[0].filename, /^[0-9a-f-]{36}-test\.png$/);

  // Test attachment retrieval
  const attachRes = await app.call(`/api/attachment?name=${uploadData.files[0].filename}`);
  assert.equal(attachRes.status, 200);
  assert.equal(attachRes.headers.get('content-type'), 'image/png');

  // Test invalid attachment name traversal
  assert.equal((await app.call('/api/attachment?name=..%2Fsecret.txt')).status, 400);
});
