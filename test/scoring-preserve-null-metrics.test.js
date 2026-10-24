'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dtEngine = require('../lib/daytrade-screener-engine');
const bandarScoring = require('../lib/bandarmologi-screener-scoring');

test('BUG-08: Preserve null values and prevent falsified zero metrics in scoring', async (t) => {
  // Build a standard 25-candle array
  function makeCandles(todayVolume) {
    const candles = [];
    for (let i = 0; i < 25; i++) {
      candles.push({
        date: '2026-10-' + String(i + 1).padStart(2, '0'),
        open: 1000,
        high: 1020,
        low: 990,
        close: 1010,
        volume: i === 24 ? todayVolume : 100000
      });
    }
    return candles;
  }

  await t.test('1. analyzeDayTrade preserves null when today volume is null or undefined (does not coerce to 0)', () => {
    const candlesNullVol = makeCandles(null);
    const analysisNull = dtEngine.analyzeDayTrade(candlesNullVol, 'TEST');

    assert.equal(analysisNull.volume_today, null, 'volume_today must be null when volume is null');
    assert.equal(analysisNull.value_today, null, 'value_today must be null when volume is null');
    assert.equal(analysisNull.volume_ratio_20d, null, 'volume_ratio_20d must be null when volume is null');
    assert.equal(analysisNull.data_quality_status, 'DATA_INCOMPLETE', 'Missing volume must mark DATA_INCOMPLETE');
    assert.equal(analysisNull.data_quality_valid, false);

    const candlesUndefVol = makeCandles(undefined);
    const analysisUndef = dtEngine.analyzeDayTrade(candlesUndefVol, 'TEST');
    assert.equal(analysisUndef.volume_today, null, 'volume_today must be null when volume is undefined');
    assert.equal(analysisUndef.value_today, null);
    assert.equal(analysisUndef.volume_ratio_20d, null);
  });

  await t.test('2. analyzeDayTrade preserves numeric 0 when volume is genuinely 0 (not missing)', () => {
    const candlesZeroVol = makeCandles(0);
    const analysisZero = dtEngine.analyzeDayTrade(candlesZeroVol, 'TEST');

    assert.equal(analysisZero.volume_today, 0, 'Genuine 0 volume must stay 0');
    assert.equal(analysisZero.value_today, 0);
    assert.equal(analysisZero.volume_ratio_20d, 0, 'volume_ratio_20d must be 0 for genuine 0 volume');
  });

  await t.test('3. calculateBandarmologiScore does not coerce null volumeRatio20d to 0', () => {
    const dummyBrokerData = {
      stock_code: 'BBCA',
      brokers: [
        { broker_code: 'YP', bval: 1000000000, sval: 500000000, bvol: 10000, svol: 5000 }
      ]
    };

    const resNullVr = bandarScoring.calculateBandarmologiScore(dummyBrokerData, {
      mode: 'daytrade',
      volumeRatio20d: null
    });
    // Should not trigger DAYTRADE_VOLUME_SURGE
    assert.ok(!resNullVr.breakdown.some(b => b.rule === 'DAYTRADE_VOLUME_SURGE'), 'Null volume ratio must not trigger volume surge');

    const resSurge = bandarScoring.calculateBandarmologiScore(dummyBrokerData, {
      mode: 'daytrade',
      volumeRatio20d: 2.5
    });
    assert.ok(resSurge.breakdown.some(b => b.rule === 'DAYTRADE_VOLUME_SURGE'), '2.5x volume ratio must trigger volume surge');
  });

  await t.test('4. enrichCandidateWithBandarmologi retains volumeRatio20d null when absent from candidate', () => {
    const candidateNoVol = {
      ticker: 'BBCA',
      close: 9000,
      broker_summary: {
        stock_code: 'BBCA',
        brokers: []
      }
    };

    const enriched = bandarScoring.enrichCandidateWithBandarmologi(candidateNoVol, { mode: 'daytrade' });
    assert.ok(enriched, 'Enriched candidate should be returned');
    assert.equal(candidateNoVol.volume_ratio_20d, undefined, 'Candidate original fields preserved');
  });
});
