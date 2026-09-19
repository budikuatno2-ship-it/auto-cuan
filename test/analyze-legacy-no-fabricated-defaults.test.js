'use strict';

// ===========================================================================
// Batch 8 / F-056 — analyze-legacy.js must stop inventing technical readings.
//
// buildIHSGFixedTemplate() and buildStockFixedTemplate() used to substitute
// fabricated defaults whenever a metric was absent:
//
//   rsi14          || 50   -> "RSI14: 50" (a neutral reading that was never measured)
//   volumeVsAvg20  || 1    -> "Volume: 1x avg20" (a normal-volume claim)
//   priceChange1D  || 0    -> "naik 0,00%" (a flat session that never happened)
//
// Those invented numbers were then fed straight into the Status / Bias /
// Confidence / Action decision logic, so a payload with NO technical data at
// all could still produce a confident "Breakout Watch / Bullish / High" call.
//
// The contract now matches public/market-feature-runtime.js: an absent field
// stays absent. The card renders "—" and the decision logic refuses to judge
// from data it does not have.
//
// LOCAL / STATIC ONLY. No network, no backend.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const analyze = require('../lib/analyze-legacy');
const { buildStockFixedTemplate, buildIHSGFixedTemplate } = analyze.__test;

const DASH = '\u2014'; // em dash "—"

// A payload where every technical metric is missing, exactly as the handler
// builds it when only a stated/carried price is available (see
// lib/analyze-legacy.js minimalData / message_stated_price branches).
function emptyStockData(last) {
  return {
    last: last, priceChange1D: null, volumeVsAvg20: null, rsi14: null,
    ma20: null, ma50: null, ma100: null, ma200: null, high: null, low: null,
    resistance1: null, resistance2: null, support1: null, support2: null,
    pivotPoint: null, fib382: null, fib500: null, fib618: null, fib786: null
  };
}

function emptyIhsgData(last) {
  return emptyStockData(last);
}

// ---------------------------------------------------------------------------
// Stock template
// ---------------------------------------------------------------------------
test('stock template renders "—" for absent RSI/volume/change instead of fabricated numbers', () => {
  const html = buildStockFixedTemplate(emptyStockData(1000), 'TEST', '');
  assert.ok(html, 'template must still render when only the price is known');

  // The fabricated readings must be gone.
  assert.doesNotMatch(html, /RSI14:\s*50\b/, 'RSI14 must not be invented as 50');
  assert.doesNotMatch(html, /Volume:\s*1x/, 'volume must not be invented as 1x');
  assert.doesNotMatch(html, /naik 0,00%|turun 0,00%/, 'price change must not be invented as 0%');

  // The absent metrics are shown as an explicit dash.
  assert.match(html, new RegExp('RSI14:\\s*' + DASH), 'RSI14 must render as —');
  assert.match(html, new RegExp('Volume:\\s*' + DASH), 'volume must render as —');
});

test('stock template does not take a buy/sell decision from missing technical data', () => {
  const html = buildStockFixedTemplate(emptyStockData(1000), 'TEST', '');

  // No confident call may be derived from data that does not exist.
  assert.doesNotMatch(html, /Beli saat breakout terkonfirmasi/, 'no buy action from fabricated data');
  assert.doesNotMatch(html, /Breakout Watch/, 'no breakout status from fabricated data');
  assert.doesNotMatch(html, /<b>High<\/b>/, 'confidence must not be High without data');

  // The card states the data gap explicitly and drops confidence.
  assert.match(html, /Data Belum Lengkap/, 'status must flag incomplete data');
  assert.match(html, /<b>Low<\/b>/, 'confidence must be Low when data is incomplete');
  assert.match(html, /data teknikal belum lengkap/i, 'the gap must be stated to the user');
});

test('stock template still computes a real decision when the data is present', () => {
  const full = {
    last: 1000, priceChange1D: 3, volumeVsAvg20: 2, rsi14: 60,
    ma20: 900, ma50: 850, ma100: 800, ma200: 700, high: 1010, low: 980,
    resistance1: 1050, resistance2: 1100, support1: 950, support2: 900,
    pivotPoint: 1000, fib382: 990, fib500: 980, fib618: 970, fib786: 960
  };
  const html = buildStockFixedTemplate(full, 'TEST', '');
  assert.match(html, /Breakout Watch/, 'a real breakout setup must still be reported');
  assert.match(html, /<b>High<\/b>/, 'confidence must still be High with full data');
  assert.doesNotMatch(html, /Data Belum Lengkap/, 'complete data must not be flagged as incomplete');
});

// ---------------------------------------------------------------------------
// IHSG template
// ---------------------------------------------------------------------------
test('IHSG template renders "—" for absent RSI/volume/change instead of fabricated numbers', () => {
  const html = buildIHSGFixedTemplate(emptyIhsgData(7000), '');
  assert.ok(html, 'template must still render when only the index level is known');

  assert.doesNotMatch(html, /RSI14:\s*50\b/, 'RSI14 must not be invented as 50');
  assert.doesNotMatch(html, /volume 1x rata-rata/, 'volume must not be invented as 1x');
  assert.doesNotMatch(html, /naik 0,00%|turun 0,00%/, 'price change must not be invented as 0%');

  assert.match(html, new RegExp('RSI14:\\s*' + DASH), 'RSI14 must render as —');
  assert.match(html, new RegExp('Volume:\\s*' + DASH), 'volume must render as —');
});

test('IHSG template does not take a market call from missing technical data', () => {
  const html = buildIHSGFixedTemplate(emptyIhsgData(7000), '');

  assert.doesNotMatch(html, /Risk-Off/, 'no risk-off call from fabricated data');
  assert.doesNotMatch(html, /Breakout Watch/, 'no breakout call from fabricated data');
  assert.doesNotMatch(html, /Rebound Watch/, 'no rebound call from fabricated data');
  assert.doesNotMatch(html, /<b>High<\/b>/, 'confidence must not be High without data');

  assert.match(html, /Data Belum Lengkap/, 'status must flag incomplete data');
  assert.match(html, /<b>Low<\/b>/, 'confidence must be Low when data is incomplete');
  assert.match(html, /data teknikal belum lengkap/i, 'the gap must be stated to the user');
});

test('IHSG template still computes a real market call when the data is present', () => {
  const full = {
    last: 7000, priceChange1D: -2, volumeVsAvg20: 1.5, rsi14: 35,
    ma20: 7100, ma50: 7200, ma100: 7300, ma200: 7400, high: 7050, low: 6950,
    resistance1: 7100, resistance2: 7200, support1: 6900, support2: 6800,
    fib382: 7050, fib500: 7000, fib618: 6950, fib786: 6900
  };
  const html = buildIHSGFixedTemplate(full, '');
  assert.match(html, /Risk-Off/, 'a real risk-off market must still be reported');
  assert.match(html, /<b>High<\/b>/, 'confidence must still be High with full data');
  assert.doesNotMatch(html, /Data Belum Lengkap/, 'complete data must not be flagged as incomplete');
});
