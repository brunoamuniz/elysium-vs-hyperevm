import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CHAINS } from '../src/config.mjs';
import { saveState, emptyState, compactState } from '../src/state.mjs';
import {
  bootstrapMedianDifference,
  bootstrapMedianDifferenceAsync,
  buildCompareSnapshot,
  collectCompare,
  chainInclusionMs,
  MIN_COMPARISON_SAMPLES,
  readCompareSource,
} from '../src/compare-snapshot.mjs';
import { createDashboardServer } from '../src/dashboard-server.mjs';

const WALLET = '0x00000000000000000000000000000000000B0b01';
const CONTRACT = '0xC23D6d3E3225dAF415A7756B7259D65eCF478d24';
const NOW = new Date('2026-09-23T20:00:00.000Z');
const BASE = Date.parse('2026-09-22T19:00:00.000Z');

function action(
  index,
  { chainOffsetMs = 150, start = BASE, version = 4, quality = 'primary', status = 'finalized', nitro = true } = {},
) {
  const submit = start + index * 6000;
  const blockSeconds = Math.floor((submit + chainOffsetMs) / 1000);
  return {
    id: `pulse:${new Date(submit).toISOString().slice(0, 16)}Z:${index % 10}:${index}`,
    kind: 'pulse',
    profile: 'benchmark-10',
    status,
    nonce: String(index),
    hash: `0x${index.toString(16).padStart(64, 'a')}`,
    raw: `0x02${'ee'.repeat(40)}${WALLET.slice(2)}`,
    data: `0xdeadbeef${WALLET.slice(2)}`,
    expected: {
      contractAddress: CONTRACT,
      entropy: `0x${'ab'.repeat(32)}`,
      countAfter: String(index + 1),
      caller: WALLET,
    },
    receipt: { blockNumber: String(1000 + index), blockHash: `0x${'cc'.repeat(32)}` },
    cost: nitro
      ? {
          worstCostWei: '400000000000000',
          reservedDay: '2026-09-22',
          actualCostWei: '520140000000',
          gasUsed: '52014',
          effectiveGasPriceWei: '10000000',
          gasUsedForL1: '23165',
          executionGas: '28849',
          breakdown: 'nitro',
          blockBaseFeeWei: '10000000',
        }
      : {
          worstCostWei: '400000000000000',
          reservedDay: '2026-09-22',
          actualCostWei: '2884900000000',
          gasUsed: '28849',
          effectiveGasPriceWei: '100000000',
          gasUsedForL1: null,
          executionGas: '28849',
          breakdown: 'none',
          blockBaseFeeWei: '100000000',
        },
    timing: {
      clockOffsetMs: 0,
      measurementVersion: version,
      quality,
      recovered: quality !== 'primary',
      submitStartedAt: new Date(submit).toISOString(),
      rpcAcceptedAt: new Date(submit + 470).toISOString(),
      includedObservedAt: new Date(submit + 900).toISOString(),
      includedObservedBy: 'block_watch',
      includedObservedRttMs: 320,
      blockTimestamp: String(blockSeconds),
      confirmedObservedAt: new Date(submit + 9000).toISOString(),
    },
  };
}

function source(chainId, actions, extra = {}) {
  return {
    chain: CHAINS[chainId],
    halted: false,
    archived: [],
    state: {
      ...emptyState(WALLET, CHAINS[chainId].chainId),
      walletAddress: WALLET,
      dailySpend: { '2026-09-22': '999' },
      hold: null,
      holdHistory: [{ type: 'stuck_nonce', reason: `operator note ${WALLET}`, clearedAt: '2026-09-22T00:00:00Z' }],
      deployment: { address: CONTRACT, txHash: `0x${'22'.repeat(32)}`, blockNumber: '900' },
      actions,
      ...extra,
    },
  };
}

function walk(value, visit, pathParts = []) {
  visit(pathParts, value);
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, visit, [...pathParts, index]));
  else if (value && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) walk(child, visit, [...pathParts, key]);
}

