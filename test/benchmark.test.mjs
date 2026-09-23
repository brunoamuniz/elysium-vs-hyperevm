import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeEventTopics, keccak256 } from 'viem';
import { loadBenchmarkConfig, loadConfig } from '../src/config.mjs';
import {
  classifyRpcError,
  clearBenchmarkHold,
  gasBreakdown,
  highestExpectedCount,
  isReceiptNotFound,
  openBenchmarkOwner,
  submissionsInMinute,
  utcMinute,
} from '../src/benchmark.mjs';
import { buildDashboardPayload, readDashboardState } from '../src/dashboard-data.mjs';
import { emptyState, inFlightCount, loadState, saveState } from '../src/state.mjs';

const WALLET = '0x00000000000000000000000000000000000B0b01';
const CONTRACT = '0xC23D6d3E3225dAF415A7756B7259D65eCF478d24';
const ABI = [
  { type: 'function', name: 'count', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'pulse',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'entropy', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'event',
    name: 'Pulsed',
    inputs: [
      { name: 'caller', type: 'address', indexed: true },
      { name: 'count', type: 'uint256', indexed: true },
      { name: 'entropy', type: 'bytes32', indexed: false },
    ],
  },
];
const ARTIFACT = { abi: ABI };
const START = '2026-09-22T12:00:00.000Z';

function account() {
  return {
    address: WALLET,
    signTransaction: async (tx) => `0x02${tx.nonce.toString(16).padStart(8, '0')}${'ee'.repeat(40)}`,
  };
}

function fakeClock(startIso = START) {
  let wall = Date.parse(startIso);
  let mono = 0;
  return {
    now: () => new Date(wall),
    monotonic: () => mono,
    sleep: async () => {},
    advance(ms) {
      wall += ms;
      mono += ms;
    },
    skewWall(ms) {
      wall += ms;
    },
  };
}

function fakeChain(overrides = {}) {
  const chain = {
    latest: 0,
    pending: 0,
    block: 1000n,
    balance: 10n ** 18n,
    gas: 80_000n,
    maxFeePerGas: 5_000_000_000n,
    count: 0n,
    sent: [],
    receipts: new Map(),
    sendError: null,
    ...overrides,
  };
  chain.getTransactionCount = async ({ blockTag }) => (blockTag === 'latest' ? chain.latest : chain.pending);
  chain.getBalance = async () => chain.balance;
  chain.estimateFeesPerGas = async () => ({ maxFeePerGas: chain.maxFeePerGas, maxPriorityFeePerGas: 0n });
  chain.estimateGas = async () => chain.gas;
  chain.getBlockNumber = async () => chain.block;
  chain.getBlock = async ({ blockNumber }) => ({
    hash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
    timestamp: 1_790_000_000n + BigInt(blockNumber),
  });
  chain.readContract = async () => chain.count;
  chain.getTransactionReceipt = async ({ hash }) => {
    const receipt = chain.receipts.get(hash.toLowerCase());
    if (!receipt) throw new Error('transaction receipt not found');
    return receipt;
  };
  chain.sendRawTransaction = async ({ serializedTransaction }) => {
    if (chain.sendError) {
      const error = chain.sendError;
      chain.sendError = null;
      throw error;
    }
    chain.sent.push(serializedTransaction);
    chain.pending += 1;
    return keccak256(serializedTransaction);
  };
  chain.include = (
    action,
    {
      blockNumber = chain.block,
      status = 'success',
      entropy = action.expected.entropy,
      countAfter = action.expected.countAfter,
    } = {},
  ) => {
    const topics = encodeEventTopics({
      abi: ABI,
      eventName: 'Pulsed',
      args: { caller: WALLET, count: BigInt(countAfter) },
    });
    chain.receipts.set(action.hash.toLowerCase(), {
      status,
      blockNumber: BigInt(blockNumber),
      blockHash: `0x${BigInt(blockNumber).toString(16).padStart(64, '0')}`,
      gasUsed: 60_000n,
      effectiveGasPrice: 1_000_000_000n,
      logs: [{ address: CONTRACT, topics, data: entropy }],
    });
    chain.latest = Math.max(chain.latest, Number(action.nonce) + 1);
  };
  return chain;
}

