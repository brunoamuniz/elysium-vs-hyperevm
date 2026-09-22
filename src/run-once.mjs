import crypto from 'node:crypto';
import { decodeEventLog, encodeDeployData, encodeFunctionData, getContractAddress, keccak256 } from 'viem';
import { assertLive } from './config.mjs';
import { compileMinutePulse } from './contract.mjs';
import { assertHalted, clients, verifyNetwork } from './elysium.mjs';
import { acquireLock } from './lock.mjs';
import { appendAction, emptyCost, emptyTiming, loadState, saveState, unresolvedAction } from './state.mjs';

function slotNow(now = new Date()) {
  return now.toISOString().slice(0, 16) + 'Z';
}
function actionId(kind, slot) {
  return `${kind}:${slot}`;
}
function dayKey() {
  return new Date().toISOString().slice(0, 10);
}
function hold(message) {
  const error = new Error(message);
  error.code = 'HOLD';
  return error;
}
async function maybeReceipt(publicClient, hash) {
  try {
    return await publicClient.getTransactionReceipt({ hash });
  } catch {
    return null;
  }
}
async function maybeTransaction(publicClient, hash) {
  try {
    return await publicClient.getTransaction({ hash });
  } catch {
    return null;
  }
}
function reserved(state, day) {
  return BigInt(state.dailyReserved?.[day] ?? '0');
}
function spent(state, day) {
  return BigInt(state.dailySpend?.[day] ?? '0');
}
function releaseReservation(state, action) {
  const day = action.cost?.reservedDay;
  if (!day || action.cost.reservationReleased) return;
  const remaining = reserved(state, day) - BigInt(action.cost.worstCostWei ?? '0');
  state.dailyReserved[day] = (remaining > 0n ? remaining : 0n).toString();
  action.cost.reservationReleased = true;
}

