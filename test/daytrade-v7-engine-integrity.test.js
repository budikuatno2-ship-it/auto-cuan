'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dtEngine = require('../lib/daytrade-screener-engine');
const candleEngine = require('../lib/candle-pattern-engine');
const volumePace = require('../lib/intraday-volume-pace');
const watcherMomentum = require('../lib/intraday-fast-watcher-momentum');
const watcherLive = require('../lib/intraday-fast-watcher-live');
const sectorHot = require('../api/sector-hot');

// Helper to build base parameters for classifyStatus
function baseClassifyParams(compositeScore, dataOverrides, levelsOverrides) {
  const data = Object.assign({
    ticker: 'TEST',
    last_price: 1000,
    open_price: 990,
    high_price: 1020,
    low_price: 980,
    change_pct: 1.5,
    volume_ratio_20d: 1.5,
    distance_to_breakout_pct: 2.0,
    range_position: 70,
    value_today: 15000000000,
    avg_value_7d: 8000000000,
    _priceAboveOpen: true,
    _overextendedMA20: false,
    rsi14: 55,
    support: 950,
    resistance: 1050
  }, dataOverrides || {});

  const levels = Object.assign({
    entry_low: 990,
    entry_high: 1005,
    stop_loss: 970,
    tp1: 1040,
    tp2: 1080,
    risk_reward: 2.0,
    _riskDistPct: 2.5
  }, levelsOverrides || {});

  const liqResult = { score: 20, pass: true, reason: 'Good liquidity' };
  const penaltyResult = { penalty: 0, reasons: [] };
  const board = 'REGULER';
  const runMode = 'MORNING';
  const candleDowngrade = false;

  return { compositeScore, data, levels, liqResult, penaltyResult, board, runMode, candleDowngrade };
}

// ============================================================
// 1. Urutan Evaluasi Early Radar vs Prespike (PR #518)
// ============================================================
test('Cluster 2 - Focus 1: Confirmed volume (>= 1.2x) with score 70-74 qualifies for PRE_SPIKE_WATCH, not downgraded to EARLY_RADAR', () => {
  const { compositeScore, data, levels, liqResult, penaltyResult, board, runMode, candleDowngrade } = baseClassifyParams(72, {
    volume_ratio_20d: 1.5,
    distance_to_breakout_pct: 2.0,
    change_pct: 2.0
  });

  const res = dtEngine.classifyStatus(compositeScore, data, levels, liqResult, penaltyResult, board, runMode, candleDowngrade);
  assert.equal(res.status, 'PRE_SPIKE_WATCH');
  assert.match(res.notes, /Volume mulai masuk/);
});

test('Cluster 2 - Focus 1: Unconfirmed volume (< 1.2x) with score >= 70 near breakout correctly routes to EARLY_RADAR', () => {
  const { compositeScore, data, levels, liqResult, penaltyResult, board, runMode, candleDowngrade } = baseClassifyParams(72, {
    volume_ratio_20d: 0.9,
    distance_to_breakout_pct: 2.0,
    change_pct: 1.0
  });

  const res = dtEngine.classifyStatus(compositeScore, data, levels, liqResult, penaltyResult, board, runMode, candleDowngrade);
  assert.equal(res.status, 'EARLY_RADAR');
  assert.match(res.notes, /vol 0\.90x/);
});

test('Cluster 2 - Focus 1: Unconfirmed volume (< 1.2x) with score >= 70 far from breakout routes to SPECULATIVE', () => {
  const { compositeScore, data, levels, liqResult, penaltyResult, board, runMode, candleDowngrade } = baseClassifyParams(72, {
    volume_ratio_20d: 0.8,
    distance_to_breakout_pct: 5.0,
    change_pct: 1.0
  });

  const res = dtEngine.classifyStatus(compositeScore, data, levels, liqResult, penaltyResult, board, runMode, candleDowngrade);
  assert.equal(res.status, 'SPECULATIVE');
  assert.match(res.notes, /Belum ada konfirmasi volume/);
});

