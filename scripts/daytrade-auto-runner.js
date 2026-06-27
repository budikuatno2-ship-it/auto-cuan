#!/usr/bin/env node
'use strict';

/**
 * Local Day Trade auto runner.
 *
 * Manual laptop/terminal helper only. It does not send Telegram directly;
 * the backend endpoint handles Telegram notification behavior.
 */

var DEFAULT_START = '09:10';
var DEFAULT_END = '15:40';
var DEFAULT_INTERVAL_MINUTES = 30;
var REQUEST_TIMEOUT_MS = 20000;
var WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

var stopped = false;
var timer = null;

function pad(n) { return String(n).padStart(2, '0'); }

function getWibDate(now) {
  now = now || new Date();
  return new Date(now.getTime() + WIB_OFFSET_MS);
}

function formatWib(now) {
  var wib = getWibDate(now);
  return wib.getUTCFullYear() + '-' + pad(wib.getUTCMonth() + 1) + '-' + pad(wib.getUTCDate()) + ' ' + pad(wib.getUTCHours()) + ':' + pad(wib.getUTCMinutes()) + ':' + pad(wib.getUTCSeconds()) + ' WIB';
}

function parseHHMM(value, name) {
  var raw = String(value || '').trim();
  var m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(name + ' must use HH:MM format, got: ' + raw);
  var hh = Number(m[1]);
  var mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) throw new Error(name + ' is out of range: ' + raw);
  return hh * 60 + mm;
}

function getWibMinuteOfDay(now) {
  var wib = getWibDate(now);
  return wib.getUTCHours() * 60 + wib.getUTCMinutes();
}

function getWindowConfig() {
  var startText = process.env.AUTO_RUN_START || DEFAULT_START;
  var endText = process.env.AUTO_RUN_END || DEFAULT_END;
  var interval = Number(process.env.AUTO_RUN_INTERVAL_MINUTES || DEFAULT_INTERVAL_MINUTES);
  if (!isFinite(interval) || interval <= 0) throw new Error('AUTO_RUN_INTERVAL_MINUTES must be a positive number.');
  return {
    startText: startText,
    endText: endText,
    startMinute: parseHHMM(startText, 'AUTO_RUN_START'),
    endMinute: parseHHMM(endText, 'AUTO_RUN_END'),
    intervalMinutes: interval
  };
}

function isWithinWindow(now, cfg) {
  var minute = getWibMinuteOfDay(now);
  return minute >= cfg.startMinute && minute <= cfg.endMinute;
}

function isAfterWindow(now, cfg) {
  return getWibMinuteOfDay(now) > cfg.endMinute;
}

function msUntilWibMinute(targetMinute, now) {
  now = now || new Date();
  var wib = getWibDate(now);
  var target = new Date(Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth(), wib.getUTCDate(), Math.floor(targetMinute / 60), targetMinute % 60, 0, 0));
  var diffWibMs = target.getTime() - wib.getTime();
  return Math.max(0, diffWibMs);
}

function buildEndpointUrl() {
  var baseUrl = (process.env.AUTO_CUAN_BASE_URL || '').trim();
  if (!baseUrl) throw new Error('AUTO_CUAN_BASE_URL is required.');
  var normalized = baseUrl.replace(/\/+$/, '');
  return normalized + '/api/sector-hot?action=daytrade-screener-run';
}

function getCronSecret() {
  var secret = (process.env.CRON_SECRET || '').trim();
  if (!secret) throw new Error('CRON_SECRET is required.');
  return secret;
}

function logTelegramResult(data) {
  var telegram = data && data.telegram;
  if (!telegram) {
    console.log('telegram: unavailable');
    return;
  }
  var sent = telegram.sent === true;
  var skipped = telegram.skipped === true;
  var reason = telegram.reason || null;
  console.log('telegram sent:', sent);
  console.log('telegram skipped:', skipped);
  console.log('telegram reason:', reason || '-');
}

