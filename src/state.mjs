import fs from 'node:fs/promises';
import path from 'node:path';

export const STATE_VERSION = 2;
export const SUPPORTED_STATE_VERSIONS = [1, 2];
export const ACTION_STATUSES = ['prepared', 'submitted', 'included', 'finalized', 'reverted', 'reconcile_required'];
export const LEGACY_STATUS_MAP = { broadcast: 'submitted', confirmed: 'included' };
export const RESOLVED_STATUSES = ['finalized', 'reverted'];
export const IN_FLIGHT_STATUSES = ['prepared', 'submitted'];
export const BATCH_OUTCOMES = ['opened', 'submitted', 'capacity_skip', 'budget_skip', 'hold_skip'];
export const TIMING_QUALITIES = ['primary', 'recovered', 'migrated', 'drift'];
export const ACTIVE_ACTION_LIMIT = 400;
export const HOLD_TYPES = [
  'stuck_nonce',
  'foreign_nonce',
  'intent_mismatch',
  'reorg',
  'hash_mismatch',
  'reconcile_required',
];
export const HOLD_HISTORY_LIMIT = 20;

export function emptyTiming() {
  return {
    preparedAt: null,
    submitStartedAt: null,
    rpcAcceptedAt: null,
    includedObservedAt: null,
    blockTimestamp: null,
    confirmedObservedAt: null,
    pollIntervalMs: null,
    quality: 'primary',
    recovered: false,
  };
}
export function emptyCost() {
  return { worstCostWei: null, reservedDay: null, actualCostWei: null, gasUsed: null, effectiveGasPriceWei: null };
}
export const LEGACY_CHAIN_ID = 99801;
export function emptyState(walletAddress = null, chainId = null) {
  return {
    version: STATE_VERSION,
    chainId,
    walletAddress,
    deployment: null,
    actions: [],
    batches: [],
    dailySpend: {},
    dailyReserved: {},
    hold: null,
    archive: { files: [], archivedActions: 0 },
  };
}
export async function ensureStateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const s = await fs.lstat(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0) throw new Error('state directory is insecure');
}
export function statePath(dir) {
  return path.join(dir, 'state.json');
}
export function aggregatesPath(dir) {
  return path.join(dir, 'aggregates.json');
}
export function archivePath(dir, day) {
  return path.join(dir, `finalized-${day}.ndjson`);
}

function migrateAction(action) {
  const timing = {
    ...emptyTiming(),
    preparedAt: action.createdAt ?? null,
    submitStartedAt: action.broadcastAt ?? null,
    rpcAcceptedAt: action.broadcastAt ?? null,
    confirmedObservedAt: action.finalizedAt ?? null,
    quality: 'migrated',
  };
  return {
    ...action,
    status: LEGACY_STATUS_MAP[action.status] ?? action.status,
    profile: action.profile ?? 'serial-1',
    batchId: action.batchId ?? null,
    index: action.index ?? 0,
    timing: action.timing ?? timing,
    cost: action.cost ?? {
      ...emptyCost(),
      worstCostWei: action.worstCost ?? null,
      reservedDay: typeof action.createdAt === 'string' ? action.createdAt.slice(0, 10) : null,
    },
  };
}

export function migrateState(raw) {
  if (!raw || typeof raw !== 'object' || !SUPPORTED_STATE_VERSIONS.includes(raw.version))
    throw new Error('invalid state schema');
  if (raw.version === STATE_VERSION) return raw;
  if (!Array.isArray(raw.actions) || typeof raw.dailySpend !== 'object' || raw.dailySpend === null)
    throw new Error('invalid state schema');
  return {
    version: STATE_VERSION,
    walletAddress: raw.walletAddress ?? null,
    deployment: raw.deployment ?? null,
    actions: raw.actions.map(migrateAction),
    batches: [],
    dailySpend: { ...raw.dailySpend },
    dailyReserved: {},
    hold: null,
    archive: { files: [], archivedActions: 0 },
    migratedFrom: raw.version,
  };
}

export function validateState(state) {
  if (!state || state.version !== STATE_VERSION || !Array.isArray(state.actions) || !Array.isArray(state.batches))
    throw new Error('invalid state schema');
  if (
    typeof state.dailySpend !== 'object' ||
    state.dailySpend === null ||
    typeof state.dailyReserved !== 'object' ||
    state.dailyReserved === null
  )
    throw new Error('invalid state schema');
  for (const action of state.actions)
    if (!ACTION_STATUSES.includes(action.status)) throw new Error('invalid action status');
  for (const batch of state.batches)
    if (!BATCH_OUTCOMES.includes(batch.outcome)) throw new Error('invalid batch outcome');
  if (
    state.hold !== undefined &&
    state.hold !== null &&
    (typeof state.hold !== 'object' || !HOLD_TYPES.includes(state.hold.type))
  )
    throw new Error('invalid hold');
  if (state.holdHistory !== undefined && !Array.isArray(state.holdHistory)) throw new Error('invalid hold history');
  if (state.chainId !== undefined && state.chainId !== null && !Number.isSafeInteger(state.chainId))
    throw new Error('invalid chain id');
}

