import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { millisecondsToNextMinute, runBenchmarkLoop } from '../src/loop.mjs';

test('schedules at the next minute boundary', () => {
  assert.equal(millisecondsToNextMinute(new Date('2026-09-22T12:00:00.000Z')), 60_000);
  assert.equal(millisecondsToNextMinute(new Date('2026-09-22T12:00:59.500Z')), 500);
});

function stubOwner(behaviour = {}) {
  const calls = { slots: [], tracks: 0, compacted: 0 };
  return {
    calls,
    state: { actions: [], batches: [] },
    async runSlot(slot) {
      calls.slots.push(slot);
      if (behaviour.slotError) throw behaviour.slotError;
      return { backlog: 0, prepared: 10, submitted: 10, outcome: 'submitted' };
    },
    async track() {
      calls.tracks += 1;
      if (behaviour.trackError && calls.tracks === behaviour.trackErrorAt) throw behaviour.trackError;
    },
    async compact() {
      calls.compacted += 1;
      return { archived: 0, files: [] };
    },
    async close() {},
  };
}

function loopClock(startIso = '2026-09-22T12:00:00.000Z') {
  let wall = Date.parse(startIso);
  return {
    now: () => new Date(wall),
    monotonic: () => wall,
    sleep: async (ms) => {
      wall += ms;
    },
  };
}

test('the benchmark loop tracks confirmations between minute boundaries and publishes aggregates', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elysium-loop-'));
  const owner = stubOwner();
  const result = await runBenchmarkLoop({
    owner,
    config: { stateDir: dir },
    benchmark: { pollIntervalMs: 15_000 },
    clock: loopClock(),
    signal: {},
    log: () => {},
    maxSlots: 2,
  });
  assert.equal(result.slots, 2);
  assert.deepEqual(owner.calls.slots, ['2026-09-22T12:00Z', '2026-09-22T12:01Z']);
  assert.equal(owner.calls.tracks, 8, 'four polls per minute at a fifteen second interval');
  assert.equal(owner.calls.compacted, 2);
  assert.ok(JSON.parse(await fs.readFile(path.join(dir, 'aggregates.json'), 'utf8')).confirmationLabel === '2-conf');
  await fs.rm(dir, { recursive: true });
});

test('a hold keeps the benchmark loop tracking while a halt stops it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elysium-loop-'));
  const logs = [];
  const held = stubOwner({ slotError: Object.assign(new Error('x'), { code: 'HOLD' }) });
  await runBenchmarkLoop({
    owner: held,
    config: { stateDir: dir },
    benchmark: { pollIntervalMs: 30_000 },
    clock: loopClock(),
    signal: {},
    log: (entry) => logs.push(entry),
    maxSlots: 2,
  });
  assert.equal(held.calls.slots.length, 2, 'a hold does not end the benchmark run');
  assert.ok(held.calls.tracks > 0, 'confirmation tracking continues through a hold');
  assert.deepEqual([...new Set(logs.map((entry) => entry.type))], ['benchmark_hold']);

  const halted = stubOwner({ slotError: Object.assign(new Error('x'), { code: 'HALT' }) });
  await runBenchmarkLoop({
    owner: halted,
    config: { stateDir: dir },
    benchmark: { pollIntervalMs: 30_000 },
    clock: loopClock(),
    signal: {},
    log: () => {},
    maxSlots: 5,
  });
  assert.equal(halted.calls.slots.length, 1, 'a halt stops the benchmark run immediately');
  assert.equal(halted.calls.tracks, 0);
  await fs.rm(dir, { recursive: true });
});

test('a receipt timeout surfaced by the tracker never ends the process run', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elysium-loop-'));
  const owner = stubOwner({ trackError: Object.assign(new Error('x'), { code: 'RPC' }), trackErrorAt: 1 });
  const result = await runBenchmarkLoop({
    owner,
    config: { stateDir: dir },
    benchmark: { pollIntervalMs: 30_000 },
    clock: loopClock(),
    signal: {},
    log: () => {},
    maxSlots: 2,
  });
  assert.equal(result.slots, 2);
  assert.equal(owner.calls.tracks, 4);
  await fs.rm(dir, { recursive: true });
});

test('benchmark loop log entries pass through redaction', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elysium-loop-'));
  const logs = [];
  const owner = stubOwner();
  owner.runSlot = async () => ({
    backlog: 0,
    prepared: 0,
    submitted: 0,
    outcome: `https://leak.example/${'cd'.repeat(32)}`,
  });
  await runBenchmarkLoop({
    owner,
    config: { stateDir: dir },
    benchmark: { pollIntervalMs: 30_000 },
    clock: loopClock(),
    signal: {},
    log: (entry) => logs.push(entry),
    maxSlots: 1,
  });
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes('leak.example'));
  assert.ok(!serialized.includes('cd'.repeat(32)));
  await fs.rm(dir, { recursive: true });
});

test('the benchmark loop drives the block watcher alongside slots and stops it on exit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elysium-loop-'));
  const owner = stubOwner();
  let watches = 0;
  owner.watch = async () => {
    watches += 1;
    await new Promise((resolve) => setImmediate(resolve));
  };
  await runBenchmarkLoop({
    owner,
    config: { stateDir: dir },
    benchmark: { pollIntervalMs: 30_000, watchIntervalMs: 500 },
    clock: loopClock(),
    signal: {},
    log: () => {},
    maxSlots: 1,
  });
  assert.ok(watches > 0, 'the watcher ran');
  const after = watches;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(watches, after, 'the watcher stops when the loop returns');
  await fs.rm(dir, { recursive: true });
});
