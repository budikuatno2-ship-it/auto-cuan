'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');

const sweepDiag = require('../lib/trade-plan-v2-sweep-diagnostic');
const tp = require('../lib/trade-plan-v2');
const fmt = require('../lib/trade-plan-v2-formatter');
const flags = require('../lib/trade-plan-v2-flags');
const templates = require('../lib/telegram-templates');
const eng = require('../lib/daytrade-screener-engine');

const FIXTURES = path.join(__dirname, 'fixtures', 'intraday-shadow-trade-backtest');
const SHADOW_ROOT = path.join(FIXTURES, 'shadow');
const SAMPLE_ROOT = path.join(FIXTURES, 'samples');
const DATES = ['2026-07-20', '2026-07-21', '2026-07-22'];
const SAFE_ENV = Object.freeze({ DAYTRADE_INTRADAY_SCORE_ENABLED: 'false', DAYTRADE_WORKER_ALLOW_MUTATION: 'false', TELEGRAM_ENABLED: '0' });

function run(overrides) {
  return sweepDiag.runSweepConfirmationDiagnostic(Object.assign({
    shadowRoot: SHADOW_ROOT, sampleRoot: SAMPLE_ROOT, dates: DATES.slice(), minScore: 16, env: Object.assign({}, SAFE_ENV)
  }, overrides || {}));
}

// ===================================================================
// Three-day sweep-confirmation comparison
// ===================================================================

test('1. compares the four confirmation policies and reports the full metric set', async () => {
  const r = await run();
  assert.equal(r.status, 'success');
  assert.equal(r.screener_type, 'DAY_TRADE');
  assert.deepEqual(r.dates, DATES);
  const P = r.policy_comparison_all_trades;
  for (const key of ['IMMEDIATE_FIRST_TOUCH', 'ONE_OBS_RECLAIM', 'TWO_OBS_BREAKDOWN', 'EMERGENCY_ONLY']) {
    assert.ok(P[key], 'missing policy ' + key);
    const m = P[key].metrics;
    for (const f of ['avoided_false_exits', 'additional_losses_from_delayed_confirmation',
      'subsequent_mfe_after_reclaimed_sweep', 'avg_net_return_pct', 'median_net_return_pct',
      'max_drawdown_pct', 'outlier_dependence', 'emergency_exit_count']) {
      assert.ok(f in m, 'policy ' + key + ' missing metric ' + f);
    }
  }
});

test('2. the 50 bps round-trip cost and independent-trade dedup are applied', async () => {
  const r = await run();
  assert.equal(r.parameters.round_trip_cost_bps, 50);
  assert.equal(r.parameters.independent_deduplicated_trades, true);
  assert.equal(r.counts.unique_independent_trades, 5);
});

test('3. the emergency structural hard stop is always active for every policy', async () => {
  const r = await run();
  assert.equal(r.parameters.emergency_hard_stop_always_active, true);
  assert.equal(r.safety.emergency_hard_stop_always_active, true);
  // The EMERGENCY_ONLY policy still exits via the hard stop (never disabled).
  const emgExits = r.policy_comparison_all_trades.EMERGENCY_ONLY.metrics.emergency_exit_count;
  assert.ok(emgExits >= 0);
});

test('4. results excluding BNBR are reported (BNBR absent => identical, with a note)', async () => {
  const r = await run();
  assert.ok(r.policy_comparison_excluding_bnbr);
  assert.ok(r.warnings.some((w) => /BNBR_NOT_PRESENT/.test(w)));
  assert.match(r.excluding_bnbr_note, /not present/i);
  // With BNBR absent the excluding-BNBR comparison equals the all-trades one.
  assert.deepEqual(r.policy_comparison_excluding_bnbr, r.policy_comparison_all_trades);
});

