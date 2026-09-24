'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fusion = require('../lib/top5-fusion-engine');
const sectorHot = require('../api/sector-hot');
const idxTick = require('../lib/idx-tick-normalization');

const T = sectorHot.__test;

function buildCandles() {
  const bars = 90;
  const base = 1000;
  const candles = [];
  for (let i = 0; i < bars; i++) {
    const close = i >= bars - 20
      ? base + Math.sin(i) * (base * 0.004)
      : base + Math.sin(i / 7) * (base * 0.05);
    const open = i === 0 ? close : candles[i - 1].close;
    candles.push({
      time: 1700000000 + i * 86400,
      date: new Date((1700000000 + i * 86400) * 1000).toISOString().slice(0, 10),
      open: open,
      high: Math.max(open, close) + base * 0.006,
      low: Math.min(open, close) - base * 0.006,
      close: close,
      volume: i === bars - 1 ? 2600000 : 900000
    });
  }
  return candles;
}

const candles = buildCandles();
const last = candles[candles.length - 1];
const TODAY = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const strongBroker = fusion.summarizeBrokerFrames([4200000000, 3100000000, 1800000000, 900000000, 700000000, 500000000, 300000000]);
const strongForeign = { net_1d: 1200000000, net_3d: 3400000000, net_7d: 5100000000, positive_days_7d: 6, streak: 4, available: true };

function candidate(overrides) {
  return Object.assign({
    ticker: 'FUSION',
    category: 'Swing Konglo',
    entry1: last.close + 5,
    entry2: last.close - 5,
    sl: last.close * 0.97,
    tp1: last.close * 1.06,
    last_price: last.close,
    risk_reward: 1.4,
    breakout_confirmation_status: 'BREAKOUT_WATCH',
    entry_status: 'NEAR_ENTRY',
    entry_quality_status: 'NEAR_ENTRY',
    quality_grade: 'B',
    risk_label_v2: 'Medium Risk',
    liquidity_label: 'Liquid',
    trading_plan_valid: true,
    plan_quality_status: 'OK',
    volume_phase: 'ACCUMULATION',
    final_quality_pass: false,
    final_top_quality_gate: { pass: false, reason: 'Breakout Confirmation' },
    price_date: TODAY,
    last_trade_date: TODAY,
    trade_date: TODAY,
    value_today: 8e9,
    traded_value: 8e9,
    volume_ratio_20d: 2.6
  }, overrides || {});
}

function snap(value, mode) {
  return idxTick.normalizeIdxPriceLevel(value, mode, undefined, undefined, 'FUSION');
}

function publish(row, evaluation) {
  const pick = fusion.buildFusionPick(evaluation);
  T.attachEntryStatus(pick);
  const reconciliation = fusion.reconcileFusionPick(pick, evaluation);
  if (reconciliation.action === 'waive') fusion.applyFusionWaiver(pick);
  pick.telegram_verdict = 'Fusion Engine: skor gabungan ' + pick.fusion_score + '.';
  pick.status_reason = pick.telegram_verdict;
  pick.action = 'BUY';
  pick.action_label = 'Entry';
  pick.signal_action = 'BUY';
  pick.signal_action_label = 'Entry';
  return { pick: pick, reconciliation: reconciliation };
}

test('fusion formula is a 50/50 dual pillar with the T+1..T+5 contract', () => {
  assert.equal(fusion.FUSION_WEIGHTS.swing, 0.5);
  assert.equal(fusion.FUSION_WEIGHTS.momentum, 0.5);
  assert.equal(fusion.SL_MIN_PCT, 3);
  assert.equal(fusion.SL_MAX_PCT, 5);
  assert.equal(fusion.TP1_MIN_PCT, 8);
  assert.equal(fusion.TP1_MAX_PCT, 15);
  assert.ok(fusion.MIN_ASYMMETRIC_RR >= 1.6);
});

