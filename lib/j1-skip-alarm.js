'use strict';

/**
 * B3/B5 (2026-10-23) — J1 consecutive-skip alarm.
 *
 * WHY: on 20-22 Oct every J1 EOD firing logged `SKIPPED_ARJUM_BUSY` and moved on.
 * Nothing alerted anyone, so three trading days of broker-summary data were lost
 * silently. This module counts consecutive skips and raises ONE alarm on the 3rd,
 * through the SAME Telegram path the other alarms use, and records the outcome
 * (sent / skipped / failed) so "the alarm was sent" is provable, not assumed.
 *
 * Design:
 *  - Pure decision (`evaluate`) so tests need no clock and no network.
 *  - State is a small JSON file (default data/j1-skip-alarm.json) that the Admin
 *    Console can read.
 *  - Never throws: a broken alarm must not break J1.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_THRESHOLD = 3;
const DEFAULT_STATE_PATH = path.join(__dirname, '..', 'data', 'j1-skip-alarm.json');

function statePath(override) {
  return override || process.env.J1_SKIP_ALARM_STATE || DEFAULT_STATE_PATH;
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
}

function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (_) {}
}

/**
 * Pure decision: should this skip raise an alarm?
 * @param {{consecutiveSkips:number, threshold?:number, lastAlertAt?:string|null, now?:number, cooldownMs?:number}} input
 */
function evaluate(input) {
  const opts = input || {};
  const skips = Number(opts.consecutiveSkips) || 0;
  const threshold = Number.isFinite(Number(opts.threshold)) && Number(opts.threshold) > 0 ? Number(opts.threshold) : DEFAULT_THRESHOLD;
  const cooldownMs = Number.isFinite(Number(opts.cooldownMs)) ? Number(opts.cooldownMs) : 6 * 60 * 60 * 1000;
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  if (skips < threshold) return { shouldAlert: false, reason: 'below_threshold' };
  const last = opts.lastAlertAt ? new Date(opts.lastAlertAt).getTime() : null;
  if (Number.isFinite(last) && now - last < cooldownMs) return { shouldAlert: false, reason: 'cooldown' };
  return { shouldAlert: true, reason: 'consecutive_skips' };
}

function buildMessage(detail) {
  const d = detail || {};
  return [
    '🚨 DARURAT — J1 dilewati berulang (SKIPPED_ARJUM_BUSY)',
    '',
    'J1 (broker summary harian) tidak mendapat lock Arjum berturut-turut.',
    'Data harian (ALL/F/akumulasi/insider) TIDAK terkumpul selama ini.',
    '',
    'Berturut-turut : ' + (d.consecutiveSkips != null ? d.consecutiveSkips : '?') + ' kali',
    'Ambang        : ' + (d.threshold != null ? d.threshold : DEFAULT_THRESHOLD) + ' kali',
    'Terakhir      : ' + (d.lastSkipAt || '-'),
    '',
    'Cek: tail -n 60 autocuan-runner/logs/daily-market-update.log'
  ].join('\n');
}

/** Record one skip. Returns { consecutiveSkips, shouldAlert, detail }. */
function recordSkip(opts) {
  const o = opts || {};
  const file = statePath(o.statePath);
  const state = readState(file);
  const consecutiveSkips = (Number(state.consecutive_skips) || 0) + 1;
  const nowIso = new Date().toISOString();
  const decision = evaluate({
    consecutiveSkips,
    threshold: o.threshold,
    lastAlertAt: state.last_alert_at || null,
    now: o.now,
    cooldownMs: o.cooldownMs
  });
  const next = {
    consecutive_skips: consecutiveSkips,
    last_skip_at: nowIso,
    last_alert_at: decision.shouldAlert ? nowIso : (state.last_alert_at || null),
    last_alert_reason: decision.shouldAlert ? decision.reason : (state.last_alert_reason || null),
    updated_at: nowIso
  };
  writeState(file, next);
  return {
    consecutiveSkips,
    shouldAlert: decision.shouldAlert,
    reason: decision.reason,
    detail: { consecutiveSkips, threshold: o.threshold || DEFAULT_THRESHOLD, lastSkipAt: nowIso }
  };
}

/** A successful J1 run (one that SAVED data) clears the counter. */
function recordSuccess(opts) {
  const o = opts || {};
  const file = statePath(o.statePath);
  const state = readState(file);
  writeState(file, Object.assign({}, state, {
    consecutive_skips: 0,
    consecutive_zero_saved: 0,
    last_success_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }));
}

/**
 * DARURAT 23 Oct 2026: J1 acquired the lock but persisted ZERO files (every
 * broker-summary call returned 400). That is a failure, not a success — it must
 * NOT stamp `last_success_at`, and it must alarm immediately (a zero-saved EOD
 * run means the whole trading day's data is missing).
 */
function recordZeroSaved(opts) {
  const o = opts || {};
  const file = statePath(o.statePath);
  const state = readState(file);
  const consecutiveZeroSaved = (Number(state.consecutive_zero_saved) || 0) + 1;
  const nowIso = new Date().toISOString();
  const detail = {
    consecutiveSkips: consecutiveZeroSaved,
    threshold: 1,
    lastSkipAt: nowIso,
    attempted: Number(o.attempted) || 0,
    zeroSaved: true
  };
  const next = Object.assign({}, state, {
    consecutive_zero_saved: consecutiveZeroSaved,
    last_zero_saved_at: nowIso,
    last_zero_saved_attempted: detail.attempted,
    last_alert_at: nowIso,
    last_alert_reason: 'zero_saved',
    updated_at: nowIso
  });
  writeState(file, next);
  // Fire-and-forget: the caller logs the outcome.
  const sent = send(detail).then((r) => {
    try {
      const s = readState(file);
      s.last_alert_sent = r.sent === true;
      s.last_alert_skip_reason = r.skipped ? r.reason : null;
      writeState(file, s);
    } catch (_) {}
    return r;
  });
  return { consecutiveZeroSaved, shouldAlert: true, detail, sent };
}

/** Send the alarm through the shared Telegram notifier. Never throws. */
async function send(detail, deps) {
  const d = deps || {};
  try {
    if (d.notifier && typeof d.notifier.isTelegramEnabled === 'function' && !d.notifier.isTelegramEnabled()) {
      return { sent: false, skipped: true, reason: 'telegram_disabled' };
    }
    const notifier = d.notifier || require('./telegram-notifier');
    const res = await notifier.sendTelegramMessage(buildMessage(detail));
    return { sent: Boolean(res && res.ok !== false), skipped: false, result: res };
  } catch (err) {
    return { sent: false, skipped: true, reason: 'send_failed: ' + (err && err.message ? err.message : String(err)) };
  }
}

module.exports = {
  DEFAULT_THRESHOLD,
  DEFAULT_STATE_PATH,
  statePath,
  evaluate,
  buildMessage,
  recordSkip,
  recordSuccess,
  recordZeroSaved,
  send
};