async function finalize({ action, account, publicClient, config, state, artifact }) {
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: action.hash,
    confirmations: config.confirmations,
    timeout: 90_000,
  });
  if (receipt.status !== 'success') throw hold('transaction reverted');
  const canonical = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
  if (canonical.hash?.toLowerCase() !== receipt.blockHash?.toLowerCase()) throw hold('receipt block is non-canonical');
  const tx = await publicClient.getTransaction({ hash: action.hash });
  if (
    tx.from.toLowerCase() !== account.address.toLowerCase() ||
    (tx.to ?? null)?.toLowerCase() !== action.to?.toLowerCase() ||
    tx.input.toLowerCase() !== action.data.toLowerCase()
  )
    throw hold('transaction intent mismatch');
  if (action.kind === 'deploy') {
    const code = await publicClient.getBytecode({ address: action.expected.contractAddress });
    const expectedRuntimeHash = artifact.runtimeHashForAuthorizedCaller(account.address);
    if (!code || keccak256(code) !== expectedRuntimeHash) throw hold('deployed runtime bytecode hash mismatch');
    const caller = await publicClient.readContract({
      address: action.expected.contractAddress,
      abi: artifact.abi,
      functionName: 'authorizedCaller',
    });
    if (caller.toLowerCase() !== account.address.toLowerCase()) throw hold('deployment authorized caller mismatch');
    state.deployment = {
      address: action.expected.contractAddress,
      runtimeHash: expectedRuntimeHash,
      txHash: action.hash,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
    };
  } else {
    const events = receipt.logs
      .filter((log) => log.address.toLowerCase() === action.expected.contractAddress.toLowerCase())
      .map((log) => {
        try {
          return decodeEventLog({ abi: artifact.abi, data: log.data, topics: log.topics });
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((event) => event.eventName === 'Pulsed');
    const match = events.find(
      (event) =>
        event.args.caller.toLowerCase() === account.address.toLowerCase() &&
        event.args.count === BigInt(action.expected.countAfter) &&
        event.args.entropy.toLowerCase() === action.expected.entropy.toLowerCase(),
    );
    if (!match) throw hold('pulse receipt did not emit the exact expected Pulsed event');
  }
  const finalizedAt = new Date().toISOString();
  const gasUsed = BigInt(receipt.gasUsed);
  const effectiveGasPrice = BigInt(receipt.effectiveGasPrice ?? 0n);
  const actualCost = gasUsed * effectiveGasPrice;
  releaseReservation(state, action);
  const day = action.cost?.reservedDay ?? dayKey();
  if (action.cost?.actualCostWei === null || action.cost?.actualCostWei === undefined)
    state.dailySpend[day] = (spent(state, day) + actualCost).toString();
  action.cost = {
    ...action.cost,
    actualCostWei: actualCost.toString(),
    gasUsed: gasUsed.toString(),
    effectiveGasPriceWei: effectiveGasPrice.toString(),
  };
  action.timing = {
    ...action.timing,
    confirmedObservedAt: finalizedAt,
    blockTimestamp: canonical.timestamp.toString(),
    confirmationLabel: '2-conf',
  };
  action.status = 'finalized';
  action.finalizedAt = finalizedAt;
  action.receipt = { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash };
  await saveState(config.stateDir, state);
  return action;
}

async function reconcilePendingAction({ account, publicClient, config, state, artifact }) {
  const action = unresolvedAction(state);
  if (!action) return null;
  if (action.status === 'reconcile_required') throw hold('reconcile required: operator review before further writes');
  action.timing = { ...(action.timing ?? emptyTiming()), recovered: true, quality: 'recovered' };
  const receipt = await maybeReceipt(publicClient, action.hash);
  if (receipt) return finalize({ action, account, publicClient, config, state, artifact });
  const found = await maybeTransaction(publicClient, action.hash);
  if (found) {
    action.status = 'submitted';
    await saveState(config.stateDir, state);
    throw hold('reconcile required: transaction is pending');
  }
  const [latest, pending] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
  ]);
  if (latest <= BigInt(action.nonce) && pending <= BigInt(action.nonce)) {
    if (await assertHalted(config)) throw hold('HALT active: retained prepared action was not broadcast');
    const hash = await publicClient.sendRawTransaction({ serializedTransaction: action.raw });
    if (hash.toLowerCase() !== action.hash.toLowerCase()) throw hold('reconcile broadcast hash mismatch');
    const broadcastAt = new Date().toISOString();
    action.status = 'submitted';
    action.broadcastAt = broadcastAt;
    action.timing = {
      ...action.timing,
      submitStartedAt: action.timing.submitStartedAt ?? broadcastAt,
      rpcAcceptedAt: broadcastAt,
    };
    await saveState(config.stateDir, state);
    return finalize({ action, account, publicClient, config, state, artifact });
  }
  action.status = 'reconcile_required';
  await saveState(config.stateDir, state);
  throw hold('reconcile required: nonce consumed by an unknown transaction');
}

async function prepareAndBroadcast({ kind, data, to, account, publicClient, config, state, expectedForNonce }) {
  if (await assertHalted(config)) throw hold('HALT active: no writes permitted');
  if (unresolvedAction(state)) throw hold('unresolved action exists; reconcile before a new write');
  const [nonce, balance, fees] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    publicClient.getBalance({ address: account.address }),
    publicClient.estimateFeesPerGas(),
  ]);
  const gas = await publicClient.estimateGas({ account, to, data });
  const maxFeePerGas = fees.maxFeePerGas ?? (await publicClient.getGasPrice());
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 0n;
  const worstCost = gas * maxFeePerGas;
  const day = dayKey();
  const committed = spent(state, day) + reserved(state, day);
  if (
    gas > config.maxGas ||
    maxFeePerGas > config.maxFeePerGas ||
    worstCost > config.maxTxCost ||
    committed + worstCost > config.dailyCostLimit ||
    balance < worstCost + config.minGasReserve
  )
    throw hold('cost or balance circuit breaker held this write');
  const raw = await account.signTransaction({
    chainId: config.chainId,
    nonce,
    to,
    data,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    type: 'eip1559',
  });
  const hash = keccak256(raw);
  const expected = expectedForNonce(nonce);
  const preparedAt = new Date().toISOString();
  const action = {
    id: actionId(kind, expected.slot),
    kind,
    slot: expected.slot,
    index: 0,
    batchId: null,
    profile: 'serial-1',
    status: 'prepared',
    nonce: nonce.toString(),
    to: to ?? null,
    data,
    raw,
    hash,
    expected,
    createdAt: preparedAt,
    worstCost: worstCost.toString(),
    timing: { ...emptyTiming(), preparedAt },
    cost: { ...emptyCost(), worstCostWei: worstCost.toString(), reservedDay: day },
  };
  appendAction(state, action);
  state.dailyReserved[day] = (reserved(state, day) + worstCost).toString();
  await saveState(config.stateDir, state);
  if (await assertHalted(config)) throw hold('HALT active after prepare; action retained for reconciliation');
  const submitStartedAt = new Date().toISOString();
  action.timing = { ...action.timing, submitStartedAt };
  await saveState(config.stateDir, state);
  const broadcastHash = await publicClient.sendRawTransaction({ serializedTransaction: raw });
  if (broadcastHash.toLowerCase() !== hash.toLowerCase()) throw hold('RPC returned a different transaction hash');
  const rpcAcceptedAt = new Date().toISOString();
  action.status = 'submitted';
  action.broadcastAt = rpcAcceptedAt;
  action.timing = { ...action.timing, rpcAcceptedAt };
  await saveState(config.stateDir, state);
  return action;
}

