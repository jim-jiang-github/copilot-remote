import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { Peer, relayUrl } from '../wire.mjs';
import { network, secrets } from './helpers.mjs';
import { createRelay } from '../relay.mjs';

test('authenticated three-role outbound RPC routes without trusting claimed sender', async (t) => {
  const { peers } = await network(t);
  peers.agent.on('message', (message) => {
    assert.equal(message.from, 'operator');
    void peers.agent.respond(message, (command) => peers.agent.request('device', command));
  });
  peers.device.on('message', (message) => {
    assert.equal(message.from, 'agent');
    void peers.device.respond(message, async (command) => ({ echoed: command }));
  });
  assert.deepEqual(await peers.operator.request('agent', { hello: 'B' }), { echoed: { hello: 'B' } });
});

test('public plaintext refused, invalid authentication and duplicate roles refused', async (t) => {
  assert.throws(() => relayUrl('ws://example.com'), /wss/);
  assert.throws(() => relayUrl('wss://user:password@example.com'), /only scheme/);
  const { peers, url, tokens } = await network(t);
  for (const secret of [secrets().agent, tokens.agent]) {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${secret}`, 'X-Executor-Role': 'agent' } });
    const [error] = await once(ws, 'error');
    assert.match(error.message, /401|409/);
    ws.terminate();
  }
  assert.equal(peers.agent.ready, true);
  assert.throws(() => createRelay({ secrets: { agent: tokens.agent, device: tokens.agent, operator: tokens.operator } }),
    /distinct/);
});

test('role violation closes socket; connection loss does not replay unknown requests', async (t) => {
  const { peers } = await network(t);
  let calls = 0;
  peers.device.on('message', () => { calls++; peers.device.close(); });
  await assert.rejects(peers.agent.request('device', { execute: true }), /may have executed/);
  assert.equal(calls, 1);
  const closed = once(peers.operator, 'disconnected');
  peers.operator.send({ type: 'request', to: 'device', id: 'forbidden', command: {} });
  await closed;
  peers.operator.close();
  assert.equal(calls, 1);
});

test('transport reconnect alone never reissues a pending request', async (t) => {
  const { peers, tokens, url } = await network(t);
  let calls = 0;
  peers.device.on('message', () => { calls++; peers.device.close(); });
  await assert.rejects(peers.agent.request('device', {}), /may have executed/);
  const replacement = new Peer({ url, role: 'device', secret: tokens.device });
  replacement.on('fault', () => {});
  replacement.on('message', () => { calls++; });
  t.after(() => replacement.close());
  const ready = once(replacement, 'ready');
  replacement.connect();
  await ready;
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  assert.equal(calls, 1);
});