test('Cluster 2 - Focus 1: Thin anomaly (jump > 5% without volume >= 1.5) triggers Gap/Overheat guard -> WAIT_PULLBACK', () => {
  const { compositeScore, data, levels, liqResult, penaltyResult, board, runMode, candleDowngrade } = baseClassifyParams(75, {
    volume_ratio_20d: 1.1, // thin volume (< 1.5)
    change_pct: 5.5        // sudden jump
  });

  const res = dtEngine.classifyStatus(compositeScore, data, levels, liqResult, penaltyResult, board, runMode, candleDowngrade);
  assert.equal(res.status, 'WAIT_PULLBACK');
  assert.match(res.notes, /Hindari chase/);
});

test('Cluster 2 - Focus 1: Regression Test - volume_ratio_20d null does NOT throw TypeError and formats as N/A', () => {
  const { compositeScore, data, levels, liqResult, penaltyResult, board, runMode, candleDowngrade } = baseClassifyParams(72, {
    volume_ratio_20d: null,
    distance_to_breakout_pct: 2.0,
    change_pct: 1.0
  });

  assert.doesNotThrow(() => {
    const res = dtEngine.classifyStatus(compositeScore, data, levels, liqResult, penaltyResult, board, runMode, candleDowngrade);
    assert.equal(res.status, 'EARLY_RADAR');
    assert.match(res.notes, /vol N\/A/);
  });
});

// ============================================================
// 2. Opening Velocity Guard & Pace Volume (PR #612)
// ============================================================
test('Cluster 2 - Focus 2: Opening Velocity Guard rejects low delta turnover in 09:16-09:30 WIB window for Main board', () => {
  const evalGuard = watcherMomentum.evaluateOpeningVelocityGuard({
    scheduled_time: '09:20',
    board: 'UTAMA',
    obs: {
      delta_turnover_5m: 100000000 // 100M (< 250M required)
    }
  });

  assert.equal(evalGuard.in_window, true);
  assert.equal(evalGuard.passes, false);
  assert.equal(evalGuard.reason, 'opening_range_velocity_insufficient');
  assert.equal(evalGuard.threshold, 250000000);
});

test('Cluster 2 - Focus 2: Opening Velocity Guard passes high delta turnover in 09:16-09:30 WIB window for Main board', () => {
  const evalGuard = watcherMomentum.evaluateOpeningVelocityGuard({
    scheduled_time: '09:20',
    board: 'UTAMA',
    obs: {
      delta_turnover_5m: 300000000 // 300M (>= 250M required)
    }
  });

  assert.equal(evalGuard.in_window, true);
  assert.equal(evalGuard.passes, true);
  assert.equal(evalGuard.reason, 'opening_range_velocity_passed');
});

test('Cluster 2 - Focus 2: Opening Velocity Guard applies 100M threshold for Acceleration Board', () => {
  const evalGuardFail = watcherMomentum.evaluateOpeningVelocityGuard({
    scheduled_time: '09:25',
    board: 'AKSELERASI',
    obs: {
      delta_turnover_5m: 80000000 // 80M (< 100M required)
    }
  });
  assert.equal(evalGuardFail.passes, false);
  assert.equal(evalGuardFail.threshold, 100000000);

  const evalGuardPass = watcherMomentum.evaluateOpeningVelocityGuard({
    scheduled_time: '09:25',
    board: 'AKSELERASI',
    obs: {
      delta_turnover_5m: 150000000 // 150M (>= 100M required)
    }
  });
  assert.equal(evalGuardPass.passes, true);
});

test('Cluster 2 - Focus 2: Opening Velocity Guard is inactive after 09:30 WIB', () => {
  const evalGuard = watcherMomentum.evaluateOpeningVelocityGuard({
    scheduled_time: '09:35',
    board: 'UTAMA',
    obs: {
      delta_turnover_5m: 50000000 // 50M
    }
  });

  assert.equal(evalGuard.in_window, false);
  assert.equal(evalGuard.passes, true);
});

