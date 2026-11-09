'use strict';

/**
 * api/screener.js
 * ============================================================================
 * Endpoint API Screener Terpadu Auto-Cuan — V5 P0 hardened
 * ============================================================================
 *
 * WHAT CHANGED IN V5 P0 (BUG-V5-P0-001 / 002 / P1-023)
 *   BEFORE: this file was a *template generator*. It iterated a hardcoded
 *   20-ticker universe per category and, for every ticker absent from the
 *   on-disk JSON, substituted a literal price (`1550` / `380` / `1420`) plus
 *   literal score/win-rate/change defaults, then derived every level from that
 *   invented price. 60 rows were published from 7 real source rows.
 *
 *   AFTER: this file is a *reader*. It publishes exactly the rows that exist in
 *   the source files. A field that is genuinely absent becomes `null`; a row
 *   that cannot be populated from real data is NOT published at all. Publishing
 *   fewer rows — or none — is the correct behaviour.
 *
 * CONTRACT
 *   - No numeric literal is ever substituted for a missing market datum.
 *   - `0` survives as a real value (the `value || CONSTANT` anti-pattern is gone).
 *   - Every published row carries `data_status` and `provenance`.
 *   - The readiness verdict is computed from the real R/R gate, never stamped.
 *
 * Response shape is backward compatible: `konglo`, `nonkonglo`, `daytrade`,
 * `categories`, `results`, `meta`, `success`, `trade_date`, `session_status`
 * all still exist. New fields are purely additive.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');

const contract = require('../lib/market-data-contract.js');
const screenerConfig = require('../lib/screener-config.js');
const readiness = require('../lib/readiness-engine.js');

const { DATA_STATUS, pickNumber, pickText, isKnown } = contract;
const { MIN_RR_RATIO, recalculateRiskReward } = screenerConfig;

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const BACKTEST_FILE = path.join(ROOT, 'bukti-verifikasi-final', 'backtest-individual-964.json');

let _cachedScreenerData = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 30000;

/* -------------------------------------------------------------------------- */
/* Category definition — metadata ONLY, never a ticker universe               */
/* -------------------------------------------------------------------------- */

/**
 * Each entry names the *file* to read. There is deliberately no per-category
 * ticker list here: a hardcoded universe is what manufactured the fake rows.
 */
const CATEGORY_SPECS = Object.freeze([
  Object.freeze({ key: 'konglo', label: 'Swing Konglo', file: 'screener-v3f04-konglo.json' }),
  Object.freeze({ key: 'nonkonglo', label: 'Swing Non-Konglo', file: 'screener-v3f04-nonkonglo.json' }),
  Object.freeze({ key: 'daytrade', label: 'Day Trade', file: 'screener-v3f04-daytrade.json' })
]);

/** Minimum backtest sample for a win rate to be a *qualification* (see N23). */
const MIN_WIN_RATE_SAMPLE = 10;

/* -------------------------------------------------------------------------- */
/* Small IO helpers                                                           */
/* -------------------------------------------------------------------------- */

function readJsonSafe(p, def) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return def === undefined ? null : def;
  }
}

function wibDateString(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date || new Date());
}

function getBacktestMap() {
  const map = new Map();
  const bt = readJsonSafe(BACKTEST_FILE, null);
  if (bt && Array.isArray(bt.tickers)) {
    for (const t of bt.tickers) {
      if (t && t.ticker) map.set(String(t.ticker).toUpperCase(), t);
    }
  }
  return map;
}

/* -------------------------------------------------------------------------- */
/* Readiness — delegated to the SINGLE authority                              */
/* -------------------------------------------------------------------------- */

