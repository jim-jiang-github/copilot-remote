import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

export async function checkLiveBrowser({ origin, username, password, targetId, history = false }) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const results = [];
  try {
    for (const viewport of [{ width: 1915, height: 1032 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin);
      await page.locator('#username').fill(username);
      await page.locator('#password').fill(password);
      await page.locator('#login-form button').click();
      await page.locator('#shell').waitFor({ state: 'visible' });
      if (viewport.width < 700) await page.locator('#open-sidebar').click();
      const target = page.locator(`.session[data-session-id="${targetId}"]`);
      await target.click();
      let historyResult;
      if (history) {
        await page.waitForFunction(() => document.querySelectorAll('.history-message').length > 0);
        const recent = await page.locator('.history-message').count();
        const backend = await page.evaluate(async id => {
          const response = await fetch('/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
          if (!response.ok) throw new Error('Actual authenticated history request failed');
          return response.json();
        }, targetId);
        assert.ok(backend.messages.length > 0);
        await page.waitForFunction(ids => {
          const rendered = new Set([...document.querySelectorAll('.history-message')].map(e => e.dataset.messageId));
          return ids.every(id => rendered.has(id));
        }, backend.messages.map(item => item.messageId));
        await page.locator('#conversation').evaluate(e => { e.scrollTop = 0; });
        await page.locator('#older-history').click();
        await page.waitForFunction(count => document.querySelectorAll('.history-message').length > count, recent);
        const olderTotal = await page.locator('.history-message').count();
        await page.waitForTimeout(3400);
        historyResult = { recentCount: recent, afterOlderCount: olderTotal, renderedIdsMatchBackend: true,
          latestAt: backend.messages.at(-1).timestamp, roles: [...new Set(backend.messages.map(item => item.role))],
          source: backend.source, pollingError: await page.locator('#history-status').textContent() };
        assert.ok(!historyResult.pollingError.includes('HISTORY_'));
      }
      await page.locator('#message').fill('真实页面检查草稿，不发送');
      const dimensions = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        sidebar: document.querySelector('#sidebar').getBoundingClientRect().width,
        composerWidth: document.querySelector('#composer').getBoundingClientRect().width,
        composerHeight: document.querySelector('#composer').getBoundingClientRect().height
      }));
      assert.equal(dimensions.overflow, false);
      assert.deepEqual(errors, []);
      const screenshot = new URL(`../.local/live-${viewport.width > 700 ? 'desktop' : 'mobile'}-preview.png`, import.meta.url);
      if (!history) await page.screenshot({ path: screenshot.pathname.replace(/^\/([A-Z]:)/, '$1'), animations: 'disabled' });
      results.push({ viewport, ...dimensions, authenticated: true, selectedId: targetId, errors, sent: false, ...(historyResult ? { history: historyResult } : {}) });
      await page.evaluate(() => fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
      await page.close();
    }
  } finally { await browser.close(); }
  return results;
}
