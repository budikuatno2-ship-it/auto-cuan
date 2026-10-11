'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const screenerConfig = require('../lib/screener-config');
const { passesRiskRewardFilter, recalculateRiskReward, MIN_RR_RATIO } = screenerConfig;
const idxTickNormalization = require('../lib/idx-tick-normalization');
const sectorHot = require('../api/sector-hot');
const momentum = require('../lib/intraday-fast-watcher-momentum');
const pool = require('../lib/intraday-fast-watcher-pool');
const publisher = require('../lib/intraday-fast-watcher-publisher');
const tpv2 = require('../lib/trade-plan-v2');
const tpv2Integration = require('../lib/trade-plan-v2-integration');

test('BATCH 1 - A1: passesRiskRewardFilter recalculates R/R from final levels after resistance cap/tick', () => {
  // Case 1: candidate carries a stale/inflated risk_reward of 1.8, but actual levels give 1.2
  // Entry: 1000, SL: 900, TP1: 1120 => Reward: 120, Risk: 100 => Actual R/R: 1.2
  const candidateStale = {
    risk_reward: 1.8,
    entry_high: 1000,
    stop_loss: 900,
    tp1: 1120,
    recalculate_rr: true
  };
  assert.equal(
    passesRiskRewardFilter(candidateStale, MIN_RR_RATIO),
    false,
    'Stale/inflated R/R must be superseded by actual level calculation and rejected when actual < 1.5'
  );

  // Case 2: candidate with valid levels giving actual R/R = 1.6
  // Entry: 1000, SL: 900, TP1: 1160 => Reward: 160, Risk: 100 => Actual R/R: 1.6
  const candidateValid = {
    risk_reward: 1.6,
    entry_high: 1000,
    stop_loss: 900,
    tp1: 1160
  };
  assert.equal(
    passesRiskRewardFilter(candidateValid, MIN_RR_RATIO),
    true,
    'Candidate with actual R/R >= 1.5 must pass'
  );

  // Case 3: nested levels object where rawVal is missing => automatically derives from levels
  const candidateNested = {
    levels: {
      entry_high: 1000,
      stop_loss: 900,
      tp1: 1130 // Actual R/R is 1.3
    }
  };
  assert.equal(
    passesRiskRewardFilter(candidateNested, MIN_RR_RATIO),
    false,
    'Nested levels with actual R/R < 1.5 must be rejected'
  );

  // Direct recalculateRiskReward verification
  assert.equal(recalculateRiskReward({ entry_high: 1000, stop_loss: 900, tp1: 1150 }), 1.5);
  assert.equal(recalculateRiskReward({ entry_high: 1000, stop_loss: 900, tp1: 1120 }), 1.2);
  assert.equal(recalculateRiskReward({ entry_high: 1000, stop_loss: 1050, tp1: 1200 }), null);
});

test('BATCH 1 - A2: passesRiskRewardFilter fails closed on invalid, zero, or non-finite levels', () => {
  // SL >= Entry
  assert.equal(
    passesRiskRewardFilter({ entry_high: 1000, stop_loss: 1050, tp1: 1200 }),
    false,
    'SL >= entry must fail-closed'
  );

  // TP1 <= Entry
  assert.equal(
    passesRiskRewardFilter({ entry_high: 1000, stop_loss: 900, tp1: 950 }),
    false,
    'TP1 <= entry must fail-closed'
  );

  // Zero risk (SL === Entry)
  assert.equal(
    passesRiskRewardFilter({ entry_high: 1000, stop_loss: 1000, tp1: 1200 }),
    false,
    'Zero risk must fail-closed'
  );

  // Null / missing / non-finite
  assert.equal(passesRiskRewardFilter(null), false);
  assert.equal(passesRiskRewardFilter({}), false);
  assert.equal(passesRiskRewardFilter({ risk_reward: NaN }), false);
  assert.equal(passesRiskRewardFilter({ risk_reward: Infinity }), false);
  assert.equal(passesRiskRewardFilter({ risk_reward: -1.5 }), false);
});

test('BATCH 1 - A3: sector-hot getMinRRForCategory enforces 1.5 across ALL categories', () => {
  const getMinRR = (sectorHot.__test && sectorHot.__test.getMinRRForCategory) || sectorHot.getMinRRForCategory;
  assert.ok(typeof getMinRR === 'function', 'getMinRRForCategory must be exposed for testing');
  assert.equal(getMinRR('daytrade'), 1.5, 'Daytrade must enforce 1.5, not 1.3');
  assert.equal(getMinRR('day trade'), 1.5, 'Day Trade string must enforce 1.5');
  assert.equal(getMinRR('DAY_TRADE'), 1.5, 'DAY_TRADE must enforce 1.5');
  assert.equal(getMinRR('swing_konglo'), 1.5, 'Swing Konglo must enforce 1.5');
  assert.equal(getMinRR('swing_non_konglo'), 1.5, 'Swing Non-Konglo must enforce 1.5');
  assert.equal(getMinRR('daily_top5'), 1.5, 'Top 5 must enforce 1.5');
});