async function harness({
  env = {},
  chain = fakeChain(),
  clock = fakeClock(),
  state = null,
  chainArgv = [],
  clockOffset = null,
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elysium-bench-'));
  await fs.chmod(dir, 0o700);
  const config = {
    ...loadConfig({ ELYSIUM_STATE_DIR: dir, ELYSIUM_LIVE_ENABLED: 'true' }, ['node', 'loop.mjs', ...chainArgv]),
  };
  const seeded = state ?? {
    ...emptyState(WALLET, config.chainId),
    deployment: {
      address: CONTRACT,
      runtimeHash: `0x${'11'.repeat(32)}`,
      txHash: `0x${'22'.repeat(32)}`,
      blockNumber: '900',
      blockHash: `0x${'33'.repeat(32)}`,
    },
  };
  await saveState(dir, seeded);
  const benchmark = loadBenchmarkConfig(env, ['node', 'loop.mjs', '--profile', 'benchmark-10']);
  const logs = [];
  const owner = await openBenchmarkOwner({
    config,
    benchmark,
    account: account(),
    artifact: ARTIFACT,
    chain,
    clock,
    clockOffset,
    log: (entry) => logs.push(entry),
  });
  return {
    dir,
    config,
    benchmark,
    chain,
    clock,
    owner,
    logs,
    async cleanup() {
      await owner.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test('rpc errors are classified into typed kinds without echoing provider text', () => {
  assert.equal(classifyRpcError(new Error('already known')), 'already_known');
  assert.equal(classifyRpcError(new Error('nonce too low')), 'nonce_too_low');
  assert.equal(classifyRpcError(new Error('HTTP 429 Too Many Requests')), 'rate_limit');
  assert.equal(classifyRpcError(new Error('request timed out')), 'timeout');
  assert.equal(classifyRpcError(new Error('fetch failed ECONNRESET')), 'transient');
  assert.equal(classifyRpcError(new Error('something else')), 'unknown');
  assert.equal(classifyRpcError(undefined), 'unknown');
});

test('rpc error kinds survive the typed RPC wrapper and nested provider causes', () => {
  const wrapped = Object.assign(new Error('rpc call sendRawTransaction failed with already_known'), {
    code: 'RPC',
    kind: 'already_known',
  });
  assert.equal(classifyRpcError(wrapped), 'already_known');
  assert.equal(
    classifyRpcError(Object.assign(new Error('x'), { code: 'RPC', kind: 'nonce_too_low' })),
    'nonce_too_low',
  );
  assert.equal(
    classifyRpcError(
      Object.assign(new Error('Transaction failed.'), {
        name: 'TransactionExecutionError',
        cause: { name: 'RpcRequestError', details: 'already known' },
      }),
    ),
    'already_known',
  );
  assert.equal(
    classifyRpcError(
      Object.assign(new Error('Execution failed.'), {
        cause: {
          name: 'NonceTooLowError',
          message: 'Nonce provided for the transaction is lower than the current nonce of the account.',
        },
      }),
    ),
    'nonce_too_low',
  );
});

test('a batch persists every fixed-nonce action before any broadcast and submits in nonce order', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  let preparedAtFirstSend = null;
  const send = chain.sendRawTransaction;
  chain.sendRawTransaction = async (args) => {
    preparedAtFirstSend ??= h.owner.state.actions.length;
    return send(args);
  };
  const result = await h.owner.runSlot('2026-09-22T12:00Z');
  assert.equal(result.prepared, 10);
  assert.equal(result.submitted, 10);
  assert.equal(preparedAtFirstSend, 10, 'all ten actions must be journaled before the first broadcast');
  assert.deepEqual(
    h.owner.state.actions.map((action) => action.nonce),
    ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
  );
  assert.deepEqual(
    h.owner.state.actions.map((action) => action.id),
    Array.from({ length: 10 }, (_, index) => `pulse:2026-09-22T12:00Z:${index}`),
  );
  assert.deepEqual(
    h.owner.state.actions.map((action) => action.expected.countAfter),
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
  );
  assert.deepEqual([...new Set(h.owner.state.actions.map((action) => action.status))], ['submitted']);
  assert.equal(chain.sent.length, 10);
  assert.deepEqual(
    h.owner.state.batches.map((batch) => batch.outcome),
    ['submitted'],
  );
  await h.cleanup();
});

test('a second slot inside the same UTC minute cannot exceed ten new submissions', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  const second = await h.owner.runSlot('2026-09-22T12:00Z-b');
  assert.equal(second.prepared, 0);
  assert.equal(second.outcome, 'capacity_skip');
  assert.equal(chain.sent.length, 10);
  assert.equal(submissionsInMinute(h.owner.state, '2026-09-22T12:00Z'), 10);
  const skip = h.owner.state.batches.find((batch) => batch.outcome === 'capacity_skip');
  assert.equal(skip.quotaRoom, 0);
  assert.ok(
    !h.owner.state.actions.some((action) => action.status === 'capacity_skip'),
    'capacity_skip belongs in batches, never as an action',
  );
  await h.cleanup();
});

test('the global in-flight cap skips a slot instead of queueing unbounded nonces', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  h.clock.advance(60_000);
  await h.owner.runSlot('2026-09-22T12:01Z');
  assert.equal(inFlightCount(h.owner.state), 20);
  h.clock.advance(60_000);
  const third = await h.owner.runSlot('2026-09-22T12:02Z');
  assert.equal(third.outcome, 'capacity_skip');
  assert.equal(chain.sent.length, 20);
  const skip = h.owner.state.batches.find((batch) => batch.outcome === 'capacity_skip');
  assert.equal(skip.inFlight, 20);
  assert.equal(skip.capacityRoom, 0);
  await h.cleanup();
});

test('prepared work left over from a crash consumes the next minute quota before a new batch opens', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  chain.sendRawTransaction = async () => {
    throw new Error('fetch failed ECONNRESET');
  };
  await h.owner.runSlot('2026-09-22T12:00Z');
  assert.equal(h.owner.state.actions.filter((action) => action.status === 'prepared').length, 10);
  assert.equal(submissionsInMinute(h.owner.state, '2026-09-22T12:00Z'), 0);
  await h.owner.close();

  const restarted = await openBenchmarkOwner({
    config: h.config,
    benchmark: h.benchmark,
    account: account(),
    artifact: ARTIFACT,
    chain: fakeChain({ ...chain, sent: [], receipts: chain.receipts }),
    clock: h.clock,
    log: () => {},
  });
  h.clock.advance(60_000);
  const result = await restarted.runSlot('2026-09-22T12:01Z');
  assert.equal(result.backlog, 10, 'the retained batch is rebroadcast, not re-prepared');
  assert.equal(result.prepared, 0);
  assert.equal(restarted.state.actions.length, 10, 'no duplicate nonces are created after a restart');
  assert.deepEqual([...new Set(restarted.state.actions.map((action) => action.status))], ['submitted']);
  assert.equal(submissionsInMinute(restarted.state, '2026-09-22T12:01Z'), 10);
  await restarted.close();
  await fs.rm(h.dir, { recursive: true, force: true });
});

test('inclusion settles the actual receipt cost and releases the worst-case reservation', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  const worstEach = 80_000n * 5_000_000_000n;
  assert.equal(h.owner.state.dailyReserved['2026-09-22'], (worstEach * 10n).toString());
  assert.equal(h.owner.state.dailySpend['2026-09-22'], undefined);

  for (const action of h.owner.state.actions) chain.include(action, { blockNumber: 1001n });
  chain.block = 1001n;
  await h.owner.track();
  assert.deepEqual([...new Set(h.owner.state.actions.map((action) => action.status))], ['included']);
  assert.equal(h.owner.state.dailyReserved['2026-09-22'], '0');
  assert.equal(h.owner.state.dailySpend['2026-09-22'], (60_000n * 1_000_000_000n * 10n).toString());
  const first = h.owner.state.actions[0];
  assert.equal(first.cost.gasUsed, '60000');
  assert.equal(first.cost.effectiveGasPriceWei, '1000000000');
  assert.equal(first.timing.includedObservedAt, h.clock.now().toISOString());
  assert.equal(first.timing.blockTimestamp, (1_790_000_000n + 1001n).toString());

  h.clock.advance(4000);
  chain.block = 1003n;
  await h.owner.track();
  assert.deepEqual([...new Set(h.owner.state.actions.map((action) => action.status))], ['finalized']);
  assert.equal(first.timing.confirmationLabel, '2-conf');
  assert.equal(h.owner.state.actions[0].timing.quality, 'primary');
  await h.cleanup();
});

test('two-block confirmation is tracked separately from inclusion and not called finality', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  const action = h.owner.state.actions[0];
  chain.include(action, { blockNumber: 1001n });
  chain.block = 1001n;
  h.clock.advance(3000);
  await h.owner.track();
  assert.equal(h.owner.state.actions[0].status, 'included');
  chain.block = 1002n;
  await h.owner.track();
  assert.equal(h.owner.state.actions[0].status, 'included', 'one confirmation is not two');
  chain.block = 1003n;
  h.clock.advance(2000);
  await h.owner.track();
  assert.equal(h.owner.state.actions[0].status, 'finalized');
  assert.equal(h.owner.state.actions[0].timing.confirmationLabel, '2-conf');
  await h.cleanup();
});

test('a missing receipt does not crash the owner and later resolves normally', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  for (let poll = 0; poll < 5; poll += 1) {
    h.clock.advance(2000);
    await h.owner.track();
  }
  assert.deepEqual([...new Set(h.owner.state.actions.map((action) => action.status))], ['submitted']);
  assert.equal(h.owner.state.hold, null);
  for (const action of h.owner.state.actions) chain.include(action, { blockNumber: 1001n });
  chain.block = 1004n;
  await h.owner.track();
  assert.deepEqual([...new Set(h.owner.state.actions.map((action) => action.status))], ['finalized']);
  await h.cleanup();
});

