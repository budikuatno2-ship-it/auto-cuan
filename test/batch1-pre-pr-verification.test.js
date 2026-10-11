'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const screenerConfig = require('../lib/screener-config');
const { passesRiskRewardFilter, recalculateRiskReward, MIN_RR_RATIO } = screenerConfig;
const marketHoursGuard = require('../lib/market-hours-guard');
const volumePace = require('../lib/intraday-volume-pace');
const fastWatcherLive = require('../lib/intraday-fast-watcher-live');
const fastWatcherPublisher = require('../lib/intraday-fast-watcher-publisher');
const sectorHot = require('../api/sector-hot');
const tpv2Integration = require('../lib/trade-plan-v2-integration');

// Helper candidate generator matching integration test
function makeV2Candidate(extra) {
  return Object.assign({
    ticker: 'BBCA',
    entry_low: 9400,
    entry_high: 9450,
    support: 9300,
    swing_low: 9250,
    resistance: 9900,
    next_resistance: 10200,
    atr14: 120,
    last_price: 9440,
    current_price: 9440,
    tp1: 9850,
    tp2: 10200,
    stop_loss: 9200,
    risk_reward: 2.1
  }, extra || {});
}

// =============================================================================
// VERIFIKASI CELAH A: TRADE PLAN V2 & REALISTIC PLANS
// =============================================================================

test('VERIFIKASI A: Real Trade Plan V2 with sub-1.5 R/R is blocked from ready/executable signal publication', () => {
  // Build a real Trade Plan V2 via canonical integration adapter
  const planV2 = tpv2Integration.buildCandidatePlanV2(makeV2Candidate(), { screener_type: 'DAY_TRADE' });
  assert.ok(planV2.rr_to_tp1 != null, 'Plan must compute rr_to_tp1');
  assert.ok(planV2.rr_to_tp1 < 1.5, 'Default DAY_TRADE profile generates informational plan with R/R < 1.5');

  // Candidate carrying this real plan
  const candidateWithV2 = {
    ticker: 'BBCA',
    category: 'daytrade',
    last_price: 9440,
    trade_plan_v2: planV2,
    entry_high: planV2.entry_zone_high,
    entry_low: planV2.entry_zone_low,
    stop_loss: planV2.stop_loss,
    tp1: planV2.tp1,
    risk_reward: planV2.rr_to_tp1,
    status: 'READY_BREAKOUT',
    execution_reality_status: 'NORMAL',
    breakout_confirmation_status: 'CONFIRMED'
  };

  // Must be blocked from public execution because R/R < 1.5
  assert.equal(
    passesRiskRewardFilter(candidateWithV2, MIN_RR_RATIO, { recalculate: true }),
    false,
    'Real V2 plan with R/R < 1.5 must fail passesRiskRewardFilter'
  );
  assert.equal(
    sectorHot.__test.candidatePassesPublicTelegramSafetyGate(candidateWithV2, 'daytrade'),
    false,
    'Real plan with R/R < 1.5 must NOT pass public Telegram safety gate'
  );

  // Now construct candidate with R/R >= 1.5:
  const candidateWithHighRR = Object.assign({}, candidateWithV2, {
    tp1: 9850,
    entry_high: 9450,
    stop_loss: 9150, // Risk: 300, Reward: 400 => R/R: 1.33 -> still < 1.5
    risk_reward: 1.33
  });
  assert.equal(passesRiskRewardFilter(candidateWithHighRR, MIN_RR_RATIO, { recalculate: true }), false);

  const candidateQualifies = Object.assign({}, candidateWithV2, {
    tp1: 9950,
    entry_high: 9450,
    stop_loss: 9100, // Risk: 350, Reward: 500 => R/R: 1.43 -> < 1.5
    risk_reward: 1.43
  });
  assert.equal(passesRiskRewardFilter(candidateQualifies, MIN_RR_RATIO, { recalculate: true }), false);

  const candidateValid16 = Object.assign({}, candidateWithV2, {
    tp1: 10000,
    entry_high: 9450,
    stop_loss: 9100, // Risk: 350, Reward: 550 => R/R: 1.57 >= 1.5
    risk_reward: 1.57
  });
  assert.equal(passesRiskRewardFilter(candidateValid16, MIN_RR_RATIO, { recalculate: true }), true);
});

