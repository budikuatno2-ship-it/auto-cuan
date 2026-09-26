'use strict';

/**
 * AUDIT FASE 8 — Swing Screener Engine, Non-Konglo Filtering Logic,
 * & Multi-Day Swing Watchlist.
 *
 * ZERO-TRUST FORENSIC SUITE — each test below reproduces a REAL defect that was
 * confirmed by reading the production code path AND by empirical reproduction
 * (randomised OHLC trials / live helper invocation) before any fix was applied.
 *
 * Findings covered:
 *   BUG-F8-01  Tautologi support  — `_belowSupport` tak pernah true (breakdown blind)
 *   BUG-F8-02  Tautologi resistance — `close > resistance` mustahil → BREAKOUT_CONFIRMED unreachable
 *   BUG-F8-03  Window NK 60 hari → MA50 selalu null → 100% "Di bawah MA50"
 *   BUG-F8-04  is_fca string 'false' dibaca sebagai FCA di calculateRiskLabel
 *   BUG-F8-05  Ticker/board FCA tidak diteruskan ke normalizeLevelsToIdxTicks
 *   BUG-F8-06  select('calculated_at') pada swing_screener_non_konglo_latest (kolom tak ada)
 *   BUG-F8-07  select('run_date') pada swing_screener_meta (kolom tak ada)
 *   BUG-F8-08  select('last_staging_write_count') pada swing_screener_non_konglo_meta (kolom tak ada)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sectorHot = require('../api/sector-hot');
const T = sectorHot.__test || sectorHot;
const idxTick = require('../lib/idx-tick-normalization');
const swingEngine = require('../lib/swing-screener-engine');

const ROOT = path.join(__dirname, '..');
const SECTOR_HOT_SRC = fs.readFileSync(path.join(ROOT, 'api', 'sector-hot.js'), 'utf8');
const WATCHLIST_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'user-watchlist-service.js'), 'utf8');
const NK_MIGRATION = fs.readFileSync(path.join(ROOT, 'supabase', 'swing-screener-non-konglo.sql'), 'utf8');
const KONGLO_MIGRATION = fs.readFileSync(path.join(ROOT, 'supabase', 'swing-screener-migration.sql'), 'utf8');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function bar(open, high, low, close, volume) {
  return { open: open, high: high, low: low, close: close, volume: volume == null ? 1000000 : volume };
}

/** 19 calm bars trading inside 900-1000, then a decisive breakdown bar. */
function breakdownCandles() {
  const candles = [];
  for (let i = 0; i < 19; i++) candles.push(bar(950, 1000, 900, 950));
  candles.push(bar(900, 910, 700, 710)); // today: crashes far below every prior low
  return candles;
}

/** 19 calm bars capped at 1000, then a decisive breakout closing at the high. */
function breakoutCandles() {
  const candles = [];
  for (let i = 0; i < 19; i++) candles.push(bar(950, 1000, 900, 950));
  candles.push(bar(1000, 1200, 995, 1200)); // today: closes at a new high
  return candles;
}

/** Deterministic pseudo-random OHLC generator (no external deps). */
function pseudoRandomCandles(count, seed) {
  let s = seed || 123456789;
  const rnd = function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const out = [];
  for (let i = 0; i < count; i++) {
    const close = 100 + rnd() * 900;
    const open = close * (0.97 + rnd() * 0.06);
    const high = Math.max(open, close) * (1 + rnd() * 0.03);
    const low = Math.min(open, close) * (1 - rnd() * 0.03);
    out.push(bar(open, high, low, close));
  }
  return out;
}

function sqlColumns(tableName, sqlText) {
  const re = new RegExp('CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:public\\.)?' + tableName + '\\s*\\(([\\s\\S]*?)\\)\\s*;', 'i');
  const m = sqlText.match(re);
  if (!m) return null;
  const cols = [];
  m[1].split('\n').forEach(function (line) {
    const t = line.trim();
    if (!t || t.startsWith('--')) return;
    if (/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(t)) return;
    const cm = t.match(/^"?([a-z0-9_]+)"?\s+[A-Za-z]/i);
    if (cm) cols.push(cm[1].toLowerCase());
  });
  return cols;
}

