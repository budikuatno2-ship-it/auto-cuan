'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sectorHot = require('../api/sector-hot');

const {
  candidatePassesPublicTelegramSafetyGate,
  candidatePassesTop5WatchlistGate,
  sendDailyTop5Telegram
} = sectorHot.__test;

// ============================================================
// BASE CANDIDATE FACTORY — mimics COCO/MTEL/MDIA from the problem statement
// ============================================================

function watchlistBase(overrides) {
  return Object.assign({
    ticker: 'COCO', category: 'Swing Konglo', status: 'Swing Ready', final_status: 'Swing Ready',
    risk_label: 'Medium Risk', risk_label_v2: 'Medium Risk', risk_reward: 2.5,
    entry_low: 1000, entry_high: 1050, entry1: 1050, entry2: 1000,
    sl: 950, stop_loss: 950, tp1n: 1300, tp1: 1300, tp2n: 1500, tp2: 1500,
    tp1_upside: 23.8, last_price: 1060, lastn: 1060,
    trading_plan_valid: true, plan_quality_status: 'OK',
    liquidity_label: 'Liquid', volume_confirmation_label: 'Volume kuat',
    volume_label: 'Accumulation Volume', volume_notes: 'Volume di atas rata-rata.',
    volume_phase: 'MARKUP_CONFIRMATION',
    entry_status: 'IN_ENTRY_AREA', entry_quality_status: 'IN_ENTRY_AREA',
    setup_freshness_status: 'FRESH', freshness_is_stale: false, is_stale: false,
    breakout_confirmation_status: 'BREAKOUT_WATCH',
    quality_grade: 'A', grade: 'A', confidence: 'A',
    telegram_verdict: 'Pantau breakout/reclaim valid dengan volume.',
    score: 82,
    // Required for min upside calculation
    entry_high: 1050
  }, overrides || {});
}

function strictSignalBase(overrides) {
  // A candidate that passes the strict Entry Signal gate
  return Object.assign(watchlistBase(), {
    breakout_confirmation_status: 'CONFIRMED',
    setup_freshness_status: 'FRESH'
  }, overrides || {});
}

// ============================================================
// TEST: BREAKOUT_WATCH + A grade + safe entry + valid liquidity passes watchlist gate
// ============================================================

test('BREAKOUT_WATCH + A grade + IN_ENTRY_AREA + Liquid passes watchlist gate', () => {
  var c = watchlistBase();
  assert.equal(candidatePassesTop5WatchlistGate(c), true);
});

test('BREAKOUT_WATCH + A grade + NEAR_ENTRY + Liquid passes watchlist gate', () => {
  var c = watchlistBase({ entry_status: 'NEAR_ENTRY' });
  assert.equal(candidatePassesTop5WatchlistGate(c), true);
});

test('NEEDS_CLOSE_CONFIRMATION + B grade + valid passes watchlist gate', () => {
  var c = watchlistBase({ breakout_confirmation_status: 'NEEDS_CLOSE_CONFIRMATION', quality_grade: 'B', grade: 'B' });
  assert.equal(candidatePassesTop5WatchlistGate(c), true);
});

test('BREAKOUT_WATCH + WAIT_PULLBACK entry_status passes watchlist gate', () => {
  var c = watchlistBase({ entry_status: 'WAIT_PULLBACK' });
  assert.equal(candidatePassesTop5WatchlistGate(c), true);
});

test('MTEL-like candidate (Low Risk, A grade, BREAKOUT_WATCH) passes watchlist gate', () => {
  var c = watchlistBase({
    ticker: 'MTEL', risk_label_v2: 'Low Risk', risk_label: 'Low Risk',
    quality_grade: 'A', risk_reward: 2.27,
    breakout_confirmation_status: 'BREAKOUT_WATCH',
    entry_status: 'IN_ENTRY_AREA', plan_quality_status: 'OK'
  });
  assert.equal(candidatePassesTop5WatchlistGate(c), true);
});

test('MDIA-like candidate (Medium Risk, A grade, BREAKOUT_WATCH, NEAR_ENTRY) passes watchlist gate', () => {
  var c = watchlistBase({
    ticker: 'MDIA', risk_label_v2: 'Medium Risk',
    quality_grade: 'A', risk_reward: 2.0,
    breakout_confirmation_status: 'BREAKOUT_WATCH',
    entry_status: 'NEAR_ENTRY', volume_phase: 'MARKUP_CONFIRMATION'
  });
  assert.equal(candidatePassesTop5WatchlistGate(c), true);
});

