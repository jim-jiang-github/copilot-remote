import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DeviceTools, devicePath, runProcess } from '../device-tools.mjs';
import { cleanupTemporary, temporary } from './helpers.mjs';
import { lockDirectory, saveJson } from '../storage.mjs';
import { createHash } from 'node:crypto';
import { approvalFor } from '../device.mjs';

async function fixture(t, approve = async () => true) {
  const directory = await temporary(t);
  const root = join(directory, 'root');
  await mkdir(root);
  const tools = new DeviceTools({ root, directory, approve, executables: [process.execPath] });
  await tools.initialize();
  t.after(() => tools.close());
  cleanupTemporary(t, directory);
  return { tools, directory, root };
}

test('real file and process tools deduplicate before and after restart', async (t) => {
  const { tools, directory, root } = await fixture(t);
  const write = { requestId: 'write', tool: 'write', args: { path: 'hello.txt', content: 'first' } };
  assert.equal((await tools.execute(write)).status, 'completed');
  await writeFile(join(root, 'hello.txt'), 'changed independently');
  await tools.execute(write);
  assert.equal(await readFile(join(root, 'hello.txt'), 'utf8'), 'changed independently');
  const resumed = new DeviceTools({ root, directory, approve: async () => true });
  await resumed.initialize();
  await resumed.execute(write);
  assert.equal(await readFile(join(root, 'hello.txt'), 'utf8'), 'changed independently');
  const output = await tools.execute({ requestId: 'exec', tool: 'exec', args: {
    executable: process.execPath, args: ['-e', 'console.log(process.cwd())'],
  } });
  assert.equal(output.status, 'completed');
  assert.equal(output.result.stdout.trim(), await realpath(root));
  await resumed.close();
});

test('path traversal, absolute paths, symlink escape, size limits and unknown executables fail closed', async (t) => {
  const { tools, root, directory } = await fixture(t);
  await assert.rejects(devicePath(await realpath(root), '../outside'), /outside/);
  await assert.rejects(devicePath(await realpath(root), directory), /relative/);
  const outside = join(directory, 'outside');
  await mkdir(outside);
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(devicePath(await realpath(root), 'escape'), /Symbolic/);
  await assert.rejects(devicePath(await realpath(root), 'escape/file', true), /outside/);
  assert.equal((await tools.execute({
    requestId: 'large', tool: 'write', args: { path: 'large', content: 'x'.repeat(512 * 1024 + 1) },
  })).status, 'failed');
  assert.equal((await tools.execute({
    requestId: 'not-allowed', tool: 'exec', args: { executable: join(root, 'missing'), args: [] },
  })).status, 'failed');
});

test('denials never execute and are not turned into success-shaped output', async (t) => {
  const { tools, root } = await fixture(t, async () => false);
  const result = await tools.execute({
    requestId: 'denied', tool: 'write', args: { path: 'denied', content: 'no' },
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /denied/);
  await assert.rejects(readFile(join(root, 'denied')), { code: 'ENOENT' });
});

test('process timeout, output bound and cancellation stop actual children', async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], root, 200), /timed out/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(600000))'],
    root, 10_000), /output exceeded/);
  const controller = new AbortController();
  const run = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], root, 10_000, controller.signal);
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(run, /cancelled/);
});

test('live process output preserves UTF-8 across chunk boundaries', async (t) => {
  const { root } = await fixture(t);
  const progress = [];
  const result = await runProcess(process.execPath, ['-e',
    'process.stdout.write(Buffer.from([0xe4]));setTimeout(()=>process.stdout.write(Buffer.from([0xbd,0xa0])),100)'],
  root, 5000, undefined, (stream, text) => progress.push({ stream, text }));
  assert.equal(result.stdout, '\u4f60');
  assert.equal(progress.map((event) => event.text).join(''), '\u4f60');
});

test('one owner per persistent state directory', async (t) => {
  const directory = await temporary(t);
  cleanupTemporary(t, directory);
  const release = await lockDirectory(directory);
  await assert.rejects(lockDirectory(directory), /locked/);
  await release();
  const releaseAgain = await lockDirectory(directory);
  await releaseAgain();
});

test('session cancellation interrupts active work and prevents queued execution', async (t) => {
  const { tools, root } = await fixture(t, (command, signal) => command.requestId !== 'waiting'
    ? Promise.resolve(true) : new Promise((resolveApproval) => {
      signal.addEventListener('abort', () => resolveApproval(false), { once: true });
    }));
  const waiting = tools.execute({ requestId: 'waiting', sessionId: 'session', tool: 'info' });
  const queued = tools.execute({ requestId: 'queued', sessionId: 'session', tool: 'write',
    args: { path: 'should-not-exist', content: 'no' } });
  while (tools.active.size === 0) await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  assert.equal(tools.cancelSession('session').cancelled, 1);
  assert.equal((await waiting).status, 'failed');
  assert.match((await queued).error, /cancelled before execution/);
  await assert.rejects(readFile(join(root, 'should-not-exist')), { code: 'ENOENT' });
});

test('operator approval mode is explicit and requires paired A authorization marker', async () => {
  assert.throws(() => approvalFor('all'), /terminal or operator/);
  const approve = approvalFor('operator');
  assert.equal(await approve({ requestId: 'none', tool: 'write' }), false);
  assert.equal(await approve({
    requestId: 'authorized', tool: 'read', authorization: 'operator-approved-once',
  }), true);
});

test('crash-pending journal entry is never re-executed after restart', async (t) => {
  const { tools, directory, root } = await fixture(t);
  const command = { requestId: 'crash-pending', tool: 'write', args: { path: 'unsafe-replay', content: 'no' } };
  const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
  await saveJson(tools.ledgerPath, { [command.requestId]: { hash, status: 'uncertain' } });
  const restarted = new DeviceTools({ root, directory, approve: async () => assert.fail('Must not ask or execute') });
  await restarted.initialize();
  assert.equal((await restarted.execute(command)).status, 'uncertain');
  await assert.rejects(readFile(join(root, 'unsafe-replay')), { code: 'ENOENT' });
  await restarted.close();
});
