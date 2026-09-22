import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validatePrivateKey } from '../src/wallet.mjs';
import { acquireLock } from '../src/lock.mjs';
import { appendAction, emptyState, loadState, saveState } from '../src/state.mjs';

test('private key validation rejects malformed values', () => {
  assert.throws(() => validatePrivateKey('bad'));
  assert.equal(validatePrivateKey('0x' + '1'.repeat(64)).length, 66);
});
test('state persists append-only actions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elysium-state-'));
  const state = emptyState('0x0000000000000000000000000000000000000001');
  appendAction(state, { id: 'pulse:one', status: 'prepared' });
  await saveState(dir, state);
  const loaded = await loadState(dir, state.walletAddress);
  assert.equal(loaded.actions[0].id, 'pulse:one');
  await fs.rm(dir, { recursive: true });
});
test('kernel lock prevents a concurrent state writer and releases cleanly', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elysium-lock-'));
  const release = await acquireLock(dir);
  await assert.rejects(() => acquireLock(dir), /holds the state lock/);
  await release();
  const releaseSecond = await acquireLock(dir);
  await releaseSecond();
  await fs.rm(dir, { recursive: true });
});

test('a journal is bound to one chain and only the legacy Elysium journal may lack a chain id', async () => {
  const { LEGACY_CHAIN_ID } = await import('../src/state.mjs');
  const wallet = '0x0000000000000000000000000000000000000001';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elysium-chain-'));
  const fresh = await loadState(dir, wallet, 998);
  assert.equal(fresh.chainId, 998, 'a new journal records its chain');
  await saveState(dir, fresh);
  await assert.rejects(() => loadState(dir, wallet, LEGACY_CHAIN_ID), /another chain/);
  assert.equal((await loadState(dir, wallet, 998)).chainId, 998);
  const legacy = emptyState(wallet);
  delete legacy.chainId;
  await saveState(dir, legacy);
  await assert.rejects(() => loadState(dir, wallet, 998), /no chain id/);
  const adopted = await loadState(dir, wallet, LEGACY_CHAIN_ID);
  assert.equal(adopted.chainId, LEGACY_CHAIN_ID, 'the legacy Elysium journal is stamped on load');
  await fs.rm(dir, { recursive: true });
});