test('VERIFIKASI A: Legacy fallback plan with R/R < 1.5 cannot pass safety gate', () => {
  const legacyCandidate = {
    ticker: 'ASII',
    category: 'daytrade',
    entry_low: 5000,
    entry_high: 5100,
    stop_loss: 4800, // Risk = 300
    tp1: 5450,       // Reward = 350 => R/R = 350/300 = 1.17
    risk_reward: 1.17,
    status: 'READY_BREAKOUT',
    source: 'legacy_fallback'
  };

  assert.equal(
    passesRiskRewardFilter(legacyCandidate, MIN_RR_RATIO, { recalculate: true }),
    false,
    'Legacy fallback with R/R 1.17 must be rejected'
  );
  assert.equal(
    sectorHot.__test.candidatePassesPublicTelegramSafetyGate(legacyCandidate, 'daytrade'),
    false,
    'Legacy fallback cannot bypass public Telegram safety gate'
  );
});

// =============================================================================
// VERIFIKASI CELAH B: INTRADAY VOLUME PACE DENOMINATOR & REGULAR SESSION STATUS
// =============================================================================

test('VERIFIKASI B: Intraday Volume Pace mathematical consistency (330 / 270 vs 320 / 260)', () => {
  // Denominator 330 (Mon-Thu) and 270 (Fri) represents the full exchange day (including 10m closing auction).
  // This is required because 20D average volume baseline contains full daily volume.
  const monSched = volumePace.tradingSchedule('2026-10-12');
  assert.equal(monSched.total, 330, 'Full trading schedule total must remain 330 for pace math consistency');
  assert.equal(monSched.windows[1].end, 960, 'S2 window must extend to 960 (16:00) for daily baseline projection');

  // Verify that isRegularTradingTime / is_regular_session correctly isolates the continuous trading window (< 15:50)
  assert.equal(volumePace.isRegularTradingTime(1, 945), true, '15:45 (945m) is within continuous regular session');
  assert.equal(volumePace.isRegularTradingTime(1, 949), true, '15:49 (949m) is within continuous regular session');
  assert.equal(volumePace.isRegularTradingTime(1, 950), false, '15:50 (950m) is pre-closing auction, NOT regular continuous trading');
  assert.equal(volumePace.isRegularTradingTime(1, 955), false, '15:55 (955m) is pre-closing auction, NOT regular continuous trading');
  assert.equal(volumePace.isRegularTradingTime(1, 960), false, '16:00 (960m) is after close');

  // Verify Friday regular session
  assert.equal(volumePace.isRegularTradingTime(5, 689), true, '11:29 Friday S1 is regular');
  assert.equal(volumePace.isRegularTradingTime(5, 690), false, '11:30 Friday is lunch/prayer break');
  assert.equal(volumePace.isRegularTradingTime(5, 839), false, '13:59 Friday is lunch/prayer break');
  assert.equal(volumePace.isRegularTradingTime(5, 840), true, '14:00 Friday S2 opens');
  assert.equal(volumePace.isRegularTradingTime(5, 950), false, '15:50 Friday regular session closed');
});

test('VERIFIKASI B: FastWatcher runModeForTime terminates at 15:49:59 (returns null for ticks >= 15:50)', () => {
  // Live date-aware calls:
  assert.equal(fastWatcherLive.runModeForTime('15:49', '2026-10-12'), 'AFTERNOON_EXIT');
  assert.equal(fastWatcherLive.runModeForTime('15:50', '2026-10-12'), null);
  assert.equal(fastWatcherLive.runModeForTime('15:55', '2026-10-12'), null);
  assert.equal(fastWatcherLive.runModeForTime('16:00', '2026-10-12'), null);

  // Backward compatibility single-arg call (without sampleDate) remains supported up to 16:00
  assert.equal(fastWatcherLive.runModeForTime('16:00'), 'AFTERNOON_EXIT');
  assert.equal(fastWatcherLive.runModeForTime('16:01'), null);
});

// =============================================================================
// VERIFIKASI CELAH C: SAFETY GATE PADA BERBAGAI BENTUK PAYLOAD PRODUKSI
// =============================================================================

