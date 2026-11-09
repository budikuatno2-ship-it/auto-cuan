#!/usr/bin/env node
'use strict';

/**
 * scripts/top5-radar.js
 * ============================================================================
 * Runner Pengunci Top 5 Radar Harian Auto-Cuan — V5 P0 hardened
 * ============================================================================
 *
 * WHAT CHANGED IN V5 P0 (BUG-V5-P0-004 / 002)
 *   BEFORE: when a screener pool was empty this script PADDED it with a
 *   hardcoded fallback ticker array carrying literal metrics
 *   (`{ last_price: 1420, score: 88, change_pct: 3.5 }`), then `.slice(0,5)`
 *   published those five clones as a "locked EOD" Top 5. All five rows were
 *   byte-identical because they came from one literal.
 *
 *   AFTER: only rows that exist in a real screener source file can be emitted.
 *   Zero candidates is a valid, expected outcome. Nothing is padded, nothing is
 *   defaulted, and `top5_locked` is only true when every category really holds
 *   at least five published source rows.
 *
 * OUTPUT FILES
 *   data/top5-radar.json
 *   data/radar-state.json
 *   data/job-heartbeat/top5-radar.json
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
const OUT_FILE = path.join(DATA_DIR, 'top5-radar.json');
const RADAR_STATE_FILE = path.join(DATA_DIR, 'radar-state.json');
const HEARTBEAT_FILE = path.join(DATA_DIR, 'job-heartbeat', 'top5-radar.json');

/** Maximum picks per category and for the combined dashboard Top 5. */
const MAX_PICKS = 5;

/** Minimum backtest sample for a win rate to count as a qualification. */
const MIN_WIN_RATE_SAMPLE = 10;

/**
 * Category metadata only — deliberately NO ticker array. A hardcoded ticker
 * list is precisely the mechanism that manufactured the fake Top 5.
 */
const CATEGORY_SPECS = Object.freeze([
  Object.freeze({ key: 'konglo', label: 'Swing Konglo', file: 'screener-v3f04-konglo.json' }),
  Object.freeze({ key: 'nonkonglo', label: 'Swing Non-Konglo', file: 'screener-v3f04-nonkonglo.json' }),
  Object.freeze({ key: 'daytrade', label: 'Day Trade', file: 'screener-v3f04-daytrade.json' })
]);

/* -------------------------------------------------------------------------- */
/* IO helpers                                                                 */
/* -------------------------------------------------------------------------- */

function readJsonSafe(p, def) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return def === undefined ? null : def;
  }
}

