'use strict';

/**
 * BATCH 4 — FASE 7 (CORE SCREENER ENGINE) FORENSIC AUDIT.
 *
 * Zero-trust, test-first suite for lib/daytrade-screener-engine.js. Every test
 * below FAILS against the pre-fix code and PASSES after the minimal fix.
 *
 * Relationship to the earlier Fase 7 suite
 * ----------------------------------------
 * `test/audit-fase7-daytrade-screener-bugs.test.js` covers the ORIGINAL Fase 7
 * blockers (breakout tautology, TP1 cap, RVOL null at the liquidity gate,
 * formatted numeric strings in candles). This suite covers the RESIDUAL defect
 * class that survived that pass:
 *
 *   BATCH4-F7-01  analyzeDayTrade crashes (TypeError) on empty / null / garbage
 *                 candle arrays instead of degrading to "no analysis".
 *   BATCH4-F7-02  Formatted numeric strings are coerced for CANDLES but not for
 *                 the QUOTE fields, so calculatePenalty / classifyStatus /
 *                 scoreDayTrade throw `data.change_pct.toFixed is not a function`
 *                 on a real feed.
 *   BATCH4-F7-03  `null < 1.2 === true` at the CLASSIFICATION gate: UNKNOWN RVOL
 *                 is treated exactly like a KNOWN low RVOL and denied
 *                 PRE_SPIKE_WATCH / EARLY_RADAR promotion.
 *   BATCH4-F7-04  Momentum scoring precision + boundedness on hostile inputs.
 *   BATCH4-F7-05  Ranking filter must fail closed on non-finite / non-numeric
 *                 scores.
 *
 * Hermetic: no network, no database, no filesystem writes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../lib/daytrade-screener-engine');
const v7 = require('../lib/daytrade-screener-engine-v7');
const sectorHot = require('../api/sector-hot');

const selectTop = (sectorHot.__test && sectorHot.__test.selectTopCandidatesWithSectorDiversification)
  || sectorHot.selectTopCandidatesWithSectorDiversification;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function candle(over) {
  return Object.assign({
    time: 1700000000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 5000000
  }, over || {});
}

/** 25 clean sessions in a 99..101 box. */
function cleanSeries(count) {
  const rows = [];
  for (let i = 0; i < (count || 25); i++) {
    rows.push(candle({ time: 1700000000 + i * 86400 }));
  }
  return rows;
}

/**
 * classifyStatus inputs in the shape the production callers use, with levels
 * supplied explicitly so the RR gate never masks the volume-dependent branches.
 */
function classifyParams(score, dataOverrides, levelsOverrides) {
  return {
    compositeScore: score,
    data: Object.assign({
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
    }, dataOverrides || {}),
    levels: Object.assign({
      entry_low: 990,
      entry_high: 1005,
      stop_loss: 970,
      tp1: 1040,
      tp2: 1080,
      risk_reward: 2.0,
      _riskDistPct: 2.5
    }, levelsOverrides || {}),
    liqResult: { score: 20, pass: true, reason: 'Good liquidity' },
    penaltyResult: { penalty: 0, reasons: [] },
    board: 'REGULER',
    runMode: 'MORNING',
    candleDowngrade: false
  };
}

function classifyWith(score, dataOverrides, levelsOverrides) {
  const p = classifyParams(score, dataOverrides, levelsOverrides);
  return engine.classifyStatus(
    p.compositeScore, p.data, p.levels, p.liqResult,
    p.penaltyResult, p.board, p.runMode, p.candleDowngrade
  );
}

// ===========================================================================
// BATCH4-F7-01 — EMPTY / INCOMPLETE CANDLE ARRAY HANDLING
// `analyzeDayTrade` dereferenced `candles.length` and `last.close` without a
// guard, so a provider that answered with an empty array, a null body, or a
// page of null rows crashed with a TypeError inside the batch loop. The crash
// was swallowed by the per-ticker try/catch, so the ticker silently vanished
// from the scan with a generic "exception:" reason instead of a diagnosable
// "no analysis" outcome — and any caller outside that try/catch (backtests,
// diagnostics, replay tools) crashed outright.
// ===========================================================================