test('Cluster 2 - Focus 2: Volume pace zero-division immunity at exactly 09:00:00', () => {
  const progress = volumePace.sessionProgress('2026-09-10', '09:00');
  assert.equal(progress.active_trading_minutes, 0);
  assert.equal(progress.session_progress_fraction, 0);
  assert.equal(progress.effective_session_progress, null);

  const paceResult = volumePace.calculateVolumePace({
    sample_date: '2026-09-10',
    scheduled_time: '09:00',
    volume_today: 50000,
    avg_volume_20d: 500000,
    previous_day_volume: 450000
  });

  assert.equal(paceResult.projected_full_day_volume, null);
  assert.equal(paceResult.volume_pace_vs_20d, null);
  assert.equal(paceResult.volume_pace_confidence, 'LOW');
});

test('Cluster 2 - Focus 2: Volume pace clamps effective progress to MIN_EFFECTIVE_PROGRESS (0.15) at 09:01:00', () => {
  const progress = volumePace.sessionProgress('2026-09-10', '09:01');
  assert.equal(progress.active_trading_minutes, 1);
  assert.equal(progress.session_progress_fraction, 0); // 1 / 330 rounds to 0.00
  assert.equal(progress.effective_session_progress, 0.15); // clamped to 0.15

  const paceResult = volumePace.calculateVolumePace({
    sample_date: '2026-09-10',
    scheduled_time: '09:01',
    volume_today: 15000,
    avg_volume_20d_ex_today: 100000,
    previous_day_volume: 100000
  });

  // Projected = 15000 / 0.15 = 100,000
  assert.equal(paceResult.projected_full_day_volume, 100000);
  assert.equal(paceResult.volume_pace_vs_20d, 1);
});

// ============================================================
// 3. Break-Even +2% Exit Management & Scoring Rework (PR #613)
// ============================================================
test('Cluster 2 - Focus 3: BEP +2% lock activates when price gains >= 2.0% from entry and protects with BEP_CLOSED (0% loss)', () => {
  const evaluateMonitorStatus = sectorHot.__test ? sectorHot.__test.evaluateMonitorStatus : null;
  assert.equal(typeof evaluateMonitorStatus, 'function', 'evaluateMonitorStatus must be exported in sectorHot.__test');

  const pick = {
    ticker: 'BBCA',
    status: 'RUNNING',
    monitor_source: 'daytrade',
    entry1: 10000,
    entry2: 10000,
    sl: 9700,
    tp1: 10400,
    tp2: 10800,
    board: 'UTAMA'
  };

  // Step 1: Active position reaches +2.5% intraday (high = 10250 >= entryMid 10000 * 1.020, low holds above BEP)
  const obsHigh = {
    last: 10150,
    high: 10250,
    low: 10050,
    at: new Date().toISOString()
  };

  const statusRunningWithBep = evaluateMonitorStatus(pick, obsHigh);
  assert.equal(statusRunningWithBep.bep_locked, true, 'bep_locked must become true after +2% gain');
  assert.equal(statusRunningWithBep.effective_sl, 10025, 'effective_sl must be raised to entryMid + 1 tick (10025)');

  // Step 2: Price retraces back to effective SL (low = 10025)
  const pickWithBep = Object.assign({}, pick, {
    bep_locked: true,
    effective_sl: 10025,
    high_since_entry: 10250
  });
  const obsRetrace = {
    last: 10025,
    high: 10250,
    low: 10025,
    at: new Date().toISOString()
  };

  const statusClosed = evaluateMonitorStatus(pickWithBep, obsRetrace);
  assert.equal(statusClosed.status, 'BEP_CLOSED');
  assert.equal(statusClosed.loss_pct, 0, 'BEP_CLOSED must have loss_pct: 0');
  assert.equal(statusClosed.pnl_pct, 0, 'BEP_CLOSED must have pnl_pct: 0');
});

