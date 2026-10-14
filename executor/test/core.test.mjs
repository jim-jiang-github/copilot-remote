import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Executor, identifier } from '../core.mjs';
import { cleanupTemporary, temporary } from './helpers.mjs';
import { remoteSessionConfig, handleOperator } from '../agent.mjs';

class FakeSession extends EventEmitter {
  sessionId = 'fake';
  sends = [];
  on(handler) { return super.on('event', handler); }
  async getEvents() { return [{ type: 'assistant.message', data: { content: 'history' } }]; }
  async send(value) { this.sends.push(value); return 'message-id'; }
  async abort() { this.aborted = true; }
}

async function fixture(t, options = {}) {
  const directory = await temporary(t);
  const session = new FakeSession();
  const client = {
    async createSession(config) { this.createConfig = config; return session; },
    async resumeSession(id, config) { this.resumeConfig = config; return session; },
    async stop() { return []; },
  };
  const executor = new Executor({ client, directory, workspace: directory, ...options });
  await executor.initialize();
  t.after(() => executor.close());
  cleanupTemporary(t, directory);
  const created = await executor.execute({ action: 'create', requestId: 'create-1' });
  return { executor, client, session, directory, id: created.sessionId };
}

test('prompts deduplicate concurrently and across restart, with no automatic continuation', async (t) => {
  const { executor, client, session, directory, id } = await fixture(t);
  const command = { action: 'send', requestId: 'message-1', sessionId: id, prompt: 'hello' };
  const results = await Promise.all([executor.execute(command), executor.execute(command)]);
  assert.equal(session.sends.length, 1);
  assert.equal(results[0].status, 'accepted');
  assert.equal((await handleOperator(executor, { action: 'status', operationId: 'message-1' })).status, 'accepted');
  await assert.rejects(handleOperator(executor, { action: 'status', operationId: 'not-found' }), /not found/);
  await assert.rejects(executor.execute({ ...command, prompt: 'different' }), /different content/);
  const restarted = new Executor({ client, directory, workspace: directory });
  await restarted.initialize();
  await restarted.execute({ action: 'resume', requestId: 'resume-1', sessionId: id });
  assert.equal(client.resumeConfig.continuePendingWork, false);
  assert.equal(client.resumeConfig.allowTranscriptRecovery, false);
  await restarted.execute(command);
  assert.equal(session.sends.length, 1);
  await restarted.close();
});

test('runtime failures remain uncertain and cannot be retried', async (t) => {
  const { executor, session, id } = await fixture(t);
  let calls = 0;
  session.send = async () => { calls++; throw new Error('lost acknowledgment'); };
  const command = { action: 'send', requestId: 'lost', sessionId: id, prompt: 'run' };
  assert.equal((await executor.execute(command)).status, 'uncertain');
  assert.equal((await executor.execute(command)).error, 'lost acknowledgment');
  assert.equal(calls, 1);
});

test('permission approval is one-shot, input choices validated, timeouts deny', async (t) => {
  const { executor, id } = await fixture(t, { reviewTimeout: 30 });
  const result = executor.review(id, 'permission', { kind: 'shell' });
  const reviewId = [...executor.reviews.keys()][0];
  await executor.execute({ action: 'review', requestId: 'approve', sessionId: id, reviewId, decision: true });
  assert.deepEqual(await result, { kind: 'approve-once', approvedInteractively: true });
  await assert.rejects(executor.execute({
    action: 'review', requestId: 'stale', sessionId: id, reviewId, decision: true,
  }), /no longer pending/);
  assert.equal((await executor.review(id, 'permission', {})).kind, 'reject');
  const answer = executor.review(id, 'input', { question: 'Pick', choices: ['yes'], allowFreeform: false });
  const inputId = [...executor.reviews.keys()][0];
  await assert.rejects(executor.execute({
    action: 'review', requestId: 'wrong', sessionId: id, reviewId: inputId, decision: 'no',
  }), /Invalid user input/);
  await executor.execute({ action: 'review', requestId: 'answer', sessionId: id, reviewId: inputId, decision: 'yes' });
  assert.deepEqual(await answer, { answer: 'yes', wasFreeform: false });
});

test('owned sessions only, dangerous identifiers blocked and bounded replay resets explicitly', async (t) => {
  const { executor, id } = await fixture(t);
  assert.throws(() => identifier('__proto__'), /Invalid/);
  await assert.rejects(executor.execute({ action: 'resume', requestId: 'outside', sessionId: 'unowned' }), /not owned/);
  for (let i = 0; i < 1005; i++) executor.publish(id, 'test', {});
  assert.equal(executor.events.length, 1000);
  assert.equal((await handleOperator(executor, { action: 'events', epoch: executor.epoch, sequence: 0 })).reset, true);
  assert.equal((await handleOperator(executor, {
    action: 'events', epoch: executor.epoch, sequence: executor.sequence - 1,
  })).events.length, 1);
  const state = await executor.snapshot(id);
  assert.equal(state.history[0].data.content, 'history');
});

test('only remote custom tools are enabled and denied tools never reach device', async (t) => {
  const { executor, id } = await fixture(t, { reviewTimeout: 10 });
  let calls = 0;
  const config = remoteSessionConfig(executor, { request: async () => { calls++; } }, id);
  assert.deepEqual(config.availableTools, ['custom:device_info', 'custom:device_list',
    'custom:device_read', 'custom:device_write', 'custom:device_exec']);
  assert.deepEqual(config.excludedTools, ['builtin:*', 'mcp:*']);
  assert.equal(config.enableFileHooks, false);
  assert.equal(config.enableHostGitOperations, false);
  assert.equal((await config.tools[0].handler({})).resultType, 'failure');
  assert.equal(calls, 0);
});

test('large snapshots and approval payloads are bounded and fail closed', async (t) => {
  const { executor, session, id } = await fixture(t);
  session.getEvents = async () => [
    { type: 'user.message', data: { content: 'x'.repeat(700 * 1024) } },
    { type: 'assistant.message', data: { content: 'y'.repeat(700 * 1024) } },
  ];
  const snapshot = await executor.snapshot(id);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.history.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 1024 * 1024);
  const denied = await executor.review(id, 'permission', { content: 'x'.repeat(401 * 1024) });
  assert.equal(denied.kind, 'reject');
  assert.equal(executor.reviews.size, 0);
});
