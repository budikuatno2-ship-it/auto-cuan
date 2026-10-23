#!/usr/bin/env node
'use strict';

/**
 * B3 (22 Oct 2026) — inspect the H-1 refill backlog from the daily markers and
 * raise ONE alert (Telegram + persisted Admin Console state) when the backlog is
 * older than 24h AND not shrinking.
 *
 * It reads the real marker files written by tools/run-daily-broker-update.js:
 *   data/arjum-data/_daily-update-marker/<date>.json
 * For the most recent marker, `pending` (markerQuality.pending_provider_count) is
 * the number of emiten still missing for that date. Nothing is written to market
 * data; only a small alarm-state JSON and a log line.
 *
 * Read-only w.r.t. data. No secrets, no network unless an alert is due.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const alarm = require(path.join(ROOT_DIR, 'lib', 'backlog-age-alarm'));

function markerDir(env) {
  const e = env || process.env;
  const base = e.ARJUM_DATA_DIR || process.env.ARJUM_DATA_DIR || path.join(ROOT_DIR, 'data', 'arjum-data');
  return path.join(base, '_daily-update-marker');
}

function statePath(env) {
  const e = env || process.env;
  return e.BACKLOG_ALARM_STATE || process.env.BACKLOG_ALARM_STATE || path.join(ROOT_DIR, 'data', 'backlog-age-alarm.json');
}

function wibDay(ms) {
  const d = new Date((Number.isFinite(ms) ? ms : Date.now()) + 7 * 3600000);
  return d.toISOString().slice(0, 10);
}

function readAlarmState(env) {
  try { return JSON.parse(fs.readFileSync(statePath(env), 'utf8')); } catch (_) { return {}; }
}

function writeAlarmState(state, env) {
  try {
    const p = statePath(env);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state, null, 2));
  } catch (_) {}
}

// Select the newest marker by its filename date (excluding the quarantine dir).
function newestPending(dates, dir) {
  let best = null;
  for (const d of dates) {
    let marker = null;
    try { marker = JSON.parse(fs.readFileSync(path.join(dir, d + '.json'), 'utf8')); } catch (_) { continue; }
    const pending = Number(marker.pending) || 0;
    const total = Number(marker.total_tickers) || 0;
    if (!best || d > best.date) best = { date: d, pending, total, complete: marker.complete === true };
  }
  return best;
}

function markerDates(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('.json', ''))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
  } catch (_) { return []; }
}

async function run(argv, env) {
  const e = env || process.env;
  const args = argv || [];
  const json = args.includes('--json');
  const now = Date.now();
  const nowMs = Number(e.BACKLOG_ALARM_NOW_MS) || now;

  const dir = markerDir(e);
  const dates = markerDates(dir);
  const latest = newestPending(dates.slice(-30), dir);
  const total = latest ? latest.total : 0;
  const pending = latest ? latest.pending : 0;
  const targetDate = latest ? latest.date : null;

  // The episode's start is recorded the first time we SEE a given backlog target.
  // A different target date (a new trading day) starts a fresh episode.
  const prior = readAlarmState(e);
  const sameEpisode = prior.target_date === targetDate;
  const firstSeenAt = sameEpisode && prior.first_seen_at ? prior.first_seen_at : (pending > 0 ? new Date(nowMs).toISOString() : null);
  const previousPending = sameEpisode && Number.isFinite(Number(prior.pending)) ? Number(prior.pending) : pending;

  const decision = alarm.evaluate({
    now: nowMs,
    pendingCount: pending,
    previousPending,
    firstSeenAt,
    lastAlertAt: prior.last_alert_at || null,
    lastAlertDay: prior.last_alert_day || null,
    nowWibDay: wibDay(nowMs),
    staleHours: Number(e.BACKLOG_STALE_HOURS) || undefined,
    cooldownMs: Number(e.BACKLOG_ALERT_COOLDOWN_MS) || undefined
  });

  const detail = {
    pendingCount: pending,
    totalTickers: total,
    targetDate,
    ageHours: decision.ageHours,
    staleHours: alarm.DEFAULT_STALE_HOURS,
    reason: decision.reason
  };

  let sendResult = { sent: false, skipped: true, reason: 'not_due' };
  if (decision.shouldAlert) {
    sendResult = await alarm.send(detail, {
      notifier: require(path.join(ROOT_DIR, 'lib', 'telegram-notifier'))
    });
  }

  // Persist the Admin-Console-visible alarm state + the episode bookkeeping.
  const nextState = {
    target_date: targetDate,
    pending,
    total_tickers: total,
    first_seen_at: firstSeenAt,
    age_hours: decision.ageHours == null ? null : Math.round(decision.ageHours * 10) / 10,
    reason: decision.reason,
    should_alert: decision.shouldAlert,
    last_alert_at: decision.shouldAlert ? new Date(nowMs).toISOString() : (prior.last_alert_at || null),
    last_alert_day: decision.shouldAlert ? wibDay(nowMs) : (prior.last_alert_day || null),
    alert_sent: sendResult.sent === true,
    alert_reason: sendResult.reason || null,
    updated_at: new Date(nowMs).toISOString()
  };
  // A drained (or empty) backlog clears the episode so a later stall re-alerts.
  if (pending <= 0) {
    nextState.first_seen_at = null;
  }
  writeAlarmState(nextState, e);

  const summary = {
    mode: 'backlog_age',
    target_date: targetDate,
    pending,
    total_tickers: total,
    age_hours: nextState.age_hours,
    reason: decision.reason,
    alerted: decision.shouldAlert,
    alert_sent: sendResult.sent === true,
    alert_skip_reason: sendResult.skipped ? sendResult.reason : null
  };

  if (json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    process.stdout.write(
      `[BACKLOG-ALARM] target=${targetDate} pending=${pending}/${total} age_h=${nextState.age_hours} reason=${decision.reason} alerted=${decision.shouldAlert} sent=${sendResult.sent === true}\n`
    );
  }
  return summary;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((s) => { process.exitCode = 0; return s; }).catch((err) => {
    console.error('backlog-alarm error:', err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}

module.exports = { run, markerDates, markerDir, statePath, wibDay, newestPending };
