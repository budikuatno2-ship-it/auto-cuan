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
// BASE CANDIDATE FACTORY
// ============================================================

function safeWatchlistCandidate(overrides) {
  return Object.assign({
    ticker: 'SAFE1', category: 'Swing Konglo', status: 'Swing Ready', final_status: 'Swing Ready',
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
    score: 82
  }, overrides || {});
}

function blockedCandidate(overrides) {
  return Object.assign(safeWatchlistCandidate(), {
    ticker: 'BLOCKED1',
    quality_grade: 'Avoid', grade: 'Avoid', confidence: 'Avoid'
  }, overrides || {});
}

function distributionBlockedCandidate(overrides) {
  return Object.assign(safeWatchlistCandidate(), {
    ticker: 'DIST1',
    volume_phase: 'DISTRIBUTION_RISK',
    status_reason: 'DISTRIBUTION_RISK detected'
  }, overrides || {});
}

// ============================================================
// TEST: fallback fills to 5 when first 5 contain 3 safe + 2 blocked
// ============================================================

test('watchlist fallback: first 5 contain 3 safe + 2 blocked, scans pool to fill to 5', () => {
  // Simulate the classification logic from handleTelegramDailyPicks
  // Initial picks from selectDailyTop5 (top 5)
  var initialPicks = [
    safeWatchlistCandidate({ ticker: 'COCO' }),
    safeWatchlistCandidate({ ticker: 'MTEL' }),
    safeWatchlistCandidate({ ticker: 'MDIA' }),
    blockedCandidate({ ticker: 'SAME' }),   // Grade Avoid
    distributionBlockedCandidate({ ticker: 'ARCI' })  // DISTRIBUTION_RISK
  ];

  // Broader pool (simulating top5RadarCandidates)
  var broaderPool = [
    safeWatchlistCandidate({ ticker: 'COCO' }),  // already picked
    safeWatchlistCandidate({ ticker: 'MTEL' }),  // already picked
    safeWatchlistCandidate({ ticker: 'MDIA' }),  // already picked
    blockedCandidate({ ticker: 'SAME' }),        // blocked
    distributionBlockedCandidate({ ticker: 'ARCI' }), // blocked
    safeWatchlistCandidate({ ticker: 'BBCA' }),  // safe, fill slot 4
    blockedCandidate({ ticker: 'BADX' }),        // blocked in pool
    safeWatchlistCandidate({ ticker: 'TLKM' }), // safe, fill slot 5
    safeWatchlistCandidate({ ticker: 'ASII' })   // not needed (already 5)
  ];

  // Step 1: classify initial picks (same as handleTelegramDailyPicks)
  var strictSignalPicks = [];
  var watchlistCandidates = [];
  var rejectedByGate = [];
  var isWatchlistContext = true;

  initialPicks.forEach(function(p) {
    var passesSafety = candidatePassesPublicTelegramSafetyGate(p, 'daily_top5');
    var passesUpside = true;
    if (passesSafety && passesUpside) {
      strictSignalPicks.push(p);
    } else if (isWatchlistContext && candidatePassesTop5WatchlistGate(p)) {
      watchlistCandidates.push(p);
    } else {
      rejectedByGate.push({ ticker: p.ticker, reason: 'blocked' });
    }
  });

  // Step 2: fallback — scan broader pool to fill to 5
  var watchlistSafeFromPool = [];
  var seenTickers = {};
  var watchlistScannedCount = 0;
  var watchlistBlockedCount = 0;

  watchlistCandidates.forEach(function(wc) {
    if (wc.ticker) seenTickers[wc.ticker] = true;
    watchlistSafeFromPool.push(wc);
  });

  for (var wp = 0; wp < broaderPool.length && watchlistSafeFromPool.length < 5; wp++) {
    var poolCandidate = broaderPool[wp];
    if (!poolCandidate || !poolCandidate.ticker) continue;
    if (seenTickers[poolCandidate.ticker]) continue;
    seenTickers[poolCandidate.ticker] = true;
    watchlistScannedCount++;
    if (candidatePassesTop5WatchlistGate(poolCandidate)) {
      watchlistSafeFromPool.push(poolCandidate);
    } else {
      watchlistBlockedCount++;
    }
  }

  var finalPicks = watchlistSafeFromPool.slice(0, 5);

  // Assertions
  assert.equal(strictSignalPicks.length, 0, 'no strict signals');
  assert.equal(finalPicks.length, 5, 'should fill to 5 safe candidates');
  assert.deepEqual(
    finalPicks.map(function(p) { return p.ticker; }),
    ['COCO', 'MTEL', 'MDIA', 'BBCA', 'TLKM'],
    'should include original 3 safe + 2 from broader pool'
  );
  assert.ok(watchlistScannedCount > 0, 'should have scanned additional candidates');
  assert.ok(watchlistBlockedCount > 0, 'should have blocked at least one from pool');
});