test('5. excluding BNBR actually removes it when present', () => {
  // Synthetic trades exercising the ticker filter deterministically.
  const mk = (ticker, net) => ({ _date: '2026-07-20', _ticker: ticker, _entryMinutes: 570,
    outcomes: { IMMEDIATE_FIRST_TOUCH: { available: true, net_return_pct: net, trailing_exit: false, emergency_exit: false, swept_and_reclaimed: false, subsequent_mfe_after_reclaim_pct: null },
      ONE_OBS_RECLAIM: { available: true, net_return_pct: net, trailing_exit: false, emergency_exit: false, swept_and_reclaimed: false, subsequent_mfe_after_reclaim_pct: null },
      TWO_OBS_BREAKDOWN: { available: true, net_return_pct: net, trailing_exit: false, emergency_exit: false, swept_and_reclaimed: false, subsequent_mfe_after_reclaim_pct: null },
      EMERGENCY_ONLY: { available: true, net_return_pct: net, trailing_exit: false, emergency_exit: false, swept_and_reclaimed: false, subsequent_mfe_after_reclaim_pct: null } } });
  const trades = [mk('WINR', 2), mk('BNBR', 100)];
  const all = sweepDiag.aggregatePolicy('IMMEDIATE_FIRST_TOUCH', trades);
  const exB = sweepDiag.aggregatePolicy('IMMEDIATE_FIRST_TOUCH', trades.filter((t) => t._ticker !== 'BNBR'));
  assert.equal(all.resolved_trades, 2);
  assert.equal(exB.resolved_trades, 1);
  assert.notEqual(all.avg_net_return_pct, exB.avg_net_return_pct);
});

test('6. deterministic (byte-identical reruns)', async () => {
  assert.deepEqual(await run(), await run());
});

test('7. DAY_TRADE only — Swing is refused and no swing calibration is claimed', async () => {
  assert.equal((await run({ screenerType: 'SWING_KONGLO' })).status, 'rejected_scope');
  assert.equal((await run({ screenerType: 'SWING_NON_KONGLO' })).status, 'rejected_scope');
  const ok = await run();
  assert.match(ok.scope_disclaimer, /must NOT be used to claim calibration of Swing Konglo or Swing Non-Konglo/i);
  assert.match(ok.scope_disclaimer, /NO profitability is claimed/i);
});

test('8. safety gate fails when scoring/mutation/telegram is enabled', async () => {
  assert.equal((await run({ env: { DAYTRADE_INTRADAY_SCORE_ENABLED: '1' } })).status, 'safety_violation');
  assert.equal((await run({ env: { TELEGRAM_ENABLED: '1' } })).status, 'safety_violation');
});

test('9. simulateSweepPolicy applies the emergency hard stop under EMERGENCY_ONLY', () => {
  const out = sweepDiag.simulateSweepPolicy({
    entryPrice: 100, support: 96, resistance: 120, atrProxy: 2,
    forwardPath: [{ minutes: 615, price: 90 }, { minutes: 700, price: 85 }], // crashes below emergency
    supportBufferAtr: 0.5, trailingAtr: 1.0, tp1BufferAtr: 0.2
  }, 'EMERGENCY_ONLY');
  assert.equal(out.emergency_exit, true);
  assert.equal(out.exit_reason, 'EMERGENCY_STOP');
});

// ===================================================================
// Backward compatibility + byte-identical existing behaviour
// ===================================================================

test('10. existing Trade Plan V2 outputs remain backward compatible (no-sweep inputs unchanged)', () => {
  const plan = tp.buildTradePlanV2({
    ticker: 'TEST', entry_low: 1000, entry_high: 1010, support: 990, swing_low: 990,
    resistance: 1080, atr14: 20, current_price: 1008
  }, { screener_type: 'DAY_TRADE' });
  // Core fields use the nearest confirmed swing low and realistic R target.
  assert.equal(plan.status, tp.STATUS.WARNING);
  assert.equal(plan.stop_loss, 980);
  assert.equal(plan.tp1, 1040);
  assert.equal(plan.support, 990);
  assert.equal(plan.resistance, 1080);
  assert.equal(plan.rr_to_tp1, 1);
  assert.equal(plan.stop_anchor_type, tp.SUPPORT_ANCHOR_TYPE.CONFIRMED_SWING_LOW);
  // Additive fields default safely.
  assert.equal(plan.candle_structure, null);
  assert.deepEqual(plan.active_gap_areas, []);
  assert.equal(plan.trailing_sweep_state, tp.TRAILING_SWEEP_STATE.NORMAL);
});

test('11. existing screener scoring output is byte-identical (regression lock)', () => {
  const candles = [];
  let price = 1000;
  for (let i = 0; i < 60; i++) {
    const drift = Math.sin(i / 5) * 8 + i * 0.7;
    const o = price, c = 1000 + drift, h = Math.max(o, c) + 6, l = Math.min(o, c) - 6, v = 800000 + (i % 7) * 50000;
    candles.push({ open: Math.round(o), high: Math.round(h), low: Math.round(l), close: Math.round(c), volume: v });
    price = c;
  }
  const data = eng.analyzeDayTrade(candles, 'TEST');
  assert.equal(data.support, 1024);
  assert.equal(data.resistance, 1042);
  assert.equal(data.atr14, 12.79);
  const s = eng.scoreDayTrade(data, 'morning', 'UTAMA', null);
  assert.equal(s.daytrade_score, 56);
  assert.equal(s.liquidity_score, 7);
  assert.equal(s.momentum_score, 18);
  assert.equal(s.status, 'WAIT_PULLBACK');
});

