'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dtEngine = require('../lib/daytrade-screener-engine');
const dtEngineV7 = require('../lib/daytrade-screener-engine-v7');
const dtConstants = require('../lib/daytrade-screener-constants');
const sectorHot = require('../api/sector-hot');
const {
  scoreAndClassify,
  calculateNkSetupScore,
  evaluateMonitorStatus,
  selectTopCandidatesWithSectorDiversification,
  candidatePassesMinUpside,
  getMinTp1UpsideForCategory
} = sectorHot.__test;

test('Fase 3: Base Score is 25 and Tradeable Threshold is 65', () => {
  assert.equal(dtConstants.BASE_SCORE, 25);
  assert.equal(dtConstants.TRADEABLE_SCORE_THRESHOLD, 65);
  assert.equal(dtEngine.BASE_SCORE, 25);
  assert.equal(dtEngine.TRADEABLE_SCORE_THRESHOLD, 65);
  assert.equal(dtEngineV7.BASE_SCORE, 25);
  assert.equal(dtEngineV7.TRADEABLE_SCORE_THRESHOLD, 65);
});

test('Fase 3: Volume Surge scoring tiers', () => {
  assert.equal(dtEngine.scoreVolumeSurge({ volume_ratio_20d: 2.5 }), 30);
  assert.equal(dtEngine.scoreVolumeSurge({ volume_ratio_20d: 2.0 }), 30);
  assert.equal(dtEngine.scoreVolumeSurge({ volume_ratio_20d: 1.8 }), 20);
  assert.equal(dtEngine.scoreVolumeSurge({ volume_ratio_20d: 1.5 }), 20);
  assert.equal(dtEngine.scoreVolumeSurge({ volume_ratio_20d: 1.3 }), 10);
  assert.equal(dtEngine.scoreVolumeSurge({ volume_ratio_20d: 1.25 }), 10);
  assert.equal(dtEngine.scoreVolumeSurge({ volume_ratio_20d: 0.95 }), 0);
  assert.equal(dtEngine.scoreVolumeSurge(null), 0);
});

test('Fase 3: Order Flow & Velocity scoring', () => {
  // Delta turnover >= 1B -> 15 points
  assert.equal(dtEngine.scoreOrderFlowVelocity({ delta_turnover_15m: 1500000000 }), 15);
  // Bid dominance > 58% -> 10 points
  assert.equal(dtEngine.scoreOrderFlowVelocity({ bid_dominance: 0.60 }), 10);
  assert.equal(dtEngine.scoreOrderFlowVelocity({ bid_dominance: 65 }), 10);
  // No order flow edge
  assert.equal(dtEngine.scoreOrderFlowVelocity({ delta_turnover_15m: 200000000, bid_dominance: 0.50 }), 0);
});

test('Fase 3: Stock with volume_ratio < 1.0 cannot exceed score 64 (hard ceiling)', () => {
  const lowVolStock = {
    volume_ratio_20d: 0.8,
    change_pct: 3.5,
    rsi14: 55,
    _priceAboveOpen: true,
    distance_to_breakout_pct: 1.0,
    range_position: 70,
    delta_turnover_15m: 2000000000,
    bid_dominance: 0.65
  };
  const score = dtEngine.calculateDayTradeScore(lowVolStock);
  assert.ok(score < 65, `Score ${score} must be strictly < 65 for low volume stock`);
  assert.ok(score <= 64, `Score ${score} must be <= 64`);
});

test('Fase 3: Stock with strong volume surge & order flow can pass 65', () => {
  const highVolStock = {
    volume_ratio_20d: 2.2, // +30
    delta_turnover_15m: 1500000000, // +15
    change_pct: 2.5, // +8
    rsi14: 60, // +8
    _priceAboveOpen: true, // +4
    distance_to_breakout_pct: 1.5, // +5
    range_position: 75 // +5
  };
  const score = dtEngine.calculateDayTradeScore(highVolStock);
  assert.ok(score >= 65, `Score ${score} should comfortably pass 65 with strong volume surge`);
});