// ===========================================================================
// BUG-F8-01 — TAUTOLOGI SUPPORT (breakdown tak pernah terdeteksi)
// ===========================================================================

test('BUG-F8-01a: calculateIndicators support must EXCLUDE the running bar (breakdown detectable)', () => {
  assert.equal(typeof T.calculateIndicators, 'function',
    'calculateIndicators must be exported for the swing audit');
  const analysis = T.calculateIndicators(breakdownCandles());
  const lastClose = 710;
  assert.equal(analysis.last_price, 710);
  // Prior support (bars 1..19) is 900. Today's low (700) must NOT become support.
  assert.equal(analysis.support, 900,
    'support must be the PRIOR-bar support (900), not today\'s own low (700)');
  assert.equal(analysis._belowSupport, true,
    'a close at 710 under prior support 900 MUST register as a breakdown');
});

test('BUG-F8-01b: _belowSupport is reachable — not a mathematical tautology', () => {
  let detected = 0;
  for (let t = 0; t < 400; t++) {
    const candles = pseudoRandomCandles(25, 1000 + t);
    // force a genuine breakdown on the final bar
    const last = candles[candles.length - 1];
    const priorLow = Math.min.apply(null, candles.slice(0, -1).map(function (c) { return c.low; }));
    last.low = priorLow * 0.90;
    last.close = priorLow * 0.92;
    last.open = priorLow * 0.95;
    last.high = priorLow * 0.96;
    const a = T.calculateIndicators(candles);
    if (a._belowSupport === true) detected++;
  }
  assert.equal(detected, 400,
    'every genuine breakdown must be detected; got ' + detected + '/400');
});

test('BUG-F8-01c: Non-Konglo support/resistance window must exclude the running bar', () => {
  // The NK scorer derives support/resistance from its own slice. Guard that the
  // window is anchored BEFORE the last bar (slice(-21, -1)) rather than a plain
  // slice(-20) which would include today's own high/low.
  const nkStart = SECTOR_HOT_SRC.indexOf('async function fetchNkQuoteData');
  assert.ok(nkStart > 0, 'fetchNkQuoteData must exist');
  const nkEnd = SECTOR_HOT_SRC.indexOf('function applyNkHardFilters', nkStart);
  const nkBlock = SECTOR_HOT_SRC.slice(nkStart, nkEnd);

  const anchor = nkBlock.match(/const priorBars = validDays\.slice\((-?\d+),\s*(-?\d+)\);/);
  assert.ok(anchor, 'NK must anchor an explicit prior-bar window for support/resistance');
  assert.equal(Number(anchor[1]), -21, 'the prior window must start one bar before the 20-bar lookback');
  assert.equal(Number(anchor[2]), -1, 'the prior window must END before the running bar');

  assert.match(nkBlock, /const last20Lows = srWindow\.map/,
    'support must be computed from the prior-bar window, not the raw last-20 slice');
  assert.match(nkBlock, /const last20Highs = srWindow\.map/,
    'resistance must be computed from the prior-bar window, not the raw last-20 slice');
});

// ===========================================================================
// BUG-F8-02 — TAUTOLOGI RESISTANCE (BREAKOUT_CONFIRMED unreachable)
// ===========================================================================

test('BUG-F8-02a: calculateIndicators resistance must EXCLUDE the running bar', () => {
  const analysis = T.calculateIndicators(breakoutCandles());
  assert.equal(analysis.last_price, 1200);
  // Prior resistance (bars 1..19) is 1000. Today's high (1200) must NOT cap it.
  assert.equal(analysis.resistance, 1000,
    'resistance must be the PRIOR-bar ceiling (1000), not today\'s own high (1200)');
  assert.ok(analysis.last_price > analysis.resistance,
    'a breakout close must be strictly ABOVE the stored resistance');
});

test('BUG-F8-02b: deriveBreakoutConfirmation reaches BREAKOUT_CONFIRMED on a real breakout', () => {
  const analysis = T.calculateIndicators(breakoutCandles());
  const confirmation = idxTick.deriveBreakoutConfirmation({
    last_price: analysis.last_price,
    close: analysis.last_price,
    high_price: 1200,
    resistance: analysis.resistance,
    volume_ratio_avg20: 2.5,
    candle_closed: true
  });
  assert.equal(confirmation.breakout_confirmation_status, 'BREAKOUT_CONFIRMED',
    'a confirmed close above prior resistance MUST be able to produce BREAKOUT_CONFIRMED');
});

