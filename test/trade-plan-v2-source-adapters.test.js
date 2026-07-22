'use strict';

/**
 * Trade Plan V2 — Runtime Source Adapter tests (REAL-shaped fixtures)
 * ==================================================================
 *
 * The fixtures below are copied from the ACTUAL runtime object shapes emitted by
 * each screener (not simplified synthetic candidates):
 *   - Day Trade:       analyzeDayTrade() return  (lib/daytrade-screener-engine.js)
 *   - Swing Konglo:    calculateIndicators() return (api/sector-hot.js)
 *   - Swing Non-Konglo: calculateNkSetupScore() return (api/sector-hot.js)
 *
 * They verify the adapters hydrate the canonical Trade Plan V2 with the screener's
 * already-computed structure, that structure is NEVER reverse-derived from the
 * legacy SL/TP, that missing historical structure is reported honestly, and that
 * scoring / fallback / parity / API-count invariants hold.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adapters = require('../lib/trade-plan-v2-source-adapters');
const integration = require('../lib/trade-plan-v2-integration');
const fmt = require('../lib/trade-plan-v2-formatter');
const tpv2 = require('../lib/trade-plan-v2');
const replay = require('../lib/trade-plan-v2-replay-preview');
const collector = require('../tools/intraday-sample-collector');

const ROOT = path.join(__dirname, '..');

// Deterministic real-shaped candle series (oldest→newest).
function realCandles(base) {
  const out = [];
  for (let i = 0; i < 20; i++) {
    const o = base + i * 2;
    out.push({ open: o, high: o + 8, low: o - 6, close: o + 3, volume: 1000000 + i * 1000 });
  }
  return out;
}

// ---- REAL Day Trade analyzeDayTrade() output shape --------------------------
function realDayTradeAnalysis() {
  return {
    ticker: 'BBCA',
    last_price: 9440,
    price_source: 'yahoo_chart_1d_close',
    price_asof: '2026-07-22T08:00:00.000Z',
    price_date: '2026-07-22',
    open_price: 9400,
    high_price: 9480,
    low_price: 9380,
    change_pct: 0.53,
    previous_close: 9390,
    data_quality_status: 'ok',
    data_quality_label: null,
    data_quality_note: null,
    data_quality_valid: true,
    data_quality_needs_revalidation: false,
    volume_today: 52000000,
    value_today: 490000000000,
    avg_volume_20d: 41000000,
    avg_value_7d: 380000000000,
    volume_ratio_20d: 1.27,
    rsi14: 58.2,
    ma20: 9350,
    ma50: 9200,
    resistance: 9900,
    support: 9300,
    range_position: 60,
    distance_to_breakout_pct: 4.87,
    atr14: 120.5,
    swingLow5: 9250,
    swingHigh10: 10050,
    _priceAboveOpen: true,
    _priceNearHigh: false,
    _fadeFromHigh: 0.4,
    _aboveMA20: true,
    _aboveMA50: true,
    _overextendedMA20: false
  };
}

// The flattened `scored` row (post scoreDayTrade): keeps support/resistance +
// levels but DROPS atr14/swingLow5/swingHigh10 — this is exactly why passing only
// the flattened row lost structure.
function realDayTradeScored() {
  return {
    ticker: 'BBCA', status: 'READY_BREAKOUT', setup: 'Breakout', confidence: 'A',
    daytrade_score: 82, confirmed_rank: 1, shadow_score: 18,
    last_price: 9440, open_price: 9400, high_price: 9480, low_price: 9380, previous_close: 9390,
    entry_low: 9410, entry_high: 9450, stop_loss: 9205, tp1: 9850, tp2: 10100, risk_reward: 1.9,
    support: 9300, resistance: 9900, volume_ratio_20d: 1.27, rsi14: 58.2, ma20: 9350, ma50: 9200
  };
}

// ---- REAL Swing Konglo calculateIndicators() output shape -------------------
function realKongloAnalysis() {
  return {
    last_price: 2500, price_source: 'yahoo_chart_1d_close', price_asof: '2026-07-22T08:00:00.000Z',
    price_date: '2026-07-22', open_price: 2480, high_price: 2520, low_price: 2460,
    close_price: 2500, previous_close: 2470, prev_close: 2470, change_pct: 1.21,
    ma20: 2450, ma50: 2380, rsi14: 61.4, volume_ratio_avg20: 1.35,
    support: 2400, resistance: 2900, entry_low: 2480, entry_high: 2510,
    stop_loss: 2340, tp1: 2870, tp2: 2990, risk_reward: 2.1, invalidation: 'Close < 2340',
    _isLargeRed: false, _overextended: false, _belowMA50: false, _belowSupport: false, _slDistance: 3.2,
    _isAccumulation: true, _isDistribution: false, _distributionStrength: 0, _isDoji: false,
    _isStrongRejection: false, _volRatio: 1.35, _closePosition: 0.72, _upperShadow: 8, _body: 20,
    _atr14: 45.0, _atrSlUsed: true, _tpNote: null,
    _overheadGap: { lower: 2950, upper: 2990, size: 40 },
    _downsideGap: { lower: 2360, upper: 2390, size: 30 },
    _adx14: 24.1, _distAboveMA20Pct: 2.0,
    _candlePattern: { pattern: 'Bullish Engulfing', bias: 'bullish', risk: 'normal', note: 'Bullish engulfing near support' }
  };
}

// ---- REAL Swing Non-Konglo calculateNkSetupScore() output shape -------------
function realNonKongloScored() {
  return {
    score: 74, grade: 'B+', status: 'SWING_READY', status_reason: 'Valid swing setup',
    setup_type: 'pullback', last_price: 1610, price_source: 'yahoo_chart_1d_close',
    price_asof: '2026-07-22T08:00:00.000Z', price_date: '2026-07-22',
    open_price: 1600, high_price: 1625, low_price: 1595, close_price: 1610,
    previous_close: 1595, prev_close: 1595, change_pct: 0.94,
    avg_volume_20d: 22000000, avg_transaction_value_20d: 35000000000,
    tx_value_1d: 40000000000, avg_tx_value_3d: 38000000000, avg_tx_value_7d: 36000000000,
    traded_days_20d: 20, risk_reward: 1.8, volume_ratio_avg20: 1.18,
    ma20: 1560, ma50: 1500, rsi14: 55.6,
    entry_low: 1600, entry_high: 1620, stop_loss: 1540, tp1: 1780, tp2: 1900,
    support: 1550, resistance: 1800,
    atr14: 34.5, sl_atr_multiple: 0.8, tp1_atr_multiple: 5.2, atr_warning_notes: []
  };
}

// ===================================================================
// 1-3. Each real screener analysis produces a non-null structural level
// ===================================================================

test('1. real Day Trade runtime analysis produces a non-null structural level', () => {
  const built = integration.buildPlanFromSource('DAY_TRADE', {
    analysis: realDayTradeAnalysis(), scored: realDayTradeScored(), candles: realCandles(9200)
  }, {});
  assert.notEqual(built.plan.status, tpv2.STATUS.REJECTED, 'reject: ' + built.plan.reject_reason);
  assert.equal(built.plan.support, 9300, 'support hydrated from analysis');
  assert.equal(built.plan.structural_invalidation, 9250, 'structural invalidation uses the confirmed swing low (swingLow5)');
  assert.ok(built.plan.stop_loss !== null && built.plan.stop_loss < 9250, 'SL below the confirmed swing low');
  assert.ok(built.plan.resistance === 9900 && built.plan.tp1 !== null && built.plan.tp1 < 9900, 'TP1 before resistance');
  assert.equal(built.structural.available, true);
  assert.ok(built.structural.source_fields.indexOf('swingLow5') >= 0, 'swingLow5 recognised as swing low');
  assert.ok(built.structural.source_fields.indexOf('atr14') >= 0, 'atr14 recognised');
});

test('2. real Swing Konglo analysis produces a non-null structural level (and gaps)', () => {
  const built = integration.buildPlanFromSource('SWING_KONGLO', {
    analysis: realKongloAnalysis(), row: realKongloAnalysis(), candles: realCandles(2350)
  }, {});
  assert.notEqual(built.plan.status, tpv2.STATUS.REJECTED, 'reject: ' + built.plan.reject_reason);
  assert.equal(built.plan.support, 2400, 'support hydrated from analysis');
  assert.ok(built.plan.stop_loss !== null && built.plan.stop_loss < 2400, 'SL below support');
  // _downsideGap (below price) becomes the active DEMAND gap, and the SL is
  // anchored below that active demand-gap invalidation.
  assert.ok(built.structural.source_fields.indexOf('_downsideGap') >= 0, '_downsideGap recognised as demand gap');
  assert.ok(built.plan.nearest_demand_gap && built.plan.nearest_demand_gap.active, 'demand gap active');
  assert.ok(built.plan.stop_loss < built.plan.nearest_demand_gap.gap_low, 'SL below the active demand-gap invalidation');
  assert.ok(built.structural.source_fields.indexOf('_atr14') === -1, 'atr sourced via alias, not literal _atr14 label');
  assert.ok(built.structural.source_fields.indexOf('atr14') >= 0, 'ATR recognised (from _atr14 alias)');
  assert.equal(built.structural.available, true);
});

test('3. real Swing Non-Konglo analysis produces a non-null structural level', () => {
  const built = integration.buildPlanFromSource('SWING_NON_KONGLO', {
    scored: realNonKongloScored(), candles: realCandles(1520)
  }, {});
  assert.notEqual(built.plan.status, tpv2.STATUS.REJECTED, 'reject: ' + built.plan.reject_reason);
  assert.equal(built.plan.support, 1550, 'support hydrated from NK scored');
  assert.equal(built.plan.resistance, 1800, 'resistance hydrated from NK scored');
  assert.ok(built.plan.stop_loss !== null && built.plan.stop_loss < 1550, 'SL below support');
  assert.ok(built.plan.tp1 !== null && built.plan.tp1 < 1800, 'TP1 before resistance');
  assert.ok(built.structural.source_fields.indexOf('atr14') >= 0, 'NK atr14 recognised (captured before it is stripped)');
});

// ===================================================================
// 4. Aliases and nested runtime fields are recognised
// ===================================================================

test('4. support/resistance aliases and nested gap fields are recognised', () => {
  // Alias probe: support1/r1/latest_swing_low + nested demand_gap object.
  const src = { row: {
    ticker: 'ALIAS', support1: 3000, r1: 3400, latest_swing_low: 2950, _atr14: 40,
    entry_low: 3010, entry_high: 3040, last_price: 3020,
    demand_gap: { gap_low: 2900, gap_high: 2930, gap_direction: 'DEMAND' }
  } };
  const adapted = adapters.adaptSwingKonglo(src);
  assert.equal(adapted.input.support, 3000, 'support1 alias recognised');
  assert.equal(adapted.input.resistance, 3400, 'r1 alias recognised');
  assert.equal(adapted.input.swing_low, 2950, 'latest_swing_low alias recognised');
  assert.equal(adapted.input.atr14, 40, '_atr14 alias recognised');
  assert.equal(adapted.input.gaps.length, 1, 'nested demand_gap recognised');
  assert.equal(adapted.input.gaps[0].gap_direction, 'DEMAND');
});

// ===================================================================
// 5-6. Structure is NEVER reverse-derived from legacy SL / TP
// ===================================================================

test('5. no support is derived from the legacy stop loss', () => {
  // Row with a legacy SL but NO support/swing-low anywhere.
  const row = { ticker: 'NOSUP', last_price: 1000, entry_low: 990, entry_high: 1000, stop_loss: 940, tp1: 1080, resistance: 1100 };
  const adapted = adapters.adaptDayTrade({ scored: row });
  assert.equal(adapted.input.support, null, 'support must stay null (not taken from SL 940)');
  assert.equal(adapted.input.swing_low, null, 'swing low must stay null');
  const plan = integration.buildPlanFromSource('DAY_TRADE', { scored: row }, {}).plan;
  assert.equal(plan.status, tpv2.STATUS.REJECTED);
  assert.equal(plan.reject_reason, 'NO_STRUCTURAL_LEVEL');
  assert.equal(plan.support, null, 'V2 support must be null, never the legacy SL');
  assert.notEqual(plan.support, 940);
});

test('6. no resistance is derived from the legacy take-profit', () => {
  // Row with a legacy TP but NO resistance.
  const row = { ticker: 'NORES', last_price: 1000, entry_low: 990, entry_high: 1000, support: 960, swingLow5: 955, stop_loss: 945, tp1: 1120 };
  const adapted = adapters.adaptDayTrade({ scored: row });
  assert.equal(adapted.input.resistance, null, 'resistance must stay null (not taken from TP 1120)');
  const plan = integration.buildPlanFromSource('DAY_TRADE', { scored: row }, {}).plan;
  assert.equal(plan.resistance, null, 'V2 resistance must be null, never the legacy TP');
  assert.equal(plan.tp1, null, 'TP1 must not be invented when resistance is unavailable');
  assert.ok((plan.warnings || []).indexOf('NO_RESISTANCE_TP1_UNAVAILABLE') >= 0);
});

// ===================================================================
// 7. Missing historical structure is reported honestly
// ===================================================================

test('7. replay reports HISTORICAL_STRUCTURE_NOT_CAPTURED for structure-less stored rows', () => {
  // Exactly the stored intraday-sample shape (buildCandidateRecord): OHLC + entry/
  // tp/sl only, NO support/resistance/swing/atr.
  const storedIntradayRows = [
    { ticker: 'AAA', current_price: 1000, open: 990, high: 1010, low: 985, previous_close: 995, entry_low: 990, entry_high: 1000, tp1: 1050, tp2: 1100, sl: 960 },
    { ticker: 'BBB', current_price: 500, open: 495, high: 505, low: 492, previous_close: 498, entry_low: 495, entry_high: 500, tp1: 530, tp2: 560, sl: 480 }
  ];
  const report = replay.replayCandidates({ candidates: storedIntradayRows, screener_type: 'DAY_TRADE' });
  assert.equal(report.historical_structure_status, 'HISTORICAL_STRUCTURE_NOT_CAPTURED');
  assert.equal(report.summary.structural_context_available, 0);
  assert.equal(report.summary.structural_context_missing, 2);
  assert.equal(report.summary.legacy_fallback_missing_structure, 2);
  assert.equal(report.summary.v2_rejected_by_risk, 0, 'not a risk rejection — genuinely no structure');
  // Honesty: no support/resistance fabricated from the legacy SL/TP.
  for (const c of report.comparisons) {
    assert.equal(c.trade_plan_v2.support, null);
    assert.equal(c.trade_plan_v2.resistance, null);
  }
});

test('8. replay reports STRUCTURE_PRESENT and a usable plan for real-structured rows', () => {
  const report = replay.replayCandidates({
    candidates: [Object.assign(realDayTradeScored(), { swingLow5: 9250, swingHigh10: 10050, atr14: 120.5 })],
    screener_type: 'DAY_TRADE'
  });
  assert.equal(report.historical_structure_status, 'STRUCTURE_PRESENT');
  assert.equal(report.summary.structural_context_available, 1);
  assert.equal(report.summary.v2_usable, 1);
  assert.equal(report.summary.web_telegram_parity_ok, true);
});

// ===================================================================
// 9. Public legacy fallback remains safe (never null public SL/TP)
// ===================================================================

test('9. public fallback never emits null SL/TP when V2 has no structure', () => {
  const env = { TRADE_PLAN_V2_PUBLIC_ENABLED: 'true' };
  const row = { ticker: 'FB', entry_low: 990, entry_high: 1000, stop_loss: 945, tp1: 1080, tp2: 1150, risk_reward: 1.8 };
  const resolved = integration.resolvePublicTradePlan(row, { channel: 'web', mode: 'daytrade', env });
  assert.equal(resolved.source, 'legacy_fallback');
  assert.equal(resolved.payload.stop_loss, 945, 'legacy SL preserved');
  assert.equal(resolved.payload.tp1, 1080, 'legacy TP preserved');
  assert.notEqual(resolved.payload.stop_loss, null);
  assert.notEqual(resolved.payload.tp1, null);
});

test('10. public flag false keeps the legacy plan (flag remains false by default)', () => {
  const resolved = integration.resolvePublicTradePlan(realDayTradeScored(), { channel: 'telegram', mode: 'daytrade', env: {} });
  assert.equal(resolved.source, 'legacy');
  assert.equal(resolved.public_v2_enabled, false);
});

// ===================================================================
// 11. Base scores / rankings remain byte-identical
// ===================================================================

test('11. shadow attach with a real source never mutates scoring/ranking fields', () => {
  const scored = realDayTradeScored();
  const analysis = realDayTradeAnalysis();
  const scoringBefore = {
    daytrade_score: scored.daytrade_score, status: scored.status, confidence: scored.confidence,
    confirmed_rank: scored.confirmed_rank, shadow_score: scored.shadow_score,
    entry_low: scored.entry_low, entry_high: scored.entry_high, stop_loss: scored.stop_loss,
    tp1: scored.tp1, tp2: scored.tp2, risk_reward: scored.risk_reward
  };
  integration.attachShadowTradePlanV2(scored, {
    screener_type: 'DAY_TRADE',
    env: { TRADE_PLAN_V2_SHADOW_ENABLED: 'true' },
    source: { analysis, scored, candles: realCandles(9200) }
  });
  for (const k of Object.keys(scoringBefore)) {
    assert.equal(scored[k], scoringBefore[k], 'scoring/level field ' + k + ' must be untouched');
  }
  assert.equal(scored.trade_plan_v2.plan_version, 'trade-plan-v2');
  assert.equal(scored.trade_plan_v2.support, 9300, 'shadow plan hydrated from real analysis structure');
  assert.equal(scored.trade_plan_v2_structural.available, true);
});

test('12. shadow attach with a source is a no-op when the shadow flag is off', () => {
  const scored = realDayTradeScored();
  const before = JSON.parse(JSON.stringify(scored));
  integration.attachShadowTradePlanV2(scored, {
    screener_type: 'DAY_TRADE', env: {},
    source: { analysis: realDayTradeAnalysis(), scored, candles: realCandles(9200) }
  });
  assert.deepEqual(scored, before, 'no fields added while the shadow flag is off');
});

// ===================================================================
// 13. Web / Telegram parity remains exact for hydrated plans
// ===================================================================

test('13. web and Telegram canonical numbers are identical for a hydrated plan', () => {
  const built = integration.buildPlanFromSource('DAY_TRADE', {
    analysis: realDayTradeAnalysis(), scored: realDayTradeScored(), candles: realCandles(9200)
  }, {});
  const web = fmt.buildWebViewModel(built.plan);
  const tg = fmt.buildTelegramViewModel(built.plan);
  const diff = fmt.diffViewModels(web, tg);
  assert.equal(diff.equal, true, 'mismatches: ' + JSON.stringify(diff.mismatches));
  for (const f of ['support', 'resistance', 'stop_loss', 'tp1', 'rr_to_tp1', 'trailing_activation', 'structural_invalidation']) {
    assert.equal(web.canonical[f], tg.canonical[f], f + ' must match across channels');
  }
});

// ===================================================================
// 14. Future sample capture (additive, honest)
// ===================================================================

test('14. sample capture preserves real structure and derives candle body/wick from OHLC only', () => {
  const sc = collector.buildStructuralContext({
    open_price: 9400, high_price: 9480, low_price: 9380, last_price: 9440,
    support: 9300, resistance: 9900, swing_low: 9250, swing_high: 10050, atr14: 120.5
  });
  assert.equal(sc.support, 9300);
  assert.equal(sc.resistance, 9900);
  assert.equal(sc.confirmed_swing_low, 9250);
  assert.equal(sc.next_resistance, 10050);
  assert.equal(sc.atr14, 120.5);
  assert.ok(sc.candle_structure && sc.candle_structure.body === 40, 'candle body derived from OHLC');
  assert.ok(sc.candle_structure.upper_wick >= 0 && sc.candle_structure.lower_wick >= 0);
});

test('15. sample capture never fabricates structure from SL/TP when absent', () => {
  const sc = collector.buildStructuralContext({
    open_price: 1000, high_price: 1010, low_price: 990, last_price: 1005, sl: 960, tp1: 1080
  });
  assert.equal(sc.support, null, 'no support fabricated from SL');
  assert.equal(sc.resistance, null, 'no resistance fabricated from TP');
  assert.equal(sc.confirmed_swing_low, null);
  assert.equal(sc.atr14, null);
});

// ===================================================================
// 16. API JavaScript count remains exactly 12
// ===================================================================

test('16. the API surface remains exactly 12 endpoints', () => {
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js'));
  assert.equal(apiFiles.length, 12, 'API endpoint count must stay 12: ' + apiFiles.join(', '));
});
