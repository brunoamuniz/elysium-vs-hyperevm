(() => {
  'use strict';

  const ENDPOINT = '/api/dashboard';
  const POLL_MS = 15000;
  const TIMEOUT_MS = 10000;
  const DASH = '–';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const W = 560;
  const H = 220;
  const M = { top: 12, right: 14, bottom: 28, left: 48 };
  const SERIES_CAP = 300;
  const MINUTE_CAP = 60;
  const TX_CAP = 25;
  const HEALTH_CAP = 60;
  const TABLE_CAP = 60;
  const ROLLING_WINDOW = 20;
  const ROLLING_MIN = 5;

  const SERVICE_TONE = { active: 'ok', pending: 'warn', stale: 'warn', not_deployed: 'warn', reconcile_required: 'stop', halted: 'stop', unknown: 'warn' };
  const STATUS_TONE = { finalized: 'ok', confirmed: 'ok', included: 'ok', broadcast: 'warn', submitted: 'warn', prepared: 'warn', reverted: 'stop', reconcile_required: 'stop', unknown: 'warn' };
  const SERVICE_TEXT = {
    active: 'active', pending: 'pending action', stale: 'stale', not_deployed: 'not deployed',
    reconcile_required: 'reconcile required', halted: 'halted', unknown: 'unknown',
  };
  const PHASE_ROWS = [
    ['submit_to_accept', 'Submit to RPC accept'],
    ['submit_to_inclusion', 'Submit to inclusion (observed)'],
    ['chain_inclusion', 'Submit to block timestamp'],
    ['inclusion_to_2conf', 'Inclusion to 2-conf'],
    ['end_to_end', 'End-to-end (submit to 2-conf)'],
  ];
  const POINT_KINDS = {
    final: { label: 'Finalized', cls: 'mark-final', shape: 'circle' },
    pending: { label: 'Pending', cls: 'mark-pending', shape: 'square' },
    reverted: { label: 'Reverted', cls: 'mark-reverted', shape: 'triangle' },
    stop: { label: 'Reconcile required or unknown', cls: 'mark-stop', shape: 'diamond' },
    recovered: { label: 'Recovered, migrated or drift (excluded from percentiles)', cls: 'mark-recovered', shape: 'circle' },
  };

  let timer = null;
  let stopped = false;
  let lastData = null;
  let latestRpcState = 'unknown';
  let inflight = null;
  let uid = 0;
  const healthLog = [];

  const el = (id) => document.getElementById(id);

  function setText(id, value) {
    const node = el(id);
    if (node) node.textContent = value === null || value === undefined || value === '' ? DASH : String(value);
  }

  function setTone(id, tone) {
    const node = el(id);
    if (node) node.dataset.tone = tone || 'none';
  }

  function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
  function list(value, cap) { return Array.isArray(value) ? value.slice(-cap) : []; }

  function shortHash(value) {
    if (typeof value !== 'string' || value.length < 18) return value || DASH;
    return `${value.slice(0, 10)}…${value.slice(-8)}`;
  }

  function weiToHype(wei, digits = 6) {
    if (typeof wei !== 'string' || !/^[0-9]{1,78}$/.test(wei)) return null;
    const padded = wei.padStart(19, '0');
    const whole = padded.slice(0, padded.length - 18).replace(/^0+(?=[0-9])/, '');
    const fraction = padded.slice(padded.length - 18).slice(0, digits);
    return `${whole}.${fraction}`;
  }

  function weiNumber(wei) {
    if (typeof wei !== 'string' || !/^[0-9]{1,78}$/.test(wei)) return null;
    const value = Number(wei) / 1e18;
    return Number.isFinite(value) ? value : null;
  }

  function millis(value) {
    const ms = finite(value);
    if (ms === null) return null;
    return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 100000 ? 0 : 1)} s` : `${Math.round(ms)} ms`;
  }

  function percent(value) {
    const ratio = finite(value);
    return ratio === null ? null : `${(ratio * 100).toFixed(1)}%`;
  }

  function epoch(iso) {
    if (typeof iso !== 'string' || iso.length > 40) return null;
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function shortTime(iso) {
    const ms = epoch(iso);
    return ms === null ? null : new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  }

  function clock(ms) { return new Date(ms).toISOString().slice(11, 16); }
  function minuteLabel(value) { return typeof value === 'string' && value.length >= 16 ? value.slice(11, 16) : DASH; }

  function niceMax(value) {
    if (!(value > 0)) return 1;
    const exponent = 10 ** Math.floor(Math.log10(value));
    for (const step of [1, 2, 2.5, 5, 10]) if (value <= step * exponent) return step * exponent;
    return 10 * exponent;
  }

  function scale(d0, d1, r0, r1) {
    const span = d1 - d0 || 1;
    return (value) => r0 + ((value - d0) / span) * (r1 - r0);
  }

  function node(tag, attrs, parent) {
    const created = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs || {})) created.setAttribute(key, String(value));
    if (parent) parent.appendChild(created);
    return created;
  }

  function textNode(tag, attrs, text, parent) {
    const created = node(tag, attrs, parent);
    created.textContent = text;
    return created;
  }

  function createSvg(title, desc, height = H) {
    uid += 1;
    const svg = node('svg', { viewBox: `0 0 ${W} ${height}`, role: 'img', 'aria-labelledby': `svg-t-${uid} svg-d-${uid}`, focusable: 'false' });
    textNode('title', { id: `svg-t-${uid}` }, title, svg);
    textNode('desc', { id: `svg-d-${uid}` }, desc, svg);
    return svg;
  }

  function marker(parent, kind, x, y, size, label) {
    const spec = POINT_KINDS[kind];
    let shape;
    if (spec.shape === 'square') shape = node('rect', { x: x - size, y: y - size, width: size * 2, height: size * 2, rx: 1, class: spec.cls }, parent);
    else if (spec.shape === 'diamond') shape = node('path', { d: `M${x} ${y - size * 1.3}L${x + size * 1.3} ${y}L${x} ${y + size * 1.3}L${x - size * 1.3} ${y}Z`, class: spec.cls }, parent);
    else if (spec.shape === 'triangle') shape = node('path', { d: `M${x} ${y - size * 1.2}L${x + size * 1.1} ${y + size * 0.8}L${x - size * 1.1} ${y + size * 0.8}Z`, class: spec.cls }, parent);
    else shape = node('circle', { cx: x, cy: y, r: size, class: spec.cls }, parent);
    if (label) textNode('title', {}, label, shape);
    return shape;
  }

  function yAxis(svg, y, max, format, ticks = 4) {
    const group = node('g', { class: 'axis', 'aria-hidden': 'true' }, svg);
    for (let index = 0; index <= ticks; index += 1) {
      const value = (max / ticks) * index;
      const py = y(value);
      node('line', { x1: M.left, x2: W - M.right, y1: py, y2: py, class: index === 0 ? 'baseline' : 'gridline' }, group);
      textNode('text', { x: M.left - 6, y: py + 3, 'text-anchor': 'end' }, format(value), group);
    }
  }

  function xLabels(svg, labels, height = H) {
    const group = node('g', { class: 'axis', 'aria-hidden': 'true' }, svg);
    for (const [x, text, anchor] of labels) textNode('text', { x, y: height - 8, 'text-anchor': anchor }, text, group);
  }

  function linePath(points) {
    let d = '';
    let pen = false;
    for (const point of points) {
      if (point === null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${point[0].toFixed(1)} ${point[1].toFixed(1)}`;
      pen = true;
    }
    return d;
  }

  function legendSwatch(item) {
    const svg = node('svg', { width: 18, height: 12, viewBox: '0 0 18 12', 'aria-hidden': 'true', focusable: 'false' });
    if (item.kind) marker(svg, item.kind, 9, 6, 4);
    else if (item.line) node('path', { d: 'M1 6H17', class: item.line }, svg);
    else if (item.bar) node('rect', { x: 3, y: 1, width: 12, height: 10, rx: 2, class: item.bar }, svg);
    return svg;
  }

  function renderLegend(figure, items) {
    const legend = figure.querySelector('[data-legend]');
    if (!legend) return;
    legend.replaceChildren();
    for (const item of items) {
      const li = document.createElement('li');
      li.appendChild(legendSwatch(item));
      const span = document.createElement('span');
      span.textContent = item.label;
      li.appendChild(span);
      legend.appendChild(li);
    }
  }

  function renderDataTable(figure, caption, headers, rows) {
    const holder = figure.querySelector('[data-table]');
    if (!holder) return;
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
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const header of headers) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = header;
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    table.appendChild(head);
    const body = document.createElement('tbody');
    for (const row of rows.slice(-TABLE_CAP)) {
      const tr = document.createElement('tr');
      for (const value of row) {
        const td = document.createElement('td');
        td.textContent = value === null || value === undefined || value === '' ? DASH : String(value);
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    table.appendChild(body);
    wrap.appendChild(table);
    holder.appendChild(wrap);
  }

  function renderChart(id, { summary, svg, emptyText, legend, table }) {
    const figure = el(id);
    if (!figure) return;
    const summaryNode = figure.querySelector('.chart-summary');
    if (summaryNode) summaryNode.textContent = summary;
    const plot = figure.querySelector('[data-plot]');
    if (plot) {
      plot.replaceChildren();
      if (svg) plot.appendChild(svg);
      else {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = emptyText || 'No data yet.';
        plot.appendChild(empty);
      }
    }
    renderLegend(figure, svg ? legend : []);
    if (table) renderDataTable(figure, table.caption, table.headers, table.rows);
  }

  function pointKind(point) {
    if (point.status === 'reverted') return 'reverted';
    if (point.status === 'reconcile_required' || point.status === 'unknown') return 'stop';
    if (point.quality !== 'primary') return 'recovered';
    if (point.status === 'finalized') return 'final';
    return 'pending';
  }

  function nearestRank(sorted, p) {
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
  }

  function rollingPercentiles(points) {
    const window = [];
    return points.map((point) => {
      if (point.kind === 'final' && point.value !== null) {
        window.push(point.value);
        if (window.length > ROLLING_WINDOW) window.shift();
      }
      if (window.length < ROLLING_MIN) return { p50: null, p95: null };
      const sorted = [...window].sort((a, b) => a - b);
      return { p50: nearestRank(sorted, 50), p95: nearestRank(sorted, 95) };
    });
  }

  function latencyChart(benchmark) {
    const incoming = list(benchmark?.series, SERIES_CAP);
    const points = [];
    for (const point of incoming) {
      const at = epoch(point?.at);
      if (at === null) continue;
      points.push({ at, kind: pointKind(point), value: finite(point.endToEndMs), status: point.status, quality: point.quality });
    }
    const plotted = points.filter((point) => point.value !== null);
    const unplotted = points.length - plotted.length;
    const rolling = rollingPercentiles(points);
    const last = [...rolling].reverse().find((entry) => entry.p50 !== null);
    const counts = { final: 0, pending: 0, reverted: 0, stop: 0, recovered: 0 };
    for (const point of points) counts[point.kind] += 1;
    const summary = points.length
      ? `${points.length} submissions: ${counts.final} finalized primary, ${counts.pending} pending, ${counts.reverted} reverted, ${counts.stop} reconcile required or unknown, ${counts.recovered} recovered or migrated. ${unplotted} have no end-to-end latency yet. ${last ? `Latest rolling p50 ${millis(last.p50)}, p95 ${millis(last.p95)} over the last ${ROLLING_WINDOW} primary samples.` : `Rolling percentiles need ${ROLLING_MIN} primary samples.`}`
      : 'No submissions with timing data yet.';
    const table = {
      caption: 'End-to-end latency per submission (latest rows)',
      headers: ['Submitted (UTC)', 'Status', 'Timing', 'End-to-end', 'Rolling p50', 'Rolling p95'],
      rows: points.map((point, index) => [shortTime(new Date(point.at).toISOString()), point.status, point.quality, millis(point.value), millis(rolling[index].p50), millis(rolling[index].p95)]),
    };
    if (!plotted.length) return { summary, table };
    const t0 = points[0].at;
    const t1 = points[points.length - 1].at;
    const yMax = niceMax(Math.max(...plotted.map((point) => point.value), ...rolling.map((entry) => entry.p95 || 0)));
    const x = scale(t0, t1 === t0 ? t0 + 60000 : t1, M.left + 6, W - M.right - 6);
    const y = scale(0, yMax, H - M.bottom, M.top);
    const svg = createSvg('Latency over time', summary);
    yAxis(svg, y, yMax, (value) => millis(value));
    xLabels(svg, [[M.left, clock(t0), 'start'], [W - M.right, clock(t1), 'end']]);
    const marks = node('g', {}, svg);
    for (const point of points) {
      if (point.value === null) continue;
      marker(marks, point.kind, x(point.at), y(point.value), plotted.length > 120 ? 2.5 : 3.5, `${clock(point.at)} ${POINT_KINDS[point.kind].label}: ${millis(point.value)}`);
    }
    const legend = Object.entries(POINT_KINDS).filter(([kind]) => counts[kind] > 0).map(([kind, spec]) => ({ kind, label: spec.label }));
    if (last) {
      node('path', { d: linePath(points.map((point, index) => (rolling[index].p95 === null ? null : [x(point.at), y(rolling[index].p95)]))), class: 'line-p95' }, svg);
      node('path', { d: linePath(points.map((point, index) => (rolling[index].p50 === null ? null : [x(point.at), y(rolling[index].p50)]))), class: 'line-p50' }, svg);
      legend.push({ line: 'line-p50', label: `Rolling p50 (${ROLLING_WINDOW})` }, { line: 'line-p95', label: `Rolling p95 (${ROLLING_WINDOW})` });
    }
    return { summary, svg, legend, table };
  }

  function minuteChart(benchmark) {
    const minutes = list(benchmark?.minutes, MINUTE_CAP);
    const withLatency = minutes.filter((minute) => finite(minute.minLatencyMs) !== null && finite(minute.maxLatencyMs) !== null);
    const spreads = withLatency.map((minute) => minute.maxLatencyMs - minute.minLatencyMs);
    const widest = spreads.length ? Math.max(...spreads) : null;
    const summary = minutes.length
      ? `${minutes.length} minutes shown, ${withLatency.length} with primary latency. ${widest !== null ? `Widest min-to-max spread ${millis(widest)}.` : ''} Planned ${minutes.reduce((sum, m) => sum + (m.plannedCount || 0), 0)}, submitted ${minutes.reduce((sum, m) => sum + (m.submitted || 0), 0)}, finalized ${minutes.reduce((sum, m) => sum + (m.finalized || 0), 0)}, skipped ${minutes.reduce((sum, m) => sum + (m.skipped || 0), 0)}.`
      : 'No per-minute batches yet.';
    const table = {
      caption: 'Per-minute batch latency and counts (UTC)',
      headers: ['Minute', 'Planned', 'Submitted', 'Included', 'Finalized', 'Skipped', 'Min', 'Mean', 'Max'],
      rows: minutes.map((m) => [m.minute, m.plannedCount, m.submitted, m.included, m.finalized, m.skipped, millis(m.minLatencyMs), millis(m.meanLatencyMs), millis(m.maxLatencyMs)]),
    };
    if (!withLatency.length) return { summary, table, emptyText: 'No minutes with primary end-to-end latency yet.' };
    const yMax = niceMax(Math.max(...withLatency.map((m) => m.maxLatencyMs)));
    const band = (W - M.left - M.right) / minutes.length;
    const x = (index) => M.left + band * (index + 0.5);
    const y = scale(0, yMax, H - M.bottom, M.top);
    const svg = createSvg('Per-minute latency consistency', summary);
    yAxis(svg, y, yMax, (value) => millis(value));
    xLabels(svg, [[M.left, minuteLabel(minutes[0].minute), 'start'], [W - M.right, minuteLabel(minutes[minutes.length - 1].minute), 'end']]);
    const marks = node('g', {}, svg);
    minutes.forEach((m, index) => {
      if (finite(m.minLatencyMs) === null || finite(m.maxLatencyMs) === null) return;
      const group = node('g', {}, marks);
      textNode('title', {}, `${m.minute}: min ${millis(m.minLatencyMs)}, mean ${millis(m.meanLatencyMs)}, max ${millis(m.maxLatencyMs)}; ${m.finalized}/${m.plannedCount || m.submitted} finalized`, group);
      node('line', { x1: x(index), x2: x(index), y1: y(m.minLatencyMs), y2: y(m.maxLatencyMs), class: 'range' }, group);
      if (finite(m.meanLatencyMs) !== null) node('circle', { cx: x(index), cy: y(m.meanLatencyMs), r: 4, class: 'mean-dot' }, group);
    });
    return { summary, svg, legend: [{ line: 'range', label: 'Min to max' }, { kind: 'final', label: 'Mean' }], table };
  }

  function rebin(histogram, target) {
    const base = histogram.bucketMs;
    const factor = target / base;
    if (!Number.isInteger(factor) || factor < 1) return null;
    const buckets = [];
    for (const bucket of histogram.buckets) {
      const index = Math.floor(bucket.fromMs / target);
      if (!buckets[index]) buckets[index] = { fromMs: index * target, toMs: (index + 1) * target, count: 0 };
      buckets[index].count += bucket.count;
    }
    return Array.from({ length: buckets.length }, (_, index) => buckets[index] || { fromMs: index * target, toMs: (index + 1) * target, count: 0 });
  }

  function histogramChart(benchmark) {
    const source = benchmark?.histogram;
    const base = finite(source?.bucketMs);
    const select = el('bucket-select');
    const clean = {
      bucketMs: base,
      overflowCount: finite(source?.overflowCount) || 0,
      buckets: list(source?.buckets, 40).filter((b) => finite(b?.fromMs) !== null && finite(b?.toMs) !== null && finite(b?.count) !== null),
    };
    if (select && base) {
      for (const option of select.options) option.disabled = Number(option.value) % base !== 0 || Number(option.value) < base;
      if (select.selectedOptions[0]?.disabled) select.value = String(base);
    }
    const target = select ? Number(select.value) : base;
    const buckets = base ? rebin(clean, target) || clean.buckets : [];
    const total = buckets.reduce((sum, b) => sum + b.count, 0) + clean.overflowCount;
    const mode = buckets.reduce((best, b) => (b.count > (best?.count || 0) ? b : best), null);
    const summary = total
      ? `${total} primary end-to-end samples in ${millis(target)} buckets. ${mode ? `Most common range ${millis(mode.fromMs)} to ${millis(mode.toMs)} (${mode.count}).` : 'No samples fall inside the bucketed range.'} ${clean.overflowCount} beyond the last bucket.`
      : 'No primary end-to-end samples yet.';
    const table = {
      caption: `Primary end-to-end latency histogram, ${millis(target) || DASH} buckets`,
      headers: ['From', 'To', 'Count'],
      rows: buckets.map((b) => [millis(b.fromMs), millis(b.toMs), b.count]).concat(clean.overflowCount ? [[millis(buckets.length ? buckets[buckets.length - 1].toMs : 0), 'beyond', clean.overflowCount]] : []),
    };
    if (!mode) return { summary, table, emptyText: total ? 'All samples are beyond the last bucket.' : undefined };
    const yMax = niceMax(Math.max(...buckets.map((b) => b.count), 1));
    const band = (W - M.left - M.right) / buckets.length;
    const y = scale(0, yMax, H - M.bottom, M.top);
    const svg = createSvg('Latency distribution', summary);
    yAxis(svg, y, yMax, (value) => String(Math.round(value)));
    xLabels(svg, [[M.left, millis(buckets[0].fromMs), 'start'], [W - M.right, millis(buckets[buckets.length - 1].toMs), 'end']]);
    const marks = node('g', {}, svg);
    buckets.forEach((b, index) => {
      if (!b.count) return;
      const top = y(b.count);
      const bar = node('rect', { x: M.left + band * index + 1, y: top, width: Math.max(1, band - 2), height: H - M.bottom - top, rx: Math.min(3, band / 4), class: 'bar' }, marks);
      textNode('title', {}, `${millis(b.fromMs)} to ${millis(b.toMs)}: ${b.count}`, bar);
    });
    return { summary, svg, legend: [], table };
  }

  function throughputChart(benchmark) {
    const minutes = list(benchmark?.minutes, MINUTE_CAP);
    const sum = (key) => minutes.reduce((total, m) => total + (finite(m[key]) || 0), 0);
    const peakPending = minutes.reduce((max, m) => Math.max(max, finite(m.pending) || 0), 0);
    const summary = minutes.length
      ? `Last ${minutes.length} minutes: ${sum('submitted')} submitted, ${sum('included')} included, ${sum('finalized')} finalized, ${sum('reverted')} reverted. Peak pending depth ${peakPending} in one minute.`
      : 'No per-minute activity yet.';
    const table = {
      caption: 'Per-minute throughput and pending depth (UTC)',
      headers: ['Minute', 'Submitted', 'Included', 'Finalized', 'Reverted', 'Pending'],
      rows: minutes.map((m) => [m.minute, m.submitted, m.included, m.finalized, m.reverted, m.pending]),
    };
    if (!minutes.length) return { summary, table };
    const yMax = niceMax(Math.max(1, ...minutes.map((m) => Math.max(m.submitted || 0, m.finalized || 0, m.pending || 0, m.plannedCount || 0))));
    const band = (W - M.left - M.right) / minutes.length;
    const x = (index) => M.left + band * (index + 0.5);
    const y = scale(0, yMax, H - M.bottom, M.top);
    const svg = createSvg('Throughput and pending depth', summary);
    yAxis(svg, y, yMax, (value) => String(Math.round(value)));
    xLabels(svg, [[M.left, minuteLabel(minutes[0].minute), 'start'], [W - M.right, minuteLabel(minutes[minutes.length - 1].minute), 'end']]);
    const bars = node('g', {}, svg);
    minutes.forEach((m, index) => {
      const pending = finite(m.pending) || 0;
      const top = y(pending);
      const bar = node('rect', { x: M.left + band * index + 1, y: pending ? top : H - M.bottom, width: Math.max(1, band - 2), height: pending ? H - M.bottom - top : 0, rx: 1, class: 'bar-muted' }, bars);
      textNode('title', {}, `${m.minute}: submitted ${m.submitted}, included ${m.included}, finalized ${m.finalized}, pending ${pending}`, bar);
    });
    node('path', { d: linePath(minutes.map((m, index) => [x(index), y(finite(m.submitted) || 0)])), class: 'line-submitted' }, svg);
    node('path', { d: linePath(minutes.map((m, index) => [x(index), y(finite(m.finalized) || 0)])), class: 'line-finalized' }, svg);
    return {
      summary, svg, table,
      legend: [{ line: 'line-submitted', label: 'Submitted' }, { line: 'line-finalized', label: 'Finalized' }, { bar: 'bar-muted', label: 'Pending depth' }],
    };
  }

  function costChart(data) {
    const txs = list(data?.transactions, TX_CAP).slice().reverse()
      .map((tx) => ({ slot: tx.slot, hash: tx.hash, wei: tx.actualCostWei, hype: weiNumber(tx.actualCostWei) }))
      .filter((tx) => tx.hype !== null);
    const today = data?.benchmark?.cost?.today || {};
    const allTime = data?.benchmark?.cost?.allTime || {};
    const actualToday = weiNumber(today.actualCostWei);
    const worstToday = weiNumber(today.worstCostWei);
    const mean = txs.length ? txs.reduce((s, tx) => s + tx.hype, 0) / txs.length : null;
    const summary = `Today ${weiToHype(today.actualCostWei, 8) ?? DASH} HYPE settled across ${today.settledActions ?? 0} actions against ${weiToHype(today.worstCostWei, 8) ?? DASH} HYPE worst-case reserved; all time ${weiToHype(allTime.actualCostWei, 8) ?? DASH} HYPE. ${txs.length ? `Mean of last ${txs.length} settled transactions ${mean.toFixed(8)} HYPE.` : 'No settled per-transaction cost in the recent list.'} The daily budget limit is not exposed by the dashboard API.`;
    const table = {
      caption: 'Settled cost per recent transaction, oldest first (HYPE)',
      headers: ['Slot', 'Hash', 'Cost HYPE'],
      rows: txs.map((tx) => [tx.slot, shortHash(tx.hash), weiToHype(tx.wei, 8)]),
    };
    if (!txs.length && !(worstToday > 0)) return { summary, table, emptyText: 'No settled cost data yet.' };
    const meterH = 40;
    const height = H + meterH;
    const svg = createSvg('Cost', summary, height);
    if (worstToday > 0) {
      const inner = W - M.left - M.right;
      const fill = Math.min(1, (actualToday || 0) / worstToday);
      textNode('text', { x: M.left, y: 12, class: 'row-label' }, 'Today: settled of worst-case reserved', svg);
      node('rect', { x: M.left, y: 18, width: inner, height: 10, rx: 3, class: 'bar-track' }, svg);
      const meter = node('rect', { x: M.left, y: 18, width: Math.max(fill ? 2 : 0, inner * fill), height: 10, rx: 3, class: 'bar-accent' }, svg);
      textNode('title', {}, `${weiToHype(today.actualCostWei, 8)} of ${weiToHype(today.worstCostWei, 8)} HYPE`, meter);
      textNode('text', { x: W - M.right, y: 12, 'text-anchor': 'end', class: 'value-label' }, `${(fill * 100).toFixed(1)}%`, svg);
    }
    if (txs.length) {
      const yMax = niceMax(Math.max(...txs.map((tx) => tx.hype)));
      const top = M.top + meterH;
      const y = scale(0, yMax, height - M.bottom, top);
      const band = (W - M.left - M.right) / txs.length;
      const group = node('g', { class: 'axis', 'aria-hidden': 'true' }, svg);
      for (let index = 0; index <= 3; index += 1) {
        const value = (yMax / 3) * index;
        node('line', { x1: M.left, x2: W - M.right, y1: y(value), y2: y(value), class: index === 0 ? 'baseline' : 'gridline' }, group);
        textNode('text', { x: M.left - 6, y: y(value) + 3, 'text-anchor': 'end' }, value.toPrecision(2), group);
      }
      xLabels(svg, [[M.left, 'oldest', 'start'], [W - M.right, 'newest', 'end']], height);
      const bars = node('g', {}, svg);
      txs.forEach((tx, index) => {
        const barTop = y(tx.hype);
        const bar = node('rect', { x: M.left + band * index + 2, y: barTop, width: Math.max(1, band - 4), height: height - M.bottom - barTop, rx: Math.min(3, band / 4), class: 'bar' }, bars);
        textNode('title', {}, `${tx.slot || shortHash(tx.hash)}: ${weiToHype(tx.wei, 8)} HYPE`, bar);
      });
    }
    const legend = [];
    if (worstToday > 0) legend.push({ bar: 'bar-accent', label: 'Settled today vs reserved' });
    if (txs.length) legend.push({ bar: 'bar', label: 'Per-transaction cost (HYPE)' });
    return { summary, svg, legend, table };
  }

  function recordHealth(state) {
    healthLog.push({ at: Date.now(), state });
    if (healthLog.length > HEALTH_CAP) healthLog.shift();
  }

  function healthChart(data) {
    const series = list(data?.benchmark?.series, SERIES_CAP);
    const quality = { primary: 0, recovered: 0, migrated: 0, drift: 0, unknown: 0 };
    for (const point of series) quality[Object.hasOwn(quality, point?.quality) ? point.quality : 'unknown'] += 1;
    const skips = data?.benchmark?.skips || {};
    const rows = [
      ['Primary timing', quality.primary, 'bar'],
      ['Recovered', quality.recovered, 'bar-muted'],
      ['Migrated', quality.migrated, 'bar-muted'],
      ['Clock drift', quality.drift, 'bar-muted'],
      ['Reconcile required', finite(data?.journal?.reconcileRequired) || 0, 'bar-stop'],
      ['Capacity skip', finite(skips.capacity) || 0, 'bar-accent'],
      ['Budget skip', finite(skips.budget) || 0, 'bar-accent'],
      ['Hold skip', finite(skips.hold) || 0, 'bar-accent'],
    ];
    const ok = healthLog.filter((entry) => entry.state === 'ok').length;
    const currentRpc = latestRpcState === 'unknown' ? 'unknown' : latestRpcState === 'unavailable' ? `unavailable${data?.unavailable?.rpc ? ` (${data.unavailable.rpc})` : ''}` : 'available';
    const summary = `This browser session observed the RPC available on ${ok} of ${healthLog.length} refreshes (per-minute RPC error counts are not in the API). Current RPC: ${currentRpc}. Of ${series.length} recent submissions, ${quality.primary} have primary timing and ${quality.recovered + quality.migrated + quality.drift} were recovered, migrated or drift-flagged.`;
    const table = {
      caption: 'Recovery and skip counts, then RPC availability per refresh in this session',
      headers: ['Measure', 'Value'],
      rows: rows.map(([label, value]) => [label, value]).concat(healthLog.slice(-(TABLE_CAP - rows.length)).map((entry) => [`Refresh ${clock(entry.at)}Z`, entry.state])),
    };
    const stripH = 34;
    const rowH = 18;
    const height = stripH + rows.length * rowH + 8;
    const svg = createSvg('RPC and recovery health', summary, height);
    const labelW = 128;
    textNode('text', { x: 0, y: 12, class: 'row-label' }, 'RPC per refresh', svg);
    const slot = (W - labelW - M.right) / HEALTH_CAP;
    const strip = node('g', {}, svg);
    for (let index = 0; index < HEALTH_CAP; index += 1) {
      const entry = healthLog[healthLog.length - HEALTH_CAP + index];
      const cls = !entry ? 'strip-none' : entry.state === 'ok' ? 'strip-ok' : 'strip-down';
      const px = labelW + slot * index;
      const tick = entry && entry.state !== 'ok'
        ? node('rect', { x: px + 1, y: 2, width: Math.max(1, slot - 2), height: 14, rx: 1, class: cls }, strip)
        : node('rect', { x: px + 1, y: 6, width: Math.max(1, slot - 2), height: 10, rx: 1, class: cls }, strip);
      if (entry) textNode('title', {}, `${clock(entry.at)}Z: ${entry.state}`, tick);
    }
    const max = niceMax(Math.max(1, ...rows.map((row) => row[1])));
    const x = scale(0, max, labelW, W - M.right - 40);
    rows.forEach(([label, value, cls], index) => {
      const py = stripH + index * rowH;
      textNode('text', { x: 0, y: py + 11, class: 'row-label' }, label, svg);
      node('rect', { x: labelW, y: py + 2, width: W - M.right - 40 - labelW, height: 11, rx: 2, class: 'bar-track' }, svg);
      if (value > 0) node('rect', { x: labelW, y: py + 2, width: Math.max(2, x(value) - labelW), height: 11, rx: 2, class: cls }, svg);
      textNode('text', { x: W - M.right, y: py + 11, 'text-anchor': 'end', class: 'value-label' }, String(value), svg);
    });
    return {
      summary, svg, table,
      legend: [{ bar: 'strip-ok', label: 'RPC available (short tick)' }, { bar: 'strip-down', label: 'RPC or feed unavailable (tall tick)' }, { bar: 'bar-muted', label: 'Non-primary timing' }, { bar: 'bar-accent', label: 'Skipped slot' }, { bar: 'bar-stop', label: 'Reconcile required' }],
    };
  }

  function renderCharts(data) {
    const benchmark = data?.benchmark;
    renderChart('chart-latency', latencyChart(benchmark));
    renderChart('chart-minutes', minuteChart(benchmark));
    renderChart('chart-histogram', histogramChart(benchmark));
    renderChart('chart-throughput', throughputChart(benchmark));
    renderChart('chart-cost', costChart(data));
    renderChart('chart-health', healthChart(data));
  }

  function cell(row, text, options = {}) {
    const td = document.createElement('td');
    if (options.tone) {
      const tag = document.createElement('span');
      tag.className = 'status-tag';
      tag.dataset.tone = options.tone;
      tag.textContent = text;
      td.appendChild(tag);
    } else if (options.quality) {
      const tag = document.createElement('span');
      tag.className = 'quality';
      tag.dataset.quality = options.quality;
      tag.textContent = text;
      td.appendChild(tag);
    } else {
      td.textContent = text;
    }
    if (options.cls) td.className = options.cls;
    row.appendChild(td);
    return td;
  }

  function renderTransactions(items) {
    const body = el('tx-body');
    const empty = el('tx-empty');
    if (!body) return;
    body.replaceChildren();
    const rows = list(items, TX_CAP);
    if (empty) empty.hidden = rows.length > 0;
    for (const tx of rows) {
      const row = document.createElement('tr');
      cell(row, tx.kind || 'unknown');
      cell(row, tx.slot || DASH, { cls: 'mono' });
      cell(row, tx.status || 'unknown', { tone: STATUS_TONE[tx.status] || 'warn' });
      const hashCell = cell(row, shortHash(tx.hash), { cls: 'mono' });
      if (typeof tx.hash === 'string') hashCell.title = tx.hash;
      cell(row, tx.nonce || DASH, { cls: 'mono num' });
      cell(row, tx.blockNumber || DASH, { cls: 'mono num' });
      cell(row, millis(tx.latencyMs) || DASH, { cls: 'mono num' });
      cell(row, tx.quality || 'unknown', { quality: tx.quality || 'unknown' });
      cell(row, weiToHype(tx.actualCostWei, 8) || DASH, { cls: 'mono num' });
      cell(row, shortTime(tx.finalizedAt) || DASH, { cls: 'mono' });
      body.appendChild(row);
    }
  }

  function renderPhases(phases) {
    const body = el('phase-body');
    if (!body) return;
    body.replaceChildren();
    for (const [key, label] of PHASE_ROWS) {
      const s = phases?.[key] || {};
      const row = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = label;
      row.appendChild(th);
      cell(row, String(finite(s.count) ?? 0), { cls: 'mono num' });
      for (const field of ['p50Ms', 'p95Ms', 'minMs', 'maxMs', 'meanMs', 'stdevMs']) cell(row, millis(s[field]) || DASH, { cls: 'mono num' });
      cell(row, finite(s.cv) === null ? DASH : s.cv.toFixed(3), { cls: 'mono num' });
      body.appendChild(row);
    }
  }

  function renderFeed(state) {
    const node = el('feed-status');
    if (!node) return;
    node.dataset.feed = state;
    node.textContent = state === 'live' ? 'live' : state === 'stale' ? 'refresh failed' : state === 'render_error' ? 'render failed' : 'unreachable';
  }

  function render(data) {
    setText('generated-at', shortTime(data.generatedAt));
    setText('network-name', data.network?.name);
    setText('chain-id', data.network?.chainId);
    const badge = el('network-badge');
    if (badge) badge.textContent = data.network?.environment === 'testnet' ? 'Testnet' : 'Network';

    const service = data.service?.state || 'unknown';
    setText('service-state', SERVICE_TEXT[service] || service);
    setTone('service-dot', SERVICE_TONE[service] || 'warn');
    setText('loop-liveness', data.service?.loopLiveness === 'not_journaled' ? 'not journaled by the loop' : data.service?.loopLiveness);
    setText('halt-file', data.service?.haltFile === true ? 'present' : data.service?.haltFile === false ? 'absent' : 'unreadable');
    setText('state-availability', data.unavailable?.state ? `unavailable (${data.unavailable.state})` : 'available');
    setText('rpc-availability', data.unavailable?.rpc ? `unavailable (${data.unavailable.rpc})` : 'available');
    setText('aggregates-availability', data.unavailable?.aggregates ? `unavailable (${data.unavailable.aggregates})` : `available${data.archive?.aggregatesGeneratedAt ? `, ${shortTime(data.archive.aggregatesGeneratedAt)}` : ''}`);

    setText('wallet-address', data.wallet?.address);
    setText('contract-address', data.contract?.address);
    setText('deploy-tx', data.contract?.deployTxHash ? shortHash(data.contract.deployTxHash) : null);
    setText('deploy-block', data.contract?.deployBlockNumber);

    setText('balance-hype', weiToHype(data.wallet?.balanceWei, 4));
    setText('balance-wei', data.wallet?.balanceWei);
    setText('pulse-count', data.onchain?.pulseCount);
    setText('block-number', data.onchain?.blockNumber);

    setText('finalized-pulses', data.journal?.finalizedPulses);
    setText('total-actions', data.journal?.totalActions);
    setText('last-slot', data.journal?.lastPulseSlot);
    setText('last-finalized', shortTime(data.journal?.lastFinalizedAt));
    setText('today-spend', data.journal?.todaySpendWei ? `${data.journal.todaySpendWei} wei` : null);

    const bench = data.benchmark || {};
    const e2e = bench.phases?.end_to_end || {};
    setText('bench-p50', millis(e2e.p50Ms));
    setText('bench-p95', millis(e2e.p95Ms));
    setText('rate-final', percent(bench.rates?.allTime?.finalizationRate));
    const hourRate = percent(bench.rates?.lastHour?.finalizationRate);
    setText('rate-final-hour', hourRate ? `1h ${hourRate}` : '1h –');
    setText('cost-today', weiToHype(bench.cost?.today?.actualCostWei, 6));
    const all = bench.rates?.allTime || {};
    setText('c-submitted', all.submitted);
    setText('c-included', all.included);
    setText('c-finalized', all.finalized);
    setText('c-reverted', all.reverted);
    setText('c-pending', all.pending);
    setText('c-skipped', bench.skips?.capacity);
    const counts = bench.sampleCounts || {};
    setText('sample-note', `${finite(counts.primaryEndToEnd) ?? 0} primary end-to-end samples, ${finite(counts.recovered) ?? 0} non-primary.`);
    renderPhases(bench.phases);

    const blockedBy = data.hold?.blockedBy;
    setText('hold-state', blockedBy === 'halt' ? 'HALT file present' : blockedBy === 'reconcile_required' ? 'reconcile required' : blockedBy === 'pending' ? 'action in flight' : 'no hold recorded');
    setTone('hold-dot', blockedBy === 'halt' || blockedBy === 'reconcile_required' ? 'stop' : blockedBy ? 'warn' : 'ok');
    setText('hold-action', data.hold?.action?.id);
    setText('hold-status', data.hold?.type ? `${data.hold.type} hold` : data.hold?.lastCleared ? `last ${data.hold.lastCleared.type} hold cleared ${data.hold.lastCleared.clearedAt ?? ''}`.trim() : data.hold?.action?.status);
    setText('hold-hash', data.hold?.action?.hash ? shortHash(data.hold.action.hash) : null);

    renderTransactions(data.transactions);
    renderCharts(data);
    renderFeed('live');
  }

  async function fetchDashboard() {
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(ENDPOINT, { method: 'GET', cache: 'no-store', credentials: 'omit', signal: controller.signal });
      if (!response.ok) return { feed: response.status >= 500 ? 'down' : 'stale' };
      return { data: await response.json() };
    } catch {
      return { feed: 'down' };
    } finally {
      clearTimeout(abort);
    }
  }

  async function refresh() {
    const result = await fetchDashboard();
    if (stopped) return;
    if (result.feed) {
      latestRpcState = 'unknown';
      recordHealth('feed_unavailable');
      renderFeed(result.feed);
      try { renderChart('chart-health', healthChart(lastData)); } catch { renderFeed('render_error'); }
      return;
    }
    latestRpcState = result.data?.unavailable?.rpc ? 'unavailable' : 'available';
    recordHealth(result.data?.unavailable?.rpc ? 'rpc_unavailable' : 'ok');
    lastData = result.data;
    try { render(result.data); } catch { renderFeed('render_error'); }
  }

  function schedule() {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(tick, POLL_MS);
  }

  async function tick() {
    if (inflight) return inflight;
    if (document.visibilityState === 'hidden') { schedule(); return undefined; }
    inflight = refresh();
    try { await inflight; } finally { inflight = null; }
    schedule();
    return undefined;
  }

  const bucketSelect = el('bucket-select');
  if (bucketSelect) bucketSelect.addEventListener('change', () => { if (lastData) renderChart('chart-histogram', histogramChart(lastData.benchmark)); });

  for (const link of document.querySelectorAll('.nav-list a')) {
    link.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.nav-list a')) other.removeAttribute('aria-current');
      link.setAttribute('aria-current', 'true');
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick();
  });

  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) { stopped = false; tick(); } });

  tick();
})();
