'use strict';

/**
 * DeepScan long-horizon data contract.
 *
 * Heavy market history is prepared once per weekly DeepScan cycle into
 * data/deepscan-history/. Runtime scoring then consumes one ticker at a time,
 * keeping memory bounded while still allowing formulas to use every completed
 * daily candle requested from 2020-01-01 through the latest refresh date.
 */

const fs = require('fs');
const path = require('path');
const fcaTransition2026 = require('./fca-transition-2026');
const { isValidIdxTicker } = require('./idx-ticker');
const bandarmologiFlow = require('./bandarmologi-flow');
const dailyPbv = require('./daily-pbv');

const FULL_HISTORY_START = '2020-01-01';
const FULL_HISTORY_DIR = 'deepscan-history';
const UNIVERSE_QUERY_LIMIT = 2000;
const FUNDAMENTAL_QUERY_CHUNK = 250;

function safeTicker(value) {
  return fcaTransition2026.normalizeTicker(value);
}

function normalizeCandle(row) {
  if (!row || typeof row !== 'object') return null;
  const date = String(row.date || row.time || '').slice(0, 10);
  const open = Number(row.open);
  const high = Number(row.high);
  const low = Number(row.low);
  const close = Number(row.close);
  const volume = Number(row.volume);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (![open, high, low, close].every(Number.isFinite)) return null;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || high < low) return null;
  return {
    date,
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) && volume >= 0 ? volume : 0
  };
}

