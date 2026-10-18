import { redact } from './config.mjs';
import { gzipSync } from 'node:zlib';
import { collectCompare } from './compare-snapshot.mjs';
import { kvCommand, SNAPSHOT_KEY } from './snapshot-function.mjs';

export const SNAPSHOT_PATHNAME = 'snapshot.json';
// Every put is a Blob advanced operation. The Hobby plan includes 2,000 a month and suspends the store past
// that; one put per 30 min is at most 1,488 in a 31-day month, leaving room for dashboard browsing.
export const BLOB_MONTHLY_ADVANCED_OPERATIONS = 2_000;
export const PUBLISH_INTERVAL_MS = 1_800_000;
export const SNAPSHOT_CACHE_SECONDS = 60;
// Upstash's free plan includes 500,000 commands a month; a SET every 5 min is under 9,000.
export const KV_PUBLISH_INTERVAL_MS = 300_000;

export function blobUploader({ put, token }) {
  if (typeof token !== 'string' || !token.startsWith('vercel_blob_rw_'))
    throw new Error('BLOB_READ_WRITE_TOKEN is missing or malformed');
  return (pathname, body) =>
    put(pathname, body, {
      access: 'public',
      allowOverwrite: true,
      addRandomSuffix: false,
      cacheControlMaxAge: SNAPSHOT_CACHE_SECONDS,
      contentType: 'application/json',
      token,
    });
}

export function kvUploader({ url, token, fetchImpl }) {
  if (typeof url !== 'string' || !url.startsWith('https://'))
    throw new Error('KV_REST_API_URL is missing or malformed');
  if (typeof token !== 'string' || token.length < 20) throw new Error('KV_REST_API_TOKEN is missing or malformed');
  return async (_pathname, body) => {
    await kvCommand({ url, token, command: ['SET', SNAPSHOT_KEY, gzipSync(body).toString('base64')], fetchImpl });
    return { url: `kv:${SNAPSHOT_KEY}` };
  };
}

// The SDK's errors keep name 'Error'; their class (BlobStoreSuspendedError, ...) is the useful, secret-free part.
export function errorLabel(error) {
  if (error?.name && error.name !== 'Error') return error.name;
  return error?.constructor?.name ?? 'Error';
}

export async function publishOnce({ sources, upload, now = () => new Date(), collect = collectCompare, state = {} }) {
  const snapshot = await collect({ sources, now });
  const body = JSON.stringify(snapshot);
  const content = JSON.stringify({ ...snapshot, generatedAt: null });
  if (content === state.lastContent) return { skipped: true, generatedAt: snapshot.generatedAt };
  const result = await upload(SNAPSHOT_PATHNAME, body);
  state.lastContent = content;
  return { url: result?.url ?? null, bytes: Buffer.byteLength(body), generatedAt: snapshot.generatedAt };
}

export async function runPublisher({
  sources,
  upload,
  intervalMs = PUBLISH_INTERVAL_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = (entry) => console.log(JSON.stringify(entry)),
  signal = process,
  maxRuns = Infinity,
  collect = collectCompare,
}) {
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  signal.once?.('SIGINT', stop);
  signal.once?.('SIGTERM', stop);
  let runs = 0;
  const state = {};
  while (!stopping && runs < maxRuns) {
    runs += 1;
    try {
      const result = await publishOnce({ sources, upload, collect, state });
      log({ type: result.skipped ? 'snapshot_unchanged' : 'snapshot_published', ...result });
    } catch (error) {
      log({ type: 'snapshot_publish_failed', error: redact(errorLabel(error)) });
    }
    if (!stopping && runs < maxRuns) await sleep(intervalMs);
  }
  return { runs };
}
