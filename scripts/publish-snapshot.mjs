import path from 'node:path';
import { put } from '@vercel/blob';
import { CHAINS, loadConfig, redact } from '../src/config.mjs';
import { blobUploader, publishOnce, runPublisher } from '../src/publisher.mjs';

try {
  const config = loadConfig();
  const hyperevmStateDir = process.env.ELYSIUM_HYPEREVM_STATE_DIR ?? CHAINS['hyperevm-testnet'].defaultStateDir;
  if (!path.isAbsolute(hyperevmStateDir)) throw new Error('ELYSIUM_HYPEREVM_STATE_DIR must be an absolute path');
  const sources = [
    { chain: 'elysium-testnet', stateDir: config.stateDir },
    { chain: 'hyperevm-testnet', stateDir: hyperevmStateDir },
  ];
  const upload = blobUploader({ put, token: process.env.BLOB_READ_WRITE_TOKEN });
  if (process.argv.includes('--once'))
    console.log(JSON.stringify({ type: 'snapshot_published', ...(await publishOnce({ sources, upload })) }));
  else await runPublisher({ sources, upload });
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
}
