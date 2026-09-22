import { loadConfig } from '../src/config.mjs';
import { clients, verifyNetwork } from '../src/elysium.mjs';
try {
  const config = loadConfig();
  const { publicClient } = clients(undefined, config);
  console.log(JSON.stringify(await verifyNetwork(publicClient, config)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
