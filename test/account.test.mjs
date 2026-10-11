import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { localAccount } from '../account.mjs';

test('local username/password setup stores only salted scrypt and verifies credentials', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'copilot-remote-account-'));
  t.after(() => rm(folder, { recursive: true }));
  const file = path.join(folder, 'account.json');
  const account = localAccount(file);
  assert.equal((await account.status()).needsSetup, true);
  await assert.rejects(account.setup('jim', 'short'));
  await account.setup('jim', 'test-only-strong-password');
  assert.equal((await account.status()).needsSetup, false);
  assert.equal(await account.authenticate('jim', 'test-only-strong-password'), true);
  assert.equal(await account.authenticate('other', 'test-only-strong-password'), false);
  assert.equal(await account.authenticate('jim', 'wrong'), false);
  const stored = await readFile(file, 'utf8');
  assert.ok(!stored.includes('test-only-strong-password'));
  await assert.rejects(account.setup('another', 'test-only-strong-password'), error => error.code === 'EEXIST');
});
