import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import fsExt from 'fs-ext';

const flock = promisify(fsExt.flock);
export async function acquireLock(stateDir) {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(stateDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error('state directory is insecure');
  const file = path.join(stateDir, '.run.lock');
  const handle = await fs.open(file, 'a+', 0o600);
  try {
    await flock(handle.fd, 'exnb');
  } catch (error) {
    await handle.close();
    if (error.code === 'EAGAIN' || error.code === 'EACCES')
      throw new Error('another elysium-minute-loop process holds the state lock', { cause: error });
    throw error;
  }
  return async () => {
    try {
      await flock(handle.fd, 'un');
    } finally {
      await handle.close();
    }
  };
}