test('BUG-F8-02c: breakout confirmation is reachable across randomised breakouts', () => {
  let confirmed = 0;
  for (let t = 0; t < 400; t++) {
    const candles = pseudoRandomCandles(25, 5000 + t);
    const priorHigh = Math.max.apply(null, candles.slice(0, -1).map(function (c) { return c.high; }));
    const last = candles[candles.length - 1];
    last.low = priorHigh * 0.99;
    last.open = priorHigh * 1.01;
    last.close = priorHigh * 1.06;
    last.high = priorHigh * 1.07;
    const a = T.calculateIndicators(candles);
    const bc = idxTick.deriveBreakoutConfirmation({
      last_price: a.last_price,
      close: a.last_price,
      high_price: priorHigh * 1.07,
      resistance: a.resistance,
      volume_ratio_avg20: 2.0,
      candle_closed: true
    });
    if (bc.breakout_confirmation_status === 'BREAKOUT_CONFIRMED') confirmed++;
  }
  assert.equal(confirmed, 400,
    'every confirmed breakout must be able to trigger BREAKOUT_CONFIRMED; got ' + confirmed + '/400');
});

// ===========================================================================
// BUG-F8-03 — WINDOW NK 60 HARI → MA50 SELALU NULL
// ===========================================================================

test('BUG-F8-03a: a 60-calendar-day window cannot supply the 50 bars MA50 needs', () => {
  const tradingBars = Math.floor((60 / 7) * 5); // ~42 bars before IDX holidays
  assert.ok(tradingBars < 50,
    '60 calendar days yield ~' + tradingBars + ' bars — structurally below the MA50 requirement');
  assert.equal(T.nkCalcMA(new Array(tradingBars).fill(1000), 50), null,
    'nkCalcMA must return null when fewer than `period` bars exist');
});

test('BUG-F8-03b: Non-Konglo quote window must request enough history for MA50', () => {
  const nkStart = SECTOR_HOT_SRC.indexOf('async function fetchNkQuoteData');
  const nkEnd = SECTOR_HOT_SRC.indexOf('function applyNkHardFilters', nkStart);
  const nkBlock = SECTOR_HOT_SRC.slice(nkStart, nkEnd);
  const m = nkBlock.match(/now\s*-\s*(\d+)\s*\*\s*86400/);
  assert.ok(m, 'the NK lookback expression must be present');
  const days = Number(m[1]);
  const bars = Math.floor((days / 7) * 5);
  assert.ok(bars >= 60,
    'NK window must yield >= 60 trading bars so MA50 is computable (got ' + days +
    ' calendar days ≈ ' + bars + ' bars)');
});

test('BUG-F8-03c: a null MA50 must not hard-fail Swing Ready for every Non-Konglo candidate', () => {
  const src = SECTOR_HOT_SRC;
  assert.ok(
    !/if \(!\(q\.ma50 && q\.lastPrice >= q\.ma50\)\) \{ passesAllHardFilters = false; failReasons\.push\('Di bawah MA50'\); \}/.test(src),
    'a structurally-null MA50 must not be treated as "price below MA50"'
  );
});

// ===========================================================================
// BUG-F8-04 — is_fca STRING 'false' DIBACA SEBAGAI FCA
// ===========================================================================

test("BUG-F8-04a: calculateRiskLabel must not treat is_fca='false' as FCA", () => {
  const base = { risk_reward: 2.0, mode: 'swing', board: 'UTAMA', volume_ratio_20d: 1.2 };
  const asStringFalse = idxTick.calculateRiskLabel(Object.assign({}, base, { is_fca: 'false' }));
  const asBooleanFalse = idxTick.calculateRiskLabel(Object.assign({}, base, { is_fca: false }));
  assert.equal(asStringFalse.risk_score, asBooleanFalse.risk_score,
    "is_fca='false' must score identically to is_fca=false");
  assert.equal(asStringFalse.risk_notes.join('|').indexOf('FCA'), -1,
    "is_fca='false' must NOT be labelled FCA/Pemantauan Khusus");
});

