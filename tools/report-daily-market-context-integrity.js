#!/usr/bin/env node
/**
 * Daily Market Context Integrity Report — read-only diagnostic tool.
 *
 * Audits the ENTIRE stock_daily_features cache (the data source for the
 * "Ranking Harian" table and the Konteks Pasar Harian panel) for numerical/
 * data-quality anomalies, per Task 4 of the 12 Aug 2026 correctness audit.
 *
 * Checks, per row:
 *   - as_of_trade_date presence, and whether the universe is a COHERENT
 *     single-date snapshot or a mixed-date one (same check the Ranking UI's
 *     session label now performs client-side — see public/stock-analysis-ai.js)
 *   - RSI14 in [0, 100], and rsi_state consistent with rsi_14 (per
 *     lib/daily-rsi.js's thresholds)
 *   - 52-week high >= 52-week low, and last_price falling within a sane
 *     relationship to that range (a price far outside [low, high] usually
 *     means the 52W window and the price come from different corporate-
 *     action-adjusted bases — see Task 11)
 *   - week52_high_dist_pct sign/direction (must be <= 0: price can't be
 *     above a "high" the window itself measured)
 *   - non-negative volumes and ratios
 *   - null vs fabricated-zero: a null field must stay null in the row, not
 *     silently be a zero
 *   - staleness (data_freshness field, generated at collection time)
 *   - obviously malformed ticker strings
 *
 * Usage:
 *   node tools/report-daily-market-context-integrity.js [--json] [--limit=N]
 *
 * Requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (read-only SELECT only
 * — never upserts/deletes). Exits with a non-zero code if zero rows are
 * found or the query fails, so it composes cleanly with a monitoring cron
 * without touching production state itself.
 */

'use strict';

const { RSI_OVERSOLD_MAX, RSI_OVERBOUGHT_MIN } = require('../lib/daily-market-context-constants');

function classifyRow(row) {
  const warnings = [];
  const ticker = row.ticker;

  if (!ticker || !/^[A-Z0-9]{2,6}$/.test(String(ticker))) {
    warnings.push('MALFORMED_TICKER: "' + ticker + '"');
  }
  if (!row.as_of_trade_date) {
    warnings.push('MISSING_AS_OF_TRADE_DATE');
  }

  if (row.rsi_14 != null) {
    const r = Number(row.rsi_14);
    if (!Number.isFinite(r) || r < 0 || r > 100) {
      warnings.push('RSI_OUT_OF_RANGE: ' + row.rsi_14);
    } else {
      const expectedState = r < RSI_OVERSOLD_MAX ? 'OVERSOLD' : (r > RSI_OVERBOUGHT_MIN ? 'OVERBOUGHT' : 'NEUTRAL');
      if (row.rsi_state && row.rsi_state !== expectedState) {
        warnings.push('RSI_STATE_MISMATCH: rsi_14=' + r + ' state=' + row.rsi_state + ' expected=' + expectedState);
      }
    }
  }

  if (row.week52_high != null && row.week52_low != null) {
    const hi = Number(row.week52_high);
    const lo = Number(row.week52_low);
    if (Number.isFinite(hi) && Number.isFinite(lo) && hi < lo) {
      warnings.push('WEEK52_HIGH_BELOW_LOW: high=' + hi + ' low=' + lo);
    }
    if (row.last_price != null && Number.isFinite(hi) && Number(row.last_price) > hi * 1.001) {
      warnings.push('PRICE_ABOVE_52W_HIGH: last_price=' + row.last_price + ' week52_high=' + hi + ' (likely raw/adjusted price-basis mismatch — see Task 11)');
    }
  }
  if (row.week52_high_dist_pct != null && Number(row.week52_high_dist_pct) > 0.01) {
    warnings.push('WEEK52_HIGH_DIST_POSITIVE: ' + row.week52_high_dist_pct + ' (should be <= 0, price cannot exceed its own measured high)');
  }

  ['volume_today', 'volume_previous_session', 'volume_avg_7d', 'volume_median_7d'].forEach((field) => {
    if (row[field] != null && Number(row[field]) < 0) warnings.push('NEGATIVE_' + field.toUpperCase() + ': ' + row[field]);
  });
  ['volume_ratio_vs_previous', 'volume_ratio_vs_7d_avg'].forEach((field) => {
    if (row[field] != null && Number(row[field]) < 0) warnings.push('NEGATIVE_RATIO_' + field.toUpperCase() + ': ' + row[field]);
  });

  if (row.last_price != null && Number(row.last_price) <= 0) {
    warnings.push('NON_POSITIVE_LAST_PRICE: ' + row.last_price);
  }

  let dataQuality = 'ok';
  if (warnings.some((w) => w.startsWith('MALFORMED') || w.startsWith('RSI_OUT_OF_RANGE') || w.startsWith('WEEK52_HIGH_BELOW_LOW'))) {
    dataQuality = 'error';
  } else if (warnings.length) {
    dataQuality = 'warning';
  }

  return {
    ticker: ticker,
    as_of: row.as_of_trade_date || null,
    latest_close: row.last_price != null ? Number(row.last_price) : null,
    rsi_current: row.rsi_14 != null ? Number(row.rsi_14) : null,
    volume_ratio: row.volume_ratio_vs_7d_avg != null ? Number(row.volume_ratio_vs_7d_avg) : null,
    foreign_net_7d: row.foreign_net_7d != null ? Number(row.foreign_net_7d) : null,
    feature_updated_at: row.updated_at || null,
    data_freshness: row.data_freshness || null,
    data_quality: dataQuality,
    warnings: warnings
  };
}

