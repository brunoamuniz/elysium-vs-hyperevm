import fs from 'node:fs/promises';
import path from 'node:path';

export const SNAPSHOT_URL = 'https://marlsetf2fnnbxpa.public.blob.vercel-storage.com/snapshot.json';
export const WEB_ASSETS = ['compare.js', 'compare.css', 'dashboard.css'];

export function snapshotOrigin(snapshotUrl) {
  const url = new URL(snapshotUrl);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.public.blob.vercel-storage.com'))
    throw new Error('snapshot URL must be a public Vercel Blob https URL');
  return url.origin;
}

export function webHeaders(snapshotUrl) {
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    `connect-src ${snapshotOrigin(snapshotUrl)}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    headers: [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
        ],
      },
    ],
  };
}

export async function renderWeb({ publicDir, snapshotUrl = SNAPSHOT_URL }) {
  snapshotOrigin(snapshotUrl);
  const html = await fs.readFile(path.join(publicDir, 'compare.html'), 'utf8');
  const marker = 'data-snapshot="/api/compare"';
  if (!html.includes(marker)) throw new Error('compare.html is missing the snapshot marker');
  const files = {
    'index.html': html.replace(marker, `data-snapshot="${snapshotUrl}"`),
    'vercel.json': `${JSON.stringify(webHeaders(snapshotUrl), null, 2)}\n`,
  };
  for (const asset of WEB_ASSETS) files[asset] = await fs.readFile(path.join(publicDir, asset), 'utf8');
  return files;
}

export async function writeWeb({ publicDir, outDir, snapshotUrl = SNAPSHOT_URL }) {
  const files = await renderWeb({ publicDir, snapshotUrl });
  await fs.mkdir(outDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(outDir, name), body);
  return Object.keys(files);
}
