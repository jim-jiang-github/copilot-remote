import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CopilotClient } from '@github/copilot-sdk';
import { Executor, identifier, ExecutorError } from './core.mjs';
import { lockDirectory } from './storage.mjs';
import { Peer } from './wire.mjs';

const object = (properties, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const string = { type: 'string' };
const definitions = [
  ['info', 'Describe PC B, its root, allowed executables and supported capabilities.', object({})],
  ['list', 'List a directory on PC B. Paths are relative to B root; use "." for root.', object({ path: string }, ['path'])],
  ['read', 'Read a UTF-8 file on PC B, maximum 512 KiB.', object({ path: string }, ['path'])],
  ['write', 'Write a UTF-8 file on PC B. Parent must exist. Explicit human approval required.',
    object({ path: string, content: string }, ['path', 'content'])],
  ['exec', 'Run an allowed executable on PC B WITHOUT a shell. No interactive stdin. Approval required.',
    object({ executable: string, args: { type: 'array', items: string }, cwd: string,
      timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 } }, ['executable', 'args'])],
];

export function remoteSessionConfig(executor, peer, sessionId) {
  const tools = definitions.map(([tool, description, parameters]) => ({
    name: `device_${tool}`, description, parameters,
    handler: async (args) => {
      const permission = await executor.review(sessionId, 'permission', {
        kind: 'remote-tool', target: 'PC B', tool, args,
      });
      if (permission.kind !== 'approve-once') {
        return { resultType: 'failure', textResultForLlm: 'Remote operation denied' };
      }
      try {
        const requestId = randomUUID();
        const result = await peer.request('device', {
          tool, args, requestId, sessionId, authorization: 'operator-approved-once',
        }, requestId);
        const success = result.status === 'completed' && !(tool === 'exec' && result.result?.exitCode !== 0);
        return {
          resultType: success ? 'success' : 'failure',
          textResultForLlm: JSON.stringify(result),
        };
      } catch (error) {
        return { resultType: 'failure', textResultForLlm: error.message, error: error.message };
      }
    },
  }));
  return {
    tools,
    availableTools: tools.map((tool) => `custom:${tool.name}`),
    excludedTools: ['builtin:*', 'mcp:*'],
    enableConfigDiscovery: false,
    enableSkills: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    enableOnDemandInstructionDiscovery: false,
    enableExperimentalMode: false,
    systemMessage: {
      mode: 'append',
      content: 'You are controlling a different private computer, PC B, through explicit device_* tools. '
        + 'Your runtime on PC A is NOT the target workspace. Never assume A files or paths describe B. '
        + 'Call device_info to learn the target. Only the advertised tools are supported. '
        + 'Browser, desktop, interactive terminals, local built-in tools and App integration are unavailable. '
        + 'All remote operations require explicit approval. A lost response is uncertain; do not rerun it automatically.',
    },
  };
}

export async function handleOperator(executor, command) {
  if (command.action === 'list') return executor.list();
  if (command.action === 'status') {
    identifier(command.operationId);
    if (!Object.hasOwn(executor.catalog.operations, command.operationId)) {
      throw new ExecutorError('Request ID not found; absence is not proof of non-execution after state loss', 404);
    }
    return executor.catalog.operations[command.operationId];
  }
  if (command.action === 'snapshot') return executor.snapshot(command.sessionId);
  if (command.action === 'events') {
    if (command.epoch !== executor.epoch || !Number.isInteger(command.sequence)
      || command.sequence < 0 || command.sequence > executor.sequence
      || command.sequence < (executor.events[0]?.sequence || 1) - 1) {
      return { reset: true, epoch: executor.epoch };
    }
    const events = executor.events.filter((event) => event.sequence > command.sequence);
    if (Buffer.byteLength(JSON.stringify(events)) > 900 * 1024) {
      return { reset: true, epoch: executor.epoch };
    }
    return { events };
  }
  return executor.execute(command);
}

export function handleAgentMessage(executor, peer, message) {
  if (message.type === 'request' && message.from === 'operator') {
    void peer.respond(message, (command) => handleOperator(executor, command));
  } else if (message.type === 'event' && message.from === 'device'
    && message.event?.type === 'device.output'
    && Object.hasOwn(executor.catalog.sessions, message.event.sessionId)) {
    executor.publish(message.event.sessionId, 'device.output', message.event.data);
  }
}

async function main() {
  if (!process.env.EXECUTOR_GITHUB_TOKEN) {
    throw new Error('Supply EXECUTOR_GITHUB_TOKEN explicitly on A; existing credentials are not used');
  }
  const directory = resolve(process.env.EXECUTOR_STATE || '.executor', 'agent');
  const release = await lockDirectory(directory);
  let peer, executor, client;
  try {
    const workspace = join(directory, 'workspace');
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    peer = new Peer({ url: process.env.EXECUTOR_RELAY, role: 'agent', secret: process.env.EXECUTOR_AGENT_TOKEN });
    client = new CopilotClient({
      mode: 'empty', baseDirectory: join(directory, 'copilot'), workingDirectory: workspace,
      // Use an explicitly supplied credential, not the existing PC App/CLI account.
      useLoggedInUser: false, gitHubToken: process.env.EXECUTOR_GITHUB_TOKEN,
    });
    executor = new Executor({
      client, directory, workspace,
      sessionConfig: (id) => remoteSessionConfig(executor, peer, id),
      onAbort: (sessionId) => peer.request('device', { action: 'cancel', sessionId }),
    });
    await executor.initialize();
    await client.start();
    const auth = await client.getAuthStatus();
    if (!auth.isAuthenticated) throw new Error('Copilot is not authenticated. Supply EXECUTOR_GITHUB_TOKEN on A.');
    peer.on('fault', (error) => console.error(error.message));
    peer.on('ready', () => console.log('Agent connected; Copilot runtime is on A, all advertised tools target B'));
    peer.on('disconnected', () => console.error('Relay disconnected; sessions retained, no prompts or tools replayed'));
    executor.on('event', (event) => {
      if (peer.ready && peer.peers.includes('operator')) {
        try { peer.send({ type: 'event', to: 'operator', event }); }
        catch (error) { console.error(error.message); }
      }
    });
    peer.on('message', (message) => handleAgentMessage(executor, peer, message));
    peer.connect();
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try {
        const cancellationErrors = [];
        for (const sessionId of executor.sessions.keys()) {
          if (peer.ready && peer.peers.includes('device')) {
            try { await peer.request('device', { action: 'cancel', sessionId }); }
            catch (error) { cancellationErrors.push(error); console.error(error.message); }
          }
        }
        await executor.close();
        if (cancellationErrors.length) throw new AggregateError(cancellationErrors, 'B cancellation was not confirmed');
      } finally { peer.close(); await release(); }
    };
    for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => {
      stop().catch((error) => { console.error(error); process.exitCode = 1; });
    });
  } catch (error) {
    peer?.close();
    if (client) {
      const errors = await client.stop();
      for (const cleanupError of errors) console.error(cleanupError);
    }
    await release();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
