'use strict';

/**
 * DayTrade snapshot staleness alarm.
 *
 * WHY: the DayTrade producer silently froze for six sessions (13-19 Oct 2026)
 * while every dashboard showed a stale `screener-latest.json`. Nothing alerted
 * anyone. This module turns "snapshot older than N minutes during market hours"
 * into ONE Telegram message per incident — not one per cron firing.
 *
 * Design constraints:
 * - Pure decision function (`evaluate`) so tests need no clock, no filesystem.
 * - Alert is per-EPISODE: the same stale window fires once, and re-arms only
 *   after the snapshot becomes fresh again (or a new day starts).
 * - Never throws: a broken alarm must not break the producer.
 */

const DEFAULT_STALE_MINUTES = 120;
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h: one alert per incident

function toMs(value) {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Decide whether an alert is due.
 *
 * @param {object} input
 * @param {string|number|Date} input.snapshotMtime  last successful snapshot write
 * @param {string|number|Date} input.now            current time
 * @param {boolean} input.marketOpen                is the exchange session open
 * @param {number} [input.staleMinutes=120]         staleness threshold
 * @param {number|null} [input.lastAlertAt=null]    last alert timestamp (ms)
 * @param {number} [input.cooldownMs=6h]            minimum gap between alerts
 * @returns {{shouldAlert:boolean, reason:string, ageMinutes:number|null}}
 */
function evaluate(input) {
  const opts = input || {};
  const ageMs = (() => {
    const m = toMs(opts.snapshotMtime);
    const n = toMs(opts.now);
    if (m == null || n == null) return null;
    return n - m;
  })();
  const ageMinutes = ageMs == null ? null : Math.max(0, Math.round(ageMs / 60000));
  const staleMinutes = Number.isFinite(Number(opts.staleMinutes))
    ? Number(opts.staleMinutes)
    : DEFAULT_STALE_MINUTES;
  const cooldownMs = Number.isFinite(Number(opts.cooldownMs))
    ? Number(opts.cooldownMs)
    : DEFAULT_COOLDOWN_MS;

  if (opts.marketOpen !== true) {
    return { shouldAlert: false, reason: 'market_closed', ageMinutes };
  }
  if (ageMs == null) {
    // No snapshot at all during market hours is the worst case: alert.
    return { shouldAlert: true, reason: 'snapshot_missing', ageMinutes: null };
  }
  if (ageMinutes < staleMinutes) {
    return { shouldAlert: false, reason: 'fresh', ageMinutes };
  }

  const last = toMs(opts.lastAlertAt);
  const nowMs = toMs(opts.now);
  if (last != null && nowMs != null && nowMs - last < cooldownMs) {
    return { shouldAlert: false, reason: 'cooldown', ageMinutes };
  }
  return { shouldAlert: true, reason: 'stale', ageMinutes };
}

function buildMessage(detail) {
  const d = detail || {};
  const age = d.ageMinutes == null ? 'tidak diketahui' : d.ageMinutes + ' menit';
  return [
    '🚨 DARURAT — DayTrade snapshot basi',
    '',
    'Snapshot DayTrade lebih tua dari ambang batas saat jam bursa.',
    'Artinya producer berhenti publish (sinyal live tidak diperbarui).',
    '',
    'Umur snapshot : ' + age,
    'Ambang        : ' + (d.staleMinutes != null ? d.staleMinutes : DEFAULT_STALE_MINUTES) + ' menit',
    'Alasan        : ' + String(d.reason || 'stale'),
    '',
    'Cek: pm2 logs / tail -n 40 autocuan-runner/logs/daytrade-producer.log'
  ].join('\n');
}

/**
 * Send the alert through the shared Telegram notifier.
 * Returns { sent, skipped, reason } and never throws.
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

module.exports = {
  DEFAULT_STALE_MINUTES,
  DEFAULT_COOLDOWN_MS,
  evaluate,
  buildMessage,
  send
};
