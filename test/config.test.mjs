import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertBenchmarkLive,
  assertLive,
  CHAIN_ID,
  loadBenchmarkConfig,
  loadConfig,
  parseProfile,
  redact,
} from '../src/config.mjs';
import { pulseOnce } from '../src/run-once.mjs';

test('config is pinned to the Elysium testnet', () => {
  const config = loadConfig({});
  assert.equal(config.chainId, CHAIN_ID);
  assert.equal(config.rpcUrl, 'https://rpc-elysium-testnet.t.conduit.xyz');
  assert.equal(config.liveEnabled, false);
});
test('live config fails closed on malformed boolean and bad state paths', () => {
  assert.throws(() => loadConfig({ ELYSIUM_LIVE_ENABLED: 'yes' }));
  assert.throws(() => loadConfig({ ELYSIUM_STATE_DIR: 'relative' }));
  assert.throws(() => loadConfig({ ELYSIUM_STATE_DIR: '' }));
});
test('direct write API requires both live gates before using network', async () => {
  await assert.rejects(() => pulseOnce({}, { liveEnabled: false }, new Date(), ['node']), /Live write disabled/);
  assert.throws(() => assertLive({ liveEnabled: true }, ['node']), /Live write disabled/);
});
test('redaction removes private keys and URLs', () => {
  const text = redact('https://secret.example/x 0x' + 'a'.repeat(64));
  assert.ok(!text.includes('secret.example'));
  assert.ok(!text.includes('a'.repeat(64)));
});

test('the default profile is serial-1 and only the two documented profiles parse', () => {
  assert.equal(parseProfile(['node', 'loop.mjs', '--live']), 'serial-1');
  assert.equal(parseProfile(['node', 'loop.mjs', '--live', '--profile', 'benchmark-10']), 'benchmark-10');
  assert.throws(() => parseProfile(['node', 'loop.mjs', '--profile', 'benchmark-100']), /--profile must be exactly/);
  assert.throws(() => parseProfile(['node', 'loop.mjs', '--profile']), /--profile must be exactly/);
  assert.throws(
    () => parseProfile(['node', 'loop.mjs', '--profile', 'serial-1', '--profile', 'benchmark-10']),
    /only be given once/,
  );
});

test('benchmark mode needs both live gates plus the env gate and the explicit profile flag', () => {
  const argv = ['node', 'loop.mjs', '--live', '--profile', 'benchmark-10'];
  const enabled = loadBenchmarkConfig({ ELYSIUM_BENCHMARK_ENABLED: 'true' }, argv);
  assert.throws(() => assertBenchmarkLive({ liveEnabled: false }, enabled, argv), /Live write disabled/);
  assert.throws(
    () => assertBenchmarkLive({ liveEnabled: true }, enabled, ['node', 'loop.mjs', '--profile', 'benchmark-10']),
    /Live write disabled/,
  );
  assert.throws(
    () => assertBenchmarkLive({ liveEnabled: true }, loadBenchmarkConfig({}, argv), argv),
    /ELYSIUM_BENCHMARK_ENABLED=true/,
  );
  assert.throws(
    () =>
      assertBenchmarkLive(
        { liveEnabled: true },
        loadBenchmarkConfig({ ELYSIUM_BENCHMARK_ENABLED: 'true' }, ['node', 'loop.mjs', '--live']),
        ['node', 'loop.mjs', '--live'],
      ),
    /--profile benchmark-10/,
  );
  assert.doesNotThrow(() => assertBenchmarkLive({ liveEnabled: true }, enabled, argv));
  assert.throws(() => loadBenchmarkConfig({ ELYSIUM_BENCHMARK_ENABLED: 'yes' }, argv), /exactly true or false/);
});

test('benchmark limits are explicit overrides with bounded, validated values', () => {
  const argv = ['node', 'loop.mjs', '--live', '--profile', 'benchmark-10'];
  const defaults = loadBenchmarkConfig({}, argv);
  assert.equal(defaults.batchSize, 10);
  assert.equal(defaults.inFlightCap, 20);
  assert.ok(
    defaults.dailyCostLimit > defaults.maxTxCost * 10n,
    'the benchmark daily budget must preflight a whole batch',
  );
  assert.equal(loadBenchmarkConfig({ ELYSIUM_BENCHMARK_DAILY_COST_LIMIT: '123' }, argv).dailyCostLimit, 123n);
  assert.throws(() => loadBenchmarkConfig({ ELYSIUM_BENCHMARK_DAILY_COST_LIMIT: '0' }, argv), /must be positive/);
  assert.throws(() => loadBenchmarkConfig({ ELYSIUM_BENCHMARK_POLL_MS: '10' }, argv), /between 250 and 30000/);
  assert.throws(() => loadBenchmarkConfig({ ELYSIUM_BENCHMARK_STUCK_MS: '-1' }, argv), /unsigned decimal integer/);
  assert.equal(loadConfig({}).dailyCostLimit, 10_000_000_000_000_000n, 'the serial default budget is untouched');
});

