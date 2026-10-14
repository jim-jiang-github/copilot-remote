import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { Peer } from './wire.mjs';

const streamedMessages = new Set();
export function displayEvent(event) {
  if (event.type === 'assistant.message_delta') {
    if (!streamedMessages.has(event.data.messageId)) {
      if (streamedMessages.size > 1000) streamedMessages.clear();
      streamedMessages.add(event.data.messageId);
      process.stdout.write('\nAssistant: ');
    }
    process.stdout.write(event.data.deltaContent || '');
  } else if (event.type === 'assistant.message') {
    if (streamedMessages.delete(event.data.messageId)) process.stdout.write('\n');
    else console.log(`\nAssistant: ${event.data.content}`);
  }
  else if (event.type === 'executor.review') {
    console.log(`\nREVIEW ${event.data.requestId} (${event.data.type}):\n${JSON.stringify(event.data.request, null, 2)}`);
    console.log('Use /approve ID, /deny ID, or /answer ID your answer. Approval is only for this request.');
  } else if (event.type === 'device.output') {
    process.stdout.write(`[B ${event.data.stream}] ${event.data.text}`);
  } else if (['session.error', 'executor.error', 'executor.review.closed', 'session.idle',
    'tool.execution_start', 'tool.execution_complete'].includes(event.type)) {
    console.log(`\n${event.type}: ${JSON.stringify(event.data)}`);
  }
}

async function main() {
  const peer = new Peer({
    url: process.env.EXECUTOR_RELAY, role: 'operator', secret: process.env.EXECUTOR_OPERATOR_TOKEN,
  });
  let sessionId = process.env.EXECUTOR_SESSION;
  let cursor = 0, epoch, syncing = false;
  const buffer = [];
  const consume = (event) => {
    if (epoch !== event.epoch || event.sequence <= cursor) return;
    cursor = event.sequence;
    if (event.sessionId === sessionId) displayEvent(event);
  };
  const request = (command) => {
    const requestId = randomUUID();
    if (['create', 'send', 'abort', 'review'].includes(command.action)) {
      console.log(`Request ${requestId} (${command.action}); save this ID if delivery becomes uncertain`);
    }
    return peer.request('agent', { ...command, requestId }, requestId);
  };
  const snapshot = async () => {
    syncing = true;
    try {
      const state = await request({ action: 'snapshot', sessionId });
      console.log('\n--- Conversation history ---');
      if (state.truncated) console.log('Older history omitted from this bounded snapshot; retained on A.');
      for (const event of state.history) {
        if (['user.message', 'assistant.message'].includes(event.type)) {
          console.log(`${event.type}: ${event.data.content}`);
        }
      }
      epoch = state.epoch;
      cursor = state.sequence;
      for (const review of state.reviews) {
        displayEvent({ type: 'executor.review', data: review });
      }
      for (const event of buffer.splice(0)) consume(event);
    } finally { syncing = false; }
  };
  let synchronizing;
  const sync = () => {
    if (synchronizing || !peer.peers.includes('agent') || !sessionId) return;
    synchronizing = (async () => {
      const result = await request({ action: 'resume', sessionId });
      if (result.status !== 'accepted') throw new Error(JSON.stringify(result));
      if (epoch) {
        syncing = true;
        const replay = await request({ action: 'events', epoch, sequence: cursor });
        if (!replay.reset) {
          for (const event of replay.events) consume(event);
          for (const event of buffer.splice(0)) consume(event);
          syncing = false;
          return;
        }
      }
      await snapshot();
    })().catch((error) => console.error(`Synchronization failed: ${error.message}`))
      .finally(() => { syncing = false; synchronizing = undefined; });
  };
  peer.on('fault', (error) => console.error(error.message));
  peer.on('ready', () => console.log('Connected. /new /list /status REQUEST_ID /resume ID /approve ID /deny ID /answer ID text /abort /quit'));
  peer.on('presence', sync);
  peer.on('disconnected', () => console.error('Disconnected; reconnecting transport only. No instructions replayed.'));
  peer.on('message', (message) => {
    if (message.type === 'event' && message.from === 'agent') {
      if (syncing) buffer.push(message.event);
      else consume(message.event);
    }
  });
  peer.connect();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let inputQueue = Promise.resolve();
  const line = async (text) => {
    text = text.trim();
    if (!text) return;
    if (text === '/quit') { rl.close(); return; }
    if (text === '/list') { console.log(await request({ action: 'list' })); return; }
    if (text.startsWith('/status ')) {
      console.log(await request({ action: 'status', operationId: text.slice(8).trim() }));
      return;
    }
    if (text === '/new') {
      const result = await request({ action: 'create' });
      console.log(result);
      if (result.status === 'accepted') { sessionId = result.sessionId; epoch = undefined; await snapshot(); }
      return;
    }
    if (text.startsWith('/resume ')) {
      sessionId = text.slice(8).trim(); epoch = undefined;
      const result = await request({ action: 'resume', sessionId });
      console.log(result);
      if (result.status === 'accepted') await snapshot();
      return;
    }
    if (!sessionId) throw new Error('Use /new or /resume ID first');
    let command;
    if (text === '/abort') command = { action: 'abort', sessionId };
    else if (text.startsWith('/approve ') || text.startsWith('/deny ')) {
      command = { action: 'review', sessionId, reviewId: text.split(' ')[1], decision: text.startsWith('/approve ') };
    } else if (text.startsWith('/answer ')) {
      const match = /^\/answer (\S+) ([\s\S]+)$/.exec(text);
      if (!match) throw new Error('Use /answer ID your answer');
      command = { action: 'review', sessionId, reviewId: match[1], decision: match[2] };
    } else if (text.startsWith('/')) throw new Error('Unknown command');
    else command = { action: 'send', sessionId, prompt: text };
    console.log(await request(command));
  };
  rl.on('line', (text) => {
    inputQueue = inputQueue.then(() => line(text)).catch((error) => console.error(error.message));
  });
  rl.on('close', () => peer.close());
  process.once('SIGTERM', () => rl.close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