test('VERIFIKASI C: Nested production payload (item.observation.metrics)', () => {
  // Real FastWatcher production candidate with nested metrics
  const prodItemValid = {
    ticker: 'BBRI',
    observation: {
      ticker: 'BBRI',
      metrics: {
        entry_high: 4000,
        stop_loss: 3800, // Risk = 200
        tp1: 4350,       // Reward = 350 => R/R = 1.75
        risk_reward: 1.75
      }
    }
  };
  assert.equal(passesRiskRewardFilter(prodItemValid, MIN_RR_RATIO, { recalculate: true }), true);

  const prodItemInvalid = {
    ticker: 'BBRI',
    observation: {
      ticker: 'BBRI',
      metrics: {
        entry_high: 4000,
        stop_loss: 3800, // Risk = 200
        tp1: 4240,       // Reward = 240 => R/R = 1.20
        risk_reward: 1.20
      }
    }
  };
  assert.equal(passesRiskRewardFilter(prodItemInvalid, MIN_RR_RATIO, { recalculate: true }), false);
});

test('VERIFIKASI C: Legacy aliases (entry1, entry2, sl, tp1n)', () => {
  // When entry1 and entry2 are both present, conservative upper boundary (max) is used
  const aliasValid = {
    ticker: 'BBCA',
    entry1: 9000,
    entry2: 9100, // Upper entry = 9100
    sl: 8800,     // Risk = 300
    tp1n: 9600,   // Reward = 500 => R/R = 500 / 300 = 1.67
    risk_reward: 1.67
  };
  assert.equal(passesRiskRewardFilter(aliasValid, MIN_RR_RATIO, { recalculate: true }), true);

  const aliasInvalid = {
    ticker: 'BBCA',
    entry1: 9000,
    entry2: 9100, // Upper entry = 9100
    sl: 8800,     // Risk = 300
    tp1n: 9450,   // Reward = 350 => R/R = 350 / 300 = 1.17
    risk_reward: 1.17
  };
  assert.equal(passesRiskRewardFilter(aliasInvalid, MIN_RR_RATIO, { recalculate: true }), false);
});

test('VERIFIKASI C: Resistance cap changes R/R from >= 1.5 to < 1.5 (must be rejected)', () => {
  // Initial levels before cap:
  // entry_high: 1000, stop_loss: 900 (Risk: 100), initial un-capped tp1: 1180 (R/R: 1.8)
  // But resistance is at 1120, capping final TP1 to 1120 => Reward: 120 => Final R/R: 1.2
  const candidatePostCap = {
    ticker: 'INCO',
    entry_high: 1000,
    stop_loss: 900,
    tp1: 1120, // Final capped TP1
    risk_reward: 1.8, // Stale pre-cap field
    resistance: 1120
  };

  // With recalculate option, the final levels determine eligibility:
  assert.equal(
    passesRiskRewardFilter(candidatePostCap, MIN_RR_RATIO, { recalculate: true }),
    false,
    'Candidate whose final capped TP1 reduces R/R below 1.5 must be rejected despite stale 1.8 in risk_reward'
  );

  // Recalculate helper returns the exact numerical value of final levels
  assert.equal(recalculateRiskReward(candidatePostCap), 1.2);
});

test('VERIFIKASI C: Non-finite, NaN, Infinity, and zero/inverted risk levels fail closed', () => {
  assert.equal(passesRiskRewardFilter({ entry_high: 1000, stop_loss: 1000, tp1: 1200 }), false); // zero risk
  assert.equal(passesRiskRewardFilter({ entry_high: 1000, stop_loss: 1100, tp1: 1200 }), false); // inverted SL
  assert.equal(passesRiskRewardFilter({ entry_high: 1000, stop_loss: 900, tp1: 950 }), false);   // inverted TP1
  assert.equal(passesRiskRewardFilter({ entry_high: 1000, stop_loss: 0, tp1: 1200 }), false);     // zero SL
  assert.equal(passesRiskRewardFilter({ entry_high: 1000, stop_loss: -100, tp1: 1200 }), false);  // negative SL
  assert.equal(passesRiskRewardFilter({ entry_high: NaN, stop_loss: 900, tp1: 1200 }), false);
  assert.equal(passesRiskRewardFilter({ entry_high: Infinity, stop_loss: 900, tp1: 1200 }), false);
  assert.equal(passesRiskRewardFilter({ entry_high: 1000, stop_loss: 900, tp1: Infinity }), false);
});