test("BUG-F8-04b: calculateRiskLabel must treat is_fca='true' and 1 as FCA", () => {
  const base = { risk_reward: 2.0, mode: 'swing', board: 'UTAMA', volume_ratio_20d: 1.2 };
  const asTrue = idxTick.calculateRiskLabel(Object.assign({}, base, { is_fca: true }));
  const asStringTrue = idxTick.calculateRiskLabel(Object.assign({}, base, { is_fca: 'true' }));
  const asOne = idxTick.calculateRiskLabel(Object.assign({}, base, { is_fca: 1 }));
  assert.equal(asStringTrue.risk_score, asTrue.risk_score, "is_fca='true' must equal is_fca=true");
  assert.equal(asOne.risk_score, asTrue.risk_score, 'is_fca=1 must equal is_fca=true');
  assert.ok(asTrue.risk_notes.join('|').indexOf('FCA') >= 0, 'genuine FCA must be labelled');
});

test('BUG-F8-04c: the FCA truthiness helper is exported and used by the risk label', () => {
  assert.equal(typeof idxTick.isExplicitTrueFlag, 'function',
    'isExplicitTrueFlag must be exported so every FCA gate shares one truthiness rule');
  assert.equal(idxTick.isExplicitTrueFlag('false'), false);
  assert.equal(idxTick.isExplicitTrueFlag('true'), true);
  assert.equal(idxTick.isExplicitTrueFlag(1), true);
  assert.equal(idxTick.isExplicitTrueFlag(0), false);
});

// ===========================================================================
// BUG-F8-05 — FCA TICKER TIDAK DITERUSKAN KE normalizeLevelsToIdxTicks
// ===========================================================================

test('BUG-F8-05a: normalizeLevelsToIdxTicks honours a known FCA ticker (Rp1 tick)', () => {
  const levels = { entry_low: 301, entry_high: 305, stop_loss: 290, tp1: 320, tp2: 340, risk_reward: 2.0 };
  const withoutTicker = idxTick.normalizeLevelsToIdxTicks(Object.assign({}, levels), { mode: 'swing' });
  const withTicker = idxTick.normalizeLevelsToIdxTicks(Object.assign({}, levels, { ticker: 'LUCK' }), { mode: 'swing' });
  // LUCK trades on a uniform Rp1 tick, so 301 must survive verbatim.
  assert.equal(withTicker.entry_low, 301,
    'an FCA ticker must keep Rp1 granularity (301 stays 301)');
  assert.notEqual(withoutTicker.entry_low, withTicker.entry_low,
    'dropping the ticker silently snaps the level onto the wrong tick grid');
});

test('BUG-F8-05b: the Konglo screener must pass ticker/board into tick normalization', () => {
  const idx = SECTOR_HOT_SRC.indexOf('var _tickResult = idxTick.normalizeLevelsToIdxTicks(');
  assert.ok(idx > 0, 'Konglo tick normalization call must exist');
  const block = SECTOR_HOT_SRC.slice(idx, idx + 400);
  assert.match(block, /ticker\s*:/,
    'Konglo tick normalization must receive the ticker so FCA names use Rp1 ticks');
});

test('BUG-F8-05c: the Non-Konglo screener must pass ticker/board into tick normalization', () => {
  const idx = SECTOR_HOT_SRC.indexOf('var _nkTickResult = idxTick.normalizeLevelsToIdxTicks(');
  assert.ok(idx > 0, 'Non-Konglo tick normalization call must exist');
  const block = SECTOR_HOT_SRC.slice(idx, idx + 400);
  assert.match(block, /ticker\s*:/,
    'Non-Konglo tick normalization must receive the ticker so FCA names use Rp1 ticks');
});

// ===========================================================================
// BUG-F8-06 — select('calculated_at') PADA swing_screener_non_konglo_latest
// ===========================================================================

test('BUG-F8-06a: swing_screener_non_konglo_latest has no calculated_at column', () => {
  const cols = sqlColumns('swing_screener_non_konglo_latest', NK_MIGRATION);
  assert.ok(cols, 'the Non-Konglo latest table must be declared in the migration');
  assert.equal(cols.indexOf('calculated_at'), -1,
    'calculated_at does not exist on swing_screener_non_konglo_latest');
  assert.ok(cols.indexOf('published_at') >= 0, 'published_at is the real recency column');
});