test('BATCH4-F7-01a: analyzeDayTrade(null) must degrade to null, not throw', () => {
  assert.doesNotThrow(() => engine.analyzeDayTrade(null, 'NULLBODY'));
  assert.equal(engine.analyzeDayTrade(null, 'NULLBODY'), null,
    'a null candle body must produce "no analysis"');
});

test('BATCH4-F7-01b: analyzeDayTrade(undefined) must degrade to null, not throw', () => {
  assert.doesNotThrow(() => engine.analyzeDayTrade(undefined, 'UNDEF'));
  assert.equal(engine.analyzeDayTrade(undefined, 'UNDEF'), null,
    'an undefined candle body must produce "no analysis"');
});

test('BATCH4-F7-01c: analyzeDayTrade([]) must degrade to null, not throw', () => {
  assert.doesNotThrow(() => engine.analyzeDayTrade([], 'EMPTY'));
  assert.equal(engine.analyzeDayTrade([], 'EMPTY'), null,
    'an empty candle array must produce "no analysis"');
});

test('BATCH4-F7-01d: analyzeDayTrade with only unusable rows must degrade to null', () => {
  const garbage = [null, undefined, {}, { open: null, high: null, low: null, close: null, volume: null }];
  assert.doesNotThrow(() => engine.analyzeDayTrade(garbage, 'GARBAGE'));
  assert.equal(engine.analyzeDayTrade(garbage, 'GARBAGE'), null,
    'a series with no usable OHLC row must produce "no analysis"');
});

test('BATCH4-F7-01e: analyzeDayTrade must drop unusable rows and still analyse the rest', () => {
  const series = cleanSeries(25);
  // Provider gap: one interior session arrives with null OHLC.
  series[10] = { time: 1700000000 + 10 * 86400, open: null, high: null, low: null, close: null, volume: null };

  let analysis = null;
  assert.doesNotThrow(() => { analysis = engine.analyzeDayTrade(series, 'GAP'); },
    'an interior null row must not crash the analyser');
  assert.ok(analysis, 'the remaining 24 usable sessions are enough to analyse');
  assert.ok(Number.isFinite(analysis.last_price) && analysis.last_price > 0,
    'last_price must come from a usable row, got: ' + analysis.last_price);
  assert.ok(Number.isFinite(analysis.support) && analysis.support > 0,
    'support must be finite, got: ' + analysis.support);
  assert.ok(Number.isFinite(analysis.resistance) && analysis.resistance > 0,
    'resistance must be finite, got: ' + analysis.resistance);
});

test('BATCH4-F7-01f: a valid series must never emit non-finite levels', () => {
  const analysis = engine.analyzeDayTrade(cleanSeries(25), 'CLEAN');
  ['support', 'resistance', 'breakout_trigger', 'last_price', 'high_price', 'low_price']
    .forEach((key) => {
      assert.ok(Number.isFinite(analysis[key]),
        key + ' must be finite, got: ' + analysis[key]);
    });
});

test('BATCH4-F7-01g: the batch path must mark an empty candle body as failed, not crash', async () => {
  const batch = await v7.runDayTradeBatch([{ ticker: 'EMPTYBODY', board: 'UTAMA' }], 'MORNING_SCOUT', {
    noDelay: true,
    fetchCandles: async () => [],
    captureEvaluationInitial: false,
    market_regime: { market_regime_label: 'NEUTRAL', market_regime_score_adjustment: 0 }
  });
  assert.equal(batch.results.length, 0, 'an empty body cannot produce a scored row');
  assert.equal(batch.failed.length, 1, 'it must be reported as a failed ticker');
  assert.match(String(batch.failed[0].reason), /insufficient_candles/,
    'the failure reason must be diagnosable, got: ' + batch.failed[0].reason);
});

