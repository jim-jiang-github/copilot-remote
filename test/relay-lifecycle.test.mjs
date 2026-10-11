import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startRelay } from '../relay.mjs';
import { localAccount } from '../account.mjs';
import { payloadReference, markStopped, applyAdmission } from '../relay-state.mjs';

const targetId = '16155eeb-4c2f-4d72-bbf9-8f72b90b4201';
const accepted = { resultType: 'success', textResultForLlm: "Message accepted for priority delivery to chat 'Test'." };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-lifecycle-'));
  let hooks, tools, listener, server, close;
  let latest;
  const session = {
    on(callback) { listener = callback; },
    async send({ prompt }) {
      latest = { prompt, messageId: randomUUID() };
      listener({ type: 'user.message', data: { content: prompt, messageId: latest.messageId } });
      return latest.messageId;
    }
  };
  const account = localAccount(join(dir, 'account.json'));
  await account.setup('lifecycle-test', randomUUID());
  await startRelay(async config => { hooks = config.hooks; tools = config.tools; return session; }, {
    config: { runtimeId: process.env.SESSION_ID, appId: 'coordinator', targetId, verificationEnabled: true },
    ledgerUrl: join(dir, 'ledger.json'), account, port: 0,
    onServer: value => { server = value; }, onClose: value => { close = value; }
  });
  t.after(async () => { await close(); server?.closeAllConnections(); await rm(dir, { recursive: true }); });
  const invoke = (name, args = {}) => tools.find(tool => tool.name === name).handler(args);
  await invoke('remote_relay_start');
  await invoke('remote_relay_verify', { action: 'targets' });
  const input = { toolName: 'list_sessions_and_chats', toolArgs: {} };
  assert.equal((await hooks.onPreToolUse(input)).permissionDecision, 'allow');
  await hooks.onPostToolUse({ ...input, toolResult: { resultType: 'success', textResultForLlm: JSON.stringify([{ id: targetId, title: 'Test', type: 'chat' }]) } });
  async function queue() {
    const id = randomUUID();
    await invoke('remote_relay_verify', { action: 'question', requestId: id });
    return { id, messageId: latest.messageId };
  }
  async function lookup(ok = true) {
    const input = { toolName: 'get_session', toolArgs: { project_session_id: targetId } };
    assert.equal((await hooks.onPreToolUse(input)).permissionDecision, 'allow');
    await hooks.onPostToolUse({ ...input, toolResult: { resultType: ok ? 'success' : 'failure', textResultForLlm: JSON.stringify({ id: ok ? targetId : 'wrong', archived_at: null }) } });
  }
  async function dispatch(request) {
    const input = { toolName: 'send_session_message', toolArgs: { session_id: targetId, message: payloadReference(request.id), delivery_mode: 'immediate' } };
    const decision = await hooks.onPreToolUse(input);
    assert.equal(decision.permissionDecision, 'allow');
    const ledger = JSON.parse(await readFile(join(dir, 'ledger.json')));
    assert.equal(decision.modifiedArgs.message, ledger.requests[request.id].text);
    assert.match(decision.modifiedArgs.message, /^我可以创建什么项目吗？\n/);
    assert.equal((await hooks.onPreToolUse({ ...input, toolArgs: decision.modifiedArgs })).permissionDecision, 'deny');
    return { ...input, toolArgs: decision.modifiedArgs };
  }
  const snapshot = async () => JSON.parse(await invoke('remote_relay_verify', { action: 'status' }));
  const receipt = async id => (await snapshot()).receipts.find(item => item.requestId === id);
  return { hooks, emit: event => listener(event), queue, lookup, dispatch, receipt, snapshot };
}

