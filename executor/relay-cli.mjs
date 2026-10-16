import { createInterface } from 'node:readline/promises';
import { main } from './relay.mjs';

main().catch(async (error) => {
  process.exitCode = 1;
  console.error(`Relay startup failed: ${error.message}`);
  console.error('Set EXECUTOR_AGENT_TOKEN, EXECUTOR_DEVICE_TOKEN and EXECUTOR_OPERATOR_TOKEN'
    + ' to three distinct random role tokens in PowerShell, then run .\\relay.exe.');
  if (!process.stdin.isTTY) return;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    await rl.question('Press Enter to close this window...');
  } finally {
    rl.close();
  }
});
