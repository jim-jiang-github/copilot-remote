import { joinSession } from '@github/copilot-sdk/extension';
import { startRelay } from '../../../relay.mjs';

await startRelay(joinSession);