test('BATCH 1 - A4: idx-tick-normalization derivePlanQuality flags R/R < 1.5 as POOR_RR for Day Trade', () => {
  const planDay13 = {
    ticker: 'TEST',
    mode: 'daytrade',
    current_price: 1000,
    entry_low: 980,
    entry_high: 1000,
    stop_loss: 950,
    tp1: 1065, // Risk = 50, Reward = 65 => R/R = 1.3
    risk_reward: 1.3
  };
  const quality = idxTickNormalization.derivePlanQuality(planDay13);
  assert.equal(quality.plan_quality_status, 'POOR_RR', 'Daytrade R/R 1.3 must be classified as POOR_RR');
});

test('BATCH 1 - A5: candidatePassesPublicTelegramSafetyGate strictly rejects R/R < 1.5', () => {
  const safetyGate = sectorHot.__test.candidatePassesPublicTelegramSafetyGate;
  assert.ok(typeof safetyGate === 'function', 'candidatePassesPublicTelegramSafetyGate must be exposed');
  const candidate13 = {
    ticker: 'BBCA',
    category: 'daytrade',
    last_price: 1000,
    entry_high: 1000,
    entry_low: 980,
    stop_loss: 950,
    tp1: 1065, // R/R 1.3
    risk_reward: 1.3,
    status: 'READY_BREAKOUT',
    execution_reality_status: 'NORMAL',
    breakout_confirmation_status: 'CONFIRMED'
  };
  const passed = safetyGate(candidate13, 'daytrade');
  assert.equal(passed, false, 'Candidate with R/R 1.3 must fail public Telegram safety gate');
});

test('BATCH 1 - A6: FastWatcher momentum & pool enforce minimum R/R >= 1.5 for READY_CONFIRMED', () => {
  // Test observation with R/R = 1.2
  const obs12 = {
    ticker: 'BUMI',
    current_price: 100,
    entry_low: 98,
    entry_high: 100,
    stop_loss: 90,
    tp1: 112, // Risk: 10, Reward: 12 => R/R = 1.2
    risk_reward: 1.2,
    relative_volume: 2.0,
    change_pct: 3.0,
    open: 97,
    high: 101,
    low: 96,
    volume: 5000000,
    average_volume: 2000000
  };

  const metrics = momentum.metricsFrom(obs12);
  assert.ok(metrics.minimum_risk_reward >= 1.5, 'minimum_risk_reward must be >= 1.5 by default');

  const evaluated = momentum.evaluate(obs12);
  assert.equal(evaluated.entry_eligible, false, 'R/R 1.2 setup must not be entry_eligible');
  assert.ok(
    evaluated.reasons.includes('risk_reward_below_minimum'),
    'Reasons must include risk_reward_below_minimum'
  );
});

test('BATCH 1 - A7: FastWatcher publisher publishConfirmed blocks candidate with R/R < 1.5', async () => {
  let telegramSent = false;
  const mockNotifyFn = async () => {
    telegramSent = true;
    return { sent: true };
  };

  const item12 = {
    ticker: 'TEST',
    setup_id: 'test-setup-12',
    watch_score: 85,
    publish_score: 85,
    observation: {
      ticker: 'TEST',
      current_price: 1000,
      entry_high: 1000,
      entry_low: 980,
      stop_loss: 900,
      tp1: 1120, // R/R 1.2
      risk_reward: 1.2,
      relative_volume: 2.5
    }
  };

  const res = await publisher.publishConfirmed({
    publishable: [item12],
    sampleDate: '2026-10-12',
    scheduledTime: '10:00',
    env: { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_PUBLISH_ENABLED: '1', FAST_WATCHER_TELEGRAM_ENABLED: '1' },
    notifyFn: mockNotifyFn,
    publishedDir: 'd:/auto-cuan-2/data/test-published-tmp'
  });

  assert.equal(telegramSent, false, 'Candidate with R/R 1.2 must never be broadcast via Telegram in publishConfirmed');
});

test('BATCH 1 - A8: Trade Plan V2 isPlanV2Usable rejects plans with rr_to_tp1 < 1.5 for public/executable use', () => {
  const planLowRR = {
    entry_zone_low: 1000,
    entry_zone_high: 1020,
    stop_loss: 950,
    stop_anchor_price: 960,
    tp1: 1100, // (1100 - 1020) / (1020 - 950) = 80 / 70 = 1.14
    rr_to_tp1: 1.14,
    status: 'OK',
    warnings: [],
    profile: { min_rr_to_tp1: 1.2 }
  };

  assert.equal(
    tpv2Integration.isPlanV2Usable(planLowRR),
    false,
    'Plan with rr_to_tp1 1.14 must not be usable when below profile minimum'
  );
});