test('the public snapshot never carries the wallet in any casing, prefix or topic form, nor journal internals', () => {
  const snapshot = buildCompareSnapshot({
    sources: [
      source(
        'elysium-testnet',
        Array.from({ length: 30 }, (_, i) => action(i)),
      ),
      source(
        'hyperevm-testnet',
        Array.from({ length: 30 }, (_, i) => action(i, { chainOffsetMs: 1600 })),
      ),
    ],
    now: NOW,
  });
  const text = JSON.stringify(snapshot).toLowerCase();
  const bare = WALLET.slice(2).toLowerCase();
  assert.ok(!text.includes(bare), 'wallet without 0x');
  assert.ok(!text.includes(bare.padStart(64, '0')), 'wallet as a 32-byte topic');
  for (const leaked of [
    'operator note',
    'dailyspend',
    'worstcostwei',
    'nonce',
    'entropy',
    'deadbeef',
    'reserved',
    'holdhistory',
    '"raw"',
    '"data"',
    '"expected"',
  ])
    assert.ok(!text.includes(leaked), `snapshot leaks ${leaked}`);
});

test('every key path in the snapshot belongs to the documented schema', () => {
  const snapshot = buildCompareSnapshot({
    sources: [
      source(
        'elysium-testnet',
        Array.from({ length: 5 }, (_, i) => action(i)),
      ),
      source(
        'hyperevm-testnet',
        Array.from({ length: 5 }, (_, i) => action(i)),
      ),
    ],
    now: NOW,
  });
  const allowed = new Set([
    'schemaVersion',
    'generatedAt',
    'measurementVersion',
    'load',
    'load.profile',
    'load.txPerMinutePerChain',
    'load.contract',
    'load.watchIntervalMs',
    'load.pollIntervalMs',
    'window',
    'window.start',
    'window.end',
    'window.hours',
    'window.announceAfterHours',
    'window.minSamplesPerChain',
    'comparison',
    'comparison.metric',
    'comparison.ready',
    'comparison.announceable',
    'comparison.pair',
    'comparison.pair.*',
    'comparison.diffP50Ms',
    'comparison.ci95Ms',
    'comparison.ci95Ms.*',
    'comparison.resamples',
    'comparison.seed',
    'comparison.samplesUsed',
    'comparison.samplesUsed.*',
    'chains',
    'chains.*',
    'chains.*.id',
    'chains.*.name',
    'chains.*.chainId',
    'chains.*.layer',
    'chains.*.stack',
    'chains.*.settlesTo',
    'chains.*.status',
    'chains.*.firstSampleAt',
    'chains.*.contract',
    'chains.*.contract.address',
    'chains.*.contract.explorerUrl',
    'chains.*.contract.deployTxHash',
    'chains.*.contract.deployTxUrl',
    'chains.*.counts',
    ...['sent', 'included', 'reverted', 'pending', 'primary', 'excluded'].map((key) => `chains.*.counts.${key}`),
    'chains.*.successRate',
    'chains.*.watchedShare',
    'chains.*.metrics',
    ...[
      'chainInclusion',
      'rpcAccept',
      'observedInclusion',
      'watchRtt',
      'inclusionToTwoConf',
      'clockCorrection',
    ].flatMap((metric) => [
      `chains.*.metrics.${metric}`,
      ...['count', 'p50Ms', 'p95Ms', 'minMs', 'maxMs', 'meanMs'].map((key) => `chains.*.metrics.${metric}.${key}`),
    ]),
    'chains.*.gas',
    'chains.*.gas.settled',
    'chains.*.gas.breakdownCoverage',
    'chains.*.gas.feePer1000TxWei',
    'chains.*.gas.postingShare',
    ...[
      'feeWei.p50',
      'feeWei.p95',
      'feeWei.mean',
      'feeWei.total',
      'gasUsed.p50',
      'gasUsed.mean',
      'executionGas.p50',
      'executionGas.mean',
      'postingGas.p50',
      'postingGas.mean',
      'gasPriceWei.p50',
      'gasPriceWei.min',
      'gasPriceWei.max',
      'feeWei',
      'gasUsed',
      'executionGas',
      'postingGas',
      'gasPriceWei',
    ].map((key) => `chains.*.gas.${key}`),
    'chains.*.gas.hourly',
    'chains.*.gas.hourly.*',
    ...['hour', 'count', 'feeP50Wei', 'gasPriceP50Wei'].map((key) => `chains.*.gas.hourly.*.${key}`),
    'chains.*.gas.series',
    'chains.*.gas.series.*',
    'chains.*.gas.series.*.at',
    'chains.*.gas.series.*.feeWei',
    'comparison.feeRatio',
    'comparison.executionGasDelta',
    'chains.*.histogram',
    'chains.*.histogram.bucketMs',
    'chains.*.histogram.overflowCount',
    'chains.*.histogram.buckets',
    'chains.*.histogram.buckets.*',
    'chains.*.histogram.buckets.*.fromMs',
    'chains.*.histogram.buckets.*.toMs',
    'chains.*.histogram.buckets.*.count',
    'chains.*.hourly',
    'chains.*.hourly.*',
    ...['hour', 'count', 'chainInclusionP50Ms', 'rpcAcceptP50Ms', 'observedInclusionP50Ms'].map(
      (key) => `chains.*.hourly.*.${key}`,
    ),
    'chains.*.series',
    'chains.*.series.*',
    'chains.*.series.*.at',
    'chains.*.series.*.chainInclusionMs',
    'chains.*.series.*.observedInclusionMs',
    'chains.*.recent',
    'chains.*.recent.*',
    ...[
      'hash',
      'explorerUrl',
      'status',
      'blockNumber',
      'submittedAt',
      'chainInclusionMs',
      'rpcAcceptMs',
      'observedInclusionMs',
    ].map((key) => `chains.*.recent.*.${key}`),
  ]);
  walk(snapshot, (parts) => {
    if (!parts.length) return;
    const key = parts.map((part) => (typeof part === 'number' ? '*' : part)).join('.');
    assert.ok(allowed.has(key), `unexpected snapshot path ${key}`);
  });
});