/**
 * BUG-V5-P0-003 / BUG-V5-P0-005.
 *
 * This function used to be this file's private verdict engine: it consulted the
 * R/R policy gate, then mapped the result onto its own vocabulary and its own
 * `BUY` token. That made `api/screener.js` one of several independent
 * authorities, which is exactly how a row could be published `READY` while its
 * own numbers said otherwise.
 *
 * The verdict now comes exclusively from `lib/readiness-engine.js`. This wrapper
 * exists only to hand the engine the freshness context this file already knows
 * (the source's trade date and today's WIB date) and to keep the historical
 * export name working for existing callers and tests.
 *
 * @param {object} row         candidate with real levels
 * @param {string|null} sourceStatus upstream producer's free-text status
 * @param {{tradeDate?:string|null, now?:number, dataStatus?:string}} [context]
 * @returns {{status:string, verdict:string, reason:string|null, reasons:string[],
 *            rr:number|null, gatePassed:boolean}}
 */
function deriveReadiness(row, sourceStatus, context) {
  const ctx = context && typeof context === 'object' ? context : {};
  const result = readiness.evaluate(
    Object.assign({}, row, {
      source_status: sourceStatus === null || sourceStatus === undefined ? null : sourceStatus,
      trade_date: ctx.tradeDate !== undefined ? ctx.tradeDate : row && row.trade_date,
      data_status: ctx.dataStatus !== undefined ? ctx.dataStatus : (row && row.data_status)
    }),
    {
      minRiskReward: MIN_RR_RATIO,
      now: ctx.now !== undefined ? ctx.now : undefined
    }
  );

  return Object.freeze({
    // `verdict` is retained as an alias so older consumers keep working; both
    // fields carry the engine's status verbatim.
    status: result.status,
    verdict: result.status,
    reason: result.reasons.length > 0 ? result.reasons[0] : null,
    reasons: result.reasons.slice(),
    rr: result.rr,
    gatePassed: Boolean(result.gateResults.riskReward && result.gateResults.riskReward.pass),
    gateResults: result.gateResults
  });
}

/* -------------------------------------------------------------------------- */
/* Row construction                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build one published screener row from a REAL source row.
 *
 * Returns `{ row, reject }`. When `reject` is set the row must NOT be published.
 * Every field is either a real value read from the source (or its backtest
 * companion) or `null`. No plausible default is ever invented.
 *
 * @param {object} raw source row
 * @param {object} spec category spec
 * @param {Map} backtestMap
 * @param {{file:string, tradeDate:string|null, today:string}} origin
 */
