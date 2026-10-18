// Serves the published snapshot from Upstash KV. `npm run build:web` copies this file verbatim to
// web/api/snapshot.mjs, so it must import nothing but Node built-ins.
export const SNAPSHOT_KEY = 'snapshot.json.gz.b64';
// The CDN answers repeat polls; the function and KV see at most one read per region per minute.
export const SNAPSHOT_EDGE_SECONDS = 60;

export async function kvCommand({ url, token, command, fetchImpl = fetch }) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error(`KV command failed with status ${response.status}`);
  return payload.result;
}

const unavailable = (status) =>
  new Response('{"error":"snapshot_unavailable"}', {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export async function handleSnapshot({ env, fetchImpl = fetch }) {
  if (!env.KV_REST_API_URL || !env.KV_REST_API_READ_ONLY_TOKEN) return unavailable(503);
  try {
    const stored = await kvCommand({
      url: env.KV_REST_API_URL,
      token: env.KV_REST_API_READ_ONLY_TOKEN,
      command: ['GET', SNAPSHOT_KEY],
      fetchImpl,
    });
    if (typeof stored !== 'string') return unavailable(503);
    return new Response(Buffer.from(stored, 'base64'), {
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'cache-control': `public, max-age=0, s-maxage=${SNAPSHOT_EDGE_SECONDS}, stale-while-revalidate=300`,
      },
    });
  } catch {
    return unavailable(502);
  }
}

export function GET() {
  return handleSnapshot({ env: process.env });
}
