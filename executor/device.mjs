import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DeviceTools } from './device-tools.mjs';
import { lockDirectory } from './storage.mjs';
import { Peer } from './wire.mjs';

export async function terminalApproval(command, signal) {
  if (!process.stdin.isTTY) {
    console.error(`Denied ${command.tool}: device approval requires an interactive terminal`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const timeout = AbortSignal.timeout(300_000);
  try {
    console.log(`\nREMOTE REQUEST (untrusted arguments):\n${JSON.stringify(command, null, 2)}`);
    return (await rl.question('Approve this request ONCE? Type yes: ', {
      signal: AbortSignal.any([signal, timeout]),
    })) === 'yes';
  } catch (error) {
    if (!signal.aborted && !timeout.aborted) throw error;
    console.error('Approval cancelled or expired; denied');
    return false;
  } finally { rl.close(); }
}

export function approvalFor(mode) {
  if (mode === 'terminal') return terminalApproval;
  if (mode !== 'operator') throw new Error('EXECUTOR_APPROVAL must be terminal or operator');
  return async (command) => {
    if (command.authorization !== 'operator-approved-once') {
      console.error('Denied request without paired A operator approval');
      return false;
    }
    console.log(`Paired A reports explicit operator approval: ${command.requestId} ${command.tool}`);
    return true;
  };
}

async function main() {
  if (!process.env.EXECUTOR_ROOT) throw new Error('Set EXECUTOR_ROOT to the target workspace on B');
  const approvalMode = process.env.EXECUTOR_APPROVAL || 'terminal';
  const approve = approvalFor(approvalMode);
  const directory = resolve(process.env.EXECUTOR_STATE || '.executor', 'device');
  const release = await lockDirectory(directory);
  let device, peer;
  try {
    device = new DeviceTools({
      root: resolve(process.env.EXECUTOR_ROOT), directory, approve,
      executables: JSON.parse(process.env.EXECUTOR_EXECUTABLES || '[]'),
      onOutput: (command, stream, text) => {
        if (peer?.ready && peer.peers.includes('agent')) {
          try {
            peer.send({ type: 'event', to: 'agent', event: {
              sessionId: command.sessionId, type: 'device.output',
              data: { requestId: command.requestId, stream, text },
            } });
          } catch (error) { console.error(`Live output delivery failed: ${error.message}`); }
        }
      },
    });
    await device.initialize();
    peer = new Peer({
      url: process.env.EXECUTOR_RELAY, role: 'device', secret: process.env.EXECUTOR_DEVICE_TOKEN,
    });
    peer.on('fault', (error) => console.error(error.message));
    peer.on('ready', () => console.log(`Device connected; root ${device.root}; approval mode: ${approvalMode}`));
    peer.on('disconnected', () => console.error('Relay disconnected; pending work is not replayed'));
    peer.on('message', (message) => {
      if (message.type === 'request' && message.from === 'agent') {
        void peer.respond(message, (command) => command.action === 'cancel'
          ? device.cancelSession(command.sessionId) : device.execute(command));
      }
    });
    peer.connect();
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      peer.close();
      try { await device.close(); }
      finally { await release(); }
    };
    for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => {
      stop().catch((error) => { console.error(error); process.exitCode = 1; });
    });
  } catch (error) {
    peer?.close();
    await device?.close();
    await release();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
