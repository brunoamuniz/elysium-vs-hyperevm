import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { CHAINS } from '../src/config.mjs';
import { emptyState } from '../src/state.mjs';
import { buildCompareSnapshot } from '../src/compare-snapshot.mjs';

const WALLET = '0x00000000000000000000000000000000000B0b01';
const CONTRACT = '0xC23D6d3E3225dAF415A7756B7259D65eCF478d24';
const NOW = new Date('2026-09-24T12:00:00.000Z');
const BASE = Date.parse('2026-09-23T11:21:00.000Z');

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.lazy = new Map();
    this.text = '';
    this.className = '';
  }
  set innerHTML(_) {
    throw new Error('innerHTML is forbidden');
  }
  get textContent() {
    return this.text + this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join('');
  }
  set textContent(value) {
    this.children = [];
    this.text = String(value);
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    this.children.push(...nodes);
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
  addEventListener() {}
  querySelector(selector) {
    if (!this.lazy.has(selector)) this.lazy.set(selector, new FakeElement('div'));
    return this.lazy.get(selector);
  }
  createTHead() {
    return this.appendChild(new FakeElement('thead'));
  }
  createTBody() {
    return this.appendChild(new FakeElement('tbody'));
  }
  insertRow() {
    return this.appendChild(new FakeElement('tr'));
  }
  insertCell() {
    return this.appendChild(new FakeElement('td'));
  }
  all() {
    return [
      this,
      ...this.children.filter((child) => typeof child !== 'string').flatMap((child) => child.all()),
      ...[...this.lazy.values()].flatMap((child) => child.all()),
    ];
  }
}

const settle = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function render(snapshot) {
  const byId = new Map();
  const document = {
    visibilityState: 'visible',
    documentElement: { dataset: { snapshot: '/api/compare' } },
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new FakeElement('div'));
      return byId.get(id);
    },
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_, tag) => new FakeElement(tag),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const context = vm.createContext({
    document,
    window: { addEventListener() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(snapshot)) }),
    AbortController,
    URL,
    Node: FakeElement,
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
    Map,
    Set,
  });
  vm.runInContext(await fs.readFile(new URL('../public/compare.js', import.meta.url), 'utf8'), context);
  await settle();
  const el = (id) => document.getElementById(id);
  const allText = () => [...byId.values()].map((node) => node.textContent).join('\n');
  return { el, allText };
}

function action(index, { delayMs, start = BASE, offsetMs = 0, nitro = true } = {}) {
  const submitReal = start + index * 6_037;
  const submitLocal = submitReal - offsetMs;
  return {
    id: `pulse:${index}`,
    kind: 'pulse',
    profile: 'benchmark-10',
    status: 'finalized',
    hash: `0x${index.toString(16).padStart(64, 'a')}`,
    receipt: { blockNumber: String(1000 + index) },
    cost: nitro
      ? {
          actualCostWei: '389000000000',
          gasUsed: '38900',
          effectiveGasPriceWei: '10000000',
          gasUsedForL1: '10051',
          executionGas: '28849',
          breakdown: 'nitro',
        }
      : {
          actualCostWei: '2884900000000',
          gasUsed: '28849',
          effectiveGasPriceWei: '100000000',
          gasUsedForL1: null,
          executionGas: '28849',
          breakdown: 'none',
        },
    timing: {
      measurementVersion: 4,
      clockOffsetMs: offsetMs,
      quality: 'primary',
      recovered: false,
      submitStartedAt: new Date(submitLocal).toISOString(),
      rpcAcceptedAt: new Date(submitLocal + 450).toISOString(),
      includedObservedAt: new Date(submitLocal + delayMs + 700).toISOString(),
      includedObservedRttMs: 400,
      blockTimestamp: String(Math.floor((submitReal + delayMs) / 1000)),
      confirmedObservedAt: new Date(submitLocal + delayMs + 5000).toISOString(),
    },
  };
}

function source(chainId, actions) {
  return {
    chain: CHAINS[chainId],
    halted: false,
    archived: [],
    state: {
      ...emptyState(WALLET, CHAINS[chainId].chainId),
      deployment: { address: CONTRACT, txHash: `0x${'22'.repeat(32)}` },
      actions,
    },
  };
}