test('an rpc pending nonce that lags the journal triggers an exact same-hash rebroadcast', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  const before = chain.sent.length;
  chain.pending = 0;
  await h.owner.track();
  assert.equal(chain.sent.length, before + 10, 'the exact persisted raw transactions are rebroadcast in nonce order');
  assert.deepEqual(chain.sent.slice(before), chain.sent.slice(0, 10));
  assert.equal(h.owner.state.hold, null);
  assert.deepEqual([...new Set(h.owner.state.actions.map((action) => action.timing.quality))], ['recovered']);
  await h.cleanup();
});

test('an exact-hash already-known rebroadcast result is treated as success', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  chain.pending = 0;
  chain.sendRawTransaction = async () => {
    throw new Error('already known');
  };
  await h.owner.track();
  assert.equal(h.owner.state.hold, null);
  assert.deepEqual([...new Set(h.owner.state.actions.map((action) => action.status))], ['submitted']);
  assert.equal(h.logs.filter((entry) => entry.type === 'action_rebroadcast').length, 10);
  assert.equal(h.logs.filter((entry) => entry.type === 'rebroadcast_failed').length, 0);
  await h.cleanup();
});

test('an already-known initial submit is accepted as the exact persisted hash', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  const send = chain.sendRawTransaction;
  let first = true;
  chain.sendRawTransaction = async (args) => {
    if (first) {
      first = false;
      await send(args);
      throw new Error('already known');
    }
    return send(args);
  };
  const result = await h.owner.runSlot('2026-09-22T12:00Z');
  assert.equal(result.submitted, 10);
  assert.equal(h.owner.state.actions[0].status, 'submitted');
  assert.ok(h.owner.state.actions[0].timing.rpcAcceptedAt);
  assert.equal(h.logs.filter((entry) => entry.type === 'submit_failed').length, 0);
  await h.cleanup();
});

test('a nonce-too-low initial submit leaves the action for receipt reconciliation instead of failing', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  const send = chain.sendRawTransaction;
  let first = true;
  chain.sendRawTransaction = async (args) => {
    if (first) {
      first = false;
      throw new Error('nonce too low');
    }
    return send(args);
  };
  const result = await h.owner.runSlot('2026-09-22T12:00Z');
  assert.equal(result.submitted, 0);
  assert.equal(h.owner.state.actions[0].status, 'prepared');
  assert.equal(h.logs.filter((entry) => entry.type === 'submit_nonce_consumed').length, 1);
  assert.equal(h.logs.filter((entry) => entry.type === 'submit_failed').length, 0);
  assert.equal(h.owner.state.hold, null);
  chain.include(h.owner.state.actions[0], { blockNumber: 1001n });
  chain.block = 1001n;
  await h.owner.track();
  assert.equal(h.owner.state.actions[0].status, 'included');
  assert.equal(h.owner.state.actions[0].timing.quality, 'recovered');
  assert.equal(h.owner.state.hold, null);
  await h.cleanup();
});

test('a nonce-too-low rebroadcast is not a failure and the receipt settles on the next tick', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  chain.pending = 0;
  chain.sendRawTransaction = async () => {
    throw new Error('nonce too low');
  };
  await h.owner.track();
  assert.equal(h.owner.state.hold, null);
  assert.equal(h.logs.filter((entry) => entry.type === 'rebroadcast_nonce_consumed').length, 10);
  assert.equal(h.logs.filter((entry) => entry.type === 'rebroadcast_failed').length, 0);
  for (const action of h.owner.state.actions) chain.include(action, { blockNumber: 1001n });
  chain.pending = 10;
  chain.block = 1003n;
  await h.owner.track();
  assert.deepEqual([...new Set(h.owner.state.actions.map((action) => action.status))], ['finalized']);
  await h.cleanup();
});

test('partial rpc acceptance submits only the accepted prefix and the backlog drains next minute', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  const send = chain.sendRawTransaction;
  let calls = 0;
  chain.sendRawTransaction = async (args) => {
    calls += 1;
    if (calls > 4) throw new Error('fetch failed ECONNRESET');
    return send(args);
  };
  const first = await h.owner.runSlot('2026-09-22T12:00Z');
  assert.equal(first.submitted, 4);
  assert.deepEqual(
    h.owner.state.actions.map((action) => action.status),
    [...Array(4).fill('submitted'), ...Array(6).fill('prepared')],
  );
  assert.equal(h.owner.state.batches[0].submittedCount, 4);
  assert.equal(submissionsInMinute(h.owner.state, '2026-09-22T12:00Z'), 4);
  assert.equal(h.logs.filter((entry) => entry.type === 'submit_failed').length, 1);
  chain.sendRawTransaction = send;
  h.clock.advance(60_000);
  const second = await h.owner.runSlot('2026-09-22T12:01Z');
  assert.equal(second.backlog, 6);
  assert.equal(second.prepared, 4, 'the backlog consumes the new minute quota first');
  assert.equal(submissionsInMinute(h.owner.state, '2026-09-22T12:01Z'), 10);
  assert.deepEqual(
    chain.sent.map((raw) => keccak256(raw)),
    h.owner.state.actions.map((action) => action.hash),
  );
  await h.cleanup();
});

test('an accepted submit whose response is lost is recovered by the already-known retry', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  const send = chain.sendRawTransaction;
  const seen = new Set();
  chain.sendRawTransaction = async (args) => {
    if (seen.has(args.serializedTransaction)) throw new Error('already known');
    seen.add(args.serializedTransaction);
    await send(args);
    if (seen.size === 1) throw new Error('request timed out');
    return keccak256(args.serializedTransaction);
  };
  const result = await h.owner.runSlot('2026-09-22T12:00Z');
  assert.equal(result.submitted, 10);
  assert.equal(chain.sent.length, 10, 'the lost-response retry never double-sends a new transaction');
  assert.equal(h.logs.filter((entry) => entry.type === 'rpc_retry').length, 1);
  await h.cleanup();
});

test('a chain nonce beyond the journal authority halts instead of racing a foreign transaction', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  chain.latest = 42;
  await assert.rejects(
    () => h.owner.track(),
    (error) => error.code === 'HALT',
  );
  assert.equal(h.owner.state.hold.type, 'foreign_nonce');
  const skipped = await h.owner.runSlot('2026-09-22T12:01Z').catch((error) => error);
  assert.equal(skipped.code, 'HALT');
  await h.cleanup();
});

