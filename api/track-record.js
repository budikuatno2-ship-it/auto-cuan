'use strict';

/**
 * api/track-record.js
 * ============================================================================
 * Endpoint API Track Record Evaluasi Sinyal Riil Auto-Cuan — V5 P0 hardened
 * ============================================================================
 *
 * WHAT CHANGED IN V5 P0 (BUG-V5-P0-003 + P0-002 / P0-005)
 *   BEFORE: the `signals` array was a *fabricated ledger*. For each of the first
 *   50 backtest tickers this file computed:
 *       entry   = 1500 + (idx * 25)          // invented price ladder
 *       last_price = entry ± 120 / 80 / 10   // invented outcome, chosen by idx % 4
 *       status  = idx % 5 / 6 / 4 cycling through
 *                 RUNNING / WAITING_ENTRY / SL_HIT / TP1_HIT
 *       gain_pct, max_gain_pct, holding_period, rr: 1.5  // all literals
 *   None of that came from a source. The endpoint then published aggregate
 *   win rates (66.9% / 77.2% / 82.1%) and hit counts (2663 / 820 / 397) as hard
 *   literals beside it, and `resolved_win_rate: '87.5%'`.
 *
 *   AFTER: every published number is read from
 *   `bukti-verifikasi-final/backtest-individual-964.json` and aggregated.
 *   There is no per-trade ledger in that file, so outcome-level fields
 *   (`tp1_hits`, `running_signals`, `sl_rate`, …) are `null` and an explicit
 *   `unavailable_reason` explains why. Per-ticker rows publish only the metrics
 *   the file actually contains; every price field is `null`.
 *
 * CONTRACT
 *   - No numeric literal is substituted for a missing datum.
 *   - Aggregates are sums/ratios over real rows, never typed constants.
 *   - A win rate below the minimum sample is still shown (it is real data) but
 *     is flagged `win_rate_qualified: false` rather than presented as a result.
 *   - `status`/`outcome` are `null`: the source has no per-trade outcome, so no
 *     verdict is asserted. Nothing here is publishable as a BUY.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');

const contract = require('../lib/market-data-contract.js');
const readiness = require('../lib/readiness-engine.js');

const { DATA_STATUS, pickNumber, pickText, numberOrNull } = contract;

const ROOT = path.resolve(__dirname, '..');
const BACKTEST_FILE = path.join(ROOT, 'bukti-verifikasi-final', 'backtest-individual-964.json');

/** Minimum trade count for a win rate to count as a qualification (see N23). */
const MIN_WIN_RATE_SAMPLE = 10;

/** How many per-ticker rows are surfaced (the summary covers the whole file). */
const MAX_SIGNAL_ROWS = 50;

let _cachedTrackRecord = null;

/* -------------------------------------------------------------------------- */
/* Source read                                                                */
/* -------------------------------------------------------------------------- */

function readBacktestFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BACKTEST_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Aggregation — every figure is derived, none is typed                       */
/* -------------------------------------------------------------------------- */

/**
 * Weighted win rate: Σ(winRatePct × tradesCount) / Σ tradesCount.
 *
 * Weighting by trade count is the only defensible aggregation when tickers have
 * wildly different sample sizes. A plain mean of percentages lets a single
 * 1-trade ticker carry the same weight as a 40-trade ticker — the mechanism
 * behind the old "82.1% Top 5" claim.
 */
function weightedWinRate(rows) {
  let weight = 0;
  let weighted = 0;
  for (const row of rows) {
    const trades = numberOrNull(row && row.tradesCount);
    const winRate = numberOrNull(row && row.winRatePct);
    if (trades === null || winRate === null || trades <= 0) continue;
    weight += trades;
    weighted += winRate * trades;
  }
  if (weight <= 0) return null;
  const value = weighted / weight;
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2))
    : Number(sorted[mid].toFixed(2));
}

/** Per-method aggregate: how each strategy actually performed. */
function aggregateByMethod(rows) {
  const groups = new Map();
  for (const row of rows) {
    const methodId = pickText(row && row.bestMethodId, row && row.bestMethodName);
    if (!methodId) continue;
    if (!groups.has(methodId)) {
      groups.set(methodId, {
        method_id: methodId,
        method_name: pickText(row && row.bestMethodName) || methodId,
        tickers: [],
        rows: []
      });
    }
    const g = groups.get(methodId);
    g.rows.push(row);
    if (row && row.ticker) g.tickers.push(String(row.ticker).toUpperCase());
  }

  const out = [];
  for (const g of groups.values()) {
    const qualified = g.rows.filter((r) => {
      const t = numberOrNull(r.tradesCount);
      return t !== null && t >= MIN_WIN_RATE_SAMPLE;
    });
    out.push({
      method_id: g.method_id,
      method_name: g.method_name,
      tickers_count: g.tickers.length,
      qualified_tickers_count: qualified.length,
      // Weighted over ALL tickers; the qualified-only figure is reported
      // separately so a tiny sample cannot inflate the headline.
      win_rate_pct: weightedWinRate(g.rows),
      win_rate_pct_qualified_only: qualified.length > 0 ? weightedWinRate(qualified) : null,
      median_wilson_lower_bound_pct: median(g.rows.map((r) => numberOrNull(r.wilsonLowerBoundPct)).filter((v) => v !== null))
    });
  }

  return out.sort((a, b) => (b.tickers_count - a.tickers_count) || String(a.method_id).localeCompare(String(b.method_id)));
}

