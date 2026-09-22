import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildDashboardPayload,
  collectDashboard,
  confirmationLatency,
  deriveServiceState,
  LATENCY_MIN_SAMPLES,
  LATENCY_SAMPLE_LIMIT,
  readChain,
  readDashboardState,
  STALE_AFTER_MS,
} from '../src/dashboard-data.mjs';

const WALLET = '0x00000000000000000000000000000000000000a1';
const CONTRACT = '0x00000000000000000000000000000000000000b2';
const CANARY = 'CANARY_MUST_NOT_LEAK';
const NOW = new Date('2026-09-22T12:00:00.000Z');

function pulse(index, { status = 'finalized', broadcastAt, finalizedAt, extra = {} } = {}) {
  const minute = String(index).padStart(2, '0');
  const base = Date.parse(`2026-09-22T11:${minute}:00.000Z`);
  return {
    id: `pulse:2026-09-22T11:${minute}Z`,
    kind: 'pulse',
    slot: `2026-09-22T11:${minute}Z`,
    status,
    nonce: String(index),
    to: CONTRACT,
    data: `0x${CANARY.length.toString(16)}${'ab'.repeat(20)}${CANARY}`,
    raw: `0x02f8${'cd'.repeat(60)}${CANARY}`,
    expected: {
      contractAddress: CONTRACT,
      entropy: `0x${'ef'.repeat(32)}`,
      countAfter: String(index),
      secretNote: CANARY,
    },
    hash: `0x${String(index).padStart(2, '0').repeat(32)}`,
    createdAt: new Date(base).toISOString(),
    broadcastAt: broadcastAt === undefined ? new Date(base + 500).toISOString() : broadcastAt,
    finalizedAt: finalizedAt === undefined ? new Date(base + 500 + index * 100 + 1000).toISOString() : finalizedAt,
    receipt: { blockNumber: String(1000 + index), blockHash: `0x${'aa'.repeat(32)}` },
    worstCost: '210000000000000',
    undocumentedField: CANARY,
    ...extra,
  };
}

function stateWith(actions, overrides = {}) {
  return {
    version: 1,
    walletAddress: WALLET,
    deployment: {
      address: CONTRACT,
      runtimeHash: `0x${'11'.repeat(32)}`,
      txHash: `0x${'22'.repeat(32)}`,
      blockNumber: '900',
      blockHash: `0x${'33'.repeat(32)}`,
      secretNote: CANARY,
    },
    actions,
    dailySpend: { '2026-09-22': '4200000000000000' },
    rpcUrl: 'https://rpc-elysium-testnet.t.conduit.xyz',
    keyPath: '/home/user/.config/elysium-minute-loop/wallet.json',
    privateKey: `0x${'99'.repeat(32)}`,
    undocumentedTopLevel: CANARY,
    ...overrides,
  };
}

const okChain = { balanceWei: '123456789000000000', blockNumber: '1200', pulseCount: '9', unavailable: null };

async function tempStateDir(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elysium-dashboard-'));
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  return dir;
}

test('payload omits raw transactions, calldata, expected payloads, keys and unknown state fields', () => {
  const payload = buildDashboardPayload({
    read: { state: stateWith([pulse(1), pulse(2)]), halted: false, unavailable: null },
    chain: okChain,
    now: NOW,
  });
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes(CANARY), 'canary leaked into serialized payload');
  for (const forbidden of [
    '"raw"',
    '"data"',
    '"expected"',
    'privateKey',
    'keyPath',
    'wallet.json',
    'entropy',
    'runtimeHash',
    'conduit.xyz',
    'rpcUrl',
    'undocumented',
    'blockHash',
    'dailySpend',
  ]) {
    assert.ok(!serialized.includes(forbidden), `payload exposed ${forbidden}`);
  }
  assert.deepEqual(Object.keys(payload).sort(), [
    'archive',
    'benchmark',
    'contract',
    'generatedAt',
    'hold',
    'journal',
    'latency',
    'network',
    'onchain',
    'service',
    'transactions',
    'unavailable',
    'wallet',
  ]);
  assert.deepEqual(Object.keys(payload.transactions[0]).sort(), [
    'actualCostWei',
    'blockNumber',
    'broadcastAt',
    'createdAt',
    'finalizedAt',
    'hash',
    'id',
    'includedAt',
    'kind',
    'latencyMs',
    'nonce',
    'quality',
    'slot',
    'status',
    'worstCostWei',
  ]);
});

