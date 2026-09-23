import fs from 'node:fs/promises';
import path from 'node:path';
import { CHAINS } from './config.mjs';
import { clockOffsetMs } from './benchmark-metrics.mjs';
import { LEGACY_CHAIN_ID, readArchive, validateReadableState } from './state.mjs';

export const SCHEMA_VERSION = 1;
export const MEASUREMENT_VERSION = 4;
export const MIN_COMPARISON_SAMPLES = 200;
export const MIN_ANNOUNCE_HOURS = 24;
export const BOOTSTRAP_RESAMPLES = 10_000;
export const BOOTSTRAP_SEED = 20260922;
export const BOOTSTRAP_SAMPLE_CAP = 5_000;
export const ARCHIVE_DAYS = 7;
export const STALE_AFTER_MS = 180_000;
export const RECENT_LIMIT = 20;
export const SERIES_LIMIT = 600;
export const HOURLY_LIMIT = 168;
export const HISTOGRAM_BUCKET_MS = 250;
export const HISTOGRAM_BUCKETS = 24;
export const BLOCK_TIMESTAMP_MIDPOINT_MS = 500;

export const CHAIN_FACTS = Object.freeze({
  'elysium-testnet': Object.freeze({
    layer: 'L2',
    stack: 'Arbitrum Orbit (Nitro), AnyTrust DA, Conduit sequencer',
    settlesTo: 'HyperEVM testnet',
    explorerTx: 'https://elysium.kinetiq.xyz/testnet-explorer/transaction/',
    explorerAddress: 'https://elysium.kinetiq.xyz/testnet-explorer/address/',
  }),
  'hyperevm-testnet': Object.freeze({
    layer: 'L1',
    stack: 'HyperEVM on HyperBFT',
    settlesTo: null,
    explorerTx: 'https://app.hyperliquid-testnet.xyz/explorer/tx/',
    explorerAddress: 'https://app.hyperliquid-testnet.xyz/explorer/address/',
  }),
});

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function hash(value) {
  return typeof value === 'string' && HASH_RE.test(value) ? value.toLowerCase() : null;
}
function address(value) {
  return typeof value === 'string' && ADDRESS_RE.test(value) ? value : null;
}
function epoch(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
function iso(ms) {
  return ms === null ? null : new Date(ms).toISOString();
}
function wholeNumber(value) {
  if (typeof value === 'string' && /^[0-9]{1,30}$/.test(value)) return value.replace(/^0+(?=[0-9])/, '');
  if (typeof value === 'bigint' && value >= 0n) return value.toString();
  return null;
}
function finiteMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400_000 ? value : null;
}

export function chainInclusionMs(timing) {
  const submit = epoch(timing?.submitStartedAt);
  const seconds = wholeNumber(timing?.blockTimestamp);
  if (submit === null || seconds === null || seconds.length > 12) return null;
  const offset = clockOffsetMs(timing);
  if (offset === null) return null;
  const delta = Number(seconds) * 1000 + BLOCK_TIMESTAMP_MIDPOINT_MS - (submit + offset);
  return delta > -BLOCK_TIMESTAMP_MIDPOINT_MS && delta <= 86_400_000 ? delta : null;
}

function between(timing, from, to) {
  const a = epoch(timing?.[from]);
  const b = epoch(timing?.[to]);
  return a === null || b === null || b < a || b - a > 86_400_000 ? null : b - a;
}

export function isBenchmarkSample(action) {
  return (
    action &&
    typeof action === 'object' &&
    action.kind === 'pulse' &&
    action.profile === 'benchmark-10' &&
    action.timing?.measurementVersion === MEASUREMENT_VERSION &&
    epoch(action.timing?.submitStartedAt) !== null
  );
}

function isPrimary(action) {
  return action.timing?.quality === 'primary' && action.timing?.recovered !== true;
}

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summary(values) {
  const clean = values.filter((value) => value !== null).sort((a, b) => a - b);
  if (!clean.length) return { count: 0, p50Ms: null, p95Ms: null, minMs: null, maxMs: null, meanMs: null };
  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  return {
    count: clean.length,
    p50Ms: percentile(clean, 50),
    p95Ms: percentile(clean, 95),
    minMs: clean[0],
    maxMs: clean[clean.length - 1],
    meanMs: Math.round(mean),
  };
}