test('Cluster 2 - Focus 3: TP1 Hit takes precedence and is NEVER overwritten by SL_HIT on subsequent retrace', () => {
  const evaluateMonitorStatus = sectorHot.__test.evaluateMonitorStatus;

  const pick = {
    ticker: 'BBRI',
    status: 'TP1_HIT',
    monitor_source: 'daytrade',
    hit_tp1_at: new Date().toISOString(),
    entry1: 5000,
    entry2: 5000,
    sl: 4850,
    tp1: 5200,
    tp2: 5400,
    board: 'UTAMA'
  };

  // Retrace down to or below SL after TP1 hit (low = 4850)
  const obsRetrace = {
    last: 4850,
    high: 5200,
    low: 4850,
    at: new Date().toISOString()
  };

  const res = evaluateMonitorStatus(pick, obsRetrace);
  assert.equal(res.status, 'TP1_HIT', 'Must remain TP1_HIT and never become SL_HIT');
  assert.match(res.note, /Posisi selesai setelah TP1 tercapai/);
});

test('Cluster 2 - Focus 3: Scoring Meritocracy - BASE_SCORE 25 and hard ceiling 64 when volume_ratio_20d < 1.0', () => {
  const calculateScore = dtEngine.calculateDayTradeScore;
  assert.equal(typeof calculateScore, 'function');

  // Candidate with perfect technicals and orderflow but volume_ratio_20d < 1.0 (0.8x)
  const lowVolCandidate = {
    volume_ratio_20d: 0.8,
    change_pct: 3.0,
    rsi14: 60,
    price_above_open: true,
    distance_to_breakout_pct: 1.5,
    range_position: 80,
    delta_turnover_15m: 2000000000, // 2B orderflow
    bid_dominance: 0.75
  };

  const scoreLowVol = calculateScore(lowVolCandidate);
  assert.equal(scoreLowVol, 64, 'Candidate with volume ratio < 1.0 cannot exceed 64 (hard capped at 64)');

  // Candidate with volume ratio 1.5x unlocks tradeable threshold (>= 65)
  const confirmedCandidate = Object.assign({}, lowVolCandidate, {
    volume_ratio_20d: 1.5
  });
  const scoreConfirmed = calculateScore(confirmedCandidate);
  assert.ok(scoreConfirmed >= 65, 'Candidate with confirmed volume exceeds tradeable score threshold 65');
});

test('Cluster 2 - Focus 3: selectTopCandidatesWithSectorDiversification enforces Top 10 and max 3 per sector', () => {
  const selectTop = sectorHot.selectTopCandidatesWithSectorDiversification;
  assert.equal(typeof selectTop, 'function');

  // Generate 15 candidates: 6 Financial, 5 Tech, 4 Energy
  const pool = [];
  for (let i = 1; i <= 6; i++) {
    pool.push({ ticker: `FIN${i}`, sector: 'Financials', daytrade_score: 90 - i });
  }
  for (let i = 1; i <= 5; i++) {
    pool.push({ ticker: `TECH${i}`, sector: 'Technology', daytrade_score: 85 - i });
  }
  for (let i = 1; i <= 4; i++) {
    pool.push({ ticker: `NRG${i}`, sector: 'Energy', daytrade_score: 80 - i });
  }

  const selected = selectTop(pool, 10, 3);
  assert.equal(selected.length, 9, 'Top candidates limited to max 3 per sector across 3 sectors = 9');

  const sectorCounts = {};
  for (const item of selected) {
    sectorCounts[item.sector] = (sectorCounts[item.sector] || 0) + 1;
    assert.ok(item.daytrade_score >= 65, 'Only scores >= 65 are selected');
  }

  assert.equal(sectorCounts['Financials'], 3, 'Financials must be capped at 3');
  assert.equal(sectorCounts['Technology'], 3, 'Technology must be capped at 3');
  assert.equal(sectorCounts['Energy'], 3, 'Energy must be capped at 3');
});

