'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PatternMap = require('../public/pattern-map');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function candidate(overrides) {
  return Object.assign({
    id: 'det-1', ruleVersion: 'rules-1', name: 'Trusted ABCD', status: 'confirmed',
    ticker: 'BBCA', timeframe: '1D', dataDate: '2026-07-24', currentPrice: 9250,
    candles: [
      { time: '2026-07-21', open: 9000, high: 9100, low: 8950, close: 9050 },
      { time: '2026-07-24', open: 9050, high: 9300, low: 9000, close: 9250 }
    ],
    points: {
      X: { time: '2026-07-20', value: 9000 }, A: { time: '2026-07-21', value: 9400 },
      B: { time: '2026-07-22', value: 9150 }, C: { time: '2026-07-23', value: 9350 },
      D: { time: '2026-07-24', value: 9100 }
    },
    prz: { low: 9050, high: 9125 }, confirmation: 9300, invalidation: 9000, tp1: 9500, tp2: 9700
  }, overrides || {});
}

function response(blob) { return { ok: true, blob: async () => blob }; }

test('Pattern tab is lazy and initial Chart load contains no QuickChart request', () => {
  const loadStart = html.indexOf('async function loadChartPage(');
  const loadEnd = html.indexOf('// ===== MODE SYSTEM', loadStart);
  const loadSource = html.slice(loadStart, loadEnd);
  assert.match(html, /if \(isPattern\) renderPatternTab\(\)/);
  assert.doesNotMatch(loadSource, /renderPatternTab\s*\(/);
  assert.doesNotMatch(loadSource, /quickchart\.io/i);
  assert.match(html, /showChartTab\('technical'\)/);
});

test('text-only labels and incomplete pivots never become fake geometry', () => {
  assert.equal(PatternMap.hasDrawableGeometry({ name: 'Gartley', status: 'detected' }), false);
  assert.equal(PatternMap.buildQuickChartConfig({ id: 'x', ruleVersion: '1', candles: [{}], points: {} }), null);
});

test('no geometry returns the required clear empty state without a renderer call', async () => {
  let calls = 0;
  const manager = new PatternMap.RequestManager(async () => { calls++; return response({}); });
  const result = await manager.render({ name: 'text only' });
  assert.equal(result.empty, true);
  assert.equal(result.message, 'Belum ada pattern yang dapat divisualisasikan untuk saham ini.');
  assert.equal(calls, 0);
});

test('adapter supports trusted candles, pivots, PRZ and deterministic levels', () => {
  const config = PatternMap.buildQuickChartConfig(candidate());
  assert.equal(config.type, 'candlestick');
  assert.match(config.options.plugins.title.text, /Trusted ABCD.*BBCA.*2026-07-24/);
  for (const label of ['X-A-B-C-D', 'PRZ', 'Confirmation', 'Invalidation', 'TP1', 'TP2', 'Current']) {
    assert.ok(config.data.datasets.some((item) => item.label === label), label);
  }
});

test('one ticker/key creates at most one active image request and cache prevents repeats', async () => {
  let calls = 0;
  let release;
  const manager = new PatternMap.RequestManager(() => {
    calls++;
    return new Promise((resolve) => { release = () => resolve(response({ png: true })); });
  });
  const first = manager.render(candidate());
  const second = manager.render(candidate());
  assert.equal(calls, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.key, b.key);
  await manager.render(candidate());
  assert.equal(calls, 1);
});

test('ticker change aborts and obsolete output is ignored', async () => {
  const requests = [];
  const manager = new PatternMap.RequestManager((url, options) => new Promise((resolve, reject) => {
    const req = { options, resolve };
    requests.push(req);
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const oldResult = manager.render(candidate());
  const next = candidate({ ticker: 'TLKM', id: 'det-2' });
  const newResult = manager.render(next);
  assert.equal(requests[0].options.signal.aborted, true);
  requests[1].resolve(response({ ticker: 'TLKM' }));
  assert.equal((await oldResult).obsolete, true);
  assert.equal((await newResult).key, PatternMap.cacheKey(next));
});

test('QuickChart failure is isolated with Technical Chart fallback copy', async () => {
  const manager = new PatternMap.RequestManager(async () => ({ ok: false, status: 503 }));
  const result = await manager.render(candidate());
  assert.equal(result.error, true);
  assert.match(result.message, /Technical Chart tetap dapat digunakan/);
  assert.match(html, /renderLightweightChart\(chartId, data\.candles/);
});

test('T-1 metadata is rendered truthfully and Q&A sends no AI request', () => {
  assert.match(html, /data\.actual_data_date/);
  assert.match(html, /data\.t1_status === 'stale'/);
  assert.match(html, /T-1 kalender belum diverifikasi/);
  const start = html.indexOf('function submitPatternQuestion(');
  const end = html.indexOf('\n}\n', start) + 2;
  const submit = html.slice(start, end);
  assert.doesNotMatch(submit, /fetch\s*\(|XMLHttpRequest|WebSocket/);
  assert.match(submit, /AI belum tersedia pada fase MVP/);
});

test('QuickChart payload is bounded, POST-only, public, and keyed by required fields', async () => {
  let captured;
  const manager = new PatternMap.RequestManager(async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return response({});
  });
  const data = candidate({ authToken: 'secret', portfolio: [{ ticker: 'BBCA' }], conversation: 'private' });
  await manager.render(data);
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.body.width, 1200);
  assert.equal(captured.body.height, 700);
  assert.doesNotMatch(captured.options.body, /secret|portfolio|private/i);
  assert.equal(PatternMap.cacheKey(data), 'BBCA|2026-07-24|det-1|rules-1');
});

test('API endpoint count remains at the base-branch baseline', () => {
  const apiFiles = fs.readdirSync(path.join(__dirname, '..', 'api')).filter((file) => file.endsWith('.js'));
  assert.equal(apiFiles.length, 12);
});
