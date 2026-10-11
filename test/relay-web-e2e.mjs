import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:8765';
const local = new URL('../.local/', import.meta.url);
const username = process.env.REMOTE_TEST_USERNAME;
const password = process.env.REMOTE_TEST_PASSWORD;
if (!username || !password) throw new Error('Set local account credentials via environment.');
const testId = '16155eeb-4c2f-4d72-bbf9-8f72b90b4201';
let cookie;
async function call(route, body) {
  const response = await fetch(`${base}/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (route === 'login') cookie = response.headers.get('set-cookie')?.split(';')[0];
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
await call('login', { username, password });
const snapshot = await call('snapshot');
if (process.argv.includes('--refresh')) {
  console.log(JSON.stringify(await call('targets', {})));
} else if (process.argv.includes('--submit')) {
  assert.ok(snapshot.sessions.some(item => item.id === testId && item.title === 'Remote UI delivery test'), 'Test target must come from actual App enumeration.');
  const selection = await call('select', { id: testId });
  assert.equal(selection.selected.id, testId);
  const requestId = randomUUID();
  const text = `REMOTE_WEB_E2E_${requestId}。专用后台中转验证，请只回复“收到”，不要使用工具或改文件。`;
  const first = await call('send', { id: testId, requestId, text });
  assert.equal(first.submitted, true);
  const duplicate = await call('send', { id: testId, requestId, text });
  assert.equal(duplicate.requestId, requestId);
  await writeFile(new URL('relay-web-verification.json', local), JSON.stringify({ requestId, targetId: testId, text, authenticated: true, selected: true, duplicateRequestMatched: true, admission: first }, null, 2));
  console.log(JSON.stringify(first));
} else if (process.argv.includes('--verify')) {
  const reportUrl = new URL('relay-web-verification.json', local);
  const report = JSON.parse(await readFile(reportUrl, 'utf8'));
  const receipt = snapshot.receipts.find(item => item.requestId === report.requestId);
  assert.equal(receipt?.status, 'app_accepted', JSON.stringify(receipt));
  assert.equal(receipt.id, testId);
  assert.match(receipt.appReceipt, /^Message accepted for priority delivery to chat 'Remote UI delivery test'/);
  const replay = await fetch(`${base}/api/send`, { method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: report.targetId, text: report.text, requestId: report.requestId }) });
  const replayBody = await replay.json();
  assert.ok((replay.status === 409 && replayBody.code === 'REQUEST_CONFLICT') ||
    (replay.status === 200 && replayBody.requestId === report.requestId), JSON.stringify(replayBody));
  await writeFile(reportUrl, JSON.stringify({ ...report, verifiedAt: new Date().toISOString(), appReceipt: receipt, crossLoginReplayPrevented: true, targetProcessed: 'not verified' }, null, 2));
  console.log(JSON.stringify({ requestId: report.requestId, status: receipt.status, crossLoginReplayPrevented: true, targetProcessed: 'not verified' }));
} else {
  console.log(JSON.stringify(snapshot, null, 2));
}
