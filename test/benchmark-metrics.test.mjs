import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAggregates,
  costTotals,
  DEFAULT_HISTOGRAM_BUCKET_MS,
  histogram,
  isPrimary,
  latencySamples,
  latencySeries,
  MAX_HISTOGRAM_BUCKETS,
  minuteBatches,
  percentile,
  phaseLatency,
  successRates,
  summarize,
  utcMinute,
} from '../src/benchmark-metrics.mjs';

const BASE = Date.parse('2026-09-22T12:00:00.000Z');
const iso = (offset) => new Date(BASE + offset).toISOString();

function action({
  index = 0,
  status = 'finalized',
  submit = 0,
  accept = 200,
  included = 3000,
  confirmed = 7000,
  quality = 'primary',
  recovered = false,
  cost = {},
  blockTimestamp = null,
} = {}) {
  return {
    id: `pulse:slot:${index}`,
    kind: 'pulse',
    status,
    nonce: String(index),
    timing: {
      preparedAt: iso(submit - 100),
      submitStartedAt: iso(submit),
      rpcAcceptedAt: accept === null ? null : iso(submit + accept),
      includedObservedAt: included === null ? null : iso(submit + included),
      confirmedObservedAt: confirmed === null ? null : iso(submit + confirmed),
      blockTimestamp,
      pollIntervalMs: 2000,
      quality,
      recovered,
    },
    cost: {
      worstCostWei: '1500000000000000',
      reservedDay: '2026-09-22',
      actualCostWei: '400000000000000',
      gasUsed: '80000',
      effectiveGasPriceWei: '5000000000',
      ...cost,
    },
  };
}

test('summarize returns count, min, max, mean, stdev, cv and nearest-rank percentiles', () => {
  const stats = summarize([1000, 2000, 3000, 4000, 5000]);
  assert.equal(stats.count, 5);
  assert.equal(stats.minMs, 1000);
  assert.equal(stats.maxMs, 5000);
  assert.equal(stats.meanMs, 3000);
  assert.equal(stats.stdevMs, 1414.21);
  assert.equal(stats.cv, 0.4714);
  assert.equal(stats.p50Ms, 3000);
  assert.equal(stats.p95Ms, 5000);
});

test('zero and single sample windows never invent statistics or divide by zero', () => {
  assert.deepEqual(summarize([]), {
    count: 0,
    minMs: null,
    maxMs: null,
    meanMs: null,
    stdevMs: null,
    cv: null,
    p50Ms: null,
    p95Ms: null,
  });
  assert.deepEqual(summarize(undefined).count, 0);
  const one = summarize([2500]);
  assert.deepEqual([one.count, one.stdevMs, one.cv, one.p50Ms, one.p95Ms], [1, 0, 0, 2500, 2500]);
  assert.equal(summarize([0, 0]).cv, null, 'a zero mean must not produce an infinite coefficient of variation');
  assert.equal(percentile([], 50), null);
});

test('malformed, missing and negative intervals are dropped rather than coerced', () => {
  assert.equal(phaseLatency(action({ accept: null }), 'submit_to_accept'), null);
  assert.equal(
    phaseLatency({ timing: { submitStartedAt: 'not-a-date', rpcAcceptedAt: iso(500) } }, 'submit_to_accept'),
    null,
  );
  assert.equal(
    phaseLatency({ timing: { submitStartedAt: iso(5000), confirmedObservedAt: iso(0) } }, 'end_to_end'),
    null,
    'a negative interval is not a latency',
  );
  assert.equal(
    phaseLatency({ timing: { submitStartedAt: iso(0), confirmedObservedAt: iso(90_000_000) } }, 'end_to_end'),
    null,
    'an implausible interval is rejected',
  );
  assert.equal(phaseLatency({}, 'end_to_end'), null);
  assert.equal(phaseLatency(action(), 'not_a_phase'), null);
  assert.equal(phaseLatency(action({ blockTimestamp: 'abc' }), 'chain_inclusion'), null);
  assert.equal(phaseLatency(action({ blockTimestamp: String(Math.floor(BASE / 1000) + 3) }), 'chain_inclusion'), 3000);
});

test('primary percentile samples exclude recovered, migrated and drift-flagged actions', () => {
  const actions = [
    action({ index: 1, confirmed: 4000 }),
    action({ index: 2, confirmed: 6000 }),
    action({ index: 3, confirmed: 900_000, quality: 'migrated' }),
    action({ index: 4, confirmed: 900_000, quality: 'recovered' }),
    action({ index: 5, confirmed: 900_000, quality: 'primary', recovered: true }),
    action({ index: 6, confirmed: 900_000, quality: 'drift' }),
  ];
  assert.deepEqual(latencySamples(actions, 'end_to_end'), [4000, 6000]);
  assert.equal(latencySamples(actions, 'end_to_end', { primaryOnly: false }).length, 6);
  assert.equal(isPrimary(actions[4]), false);
  assert.equal(summarize(latencySamples(actions, 'end_to_end')).p95Ms, 6000);
});

