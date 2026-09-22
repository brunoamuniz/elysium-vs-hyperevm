import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMinutePulse } from '../src/contract.mjs';

test('MinutePulse compiles with required ABI and bytecode', () => {
  const artifact = compileMinutePulse();
  assert.ok(artifact.bytecode.length > 10);
  assert.ok(artifact.runtimeBytecode.length > 10);
  assert.match(artifact.runtimeHash, /^0x[0-9a-f]{64}$/);
  assert.ok(artifact.abi.some((x) => x.name === 'pulse'));
});
