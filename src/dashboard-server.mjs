import fs from 'node:fs/promises';
import http from 'node:http';
import { clients } from './elysium.mjs';
import { collectDashboard, readChain } from './dashboard-data.mjs';
import { collectCompare } from './compare-snapshot.mjs';

export const DASHBOARD_HOST = '127.0.0.1';
export const RPC_CACHE_TTL_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const COMPARE_CACHE_MS = 30_000;
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const COUNT_ABI = [
  { type: 'function', name: 'count', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];
const ASSETS = [
  { route: '/', file: 'compare.html', type: 'text/html; charset=utf-8' },
  { route: '/operator', file: 'dashboard.html', type: 'text/html; charset=utf-8' },
  { route: '/dashboard.css', file: 'dashboard.css', type: 'text/css; charset=utf-8' },
  { route: '/dashboard.js', file: 'dashboard.js', type: 'text/javascript; charset=utf-8' },
  { route: '/compare.css', file: 'compare.css', type: 'text/css; charset=utf-8' },
  { route: '/compare.js', file: 'compare.js', type: 'text/javascript; charset=utf-8' },
];

export function createElysiumReader(config) {
  const { publicClient } = clients(undefined, config);
  return {
    getBlockNumber: () => publicClient.getBlockNumber(),
    getBalance: (address) => publicClient.getBalance({ address }),
    getPulseCount: (address) => publicClient.readContract({ address, abi: COUNT_ABI, functionName: 'count' }),
  };
}

export function createChainCache({ rpc, ttlMs = RPC_CACHE_TTL_MS, now = () => new Date(), reader = readChain }) {
  let cached = null;
  let inflight = null;
  return async ({ walletAddress, contractAddress }) => {
    const key = `${walletAddress ?? ''}|${contractAddress ?? ''}`;
    if (cached && cached.key === key && now().getTime() - cached.at < ttlMs) return cached.value;
    if (inflight && inflight.key === key) return inflight.promise;
    const promise = reader({ rpc, walletAddress, contractAddress })
      .then((value) => {
        cached = { key, at: now().getTime(), value };
        return value;
      })
      .finally(() => {
        if (inflight?.promise === promise) inflight = null;
      });
    inflight = { key, promise };
    return promise;
  };
}

async function loadAssets() {
  const loaded = [];
  for (const asset of ASSETS)
    loaded.push({ ...asset, body: await fs.readFile(new URL(`../public/${asset.file}`, import.meta.url)) });
  return new Map(loaded.map((asset) => [asset.route, asset]));
}

function allowedHost(header, port) {
  if (typeof header !== 'string' || header.length > 100) return false;
  return ['127.0.0.1', `127.0.0.1:${port}`, 'localhost', `localhost:${port}`].includes(header);
}

function send(req, res, status, type, body, extra = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    'content-type': type,
    'content-length': buffer.length,
    'cache-control': 'no-store',
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    ...extra,
  });
  if (req.method === 'HEAD') res.end();
  else res.end(buffer);
}

function sendJson(req, res, status, value, extra) {
  send(req, res, status, 'application/json; charset=utf-8', JSON.stringify(value), extra);
}

export async function createDashboardServer({
  stateDir,
  rpc = null,
  now = () => new Date(),
  port = 0,
  bindHost = DASHBOARD_HOST,
  allowedHosts = null,
  collect = collectDashboard,
  compareSources = null,
  compare = collectCompare,
} = {}) {
  if (typeof stateDir !== 'string' || !stateDir) throw new Error('dashboard requires a state directory');
  if (typeof bindHost !== 'string' || !bindHost) throw new Error('dashboard requires a bind host');
  if (
    allowedHosts !== null &&
    (!Array.isArray(allowedHosts) ||
      allowedHosts.some((host) => typeof host !== 'string' || host.length < 1 || host.length > 100))
  )
    throw new Error('dashboard allowed hosts are invalid');
  const assets = await loadAssets();
  const chainReader = createChainCache({ rpc, now });
  let compareCache = null;
  const compareSnapshot = () => {
    const at = now().getTime();
    if (compareCache && at - compareCache.at < COMPARE_CACHE_MS) return compareCache.promise;
    const promise = compare({ sources: compareSources, now });
    compareCache = { at, promise };
    promise.catch(() => {
      if (compareCache?.promise === promise) compareCache = null;
    });
    return promise;
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return sendJson(req, res, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD' });
      const bound = server.address()?.port;
      if (!(allowedHosts?.includes(req.headers.host) ?? allowedHost(req.headers.host, bound)))
        return sendJson(req, res, 400, { error: 'bad_host' });
      let pathname;
      try {
        pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      } catch {
        return sendJson(req, res, 400, { error: 'bad_request' });
      }
      if (pathname === '/healthz') return sendJson(req, res, 200, { status: 'ok' });
      if (pathname === '/api/dashboard')
        return sendJson(req, res, 200, await collect({ stateDir, rpc, now, chainReader }));
      if (pathname === '/api/compare')
        return compareSources
          ? sendJson(req, res, 200, await compareSnapshot())
          : sendJson(req, res, 404, { error: 'not_found' });
      if (pathname === '/compare') return send(req, res, 301, 'text/plain; charset=utf-8', '', { location: '/' });
      const asset = assets.get(pathname);
      if (asset) return send(req, res, 200, asset.type, asset.body);
      return sendJson(req, res, 404, { error: 'not_found' });
    } catch {
      if (!res.headersSent) sendJson(req, res, 503, { error: 'dashboard_unavailable' });
      else res.end();
    }
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bindHost, resolve);
  });
  const bound = server.address().port;
  return {
    server,
    host: bindHost,
    port: bound,
    url: `http://${bindHost}:${bound}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
