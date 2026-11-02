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

function wibDateKeyOf(value) {
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(d.getTime())) return null;
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
    });
    return fmt.format(d);
  } catch (_) { return null; }
}

function resolveLastTradingDay(now, explicit) {
  if (typeof explicit === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  try {
    const cal = require('./idx-trading-calendar');
    const hs = cal.getSeedHolidaySet();
    const todayKey = wibDateKeyOf(now) || wibDateKeyOf(new Date());
    if (!todayKey) return null;
    if (cal.isTradingDay(todayKey, hs)) return todayKey;
    return cal.previousTradingDay(todayKey, hs);
  } catch (_) { return null; }
}

/**
 * Decide whether an alert is due.
 *
 * P5 — trading-day-aware staleness (anti alarm palsu malam/akhir pekan).
 * - Saat jam bursa aktif (marketOpen===true): umur snapshot > staleMinutes
 *   (default 120, 30-120 menit sesuai instruksi P5) → DARURAT.
 * - Di luar jam bursa (malam/akhir pekan): TIDAK BOLEH bunyikan alarm palsu
 *   bila snapshot sudah memuat penutupan hari bursa terakhir (lastTradingDay
 *   EOD). Alarm DARURAT hanya bila snapshotDate < lastTradingDay (belum update
 *   ke tanggal hari bursa terakhir). Diam di luar jam bursa selalu beralasan
 *   'market_closed' agar kompatibel dengan kontrak lama; kejujuran dibuktikan
 *   via snapshotDate/lastTradingDay yang ikut dikembalikan.
 *
 * @param {object} input
 * @param {string|number|Date} input.snapshotMtime  last successful snapshot write
 * @param {string|number|Date} input.now            current time
 * @param {boolean} input.marketOpen                is the exchange session open
 * @param {number} [input.staleMinutes=120]         staleness threshold
 * @param {number|null} [input.lastAlertAt=null]    last alert timestamp (ms)
 * @param {number} [input.cooldownMs=6h]            minimum gap between alerts
 * @param {string} [input.snapshotDate]             snapshot trading date YYYY-MM-DD (opsional, P5)
 * @param {string} [input.lastTradingDay]           hari bursa terakhir YYYY-MM-DD (opsional, P5; dihitung bila kosong)
 * @returns {{shouldAlert:boolean, reason:string, ageMinutes:number|null, snapshotDate:string|null, lastTradingDay:string|null}}
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

  // P5: di luar jam bursa, keputusan berbasis TANGGAL hari bursa terakhir,
  // bukan umur menit mentah (mencegah alarm palsu 267 menit malam/akhir pekan).
  // Diam di luar jam bursa SELALU beralasan 'market_closed' (kompatibel dengan
  // kontrak lama); kejujuran dibuktikan via snapshotDate/lastTradingDay yang
  // ikut dikembalikan. Hanya snapshot yang tertinggal dari hari bursa terakhir
  // yang boleh DARURAT ('stale_eod_behind', dengan cooldown).
  if (opts.marketOpen !== true) {
    const hasDateInputs = opts.snapshotDate != null || opts.lastTradingDay != null
      || opts.snapshotMtime != null;
    if (!hasDateInputs) {
      return { shouldAlert: false, reason: 'market_closed', ageMinutes, snapshotDate: null, lastTradingDay: null };
    }
    const lastTD = resolveLastTradingDay(opts.now, opts.lastTradingDay);
    const snapDate = typeof opts.snapshotDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.snapshotDate)
      ? opts.snapshotDate
      : wibDateKeyOf(opts.snapshotMtime);
    if (!snapDate || !lastTD) {
      // Tidak ada snapshot sama sekali di luar jam bursa = tetap diam (bukan DARURAT);
      // producer EOD malam hari yang akan mengejar ketertinggalan.
      return { shouldAlert: false, reason: 'market_closed', ageMinutes, snapshotDate: snapDate, lastTradingDay: lastTD };
    }
    if (snapDate >= lastTD) {
      return { shouldAlert: false, reason: 'market_closed', ageMinutes, snapshotDate: snapDate, lastTradingDay: lastTD };
    }
    // Snapshot belum memuat penutupan hari bursa terakhir → DARURAT jujur (dengan cooldown).
    const lastClosed = toMs(opts.lastAlertAt);
    const nowClosedMs = toMs(opts.now);
    if (lastClosed != null && nowClosedMs != null && nowClosedMs - lastClosed < cooldownMs) {
      return { shouldAlert: false, reason: 'cooldown', ageMinutes, snapshotDate: snapDate, lastTradingDay: lastTD };
    }
    return { shouldAlert: true, reason: 'stale_eod_behind', ageMinutes, snapshotDate: snapDate, lastTradingDay: lastTD };
  }

  // FIX-2: account for lunch break (Mon-Thu 12:00-13:30, Fri 11:30-14:00)
  // During IDX lunch break, no snapshot is published — don't false-alarm
  var lunchBreakAwareMinutes = staleMinutes;
  try {
    var marketGuard = require('./market-hours-guard');
    var sess = marketGuard.getMarketSessionStatus && marketGuard.getMarketSessionStatus(opts.now);
    if (sess && sess.session === 'BREAK') {
      // Add lunch break duration to threshold so break gap doesn't trigger alarm
      lunchBreakAwareMinutes = staleMinutes + 150; // +2.5h covers both Mon-Thu and Fri breaks
    }
  } catch (_) {}

  // P5: sertakan tanggal untuk kejujuran gate (tidak mengubah keputusan jam bursa).
  var snapDateOpen = typeof opts.snapshotDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.snapshotDate)
    ? opts.snapshotDate
    : wibDateKeyOf(opts.snapshotMtime);
  var lastTDOpen = resolveLastTradingDay(opts.now, opts.lastTradingDay);
  if (ageMs == null) {
    // No snapshot at all during market hours is the worst case: alert.
    return { shouldAlert: true, reason: 'snapshot_missing', ageMinutes: null, snapshotDate: snapDateOpen, lastTradingDay: lastTDOpen };
  }
  if (ageMinutes < lunchBreakAwareMinutes) {
    return { shouldAlert: false, reason: 'fresh', ageMinutes, snapshotDate: snapDateOpen, lastTradingDay: lastTDOpen };
  }

  const last = toMs(opts.lastAlertAt);
  const nowMs = toMs(opts.now);
  if (last != null && nowMs != null && nowMs - last < cooldownMs) {
    return { shouldAlert: false, reason: 'cooldown', ageMinutes, snapshotDate: snapDateOpen, lastTradingDay: lastTDOpen };
  }
  return { shouldAlert: true, reason: 'stale', ageMinutes, snapshotDate: snapDateOpen, lastTradingDay: lastTDOpen };
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
  send,
  // P5: diekspor agar producer/gate memakai kalender hari bursa yang sama.
  wibDateKeyOf,
  resolveLastTradingDay
};