export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function resampledMedian(sorted, random, counts) {
  const n = sorted.length;
  counts.fill(0);
  for (let draw = 0; draw < n; draw += 1) counts[Math.floor(random() * n)] += 1;
  const target = Math.ceil(0.5 * n);
  let seen = 0;
  for (let index = 0; index < n; index += 1) {
    seen += counts[index];
    if (seen >= target) return sorted[index];
  }
  return sorted[n - 1];
}

const DEFERRED = Symbol('deferred bootstrap samples');
export const BOOTSTRAP_CHUNK = 250;

function* bootstrapSteps(a, b, resamples, seed) {
  const left = a.slice(-BOOTSTRAP_SAMPLE_CAP).sort((x, y) => x - y);
  const right = b.slice(-BOOTSTRAP_SAMPLE_CAP).sort((x, y) => x - y);
  if (!left.length || !right.length) return null;
  const random = seededRandom(seed);
  const leftCounts = new Uint32Array(left.length);
  const rightCounts = new Uint32Array(right.length);
  const diffs = new Float64Array(resamples);
  for (let index = 0; index < resamples; index += 1) {
    diffs[index] = resampledMedian(left, random, leftCounts) - resampledMedian(right, random, rightCounts);
    if ((index + 1) % BOOTSTRAP_CHUNK === 0) yield;
  }
  diffs.sort();
  return {
    diffP50Ms: percentile(left, 50) - percentile(right, 50),
    ci95Ms: [percentile(diffs, 2.5), percentile(diffs, 97.5)],
    resamples,
    seed,
    samplesUsed: [left.length, right.length],
  };
}

