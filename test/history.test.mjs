import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHistoryReader } from '../history.mjs';

const id = '8f7861af-bfe9-48ed-8e33-0feb489cd143';
const cwd = path.resolve('fixture-project');
const event = (type, data, timestamp = '2026-10-11T10:00:00Z') => JSON.stringify({ id: randomUUID(), type, timestamp, data }) + '\n';
const start = () => event('session.start', { version: 1, sessionId: id, context: { cwd } });
const message = (content, role = 'user', extra = {}) => event(`${role}.message`, { content, messageId: randomUUID(), ...extra });
async function fixture(t, text = start()) {
  const root = await mkdtemp(path.join(tmpdir(), 'remote-history-'));
  await mkdir(path.join(root, id));
  const file = path.join(root, id, 'events.jsonl');
  await writeFile(file, text);
  t.after(() => rm(root, { recursive: true, force: true }));
  const read = createHistoryReader({ root, targets: () => [{ id, path: cwd }], pageSize: 2 });
  return { root, file, read };
}
test('recent, older and incremental pages use append order and safe role fields', async t => {
  const f = await fixture(t, start() + message('one') + message('two', 'assistant', { phase: 'final_answer', reasoningText: 'SECRET' }) +
    message('three', 'user', { isAutopilotContinuation: true, attachments: [{ path: 'SECRET', displayName: '..\\photo.png' }] }));
  const recent = await f.read({ id });
  assert.deepEqual(recent.messages.map(item => item.content), ['two', 'three']);
  assert.equal(recent.messages[1].source, '自动续行');
  assert.equal(recent.messages[1].attachments[0].name, 'photo.png');
  assert.ok(!JSON.stringify(recent).includes('SECRET'));
  const older = await f.read({ id, before: recent.before });
  assert.deepEqual(older.messages.map(item => item.content), ['one']);
  await appendFile(f.file, message('new answer', 'assistant', { phase: 'final_answer' }));
  const incremental = await f.read({ id, after: recent.after });
  assert.deepEqual(incremental.messages.map(item => item.content), ['new answer']);
});
test('incomplete tail waits for newline without losing or duplicating a new reply', async t => {
  const f = await fixture(t, start() + message('old'));
  const first = await f.read({ id });
  const line = message('new', 'assistant', { phase: 'final_answer' });
  await appendFile(f.file, line.slice(0, -1));
  const partial = await f.read({ id, after: first.after });
  assert.equal(partial.messages.length, 0);
  assert.equal(partial.incompleteTail, true);
  await appendFile(f.file, '\n');
  assert.deepEqual((await f.read({ id, after: first.after })).messages.map(item => item.content), ['new']);
});
test('attachment-only messages remain visible with no local path disclosure', async t => {
  const f = await fixture(t, start() + message('', 'user', { attachments: [{ displayName: 'picture.png', path: 'C:\\private\\picture.png' }] }));
  const result = await f.read({ id });
  assert.equal(result.messages.length, 1);
  assert.deepEqual(result.messages[0].attachments, [{ name: 'picture.png', filename: 'picture.png' }]);
  assert.ok(!JSON.stringify(result).includes('private'));
});
test('extracts user embedded upload attachments safely and strips raw local paths', async t => {
  const embedded = '[用户上传了 1 张图片附件]:\n1. C:\\private\\path\\secret-id-photo.png (photo.png)\n\n请分析这张图片';
  const f = await fixture(t, start() + message(embedded, 'user'));
  const result = await f.read({ id });
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].content, '请分析这张图片');
  assert.deepEqual(result.messages[0].attachments, [{ name: 'photo.png', filename: 'secret-id-photo.png' }]);
  assert.ok(!JSON.stringify(result).includes('private'));
});
test('incremental polling reads new pages and is bounded to the captured snapshot', async t => {
  const f = await fixture(t, start() + message('first'));
  const first = await f.read({ id });
  await appendFile(f.file, message('next1', 'assistant') + message('next2', 'assistant') + message('next3', 'assistant'));
  const page = await f.read({ id, after: first.after });
  assert.deepEqual(page.messages.map(item => item.content), ['next1', 'next2']);
  assert.equal(page.hasMoreNew, true);
  const last = await f.read({ id, after: page.after });
  assert.deepEqual(last.messages.map(item => item.content), ['next3']);
  assert.equal(last.hasMoreNew, false);
});
test('actual successful completion summary is a visible assistant reply, not a raw tool log', async t => {
  const call = randomUUID();
  const f = await fixture(t, start() + event('assistant.message', { messageId: randomUUID(), content: '',
    toolRequests: [{ toolCallId: call, name: 'task_complete', arguments: { summary: 'Actual final reply' } }] }));
  const pending = await f.read({ id });
  assert.equal(pending.messages.length, 0);
  await appendFile(f.file, event('tool.execution_complete', { toolCallId: call, success: true, result: { content: 'Internal detail SECRET' } }));
  const done = await f.read({ id, after: pending.after });
  assert.equal(done.messages[0].content, 'Actual final reply');
  assert.equal(done.messages[0].role, 'assistant');
  assert.equal(done.messages[0].source, '完成摘要');
  assert.ok(!JSON.stringify(done).includes('SECRET'));
});
test('tool execution progress parses safe titles, icons, durations and turn activity', async t => {
  const toolCallId = 'call_' + randomUUID();
  const f = await fixture(t, start() + message('用户指令') +
    event('assistant.turn_start', { turnId: '0' }, '2026-10-13T10:00:00.000Z') +
    event('tool.execution_start', {
      toolCallId,
      toolName: 'view',
      toolTitle: 'Viewing file',
      arguments: { path: 'C:\\Users\\alice\\repo\\pdd_video.py' }
    }, '2026-10-13T10:00:01.000Z'));
  const inFlight = await f.read({ id });
  assert.equal(inFlight.messages.length, 2);
  const toolItem = inFlight.messages[1];
  assert.equal(toolItem.role, 'tool');
  assert.equal(toolItem.icon, '🐍');
  assert.equal(toolItem.title, 'View pdd_video.py');
  assert.equal(toolItem.status, 'running');
  assert.equal(inFlight.progress.status, 'busy');
  assert.equal(inFlight.progress.activeTool.title, 'View pdd_video.py');
  assert.ok(!JSON.stringify(inFlight).includes('alice'));

  await appendFile(f.file, event('tool.execution_complete', {
    toolCallId,
    success: true,
    result: { content: 'INTERNAL_SECRET_CODE' }
  }, '2026-10-13T10:00:20.000Z') +
    event('assistant.turn_end', { turnId: '0' }, '2026-10-13T10:00:20.500Z') +
    message('任务已完成', 'assistant'));

  const completed = await f.read({ id, after: inFlight.after });
  const completedTool = completed.messages.find(m => m.toolCallId === toolCallId);
  assert.ok(completedTool);
  assert.equal(completedTool.status, 'completed');
  assert.equal(completedTool.durationText, '19s');
  assert.equal(completed.progress.status, 'idle');
  assert.ok(!JSON.stringify(completed).includes('INTERNAL_SECRET_CODE'));
});
test('invalid UTF8/schema/version, unknown phase and mismatched identity fail explicitly', async t => {
  for (const text of [
    start() + message('bad', 'assistant', { phase: 'new-unknown-phase' }),
    start() + event('user.message', { messageId: randomUUID() }),
    event('session.start', { version: 2, sessionId: id, context: { cwd } }),
    event('session.start', { version: 1, sessionId: randomUUID(), context: { cwd } }),
    start() + '{invalid}\n',
    Buffer.concat([Buffer.from(start()), Buffer.from([255, 10])])
  ]) {
    const f = await fixture(t, text);
    await assert.rejects(f.read({ id }), error => ['HISTORY_INVALID', 'HISTORY_UNAVAILABLE'].includes(error.code));
  }
});
test('truncation, replacement and overwritten prefix invalidate old cursors', async t => {
  for (const mode of ['truncate', 'replace', 'overwrite']) {
    const f = await fixture(t, start() + message('old'));
    const first = await f.read({ id });
    if (mode === 'replace') {
      await rename(f.file, f.file + '.old');
      await writeFile(f.file, start() + message('replacement'));
    } else await writeFile(f.file, mode === 'truncate' ? start() : start() + message('overwritten'));
    await assert.rejects(f.read({ id, after: first.after }), { code: 'HISTORY_CHANGED' });
    assert.ok((await f.read({ id })).messages.length >= 0);
  }
});
test('unknown target, traversal, cwd mismatch and junction paths are refused', async t => {
  const f = await fixture(t, start());
  await assert.rejects(f.read({ id: '..\\outside' }), { code: 'HISTORY_UNAVAILABLE' });
  await assert.rejects(f.read({ id: randomUUID() }), { code: 'HISTORY_UNAVAILABLE' });
  const wrong = createHistoryReader({ root: f.root, targets: () => [{ id, path: path.resolve('wrong-project') }] });
  await assert.rejects(wrong({ id }), { code: 'HISTORY_UNAVAILABLE' });
  const linked = path.join(f.root, 'linked');
  await symlink(path.join(f.root, id), linked, 'junction');
  const reader = createHistoryReader({ root: linked, targets: () => [{ id, path: cwd }] });
  await mkdir(path.join(f.root, id, id));
  await writeFile(path.join(f.root, id, id, 'events.jsonl'), start());
  await assert.rejects(reader({ id }), { code: 'HISTORY_UNAVAILABLE' });
});