function buildScreenerRow(raw, spec, backtestMap, origin) {
  if (!raw || typeof raw !== 'object') {
    return { row: null, reject: { ticker: null, reason: 'ROW_NOT_OBJECT' } };
  }

  const ticker = String(pickText(raw.ticker) || '').toUpperCase();
  if (!ticker) {
    return { row: null, reject: { ticker: null, reason: 'TICKER_ABSENT' } };
  }

  const bt = backtestMap.get(ticker) || {};

  /* --- Price: the single datum that must exist for a market row ---------- */
  const lastPrice = pickNumber(raw.last_price, raw.close, raw.price, raw.entry_price);
  if (lastPrice === null) {
    return { row: null, reject: { ticker, reason: 'LAST_PRICE_ABSENT' } };
  }
  if (lastPrice <= 0) {
    return { row: null, reject: { ticker, reason: 'LAST_PRICE_NOT_POSITIVE' } };
  }

  /* --- Trade plan: read only, never derived from the price --------------- */
  const entryLow = pickNumber(raw.entry_low);
  const entryHigh = pickNumber(raw.entry_high, raw.entry);
  const stopLoss = pickNumber(raw.stop_loss, raw.sl);
  const tp1 = pickNumber(raw.tp1);
  const tp2 = pickNumber(raw.tp2);

  const planValues = [entryHigh, stopLoss, tp1];
  const planComplete = planValues.every((v) => v !== null);
  if (!planComplete) {
    return { row: null, reject: { ticker, reason: 'TRADE_PLAN_LEVELS_ABSENT' } };
  }
  // Structural validity. An invalid plan is not a candidate.
  if (!(entryHigh > stopLoss && stopLoss > 0 && tp1 > entryHigh)) {
    return { row: null, reject: { ticker, reason: 'TRADE_PLAN_STRUCTURALLY_INVALID' } };
  }

  /* --- Indicators: real or null ------------------------------------------ */
  const score = pickNumber(raw.conviction_score, raw.score, raw.v3f04_score, raw.daytrade_score);
  const changePct = pickNumber(raw.change_pct);
  const volumeRatio = pickNumber(raw.volume_ratio_20d, raw.volume_ratio);
  const rsi14 = pickNumber(raw.rsi14, raw.rsi);

  // The win rate is REAL data from `backtest-individual-964.json`; it is
  // published unchanged. Whether the sample is large enough to be a
  // qualification is a *separate* defect (negative control N23) and is
  // reported additively here rather than silently suppressing a real figure —
  // suppressing it would hide the sample-size defect instead of surfacing it.
  const rawWinRate = pickNumber(raw.win_rate_pct, raw.winRatePct, bt.winRatePct);
  const sampleSize = pickNumber(bt.tradesCount, raw.trades_count);
  const winRateQualified = sampleSize !== null && sampleSize >= MIN_WIN_RATE_SAMPLE;
  const winRate = rawWinRate;

  const bestMethod = pickText(bt.bestMethodName, raw.best_method_name);
  const bestHorizon = pickText(bt.bestBrokerHorizon, raw.best_broker_horizon);
  const flowDriver = pickText(bt.dominantFlowDriver, raw.dominant_flow_driver);

  /* --- R/R: source value, else recomputed from real levels --------------- */
  const sourceRr = pickNumber(raw.rr, raw.risk_reward);
  const computedRr = recalculateRiskReward({ entry_high: entryHigh, stop_loss: stopLoss, tp1 });
  const rr = sourceRr !== null ? sourceRr : (computedRr === null ? null : Number(computedRr.toFixed(2)));

  const sourceStatus = pickText(raw.status, raw.setup);

  const row = {
    ticker,
    name: pickText(raw.company_name, raw.stock_name) || ticker,
    company_name: pickText(raw.company_name, raw.stock_name) || ticker,
    category: spec.label,
    screener_type: spec.key,

    last_price: lastPrice,
    current_price: lastPrice,
    close: lastPrice,

    change_pct: changePct,

    score,
    conviction_score: score,
    combined_score: score,

    win_rate_pct: winRate,
    winRatePct: winRate,
    win_rate_sample_size: sampleSize,
    win_rate_qualified: winRateQualified,

    best_method_name: bestMethod,
    bestMethodName: bestMethod,
    best_broker_horizon: bestHorizon,
    bestBrokerHorizon: bestHorizon,
    dominant_flow_driver: flowDriver,

    entry_low: entryLow,
    entry_high: entryHigh,
    entry1: entryHigh,
    entry2: entryLow,
    entry_area: (entryLow !== null && entryHigh !== null)
      ? entryLow.toLocaleString('id-ID') + ' \u2013 ' + entryHigh.toLocaleString('id-ID')
      : null,
    stop_loss: stopLoss,
    sl: stopLoss,
    tp1,
    tp2,
    risk_reward: rr,
    rr,

    volume_ratio_20d: volumeRatio,
    volume_ratio: volumeRatio,
    rsi14,

    source_status: sourceStatus,
    source_file: origin.file
  };

  row.catatan = [bestMethod, bestHorizon].filter(Boolean).join(' (') === ''
    ? null
    : (bestMethod || '') + (bestHorizon ? ' (' + bestHorizon + ')' : '');
  if (row.catatan === '') row.catatan = null;

  /* --- Explicitness: no synthetic stamping of freshness ------------------ */
  // The row's own trade date wins over the file-level date: a file can be
  // rewritten at 2026-11-04 while the candidates inside describe 2026-11-03.
  const rowTradeDate = pickText(raw.trade_date, raw.market_date, raw.run_date) || origin.tradeDate;
  row.trade_date = rowTradeDate;
  row.stale = isKnown(rowTradeDate) && isKnown(origin.today)
    ? rowTradeDate !== origin.today
    : null;
  row.is_stale = row.stale;
  row.freshness_label = row.stale === null ? null : (row.stale ? 'stale' : 'fresh');

  /* --- Data status ------------------------------------------------------- */
  const analysisFields = [score, winRate, changePct, volumeRatio, rsi14];
  const missingAnalysis = analysisFields.filter((v) => v === null).length;
  let status = DATA_STATUS.AVAILABLE;
  if (missingAnalysis === analysisFields.length) status = DATA_STATUS.PARTIAL;
  else if (missingAnalysis > 0) status = DATA_STATUS.PARTIAL;
  if (row.stale === true) status = DATA_STATUS.STALE;

  const withProvenance = contract.attachProvenance(row, {
    source: origin.file,
    tradeDate: origin.tradeDate,
    sourceTimestamp: pickText(raw.calculated_at, raw.price_asof, raw.price_date) || null,
    status,
    extra: {
      priceSource: pickText(raw.price_source) || null,
      priceAsof: pickText(raw.price_asof, raw.price_date) || null
    }
  });

  /* --- Verdict: the engine decides, and it decides LAST ------------------ */
  // Ordering matters: the verdict must see the freshness context that was only
  // just resolved (`trade_date`, `stale`, `data_status`). Computing it earlier —
  // as this file previously did — let a row be stamped READY before anyone had
  // established that the data was a day old.
  const verdict = deriveReadiness(withProvenance, sourceStatus, {
    tradeDate: rowTradeDate,
    dataStatus: withProvenance.data_status,
    now: origin.now
  });

  withProvenance.readiness_status = verdict.status;
  withProvenance.status = verdict.status;
  withProvenance.action = readiness.actionForStatus(verdict.status);
  withProvenance.action_label = withProvenance.action;
  withProvenance.status_label = readiness.labelForStatus(verdict.status);
  // `setup` used to carry the producer's free text ("Swing Ready"). That text
  // contains the token READY, so any consumer treating `setup` as a verdict
  // read a source label as a recommendation. The raw text stays in
  // `source_status`; `setup` now carries the engine's status.
  withProvenance.setup = verdict.status;
  withProvenance.timing = verdict.status === readiness.STATUS.READY ? 'Area Beli' : null;
  withProvenance.arah = verdict.status === readiness.STATUS.READY ? 'Akumulasi' : null;
  withProvenance.verdict_reason = verdict.reason;
  withProvenance.verdict_reasons = verdict.reasons;
  withProvenance.rr_gate_passed = verdict.gatePassed;
  withProvenance.rr_policy_minimum = MIN_RR_RATIO;
  withProvenance.rr_engine = verdict.rr;

  /* --- Derived post-verdict flags: honest, never optimistic -------------- */
  // `true` only when the engine really said READY. These three fields are what
  // every downstream gate and Telegram publisher reads, so they must never be
  // set from the gate result alone.
  const isReady = verdict.status === readiness.STATUS.READY;
  withProvenance.trading_plan_valid = isReady;
  withProvenance.safe = isReady;
  withProvenance.quality_grade = null;
  withProvenance.grade = null;
  withProvenance.risk_label = readiness.labelForStatus(verdict.status);
  withProvenance.plan_quality_status = verdict.gatePassed ? 'PASS' : 'FAIL';
  withProvenance.waived = false;

  return { row: withProvenance, reject: null };
}