function snapshotFor({ elysiumDelay = 180, hyperDelay = 1600, count = 300, offsetMs = 0 } = {}) {
  return buildCompareSnapshot({
    sources: [
      source(
        'elysium-testnet',
        Array.from({ length: count }, (_, i) => action(i, { delayMs: elysiumDelay, offsetMs })),
      ),
      source(
        'hyperevm-testnet',
        Array.from({ length: count }, (_, i) => action(i, { delayMs: hyperDelay, offsetMs, nitro: false })),
      ),
    ],
    now: NOW,
  });
}

const cardText = (el, index) => el('chain-cards').children[index].textContent;

test('the headline card separates the number from its label and shows a real, non-zero latency', async () => {
  const { el } = await render(snapshotFor());
  const elysium = cardText(el, 0);
  assert.match(elysium, /\d+ ms p50 chain-side inclusion/, 'number and label are separated by a space');
  assert.doesNotMatch(elysium, /msp50/);
  const shown = Number(elysium.match(/(\d[\d,]*) ms p50/)[1].replace(/,/g, ''));
  assert.ok(shown > 0, 'a fast chain must not read as 0 ms');
  assert.ok(Math.abs(shown - 180) <= 80, `Elysium shows ${shown} ms for a true 180 ms delay`);
  const hyper = Number(
    cardText(el, 1)
      .match(/(\d[\d,]*) ms p50/)[1]
      .replace(/,/g, ''),
  );
  assert.ok(Math.abs(hyper - 1600) <= 80, `HyperEVM shows ${hyper} ms for a true 1600 ms delay`);
});

test('no rendered text ever shows NaN, undefined, null, Infinity or a negative latency', async () => {
  for (const snapshot of [snapshotFor(), snapshotFor({ count: 20 }), snapshotFor({ elysiumDelay: 0 })]) {
    const { allText } = await render(snapshot);
    const text = allText();
    for (const bad of ['NaN', 'undefined', 'null', 'Infinity', '[object Object]'])
      assert.ok(!text.includes(bad), `rendered text contains ${bad}`);
    assert.doesNotMatch(text, /[-−]\d[\d,]* ms p50/, 'a headline latency is never negative');
    assert.doesNotMatch(text, /(^|\s)-\d[\d,]* ms/m, 'no latency cell renders with a minus sign');
  }
});

test('a chain that includes within the same second reads as under half a second, never as a negative or zero figure', async () => {
  const { el } = await render(snapshotFor({ elysiumDelay: 0 }));
  const card = cardText(el, 0);
  assert.doesNotMatch(card, /^0 ms|\s0 ms p50/);
  assert.match(card, /(< 0\.5 s|\d+ ms) p50 chain-side inclusion/);
  const recent = el('tx-tables').children[0].textContent;
  assert.doesNotMatch(recent, /-\d+ ms/);
});

test('before 200 samples the page says it is collecting data and does not announce a winner', async () => {
  const { el } = await render(snapshotFor({ count: 50 }));
  const verdict = el('verdict-text').textContent;
  assert.match(verdict, /Collecting data: 50 of 200 samples/);
  assert.doesNotMatch(verdict, /faster/);
});

test('a ready result names the faster chain with the measured gap and its interval', async () => {
  const { el } = await render(snapshotFor());
  const verdict = el('verdict-text').textContent;
  assert.match(verdict, /Elysium Testnet includes transactions faster/);
  assert.match(verdict, /95% CI/);
  assert.match(verdict, /costs \d+(\.\d)?× less than on HyperEVM Testnet/);
});

test('the fee row shows HYPE amounts with the expected magnitude', async () => {
  const { el } = await render(snapshotFor());
  const rows = el('gas-body').children.map((row) => row.textContent);
  const feeRow = rows.find((row) => row.startsWith('Fee per transaction, mean'));
  assert.match(feeRow, /0\.000000389 HYPE/);
  assert.match(feeRow, /0\.000002884 HYPE/);
});
