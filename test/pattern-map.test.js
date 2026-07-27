'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
      X: { time: candles[0].time, value: 9000, candleIndex: 0 }, A: { time: candles[1].time, value: 9300, candleIndex: 1 },
      B: { time: candles[2].time, value: 9100, candleIndex: 2 }, C: { time: candles[3].time, value: 9350, candleIndex: 3 },
      D: { time: candles[4].time, value: 9125, candleIndex: 4 }
    }, prz: { low: 9075, high: 9150 }, confirmation: 9300, invalidation: 9000, tp1: 9500, tp2: 9700,
    currentPrice: candles.at(-1).close, confirmationEvidence: { type: 'daily-close', date: '2026-07-26' }
  };
  return { candidate, context: { ticker: 'BBCA', timeframe: '1D', dataDate: '2026-07-26', candles: clone(candles) } };
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function response(blob) { return { ok: true, blob: async () => blob }; }

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

test('live candles contract does not falsely expose patternMap geometry', () => {
  assert.doesNotMatch(candlesApi, /patternMap\s*:/);
  assert.match(html, /no producer exists today; preview stays default-off/);
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

test('reversed PRZ, invalid levels, and unproven confirmed status are rejected', () => {
  assert.equal(invalid(v => { v.candidate.prz.low = v.candidate.prz.high + 1; }).reason, 'invalid_prz');
  assert.equal(invalid(v => { v.candidate.tp2 = Infinity; }).reason, 'invalid_level');
  assert.equal(invalid(v => { delete v.candidate.confirmationEvidence; }).reason, 'missing_confirmation_evidence');
});

test('config supports financial/mixed overlays and a bounded PRZ fill', () => {
  const value = fixture();
  const config = PatternMap.buildQuickChartConfig(value.candidate, value.context);
  assert.equal(config.data.datasets[0].type, 'candlestick');
  for (const label of ['X-A-B-C-D', 'Confirmation', 'Invalidation', 'TP1', 'TP2', 'Current', 'PRZ upper', 'PRZ lower']) {
    assert.ok(config.data.datasets.some(d => d.label === label), label);
  }
  const upperIndex = config.data.datasets.findIndex(d => d.label === 'PRZ upper');
  const lowerIndex = config.data.datasets.findIndex(d => d.label === 'PRZ lower');
  assert.equal(lowerIndex, upperIndex + 1);
  assert.equal(config.data.datasets[upperIndex].data[0].y, value.candidate.prz.high);
  assert.equal(config.data.datasets[lowerIndex].data[0].y, value.candidate.prz.low);
  assert.ok(config.data.datasets[lowerIndex].data[0].y <= config.data.datasets[upperIndex].data[0].y);
  assert.deepEqual(config.data.datasets[lowerIndex].fill, { target: '-1', above: 'rgba(168,85,247,.18)', below: 'rgba(168,85,247,.18)' });
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
  assert.deepEqual(await old, { obsolete: true }); assert.equal((await current).key, PatternMap.cacheKey(two.candidate));
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
