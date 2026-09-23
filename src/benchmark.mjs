import crypto from 'node:crypto';
import { decodeEventLog, encodeFunctionData, keccak256 } from 'viem';
import { CHAINS, redact } from './config.mjs';
import { assertHalted } from './elysium.mjs';
import { acquireLock } from './lock.mjs';
import {
  appendAction,
  appendBatch,
  compactState,
  emptyCost,
  emptyTiming,
  HOLD_HISTORY_LIMIT,
  inFlightCount,
  loadState,
  nextJournalNonce,
  saveState,
  unresolvedActions,
} from './state.mjs';

export const RPC_ERROR_KINDS = ['rate_limit', 'timeout', 'already_known', 'nonce_too_low', 'transient', 'unknown'];
export const RETRYABLE_KINDS = ['rate_limit', 'timeout', 'transient'];
export const MISSING_RECEIPT_POLLS_BEFORE_RECONCILE = 2;
export const MEASUREMENT_VERSION = 4;
export const REBROADCAST_AFTER_MS = 30_000;
export const WATCH_BACKFILL_BLOCKS = 3;
export const WATCH_MAX_GAP_BLOCKS = 20;
export const WATCH_OBSERVATION_LIMIT = 500;
const RECEIPT_UNAVAILABLE = Symbol('receipt unavailable');

export function typedError(code, reason) {
  const error = new Error(reason);
  error.code = code;
  return error;
}
export function hold(reason) {
  return typedError('HOLD', reason);
}
export function halt(reason) {
  return typedError('HALT', reason);
}

export function classifyRpcError(error) {
  if (error?.code === 'RPC' && RPC_ERROR_KINDS.includes(error.kind)) return error.kind;
  const parts = [];
  for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth += 1)
    parts.push(cause.name, cause.shortMessage, cause.details, cause.message);
  const text = parts
    .filter((part) => typeof part === 'string')
    .join(' ')
    .toLowerCase();
  if (/already known|known transaction|already exists/.test(text)) return 'already_known';
  if (
    /nonce too low|nonce is too low|noncetoolow|lower than the current nonce|replacement transaction underpriced/.test(
      text,
    )
  )
    return 'nonce_too_low';
  if (/rate.?limit|too many requests|429/.test(text)) return 'rate_limit';
  if (/timeout|timed out|etimedout|esockettimedout/.test(text)) return 'timeout';
  if (/socket|econnreset|econnrefused|enotfound|network|fetch failed|502|503|504/.test(text)) return 'transient';
  return 'unknown';
}

export function isReceiptNotFound(error) {
  for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth += 1) {
    if (cause.name === 'TransactionReceiptNotFoundError') return true;
    const text = [cause.shortMessage, cause.details, cause.message]
      .filter((part) => typeof part === 'string')
      .join(' ')
      .toLowerCase();
    if (/receipt.*(not found|could not be found)/.test(text)) return true;
  }
  return false;
}

export function utcMinute(date) {
  return date.toISOString().slice(0, 16) + 'Z';
}
export function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