test('a consumed nonce with no receipt needs two polls before it is called reconcile_required', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  chain.latest = 1;
  chain.pending = 10;
  await h.owner.track();
  assert.equal(h.owner.state.actions[0].status, 'submitted', 'one missing poll is not proof of foreign consumption');
  assert.equal(h.owner.state.actions[0].missingReceiptPolls, 1);
  await assert.rejects(
    () => h.owner.track(),
    (error) => error.code === 'HALT',
  );
  assert.equal(h.owner.state.actions[0].status, 'reconcile_required');
  assert.equal(h.owner.state.hold.type, 'foreign_nonce');
  await h.cleanup();
});

test('a receipt without the exact expected Pulsed event halts for operator reconciliation', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  const action = h.owner.state.actions[0];
  chain.include(action, { blockNumber: 1001n, countAfter: '99' });
  chain.block = 1005n;
  await assert.rejects(
    () => h.owner.track(),
    (error) => error.code === 'HALT',
  );
  assert.equal(h.owner.state.actions[0].status, 'reconcile_required');
  assert.equal(h.owner.state.hold.type, 'intent_mismatch');
  await h.cleanup();
});

test('a reverted receipt is settled at its real cost without halting the benchmark', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  const action = h.owner.state.actions[0];
  chain.include(action, { blockNumber: 1001n, status: 'reverted' });
  chain.block = 1005n;
  await h.owner.track();
  assert.equal(h.owner.state.actions[0].status, 'reverted');
  assert.equal(h.owner.state.actions[0].cost.actualCostWei, (60_000n * 1_000_000_000n).toString());
  assert.equal(h.owner.state.hold, null);
  await h.cleanup();
});

test('a daily budget that cannot preflight a whole batch records a typed budget skip', async () => {
  const chain = fakeChain();
  const h = await harness({
    chain,
    env: { ELYSIUM_BENCHMARK_DAILY_COST_LIMIT: String(80_000n * 5_000_000_000n * 9n) },
  });
  const result = await h.owner.runSlot('2026-09-22T12:00Z');
  assert.equal(result.prepared, 0);
  assert.equal(result.outcome, 'budget_skip');
  assert.equal(h.owner.state.batches[0].reason, 'daily_limit');
  assert.equal(chain.sent.length, 0);
  await h.cleanup();
});

test('committed-but-unsettled reservations count against the next batch budget check', async () => {
  const chain = fakeChain();
  const h = await harness({
    chain,
    env: { ELYSIUM_BENCHMARK_DAILY_COST_LIMIT: String(80_000n * 5_000_000_000n * 15n) },
  });
  await h.owner.runSlot('2026-09-22T12:00Z');
  h.clock.advance(60_000);
  const second = await h.owner.runSlot('2026-09-22T12:01Z');
  assert.equal(second.outcome, 'budget_skip');
  assert.equal(h.owner.state.batches[1].reason, 'daily_limit');
  await h.cleanup();
});

test('the balance preflight counts outstanding committed reservations', async () => {
  const worstBatch = 80_000n * 5_000_000_000n * 10n;
  const reserve = 10_000_000_000_000_000n;
  const chain = fakeChain({ balance: worstBatch * 2n + reserve - 1n });
  const h = await harness({ chain });
  const first = await h.owner.runSlot('2026-09-22T12:00Z');
  assert.equal(first.submitted, 10);
  h.clock.advance(60_000);
  const second = await h.owner.runSlot('2026-09-22T12:01Z');
  assert.equal(second.outcome, 'budget_skip');
  assert.equal(h.owner.state.batches[1].reason, 'balance_reserve');
  assert.equal(chain.sent.length, 10);
  await h.cleanup();
});

test('an insufficient balance reserve blocks the batch before any signing', async () => {
  const chain = fakeChain({ balance: 10n ** 16n });
  const h = await harness({ chain });
  const result = await h.owner.runSlot('2026-09-22T12:00Z');
  assert.equal(result.outcome, 'budget_skip');
  assert.equal(h.owner.state.batches[0].reason, 'balance_reserve');
  assert.equal(h.owner.state.actions.length, 0);
  await h.cleanup();
});

test('a HALT file stops new preparation and retains the journal untouched', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await fs.writeFile(path.join(h.dir, 'HALT'), '');
  await assert.rejects(
    () => h.owner.runSlot('2026-09-22T12:00Z'),
    (error) => error.code === 'HALT',
  );
  assert.equal(h.owner.state.actions.length, 0);
  assert.equal(chain.sent.length, 0);
  await h.cleanup();
});

test('a stuck lowest nonce becomes a persisted hold rather than an abandoned action', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  h.clock.advance(400_000);
  await assert.rejects(
    () => h.owner.track(),
    (error) => error.code === 'HOLD',
  );
  assert.equal(h.owner.state.hold.type, 'stuck_nonce');
  assert.equal(h.owner.state.hold.nonce, '0');
  assert.equal(h.owner.state.actions.length, 10, 'no action is abandoned while the nonce is held');
  h.clock.advance(60_000);
  const skipped = await h.owner.runSlot('2026-09-22T12:07Z');
  assert.equal(skipped.outcome, 'hold_skip');
  await h.cleanup();
});

test('a wall-clock jump during a batch flags drift instead of publishing a fake latency', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  const action = h.owner.state.actions[0];
  chain.include(action, { blockNumber: 1001n });
  chain.block = 1004n;
  h.clock.skewWall(30_000);
  await h.owner.track();
  assert.equal(h.owner.state.actions[0].status, 'finalized');
  assert.equal(h.owner.state.actions[0].timing.quality, 'drift');
  await h.cleanup();
});

test('expected counts continue from the highest journaled value, not a stale chain read', async () => {
  const chain = fakeChain({ count: 3n });
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  assert.equal(h.owner.state.actions[0].expected.countAfter, '4');
  assert.equal(highestExpectedCount(h.owner.state), 13n);
  h.clock.advance(60_000);
  await h.owner.runSlot('2026-09-22T12:01Z');
  assert.equal(
    h.owner.state.actions[10].expected.countAfter,
    '14',
    'a lagging chain count must not restart the expected sequence',
  );
  await h.cleanup();
});

test('utc minute attribution uses the actual acceptance stamp', () => {
  assert.equal(utcMinute(new Date('2026-09-22T12:00:59.900Z')), '2026-09-22T12:00Z');
  assert.equal(
    submissionsInMinute(
      {
        actions: [
          { timing: { rpcAcceptedAt: '2026-09-22T12:00:10.000Z' } },
          { timing: { rpcAcceptedAt: '2026-09-22T12:01:10.000Z' } },
          { timing: {} },
        ],
      },
      '2026-09-22T12:00Z',
    ),
    1,
  );
});

test('a tick polls the block and nonce once and fetches receipts only below the latest nonce', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  const calls = { nonce: 0, block: 0, receipts: [] };
  const counts = chain.getTransactionCount;
  const blocks = chain.getBlockNumber;
  const receipts = chain.getTransactionReceipt;
  chain.getTransactionCount = async (args) => {
    calls.nonce += 1;
    return counts(args);
  };
  chain.getBlockNumber = async () => {
    calls.block += 1;
    return blocks();
  };
  chain.getTransactionReceipt = async (args) => {
    calls.receipts.push(args.hash);
    return receipts(args);
  };
  chain.latest = 3;
  await h.owner.track();
  assert.equal(calls.nonce, 2, 'one latest and one pending nonce read per tick');
  assert.equal(calls.block, 1, 'one block read per tick');
  assert.deepEqual(
    calls.receipts,
    h.owner.state.actions.slice(0, 3).map((action) => action.hash),
    'nonces at or above latest cannot have a receipt yet',
  );
  await h.cleanup();
});

