'use strict';

// ===========================================================================
// Regression: fetchNkQuoteData (api/sector-hot.js) built its candle series
// while null-checking ONLY close and volume:
//
//   if (closes[i] != null && volumes[i] != null) {
//     validDays.push({ ..., high: highs[i], low: lows[i], ... });
//   }
//
// Yahoo returns each OHLCV series independently, so a session can carry a close
// and a volume while its high/low are null. Keeping such a day is not harmless:
//
//   const support = Math.min(...last20Lows);
//
// JavaScript coerces null to 0 inside Math.min, so ONE null low collapses
// support to 0 for a stock trading in the thousands. support then drives the
// Fib 0.382 pullback zone, setupType, entry_low and stop_loss — so the
// published Non-Konglo plan is derived from a price that does not exist.
//
// The other Yahoo parsers in the same file (fetchScreenerCandles :2332,
// fetchChartOhlcRows :5468) already require the full OHLC set. The NK parser
// was the only one that did not.
//
// Note the asymmetry that makes this easy to miss: Math.max is unharmed by a
// null (null -> 0 never wins a max), so `resistance` stays plausible while
// `support` silently becomes 0. Nothing downstream looks wrong until the
// levels do.
//
// LOCAL / STATIC ONLY. No network: the helper is pure and takes the raw arrays.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const sectorHot = require('../api/sector-hot.js');
const parseNkValidDays = sectorHot.__test.parseNkValidDays;

// A 25-session series for a stock trading around 1000, with one halted session
// at index 12 that has close + volume but no high/low — exactly the shape Yahoo
// returns for a suspended session.
function buildSeries(mutate) {
  const timestamps = [], opens = [], highs = [], lows = [], closes = [], volumes = [];
  for (let i = 0; i < 25; i++) {
    timestamps.push(1700000000 + i * 86400);
    opens.push(1000 + i);
    highs.push(1010 + i);
    lows.push(990 + i);
    closes.push(1000 + i);
    volumes.push(1000000);
  }
  const series = { timestamps, opens, highs, lows, closes, volumes };
  if (mutate) mutate(series);
  return series;
}

function parse(series) {
  return parseNkValidDays(series.timestamps, series.opens, series.highs, series.lows, series.closes, series.volumes);
}

function supportOf(days) {
  return Math.min.apply(null, days.slice(-20).map((d) => d.low));
}

function resistanceOf(days) {
  return Math.max.apply(null, days.slice(-20).map((d) => d.high));
}

// --- The bug itself ---------------------------------------------------------

test('a session with a null low is dropped, so support cannot collapse to 0', () => {
  const series = buildSeries((s) => { s.highs[12] = null; s.lows[12] = null; });
  const days = parse(series);

  assert.equal(days.length, 24, 'the halted session must be dropped');
  const support = supportOf(days);
  assert.notEqual(support, 0, 'support must not be 0 for a stock trading near 1000');
  assert.ok(support > 900, 'support should sit in the real price range, got ' + support);
});

test('the entry zone derived from support stays in the real price range', () => {
  const series = buildSeries((s) => { s.highs[12] = null; s.lows[12] = null; });
  const days = parse(series);
  const support = supportOf(days);
  const resistance = resistanceOf(days);

  // The Fib 0.382 pullback zone, exactly as fetchNkQuoteData computes it.
  const pullbackEntryHigh = support + (resistance - support) * 0.382;
  const lastClose = days[days.length - 1].close;

  assert.ok(
    pullbackEntryHigh > lastClose * 0.9 && pullbackEntryHigh < lastClose * 1.1,
    'entry zone ' + Math.round(pullbackEntryHigh) + ' should be near last close ' + lastClose
  );

  // With the halted day kept, support would be 0 and this figure lands near 395
  // for a stock at 1024 — a 61% error.
  const brokenSupport = 0;
  const brokenEntryHigh = brokenSupport + (resistance - brokenSupport) * 0.382;
  assert.ok(brokenEntryHigh < lastClose * 0.5, 'sanity: the broken value really is far off');
});

