import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildDashboardPayload,
  collectDashboard,
  MINUTE_LIMIT,
  readArchiveSummary,
  readDashboardState,
  SERIES_LIMIT,
} from '../src/dashboard-data.mjs';

const WALLET = '0x00000000000000000000000000000000000000a1';
const CONTRACT = '0x00000000000000000000000000000000000000b2';
const CANARY = 'CANARY_MUST_NOT_LEAK';
const NOW = new Date('2026-09-22T12:00:00.000Z');
const BASE = Date.parse('2026-09-22T11:30:00.000Z');
const iso = (offset) => new Date(BASE + offset).toISOString();
const okChain = { balanceWei: '123456789000000000', blockNumber: '1200', pulseCount: '9', unavailable: null };

function v2Action(index, overrides = {}) {
  const at = index * 6000;
  return {
    id: `pulse:2026-09-22T11:30Z:${index}`,
    kind: 'pulse',
    slot: '2026-09-22T11:30Z',
    index,
    batchId: 'batch:2026-09-22T11:30Z',
    profile: 'benchmark-10',
    status: 'finalized',
    nonce: String(index),
    to: CONTRACT,
    data: `0x97dc97cb${CANARY}`,
    raw: `0x02f8${CANARY}`,
    hash: `0x${String(index % 10).repeat(64)}`,
    expected: {
      contractAddress: CONTRACT,
      entropy: `0x${'ab'.repeat(32)}`,
      countAfter: String(index + 1),
      secretNote: CANARY,
    },
    receipt: { blockNumber: String(2000 + index), blockHash: `0x${'cc'.repeat(32)}` },
    timing: {
      preparedAt: iso(at - 200),
      submitStartedAt: iso(at),
      rpcAcceptedAt: iso(at + 150),
      includedObservedAt: iso(at + 3000),
      blockTimestamp: '1790000000',
      confirmedObservedAt: iso(at + 7000),
      pollIntervalMs: 2000,
      quality: 'primary',
      recovered: false,
      processId: CANARY,
    },
    cost: {
      worstCostWei: '400000000000000',
      reservedDay: '2026-09-22',
      actualCostWei: '60000000000000',
      gasUsed: '60000',
      effectiveGasPriceWei: '1000000000',
    },
    undocumentedField: CANARY,
    ...overrides,
  };
}

function v2State(actions, batches = [], overrides = {}) {
  return {
    version: 2,
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
    batches,
    dailySpend: { '2026-09-22': '600000000000000' },
    dailyReserved: { '2026-09-22': '0' },
    hold: null,
    archive: { files: [`finalized-2026-09-22.ndjson-${CANARY}`], archivedActions: 7 },
    privateKey: `0x${'99'.repeat(32)}`,
    keyPath: `/home/user/.config/elysium-minute-loop/wallet.json`,
    undocumentedTopLevel: CANARY,
    ...overrides,
  };
}

async function tempStateDir(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elysium-bench-dash-'));
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  return dir;
}

test('a v2 journal with benchmark batches and new statuses is accepted, not rejected wholesale', async () => {
  const state = v2State(
    [
      v2Action(0),
      v2Action(1, { status: 'included' }),
      v2Action(2, { status: 'reverted' }),
      v2Action(3, { status: 'submitted' }),
    ],
    [
      { id: 'batch:2026-09-22T11:30Z', slot: '2026-09-22T11:30Z', outcome: 'submitted', plannedCount: 10 },
      { id: 'batch:2026-09-22T11:31Z', slot: '2026-09-22T11:31Z', outcome: 'capacity_skip', plannedCount: 0 },
    ],
  );
  const dir = await tempStateDir({ 'state.json': JSON.stringify(state) });
  const read = await readDashboardState(dir);
  assert.equal(read.unavailable, null);
  const payload = buildDashboardPayload({ read, chain: okChain, now: new Date(BASE + 60_000) });
  assert.equal(payload.benchmark.sampleCounts.actions, 4);
  assert.equal(payload.benchmark.skips.capacity, 1);
  assert.equal(payload.benchmark.rates.allTime.finalized, 1);
  assert.equal(payload.service.state, 'pending');
  await fs.rm(dir, { recursive: true });
});