test('benchmark log output is redacted before it reaches the log sink', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot(`https://leak.example/${'ab'.repeat(32)}`);
  const serialized = JSON.stringify(h.logs);
  assert.ok(!serialized.includes('leak.example'));
  assert.ok(!serialized.includes('ab'.repeat(32)));
  await h.cleanup();
});

test('compaction persistence is serialized through the owner queue', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elysium-bench-'));
  await fs.chmod(dir, 0o700);
  const actions = Array.from({ length: 60 }, (_, index) => ({
    id: `pulse:old:${index}`,
    kind: 'pulse',
    status: 'finalized',
    nonce: String(index),
    hash: `0x${index.toString(16).padStart(64, '0')}`,
    timing: { rpcAcceptedAt: '2026-09-21T10:00:00.000Z' },
    cost: {},
  }));
  await saveState(dir, { ...emptyState(WALLET), actions });
  const config = loadConfig({ ELYSIUM_STATE_DIR: dir, ELYSIUM_LIVE_ENABLED: 'true' });
  const benchmark = loadBenchmarkConfig({ ELYSIUM_BENCHMARK_ACTIVE_LIMIT: '50' }, [
    'node',
    'loop.mjs',
    '--profile',
    'benchmark-10',
  ]);
  const owner = await openBenchmarkOwner({
    config,
    benchmark,
    account: account(),
    artifact: ARTIFACT,
    chain: fakeChain(),
    clock: fakeClock(),
    log: () => {},
  });
  const [a, b] = await Promise.all([owner.compact(), owner.compact()]);
  assert.equal(a.archived + b.archived, 10, 'a concurrent compaction must not archive the same actions twice');
  const archived = (await fs.readFile(path.join(dir, 'finalized-2026-09-21.ndjson'), 'utf8')).trim().split('\n');
  assert.equal(archived.length, 10);
  const disk = await loadState(dir, WALLET);
  assert.equal(disk.actions.length, 50);
  assert.equal(disk.archive.archivedActions, 10);
  await owner.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function reopen(h, chain = h.chain) {
  return openBenchmarkOwner({
    config: h.config,
    benchmark: h.benchmark,
    account: account(),
    artifact: ARTIFACT,
    chain,
    clock: h.clock,
    log: (entry) => h.logs.push(entry),
  });
}

function clear(h, fields) {
  return clearBenchmarkHold({
    config: h.config,
    account: account(),
    artifact: ARTIFACT,
    chain: h.chain,
    clock: h.clock,
    log: (entry) => h.logs.push(entry),
    reason: 'operator reviewed journal and explorer',
    ...fields,
  });
}

test('a persisted benchmark hold is dashboard-visible as reconcile_required', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  h.clock.advance(400_000);
  await assert.rejects(
    () => h.owner.track(),
    (error) => error.code === 'HOLD',
  );
  await h.owner.close();
  const disk = await loadState(h.dir, WALLET);
  assert.equal(disk.hold.type, 'stuck_nonce');
  assert.equal(disk.hold.status, 'reconcile_required');
  const payload = buildDashboardPayload({
    read: await readDashboardState(h.dir),
    chain: { balanceWei: null, pulseCount: null, blockNumber: null, unavailable: null },
    now: h.clock.now(),
  });
  assert.equal(payload.service.state, 'reconcile_required');
  assert.equal(payload.hold.blockedBy, 'reconcile_required');
  assert.equal(payload.hold.type, 'stuck_nonce');
  assert.equal(payload.hold.nonce, '0');
  await fs.rm(h.dir, { recursive: true, force: true });
});

test('clearing a hold requires the HALT file, the exact hold, a released lock and a reason', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  h.clock.advance(400_000);
  await assert.rejects(
    () => h.owner.track(),
    (error) => error.code === 'HOLD',
  );
  await assert.rejects(() => clear(h, { type: 'stuck_nonce', nonce: '0' }), /state lock/);
  await h.owner.close();
  await assert.rejects(() => clear(h, { type: 'stuck_nonce', nonce: '0' }), /HALT/);
  await fs.writeFile(path.join(h.dir, 'HALT'), '');
  await assert.rejects(() => clear(h, { type: 'stuck_nonce', nonce: '0', reason: '' }), /reason/);
  await assert.rejects(() => clear(h, { type: 'foreign_nonce', nonce: '0' }), /not foreign_nonce/);
  await assert.rejects(() => clear(h, { type: 'stuck_nonce', nonce: '1' }), /nonce/);
  await assert.rejects(() => clear(h, { type: 'stuck_nonce', nonce: '0' }), /not been consumed/);
  assert.equal((await loadState(h.dir, WALLET)).hold.type, 'stuck_nonce', 'a refused clear leaves the hold untouched');
  await fs.rm(h.dir, { recursive: true, force: true });
});

test('a resolved stuck-nonce hold is cleared into visible history and the benchmark resumes', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  h.clock.advance(400_000);
  await assert.rejects(
    () => h.owner.track(),
    (error) => error.code === 'HOLD',
  );
  for (const action of h.owner.state.actions) chain.include(action, { blockNumber: 1001n });
  chain.block = 1003n;
  await h.owner.close();
  await fs.writeFile(path.join(h.dir, 'HALT'), '');
  const result = await clear(h, { type: 'stuck_nonce', nonce: '0' });
  assert.equal(result.cleared, 'stuck_nonce');
  const disk = await loadState(h.dir, WALLET);
  assert.equal(disk.hold, null);
  assert.equal(disk.holdHistory.at(-1).type, 'stuck_nonce');
  assert.equal(disk.holdHistory.at(-1).reason, 'operator reviewed journal and explorer');
  const payload = buildDashboardPayload({
    read: await readDashboardState(h.dir),
    chain: { balanceWei: null, pulseCount: null, blockNumber: null, unavailable: null },
    now: h.clock.now(),
  });
  assert.equal(payload.hold.type, null);
  assert.deepEqual(payload.hold.lastCleared, { type: 'stuck_nonce', clearedAt: h.clock.now().toISOString() });
  await fs.rm(path.join(h.dir, 'HALT'));
  const owner = await reopen(h);
  await owner.track();
  assert.deepEqual([...new Set(owner.state.actions.map((action) => action.status))], ['finalized']);
  h.clock.advance(60_000);
  const next = await owner.runSlot(utcMinute(h.clock.now()));
  assert.equal(next.submitted, 10);
  assert.equal(h.logs.filter((entry) => entry.type === 'benchmark_hold_cleared').length, 1);
  await owner.close();
  await fs.rm(h.dir, { recursive: true, force: true });
});