test('BUG-F8-06b: no PostgREST select targets calculated_at on the Non-Konglo latest table', () => {
  const files = { 'api/sector-hot.js': SECTOR_HOT_SRC, 'lib/user-watchlist-service.js': WATCHLIST_SRC };
  Object.keys(files).forEach(function (name) {
    const src = files[name];
    const re = /from\('swing_screener_non_konglo_latest'\)\s*\.select\('([^']*)'\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const select = m[1];
      if (select.trim() === '*') continue;
      assert.equal(select.indexOf('calculated_at'), -1,
        name + " selects calculated_at from swing_screener_non_konglo_latest — the column does not exist");
    }
  });
});

// ===========================================================================
// BUG-F8-07 — select('run_date') PADA swing_screener_meta
// ===========================================================================

test('BUG-F8-07a: swing_screener_meta has no run_date column', () => {
  const cols = sqlColumns('swing_screener_meta', KONGLO_MIGRATION);
  assert.ok(cols, 'swing_screener_meta must be declared in the migration');
  assert.equal(cols.indexOf('run_date'), -1,
    'run_date does not exist on swing_screener_meta');
});

test('BUG-F8-07b: no PostgREST select targets run_date on swing_screener_meta', () => {
  const re = /from\('swing_screener_meta'\)\s*\.select\('([^']*)'\)/g;
  let m;
  while ((m = re.exec(SECTOR_HOT_SRC)) !== null) {
    const select = m[1];
    if (select.trim() === '*') continue;
    assert.equal(select.indexOf('run_date'), -1,
      "swing_screener_meta select must not request run_date — the column does not exist");
  }
});

// ===========================================================================
// BUG-F8-08 — select('last_staging_write_count') KOLOM TAK ADA
// ===========================================================================

test('BUG-F8-08a: swing_screener_non_konglo_meta has no last_staging_write_count column', () => {
  const cols = sqlColumns('swing_screener_non_konglo_meta', NK_MIGRATION);
  assert.ok(cols, 'swing_screener_non_konglo_meta must be declared in the migration');
  assert.equal(cols.indexOf('last_staging_write_count'), -1,
    'last_staging_write_count does not exist on swing_screener_non_konglo_meta');
});

test('BUG-F8-08b: no PostgREST select targets last_staging_write_count', () => {
  const re = /from\('swing_screener_non_konglo_meta'\)\s*\.select\('([^']*)'\)/g;
  let m;
  while ((m = re.exec(SECTOR_HOT_SRC)) !== null) {
    const select = m[1];
    if (select.trim() === '*') continue;
    assert.equal(select.indexOf('last_staging_write_count'), -1,
      'selecting a non-existent column makes PostgREST fail the whole read');
  }
});

// ===========================================================================
// INTEGRASI FASE SEBELUMNYA
// ===========================================================================

test('Fase 7 carry-over: the shared FCA truthiness helper still accepts 1/0 and booleans', () => {
  assert.equal(idxTick.getIdxTickSize(1500, 'UTAMA', 'true', null), 1,
    "FCA string 'true' must select the Rp1 tick");
  assert.equal(idxTick.getIdxTickSize(1500, 'UTAMA', 'false', 'BBCA'), 5,
    "FCA string 'false' must fall back to the normal Rp5 tick at 1500");
  assert.equal(idxTick.getIdxTickSize(1500, 'UTAMA', false, 'BBCA'), 5);
});

test('Fase 5 carry-over: price-scale guard still blocks synthetic-scaled rows', () => {
  const guard = require('../lib/corporate-action-price-scale-guard');
  const blocked = guard.detectPriceScaleMismatch(
    { last_price: 1200, entry_low: 120, entry_high: 130, stop_loss: 115, tp1: 150, support: 118, resistance: 140 },
    null,
    {}
  );
  assert.equal(blocked.blocked, true, 'a 10x scale mismatch must still be blocked');
});

