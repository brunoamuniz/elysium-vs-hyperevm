(() => {
  'use strict';

  const ENDPOINT = document.documentElement.dataset.snapshot || '/api/compare';
  const POLL_MS = 60000;
  const TIMEOUT_MS = 15000;
  const DASH = '–';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const W = 560;
  const H = 220;
  const M = { top: 12, right: 14, bottom: 28, left: 62 };
  const WIDE = 1120;
  const SERIES = ['a', 'b'];
  const EXPLORER_HOSTS = ['elysium.kinetiq.xyz', 'app.hyperliquid-testnet.xyz'];

  let timer = null;
  let stopped = false;
  let inflight = null;
  let uid = 0;

  const el = (id) => document.getElementById(id);
  const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

  function setText(id, value) { const target = el(id); if (target) target.textContent = value === null || value === undefined || value === '' ? DASH : String(value); }

  function ms(value) {
    const n = finite(value);
    if (n === null) return DASH;
    return n >= 10000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n).toLocaleString('en-US')} ms`;
  }

  function inclusion(value) { const n = finite(value); return n !== null && n < 0 ? '< 0.5 s' : ms(value); }
  function signedMs(value) { const n = finite(value); return n === null ? DASH : `${n > 0 ? '+' : n < 0 ? '−' : ''}${ms(Math.abs(n))}`; }
  function pct(value) { const n = finite(value); return n === null ? DASH : `${(n * 100).toFixed(2)}%`; }
  function shortHash(value) { return typeof value === 'string' && value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value || DASH; }
  function utc(iso) { const at = typeof iso === 'string' ? Date.parse(iso) : NaN; return Number.isFinite(at) ? new Date(at).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : DASH; }
  function clock(at) { return new Date(at).toISOString().slice(11, 16); }

  function weiToHype(wei, digits = 9) {
    if (typeof wei !== 'string' || !/^[0-9]{1,40}$/.test(wei)) return DASH;
    const padded = wei.padStart(19, '0');
    return `${padded.slice(0, -18).replace(/^0+(?=[0-9])/, '')}.${padded.slice(-18).slice(0, digits)}`;
  }

  function gwei(wei) { if (typeof wei !== 'string' || !/^[0-9]{1,40}$/.test(wei)) return DASH; return `${(Number(wei) / 1e9).toFixed(4)} gwei`; }

  function safeUrl(value) {
    if (typeof value !== 'string') return null;
    try { const url = new URL(value); return url.protocol === 'https:' && EXPLORER_HOSTS.includes(url.hostname) ? url.href : null; } catch { return null; }
  }

  function link(text, href) {
    const safe = safeUrl(href);
    if (!safe) { const span = document.createElement('span'); span.textContent = text; return span; }
    const anchor = document.createElement('a');
    anchor.href = safe;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = text;
    return anchor;
  }

  function node(tag, attrs, parent) {
    const created = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs || {})) created.setAttribute(key, String(value));
    if (parent) parent.appendChild(created);
    return created;
  }

  function textNode(tag, attrs, text, parent) { const created = node(tag, attrs, parent); created.textContent = text; return created; }

  function createSvg(title, desc, height = H, width = W) {
    uid += 1;
    const svg = node('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-labelledby': `cmp-t-${uid} cmp-d-${uid}`, focusable: 'false' });
    textNode('title', { id: `cmp-t-${uid}` }, title, svg);
    textNode('desc', { id: `cmp-d-${uid}` }, desc, svg);
    return svg;
  }

  function niceMax(value) {
    if (!(value > 0)) return 1;
    const exponent = 10 ** Math.floor(Math.log10(value));
    for (const step of [1, 2, 2.5, 5, 10]) if (value <= step * exponent) return step * exponent;
    return 10 * exponent;
  }

  function scale(d0, d1, r0, r1) { const span = d1 - d0 || 1; return (value) => r0 + ((value - d0) / span) * (r1 - r0); }

  function yAxis(svg, y, max, format, width = W) {
    const group = node('g', { class: 'axis', 'aria-hidden': 'true' }, svg);
    for (let index = 0; index <= 4; index += 1) {
      const value = (max / 4) * index;
      node('line', { x1: M.left, x2: width - M.right, y1: y(value), y2: y(value), class: index === 0 ? 'baseline' : 'gridline' }, group);
      textNode('text', { x: M.left - 6, y: y(value) + 3, 'text-anchor': 'end' }, format(value), group);
    }
  }

  function xLabels(svg, labels) {
    const group = node('g', { class: 'axis', 'aria-hidden': 'true' }, svg);
    for (const [x, text, anchor] of labels) textNode('text', { x, y: H - 8, 'text-anchor': anchor }, text, group);
  }

  function legendSwatch(kind) {
    const svg = node('svg', { width: 18, height: 12, viewBox: '0 0 18 12', 'aria-hidden': 'true', focusable: 'false' });
    if (kind.endsWith('-line')) node('path', { d: 'M1 6H17', class: kind }, svg);
    else if (kind.endsWith('-mark')) node('circle', { cx: 9, cy: 6, r: 4, class: kind }, svg);
    else node('rect', { x: 3, y: 1, width: 12, height: 10, rx: 2, class: kind }, svg);
    return svg;
  }

  function renderTable(holder, caption, headers, rows) {
    holder.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    wrap.setAttribute('tabindex', '0');
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', caption);
    const table = document.createElement('table');
    table.className = 'dense';
    const cap = document.createElement('caption');
    cap.textContent = caption;
    table.appendChild(cap);
    const head = table.createTHead().insertRow();
    for (const header of headers) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = header; head.appendChild(th); }
    const body = table.createTBody();
    for (const row of rows) { const tr = body.insertRow(); for (const value of row) tr.insertCell().textContent = value === null || value === undefined ? DASH : String(value); }
    wrap.appendChild(table);
    holder.appendChild(wrap);
  }

  function renderChart(id, { summary, svg, legend = [], table, emptyText }) {
    const figure = el(id);
    if (!figure) return;
    figure.querySelector('.chart-summary').textContent = summary;
    const plot = figure.querySelector('[data-plot]');
    plot.replaceChildren();
    if (svg) plot.appendChild(svg);
    else { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = emptyText || 'No data yet.'; plot.appendChild(empty); }
    const list = figure.querySelector('[data-legend]');
    list.replaceChildren();
    if (svg) for (const item of legend) { const li = document.createElement('li'); li.appendChild(legendSwatch(item.kind)); const span = document.createElement('span'); span.textContent = item.label; li.appendChild(span); list.appendChild(li); }
    if (table) renderTable(figure.querySelector('[data-table]'), table.caption, table.headers, table.rows);
  }

  function chains(data) { return Array.isArray(data?.chains) ? data.chains.slice(0, 2) : []; }

  function verdict(data) {
    const [a, b] = chains(data);
    const cmp = data?.comparison || {};
    const win = data?.window || {};
    if (!a || !b) return 'Waiting for both chains to report.';
    const an = finite(a.metrics?.chainInclusion?.count) ?? 0;
    const bn = finite(b.metrics?.chainInclusion?.count) ?? 0;
    const need = finite(win.minSamplesPerChain) ?? 200;
    const ap = a.metrics?.chainInclusion?.p50Ms;
    const bp = b.metrics?.chainInclusion?.p50Ms;
    if (!cmp.ready) {
      const early = finite(ap) !== null && finite(bp) !== null ? ` Early p50 so far: ${a.name} ${inclusion(ap)}, ${b.name} ${inclusion(bp)}.` : '';
      return [`Collecting data: ${an} of ${need} samples on ${a.name}, ${bn} of ${need} on ${b.name}.${early}`, 'Not yet a result.'];
    }
    const [lo, hi] = Array.isArray(cmp.ci95Ms) ? cmp.ci95Ms : [null, null];
    const diff = finite(cmp.diffP50Ms);
    let head;
    if (finite(hi) !== null && hi < 0) head = `${a.name} includes transactions faster: p50 ${inclusion(ap)} vs ${inclusion(bp)} on ${b.name}, ${ms(Math.abs(diff))} sooner (95% CI ${ms(Math.abs(hi))} to ${ms(Math.abs(lo))}).`;
    else if (finite(lo) !== null && lo > 0) head = `${b.name} includes transactions faster: p50 ${inclusion(bp)} vs ${inclusion(ap)} on ${a.name}, ${ms(diff)} sooner (95% CI ${ms(lo)} to ${ms(hi)}).`;
    else head = `No clear difference in chain-side inclusion: p50 ${inclusion(ap)} on ${a.name} vs ${inclusion(bp)} on ${b.name} (95% CI of the difference ${signedMs(lo)} to ${signedMs(hi)}).`;
    return [head, cmp.announceable ? null : `Provisional until the shared window reaches ${finite(win.announceAfterHours) ?? 24} hours.`];
  }

  function hype(wei, digits = 9) { const text = weiToHype(wei, digits); return text === DASH ? DASH : `${text} HYPE`; }
  function ratio(value) { const n = finite(value); return n === null ? DASH : `${n >= 10 ? n.toFixed(0) : n.toFixed(1)}×`; }
  function gasNumber(value) { return typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value).toLocaleString('en-US') : DASH; }

  function feeVerdict(data) {
    const [a, b] = chains(data);
    const fa = a?.gas?.feeWei?.mean; const fb = b?.gas?.feeWei?.mean;
    const r = finite(data?.comparison?.feeRatio);
    if (!a || !b || !fa || !fb || r === null || r <= 0) return null;
    const cheaper = r >= 1 ? a : b; const pricier = r >= 1 ? b : a; const factor = r >= 1 ? r : 1 / r;
    const ga = a.gas?.gasUsed?.mean; const gb = b.gas?.gasUsed?.mean;
    const pa = a.gas?.gasPriceWei?.p50; const pb = b.gas?.gasPriceWei?.p50;
    let why = '';
    if (ga && gb && pa && pb && Number(pa) > 0 && Number(pb) > 0) {
      const gasFactor = Number(ga) / Number(gb); const priceFactor = Number(pb) / Number(pa);
      const posting = a.gas?.postingShare;
      why = ` ${a.name} uses ${gasFactor >= 1 ? `${Math.round((gasFactor - 1) * 100)}% more` : `${Math.round((1 - gasFactor) * 100)}% less`} gas per transaction${finite(posting) !== null ? `, ${Math.round(posting * 100)}% of it for posting data to its parent chain,` : ''} at a ${priceFactor >= 1 ? `${ratio(priceFactor)} lower` : `${ratio(1 / priceFactor)} higher`} gas price.`;
    }
    const coverage = finite(a.gas?.breakdownCoverage);
    const hedge = coverage !== null && coverage < 0.9 ? ' (gas breakdown available for part of the samples only)' : '';
    return `A transaction on ${cheaper.name} costs ${ratio(factor)} less than on ${pricier.name}: mean fee ${hype(cheaper.gas.feeWei.mean)} vs ${hype(pricier.gas.feeWei.mean)}.${why}${hedge}`;
  }

  function renderVerdict(data) {
    const target = el('verdict-text');
    const parts = [].concat(verdict(data));
    target.replaceChildren();
    const first = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = parts[0];
    first.appendChild(strong);
    if (parts[1]) { first.append(' '); const note = document.createElement('span'); note.className = 'provisional'; note.textContent = parts[1]; first.appendChild(note); }
    target.appendChild(first);
    const fee = feeVerdict(data);
    if (fee) { const second = document.createElement('p'); second.textContent = fee; target.appendChild(second); }
    const win = data?.window || {};
    setText('window-note', win.start ? `Shared window ${utc(win.start)} to ${utc(win.end)} (${finite(win.hours) ?? 0} h). ${data?.load?.txPerMinutePerChain ?? 10} transactions per minute per chain, measurement v${data?.measurementVersion ?? DASH}.` : 'Waiting for both chains to start the current measurement.');
  }

  function renderCards(data) {
    const holder = el('chain-cards');
    holder.replaceChildren();
    chains(data).forEach((chain, index) => {
      const card = document.createElement('article');
      card.className = 'compare-card';
      const h3 = document.createElement('h3');
      const swatch = document.createElement('span'); swatch.className = 'swatch'; swatch.dataset.series = SERIES[index]; h3.appendChild(swatch);
      h3.append(chain.name || DASH);
      const layer = document.createElement('span'); layer.className = 'layer-tag'; layer.textContent = chain.layer || DASH; h3.appendChild(layer);
      const state = document.createElement('span'); state.className = 'status-tag'; state.dataset.tone = chain.status === 'running' ? 'ok' : chain.status === 'paused' ? 'stop' : 'warn'; state.textContent = chain.status || 'unknown'; h3.appendChild(state);
      card.appendChild(h3);
      const stack = document.createElement('p'); stack.className = 'stack'; stack.textContent = chain.settlesTo ? `${chain.stack}, settles to ${chain.settlesTo}` : chain.stack; card.appendChild(stack);
      const big = document.createElement('p'); big.className = 'big-number'; big.textContent = inclusion(chain.metrics?.chainInclusion?.p50Ms);
      const unit = document.createElement('small'); unit.textContent = ' p50 chain-side inclusion'; big.appendChild(unit); card.appendChild(big);
      const kv = document.createElement('dl'); kv.className = 'card-kv';
      const add = (label, value) => { const dt = document.createElement('dt'); dt.textContent = label; const dd = document.createElement('dd'); if (value instanceof Node) dd.appendChild(value); else dd.textContent = value; kv.append(dt, dd); };
      add('p95', inclusion(chain.metrics?.chainInclusion?.p95Ms));
      add('RPC accept p50', ms(chain.metrics?.rpcAccept?.p50Ms));
      add('Samples', `${chain.counts?.primary ?? 0} primary, ${chain.counts?.excluded ?? 0} excluded`);
      add('Fee per tx', hype(chain.gas?.feeWei?.mean));
      add('Per 1,000 tx', hype(chain.gas?.feePer1000TxWei, 6));
      add('Gas', chain.gas?.postingGas ? `${gasNumber(chain.gas.executionGas?.p50)} execution + ${gasNumber(chain.gas.postingGas.p50)} posting` : chain.gas?.executionGas ? `${gasNumber(chain.gas.executionGas.p50)} execution` : DASH);
      add('Success', pct(chain.successRate));
      add('Contract', link(shortHash(chain.contract?.address), chain.contract?.explorerUrl));
      card.appendChild(kv);
      holder.appendChild(card);
    });
  }

  function renderCompareTable(headId, bodyId, rows, data, { ratio: showRatio = false } = {}) {
    const list = chains(data);
    const head = el(headId); const body = el(bodyId);
    head.replaceChildren(); body.replaceChildren();
    const hr = head.insertRow();
    for (const label of ['Measure', ...list.map((chain) => chain.name), list.length === 2 ? (showRatio ? `${list[1].name} ÷ ${list[0].name}` : 'Difference') : null].filter(Boolean)) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; if (label !== 'Measure') th.className = 'num'; hr.appendChild(th); }
    for (const row of rows) {
      const tr = body.insertRow();
      if (row.secondary) tr.className = 'secondary';
      const th = document.createElement('th'); th.scope = 'row'; th.textContent = row.label;
      if (row.tag) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = row.tag; th.appendChild(tag); }
      tr.appendChild(th);
      const values = list.map((chain) => row.get(chain));
      for (const value of values) { const td = tr.insertCell(); td.className = 'num mono'; td.textContent = row.format(value); }
      if (list.length === 2) {
        const td = tr.insertCell(); td.className = 'num mono';
        if (showRatio) { const [x, y] = values.map((value) => (typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : finite(value))); td.textContent = x && y !== null && x > 0 && y > 0 && row.tag !== 'L2 only' && row.tag !== 'secondary' ? ratio(y / x) : DASH; }
        else td.textContent = row.diff && finite(values[0]) !== null && finite(values[1]) !== null ? signedMs(values[0] - values[1]) : DASH;
      }
    }
  }

  function renderMetrics(data) {
    const m = (key, field) => (chain) => chain.metrics?.[key]?.[field];
    renderCompareTable('metrics-head', 'metrics-body', [
      { label: 'Chain-side inclusion p50', get: m('chainInclusion', 'p50Ms'), format: inclusion, diff: true },
      { label: 'Chain-side inclusion p95', get: m('chainInclusion', 'p95Ms'), format: inclusion, diff: true },
      { label: 'RPC accept p50', get: m('rpcAccept', 'p50Ms'), format: ms, diff: true },
      { label: 'RPC accept p95', get: m('rpcAccept', 'p95Ms'), format: ms, diff: true },
      { label: 'Observed inclusion p50', tag: 'secondary, client-side', secondary: true, get: m('observedInclusion', 'p50Ms'), format: ms, diff: true },
      { label: 'Observed inclusion p95', tag: 'secondary, client-side', secondary: true, get: m('observedInclusion', 'p95Ms'), format: ms, diff: true },
      { label: 'Watcher RPC round trip p50', tag: 'secondary', secondary: true, get: m('watchRtt', 'p50Ms'), format: ms, diff: true },
      { label: 'Clock correction applied, median', tag: 'secondary', secondary: true, get: m('clockCorrection', 'p50Ms'), format: ms, diff: false },
      { label: 'Inclusion to 2-conf p50', tag: 'secondary, not meaningful', secondary: true, get: m('inclusionToTwoConf', 'p50Ms'), format: ms, diff: false },
      { label: 'Success rate', get: (chain) => chain.successRate, format: pct, diff: false },
      { label: 'Primary samples', get: (chain) => chain.counts?.primary, format: (value) => (finite(value) === null ? DASH : String(value)), diff: false },
      { label: 'Excluded samples', get: (chain) => chain.counts?.excluded, format: (value) => (finite(value) === null ? DASH : String(value)), diff: false },
    ], data);
    const g = (path) => (chain) => path.split('.').reduce((value, key) => value?.[key], chain.gas);
    renderCompareTable('gas-head', 'gas-body', [
      { label: 'Fee per transaction, mean', get: g('feeWei.mean'), format: (value) => hype(value) },
      { label: 'Fee per transaction, p50', get: g('feeWei.p50'), format: (value) => hype(value) },
      { label: 'Fee per transaction, p95', get: g('feeWei.p95'), format: (value) => hype(value) },
      { label: 'Fee per 1,000 transactions', get: g('feePer1000TxWei'), format: (value) => hype(value, 6) },
      { label: 'Gas used, p50', get: g('gasUsed.p50'), format: gasNumber },
      { label: 'Execution gas, p50', get: g('executionGas.p50'), format: gasNumber },
      { label: 'Posting gas, p50', tag: 'L2 only', get: g('postingGas.p50'), format: gasNumber },
      { label: 'Posting share of gas', tag: 'L2 only', get: g('postingShare'), format: pct },
      { label: 'Gas price, p50', get: g('gasPriceWei.p50'), format: gwei },
      { label: 'Gas price range', get: (chain) => (chain.gas?.gasPriceWei ? `${gwei(chain.gas.gasPriceWei.min)} – ${gwei(chain.gas.gasPriceWei.max)}` : null), format: (value) => value || DASH },
      { label: 'Settled transactions', get: g('settled'), format: (value) => (finite(value) === null ? DASH : String(value)) },
      { label: 'Gas breakdown coverage', tag: 'secondary', secondary: true, get: g('breakdownCoverage'), format: pct },
    ], data, { ratio: true });
  }

  function hourlyChart(data) {
    const list = chains(data);
    const hours = [...new Set(list.flatMap((chain) => (chain.hourly || []).map((entry) => entry.hour)))].sort();
    const rows = hours.map((hour) => [hour.replace('T', ' '), ...list.map((chain) => inclusion((chain.hourly || []).find((entry) => entry.hour === hour)?.chainInclusionP50Ms))]);
    const table = { caption: 'Chain-side inclusion p50 per UTC hour', headers: ['Hour', ...list.map((chain) => chain.name)], rows };
    const values = list.flatMap((chain) => (chain.hourly || []).map((entry) => finite(entry.chainInclusionP50Ms)).filter((value) => value !== null).map((value) => Math.max(0, value)));
    const summary = hours.length ? `${hours.length} hour${hours.length === 1 ? '' : 's'}. ${list.map((chain) => { const last = (chain.hourly || []).at(-1); return `${chain.name} latest hour p50 ${inclusion(last?.chainInclusionP50Ms)} over ${last?.count ?? 0} samples`; }).join('; ')}.` : 'No hourly data yet.';
    if (!values.length) return { summary, table };
    const yMax = niceMax(Math.max(...values));
    const x = (index) => (hours.length === 1 ? (M.left + W - M.right) / 2 : scale(0, hours.length - 1, M.left + 6, W - M.right - 6)(index));
    const y = scale(0, yMax, H - M.bottom, M.top);
    const svg = createSvg('Chain-side inclusion p50 per hour', summary);
    yAxis(svg, y, yMax, ms);
    xLabels(svg, [[M.left, hours[0].slice(11, 16), 'start'], [W - M.right, hours.at(-1).slice(11, 16), 'end']]);
    list.forEach((chain, index) => {
      const points = hours.map((hour, position) => { const value = finite((chain.hourly || []).find((entry) => entry.hour === hour)?.chainInclusionP50Ms); return value === null ? null : [x(position), y(Math.max(0, value))]; });
      let d = ''; let pen = false;
      for (const point of points) { if (!point) { pen = false; continue; } d += `${pen ? 'L' : 'M'}${point[0].toFixed(1)} ${point[1].toFixed(1)}`; pen = true; }
      node('path', { d, class: `series-${SERIES[index]}-line` }, svg);
      for (const point of points) if (point) node('circle', { cx: point[0], cy: point[1], r: 3, class: `series-${SERIES[index]}-mark` }, svg);
    });
    return { summary, svg, table, legend: list.map((chain, index) => ({ kind: `series-${SERIES[index]}-line`, label: chain.name })) };
  }

  function histogramChart(data) {
    const list = chains(data);
    const buckets = list[0]?.histogram?.buckets || [];
    const rows = buckets.map((bucket, index) => [`${bucket.fromMs}–${bucket.toMs} ms`, ...list.map((chain) => chain.histogram?.buckets?.[index]?.count ?? 0)]);
    rows.push([`≥ ${buckets.at(-1)?.toMs ?? DASH} ms`, ...list.map((chain) => chain.histogram?.overflowCount ?? 0)]);
    const table = { caption: 'Chain-side inclusion distribution (count per bucket)', headers: ['Bucket', ...list.map((chain) => chain.name)], rows };
    const shares = list.map((chain) => { const total = (chain.histogram?.buckets || []).reduce((sum, bucket) => sum + bucket.count, 0) + (chain.histogram?.overflowCount || 0); return (chain.histogram?.buckets || []).map((bucket) => (total ? bucket.count / total : 0)); });
    const any = shares.some((share) => share.some((value) => value > 0));
    const summary = any ? `Share of samples per ${list[0]?.histogram?.bucketMs ?? 250} ms bucket. ${list.map((chain, index) => { const best = shares[index].indexOf(Math.max(...shares[index])); return `${chain.name} most common ${buckets[best]?.fromMs ?? 0}–${buckets[best]?.toMs ?? 0} ms`; }).join('; ')}.` : 'No samples yet.';
    if (!any) return { summary, table };
    const yMax = niceMax(Math.max(...shares.flat()));
    const band = (W - M.left - M.right) / buckets.length;
    const y = scale(0, yMax, H - M.bottom, M.top);
    const svg = createSvg('Chain-side inclusion distribution', summary);
    yAxis(svg, y, yMax, (value) => `${Math.round(value * 100)}%`);
    xLabels(svg, [[M.left, '0 ms', 'start'], [W - M.right, `${buckets.at(-1).toMs} ms`, 'end']]);
    shares.forEach((share, series) => share.forEach((value, index) => {
      if (!value) return;
      const width = Math.max(1, band / 2 - 1);
      const top = y(value);
      const bar = node('rect', { x: M.left + band * index + series * (band / 2) + 0.5, y: top, width, height: H - M.bottom - top, rx: 1, class: `series-${SERIES[series]}-bar` }, svg);
      textNode('title', {}, `${list[series].name} ${buckets[index].fromMs}–${buckets[index].toMs} ms: ${(value * 100).toFixed(1)}%`, bar);
    }));
    return { summary, svg, table, legend: list.map((chain, index) => ({ kind: `series-${SERIES[index]}-bar`, label: chain.name })) };
  }

  function seriesChart(data) {
    const list = chains(data);
    const points = list.map((chain) => (chain.series || []).map((point) => ({ at: Date.parse(point.at), value: finite(point.chainInclusionMs) })).filter((point) => Number.isFinite(point.at) && point.value !== null));
    const all = points.flat();
    const rows = list.flatMap((chain, index) => points[index].slice(-60).map((point) => [chain.name, utc(new Date(point.at).toISOString()), inclusion(point.value)]));
    const table = { caption: 'Latest per-transaction chain-side inclusion (up to 60 per chain)', headers: ['Chain', 'Submitted (UTC)', 'Inclusion'], rows };
    const summary = all.length ? `${list.map((chain, index) => `${points[index].length} ${chain.name} transactions`).join(' and ')} plotted by submission time.` : 'No transactions yet.';
    if (!all.length) return { summary, table };
    const t0 = Math.min(...all.map((point) => point.at));
    const t1 = Math.max(...all.map((point) => point.at));
    const yMax = niceMax(Math.max(...all.map((point) => point.value), 1));
    const x = scale(t0, t1 === t0 ? t0 + 60000 : t1, M.left + 6, WIDE - M.right - 6);
    const y = scale(0, yMax, H - M.bottom, M.top);
    const svg = createSvg('Per-transaction chain-side inclusion', summary, H, WIDE);
    yAxis(svg, y, yMax, ms, WIDE);
    xLabels(svg, [[M.left, clock(t0), 'start'], [WIDE - M.right, clock(t1), 'end']]);
    points.forEach((series, index) => { const group = node('g', {}, svg); for (const point of series) node('circle', { cx: x(point.at).toFixed(1), cy: y(Math.max(0, point.value)).toFixed(1), r: 2.5, class: `series-${SERIES[index]}-mark` }, group); });
    return { summary, svg, table, legend: list.map((chain, index) => ({ kind: `series-${SERIES[index]}-mark`, label: chain.name })) };
  }

  function breakdownChart(data) {
    const list = chains(data);
    const rows = list.map((chain) => ({ name: chain.name, execution: Number(chain.gas?.executionGas?.p50 ?? NaN), posting: chain.gas?.postingGas ? Number(chain.gas.postingGas.p50) : 0, fee: chain.gas?.feeWei?.p50 }));
    const table = { caption: 'Median gas per transaction by component', headers: ['Chain', 'Execution gas', 'Posting gas', 'Total', 'Fee p50'], rows: rows.map((row) => [row.name, Number.isFinite(row.execution) ? row.execution.toLocaleString('en-US') : DASH, row.posting ? row.posting.toLocaleString('en-US') : '0', Number.isFinite(row.execution) ? (row.execution + row.posting).toLocaleString('en-US') : DASH, hype(row.fee)]) };
    const valid = rows.filter((row) => Number.isFinite(row.execution));
    const delta = finite(data?.comparison?.executionGasDelta);
    const summary = valid.length === 2 ? `${rows.map((row) => `${row.name}: ${(row.execution + row.posting).toLocaleString('en-US')} gas (${row.execution.toLocaleString('en-US')} execution${row.posting ? `, ${row.posting.toLocaleString('en-US')} posting` : ''})`).join('; ')}. ${delta === 0 ? 'Execution gas is identical, as expected for the same bytecode.' : delta === null ? '' : `Execution gas differs by ${Math.abs(delta).toLocaleString('en-US')}; check the contract deployments.`}` : 'No settled transactions with a gas breakdown yet.';
    if (valid.length !== 2) return { summary, table };
    const height = 130;
    const max = Math.max(...rows.map((row) => row.execution + row.posting));
    const labelW = 150;
    const x = scale(0, niceMax(max), labelW, WIDE - M.right - 90);
    const svg = createSvg('Gas per transaction by component', summary, height, WIDE);
    rows.forEach((row, index) => {
      const top = 18 + index * 52;
      textNode('text', { x: 0, y: top + 17, class: 'row-label' }, row.name, svg);
      const exec = node('rect', { x: labelW, y: top, width: Math.max(1, x(row.execution) - labelW), height: 26, rx: 3, class: `series-${SERIES[index]}-bar` }, svg);
      textNode('title', {}, `${row.name} execution gas ${row.execution.toLocaleString('en-US')}`, exec);
      if (row.posting) { const post = node('rect', { x: x(row.execution), y: top, width: Math.max(1, x(row.execution + row.posting) - x(row.execution)), height: 26, rx: 3, class: 'posting-bar' }, svg); textNode('title', {}, `${row.name} posting gas ${row.posting.toLocaleString('en-US')}`, post); }
      textNode('text', { x: x(row.execution + row.posting) + 8, y: top + 17, class: 'value-label' }, (row.execution + row.posting).toLocaleString('en-US'), svg);
    });
    return { summary, svg, table, legend: [{ kind: 'series-a-bar', label: `${list[0].name} execution` }, { kind: 'series-b-bar', label: `${list[1].name} execution` }, { kind: 'posting-bar', label: 'Posting to parent chain' }] };
  }

  function feeChart(data) {
    const list = chains(data);
    const points = list.map((chain) => (chain.gas?.series || []).map((point) => ({ at: Date.parse(point.at), fee: typeof point.feeWei === 'string' && /^[0-9]+$/.test(point.feeWei) ? Number(point.feeWei) / 1e18 : null })).filter((point) => Number.isFinite(point.at) && point.fee > 0));
    const all = points.flat();
    const table = { caption: 'Latest fee per transaction (up to 60 per chain, HYPE)', headers: ['Chain', 'Submitted (UTC)', 'Fee HYPE'], rows: list.flatMap((chain, index) => points[index].slice(-60).map((point) => [chain.name, utc(new Date(point.at).toISOString()), point.fee.toExponential(3)])) };
    const summary = all.length ? `${list.map((chain, index) => `${points[index].length} ${chain.name} fees`).join(' and ')}. Log scale: each gridline is a factor of 10.` : 'No settled fees yet.';
    if (!all.length) return { summary, table };
    const lo = Math.floor(Math.log10(Math.min(...all.map((point) => point.fee))));
    const hi = Math.ceil(Math.log10(Math.max(...all.map((point) => point.fee)))) + (Math.min(...all.map((p) => p.fee)) === Math.max(...all.map((p) => p.fee)) ? 1 : 0);
    const t0 = Math.min(...all.map((point) => point.at)); const t1 = Math.max(...all.map((point) => point.at));
    const x = scale(t0, t1 === t0 ? t0 + 60000 : t1, M.left + 6, W - M.right - 6);
    const y = scale(lo, Math.max(hi, lo + 1), H - M.bottom, M.top);
    const svg = createSvg('Fee per transaction, log scale', summary);
    const group = node('g', { class: 'axis', 'aria-hidden': 'true' }, svg);
    for (let exp = lo; exp <= Math.max(hi, lo + 1); exp += 1) { node('line', { x1: M.left, x2: W - M.right, y1: y(exp), y2: y(exp), class: exp === lo ? 'baseline' : 'gridline' }, group); textNode('text', { x: M.left - 6, y: y(exp) + 3, 'text-anchor': 'end' }, `1e${exp}`, group); }
    xLabels(svg, [[M.left, clock(t0), 'start'], [W - M.right, clock(t1), 'end']]);
    points.forEach((series, index) => { const marks = node('g', {}, svg); for (const point of series) node('circle', { cx: x(point.at).toFixed(1), cy: y(Math.log10(point.fee)).toFixed(1), r: 2.5, class: `series-${SERIES[index]}-mark` }, marks); });
    return { summary, svg, table, legend: list.map((chain, index) => ({ kind: `series-${SERIES[index]}-mark`, label: `${chain.name} (HYPE, log)` })) };
  }

  function priceChart(data) {
    const list = chains(data);
    const hours = [...new Set(list.flatMap((chain) => (chain.gas?.hourly || []).map((entry) => entry.hour)))].sort();
    const value = (chain, hour) => { const entry = (chain.gas?.hourly || []).find((item) => item.hour === hour); return entry && /^[0-9]+$/.test(entry.gasPriceP50Wei ?? '') ? Number(entry.gasPriceP50Wei) / 1e9 : null; };
    const table = { caption: 'Median gas price per UTC hour (gwei)', headers: ['Hour', ...list.map((chain) => chain.name)], rows: hours.map((hour) => [hour.replace('T', ' '), ...list.map((chain) => { const v = value(chain, hour); return v === null ? DASH : v.toFixed(4); })]) };
    const values = hours.flatMap((hour) => list.map((chain) => value(chain, hour))).filter((v) => v !== null);
    const summary = values.length ? `${list.map((chain) => { const last = value(chain, hours.at(-1)); return `${chain.name} latest ${last === null ? DASH : `${last.toFixed(4)} gwei`}`; }).join('; ')}.` : 'No gas prices yet.';
    if (!values.length) return { summary, table };
    const yMax = niceMax(Math.max(...values));
    const x = (index) => (hours.length === 1 ? (M.left + W - M.right) / 2 : scale(0, hours.length - 1, M.left + 6, W - M.right - 6)(index));
    const y = scale(0, yMax, H - M.bottom, M.top);
    const svg = createSvg('Gas price per hour', summary);
    yAxis(svg, y, yMax, (v) => `${v.toFixed(v < 0.1 ? 3 : 2)} gwei`);
    xLabels(svg, [[M.left, hours[0].slice(11, 16), 'start'], [W - M.right, hours.at(-1).slice(11, 16), 'end']]);
    list.forEach((chain, index) => {
      let d = ''; let pen = false;
      hours.forEach((hour, position) => { const v = value(chain, hour); if (v === null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(position).toFixed(1)} ${y(v).toFixed(1)}`; pen = true; node('circle', { cx: x(position), cy: y(v), r: 3, class: `series-${SERIES[index]}-mark` }, svg); });
      node('path', { d, class: `series-${SERIES[index]}-line` }, svg);
    });
    return { summary, svg, table, legend: list.map((chain, index) => ({ kind: `series-${SERIES[index]}-line`, label: chain.name })) };
  }

  function renderTransactions(data) {
    const holder = el('tx-tables');
    holder.replaceChildren();
    for (const chain of chains(data)) {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap tx-table';
      wrap.setAttribute('tabindex', '0');
      wrap.setAttribute('role', 'region');
      wrap.setAttribute('aria-label', `${chain.name} recent transactions`);
      const table = document.createElement('table');
      table.className = 'dense';
      const cap = document.createElement('caption'); cap.textContent = chain.name; table.appendChild(cap);
      const head = table.createTHead().insertRow();
      for (const label of ['Transaction', 'Block', 'Status', 'Inclusion', 'Observed']) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; head.appendChild(th); }
      const body = table.createTBody();
      for (const tx of (chain.recent || []).slice(0, 20)) {
        const tr = body.insertRow();
        const hashCell = tr.insertCell(); hashCell.className = 'mono'; hashCell.appendChild(link(shortHash(tx.hash), tx.explorerUrl));
        const block = tr.insertCell(); block.className = 'mono'; block.textContent = tx.blockNumber || DASH;
        const state = tr.insertCell(); const tag = document.createElement('span'); tag.className = 'status-tag'; tag.dataset.tone = ['finalized', 'included'].includes(tx.status) ? 'ok' : tx.status === 'reverted' ? 'stop' : 'warn'; tag.textContent = tx.status || 'unknown'; state.appendChild(tag);
        const inc = tr.insertCell(); inc.className = 'mono num'; inc.textContent = inclusion(tx.chainInclusionMs);
        const obs = tr.insertCell(); obs.className = 'mono num'; obs.textContent = ms(tx.observedInclusionMs);
      }
      wrap.appendChild(table);
      holder.appendChild(wrap);
    }
  }

  function renderFeed(state) {
    const target = el('feed-status');
    target.dataset.feed = state;
    target.textContent = state === 'live' ? 'live' : state === 'render_error' ? 'render failed' : 'unreachable';
  }

  function render(data) {
    setText('generated-at', utc(data.generatedAt));
    renderVerdict(data);
    renderCards(data);
    renderMetrics(data);
    renderChart('chart-hourly', hourlyChart(data));
    renderChart('chart-histogram', histogramChart(data));
    renderChart('chart-series', seriesChart(data));
    renderChart('chart-breakdown', breakdownChart(data));
    renderChart('chart-fee', feeChart(data));
    renderChart('chart-price', priceChart(data));
    setText('footer-generated', data.generatedAt ? `data ${utc(data.generatedAt)}` : null);
    renderTransactions(data);
    renderFeed('live');
  }

  async function refresh() {
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const separator = ENDPOINT.includes('?') ? '&' : '?';
      const response = await fetch(`${ENDPOINT}${separator}v=${Date.now()}`, { method: 'GET', cache: 'no-store', credentials: 'omit', signal: controller.signal });
      if (stopped) return;
      if (!response.ok) { renderFeed('down'); return; }
      const data = await response.json();
      try { render(data); } catch { renderFeed('render_error'); }
    } catch { if (!stopped) renderFeed('down'); } finally { clearTimeout(abort); }
  }

  function schedule() { clearTimeout(timer); if (!stopped) timer = setTimeout(tick, POLL_MS); }

  async function tick() {
    if (inflight) return inflight;
    if (document.visibilityState === 'hidden') { schedule(); return undefined; }
    inflight = refresh();
    try { await inflight; } finally { inflight = null; }
    schedule();
    return undefined;
  }

  const navLinks = [...document.querySelectorAll('.nav-list a')];
  const markCurrent = (id) => { for (const anchor of navLinks) { if (anchor.getAttribute('href') === `#${id}`) anchor.setAttribute('aria-current', 'true'); else anchor.removeAttribute('aria-current'); } };
  for (const anchor of navLinks) anchor.addEventListener('click', () => markCurrent(anchor.getAttribute('href').slice(1)));
  if ('IntersectionObserver' in window) {
    const visible = new Map();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0);
      const order = navLinks.map((anchor) => anchor.getAttribute('href').slice(1));
      const best = order.find((id) => (visible.get(id) || 0) > 0);
      if (best) markCurrent(best);
    }, { rootMargin: '-56px 0px -55% 0px', threshold: [0, 0.01, 0.25] });
    for (const anchor of navLinks) { const section = document.getElementById(anchor.getAttribute('href').slice(1)); if (section) observer.observe(section); }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) { stopped = false; tick(); } });
  tick();
})();