test('every new benchmark and archive field survives a redaction canary sweep', () => {
  const state = v2State(
    [
      v2Action(0),
      v2Action(1, { timing: { ...v2Action(1).timing, quality: CANARY } }),
      v2Action(2, {
        cost: {
          worstCostWei: CANARY,
          actualCostWei: CANARY,
          gasUsed: CANARY,
          effectiveGasPriceWei: CANARY,
          reservedDay: CANARY,
        },
      }),
      v2Action(3, { status: CANARY }),
    ],
    [
      {
        id: CANARY,
        slot: CANARY,
        outcome: CANARY,
        plannedCount: CANARY,
        openedAt: CANARY,
        firstNonce: CANARY,
        worstCostWei: CANARY,
      },
    ],
    { hold: { type: CANARY, nonce: CANARY, since: CANARY } },
  );
  const payload = buildDashboardPayload({
    read: { state, halted: false, unavailable: null },
    chain: okChain,
    now: NOW,
    archive: {
      summary: { generatedAt: CANARY, actions: CANARY, batches: 1, primaryEndToEnd: 1, recovered: 0 },
      unavailable: null,
    },
  });
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes(CANARY), 'a canary leaked into the benchmark payload');
  for (const forbidden of [
    '"raw"',
    '"data"',
    '"expected"',
    'privateKey',
    'keyPath',
    'wallet.json',
    'entropy',
    'processId',
    'ndjson',
    'dailyReserved',
    'blockHash',
    'undocumented',
  ]) {
    assert.ok(!serialized.includes(forbidden), `benchmark payload exposed ${forbidden}`);
  }
  assert.deepEqual(Object.keys(payload.benchmark).sort(), [
    'confirmationLabel',
    'cost',
    'histogram',
    'minutes',
    'phases',
    'primaryQuality',
    'rates',
    'sampleCounts',
    'series',
    'skips',
  ]);
  assert.deepEqual(Object.keys(payload.archive).sort(), [
    'aggregatesActions',
    'aggregatesGeneratedAt',
    'archivedActions',
  ]);
  assert.equal(payload.archive.archivedActions, 7);
  assert.equal(payload.archive.aggregatesActions, null, 'a non-integer archived count is dropped, not echoed');
});

test('phases, histogram and per-minute series are reported separately and stay typed', () => {
  const actions = Array.from({ length: 10 }, (_, index) => v2Action(index));
  const payload = buildDashboardPayload({
    read: {
      state: v2State(actions, [
        { id: 'batch:2026-09-22T11:30Z', slot: '2026-09-22T11:30Z', outcome: 'submitted', plannedCount: 10 },
      ]),
      halted: false,
      unavailable: null,
    },
    chain: okChain,
    now: NOW,
  });
  const benchmark = payload.benchmark;
  assert.equal(benchmark.confirmationLabel, '2-conf');
  assert.equal(benchmark.phases.submit_to_accept.p50Ms, 150);
  assert.equal(benchmark.phases.submit_to_inclusion.p50Ms, 3000);
  assert.equal(benchmark.phases.inclusion_to_2conf.p50Ms, 4000);
  assert.equal(benchmark.phases.end_to_end.p50Ms, 7000);
  assert.equal(benchmark.phases.end_to_end.count, 10);
  assert.equal(benchmark.phases.end_to_end.cv, 0);
  assert.equal(benchmark.histogram.bucketMs, 15_000);
  assert.deepEqual(
    benchmark.histogram.buckets.map((bucket) => bucket.count),
    [10],
  );
  assert.equal(benchmark.minutes[0].plannedCount, 10);
  assert.equal(benchmark.minutes[0].finalized, 10);
  assert.equal(benchmark.cost.today.actualCostWei, '600000000000000');
  assert.equal(benchmark.cost.today.worstCostWei, '4000000000000000');
  assert.equal(benchmark.series.length, 10);
  assert.deepEqual(Object.keys(benchmark.series[0]).sort(), [
    'acceptMs',
    'at',
    'endToEndMs',
    'inclusionMs',
    'quality',
    'status',
  ]);
});

test('recovered and migrated samples are labelled and kept out of primary percentiles', () => {
  const actions = [
    v2Action(0),
    v2Action(1, {
      timing: { ...v2Action(1).timing, quality: 'recovered', recovered: true, confirmedObservedAt: iso(900_000) },
    }),
    v2Action(2, { timing: { ...v2Action(2).timing, quality: 'migrated', confirmedObservedAt: iso(900_000) } }),
  ];
  const payload = buildDashboardPayload({
    read: { state: v2State(actions), halted: false, unavailable: null },
    chain: okChain,
    now: NOW,
  });
  assert.equal(payload.benchmark.phases.end_to_end.count, 1);
  assert.equal(payload.benchmark.phases.end_to_end.maxMs, 7000);
  assert.equal(payload.benchmark.sampleCounts.recovered, 2);
  assert.deepEqual(
    payload.benchmark.series.map((point) => point.quality),
    ['primary', 'recovered', 'migrated'],
  );
  assert.equal(payload.transactions.find((tx) => tx.nonce === '1').quality, 'recovered');
});

