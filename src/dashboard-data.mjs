import fs from 'node:fs/promises';
import path from 'node:path';
import { CHAIN_ID } from './config.mjs';
import { HOLD_TYPES, validateReadableState } from './state.mjs';
import { buildAggregates, latencySeries } from './benchmark-metrics.mjs';

export const SERVICE_STATES = ['halted', 'reconcile_required', 'pending', 'not_deployed', 'active', 'stale', 'unknown'];
export const ACTION_STATUSES = [
  'prepared',
  'broadcast',
  'submitted',
  'confirmed',
  'included',
  'finalized',
  'reverted',
  'reconcile_required',
];
export const UNRESOLVED_STATUSES = ['prepared', 'broadcast', 'submitted', 'confirmed', 'included'];
export const SERIES_LIMIT = 300;
export const MINUTE_LIMIT = 180;
export const LATENCY_SAMPLE_LIMIT = 200;
export const LATENCY_MIN_SAMPLES = 5;
export const STALE_AFTER_MS = 180_000;
export const TRANSACTION_LIMIT = 25;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const SLOT_RE = /^[0-9A-Za-z:_.-]{1,40}$/;
const ID_RE = /^[0-9A-Za-z:_.-]{1,64}$/;

function address(value) {
  return typeof value === 'string' && ADDRESS_RE.test(value) ? value : null;
}
function hash(value) {
  return typeof value === 'string' && HASH_RE.test(value) ? value : null;
}
function label(value, pattern) {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}
function quantity(value) {
  if (typeof value === 'bigint') return value >= 0n ? value.toString() : null;
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value === 'string' && /^[0-9]{1,78}$/.test(value)) return value.replace(/^0+(?=[0-9])/, '');
  return null;
}
function timestamp(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function epoch(value) {
  const iso = timestamp(value);
  const ms = iso === null ? NaN : Date.parse(iso);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
function count(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1e12 ? value : null;
}
function actions(state) {
  return Array.isArray(state?.actions) ? state.actions.filter((action) => action && typeof action === 'object') : [];
}
function dayKey(now) {
  return now.toISOString().slice(0, 10);
}
function holdType(value) {
  return HOLD_TYPES.includes(value) ? value : null;
}
function recordedHold(state) {
  return state?.hold && typeof state.hold === 'object' && holdType(state.hold.type) ? state.hold : null;
}
function lastClearedHold(state) {
  const history = Array.isArray(state?.holdHistory) ? state.holdHistory : [];
  const last = history[history.length - 1];
  return last && typeof last === 'object' && holdType(last.type)
    ? { type: last.type, clearedAt: timestamp(last.clearedAt) }
    : null;
}

export async function readDashboardState(stateDir) {
  let halted;
  try {
    await fs.access(path.join(stateDir, 'HALT'));
    halted = true;
  } catch (error) {
    if (error.code === 'ENOENT') halted = false;
    else return { state: null, halted: null, unavailable: 'unreadable' };
  }
  let text;
  try {
    text = await fs.readFile(path.join(stateDir, 'state.json'), 'utf8');
  } catch (error) {
    return { state: null, halted, unavailable: error.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
    validateReadableState(parsed);
  } catch {
    return { state: null, halted, unavailable: 'invalid' };
  }
  return { state: parsed, halted, unavailable: null };
}

export async function readArchiveSummary(stateDir) {
  let text;
  try {
    text = await fs.readFile(path.join(stateDir, 'aggregates.json'), 'utf8');
  } catch (error) {
    return { summary: null, unavailable: error.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    const parsed = JSON.parse(text);
    const counts = parsed?.sampleCounts;
    if (!counts || typeof counts !== 'object') return { summary: null, unavailable: 'invalid' };
    return {
      summary: {
        generatedAt: timestamp(parsed.generatedAt),
        actions: count(counts.actions),
        batches: count(counts.batches),
        primaryEndToEnd: count(counts.primaryEndToEnd),
        recovered: count(counts.recovered),
      },
      unavailable: null,
    };
  } catch {
    return { summary: null, unavailable: 'invalid' };
  }
}

export async function readChain({ rpc, walletAddress, contractAddress }) {
  const empty = { balanceWei: null, blockNumber: null, pulseCount: null };
  if (!rpc) return { ...empty, unavailable: 'unconfigured' };
  try {
    const [blockNumber, balance, count] = await Promise.all([
      rpc.getBlockNumber(),
      walletAddress ? rpc.getBalance(walletAddress) : null,
      contractAddress ? rpc.getPulseCount(contractAddress) : null,
    ]);
    return {
      balanceWei: quantity(balance),
      blockNumber: quantity(blockNumber),
      pulseCount: quantity(count),
      unavailable: null,
    };
  } catch {
    return { ...empty, unavailable: 'unreachable' };
  }
}

function publicTransaction(action) {
  const broadcastAt = timestamp(action.timing?.rpcAcceptedAt) ?? timestamp(action.broadcastAt);
  const finalizedAt = timestamp(action.timing?.confirmedObservedAt) ?? timestamp(action.finalizedAt);
  const start = epoch(action.timing?.rpcAcceptedAt) ?? epoch(action.broadcastAt);
  const end = epoch(action.timing?.confirmedObservedAt) ?? epoch(action.finalizedAt);
  const latencyMs = start !== null && end !== null && end - start >= 0 ? end - start : null;
  return {
    id: label(action.id, ID_RE),
    kind: action.kind === 'deploy' || action.kind === 'pulse' ? action.kind : 'unknown',
    slot: label(action.slot, SLOT_RE),
    status: ACTION_STATUSES.includes(action.status) ? action.status : 'unknown',
    hash: hash(action.hash),
    nonce: quantity(action.nonce),
    createdAt: timestamp(action.timing?.preparedAt) ?? timestamp(action.createdAt),
    broadcastAt,
    finalizedAt,
    blockNumber: quantity(action.receipt?.blockNumber),
    worstCostWei: quantity(action.cost?.worstCostWei ?? action.worstCost),
    actualCostWei: quantity(action.cost?.actualCostWei),
    includedAt: timestamp(action.timing?.includedObservedAt),
    quality: ['primary', 'recovered', 'migrated', 'drift'].includes(action.timing?.quality)
      ? action.timing.quality
      : 'unknown',
    latencyMs,
  };
}

export function confirmationSamples(state) {
  const samples = [];
  for (const action of actions(state)) {
    if (action.kind !== 'pulse' || action.status !== 'finalized') continue;
    const start = epoch(action.timing?.rpcAcceptedAt) ?? epoch(action.broadcastAt);
    const end = epoch(action.timing?.confirmedObservedAt) ?? epoch(action.finalizedAt);
    if (start === null || end === null || end - start < 0) continue;
    samples.push(end - start);
  }
  return samples.slice(-LATENCY_SAMPLE_LIMIT);
}

function nearestRank(sorted, percentile) {
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function confirmationLatency(state) {
  const samples = confirmationSamples(state);
  const sorted = [...samples].sort((a, b) => a - b);
  const enough = samples.length >= LATENCY_MIN_SAMPLES;
  return {
    measure: 'broadcast_to_finalized',
    confirmations: 2,
    samples: samples.length,
    windowLimit: LATENCY_SAMPLE_LIMIT,
    minSamples: LATENCY_MIN_SAMPLES,
    p50Ms: enough ? nearestRank(sorted, 50) : null,
    p95Ms: enough ? nearestRank(sorted, 95) : null,
    lastMs: samples.length ? samples[samples.length - 1] : null,
  };
}

function lastFinalizedPulse(state) {
  let latest = null;
  for (const action of actions(state)) {
    if (action.kind !== 'pulse' || action.status !== 'finalized') continue;
    const at = epoch(action.timing?.confirmedObservedAt) ?? epoch(action.finalizedAt);
    if (at !== null && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

function lastActivity(state) {
  let latest = null;
  for (const action of actions(state)) {
    for (const value of [
      action.timing?.preparedAt,
      action.timing?.rpcAcceptedAt,
      action.timing?.includedObservedAt,
      action.timing?.confirmedObservedAt,
      action.createdAt,
      action.broadcastAt,
      action.finalizedAt,
    ]) {
      const at = epoch(value);
      if (at !== null && (latest === null || at > latest)) latest = at;
    }
  }
  return latest;
}

const PHASE_KEYS = ['submit_to_accept', 'submit_to_inclusion', 'inclusion_to_2conf', 'end_to_end', 'chain_inclusion'];
const QUALITY_KEYS = ['primary', 'recovered', 'migrated', 'drift', 'unknown'];
function num(value, max = 1e15) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}
function summary(value) {
  return {
    count: count(value?.count) ?? 0,
    minMs: num(value?.minMs),
    maxMs: num(value?.maxMs),
    meanMs: num(value?.meanMs),
    stdevMs: num(value?.stdevMs),
    cv: num(value?.cv),
    p50Ms: num(value?.p50Ms),
    p95Ms: num(value?.p95Ms),
  };
}
function rates(value) {
  return {
    submitted: count(value?.submitted) ?? 0,
    included: count(value?.included) ?? 0,
    finalized: count(value?.finalized) ?? 0,
    reverted: count(value?.reverted) ?? 0,
    pending: count(value?.pending) ?? 0,
    reconcileRequired: count(value?.reconcileRequired) ?? 0,
    inclusionRate: num(value?.inclusionRate),
    finalizationRate: num(value?.finalizationRate),
    failureRate: num(value?.failureRate),
  };
}
function costs(value) {
  return {
    settledActions: count(value?.settledActions) ?? 0,
    actualCostWei: quantity(value?.actualCostWei),
    worstCostWei: quantity(value?.worstCostWei),
    gasUsed: quantity(value?.gasUsed),
    meanEffectiveGasPriceWei: quantity(value?.meanEffectiveGasPriceWei),
  };
}

export function benchmarkSection(state, now) {
  const aggregates = buildAggregates(state, { now });
  const phases = {};
  for (const key of PHASE_KEYS) phases[key] = summary(aggregates.phases[key]);
  return {
    confirmationLabel: '2-conf',
    primaryQuality: 'primary',
    sampleCounts: {
      actions: count(aggregates.sampleCounts.actions) ?? 0,
      batches: count(aggregates.sampleCounts.batches) ?? 0,
      primaryEndToEnd: count(aggregates.sampleCounts.primaryEndToEnd) ?? 0,
      recovered: count(aggregates.sampleCounts.recovered) ?? 0,
    },
    phases,
    histogram: {
      bucketMs: count(aggregates.histogram.bucketMs) ?? 0,
      overflowCount: count(aggregates.histogram.overflowCount) ?? 0,
      buckets: aggregates.histogram.buckets.slice(0, 40).map((bucket) => ({
        fromMs: count(bucket.fromMs) ?? 0,
        toMs: count(bucket.toMs) ?? 0,
        count: count(bucket.count) ?? 0,
      })),
    },
    rates: { allTime: rates(aggregates.rates.allTime), lastHour: rates(aggregates.rates.lastHour) },
    cost: {
      allTime: costs(aggregates.cost.allTime),
      today: costs(aggregates.cost.today),
      day: label(aggregates.cost.day, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
    },
    skips: {
      capacity: count(aggregates.skips.capacity) ?? 0,
      budget: count(aggregates.skips.budget) ?? 0,
      hold: count(aggregates.skips.hold) ?? 0,
    },
    minutes: aggregates.minutes.slice(-MINUTE_LIMIT).map((minute) => ({
      minute: label(minute.minute, SLOT_RE),
      submitted: count(minute.submitted) ?? 0,
      included: count(minute.included) ?? 0,
      finalized: count(minute.finalized) ?? 0,
      reverted: count(minute.reverted) ?? 0,
      pending: count(minute.pending) ?? 0,
      skipped: count(minute.skipped) ?? 0,
      plannedCount: count(minute.plannedCount) ?? 0,
      minLatencyMs: num(minute.minLatencyMs),
      maxLatencyMs: num(minute.maxLatencyMs),
      meanLatencyMs: num(minute.meanLatencyMs),
    })),
    series: latencySeries(
      actions(state).filter((action) => action.kind === 'pulse'),
      { limit: SERIES_LIMIT },
    ).map((point) => ({
      at: timestamp(point.at),
      status: ACTION_STATUSES.includes(point.status) ? point.status : 'unknown',
      quality: QUALITY_KEYS.includes(point.quality) ? point.quality : 'unknown',
      endToEndMs: num(point.endToEndMs),
      inclusionMs: num(point.inclusionMs),
      acceptMs: num(point.acceptMs),
    })),
  };
}

export function deriveServiceState({ state, halted, unavailable, nowMs }) {
  if (halted === true) return 'halted';
  if (unavailable !== null || !state) return 'unknown';
  const list = actions(state);
  if (recordedHold(state) || list.some((action) => action.status === 'reconcile_required')) return 'reconcile_required';
  if (list.some((action) => UNRESOLVED_STATUSES.includes(action.status))) {
    const at = lastActivity(state);
    return at !== null && nowMs - at <= STALE_AFTER_MS ? 'pending' : 'stale';
  }
  if (!address(state.deployment?.address)) return 'not_deployed';
  const last = lastFinalizedPulse(state);
  if (last === null) return 'stale';
  return nowMs - last <= STALE_AFTER_MS ? 'active' : 'stale';
}

export function buildDashboardPayload({ read, chain, now, archive = { summary: null, unavailable: 'missing' } }) {
  const state = read.unavailable === null ? read.state : null;
  const list = actions(state);
  const blocking =
    list.find((action) => action.status === 'reconcile_required') ||
    list.find((action) => UNRESOLVED_STATUSES.includes(action.status)) ||
    null;
  const serviceState = deriveServiceState({
    state,
    halted: read.halted,
    unavailable: read.unavailable,
    nowMs: now.getTime(),
  });
  const benchmarkHold = recordedHold(state);
  const finalizedPulses = list.filter((action) => action.kind === 'pulse' && action.status === 'finalized');
  const recent = list.slice(-TRANSACTION_LIMIT).reverse().map(publicTransaction);
  return {
    generatedAt: now.toISOString(),
    network: { name: 'Elysium Testnet', chainId: String(CHAIN_ID), currency: 'HYPE', environment: 'testnet' },
    service: { state: serviceState, loopLiveness: 'not_journaled', haltFile: read.halted },
    wallet: { address: address(state?.walletAddress), balanceWei: chain.balanceWei },
    contract: {
      address: address(state?.deployment?.address),
      deployTxHash: hash(state?.deployment?.txHash),
      deployBlockNumber: quantity(state?.deployment?.blockNumber),
    },
    onchain: { pulseCount: chain.pulseCount, blockNumber: chain.blockNumber },
    journal: {
      totalActions: list.length,
      finalizedPulses: finalizedPulses.length,
      unresolvedActions: list.filter((action) => UNRESOLVED_STATUSES.includes(action.status)).length,
      reconcileRequired: list.filter((action) => action.status === 'reconcile_required').length,
      lastPulseSlot: finalizedPulses.length ? label(finalizedPulses[finalizedPulses.length - 1].slot, SLOT_RE) : null,
      lastFinalizedAt: lastFinalizedPulse(state) === null ? null : new Date(lastFinalizedPulse(state)).toISOString(),
      todaySpendWei: quantity(state?.dailySpend?.[dayKey(now)]),
      spendDay: dayKey(now),
    },
    latency: confirmationLatency(state),
    benchmark: benchmarkSection(state, now),
    archive: {
      archivedActions: count(state?.archive?.archivedActions) ?? 0,
      aggregatesGeneratedAt: timestamp(archive.summary?.generatedAt),
      aggregatesActions: count(archive.summary?.actions),
    },
    transactions: recent,
    hold: {
      haltFile: read.halted,
      blockedBy:
        serviceState === 'halted'
          ? 'halt'
          : benchmarkHold
            ? 'reconcile_required'
            : blocking
              ? blocking.status === 'reconcile_required'
                ? 'reconcile_required'
                : 'pending'
              : null,
      action: blocking ? publicTransaction(blocking) : null,
      type: benchmarkHold ? benchmarkHold.type : null,
      since: benchmarkHold ? timestamp(benchmarkHold.since) : null,
      nonce: benchmarkHold ? quantity(benchmarkHold.nonce) : null,
      lastCleared: lastClearedHold(state),
    },
    unavailable: { state: read.unavailable, rpc: chain.unavailable, aggregates: archive.unavailable },
  };
}

export async function collectDashboard({ stateDir, rpc = null, now = () => new Date(), chainReader = readChain }) {
  const read = await readDashboardState(stateDir);
  const walletAddress = read.unavailable === null ? address(read.state?.walletAddress) : null;
  const contractAddress = read.unavailable === null ? address(read.state?.deployment?.address) : null;
  const chain = await chainReader({ rpc, walletAddress, contractAddress });
  const archive = await readArchiveSummary(stateDir);
  return buildDashboardPayload({ read, chain, now: now(), archive });
}
