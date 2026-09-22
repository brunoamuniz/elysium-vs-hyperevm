import path from 'node:path';
import { CHAINS, loadConfig } from '../src/config.mjs';
import { createDashboardServer, createElysiumReader } from '../src/dashboard-server.mjs';
try {
  const config = loadConfig();
  const port = Number(process.env.ELYSIUM_DASHBOARD_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('ELYSIUM_DASHBOARD_PORT must be a valid port number');
  const bindHost = process.env.ELYSIUM_DASHBOARD_BIND_HOST ?? '127.0.0.1';
  const allowedHosts =
    process.env.ELYSIUM_DASHBOARD_ALLOWED_HOSTS?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? null;
  const hyperevmStateDir = process.env.ELYSIUM_HYPEREVM_STATE_DIR ?? CHAINS['hyperevm-testnet'].defaultStateDir;
  if (!path.isAbsolute(hyperevmStateDir)) throw new Error('ELYSIUM_HYPEREVM_STATE_DIR must be an absolute path');
  const compareSources = [
    { chain: 'elysium-testnet', stateDir: config.stateDir },
    { chain: 'hyperevm-testnet', stateDir: hyperevmStateDir },
  ];
  const dashboard = await createDashboardServer({
    stateDir: config.stateDir,
    rpc: createElysiumReader(config),
    port,
    bindHost,
    allowedHosts,
    compareSources,
  });
  console.log(JSON.stringify({ type: 'dashboard_listening', url: dashboard.url, mode: 'read-only' }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