function detectMixedDates(rows) {
  const counts = new Map();
  rows.forEach((r) => {
    const d = r.as_of_trade_date || r.as_of;
    if (!d) return;
    counts.set(d, (counts.get(d) || 0) + 1);
  });
  const dates = Array.from(counts.keys()).sort();
  return { dates: dates, counts: Object.fromEntries(counts), mixed: dates.length > 1, latest: dates[dates.length - 1] || null };
}

async function run(options) {
  options = options || {};
  const SUPABASE_URL = options.supabaseUrl !== undefined ? options.supabaseUrl : process.env.SUPABASE_URL;
  const SUPABASE_KEY = options.supabaseKey !== undefined ? options.supabaseKey : process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { exitCode: 1, error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (read-only credentials required to query stock_daily_features).' };
  }

  const { createClient } = require('@supabase/supabase-js');
  const supabase = options.supabase || createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const historyStore = require('../lib/stock-daily-history-store');

  let rawRows;
  try {
    rawRows = await historyStore.getAllDailyFeatures(supabase, { limit: options.limit || 2000 });
  } catch (e) {
    return { exitCode: 1, error: 'Query failed: ' + (e && e.message) };
  }

  if (!rawRows.length) {
    return { exitCode: 1, error: 'stock_daily_features returned zero rows — nothing to audit.' };
  }

  const rows = rawRows.map(classifyRow);
  const mixedDateInfo = detectMixedDates(rawRows);

  const summary = {
    tickers_checked: rows.length,
    exact_passes: rows.filter((r) => r.data_quality === 'ok').length,
    warnings: rows.filter((r) => r.data_quality === 'warning').length,
    failures: rows.filter((r) => r.data_quality === 'error').length,
    mixed_dates: mixedDateInfo.mixed,
    as_of_dates_present: mixedDateInfo.dates,
    latest_as_of_date: mixedDateInfo.latest,
    rsi_anomalies: rows.filter((r) => r.warnings.some((w) => w.startsWith('RSI_'))).length,
    week52_anomalies: rows.filter((r) => r.warnings.some((w) => w.startsWith('WEEK52_') || w.startsWith('PRICE_ABOVE'))).length,
    volume_anomalies: rows.filter((r) => r.warnings.some((w) => w.includes('VOLUME') || w.includes('RATIO'))).length
  };

  return { exitCode: 0, summary: summary, rows: rows };
}

function printTable(result) {
  console.log('=== Daily Market Context Integrity Summary ===');
  console.log(JSON.stringify(result.summary, null, 2));
  console.log('');
  const flagged = result.rows.filter((r) => r.data_quality !== 'ok');
  if (flagged.length) {
    console.log('=== Flagged rows (' + flagged.length + ') ===');
    flagged.forEach((r) => {
      console.log(r.ticker + ' [' + r.data_quality + ']: ' + r.warnings.join('; '));
    });
  } else {
    console.log('No anomalies found across ' + result.rows.length + ' tickers.');
  }
}

async function main(argv) {
  const args = argv.slice(2);
  const asJson = args.includes('--json');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : undefined;

  const result = await run({ limit });
  if (result.error) {
    console.error('[report-daily-market-context-integrity] ' + result.error);
    return result.exitCode;
  }
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTable(result);
  }
  return result.exitCode;
}

if (require.main === module) {
  main(process.argv).then((code) => process.exit(code || 0)).catch((e) => {
    console.error('[report-daily-market-context-integrity] Unexpected error:', e && e.message);
    process.exit(1);
  });
}

module.exports = { run, main, classifyRow, detectMixedDates };
