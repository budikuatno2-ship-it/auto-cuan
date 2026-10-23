'use strict';

/**
 * B3 (22 Oct 2026) — H-1 refill backlog age alarm.
 *
 * WHY: the 19 Oct refill (J1 broker-summary for the full universe) stalled at 50
 * liquid tickers with ~920 still empty, and NOTHING alerted anyone — no Admin
 * Console state, no Telegram. The backlog simply sat there while every run
 * reported success. This module turns "the pending refill queue is older than 24h
 * and NOT shrinking" into ONE alert per day.
 *
 * Design (same posture as lib/daytrade-snapshot-alarm.js):
 * - Pure decision function (`evaluate`) so tests need no clock and no filesystem.
 * - Alert is at most once per WIB calendar day, and only when the backlog is both
 *   old AND not decreasing (a queue that is draining is not an incident).
 * - Never throws: a broken alarm must not break a job.
 */

const DEFAULT_STALE_HOURS = 24;
const DEFAULT_COOLDOWN_MS = 20 * 60 * 60 * 1000; // one alert per day (with margin)

function toMs(value) {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Decide whether the backlog alert is due.
 *
 * @param {object} input
 * @param {string|number|Date} input.now                 current time
 * @param {number} input.pendingCount                    microcap/emiten still empty
 * @param {number|null} [input.previousPending]          last observed pending count
 * @param {string|number|Date} [input.firstSeenAt]       when this backlog episode began
 * @param {string|number|Date} [input.lastAlertAt]       last alert timestamp
 * @param {string} [input.lastAlertDay]                  WIB day (YYYY-MM-DD) of last alert
 * @param {string} [input.nowWibDay]                     current WIB day (YYYY-MM-DD)
 * @param {number} [input.staleHours=24]
 * @param {number} [input.cooldownMs=20h]
 * @returns {{shouldAlert:boolean, reason:string, ageHours:number|null}}
 */
function evaluate(input) {
  const opts = input || {};
  const nowMs = toMs(opts.now);
  const pending = Number(opts.pendingCount);
  const staleHours = Number.isFinite(Number(opts.staleHours)) ? Number(opts.staleHours) : DEFAULT_STALE_HOURS;
  const cooldownMs = Number.isFinite(Number(opts.cooldownMs)) ? Number(opts.cooldownMs) : DEFAULT_COOLDOWN_MS;

  if (!Number.isFinite(pending) || pending <= 0) {
    return { shouldAlert: false, reason: 'no_backlog', ageHours: 0 };
  }

  const first = toMs(opts.firstSeenAt);
  const ageHours = (first != null && nowMs != null) ? Math.max(0, (nowMs - first) / 3600000) : null;

  if (ageHours == null) {
    // A backlog with no recorded start cannot yet be judged "old"; the caller
    // records the start on first sighting and alerts on a later run.
    return { shouldAlert: false, reason: 'age_unknown', ageHours: null };
  }
  if (ageHours < staleHours) {
    return { shouldAlert: false, reason: 'still_young', ageHours };
  }

  const prev = Number(opts.previousPending);
  if (Number.isFinite(prev) && pending < prev) {
    // The queue is draining — a stalled-backlog alarm would be noise.
    return { shouldAlert: false, reason: 'decreasing', ageHours };
  }

  if (opts.nowWibDay && opts.lastAlertDay && String(opts.nowWibDay) === String(opts.lastAlertDay)) {
    return { shouldAlert: false, reason: 'already_alerted_today', ageHours };
  }

  const last = toMs(opts.lastAlertAt);
  if (last != null && nowMs != null && nowMs - last < cooldownMs) {
    return { shouldAlert: false, reason: 'cooldown', ageHours };
  }

  return { shouldAlert: true, reason: 'stale_not_decreasing', ageHours };
}

function buildMessage(detail) {
  const d = detail || {};
  const age = d.ageHours == null ? 'tidak diketahui' : Math.round(d.ageHours) + ' jam';
  const pending = d.pendingCount == null ? '?' : String(d.pendingCount);
  const total = d.totalTickers == null ? '?' : String(d.totalTickers);
  return [
    '⚠️ PERINGATAN — antrean isi ulang H-1 macet',
    '',
    'Antrean broker-summary H-1 lebih tua dari ambang batas dan tidak berkurang.',
    'Artinya refill tidak menutup seluruh emiten seperti seharusnya.',
    '',
    'Belum terisi  : ' + pending + ' / ' + total + ' emiten',
    'Umur antrean  : ' + age,
    'Ambang        : ' + (d.staleHours != null ? d.staleHours : DEFAULT_STALE_HOURS) + ' jam',
    'Alasan        : ' + String(d.reason || 'stale_not_decreasing'),
    '',
    'Cek: tail -n 40 autocuan-runner/logs/daily-market-update.log'
  ].join('\n');
}

/**
 * Send the alert through the shared Telegram notifier. Returns
 * { sent, skipped, reason } and never throws.
 */
async function send(detail, deps) {
  const d = deps || {};
  try {
    if (d.notifier && typeof d.notifier.isTelegramEnabled === 'function' && !d.notifier.isTelegramEnabled()) {
      return { sent: false, skipped: true, reason: 'telegram_disabled' };
    }
    const notifier = d.notifier || require('./telegram-notifier');
    const text = buildMessage(detail);
    const res = await notifier.sendTelegramMessage(text);
    return { sent: Boolean(res && res.ok !== false), skipped: false, result: res };
  } catch (err) {
    return { sent: false, skipped: true, reason: 'send_failed: ' + (err && err.message ? err.message : String(err)) };
  }
}

module.exports = { DEFAULT_STALE_HOURS, DEFAULT_COOLDOWN_MS, evaluate, buildMessage, send };
