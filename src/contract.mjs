import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import { getAddress, keccak256, padHex, toHex } from 'viem';

const sourcePath = path.resolve('contracts/MinutePulse.sol');
export function compileMinutePulse() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'MinutePulse.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      metadata: { bytecodeHash: 'none' },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((entry) => entry.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const artifact = output.contracts?.['MinutePulse.sol']?.MinutePulse;
  const bytecode = `0x${artifact?.evm?.bytecode?.object || ''}`;
  const runtimeBytecode = `0x${artifact?.evm?.deployedBytecode?.object || ''}`;
  if (bytecode === '0x' || runtimeBytecode === '0x') throw new Error('contract compilation produced empty bytecode');
  const abi = artifact.abi;
  for (const expected of ['count', 'pulse', 'authorizedCaller'])
    if (!abi.some((item) => item.type === 'function' && item.name === expected))
      throw new Error(`missing ABI method ${expected}`);
  if (!abi.some((item) => item.type === 'event' && item.name === 'Pulsed')) throw new Error('missing Pulsed event');
  const immutablePlaceholder = '0'.repeat(64);
  if (!runtimeBytecode.slice(2).includes(immutablePlaceholder))
    throw new Error('authorizedCaller immutable placeholder missing from runtime bytecode');
  const runtimeBytecodeForAuthorizedCaller = (caller) => {
    const body = runtimeBytecode.slice(2);
    const replacement = padHex(getAddress(caller), { size: 32 }).slice(2).toLowerCase();
    return `0x${body.replaceAll(immutablePlaceholder, replacement)}`;
  };
  const runtimeHashForAuthorizedCaller = (caller) => keccak256(runtimeBytecodeForAuthorizedCaller(caller));
  return {
    abi,
    bytecode,
    runtimeBytecode,
    runtimeHash: keccak256(runtimeBytecode),
    runtimeBytecodeForAuthorizedCaller,
    runtimeHashForAuthorizedCaller,
    sourceHash: keccak256(toHex(source)),
    compilerVersion: solc.version(),
  };
}
