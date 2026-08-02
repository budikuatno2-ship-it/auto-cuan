'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PatternMap = require('../public/pattern-map');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const candlesApi = fs.readFileSync(path.join(__dirname, '..', 'api', 'candles.js'), 'utf8');

function fixture() {
  const candles = [20, 21, 22, 23, 24, 25, 26].map((day, index) => ({
    time: `2026-07-${day}`, open: 9000 + index * 25, high: 9150 + index * 25,
    low: 8900 + index * 25, close: 9050 + index * 25
  }));
  const candidate = {
    id: 'det-1', ruleVersion: 'rules-1', name: 'Trusted ABCD', status: 'confirmed',
    provenance: 'deterministic-pattern-engine-v1', ticker: 'BBCA', timeframe: '1D', dataDate: '2026-07-26',
    candles, points: {
      X: { time: candles[0].time, value: candles[0].low, candleIndex: 0, priceField: 'low' }, A: { time: candles[1].time, value: candles[1].high, candleIndex: 1, priceField: 'high' },
      B: { time: candles[2].time, value: candles[2].low, candleIndex: 2, priceField: 'low' }, C: { time: candles[3].time, value: candles[3].high, candleIndex: 3, priceField: 'high' },
      D: { time: candles[4].time, value: candles[4].low, candleIndex: 4, priceField: 'low' }
    }, prz: { low: 9075, high: 9150 }, confirmation: 9300, invalidation: 9000, tp1: 9500, tp2: 9700,
    currentPrice: candles.at(-1).close, confirmationEvidence: { type: 'daily-close', date: '2026-07-26' }
  };
  return { candidate, context: { ticker: 'BBCA', timeframe: '1D', dataDate: '2026-07-26', candles: clone(candles) } };
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function response(blob) { return { ok: true, blob: async () => blob }; }

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const brace = html.indexOf('{', start); let depth = 0;
  for (let i = brace; i < html.length; i++) {
    if (html[i] === '{') depth++;
    if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

function tabHarness(search) {
  function element(classes) {
    const values = new Set(classes.split(/\s+/).filter(Boolean));
    return { attributes: {}, classList: {
      add: name => values.add(name), remove: name => values.delete(name), contains: name => values.has(name),
      toggle(name, force) { if (force === undefined) force = !values.has(name); force ? values.add(name) : values.delete(name); return force; }
    }, setAttribute(name, value) { this.attributes[name] = value; } };
  }
  const elements = {
    technicalChartTab: element('bg-emerald-500 text-black'),
    patternChartTab: element('hidden bg-dark-700 text-gray-300'),
    chartPageContainer: element(''), patternPageContainer: element('hidden')
  };
  const sandbox = { URLSearchParams, window: { location: { search: search || '' } },
    document: { getElementById: id => elements[id] }, resetPatternMap() {}, renderPatternTab() {} };
  vm.createContext(sandbox);
  vm.runInContext(['patternMapPreviewEnabled', 'setChartTabSelected', 'applyPatternMapPreviewPolicy', 'showChartTab'].map(extractFunction).join('\n'), sandbox);
  return { ...sandbox, elements };
}

function invalid(mutator) {
  const value = fixture(); mutator(value); return PatternMap.validateCandidate(value.candidate, value.context);
}

test('production Pattern tab is default-off and lazy; initial Chart load has no QuickChart request', () => {
  const load = html.slice(html.indexOf('async function loadChartPage('), html.indexOf('// ===== MODE SYSTEM'));
  assert.match(html, /id="patternChartTab"[^>]*class="hidden /);
  assert.match(html, /__AUTOCUAN_PATTERN_MAP_PREVIEW__/);
  assert.match(html, /patternMapPreview.*=== '1'/);
  assert.match(html, /if \(isPattern\) renderPatternTab\(\)/);
  assert.doesNotMatch(load, /renderPatternTab\s*\(|quickchart\.io/i);
});

test('default-off gate survives Technical Chart loads and rejects direct Pattern invocation', () => {
  const h = tabHarness('');
  assert.equal(h.elements.patternChartTab.classList.contains('hidden'), true);
  assert.equal(h.showChartTab('technical'), true);
  assert.equal(h.elements.patternChartTab.classList.contains('hidden'), true);
  assert.match(html.slice(html.indexOf('async function loadChartPage('), html.indexOf('// ===== MODE SYSTEM')), /showChartTab\('technical'\)/);
  assert.equal(h.showChartTab('pattern'), false);
  assert.equal(h.elements.chartPageContainer.classList.contains('hidden'), false);
  assert.equal(h.elements.patternPageContainer.classList.contains('hidden'), true);
  assert.equal(h.elements.patternChartTab.classList.contains('hidden'), true);
});

test('explicit preview flag exposes tabs, and removing it safely restores Technical Chart', () => {
  const h = tabHarness('?patternMapPreview=1');
  assert.equal(h.applyPatternMapPreviewPolicy(), true);
  assert.equal(h.elements.patternChartTab.classList.contains('hidden'), false);
  assert.equal(h.showChartTab('pattern'), true);
  assert.equal(h.elements.chartPageContainer.classList.contains('hidden'), true);
  h.window.location.search = '';
  assert.equal(h.applyPatternMapPreviewPolicy(), false);
  assert.equal(h.elements.patternChartTab.classList.contains('hidden'), true);
  assert.equal(h.elements.chartPageContainer.classList.contains('hidden'), false);
  assert.equal(h.elements.patternPageContainer.classList.contains('hidden'), true);
});

test('live candles contract exposes only deterministic geometry while preview stays default-off', () => {
  assert.match(candlesApi, /patternMap/);
  assert.match(html, /deterministic server geometry; preview stays default-off/);
});

test('labels or absent geometry return required empty state without QuickChart', async () => {
  let calls = 0;
  const manager = new PatternMap.RequestManager(async () => { calls++; return response({}); });
  const result = await manager.render({ name: 'Gartley' }, fixture().context);
  assert.deepEqual(result, { empty: true, message: PatternMap.EMPTY_MESSAGE });
  assert.equal(calls, 0);
});

test('strict validation accepts only the complete bound deterministic fixture', () => {
  const value = fixture();
  assert.equal(PatternMap.validateCandidate(value.candidate, value.context).valid, true);
  assert.equal(PatternMap.publicPatternData(value.candidate, value.context).provenance, 'deterministic-pattern-engine-v1');
});

test('ticker, data date, rule version, and plain-object trust mismatches are rejected', () => {
  assert.equal(invalid(v => { v.candidate.ticker = 'TLKM'; }).reason, 'ticker_mismatch');
  assert.equal(invalid(v => { v.candidate.dataDate = '2026-07-25'; }).reason, 'data_date_mismatch');
  assert.equal(invalid(v => { delete v.candidate.ruleVersion; }).reason, 'invalid_rule_version');
  const value = fixture(); value.candidate = Object.create(value.candidate);
  assert.equal(PatternMap.validateCandidate(value.candidate, value.context).reason, 'untrusted_object');
});

test('invalid OHLC, unordered candles, and non-identical T-1 candle sets are rejected', () => {
  assert.equal(invalid(v => { v.candidate.candles[2].high = v.candidate.candles[2].low - 1; }).reason, 'invalid_ohlc');
  assert.equal(invalid(v => { [v.candidate.candles[1], v.candidate.candles[2]] = [v.candidate.candles[2], v.candidate.candles[1]]; }).reason, 'unordered_candles');
  assert.equal(invalid(v => { v.candidate.candles[3].close += 1; }).reason, 'candle_set_mismatch');
});

test('unordered, out-of-source, and invalid pivots are rejected', () => {
  assert.equal(invalid(v => { v.candidate.points.B.time = v.candidate.points.A.time; }).reason, 'unordered_pivots');
  assert.equal(invalid(v => { v.candidate.points.D.candleIndex = 99; }).reason, 'pivot_outside_source');
  assert.equal(invalid(v => { v.candidate.points.X.value = NaN; }).reason, 'invalid_pivot');
});

test('pivot prices must exactly bind to the allowlisted source candle high or low', () => {
  const high = fixture();
  assert.equal(high.candidate.points.A.priceField, 'high');
  assert.equal(PatternMap.validateCandidate(high.candidate, high.context).valid, true);
  const low = fixture();
  assert.equal(low.candidate.points.X.priceField, 'low');
  assert.equal(PatternMap.validateCandidate(low.candidate, low.context).valid, true);
  assert.equal(invalid(v => { v.candidate.points.A.priceField = 'low'; }).reason, 'pivot_price_mismatch');
  assert.equal(invalid(v => { v.candidate.points.A.value = v.candidate.candles[1].high - 1; }).reason, 'pivot_price_mismatch');
  assert.equal(invalid(v => { v.candidate.points.A.value = v.candidate.candles[1].high + 1000; }).reason, 'pivot_price_mismatch');
  assert.equal(invalid(v => { delete v.candidate.points.A.priceField; }).reason, 'invalid_pivot_price_field');
});

test('sanitized pivots preserve only allowlisted priceField and renderer does not adjust values', () => {
  const value = fixture(); value.candidate.points.X.privateNote = 'do not send';
  const data = PatternMap.publicPatternData(value.candidate, value.context);
  assert.deepEqual(data.points.X, { time: value.candidate.points.X.time, value: value.candidate.points.X.value,
    candleIndex: 0, priceField: 'low' });
  assert.equal(data.points.X.privateNote, undefined);
  const legs = PatternMap.buildQuickChartConfig(value.candidate, value.context).data.datasets.find(d => d.label === 'X-A-B-C-D');
  assert.equal(legs.data[0].y, value.candidate.points.X.value);
});

test('reversed PRZ, invalid levels, and unproven confirmed status are rejected', () => {
  assert.equal(invalid(v => { v.candidate.prz.low = v.candidate.prz.high + 1; }).reason, 'invalid_prz');
  assert.equal(invalid(v => { v.candidate.tp2 = Infinity; }).reason, 'invalid_level');
  assert.equal(invalid(v => { delete v.candidate.confirmationEvidence; }).reason, 'missing_confirmation_evidence');
});

test('config supports financial/mixed overlays and a bounded PRZ fill', () => {
  const value = fixture();
  const config = PatternMap.buildQuickChartConfig(value.candidate, value.context);
  assert.equal(config.data.datasets[0].type, 'candlestick');
  const labels = config.data.datasets.map(d => String(d.label));
  // Level datasets print their price into the label, so match by name prefix.
  for (const name of ['X-A-B-C-D', 'Konfirmasi', 'Invalidasi', 'TP1', 'TP2', 'Harga terakhir', 'PRZ ', 'PRZ bawah']) {
    assert.ok(labels.some(label => label.startsWith(name)), name);
  }
  const upperIndex = labels.findIndex(label => label.startsWith('PRZ ') && label !== 'PRZ bawah');
  const lowerIndex = labels.indexOf('PRZ bawah');
  assert.equal(lowerIndex, upperIndex + 1);
  assert.equal(config.data.datasets[upperIndex].data[0].y, value.candidate.prz.high);
  assert.equal(config.data.datasets[lowerIndex].data[0].y, value.candidate.prz.low);
  assert.ok(config.data.datasets[lowerIndex].data[0].y <= config.data.datasets[upperIndex].data[0].y);
  assert.deepEqual(config.data.datasets[lowerIndex].fill, { target: '-1', above: 'rgba(168,85,247,.26)', below: 'rgba(168,85,247,.26)' });
});

test('QuickChart POST selects v4, is bounded, and allowlists public fields', async () => {
  let captured; const value = fixture();
  value.candidate.authToken = 'secret'; value.candidate.portfolio = 'private';
  const manager = new PatternMap.RequestManager(async (url, options) => { captured = JSON.parse(options.body); return response({}); });
  await manager.render(value.candidate, value.context);
  assert.equal(captured.version, '4'); assert.equal(captured.width, 1200); assert.equal(captured.height, 700);
  assert.doesNotMatch(JSON.stringify(captured), /secret|private|authToken|portfolio/);
});

test('same candidate deduplicates and caches one active image request', async () => {
  let calls = 0, release; const value = fixture();
  const manager = new PatternMap.RequestManager(() => { calls++; return new Promise(resolve => { release = () => resolve(response({ png: true })); }); });
  const first = manager.render(value.candidate, value.context); const second = manager.render(value.candidate, value.context);
  assert.equal(calls, 1); release(); await Promise.all([first, second]);
  await manager.render(value.candidate, value.context); assert.equal(calls, 1);
});

test('ticker change aborts and ignores obsolete work without a renderer failure', async () => {
  const requests = [], one = fixture(), two = fixture(); two.candidate.ticker = two.context.ticker = 'TLKM'; two.candidate.id = 'det-2';
  const manager = new PatternMap.RequestManager((url, options) => new Promise((resolve, reject) => {
    requests.push({ options, resolve }); options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const old = manager.render(one.candidate, one.context); const current = manager.render(two.candidate, two.context);
  assert.equal(requests[0].options.signal.aborted, true); requests[1].resolve(response({}));
  assert.deepEqual(await old, { obsolete: true }); assert.equal((await current).key, PatternMap.cacheKey(two.candidate, PatternMap.patternImageSpec()));
});

test('object URLs are revoked on replacement, ticker reset, and Chart-page exit', () => {
  assert.match(html, /function revokePatternImageUrl\(\)[\s\S]*URL\.revokeObjectURL/);
  assert.match(html, /function resetPatternMap\(\)[\s\S]*revokePatternImageUrl\(\)/);
  assert.match(html, /page !== 'chart'[\s\S]*resetPatternMap\(\)/);
  assert.match(html, /async function loadChartPage\([\s\S]*resetPatternMap\(\)/);
  assert.match(html, /if \(_patternImageUrl\) URL\.revokeObjectURL\(_patternImageUrl\)/);
});

test('QuickChart failure is isolated from unchanged Technical Chart rendering', async () => {
  const value = fixture(), manager = new PatternMap.RequestManager(async () => ({ ok: false, status: 503 }));
  const result = await manager.render(value.candidate, value.context);
  assert.equal(result.error, true); assert.match(result.message, /Technical Chart tetap dapat digunakan/);
  assert.match(html, /renderLightweightChart\(chartId, data\.candles/);
});

test('Q&A is visibly disabled and contains no submit or AI/network path', () => {
  assert.match(html, /Preview nonaktif — AI segera hadir/);
  assert.match(html, /id="patternQuestion" disabled aria-disabled="true"/);
  assert.doesNotMatch(html, /function submitPatternQuestion\(/);
  assert.match(html, /Tidak ada AI atau permintaan jaringan/);
});

test('API endpoint count remains exactly 12', () => {
  assert.equal(fs.readdirSync(path.join(__dirname, '..', 'api')).filter(file => file.endsWith('.js')).length, 12);
});