// ============================================================
// TEST: AVOID still blocked
// ============================================================

test('AVOID grade blocked by watchlist gate', () => {
  var c = watchlistBase({ quality_grade: 'Avoid', grade: 'Avoid' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('action Hindari blocked by watchlist gate', () => {
  var c = watchlistBase({ action_label: 'Hindari' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('signal_action AVOID blocked by watchlist gate', () => {
  var c = watchlistBase({ signal_action: 'AVOID' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('foreign net sell commentary is not an actionable SELL instruction', () => {
  var c = strictSignalBase({ foreign_notes: 'Foreign net sell masih terdeteksi; tunggu konfirmasi.', notes: 'Foreign net sell is an analytical factor.' });
  assert.equal(candidatePassesTop5WatchlistGate(c), true);
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daytrade'), true);
});

test('structured SELL action or status remains fatal', () => {
  assert.equal(candidatePassesTop5WatchlistGate(watchlistBase({ action: 'SELL' })), false);
  assert.equal(candidatePassesPublicTelegramSafetyGate(strictSignalBase({ display_status: 'SELL' }), 'daytrade'), false);
});

// ============================================================
// TEST: DISTRIBUTION_RISK still blocked
// ============================================================

test('volume_phase DISTRIBUTION blocks watchlist gate', () => {
  var c = watchlistBase({ volume_phase: 'DISTRIBUTION' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('volume_phase DISTRIBUTION_RISK blocks watchlist gate', () => {
  var c = watchlistBase({ volume_phase: 'DISTRIBUTION_RISK' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('status_reason with distribution_risk text blocks watchlist gate', () => {
  var c = watchlistBase({ status_reason: 'DISTRIBUTION_RISK detected' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('MARKUP_CONFIRMATION volume_phase is NOT blocked', () => {
  var c = watchlistBase({ volume_phase: 'MARKUP_CONFIRMATION' });
  assert.equal(candidatePassesTop5WatchlistGate(c), true);
});

// ============================================================
// TEST: Very High Risk still blocked
// ============================================================

test('Very High Risk blocked by watchlist gate', () => {
  var c = watchlistBase({ risk_label_v2: 'Very High Risk' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

// ============================================================
// TEST: weak liquidity still blocked
// ============================================================

test('is_liquidity_risk=true blocked by watchlist gate', () => {
  var c = watchlistBase({ is_liquidity_risk: true });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('Likuiditas Tipis label blocked by watchlist gate', () => {
  var c = watchlistBase({ liquidity_label: 'Likuiditas Tipis' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

// ============================================================
// TEST: chase/extended still blocked
// ============================================================

test('entry_status CHASE_RISK blocked by watchlist gate', () => {
  var c = watchlistBase({ entry_status: 'CHASE_RISK' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('entry_status EXTENDED blocked by watchlist gate', () => {
  var c = watchlistBase({ entry_status: 'EXTENDED' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

// ============================================================
// TEST: stale / needs revalidation still blocked
// ============================================================

test('is_stale=true blocked by watchlist gate', () => {
  var c = watchlistBase({ is_stale: true });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('setup_freshness_status NEEDS_REVALIDATION blocked by watchlist gate', () => {
  var c = watchlistBase({ setup_freshness_status: 'NEEDS_REVALIDATION' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('setup_freshness_status EXPIRED blocked by watchlist gate', () => {
  var c = watchlistBase({ setup_freshness_status: 'EXPIRED' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

// ============================================================
// TEST: below SL / invalidation hit still blocked
// ============================================================

test('entry_status INVALID_BELOW_SL blocked by watchlist gate', () => {
  var c = watchlistBase({ entry_status: 'INVALID_BELOW_SL' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('invalidation_distance_status INVALID_BELOW_SL blocked by watchlist gate', () => {
  var c = watchlistBase({ invalidation_distance_status: 'INVALID_BELOW_SL' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

// ============================================================
// TEST: invalid plan still blocked
// ============================================================

test('trading_plan_valid=false blocked by watchlist gate', () => {
  var c = watchlistBase({ trading_plan_valid: false });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('plan_quality_status INVALID blocked by watchlist gate', () => {
  var c = watchlistBase({ plan_quality_status: 'INVALID' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

// ============================================================
// TEST: weak volume (fatal) still blocked
// ============================================================

test('weak volume label blocked by watchlist gate', () => {
  var c = watchlistBase({ volume_label: 'Weak Volume' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('volume lemah text blocked by watchlist gate', () => {
  var c = watchlistBase({ volume_notes: 'volume lemah, belum konfirmasi' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

// ============================================================
// TEST: unsafe ARA/ARB blocked
// ============================================================

test('execution_reality_status ARA_HIT blocked by watchlist gate', () => {
  var c = watchlistBase({ execution_reality_status: 'ARA_HIT' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('buy_execution_realistic=false blocked by watchlist gate', () => {
  var c = watchlistBase({ buy_execution_realistic: false });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('execution_reality_status UNKNOWN_LIMITS blocked by watchlist gate', () => {
  var c = watchlistBase({ execution_reality_status: 'UNKNOWN_LIMITS' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

// ============================================================
// TEST: failed breakout blocked
// ============================================================

test('false_breakout_risk=true blocked by watchlist gate', () => {
  var c = watchlistBase({ false_breakout_risk: true });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('breakout_confirmation_status FALSE_BREAKOUT_RISK blocked by watchlist gate', () => {
  var c = watchlistBase({ breakout_confirmation_status: 'FALSE_BREAKOUT_RISK' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

// ============================================================
// TEST: High Risk only passes if Liquid + RR >= 2 + no distribution
// ============================================================

test('High Risk + Liquid + RR >= 2 + no distribution passes watchlist gate', () => {
  var c = watchlistBase({ risk_label_v2: 'High Risk', liquidity_label: 'Liquid', risk_reward: 2.5, volume_phase: 'MARKUP_CONFIRMATION' });
  assert.equal(candidatePassesTop5WatchlistGate(c), true);
});

test('High Risk + Liquid + RR < 2 blocked by watchlist gate', () => {
  var c = watchlistBase({ risk_label_v2: 'High Risk', liquidity_label: 'Liquid', risk_reward: 1.8 });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('High Risk + non-Liquid blocked by watchlist gate', () => {
  var c = watchlistBase({ risk_label_v2: 'High Risk', liquidity_label: 'Likuiditas Tipis', risk_reward: 3.0 });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('High Risk + Liquid + distribution volume_phase blocked', () => {
  var c = watchlistBase({ risk_label_v2: 'High Risk', liquidity_label: 'Liquid', risk_reward: 2.5, volume_phase: 'DISTRIBUTION' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

// ============================================================
// TEST: RR < 1.5 blocked
// ============================================================

test('RR < 1.5 blocked by watchlist gate', () => {
  var c = watchlistBase({ risk_reward: 1.4 });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('RR = 1.5 passes watchlist gate', () => {
  var c = watchlistBase({ risk_reward: 1.5 });
  assert.equal(candidatePassesTop5WatchlistGate(c), true);
});

// ============================================================
// TEST: Grade C only passes with RR >= 2.5 and Low/Medium risk
// ============================================================

test('Grade C + RR >= 2.5 + Low Risk passes watchlist gate', () => {
  var c = watchlistBase({ quality_grade: 'C', grade: 'C', confidence: 'C', risk_reward: 2.5, risk_label_v2: 'Low Risk' });
  assert.equal(candidatePassesTop5WatchlistGate(c), true);
});

test('Grade C + RR < 2.5 blocked by watchlist gate', () => {
  var c = watchlistBase({ quality_grade: 'C', grade: 'C', confidence: 'C', risk_reward: 2.0, risk_label_v2: 'Low Risk' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('Grade D blocked by watchlist gate', () => {
  var c = watchlistBase({ quality_grade: 'D', grade: 'D', confidence: 'D' });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

// ============================================================
// TEST: normal strict signal behavior unchanged
// ============================================================

test('strict signal candidate with CONFIRMED breakout passes public safety gate', () => {
  var c = strictSignalBase();
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), true);
});

test('BREAKOUT_WATCH candidate still fails strict public safety gate', () => {
  var c = watchlistBase();
  // The strict gate should STILL reject BREAKOUT_WATCH
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
});

test('watchlist gate does NOT affect strict signal gate result', () => {
  // A candidate failing the strict gate but passing watchlist gate
  // should still be correctly classified as watchlist_candidate, not strict_signal
  var c = watchlistBase({ breakout_confirmation_status: 'BREAKOUT_WATCH' });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
  assert.equal(candidatePassesTop5WatchlistGate(c), true);
});

// ============================================================
// TEST: Telegram wording includes "Bukan sinyal entry langsung" in watchlist mode
// ============================================================

test('sendDailyTop5Telegram watchlist_mode header includes pantauan wording', async function() {
  // Mock supabase and telegramNotifier to capture sent messages
  var sentMessages = [];
  var originalSendTelegramMessage = require('../lib/telegram-notifier').sendTelegramMessage;
  require('../lib/telegram-notifier').sendTelegramMessage = async function(msg) {
    sentMessages.push(msg);
    return { sent: true, skipped: false };
  };

  try {
    var picks = [watchlistBase({ ticker: 'COCO' }), watchlistBase({ ticker: 'MTEL' })];
    var mockSupabase = {
      from: function() {
        return { select: function() { return { eq: function() { return { order: function() { return { limit: function() { return Promise.resolve({ data: [], error: null }); } }; } }; } }; } };
      }
    };
    var result = await sendDailyTop5Telegram(mockSupabase, picks, '2026-07-04', {
      previous_close_snapshot: true,
      watchlist_mode: true
    });

    assert.equal(result.watchlist_mode, true);
    assert.ok(sentMessages.length >= 1, 'should have sent at least 1 message');

    // Header message should contain watchlist wording
    var headerMsg = sentMessages[0];
    assert.ok(headerMsg.indexOf('Top 5 Watchlist') >= 0, 'header should contain Top 5 Watchlist');
    assert.ok(headerMsg.indexOf('Bukan sinyal entry langsung') >= 0, 'header should contain disclaimer');
    assert.ok(headerMsg.indexOf('breakout/close confirmation') >= 0, 'header should contain breakout condition');

    // Should NOT contain Entry Signal wording
    assert.ok(headerMsg.indexOf('AUTO-CUAN SAHAM PILIHAN') < 0, 'should NOT use entry signal title');
  } finally {
    require('../lib/telegram-notifier').sendTelegramMessage = originalSendTelegramMessage;
  }
});

test('sendDailyTop5Telegram normal mode header uses standard wording', async function() {
  var sentMessages = [];
  var originalSendTelegramMessage = require('../lib/telegram-notifier').sendTelegramMessage;
  require('../lib/telegram-notifier').sendTelegramMessage = async function(msg) {
    sentMessages.push(msg);
    return { sent: true, skipped: false };
  };

  try {
    var picks = [strictSignalBase({ ticker: 'BBRI' })];
    var mockSupabase = {
      from: function() {
        return { select: function() { return { eq: function() { return { order: function() { return { limit: function() { return Promise.resolve({ data: [], error: null }); } }; } }; } }; } };
      }
    };
    var result = await sendDailyTop5Telegram(mockSupabase, picks, '2026-07-04', {
      previous_close_snapshot: false,
      watchlist_mode: false
    });

    assert.equal(result.watchlist_mode, false);
    assert.ok(sentMessages.length >= 1);
    var headerMsg = sentMessages[0];
    assert.ok(headerMsg.indexOf('AUTO-CUAN SAHAM PILIHAN') >= 0, 'normal mode should use standard title');
    assert.ok(headerMsg.indexOf('TOP 5 WATCHLIST') < 0, 'normal mode should NOT use watchlist title');
  } finally {
    require('../lib/telegram-notifier').sendTelegramMessage = originalSendTelegramMessage;
  }
});

// ============================================================
// TEST: diagnostics distinguishes strict_signal vs watchlist_candidate vs blocked
// ============================================================

test('diagnostics classification: strict_signal, watchlist_candidate, blocked', () => {
  // Simulate the classification logic from handleTelegramDailyPicks
  var picks = [
    strictSignalBase({ ticker: 'BBRI' }),        // strict_signal
    watchlistBase({ ticker: 'COCO' }),            // watchlist_candidate
    watchlistBase({ ticker: 'SAME', quality_grade: 'Avoid', grade: 'Avoid' })  // blocked
  ];

  var strictSignalPicks = [];
  var watchlistCandidates = [];
  var rejectedByGate = [];
  var isWatchlistContext = true;

  picks.forEach(function(p) {
    var passesSafety = candidatePassesPublicTelegramSafetyGate(p, 'daily_top5');
    var passesUpside = true; // simplified for test
    if (passesSafety && passesUpside) {
      strictSignalPicks.push(p);
    } else if (isWatchlistContext && candidatePassesTop5WatchlistGate(p)) {
      watchlistCandidates.push(p);
    } else {
      rejectedByGate.push({ ticker: p.ticker, classification: 'blocked' });
    }
  });

  assert.equal(strictSignalPicks.length, 1);
  assert.equal(strictSignalPicks[0].ticker, 'BBRI');
  assert.equal(watchlistCandidates.length, 1);
  assert.equal(watchlistCandidates[0].ticker, 'COCO');
  assert.equal(rejectedByGate.length, 1);
  assert.equal(rejectedByGate[0].ticker, 'SAME');
  assert.equal(rejectedByGate[0].classification, 'blocked');
});

test('when no strict_signal but watchlist exists, top5Mode = watchlist', () => {
  var picks = [
    watchlistBase({ ticker: 'COCO' }),
    watchlistBase({ ticker: 'MTEL', risk_label_v2: 'Low Risk' }),
    watchlistBase({ ticker: 'SAME', quality_grade: 'Avoid', grade: 'Avoid' })  // blocked
  ];

  var strictSignalPicks = [];
  var watchlistCandidates = [];
  var rejectedByGate = [];
  var isWatchlistContext = true;

  picks.forEach(function(p) {
    var passesSafety = candidatePassesPublicTelegramSafetyGate(p, 'daily_top5');
    var passesUpside = true;
    if (passesSafety && passesUpside) {
      strictSignalPicks.push(p);
    } else if (isWatchlistContext && candidatePassesTop5WatchlistGate(p)) {
      watchlistCandidates.push(p);
    } else {
      rejectedByGate.push({ ticker: p.ticker });
    }
  });

  var top5Mode = 'strict_signal';
  var finalPicks = strictSignalPicks;
  if (strictSignalPicks.length === 0 && watchlistCandidates.length > 0) {
    finalPicks = watchlistCandidates.slice(0, 5);
    top5Mode = 'watchlist';
  } else if (strictSignalPicks.length === 0 && watchlistCandidates.length === 0) {
    top5Mode = 'empty';
  }

  assert.equal(top5Mode, 'watchlist');
  assert.equal(finalPicks.length, 2);
  assert.deepEqual(finalPicks.map(function(p) { return p.ticker; }), ['COCO', 'MTEL']);
  assert.equal(rejectedByGate.length, 1);
  assert.equal(rejectedByGate[0].ticker, 'SAME');
});

test('when strict_signal exists, top5Mode = strict_signal (watchlist candidates ignored)', () => {
  var picks = [
    strictSignalBase({ ticker: 'BBRI' }),
    watchlistBase({ ticker: 'COCO' })
  ];

  var strictSignalPicks = [];
  var watchlistCandidates = [];
  var isWatchlistContext = true;

  picks.forEach(function(p) {
    var passesSafety = candidatePassesPublicTelegramSafetyGate(p, 'daily_top5');
    var passesUpside = true;
    if (passesSafety && passesUpside) {
      strictSignalPicks.push(p);
    } else if (isWatchlistContext && candidatePassesTop5WatchlistGate(p)) {
      watchlistCandidates.push(p);
    }
  });

  var top5Mode = 'strict_signal';
  var finalPicks = strictSignalPicks;
  if (strictSignalPicks.length === 0 && watchlistCandidates.length > 0) {
    finalPicks = watchlistCandidates.slice(0, 5);
    top5Mode = 'watchlist';
  }

  assert.equal(top5Mode, 'strict_signal');
  assert.equal(finalPicks.length, 1);
  assert.equal(finalPicks[0].ticker, 'BBRI');
});

// ============================================================
// TEST: data_quality_valid=false still blocked
// ============================================================

test('data_quality_valid=false blocked by watchlist gate', () => {
  var c = watchlistBase({ data_quality_valid: false });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

// ============================================================
// TEST: missing plan fields blocked
// ============================================================

test('missing entry1 blocked by watchlist gate', () => {
  var c = watchlistBase({ entry1: null, entry_low: null, entry_high: null });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});

test('missing tp1 blocked by watchlist gate', () => {
  var c = watchlistBase({ tp1: null, tp1n: null });
  assert.equal(candidatePassesTop5WatchlistGate(c), false);
});
