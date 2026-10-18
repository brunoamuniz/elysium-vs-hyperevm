import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BLOB_MONTHLY_ADVANCED_OPERATIONS,
  blobUploader,
  kvUploader,
  errorLabel,
  publishOnce,
  PUBLISH_INTERVAL_MS,
  runPublisher,
  SNAPSHOT_PATHNAME,
} from '../src/publisher.mjs';
import { gunzipSync } from 'node:zlib';
import { handleSnapshot, SNAPSHOT_KEY } from '../src/snapshot-function.mjs';
import { renderWeb, snapshotOrigin, SNAPSHOT_URL, webHeaders, writeWeb } from '../src/web-build.mjs';

const root = (file) => new URL(`../${file}`, import.meta.url);
const read = (file) => fs.readFile(root(file), 'utf8');

test('the uploader overwrites one public snapshot with a cache the CDN accepts, and refuses a malformed token', async () => {
  const calls = [];
  const upload = blobUploader({
    put: async (...args) => {
      calls.push(args);
      return { url: 'https://x.public.blob.vercel-storage.com/snapshot.json' };
    },
    token: 'vercel_blob_rw_example',
  });
  await upload(SNAPSHOT_PATHNAME, '{}');
  const [pathname, body, options] = calls[0];
  assert.equal(pathname, 'snapshot.json');
  assert.equal(body, '{}');
  assert.deepEqual(
    { ...options, token: '[t]' },
    {
      access: 'public',
      allowOverwrite: true,
      addRandomSuffix: false,
      cacheControlMaxAge: 60,
      contentType: 'application/json',
      token: '[t]',
    },
  );
  assert.ok(options.cacheControlMaxAge >= 60, 'Vercel Blob rejects a cache shorter than 60 s');
  assert.throws(() => blobUploader({ put: async () => {}, token: undefined }), /missing or malformed/);
  assert.throws(() => blobUploader({ put: async () => {}, token: 'not-a-blob-token' }), /missing or malformed/);
});

test('publishOnce uploads exactly the sanitized compare snapshot', async () => {
  const uploads = [];
  const snapshot = { schemaVersion: 1, generatedAt: '2026-09-22T20:00:00.000Z', chains: [] };
  const result = await publishOnce({
    sources: [],
    collect: async () => snapshot,
    upload: async (pathname, body) => {
      uploads.push({ pathname, body });
      return { url: 'https://x.public.blob.vercel-storage.com/snapshot.json' };
    },
  });
  assert.deepEqual(uploads, [{ pathname: 'snapshot.json', body: JSON.stringify(snapshot) }]);
  assert.equal(result.bytes, JSON.stringify(snapshot).length);
  assert.equal(result.generatedAt, snapshot.generatedAt);
});

test('a failed upload is logged without provider text and the publisher keeps going', async () => {
  const logs = [];
  let attempts = 0;
  const upload = async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error('token vercel_blob_rw_secret rejected at https://blob.vercel-storage.com');
      error.name = 'BlobAccessError';
      throw error;
    }
    return { url: 'u' };
  };
  const result = await runPublisher({
    sources: [],
    upload,
    collect: async () => ({ generatedAt: 'g' }),
    sleep: async () => {},
    log: (entry) => logs.push(entry),
    signal: {},
    maxRuns: 2,
  });
  assert.equal(result.runs, 2);
  assert.deepEqual(
    logs.map((entry) => entry.type),
    ['snapshot_publish_failed', 'snapshot_published'],
  );
  assert.ok(!JSON.stringify(logs).includes('vercel_blob_rw_'), 'the token never reaches the log');
  assert.equal(logs[0].error, 'BlobAccessError');
});

test('an unchanged snapshot is not uploaded again, so idle loops cost no Blob operations', async () => {
  const logs = [];
  let uploads = 0;
  let tick = 0;
  const bodies = [{ a: 1 }, { a: 1 }, { a: 2 }];
  await runPublisher({
    sources: [],
    upload: async () => {
      uploads += 1;
      return { url: 'u' };
    },
    collect: async () => ({ ...bodies[tick], generatedAt: `g${tick++}` }),
    sleep: async () => {},
    log: (entry) => logs.push(entry),
    signal: {},
    maxRuns: 3,
  });
  assert.equal(uploads, 2);
  assert.deepEqual(
    logs.map((entry) => entry.type),
    ['snapshot_published', 'snapshot_unchanged', 'snapshot_published'],
  );
  const putsPerMonth = Math.ceil((31 * 24 * 3600 * 1000) / PUBLISH_INTERVAL_MS);
  assert.ok(putsPerMonth <= BLOB_MONTHLY_ADVANCED_OPERATIONS * 0.75, 'uploads stay well inside the Hobby Blob quota');
});

test('a failed upload whose SDK error keeps the generic name is labelled by its class', () => {
  class BlobStoreSuspendedError extends Error {}
  assert.equal(
    errorLabel(new BlobStoreSuspendedError('Vercel Blob: This store has been suspended.')),
    'BlobStoreSuspendedError',
  );
  assert.equal(errorLabel(undefined), 'Error');
});

