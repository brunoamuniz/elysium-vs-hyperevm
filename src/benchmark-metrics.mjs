export const PHASES = [
  'submit_to_accept',
  'submit_to_inclusion',
  'inclusion_to_2conf',
  'end_to_end',
  'chain_inclusion',
];
export const PRIMARY_QUALITY = 'primary';
export const HISTOGRAM_BUCKETS_MS = [15_000, 30_000, 60_000];
export const DEFAULT_HISTOGRAM_BUCKET_MS = 15_000;
export const MAX_HISTOGRAM_BUCKETS = 40;
export const MAX_SAMPLES = 2000;

export function epochMs(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function bigintOrNull(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === 'string' && /^[0-9]{1,78}$/.test(value)) return BigInt(value);
  return null;
}

function blockTimestampMs(timing) {
  const seconds = bigintOrNull(timing?.blockTimestamp);
  if (seconds === null || seconds > 100_000_000_000n) return null;
  return Number(seconds) * 1000;
}

export function clockOffsetMs(timing) {
  const value = timing?.clockOffsetMs;
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 60_000 ? value : null;
}

function correctedSubmit(timing) {
  const submit = epochMs(timing.submitStartedAt);
  if (submit === null) return null;
  const offset = clockOffsetMs(timing);
  if (offset === null) return (timing.measurementVersion ?? 0) >= 4 ? null : submit;
  return submit + offset;
}

export function phaseLatency(action, phase) {
  const timing = action?.timing;
  if (!timing || typeof timing !== 'object') return null;
  const pairs = {
    submit_to_accept: [epochMs(timing.submitStartedAt), epochMs(timing.rpcAcceptedAt)],
    submit_to_inclusion: [epochMs(timing.submitStartedAt), epochMs(timing.includedObservedAt)],
    inclusion_to_2conf: [epochMs(timing.includedObservedAt), epochMs(timing.confirmedObservedAt)],
    end_to_end: [epochMs(timing.submitStartedAt), epochMs(timing.confirmedObservedAt)],
    chain_inclusion: [correctedSubmit(timing), blockTimestampMs(timing)],
  };
  const pair = pairs[phase];
  if (!pair) return null;
  const [start, end] = pair;
  if (start === null || end === null) return null;
  const delta = end - start;
  if (phase === 'chain_inclusion' && delta < 0 && delta > -1000) return 0;
  return delta >= 0 && delta <= 86_400_000 ? delta : null;
}

export function isPrimary(action) {
  return action?.timing?.quality === PRIMARY_QUALITY && action?.timing?.recovered !== true;
}

export function latencySamples(actions, phase, { primaryOnly = true, limit = MAX_SAMPLES } = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const samples = [];
  for (const action of list) {
    if (!action || typeof action !== 'object') continue;
    if (primaryOnly && !isPrimary(action)) continue;
    const value = phaseLatency(action, phase);
    if (value !== null) samples.push(value);
  }
  return samples.slice(-limit);
}

export function percentile(samples, p) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function summarize(samples) {
  const clean = (Array.isArray(samples) ? samples : []).filter((value) => Number.isFinite(value) && value >= 0);
  if (!clean.length)
    return { count: 0, minMs: null, maxMs: null, meanMs: null, stdevMs: null, cv: null, p50Ms: null, p95Ms: null };
  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  const variance = clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / clean.length;
  const stdev = Math.sqrt(variance);
  return {
    count: clean.length,
    minMs: Math.min(...clean),
    maxMs: Math.max(...clean),
    meanMs: round(mean),
    stdevMs: round(stdev),
    cv: mean === 0 ? null : round(stdev / mean, 4),
    p50Ms: percentile(clean, 50),
    p95Ms: percentile(clean, 95),
  };
}

export function histogram(samples, bucketMs = DEFAULT_HISTOGRAM_BUCKET_MS) {
  if (!HISTOGRAM_BUCKETS_MS.includes(bucketMs))
    throw new Error('histogram bucket must be 15000, 30000 or 60000 milliseconds');
  const clean = (Array.isArray(samples) ? samples : []).filter((value) => Number.isFinite(value) && value >= 0);
  if (!clean.length) return { bucketMs, overflowCount: 0, buckets: [] };
  const needed = Math.floor(Math.max(...clean) / bucketMs) + 1;
  const used = Math.min(needed, MAX_HISTOGRAM_BUCKETS);
  const buckets = Array.from({ length: used }, (_, index) => ({
    fromMs: index * bucketMs,
    toMs: (index + 1) * bucketMs,
    count: 0,
  }));
  let overflowCount = 0;
  for (const value of clean) {
    const index = Math.floor(value / bucketMs);
    if (index >= used) overflowCount += 1;
    else buckets[index].count += 1;
  }
  return { bucketMs, overflowCount, buckets };
}

