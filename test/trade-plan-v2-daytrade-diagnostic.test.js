'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const diag = require('../lib/trade-plan-v2-daytrade-diagnostic');
const eng = require('../lib/daytrade-screener-engine');

const FIXTURES = path.join(__dirname, 'fixtures', 'intraday-shadow-trade-backtest');
const SHADOW_ROOT = path.join(FIXTURES, 'shadow');
const SAMPLE_ROOT = path.join(FIXTURES, 'samples');
const DATES = ['2026-07-20', '2026-07-21', '2026-07-22'];

const SAFE_ENV = Object.freeze({
  DAYTRADE_INTRADAY_SCORE_ENABLED: 'false',
  DAYTRADE_WORKER_ALLOW_MUTATION: 'false',
  TELEGRAM_ENABLED: '0'
});

function run(overrides) {
  return diag.runDaytradeDiagnostic(Object.assign({
    shadowRoot: SHADOW_ROOT,
    sampleRoot: SAMPLE_ROOT,
    dates: DATES.slice(),
    minScore: 16,
    env: Object.assign({}, SAFE_ENV)
  }, overrides || {}));
}

// ===================================================================
// Core diagnostic
// ===================================================================

test('1. the three-day diagnostic runs and reports the full metric set per variant', async () => {
  const r = await run();
  assert.equal(r.status, 'success');
  assert.equal(r.screener_type, 'DAY_TRADE');
  assert.deepEqual(r.dates, DATES);
  // 3 x 3 x 3 parameter grid.
  assert.equal(r.parameter_grid.length, 27);
  const m = r.baseline_day_trade_profile.by_exit_horizon.EOD;
  for (const f of ['stop_hit_frequency', 'tp1_hit_frequency', 'trailing_stop_exit_frequency',
    'avg_mfe_pct', 'avg_mae_pct', 'avg_net_return_pct', 'median_net_return_pct',
    'profit_factor', 'max_drawdown_pct', 'outlier_dependence']) {
    assert.ok(f in m, 'missing metric ' + f);
  }
  assert.ok('best_trade_share_of_total' in m.outlier_dependence);
});

test('2. deterministic parameter comparison covers support / TP1 / trailing / +60m vs EOD / 50bps', async () => {
  const r = await run();
  const p = r.parameters;
  assert.deepEqual(p.support_buffer_atr_variants, [0.25, 0.5, 0.75]);
  assert.deepEqual(p.tp1_resistance_buffer_atr_variants, [0.1, 0.2, 0.3]);
  assert.deepEqual(p.trailing_atr_variants, [0.75, 1, 1.5]);
  assert.deepEqual(p.exit_horizons.map((h) => h.key), ['PLUS_60M', 'EOD']);
  assert.equal(p.round_trip_cost_bps, 50);
  assert.equal(p.independent_deduplicated_trades, true);
  // every grid cell has both exit horizons.
  for (const cell of r.parameter_grid) {
    assert.ok(cell.by_exit_horizon.PLUS_60M);
    assert.ok(cell.by_exit_horizon.EOD);
    assert.equal(cell.variant.round_trip_cost_bps, 50);
  }
});

test('3. independent, deduplicated trades (one per ticker per day)', async () => {
  const r = await run();
  // Matches the shadow backtest: 5 entered independent trades across 3 days.
  assert.equal(r.counts.unique_independent_trades, 5);
});

test('4. the diagnostic is deterministic (byte-identical reruns)', async () => {
  const a = await run();
  const b = await run();
  assert.deepEqual(a, b);
});

test('5. the 50 bps round-trip cost reduces net exactly 0.50 percentage points below gross', () => {
  const out = diag.simulateTrade({
    entryPrice: 100,
    entryMinutes: 570, // 09:30
    support: 96,
    resistance: 110,
    atrProxy: 2,
    forwardPath: [{ minutes: 615, price: 106 }, { minutes: 960, price: 108 }],
    supportBufferAtr: 0.5,
    tp1BufferAtr: 0.2,
    trailingAtr: 1.0,
    horizon: { key: 'EOD', kind: 'eod' }
  });
  assert.equal(out.available, true);
  assert.equal(out.gross_return_pct - out.net_return_pct, 0.5);
});

// ===================================================================
// Scope guard: DAY TRADE only
// ===================================================================

test('6. the three intraday days are used ONLY for Day Trade (Swing is refused)', async () => {
  const kon = await run({ screenerType: 'SWING_KONGLO' });
  assert.equal(kon.status, 'rejected_scope');
  const non = await run({ screenerType: 'SWING_NON_KONGLO' });
  assert.equal(non.status, 'rejected_scope');
  // The success output disclaims any swing calibration.
  const ok = await run();
  assert.match(ok.scope_disclaimer, /must NOT be used to claim calibration of Swing Konglo or Swing Non-Konglo/i);
});