// ============================================================
// 4. Candle Pattern Hammer vs Hanging Man & Null Sentinels (PR #521, #522)
// ============================================================
test('Cluster 2 - Focus 4: Red candle with long lower shadow at support is classified as Hammer (Bullish)', () => {
  // Red candle: open 1010, close 1000, high 1012, low 950
  // range = 62, body = 10, lowerShadow = 50 (>= 2 * body), upperShadow = 2 (<= 0.15 of range)
  const redHammer = { open: 1010, high: 1012, low: 950, close: 1000, volume: 100000 };
  const priorCandle = { open: 1020, high: 1025, low: 1005, close: 1010, volume: 80000 };
  const candles = [priorCandle, redHammer];

  const ctxSupport = {
    support: 990,      // lastPrice (1000) <= support * 1.03 (1019.7)
    lastPrice: 1000,
    changePct: -0.5
  };

  const pattern = candleEngine.detectPattern(candles, ctxSupport);
  assert.equal(pattern.pattern, 'Hammer');
  assert.equal(pattern.bias, 'Bullish');
});

test('Cluster 2 - Focus 4: Red candle with long lower shadow extended far above support is classified as Hanging Man (Bearish)', () => {
  const redHangingMan = { open: 1210, high: 1212, low: 1150, close: 1200, volume: 100000 };
  const priorCandle = { open: 1150, high: 1190, low: 1140, close: 1180, volume: 80000 };
  const candles = [priorCandle, redHangingMan];

  const ctxUptrend = {
    support: 1000,      // lastPrice (1200) > support * 1.03 (1030), extended above support
    lastPrice: 1200,
    changePct: 5.0
  };

  const pattern = candleEngine.detectPattern(candles, ctxUptrend);
  assert.equal(pattern.pattern, 'Hanging Man');
  assert.equal(pattern.bias, 'Bearish');
});

test('Cluster 2 - Focus 4: Unknown 20D volume ratio returns null sentinel (not 0) and does not divide by zero', () => {
  const candles = [];
  for (let i = 0; i < 12; i++) {
    candles.push({
      date: `2026-08-${String(i + 1).padStart(2, '0')}`,
      open: 1000,
      high: 1020,
      low: 990,
      close: 1010,
      volume: 100000
    });
  }

  const analysis = dtEngine.analyzeDayTrade(candles, 'TEST');
  assert.equal(analysis.avg_volume_20d, null);
  assert.equal(analysis.volume_ratio_20d, null);
});

// ============================================================
// 5. Friday Market Break (11:30 - 14:00 WIB) & Lifecycle Leak Check (PR #611)
// ============================================================
test('Cluster 2 - Focus 5: Friday break window (11:30 - 14:00 WIB) strictly returns null runMode', () => {
  const runMode = watcherLive.runModeForTime;
  assert.equal(typeof runMode, 'function');

  const friday = '2026-09-11'; // Friday

  // Active before Friday break
  assert.equal(runMode('11:25', friday), 'MIDDAY_CHECK');

  // Inside Friday break
  assert.equal(runMode('11:30', friday), null, '11:30 Friday must be rejected (session 1 closed)');
  assert.equal(runMode('12:00', friday), null, '12:00 Friday must be rejected');
  assert.equal(runMode('13:45', friday), null, '13:45 Friday must be rejected');
  assert.equal(runMode('13:59', friday), null, '13:59 Friday must be rejected');

  // Resumes at 14:00 WIB
  assert.equal(runMode('14:05', friday), 'AFTERNOON_EXIT', '14:05 Friday must resume in AFTERNOON_EXIT');
});

test('Cluster 2 - Focus 5: Thursday market schedule allows trading between 11:30 and 12:00 WIB', () => {
  const runMode = watcherLive.runModeForTime;
  const thursday = '2026-09-10'; // Thursday

  // Active on Thursday at 11:45 (Mon-Thu session 1 closes at 12:00)
  assert.equal(runMode('11:45', thursday), 'MIDDAY_CHECK');

  // Mon-Thu break is 12:00 - 13:30
  assert.equal(runMode('12:15', thursday), null);
  assert.equal(runMode('13:40', thursday), 'AFTERNOON_EXIT');
});