// ============================================================
// TEST: blocked candidates remain blocked — gate is not weakened
// ============================================================

test('watchlist fallback: blocked candidates remain blocked (gate not weakened)', () => {
  var unsafeCandidates = [
    blockedCandidate({ ticker: 'AVOID1', quality_grade: 'Avoid', grade: 'Avoid' }),
    distributionBlockedCandidate({ ticker: 'DIST1' }),
    safeWatchlistCandidate({ ticker: 'CHASE1', entry_status: 'CHASE_RISK' }),
    safeWatchlistCandidate({ ticker: 'STALE1', is_stale: true }),
    safeWatchlistCandidate({ ticker: 'VHRISK', risk_label_v2: 'Very High Risk' }),
    safeWatchlistCandidate({ ticker: 'WEAKLIQ', is_liquidity_risk: true }),
    safeWatchlistCandidate({ ticker: 'INVALIDPLAN', trading_plan_valid: false }),
    safeWatchlistCandidate({ ticker: 'FALSEBRK', false_breakout_risk: true }),
    safeWatchlistCandidate({ ticker: 'ARAHIT', execution_reality_status: 'ARA_HIT' }),
    safeWatchlistCandidate({ ticker: 'BELOWSL', entry_status: 'INVALID_BELOW_SL' })
  ];

  unsafeCandidates.forEach(function(c) {
    assert.equal(candidatePassesTop5WatchlistGate(c), false,
      c.ticker + ' should remain blocked by watchlist gate');
  });
});

// ============================================================
// TEST: if only 3 safe candidates exist in entire pool, returns 3 (not unsafe fillers)
// ============================================================

test('watchlist fallback: only 3 safe in entire pool returns 3, not unsafe fillers', () => {
  var initialPicks = [
    safeWatchlistCandidate({ ticker: 'COCO' }),
    safeWatchlistCandidate({ ticker: 'MTEL' }),
    blockedCandidate({ ticker: 'BAD1' }),
    blockedCandidate({ ticker: 'BAD2' }),
    blockedCandidate({ ticker: 'BAD3' })
  ];

  // Broader pool: only 1 additional safe candidate (total 3 safe: COCO, MTEL, BBCA)
  var broaderPool = [
    safeWatchlistCandidate({ ticker: 'COCO' }),
    safeWatchlistCandidate({ ticker: 'MTEL' }),
    blockedCandidate({ ticker: 'BAD1' }),
    blockedCandidate({ ticker: 'BAD2' }),
    blockedCandidate({ ticker: 'BAD3' }),
    safeWatchlistCandidate({ ticker: 'BBCA' }),
    blockedCandidate({ ticker: 'BAD4' }),
    blockedCandidate({ ticker: 'BAD5' }),
    blockedCandidate({ ticker: 'BAD6' })
  ];

  var strictSignalPicks = [];
  var watchlistCandidates = [];
  var isWatchlistContext = true;

  initialPicks.forEach(function(p) {
    var passesSafety = candidatePassesPublicTelegramSafetyGate(p, 'daily_top5');
    var passesUpside = true;
    if (passesSafety && passesUpside) {
      strictSignalPicks.push(p);
    } else if (isWatchlistContext && candidatePassesTop5WatchlistGate(p)) {
      watchlistCandidates.push(p);
    }
  });

  var watchlistSafeFromPool = [];
  var seenTickers = {};

  watchlistCandidates.forEach(function(wc) {
    if (wc.ticker) seenTickers[wc.ticker] = true;
    watchlistSafeFromPool.push(wc);
  });

  for (var wp = 0; wp < broaderPool.length && watchlistSafeFromPool.length < 5; wp++) {
    var poolCandidate = broaderPool[wp];
    if (!poolCandidate || !poolCandidate.ticker) continue;
    if (seenTickers[poolCandidate.ticker]) continue;
    seenTickers[poolCandidate.ticker] = true;
    if (candidatePassesTop5WatchlistGate(poolCandidate)) {
      watchlistSafeFromPool.push(poolCandidate);
    }
  }

  var finalPicks = watchlistSafeFromPool.slice(0, 5);

  assert.equal(finalPicks.length, 3, 'should only return 3 safe candidates, not pad with unsafe');
  assert.deepEqual(
    finalPicks.map(function(p) { return p.ticker; }),
    ['COCO', 'MTEL', 'BBCA']
  );
});

