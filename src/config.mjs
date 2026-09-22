import path from 'node:path';
import os from 'node:os';

export const RPC_URL = 'https://rpc-elysium-testnet.t.conduit.xyz';
export const CHAIN_ID = 99801;
export const ANCHOR_BLOCK = 1n;
export const ANCHOR_HASH = '0xe46ba6c67a0e2f23669f92ad310ebc7a1530319d4c6beb59b21cf815bd9ced16';
export const KEY_ROOT = path.join(os.homedir(), '.config', 'elysium-minute-loop');
export const KEY_PATH = path.join(KEY_ROOT, 'wallet.json');
export const DEFAULT_STATE_DIR = path.join(os.homedir(), '.local', 'state', 'elysium-minute-loop');
export const DEFAULT_CHAIN = 'elysium-testnet';
export const CHAINS = Object.freeze({
  'elysium-testnet': Object.freeze({
    id: 'elysium-testnet',
    name: 'Elysium Testnet',
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
    anchorBlock: ANCHOR_BLOCK,
    anchorHash: ANCHOR_HASH,
    defaultStateDir: DEFAULT_STATE_DIR,
    rpcRequestsPerSecond: 4,
    pendingNonceIsLatest: false,
    maxNoncesAhead: null,
    feeHeadroom: 1n,
  }),
  'hyperevm-testnet': Object.freeze({
    id: 'hyperevm-testnet',
    name: 'HyperEVM Testnet',
    chainId: 998,
    rpcUrl: 'https://rpc.hyperliquid-testnet.xyz/evm',
    anchorBlock: 62_500_000n,
    anchorHash: '0x5f544cc92e86ca7c994a04e045e845912e0d2923989b559007ba36547234a08d',
    defaultStateDir: path.join(os.homedir(), '.local', 'state', 'elysium-minute-loop-hyperevm'),
    rpcRequestsPerSecond: 3,
    pendingNonceIsLatest: true,
    maxNoncesAhead: 8,
    feeHeadroom: 2n,
  }),
});
export const PROFILES = ['serial-1', 'benchmark-10'];
export const BENCHMARK_BATCH_SIZE = 10;
export const BENCHMARK_IN_FLIGHT_CAP = 20;
function exactTrue(value) {
  return value === 'true';
}
function positiveBigInt(value, name) {
  if (!/^[0-9]+$/.test(value ?? '')) throw new Error(`${name} must be an unsigned decimal integer`);
  const out = BigInt(value);
  if (out <= 0n) throw new Error(`${name} must be positive`);
  return out;
}
function boundedInt(value, name, min, max) {
  if (!/^[0-9]+$/.test(value ?? '')) throw new Error(`${name} must be an unsigned decimal integer`);
  const out = Number(value);
  if (!Number.isSafeInteger(out) || out < min || out > max)
    throw new Error(`${name} must be between ${min} and ${max}`);
  return out;
}
function stateDir(value, fallback) {
  if (value === undefined) return fallback;
  if (!value || value.includes('\0') || !path.isAbsolute(value))
    throw new Error('ELYSIUM_STATE_DIR must be a non-empty absolute local path');
  return path.resolve(value);
}
export function parseChain(argv = process.argv, env = process.env) {
  const index = argv.indexOf('--chain');
  if (index !== -1 && argv.indexOf('--chain', index + 1) !== -1) throw new Error('--chain may only be given once');
  const flag = index === -1 ? undefined : argv[index + 1];
  if (index !== -1 && !Object.hasOwn(CHAINS, flag))
    throw new Error(`--chain must be one of ${Object.keys(CHAINS).join(', ')}`);
  if (env.ELYSIUM_CHAIN !== undefined && !Object.hasOwn(CHAINS, env.ELYSIUM_CHAIN))
    throw new Error(`ELYSIUM_CHAIN must be one of ${Object.keys(CHAINS).join(', ')}`);
  if (flag !== undefined && env.ELYSIUM_CHAIN !== undefined && flag !== env.ELYSIUM_CHAIN)
    throw new Error('--chain and ELYSIUM_CHAIN disagree');
  return CHAINS[flag ?? env.ELYSIUM_CHAIN ?? DEFAULT_CHAIN];
}
export function loadConfig(env = process.env, argv = process.argv) {
  const chain = parseChain(argv, env);
  const liveEnabled = exactTrue(env.ELYSIUM_LIVE_ENABLED);
  if (env.ELYSIUM_LIVE_ENABLED !== undefined && !['true', 'false'].includes(env.ELYSIUM_LIVE_ENABLED))
    throw new Error('ELYSIUM_LIVE_ENABLED must be exactly true or false');
  return {
    chain: chain.id,
    chainName: chain.name,
    rpcUrl: chain.rpcUrl,
    chainId: chain.chainId,
    anchorBlock: chain.anchorBlock,
    anchorHash: chain.anchorHash,
    keyPath: KEY_PATH,
    stateDir: stateDir(env.ELYSIUM_STATE_DIR, chain.defaultStateDir),
    liveEnabled,
    maxGas: positiveBigInt(env.ELYSIUM_MAX_GAS || '300000', 'ELYSIUM_MAX_GAS'),
    maxFeePerGas: positiveBigInt(env.ELYSIUM_MAX_FEE_PER_GAS || '5000000000', 'ELYSIUM_MAX_FEE_PER_GAS'),
    maxTxCost: positiveBigInt(env.ELYSIUM_MAX_TX_COST || '1000000000000000', 'ELYSIUM_MAX_TX_COST'),
    minGasReserve: positiveBigInt(env.ELYSIUM_MIN_GAS_RESERVE || '10000000000000000', 'ELYSIUM_MIN_GAS_RESERVE'),
    dailyCostLimit: positiveBigInt(env.ELYSIUM_DAILY_COST_LIMIT || '10000000000000000', 'ELYSIUM_DAILY_COST_LIMIT'),
    confirmations: 2,
  };
}
export function assertLive(config, argv = process.argv) {
  if (!config.liveEnabled || !argv.includes('--live'))
    throw new Error('Live write disabled: require ELYSIUM_LIVE_ENABLED=true and --live');
}