test('a false-positive foreign-nonce hold is cleared only after the exact receipt is verified', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  chain.latest = 1;
  await h.owner.track();
  await assert.rejects(
    () => h.owner.track(),
    (error) => error.code === 'HALT',
  );
  assert.equal(h.owner.state.hold.type, 'foreign_nonce');
  await h.owner.close();
  await fs.writeFile(path.join(h.dir, 'HALT'), '');
  await assert.rejects(() => clear(h, { type: 'foreign_nonce', nonce: '0' }), /retire this journal/);
  const action = (await loadState(h.dir, WALLET)).actions[0];
  chain.include(action, { blockNumber: 1001n });
  chain.block = 1003n;
  const result = await clear(h, { type: 'foreign_nonce', nonce: '0' });
  assert.deepEqual(result.restored, [{ id: action.id, status: 'submitted' }]);
  await fs.rm(path.join(h.dir, 'HALT'));
  const owner = await reopen(h);
  await owner.track();
  assert.equal(owner.state.actions[0].status, 'finalized');
  assert.equal(owner.state.actions[0].timing.quality, 'recovered');
  assert.equal(owner.state.hold, null);
  await owner.close();
  await fs.rm(h.dir, { recursive: true, force: true });
});

test('a genuine intent mismatch cannot be cleared by the tool', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  chain.include(h.owner.state.actions[0], { blockNumber: 1001n, countAfter: '99' });
  chain.block = 1005n;
  await assert.rejects(
    () => h.owner.track(),
    (error) => error.code === 'HALT',
  );
  await assert.rejects(
    () => h.owner.track(),
    (error) => error.code === 'HALT',
  );
  assert.equal(h.owner.state.hold.type, 'intent_mismatch', 'a later tick must not overwrite the specific hold type');
  await h.owner.close();
  await fs.writeFile(path.join(h.dir, 'HALT'), '');
  await assert.rejects(() => clear(h, { type: 'intent_mismatch', nonce: '0' }), /retire this journal/);
  const disk = await loadState(h.dir, WALLET);
  assert.equal(disk.hold.type, 'intent_mismatch');
  assert.equal(disk.actions[0].status, 'reconcile_required');
  await fs.rm(h.dir, { recursive: true, force: true });
});

test('a failed save does not poison the persist queue for later writes', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await fs.chmod(h.dir, 0o755);
  await assert.rejects(() => h.owner.runSlot('2026-09-22T12:00Z'), /insecure/);
  await fs.chmod(h.dir, 0o700);
  await h.owner.compact();
  h.clock.advance(60_000);
  const next = await h.owner.runSlot('2026-09-22T12:01Z');
  assert.equal(next.backlog, 10);
  const disk = await loadState(h.dir, WALLET);
  assert.deepEqual([...new Set(disk.actions.map((action) => action.status))], ['submitted']);
  await h.cleanup();
});

test('receipt rpc errors never count as missing-receipt polls', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  const receipts = chain.getTransactionReceipt;
  chain.getTransactionReceipt = async () => {
    throw new Error('fetch failed ECONNRESET');
  };
  chain.latest = 1;
  for (let poll = 0; poll < 3; poll += 1) await h.owner.track();
  assert.equal(h.owner.state.actions[0].missingReceiptPolls, 0);
  assert.equal(h.owner.state.actions[0].status, 'submitted');
  assert.equal(h.owner.state.hold, null);
  chain.getTransactionReceipt = receipts;
  await h.owner.track();
  assert.equal(h.owner.state.actions[0].missingReceiptPolls, 1, 'a genuine not-found still counts');
  await h.cleanup();
});

test('receipt not-found detection matches viem and provider shapes only', () => {
  assert.equal(isReceiptNotFound(Object.assign(new Error('x'), { name: 'TransactionReceiptNotFoundError' })), true);
  assert.equal(isReceiptNotFound(new Error('Transaction receipt with hash "0xab" could not be found.')), true);
  assert.equal(isReceiptNotFound(new Error('getaddrinfo ENOTFOUND rpc.example')), false);
  assert.equal(isReceiptNotFound(new Error('request timed out')), false);
});

test('an rpc pending nonce above the journal authority halts instead of being adopted', async () => {
  const chain = fakeChain({ pending: 3 });
  const h = await harness({ chain });
  await assert.rejects(
    () => h.owner.runSlot('2026-09-22T12:00Z'),
    (error) => error.code === 'HALT',
  );
  assert.equal(h.owner.state.hold.type, 'foreign_nonce');
  assert.equal(h.owner.state.hold.pending, '3');
  assert.equal(h.owner.state.actions.length, 0);
  assert.equal(chain.sent.length, 0);
  assert.equal((await loadState(h.dir, WALLET)).hold.type, 'foreign_nonce');
  await h.cleanup();
});

test('a never-accepted prepared lowest nonce escalates to a stuck-nonce hold', async () => {
  const chain = fakeChain();
  chain.sendRawTransaction = async () => {
    throw new Error('something else');
  };
  const h = await harness({ chain });
  const first = await h.owner.runSlot('2026-09-22T12:00Z');
  assert.equal(first.submitted, 0);
  assert.equal(h.owner.state.actions[0].status, 'prepared');
  h.clock.advance(400_000);
  await assert.rejects(
    () => h.owner.track(),
    (error) => error.code === 'HOLD',
  );
  assert.equal(h.owner.state.hold.type, 'stuck_nonce');
  assert.equal(h.owner.state.hold.nonce, '0');
  await h.cleanup();
});

test('prepared actions left by downtime before any send attempt are broadcast after restart, not held as stuck', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  const signer = account();
  let signed = 0;
  const crashing = {
    ...signer,
    signTransaction: async (tx) => {
      signed += 1;
      if (signed === 10) await fs.writeFile(path.join(h.dir, 'HALT'), '');
      return signer.signTransaction(tx);
    },
  };
  await h.owner.close();
  const first = await openBenchmarkOwner({
    config: h.config,
    benchmark: h.benchmark,
    account: crashing,
    artifact: ARTIFACT,
    chain,
    clock: h.clock,
    log: () => {},
  });
  await assert.rejects(
    () => first.runSlot('2026-09-22T12:00Z'),
    (error) => error.code === 'HALT',
  );
  await first.close();
  assert.equal(chain.sent.length, 0);
  const persisted = await loadState(h.dir, WALLET);
  assert.equal(persisted.actions.length, 10);
  assert.ok(
    persisted.actions.every(
      (action) => action.status === 'prepared' && action.timing.firstBroadcastAttemptAt === undefined,
    ),
  );
  await fs.rm(path.join(h.dir, 'HALT'));

  h.clock.advance(3_600_000);
  const restarted = await openBenchmarkOwner({
    config: h.config,
    benchmark: h.benchmark,
    account: account(),
    artifact: ARTIFACT,
    chain,
    clock: h.clock,
    log: () => {},
  });
  const result = await restarted.runSlot('2026-09-22T13:00Z');
  assert.equal(restarted.state.hold, null);
  assert.equal(result.backlog, 10, 'the retained batch is broadcast once the process is back');
  assert.equal(restarted.state.actions[0].timing.firstBroadcastAttemptAt, h.clock.now().toISOString());
  await restarted.close();
  await fs.rm(h.dir, { recursive: true, force: true });
});

