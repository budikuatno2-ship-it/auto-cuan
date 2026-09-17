'use strict';

/**
 * Batch 7 — Swing R/R Gate & Signal Revalidation
 *
 * Regression guard: the Swing Telegram digest fallback path MUST NOT leak
 * candidates whose Risk/Reward ratio is below the minimum threshold.
 * Previously, when strictCandidates was empty, the digest fallback allowed
 * Tier 2 emiten (R/R 1.3x) through with no R/R floor.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const sectorHot = require('../api/sector-hot');
const notifier = require('../lib/telegram-notifier');
const swingEngine = require('../lib/swing-screener-engine');
const { passesRiskRewardFilter, MIN_RR_RATIO } = require('../lib/screener-config');

const {
  sendSwingKongloTelegramNotification,
  sendSwingNkTelegramNotification
} = sectorHot.__test;

const JAKARTA_TODAY = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

function makeSupabase(kongloRows, nkRows) {
  return {
    from: function(table) {
      var data;
      if (table === 'swing_screener_latest') data = kongloRows || [];
      else if (table === 'swing_screener_non_konglo_latest') data = nkRows || [];
      else data = [];
      return {
        select: function() { return this; },
        order: function() { return this; },
        limit: function() { return Promise.resolve({ data: data, error: null }); },
        eq: function() { return this; },
        neq: function() { return this; },
        in: function() { return this; },
        maybeSingle: function() { return Promise.resolve({ data: { calculated_at: new Date().toISOString(), status: 'published', run_date: JAKARTA_TODAY }, error: null }); }
      };
    }
  };
}

function validRow(overrides) {
  return Object.assign({
    ticker: 'BBRI', status: 'Watchlist', score: 72, rank: 1,
    last_price: 5025, entry_low: 5000, entry_high: 5050,
    stop_loss: 4800, tp1: 5500, tp2: 5800, risk_reward: 2.0,
    volume_ratio_avg20: 1.1, tx_value_1d: 5000000000, avg_tx_value_7d: 5000000000,
    trading_plan_valid: true, plan_quality_status: 'OK',
    risk_label: 'Medium Risk', risk_label_v2: 'Medium Risk',
    tf_1d_context: 'Green candle', tf_5d_context: 'Bullish',
    price_date: JAKARTA_TODAY, calculated_at: new Date().toISOString(),
    setup_freshness_status: 'FRESH'
  }, overrides || {});
}

function withSendSpy(fn) {
  var original = notifier.sendTelegramMessage;
  var calls = [];
  notifier.sendTelegramMessage = async function(text) { calls.push(text); return { sent: true, message: text }; };
  return fn(calls).finally(function() { notifier.sendTelegramMessage = original; });
}

// --- passesRiskRewardFilter contract -----------------------------------------

test('passesRiskRewardFilter rejects R/R 1.3x (below MIN_RR_RATIO 1.5)', function() {
  assert.equal(MIN_RR_RATIO, 1.5);
  assert.equal(passesRiskRewardFilter({ risk_reward: 1.3 }), false);
});

test('passesRiskRewardFilter accepts R/R >= 1.5x', function() {
  assert.equal(passesRiskRewardFilter({ risk_reward: 1.5 }), true);
  assert.equal(passesRiskRewardFilter({ risk_reward: 1.8 }), true);
});

test('passesRiskRewardFilter safely rejects invalid/null/0 R/R', function() {
  assert.equal(passesRiskRewardFilter({ risk_reward: null }), false);
  assert.equal(passesRiskRewardFilter({ risk_reward: 0 }), false);
  assert.equal(passesRiskRewardFilter({ risk_reward: 'abc' }), false);
  assert.equal(passesRiskRewardFilter({}), false);
  assert.equal(passesRiskRewardFilter(null), false);
});

// --- verifySwingHighConviction high-conviction gate --------------------------

test('verifySwingHighConviction rejects swing candidate with R/R 1.3x', function() {
  var out = swingEngine.verifySwingHighConviction({
    ticker: 'TIER2', status: 'SWING_READY', score: 80, risk_reward: 1.3,
    volume_ratio_20d: 1.3, tf_5d_context: 'Bullish', tf_1d_context: 'Green candle'
  });
  assert.equal(out, null, 'R/R 1.3x must be rejected from high conviction');
});

test('verifySwingHighConviction accepts swing candidate with R/R >= 1.8x', function() {
  var out = swingEngine.verifySwingHighConviction({
    ticker: 'GOODRR', status: 'SWING_READY', score: 80, risk_reward: 1.8,
    volume_ratio_20d: 1.3, tf_5d_context: 'Bullish', tf_1d_context: 'Green candle'
  });
  assert.ok(out, 'R/R 1.8x must pass high conviction');
  assert.equal(out.ticker, 'GOODRR');
});

test('verifySwingHighConviction safely rejects invalid/null/0 R/R', function() {
  assert.equal(swingEngine.verifySwingHighConviction({ ticker: 'X', status: 'SWING_READY', score: 80, risk_reward: null }), null);
  assert.equal(swingEngine.verifySwingHighConviction({ ticker: 'X', status: 'SWING_READY', score: 80, risk_reward: 0 }), null);
  assert.equal(swingEngine.verifySwingHighConviction(null), null);
});

// --- Telegram dispatch: fallback must not leak sub-minimum R/R ---------------

test('Swing Konglo fallback drops R/R 1.3x candidate from buy-signal dispatch', async function() {
  await withSendSpy(async function(calls) {
    // Levels yield genuine R/R 1.3x: (5375-5050)/(5050-4800) = 1.3
    var supabase = makeSupabase([validRow({ ticker: 'LOWRR', risk_reward: 1.3, score: 70, tp1: 5375, tp2: 5375 })]);
    var result = await sendSwingKongloTelegramNotification(supabase, 1);
    assert.equal(result.digest_candidate_count, 0, 'R/R 1.3x must be filtered out of digest fallback');
    assert.equal(result.selected_count, 0);
    // The buy-signal message must never carry the sub-minimum R/R ticker.
    calls.forEach(function(text) {
      if (/SWING KONGLO SIGNAL/i.test(text)) {
        assert.doesNotMatch(text, /LOWRR/, 'sub-minimum R/R ticker must never appear in a buy signal');
      }
    });
  });
});

test('Swing Non-Konglo fallback drops R/R 1.3x candidate from buy-signal dispatch', async function() {
  await withSendSpy(async function(calls) {
    // Levels yield genuine R/R 1.3x: (5375-5050)/(5050-4800) = 1.3
    var supabase = makeSupabase(null, [validRow({ ticker: 'NKLOW', rank: 1, risk_reward: 1.3, score: 70, tp1: 5375, tp2: 5375 })]);
    var result = await sendSwingNkTelegramNotification(supabase, 1);
    assert.equal(result.digest_candidate_count, 0, 'R/R 1.3x must be filtered out of digest fallback');
    assert.equal(result.selected_count, 0);
    calls.forEach(function(text) {
      if (/SWING NON-KONGLO SIGNAL/i.test(text)) {
        assert.doesNotMatch(text, /NKLOW/, 'sub-minimum R/R ticker must never appear in a buy signal');
      }
    });
  });
});

test('Swing Konglo fallback keeps R/R >= 1.5x candidate eligible', async function() {
  await withSendSpy(async function(calls) {
    // Levels yield genuine R/R 1.6x: (5450-5050)/(5050-4800) = 1.6
    var supabase = makeSupabase([validRow({ ticker: 'OKRR', risk_reward: 1.6, score: 70, tp1: 5450, tp2: 5450 })]);
    var result = await sendSwingKongloTelegramNotification(supabase, 1);
    assert.equal(result.digest_candidate_count, 1, 'R/R 1.6x must survive the digest fallback gate');
  });
});