/* -------------------------------------------------------------------------- */
/* Category read                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Read one category file and build its published rows.
 *
 * The "official" publication set is `results`. Day-trade files additionally
 * carry a `radar` array of *real* candidates whose price is sourced (e.g.
 * `price_source: yahoo_chart_1d_close`, `price_asof`). Those rows are surfaced
 * verbatim under `radar_candidates` so the real data is visible, but they are
 * NOT merged into `results`: the producer published nothing in that array, and
 * pretending otherwise would be exactly the substitution this package removes.
 */
function buildCategory(spec, backtestMap, today, now) {
  const filePath = path.join(DATA_DIR, spec.file);
  const relFile = 'data/' + spec.file;
  const doc = readJsonSafe(filePath, null);

  const base = {
    key: spec.key,
    label: spec.label,
    source_file: relFile,
    source_rows: 0,
    published_rows: 0,
    rejected: [],
    radar_candidates: [],
    trade_date: null,
    data_status: DATA_STATUS.SOURCE_UNAVAILABLE,
    status_reason: null
  };

  if (!doc || typeof doc !== 'object') {
    base.status_reason = 'SOURCE_FILE_UNREADABLE';
    return { meta: base, rows: [] };
  }

  const tradeDate = pickText(doc.trade_date, doc.market_date, doc.run_date);
  base.trade_date = tradeDate;
  // The clock is injected into the readiness engine, never read inside it.
  const origin = { file: relFile, tradeDate, today, now };

  const rawResults = Array.isArray(doc.results) ? doc.results : [];
  const rawRadar = Array.isArray(doc.radar)
    ? doc.radar
    : (Array.isArray(doc.radar_candidates) ? doc.radar_candidates : []);
  base.source_rows = rawResults.length;

  /* Real radar rows: surfaced, but never published as screener candidates. */
  const radarBuilt = [];
  for (const rawRadarRow of rawRadar) {
    const built = buildScreenerRow(rawRadarRow, spec, backtestMap, origin);
    if (built.row) {
      radarBuilt.push(Object.assign({}, built.row, {
        published: false,
        publication_block: 'SOURCE_RESULTS_EMPTY_NOT_A_CANDIDATE_SET'
      }));
    } else if (built.reject) {
      base.rejected.push(Object.assign({ radar: true }, built.reject));
    }
  }
  base.radar_candidates = radarBuilt;

  const rows = [];
  for (const raw of rawResults) {
    const built = buildScreenerRow(raw, spec, backtestMap, origin);
    if (!built.row) {
      base.rejected.push(built.reject);
      continue;
    }
    rows.push(built.row);
  }
  base.published_rows = rows.length;

  if (rows.length === 0) {
    base.data_status = DATA_STATUS.NOT_PUBLISHED;
    base.status_reason = rawResults.length === 0
      ? 'PRODUCER_PUBLISHED_NO_CANDIDATES'
      : 'NO_SOURCE_ROW_PASSED_REAL_DATA_VALIDATION';
  } else if (base.rejected.length > 0) {
    base.data_status = DATA_STATUS.PARTIAL;
    base.status_reason = 'SOME_SOURCE_ROWS_REJECTED';
  } else {
    base.data_status = DATA_STATUS.AVAILABLE;
  }
  if (base.data_status !== DATA_STATUS.NOT_PUBLISHED && isKnown(tradeDate) && tradeDate !== today) {
    base.data_status = DATA_STATUS.STALE;
    base.status_reason = base.status_reason || 'SOURCE_TRADE_DATE_IS_NOT_TODAY';
  }

  return { meta: base, rows };
}