test('series and minute history are bounded so the payload cannot grow without limit', () => {
  const actions = Array.from({ length: 1200 }, (_, index) => ({
    ...v2Action(index % 10),
    id: `pulse:x:${index}`,
    nonce: String(index),
    timing: {
      ...v2Action(0).timing,
      rpcAcceptedAt: new Date(BASE - index * 60_000).toISOString(),
      submitStartedAt: new Date(BASE - index * 60_000).toISOString(),
      includedObservedAt: new Date(BASE - index * 60_000 + 3000).toISOString(),
      confirmedObservedAt: new Date(BASE - index * 60_000 + 7000).toISOString(),
      quality: 'primary',
      recovered: false,
    },
  }));
  const payload = buildDashboardPayload({
    read: { state: v2State(actions), halted: false, unavailable: null },
    chain: okChain,
    now: NOW,
  });
  assert.equal(payload.benchmark.series.length, SERIES_LIMIT);
  assert.equal(payload.benchmark.minutes.length, MINUTE_LIMIT);
  assert.ok(payload.benchmark.histogram.buckets.length <= 40);
  assert.equal(payload.transactions.length, 25);
  assert.ok(JSON.stringify(payload).length < 250_000, 'dashboard payload must stay bounded');
});

test('aggregates.json is optional and typed as unavailable rather than invented', async () => {
  const missing = await tempStateDir();
  assert.deepEqual(await readArchiveSummary(missing), { summary: null, unavailable: 'missing' });
  const broken = await tempStateDir({ 'aggregates.json': `not json ${CANARY}` });
  assert.deepEqual(await readArchiveSummary(broken), { summary: null, unavailable: 'invalid' });
  const noCounts = await tempStateDir({
    'aggregates.json': JSON.stringify({ generatedAt: '2026-09-22T12:00:00.000Z' }),
  });
  assert.equal((await readArchiveSummary(noCounts)).unavailable, 'invalid');
  const good = await tempStateDir({
    'aggregates.json': JSON.stringify({
      generatedAt: '2026-09-22T11:59:00.000Z',
      sampleCounts: { actions: 42, batches: 5, primaryEndToEnd: 40, recovered: 2 },
      secretNote: CANARY,
    }),
  });
  const summary = await readArchiveSummary(good);
  assert.equal(summary.unavailable, null);
  assert.equal(summary.summary.actions, 42);
  assert.ok(!JSON.stringify(summary).includes(CANARY));
  for (const dir of [missing, broken, noCounts, good]) await fs.rm(dir, { recursive: true });
});

test('collectDashboard reads aggregates without writing anything into the state directory', async () => {
  const dir = await tempStateDir({
    'state.json': JSON.stringify(
      v2State(
        [v2Action(0)],
        [{ id: 'batch:2026-09-22T11:30Z', slot: '2026-09-22T11:30Z', outcome: 'submitted', plannedCount: 10 }],
      ),
    ),
    'aggregates.json': JSON.stringify({
      generatedAt: '2026-09-22T11:59:00.000Z',
      sampleCounts: { actions: 400, batches: 40, primaryEndToEnd: 380, recovered: 20 },
    }),
    'finalized-2026-09-22.ndjson': `{"id":"pulse:old:0"}\n`,
  });
  const before = (await fs.readdir(dir)).sort();
  const payload = await collectDashboard({ stateDir: dir, rpc: null, now: () => NOW });
  assert.deepEqual((await fs.readdir(dir)).sort(), before);
  assert.equal(payload.unavailable.aggregates, null);
  assert.equal(payload.archive.aggregatesActions, 400);
  assert.equal(payload.archive.aggregatesGeneratedAt, '2026-09-22T11:59:00.000Z');
  assert.ok(!JSON.stringify(payload).includes(CANARY));
  await fs.rm(dir, { recursive: true });
});

test('a legacy v1 journal still renders while its samples are never counted as primary', async () => {
  const legacy = {
    version: 1,
    walletAddress: WALLET,
    deployment: { address: CONTRACT, txHash: `0x${'22'.repeat(32)}`, blockNumber: '900' },
    actions: [
      {
        id: 'pulse:2026-09-22T11:30Z',
        kind: 'pulse',
        slot: '2026-09-22T11:30Z',
        status: 'finalized',
        nonce: '1',
        hash: `0x${'11'.repeat(32)}`,
        createdAt: iso(0),
        broadcastAt: iso(500),
        finalizedAt: iso(9000),
        receipt: { blockNumber: '2000' },
        worstCost: '400000000000000',
      },
    ],
    dailySpend: { '2026-09-22': '400000000000000' },
  };
  const dir = await tempStateDir({ 'state.json': JSON.stringify(legacy) });
  const payload = await collectDashboard({ stateDir: dir, rpc: null, now: () => NOW });
  assert.equal(payload.unavailable.state, null);
  assert.equal(payload.journal.finalizedPulses, 1);
  assert.equal(payload.latency.lastMs, 8500);
  assert.equal(payload.benchmark.phases.end_to_end.count, 0, 'unmigrated v1 timings are not benchmark-grade samples');
  assert.equal(payload.benchmark.sampleCounts.actions, 1);
  await fs.rm(dir, { recursive: true });
});
