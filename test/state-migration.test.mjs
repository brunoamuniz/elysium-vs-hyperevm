import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ACTIVE_ACTION_LIMIT,
  aggregatesPath,
  archivePath,
  archiveRecord,
  archivableActions,
  compactState,
  emptyState,
  loadState,
  migrateState,
  nextJournalNonce,
  readArchive,
  saveAggregates,
  saveState,
  STATE_VERSION,
  validateReadableState,
  validateState,
} from '../src/state.mjs';

const WALLET = '0x00000000000000000000000000000000000000a1';
const SECRET = 'CANARY_MUST_NOT_LEAK';

function v1Action(index, status = 'finalized') {
  const base = Date.parse('2026-09-22T11:00:00.000Z') + index * 60_000;
  return {
    id: `pulse:slot-${index}`,
    kind: 'pulse',
    slot: `slot-${index}`,
    status,
    nonce: String(index),
    to: '0x00000000000000000000000000000000000000b2',
    data: `0x97dc97cb${SECRET}`,
    raw: `0x02f8${SECRET}`,
    hash: `0x${String(index % 10).repeat(64)}`,
    expected: {
      contractAddress: '0x00000000000000000000000000000000000000b2',
      entropy: `0x${'ab'.repeat(32)}`,
      countAfter: String(index),
    },
    createdAt: new Date(base).toISOString(),
    broadcastAt: new Date(base + 500).toISOString(),
    finalizedAt: status === 'finalized' ? new Date(base + 4500).toISOString() : undefined,
    receipt: { blockNumber: String(1000 + index), blockHash: `0x${'cc'.repeat(32)}` },
    worstCost: '1500000000000000',
  };
}

function v1State(actions) {
  return {
    version: 1,
    walletAddress: WALLET,
    deployment: { address: '0x00000000000000000000000000000000000000b2' },
    actions,
    dailySpend: { '2026-09-22': '3000000000000000' },
  };
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'elysium-migrate-'));
}

test('v1 journals migrate to v2 with typed timing, cost and legacy status remapping', () => {
  const migrated = migrateState(
    v1State([
      v1Action(1),
      v1Action(2, 'broadcast'),
      v1Action(3, 'confirmed'),
      v1Action(4, 'prepared'),
      v1Action(5, 'reconcile_required'),
    ]),
  );
  assert.equal(migrated.version, STATE_VERSION);
  assert.equal(migrated.migratedFrom, 1);
  assert.deepEqual(
    migrated.actions.map((action) => action.status),
    ['finalized', 'submitted', 'included', 'prepared', 'reconcile_required'],
  );
  assert.deepEqual(migrated.batches, []);
  assert.deepEqual(migrated.dailyReserved, {});
  assert.equal(migrated.dailySpend['2026-09-22'], '3000000000000000');
  const first = migrated.actions[0];
  assert.equal(first.timing.submitStartedAt, '2026-09-22T11:01:00.500Z');
  assert.equal(first.timing.rpcAcceptedAt, '2026-09-22T11:01:00.500Z');
  assert.equal(first.timing.confirmedObservedAt, '2026-09-22T11:01:04.500Z');
  assert.equal(first.timing.includedObservedAt, null);
  assert.equal(
    first.timing.quality,
    'migrated',
    'v1 finalization stamps must never count as primary benchmark samples',
  );
  assert.equal(first.cost.worstCostWei, '1500000000000000');
  assert.equal(first.cost.reservedDay, '2026-09-22');
  assert.equal(first.profile, 'serial-1');
  validateState(migrated);
});

test('migration is idempotent and refuses unknown versions', () => {
  const once = migrateState(v1State([v1Action(1)]));
  assert.equal(migrateState(once), once);
  assert.throws(() => migrateState({ version: 3, actions: [], dailySpend: {} }), /invalid state schema/);
  assert.throws(() => migrateState({ version: 1, actions: 'nope', dailySpend: {} }), /invalid state schema/);
  assert.throws(() => migrateState(null), /invalid state schema/);
});

test('loadState migrates a v1 file on disk without a wallet mismatch', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(v1State([v1Action(1)])), { mode: 0o600 });
  const loaded = await loadState(dir, WALLET);
  assert.equal(loaded.version, 2);
  assert.equal(loaded.actions[0].status, 'finalized');
  await saveState(dir, loaded);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8')).version, 2);
  await fs.rm(dir, { recursive: true });
});