test('chains come from a frozen registry and --chain or ELYSIUM_CHAIN select one pinned entry', async () => {
  const { CHAINS } = await import('../src/config.mjs');
  assert.ok(Object.isFrozen(CHAINS) && Object.values(CHAINS).every(Object.isFrozen));
  const elysium = loadConfig({}, ['node', 'loop.mjs']);
  assert.equal(elysium.chain, 'elysium-testnet');
  assert.equal(elysium.chainId, 99801);
  const hyper = loadConfig({}, ['node', 'loop.mjs', '--chain', 'hyperevm-testnet']);
  assert.equal(hyper.chainId, 998);
  assert.equal(hyper.rpcUrl, 'https://rpc.hyperliquid-testnet.xyz/evm');
  assert.equal(hyper.anchorBlock, 62_500_000n);
  assert.ok(hyper.stateDir.endsWith('elysium-minute-loop-hyperevm'));
  assert.notEqual(hyper.stateDir, elysium.stateDir);
  assert.equal(loadConfig({ ELYSIUM_CHAIN: 'hyperevm-testnet' }, ['node']).chainId, 998);
  assert.equal(
    loadConfig({ ELYSIUM_RPC_URL: 'https://evil.example', ELYSIUM_CHAIN_ID: '1' }, ['node']).rpcUrl,
    'https://rpc-elysium-testnet.t.conduit.xyz',
    'env cannot override a pin',
  );
});

test('chain selection fails closed on unknown, repeated or conflicting values', () => {
  assert.throws(() => loadConfig({}, ['node', '--chain', 'mainnet']), /--chain must be one of/);
  assert.throws(() => loadConfig({}, ['node', '--chain']), /--chain must be one of/);
  assert.throws(
    () => loadConfig({}, ['node', '--chain', 'hyperevm-testnet', '--chain', 'elysium-testnet']),
    /only be given once/,
  );
  assert.throws(() => loadConfig({ ELYSIUM_CHAIN: 'x' }, ['node']), /ELYSIUM_CHAIN must be one of/);
  assert.throws(
    () => loadConfig({ ELYSIUM_CHAIN: 'elysium-testnet' }, ['node', '--chain', 'hyperevm-testnet']),
    /disagree/,
  );
});

test('rpc clients refuse any config that does not match a pinned registry entry', async () => {
  const { clients } = await import('../src/elysium.mjs');
  const hyper = loadConfig({}, ['node', '--chain', 'hyperevm-testnet']);
  assert.doesNotThrow(() => clients(undefined, hyper));
  assert.throws(() => clients(undefined, undefined), /pinned chain/);
  assert.throws(() => clients(undefined, { ...hyper, rpcUrl: 'https://evil.example' }), /pinned chain/);
  assert.throws(() => clients(undefined, { ...hyper, chainId: 99801 }), /pinned chain/);
});

test('verifyNetwork fails closed on a chain id or anchor mismatch for each chain', async () => {
  const { verifyNetwork } = await import('../src/elysium.mjs');
  for (const argv of [['node'], ['node', '--chain', 'hyperevm-testnet']]) {
    const config = loadConfig({}, argv);
    const client = (chainId, hash) => ({
      getChainId: async () => chainId,
      getBlock: async ({ blockNumber }) => {
        assert.equal(blockNumber, config.anchorBlock);
        return { hash };
      },
    });
    await assert.doesNotReject(() => verifyNetwork(client(config.chainId, config.anchorHash), config));
    await assert.rejects(
      () => verifyNetwork(client(config.chainId === 998 ? 99801 : 998, config.anchorHash), config),
      /unexpected chain ID/,
    );
    await assert.rejects(
      () => verifyNetwork(client(config.chainId, `0x${'00'.repeat(32)}`), config),
      /anchor block hash mismatch/,
    );
  }
});