test('a canary hidden in id, slot or timestamps is rejected rather than serialized', () => {
  const tainted = pulse(3, { extra: { id: `pulse:${CANARY} <script>`, slot: `${CANARY} slot`, createdAt: CANARY } });
  const payload = buildDashboardPayload({
    read: { state: stateWith([tainted]), halted: false, unavailable: null },
    chain: okChain,
    now: NOW,
  });
  assert.ok(!JSON.stringify(payload).includes(CANARY));
  assert.equal(payload.transactions[0].id, null);
  assert.equal(payload.transactions[0].slot, null);
  assert.equal(payload.transactions[0].createdAt, null);
});

test('service state is derived only from durable disk facts in documented precedence', () => {
  const finalized = [pulse(1), pulse(2)];
  const fresh = [pulse(1, { finalizedAt: new Date(NOW.getTime() - 30_000).toISOString() })];
  const nowMs = NOW.getTime();
  assert.equal(deriveServiceState({ state: stateWith(fresh), halted: true, unavailable: null, nowMs }), 'halted');
  assert.equal(
    deriveServiceState({
      state: stateWith([pulse(1, { status: 'reconcile_required' })]),
      halted: false,
      unavailable: null,
      nowMs,
    }),
    'reconcile_required',
  );
  assert.equal(
    deriveServiceState({
      state: stateWith([
        pulse(1, { status: 'broadcast', broadcastAt: new Date(nowMs - 30_000).toISOString(), finalizedAt: null }),
      ]),
      halted: false,
      unavailable: null,
      nowMs,
    }),
    'pending',
  );
  assert.equal(
    deriveServiceState({
      state: stateWith([pulse(1, { status: 'broadcast', finalizedAt: null })]),
      halted: false,
      unavailable: null,
      nowMs,
    }),
    'stale',
    'an in-flight action with no recent journal activity does not mask a stale loop',
  );
  assert.equal(
    deriveServiceState({ state: stateWith([], { deployment: null }), halted: false, unavailable: null, nowMs }),
    'not_deployed',
  );
  assert.equal(deriveServiceState({ state: stateWith(fresh), halted: false, unavailable: null, nowMs }), 'active');
  assert.equal(deriveServiceState({ state: stateWith(finalized), halted: false, unavailable: null, nowMs }), 'stale');
  assert.equal(
    deriveServiceState({ state: stateWith(fresh), halted: false, unavailable: 'missing', nowMs }),
    'unknown',
  );
  const edge = [pulse(1, { finalizedAt: new Date(nowMs - STALE_AFTER_MS).toISOString() })];
  assert.equal(deriveServiceState({ state: stateWith(edge), halted: false, unavailable: null, nowMs }), 'active');
});

test('loop liveness is reported as not journaled and never inferred', () => {
  const payload = buildDashboardPayload({
    read: { state: stateWith([pulse(1)]), halted: false, unavailable: null },
    chain: okChain,
    now: NOW,
  });
  assert.equal(payload.service.loopLiveness, 'not_journaled');
});

test('confirmation latency uses nearest-rank percentiles over bounded pulse samples', () => {
  const few = stateWith([pulse(1), pulse(2), pulse(3), pulse(4)]);
  assert.equal(confirmationLatency(few).samples, 4);
  assert.equal(confirmationLatency(few).p50Ms, null);
  assert.equal(confirmationLatency(few).p95Ms, null);

  const actions = [];
  for (let index = 1; index <= 10; index += 1) {
    const base = Date.parse('2026-09-22T11:00:00.000Z') + index * 60_000;
    actions.push({
      ...pulse(index),
      broadcastAt: new Date(base).toISOString(),
      finalizedAt: new Date(base + index * 1000).toISOString(),
    });
  }
  const latency = confirmationLatency(stateWith(actions));
  assert.equal(latency.samples, 10);
  assert.equal(latency.measure, 'broadcast_to_finalized');
  assert.equal(latency.confirmations, 2);
  assert.equal(latency.p50Ms, 5000);
  assert.equal(latency.p95Ms, 10000);
  assert.equal(latency.lastMs, 10000);
  assert.equal(latency.minSamples, LATENCY_MIN_SAMPLES);
});

