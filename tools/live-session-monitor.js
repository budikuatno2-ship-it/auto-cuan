'use strict';

/**
 * Batch 19 — Live Session Monitor (read-only observability)
 *
 * Answers, for a given instant, "is each live path allowed to run right now, and
 * if not, why?" by composing the guards built across Batches 2–18 into one view:
 *
 *   - IDX session state        (lib/market-hours-guard.js)
 *   - Telegram monitor gate    (tools/run-telegram-monitor-local.js semantics)
 *   - Fast Watcher guarded-live (lib/intraday-fast-watcher-guarded-live.js kill-switch)
 *   - Intraday volume-pace market_state (lib/intraday-volume-pace.js)
 *
 * Read-only: never sends, never mutates state. Safe to run during a live session.
 *
 * Usage:
 *   node tools/live-session-monitor.js                 # now
 *   node tools/live-session-monitor.js --at 2026-09-17T05:45:00Z
 *   node tools/live-session-monitor.js --json
 */

const marketHours = require('../lib/market-hours-guard');
const volumePace = require('../lib/intraday-volume-pace');
const guardedLive = require('../lib/intraday-fast-watcher-guarded-live');

function jakartaDateStr(date) {
  const wib = marketHours.getWibComponents(date);
  return wib.isValid ? wib.dateStr : null;
}

function jakartaTimeStr(date) {
  const wib = marketHours.getWibComponents(date);
  return wib.isValid ? wib.timeStr : null;
}

/**
 * Pure: build the consolidated live-session report for an instant.
 * @param {Date|string|number} [now]
 * @param {Object} [env] - environment for the fast-watcher kill-switch (defaults to process.env)
 */
function buildLiveSessionReport(now, env) {
  const date = now == null ? new Date() : new Date(now);
  const session = marketHours.getMarketSession(date);
  const isOpen = marketHours.isMarketOpen(date);
  const timeStr = jakartaTimeStr(date);
  const dateStr = jakartaDateStr(date);

  // Telegram monitor path: allowed only during an active session (mirrors
  // run-telegram-monitor-local.js isMarketSessionWib()).
  const telegramMonitor = {
    allowed: isOpen,
    reason: isOpen ? null : (session === 'CLOSED' ? 'outside_trading_hours' : 'market_closed')
  };

  // Fast Watcher guarded-live: needs BOTH the kill-switch on AND an active session.
  const liveEnabled = guardedLive.liveEnabled(env || process.env);
  const fastWatcher = {
    live_enabled: liveEnabled,
    allowed: liveEnabled && isOpen,
    reason: !liveEnabled ? 'kill_switch_off' : (isOpen ? null : 'market_closed')
  };

  // Intraday volume-pace market_state (best-effort; needs a valid date+time).
  let marketState = null;
  if (dateStr && timeStr) {
    try {
      marketState = volumePace.sessionProgress(dateStr, timeStr).market_state;
    } catch (_) {
      marketState = null;
    }
  }

  return {
    at: date.toISOString(),
    date_wib: dateStr,
    time_wib: timeStr,
    session,
    is_market_open: isOpen,
    market_state: marketState,
    paths: {
      telegram_monitor: telegramMonitor,
      fast_watcher_guarded_live: fastWatcher
    }
  };
}

function parseArgs(argv) {
  const args = { at: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--at') args.at = argv[++i];
    else if (argv[i] === '--json') args.json = true;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const report = buildLiveSessionReport(args.at);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Live session @ ${report.time_wib} WIB (${report.date_wib})`);
    console.log(`  session=${report.session} open=${report.is_market_open} market_state=${report.market_state}`);
    console.log(`  telegram_monitor: allowed=${report.paths.telegram_monitor.allowed} reason=${report.paths.telegram_monitor.reason || '-'}`);
    console.log(`  fast_watcher_guarded_live: allowed=${report.paths.fast_watcher_guarded_live.allowed} reason=${report.paths.fast_watcher_guarded_live.reason || '-'}`);
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { buildLiveSessionReport, parseArgs, jakartaDateStr, jakartaTimeStr };