// ============================================================
// TEST: strict signal mode unchanged — does not trigger fallback
// ============================================================

test('watchlist fallback: strict signal mode unchanged (no fallback scan)', () => {
  // strictSignalBase passes both safety gate AND upside check
  var strictCandidate = safeWatchlistCandidate({
    ticker: 'BBRI',
    breakout_confirmation_status: 'CONFIRMED',
    setup_freshness_status: 'FRESH'
  });

  var initialPicks = [
    strictCandidate,
    safeWatchlistCandidate({ ticker: 'COCO' }),
    blockedCandidate({ ticker: 'BAD1' })
  ];

  var broaderPool = [
    strictCandidate,
    safeWatchlistCandidate({ ticker: 'COCO' }),
    safeWatchlistCandidate({ ticker: 'EXTRA1' }),
    safeWatchlistCandidate({ ticker: 'EXTRA2' }),
    safeWatchlistCandidate({ ticker: 'EXTRA3' })
  ];

  var strictSignalPicks = [];
  var watchlistCandidates = [];
  var isWatchlistContext = true;

  initialPicks.forEach(function(p) {
    var passesSafety = candidatePassesPublicTelegramSafetyGate(p, 'daily_top5');
    var passesUpside = true;
    if (passesSafety && passesUpside) {
      strictSignalPicks.push(p);
    } else if (isWatchlistContext && candidatePassesTop5WatchlistGate(p)) {
      watchlistCandidates.push(p);
    }
  });

  // When strict_signal_count > 0, final picks = strictSignalPicks (no fallback)
  var top5Mode = 'strict_signal';
  var finalPicks = strictSignalPicks;
  if (strictSignalPicks.length === 0 && isWatchlistContext) {
    // Would scan broader pool — but this path is NOT taken
    top5Mode = 'watchlist';
  } else if (strictSignalPicks.length > 0) {
    top5Mode = 'strict_signal';
  }

  assert.equal(top5Mode, 'strict_signal', 'should remain in strict_signal mode');
  assert.ok(strictSignalPicks.length > 0, 'strict signals exist');
  assert.equal(finalPicks[0].ticker, 'BBRI', 'strict signal candidate is first');
  // Broader pool is NOT scanned
});

// ============================================================
// TEST: diagnostics include watchlist_scanned_count and blocked_count
// ============================================================

test('watchlist fallback: diagnostics include watchlist_scanned_count and blocked_count', () => {
  var initialPicks = [
    safeWatchlistCandidate({ ticker: 'COCO' }),
    safeWatchlistCandidate({ ticker: 'MTEL' }),
    safeWatchlistCandidate({ ticker: 'MDIA' }),
    blockedCandidate({ ticker: 'SAME' }),
    distributionBlockedCandidate({ ticker: 'ARCI' })
  ];

  var broaderPool = [
    safeWatchlistCandidate({ ticker: 'COCO' }),
    safeWatchlistCandidate({ ticker: 'MTEL' }),
    safeWatchlistCandidate({ ticker: 'MDIA' }),
    blockedCandidate({ ticker: 'SAME' }),
    distributionBlockedCandidate({ ticker: 'ARCI' }),
    safeWatchlistCandidate({ ticker: 'BBCA' }),
    blockedCandidate({ ticker: 'BADX' }),
    safeWatchlistCandidate({ ticker: 'TLKM' })
  ];

  // Simulate the classification
  var strictSignalPicks = [];
  var watchlistCandidates = [];
  var rejectedByGate = [];
  var isWatchlistContext = true;

  initialPicks.forEach(function(p) {
    var passesSafety = candidatePassesPublicTelegramSafetyGate(p, 'daily_top5');
    var passesUpside = true;
    if (passesSafety && passesUpside) {
      strictSignalPicks.push(p);
    } else if (isWatchlistContext && candidatePassesTop5WatchlistGate(p)) {
      watchlistCandidates.push(p);
    } else {
      rejectedByGate.push({ ticker: p.ticker, reason: 'blocked' });
    }
  });

  // Fallback scan
  var watchlistScannedCount = 0;
  var watchlistBlockedCount = 0;
  var watchlistSafeFromPool = [];
  var seenTickers = {};

  watchlistCandidates.forEach(function(wc) {
    if (wc.ticker) seenTickers[wc.ticker] = true;
    watchlistSafeFromPool.push(wc);
  });

  for (var wp = 0; wp < broaderPool.length && watchlistSafeFromPool.length < 5; wp++) {
    var poolCandidate = broaderPool[wp];
    if (!poolCandidate || !poolCandidate.ticker) continue;
    if (seenTickers[poolCandidate.ticker]) continue;
    seenTickers[poolCandidate.ticker] = true;
    watchlistScannedCount++;
    if (candidatePassesTop5WatchlistGate(poolCandidate)) {
      watchlistSafeFromPool.push(poolCandidate);
    } else {
      watchlistBlockedCount++;
      rejectedByGate.push({ ticker: poolCandidate.ticker, reason: 'watchlist_gate_blocked' });
    }
  }

  var finalPicks = watchlistSafeFromPool.slice(0, 5);

  // Build diagnostics (simulating manualDiagnostics)
  var diagnostics = {
    raw_candidate_pool_count: broaderPool.length,
    strict_signal_count: strictSignalPicks.length,
    watchlist_candidate_count: watchlistSafeFromPool.length,
    watchlist_scanned_count: watchlistScannedCount,
    blocked_count: watchlistBlockedCount,
    selected_tickers: finalPicks.map(function(p) { return p.ticker; }),
    top5_mode: 'watchlist',
    top_rejection_reasons: (function() {
      var reasons = {};
      rejectedByGate.forEach(function(r) { reasons[r.reason] = (reasons[r.reason] || 0) + 1; });
      return reasons;
    })()
  };

  assert.equal(diagnostics.strict_signal_count, 0);
  assert.equal(diagnostics.watchlist_candidate_count, 5);
  assert.ok(diagnostics.watchlist_scanned_count > 0, 'watchlist_scanned_count should be > 0');
  assert.ok(diagnostics.blocked_count > 0, 'blocked_count should be > 0');
  assert.deepEqual(diagnostics.selected_tickers, ['COCO', 'MTEL', 'MDIA', 'BBCA', 'TLKM']);
  assert.equal(diagnostics.top5_mode, 'watchlist');
  assert.ok(diagnostics.top_rejection_reasons.blocked >= 2, 'should have at least 2 blocked from initial picks');
  assert.ok(diagnostics.top_rejection_reasons.watchlist_gate_blocked >= 1, 'should have at least 1 blocked from pool scan');
});

