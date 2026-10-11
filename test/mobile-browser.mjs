import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const username = process.env.REMOTE_TEST_USERNAME;
const password = process.env.REMOTE_TEST_PASSWORD;
if (!username || !password) throw new Error('Set local test account credentials via environment, never GitHub credentials.');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8765');
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#login-form button').click();
  await page.locator('#shell').waitFor({ state: 'visible' });
  await page.locator('#open-sidebar').click();
  if (await page.locator('.session').count() === 0) {
    await expect(page.locator('#refresh')).toBeEnabled();
    await page.locator('#refresh').click();
  }
  const testTitle = process.env.REMOTE_TEST_TARGET_TITLE ?? 'CLI 远程执行';
  await page.locator('.session').filter({ hasText: testTitle }).click();
  await page.locator('#message').waitFor({ state: 'visible' });
  await expect(page.locator('#title')).toHaveText(testTitle);
  await expect(page.locator('#message')).toBeEnabled();
  await page.locator('#message').fill('手机草稿，不发送');
  await expect(page.locator('#send')).toBeEnabled({ timeout: 120000 });
  const width = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  assert.ok(width.content <= width.viewport, JSON.stringify(width));
  assert.deepEqual(errors, []);
  await expect(page.locator('#sidebar')).not.toHaveClass(/open/);
  const groups = await page.locator('.tree-group>summary').allTextContents();
  assert.ok(groups.some(name => name.includes('CopilotRemote')), JSON.stringify(groups));
  assert.ok(groups.some(name => name.includes('shop-postman')), JSON.stringify(groups));
  assert.ok(groups.some(name => name.includes('qianniu-standalone-bridge')), JSON.stringify(groups));
  await page.locator('#open-sidebar').click();
  await page.locator('#create-session').click();
  await expect(page.locator('#create-dialog')).toBeVisible();
  assert.ok((await page.locator('#new-project option').allTextContents()).includes('CopilotRemote'));
  await page.locator('#cancel-create').click();
  await page.locator('#close-sidebar').click();
  await page.screenshot({ path: new URL('../.local/mobile-preview.png', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'), fullPage: true, animations: 'disabled' });
  console.log(JSON.stringify({ mobileViewport: '390x844', authenticated: true, selectedExistingTarget: true, realProjectGroups: groups, createDialogOnly: true, draftEditable: true, horizontalOverflow: false, pageErrors: errors, sent: false, created: false }));
} finally { await browser.close(); }