export const MINUTE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$/;
export function utcMinute(value) {
  const ms = epochMs(value);
  return ms === null ? null : new Date(ms).toISOString().slice(0, 16) + 'Z';
}
export function utcDay(value) {
  const ms = epochMs(value);
  return ms === null ? null : new Date(ms).toISOString().slice(0, 10);
}

export function minuteBatches(actions, batches = [], { limit = 240 } = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const minutes = new Map();
  const touch = (minute) => {
    if (!minutes.has(minute))
      minutes.set(minute, {
        minute,
        submitted: 0,
        included: 0,
        finalized: 0,
        reverted: 0,
        pending: 0,
        skipped: 0,
        plannedCount: 0,
        latencies: [],
      });
    return minutes.get(minute);
  };
  for (const action of list) {
    if (!action || typeof action !== 'object') continue;
    const minute = utcMinute(action.timing?.rpcAcceptedAt);
    if (minute === null) continue;
    const entry = touch(minute);
    entry.submitted += 1;
    if (action.status === 'included' || action.status === 'finalized' || action.status === 'reverted')
      entry.included += 1;
    if (action.status === 'finalized') entry.finalized += 1;
    if (action.status === 'reverted') entry.reverted += 1;
    if (action.status === 'prepared' || action.status === 'submitted') entry.pending += 1;
    const latency = isPrimary(action) ? phaseLatency(action, 'end_to_end') : null;
    if (latency !== null) entry.latencies.push(latency);
  }
  for (const batch of Array.isArray(batches) ? batches : []) {
    if (!batch || typeof batch !== 'object') continue;
    const minute =
      typeof batch.slot === 'string' && MINUTE_RE.test(batch.slot) ? batch.slot : utcMinute(batch.openedAt);
    if (typeof minute !== 'string') continue;
    const entry = touch(minute);
    if (batch.outcome === 'capacity_skip' || batch.outcome === 'budget_skip' || batch.outcome === 'hold_skip')
      entry.skipped += 1;
    const planned = Number(batch.plannedCount);
    if (Number.isSafeInteger(planned) && planned >= 0 && planned <= 100)
      entry.plannedCount = Math.max(entry.plannedCount, planned);
  }
  return [...minutes.values()]
    .sort((a, b) => (a.minute < b.minute ? -1 : a.minute > b.minute ? 1 : 0))
    .slice(-limit)
    .map(({ latencies, ...entry }) => ({
      ...entry,
      minLatencyMs: latencies.length ? Math.min(...latencies) : null,
      maxLatencyMs: latencies.length ? Math.max(...latencies) : null,
      meanLatencyMs: latencies.length
        ? round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
        : null,
    }));
}

export function costTotals(actions, { day = null } = {}) {
  const list = Array.isArray(actions) ? actions : [];
  let actual = 0n;
  let worst = 0n;
  let gasUsed = 0n;
  let settled = 0;
  let priceSum = 0n;
  let priced = 0;
  for (const action of list) {
    if (!action || typeof action !== 'object') continue;
    if (day !== null && (action.cost?.reservedDay ?? utcDay(action.timing?.rpcAcceptedAt)) !== day) continue;
    const worstWei = bigintOrNull(action.cost?.worstCostWei);
    if (worstWei !== null) worst += worstWei;
    const actualWei = bigintOrNull(action.cost?.actualCostWei);
    if (actualWei !== null) {
      actual += actualWei;
      settled += 1;
    }
    const used = bigintOrNull(action.cost?.gasUsed);
    if (used !== null) gasUsed += used;
    const price = bigintOrNull(action.cost?.effectiveGasPriceWei);
    if (price !== null) {
      priceSum += price;
      priced += 1;
    }
  }
  return {
    settledActions: settled,
    actualCostWei: actual.toString(),
    worstCostWei: worst.toString(),
    gasUsed: gasUsed.toString(),
    meanEffectiveGasPriceWei: priced ? (priceSum / BigInt(priced)).toString() : null,
  };
}