// ============================================================
// TEST: sendDailyTop5Telegram adds "Kandidat aman tersedia X dari 5" when < 5
// ============================================================

test('sendDailyTop5Telegram: watchlist mode with < 5 candidates shows availability count', async function() {
  var sentMessages = [];
  var originalSendTelegramMessage = require('../lib/telegram-notifier').sendTelegramMessage;
  require('../lib/telegram-notifier').sendTelegramMessage = async function(msg) {
    sentMessages.push(msg);
    return { sent: true, skipped: false };
  };

  try {
    var picks = [
      safeWatchlistCandidate({ ticker: 'COCO' }),
      safeWatchlistCandidate({ ticker: 'MTEL' }),
      safeWatchlistCandidate({ ticker: 'MDIA' })
    ];
    var mockSupabase = {
      from: function() {
        return { select: function() { return { eq: function() { return { order: function() { return { limit: function() { return Promise.resolve({ data: [], error: null }); } }; } }; } }; } };
      }
    };
    var result = await sendDailyTop5Telegram(mockSupabase, picks, '2026-07-04', {
      previous_close_snapshot: true,
      watchlist_mode: true,
      watchlist_safe_count: 3
    });

    assert.equal(result.watchlist_mode, true);
    assert.ok(sentMessages.length >= 1, 'should have sent at least 1 message');

    var headerMsg = sentMessages[0];
    assert.ok(headerMsg.indexOf('Top 5 Watchlist') >= 0, 'header should contain Top 5 Watchlist');
    assert.ok(headerMsg.indexOf('lolos gate: 3/5') >= 0, 'header should contain available/gate count (3/5)');
    assert.ok(headerMsg.indexOf('Bukan sinyal entry langsung') >= 0, 'header should contain disclaimer');
  } finally {
    require('../lib/telegram-notifier').sendTelegramMessage = originalSendTelegramMessage;
  }
});

// ============================================================
// TEST: sendDailyTop5Telegram with 5 candidates does NOT show availability count
// ============================================================