/* -------------------------------------------------------------------------- */
/* Payload                                                                    */
/* -------------------------------------------------------------------------- */

function buildScreenerPayload() {
  const now = Date.now();
  if (_cachedScreenerData && (now - _cachedAt < CACHE_TTL_MS)) {
    return _cachedScreenerData;
  }

  const today = wibDateString();
  const backtestMap = getBacktestMap();

  const perCategory = {};
  for (const spec of CATEGORY_SPECS) {
    perCategory[spec.key] = buildCategory(spec, backtestMap, today, now);
  }

  const kongloRows = perCategory.konglo.rows;
  const nkRows = perCategory.nonkonglo.rows;
  const dtRows = perCategory.daytrade.rows;
  const allRows = [...kongloRows, ...nkRows, ...dtRows];

  const tradeDates = CATEGORY_SPECS
    .map((spec) => perCategory[spec.key].meta.trade_date)
    .filter((d) => typeof d === 'string' && d.length > 0)
    .sort();
  const dataTradeDate = tradeDates.length ? tradeDates[tradeDates.length - 1] : null;

  const anyStale = allRows.some((r) => r.stale === true);
  const publishedCount = allRows.length;

  let sessionStatus;
  if (publishedCount === 0) sessionStatus = 'NO_DATA';
  else if (anyStale) sessionStatus = 'STALE';
  else sessionStatus = 'FINAL_EOD';

  const payloadDataStatus = publishedCount === 0
    ? DATA_STATUS.NOT_PUBLISHED
    : (anyStale ? DATA_STATUS.STALE : DATA_STATUS.AVAILABLE);

  const categoriesMeta = {};
  for (const spec of CATEGORY_SPECS) {
    categoriesMeta[spec.key] = perCategory[spec.key].meta;
  }

  const payload = {
    success: true,

    // The market date the data actually describes (not the wall clock).
    trade_date: dataTradeDate,
    date: dataTradeDate,
    market_date: dataTradeDate,
    run_date: dataTradeDate,
    data_as_of: dataTradeDate,
    calculated_at: new Date().toISOString(),

    session_status: sessionStatus,
    is_eod_final: publishedCount > 0 && !anyStale,
    eod_complete: publishedCount > 0 && !anyStale,
    stale: anyStale,
    freshness_label: publishedCount === 0 ? null : (anyStale ? 'stale' : 'fresh'),

    data_status: payloadDataStatus,

    konglo: kongloRows,
    nonkonglo: nkRows,
    daytrade: dtRows,

    // Real, price-sourced day-trade rows that the producer did NOT publish as
    // screener candidates. Surfaced for inspection; never merged into results.
    daytrade_radar: perCategory.daytrade.meta.radar_candidates,

    categories: {
      konglo: kongloRows,
      nonkonglo: nkRows,
      daytrade: dtRows
    },
    categories_meta: categoriesMeta,

    meta: {
      calculated_at: new Date().toISOString(),
      trading_date: dataTradeDate,
      session_status: sessionStatus,
      is_eod_final: publishedCount > 0 && !anyStale,
      stale: anyStale,

      // Real counts. `universe_count` is the number of rows actually examined.
      universe_count: CATEGORY_SPECS.reduce((sum, s) => sum + perCategory[s.key].meta.source_rows, 0),
      scanned_count: CATEGORY_SPECS.reduce((sum, s) => sum + perCategory[s.key].meta.source_rows, 0),
      published_count: publishedCount,
      rejected_count: CATEGORY_SPECS.reduce((sum, s) => sum + perCategory[s.key].meta.rejected.length, 0),
      fabricated_count: 0,
      rr_policy_minimum: MIN_RR_RATIO,
      readiness_engine: '../lib/readiness-engine.js',
      // Honest per-status census of the published set. A downstream reader can
      // see at a glance that nothing was published as READY.
      readiness_counts: allRows.reduce((acc, r) => {
        const key = String(r.readiness_status || r.status || 'UNKNOWN');
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {})
    },

    results: allRows
  };

  _cachedScreenerData = payload;
  _cachedAt = now;
  return payload;
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = async function handler(req, res) {
  try {
    const payload = buildScreenerPayload();
    const query = (req && req.query) || {};
    const category = String(query.category || query.tab || query.type || '').toLowerCase();

    let filtered = payload.results;
    if (category.includes('konglo') && !category.includes('non')) {
      filtered = payload.konglo;
    } else if (category.includes('non')) {
      filtered = payload.nonkonglo;
    } else if (category.includes('day')) {
      filtered = payload.daytrade;
    }

    const responseData = Object.assign({}, payload, {
      count: filtered.length,
      results: filtered
    });

    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
    }
    if (res && typeof res.status === 'function') {
      return res.status(200).json(responseData);
    }
    return responseData;
  } catch (err) {
    if (res && typeof res.status === 'function') {
      return res.status(500).json({ success: false, error: err.message });
    }
    throw err;
  }
};

module.exports.buildScreenerPayload = buildScreenerPayload;
module.exports.buildScreenerRow = buildScreenerRow;
module.exports.deriveReadiness = deriveReadiness;
module.exports.CATEGORY_SPECS = CATEGORY_SPECS;