// ===================================================================
// Safety
// ===================================================================

test('7. enabling scoring / mutation / telegram fails the safety gate', async () => {
  assert.equal((await run({ env: { DAYTRADE_INTRADAY_SCORE_ENABLED: '1' } })).status, 'safety_violation');
  assert.equal((await run({ env: { DAYTRADE_WORKER_ALLOW_MUTATION: 'true' } })).status, 'safety_violation');
  assert.equal((await run({ env: { TELEGRAM_ENABLED: '1' } })).status, 'safety_violation');
});

test('8. the success summary asserts scoring / mutation / telegram / supabase / portfolio all off', async () => {
  const r = await run();
  const s = r.safety;
  assert.equal(s.production_scoring_enabled, false);
  assert.equal(s.mutations_performed, false);
  assert.equal(s.telegram_sent, false);
  assert.equal(s.supabase_writes, false);
  assert.equal(s.portfolio_mutated, false);
  assert.equal(s.source_files_rewritten, false);
});

test('9. trade-plan-v2 modules import no Telegram / Supabase / DB-mutation code', () => {
  const files = ['trade-plan-v2.js', 'trade-plan-v2-formatter.js', 'trade-plan-v2-flags.js', 'trade-plan-v2-daytrade-diagnostic.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');
    assert.ok(!/require\(['"].*telegram/i.test(src), f + ' must not import telegram');
    assert.ok(!/@supabase\/supabase-js/.test(src), f + ' must not import supabase client');
    assert.ok(!/\.insert\(|\.upsert\(|\.update\(/.test(src), f + ' must not perform DB mutations');
  }
});

// ===================================================================
// Base scoring formulas remain unchanged (regression lock)
// ===================================================================

function deterministicCandles() {
  const candles = [];
  let price = 1000;
  for (let i = 0; i < 60; i++) {
    const drift = Math.sin(i / 5) * 8 + i * 0.7;
    const o = price;
    const c = 1000 + drift;
    const h = Math.max(o, c) + 6;
    const l = Math.min(o, c) - 6;
    const v = 800000 + (i % 7) * 50000;
    candles.push({ open: Math.round(o), high: Math.round(h), low: Math.round(l), close: Math.round(c), volume: v });
    price = c;
  }
  return candles;
}

test('10. Day Trade base scoring formula output is unchanged (locked regression)', () => {
  const candles = deterministicCandles();
  const data = eng.analyzeDayTrade(candles, 'TEST');
  // analyzeDayTrade level formulas are unchanged.
  assert.equal(data.support, 1024);
  assert.equal(data.resistance, 1042);
  assert.equal(data.atr14, 12.79);
  assert.equal(data.rsi14, 54.55);
  // scoreDayTrade composite + components are unchanged.
  const s = eng.scoreDayTrade(data, 'morning', 'UTAMA', null);
  assert.equal(s.daytrade_score, 56);
  assert.equal(s.liquidity_score, 7);
  assert.equal(s.prespike_score, 18);
  assert.equal(s.momentum_score, 18);
  assert.equal(s.risk_reward_score, 0);
  assert.equal(s.trend_score, 13);
  assert.equal(s.penalty_score, 0);
  assert.equal(s.candle_score, 0);
  assert.equal(s.status, 'WAIT_PULLBACK');
});

test('11. Swing/Day base scoring helpers (score components) remain callable and unchanged', () => {
  // The individual base scoring functions used by Konglo / Non-Konglo / Day Trade
  // are still exported with unchanged formulas.
  const candles = deterministicCandles();
  const data = eng.analyzeDayTrade(candles, 'TEST');
  const levels = eng.calculateLevels(data);
  assert.equal(eng.scoreLiquidity(data).score, 7);
  assert.equal(eng.scorePreSpike(data), 18);
  assert.equal(eng.scoreMomentum(data), 18);
  assert.equal(eng.scoreRiskReward(data, levels), 5);
  assert.equal(eng.scoreTrend(data), 13);
  assert.equal(eng.calculatePenalty(data).penalty, 0);
});

// ===================================================================
// API endpoint count invariant
// ===================================================================

test('12. API endpoint count remains exactly 12', async () => {
  const entries = await fsp.readdir(path.join(__dirname, '..', 'api'));
  assert.equal(entries.filter((f) => f.endsWith('.js')).length, 12);
});
