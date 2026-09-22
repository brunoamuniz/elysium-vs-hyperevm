import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { buildDashboardPayload } from '../src/dashboard-data.mjs';

const read = (file) => fs.readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
const CHART_IDS = [
  'chart-latency',
  'chart-minutes',
  'chart-histogram',
  'chart-throughput',
  'chart-cost',
  'chart-health',
];
const HOSTILE = '<img src=x onerror=alert(1)>';
const CONTRACT = '0x00000000000000000000000000000000000000b2';
const BASE = Date.parse('2026-09-22T11:00:00.000Z');
const iso = (offset) => new Date(BASE + offset).toISOString();

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = {};
    this.lazy = new Map();
    this.text = '';
    this.hidden = false;
    this.className = '';
  }
  set innerHTML(_) {
    throw new Error('innerHTML is forbidden');
  }
  set outerHTML(_) {
    throw new Error('outerHTML is forbidden');
  }
  insertAdjacentHTML() {
    throw new Error('insertAdjacentHTML is forbidden');
  }
  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join('');
  }
  set textContent(value) {
    this.children = [];
    this.text = String(value);
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  replaceChildren(...nodes) {
    this.children = nodes;
    this.text = '';
  }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
  }
  getAttribute(key) {
    return this.attributes.get(key) ?? null;
  }
  removeAttribute(key) {
    this.attributes.delete(key);
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  querySelector(selector) {
    if (!this.lazy.has(selector)) this.lazy.set(selector, new FakeElement('div'));
    return this.lazy.get(selector);
  }
  all() {
    return [
      this,
      ...this.children.flatMap((child) => child.all()),
      ...[...this.lazy.values()].flatMap((child) => child.all()),
    ];
  }
}

function fakeSelect() {
  const select = new FakeElement('select');
  select.options = ['15000', '30000', '60000'].map((value) => ({ value, disabled: false }));
  select.value = '15000';
  Object.defineProperty(select, 'selectedOptions', {
    get: () => select.options.filter((option) => option.value === select.value),
  });
  return select;
}

const settle = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function runDashboard(payload, { ok = true, fetchImpl, breakOnce } = {}) {
  const byId = new Map([['bucket-select', fakeSelect()]]);
  if (breakOnce) {
    const broken = new FakeElement('div');
    let thrown = false;
    Object.defineProperty(broken, 'textContent', {
      get: () => broken.text,
      set: (value) => {
        if (!thrown) {
          thrown = true;
          throw new Error('render exploded');
        }
        broken.text = String(value);
      },
    });
    byId.set(breakOnce, broken);
  }
  const listeners = {};
  const document = {
    visibilityState: 'visible',
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new FakeElement('div'));
      return byId.get(id);
    },
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (ns, tag) => {
      assert.equal(ns, 'http://www.w3.org/2000/svg');
      return new FakeElement(tag);
    },
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
  };
  const requests = [];
  const context = vm.createContext({
    document,
    window: { addEventListener() {} },
    fetch: fetchImpl
      ? (url, options) => {
          requests.push({ url, options });
          return fetchImpl(url, options);
        }
      : async (url, options) => {
          requests.push({ url, options });
          return { ok, status: ok ? 200 : 503, json: async () => JSON.parse(JSON.stringify(payload)) };
        },
    AbortController,
    setTimeout: () => 0,
    clearTimeout: () => {},
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    JSON,
    Promise,
  });
  vm.runInContext(await read('dashboard.js'), context);
  await settle();
  const refreshAgain = async () => {
    listeners.visibilitychange();
    await settle();
  };
  return { el: (id) => document.getElementById(id), requests, fire: (type) => listeners[type](), refreshAgain };
}

const summaryOf = (el, id) => el(id).querySelector('.chart-summary').textContent;
const tableRows = (el, id) =>
  el(id)
    .querySelector('[data-table]')
    .all()
    .filter((node) => node.tagName === 'tbody')[0]
    .children.map((row) => row.children.map((cell) => cell.textContent));

function action(index, overrides = {}) {
  const at = Math.floor(index / 10) * 60_000 + (index % 10) * 1000;
  return {
    id: `pulse:2026-09-22T11:${String(Math.floor(index / 10) % 60).padStart(2, '0')}Z:${index % 10}`,
    kind: 'pulse',
    slot: `2026-09-22T11:${String(Math.floor(index / 10) % 60).padStart(2, '0')}Z`,
    status: 'finalized',
    nonce: String(index),
    hash: `0x${String(index % 10).repeat(64)}`,
    receipt: { blockNumber: String(2000 + index) },
    timing: {
      submitStartedAt: iso(at),
      rpcAcceptedAt: iso(at + 150),
      includedObservedAt: iso(at + 3000),
      blockTimestamp: '1790000000',
      confirmedObservedAt: iso(at + 7000 + (index % 7) * 900),
      quality: 'primary',
      recovered: false,
    },
    cost: {
      worstCostWei: '400000000000000',
      reservedDay: '2026-09-22',
      actualCostWei: String(60000000000000 + index * 1000),
      gasUsed: '60000',
      effectiveGasPriceWei: '1000000000',
    },
    ...overrides,
  };
}