async function exclusive(config, fn) {
  const release = await acquireLock(config.stateDir);
  try {
    return await fn();
  } finally {
    await release();
  }
}
export async function deploy(account, config, argv = process.argv) {
  assertLive(config, argv);
  return exclusive(config, async () => {
    const { publicClient } = clients(account, config);
    await verifyNetwork(publicClient, config);
    const state = await loadState(config.stateDir, account.address, config.chainId);
    state.walletAddress ||= account.address;
    const artifact = compileMinutePulse();
    await reconcilePendingAction({ account, publicClient, config, state, artifact });
    if (state.deployment) throw new Error(`contract already deployed at ${state.deployment.address}`);
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [account.address] });
    const action = await prepareAndBroadcast({
      kind: 'deploy',
      data,
      to: undefined,
      account,
      publicClient,
      config,
      state,
      expectedForNonce: (nonce) => ({
        slot: `deploy-${Date.now()}`,
        contractAddress: getContractAddress({ from: account.address, nonce }),
        runtimeHash: artifact.runtimeHashForAuthorizedCaller(account.address),
      }),
    });
    return finalize({ action, account, publicClient, config, state, artifact });
  });
}
export async function pulseOnce(account, config, now = new Date(), argv = process.argv) {
  assertLive(config, argv);
  return exclusive(config, async () => {
    const { publicClient } = clients(account, config);
    await verifyNetwork(publicClient, config);
    const state = await loadState(config.stateDir, account.address, config.chainId);
    state.walletAddress ||= account.address;
    const artifact = compileMinutePulse();
    await reconcilePendingAction({ account, publicClient, config, state, artifact });
    if (!state.deployment) throw new Error('no active deployment; run deploy first');
    const code = await publicClient.getBytecode({ address: state.deployment.address });
    const caller = await publicClient.readContract({
      address: state.deployment.address,
      abi: artifact.abi,
      functionName: 'authorizedCaller',
    });
    if (
      !code ||
      keccak256(code) !== state.deployment.runtimeHash ||
      caller.toLowerCase() !== account.address.toLowerCase()
    )
      throw hold('active contract attestation mismatch');
    const slot = slotNow(now);
    if (state.actions.some((a) => a.kind === 'pulse' && a.slot === slot))
      throw hold(`minute slot ${slot} already has an action`);
    const before = await publicClient.readContract({
      address: state.deployment.address,
      abi: artifact.abi,
      functionName: 'count',
    });
    const entropy = `0x${crypto.randomBytes(32).toString('hex')}`;
    const data = encodeFunctionData({ abi: artifact.abi, functionName: 'pulse', args: [entropy] });
    const action = await prepareAndBroadcast({
      kind: 'pulse',
      data,
      to: state.deployment.address,
      account,
      publicClient,
      config,
      state,
      expectedForNonce: () => ({
        slot,
        contractAddress: state.deployment.address,
        entropy,
        countAfter: (before + 1n).toString(),
      }),
    });
    return finalize({ action, account, publicClient, config, state, artifact });
  });
}