/** Per-horizon aggregate (the file's `bestBrokerHorizon`). */
function aggregateByHorizon(rows) {
  const groups = new Map();
  for (const row of rows) {
    const horizon = pickText(row && row.bestBrokerHorizon);
    if (!horizon) continue;
    if (!groups.has(horizon)) groups.set(horizon, []);
    groups.get(horizon).push(row);
  }
  const out = [];
  for (const [horizon, group] of groups.entries()) {
    out.push({
      horizon,
      tickers_count: group.length,
      win_rate_pct: weightedWinRate(group),
      median_wilson_lower_bound_pct: median(group.map((r) => numberOrNull(r.wilsonLowerBoundPct)).filter((v) => v !== null))
    });
  }
  return out.sort((a, b) => (b.tickers_count - a.tickers_count));
}

/* -------------------------------------------------------------------------- */
/* Row builder — one real ticker, no invented prices                          */
/* -------------------------------------------------------------------------- */

/**
 * Build one published row from a REAL backtest record.
 *
 * The file carries *statistics per ticker*, not trade quotes. Every price
 * field is therefore `null`, and `status`/`outcome` are `null` because the file
 * holds no per-trade result. `readiness_status` is `INSUFFICIENT_DATA` by
 * construction: a backtest statistic is not an actionable setup, and the engine
 * says so rather than inventing entry/SL/TP to satisfy it.
 *
 * @param {object} row
 * @param {number} index
 * @returns {object}
 */