test('only v2 primary samples from the shared window count, and explorer links point at each chain', () => {
  const elysium = [
    ...Array.from({ length: 10 }, (_, i) => action(i, { version: 3 })),
    ...Array.from({ length: 10 }, (_, i) => action(i + 100)),
    action(500, { quality: 'recovered' }),
  ];
  const hyper = Array.from({ length: 10 }, (_, i) => action(i + 105, { chainOffsetMs: 1600 }));
  const snapshot = buildCompareSnapshot({
    sources: [source('elysium-testnet', elysium), source('hyperevm-testnet', hyper)],
    now: NOW,
  });
  assert.equal(
    snapshot.window.start,
    new Date(BASE + 105 * 6000).toISOString(),
    'the window starts when the later chain started',
  );
  const [e, h] = snapshot.chains;
  assert.equal(e.counts.primary, 5, 'older measurement versions and samples before the shared window are ignored');
  assert.equal(e.counts.excluded, 1, 'recovered samples are counted but excluded');
  assert.equal(h.counts.primary, 10);
  assert.ok(e.recent[0].explorerUrl.startsWith('https://elysium.kinetiq.xyz/testnet-explorer/transaction/0x'));
  assert.ok(h.recent[0].explorerUrl.startsWith('https://app.hyperliquid-testnet.xyz/explorer/tx/0x'));
  assert.equal(e.layer, 'L2');
  assert.equal(e.settlesTo, 'HyperEVM testnet');
});

