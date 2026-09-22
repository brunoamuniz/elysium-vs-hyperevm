import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  createChainCache,
  createDashboardServer,
  CSP,
  DASHBOARD_HOST,
  REQUEST_TIMEOUT_MS,
  RPC_CACHE_TTL_MS,
} from '../src/dashboard-server.mjs';

const WALLET = '0x00000000000000000000000000000000000000a1';
const CONTRACT = '0x00000000000000000000000000000000000000b2';
const CANARY = 'SERVER_CANARY_MUST_NOT_LEAK';

function sampleState() {
  return {
    version: 1,
    walletAddress: WALLET,
    deployment: {
      address: CONTRACT,
      runtimeHash: `0x${'11'.repeat(32)}`,
      txHash: `0x${'22'.repeat(32)}`,
      blockNumber: '900',
      blockHash: `0x${'33'.repeat(32)}`,
    },
    actions: [
      {
        id: 'pulse:2026-09-22T11:00Z',
        kind: 'pulse',
        slot: '2026-09-22T11:00Z',
        status: 'finalized',
        nonce: '1',
        to: CONTRACT,
        data: `0xdeadbeef${CANARY}`,
        raw: `0x02f8${CANARY}`,
        expected: { contractAddress: CONTRACT, entropy: `0x${'ef'.repeat(32)}`, countAfter: '1' },
        hash: `0x${'44'.repeat(32)}`,
        createdAt: '2026-09-22T11:00:00.000Z',
        broadcastAt: '2026-09-22T11:00:00.500Z',
        finalizedAt: '2026-09-22T11:00:02.500Z',
        receipt: { blockNumber: '1001', blockHash: `0x${'55'.repeat(32)}` },
        worstCost: '210000000000000',
        undocumented: CANARY,
      },
    ],
    dailySpend: { '2026-09-22': '4200000000000000' },
    privateKey: `0x${'99'.repeat(32)}`,
    keyPath: '/home/user/.config/elysium-minute-loop/wallet.json',
    undocumentedTopLevel: CANARY,
  };
}

async function startServer({ state = sampleState(), halt = false, rpc = null, files = {}, collect } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elysium-dashboard-server-'));
  if (state) await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state));
  if (halt) await fs.writeFile(path.join(dir, 'HALT'), '');
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const dashboard = await createDashboardServer({
    stateDir: dir,
    rpc,
    now: () => new Date('2026-09-22T12:00:00.000Z'),
    collect,
  });
  return {
    ...dashboard,
    dir,
    cleanup: async () => {
      await dashboard.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function rawRequest(port, host) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/api/dashboard', headers: { host } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

function assertHardened(response) {
  assert.equal(response.headers.get('content-security-policy'), CSP);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
}

test('server binds loopback only and serves the fixed route set', async () => {
  const dashboard = await startServer();
  try {
    assert.equal(dashboard.host, DASHBOARD_HOST);
    assert.equal(dashboard.server.address().address, '127.0.0.1');
    assert.equal(dashboard.server.requestTimeout, REQUEST_TIMEOUT_MS);
    assert.equal(dashboard.server.headersTimeout, REQUEST_TIMEOUT_MS);

    const health = await fetch(`${dashboard.url}healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    assertHardened(health);

    const page = await fetch(dashboard.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /<title>Elysium vs HyperEVM<\/title>/, 'the product is the home page');
    assertHardened(page);

    const operator = await fetch(`${dashboard.url}operator`);
    assert.equal(operator.status, 200);
    assert.match(await operator.text(), /Elysium Minute Loop/);
    assertHardened(operator);

    const moved = await fetch(`${dashboard.url}compare`, { redirect: 'manual' });
    assert.equal(moved.status, 301);
    assert.equal(moved.headers.get('location'), '/');

    for (const [asset, type] of [
      ['dashboard.css', /text\/css/],
      ['dashboard.js', /javascript/],
    ]) {
      const response = await fetch(`${dashboard.url}${asset}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), type);
      assertHardened(response);
    }

    const api = await fetch(`${dashboard.url}api/dashboard`);
    assert.equal(api.status, 200);
    assertHardened(api);
  } finally {
    await dashboard.cleanup();
  }
});

