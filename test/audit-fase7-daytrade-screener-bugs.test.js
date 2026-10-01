'use strict';

/**
 * FASE 7 — FORENSIC AUDIT: Daytrade Screener Engine, Candidate Ranking,
 * & Intraday Filtering Pipeline.
 *
 * Root-cause investigation of the "0 sinyal sepanjang hari" incident.
 *
 * Every test below is written to FAIL against the pre-fix code and PASS after
 * the minimal fix. Real dependency mapping (not assumed file names):
 *
 *   lib/daytrade-screener-engine.js       -> analyzeDayTrade, scoreLiquidity,
 *                                            scoreDayTrade, dayTradeEligibilityReason,
 *                                            filterDayTradeUniverse, runDayTradeBatch
 *   lib/daytrade-screener-engine-v7.js    -> volume-pace recall wrapper (production engine)
 *   lib/idx-tick-normalization.js         -> deriveBreakoutConfirmation, tick sizes
 *   lib/intraday-volume-pace.js           -> RVOL pace
 *   lib/market-hours-guard.js             -> authoritative session classification
 *   api/sector-hot.js                     -> handleDayTradeScreenerRun / Read,
 *                                            selectTopCandidatesWithSectorDiversification
 *   lib/daytrade-execution-ranking.js     -> candidate ranking
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../lib/daytrade-screener-engine');
const v7 = require('../lib/daytrade-screener-engine-v7');
const idxTick = require('../lib/idx-tick-normalization');
const sectorHot = require('../api/sector-hot');

// ============================================================
// HELPERS
// ============================================================

function candles(count, opts) {
  opts = opts || {};
  const rows = [];
  for (let i = 0; i < count; i++) {
    const isLast = i === count - 1;
    const base = 100 + i * 0.1;
    rows.push({
      time: 1700000000 + i * 86400,
      open: opts.lastOpen != null && isLast ? opts.lastOpen : base,
      high: opts.lastHigh != null && isLast ? opts.lastHigh : base + 2,
      low: opts.lastLow != null && isLast ? opts.lastLow : base - 1,
      close: opts.lastClose != null && isLast ? opts.lastClose : base + 1,
      volume: opts.lastVolume != null && isLast ? opts.lastVolume : (opts.volume != null ? opts.volume : 5000000)
    });
  }
  return rows;
}

const ENTRY_READY_STATUSES = ['A_PLUS_SETUP', 'TRADE_CANDIDATE', 'READY_BREAKOUT'];

// ============================================================
// BUG-F7-01 — BREAKOUT CONFIRMATION TAUTOLOGY
// `close > resistance` was unsatisfiable because `resistance` was computed as
// max(high) over a window that CONTAINS the latest candle, and
// close <= high <= max(high) always holds. Every candidate was therefore pinned
// at BREAKOUT_WATCH/NEEDS_CLOSE_CONFIRMATION, scoreDayTrade downgraded all
// ENTRY ZONE statuses to EARLY_RADAR, and the finalize step's top_count bucket
// (which only counts A_PLUS_SETUP / TRADE_CANDIDATE / READY_BREAKOUT /
// PRE_SPIKE_WATCH) could never be non-zero => "0 sinyal sepanjang hari".
// ============================================================

// Realistic breakout series: 24 sessions consolidating under 100, then a
// breakout candle that CLOSES above the prior high while leaving overhead room.
function breakoutSeries() {
  const rows = [];
  for (let i = 0; i < 24; i++) {
    rows.push({ time: 1700000000 + i * 86400, open: 99.6, high: 100, low: 99.2, close: 99.8, volume: 4000000 });
  }
  rows.push({ time: 1700000000 + 24 * 86400, open: 100, high: 104, low: 99.5, close: 103.5, volume: 30000000 });
  return rows;
}

test('BUG-F7-01: the breakout trigger must exclude the latest candle (prior-session high)', () => {
  const analysis = engine.analyzeDayTrade(breakoutSeries(), 'BREAKOUT');

  assert.equal(analysis.resistance, 104, 'inclusive 20d resistance includes today');
  assert.ok(analysis.breakout_trigger != null,
    'analysis must expose a prior-session breakout_trigger, got: ' + analysis.breakout_trigger);
  assert.equal(analysis.breakout_trigger, 100,
    'breakout_trigger must be the PRIOR sessions high so the level is breakable, got: ' + analysis.breakout_trigger);
  assert.ok(analysis.last_price > analysis.breakout_trigger,
    'a close above the prior-session high must be representable');
});

test('BUG-F7-01: a close above the prior-session high must be BREAKOUT_CONFIRMED, not BREAKOUT_WATCH', () => {
  const analysis = engine.analyzeDayTrade(breakoutSeries(), 'BREAKOUT');

  const confirmation = idxTick.deriveBreakoutConfirmation({
    close: analysis.last_price,
    last_price: analysis.last_price,
    high_price: analysis.high_price,
    resistance: analysis.resistance,
    breakout_trigger: analysis.breakout_trigger
  });
  assert.equal(confirmation.breakout_confirmation_status, 'BREAKOUT_CONFIRMED',
    'a close above the prior-session high is a confirmed breakout, got: ' + confirmation.breakout_confirmation_status);

  const scored = engine.scoreDayTrade(analysis, 'MORNING_SCOUT', 'UTAMA', null, {});
  assert.equal(scored.breakout_confirmation_status, 'BREAKOUT_CONFIRMED',
    'scoreDayTrade must consume the prior-session trigger, got: ' + scored.breakout_confirmation_status);
});

test('BUG-F7-01b: a confirmed breakout must not have TP1 clamped to today\'s own high', () => {
  const analysis = engine.analyzeDayTrade(breakoutSeries(), 'BREAKOUT');
  const levels = engine.calculateLevels(analysis);

  assert.ok(levels.entry_high > 0 && levels.stop_loss > 0 && levels.tp1 > 0,
    'levels must be well formed: ' + JSON.stringify(levels));
  assert.ok(levels.tp1 > levels.entry_high,
    'TP1 must sit above the entry zone, got tp1=' + levels.tp1 + ' entry_high=' + levels.entry_high);
  // Reward must exceed risk for a breakout that has cleared its overhead level;
  // otherwise the RR >= 1.5 entry gate is unreachable by construction.
  assert.ok(levels.risk_reward >= 1.0,
    'a confirmed breakout must offer at least 1R of reward, got RR=' + levels.risk_reward);
});

test('BUG-F7-01: runDayTradeBatch must surface a confirmed breakout instead of pinning EARLY_RADAR', async () => {
  const batch = await v7.runDayTradeBatch([{ ticker: 'BREAKOUT', board: 'UTAMA' }], 'MORNING_SCOUT', {
    noDelay: true,
    fetchCandles: async () => breakoutSeries(),
    captureEvaluationInitial: false,
    // Supply the regime explicitly so the batch never reaches out to Yahoo
    // (keeps this audit test hermetic and offline-safe).
    market_regime: { market_regime_label: 'NEUTRAL', market_regime_score_adjustment: 0 }
  });

  assert.equal(batch.results.length, 1, 'batch must produce one scored row');
  const row = batch.results[0];
  assert.equal(row.breakout_confirmation_status, 'BREAKOUT_CONFIRMED',
    'the batch path must use the prior-session trigger too, got: ' + row.breakout_confirmation_status);
  assert.notEqual(row.status, 'EARLY_RADAR',
    'the batch path must not pin a confirmed breakout at EARLY_RADAR, got: ' + row.status);
});

// ============================================================
// BUG-F7-02 — UNKNOWN RVOL TREATED AS "VERY LOW VOLUME"
// scoreLiquidity compared `data.volume_ratio_20d < 0.3` without a null guard.
// In JS `null < 0.3 === true`, so every candidate whose 20-day average volume
// is unavailable (avg_volume_20d null => volume_ratio_20d null) was hard-failed
// at the FIRST gate with reason "Volume sangat rendah (ratio<0.3)" and forced to
// status AVOID regardless of turnover.
// ============================================================

test('BUG-F7-02: UNKNOWN (null) volume ratio must NOT be hard-failed as "very low volume"', () => {
  const result = engine.scoreLiquidity({
    value_today: 5_000_000_000,
    avg_value_7d: 3_000_000_000,
    volume_ratio_20d: null
  });

  assert.equal(result.pass, true,
    'high-turnover candidate with UNKNOWN RVOL must not be dropped at the first gate, reason: ' + result.reason);
  assert.equal(/sangat rendah/i.test(String(result.reason || '')), false,
    'UNKNOWN RVOL must not be reported as "volume sangat rendah"');
  assert.ok(result.score > 0, 'a high-turnover candidate must still earn liquidity score');
});

test('BUG-F7-02: a KNOWN low volume ratio (<0.3) must still hard-fail', () => {
  const result = engine.scoreLiquidity({
    value_today: 5_000_000_000,
    avg_value_7d: 3_000_000_000,
    volume_ratio_20d: 0.2
  });
  assert.equal(result.pass, false, 'a genuinely dormant stock must still be dropped');
  assert.match(result.reason, /sangat rendah/i);
});

test('BUG-F7-02: analyzeDayTrade -> scoreDayTrade must not force AVOID when RVOL is unavailable', () => {
  // Only 19 sessions exist => the 20D average cannot be computed => ratio unknown.
  const series = [];
  for (let i = 0; i < 19; i++) {
    series.push({ time: 1700000000 + i * 86400, open: 100, high: 102, low: 99, close: 101, volume: 5000000 });
  }
  const analysis = engine.analyzeDayTrade(series, 'NORATIO');
  assert.equal(analysis.volume_ratio_20d, null, 'precondition: ratio must be unknown');

  // The live feed supplies turnover independently of the candle history.
  const enriched = Object.assign({}, analysis, { value_today: 9000000000, avg_value_7d: 7000000000 });
  const scored = engine.scoreDayTrade(enriched, 'MORNING_SCOUT', 'UTAMA', null, {});
  assert.notEqual(scored.status, 'AVOID',
    'a high-turnover stock with unknown RVOL must not be auto-AVOID, got: ' + scored.status);
  assert.ok(scored.liquidity_score > 0, 'liquidity score must be earned on turnover, got: ' + scored.liquidity_score);
});

test('BUG-F7-02: v7 volume-pace recall must not zero the liquidity score on unknown ratio', () => {
  const series = candles(25, { volume: 0, lastVolume: 80000000 });
  const row = {
    ticker: 'WAKEUP',
    daytrade_score: 78,
    status: 'TRADE_CANDIDATE',
    liquidity_score: 10,
    prespike_score: 20,
    momentum_score: 18,
    penalty_score: 0,
    last_price: 102.4,
    stop_loss: 95,
    tp1: 130,
    candle_score: 0,
    board: 'UTAMA',
    entry_low: 100,
    entry_high: 101
  };
  const recalled = v7.applyVolumePaceRecall(row, series, {
    sampleDate: '2026-09-23',
    scheduledTime: '10:00',
    runMode: 'MORNING_SCOUT'
  });
  assert.notEqual(recalled.liquidity_score, 0,
    'volume-pace recall must not zero out liquidity when RVOL is unknown');
});

// ============================================================
// BUG-F7-03 — NUMERIC STRINGS / THOUSAND SEPARATORS
// Market-data feeds deliver volume/price/value as formatted strings
// ("5.000.000" id-ID, "5,000,000" en-US). Number() returns NaN for both, and
// deriveDataQualityStatus rejects non-finite volume as INVALID_CANDLE, which
// cascades to AVOID and silently removes the ticker from the scan.
// ============================================================

test('BUG-F7-03: id-ID formatted volume string ("5.000.000") must be parsed, not flagged INVALID_CANDLE', () => {
  const series = candles(25, { lastVolume: '5.000.000' });
  const analysis = engine.analyzeDayTrade(series, 'STRVOL');

  assert.equal(analysis.data_quality_status, 'OK',
    'a dotted-thousands volume string is valid data, got: ' + analysis.data_quality_status);
  assert.equal(analysis.volume_today, 5000000, 'volume_today must be coerced to 5000000');
  assert.equal(analysis.value_today > 0, true, 'value_today must be recomputed from the coerced volume');
});

test('BUG-F7-03: en-US formatted volume string ("5,000,000") must be parsed', () => {
  const series = candles(25, { lastVolume: '5,000,000' });
  const analysis = engine.analyzeDayTrade(series, 'STRVOL2');

  assert.equal(analysis.data_quality_status, 'OK', 'got: ' + analysis.data_quality_status);
  assert.equal(analysis.volume_today, 5000000, 'volume_today must be coerced to 5000000');
});

test('BUG-F7-03: a genuinely invalid volume must still be rejected', () => {
  const series = candles(25, { lastVolume: 'not-a-number' });
  const analysis = engine.analyzeDayTrade(series, 'BADVOL');
  assert.equal(analysis.data_quality_status, 'INVALID_CANDLE',
    'non-numeric volume must still be rejected as invalid data');
});

// ============================================================
// BUG-F7-04 — FCA / BOOLEAN-STRING PARSING IN TICK SIZE
// isAkselerasiOrFca used `isFca === true`. Supabase/PostgREST delivers boolean
// columns as 'true'/'false' strings and some callers pass 1/0, so a genuine FCA
// ticker silently received the WRONG (larger) tick size, producing off-tick
// entry/SL/TP levels that later fail validateTradingPlanSanity.
// The inverse must also hold: the string 'false' must NOT be read as FCA.
// ============================================================

test('BUG-F7-04: string/number FCA flags must be honoured (Rp1 tick), without misreading "false"', () => {
  // Rp1 tick is the FCA/Akselerasi rule; Rp5 is the regular tier for price 1500.
  assert.equal(idxTick.getIdxTickSize(1500, 'UTAMA', 'true', 'ABCD'), 1,
    "string 'true' must be treated as FCA");
  assert.equal(idxTick.getIdxTickSize(1500, 'UTAMA', '1', 'ABCD'), 1,
    "string '1' must be treated as FCA");
  assert.equal(idxTick.getIdxTickSize(1500, 'UTAMA', 1, 'ABCD'), 1,
    'number 1 must be treated as FCA');
  assert.equal(idxTick.getIdxTickSize(1500, 'UTAMA', true, 'ABCD'), 1,
    'boolean true must keep working');

  // Negative cases: a non-FCA ticker must keep the regular Rp5 tick.
  assert.equal(idxTick.getIdxTickSize(1500, 'UTAMA', 'false', 'ABCD'), 5,
    "string 'false' must NOT be treated as FCA");
  assert.equal(idxTick.getIdxTickSize(1500, 'UTAMA', 0, 'ABCD'), 5,
    'number 0 must NOT be treated as FCA');
  assert.equal(idxTick.getIdxTickSize(1500, 'UTAMA', undefined, 'ABCD'), 5,
    'undefined must NOT be treated as FCA');
});

test('BUG-F7-04: FCA board names in any case must be treated as FCA', () => {
  assert.equal(idxTick.getIdxTickSize(1500, 'papan pemantauan khusus', undefined, 'ABCD'), 1,
    'lowercase FCA board name must be recognised');
  assert.equal(idxTick.getIdxTickSize(1500, 'PEMANTAUAN KHUSUS', undefined, 'ABCD'), 1,
    'uppercase FCA board name must be recognised');
});

// ============================================================
// BUG-F7-05 — STRING-FORMATTED TURNOVER DROPS VALID TICKERS AT UNIVERSE GATE
// dayTradeEligibilityReason used raw `Number(...)` on value/frequency. A
// formatted string such as "1.234.567.890" yields NaN, so the row was rejected
// as 'liquidity_unverified' — a valid, liquid stock silently removed BEFORE any
// scanning happened.
// ============================================================

test('BUG-F7-05: formatted turnover/frequency strings must not be rejected as liquidity_unverified', () => {
  const reason = engine.dayTradeEligibilityReason({
    ticker: 'LIQUID',
    board: 'UTAMA',
    value: '1.234.567.890',
    freq: '12.345'
  }, { requireLiquidity: true });

  assert.equal(reason, null,
    'a liquid stock with formatted numbers must pass eligibility, got: ' + reason);
});

test('BUG-F7-05: formatted price strings must satisfy requirePrice', () => {
  const reason = engine.dayTradeEligibilityReason({
    ticker: 'LIQUID',
    board: 'UTAMA',
    last_price: '1.250',
    valuasi: 1,
    freq: 1
  }, { requirePrice: true, requireLiquidity: true });

  assert.equal(reason, null, 'formatted price must be parseable, got: ' + reason);
});

test('BUG-F7-05: genuinely empty turnover must still be rejected', () => {
  assert.equal(
    engine.dayTradeEligibilityReason({ ticker: 'X', board: 'UTAMA', value: '', freq: '' }, { requireLiquidity: true }),
    'liquidity_unverified'
  );
  assert.equal(
    engine.dayTradeEligibilityReason({ ticker: 'X', board: 'UTAMA', value: 'abc', freq: 'abc' }, { requireLiquidity: true }),
    'liquidity_unverified'
  );
});

// ============================================================
// BUG-F7-06 — NaN / NULL SCORE BYPASSES THE >=65 PUBLISH GATE
// selectTopCandidatesWithSectorDiversification guarded with
// `score != null && Number.isFinite(score) && score < 65`. When the score was
// null/NaN/non-numeric the guard was skipped entirely, so malformed rows were
// promoted into the published Top-10 ahead of the trim/prune step.
// ============================================================

test('BUG-F7-06: null / NaN / non-numeric scores must NOT be published in the Top-10', () => {
  const selectTop = sectorHot.selectTopCandidatesWithSectorDiversification;
  assert.equal(typeof selectTop, 'function', 'selectTopCandidatesWithSectorDiversification must be exported');

  const selected = selectTop([
    { ticker: 'GOOD1', daytrade_score: 90, sector: 'A' },
    { ticker: 'GOOD2', daytrade_score: 88, sector: 'B' },
    { ticker: 'JUNK_NULL', daytrade_score: null, sector: 'C' },
    { ticker: 'JUNK_NAN', daytrade_score: NaN, sector: 'D' },
    { ticker: 'JUNK_STR', daytrade_score: 'not-a-number', sector: 'E' },
    { ticker: 'JUNK_LOW', daytrade_score: 12, sector: 'F' }
  ], 10, 3);

  const tickers = selected.map((r) => r.ticker);
  assert.deepEqual(tickers, ['GOOD1', 'GOOD2'],
    'only finite scores >= 65 may be published, got: ' + tickers.join(','));
});

test('BUG-F7-06: a candidate with a missing score field must not be published', () => {
  const selectTop = sectorHot.selectTopCandidatesWithSectorDiversification;
  const selected = selectTop([
    { ticker: 'GOOD1', daytrade_score: 90, sector: 'A' },
    { ticker: 'NO_SCORE', sector: 'B' }
  ], 10, 3);
  assert.deepEqual(selected.map((r) => r.ticker), ['GOOD1']);
});

// ============================================================
// BUG-F7-07 — PAUSED MARKET BATCH WIPES THE PUBLISHED SET
// runDayTradeBatch returns { results: [], skipped: true, status: 'paused' }
// when the market session is BREAK/CLOSED (frozen order book). The production
// caller did not inspect `skipped`, so it computed 0 passed results and ran
// finalizeDtScreener, which TRIMS daytrade_screener_latest down to the top-10 of
// an empty set — deleting the day's already-published candidates.
// ============================================================

test('BUG-F7-07: a paused (BREAK/CLOSED) batch must be reported as skipped, not as an empty scan', async () => {
  // 2026-09-23 is a Wednesday; 12:15 WIB falls inside the lunch break.
  const breakNow = '2026-09-23T05:15:00.000Z'; // 12:15 WIB
  const batch = await engine.runDayTradeBatch(
    [{ ticker: 'AAA', board: 'UTAMA' }],
    'MIDDAY_CHECK',
    { now: breakNow, noDelay: true, fetchCandles: async () => { throw new Error('must not fetch during break'); } }
  );

  assert.equal(batch.skipped, true, 'a break/closed batch must be flagged skipped');
  assert.equal(batch.status, 'paused');
  assert.equal(batch.session, 'BREAK');
  assert.deepEqual(batch.results, []);
});

test('BUG-F7-07: the run handler must expose a publish guard that honours the paused batch', () => {
  const guard = sectorHot.__test && sectorHot.__test.shouldSkipDayTradePublish;
  assert.equal(typeof guard, 'function',
    'api/sector-hot must export shouldSkipDayTradePublish so a paused batch cannot wipe published rows');

  assert.equal(guard({ skipped: true, status: 'paused', results: [] }), true,
    'a paused batch must block finalize/publish');
  assert.equal(guard({ skipped: false, status: 'running', results: [] }), false,
    'a normal empty batch must still be allowed to finalize');
  assert.equal(guard(null), false, 'missing batch result must not block');
});

// ============================================================
// REGRESSION GUARDS — the fixes must not break the safety rails.
// ============================================================

test('FASE7 regression: live/unclosed bar above resistance stays NEEDS_CLOSE_CONFIRMATION', () => {
  const result = idxTick.deriveBreakoutConfirmation({
    close: 101, high_price: 102, resistance: 100, breakout_trigger: 100,
    price_source: 'vps_bridge_live'
  });
  assert.equal(result.breakout_confirmation_status, 'NEEDS_CLOSE_CONFIRMATION');
});

test('FASE7 regression: confirmed close above the prior-session trigger is BREAKOUT_CONFIRMED', () => {
  const result = idxTick.deriveBreakoutConfirmation({
    close: 101, high_price: 102, resistance: 105, breakout_trigger: 100,
    price_source: 'yahoo_chart_1d_close'
  });
  assert.equal(result.breakout_confirmation_status, 'BREAKOUT_CONFIRMED');
});

test('FASE7 regression: a wick above the trigger that closes back below stays FALSE_BREAKOUT_RISK', () => {
  const result = idxTick.deriveBreakoutConfirmation({
    close: 99, high_price: 102, resistance: 105, breakout_trigger: 100,
    price_source: 'yahoo_chart_1d_close'
  });
  assert.equal(result.breakout_confirmation_status, 'FALSE_BREAKOUT_RISK');
  assert.equal(result.false_breakout_risk, true);
});

test('FASE7 regression: genuine illiquidity still hard-fails the liquidity gate', () => {
  const result = engine.scoreLiquidity({
    value_today: 100000,
    avg_value_7d: 50000,
    volume_ratio_20d: 1.4
  });
  assert.equal(result.pass, false, 'tiny turnover must still be rejected');
});

test('FASE7 regression: FCA / restricted boards are still excluded from the daytrade universe', () => {
  ['PAPAN PEMANTAUAN KHUSUS', 'PEMANTAUAN KHUSUS', 'FCA'].forEach((board) => {
    assert.equal(
      engine.dayTradeEligibilityReason({ ticker: 'X', board }, {}),
      'restricted_board_or_status',
      'board must stay restricted: ' + board
    );
  });
});

test('FASE7 regression: tick-size tiers for regular boards are unchanged', () => {
  assert.equal(idxTick.getIdxTickSize(150, 'UTAMA', undefined, 'X'), 1);
  assert.equal(idxTick.getIdxTickSize(350, 'UTAMA', undefined, 'X'), 2);
  assert.equal(idxTick.getIdxTickSize(1500, 'UTAMA', undefined, 'X'), 5);
  assert.equal(idxTick.getIdxTickSize(3000, 'UTAMA', undefined, 'X'), 10);
  assert.equal(idxTick.getIdxTickSize(7000, 'UTAMA', undefined, 'X'), 25);
});

test('FASE7 regression: execution ranking keeps blocked candidates below executable ones', () => {
  const ranking = require('../lib/daytrade-execution-ranking');
  const sorted = ranking.sortDayTradeByExecution([
    { ticker: 'BLOCKED', daytrade_score: 95, risk_reward: 0.5, status: 'AVOID', last_price: 100, entry_low: 99, entry_high: 100 },
    { ticker: 'EXEC', daytrade_score: 70, risk_reward: 2.0, status: 'TRADE_CANDIDATE', last_price: 99, entry_low: 99, entry_high: 100 }
  ]);
  assert.equal(sorted[0].ticker, 'EXEC', 'a blocked high-score row must not outrank an executable one');
});
