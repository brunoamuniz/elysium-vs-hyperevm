import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { KEY_ROOT, KEY_PATH } from './config.mjs';
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;
export function validatePrivateKey(value) {
  if (!KEY_RE.test(value || '')) throw new Error('wallet key must be a 32-byte 0x-prefixed hex value');
  return value;
}
export async function assertSafeDirectory(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error('wallet directory is not a private regular directory');
}
export async function generateWallet(keyPath = KEY_PATH) {
  const resolved = path.resolve(keyPath);
  if (path.dirname(resolved) !== KEY_ROOT)
    throw new Error('wallet key path must be directly inside the approved config directory');
  await assertSafeDirectory(KEY_ROOT);
  const key = `0x${crypto.randomBytes(32).toString('hex')}`;
  const account = privateKeyToAccount(key);
  const body = JSON.stringify({ version: 1, address: account.address, privateKey: key }) + '\n';
  let handle;
  try {
    handle = await fs.open(resolved, 'wx', 0o600);
    await handle.writeFile(body, { encoding: 'utf8' });
    await handle.sync();
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(`wallet already exists at ${resolved}; refusing to overwrite`, { cause: error });
    throw error;
  } finally {
    await handle?.close();
  }
  return { address: account.address, keyPath: resolved };
}
export async function loadWallet(keyPath = KEY_PATH) {
  const resolved = path.resolve(keyPath);
  if (path.dirname(resolved) !== KEY_ROOT) throw new Error('wallet key path is outside approved config directory');
  await assertSafeDirectory(KEY_ROOT);
  const stat = await fs.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
    throw new Error('wallet key file is insecure');
  const json = JSON.parse(await fs.readFile(resolved, 'utf8'));
  const privateKey = validatePrivateKey(json.privateKey);
  const account = privateKeyToAccount(privateKey);
  if (json.address?.toLowerCase() !== account.address.toLowerCase())
    throw new Error('wallet address does not match key');
  return account;
}
