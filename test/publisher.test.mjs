import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { blobUploader, publishOnce, runPublisher, SNAPSHOT_PATHNAME } from '../src/publisher.mjs';
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

test('the committed web/ build matches public/ and reads only the Blob snapshot', async () => {
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
  assert.ok(
    csp.includes(`connect-src ${new URL(SNAPSHOT_URL).origin};`),
    'the page may connect only to the Blob store',
  );
  assert.match(csp, /frame-ancestors 'none'/);
});

test('the snapshot origin must be a public Vercel Blob https host', () => {
  assert.equal(snapshotOrigin(SNAPSHOT_URL), 'https://marlsetf2fnnbxpa.public.blob.vercel-storage.com');
  assert.throws(() => snapshotOrigin('http://marlsetf2fnnbxpa.public.blob.vercel-storage.com/snapshot.json'));
  assert.throws(() => snapshotOrigin('https://evil.example/snapshot.json'));
  assert.throws(() => webHeaders('https://evil.example/x'));
});

test('writeWeb writes every file the Vercel root directory needs', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'elysium-web-'));
  const written = await writeWeb({ publicDir: new URL('../public', import.meta.url).pathname, outDir: out });
  assert.deepEqual(written.sort(), ['compare.css', 'compare.js', 'dashboard.css', 'index.html', 'vercel.json']);
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
