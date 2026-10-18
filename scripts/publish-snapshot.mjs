import path from 'node:path';
import { put } from '@vercel/blob';
import { CHAINS, loadConfig, redact } from '../src/config.mjs';
import { blobUploader, KV_PUBLISH_INTERVAL_MS, kvUploader, publishOnce, runPublisher } from '../src/publisher.mjs';

try {
  const config = loadConfig();
  const hyperevmStateDir = process.env.ELYSIUM_HYPEREVM_STATE_DIR ?? CHAINS['hyperevm-testnet'].defaultStateDir;
  if (!path.isAbsolute(hyperevmStateDir)) throw new Error('ELYSIUM_HYPEREVM_STATE_DIR must be an absolute path');
  const sources = [
    { chain: 'elysium-testnet', stateDir: config.stateDir },
    { chain: 'hyperevm-testnet', stateDir: hyperevmStateDir },
  ];
  const kv = Boolean(process.env.KV_REST_API_URL);
  const upload = kv
    ? kvUploader({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN })
    : blobUploader({ put, token: process.env.BLOB_READ_WRITE_TOKEN });
  if (process.argv.includes('--once'))
    console.log(JSON.stringify({ type: 'snapshot_published', ...(await publishOnce({ sources, upload })) }));
  else await runPublisher({ sources, upload, ...(kv ? { intervalMs: KV_PUBLISH_INTERVAL_MS } : {}) });
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
}