test('unknown routes and traversal attempts are 404 and never read a URL-derived path', async () => {
  const dashboard = await startServer();
  try {
    for (const route of [
      'nope',
      'api/',
      'api/dashboard/extra',
      '../src/wallet.mjs',
      '..%2f..%2fetc%2fpasswd',
      'public/dashboard.js',
      '.git/config',
      'state.json',
    ]) {
      const response = await fetch(`${dashboard.url}${route}`);
      assert.equal(response.status, 404, `route ${route} was not rejected`);
      assert.deepEqual(await response.json(), { error: 'not_found' });
      assertHardened(response);
    }
  } finally {
    await dashboard.cleanup();
  }
});

test('non-GET methods are rejected with 405 and no write path exists', async () => {
  const dashboard = await startServer();
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await fetch(`${dashboard.url}api/dashboard`, { method });
      assert.equal(response.status, 405, `${method} was not rejected`);
      assert.equal(response.headers.get('allow'), 'GET, HEAD');
      assertHardened(response);
    }
  } finally {
    await dashboard.cleanup();
  }
});

test('HEAD returns hardened headers without a body', async () => {
  const dashboard = await startServer();
  try {
    const response = await fetch(`${dashboard.url}api/dashboard`, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
    assertHardened(response);
  } finally {
    await dashboard.cleanup();
  }
});

test('unexpected Host headers are rejected with 400', async () => {
  const dashboard = await startServer();
  try {
    for (const host of ['evil.example', `elysium.local:${dashboard.port}`, '127.0.0.1:1']) {
      const response = await rawRequest(dashboard.port, host);
      assert.equal(response.status, 400, `host ${host} was accepted`);
      assert.deepEqual(JSON.parse(response.body), { error: 'bad_host' });
    }
    const allowed = await fetch(`${dashboard.url}api/dashboard`, { headers: { host: `localhost:${dashboard.port}` } });
    assert.equal(allowed.status, 200);
  } finally {
    await dashboard.cleanup();
  }
});

test('api response body carries no secret, raw transaction, calldata or state path', async () => {
  const dashboard = await startServer();
  try {
    const body = await (await fetch(`${dashboard.url}api/dashboard`)).text();
    assert.ok(!body.includes(CANARY));
    for (const forbidden of [
      '"raw"',
      '"data"',
      '"expected"',
      'privateKey',
      'keyPath',
      'wallet.json',
      'entropy',
      '99999',
      dashboard.dir,
      'conduit.xyz',
      'undocumented',
    ]) {
      assert.ok(!body.includes(forbidden), `api exposed ${forbidden}`);
    }
    const payload = JSON.parse(body);
    assert.equal(payload.wallet.address, WALLET);
    assert.equal(payload.contract.address, CONTRACT);
    assert.equal(payload.transactions[0].hash, `0x${'44'.repeat(32)}`);
    assert.equal(payload.transactions[0].latencyMs, 2000);
  } finally {
    await dashboard.cleanup();
  }
});

test('missing state and failing rpc degrade to typed partial availability, not 503', async () => {
  const dashboard = await startServer({
    state: null,
    rpc: {
      getBlockNumber: () => Promise.reject(new Error(`rpc exploded ${CANARY}`)),
      getBalance: () => Promise.resolve(1n),
      getPulseCount: () => Promise.resolve(1n),
    },
  });
  try {
    const response = await fetch(`${dashboard.url}api/dashboard`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(!body.includes(CANARY));
    const payload = JSON.parse(body);
    assert.deepEqual(payload.unavailable, { state: 'missing', rpc: 'unreachable', aggregates: 'missing' });
    assert.equal(payload.service.state, 'unknown');
  } finally {
    await dashboard.cleanup();
  }
});

test('the server never creates state files, a lock file or a state directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elysium-dashboard-empty-'));
  const missing = path.join(dir, 'absent');
  const dashboard = await createDashboardServer({ stateDir: missing });
  try {
    assert.equal((await fetch(`${dashboard.url}api/dashboard`)).status, 200);
    await assert.rejects(() => fs.stat(missing), /ENOENT/);
    assert.deepEqual(await fs.readdir(dir), []);
  } finally {
    await dashboard.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('chain reads are cached for 30 seconds and coalesced into a single in-flight call', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const reader = async () => {
    calls += 1;
    await gate;
    return { balanceWei: '1', blockNumber: '2', pulseCount: '3', unavailable: null };
  };
  let clock = 0;
  const cache = createChainCache({ rpc: {}, reader, now: () => new Date(clock) });

  const inflight = [
    cache({ walletAddress: WALLET, contractAddress: CONTRACT }),
    cache({ walletAddress: WALLET, contractAddress: CONTRACT }),
    cache({ walletAddress: WALLET, contractAddress: CONTRACT }),
  ];
  release();
  const results = await Promise.all(inflight);
  assert.equal(calls, 1);
  assert.deepEqual(results[0], results[2]);

  clock = RPC_CACHE_TTL_MS - 1;
  await cache({ walletAddress: WALLET, contractAddress: CONTRACT });
  assert.equal(calls, 1);

  clock = RPC_CACHE_TTL_MS;
  await cache({ walletAddress: WALLET, contractAddress: CONTRACT });
  assert.equal(calls, 2);

  await cache({ walletAddress: null, contractAddress: null });
  assert.equal(calls, 3);
});

test('a dashboard refresh performs at most three rpc reads through the server cache', async () => {
  const calls = [];
  const rpc = {
    getBlockNumber: () => {
      calls.push('block');
      return Promise.resolve(10n);
    },
    getBalance: () => {
      calls.push('balance');
      return Promise.resolve(20n);
    },
    getPulseCount: () => {
      calls.push('count');
      return Promise.resolve(30n);
    },
  };
  const dashboard = await startServer({ rpc });
  try {
    const payload = await (await fetch(`${dashboard.url}api/dashboard`)).json();
    assert.equal(calls.length, 3);
    assert.equal(payload.wallet.balanceWei, '20');
    assert.equal(payload.onchain.pulseCount, '30');
    assert.equal(payload.onchain.blockNumber, '10');
    await fetch(`${dashboard.url}api/dashboard`);
    assert.equal(calls.length, 3, 'second refresh bypassed the cache');
  } finally {
    await dashboard.cleanup();
  }
});

test('an unexpected server failure returns a typed 503 without error text', async () => {
  const dashboard = await startServer({
    collect: async () => {
      throw new Error(`internal detail ${CANARY}`);
    },
  });
  try {
    const response = await fetch(`${dashboard.url}api/dashboard`);
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.equal(body, '{"error":"dashboard_unavailable"}');
    assert.ok(!body.includes(CANARY));
  } finally {
    await dashboard.cleanup();
  }
});

test('dashboard server source does not import wallet, signing or state mutation helpers', async () => {
  const source = await fs.readFile(new URL('../src/dashboard-server.mjs', import.meta.url), 'utf8');
  for (const forbidden of [
    'wallet.mjs',
    'run-once.mjs',
    'KEY_PATH',
    'KEY_ROOT',
    'loadWallet',
    'acquireLock',
    'saveState',
    'ensureStateDir',
    'loadState',
    '0.0.0.0',
    '::',
  ]) {
    assert.ok(!source.includes(forbidden), `dashboard-server.mjs references ${forbidden}`);
  }
  assert.ok(source.includes("'127.0.0.1'"));
});