function payload(actions, overrides = {}) {
  const state = {
    version: 2,
    walletAddress: '0x00000000000000000000000000000000000000a1',
    deployment: { address: CONTRACT, txHash: `0x${'22'.repeat(32)}`, blockNumber: '900' },
    actions,
    batches: [{ slot: '2026-09-22T11:05Z', outcome: 'capacity_skip', plannedCount: 10 }],
    dailySpend: { '2026-09-22': '600000000000000' },
    hold: null,
  };
  return {
    ...buildDashboardPayload({
      read: { state, halted: false, unavailable: null },
      chain: { balanceWei: '123456789000000000', blockNumber: '1200', pulseCount: '9', unavailable: null },
      now: new Date('2026-09-22T12:00:00.000Z'),
    }),
    ...overrides,
  };
}

test('browser assets make no third-party requests and use no unsafe HTML sinks', async () => {
  const [html, css, js] = await Promise.all([read('dashboard.html'), read('dashboard.css'), read('dashboard.js')]);
  for (const [name, source] of [
    ['html', html],
    ['css', css],
    ['js', js],
  ]) {
    const urls = (source.match(/https?:\/\/[^\s'")]+/g) || []).filter((url) => url !== 'http://www.w3.org/2000/svg');
    assert.deepEqual(urls, [], `${name} references external URLs`);
    if (name === 'css') assert.ok(!/@import|url\(/i.test(source), 'css must not import or load remote resources');
  }
  assert.ok(
    !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|srcdoc/.test(js),
    'dashboard.js must build DOM with safe APIs only',
  );
  assert.ok(!/<script(?![^>]*src="\/dashboard\.js")/i.test(html), 'no inline scripts under the CSP');
  assert.ok(!/\sstyle=|\son[a-z]+=/i.test(html), 'no inline styles or event handlers under the CSP');
  assert.ok(
    !/setAttribute\(\s*['"](style|on[a-z]+)['"]/i.test(js),
    'no inline style or handler attributes from script',
  );
  assert.ok(!/<(form|button|input)\b/i.test(html), 'the dashboard stays read-only with no write controls');
  assert.ok(!/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(js), 'the dashboard only issues GET requests');
  assert.ok(
    !/privateKey|keyPath|\braw\b|calldata/i.test(js),
    'browser code never references secret or raw transaction fields',
  );
});

test('the shell carries Elysium tokens, navigation, testnet chip and six accessible chart figures', async () => {
  const [html, css] = await Promise.all([read('dashboard.html'), read('dashboard.css')]);
  for (const token of ['--canvas', '--ink', '--accent', '--border', '--ink-3', '--row', '--stop-mark'])
    assert.ok(css.includes(`${token}:`), `missing token ${token}`);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /forced-colors/);
  assert.match(html, /<nav class="sidenav" aria-label=/);
  assert.match(html, /class="testnet-chip"/);
  for (const id of CHART_IDS) {
    assert.match(html, new RegExp(`<figure class="chart" id="${id}" aria-labelledby="${id}-title">`));
    assert.match(html, new RegExp(`id="${id}-summary"`));
  }
  assert.equal((html.match(/<figure class="chart"/g) || []).length, 6);
  assert.ok(html.includes('Tailscale-only') && html.includes('not identity-authenticated'));
});

test('dashboard.js renders all six charts as labelled SVG with text summaries from the API payload', async () => {
  const actions = Array.from({ length: 60 }, (_, index) => action(index));
  actions.push(
    action(60, { status: 'reverted' }),
    action(61, {
      status: 'submitted',
      timing: { submitStartedAt: iso(3_700_000), rpcAcceptedAt: iso(3_700_150), quality: 'primary' },
    }),
    action(62, { timing: { ...action(62).timing, quality: 'recovered', recovered: true } }),
  );
  const { el, requests } = await runDashboard(payload(actions));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/dashboard');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(el('feed-status').textContent, 'live');
  assert.equal(el('network-badge').textContent, 'Testnet');
  for (const id of CHART_IDS) {
    const figure = el(id);
    const svg = figure.querySelector('[data-plot]').children[0];
    assert.equal(svg?.tagName, 'svg', `${id} renders an svg`);
    assert.equal(svg.getAttribute('role'), 'img');
    assert.deepEqual(
      svg.children.slice(0, 2).map((child) => child.tagName),
      ['title', 'desc'],
    );
    const summary = figure.querySelector('.chart-summary').textContent;
    assert.ok(summary.length > 20 && summary !== 'No data yet.', `${id} has a data summary`);
    assert.ok(
      figure
        .querySelector('[data-table]')
        .all()
        .some((node) => node.tagName === 'table'),
      `${id} has a data table`,
    );
  }
  assert.match(el('chart-latency').querySelector('.chart-summary').textContent, /rolling p50/i);
  assert.ok(
    el('chart-latency')
      .all()
      .some((node) => node.getAttribute('class') === 'line-p95'),
  );
  assert.ok(
    el('chart-latency')
      .all()
      .some((node) => node.getAttribute('class') === 'mark-recovered'),
  );
  assert.equal(el('phase-body').children.length, 5);
  assert.notEqual(el('bench-p50').textContent, '–');
});

test('hostile API strings land only in text nodes and series rendering stays bounded', async () => {
  const data = payload([action(0)]);
  data.transactions[0].slot = HOSTILE;
  data.transactions[0].kind = HOSTILE;
  data.benchmark.series = Array.from({ length: 1000 }, (_, index) => ({
    at: iso(index * 1000),
    status: 'finalized',
    quality: 'primary',
    endToEndMs: 5000 + index,
  }));
  const { el } = await runDashboard(data);
  const row = el('tx-body').children[0];
  assert.ok(row.textContent.includes(HOSTILE), 'hostile text is rendered verbatim as text');
  assert.ok(!row.all().some((node) => node.tagName === 'img'));
  const marks = el('chart-latency')
    .querySelector('[data-plot]')
    .all()
    .filter((node) => node.getAttribute('class') === 'mark-final');
  assert.ok(marks.length <= 300, `latency chart plotted ${marks.length} points`);
});

test('empty and failing feeds render explicit empty states instead of invented data', async () => {
  const empty = await runDashboard(payload([]));
  assert.equal(empty.el('chart-latency').querySelector('[data-plot]').children[0].className, 'empty');
  assert.equal(empty.el('bench-p50').textContent, '–');
  const down = await runDashboard(null, { ok: false });
  assert.equal(down.el('feed-status').textContent, 'unreachable');
  assert.match(down.el('chart-health').querySelector('.chart-summary').textContent, /0 of 1 refreshes/);
  assert.match(down.el('chart-health').querySelector('.chart-summary').textContent, /Current RPC: unknown/);
});

test('an overflow-only histogram renders an explicit empty state instead of crashing the dashboard', async () => {
  for (const buckets of [
    [],
    [
      { fromMs: 0, toMs: 15000, count: 0 },
      { fromMs: 15000, toMs: 30000, count: 0 },
    ],
  ]) {
    const data = payload([action(0)]);
    data.benchmark.histogram = { bucketMs: 15000, overflowCount: 3, buckets };
    const { el } = await runDashboard(data);
    assert.equal(el('feed-status').textContent, 'live');
    assert.match(summaryOf(el, 'chart-histogram'), /3 primary end-to-end samples.*3 beyond the last bucket/);
    const plot = el('chart-histogram').querySelector('[data-plot]').children[0];
    assert.equal(plot.className, 'empty');
    assert.equal(plot.textContent, 'All samples are beyond the last bucket.');
    assert.ok(tableRows(el, 'chart-histogram').some((row) => row[1] === 'beyond' && row[2] === '3'));
  }
});

test('a render exception is reported as a render failure, not a feed outage, and records one health tick', async () => {
  const { el, refreshAgain, requests } = await runDashboard(payload([action(0)]), { breakOnce: 'generated-at' });
  assert.equal(el('feed-status').textContent, 'render failed');
  assert.equal(el('feed-status').dataset.feed, 'render_error');
  await refreshAgain();
  assert.equal(requests.length, 2);
  assert.equal(el('feed-status').textContent, 'live');
  assert.match(summaryOf(el, 'chart-health'), /available on 2 of 2 refreshes/);
});

test('the health data table keeps every measure row while refresh history stays bounded', async () => {
  const { el, refreshAgain } = await runDashboard(payload([action(0)]));
  for (let index = 0; index < 70; index += 1) await refreshAgain();
  const rows = tableRows(el, 'chart-health');
  assert.ok(rows.length <= 60, `health table has ${rows.length} rows`);
  assert.deepEqual(
    rows.slice(0, 8).map((row) => row[0]),
    [
      'Primary timing',
      'Recovered',
      'Migrated',
      'Clock drift',
      'Reconcile required',
      'Capacity skip',
      'Budget skip',
      'Hold skip',
    ],
  );
  assert.ok(rows.slice(8).every((row) => row[0].startsWith('Refresh ')));
  assert.ok(rows.length > 8);
});

test('reconcile_required and unknown submissions get their own stop marks and counts', async () => {
  const data = payload([action(0)]);
  data.benchmark.series = [
    { at: iso(0), status: 'finalized', quality: 'primary', endToEndMs: 5000 },
    { at: iso(1000), status: 'reconcile_required', quality: 'primary', endToEndMs: 6000 },
    { at: iso(2000), status: 'unknown', quality: 'recovered', endToEndMs: 7000 },
    { at: iso(3000), status: 'submitted', quality: 'primary', endToEndMs: null },
  ];
  const { el } = await runDashboard(data);
  const summary = summaryOf(el, 'chart-latency');
  assert.match(
    summary,
    /1 finalized primary, 1 pending, 0 reverted, 2 reconcile required or unknown, 0 recovered or migrated/,
  );
  const nodes = el('chart-latency').all();
  assert.equal(nodes.filter((node) => node.getAttribute('class') === 'mark-stop').length, 3);
  assert.ok(el('chart-latency').querySelector('[data-legend]').textContent.includes('Reconcile required or unknown'));
  assert.match(await read('dashboard.css'), /\.mark-stop\s*\{/);
});

test('every horizontal chart and table scroller is a labelled keyboard-focusable region', async () => {
  const html = await read('dashboard.html');
  const plots = html.match(/<div class="chart-plot"[^>]*>/g) || [];
  assert.equal(plots.length, 6);
  for (const tag of [...plots, ...(html.match(/<div class="table-wrap"[^>]*>/g) || [])]) {
    assert.match(tag, /tabindex="0"/, tag);
    assert.match(tag, /role="region"/, tag);
    assert.match(tag, /aria-label(ledby)?="[^"]+"/, tag);
  }
  const { el } = await runDashboard(payload([action(0)]));
  for (const id of CHART_IDS) {
    const wrap = el(id).querySelector('[data-table]').children[0];
    assert.equal(wrap.className, 'table-wrap');
    assert.equal(wrap.getAttribute('tabindex'), '0');
    assert.equal(wrap.getAttribute('role'), 'region');
    assert.ok(wrap.getAttribute('aria-label'), `${id} data table region is labelled`);
  }
});

test('refreshes never overlap, so a slow response cannot render over a newer one', async () => {
  const pending = [];
  const fetchImpl = () => new Promise((resolve) => pending.push(resolve));
  const { el, fire, requests } = await runDashboard(null, { fetchImpl });
  fire('visibilitychange');
  fire('visibilitychange');
  await settle();
  assert.equal(requests.length, 1);
  const data = payload([action(0)]);
  pending[0]({ ok: true, status: 200, json: async () => data });
  await settle();
  assert.equal(el('feed-status').textContent, 'live');
  fire('visibilitychange');
  await settle();
  assert.equal(requests.length, 2);
});

test('rolling p50 and p95 legend items and lines appear only once the lines exist', async () => {
  const data = payload([action(0)]);
  data.benchmark.series = Array.from({ length: 3 }, (_, index) => ({
    at: iso(index * 1000),
    status: 'finalized',
    quality: 'primary',
    endToEndMs: 5000 + index,
  }));
  const { el } = await runDashboard(data);
  const legend = el('chart-latency').querySelector('[data-legend]').textContent;
  assert.ok(!/Rolling p50|Rolling p95/.test(legend), legend);
  assert.ok(
    !el('chart-latency')
      .all()
      .some((node) => ['line-p50', 'line-p95'].includes(node.getAttribute('class'))),
  );
  data.benchmark.series = Array.from({ length: 6 }, (_, index) => ({
    at: iso(index * 1000),
    status: 'finalized',
    quality: 'primary',
    endToEndMs: 5000 + index,
  }));
  const full = await runDashboard(data);
  assert.match(full.el('chart-latency').querySelector('[data-legend]').textContent, /Rolling p50.*Rolling p95/);
});

test('the font stack names only locally available system fonts and loads nothing over the network', async () => {
  const css = await read('dashboard.css');
  assert.ok(!/@font-face/i.test(css), 'no web fonts are declared');
  for (const name of ['--font-sans', '--font-mono']) {
    const stack = css.match(new RegExp(`${name}:([^;]+);`))[1];
    assert.ok(
      !/DM Sans|Inter|JetBrains/i.test(stack),
      `${name} names a font that is neither installed nor self-hosted: ${stack}`,
    );
  }
});