test('sequential question sends preserve exact Chinese/newline data and real admission semantics', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 2; n++) {
    const r = await f.queue();
    await f.lookup();
    const input = await f.dispatch(r);
    await f.hooks.onPostToolUse({ ...input, toolResult: accepted });
    f.emit({ type: 'session.idle', data: {} });
    assert.equal((await f.receipt(r.id)).status, 'app_accepted');
  }
});
test('lookup failure and pre-dispatch abort are confirmed not sent; recovery permits a new request', async t => {
  const f = await fixture(t);
  const failed = await f.queue();
  await f.lookup(false);
  assert.equal((await f.receipt(failed.id)).status, 'failed');
  const aborted = await f.queue();
  await f.lookup();
  f.emit({ type: 'abort', data: { reason: 'user_initiated' } });
  assert.equal((await f.receipt(aborted.id)).status, 'cancelled');
  const interrupted = await f.queue();
  await f.lookup();
  f.emit({ type: 'user.message', data: { content: 'Unrelated coordinator maintenance', messageId: randomUUID() } });
  f.emit({ type: 'abort', data: { reason: 'user_initiated' } });
  assert.equal((await f.receipt(interrupted.id)).status, 'unknown');
  assert.equal((await f.snapshot()).activeRequestId, null);
  const next = await f.queue();
  await f.lookup();
  const input = await f.dispatch(next);
  await f.hooks.onPostToolUse({ ...input, toolResult: accepted });
  assert.equal((await f.receipt(next.id)).status, 'app_accepted');
});
test('late toolCall-correlated receipt overrides unknown without overwriting a new active request', async t => {
  const f = await fixture(t);
  const old = await f.queue();
  await f.lookup();
  const input = await f.dispatch(old);
  const toolCallId = randomUUID();
  f.emit({ type: 'assistant.message', data: { originatingMessageId: old.messageId, toolRequests: [{ toolCallId, name: input.toolName, arguments: input.toolArgs }] } });
  f.emit({ type: 'abort', data: { reason: 'user_initiated' } });
  assert.equal((await f.receipt(old.id)).status, 'unknown');
  const next = await f.queue();
  f.emit({ type: 'tool.execution_complete', data: { toolCallId, success: true, result: { content: accepted.textResultForLlm } } });
  assert.equal((await f.receipt(old.id)).status, 'app_accepted');
  assert.equal((await f.snapshot()).activeRequestId, next.id);
});
test('natural stop guard runs once only before dispatch; stale idle cannot terminate next request', async t => {
  const f = await fixture(t);
  const old = await f.queue();
  await f.lookup();
  assert.equal((await f.hooks.onAgentStop({ stopHookActive: false })).decision, 'block');
  assert.equal(await f.hooks.onAgentStop({ stopHookActive: true }), undefined);
  const input = await f.dispatch(old);
  f.emit({ type: 'session.idle', data: {} });
  await f.hooks.onPostToolUse({ ...input, toolResult: accepted });
  const next = await f.queue();
  f.emit({ type: 'session.idle', data: {} });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal((await f.snapshot()).activeRequestId, next.id);
});
test('stop cannot downgrade acceptance and no-receipt authorized dispatch is unknown', () => {
  const record = { requestId: 'r', status: 'invoking', dispatchAuthorized: true };
  markStopped(record, { aborted: true, requestId: 'r' });
  assert.equal(record.status, 'unknown');
  applyAdmission(record, accepted);
  markStopped(record, { aborted: true });
  assert.equal(record.status, 'app_accepted');
});
test('idle without any dispatch is confirmed incomplete, idle after dispatch stays unknown', async t => {
  const f = await fixture(t);
  const stopped = await f.queue();
  await f.lookup();
  f.emit({ type: 'session.idle', data: {} });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal((await f.receipt(stopped.id)).status, 'failed');
  const invoked = await f.queue();
  await f.lookup();
  await f.dispatch(invoked);
  f.emit({ type: 'session.idle', data: {} });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal((await f.receipt(invoked.id)).status, 'unknown');
});
test('production config registers no development tool or fixed-target HTTP entry', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-production-'));
  let registered;
  let close;
  await startRelay(async config => {
    registered = config.tools;
    return { on() {} };
  }, {
    config: { runtimeId: process.env.SESSION_ID, appId: 'coordinator', verificationEnabled: false },
    ledgerUrl: join(dir, 'ledger.json'), onClose: value => { close = value; }
  });
  t.after(async () => { await close(); await rm(dir, { recursive: true }); });
  assert.deepEqual(registered.map(tool => tool.name), ['remote_relay_start']);
});