function buildSignalRow(row, index) {
  const ticker = String(pickText(row.ticker) || '').toUpperCase() || null;
  const trades = pickNumber(row.tradesCount);
  const winRate = pickNumber(row.winRatePct);
  const winRateQualified = trades !== null && trades >= MIN_WIN_RATE_SAMPLE;

  const built = {
    id: index + 1,
    ticker,
    category: 'Backtest',
    source: 'backtest_individual_964',
    source_short: 'Backtest',
    record_type: 'BACKTEST_STATISTIC',

    // Real metrics from the file.
    total_bars_tested: pickNumber(row.totalBarsTested),
    trades_count: trades,
    win_rate_pct: winRate,
    wilson_lower_bound_pct: pickNumber(row.wilsonLowerBoundPct),
    win_rate_qualified: winRateQualified,
    win_rate_sample_size: trades,
    profit_factor: pickNumber(row.profitFactor),
    expectancy_pct: pickNumber(row.expectancyPct),
    max_drawdown_pct: pickNumber(row.maxDrawdownPct),

    best_method_id: pickText(row.bestMethodId),
    best_method_name: pickText(row.bestMethodName),
    best_broker_horizon: pickText(row.bestBrokerHorizon),
    dominant_flow_driver: pickText(row.dominantFlowDriver),

    // No price or outcome exists for a statistical backtest record.
    entry1: null,
    entry2: null,
    last_price: null,
    sl: null,
    stop_loss: null,
    tp1: null,
    tp2: null,
    rr: null,
    gain_pct: null,
    max_gain_pct: null,
    holding_period: null,
    date: null,
    status: null,
    outcome: null,
    status_label: null,
    action: null
  };

  // Route the (always-absent) verdict through the single authority so a future
  // caller cannot make this list actionable by adding prices here: the engine
  // would still have to return READY, and it never will for a row without a
  // complete, gate-passing plan.
  const verdict = readiness.evaluate(built, { minRiskReward: undefined });
  built.readiness_status = verdict.status;
  built.verdict_reasons = verdict.reasons;

  return contract.attachProvenance(built, {
    source: 'bukti-verifikasi-final/backtest-individual-964.json',
    tradeDate: pickText(row.tradeDate, row.date) || null,
    status: winRateQualified ? DATA_STATUS.AVAILABLE : DATA_STATUS.PARTIAL,
    extra: {
      sampleQualified: winRateQualified,
      note: winRateQualified ? null : 'sample below ' + MIN_WIN_RATE_SAMPLE + ' trades'
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Payload                                                                    */
/* -------------------------------------------------------------------------- */

function buildTrackRecordPayload() {
  if (_cachedTrackRecord) return _cachedTrackRecord;

  const file = readBacktestFile();
  const rows = file && Array.isArray(file.tickers) ? file.tickers.filter((r) => r && typeof r === 'object') : [];
  const meta = (file && file.metadata) || {};

  if (rows.length === 0) {
    _cachedTrackRecord = {
      success: false,
      error: 'BACKTEST_FILE_UNREADABLE',
      data_status: DATA_STATUS.SOURCE_UNAVAILABLE,
      trade_date: null,
      as_of: null,
      summary: null,
      by_category: {},
      category_meta: {},
      signals: []
    };
    return _cachedTrackRecord;
  }

  const qualified = rows.filter((r) => {
    const t = numberOrNull(r.tradesCount);
    return t !== null && t >= MIN_WIN_RATE_SAMPLE;
  });

  const totalTrades = rows.reduce((sum, r) => {
    const t = numberOrNull(r.tradesCount);
    return sum + (t === null ? 0 : t);
  }, 0);

  const signals = rows
    .slice()
    .sort((a, b) => {
      const ta = numberOrNull(a.tradesCount) || 0;
      const tb = numberOrNull(b.tradesCount) || 0;
      if (tb !== ta) return tb - ta;
      return String(a.ticker || '').localeCompare(String(b.ticker || ''));
    })
    .slice(0, MAX_SIGNAL_ROWS)
    .map((row, idx) => buildSignalRow(row, idx));

  const overallWinRate = weightedWinRate(rows);
  const overallWinRateQualified = weightedWinRate(qualified);

  const payload = {
    success: true,

    // The date the source file describes, not the wall clock.
    trade_date: pickText(meta.generatedAt) ? String(meta.generatedAt).slice(0, 10) : null,
    as_of: pickText(meta.generatedAt) || null,
    data_status: DATA_STATUS.AVAILABLE,
    fabricated_count: 0,

    summary: {
      // Real counts.
      total_tickers_tested: pickNumber(meta.totalTickersTested) !== null
        ? pickNumber(meta.totalTickersTested) : rows.length,
      total_trades_simulated: pickNumber(meta.totalTradesSimulated) !== null
        ? pickNumber(meta.totalTradesSimulated) : totalTrades,
      qualified_tickers: qualified.length,
      tickers_below_min_sample: rows.length - qualified.length,
      min_win_rate_sample: MIN_WIN_RATE_SAMPLE,

      // Weighted rates (trade-count weighted, not a mean of percentages).
      win_rate_pct: overallWinRate,
      win_rate_pct_qualified_only: overallWinRateQualified,
      // The file's own headline, published unchanged for cross-checking.
      source_reported_average_win_rate_pct: pickNumber(meta.averageWinRatePct),

      // No per-trade ledger exists in the source. These are explicitly unknown
      // rather than the literals this file used to emit (2663 / 820 / 397 …).
      total_signals: null,
      total_resolved: null,
      running_signals: null,
      waiting_signals: null,
      tp1_hits: null,
      tp2_hits: null,
      sl_hits: null,
      expired_signals: null,
      win_rate_tp1: null,
      win_rate_tp2: null,
      sl_rate: null,
      resolved_win_rate: null,
      best_gain: null,

      unavailable_reason:
        'backtest-individual-964.json holds per-ticker strategy statistics only. It has no per-trade ledger, so resolved/running/TP1/TP2/SL counts and the best single gain cannot be derived from it. They are reported null instead of invented.'
    },

    by_method: aggregateByMethod(rows),
    by_horizon: aggregateByHorizon(rows),

    // Kept for response-shape compatibility. The source does not classify
    // tickers into these channels, so each entry carries null counts and the
    // aggregate only.
    by_category: {
      daytrade: { label: 'Day Trade', total: null, win_rate_tp1: null, channel_available: false },
      swing_konglo: { label: 'Swing Konglomerasi', total: null, win_rate_tp1: null, channel_available: false },
      swing_nk: { label: 'Swing Non-Konglomerasi', total: null, win_rate_tp1: null, channel_available: false },
      top5: {
        label: 'Top 5 Radar',
        total: null,
        win_rate_tp1: overallWinRate,
        channel_available: false,
        note: 'source has no channel classification; the aggregate weighted rate is reported'
      }
    },
    category_meta: {
      daytrade: { icon: '\u26a1', label: 'Day Trade', description: 'Sinyal scalping & momentum intraday' },
      swing_konglo: { icon: '\ud83c\udfe2', label: 'Swing Konglomerasi', description: 'Saham grup konglomerasi akumulasi kuat' },
      swing_nk: { icon: '\ud83d\ude80', label: 'Swing Non-Konglomerasi', description: 'Saham non-konglo momentum tinggi' },
      top5: { icon: '\ud83c\udfaf', label: 'Top 5 Radar', description: 'Rekomendasi harian terbaik terkunci' }
    },

    signals
  };

  _cachedTrackRecord = payload;
  return payload;
}

module.exports = async function handler(req, res) {
  try {
    const payload = buildTrackRecordPayload();
    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');
    }
    if (res && typeof res.status === 'function') {
      return res.status(200).json(payload);
    }
    return payload;
  } catch (err) {
    if (res && typeof res.status === 'function') {
      return res.status(500).json({ success: false, error: err.message });
    }
    throw err;
  }
};

module.exports.buildTrackRecordPayload = buildTrackRecordPayload;
module.exports.buildSignalRow = buildSignalRow;
module.exports.weightedWinRate = weightedWinRate;
module.exports.MIN_WIN_RATE_SAMPLE = MIN_WIN_RATE_SAMPLE;