test('latency excludes deployments, unfinalized actions, invalid and negative timestamps', () => {
  const base = Date.parse('2026-09-22T11:00:00.000Z');
  const good = [];
  for (let index = 1; index <= 5; index += 1) {
    good.push({
      ...pulse(index),
      broadcastAt: new Date(base + index * 60_000).toISOString(),
      finalizedAt: new Date(base + index * 60_000 + 2000).toISOString(),
    });
  }
  const noisy = [
    {
      ...pulse(6),
      kind: 'deploy',
      slot: 'deploy-1',
      broadcastAt: new Date(base).toISOString(),
      finalizedAt: new Date(base + 999_000).toISOString(),
    },
    { ...pulse(7), status: 'broadcast', finalizedAt: null },
    { ...pulse(8), broadcastAt: 'not-a-date' },
    { ...pulse(9), broadcastAt: new Date(base + 5000).toISOString(), finalizedAt: new Date(base).toISOString() },
  ];
  const latency = confirmationLatency(stateWith([...good, ...noisy]));
  assert.equal(latency.samples, 5);
  assert.equal(latency.p50Ms, 2000);
  assert.equal(latency.p95Ms, 2000);
});

test('latency window is capped at the configured sample limit', () => {
  const base = Date.parse('2026-09-22T00:00:00.000Z');
  const actions = [];
  for (let index = 0; index < LATENCY_SAMPLE_LIMIT + 50; index += 1) {
    actions.push({
      ...pulse(1),
      id: `pulse:${index}`,
      slot: `slot-${index}`,
      broadcastAt: new Date(base + index * 60_000).toISOString(),
      finalizedAt: new Date(base + index * 60_000 + 1000).toISOString(),
    });
  }
  assert.equal(confirmationLatency(stateWith(actions)).samples, LATENCY_SAMPLE_LIMIT);
});

test('chain quantities are returned as decimal strings', () => {
  const payload = buildDashboardPayload({
    read: { state: stateWith([pulse(1)]), halted: false, unavailable: null },
    chain: { balanceWei: '10', blockNumber: '11', pulseCount: '12', unavailable: null },
    now: NOW,
  });
  for (const value of [
    payload.wallet.balanceWei,
    payload.onchain.blockNumber,
    payload.onchain.pulseCount,
    payload.journal.todaySpendWei,
    payload.transactions[0].worstCostWei,
    payload.transactions[0].nonce,
  ]) {
    assert.equal(typeof value, 'string');
    assert.match(value, /^[0-9]+$/);
  }
  assert.equal(payload.journal.todaySpendWei, '4200000000000000');
});

test('readChain normalizes bigint results and caps reads at three calls', async () => {
  const calls = [];
  const rpc = {
    getBlockNumber: () => {
      calls.push('block');
      return Promise.resolve(1234n);
    },
    getBalance: (address) => {
      calls.push(`balance:${address}`);
      return Promise.resolve(5n);
    },
    getPulseCount: (address) => {
      calls.push(`count:${address}`);
      return Promise.resolve(7n);
    },
  };
  const chain = await readChain({ rpc, walletAddress: WALLET, contractAddress: CONTRACT });
  assert.deepEqual(chain, { balanceWei: '5', blockNumber: '1234', pulseCount: '7', unavailable: null });
  assert.equal(calls.length, 3);
});

test('rpc failures become a typed unavailable field and never forward error text', async () => {
  const rpc = {
    getBlockNumber: () => Promise.reject(new Error(`boom ${CANARY} https://rpc-elysium-testnet.t.conduit.xyz`)),
    getBalance: () => Promise.resolve(1n),
    getPulseCount: () => Promise.resolve(1n),
  };
  const chain = await readChain({ rpc, walletAddress: WALLET, contractAddress: CONTRACT });
  assert.deepEqual(chain, { balanceWei: null, blockNumber: null, pulseCount: null, unavailable: 'unreachable' });
  const payload = buildDashboardPayload({
    read: { state: stateWith([pulse(1)]), halted: false, unavailable: null },
    chain,
    now: NOW,
  });
  assert.equal(payload.unavailable.rpc, 'unreachable');
  assert.ok(!JSON.stringify(payload).includes(CANARY));
});

