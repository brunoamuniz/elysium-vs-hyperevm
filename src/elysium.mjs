import fs from 'node:fs/promises';
import path from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { CHAINS } from './config.mjs';

function pinnedChain(config) {
  const chain = CHAINS[config?.chain];
  if (!chain || chain.chainId !== config.chainId || chain.rpcUrl !== config.rpcUrl)
    throw new Error('clients require a config for a pinned chain');
  return chain;
}
export function clients(account, config) {
  const pinned = pinnedChain(config);
  const chain = defineChain({
    id: pinned.chainId,
    name: pinned.name,
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: { default: { http: [pinned.rpcUrl] } },
  });
  return {
    publicClient: createPublicClient({ chain, transport: http(pinned.rpcUrl, { timeout: 15_000, retryCount: 0 }) }),
    walletClient: account
      ? createWalletClient({ account, chain, transport: http(pinned.rpcUrl, { timeout: 15_000, retryCount: 0 }) })
      : null,
  };
}
export async function verifyNetwork(publicClient, config) {
  const [id, anchor] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlock({ blockNumber: config.anchorBlock }),
  ]);
  if (id !== config.chainId) throw new Error(`unexpected chain ID ${id}`);
  if (anchor.hash?.toLowerCase() !== config.anchorHash.toLowerCase())
    throw new Error(`${config.chainName ?? 'chain'} anchor block hash mismatch`);
  return { chainId: id, anchorHash: anchor.hash };
}
export async function assertHalted(config) {
  try {
    await fs.access(path.join(config.stateDir, 'HALT'));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