test('no comparison is published below the sample floor, and a ready one carries a reproducible interval', () => {
  const few = buildCompareSnapshot({
    sources: [
      source(
        'elysium-testnet',
        Array.from({ length: 50 }, (_, i) => action(i)),
      ),
      source(
        'hyperevm-testnet',
        Array.from({ length: 50 }, (_, i) => action(i, { chainOffsetMs: 1600 })),
      ),
    ],
    now: NOW,
  });
  assert.equal(few.comparison.ready, false);
  assert.equal(few.comparison.diffP50Ms, null);
  const n = MIN_COMPARISON_SAMPLES + 20;
  const ready = buildCompareSnapshot({
    sources: [
      source(
        'elysium-testnet',
        Array.from({ length: n }, (_, i) => action(i, { chainOffsetMs: 100 + (i % 7) * 60 })),
      ),
      source(
        'hyperevm-testnet',
        Array.from({ length: n }, (_, i) => action(i, { chainOffsetMs: 1300 + (i % 5) * 150 })),
      ),
    ],
    now: NOW,
  });
  assert.equal(ready.comparison.ready, true);
  assert.equal(ready.comparison.announceable, true, 'the window is longer than 24 h');
  assert.ok(ready.comparison.diffP50Ms < 0);
  const [lo, hi] = ready.comparison.ci95Ms;
  assert.ok(lo <= ready.comparison.diffP50Ms && ready.comparison.diffP50Ms <= hi);
  assert.deepEqual(
    bootstrapMedianDifference([1, 2, 3, 4, 5], [5, 6, 7, 8, 9]),
    bootstrapMedianDifference([1, 2, 3, 4, 5], [5, 6, 7, 8, 9]),
    'a fixed seed reproduces the interval',
  );
});

test('chain-side inclusion places each block at the middle of its whole second and rejects blocks from earlier seconds', () => {
  assert.equal(
    chainInclusionMs({
      clockOffsetMs: 0,
      submitStartedAt: '2026-09-22T19:00:03.228Z',
      blockTimestamp: String(Date.parse('2026-09-22T19:00:03Z') / 1000),
    }),
    272,
  );
  assert.equal(
    chainInclusionMs({
      clockOffsetMs: 0,
      submitStartedAt: '2026-09-22T19:00:03.228Z',
      blockTimestamp: String(Date.parse('2026-09-22T19:00:05Z') / 1000),
    }),
    2272,
  );
  assert.equal(
    chainInclusionMs({
      clockOffsetMs: 0,
      submitStartedAt: '2026-09-22T19:00:03.228Z',
      blockTimestamp: String(Date.parse('2026-09-22T19:00:01Z') / 1000),
    }),
    null,
  );
});

test('a hold shows the chain as paused and silence shows it as stale', () => {
  const recent = [action(0, { start: NOW.getTime() - 30_000 })];
  const running = buildCompareSnapshot({
    sources: [
      source('elysium-testnet', recent),
      source('hyperevm-testnet', recent, { hold: { type: 'stuck_nonce', nonce: '3', reason: 'x' } }),
    ],
    now: NOW,
  });
  assert.equal(running.chains[0].status, 'running');
  assert.equal(running.chains[1].status, 'paused');
  const old = buildCompareSnapshot({
    sources: [source('elysium-testnet', [action(0)]), source('hyperevm-testnet', [action(0)])],
    now: NOW,
  });
  assert.equal(old.chains[0].status, 'stale');
});

test('readCompareSource reads archives, and refuses a journal from another chain or an unstamped non-Elysium journal', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elysium-compare-'));
  await fs.chmod(dir, 0o700);
  const state = {
    ...emptyState(WALLET, 998),
    deployment: { address: CONTRACT },
    actions: Array.from({ length: 12 }, (_, i) => action(i, { start: NOW.getTime() - 3_600_000 })),
  };
  await saveState(dir, state);
  await compactState(dir, state, 5);
  const read = await readCompareSource('hyperevm-testnet', dir, NOW);
  assert.equal(read.archived.length, 7, 'finalized actions rotated to NDJSON are read back');
  assert.equal(read.state.actions.length, 5);
  assert.equal(
    (await readCompareSource('elysium-testnet', dir, NOW)).state,
    null,
    'a HyperEVM journal is never shown as Elysium',
  );
  const unstamped = { ...state, chainId: null };
  await saveState(dir, unstamped);
  assert.equal((await readCompareSource('hyperevm-testnet', dir, NOW)).state, null);
  assert.notEqual(
    (await readCompareSource('elysium-testnet', dir, NOW)).state,
    null,
    'the legacy Elysium journal may be unstamped',
  );
  await fs.rm(dir, { recursive: true });
});

