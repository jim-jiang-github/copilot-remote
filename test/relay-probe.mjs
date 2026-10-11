import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = new URL('../.local/', import.meta.url);
const { password } = JSON.parse(await readFile(new URL('credentials.json', root), 'utf8'));
const base = 'http://127.0.0.1:8766';
async function call(route, method = 'GET') {
  const response = await fetch(base + route, {
    method,
    headers: { Authorization: `Bearer ${password}`, Origin: base },
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json();
  assert.ok(response.ok, `HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}
if (process.argv.includes('--submit')) {
  const before = await call('/status');
  assert.equal(before.status, 'ready', 'Only submit a never-used, dedicated probe.');
  const result = await call('/probe', 'POST');
  assert.ok(result.requestId);
  console.log(JSON.stringify(result, null, 2));
} else {
  const status = await call('/status');
  await writeFile(new URL('relay-probe-observed.json', root), JSON.stringify(status, null, 2));
  console.log(JSON.stringify(status, null, 2));
}
