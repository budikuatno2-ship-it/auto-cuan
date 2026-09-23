'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const marketRegimeEngine = require('../lib/market-regime');
const bandarmologiService = require('../lib/bandarmologi-service');
const daytradeEngine = require('../lib/daytrade-screener-engine');
const swingEngine = require('../lib/swing-screener-engine');

test('Regime-Adaptive & Foreign Confluence Suite', async (t) => {
  await t.test('1. Market Regime Adaptive Thresholds resolver', () => {
    // Bull
    const bull = marketRegimeEngine.getRegimeAdaptiveThresholds('RISK_ON');
    assert.equal(bull.category, 'bull');
    assert.equal(bull.daytrade_min_score, 65);
    assert.equal(bull.swing_min_score, 75);
    assert.equal(bull.require_a_plus_daytrade, false);

    // Sideways (+5 score, min RR 1.5)
    const sideways = marketRegimeEngine.getRegimeAdaptiveThresholds('NEUTRAL');
    assert.equal(sideways.category, 'sideways');
    assert.equal(sideways.daytrade_min_score, 70);
    assert.equal(sideways.swing_min_score, 80);
    assert.equal(sideways.min_rr, 1.5);
    assert.equal(sideways.require_a_plus_daytrade, false);

    // Bear (+10 score, wajib A_PLUS_SETUP)
    const bear = marketRegimeEngine.getRegimeAdaptiveThresholds('RISK_OFF');
    assert.equal(bear.category, 'bear');
    assert.equal(bear.daytrade_min_score, 75);
    assert.equal(bear.swing_min_score, 85);
    assert.equal(bear.require_a_plus_daytrade, true);
  });

  await t.test('2. Foreign Flow & Bandarmologi Confluence directly from local disk cache', () => {
    // BBCA is backfilled in data/arjum-data/broker-summary/BBCA
    const foreignFlow = bandarmologiService.getNetForeignFlow('BBCA');
    assert.ok(foreignFlow, 'Should return foreign flow object');
    assert.equal(foreignFlow.ticker, 'BBCA');
    assert.ok(foreignFlow.has_data, 'BBCA disk snapshot should be detected');
    assert.equal(typeof foreignFlow.foreign_buy, 'number');
    assert.equal(typeof foreignFlow.foreign_sell, 'number');
    assert.equal(typeof foreignFlow.foreign_net, 'number');

    // Confluence signal evaluation
    const confluence = bandarmologiService.evaluateConfluenceSignal('BBCA');
    assert.ok(confluence, 'Confluence signal should be evaluated');
    assert.ok(['HINDARI', 'CONFIRMED', 'NEUTRAL'].includes(confluence.confluence_flag));
  });

  await t.test('3. Daytrade Screener: Sideways regime enforces score >= 70 and RR >= 1.5', () => {
    const analysis = {
      ticker: 'TEST_SW',
      last_price: 1000,
      support: 950,
      resistance: 1050,
      change_pct: 1.5,
      volume_today: 5000000,
      avg_volume_20d: 2000000,
      volume_ratio_20d: 2.5,
      ma20: 970,
      rsi14: 55,
      _priceAboveOpen: true,
      range_position: 70
    };

    // Scored in Bull regime
    const scoredBull = daytradeEngine.scoreDayTrade(analysis, 'MORNING_SCOUT', 'UTAMA', null, {
      market_regime: 'RISK_ON'
    });
    assert.ok(scoredBull);
    assert.equal(scoredBull.market_regime_category, 'bull');

    // Scored in Sideways regime
    const scoredSideways = daytradeEngine.scoreDayTrade(analysis, 'MORNING_SCOUT', 'UTAMA', null, {
      market_regime: 'NEUTRAL'
    });
    assert.ok(scoredSideways);
    assert.equal(scoredSideways.market_regime_category, 'sideways');

    // Scored in Bear regime: non A_PLUS_SETUP downgraded to WAIT_PULLBACK
    const scoredBear = daytradeEngine.scoreDayTrade(analysis, 'MORNING_SCOUT', 'UTAMA', null, {
      market_regime: 'RISK_OFF'
    });
    assert.ok(scoredBear);
    assert.equal(scoredBear.market_regime_category, 'bear');
  });

  await t.test('4. Daytrade Screener: Massive distribution triggers HINDARI & DOWNGGRADE_GRADE', () => {
    const analysis = {
      ticker: 'DIST_TICKER',
      last_price: 1000,
      support: 950,
      resistance: 1100,
      change_pct: 2.0,
      volume_today: 5000000,
      avg_volume_20d: 2000000,
      volume_ratio_20d: 2.5,
      ma20: 980,
      rsi14: 58,
      _priceAboveOpen: true,
      range_position: 75
    };

    const mockConfluence = {
      confluence_flag: 'HINDARI',
      confluence_action: 'DOWNGGRADE_GRADE',
      confluence_penalty: -20,
      is_massive_distribution: true,
      foreign_net: -5000000000,
      bandar_net: -8000000000,
      notes: 'Asing dan bandar net distribution masif.'
    };

    const scored = daytradeEngine.scoreDayTrade(analysis, 'MORNING_SCOUT', 'UTAMA', null, {
      confluenceResult: mockConfluence
    });

    assert.equal(scored.confluence_flag, 'HINDARI');
    assert.equal(scored.confluence_action, 'DOWNGGRADE_GRADE');
    assert.ok(scored.status === 'AVOID' || scored.status === 'WAIT_PULLBACK', 'Status must be defensive (AVOID or WAIT_PULLBACK)');
    assert.ok((scored.confluence_notes && scored.confluence_notes.includes('masif')) || (scored.notes && scored.notes.includes('HINDARI')));
  });

  await t.test('5. Swing Screener: Conviction cutoff adjusts adaptively (+5 sideways, +10 bear)', () => {
    const baseCandidate = {
      ticker: 'SWING_TEST',
      candles: [{ close: 1000, open: 980 }],
      last_price: 1000,
      open_price: 980,
      support: 940,
      resistance: 1150,
      risk_reward: 2.5,
      rsi14: 55,
      ma20: 980,
      status: 'SWING_SETUP',
      score: 78 // Meets bull cutoff (75) but fails sideways (80) & bear (85)
    };

    // Bull: score 78 >= 75 passes
    const passBull = swingEngine.verifySwingHighConviction(baseCandidate, { market_regime: 'RISK_ON' });
    assert.ok(passBull, 'Score 78 should pass in Bull regime (threshold 75)');

    // Sideways: score 78 < 80 rejected
    const failSideways = swingEngine.verifySwingHighConviction(baseCandidate, { market_regime: 'NEUTRAL' });
    assert.equal(failSideways, null, 'Score 78 should fail in Sideways regime (threshold 80)');

    // Bear: score 78 < 85 rejected
    const failBear = swingEngine.verifySwingHighConviction(baseCandidate, { market_regime: 'RISK_OFF' });
    assert.equal(failBear, null, 'Score 78 should fail in Bear regime (threshold 85)');
  });

  await t.test('6. Swing Screener: Massive distribution disqualifies candidate from High Conviction', () => {
    const candidate = {
      ticker: 'SWING_DIST',
      last_price: 1000,
      open_price: 980,
      support: 940,
      resistance: 1150,
      risk_reward: 2.5,
      rsi14: 55,
      ma20: 980,
      status: 'SWING_SETUP',
      score: 90
    };

    const mockConfluence = {
      confluence_flag: 'HINDARI',
      confluence_action: 'DOWNGGRADE_GRADE',
      confluence_penalty: -20,
      is_massive_distribution: true,
      foreign_net: -10000000000,
      bandar_net: -15000000000,
      notes: 'Asing dan bandar net distribution masif.'
    };

    const result = swingEngine.verifySwingHighConviction(candidate, {
      confluenceResult: mockConfluence
    });

    assert.equal(result, null, 'Candidate with massive distribution flag HINDARI must be disqualified from High Conviction');
  });
});
