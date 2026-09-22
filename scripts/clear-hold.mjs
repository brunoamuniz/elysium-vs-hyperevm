import { loadConfig, redact } from '../src/config.mjs';
import { loadWallet } from '../src/wallet.mjs';
import { clearBenchmarkHold } from '../src/benchmark.mjs';
import { compileMinutePulse } from '../src/contract.mjs';
import { clients, verifyNetwork } from '../src/elysium.mjs';

function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

try {
  const config = loadConfig();
  const account = await loadWallet(config.keyPath);
  const { publicClient } = clients(account, config);
  await verifyNetwork(publicClient, config);
  const result = await clearBenchmarkHold({
    config,
    account,
    artifact: compileMinutePulse(),
    chain: publicClient,
    type: flag('--type'),
    nonce: flag('--nonce'),
    reason: flag('--reason'),
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
}