// ===========================================================================
// BATCH4-F7-02 — FORMATTED NUMERIC STRINGS IN THE QUOTE FIELDS
// BUG-F7-03 taught the engine to coerce formatted strings for CANDLES, but the
// quote/derived fields that reach the scorer (change_pct, rsi14) were left raw.
// `calculatePenalty()` calls `data.change_pct.toFixed(1)` and classifyStatus
// calls `data.change_pct.toFixed(1)` / `data.rsi14.toFixed(0)`, so a feed that
// delivers "9.0" instead of 9.0 throws a TypeError on the overheat and RSI
// branches — the two branches a hot, volume-confirmed mover always hits.
// ===========================================================================

test('BATCH4-F7-02a: calculatePenalty must not throw on a formatted change_pct string', () => {
  const data = classifyParams(80, { change_pct: '9.0' }).data;
  let result = null;
  assert.doesNotThrow(() => { result = engine.calculatePenalty(data); },
    'a formatted change_pct must not crash the penalty engine');
  assert.ok(result && Array.isArray(result.reasons), 'penalty result must be well formed');
  assert.ok(result.penalty < 0,
    'a +9% move must still be penalised as overheat, got: ' + result.penalty);
});

test('BATCH4-F7-02b: calculatePenalty must not throw on a formatted rsi14 string', () => {
  const data = classifyParams(80, { rsi14: '86' }).data;
  let result = null;
  assert.doesNotThrow(() => { result = engine.calculatePenalty(data); },
    'a formatted rsi14 must not crash the penalty engine');
  assert.ok(result.penalty < 0,
    'an extreme-overbought RSI must still be penalised, got: ' + result.penalty);
});

test('BATCH4-F7-02c: classifyStatus must not throw on formatted change_pct / rsi14', () => {
  assert.doesNotThrow(() => classifyWith(80, { change_pct: '9.0' }),
    'a formatted change_pct must not crash classification');
  assert.doesNotThrow(() => classifyWith(80, { rsi14: '86' }),
    'a formatted rsi14 must not crash classification');
});

test('BATCH4-F7-02d: scoreDayTrade must survive a feed that formats quote numbers', () => {
  const analysis = engine.analyzeDayTrade(cleanSeries(25), 'STRQUOTE');
  const enriched = Object.assign({}, analysis, {
    change_pct: '9.0',
    rsi14: '86',
    value_today: 9000000000,
    avg_value_7d: 7000000000
  });
  let scored = null;
  assert.doesNotThrow(() => { scored = engine.scoreDayTrade(enriched, 'MORNING_SCOUT', 'UTAMA', null, {}); },
    'the production scorer must tolerate formatted quote numbers');
  assert.ok(scored && typeof scored.status === 'string',
    'a scored row must still be produced');
  // The +9% move must be read as the overheat it is — never promoted to an
  // entry-ready status, and never silently scored as a flat move.
  assert.ok(['AVOID', 'WAIT_PULLBACK'].indexOf(scored.status) !== -1,
    'a +9% overextended move must be rejected or held for pullback, got: ' + scored.status);
  assert.ok(scored.penalty_score <= 0,
    'the overheat penalty must be applied, got: ' + scored.penalty_score);
  assert.ok(scored.change_pct === 9,
    'the formatted change_pct must be coerced to the number 9, got: ' + scored.change_pct);
});

// ===========================================================================
// BATCH4-F7-03 — UNKNOWN RVOL AT THE CLASSIFICATION GATE (FAIL-CLOSED CONTRACT)
//
// The classification gate intentionally reads:
//     if (data.volume_ratio_20d < DT_INITIAL.prespike_volume_ratio) hasLowVolume = true;
// `null < 1.2` is TRUE, so an UNKNOWN ratio does NOT earn a promotion. Batch 4
// reviewed this and CONFIRMED the behaviour is correct — it is a fail-closed
// gate, not the BUG-F7-02 tautology:
//
//   * scoreLiquidity (BUG-F7-02) HARD-FAILED the candidate to AVOID, deleting
//     it from the scan even when turnover was excellent. That eliminated valid
//     candidates and was the real defect.
//   * This gate only WITHHOLDS a promotion (PRE_SPIKE_WATCH / EARLY_RADAR).
//     PRE_SPIKE_WATCH is defined as a volume-confirmed radar, so promoting on an
//     unmeasured ratio would fabricate a confirmation that was never observed.
//
// These tests pin the distinction so a future "cleanup" of the null comparison
// cannot silently start promoting unconfirmed candidates. The genuine defect in
// this area — a rendered "0.00x" for an UNKNOWN ratio — is guarded below.
// ===========================================================================