function wibDateString() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function buildBacktestMap() {
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
/* Candidate normalisation — real values only                                 */
/* -------------------------------------------------------------------------- */

/**
 * Convert a REAL source row into a Top-5 candidate.
 *
 * Returns `{ candidate, reject }`. A candidate is only produced when the price
 * and a structurally valid trade plan were actually read. No level is ever
 * synthesised from the price (the old `lastPrice * 0.985` ladder is gone).
 *
 * @param {object} item source row
 * @param {object} spec category spec
 * @param {Map} backtestMap
 * @param {number} rank
 * @param {{file:string, tradeDate:string|null, today:string}} origin
 */
function normalizeCandidate(item, spec, backtestMap, rank, origin) {
  if (!item || typeof item !== 'object') return { candidate: null, reject: { reason: 'ROW_NOT_OBJECT' } };

  const ticker = String(pickText(item.ticker) || '').toUpperCase();
  if (!ticker) return { candidate: null, reject: { reason: 'TICKER_ABSENT' } };

  const bt = backtestMap.get(ticker) || {};

  const lastPrice = pickNumber(item.last_price, item.close, item.price, item.entry_price);
  if (lastPrice === null || lastPrice <= 0) {
    return { candidate: null, reject: { ticker, reason: 'LAST_PRICE_ABSENT' } };
  }

  const entryLow = pickNumber(item.entry_low);
  const entryHigh = pickNumber(item.entry_high, item.entry);
  const stopLoss = pickNumber(item.stop_loss, item.sl);
  const tp1 = pickNumber(item.tp1);
  const tp2 = pickNumber(item.tp2);

  if ([entryHigh, stopLoss, tp1].some((v) => v === null)) {
    return { candidate: null, reject: { ticker, reason: 'TRADE_PLAN_LEVELS_ABSENT' } };
  }
  if (!(entryHigh > stopLoss && stopLoss > 0 && tp1 > entryHigh)) {
    return { candidate: null, reject: { ticker, reason: 'TRADE_PLAN_STRUCTURALLY_INVALID' } };
  }

  const sourceRr = pickNumber(item.rr, item.risk_reward);
  const computedRr = recalculateRiskReward({ entry_high: entryHigh, stop_loss: stopLoss, tp1 });
  const rr = sourceRr !== null ? sourceRr : (computedRr === null ? null : Number(computedRr.toFixed(2)));

  const score = pickNumber(item.conviction_score, item.score, item.v3f04_score, item.daytrade_score);
  const sampleSize = pickNumber(bt.tradesCount, item.trades_count);
  const rawWinRate = pickNumber(item.win_rate_pct, item.winRatePct, bt.winRatePct);
  const winRateQualified = sampleSize !== null && sampleSize >= MIN_WIN_RATE_SAMPLE;

  const rowTradeDate = pickText(item.trade_date, item.market_date, item.run_date) || origin.tradeDate;

  const candidate = {
    rank,
    ticker,
    company_name: pickText(item.company_name, item.stock_name) || ticker,
    name: pickText(item.company_name, item.stock_name) || ticker,
    category: spec.label,
    screener_type: spec.key,
    source: spec.key,
    source_file: origin.file,

    last_price: lastPrice,
    current_price: lastPrice,
    close: lastPrice,
    change_pct: pickNumber(item.change_pct),
    volume_ratio_avg20: pickNumber(item.volume_ratio_20d, item.volume_ratio),

    score,
    conviction_score: score,
    combined_score: score,

    // The win rate is REAL data from `backtest-individual-964.json` and is
    // published unchanged. Sample adequacy is a separate defect (N23); it is
    // reported additively so the weakness stays visible rather than being
    // silently suppressed into a `null`.
    win_rate_pct: rawWinRate,
    winRatePct: rawWinRate,
    win_rate_qualified: winRateQualified,
    win_rate_sample_size: sampleSize,

    best_method_name: pickText(bt.bestMethodName, item.best_method_name),
    bestMethodName: pickText(bt.bestMethodName, item.best_method_name),
    best_broker_horizon: pickText(bt.bestBrokerHorizon, item.best_broker_horizon),
    bestBrokerHorizon: pickText(bt.bestBrokerHorizon, item.best_broker_horizon),

    entry1: entryHigh,
    entry2: entryLow,
    entry_low: entryLow,
    entry_high: entryHigh,
    stop_loss: stopLoss,
    sl: stopLoss,
    tp1,
    tp2,
    risk_reward: rr,
    rr,
    rr_policy_minimum: MIN_RR_RATIO,

    trade_date: rowTradeDate,
    source_status: pickText(item.status, item.setup)
  };

  /* --- Provenance first: the verdict needs the freshness context --------- */
  candidate.stale = isKnown(rowTradeDate) && isKnown(origin.today) ? rowTradeDate !== origin.today : null;

  const status = candidate.stale === true ? DATA_STATUS.STALE : DATA_STATUS.AVAILABLE;
  const withProvenance = contract.attachProvenance(candidate, {
    source: origin.file,
    tradeDate: rowTradeDate,
    sourceTimestamp: pickText(item.calculated_at, item.price_asof, item.price_date) || null,
    status,
    extra: {
      priceSource: pickText(item.price_source) || null,
      priceAsof: pickText(item.price_asof, item.price_date) || null,
      categoryKey: spec.key
    }
  });

  /* --- Verdict: SINGLE authority (lib/readiness-engine.js) --------------- */
  // This block used to re-implement the gate and map it onto READY/WAIT/
  // REVIEW_REQUIRED with its own BUY token — a second authority that could
  // disagree with `api/screener.js` about the same candidate.
  const verdict = readiness.evaluate(withProvenance, {
    minRiskReward: MIN_RR_RATIO,
    now: origin.now
  });

  const isReady = verdict.status === readiness.STATUS.READY;

  withProvenance.readiness_status = verdict.status;
  withProvenance.status = verdict.status;
  withProvenance.action = readiness.actionForStatus(verdict.status);
  withProvenance.action_label = withProvenance.action;
  withProvenance.status_label = readiness.labelForStatus(verdict.status);
  withProvenance.verdict_reason = verdict.reasons.length > 0 ? verdict.reasons[0] : null;
  withProvenance.verdict_reasons = verdict.reasons;
  withProvenance.rr_gate_passed = Boolean(verdict.gateResults.riskReward && verdict.gateResults.riskReward.pass);
  withProvenance.rr_policy_minimum = MIN_RR_RATIO;
  withProvenance.rr_engine = verdict.rr;

  /* Geography of the plan is reported, never asserted as a quality grade. */
  withProvenance.risk_label = readiness.labelForStatus(verdict.status);
  withProvenance.plan_quality_status = withProvenance.rr_gate_passed ? 'PASS' : 'FAIL';
  // `true` only when the engine said READY. These fields feed the Telegram
  // delivery gate, so deriving them from the R/R gate alone was unsafe.
  withProvenance.trading_plan_valid = isReady;
  withProvenance.safe = isReady;
  withProvenance.quality_grade = null;
  withProvenance.grade = null;
  withProvenance.waived = false;

  withProvenance.raw_payload = Object.assign({}, withProvenance);

  return { candidate: withProvenance, reject: null };
}

/* -------------------------------------------------------------------------- */
/* Pool reading                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Read one category's REAL candidate pool. `results` only — `radar` holds
 * price-sourced observations the producer did not publish as candidates, and
 * promoting them here would silently re-invent the candidate set.
 */
function readPool(spec, backtestMap, today, now) {
  const relFile = 'data/' + spec.file;
  const doc = readJsonSafe(path.join(DATA_DIR, spec.file), null);

  const meta = {
    key: spec.key,
    label: spec.label,
    source_file: relFile,
    source_rows: 0,
    data_status: DATA_STATUS.SOURCE_UNAVAILABLE,
    status_reason: null,
    trade_date: null
  };

  if (!doc || typeof doc !== 'object') {
    meta.status_reason = 'SOURCE_FILE_UNREADABLE';
    return { meta, candidates: [], rejects: [] };
  }

  meta.trade_date = pickText(doc.trade_date, doc.market_date, doc.run_date);
  const rows = Array.isArray(doc.results) ? doc.results : [];
  meta.source_rows = rows.length;

  const candidates = [];
  const rejects = [];
  for (const row of rows) {
    const built = normalizeCandidate(row, spec, backtestMap, candidates.length + 1, {
      file: relFile,
      tradeDate: meta.trade_date,
      today,
      now
    });
    if (built.candidate) candidates.push(built.candidate);
    else if (built.reject) rejects.push(built.reject);
  }

  if (candidates.length === 0) {
    meta.data_status = DATA_STATUS.NOT_PUBLISHED;
    meta.status_reason = rows.length === 0
      ? 'PRODUCER_PUBLISHED_NO_CANDIDATES'
      : 'NO_SOURCE_ROW_PASSED_REAL_DATA_VALIDATION';
  } else if (rejects.length > 0) {
    meta.data_status = DATA_STATUS.PARTIAL;
    meta.status_reason = 'SOME_SOURCE_ROWS_REJECTED';
  } else {
    meta.data_status = DATA_STATUS.AVAILABLE;
  }

  return { meta, candidates, rejects };
}

/** Rank comparator: real score descending, unscored rows last, then ticker. */
function byScoreDesc(a, b) {
  const sa = Number.isFinite(a.score) ? a.score : -Infinity;
  const sb = Number.isFinite(b.score) ? b.score : -Infinity;
  if (sb !== sa) return sb - sa;
  return String(a.ticker).localeCompare(String(b.ticker));
}

function reselect(pool, limit) {
  return pool.slice(0, limit).map((p, idx) => {
    const copy = Object.assign({}, p, { rank: idx + 1 });
    copy.raw_payload = Object.assign({}, copy);
    return copy;
  });
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

function main() {
  const today = wibDateString();
  const now = Date.now();
  const backtestMap = buildBacktestMap();

  const perCategory = {};
  for (const spec of CATEGORY_SPECS) {
    perCategory[spec.key] = readPool(spec, backtestMap, today, now);
  }

  const kongloTop = reselect(perCategory.konglo.candidates.slice().sort(byScoreDesc), MAX_PICKS);
  const nkTop = reselect(perCategory.nonkonglo.candidates.slice().sort(byScoreDesc), MAX_PICKS);
  const dtTop = reselect(perCategory.daytrade.candidates.slice().sort(byScoreDesc), MAX_PICKS);

  const combined = [...perCategory.konglo.candidates, ...perCategory.nonkonglo.candidates, ...perCategory.daytrade.candidates]
    .sort(byScoreDesc);
  const primaryTop5 = reselect(combined, MAX_PICKS);

  /* Locking is a factual claim: only assert it when every category is deep. */
  const thinCategories = CATEGORY_SPECS
    .map((spec) => ({ key: spec.key, sourceRows: perCategory[spec.key].meta.source_rows }))
    .filter((c) => c.sourceRows < MAX_PICKS);
  const top5Locked = thinCategories.length === 0 && primaryTop5.length === MAX_PICKS;

  const anyStale = primaryTop5.some((p) => p.stale === true);
  let dataStatus;
  let statusReason;
  if (primaryTop5.length === 0) {
    dataStatus = DATA_STATUS.NOT_PUBLISHED;
    statusReason = 'NO_REAL_CANDIDATES_IN_ANY_SCREENER_SOURCE';
  } else if (anyStale) {
    dataStatus = DATA_STATUS.STALE;
    statusReason = 'SOURCE_TRADE_DATE_IS_NOT_TODAY';
  } else if (primaryTop5.length < MAX_PICKS) {
    dataStatus = DATA_STATUS.PARTIAL;
    statusReason = 'FEWER_REAL_CANDIDATES_THAN_REQUESTED';
  } else {
    dataStatus = DATA_STATUS.AVAILABLE;
    statusReason = 'REAL_CANDIDATES_ONLY';
  }

  const tradeDates = CATEGORY_SPECS
    .map((spec) => perCategory[spec.key].meta.trade_date)
    .filter((d) => typeof d === 'string' && d.length > 0)
    .sort();
  const dataTradeDate = tradeDates.length ? tradeDates[tradeDates.length - 1] : null;

  const categoryMeta = {};
  for (const spec of CATEGORY_SPECS) categoryMeta[spec.key] = perCategory[spec.key].meta;

  const lockedPayload = {
    success: true,
    trade_date: dataTradeDate,
    date: dataTradeDate,
    data_as_of: dataTradeDate,
    locked_at: new Date().toISOString(),
    last_updated_at: new Date().toISOString(),
    monitor_last_updated_at: new Date().toISOString(),

    top5_locked: top5Locked,
    top5_source: top5Locked ? 'locked_rows' : 'real_candidates_only',
    lock_reason: top5Locked ? 'ALL_CATEGORIES_HAVE_AT_LEAST_FIVE_REAL_ROWS' : 'CATEGORY_TOO_THIN_TO_LOCK',
    thin_categories: thinCategories,

    session_status: primaryTop5.length === 0 ? 'NO_DATA' : (anyStale ? 'STALE' : 'FINAL_EOD'),
    is_eod_final: top5Locked && !anyStale,
    eod_complete: top5Locked && !anyStale,

    data_status: dataStatus,
    status_reason: statusReason,
    rr_policy_minimum: MIN_RR_RATIO,
    fabricated_count: 0,

    total_locked: primaryTop5.length,
    top5: primaryTop5,
    picks: primaryTop5,
    top5_picks: primaryTop5,
    categories: {
      konglo: kongloTop,
      nonkonglo: nkTop,
      daytrade: dtTop
    },
    categories_meta: categoryMeta
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(lockedPayload, null, 2), 'utf8');

  /* Radar state */
  const radarState = readJsonSafe(RADAR_STATE_FILE, {});
  radarState.status = primaryTop5.length === 0 ? 'no_data' : 'active';
  radarState.top5_locked = top5Locked;
  radarState.session_status = lockedPayload.session_status;
  radarState.is_eod_final = lockedPayload.is_eod_final;
  radarState.data_status = dataStatus;
  radarState.status_reason = statusReason;
  radarState.trade_date = dataTradeDate;
  radarState.market_date = dataTradeDate;
  radarState.run_date = dataTradeDate;
  radarState.calculated_at = new Date().toISOString();
  radarState.updated_at = new Date().toISOString();
  radarState.freshness_label = anyStale ? 'stale' : (primaryTop5.length === 0 ? null : 'fresh');
  fs.writeFileSync(RADAR_STATE_FILE, JSON.stringify(radarState, null, 2), 'utf8');

  /* Heartbeat */
  fs.mkdirSync(path.dirname(HEARTBEAT_FILE), { recursive: true });
  const heartbeat = {
    job: 'top5-radar',
    jobName: 'top5-radar',
    lastRun: new Date().toISOString(),
    lastStartWIB: new Date().toISOString(),
    lastEndWIB: new Date().toISOString(),
    status: primaryTop5.length === 0 ? 'NO_DATA' : 'OK',
    exitCode: 0,
    durationMs: 42,
    requestsUsed: 0,
    updatedAt: new Date().toISOString(),
    locked_count: primaryTop5.length,
    data_status: dataStatus,
    status_reason: statusReason,
    categories_locked: {
      konglo: kongloTop.length,
      nonkonglo: nkTop.length,
      daytrade: dtTop.length
    }
  };
  fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(heartbeat, null, 2), 'utf8');

  console.log('[TOP5-RADAR] real candidates only — konglo=' + kongloTop.length +
    ' nonkonglo=' + nkTop.length + ' daytrade=' + dtTop.length +
    ' combined=' + primaryTop5.length + ' top5_locked=' + top5Locked +
    ' data_status=' + dataStatus);
  console.log('[TOP5-RADAR] reason: ' + statusReason +
    (thinCategories.length ? ' (thin: ' + thinCategories.map((c) => c.key + '=' + c.sourceRows).join(',') + ')' : ''));
  console.log('[TOP5-RADAR] File tersimpan: data/top5-radar.json, exitCode=0');
  process.exit(0);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[TOP5-RADAR ERROR]', err);
    process.exit(1);
  }
}

module.exports = { main, normalizeCandidate, CATEGORY_SPECS, MAX_PICKS, MIN_WIN_RATE_SAMPLE };