export function parseProfile(argv = process.argv) {
  const index = argv.indexOf('--profile');
  if (index === -1) return 'serial-1';
  if (argv.indexOf('--profile', index + 1) !== -1) throw new Error('--profile may only be given once');
  const value = argv[index + 1];
  if (!PROFILES.includes(value)) throw new Error('--profile must be exactly serial-1 or benchmark-10');
  return value;
}

export function loadBenchmarkConfig(env = process.env, argv = process.argv) {
  if (env.ELYSIUM_BENCHMARK_ENABLED !== undefined && !['true', 'false'].includes(env.ELYSIUM_BENCHMARK_ENABLED))
    throw new Error('ELYSIUM_BENCHMARK_ENABLED must be exactly true or false');
  return {
    profile: parseProfile(argv),
    enabled: exactTrue(env.ELYSIUM_BENCHMARK_ENABLED),
    batchSize: BENCHMARK_BATCH_SIZE,
    inFlightCap: BENCHMARK_IN_FLIGHT_CAP,
    maxTxCost: positiveBigInt(env.ELYSIUM_BENCHMARK_MAX_TX_COST || '1500000000000000', 'ELYSIUM_BENCHMARK_MAX_TX_COST'),
    dailyCostLimit: positiveBigInt(
      env.ELYSIUM_BENCHMARK_DAILY_COST_LIMIT || '60000000000000000',
      'ELYSIUM_BENCHMARK_DAILY_COST_LIMIT',
    ),
    pollIntervalMs: boundedInt(env.ELYSIUM_BENCHMARK_POLL_MS || '2000', 'ELYSIUM_BENCHMARK_POLL_MS', 250, 30_000),
    watchIntervalMs: boundedInt(env.ELYSIUM_BENCHMARK_WATCH_MS || '500', 'ELYSIUM_BENCHMARK_WATCH_MS', 200, 10_000),
    stuckNonceHoldMs: boundedInt(
      env.ELYSIUM_BENCHMARK_STUCK_MS || '300000',
      'ELYSIUM_BENCHMARK_STUCK_MS',
      30_000,
      3_600_000,
    ),
    rpcRetryAttempts: boundedInt(env.ELYSIUM_BENCHMARK_RPC_RETRIES || '3', 'ELYSIUM_BENCHMARK_RPC_RETRIES', 1, 10),
    rpcBackoffMs: boundedInt(
      env.ELYSIUM_BENCHMARK_RPC_BACKOFF_MS || '500',
      'ELYSIUM_BENCHMARK_RPC_BACKOFF_MS',
      50,
      30_000,
    ),
    clockDriftToleranceMs: boundedInt(
      env.ELYSIUM_BENCHMARK_DRIFT_MS || '2000',
      'ELYSIUM_BENCHMARK_DRIFT_MS',
      100,
      60_000,
    ),
    activeActionLimit: boundedInt(
      env.ELYSIUM_BENCHMARK_ACTIVE_LIMIT || '400',
      'ELYSIUM_BENCHMARK_ACTIVE_LIMIT',
      50,
      5_000,
    ),
  };
}

export function assertBenchmarkLive(config, benchmark, argv = process.argv) {
  assertLive(config, argv);
  if (benchmark.profile !== 'benchmark-10') throw new Error('Benchmark mode requires --profile benchmark-10');
  if (!benchmark.enabled) throw new Error('Benchmark mode requires ELYSIUM_BENCHMARK_ENABLED=true');
}

export function redact(value) {
  return String(value)
    .replace(/0x[a-fA-F0-9]{64,}/g, '0x[REDACTED]')
    .replace(/https?:\/\/[^\s]+/g, '[RPC_URL]');
}