test('Fase 3: Swing Konglo MA20/MA50 bonus is NOT awarded when volume ratio < 1.0', () => {
  const lowVolSetup = {
    last_price: 1000,
    ma20: 950,
    ma50: 900,
    volume_ratio_avg20: 0.8,
    rsi14: 35,
    risk_reward: 1.0
  };
  const highVolSetup = Object.assign({}, lowVolSetup, {
    volume_ratio_avg20: 1.0
  });

  const resLow = scoreAndClassify(lowVolSetup);
  const resHigh = scoreAndClassify(highVolSetup);

  // Both have same base volume bonus (+5 for 0.8-1.0), but highVol gets MA20 (+10) and MA50 (+10)
  assert.equal(resHigh.score - resLow.score, 20, `Difference between high vol (${resHigh.score}) and low vol (${resLow.score}) must be exactly 20 points`);
});

test('Fase 3: Swing Non-Konglo MA20/MA50 bonus is NOT awarded when volume ratio < 1.0', () => {
  const lowVolSetup = {
    lastPrice: 1000,
    last_price: 1000,
    ma20: 950,
    ma50: 900,
    volumeRatioAvg20: 0.8,
    rsi14: 35,
    riskReward: 1.0,
    entryLow: 980,
    entryHigh: 1000,
    stopLoss: 950,
    tp1: 1050,
    tp2: 1100,
    support: 950,
    resistance: 1100,
    change_pct: 1.0,
    avgTxValue20d: 10000000000,
    tradedDays20d: 20
  };
  const highVolSetup = Object.assign({}, lowVolSetup, {
    volumeRatioAvg20: 1.0
  });

  const resLow = calculateNkSetupScore(lowVolSetup);
  const resHigh = calculateNkSetupScore(highVolSetup);

  assert.equal(resHigh.score - resLow.score, 20, `Difference between high vol (${resHigh.score}) and low vol (${resLow.score}) must be exactly 20 points`);
});

test('Fase 3: selectTopCandidatesWithSectorDiversification enforces Top 10 and max 3 per sector', () => {
  const candidates = [
    { ticker: 'AAA1', daytrade_score: 90, sector: 'Financials' },
    { ticker: 'AAA2', daytrade_score: 88, sector: 'Financials' },
    { ticker: 'AAA3', daytrade_score: 86, sector: 'Financials' },
    { ticker: 'AAA4', daytrade_score: 85, sector: 'Financials' },
    { ticker: 'AAA5', daytrade_score: 84, sector: 'Financials' },
    { ticker: 'BBB1', daytrade_score: 82, sector: 'Technology' },
    { ticker: 'BBB2', daytrade_score: 80, sector: 'Technology' },
    { ticker: 'BBB3', daytrade_score: 79, sector: 'Technology' },
    { ticker: 'BBB4', daytrade_score: 78, sector: 'Technology' },
    { ticker: 'CCC1', daytrade_score: 75, sector: 'Energy' },
    { ticker: 'CCC2', daytrade_score: 74, sector: 'Energy' },
    { ticker: 'CCC3', daytrade_score: 73, sector: 'Energy' },
    { ticker: 'DDD1', daytrade_score: 70, sector: 'Basic Materials' },
    { ticker: 'DDD2', daytrade_score: 69, sector: 'Basic Materials' },
    { ticker: 'LOW1', daytrade_score: 60, sector: 'Healthcare' }
  ];

  const selected = selectTopCandidatesWithSectorDiversification(candidates, 10, 3);
  assert.equal(selected.length, 10);

  const counts = {};
  selected.forEach(c => {
    counts[c.sector] = (counts[c.sector] || 0) + 1;
  });

  assert.equal(counts['Financials'], 3, 'Financials should be capped at 3');
  assert.equal(counts['Technology'], 3, 'Technology should be capped at 3');
  assert.equal(counts['Energy'], 3, 'Energy should be capped at 3');
  assert.equal(counts['Basic Materials'], 1, 'Basic Materials gets the remaining 1 spot');
  assert.ok(!counts['Healthcare'], 'LOW1 with score < 65 must not be included');

  const tickers = selected.map(c => c.ticker);
  assert.deepEqual(tickers, ['AAA1', 'AAA2', 'AAA3', 'BBB1', 'BBB2', 'BBB3', 'CCC1', 'CCC2', 'CCC3', 'DDD1']);
});