function normalizeCandles(rows) {
  const byDate = new Map();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const candle = normalizeCandle(row);
    if (!candle || candle.date < FULL_HISTORY_START) continue;
    byDate.set(candle.date, candle);
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function historyFilePath(rootDir, ticker) {
  return path.join(rootDir || process.cwd(), 'data', FULL_HISTORY_DIR, safeTicker(ticker) + '.json');
}

function loadFullHistoryForTicker(rootDir, ticker) {
  const filePath = historyFilePath(rootDir, ticker);
  if (!fs.existsSync(filePath)) {
    return {
      ticker: safeTicker(ticker),
      complete: false,
      reason: 'missing_history_cache',
      candles: [],
      requested_from: null,
      requested_to: null,
      source: null
    };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rows = Array.isArray(raw) ? raw : raw.candles;
    const candles = normalizeCandles(rows);
    const requestedFrom = Array.isArray(raw) ? null : String(raw.requested_from || '');
    const requestedTo = Array.isArray(raw) ? null : String(raw.requested_to || '');
    const complete = requestedFrom && requestedFrom <= FULL_HISTORY_START && candles.length >= 30;
    return {
      ticker: safeTicker(ticker),
      complete: Boolean(complete),
      reason: complete ? null : 'history_not_requested_from_2020',
      candles,
      requested_from: requestedFrom || null,
      requested_to: requestedTo || null,
      source: Array.isArray(raw) ? null : (raw.source || null),
      first_date: candles.length ? candles[0].date : null,
      last_date: candles.length ? candles[candles.length - 1].date : null,
      candle_count: candles.length,
      generated_at: Array.isArray(raw) ? null : (raw.generated_at || null)
    };
  } catch (_) {
    return {
      ticker: safeTicker(ticker),
      complete: false,
      reason: 'invalid_history_cache',
      candles: [],
      requested_from: null,
      requested_to: null,
      source: null
    };
  }
}

function yearFraction(firstDate, lastDate) {
  const a = Date.parse(String(firstDate || '') + 'T00:00:00Z');
  const b = Date.parse(String(lastDate || '') + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return (b - a) / (365.2425 * 86400000);
}

function computeFullHistoryMetrics(candles) {
  const rows = normalizeCandles(candles);
  if (!rows.length) return null;

  const closes = rows.map((row) => row.close);
  const first = rows[0];
  const last = rows[rows.length - 1];
  const years = yearFraction(first.date, last.date);
  const totalReturnPct = first.close > 0 ? ((last.close / first.close) - 1) * 100 : null;
  const cagrPct = first.close > 0 && last.close > 0 && years > 0
    ? (Math.pow(last.close / first.close, 1 / years) - 1) * 100
    : null;

  let peak = rows[0].close;
  let maxDrawdownPct = 0;
  let low = rows[0].low;
  let high = rows[0].high;
  let positiveDays = 0;
  let tradedValueSum = 0;

  const yearlyFirst = new Map();
  const yearlyLast = new Map();

  rows.forEach((row, index) => {
    peak = Math.max(peak, row.close);
    if (peak > 0) {
      const dd = ((row.close / peak) - 1) * 100;
      maxDrawdownPct = Math.min(maxDrawdownPct, dd);
    }
    low = Math.min(low, row.low);
    high = Math.max(high, row.high);
    tradedValueSum += row.close * row.volume;
    if (index > 0 && row.close >= rows[index - 1].close) positiveDays += 1;

    const year = row.date.slice(0, 4);
    if (!yearlyFirst.has(year)) yearlyFirst.set(year, row.close);
    yearlyLast.set(year, row.close);
  });

  let positiveYears = 0;
  let observedYears = 0;
  for (const [year, firstClose] of yearlyFirst.entries()) {
    const lastClose = yearlyLast.get(year);
    if (firstClose > 0 && lastClose > 0) {
      observedYears += 1;
      if (lastClose >= firstClose) positiveYears += 1;
    }
  }

  const rangePositionPct = high > low ? ((last.close - low) / (high - low)) * 100 : 50;
  const positiveDayRatio = rows.length > 1 ? positiveDays / (rows.length - 1) : 0.5;
  const positiveYearRatio = observedYears ? positiveYears / observedYears : 0.5;

  return {
    first_date: first.date,
    last_date: last.date,
    candle_count: rows.length,
    years_observed: Number(years.toFixed(2)),
    total_return_pct: totalReturnPct == null ? null : Number(totalReturnPct.toFixed(2)),
    cagr_pct: cagrPct == null ? null : Number(cagrPct.toFixed(2)),
    max_drawdown_pct: Number(maxDrawdownPct.toFixed(2)),
    all_time_low_since_2020: low,
    all_time_high_since_2020: high,
    range_position_pct: Number(rangePositionPct.toFixed(2)),
    positive_day_ratio: Number(positiveDayRatio.toFixed(4)),
    positive_year_ratio: Number(positiveYearRatio.toFixed(4)),
    average_daily_traded_value: rows.length ? tradedValueSum / rows.length : 0
  };
}

function scoreFullHistory(metrics, lastPrice, ma200) {
  if (!metrics) return { score: 0, reasons: ['full_history_missing'] };
  let score = 0;
  const reasons = [];

  if (metrics.cagr_pct != null) {
    if (metrics.cagr_pct >= 12) { score += 6; reasons.push('CAGR>=12%'); }
    else if (metrics.cagr_pct >= 0) { score += 3; reasons.push('CAGR_non_negative'); }
    else if (metrics.cagr_pct <= -12) { score -= 4; reasons.push('CAGR<=-12%'); }
  }

  if (metrics.max_drawdown_pct >= -35) { score += 4; reasons.push('drawdown_controlled'); }
  else if (metrics.max_drawdown_pct <= -70) { score -= 3; reasons.push('drawdown_extreme'); }

  if (metrics.positive_year_ratio >= 0.6) { score += 4; reasons.push('multi_year_consistency'); }
  else if (metrics.positive_year_ratio < 0.4) { score -= 2; reasons.push('multi_year_weakness'); }

  if (ma200 && lastPrice >= ma200) { score += 4; reasons.push('above_MA200'); }
  else if (ma200 && lastPrice < ma200) { score -= 2; reasons.push('below_MA200'); }

  if (metrics.positive_day_ratio >= 0.5) { score += 2; reasons.push('positive_day_balance'); }

  return { score: Math.max(-10, Math.min(20, score)), reasons };
}

async function loadContinuousAuctionUniverse(db, fallbackTickers) {
  if (db && typeof db.from === 'function') {
    const res = await db
      .from('stock_boards')
      .select('ticker,board,is_active,is_fca,note')
      .eq('is_active', true)
      .limit(UNIVERSE_QUERY_LIMIT);
    if (res.error) throw new Error('deepscan_universe_query_failed');

    return Array.from(new Set((res.data || [])
      .filter((row) => fcaTransition2026.isEligibleContinuousAuctionRow(row))
      .map((row) => safeTicker(row.ticker))
      .filter(isValidIdxTicker)))
      .sort();
  }

  return Array.from(new Set((fallbackTickers || [])
    .map(safeTicker)
    .filter(isValidIdxTicker)))
    .sort();
}

async function loadFundamentalsMap(db, tickers) {
  const map = new Map();
  if (!db || typeof db.from !== 'function') return map;

  const universe = Array.from(new Set((tickers || []).map(safeTicker).filter(isValidIdxTicker)));
  for (let i = 0; i < universe.length; i += FUNDAMENTAL_QUERY_CHUNK) {
    const chunk = universe.slice(i, i + FUNDAMENTAL_QUERY_CHUNK);
    const res = await db.from('stock_fundamentals').select('*').in('ticker', chunk);
    if (res.error) throw new Error('deepscan_fundamentals_query_failed');
    (res.data || []).forEach((row) => {
      const ticker = safeTicker(row && row.ticker);
      if (ticker) map.set(ticker, row);
    });
  }
  return map;
}

function buildFundamentalContext(lastPrice, fundamentalsRow) {
  const pbv = dailyPbv.buildPbvContext(lastPrice, fundamentalsRow);
  let score = 0;
  const reasons = [];

  if (!pbv.data_available) {
    return {
      score: 0,
      reasons: ['verified_financial_missing'],
      data_available: false,
      pbv: null,
      book_value_per_share: pbv.book_value_per_share,
      fundamental_period: pbv.fundamental_period,
      fundamental_source: pbv.fundamental_source
    };
  }

  score += 2;
  reasons.push('verified_financial_present');

  if (pbv.pbv != null) {
    if (pbv.pbv > 0 && pbv.pbv <= 1.5) { score += 6; reasons.push('PBV<=1.5'); }
    else if (pbv.pbv <= 3) { score += 4; reasons.push('PBV<=3'); }
    else if (pbv.pbv <= 6) { score += 2; reasons.push('PBV<=6'); }
    else if (pbv.pbv > 10) { score -= 2; reasons.push('PBV>10'); }
  }

  return {
    score: Math.max(-2, Math.min(8, score)),
    reasons,
    data_available: true,
    pbv: pbv.pbv,
    book_value_per_share: pbv.book_value_per_share,
    fundamental_period: pbv.fundamental_period,
    fundamental_source: pbv.fundamental_source,
    fundamental_updated_at: pbv.fundamental_updated_at
  };
}

function brokerRoot(rootDir) {
  return path.join(rootDir || process.cwd(), 'data', 'arjum-data', 'broker-summary');
}

function scoreBrokerSummary(summary) {
  if (!summary) return { score: 0, reasons: [] };
  let score = 0;
  const reasons = [];

  if (summary.cr3Buy >= 60 && summary.cr3Buy > summary.cr3Sell) {
    score += 8;
    reasons.push('CR3_buy_dominant');
  } else if (summary.cr3Buy >= 50 && summary.cr3Buy >= summary.cr3Sell) {
    score += 4;
    reasons.push('CR3_buy_moderate');
  }

  if (summary.cr5Buy >= 70 && summary.cr5Buy > summary.cr5Sell) {
    score += 4;
    reasons.push('CR5_buy_dominant');
  }

  if (summary.foreignNet > 0) {
    score += 5;
    reasons.push('foreign_net_positive');
  } else if (summary.foreignNet < 0) {
    score -= 3;
    reasons.push('foreign_net_negative');
  }

  if (summary.retailNet < 0 && summary.foreignNet > 0) {
    score += 3;
    reasons.push('retail_sell_foreign_accumulation');
  }

  if (summary.cr3Sell >= 60 && summary.cr3Sell > summary.cr3Buy) {
    score -= 4;
    reasons.push('CR3_sell_dominant');
  }

  return { score: Math.max(-10, Math.min(20, score)), reasons };
}

function loadBrokerContext(rootDir, ticker) {
  const root = brokerRoot(rootDir);
  const dates = bandarmologiFlow.listBrokerDates(root, ticker);
  if (!dates.length) return null;

  // DeepScan broker formula is a 3-6 month accumulation view. Do not parse the
  // entire multi-year broker directory just to discover its bounds: list dates
  // once, then aggregate only the recent bounded window.
  const anchorDate = dates[dates.length - 1];
  const recent = bandarmologiFlow.bandarForTickerWindow(root, ticker, 90, anchorDate);
  if (!recent) return null;
  const score = scoreBrokerSummary(recent.summary);

  return {
    ticker: safeTicker(ticker),
    from: dates[0],
    to: anchorDate,
    sessions_all: dates.length,
    sessions_recent: recent.sessions,
    cr3: Number(recent.summary.cr3Buy.toFixed(2)),
    cr5: Number(recent.summary.cr5Buy.toFixed(2)),
    cr3_sell: Number(recent.summary.cr3Sell.toFixed(2)),
    cr5_sell: Number(recent.summary.cr5Sell.toFixed(2)),
    foreign_net: recent.summary.foreignNet,
    retail_net: recent.summary.retailNet,
    turnover: recent.summary.turnover,
    score: score.score,
    score_reasons: score.reasons
  };
}

module.exports = {
  FULL_HISTORY_START,
  FULL_HISTORY_DIR,
  safeTicker,
  normalizeCandle,
  normalizeCandles,
  historyFilePath,
  loadFullHistoryForTicker,
  computeFullHistoryMetrics,
  scoreFullHistory,
  loadContinuousAuctionUniverse,
  loadFundamentalsMap,
  buildFundamentalContext,
  loadBrokerContext,
  scoreBrokerSummary
};
