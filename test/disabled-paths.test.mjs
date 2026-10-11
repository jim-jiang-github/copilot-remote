import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopBridge } from '../server.mjs';
import { readFile } from 'node:fs/promises';

test('retired desktop automation bridge cannot be invoked by the controller', async () => {
  await assert.rejects(desktopBridge({ action: 'send', text: 'never send' }), error => error.code === 'BACKGROUND_API_UNAVAILABLE');
});
test('production relay never acquires focus, creates a CLI client, or simulates keyboard input', async () => {
  const source = await readFile(new URL('../relay.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /SendInput|SetFocus|setForeground|CopilotClient|child_process|powershell|navigate_to/);
  assert.match(source, /session\.send/);
  assert.match(source, /send_session_message/);
  assert.match(source, /app_accepted/);
});