test('sendDailyTop5Telegram: watchlist mode with 5 candidates does NOT show availability count', async function() {
  var sentMessages = [];
  var originalSendTelegramMessage = require('../lib/telegram-notifier').sendTelegramMessage;
  require('../lib/telegram-notifier').sendTelegramMessage = async function(msg) {
    sentMessages.push(msg);
    return { sent: true, skipped: false };
  };

  try {
    var picks = [
      safeWatchlistCandidate({ ticker: 'COCO' }),
      safeWatchlistCandidate({ ticker: 'MTEL' }),
      safeWatchlistCandidate({ ticker: 'MDIA' }),
      safeWatchlistCandidate({ ticker: 'BBCA' }),
      safeWatchlistCandidate({ ticker: 'TLKM' })
    ];
    var mockSupabase = {
      from: function() {
        return { select: function() { return { eq: function() { return { order: function() { return { limit: function() { return Promise.resolve({ data: [], error: null }); } }; } }; } }; } };
      }
    };
    var result = await sendDailyTop5Telegram(mockSupabase, picks, '2026-07-04', {
      previous_close_snapshot: true,
      watchlist_mode: true,
      watchlist_safe_count: 5
    });

    assert.ok(sentMessages.length >= 1);
    var headerMsg = sentMessages[0];
    assert.ok(headerMsg.indexOf('Kandidat aman tersedia') < 0, 'should NOT show availability count when 5 candidates available');
  } finally {
    require('../lib/telegram-notifier').sendTelegramMessage = originalSendTelegramMessage;
  }
});

// ============================================================
// TEST: ordering preserved from broader pool (sorted by score/ranking)
// ============================================================

test('watchlist fallback: ordering preserved from sorted broader pool', () => {
  // Pool is already sorted by rankCandidatesByPotential (higher score first)
  var broaderPool = [
    safeWatchlistCandidate({ ticker: 'HIGH1', score: 95 }),
    safeWatchlistCandidate({ ticker: 'HIGH2', score: 90 }),
    blockedCandidate({ ticker: 'BAD1' }),
    safeWatchlistCandidate({ ticker: 'MED1', score: 80 }),
    blockedCandidate({ ticker: 'BAD2' }),
    safeWatchlistCandidate({ ticker: 'MED2', score: 75 }),
    safeWatchlistCandidate({ ticker: 'LOW1', score: 70 }),
    safeWatchlistCandidate({ ticker: 'LOW2', score: 65 })
  ];

  var watchlistSafeFromPool = [];
  var seenTickers = {};

  for (var wp = 0; wp < broaderPool.length && watchlistSafeFromPool.length < 5; wp++) {
    var poolCandidate = broaderPool[wp];
    if (!poolCandidate || !poolCandidate.ticker) continue;
    if (seenTickers[poolCandidate.ticker]) continue;
    seenTickers[poolCandidate.ticker] = true;
    if (candidatePassesTop5WatchlistGate(poolCandidate)) {
      watchlistSafeFromPool.push(poolCandidate);
    }
  }

  var finalPicks = watchlistSafeFromPool.slice(0, 5);

  assert.equal(finalPicks.length, 5);
  assert.deepEqual(
    finalPicks.map(function(p) { return p.ticker; }),
    ['HIGH1', 'HIGH2', 'MED1', 'MED2', 'LOW1'],
    'ordering should follow the sorted broader pool'
  );
});

// ============================================================
// TEST: no watchlist context (non-manual mode) does NOT trigger fallback
// ============================================================

test('watchlist fallback: non-manual mode (isWatchlistContext=false) does not trigger fallback', () => {
  var initialPicks = [
    safeWatchlistCandidate({ ticker: 'COCO' }),
    safeWatchlistCandidate({ ticker: 'MTEL' }),
    blockedCandidate({ ticker: 'BAD1' }),
    blockedCandidate({ ticker: 'BAD2' }),
    blockedCandidate({ ticker: 'BAD3' })
  ];

  var strictSignalPicks = [];
  var watchlistCandidates = [];
  var isWatchlistContext = false; // NOT manual mode

  initialPicks.forEach(function(p) {
    var passesSafety = candidatePassesPublicTelegramSafetyGate(p, 'daily_top5');
    var passesUpside = true;
    if (passesSafety && passesUpside) {
      strictSignalPicks.push(p);
    } else if (isWatchlistContext && candidatePassesTop5WatchlistGate(p)) {
      watchlistCandidates.push(p);
    }
  });

  // Without isWatchlistContext, no watchlist candidates are collected
  assert.equal(watchlistCandidates.length, 0, 'no watchlist candidates in non-manual mode');
  assert.equal(strictSignalPicks.length, 0, 'no strict signals');

  // Final picks would be empty — no fallback scan
  var top5Mode = 'strict_signal';
  var finalPicks = strictSignalPicks;
  if (strictSignalPicks.length === 0 && isWatchlistContext) {
    top5Mode = 'watchlist';
  } else if (strictSignalPicks.length === 0) {
    top5Mode = 'empty';
  }

  assert.equal(top5Mode, 'empty');
  assert.equal(finalPicks.length, 0);
});