test('the KV uploader stores the gzipped snapshot and the site function serves it back with an edge cache', async () => {
  const store = new Map();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    const [command, key, value] = JSON.parse(init.body);
    const result = command === 'SET' ? (store.set(key, value), 'OK') : (store.get(key) ?? null);
    return new Response(JSON.stringify({ result }), { status: 200 });
  };
  const upload = kvUploader({ url: 'https://kv.example.upstash.io', token: 'rw-token-0123456789abcdef', fetchImpl });
  const body = JSON.stringify({ schemaVersion: 1, generatedAt: 'g' });
  assert.deepEqual(await upload(SNAPSHOT_PATHNAME, body), { url: `kv:${SNAPSHOT_KEY}` });
  assert.equal(gunzipSync(Buffer.from(store.get(SNAPSHOT_KEY), 'base64')).toString(), body);

  const env = { KV_REST_API_URL: 'https://kv.example.upstash.io', KV_REST_API_READ_ONLY_TOKEN: 'ro-token' };
  const response = await handleSnapshot({ env, fetchImpl });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.match(response.headers.get('cache-control'), /s-maxage=60/);
  assert.equal(gunzipSync(Buffer.from(await response.arrayBuffer())).toString(), body);
  assert.equal(calls.at(-1).auth, 'Bearer ro-token', 'the site reads with the read-only token');

  assert.throws(() => kvUploader({ url: 'http://kv', token: 'rw-token-0123456789abcdef' }), /KV_REST_API_URL/);
  assert.throws(() => kvUploader({ url: 'https://kv', token: undefined }), /KV_REST_API_TOKEN/);
});

test('the site function answers 503/502 without caching when the snapshot is missing or KV fails', async () => {
  const env = { KV_REST_API_URL: 'https://kv.example.upstash.io', KV_REST_API_READ_ONLY_TOKEN: 'ro-token' };
  const missing = await handleSnapshot({ env, fetchImpl: async () => new Response('{"result":null}') });
  assert.equal(missing.status, 503);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  const failed = await handleSnapshot({ env, fetchImpl: async () => new Response('{"error":"x"}', { status: 401 }) });
  assert.equal(failed.status, 502);
  assert.equal((await handleSnapshot({ env: {} })).status, 503);
});

test('the committed web/ build matches public/ and reads only the same-origin snapshot', async () => {
  const files = await renderWeb({ publicDir: new URL('../public', import.meta.url).pathname });
  for (const [name, body] of Object.entries(files))
    assert.equal(await read(`web/${name}`), body, `web/${name} is stale; run npm run build:web`);
  assert.match(files['index.html'], new RegExp(`data-snapshot="${SNAPSHOT_URL.replaceAll('.', '\\.')}"`));
  assert.ok(!files['index.html'].includes('/api/'), 'the static site never calls the operator server');
  assert.ok(!files['index.html'].includes('/operator'));
  const csp = JSON.parse(files['vercel.json']).headers[0].headers.find(
    (header) => header.key === 'Content-Security-Policy',
  ).value;
  assert.match(csp, /default-src 'none'/);
  assert.ok(csp.includes("connect-src 'self';"), 'the page may connect only to its own origin');
  assert.deepEqual(JSON.parse(files['vercel.json']).rewrites, [
    { source: '/snapshot.json', destination: '/api/snapshot' },
  ]);
  assert.equal(files['api/snapshot.mjs'], await read('src/snapshot-function.mjs'));
  assert.match(csp, /frame-ancestors 'none'/);
});

test('the snapshot source must be a same-origin path or a public Vercel Blob https host', () => {
  assert.equal(snapshotOrigin(SNAPSHOT_URL), "'self'");
  assert.equal(
    snapshotOrigin('https://marlsetf2fnnbxpa.public.blob.vercel-storage.com/snapshot.json'),
    'https://marlsetf2fnnbxpa.public.blob.vercel-storage.com',
  );
  assert.throws(() => snapshotOrigin('//evil.example/snapshot.json'));
  assert.throws(() => snapshotOrigin('http://marlsetf2fnnbxpa.public.blob.vercel-storage.com/snapshot.json'));
  assert.throws(() => snapshotOrigin('https://evil.example/snapshot.json'));
  assert.throws(() => webHeaders('https://evil.example/x'));
});

test('writeWeb writes every file the Vercel root directory needs', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'elysium-web-'));
  const written = await writeWeb({ publicDir: new URL('../public', import.meta.url).pathname, outDir: out });
  assert.deepEqual(written.sort(), [
    'api/snapshot.mjs',
    'compare.css',
    'compare.js',
    'dashboard.css',
    'index.html',
    'vercel.json',
  ]);
  await fs.rm(out, { recursive: true });
});

test('the publisher container is isolated: no ports, read-only journals, no wallet, token only from an env file', async () => {
  const compose = await read('compose.publish.yaml');
  assert.ok(!compose.includes('ports:'));
  assert.ok(!compose.includes('.config/elysium-minute-loop:'), 'the publisher never mounts the wallet directory');
  assert.match(compose, /env_file:\n\s+- \$\{HOME\}\/\.config\/elysium-vs-hyperevm-publisher\/blob\.env\n/);
  assert.ok(!/vercel_blob_rw_|BLOB_READ_WRITE_TOKEN:/.test(compose), 'the token is never written into compose');
  const mounts = [...compose.matchAll(/^\s+- (\$\{HOME\}\/\.local\/state\/[^\n]+)$/gm)].map((match) => match[1]);
  assert.equal(mounts.length, 2);
  assert.ok(
    mounts.every((mount) => mount.endsWith(':ro')),
    'journals are mounted read-only',
  );
});