test('missing state is typed as partial data and not reported as not_deployed', async () => {
  const dir = await tempStateDir();
  const read = await readDashboardState(dir);
  assert.deepEqual(read, { state: null, halted: false, unavailable: 'missing' });
  const payload = buildDashboardPayload({
    read,
    chain: { balanceWei: null, blockNumber: null, pulseCount: null, unavailable: 'unreachable' },
    now: NOW,
  });
  assert.equal(payload.unavailable.state, 'missing');
  assert.equal(payload.service.state, 'unknown');
  assert.equal(payload.contract.address, null);
  assert.equal(payload.wallet.address, null);
  assert.deepEqual(payload.transactions, []);
  await fs.rm(dir, { recursive: true });
});

test('invalid state is typed as invalid and never parsed into the payload', async () => {
  const dir = await tempStateDir({ 'state.json': `{"version":99,"actions":"${CANARY}","dailySpend":{}}` });
  const read = await readDashboardState(dir);
  assert.equal(read.unavailable, 'invalid');
  assert.equal(read.state, null);
  const payload = buildDashboardPayload({ read, chain: okChain, now: NOW });
  assert.ok(!JSON.stringify(payload).includes(CANARY));
  assert.equal(payload.service.state, 'unknown');

  const broken = await tempStateDir({ 'state.json': `not json ${CANARY}` });
  assert.equal((await readDashboardState(broken)).unavailable, 'invalid');
  await fs.rm(dir, { recursive: true });
  await fs.rm(broken, { recursive: true });
});

test('HALT file presence is read from disk and wins over a valid journal', async () => {
  const dir = await tempStateDir({ 'state.json': JSON.stringify(stateWith([pulse(1)])), HALT: '' });
  const read = await readDashboardState(dir);
  assert.equal(read.halted, true);
  const payload = buildDashboardPayload({ read, chain: okChain, now: NOW });
  assert.equal(payload.service.state, 'halted');
  assert.equal(payload.hold.blockedBy, 'halt');
  assert.equal(payload.hold.haltFile, true);
  await fs.rm(dir, { recursive: true });
});

test('collectDashboard reads state.json directly without creating or touching state files', async () => {
  const dir = await tempStateDir({
    'state.json': JSON.stringify(
      stateWith([
        pulse(1, {
          status: 'broadcast',
          broadcastAt: new Date(NOW.getTime() - 30_000).toISOString(),
          finalizedAt: null,
        }),
      ]),
    ),
  });
  const before = (await fs.readdir(dir)).sort();
  const payload = await collectDashboard({ stateDir: dir, rpc: null, now: () => NOW });
  const after = (await fs.readdir(dir)).sort();
  assert.deepEqual(after, before);
  assert.deepEqual(after, ['state.json']);
  assert.equal(payload.service.state, 'pending');
  assert.equal(payload.hold.blockedBy, 'pending');
  assert.equal(payload.unavailable.rpc, 'unconfigured');
  assert.ok(!JSON.stringify(payload).includes(CANARY));
  await fs.rm(dir, { recursive: true });
});

test('collectDashboard does not query the rpc for addresses it could not validate', async () => {
  const dir = await tempStateDir({
    'state.json': JSON.stringify(stateWith([], { walletAddress: null, deployment: null })),
  });
  const calls = [];
  const rpc = {
    getBlockNumber: () => {
      calls.push('block');
      return Promise.resolve(1n);
    },
    getBalance: () => {
      calls.push('balance');
      return Promise.resolve(1n);
    },
    getPulseCount: () => {
      calls.push('count');
      return Promise.resolve(1n);
    },
  };
  const payload = await collectDashboard({ stateDir: dir, rpc, now: () => NOW });
  assert.deepEqual(calls, ['block']);
  assert.equal(payload.service.state, 'not_deployed');
  await fs.rm(dir, { recursive: true });
});

test('dashboard data module does not import wallet, signing or key-path modules', async () => {
  const source = await fs.readFile(new URL('../src/dashboard-data.mjs', import.meta.url), 'utf8');
  for (const forbidden of [
    'wallet.mjs',
    'run-once.mjs',
    'KEY_PATH',
    'KEY_ROOT',
    'loadState',
    'ensureStateDir',
    'saveState',
    'acquireLock',
    'loadWallet',
  ]) {
    assert.ok(!source.includes(forbidden), `dashboard-data.mjs references ${forbidden}`);
  }
});