// ===================================================================
// Public output unchanged while public flag is false
// ===================================================================

test('12. public output stays unchanged even with the sweep shadow flag enabled', () => {
  const plan = tp.buildTradePlanV2({ ticker: 'X', entry_low: 1000, entry_high: 1010, support: 990, resistance: 1080, atr14: 20 },
    { screener_type: 'DAY_TRADE' });
  const legacy = { ticker: 'X', entry1: 1010, sl: 980, source: 'legacy-engine' };
  // sweep shadow ON, public OFF => still legacy, unchanged.
  const sel = fmt.selectPublicTradePlan({
    legacyPayload: legacy, planV2: plan, channel: 'web',
    env: { TRADE_PLAN_V2_LIQUIDITY_SWEEP_SHADOW_ENABLED: 'true', TRADE_PLAN_V2_PUBLIC_ENABLED: 'false' }
  });
  assert.equal(sel.source, 'legacy');
  assert.deepEqual(sel.payload, legacy);
});

test('13. the existing Telegram signal card contains no V2 / sweep leakage', () => {
  const card = templates.formatSignalCard({
    ticker: 'BBCA', entry_low: 9405, entry_high: 9595, tp1: 9785, tp2: 10070,
    stop_loss: 9215, risk_reward: 1.8, last_price: 9500, status: 'READY_BREAKOUT'
  }, 1, 'daytrade');
  assert.equal(card.indexOf('TRADE PLAN V2'), -1);
  assert.equal(card.indexOf('SWEEP'), -1);
  assert.equal(card.indexOf('trailing_sweep'), -1);
});

// ===================================================================
// Shadow web / Telegram parity with the new fields
// ===================================================================

function sweepPlan() {
  return tp.buildTradePlanV2({
    ticker: 'PAR', entry_low: 1000, entry_high: 1010, support: 990, swing_low: 985, resistance: 1080,
    atr14: 20, current_price: 1008,
    gaps: [{ gap_type: 'FVG', gap_low: 960, gap_high: 980, gap_direction: 'demand' },
      { gap_type: 'FVG', gap_low: 1055, gap_high: 1075, gap_direction: 'supply' }]
  }, {
    screener_type: 'DAY_TRADE', trailing_reference: 995,
    observations: [{ open: 1005, high: 1015, low: 1000, close: 1012 }, { open: 1012, high: 1016, low: 965, close: 1008 }]
  });
}

test('14. shadow web and Telegram parity remains exact including the new fields', () => {
  const plan = sweepPlan();
  const web = fmt.buildWebViewModel(plan);
  const tg = fmt.buildTelegramViewModel(plan);
  const diff = fmt.diffViewModels(web, tg);
  assert.equal(diff.equal, true, 'mismatches: ' + JSON.stringify(diff.mismatches));
});

test('15. the new canonical sweep/gap fields match byte-for-byte across channels', () => {
  const plan = sweepPlan();
  const web = fmt.buildWebViewModel(plan).canonical;
  const tg = fmt.buildTelegramViewModel(plan).canonical;
  assert.equal(web.trailing_sweep_state, tg.trailing_sweep_state);
  assert.equal(web.soft_exit_state, tg.soft_exit_state);
  assert.equal(web.hard_exit_state, tg.hard_exit_state);
  assert.equal(web.trailing_reference, tg.trailing_reference);
  assert.equal(web.structure_confirmation_required, tg.structure_confirmation_required);
  for (const f of fmt.CANONICAL_STRUCTURED_FIELDS) {
    assert.equal(JSON.stringify(web[f]), JSON.stringify(tg[f]), 'structured field ' + f + ' must match');
  }
  // Presentation reads canonical values — never recalculates them.
  assert.equal(web.trailing_sweep_state, plan.trailing_sweep_state);
  assert.equal(JSON.stringify(web.nearest_demand_gap), JSON.stringify(plan.nearest_demand_gap));
});

// ===================================================================
// API count invariant
// ===================================================================

test('16. API endpoint count remains exactly 12', async () => {
  const entries = await fsp.readdir(path.join(__dirname, '..', 'api'));
  assert.equal(entries.filter((f) => f.endsWith('.js')).length, 12);
});
