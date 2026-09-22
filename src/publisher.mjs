import { redact } from './config.mjs';
import { collectCompare } from './compare-snapshot.mjs';

export const SNAPSHOT_PATHNAME = 'snapshot.json';
export const PUBLISH_INTERVAL_MS = 60_000;
export const SNAPSHOT_CACHE_SECONDS = 60;

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

export async function publishOnce({ sources, upload, now = () => new Date(), collect = collectCompare }) {
  const snapshot = await collect({ sources, now });
  const body = JSON.stringify(snapshot);
  const result = await upload(SNAPSHOT_PATHNAME, body);
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
  while (!stopping && runs < maxRuns) {
    runs += 1;
    try {
      log({ type: 'snapshot_published', ...(await publishOnce({ sources, upload, collect })) });
    } catch (error) {
      log({ type: 'snapshot_publish_failed', error: redact(error?.name ?? 'Error') });
    }
    if (!stopping && runs < maxRuns) await sleep(intervalMs);
  }
  return { runs };
}