export function systemClock() {
  return {
    now: () => new Date(),
    monotonic: () => Number(process.hrtime.bigint() / 1_000_000n),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
function byNonce(a, b) {
  const x = BigInt(a.nonce);
  const y = BigInt(b.nonce);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function submissionsInMinute(state, minute) {
  let count = 0;
  for (const action of state.actions) {
    const stamp = action.timing?.rpcAcceptedAt;
    if (typeof stamp === 'string' && stamp.slice(0, 16) + 'Z' === minute) count += 1;
  }
  return count;
}

export function reservedForDay(state, day) {
  return BigInt(state.dailyReserved?.[day] ?? '0');
}
export function spentForDay(state, day) {
  return BigInt(state.dailySpend?.[day] ?? '0');
}

export function outstandingReservations(state) {
  let total = 0n;
  for (const value of Object.values(state.dailyReserved ?? {})) total += BigInt(value);
  return total;
}

export function pulseEventMatches(artifact, walletAddress, action, receipt) {
  const contract = action.expected?.contractAddress?.toLowerCase();
  const events = receipt.logs
    .filter((entry) => entry.address?.toLowerCase() === contract)
    .map((entry) => {
      try {
        return decodeEventLog({ abi: artifact.abi, data: entry.data, topics: entry.topics });
      } catch {
        return null;
      }
    })
    .filter((entry) => entry?.eventName === 'Pulsed');
  return events.some(
    (event) =>
      event.args.caller?.toLowerCase() === walletAddress.toLowerCase() &&
      event.args.count === BigInt(action.expected.countAfter) &&
      event.args.entropy?.toLowerCase() === action.expected.entropy.toLowerCase(),
  );
}

function optionalQuantity(value) {
  if (value === undefined || value === null) return null;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

export function gasBreakdown(receipt, gasUsed, block) {
  const baseFee = optionalQuantity(block?.baseFeePerGas);
  const l1BlockNumber = optionalQuantity(receipt?.l1BlockNumber);
  const common = {
    blockBaseFeeWei: baseFee === null ? null : baseFee.toString(),
    l1BlockNumber: l1BlockNumber === null ? null : l1BlockNumber.toString(),
  };
  if (receipt?.gasUsedForL1 === undefined)
    return { ...common, gasUsedForL1: null, executionGas: gasUsed.toString(), breakdown: 'none' };
  const posting = optionalQuantity(receipt.gasUsedForL1);
  if (posting === null || posting > gasUsed)
    return { ...common, gasUsedForL1: null, executionGas: null, breakdown: 'rejected' };
  return {
    ...common,
    gasUsedForL1: posting.toString(),
    executionGas: (gasUsed - posting).toString(),
    breakdown: 'nitro',
  };
}

export function highestExpectedCount(state) {
  let max = null;
  for (const action of state.actions) {
    if (action.kind !== 'pulse' || action.status === 'reverted') continue;
    const value = action.expected?.countAfter;
    if (value === undefined || value === null || !/^[0-9]+$/.test(String(value))) continue;
    const parsed = BigInt(value);
    if (max === null || parsed > max) max = parsed;
  }
  return max;
}

export async function openBenchmarkOwner({
  config,
  benchmark,
  account,
  artifact,
  chain,
  clock = systemClock(),
  clockOffset = null,
  log = (entry) => console.log(JSON.stringify(entry)),
}) {
  const pinned = CHAINS[config.chain];
  if (!pinned) throw new Error('benchmark requires a pinned chain');
  const release = await acquireLock(config.stateDir);
  const processId = crypto.randomUUID();
  let state;
  try {
    state = await loadState(config.stateDir, account.address, config.chainId);
    state.walletAddress ||= account.address;
  } catch (error) {
    await release();
    throw error;
  }

  let saving = Promise.resolve();
  const persist = () => {
    saving = saving.catch(() => {}).then(() => saveState(config.stateDir, state));
    return saving;
  };
  const emit = (type, fields = {}) => log(benchmarkLogRedactor({ type, profile: benchmark.profile, ...fields }));

  const spacingMs = 1000 / pinned.rpcRequestsPerSecond;
  let nextRpcAt = 0;
  async function throttle() {
    const now = clock.monotonic();
    const wait = Math.max(0, nextRpcAt - now);
    nextRpcAt = Math.max(now, nextRpcAt) + spacingMs;
    if (wait > 0) await clock.sleep(wait);
  }

  async function rpc(kindLabel, fn, { throttled = false } = {}) {
    let attempt = 0;
    for (;;) {
      if (!throttled || attempt > 0) await throttle();
      try {
        return await fn();
      } catch (error) {
        const kind = classifyRpcError(error);
        attempt += 1;
        if (!RETRYABLE_KINDS.includes(kind) || attempt >= benchmark.rpcRetryAttempts) {
          emit('rpc_error', { call: kindLabel, kind, attempts: attempt });
          const wrapped = typedError('RPC', `rpc call ${kindLabel} failed with ${kind}`);
          wrapped.kind = kind;
          throw wrapped;
        }
        emit('rpc_retry', { call: kindLabel, kind, attempt });
        await clock.sleep(benchmark.rpcBackoffMs * attempt);
      }
    }
  }

  function stampNow() {
    const now = clock.now();
    return { iso: now.toISOString(), wallMs: now.getTime(), monoMs: clock.monotonic() };
  }

  function markQuality(action) {
    const timing = action.timing;
    if (timing.recovered || timing.processId !== processId) {
      timing.recovered = true;
      timing.quality = 'recovered';
      return;
    }
    const wallDelta = timing.confirmedObservedWallMs - timing.submitStartedWallMs;
    const monoDelta = timing.confirmedObservedMonoMs - timing.submitStartedMonoMs;
    if (!Number.isFinite(wallDelta) || !Number.isFinite(monoDelta)) {
      timing.quality = 'recovered';
      timing.recovered = true;
      return;
    }
    if (Math.abs(wallDelta - monoDelta) > benchmark.clockDriftToleranceMs) {
      timing.quality = 'drift';
      return;
    }
    timing.quality = 'primary';
  }

  function releaseReservation(action) {
    const day = action.cost?.reservedDay;
    if (!day || action.cost.reservationReleased) return;
    const remaining = reservedForDay(state, day) - BigInt(action.cost.worstCostWei ?? '0');
    state.dailyReserved[day] = (remaining > 0n ? remaining : 0n).toString();
    action.cost.reservationReleased = true;
  }

  function enterHold(type, fields) {
    state.hold = { type, status: 'reconcile_required', since: clock.now().toISOString(), ...fields };
    emit('benchmark_hold', { hold: type, ...fields });
  }

  const observations = new Map();
  let watchedBlock = null;
  let lastLatest = null;
  let windowBlocked = false;

  async function watch() {
    const wanted = new Set();
    for (const action of state.actions) {
      const sent =
        action.status === 'submitted' || (action.status === 'prepared' && action.timing?.firstBroadcastAttemptAt);
      if (sent && action.hash && !observations.has(action.hash.toLowerCase())) wanted.add(action.hash.toLowerCase());
    }
    if (!wanted.size) {
      watchedBlock = null;
      return { scanned: 0, observed: 0 };
    }
    const record = (block, stamp, rttMs) => {
      let observed = 0;
      for (const entry of block.transactions ?? []) {
        const hash = (typeof entry === 'string' ? entry : entry?.hash)?.toLowerCase();
        if (!hash || !wanted.has(hash) || observations.has(hash)) continue;
        if (observations.size >= WATCH_OBSERVATION_LIMIT) observations.delete(observations.keys().next().value);
        observations.set(hash, {
          ...stamp,
          rttMs,
          blockNumber: BigInt(block.number),
          blockHash: block.hash,
          blockTimestamp: BigInt(block.timestamp),
          baseFeePerGas: block.baseFeePerGas ?? null,
        });
        observed += 1;
      }
      return observed;
    };
    const fetchBlock = async (label, args) => {
      let started;
      const block = await rpc(label, () => {
        started = clock.monotonic();
        return chain.getBlock(args);
      });
      return { block, stamp: stampNow(), rttMs: clock.monotonic() - started };
    };
    const head = await fetchBlock('getBlock:latest', { blockTag: 'latest' });
    const headNumber = BigInt(head.block.number);
    let observed = record(head.block, head.stamp, head.rttMs);
    let from = watchedBlock === null ? headNumber - BigInt(WATCH_BACKFILL_BLOCKS) : watchedBlock + 1n;
    if (headNumber - from > BigInt(WATCH_MAX_GAP_BLOCKS)) from = headNumber - BigInt(WATCH_MAX_GAP_BLOCKS);
    const missed = [];
    for (let number = from < 0n ? 0n : from; number < headNumber; number += 1n) missed.push(number);
    const fetched = await Promise.all(missed.map((number) => fetchBlock('getBlock', { blockNumber: number })));
    for (const entry of fetched) observed += record(entry.block, entry.stamp, entry.rttMs);
    const scanned = 1 + fetched.length;
    watchedBlock = headNumber;
    return { scanned, observed };
  }

  async function settleInclusion(action, receipt) {
    const key = action.hash?.toLowerCase();
    const seen = observations.get(key);
    const observation = seen && seen.blockHash?.toLowerCase() === receipt.blockHash?.toLowerCase() ? seen : null;
    observations.delete(key);
    const stamp = observation ?? stampNow();
    if (action.status === 'prepared') action.timing = { ...action.timing, recovered: true, quality: 'recovered' };
    const block = observation
      ? { timestamp: observation.blockTimestamp, baseFeePerGas: observation.baseFeePerGas }
      : await rpc('getBlock', () => chain.getBlock({ blockNumber: receipt.blockNumber }));
    const gasUsed = BigInt(receipt.gasUsed);
    const effectiveGasPrice = BigInt(receipt.effectiveGasPrice ?? 0n);
    const actualCost = gasUsed * effectiveGasPrice;
    releaseReservation(action);
    const day = action.cost?.reservedDay ?? utcDay(clock.now());
    state.dailySpend[day] = (spentForDay(state, day) + actualCost).toString();
    action.cost = {
      ...action.cost,
      actualCostWei: actualCost.toString(),
      gasUsed: gasUsed.toString(),
      effectiveGasPriceWei: effectiveGasPrice.toString(),
      ...gasBreakdown(receipt, gasUsed, block),
    };
    action.timing = {
      ...action.timing,
      includedObservedAt: stamp.iso,
      includedObservedWallMs: stamp.wallMs,
      includedObservedMonoMs: stamp.monoMs,
      includedObservedBy: observation ? 'block_watch' : 'receipt_poll',
      includedObservedRttMs: observation ? observation.rttMs : null,
      blockTimestamp: block.timestamp.toString(),
      pollIntervalMs: benchmark.pollIntervalMs,
      watchIntervalMs: observation ? benchmark.watchIntervalMs : null,
    };
    action.receipt = { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash };
    action.missingReceiptPolls = 0;
    if (receipt.status !== 'success') {
      action.status = 'reverted';
      await persist();
      emit('action_reverted', { id: action.id, nonce: action.nonce });
      return action;
    }
    if (!pulseEventMatches(artifact, account.address, action, receipt)) {
      action.status = 'reconcile_required';
      enterHold('intent_mismatch', { nonce: action.nonce });
      await persist();
      throw halt('included transaction did not emit the exact expected Pulsed event');
    }
    action.status = 'included';
    await persist();
    emit('action_included', { id: action.id, nonce: action.nonce, blockNumber: action.receipt.blockNumber });
    return action;
  }

  async function confirmIncluded(action, latestBlock) {
    const included = BigInt(action.receipt.blockNumber);
    if (latestBlock < included + BigInt(config.confirmations)) return action;
    const canonical = await rpc('getBlock', () => chain.getBlock({ blockNumber: included }));
    if (canonical.hash?.toLowerCase() !== action.receipt.blockHash?.toLowerCase()) {
      action.status = 'reconcile_required';
      enterHold('reorg', { nonce: action.nonce });
      await persist();
      throw halt('inclusion block is no longer canonical');
    }
    const stamp = stampNow();
    action.timing = {
      ...action.timing,
      confirmedObservedAt: stamp.iso,
      confirmedObservedWallMs: stamp.wallMs,
      confirmedObservedMonoMs: stamp.monoMs,
      confirmationLabel: '2-conf',
    };
    markQuality(action);
    action.status = 'finalized';
    action.finalizedAt = stamp.iso;
    await persist();
    emit('action_finalized', { id: action.id, nonce: action.nonce, quality: action.timing.quality });
    return action;
  }

  async function receiptOrNull(hash) {
    await throttle();
    try {
      return await chain.getTransactionReceipt({ hash });
    } catch (error) {
      if (isReceiptNotFound(error)) return null;
      emit('rpc_error', { call: 'getTransactionReceipt', kind: classifyRpcError(error), attempts: 1 });
      return RECEIPT_UNAVAILABLE;
    }
  }

  async function rebroadcast(action) {
    try {
      const hash = await rpc('sendRawTransaction', () =>
        chain.sendRawTransaction({ serializedTransaction: action.raw }),
      );
      if (hash.toLowerCase() !== action.hash.toLowerCase()) {
        action.status = 'reconcile_required';
        enterHold('hash_mismatch', { nonce: action.nonce });
        await persist();
        throw halt('rebroadcast returned a different transaction hash');
      }
      return true;
    } catch (error) {
      if (error.code === 'HALT') throw error;
      const kind = classifyRpcError(error);
      if (kind === 'already_known') return true;
      if (kind === 'nonce_too_low') {
        emit('rebroadcast_nonce_consumed', { nonce: action.nonce });
        return false;
      }
      emit('rebroadcast_failed', { nonce: action.nonce });
      return false;
    }
  }

  async function reconcile() {
    const [latestNonce, pendingNonce, blockNumber] = await Promise.all([
      rpc('getTransactionCount:latest', () =>
        chain.getTransactionCount({ address: account.address, blockTag: 'latest' }),
      ),
      rpc('getTransactionCount:pending', () =>
        chain.getTransactionCount({ address: account.address, blockTag: 'pending' }),
      ),
      rpc('getBlockNumber', () => chain.getBlockNumber()),
    ]);
    const latest = BigInt(latestNonce);
    const pending = BigInt(pendingNonce);
    const block = BigInt(blockNumber);
    lastLatest = latest;

    if (latest > nextJournalNonce(state)) {
      enterHold('foreign_nonce', { latest: latest.toString() });
      await persist();
      throw halt('chain nonce exceeds the journal nonce authority');
    }

    const unresolved = unresolvedActions(state);
    for (const action of unresolved) {
      if (action.status === 'reconcile_required') {
        if (!state.hold) {
          enterHold('reconcile_required', { nonce: action.nonce });
          await persist();
        }
        throw halt('an action requires operator reconciliation');
      }
      const nonce = BigInt(action.nonce);
      if (action.status === 'included') {
        await confirmIncluded(action, block);
        continue;
      }
      const receipt = action.hash && latest > nonce ? await receiptOrNull(action.hash) : null;
      if (receipt === RECEIPT_UNAVAILABLE) continue;
      if (receipt) {
        await settleInclusion(action, receipt);
        const refreshed = state.actions.find((entry) => entry.id === action.id);
        if (refreshed.status === 'included') await confirmIncluded(refreshed, block);
        continue;
      }
      if (action.status === 'prepared') {
        if (latest > nonce) {
          action.missingReceiptPolls = (action.missingReceiptPolls ?? 0) + 1;
          if (action.missingReceiptPolls >= MISSING_RECEIPT_POLLS_BEFORE_RECONCILE) {
            action.status = 'reconcile_required';
            enterHold('foreign_nonce', { nonce: action.nonce });
            await persist();
            throw halt('a prepared nonce was consumed by an unknown transaction');
          }
          await persist();
          continue;
        }
      } else if (
        pending <= nonce &&
        (!pinned.pendingNonceIsLatest ||
          clock.now().getTime() - Date.parse(action.timing?.lastRebroadcastAt ?? action.timing?.rpcAcceptedAt ?? '') >
            REBROADCAST_AFTER_MS)
      ) {
        action.timing = {
          ...action.timing,
          recovered: true,
          quality: 'recovered',
          lastRebroadcastAt: clock.now().toISOString(),
        };
        await persist();
        if (await rebroadcast(action)) emit('action_rebroadcast', { nonce: action.nonce });
        if (!pinned.pendingNonceIsLatest) continue;
      }
      if (latest > nonce) {
        action.missingReceiptPolls = (action.missingReceiptPolls ?? 0) + 1;
        if (action.missingReceiptPolls >= MISSING_RECEIPT_POLLS_BEFORE_RECONCILE) {
          action.status = 'reconcile_required';
          enterHold('foreign_nonce', { nonce: action.nonce });
          await persist();
          throw halt('a submitted nonce was consumed by an unknown transaction');
        }
        await persist();
        continue;
      }
      if (action !== unresolved[0]) continue;
      const since = Date.parse(
        (action.status === 'prepared'
          ? (action.timing?.firstBroadcastAttemptAt ?? action.timing?.submitStartedAt)
          : action.timing?.rpcAcceptedAt) ?? '',
      );
      if (Number.isFinite(since) && clock.now().getTime() - since > benchmark.stuckNonceHoldMs) {
        if (state.hold?.type === 'stuck_nonce' && state.hold.nonce === action.nonce) continue;
        enterHold('stuck_nonce', { nonce: action.nonce });
        await persist();
        throw hold('lowest unresolved nonce is stuck; operator recovery required');
      }
    }
    return { latest, pending, block };
  }

  async function broadcastPrepared() {
    const queue = state.actions.filter((action) => action.status === 'prepared').sort(byNonce);
    const submitted = [];
    windowBlocked = false;
    for (const action of queue) {
      if (
        pinned.maxNoncesAhead !== null &&
        lastLatest !== null &&
        BigInt(action.nonce) >= lastLatest + BigInt(pinned.maxNoncesAhead)
      ) {
        windowBlocked = true;
        emit('nonce_window_full', { nonce: action.nonce });
        break;
      }
      const minute = utcMinute(clock.now());
      if (submissionsInMinute(state, minute) >= benchmark.batchSize) {
        emit('quota_exhausted', { minute });
        break;
      }
      if (await assertHalted(config)) throw halt('HALT active: prepared actions retained for reconciliation');
      await throttle();
      const start = stampNow();
      action.timing = {
        ...action.timing,
        firstBroadcastAttemptAt: action.timing?.firstBroadcastAttemptAt ?? start.iso,
        submitStartedAt: start.iso,
        submitStartedWallMs: start.wallMs,
        submitStartedMonoMs: start.monoMs,
        clockOffsetMs: clockOffset?.current()?.offsetMs ?? null,
        processId,
      };
      await persist();
      let hash;
      try {
        hash = await rpc('sendRawTransaction', () => chain.sendRawTransaction({ serializedTransaction: action.raw }), {
          throttled: true,
        });
      } catch (error) {
        const kind = classifyRpcError(error);
        if (kind === 'already_known') hash = action.hash;
        else if (kind === 'nonce_too_low') {
          emit('submit_nonce_consumed', { nonce: action.nonce });
          break;
        } else {
          emit('submit_failed', { nonce: action.nonce });
          break;
        }
      }
      if (hash.toLowerCase() !== action.hash.toLowerCase()) {
        action.status = 'reconcile_required';
        enterHold('hash_mismatch', { nonce: action.nonce });
        await persist();
        throw halt('RPC returned a different transaction hash');
      }
      const accepted = stampNow();
      action.timing = {
        ...action.timing,
        rpcAcceptedAt: accepted.iso,
        rpcAcceptedWallMs: accepted.wallMs,
        rpcAcceptedMonoMs: accepted.monoMs,
      };
      action.status = 'submitted';
      action.broadcastAt = accepted.iso;
      await persist();
      emit('action_submitted', { id: action.id, nonce: action.nonce, minute: utcMinute(new Date(accepted.wallMs)) });
      submitted.push(action);
    }
    return submitted;
  }

  async function recordBatch(slot, outcome, fields = {}) {
    appendBatch(state, {
      id: `batch:${slot}`,
      slot,
      outcome,
      openedAt: clock.now().toISOString(),
      plannedCount: 0,
      ...fields,
    });
    await persist();
    emit('batch_recorded', { slot, outcome, ...fields });
  }

  async function prepareBatch(slot) {
    if (state.batches.some((batch) => batch.slot === slot))
      throw hold(`benchmark slot ${slot} already has a batch record`);
    if (state.hold) {
      await recordBatch(slot, 'hold_skip', { reason: state.hold.type });
      return [];
    }
    if (await assertHalted(config)) throw halt('HALT active: no writes permitted');
    if (!state.deployment) throw hold('no active deployment; run deploy first');

    const inFlight = inFlightCount(state);
    const capacityRoom = benchmark.inFlightCap - inFlight;
    const minute = utcMinute(clock.now());
    const quotaRoom = benchmark.batchSize - submissionsInMinute(state, minute);
    const planned = Math.min(benchmark.batchSize, capacityRoom, quotaRoom);
    if (planned <= 0) {
      await recordBatch(slot, 'capacity_skip', { inFlight, capacityRoom, quotaRoom });
      return [];
    }

    const [balance, fees, chainCount] = await Promise.all([
      rpc('getBalance', () => chain.getBalance({ address: account.address })),
      rpc('estimateFeesPerGas', () => chain.estimateFeesPerGas()),
      rpc('readCount', () =>
        chain.readContract({ address: state.deployment.address, abi: artifact.abi, functionName: 'count' }),
      ),
    ]);
    const maxFeePerGas =
      BigInt(fees.maxFeePerGas ?? (await rpc('getGasPrice', () => chain.getGasPrice()))) * pinned.feeHeadroom;
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 0n;
    const probeEntropy = `0x${crypto.randomBytes(32).toString('hex')}`;
    const probeData = encodeFunctionData({ abi: artifact.abi, functionName: 'pulse', args: [probeEntropy] });
    const gas = await rpc('estimateGas', () =>
      chain.estimateGas({ account, to: state.deployment.address, data: probeData }),
    );
    const worstCost = BigInt(gas) * BigInt(maxFeePerGas);
    const day = utcDay(clock.now());
    const batchWorst = worstCost * BigInt(planned);
    const committed = spentForDay(state, day) + reservedForDay(state, day);

    if (BigInt(gas) > config.maxGas || BigInt(maxFeePerGas) > config.maxFeePerGas || worstCost > benchmark.maxTxCost) {
      await recordBatch(slot, 'budget_skip', { reason: 'per_transaction_limit' });
      return [];
    }
    if (committed + batchWorst > benchmark.dailyCostLimit) {
      await recordBatch(slot, 'budget_skip', { reason: 'daily_limit' });
      return [];
    }
    if (BigInt(balance) < outstandingReservations(state) + batchWorst + config.minGasReserve) {
      await recordBatch(slot, 'budget_skip', { reason: 'balance_reserve' });
      return [];
    }

    const pendingNonce = await rpc('getTransactionCount:pending', () =>
      chain.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    );
    const journalNonce = nextJournalNonce(state);
    const rpcNonce = BigInt(pendingNonce);
    if (rpcNonce > journalNonce) {
      enterHold('foreign_nonce', { pending: rpcNonce.toString() });
      await persist();
      throw halt('pending nonce exceeds the journal nonce authority');
    }
    let nonce = journalNonce;
    const highest = highestExpectedCount(state);
    const chainBase = BigInt(chainCount);
    const base = highest === null || chainBase > highest ? chainBase : highest;

    const prepared = [];
    for (let index = 0; index < planned; index += 1) {
      const entropy = `0x${crypto.randomBytes(32).toString('hex')}`;
      const data = encodeFunctionData({ abi: artifact.abi, functionName: 'pulse', args: [entropy] });
      const raw = await account.signTransaction({
        chainId: config.chainId,
        nonce: Number(nonce),
        to: state.deployment.address,
        data,
        gas: BigInt(gas),
        maxFeePerGas: BigInt(maxFeePerGas),
        maxPriorityFeePerGas: BigInt(maxPriorityFeePerGas),
        type: 'eip1559',
      });
      const action = {
        id: `pulse:${slot}:${index}`,
        kind: 'pulse',
        slot,
        index,
        batchId: `batch:${slot}`,
        profile: benchmark.profile,
        status: 'prepared',
        nonce: nonce.toString(),
        to: state.deployment.address,
        data,
        raw,
        hash: keccak256(raw),
        expected: {
          contractAddress: state.deployment.address,
          entropy,
          countAfter: (base + BigInt(index) + 1n).toString(),
        },
        createdAt: clock.now().toISOString(),
        missingReceiptPolls: 0,
        timing: {
          ...emptyTiming(),
          preparedAt: clock.now().toISOString(),
          processId,
          measurementVersion: MEASUREMENT_VERSION,
        },
        cost: { ...emptyCost(), worstCostWei: worstCost.toString(), reservedDay: day },
        worstCost: worstCost.toString(),
      };
      appendAction(state, action);
      state.dailyReserved[day] = (reservedForDay(state, day) + worstCost).toString();
      prepared.push(action);
      nonce += 1n;
    }
    appendBatch(state, {
      id: `batch:${slot}`,
      slot,
      outcome: 'opened',
      openedAt: clock.now().toISOString(),
      plannedCount: planned,
      firstNonce: prepared[0].nonce,
      worstCostWei: batchWorst.toString(),
    });
    await persist();
    if (await assertHalted(config)) throw halt('HALT active after prepare; actions retained for reconciliation');
    emit('batch_prepared', { slot, planned, firstNonce: prepared[0].nonce });
    return prepared;
  }

  return {
    get state() {
      return state;
    },
    processId,
    reconcile,
    broadcastPrepared,
    watch,
    async runSlot(slot) {
      if (clockOffset?.due()) {
        const refreshed = await clockOffset.refresh().catch(() => null);
        emit('clock_offset', { offsetMs: refreshed?.offsetMs ?? null, servers: refreshed?.servers ?? 0 });
      }
      await reconcile();
      const backlog = await broadcastPrepared();
      const prepared = await prepareBatch(slot);
      const submitted = prepared.length ? await broadcastPrepared() : [];
      const batch = state.batches.find((entry) => entry.slot === slot);
      if (batch && batch.outcome === 'opened') {
        batch.outcome = 'submitted';
        batch.submittedCount = submitted.length;
        await persist();
      }
      return {
        backlog: backlog.length,
        prepared: prepared.length,
        submitted: submitted.length,
        outcome: batch?.outcome ?? 'none',
      };
    },
    async track() {
      const result = await reconcile();
      if (windowBlocked) await broadcastPrepared();
      return result;
    },
    async compact() {
      const run = saving.catch(() => {}).then(() => compactState(config.stateDir, state, benchmark.activeActionLimit));
      saving = run;
      return run;
    },
    async close() {
      await saving.catch(() => {});
      await release();
    },
  };
}

export function benchmarkLogRedactor(entry) {
  return JSON.parse(
    JSON.stringify(entry, (key, value) =>
      typeof value === 'bigint' ? value.toString() : typeof value === 'string' ? redact(value) : value,
    ),
  );
}

export async function clearBenchmarkHold({
  config,
  account,
  artifact,
  chain,
  type,
  nonce = null,
  reason,
  clock = systemClock(),
  log = (entry) => console.log(JSON.stringify(entry)),
}) {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 200)
    throw hold('--reason is required and must be at most 200 characters');
  const release = await acquireLock(config.stateDir);
  try {
    if (!(await assertHalted(config))) throw hold('create the HALT file before clearing a hold');
    const state = await loadState(config.stateDir, account.address, config.chainId);
    const current = state.hold;
    if (!current) throw hold('no benchmark hold is recorded');
    if (current.type !== type) throw hold(`recorded hold type is ${current.type}, not ${type}`);
    if ((current.nonce ?? null) !== nonce) throw hold('the given --nonce does not match the recorded hold');

    const [latestNonce, blockNumber] = await Promise.all([
      chain.getTransactionCount({ address: account.address, blockTag: 'latest' }),
      chain.getBlockNumber(),
    ]);
    const latest = BigInt(latestNonce);
    if (latest > nextJournalNonce(state))
      throw hold('chain nonce still exceeds the journal nonce authority; retire this journal');

    const verified = async (action) => {
      let receipt;
      try {
        receipt = await chain.getTransactionReceipt({ hash: action.hash });
      } catch {
        return null;
      }
      if (!receipt) return null;
      const block = await chain.getBlock({ blockNumber: receipt.blockNumber });
      if (block.hash?.toLowerCase() !== receipt.blockHash?.toLowerCase()) return null;
      if (receipt.status === 'success' && !pulseEventMatches(artifact, account.address, action, receipt)) return null;
      return receipt;
    };

    const restores = [];
    for (const action of unresolvedActions(state).filter((entry) => entry.status === 'reconcile_required')) {
      const receipt = action.hash ? await verified(action) : null;
      if (!receipt)
        throw hold(`action ${action.id} has no canonical receipt matching its journaled intent; retire this journal`);
      const settled = action.cost?.actualCostWei !== null && action.cost?.actualCostWei !== undefined;
      restores.push({
        action,
        status: settled ? (receipt.status === 'success' ? 'included' : 'reverted') : 'submitted',
        receipt,
      });
    }
    if (current.type === 'stuck_nonce') {
      const stuck = state.actions.find((entry) => entry.nonce === current.nonce);
      if (!stuck || latest <= BigInt(current.nonce)) throw hold('the stuck nonce has not been consumed yet');
      if (!(await verified(stuck)))
        throw hold('the stuck nonce was consumed without a receipt for the journaled hash; retire this journal');
    }

    const clearedAt = clock.now().toISOString();
    for (const { action, status, receipt } of restores) {
      action.status = status;
      action.missingReceiptPolls = 0;
      action.timing = { ...action.timing, recovered: true, quality: 'recovered' };
      if (status === 'included')
        action.receipt = { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash };
      if (status === 'reverted') action.finalizedAt = clearedAt;
    }
    state.holdHistory = [
      ...(state.holdHistory ?? []),
      {
        ...current,
        clearedAt,
        reason: redact(reason.trim()),
        restored: restores.map(({ action }) => action.id),
        checkedBlock: BigInt(blockNumber).toString(),
      },
    ].slice(-HOLD_HISTORY_LIMIT);
    state.hold = null;
    await saveState(config.stateDir, state);
    log(
      benchmarkLogRedactor({
        type: 'benchmark_hold_cleared',
        hold: current.type,
        nonce: current.nonce ?? null,
        restored: restores.length,
      }),
    );
    return {
      cleared: current.type,
      restored: restores.map(({ action }) => ({ id: action.id, status: action.status })),
    };
  } finally {
    await release();
  }
}