test('the OLD predicate really did produce support 0 — the defect, independent of this refactor', () => {
  // Applies the exact pre-fix condition (close and volume only) to the same
  // input, so this file records the defect itself rather than merely asserting
  // that a new helper exists.
  const series = buildSeries((s) => { s.highs[12] = null; s.lows[12] = null; });
  const oldWay = [];
  for (let i = 0; i < series.timestamps.length; i++) {
    if (series.closes[i] != null && series.volumes[i] != null) {   // <-- pre-fix
      oldWay.push({ ts: series.timestamps[i], high: series.highs[i], low: series.lows[i], close: series.closes[i] });
    }
  }
  assert.equal(oldWay.length, 25, 'the old predicate kept the halted session');
  assert.equal(supportOf(oldWay), 0, 'and support collapsed to 0');

  // Same input through the shipped parser.
  assert.ok(supportOf(parse(series)) > 900, 'the fixed parser keeps support in the real range');
});

test('a null low alone is enough — Math.max hides it but Math.min does not', () => {
  // This is why the bug is quiet: resistance still looks plausible.
  const withNull = [{ low: 990, high: 1010 }, { low: null, high: null }, { low: 995, high: 1015 }];
  assert.equal(Math.min.apply(null, withNull.map((d) => d.low)), 0, 'null collapses Math.min');
  assert.equal(Math.max.apply(null, withNull.map((d) => d.high)), 1015, 'but never disturbs Math.max');
});

// --- Every leg is required --------------------------------------------------

['opens', 'highs', 'lows', 'closes', 'volumes'].forEach((leg) => {
  test('a session with a null ' + leg.slice(0, -1) + ' is dropped', () => {
    const series = buildSeries((s) => { s[leg][7] = null; });
    const days = parse(series);
    assert.equal(days.length, 24);
    assert.ok(days.every((d) => d.ts !== 1700000000 + 7 * 86400), 'the affected session must not survive');
  });
});

test('undefined and NaN are rejected as well as null', () => {
  const undef = buildSeries((s) => { s.lows[5] = undefined; });
  assert.equal(parse(undef).length, 24);

  const nan = buildSeries((s) => { s.highs[5] = NaN; });
  assert.equal(parse(nan).length, 24);

  const inf = buildSeries((s) => { s.closes[5] = Infinity; });
  assert.equal(parse(inf).length, 24);
});

test('a clean series keeps every session', () => {
  const days = parse(buildSeries());
  assert.equal(days.length, 25);
  assert.equal(supportOf(days), 995);   // lows 995..1014 over the last 20
  assert.equal(resistanceOf(days), 1034);
});

test('every kept day carries all five legs as finite numbers', () => {
  const days = parse(buildSeries((s) => { s.lows[3] = null; s.opens[9] = null; }));
  assert.equal(days.length, 23);
  days.forEach((d) => {
    ['open', 'high', 'low', 'close', 'volume'].forEach((k) => {
      assert.equal(typeof d[k], 'number', k + ' must be a number');
      assert.ok(isFinite(d[k]), k + ' must be finite');
    });
  });
});

test('a zero volume day is kept — zero is real data, unlike null', () => {
  // tradedDays20d counts volume > 0 downstream, so a genuine no-trade session
  // must survive the parser and be classified there, not dropped here.
  const days = parse(buildSeries((s) => { s.volumes[4] = 0; }));
  assert.equal(days.length, 25);
  assert.equal(days[4].volume, 0);
});

test('empty and missing inputs return an empty series rather than throwing', () => {
  assert.deepEqual(parseNkValidDays([], [], [], [], [], []), []);
  assert.deepEqual(parseNkValidDays(null, null, null, null, null, null), []);
  // Short trailing arrays (Yahoo occasionally truncates one series).
  assert.deepEqual(parseNkValidDays([1, 2], [10], [12], [9], [11], [100]), [
    { ts: 1, open: 10, high: 12, low: 9, close: 11, volume: 100 }
  ]);
});
