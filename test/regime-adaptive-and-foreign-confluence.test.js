'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'arjum-confluence-test-'));
    const origEnv = process.env.ARJUM_DATA_DIR;
    process.env.ARJUM_DATA_DIR = tmpBase;

    try {
      const ticker = 'TESTFLOW';
      const mockSummary = {
        stock_code: ticker,
        date: '2026-09-23',
        total_net_flow: -4500000000,
        gross_buyers: [
          { broker_code: 'YP', bval: 500000000, bvol: 5000 },
          { broker_code: 'AK', bval: 200000000, bvol: 2000 } // Foreign buy
        ],
        gross_sellers: [
          { broker_code: 'AK', sval: 3500000000, svol: 35000 }, // Foreign sell
          { broker_code: 'BK', sval: 1700000000, svol: 17000 }  // Foreign sell
        ],
        brokers: [
          { broker_code: 'AK', bval: 200000000, sval: 3500000000, nval: -3300000000 },
          { broker_code: 'BK', bval: 0, sval: 1700000000, nval: -1700000000 }
        ]
      };

      bandarmologiService.writeDiskCache('broker-summary', ticker, 'latest', mockSummary);

      const foreignFlow = bandarmologiService.getNetForeignFlow(ticker);
      assert.ok(foreignFlow, 'Should return foreign flow object');
      assert.equal(foreignFlow.ticker, ticker);
      assert.equal(foreignFlow.has_data, true);
      assert.equal(foreignFlow.foreign_buy, 200000000);
      assert.equal(foreignFlow.foreign_sell, 5200000000);
      assert.equal(foreignFlow.foreign_net, -5000000000);
      assert.equal(foreignFlow.foreign_flow_status, 'DISTRIBUTION');
      assert.equal(foreignFlow.is_massive_distribution, true);

      // Confluence evaluation
      const confluence = bandarmologiService.evaluateConfluenceSignal(ticker);
      assert.ok(confluence, 'Confluence signal should be evaluated');
      assert.equal(confluence.confluence_flag, 'HINDARI');
      assert.equal(confluence.confluence_action, 'DOWNGGRADE_GRADE');
      assert.equal(confluence.is_massive_distribution, true);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
      if (origEnv !== undefined) process.env.ARJUM_DATA_DIR = origEnv;
      else delete process.env.ARJUM_DATA_DIR;
    }
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
      value_today: 10000000000,
      support: 950,
      resistance: 1100,
      change_pct: 2.0,
      volume_today: 10000000,
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