test('the dashboard server serves the compare page and a cached snapshot, and 404s when unconfigured', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elysium-compare-srv-'));
  let calls = 0;
  const compare = async () => {
    calls += 1;
    return { schemaVersion: 1 };
  };
  const server = await createDashboardServer({
    stateDir: dir,
    compareSources: [{ chain: 'elysium-testnet', stateDir: dir }],
    compare,
  });
  const get = (route) =>
    fetch(`${server.url.replace(/\/$/, '')}${route}`, { headers: { host: `127.0.0.1:${server.port}` } });
  assert.equal((await get('/')).status, 200);
  assert.equal((await get('/compare.js')).status, 200);
  assert.equal((await get('/compare.css')).status, 200);
  assert.deepEqual(await (await get('/api/compare')).json(), { schemaVersion: 1 });
  await get('/api/compare');
  assert.equal(calls, 1, 'the snapshot is cached between requests');
  await server.close();
  const bare = await createDashboardServer({ stateDir: dir });
  assert.equal((await fetch(`${bare.url}api/compare`, { headers: { host: `127.0.0.1:${bare.port}` } })).status, 404);
  await bare.close();
  await fs.rm(dir, { recursive: true });
});

test('the compare page stays static, read-only and CSP-safe, and links only to the two explorers', async () => {
  const read = (file) => fs.readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
  const [html, js, css] = await Promise.all([read('compare.html'), read('compare.js'), read('compare.css')]);
  assert.ok(!/\sstyle=|\son[a-z]+=/i.test(html), 'no inline styles or handlers');
  assert.ok(!/<(form|button|input)\b/i.test(html));
  assert.ok(!/setAttribute\(\s*['"](style|on[a-z]+)['"]/i.test(js));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/.test(js), 'no HTML injection sinks');
  assert.ok(!/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(js));
  assert.ok(!/privateKey|keyPath|\braw\b|calldata|walletAddress/i.test(js));
  assert.match(js, /rel = 'noopener noreferrer'/);
  assert.match(js, /EXPLORER_HOSTS = \['elysium\.kinetiq\.xyz', 'app\.hyperliquid-testnet\.xyz'\]/);
  assert.ok(!/url\(|@import|@font-face/i.test(css));
  assert.match(html, /href="dashboard\.css"/, 'asset paths are relative so the page can be hosted statically');
});

test('the server path computes the same interval in chunks without blocking the event loop', async () => {
  const a = Array.from({ length: 3000 }, (_, i) => (i * 37) % 900);
  const b = Array.from({ length: 3000 }, (_, i) => 1200 + ((i * 53) % 1100));
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 1);
  const chunked = await bootstrapMedianDifferenceAsync(a, b);
  clearInterval(timer);
  assert.deepEqual(chunked, bootstrapMedianDifference(a, b), 'chunking does not change the result');
  assert.ok(ticks > 0, 'timers ran while the bootstrap was in progress');
});

test('collectCompare fills the deferred interval and leaves no hidden fields behind', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elysium-collect-'));
  const dirs = { 'elysium-testnet': path.join(root, 'e'), 'hyperevm-testnet': path.join(root, 'h') };
  const n = MIN_COMPARISON_SAMPLES + 5;
  for (const [chainId, dir] of Object.entries(dirs)) {
    await fs.mkdir(dir, { mode: 0o700 });
    await saveState(dir, {
      ...emptyState(WALLET, CHAINS[chainId].chainId),
      deployment: { address: CONTRACT },
      actions: Array.from({ length: n }, (_, i) =>
        action(i, { chainOffsetMs: chainId === 'elysium-testnet' ? 150 : 1600 }),
      ),
    });
  }
  const snapshot = await collectCompare({
    sources: Object.entries(dirs).map(([chain, stateDir]) => ({ chain, stateDir })),
    now: () => NOW,
  });
  assert.equal(snapshot.comparison.ready, true);
  assert.ok(Array.isArray(snapshot.comparison.ci95Ms));
  assert.equal(Object.getOwnPropertySymbols(snapshot).length, 0);
  await fs.rm(root, { recursive: true });
});

test('gas spend is compared per chain with the Nitro posting part split out', () => {
  const snapshot = buildCompareSnapshot({
    sources: [
      source(
        'elysium-testnet',
        Array.from({ length: 20 }, (_, i) => action(i)),
      ),
      source(
        'hyperevm-testnet',
        Array.from({ length: 20 }, (_, i) => action(i, { chainOffsetMs: 1600, nitro: false })),
      ),
    ],
    now: NOW,
  });
  const [e, h] = snapshot.chains;
  assert.equal(e.gas.feeWei.mean, '520140000000');
  assert.equal(e.gas.executionGas.p50, '28849');
  assert.equal(e.gas.postingGas.p50, '23165');
  assert.ok(Math.abs(e.gas.postingShare - 23165 / 52014) < 1e-4);
  assert.equal(h.gas.postingGas, null, 'an L1 has no posting component');
  assert.equal(h.gas.executionGas.p50, '28849');
  assert.equal(e.gas.feePer1000TxWei, '520140000000000');
  assert.equal(e.gas.breakdownCoverage, 1);
  assert.equal(snapshot.comparison.executionGasDelta, 0, 'the same bytecode executes with the same gas on both');
  assert.equal(snapshot.comparison.feeRatio, 5.5464, 'HyperEVM fee divided by Elysium fee');
  assert.equal(e.gas.hourly[0].feeP50Wei, '520140000000');
});

test('transactions settled before the gas split was recorded count toward fees but not the breakdown', () => {
  const legacy = Array.from({ length: 4 }, (_, i) => {
    const entry = action(i);
    delete entry.cost.breakdown;
    delete entry.cost.executionGas;
    delete entry.cost.gasUsedForL1;
    return entry;
  });
  const snapshot = buildCompareSnapshot({
    sources: [
      source('elysium-testnet', [...legacy, ...Array.from({ length: 4 }, (_, i) => action(i + 4))]),
      source('hyperevm-testnet', [action(0, { nitro: false })]),
    ],
    now: NOW,
  });
  assert.equal(snapshot.chains[0].gas.settled, 8);
  assert.equal(snapshot.chains[0].gas.breakdownCoverage, 0.5);
});

test('success rate ignores transactions that are still in flight', () => {
  const list = [
    ...Array.from({ length: 8 }, (_, i) => action(i)),
    action(8, { status: 'submitted' }),
    action(9, { status: 'reverted' }),
  ];
  const snapshot = buildCompareSnapshot({
    sources: [source('elysium-testnet', list), source('hyperevm-testnet', list)],
    now: NOW,
  });
  assert.equal(snapshot.chains[0].successRate, 0.8889, '8 of 9 resolved, the in-flight one is not a failure');
});

test('the product page carries no operator or account vocabulary and credits the author', async () => {
  const read = (file) => fs.readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
  const [html, js] = await Promise.all([read('compare.html'), read('compare.js')]);
  const text = `${html.replace(/<p><strong>Privacy\.<\/strong>[^<]*<\/p>/, '')}\n${js}`.toLowerCase();
  for (const word of ['balance', 'wallet', 'nonce', 'holds?', 'spend', 'budget', 'minute loop'])
    assert.ok(!new RegExp(`\\b${word}\\b`).test(text), `product page mentions ${word}`);
  assert.match(html, /<title>Elysium vs HyperEVM<\/title>/);
  assert.match(html, /href="https:\/\/x\.com\/0xbrunoamuniz" target="_blank" rel="noopener noreferrer me"/);
  assert.match(
    html,
    /href="https:\/\/www\.linkedin\.com\/in\/brunoamuniz\/" target="_blank" rel="noopener noreferrer me"/,
  );
  assert.match(html, /href="https:\/\/github\.com\/brunoamuniz" target="_blank" rel="noopener noreferrer me"/);
  assert.match(html, /not affiliated with Kinetiq or Hyperliquid/);
  const share = html.match(/href="(https:\/\/x\.com\/intent\/post\?[^"]+)"/);
  assert.ok(share, 'the page has a Share on X link');
  const intent = new URL(share[1].replaceAll('&amp;', '&'));
  for (const handle of ['@0xbrunoamuniz', '@Kinetiq_xyz', '@Enter_Elysium'])
    assert.ok(intent.searchParams.get('text').includes(handle), `the share text tags ${handle}`);
  assert.equal(intent.searchParams.get('url'), 'https://elysium-vs-hyperevm.vercel.app');
  assert.match(
    html,
    /href="https:\/\/github\.com\/brunoamuniz\/elysium-vs-hyperevm" target="_blank" rel="noopener noreferrer"/,
    'the page has a Star on GitHub link',
  );
  const top = html.indexOf('<h1 id="overview-title">Elysium vs HyperEVM</h1>');
  const note = html.indexOf('id="affiliation-note"');
  assert.ok(
    top !== -1 && note > top && note < html.indexOf('id="verdict-text"'),
    'the affiliation notice sits right under the page title, before the result',
  );
  assert.match(
    html.slice(note, note + 300),
    /Not affiliated with, endorsed by, or sponsored by Kinetiq or Hyperliquid/,
  );
  for (const id of ['overview', 'latency', 'gas', 'transactions', 'methodology', 'about']) {
    assert.match(html, new RegExp(`<a href="#${id}"`), `menu links ${id}`);
    assert.match(html, new RegExp(`<section id="${id}"`), `section ${id} exists`);
  }
});

test('chain-side inclusion is corrected by the host clock offset measured at send time', () => {
  const block = String(Date.parse('2026-09-22T19:00:05Z') / 1000);
  const timing = (clockOffsetMs) => ({
    measurementVersion: 4,
    clockOffsetMs,
    submitStartedAt: '2026-09-22T19:00:03.228Z',
    blockTimestamp: block,
  });
  assert.equal(chainInclusionMs(timing(0)), 2272);
  assert.equal(chainInclusionMs(timing(1200)), 1072, 'a host 1.2 s behind no longer inflates the result');
  assert.equal(chainInclusionMs(timing(-500)), 2772, 'a host running ahead is corrected the other way');
  assert.equal(chainInclusionMs(timing(null)), null, 'without a fresh offset the sample is left out');
  assert.equal(chainInclusionMs(timing(120_000)), null, 'an implausible offset is rejected');
});

test('the snapshot reports how large the clock corrections were', () => {
  const list = Array.from({ length: 6 }, (_, i) => {
    const entry = action(i);
    entry.timing.clockOffsetMs = i % 2 ? 1200 : -40;
    return entry;
  });
  const snapshot = buildCompareSnapshot({
    sources: [source('elysium-testnet', list), source('hyperevm-testnet', list)],
    now: NOW,
  });
  assert.equal(snapshot.chains[0].metrics.clockCorrection.count, 6);
  assert.equal(snapshot.chains[0].metrics.clockCorrection.maxMs, 1200);
  assert.equal(snapshot.chains[0].metrics.clockCorrection.minMs, 40, 'magnitudes, not signed offsets');
});

test('the midpoint estimate recovers the true median that whole-second timestamps would hide', () => {
  const trueDelayMs = 180;
  const values = Array.from({ length: 1000 }, (_, i) => {
    const submit = Date.parse('2026-09-23T12:00:00.000Z') + i * 6_037;
    const blockSeconds = Math.floor((submit + trueDelayMs) / 1000);
    return chainInclusionMs({
      measurementVersion: 4,
      clockOffsetMs: 0,
      submitStartedAt: new Date(submit).toISOString(),
      blockTimestamp: String(blockSeconds),
    });
  });
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  const median = sorted[Math.ceil(sorted.length / 2) - 1];
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  assert.equal(sorted.length, 1000, 'no sample is dropped for landing in the same second');
  assert.ok(Math.abs(median - trueDelayMs) <= 30, `median ${median} is close to the true 180 ms`);
  assert.ok(Math.abs(mean - trueDelayMs) <= 30, `mean ${mean} is close to the true 180 ms`);
});
