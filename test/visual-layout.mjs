import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createController } from '../server.mjs';
import { parseAppTargets } from '../relay.mjs';

const log = 'C:\\Users\\JimJiang\\.copilot\\session-state\\95922c4a-2671-4737-bb04-3cd01e02ff26\\events.jsonl';
const events = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const names = new Map(events.filter(event => event.type === 'tool.execution_start').map(event => [event.data.toolCallId, event.data.toolName]));
const lists = events.filter(event => event.type === 'tool.execution_complete' && names.get(event.data.toolCallId) === 'list_sessions_and_chats' && event.data.success);
assert.ok(lists.length, 'Visual fixture requires a recorded real App enumeration.');
const sessions = parseAppTargets(lists.at(-1).data.result.content);
const ledger = JSON.parse(await readFile(new URL('../.local/relay-ledger.json', import.meta.url), 'utf8'));
const target = sessions.find(item => item.id === '4515d756-bcdd-42ad-969f-58bf634ebbe2') ?? sessions[0];
const password = randomUUID();
const origin = 'http://127.0.0.1:8767';
const account = { status: async () => ({ needsSetup: false }), authenticate: async (user, value) => user === 'visual-fixture' && value === password };
const server = createController({ origin, account, bridge: async operation => operation.action === 'select'
  ? { selected: sessions.find(item => item.id === operation.id) }
  : { connected: true, sessions, receipts: [], deliveries: Object.values(ledger.requests).filter(item => item.text), relay: true } });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(8767, '127.0.0.1', resolve); });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const viewport of [{ width: 1915, height: 1032 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator('#username').fill('visual-fixture');
    await page.locator('#password').fill(password);
    await page.locator('#login-form button').click();
    await page.locator('#shell').waitFor({ state: 'visible' });
    if (viewport.width < 700) await page.locator('#open-sidebar').click();
    await page.locator('.session').filter({ hasText: target.title }).first().click();
    await page.locator('#message').fill('界面尺寸验证草稿，不发送');
    const dimensions = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      sidebar: document.querySelector('#sidebar').getBoundingClientRect().width,
      composer: { width: document.querySelector('#composer').getBoundingClientRect().width, height: document.querySelector('#composer').getBoundingClientRect().height }
    }));
    assert.equal(dimensions.overflow, false);
    assert.deepEqual(errors, []);
    if (viewport.width > 700) {
      assert.equal(dimensions.sidebar, 274);
      assert.equal(dimensions.composer.width, 772);
      assert.equal(dimensions.composer.height, 184);
    }
    const file = new URL(`../.local/${viewport.width > 700 ? 'desktop' : 'mobile'}-preview.png`, import.meta.url);
    await page.screenshot({ path: file.pathname.replace(/^\/([A-Z]:)/, '$1'), animations: 'disabled' });
    console.log(JSON.stringify({ viewport, ...dimensions, errors, fixtureOnly: true, sent: false }));
    await page.close();
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