export function successRates(actions, { nowMs = Date.now(), windowMs = null } = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const counts = { submitted: 0, included: 0, finalized: 0, reverted: 0, pending: 0, reconcileRequired: 0 };
  for (const action of list) {
    if (!action || typeof action !== 'object') continue;
    const at = epochMs(action.timing?.rpcAcceptedAt) ?? epochMs(action.timing?.preparedAt);
    if (windowMs !== null && (at === null || nowMs - at > windowMs)) continue;
    if (action.status === 'reconcile_required') {
      counts.reconcileRequired += 1;
      continue;
    }
    if (action.timing?.rpcAcceptedAt) counts.submitted += 1;
    if (['included', 'finalized', 'reverted'].includes(action.status)) counts.included += 1;
    if (action.status === 'finalized') counts.finalized += 1;
    if (action.status === 'reverted') counts.reverted += 1;
    if (['prepared', 'submitted'].includes(action.status)) counts.pending += 1;
  }
  const ratio = (numerator, denominator) => (denominator > 0 ? round(numerator / denominator, 4) : null);
  return {
    ...counts,
    inclusionRate: ratio(counts.included, counts.submitted),
    finalizationRate: ratio(counts.finalized, counts.submitted),
    failureRate: ratio(counts.reverted, counts.submitted),
  };
}

export const HOUR_MS = 3_600_000;
export const MAX_SERIES_POINTS = 500;
export const TIMING_QUALITY = ['primary', 'recovered', 'migrated', 'drift'];

export function latencySeries(actions, { limit = MAX_SERIES_POINTS } = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const points = [];
  for (const action of list) {
    if (!action || typeof action !== 'object') continue;
    const at = epochMs(action.timing?.rpcAcceptedAt);
    if (at === null) continue;
    const quality = TIMING_QUALITY.includes(action.timing?.quality) ? action.timing.quality : 'unknown';
    points.push({
      at: new Date(at).toISOString(),
      status: ['prepared', 'submitted', 'included', 'finalized', 'reverted', 'reconcile_required'].includes(
        action.status,
      )
        ? action.status
        : 'unknown',
      quality: action.timing?.recovered === true ? 'recovered' : quality,
      endToEndMs: phaseLatency(action, 'end_to_end'),
      inclusionMs: phaseLatency(action, 'submit_to_inclusion'),
      acceptMs: phaseLatency(action, 'submit_to_accept'),
    });
  }
  return points.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(-limit);
}

export function buildAggregates(state, { now = new Date(), bucketMs = DEFAULT_HISTOGRAM_BUCKET_MS } = {}) {
  const actions = Array.isArray(state?.actions)
    ? state.actions.filter((action) => action && typeof action === 'object' && action.kind === 'pulse')
    : [];
  const batches = Array.isArray(state?.batches) ? state.batches : [];
  const nowMs = now.getTime();
  const day = now.toISOString().slice(0, 10);
  const phases = {};
  for (const phase of PHASES) phases[phase] = summarize(latencySamples(actions, phase));
  const primaryEndToEnd = latencySamples(actions, 'end_to_end');
  const skips = { capacity: 0, budget: 0, hold: 0 };
  for (const batch of batches) {
    if (batch?.outcome === 'capacity_skip') skips.capacity += 1;
    if (batch?.outcome === 'budget_skip') skips.budget += 1;
    if (batch?.outcome === 'hold_skip') skips.hold += 1;
  }
  return {
    generatedAt: new Date(nowMs).toISOString(),
    confirmationLabel: '2-conf',
    primaryQuality: PRIMARY_QUALITY,
    sampleCounts: {
      actions: actions.length,
      batches: batches.length,
      primaryEndToEnd: primaryEndToEnd.length,
      recovered: actions.filter((action) => !isPrimary(action)).length,
    },
    phases,
    histogram: histogram(primaryEndToEnd, bucketMs),
    rates: { allTime: successRates(actions, { nowMs }), lastHour: successRates(actions, { nowMs, windowMs: HOUR_MS }) },
    cost: { allTime: costTotals(actions), today: costTotals(actions, { day }), day },
    skips,
    minutes: minuteBatches(actions, batches),
  };
}