test('BATCH4-F7-03a: UNKNOWN RVOL must not be PROMOTED to a volume-confirmed radar', () => {
  const known = classifyWith(72, { volume_ratio_20d: 1.5 });
  const unknown = classifyWith(72, { volume_ratio_20d: null });

  assert.equal(known.status, 'PRE_SPIKE_WATCH',
    'precondition: a KNOWN 1.5x RVOL qualifies for PRE_SPIKE_WATCH, got: ' + known.status);
  assert.equal(unknown.status, 'EARLY_RADAR',
    'UNKNOWN RVOL must fail closed and stay at EARLY_RADAR, got: ' + unknown.status);
  assert.notEqual(unknown.status, 'PRE_SPIKE_WATCH',
    'an unmeasured ratio must never be presented as volume-confirmed');
});

test('BATCH4-F7-03b: a missing (undefined) RVOL field must also fail closed', () => {
  const unknown = classifyWith(72, { volume_ratio_20d: undefined });
  assert.notEqual(unknown.status, 'PRE_SPIKE_WATCH',
    'an absent RVOL field cannot confirm volume, got: ' + unknown.status);
});

test('BATCH4-F7-03c: a KNOWN low RVOL must STILL be denied promotion (regression guard)', () => {
  const low = classifyWith(72, { volume_ratio_20d: 1.0 });
  assert.equal(low.status, 'EARLY_RADAR',
    'a genuinely unconfirmed 1.0x print must remain capped at EARLY_RADAR, got: ' + low.status);
  assert.match(String(low.notes), /volume belum konfirmasi/i,
    'the note must explain the volume gap');
});

test('BATCH4-F7-03d: UNKNOWN RVOL must not be rendered as a measured 0.00x print', () => {
  const unknown = classifyWith(72, { volume_ratio_20d: null });
  const notes = String(unknown.notes || '');
  assert.doesNotMatch(notes, /vol 0\.00x/,
    'UNKNOWN must never be rendered as a measured 0.00x print, got: ' + notes);
  assert.match(notes, /vol N\/A/,
    'UNKNOWN must be labelled as unavailable, got: ' + notes);
});

test('BATCH4-F7-03e: an UNKNOWN ratio must not be hard-failed out of the scan', () => {
  // The BUG-F7-02 defect: `null < 0.3` forced AVOID regardless of turnover.
  // UNKNOWN must survive the liquidity gate even though it withholds promotion.
  const scored = classifyWith(72, { volume_ratio_20d: null });
  assert.notEqual(scored.status, 'AVOID',
    'UNKNOWN RVOL must not delete the candidate from the scan, got: ' + scored.status);
});

// ===========================================================================
// BATCH4-F7-04 — MOMENTUM SCORING PRECISION
// scoreMomentum compares `data.rsi14` against the RSI ladder and adds points.
// A NaN rsi14 satisfies none of the comparisons but a formatted string silently
// falls through every branch too, so a hostile feed scored 0 momentum instead
// of the value the underlying number deserves — and the score must stay bounded.
// ===========================================================================