test('repeated failed sends are held as stuck once aged past the first broadcast attempt', async () => {
  const chain = fakeChain();
  chain.sendRawTransaction = async () => {
    throw new Error('something else');
  };
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  const firstAttempt = h.owner.state.actions[0].timing.firstBroadcastAttemptAt;
  assert.equal(firstAttempt, START);
  h.clock.advance(200_000);
  await h.owner.runSlot('2026-09-22T12:03Z');
  assert.equal(h.owner.state.hold, null);
  assert.equal(h.owner.state.actions[0].status, 'prepared');
  assert.equal(
    h.owner.state.actions[0].timing.firstBroadcastAttemptAt,
    firstAttempt,
    'a retry keeps the first attempt timestamp',
  );
  assert.notEqual(h.owner.state.actions[0].timing.submitStartedAt, firstAttempt);
  assert.equal((await loadState(h.dir, WALLET)).actions[0].timing.firstBroadcastAttemptAt, firstAttempt);
  h.clock.advance(200_000);
  await assert.rejects(
    () => h.owner.track(),
    (error) => error.code === 'HOLD',
  );
  assert.equal(h.owner.state.hold.type, 'stuck_nonce');
  assert.equal(h.owner.state.hold.nonce, '0');
  await h.cleanup();
});

test('reverted pulses do not advance the next expected count', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  const actions = h.owner.state.actions;
  for (const action of actions.slice(0, 9)) chain.include(action, { blockNumber: 1001n });
  chain.include(actions[9], { blockNumber: 1001n, status: 'reverted' });
  chain.block = 1004n;
  chain.count = 9n;
  await h.owner.track();
  assert.equal(h.owner.state.actions[9].status, 'reverted');
  assert.equal(highestExpectedCount(h.owner.state), 9n);
  h.clock.advance(60_000);
  await h.owner.runSlot('2026-09-22T12:01Z');
  assert.equal(h.owner.state.actions[10].expected.countAfter, '10');
  await h.cleanup();
});

const HYPER = ['--chain', 'hyperevm-testnet'];
function blockWithHashes(number, hashes, timestamp = 1_790_000_000n + BigInt(number)) {
  return {
    number: BigInt(number),
    hash: `0x${BigInt(number).toString(16).padStart(64, '0')}`,
    timestamp,
    transactions: hashes,
  };
}

test('the block watcher stamps inclusion when the block is seen, not when the tracker reaches the action', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  const actions = h.owner.state.actions;
  for (const action of actions) chain.include(action, { blockNumber: 1001n });
  const baseGetBlock = chain.getBlock;
  let latestCalls = 0;
  chain.getBlock = async (args) => {
    if (args.blockTag === 'latest') {
      latestCalls += 1;
      return blockWithHashes(
        1001n,
        actions.map((a) => a.hash),
      );
    }
    return baseGetBlock(args);
  };
  h.clock.advance(700);
  const seenAt = h.clock.now().toISOString();
  const pass = await h.owner.watch();
  assert.equal(pass.observed, 10);
  assert.equal(latestCalls, 1);
  h.clock.advance(5_000);
  chain.block = 1001n;
  let settleBlockCalls = 0;
  chain.getBlock = async (args) => {
    settleBlockCalls += 1;
    return baseGetBlock(args);
  };
  await h.owner.track();
  for (const action of actions) {
    assert.equal(action.status, 'included');
    assert.equal(
      action.timing.includedObservedAt,
      seenAt,
      'every action carries the watcher stamp, not the later tracker pass',
    );
    assert.equal(action.timing.includedObservedBy, 'block_watch');
    assert.equal(action.timing.blockTimestamp, (1_790_000_000n + 1001n).toString());
  }
  assert.equal(settleBlockCalls, 0, 'a watched block timestamp is reused instead of re-fetched per action');
  assert.ok(
    actions.every((action) => action.timing.measurementVersion === 4),
    'samples from the fixed measurement path are tagged',
  );
  await h.cleanup();
});

test('a watched block that is no longer the receipt block falls back to a fresh stamp and block read', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  const [first] = h.owner.state.actions;
  const baseGetBlock = chain.getBlock;
  chain.getBlock = async (args) =>
    args.blockTag === 'latest'
      ? { ...blockWithHashes(1001n, [first.hash]), hash: `0x${'ab'.repeat(32)}` }
      : baseGetBlock(args);
  await h.owner.watch();
  chain.getBlock = baseGetBlock;
  chain.include(first, { blockNumber: 1001n });
  chain.block = 1001n;
  h.clock.advance(3_000);
  await h.owner.track();
  assert.equal(first.timing.includedObservedBy, 'receipt_poll');
  assert.equal(first.timing.includedObservedAt, h.clock.now().toISOString());
  await h.cleanup();
});

test('on a chain whose pending nonce is latest, an in-flight action is not mistaken for a dropped one', async () => {
  const chain = fakeChain({ maxFeePerGas: 100_000_000n });
  chain.getTransactionCount = async () => chain.latest;
  const h = await harness({ chain, chainArgv: HYPER });
  await h.owner.runSlot('2026-09-22T12:00Z');
  const sent = chain.sent.length;
  h.clock.advance(5_000);
  await h.owner.track();
  assert.equal(chain.sent.length, sent, 'no rebroadcast while the action is young');
  assert.ok(
    h.owner.state.actions
      .filter((a) => a.status === 'submitted')
      .every((a) => a.timing.quality === 'primary' && a.timing.recovered === false),
  );
  h.clock.advance(30_000);
  await h.owner.track();
  assert.ok(chain.sent.length > sent, 'an action unseen for longer than the rebroadcast delay is rebroadcast');
  await h.cleanup();
});

test('HyperEVM keeps at most eight nonces ahead of latest and sends the rest as the window opens', async () => {
  const chain = fakeChain({ maxFeePerGas: 100_000_000n });
  chain.getTransactionCount = async () => chain.latest;
  const h = await harness({ chain, chainArgv: HYPER });
  const result = await h.owner.runSlot('2026-09-22T12:00Z');
  assert.equal(result.prepared, 10);
  assert.equal(result.submitted, 8);
  assert.equal(h.owner.state.actions.filter((a) => a.status === 'prepared').length, 2);
  assert.ok(h.logs.some((entry) => entry.type === 'nonce_window_full'));
  for (const action of h.owner.state.actions.slice(0, 3)) chain.include(action, { blockNumber: 1001n });
  chain.block = 1001n;
  h.clock.advance(1_500);
  await h.owner.track();
  assert.equal(
    h.owner.state.actions.filter((a) => a.status === 'prepared').length,
    0,
    'the tracker drains the backlog once latest advances',
  );
  assert.equal(submissionsInMinute(h.owner.state, '2026-09-22T12:00Z'), 10);
  await h.cleanup();
});