test('strong broker and foreign accumulation waives a consolidation timing reject', () => {
  const evaluation = fusion.evaluateFusionCandidate(candidate(), {
    candles: candles,
    broker: strongBroker,
    foreign: strongForeign,
    snapToTick: snap
  });
  assert.equal(evaluation.verdict, 'pass');
  assert.equal(evaluation.admissible, true);
  assert.ok(evaluation.waived_warnings.indexOf('breakout_watch') >= 0);
  assert.ok(evaluation.plan.sl_risk_pct >= 3 && evaluation.plan.sl_risk_pct <= 5);
  assert.ok(evaluation.plan.tp1_upside_pct >= 8 && evaluation.plan.tp1_upside_pct <= 15);
  assert.ok(evaluation.plan.risk_reward >= 1.6);
  assert.equal(evaluation.swing_pillar.weight, 0.5);
  assert.equal(evaluation.momentum_pillar.weight, 0.5);
});

test('the same timing reject stays rejected without solid accumulation', () => {
  const evaluation = fusion.evaluateFusionCandidate(candidate({ ticker: 'WEAK' }), {
    candles: candles,
    broker: fusion.summarizeBrokerFrames([-500000000, -300000000, -200000000]),
    foreign: { net_1d: -100000000, net_3d: -400000000, net_7d: -700000000, positive_days_7d: 1, streak: -3 },
    snapToTick: snap
  });
  assert.equal(evaluation.verdict, 'soft_reject');
  assert.equal(evaluation.admissible, false);
  assert.equal(evaluation.accumulation.strong, false);
});

test('price below stop loss is never waived by strong accumulation', () => {
  const evaluation = fusion.evaluateFusionCandidate(candidate({
    ticker: 'BROKEN',
    sl: last.close * 1.1,
    stop_loss: last.close * 1.1
  }), {
    candles: candles,
    broker: strongBroker,
    foreign: strongForeign,
    snapToTick: snap
  });
  assert.equal(evaluation.verdict, 'hard_reject');
  assert.equal(evaluation.hard_reject_reason, 'price_below_sl');
  assert.equal(evaluation.admissible, false);
});

test('published fusion pick survives the Top 5 delivery gates', () => {
  const evaluation = fusion.evaluateFusionCandidate(candidate(), {
    candles: candles,
    broker: strongBroker,
    foreign: strongForeign,
    snapToTick: snap
  });
  const published = publish(candidate(), evaluation);
  assert.notEqual(published.reconciliation.action, 'drop');
  const pick = published.pick;
  assert.equal(T.candidatePassesPublicTelegramSafetyGate(pick, 'daily_top5'), true);
  assert.equal(T.candidatePassesTelegramCandidateDigestGate(pick, 'daily_top5_send'), true);
  assert.equal(T.candidatePassesMinUpside(pick), true);
  assert.ok(pick.entry1 > pick.entry2);
  assert.ok(pick.sl < pick.entry2);
  assert.ok(pick.tp1n > pick.entry1);
  assert.ok(pick.tp2n >= pick.tp1n);
});

test('combined pool selection returns 3 to 5 structured picks and drops weak flow', () => {
  const pool = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'].map(function (ticker, index) {
    return candidate({
      ticker: ticker,
      category: index % 3 === 0 ? 'Day Trade' : (index % 3 === 1 ? 'Swing Konglo' : 'Swing Non-Konglo'),
      breakout_confirmation_status: index === 1 ? 'NEEDS_CLOSE_CONFIRMATION' : 'BREAKOUT_WATCH'
    });
  });
  const result = fusion.selectFusionTop5(pool, {
    candlesFor: function () { return candles; },
    brokerFor: function (ticker) {
      return ticker === 'FFF'
        ? fusion.summarizeBrokerFrames([-900000000, -700000000, -500000000])
        : strongBroker;
    },
    foreignFor: function () { return strongForeign; },
    snapToTickFor: function () { return snap; }
  }, { limit: 5, min_count: 3 });

  assert.ok(result.picks.length >= 3 && result.picks.length <= 5);
  assert.equal(result.diagnostics.min_count_met, true);
  assert.ok(result.picks.every(function (pick) { return pick.ticker !== 'FFF'; }));
  result.picks.forEach(function (pick) {
    assert.ok(pick.entry1 > 0 && pick.entry2 > 0 && pick.sl > 0 && pick.tp1n > 0 && pick.tp2n > 0);
    assert.ok(pick.sl < pick.entry2);
    assert.ok(pick.tp1n > pick.entry1);
    assert.ok(pick.risk_reward >= 1.6);
    assert.equal(pick.fusion_top5_source, 'fusion_engine');
    assert.ok(Array.isArray(pick.fusion_reasons) && pick.fusion_reasons.length > 0);
  });
});