test('Fase 4 carry-over: high-R:R warning still annotates Non-Konglo without filtering', () => {
  const row = { entry_low: 100, entry_high: 110, stop_loss: 95, tp1: 150, risk_reward: 5.0 };
  const annotated = T.annotateSwingNkHighRrWarning(row, { category: 'swing_nk' });
  assert.equal(annotated.high_rr_warning, true);
  assert.equal(annotated.entry_low, 100, 'annotation must never mutate the plan levels');
  assert.equal(annotated.stop_loss, 95);
});

test('Swing engine: R:R < 1.8x still cannot enter High Conviction', () => {
  const rejected = swingEngine.verifySwingHighConviction({
    ticker: 'TEST', last_price: 1000, entry_low: 990, entry_high: 1000,
    stop_loss: 950, tp1: 1050, tp2: 1100, risk_reward: 1.2,
    score: 95, status: 'Swing Ready'
  });
  assert.equal(rejected, null, 'R:R 1.2x must be discarded from High Conviction');
});

test('Swing engine: WAIT_PULLBACK status is still barred from High Conviction', () => {
  const rejected = swingEngine.verifySwingHighConviction({
    ticker: 'TEST', last_price: 1000, entry_low: 990, entry_high: 1000,
    stop_loss: 950, tp1: 1100, tp2: 1150, risk_reward: 2.5,
    score: 95, status: 'Wait Pullback'
  });
  assert.equal(rejected, null, 'WAIT_PULLBACK must never be published as High Conviction');
});

test('Swing trend classifier: insufficient history returns INSUFFICIENT_DATA (no NaN)', () => {
  const indicators = require('../lib/chart-engine/indicators');
  const short = indicators.classifySwingTrend([bar(100, 105, 95, 100)]);
  assert.equal(short.status, 'INSUFFICIENT_DATA');
  assert.equal(short.close, null);
  assert.equal(short.ema20, null);
  const dirty = new Array(60).fill(bar(100, 105, 95, 100));
  dirty[5] = bar(100, 105, 95, null);
  assert.equal(indicators.classifySwingTrend(dirty).status, 'INVALID_DATA');
});

test('Non-Konglo hard filters: illiquid / thin names are still rejected', () => {
  assert.equal(typeof T.applyNkHardFilters, 'function',
    'applyNkHardFilters must be exported for the audit');
  const liquid = {
    lastPrice: 500, tradedDays20d: 20, avgTxValue20d: 20e9,
    riskReward: 2.0, volumeRatioAvg20: 1.2
  };
  assert.equal(T.applyNkHardFilters(liquid), true, 'a liquid, well-traded name must pass');
  assert.equal(T.applyNkHardFilters(Object.assign({}, liquid, { lastPrice: 0 })), false, 'harga < 1 ditolak');
  assert.equal(T.applyNkHardFilters(Object.assign({}, liquid, { lastPrice: 50 })), true, 'harga 50 tetap valid (floor Rp1)');
  assert.equal(T.applyNkHardFilters(Object.assign({}, liquid, { tradedDays20d: 14 })), false, 'traded days < 15 ditolak');
  assert.equal(T.applyNkHardFilters(Object.assign({}, liquid, { avgTxValue20d: 9e9 })), false, 'nilai transaksi < 10B ditolak');
  assert.equal(T.applyNkHardFilters(Object.assign({}, liquid, { riskReward: 1.4 })), false, 'R:R < 1.5 ditolak');
  assert.equal(T.applyNkHardFilters(Object.assign({}, liquid, { volumeRatioAvg20: 0.6 })), false, 'volume ratio < 0.7 ditolak');
});

test('Non-Konglo staging sanitizer still drops columns outside the fixed schema', () => {
  const sanitized = T.sanitizeNkStagingRow({
    ticker: 'AAAA', board: 'UTAMA', score: 80,
    tf_2d_context: 'x', close_price: 100, multi_timeframe_notes: 'y'
  });
  assert.equal(sanitized.ticker, 'AAAA');
  assert.equal(sanitized.tf_2d_context, undefined, 'tf_2d_context is not a staging column');
  assert.equal(sanitized.close_price, undefined, 'close_price is not a staging column');
  assert.equal(sanitized.multi_timeframe_notes, undefined, 'multi_timeframe_notes is not a staging column');
});
