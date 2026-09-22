import { assertLive, loadConfig } from '../src/config.mjs';
import { loadWallet } from '../src/wallet.mjs';
import { pulseOnce } from '../src/run-once.mjs';
try {
  const config = loadConfig();
  assertLive(config);
  const result = await pulseOnce(await loadWallet(config.keyPath), config);
  console.log(JSON.stringify({ status: result.status, hash: result.hash, slot: result.slot }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