export function validateReadableState(state) {
  if (!state || !SUPPORTED_STATE_VERSIONS.includes(state.version) || !Array.isArray(state.actions))
    throw new Error('invalid state schema');
  if (typeof state.dailySpend !== 'object' || state.dailySpend === null) throw new Error('invalid state schema');
  if (state.batches !== undefined && !Array.isArray(state.batches)) throw new Error('invalid state schema');
}

function assertChain(state, chainId) {
  if (chainId === undefined) return;
  if (state.chainId === undefined || state.chainId === null) {
    if (chainId !== LEGACY_CHAIN_ID)
      throw new Error('state journal has no chain id and only the Elysium journal predates it');
    state.chainId = chainId;
    return;
  }
  if (state.chainId !== chainId) throw new Error('state belongs to another chain');
}

export async function loadState(dir, walletAddress = null, chainId = undefined) {
  await ensureStateDir(dir);
  const file = statePath(dir);
  try {
    const state = migrateState(JSON.parse(await fs.readFile(file, 'utf8')));
    validateState(state);
    if (walletAddress && state.walletAddress && state.walletAddress.toLowerCase() !== walletAddress.toLowerCase())
      throw new Error('state belongs to another wallet');
    assertChain(state, chainId);
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState(walletAddress, chainId ?? null);
    throw error;
  }
}

async function atomicWrite(dir, target, body) {
  const temp = path.join(dir, `.${path.basename(target)}-${process.pid}-${Date.now()}.tmp`);
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, target);
  const parent = await fs.open(dir, 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

export async function saveState(dir, state) {
  validateState(state);
  await ensureStateDir(dir);
  await atomicWrite(dir, statePath(dir), JSON.stringify(state, null, 2) + '\n');
}
export async function saveAggregates(dir, aggregates) {
  await ensureStateDir(dir);
  await atomicWrite(dir, aggregatesPath(dir), JSON.stringify(aggregates, null, 2) + '\n');
}

export function unresolvedAction(state) {
  return state.actions.find((a) => !RESOLVED_STATUSES.includes(a.status));
}
export function unresolvedActions(state) {
  return state.actions
    .filter((a) => !RESOLVED_STATUSES.includes(a.status))
    .sort((a, b) =>
      BigInt(a.nonce ?? 0) < BigInt(b.nonce ?? 0) ? -1 : BigInt(a.nonce ?? 0) > BigInt(b.nonce ?? 0) ? 1 : 0,
    );
}
export function inFlightCount(state) {
  return state.actions.filter((a) => IN_FLIGHT_STATUSES.includes(a.status)).length;
}
export function appendAction(state, action) {
  if (state.actions.some((a) => a.id === action.id)) throw new Error('duplicate action id');
  state.actions.push(action);
}
export function appendBatch(state, batch) {
  if (state.batches.some((b) => b.id === batch.id)) throw new Error('duplicate batch id');
  state.batches.push(batch);
}

export function nextJournalNonce(state) {
  let max = -1n;
  for (const action of state.actions) {
    if (action.nonce === undefined || action.nonce === null) continue;
    const nonce = BigInt(action.nonce);
    if (nonce > max) max = nonce;
  }
  return max + 1n;
}

export function archivableActions(state, limit = ACTIVE_ACTION_LIMIT) {
  const resolved = state.actions.filter((a) => RESOLVED_STATUSES.includes(a.status));
  const keep = Math.max(0, state.actions.length - limit);
  return resolved.slice(0, Math.min(keep, resolved.length));
}

export function archiveRecord(action) {
  const { raw, data, ...rest } = action;
  return rest;
}

function archiveDay(action) {
  const stamp = action.timing?.rpcAcceptedAt ?? action.timing?.preparedAt ?? action.createdAt;
  return typeof stamp === 'string' && /^\d{4}-\d{2}-\d{2}/.test(stamp) ? stamp.slice(0, 10) : '0000-00-00';
}

export async function compactState(dir, state, limit = ACTIVE_ACTION_LIMIT) {
  const doomed = archivableActions(state, limit);
  if (!doomed.length) return { archived: 0, files: [] };
  const byDay = new Map();
  for (const action of doomed) {
    const day = archiveDay(action);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(archiveRecord(action));
  }
  await ensureStateDir(dir);
  const files = [];
  for (const [day, records] of [...byDay.entries()].sort()) {
    const handle = await fs.open(archivePath(dir, day), 'a', 0o600);
    try {
      await handle.writeFile(records.map((record) => JSON.stringify(record)).join('\n') + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    files.push(`finalized-${day}.ndjson`);
  }
  const removed = new Set(doomed.map((action) => action.id));
  state.actions = state.actions.filter((action) => !removed.has(action.id));
  state.archive = {
    files: [...new Set([...(state.archive?.files ?? []), ...files])].sort(),
    archivedActions: (state.archive?.archivedActions ?? 0) + doomed.length,
  };
  await saveState(dir, state);
  return { archived: doomed.length, files };
}

export async function readArchive(dir, day) {
  let text;
  try {
    text = await fs.readFile(archivePath(dir, day), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* tolerate a truncated final line */
    }
  }
  return records;
}
