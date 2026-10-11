import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createController } from '../server.mjs';
import { createHistoryReader } from '../history.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'history-browser-'));
const a = randomUUID(), b = randomUUID();
const cwd = path.resolve('browser-fixture');
const targets = [{ id: a, title: 'History A', kind: 'chat', path: cwd }, { id: b, title: 'History B', kind: 'chat', path: cwd }];
const encode = (type, data) => JSON.stringify({ id: randomUUID(), type, data, timestamp: new Date().toISOString() }) + '\n';
const message = (text, role = 'user') => encode(`${role}.message`, { messageId: randomUUID(), content: text, ...(role === 'assistant' ? { phase: 'final_answer' } : {}) });
for (const id of [a, b]) {
  await mkdir(path.join(root, id));
  await writeFile(path.join(root, id, 'events.jsonl'), encode('session.start', { sessionId: id, version: 1, context: { cwd } }) +
    Array.from({ length: 120 }, (_, i) => message(`${id === a ? 'A' : 'B'} message ${i}\n${'Long history line. '.repeat(12)}`, i % 2 ? 'assistant' : 'user')).join(''));
}
const reader = createHistoryReader({ root, targets: () => targets });
const receiptId = randomUUID();
let delayA = false;
const password = randomUUID();
const origin = 'http://127.0.0.1:8768';
const server = createController({ origin, password, bridge: async op => {
  if (op.action === 'history') {
    if (delayA && op.id === a) await new Promise(resolve => setTimeout(resolve, 700));
    return reader(op);
  }
  if (op.action === 'select') return { selected: targets.find(item => item.id === op.id) };
  return { connected: true, sessions: targets, relay: true, receipts: [], deliveries: [{
    id: a, requestId: receiptId, status: 'app_accepted', createdAt: '2000-01-01T00:00:00Z',
    text: `A message 118\n${'Long history line. '.repeat(12)}`
  }] };
} });
await new Promise(resolve => server.listen(8768, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const viewport of [{ width: 1915, height: 1032 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator('#username').fill('local');
    await page.locator('#password').fill(password);
    await page.locator('#login-form button').click();
    await page.locator('#shell').waitFor({ state: 'visible' });
    async function select(id) {
      if (viewport.width < 700) await page.locator('#open-sidebar').click();
      await page.locator(`.session[data-session-id="${id}"]`).click();
    }
    await select(a);
    await page.waitForFunction(() => document.querySelectorAll('.history-message').length === 40);
    assert.equal(await page.locator('.transcript-line.user:not(.history-message)').count(), 0);
    await page.locator('#conversation').evaluate(element => { element.scrollTop = 0; });
    const anchor = await page.locator('.history-message').first().getAttribute('data-message-id');
    const beforeTop = await page.locator(`[data-message-id="${anchor}"]`).evaluate(e => e.getBoundingClientRect().top);
    await page.locator('#older-history').click();
    await page.waitForFunction(() => document.querySelectorAll('.history-message').length === 80);
    const afterTop = await page.locator(`[data-message-id="${anchor}"]`).evaluate(e => e.getBoundingClientRect().top);
    assert.ok(Math.abs(afterTop - beforeTop) < 3, JSON.stringify({ beforeTop, afterTop }));
    const oldScroll = await page.locator('#conversation').evaluate(e => e.scrollTop);
    const xss = `<img src=x onerror="window.historyXss=true"> ${randomUUID()}`;
    await appendFile(path.join(root, a, 'events.jsonl'), message(xss, 'assistant'));
    await page.waitForFunction(text => [...document.querySelectorAll('.history-content')].some(e => e.textContent === text), xss);
    assert.equal(await page.evaluate(() => Boolean(window.historyXss)), false);
    assert.equal(await page.locator('#conversation img').count(), 0);
    assert.ok(Math.abs((await page.locator('#conversation').evaluate(e => e.scrollTop)) - oldScroll) < 3);
    delayA = true;
    await page.locator('#reload-history').evaluate(button => { button.hidden = false; });
    await page.locator('#reload-history').click();
    await select(b);
    await page.waitForFunction(() => document.querySelectorAll('.history-message').length === 40 && document.querySelector('.history-content')?.textContent.startsWith('B'));
    await page.waitForTimeout(800);
    assert.ok((await page.locator('.history-content').allTextContents()).every(text => text.startsWith('B')));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    delayA = false;
    console.log(JSON.stringify({ viewport, recent: true, older: true, liveNewReply: true, oldScrollPreserved: true, targetRace: true, xssBlocked: true, overflow: false }));
    await page.close();
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
