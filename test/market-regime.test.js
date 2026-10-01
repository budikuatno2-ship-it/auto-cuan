'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const regime = require('../lib/market-regime');

function candlesFromCloses(closes) {
  return closes.map(function(close, i) {
    return { date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), close: close };
  });
}

test('market regime labels RISK_ON when IHSG close > MA20 and MA20 >= MA50', function() {
  const result = regime.evaluateMarketRegime(candlesFromCloses(Array.from({ length: 50 }, (_, i) => 100 + i)));
  assert.equal(result.market_regime_label, 'RISK_ON');
  assert.equal(result.market_regime_score_adjustment, 2);
  assert.ok(result.market_regime_close > result.market_regime_ma20);
  assert.ok(result.market_regime_ma20 >= result.market_regime_ma50);
});

test('market regime labels RISK_OFF when IHSG close < MA20 and MA20 < MA50', function() {
  const result = regime.evaluateMarketRegime(candlesFromCloses(Array.from({ length: 50 }, (_, i) => 150 - i)));
  assert.equal(result.market_regime_label, 'RISK_OFF');
  assert.equal(result.market_regime_score_adjustment, -4);
  assert.ok(result.market_regime_close < result.market_regime_ma20);
  assert.ok(result.market_regime_ma20 < result.market_regime_ma50);
});

test('market regime labels mixed MA trend as NEUTRAL', function() {
  const closes = Array(30).fill(100).concat(Array(19).fill(120), [110]);
  const result = regime.evaluateMarketRegime(candlesFromCloses(closes));
  assert.equal(result.market_regime_label, 'NEUTRAL');
  assert.equal(result.market_regime_score_adjustment, 0);
});

test('market regime returns MARKET_UNKNOWN for insufficient data', function() {
  const result = regime.evaluateMarketRegime(candlesFromCloses([100, 101, 102]));
  assert.equal(result.market_regime_label, 'MARKET_UNKNOWN');
  assert.equal(result.market_regime_score_adjustment, 0);
});

test('market regime score adjustment is light and capped 0-100', function() {
  assert.equal(regime.applyMarketRegimeScore(99, { market_regime_score_adjustment: 2 }), 100);
  assert.equal(regime.applyMarketRegimeScore(3, { market_regime_score_adjustment: -4 }), 0);
  assert.equal(regime.applyMarketRegimeScore(70, { market_regime_score_adjustment: 0 }), 70);
});

test('market regime fallback is safe when market data is unavailable', async function() {
  const result = await regime.getMarketRegime({ candles: [] });
  assert.equal(result.market_regime_label, 'MARKET_UNKNOWN');
  assert.equal(result.market_regime_score_adjustment, 0);
});
