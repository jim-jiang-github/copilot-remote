import { main, reportStartupFailure } from './device.mjs';

main().catch((error) => {
  process.exitCode = 1;
  return reportStartupFailure(error);
});