test('chain inclusion, observer inclusion and confirmation phases are reported separately', () => {
  const one = action({
    submit: 0,
    accept: 150,
    included: 3000,
    confirmed: 7000,
    blockTimestamp: String(Math.floor(BASE / 1000) + 2),
  });
  assert.equal(phaseLatency(one, 'submit_to_accept'), 150);
  assert.equal(phaseLatency(one, 'submit_to_inclusion'), 3000);
  assert.equal(phaseLatency(one, 'inclusion_to_2conf'), 4000);
  assert.equal(phaseLatency(one, 'end_to_end'), 7000);
  assert.equal(phaseLatency(one, 'chain_inclusion'), 2000);
});

test('sample windows are capped so an unbounded journal cannot grow the metrics', () => {
  const actions = Array.from({ length: 2500 }, (_, index) => action({ index, confirmed: 1000 + index }));
  assert.equal(latencySamples(actions, 'end_to_end').length, 2000);
  assert.equal(latencySamples(actions, 'end_to_end', { limit: 10 }).length, 10);
  assert.equal(latencySeries(actions, { limit: 25 }).length, 25);
});

test('histogram buckets are configurable, bounded and reject unsupported widths', () => {
  const buckets = histogram([1000, 14_999, 15_000, 44_000], 15_000);
  assert.equal(buckets.bucketMs, 15_000);
  assert.deepEqual(
    buckets.buckets.map((bucket) => bucket.count),
    [2, 1, 1],
  );
  assert.equal(histogram([1000, 45_000], 30_000).buckets.length, 2);
  assert.equal(histogram([1000], 60_000).buckets.length, 1);
  assert.deepEqual(histogram([], DEFAULT_HISTOGRAM_BUCKET_MS), { bucketMs: 15_000, overflowCount: 0, buckets: [] });
  assert.throws(() => histogram([1], 7000), /15000, 30000 or 60000/);
  const wide = histogram([15_000 * (MAX_HISTOGRAM_BUCKETS + 5)], 15_000);
  assert.equal(wide.buckets.length, MAX_HISTOGRAM_BUCKETS);
  assert.equal(wide.overflowCount, 1);
});

test('minute batches report partial batches, skips and expected counts without inventing samples', () => {
  const actions = [
    action({ index: 0, status: 'finalized', confirmed: 4000 }),
    action({ index: 1, status: 'finalized', confirmed: 6000 }),
    action({ index: 2, status: 'submitted', included: null, confirmed: null }),
    action({ index: 3, status: 'reverted', confirmed: 5000, quality: 'migrated' }),
  ];
  const batches = [
    { id: 'batch:2026-09-22T12:00Z', slot: '2026-09-22T12:00Z', outcome: 'submitted', plannedCount: 10 },
    { id: 'batch:2026-09-22T12:01Z', slot: '2026-09-22T12:01Z', outcome: 'capacity_skip', plannedCount: 0 },
  ];
  const minutes = minuteBatches(actions, batches);
  const first = minutes.find((minute) => minute.minute === '2026-09-22T12:00Z');
  assert.equal(first.submitted, 4);
  assert.equal(first.included, 3);
  assert.equal(first.finalized, 2);
  assert.equal(first.reverted, 1);
  assert.equal(first.pending, 1);
  assert.equal(first.plannedCount, 10);
  assert.equal(first.minLatencyMs, 4000);
  assert.equal(first.maxLatencyMs, 6000);
  assert.equal(first.meanLatencyMs, 5000, 'migrated samples must not enter the batch consistency band');
  const skipped = minutes.find((minute) => minute.minute === '2026-09-22T12:01Z');
  assert.equal(skipped.skipped, 1);
  assert.equal(skipped.submitted, 0);
  assert.equal(skipped.minLatencyMs, null);
});

test('duplicate slots collapse into one minute bucket and the series stays ordered', () => {
  const actions = [
    action({ index: 0, confirmed: 4000 }),
    action({ index: 1, confirmed: 5000 }),
    action({ index: 2, confirmed: 6000 }),
  ];
  const batches = [
    { id: 'a', slot: '2026-09-22T12:00Z', outcome: 'submitted', plannedCount: 10 },
    { id: 'b', slot: '2026-09-22T12:00Z', outcome: 'capacity_skip', plannedCount: 0 },
  ];
  const minutes = minuteBatches(actions, batches);
  assert.equal(minutes.length, 1);
  assert.equal(minutes[0].submitted, 3);
  assert.equal(minutes[0].skipped, 1);
  assert.equal(utcMinute(iso(0)), '2026-09-22T12:00Z');
  assert.equal(utcMinute('garbage'), null);
});