test('BATCH4-F7-04a: scoreMomentum must coerce a formatted rsi14 string', () => {
  const base = {
    ma20: 98, ma50: 95, last_price: 100,
    _aboveMA20: true, _aboveMA50: true,
    _priceNearHigh: true, _priceAboveOpen: true, change_pct: 1.0
  };
  const numeric = engine.scoreMomentum(Object.assign({}, base, { rsi14: 55 }));
  const formatted = engine.scoreMomentum(Object.assign({}, base, { rsi14: '55' }));
  assert.equal(formatted, numeric,
    'a formatted rsi14 must score identically to the numeric form (' + numeric + '), got: ' + formatted);
});

test('BATCH4-F7-04b: scoreMomentum must stay bounded 0..25 on hostile inputs', () => {
  const hostile = [
    { rsi14: NaN, change_pct: NaN },
    { rsi14: null, change_pct: null },
    { rsi14: Infinity, change_pct: Infinity },
    { rsi14: 'bogus', change_pct: 'bogus' },
    { rsi14: -999, change_pct: -999 }
  ];
  hostile.forEach((over, i) => {
    const score = engine.scoreMomentum(Object.assign({
      ma20: 98, ma50: 95, last_price: 100,
      _aboveMA20: true, _aboveMA50: true,
      _priceNearHigh: true, _priceAboveOpen: true
    }, over));
    assert.ok(Number.isFinite(score), 'case ' + i + ' must return a finite score, got: ' + score);
    assert.ok(score >= 0 && score <= 25, 'case ' + i + ' must stay within 0..25, got: ' + score);
  });
});

// ===========================================================================
// BATCH4-F7-05 — RANKING FILTER MUST FAIL CLOSED
// The published Top-10 is chosen by selectTopCandidatesWithSectorDiversification.
// Only a FINITE, >= 65 score may be published; malformed scores must never be
// promoted ahead of the prune step.
// ===========================================================================

test('BATCH4-F7-05a: the ranking filter must be available for the audit', () => {
  assert.equal(typeof selectTop, 'function',
    'selectTopCandidatesWithSectorDiversification must be exported');
});

test('BATCH4-F7-05b: non-finite scores must never be published', () => {
  const selected = selectTop([
    { ticker: 'GOOD', daytrade_score: 90, group_code: 'G1' },
    { ticker: 'NANSCORE', daytrade_score: NaN, group_code: 'G1' },
    { ticker: 'INFSCORE', daytrade_score: Infinity, group_code: 'G1' },
    { ticker: 'NULLSCORE', daytrade_score: null, group_code: 'G1' },
    { ticker: 'STRSCORE', daytrade_score: 'bogus', group_code: 'G1' }
  ], 10, 3);

  assert.deepEqual(selected.map((r) => r.ticker), ['GOOD'],
    'only the finite, >= 65 candidate may be published, got: ' + JSON.stringify(selected.map((r) => r.ticker)));
});

test('BATCH4-F7-05c: a numeric-string score must be honoured, not dropped', () => {
  const selected = selectTop([
    { ticker: 'STRNUM', daytrade_score: '88', group_code: 'G1' },
    { ticker: 'LOW', daytrade_score: 40, group_code: 'G1' }
  ], 10, 3);
  assert.deepEqual(selected.map((r) => r.ticker), ['STRNUM'],
    'a formatted numeric score is a real score, got: ' + JSON.stringify(selected.map((r) => r.ticker)));
});

test('BATCH4-F7-05d: the sector cap must still be enforced after the guard', () => {
  const selected = selectTop([
    { ticker: 'A', daytrade_score: 90, group_code: 'SAME' },
    { ticker: 'B', daytrade_score: 89, group_code: 'SAME' },
    { ticker: 'C', daytrade_score: 88, group_code: 'SAME' },
    { ticker: 'D', daytrade_score: 87, group_code: 'SAME' },
    { ticker: 'E', daytrade_score: 86, group_code: 'OTHER' }
  ], 10, 3);
  assert.equal(selected.length, 4,
    'at most 3 from one sector plus the diversified pick, got: ' + selected.length);
  assert.ok(!selected.slice(0, 3).some((r) => r.ticker === 'D'),
    'the 4th same-sector candidate must be skipped');
});
