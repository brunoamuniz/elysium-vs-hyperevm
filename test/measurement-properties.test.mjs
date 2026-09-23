import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAINS } from '../src/config.mjs';
import { emptyState } from '../src/state.mjs';
import { buildCompareSnapshot, chainInclusionMs } from '../src/compare-snapshot.mjs';
import { latencySamples, phaseLatency, summarize } from '../src/benchmark-metrics.mjs';

const BASE = Date.parse('2026-09-23T11:21:00.000Z');
const NOW = new Date('2026-09-24T12:00:00.000Z');

function sample(index, { delayMs, offsetMs = 0, start = BASE }) {
  const submitReal = start + index * 6_037;
  return {
    id: `pulse:${index}`,
    kind: 'pulse',
    profile: 'benchmark-10',
    status: 'finalized',
    hash: `0x${index.toString(16).padStart(64, 'b')}`,
    timing: {
      measurementVersion: 4,
      clockOffsetMs: offsetMs,
      quality: 'primary',
      recovered: false,
      submitStartedAt: new Date(submitReal - offsetMs).toISOString(),
      rpcAcceptedAt: new Date(submitReal - offsetMs + 450).toISOString(),
      blockTimestamp: String(Math.floor((submitReal + delayMs) / 1000)),
    },
  };
}

function snapshot(elysium, hyper) {
  const source = (chainId, actions) => ({
    chain: CHAINS[chainId],
    halted: false,
    archived: [],
    state: { ...emptyState(null, CHAINS[chainId].chainId), actions },
  });
  return buildCompareSnapshot({
    sources: [source('elysium-testnet', elysium), source('hyperevm-testnet', hyper)],
    now: NOW,
  });
}

const median = (values) => {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length / 2) - 1];
};

test('for any true delay the chain-side median lands within 60 ms of the truth and no sample is dropped', () => {
  for (const delayMs of [0, 40, 180, 499, 500, 750, 1200, 1600, 2500]) {
    const values = Array.from({ length: 800 }, (_, i) => chainInclusionMs(sample(i, { delayMs }).timing));
    assert.equal(values.filter((value) => value === null).length, 0, `delay ${delayMs} ms dropped samples`);
    const estimate = median(values);
    assert.ok(Math.abs(estimate - delayMs) <= 60, `true ${delayMs} ms estimated as ${estimate} ms`);
  }
});

test('the headline never reads exactly 0 ms for a chain with a real, positive delay', () => {
  const result = snapshot(
    Array.from({ length: 400 }, (_, i) => sample(i, { delayMs: 150 })),
    Array.from({ length: 400 }, (_, i) => sample(i, { delayMs: 1500 })),
  );
  const [elysium, hyper] = result.chains;
  assert.notEqual(elysium.metrics.chainInclusion.p50Ms, 0);
  assert.ok(elysium.metrics.chainInclusion.count === 400, 'fast same-second samples are kept');
  assert.ok(Math.abs(elysium.metrics.chainInclusion.p50Ms - 150) <= 60);
  assert.ok(Math.abs(hyper.metrics.chainInclusion.p50Ms - 1500) <= 60);
  assert.ok(Math.abs(result.comparison.diffP50Ms - -1350) <= 90);
});

test('a constant host clock error changes nothing once its offset is recorded', () => {
  for (const offsetMs of [-1500, -300, 0, 450, 1219, 2800]) {
    const values = Array.from({ length: 400 }, (_, i) =>
      chainInclusionMs(sample(i, { delayMs: 180, offsetMs }).timing),
    );
    assert.ok(Math.abs(median(values) - 180) <= 60, `offset ${offsetMs} ms moved the median to ${median(values)}`);
  }
});

test('a host clock drifting 200 ms per hour keeps the corrected hourly medians flat', () => {
  const perHour = 600;
  const actions = Array.from({ length: perHour * 10 }, (_, i) => {
    const hour = Math.floor(i / perHour);
    return sample(i, { delayMs: 180, offsetMs: hour * 200, start: BASE });
  });
  const result = snapshot(
    actions,
    actions.map((entry) => ({ ...entry, id: `${entry.id}:h` })),
  );
  const hourly = result.chains[0].hourly.map((entry) => entry.chainInclusionP50Ms);
  assert.ok(hourly.length >= 9);
  assert.ok(Math.max(...hourly) - Math.min(...hourly) <= 120, `hourly medians drift: ${hourly.join(', ')}`);
});

test('an uncorrected drifting clock would show up as a trend, which is what the correction removes', () => {
  const values = (hour, offsetMs) =>
    Array.from({ length: 300 }, (_, i) =>
      chainInclusionMs({ ...sample(hour * 300 + i, { delayMs: 180, offsetMs }).timing, clockOffsetMs: 0 }),
    );
  const early = median(values(0, 0));
  const late = median(values(8, 1600));
  assert.ok(late - early > 1000, 'without a recorded offset the drift inflates later hours');
});

test('the operator metrics keep same-second samples too, so both views agree', () => {
  const actions = Array.from({ length: 500 }, (_, i) => sample(i, { delayMs: 120 }));
  const summary = summarize(latencySamples(actions, 'chain_inclusion'));
  assert.equal(summary.count, 500, 'negative midpoint estimates are not filtered out');
  assert.ok(Math.abs(summary.p50Ms - 120) <= 60);
  const first = phaseLatency(actions[0], 'chain_inclusion');
  assert.equal(first, chainInclusionMs(actions[0].timing), 'operator and public views compute the same value');
});

test('a block from an earlier second than the send is rejected, not counted as fast', () => {
  const timing = {
    measurementVersion: 4,
    clockOffsetMs: 0,
    submitStartedAt: '2026-09-23T12:00:05.000Z',
    blockTimestamp: String(Date.parse('2026-09-23T12:00:04Z') / 1000),
  };
  assert.equal(chainInclusionMs(timing), null);
  assert.equal(
    chainInclusionMs({ ...timing, submitStartedAt: '2026-09-23T12:00:04.999Z' }),
    -499,
    'the same second is still accepted',
  );
});