test('costs sum settled receipts separately from worst-case reservations and scope to a day', () => {
  const actions = [
    action({ index: 0 }),
    action({ index: 1, cost: { actualCostWei: null, gasUsed: null, effectiveGasPriceWei: null } }),
    action({ index: 2, cost: { reservedDay: '2026-09-21' } }),
  ];
  const all = costTotals(actions);
  assert.equal(all.settledActions, 2);
  assert.equal(all.actualCostWei, '800000000000000');
  assert.equal(all.worstCostWei, '4500000000000000');
  assert.equal(all.gasUsed, '160000');
  assert.equal(all.meanEffectiveGasPriceWei, '5000000000');
  const today = costTotals(actions, { day: '2026-09-22' });
  assert.equal(today.settledActions, 1);
  assert.equal(today.actualCostWei, '400000000000000');
  assert.equal(costTotals([]).actualCostWei, '0');
  assert.equal(costTotals([{ cost: { actualCostWei: 'nope', worstCostWei: -5 } }]).actualCostWei, '0');
});

test('success rates are windowed and never divide by a zero denominator', () => {
  const nowMs = BASE + 10_000;
  const actions = [
    action({ index: 0 }),
    action({ index: 1, status: 'reverted' }),
    action({ index: 2, status: 'submitted', included: null, confirmed: null }),
    { id: 'x', status: 'reconcile_required', timing: { rpcAcceptedAt: iso(100) } },
  ];
  const all = successRates(actions, { nowMs });
  assert.equal(all.submitted, 3);
  assert.equal(all.included, 2);
  assert.equal(all.finalized, 1);
  assert.equal(all.reverted, 1);
  assert.equal(all.pending, 1);
  assert.equal(all.reconcileRequired, 1);
  assert.equal(all.inclusionRate, 0.6667);
  assert.equal(all.finalizationRate, 0.3333);
  const hour = successRates(actions, { nowMs: BASE + 7_200_000, windowMs: 3_600_000 });
  assert.equal(hour.submitted, 0);
  assert.equal(hour.inclusionRate, null);
  assert.equal(successRates([], { nowMs }).finalizationRate, null);
});

test('buildAggregates produces a bounded, fully typed benchmark snapshot from an empty journal', () => {
  const aggregates = buildAggregates({ actions: [], batches: [] }, { now: new Date(BASE) });
  assert.equal(aggregates.confirmationLabel, '2-conf');
  assert.equal(aggregates.sampleCounts.actions, 0);
  assert.equal(aggregates.phases.end_to_end.count, 0);
  assert.deepEqual(aggregates.minutes, []);
  assert.deepEqual(aggregates.skips, { capacity: 0, budget: 0, hold: 0 });
  assert.equal(aggregates.cost.today.actualCostWei, '0');
});

test('buildAggregates counts skips by type and separates recovered from primary samples', () => {
  const state = {
    actions: [
      action({ index: 0, confirmed: 4000 }),
      action({ index: 1, confirmed: 900_000, quality: 'recovered' }),
      {
        kind: 'deploy',
        status: 'finalized',
        timing: { submitStartedAt: iso(0), confirmedObservedAt: iso(500_000), quality: 'primary' },
      },
    ],
    batches: [
      { id: 'a', slot: '2026-09-22T12:00Z', outcome: 'capacity_skip' },
      { id: 'b', slot: '2026-09-22T12:01Z', outcome: 'budget_skip' },
      { id: 'c', slot: '2026-09-22T12:02Z', outcome: 'hold_skip' },
    ],
  };
  const aggregates = buildAggregates(state, { now: new Date(BASE) });
  assert.deepEqual(aggregates.skips, { capacity: 1, budget: 1, hold: 1 });
  assert.equal(aggregates.sampleCounts.actions, 2, 'deployments are not benchmark samples');
  assert.equal(aggregates.sampleCounts.primaryEndToEnd, 1);
  assert.equal(aggregates.sampleCounts.recovered, 1);
  assert.equal(aggregates.phases.end_to_end.maxMs, 4000);
});

test('chain inclusion treats sub-second negative deltas from whole-second block timestamps as zero', async () => {
  const { phaseLatency } = await import('../src/benchmark-metrics.mjs');
  const at = (iso, blockTimestamp) => ({ timing: { submitStartedAt: iso, blockTimestamp } });
  assert.equal(
    phaseLatency(at('2026-09-22T12:00:03.228Z', String(Date.parse('2026-09-22T12:00:03Z') / 1000)), 'chain_inclusion'),
    0,
  );
  assert.equal(
    phaseLatency(at('2026-09-22T12:00:03.228Z', String(Date.parse('2026-09-22T12:00:05Z') / 1000)), 'chain_inclusion'),
    1772,
  );
  assert.equal(
    phaseLatency(at('2026-09-22T12:00:03.228Z', String(Date.parse('2026-09-22T12:00:01Z') / 1000)), 'chain_inclusion'),
    null,
    'a block more than a second before submit is not our inclusion',
  );
});