test('Fase 4: Dynamic Break-Even Exit Lock (+2.0% profit triggers BEP_CLOSED upon pullback)', () => {
  const activePick = {
    ticker: 'AUTO',
    category: 'Day Trade',
    status: 'RUNNING',
    entry1: 1000,
    entry2: 1000,
    sl: 960,
    initial_sl: 960,
    tp1: 1050,
    tp2: 1100,
    hit_entry_at: '2026-09-11T09:05:00.000Z'
  };

  // Case 1: High reaches 1025 (+2.5%, >= +2.0%), triggers BEP lock
  const pxSurge = {
    last: 1025,
    high: 1025,
    low: 1010,
    source: 'intraday'
  };
  const evSurge = evaluateMonitorStatus(activePick, pxSurge);
  assert.equal(evSurge.status, 'RUNNING');
  assert.equal(evSurge.bep_locked, true, 'BEP lock must be activated when profit >= +2.0%');
  assert.ok(evSurge.effective_sl >= 1000, 'Effective SL must be moved to entry or higher (entry + 1 tick)');

  // Case 2: Price subsequent candle pulls back to 980 (below BEP level 1005)
  const lockedPick = Object.assign({}, activePick, {
    bep_locked: true,
    high_since_entry: 1025,
    effective_sl: 1005
  });

  const pxPullback = {
    last: 980,
    high: 1010,
    low: 980,
    source: 'intraday'
  };
  const evExit = evaluateMonitorStatus(lockedPick, pxPullback);
  assert.equal(evExit.status, 'BEP_CLOSED', 'Must exit as BEP_CLOSED, NOT SL_HIT');
  assert.equal(evExit.isFinal, true, 'BEP_CLOSED is a final state');
  assert.equal(evExit.bep_locked, true);
  assert.equal(evExit.loss_pct, 0, 'Loss percent is 0 on BEP close');

  // Case 3: Control - Stock only reaches 1010 (+1.0%, < +2.0%) then drops to 950
  const controlPick = {
    ticker: 'CTRL',
    category: 'Day Trade',
    status: 'RUNNING',
    entry1: 1000,
    entry2: 1000,
    sl: 960,
    tp1: 1050,
    tp2: 1100,
    hit_entry_at: '2026-09-11T09:05:00.000Z',
    high_since_entry: 1010
  };
  const pxDrop = {
    last: 950,
    high: 1005,
    low: 950,
    source: 'intraday'
  };
  const evSl = evaluateMonitorStatus(controlPick, pxDrop);
  assert.equal(evSl.status, 'SL_HIT', 'Must exit as SL_HIT when profit never reached +2.0%');
  assert.equal(evSl.isFinal, true);
});

test('Fase 4: Non-Konglo TP1 fallback upside is 4.5% and passes candidatePassesMinUpside', () => {
  const fallback = getMinTp1UpsideForCategory('Swing Non-Konglo');
  assert.equal(fallback, 4.5, 'Fallback for Non-Konglo must be 4.5%');

  const nkCandidate = {
    ticker: 'MEDC',
    category: 'Swing Non-Konglo',
    entry_low: 1000,
    entry_high: 1000,
    tp1: 1050
  };
  assert.ok(candidatePassesMinUpside(nkCandidate), '5% intermediate TP1 must pass candidatePassesMinUpside');
});
