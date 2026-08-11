/**
 * Daily foreign flow context — descriptive stats over the last 7 TRADING
 * SESSIONS, computed from `foreign_watchlist_daily` rows.
 *
 * Units: `foreign_net` in this repository's only populated foreign source is
 * an IDR VALUE (close * nbsa) — see lib/admin-foreign-upload.js. There is no
 * verified buy/sell-in-lots split available, so `foreign_buy`/`foreign_sell`
 * pass through as-is (usually null) and are never invented.
 *
 * A trading session with NO row (upload gap) or a row with `foreign_net ===
 * null` is treated as MISSING, not zero — it is excluded from sums/averages
 * and counted separately so data-quality is visible to callers.
 *
 * `rows` must be newest-first, already limited to real trading sessions
 * (weekends/holidays excluded upstream).
 */

'use strict';

function numOrNull(v) {
  if (v == null) return null;
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sumWindow(rows, windowSize) {
  var window = rows.slice(0, windowSize);
  var missing = 0;
  var sum = 0;
  var haveAny = false;
  for (var row of window) {
    var net = numOrNull(row && row.foreign_net);
    if (net == null) { missing++; continue; }
    sum += net;
    haveAny = true;
  }
  return {
    value: haveAny ? Math.round(sum) : null,
    sessions_counted: window.length - missing,
    sessions_missing: missing,
    window_size: window.length
  };
}

function buildForeignContext(rows) {
  rows = Array.isArray(rows) ? rows : [];
  var window7 = rows.slice(0, 7);

  var netToday = rows.length ? numOrNull(rows[0].foreign_net) : null;

  var positiveDays = 0;
  var negativeDays = 0;
  for (var row of window7) {
    var net = numOrNull(row.foreign_net);
    if (net == null) continue;
    if (net > 0) positiveDays++;
    else if (net < 0) negativeDays++;
  }

  var streak = 0;
  var streakSign = null;
  for (var r of rows) {
    var net = numOrNull(r.foreign_net);
    if (net == null || net === 0) break;
    var sign = net > 0 ? 1 : -1;
    if (streakSign == null) streakSign = sign;
    if (sign !== streakSign) break;
    streak++;
  }

  var d3 = sumWindow(rows, 3);
  var d5 = sumWindow(rows, 5);
  var d7 = sumWindow(rows, 7);

  return {
    foreign_net_today: netToday,
    foreign_net_today_missing: rows.length ? netToday == null : true,
    foreign_net_3d: d3.value,
    foreign_net_5d: d5.value,
    foreign_net_7d: d7.value,
    foreign_net_7d_data_quality: d7.sessions_missing > 0 ? 'partial' : 'ok',
    foreign_net_7d_sessions_missing: d7.sessions_missing,
    foreign_positive_days_7d: positiveDays,
    foreign_negative_days_7d: negativeDays,
    foreign_net_streak: streakSign == null ? 0 : streak * streakSign,
    unit: 'IDR_VALUE',
    foreign_history_7d: window7.map(function(r) {
      return {
        trade_date: r.trade_date,
        foreign_buy: numOrNull(r.foreign_buy),
        foreign_sell: numOrNull(r.foreign_sell),
        foreign_net: numOrNull(r.foreign_net),
        unit: 'IDR_VALUE'
      };
    }).reverse() // oldest-first for chart display
  };
}

module.exports = {
  buildForeignContext
};
