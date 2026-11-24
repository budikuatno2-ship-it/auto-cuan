'use strict';

/**
 * test/v6-saham-potensial-lifecycle.test.js
 * ============================================================================
 * Comprehensive Unit & Regression Test Suite for Subtask C:
 * - Saham Potensial Engine (Short Swing 2–5 Hari)
 * - Deterministic Top 20 & Top 5 pure subset logic (No Dummy Padding)
 * - Anti-Slop & Variable real market data metrics (PANI, PSAB, BRMS, DEWA, BUMI)
 * - Risk/Reward (R/R >= 1.5) on max_entry discipline
 * - Lifecycle state transitions & 2-5 days auto-expiry
 * - Date display & normalization (YYYY-MM-DD)
 * - Resilient Track Record & Backtest Reader (no BACKTEST_FILE_UNREADABLE panic)
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const spEngine = require('../lib/saham-potensial-engine');
const spLifecycle = require('../lib/saham-potensial-lifecycle');
const trReader = require('../lib/track-record-reader');
const trackRecordApi = require('../api/track-record');

test('Subtask C: 1. Risk/Reward calculation on max_entry', () => {
  // Case from problem statement:
  // entry_low: 1399, entry_high: 1420, SL: 1349, TP: 1519
  // At entry_low 1399: risk = 50, reward = 120 -> RR = 2.4
  // At max_entry 1420: risk = 71, reward = 99 -> RR = 99 / 71 = 1.3944 < 1.5
  // MUST NOT be actionable if R/R on max_entry < 1.5!
  const rr = spEngine.calculateConservativeRiskReward(1420, 1349, 1519);
  assert.ok(rr !== null);
  assert.equal(rr < 1.5, true, `Calculated RR (${rr}) must be strictly less than 1.5`);

  const cand = {
    ticker: 'PANI',
    as_of: '2026-11-09',
    last_price: 1405,
    entry_low: 1399,
    entry_high: 1420,
    sl: 1349,
    tp1: 1519,
    volume_ratio: 1.4,
    change_pct: 1.2,
    bandar_score: 80,
    foreign_flow_score: 75,
    technical_score: 70
  };
  const evalResult = spEngine.evaluateShortSwingCandidate(cand, { sessionDate: '2026-11-09' });
  assert.equal(evalResult.is_actionable, false, 'Candidate with RR < 1.5 on max_entry must not be actionable');
  assert.equal(evalResult.readiness, 'WATCHLIST');
  assert.match(evalResult.risk_flags.join(' '), /RR_BELOW_MINIMUM/);
});

test('Subtask C: 2. Actionable Short Swing Candidate when RR >= 1.5 on max_entry', () => {
  // Entry: 1000 - 1020, SL: 960 (risk = 60), TP1: 1120 (reward = 100) -> RR = 100 / 60 = 1.6667 >= 1.5
  //
  // Subtask H / P0-08: every scoring component must also carry a FRESH as-of
  // clock. A candidate whose bandar/foreign/technical/volume values exist but
  // whose provenance dates are missing is unproven, and the canonical engine
  // fail-closes it to WATCHLIST — so the clocks are declared explicitly here.
  const cand = {
    ticker: 'BRMS',
    as_of: '2026-11-09',
    price_asof: '2026-11-09',
    last_price: 1010,
    entry_low: 1000,
    entry_high: 1020,
    sl: 960,
    tp1: 1120,
    volume_ratio: 1.8,
    volume_asof: '2026-11-09',
    change_pct: 2.5,
    bandar_score: 80,
    bandar_asof: '2026-11-09',
    foreign_flow_score: 75,
    foreign_asof: '2026-11-09',
    technical_score: 70,
    technical_asof: '2026-11-09'
  };
  const evalResult = spEngine.evaluateShortSwingCandidate(cand, { sessionDate: '2026-11-09' });
  assert.equal(evalResult.is_actionable, true);
  assert.equal(evalResult.readiness, 'READY');
  assert.equal(evalResult.holding_horizon, 'Short Swing (2–5 Hari)');
  assert.equal(evalResult.holding_days_min, 2);
  assert.equal(evalResult.holding_days_max, 5);
});

test('Subtask H / P0-08: the same RR>=1.5 candidate WITHOUT component as-of clocks is NOT actionable', () => {
  // Regression guard for the exact fixture above: identical levels and scores,
  // but no provenance dates. The engine must refuse to promote it to READY.
  const cand = {
    ticker: 'BRMS',
    as_of: '2026-11-09',
    last_price: 1010,
    entry_low: 1000,
    entry_high: 1020,
    sl: 960,
    tp1: 1120,
    volume_ratio: 1.8,
    change_pct: 2.5,
    bandar_score: 80,
    foreign_flow_score: 75,
    technical_score: 70
  };
  const evalResult = spEngine.evaluateShortSwingCandidate(cand, { sessionDate: '2026-11-09' });
  assert.equal(evalResult.is_actionable, false);
  assert.equal(evalResult.readiness, 'WATCHLIST');
  assert.match(evalResult.status_reason, /FRESHNESS_UNKNOWN/);
  assert.ok(evalResult.risk_flags.includes('FRESHNESS_UNKNOWN_DEMOTION'));
});

test('Subtask C: 2b. Maximum Stop Loss <= 6% enforcement for Short Swing', () => {
  // Candidate with SL > 6% (e.g. entry_high = 1000, sl = 920 -> 8% stop loss distance)
  // Even with RR >= 1.5, excessive SL must cap the row at WATCHLIST
  const cand = {
    ticker: 'MEDC',
    as_of: '2026-11-09',
    price_asof: '2026-11-09',
    last_price: 990,
    entry_low: 980,
    entry_high: 1000,
    sl: 920, // 80 pts / 1000 = 8.0% > 6.0%
    tp1: 1150, // 150 pts / 80 pts = 1.875 >= 1.5
    volume_ratio: 1.8,
    volume_asof: '2026-11-09',
    change_pct: 1.5,
    bandar_score: 80,
    bandar_asof: '2026-11-09',
    foreign_flow_score: 75,
    foreign_asof: '2026-11-09',
    technical_score: 70,
    technical_asof: '2026-11-09'
  };
  const evalResult = spEngine.evaluateShortSwingCandidate(cand, { sessionDate: '2026-11-09', maxStopLossPct: 6.0 });
  assert.equal(evalResult.is_actionable, false, 'Candidate with SL > 6% must not be actionable');
  assert.equal(evalResult.readiness, 'WATCHLIST');
  assert.ok(evalResult.risk_flags.some(f => f.startsWith('SL_EXCEEDS_MAX')));
  assert.match(evalResult.status_reason, /Stop loss/);
});

test('Subtask C: 2c. Anti-stale plan: price deviation > 25% from entry plan marked invalid/stale', () => {
  // Plan entry was 1000, but current market price has deviated to 1300 (> 25% away)
  const cand = {
    ticker: 'ADRO',
    as_of: '2026-11-09',
    price_asof: '2026-11-09',
    last_price: 1300, // 30% deviation from max_entry 1000
    entry_low: 980,
    entry_high: 1000,
    sl: 950,
    tp1: 1100,
    volume_ratio: 1.8,
    volume_asof: '2026-11-09',
    change_pct: 2.0,
    bandar_score: 80,
    bandar_asof: '2026-11-09',
    foreign_flow_score: 75,
    foreign_asof: '2026-11-09',
    technical_score: 70,
    technical_asof: '2026-11-09'
  };
  const evalResult = spEngine.evaluateShortSwingCandidate(cand, { sessionDate: '2026-11-09' });
  assert.equal(evalResult.is_actionable, false, 'Plan with price deviation > 25% must not be actionable');
  assert.equal(evalResult.readiness, 'NOT_READY');
  assert.ok(evalResult.risk_flags.includes('STALE_PLAN_REJECTED'));
  assert.match(evalResult.status_reason, /STALE_PLAN/);
});

test('Subtask C: 3. Dynamic Universe & Real Variable Metrics (No Uniform Dummy)', () => {
  // Bug video REQ-04 & REQ-05: PANI, PSAB, BRMS, DEWA, BUMI must not have uniform metrics (1.420, +3.50%, 2.1x)
  const tickers = [
    { ticker: 'PANI', as_of: '2026-11-09', last_price: 1520, change_pct: 4.12, volume_ratio: 2.3, entry_low: 1480, entry_high: 1530, sl: 1400, tp1: 1750, bandar_score: 82, foreign_flow_score: 78, technical_score: 74 },
    { ticker: 'PSAB', as_of: '2026-11-09', last_price: 340, change_pct: -1.45, volume_ratio: 1.1, entry_low: 330, entry_high: 345, sl: 310, tp1: 410, bandar_score: 76, foreign_flow_score: 70, technical_score: 68 },
    { ticker: 'BRMS', as_of: '2026-11-09', last_price: 410, change_pct: 6.77, volume_ratio: 3.5, entry_low: 395, entry_high: 415, sl: 380, tp1: 490, bandar_score: 88, foreign_flow_score: 84, technical_score: 80 },
    { ticker: 'DEWA', as_of: '2026-11-09', last_price: 115, change_pct: 0.88, volume_ratio: 1.7, entry_low: 110, entry_high: 118, sl: 104, tp1: 140, bandar_score: 72, foreign_flow_score: 66, technical_score: 64 },
    { ticker: 'BUMI', as_of: '2026-11-09', last_price: 142, change_pct: 2.16, volume_ratio: 2.0, entry_low: 138, entry_high: 144, sl: 130, tp1: 170, bandar_score: 78, foreign_flow_score: 72, technical_score: 70 }
  ];

  const snapshot = spEngine.buildSahamPotensialSnapshot(tickers, { sessionDate: '2026-11-09' });

  // Verify non-uniform values
  const prices = new Set(snapshot.top5.map(t => t.last_price));
  const changes = new Set(snapshot.top5.map(t => t.change_pct));
  const vrs = new Set(snapshot.top5.map(t => t.volume_ratio));

  assert.equal(prices.size, 5, 'Prices across PANI, PSAB, BRMS, DEWA, BUMI must be completely distinct');
  assert.equal(changes.size, 5, 'Change percentages must be completely distinct');
  assert.equal(vrs.size, 5, 'Volume ratios must be completely distinct');
});

test('Subtask C: 4. Top 20 & Top 5 Determinism and Pure Subset (No Padding)', () => {
  // Test case with fewer than 5 candidates: NO dummy padding permitted!
  const smallCandidates = [
    { ticker: 'BBCA', as_of: '2026-11-09', last_price: 10000, entry_low: 9900, entry_high: 10050, sl: 9600, tp1: 11000, volume_ratio: 1.6, change_pct: 1.0, bandar_score: 80, foreign_flow_score: 75, technical_score: 70 },
    { ticker: 'BBRI', as_of: '2026-11-09', last_price: 5200, entry_low: 5100, entry_high: 5250, sl: 4950, tp1: 5800, volume_ratio: 1.8, change_pct: 1.5, bandar_score: 78, foreign_flow_score: 74, technical_score: 69 },
    { ticker: 'BMRI', as_of: '2026-11-09', last_price: 6800, entry_low: 6700, entry_high: 6850, sl: 6500, tp1: 7500, volume_ratio: 1.4, change_pct: 0.5, bandar_score: 76, foreign_flow_score: 72, technical_score: 68 }
  ];

  const snapshotSmall = spEngine.buildSahamPotensialSnapshot(smallCandidates);
  assert.equal(snapshotSmall.top20.length, 3, 'Top 20 must contain exactly 3 candidates without dummy padding');
  assert.equal(snapshotSmall.top5.length, 3, 'Top 5 must contain exactly 3 candidates without dummy padding');
  assert.deepEqual(snapshotSmall.top5, snapshotSmall.top20, 'Top 5 must be an exact subset of Top 20');

  // Test case with 25 candidates: Top 20 must have 20, Top 5 must have 5, and Top 5 is first 5 of Top 20
  const manyCandidates = [];
  for (let i = 1; i <= 25; i++) {
    manyCandidates.push({
      ticker: `TK${i < 10 ? '0' + i : i}`,
      as_of: '2026-11-09',
      last_price: 1000 + i * 10,
      entry_low: 980 + i * 10,
      entry_high: 1020 + i * 10,
      sl: 900 + i * 10,
      tp1: 1250 + i * 10,
      volume_ratio: 1.0 + (i * 0.05),
      change_pct: 1.0 + (i * 0.1),
      bandar_score: 80,
      foreign_flow_score: 75,
      technical_score: 70
    });
  }

  const snapshotMany = spEngine.buildSahamPotensialSnapshot(manyCandidates);
  assert.equal(snapshotMany.top20.length, 20, 'Top 20 must cap at 20');
  assert.equal(snapshotMany.top5.length, 5, 'Top 5 must cap at 5');
  assert.deepEqual(snapshotMany.top5, snapshotMany.top20.slice(0, 5), 'Top 5 must be pure first 5 of Top 20');
});

test('Subtask C: 5. Short Swing Lifecycle State Machine Transitions', () => {
  const pick = {
    id: 101,
    ticker: 'TEST',
    date: '2026-11-01',
    entry_low: 1000,
    entry_high: 1050,
    sl: 950,
    tp1: 1200,
    tp2: 1300,
    status: 'WAITING_ENTRY'
  };

  // Scenario 1: Reaches entry on day 1, hits TP1 on day 2
  const candlesTp1 = [
    { trade_date: '2026-11-02', open: 1080, high: 1090, low: 1020, close: 1060 }, // Enters entry zone (low 1020 <= maxEntry 1050)
    { trade_date: '2026-11-03', open: 1070, high: 1210, low: 1060, close: 1190 }  // Hits TP1 (high 1210 >= tp1 1200)
  ];
  const res1 = spLifecycle.evaluateLifecycleHistory(pick, candlesTp1);
  assert.equal(res1.currentState, 'TP1_HIT');
  assert.equal(res1.isTerminal, true);
  assert.equal(res1.entryDate, '2026-11-02');
  assert.equal(res1.exitDate, '2026-11-03');
  assert.ok(res1.gainPct > 0);

  // Scenario 2: Invalidated before entry (SL breached before touching entry)
  const candlesInvalid = [
    { trade_date: '2026-11-02', open: 980, high: 990, low: 940, close: 945 } // low 940 <= sl 950, never touched entry 1000-1050
  ];
  const res2 = spLifecycle.evaluateLifecycleHistory(pick, candlesInvalid);
  assert.equal(res2.currentState, 'INVALIDATED_BEFORE_ENTRY');
  assert.equal(res2.isTerminal, true);
  assert.equal(res2.entryDate, null);

  // Scenario 3: Expired without entry after 5 trading days
  const candlesExpired = [
    { trade_date: '2026-11-02', high: 1150, low: 1060, close: 1100 },
    { trade_date: '2026-11-03', high: 1140, low: 1070, close: 1090 },
    { trade_date: '2026-11-04', high: 1130, low: 1065, close: 1080 },
    { trade_date: '2026-11-05', high: 1120, low: 1060, close: 1075 },
    { trade_date: '2026-11-06', high: 1110, low: 1060, close: 1070 }
  ];
  const res3 = spLifecycle.evaluateLifecycleHistory(pick, candlesExpired);
  assert.equal(res3.currentState, 'EXPIRED_NO_ENTRY');
  assert.equal(res3.isTerminal, true);

  // Scenario 4: Time exit after 5 days entered without hitting TP or SL
  const candlesTimeExit = [
    { trade_date: '2026-11-02', high: 1060, low: 1030, close: 1040 }, // Entered
    { trade_date: '2026-11-03', high: 1080, low: 1020, close: 1050 },
    { trade_date: '2026-11-04', high: 1090, low: 1025, close: 1060 },
    { trade_date: '2026-11-05', high: 1100, low: 1030, close: 1070 },
    { trade_date: '2026-11-06', high: 1110, low: 1040, close: 1080 }
  ];
  const res4 = spLifecycle.evaluateLifecycleHistory(pick, candlesTimeExit);
  assert.equal(res4.currentState, 'TIME_EXIT');
  assert.equal(res4.isTerminal, true);
  assert.equal(res4.holdingDays, 5);
});

test('Subtask K: 5b. Same-bar TP+SL resolves AMBIGUOUS_SAME_BAR (never a win or loss)', () => {
  const pick = {
    id: 102, ticker: 'AMBIG', date: '2026-11-01',
    entry_low: 1000, entry_high: 1050, sl: 950, tp1: 1200, tp2: 1300, status: 'WAITING_ENTRY'
  };
  // One single daily bar spans entry, TP1 (1200) AND SL (950). Daily OHLC cannot
  // order the intra-bar path, so the outcome must be AMBIGUOUS, not TP1_HIT.
  const candles = [
    { trade_date: '2026-11-02', open: 1010, high: 1250, low: 900, close: 1000 }
  ];
  const res = spLifecycle.evaluateLifecycleHistory(pick, candles);
  assert.equal(res.currentState, 'AMBIGUOUS_SAME_BAR');
  assert.equal(res.isTerminal, true);
  assert.equal(res.exitPrice, null, 'ambiguous exit must not claim a TP or SL price');
  assert.equal(res.gainPct, null, 'no realized gain can be claimed for an ambiguous bar');
  assert.ok(spLifecycle.STATES.AMBIGUOUS_SAME_BAR === 'AMBIGUOUS_SAME_BAR');
});

test('Subtask K: 5c. A bar touching SL AND entry zone (no target) is NOT optimistically invalidated', () => {
  const pick = {
    id: 103, ticker: 'WIDE', date: '2026-11-01',
    entry_low: 1000, entry_high: 1050, sl: 950, tp1: 1200, tp2: 1300, status: 'WAITING_ENTRY'
  };
  // low (900) breaches SL, but high (1100) reaches the entry zone: the true
  // intrabar order is unknown, so "INVALIDATED_BEFORE_ENTRY" would be an
  // overconfident no-entry claim.
  const candles = [
    { trade_date: '2026-11-02', open: 1010, high: 1100, low: 900, close: 1000 }
  ];
  const res = spLifecycle.evaluateLifecycleHistory(pick, candles);
  assert.equal(res.currentState, 'AMBIGUOUS_SAME_BAR');
  assert.equal(res.isTerminal, true);
});

test('Subtask K: 5d. SL-only breach without touching entry remains INVALIDATED_BEFORE_ENTRY', () => {
  const pick = {
    id: 104, ticker: 'SLONLY', date: '2026-11-01',
    entry_low: 1000, entry_high: 1050, sl: 950, tp1: 1200, tp2: 1300, status: 'WAITING_ENTRY'
  };
  const candles = [
    { trade_date: '2026-11-02', open: 980, high: 990, low: 940, close: 945 }
  ];
  const res = spLifecycle.evaluateLifecycleHistory(pick, candles);
  assert.equal(res.currentState, 'INVALIDATED_BEFORE_ENTRY');
  assert.equal(res.isTerminal, true);
});

test('Subtask K: 5e. resolveSameBarExit precedence (TP2 -> TP1 -> SL -> null)', () => {
  assert.equal(spLifecycle.resolveSameBarExit(1300, 1000, 1200, 1300, 950).event, 'TP2_HIT');
  assert.equal(spLifecycle.resolveSameBarExit(1250, 1000, 1200, 1300, 950).event, 'TP1_HIT');
  assert.equal(spLifecycle.resolveSameBarExit(1100, 940, 1200, 1300, 950).event, 'STOP_LOSS');
  assert.equal(spLifecycle.resolveSameBarExit(1100, 1000, 1200, 1300, 950), null);
  // A target AND the stop in one bar is ambiguous in every case.
  assert.equal(spLifecycle.resolveSameBarExit(1250, 940, 1200, 1300, 950).event, 'AMBIGUOUS_SAME_BAR');
  assert.equal(spLifecycle.resolveSameBarExit(1250, 940, 1200, 1300, 950).exitPrice, null);
});

test('Subtask C: 6. Date Normalization (YYYY-MM-DD)', () => {
  assert.equal(spLifecycle.normalizeDateYmd('2026-06-15T00:00:00.000Z'), '2026-06-15');
  assert.equal(spLifecycle.normalizeDateYmd('2026-07-20'), '2026-07-20');
  assert.equal(spLifecycle.normalizeDateYmd(new Date('2026-11-09T10:00:00Z')), '2026-11-09');
});

test('Subtask C: 7. Resilient Track Record & Backtest Reader', async () => {
  // Test reading backtest data safely
  const res = trReader.loadBacktestData();
  assert.equal(res.success, true);
  assert.ok(res.data && Array.isArray(res.data.tickers));
  assert.ok(res.data.tickers.length > 900);

  // Test ticker lookup
  const bbcaRecord = trReader.getTickerBacktestRecord('BBCA', res.data);
  assert.ok(bbcaRecord !== null);
  assert.equal(bbcaRecord.ticker, 'BBCA');

  // Test api/track-record output without BACKTEST_FILE_UNREADABLE
  const payload = await trackRecordApi({}, null);
  assert.equal(payload.success, true);
  assert.ok(payload.summary.total_signals > 0 || payload.signals.length > 0);
  assert.notEqual(payload.error, 'BACKTEST_FILE_UNREADABLE');
});
