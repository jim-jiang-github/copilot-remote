import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CopilotClient } from '@github/copilot-sdk';
import { Executor } from '../core.mjs';
import { DeviceTools } from '../device-tools.mjs';
import { handleAgentMessage, remoteSessionConfig } from '../agent.mjs';
import { cleanupTemporary, network, temporary } from './helpers.mjs';

test('real bundled runtime → authenticated relay → real B filesystem and process; restore and deny local tools',
  { timeout: 90_000 }, async (t) => {
    const directory = await temporary(t);
    const target = join(directory, 'target-B');
    const agentDirectory = join(directory, 'agent-A');
    await mkdir(target);
    await mkdir(agentDirectory);
    const { peers } = await network(t);
    let deviceApprovals = 0, operatorApprovals = 0;
    const device = new DeviceTools({
      root: target, directory, executables: [process.execPath],
      approve: async () => { deviceApprovals++; return true; },
      onOutput: (command, stream, text) => peers.device.send({
        type: 'event', to: 'agent', event: {
          sessionId: command.sessionId, type: 'device.output', data: { stream, text },
        },
      }),
    });
    await device.initialize();
    t.after(() => device.close());
    peers.device.on('message', (message) => {
      void peers.device.respond(message, (command) => device.execute(command));
    });
    const client = new CopilotClient({
      mode: 'empty', workingDirectory: agentDirectory,
      baseDirectory: join(agentDirectory, 'copilot'),
      useLoggedInUser: false,
      env: { ...process.env, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, COPILOT_GITHUB_TOKEN: undefined },
    });
    const executor = new Executor({
      client, directory: agentDirectory, workspace: agentDirectory,
      sessionConfig: (id) => remoteSessionConfig(executor, peers.agent, id),
    });
    await executor.initialize();
    t.after(() => executor.close());
    cleanupTemporary(t, directory);
    await client.start();
    assert.equal((await client.getAuthStatus()).isAuthenticated, false);
    peers.agent.on('message', (message) => handleAgentMessage(executor, peers.agent, message));
    executor.on('event', (event) => {
      if (peers.agent.ready && peers.agent.peers.includes('operator')) {
        peers.agent.send({ type: 'event', to: 'operator', event });
      }
    });
    const approvalErrors = [];
    const liveOutput = [];
    peers.operator.on('message', (message) => {
      if (message.type === 'event' && message.event.type === 'device.output') {
        liveOutput.push(message.event.data.text);
      }
      if (message.type === 'event' && message.event.type === 'executor.review') {
        operatorApprovals++;
        void peers.operator.request('agent', {
          action: 'review', sessionId: message.event.sessionId,
          reviewId: message.event.data.requestId, requestId: randomUUID(), decision: true,
        }).catch((error) => approvalErrors.push(error));
      }
    });
    const created = await peers.operator.request('agent', { action: 'create', requestId: randomUUID() });
    assert.equal(created.status, 'accepted');
    const id = created.sessionId;
    let session = executor.sessions.get(id);
    const call = (name, args) => session.rpc.tools.execute({ name, arguments: args });
    const info = await call('device_info', {});
    console.log('REAL runtime tool result:', JSON.stringify(info));
    const write = await call('device_write', { path: 'roundtrip.txt', content: 'remote SDK roundtrip' });
    console.log('REAL write result:', JSON.stringify(write));
    assert.ok(JSON.stringify(write).includes('completed'), JSON.stringify(write));
    assert.equal(await readFile(join(target, 'roundtrip.txt'), 'utf8'), 'remote SDK roundtrip');
    await assert.rejects(readFile(join(agentDirectory, 'roundtrip.txt')), { code: 'ENOENT' });
    const processResult = await call('device_exec', {
      executable: process.execPath, args: ['-e', 'console.log("SDK-B-PROCESS")'],
    });
    assert.ok(JSON.stringify(processResult).includes('SDK-B-PROCESS'), JSON.stringify(processResult));
    assert.ok(liveOutput.join('').includes('SDK-B-PROCESS'));
    assert.equal(deviceApprovals, 3);
    assert.equal(operatorApprovals, 6);
    assert.deepEqual(approvalErrors, []);
    for (const [name, args] of [['powershell', { command: 'Write-Output forbidden' }],
      ['view', { path: agentDirectory }]]) {
      const denied = await call(name, args);
      console.log(`Disabled ${name}:`, JSON.stringify(denied));
      assert.equal(denied.resultType, 'failure');
      assert.match(JSON.stringify(denied), /not.*(available|found|offered)|unknown|disabled/i);
    }
    await session.disconnect();
    executor.sessions.delete(id);
    const stopErrors = await client.stop();
    assert.deepEqual(stopErrors, []);
    await client.start();
    const resumed = await peers.operator.request('agent', { action: 'resume', sessionId: id, requestId: randomUUID() });
    assert.equal(resumed.status, 'accepted');
    session = executor.sessions.get(id);
    const read = await call('device_read', { path: 'roundtrip.txt' });
    assert.ok(JSON.stringify(read).includes('remote SDK roundtrip'), JSON.stringify(read));
    assert.equal((await executor.snapshot(id)).epoch, executor.epoch);
    console.log('Verified: SDK session create/runtime restart/resume, custom tools over three-role relay, B-only writes/exec, A built-ins rejected.');
  });