export function bootstrapMedianDifference(a, b, { resamples = BOOTSTRAP_RESAMPLES, seed = BOOTSTRAP_SEED } = {}) {
  const steps = bootstrapSteps(a, b, resamples, seed);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

export async function bootstrapMedianDifferenceAsync(
  a,
  b,
  { resamples = BOOTSTRAP_RESAMPLES, seed = BOOTSTRAP_SEED } = {},
) {
  const steps = bootstrapSteps(a, b, resamples, seed);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function histogram(values) {
  const buckets = Array.from({ length: HISTOGRAM_BUCKETS }, (_, index) => ({
    fromMs: index * HISTOGRAM_BUCKET_MS,
    toMs: (index + 1) * HISTOGRAM_BUCKET_MS,
    count: 0,
  }));
  let overflow = 0;
  for (const value of values) {
    if (value === null) continue;
    const index = Math.max(0, Math.floor(value / HISTOGRAM_BUCKET_MS));
    if (index >= HISTOGRAM_BUCKETS) overflow += 1;
    else buckets[index].count += 1;
  }
  return { bucketMs: HISTOGRAM_BUCKET_MS, buckets, overflowCount: overflow };
}

function hourly(samples) {
  const hours = new Map();
  for (const action of samples) {
    const hour = new Date(epoch(action.timing.submitStartedAt)).toISOString().slice(0, 13) + ':00Z';
    if (!hours.has(hour)) hours.set(hour, { chain: [], accept: [], observed: [] });
    const bucket = hours.get(hour);
    bucket.chain.push(chainInclusionMs(action.timing));
    bucket.accept.push(between(action.timing, 'submitStartedAt', 'rpcAcceptedAt'));
    bucket.observed.push(between(action.timing, 'submitStartedAt', 'includedObservedAt'));
  }
  return [...hours.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(-HOURLY_LIMIT)
    .map(([hour, bucket]) => {
      const chain = summary(bucket.chain);
      const accept = summary(bucket.accept);
      const observed = summary(bucket.observed);
      return {
        hour,
        count: chain.count,
        chainInclusionP50Ms: chain.p50Ms,
        rpcAcceptP50Ms: accept.p50Ms,
        observedInclusionP50Ms: observed.p50Ms,
      };
    });
}

function bigStats(values) {
  const clean = values.filter((value) => value !== null).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!clean.length) return null;
  const total = clean.reduce((sum, value) => sum + value, 0n);
  return {
    p50: percentile(clean, 50).toString(),
    p95: percentile(clean, 95).toString(),
    min: clean[0].toString(),
    max: clean[clean.length - 1].toString(),
    mean: (total / BigInt(clean.length)).toString(),
    total: total.toString(),
    count: clean.length,
  };
}

function quantityOf(action, key) {
  const value = wholeNumber(action.cost?.[key]);
  return value === null ? null : BigInt(value);
}

function gasSection(samples) {
  const settled = samples.filter(
    (action) => quantityOf(action, 'actualCostWei') !== null && quantityOf(action, 'gasUsed') !== null,
  );
  const fee = bigStats(settled.map((action) => quantityOf(action, 'actualCostWei')));
  const gasUsed = bigStats(settled.map((action) => quantityOf(action, 'gasUsed')));
  const withSplit = settled.filter(
    (action) => ['nitro', 'none'].includes(action.cost?.breakdown) && quantityOf(action, 'executionGas') !== null,
  );
  const execution = bigStats(withSplit.map((action) => quantityOf(action, 'executionGas')));
  const nitro = withSplit.filter((action) => action.cost.breakdown === 'nitro');
  const posting = bigStats(nitro.map((action) => quantityOf(action, 'gasUsedForL1')));
  const shares = nitro
    .map((action) => Number(quantityOf(action, 'gasUsedForL1')) / Number(quantityOf(action, 'gasUsed')))
    .filter((value) => Number.isFinite(value));
  const price = bigStats(settled.map((action) => quantityOf(action, 'effectiveGasPriceWei')));
  const hours = new Map();
  for (const action of settled) {
    const hour = new Date(epoch(action.timing.submitStartedAt)).toISOString().slice(0, 13) + ':00Z';
    if (!hours.has(hour)) hours.set(hour, []);
    hours.get(hour).push(action);
  }
  const pick = (stats, keys) => (stats ? Object.fromEntries(keys.map((key) => [key, stats[key]])) : null);
  return {
    settled: settled.length,
    breakdownCoverage: settled.length ? Math.round((withSplit.length / settled.length) * 10_000) / 10_000 : null,
    feeWei: pick(fee, ['p50', 'p95', 'mean', 'total']),
    feePer1000TxWei: fee ? (BigInt(fee.mean) * 1000n).toString() : null,
    gasUsed: pick(gasUsed, ['p50', 'mean']),
    executionGas: pick(execution, ['p50', 'mean']),
    postingGas: pick(posting, ['p50', 'mean']),
    postingShare: shares.length
      ? Math.round((shares.reduce((sum, value) => sum + value, 0) / shares.length) * 10_000) / 10_000
      : null,
    gasPriceWei: pick(price, ['p50', 'min', 'max']),
    hourly: [...hours.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(-HOURLY_LIMIT)
      .map(([hour, list]) => ({
        hour,
        count: list.length,
        feeP50Wei: bigStats(list.map((action) => quantityOf(action, 'actualCostWei'))).p50,
        gasPriceP50Wei: bigStats(list.map((action) => quantityOf(action, 'effectiveGasPriceWei'))).p50,
      })),
    series: settled.slice(-SERIES_LIMIT).map((action) => ({
      at: iso(epoch(action.timing.submitStartedAt)),
      feeWei: quantityOf(action, 'actualCostWei').toString(),
    })),
  };
}

function lastActivity(actions) {
  let latest = null;
  for (const action of actions)
    for (const key of ['preparedAt', 'rpcAcceptedAt', 'includedObservedAt', 'confirmedObservedAt']) {
      const at = epoch(action.timing?.[key]);
      if (at !== null && (latest === null || at > latest)) latest = at;
    }
  return latest;
}

function status({ state, halted, activeActions, nowMs }) {
  if (!state) return 'unknown';
  if (halted === true || (state.hold && typeof state.hold === 'object')) return 'paused';
  const last = lastActivity(activeActions);
  return last !== null && nowMs - last <= STALE_AFTER_MS ? 'running' : 'stale';
}

function publicSample(action, facts) {
  const txHash = hash(action.hash);
  return {
    hash: txHash,
    explorerUrl: txHash ? `${facts.explorerTx}${txHash}` : null,
    status: ['prepared', 'submitted', 'included', 'finalized', 'reverted'].includes(action.status)
      ? action.status
      : 'unknown',
    blockNumber: wholeNumber(action.receipt?.blockNumber),
    submittedAt: iso(epoch(action.timing?.submitStartedAt)),
    chainInclusionMs: chainInclusionMs(action.timing),
    rpcAcceptMs: between(action.timing, 'submitStartedAt', 'rpcAcceptedAt'),
    observedInclusionMs: between(action.timing, 'submitStartedAt', 'includedObservedAt'),
  };
}

function chainSection({ chain, state, halted, archived, nowMs, windowStartMs }) {
  const facts = CHAIN_FACTS[chain.id];
  const active = Array.isArray(state?.actions) ? state.actions : [];
  const seen = new Set();
  const all = [];
  for (const action of [...archived, ...active]) {
    if (!isBenchmarkSample(action)) continue;
    const key = typeof action.id === 'string' ? action.id : null;
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    all.push(action);
  }
  all.sort((a, b) => epoch(a.timing.submitStartedAt) - epoch(b.timing.submitStartedAt));
  const inWindow =
    windowStartMs === null ? [] : all.filter((action) => epoch(action.timing.submitStartedAt) >= windowStartMs);
  const primary = inWindow.filter(isPrimary);
  const sent = inWindow.filter((action) => epoch(action.timing?.rpcAcceptedAt) !== null);
  const included = inWindow.filter((action) => ['included', 'finalized', 'reverted'].includes(action.status));
  const reverted = inWindow.filter((action) => action.status === 'reverted');
  const resolvedCount = sent.filter((action) => !['prepared', 'submitted'].includes(action.status)).length;
  const chainValues = primary.map((action) => chainInclusionMs(action.timing));
  const gas = gasSection(primary);
  const contractAddress = address(state?.deployment?.address);
  const deployTx = hash(state?.deployment?.txHash);
  return {
    section: {
      id: chain.id,
      name: chain.name,
      chainId: chain.chainId,
      layer: facts.layer,
      stack: facts.stack,
      settlesTo: facts.settlesTo,
      status: status({ state, halted, activeActions: active, nowMs }),
      firstSampleAt: all.length ? iso(epoch(all[0].timing.submitStartedAt)) : null,
      contract: {
        address: contractAddress,
        explorerUrl: contractAddress ? `${facts.explorerAddress}${contractAddress}` : null,
        deployTxHash: deployTx,
        deployTxUrl: deployTx ? `${facts.explorerTx}${deployTx}` : null,
      },
      counts: {
        sent: sent.length,
        included: included.length,
        reverted: reverted.length,
        pending: inWindow.filter((action) => ['prepared', 'submitted'].includes(action.status)).length,
        primary: primary.length,
        excluded: inWindow.length - primary.length,
      },
      successRate: resolvedCount
        ? Math.round(((included.length - reverted.length) / resolvedCount) * 10_000) / 10_000
        : null,
      metrics: {
        chainInclusion: summary(chainValues),
        rpcAccept: summary(primary.map((action) => between(action.timing, 'submitStartedAt', 'rpcAcceptedAt'))),
        observedInclusion: summary(
          primary.map((action) => between(action.timing, 'submitStartedAt', 'includedObservedAt')),
        ),
        watchRtt: summary(primary.map((action) => finiteMs(action.timing?.includedObservedRttMs))),
        inclusionToTwoConf: summary(
          primary.map((action) => between(action.timing, 'includedObservedAt', 'confirmedObservedAt')),
        ),
        clockCorrection: summary(
          primary.map((action) => {
            const offset = clockOffsetMs(action.timing);
            return offset === null ? null : Math.abs(offset);
          }),
        ),
      },
      watchedShare: primary.length
        ? Math.round(
            (primary.filter((action) => action.timing?.includedObservedBy === 'block_watch').length / primary.length) *
              10_000,
          ) / 10_000
        : null,
      gas,
      histogram: histogram(chainValues),
      hourly: hourly(primary),
      series: primary.slice(-SERIES_LIMIT).map((action) => ({
        at: iso(epoch(action.timing.submitStartedAt)),
        chainInclusionMs: chainInclusionMs(action.timing),
        observedInclusionMs: between(action.timing, 'submitStartedAt', 'includedObservedAt'),
      })),
      recent: inWindow
        .slice(-RECENT_LIMIT)
        .reverse()
        .map((action) => publicSample(action, facts)),
    },
    chainValues: chainValues.filter((value) => value !== null),
    gas,
    firstMs: all.length ? epoch(all[0].timing.submitStartedAt) : null,
  };
}

function feeRatio(a, b) {
  if (!a?.feeWei || !b?.feeWei) return null;
  const left = BigInt(a.feeWei.mean);
  const right = BigInt(b.feeWei.mean);
  if (left === 0n) return null;
  return Math.round(Number((right * 1_000_000n) / left) / 100) / 10_000;
}

export function buildCompareSnapshot({ sources, now = new Date(), deferBootstrap = false }) {
  const nowMs = now.getTime();
  const firsts = sources.map((source) => {
    const list = [...source.archived, ...(source.state?.actions ?? [])].filter(isBenchmarkSample);
    return list.reduce((min, action) => {
      const at = epoch(action.timing.submitStartedAt);
      return min === null || at < min ? at : min;
    }, null);
  });
  const windowStartMs = firsts.every((value) => value !== null) ? Math.max(...firsts) : null;
  const built = sources.map((source) => chainSection({ ...source, nowMs, windowStartMs }));
  const [left, right] = built;
  const hours = windowStartMs === null ? 0 : Math.round((nowMs - windowStartMs) / 36_000) / 100;
  const ready = Boolean(
    left &&
    right &&
    left.chainValues.length >= MIN_COMPARISON_SAMPLES &&
    right.chainValues.length >= MIN_COMPARISON_SAMPLES,
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: iso(nowMs),
    measurementVersion: MEASUREMENT_VERSION,
    load: {
      profile: 'benchmark-10',
      txPerMinutePerChain: 10,
      contract: 'MinutePulse',
      watchIntervalMs: 500,
      pollIntervalMs: 2000,
    },
    window: {
      start: iso(windowStartMs),
      end: iso(nowMs),
      hours,
      announceAfterHours: MIN_ANNOUNCE_HOURS,
      minSamplesPerChain: MIN_COMPARISON_SAMPLES,
    },
    chains: built.map((entry) => entry.section),
    comparison: {
      metric: 'chainInclusion',
      ready,
      announceable: ready && hours >= MIN_ANNOUNCE_HOURS,
      pair: built.length === 2 ? [built[0].section.id, built[1].section.id] : null,
      feeRatio: feeRatio(left?.gas, right?.gas),
      executionGasDelta:
        left?.gas?.executionGas && right?.gas?.executionGas
          ? Number(BigInt(left.gas.executionGas.p50) - BigInt(right.gas.executionGas.p50))
          : null,
      ...(ready && !deferBootstrap
        ? bootstrapMedianDifference(left.chainValues, right.chainValues)
        : { diffP50Ms: null, ci95Ms: null, resamples: BOOTSTRAP_RESAMPLES, seed: BOOTSTRAP_SEED, samplesUsed: null }),
    },
    ...(deferBootstrap && ready ? { [DEFERRED]: [left.chainValues, right.chainValues] } : {}),
  };
}

function archiveDays(nowMs) {
  return Array.from({ length: ARCHIVE_DAYS }, (_, index) =>
    new Date(nowMs - index * 86_400_000).toISOString().slice(0, 10),
  ).reverse();
}

export async function readCompareSource(chainId, stateDir, now = new Date()) {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error('unknown chain');
  let halted;
  try {
    await fs.access(path.join(stateDir, 'HALT'));
    halted = true;
  } catch (error) {
    halted = error.code === 'ENOENT' ? false : null;
  }
  let state = null;
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(stateDir, 'state.json'), 'utf8'));
    validateReadableState(parsed);
    if (
      parsed.chainId === chain.chainId ||
      ((parsed.chainId === undefined || parsed.chainId === null) && chain.chainId === LEGACY_CHAIN_ID)
    )
      state = parsed;
  } catch {
    state = null;
  }
  const archived = [];
  for (const day of archiveDays(now.getTime())) {
    try {
      archived.push(...(await readArchive(stateDir, day)));
    } catch {
      /* an unreadable day is skipped */
    }
  }
  return { chain, state, halted, archived };
}

export async function collectCompare({ sources, now = () => new Date() }) {
  const at = now();
  const read = await Promise.all(sources.map((source) => readCompareSource(source.chain, source.stateDir, at)));
  const snapshot = buildCompareSnapshot({ sources: read, now: at, deferBootstrap: true });
  const deferred = snapshot[DEFERRED];
  delete snapshot[DEFERRED];
  if (deferred)
    snapshot.comparison = { ...snapshot.comparison, ...(await bootstrapMedianDifferenceAsync(...deferred)) };
  return snapshot;
}
