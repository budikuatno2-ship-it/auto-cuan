'use strict';

/**
 * B5 (2026-10-20): standalone IHSG benchmark step.
 *
 * Why: on 2026-10-19 the daily candle job's cross-check failed and the whole
 * run bailed out, so IHSG.json never got a 2026-10-19 bar (it stayed at
 * 2026-10-16). The index benchmark is exactly ONE request per day and is the
 * anchor for market-regime / breadth calculations, so it must not depend on
 * the 962-stock pass.
 *
 * This tool:
 *   - fetches the IHSG daily candle from Arjum (1 request),
 *   - writes/merges data/daily-candles/IHSG.json,
 *   - reports whether the bar for the target trading date exists,
 *   - raises an alert (Admin Console + Telegram) when the bar for TODAY is
 *     still missing at/after 17:30 WIB.
 *
 * Usage:
 *   node tools/fetch-ihsg-candle.js                 # today (WIB)
 *   node tools/fetch-ihsg-candle.js --date=2026-10-19
 *   node tools/fetch-ihsg-candle.js --check-only    # no request, just report
 */

const fs = require('fs');
const path = require('path');
const fetcher = require('../lib/chart-engine/candle-fetcher');
const idxTradingCalendar = require('../lib/idx-trading-calendar');

const ALERT_AFTER_HOUR_WIB = Number(process.env.IHSG_ALERT_AFTER_HOUR || 17);
const ALERT_AFTER_MINUTE_WIB = Number(process.env.IHSG_ALERT_AFTER_MINUTE || 30);

function wibParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const out = {};
  fmt.formatToParts(now).forEach(p => { if (p.type !== 'literal') out[p.type] = p.value; });
  return {
    date: `${out.year}-${out.month}-${out.day}`,
    hour: parseInt(out.hour, 10),
    minute: parseInt(out.minute, 10)
  };
}

function hasBarForDate(ticker, date) {
  const cache = fetcher.readCache(ticker);
  if (!cache || !Array.isArray(cache.candles)) return false;
  return cache.candles.some(row => String(row && row.date || '').slice(0, 10) === date);
}

function lastBarDate(ticker) {
  const cache = fetcher.readCache(ticker);
  if (!cache || !Array.isArray(cache.candles) || !cache.candles.length) return null;
  let latest = null;
  for (const row of cache.candles) {
    const d = String(row && row.date || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (!latest || d > latest)) latest = d;
  }
  return latest;
}

async function run(options = {}) {
  const argv = options.argv || process.argv.slice(2);
  const args = Array.isArray(argv) ? argv : [];
  const checkOnly = options.checkOnly === true || args.includes('--check-only');
  const dateArg = (args.find(a => a.startsWith('--date=')) || '').replace('--date=', '');
  const now = options.now || new Date();
  const wib = wibParts(now);
  const targetDate = dateArg || wib.date;

  const holidays = idxTradingCalendar.getSeedHolidaySet ? idxTradingCalendar.getSeedHolidaySet() : new Set();
  const isTradingDay = idxTradingCalendar.isTradingDay(targetDate, holidays);

  const before = hasBarForDate('IHSG', targetDate);
  const last = lastBarDate('IHSG');

  if (checkOnly) {
    console.log(JSON.stringify({ mode: 'CHECK_ONLY', target_date: targetDate, has_bar: before, last_bar: last, trading_day: isTradingDay }, null, 2));
    return { ok: before, hasBar: before, lastBar: last, targetDate, tradingDay: isTradingDay, fetched: false };
  }

  let fetched = false;
  let fetchError = null;
  if (!before) {
    const res = await fetcher.fetchDailyCandles('IHSG', {
      limit: Number(process.env.CANDLE_LIMIT) || 500,
      force: true
    });
    fetched = Boolean(res && res.ok);
    if (!fetched) fetchError = (res && res.error) || 'fetch_failed';
  }

  const hasBar = hasBarForDate('IHSG', targetDate);
  const lastAfter = lastBarDate('IHSG');
  const pastAlertWindow = (wib.hour > ALERT_AFTER_HOUR_WIB)
    || (wib.hour === ALERT_AFTER_HOUR_WIB && wib.minute >= ALERT_AFTER_MINUTE_WIB);
  const shouldAlert = isTradingDay && pastAlertWindow && !hasBar;

  const summary = {
    mode: 'LIVE',
    target_date: targetDate,
    trading_day: isTradingDay,
    has_bar: hasBar,
    last_bar: lastAfter,
    fetched,
    fetch_error: fetchError,
    alert_required: shouldAlert
  };
  console.log(JSON.stringify(summary, null, 2));

  if (shouldAlert) {
    await alertMissingIhsg(targetDate, lastAfter, fetchError);
    if (!options.keepExitCode) process.exitCode = 7;
  }

  return summary;
}

async function alertMissingIhsg(targetDate, lastBar, fetchError) {
  const line = `[ALERT] Bar IHSG untuk ${targetDate} belum ada pada ${wibParts().hour}:${String(wibParts().minute).padStart(2, '0')} WIB (bar terakhir: ${lastBar || 'tidak ada'}${fetchError ? ', error: ' + fetchError : ''}).`;
  try { console.error(line); } catch (_) {}
  try {
    const notifier = require('../lib/telegram-notifier');
    if (typeof notifier.sendTelegramMessage === 'function') {
      await notifier.sendTelegramMessage(
        `🚨 Auto-Cuan: bar IHSG ${targetDate} belum tersedia.\nBar terakhir: ${lastBar || 'tidak ada'}\n`
        + `Fetch Arjum gagal: ${fetchError || 'tidak diketahui'}\nCek job candle harian / penyedia data.`,
        { skip_market_guard: true, alert_key: 'ihsg_missing_' + targetDate, cooldownMs: 60 * 60 * 1000 }
      );
    }
  } catch (_) {}
}

if (require.main === module) {
  run().catch(err => { console.error('Fatal:', err && err.message); process.exit(1); });
}

module.exports = { run, hasBarForDate, lastBarDate, wibParts, ALERT_AFTER_HOUR_WIB, ALERT_AFTER_MINUTE_WIB };