test('dashboard-readable validation accepts v1 and v2 but rejects unknown versions', () => {
  validateReadableState(v1State([v1Action(1)]));
  validateReadableState(migrateState(v1State([v1Action(1)])));
  const withNewStatus = {
    ...emptyState(WALLET),
    actions: [{ status: 'included' }, { status: 'reverted' }],
    batches: [{ id: 'b', outcome: 'capacity_skip' }],
  };
  validateReadableState(withNewStatus);
  assert.throws(() => validateReadableState({ version: 99, actions: [], dailySpend: {} }));
  assert.throws(() => validateReadableState({ version: 2, actions: [], dailySpend: {}, batches: 'nope' }));
});

test('benchmark batch records and new statuses do not make a v2 journal invalid', () => {
  const state = emptyState(WALLET);
  state.actions.push({ id: 'pulse:a:0', status: 'included' }, { id: 'pulse:a:1', status: 'reverted' });
  state.batches.push(
    { id: 'batch:a', slot: 'a', outcome: 'capacity_skip' },
    { id: 'batch:b', slot: 'b', outcome: 'submitted' },
  );
  validateState(state);
  state.batches.push({ id: 'batch:c', outcome: 'mystery' });
  assert.throws(() => validateState(state), /invalid batch outcome/);
});

test('nonce authority is the highest journaled nonce plus one', () => {
  assert.equal(nextJournalNonce(emptyState(WALLET)), 0n);
  const state = emptyState(WALLET);
  state.actions.push(
    { id: 'a', nonce: '7', status: 'finalized' },
    { id: 'b', nonce: '3', status: 'prepared' },
    { id: 'c', status: 'prepared' },
  );
  assert.equal(nextJournalNonce(state), 8n);
});

test('archive records drop raw and calldata before leaving the active journal', () => {
  const record = archiveRecord(migrateState(v1State([v1Action(1)])).actions[0]);
  const serialized = JSON.stringify(record);
  assert.ok(!('raw' in record));
  assert.ok(!('data' in record));
  assert.ok(!serialized.includes(SECRET));
  assert.equal(record.cost.worstCostWei, '1500000000000000');
});

test('compaction rotates finalized actions to bounded daily NDJSON and keeps the journal compact', async () => {
  const dir = await tempDir();
  const state = migrateState(v1State(Array.from({ length: 12 }, (_, index) => v1Action(index + 1))));
  state.actions[11].status = 'submitted';
  await saveState(dir, state);
  assert.equal(archivableActions(state, 5).length, 7);
  const result = await compactState(dir, state, 5);
  assert.equal(result.archived, 7);
  assert.equal(state.actions.length, 5);
  assert.equal(state.archive.archivedActions, 7);
  assert.deepEqual(state.archive.files, ['finalized-2026-09-22.ndjson']);
  const archived = await readArchive(dir, '2026-09-22');
  assert.equal(archived.length, 7);
  assert.ok(!(await fs.readFile(archivePath(dir, '2026-09-22'), 'utf8')).includes(SECRET));
  assert.equal(state.actions[state.actions.length - 1].status, 'submitted');
  await fs.rm(dir, { recursive: true });
});

test('compaction is a no-op below the active limit and never drops unresolved actions', async () => {
  const dir = await tempDir();
  const state = migrateState(v1State([v1Action(1), v1Action(2, 'broadcast')]));
  assert.deepEqual(await compactState(dir, state, ACTIVE_ACTION_LIMIT), { archived: 0, files: [] });
  assert.equal(state.actions.length, 2);
  await fs.rm(dir, { recursive: true });
});

test('a truncated final archive line is tolerated instead of losing the whole file', async () => {
  const dir = await tempDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(archivePath(dir, '2026-09-22'), '{"id":"a"}\n{"id":"b"}\n{"id":"c","tru', { mode: 0o600 });
  assert.deepEqual(
    (await readArchive(dir, '2026-09-22')).map((record) => record.id),
    ['a', 'b'],
  );
  assert.deepEqual(await readArchive(dir, '2026-01-01'), []);
  await fs.rm(dir, { recursive: true });
});

test('aggregates are written atomically without a leftover temporary file', async () => {
  const dir = await tempDir();
  await saveAggregates(dir, { generatedAt: '2026-09-22T12:00:00.000Z', sampleCounts: { actions: 3 } });
  assert.equal(JSON.parse(await fs.readFile(aggregatesPath(dir), 'utf8')).sampleCounts.actions, 3);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['aggregates.json']);
  await fs.rm(dir, { recursive: true });
});