function logRunSummary(httpStatus, data) {
  console.log('HTTP status:', httpStatus);
  console.log('success:', data && data.success === true);
  if (data && data.message) console.log('message:', data.message);
  console.log('published_count:', data && (data.published_count != null ? data.published_count : data.published));
  console.log('selected_count:', data && data.telegram ? data.telegram.selected_count : undefined);
  console.log('verified_count:', data && data.telegram ? data.telegram.verified_count : undefined);
  console.log('high_conviction_count:', data && data.telegram ? data.telegram.high_conviction_count : undefined);
  logTelegramResult(data);
}

async function runOnce() {
  var url = buildEndpointUrl();
  var secret = getCronSecret();
  var controller = new AbortController();
  var timeout = setTimeout(function() { controller.abort(); }, REQUEST_TIMEOUT_MS);

  console.log('---');
  console.log('run time:', formatWib());
  console.log('endpoint:', url);

  try {
    var res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + secret },
      signal: controller.signal
    });
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { success: false, parse_error: e.message, raw: text.slice(0, 300) }; }
    logRunSummary(res.status, data || {});
    if (!res.ok) console.log('failure: backend returned non-2xx HTTP status.');
    else if (data && data.success === false) console.log('failure: backend returned success=false.');
    else console.log('run completed.');
  } catch (e) {
    if (e && e.name === 'AbortError') console.log('failure: request timed out after ' + REQUEST_TIMEOUT_MS + 'ms.');
    else console.log('failure:', e && e.message ? e.message : String(e));
  } finally {
    clearTimeout(timeout);
  }
}

function scheduleNext(cfg) {
  if (stopped) return;
  if (isAfterWindow(new Date(), cfg)) {
    console.log('stop reason: market window closed after ' + cfg.endText + ' WIB.');
    return;
  }
  var delayMs = cfg.intervalMinutes * 60 * 1000;
  var now = new Date();
  var next = new Date(now.getTime() + delayMs);
  if (getWibMinuteOfDay(next) > cfg.endMinute) {
    var untilEnd = msUntilWibMinute(cfg.endMinute, now);
    if (untilEnd <= 0) {
      console.log('stop reason: market window closed after ' + cfg.endText + ' WIB.');
      return;
    }
    delayMs = untilEnd;
    next = new Date(now.getTime() + delayMs);
  }
  console.log('next run time:', formatWib(next));
  timer = setTimeout(async function() {
    if (stopped) return;
    if (!isWithinWindow(new Date(), cfg)) {
      console.log('stop reason: current WIB time is outside ' + cfg.startText + '-' + cfg.endText + '.');
      return;
    }
    await runOnce();
    scheduleNext(cfg);
  }, delayMs);
}

async function main() {
  var cfg = getWindowConfig();
  console.log('Auto-Cuan Day Trade local runner started.');
  console.log('start time:', formatWib());
  console.log('window:', cfg.startText + '-' + cfg.endText + ' WIB');
  console.log('interval minutes:', cfg.intervalMinutes);

  process.on('SIGINT', function() {
    stopped = true;
    if (timer) clearTimeout(timer);
    console.log('\nstop reason: manual Ctrl+C shutdown.');
    process.exit(0);
  });

  var now = new Date();
  if (isAfterWindow(now, cfg)) {
    console.log('stop reason: market window is closed after ' + cfg.endText + ' WIB. No run executed.');
    return;
  }

  if (!isWithinWindow(now, cfg)) {
    var waitMs = msUntilWibMinute(cfg.startMinute, now);
    var firstRunAt = new Date(now.getTime() + waitMs);
    console.log('market window is not open yet. first run time:', formatWib(firstRunAt));
    timer = setTimeout(async function() {
      if (stopped) return;
      await runOnce();
      scheduleNext(cfg);
    }, waitMs);
    return;
  }

  await runOnce();
  scheduleNext(cfg);
}

main().catch(function(e) {
  console.error('fatal:', e && e.message ? e.message : String(e));
  process.exit(1);
});