test('Elysium has no nonce window and still sends a full batch at once', async () => {
  const h = await harness();
  const result = await h.owner.runSlot('2026-09-22T12:00Z');
  assert.equal(result.submitted, 10);
  await h.cleanup();
});

test('HyperEVM reserves fee headroom over the estimate because its base fee moves', async () => {
  const chain = fakeChain({ maxFeePerGas: 100_000_000n });
  chain.getTransactionCount = async () => chain.latest;
  const h = await harness({ chain, chainArgv: HYPER });
  await h.owner.runSlot('2026-09-22T12:00Z');
  assert.equal(h.owner.state.actions[0].cost.worstCostWei, (80_000n * 200_000_000n).toString());
  const e = await harness({ chain: fakeChain({ maxFeePerGas: 100_000_000n }) });
  await e.owner.runSlot('2026-09-22T12:00Z');
  assert.equal(
    e.owner.state.actions[0].cost.worstCostWei,
    (80_000n * 100_000_000n).toString(),
    'Elysium keeps the estimate as is',
  );
  await h.cleanup();
  await e.cleanup();
});

test('rpc calls are spaced by the per-chain request budget', async () => {
  const sleeps = [];
  const clock = fakeClock();
  clock.sleep = async (ms) => {
    sleeps.push(ms);
  };
  const chain = fakeChain({ maxFeePerGas: 100_000_000n });
  chain.getTransactionCount = async () => chain.latest;
  const h = await harness({ chain, clock, chainArgv: HYPER });
  await h.owner.reconcile();
  assert.ok(sleeps.length >= 2, 'back-to-back calls wait for their slot');
  assert.ok(sleeps.every((ms) => ms > 0 && ms <= 1000));
  assert.ok(Math.abs(sleeps[1] - sleeps[0] - 1000 / 3) < 1e-6, 'HyperEVM calls are spaced at three per second');
  await h.cleanup();
});

test('gas is split into execution and parent-chain posting when the receipt carries gasUsedForL1', () => {
  const nitro = gasBreakdown({ gasUsedForL1: '0x5a7d', l1BlockNumber: '0x3df6b10' }, 52_014n, {
    baseFeePerGas: 10_000_000n,
  });
  assert.deepEqual(nitro, {
    blockBaseFeeWei: '10000000',
    l1BlockNumber: '64973584',
    gasUsedForL1: '23165',
    executionGas: '28849',
    breakdown: 'nitro',
  });
  const l1 = gasBreakdown({}, 28_849n, { baseFeePerGas: 100_000_000n });
  assert.deepEqual(l1, {
    blockBaseFeeWei: '100000000',
    l1BlockNumber: null,
    gasUsedForL1: null,
    executionGas: '28849',
    breakdown: 'none',
  });
  assert.equal(
    gasBreakdown({ gasUsedForL1: '0x999999' }, 100n, {}).breakdown,
    'rejected',
    'posting gas above the total is refused',
  );
  assert.equal(gasBreakdown({ gasUsedForL1: 'junk' }, 100n, {}).executionGas, null);
});

test('settled actions persist the gas split and base fee from the watched block', async () => {
  const chain = fakeChain();
  const h = await harness({ chain });
  await h.owner.runSlot('2026-09-22T12:00Z');
  const [first] = h.owner.state.actions;
  chain.include(first, { blockNumber: 1001n });
  const receipt = chain.receipts.get(first.hash.toLowerCase());
  receipt.gasUsed = 60_000n;
  receipt.gasUsedForL1 = '0x5dc0';
  const baseGetBlock = chain.getBlock;
  chain.getBlock = async (args) =>
    args.blockTag === 'latest' ? { ...blockWithHashes(1001n, [first.hash]), baseFeePerGas: 7n } : baseGetBlock(args);
  await h.owner.watch();
  chain.block = 1001n;
  await h.owner.track();
  assert.equal(first.cost.gasUsedForL1, '24000');
  assert.equal(first.cost.executionGas, '36000');
  assert.equal(first.cost.blockBaseFeeWei, '7');
  assert.equal(first.cost.breakdown, 'nitro');
  await h.cleanup();
});

test('on HyperEVM a stuck action is rebroadcast at most every 30 s and still raises the stuck-nonce hold', async () => {
  const chain = fakeChain({ maxFeePerGas: 100_000_000n });
  chain.getTransactionCount = async () => chain.latest;
  const h = await harness({ chain, chainArgv: HYPER });
  await h.owner.runSlot('2026-09-22T12:00Z');
  const baseline = chain.sent.length;
  h.clock.advance(31_000);
  await h.owner.track();
  const afterFirst = chain.sent.length;
  assert.ok(afterFirst > baseline, 'rebroadcast after 30 s');
  for (let i = 0; i < 5; i += 1) {
    h.clock.advance(2_000);
    await h.owner.track();
  }
  assert.equal(chain.sent.length, afterFirst, 'no rebroadcast on every poll');
  h.clock.advance(21_000);
  await h.owner.track();
  assert.ok(chain.sent.length > afterFirst, 'the next rebroadcast waits for another 30 s');
  h.clock.advance(300_000);
  await assert.rejects(
    () => h.owner.track(),
    (error) => error.code === 'HOLD',
  );
  assert.equal(h.owner.state.hold.type, 'stuck_nonce');
  await h.cleanup();
});

test('each send carries the clock offset measured at the start of its slot', async () => {
  let refreshes = 0;
  let due = true;
  const clockOffset = {
    due: () => due,
    refresh: async () => {
      refreshes += 1;
      due = false;
      return { offsetMs: 1180, servers: 3 };
    },
    current: () => ({ offsetMs: 1180 }),
  };
  const h = await harness({ clockOffset });
  await h.owner.runSlot('2026-09-22T12:00Z');
  assert.equal(refreshes, 1);
  assert.ok(h.owner.state.actions.every((action) => action.timing.clockOffsetMs === 1180));
  assert.ok(h.logs.some((entry) => entry.type === 'clock_offset' && entry.offsetMs === 1180));
  await h.owner.runSlot('2026-09-22T12:01Z');
  assert.equal(refreshes, 1, 'no refresh until the offset is due again');
  await h.cleanup();
});

test('a send without a usable clock offset records null instead of guessing', async () => {
  const h = await harness({
    clockOffset: {
      due: () => true,
      refresh: async () => {
        throw new Error('udp blocked');
      },
      current: () => null,
    },
  });
  await h.owner.runSlot('2026-09-22T12:00Z');
  assert.ok(h.owner.state.actions.every((action) => action.timing.clockOffsetMs === null));
  assert.ok(h.logs.some((entry) => entry.type === 'clock_offset' && entry.offsetMs === null));
  await h.cleanup();
});
