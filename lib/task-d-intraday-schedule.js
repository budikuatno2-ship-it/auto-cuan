'use strict';

/**
 * lib/task-d-intraday-schedule.js — TASK D intraday Top20/Top5 monitoring.
 * ============================================================================
 * PURE schedule + observation decision layer. NO network, NO DB, NO cron edits.
 *
 * Owner contract (TASK D requirement 2):
 *   Mon-Thu WIB: 09:10, 10:05, 11:05, 12:05, 13:40, 14:40, 15:40, 16:15, 17:00
 *                (lunch break 12:00-13:30 WIB respected)
 *   Fri WIB:     09:10, 10:05, 11:05, 11:35, 14:10, 15:05, 15:40, 16:15, 17:00
 *                (Fri break 11:30-14:00 WIB respected)
 *   Sat/Sun/IDX holiday: SKIP
 *   Only monitor price/volume/breakout/entry/SL/TP. NO re-screening or
 *   re-ranking. Top5 reuses the Top20 fetch (single fetch per slot).
 *
 * All times are Asia/Jakarta wall-clock (UTC+7, no DST). The holiday set is
 * injected; the bundled IDX 2026 seed is the default so a holiday is never
 * silently treated as a trading day.
 * ============================================================================
 */

const { getSeedHolidaySet } = require('./idx-trading-calendar');

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

const SCHEDULE = Object.freeze({
  MON_THU: Object.freeze(['09:10', '10:05', '11:05', '12:05', '13:40', '14:40', '15:40', '16:15', '17:00']),
  FRI: Object.freeze(['09:10', '10:05', '11:05', '11:35', '14:10', '15:05', '15:40', '16:15', '17:00'])
});

// Break windows are inclusive of BOTH endpoints (WIB minutes): the owner's
// "12:00-13:30" / "11:30-14:00" contract includes the boundary minute.
const BREAKS = Object.freeze({
  MON_THU: Object.freeze([{ start: 12 * 60, end: 13 * 60 + 30, label: 'LUNCH_BREAK' }]),
  FRI: Object.freeze([{ start: 11 * 60 + 30, end: 14 * 60, label: 'FRIDAY_PRAYER_BREAK' }])
});

const MONITOR_FIELDS = Object.freeze(['price', 'volume', 'breakout', 'entry', 'sl', 'tp']);
const PROVIDER = 'YAHOO_ZERO_QUOTA';

function jakartaParts(now) {
  const d = new Date(now.getTime() + WIB_OFFSET_MS);
  return {
    dateKey: d.toISOString().slice(0, 10),
    weekday: d.getUTCDay(), // 0=Sun .. 6=Sat
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    time: d.toISOString().slice(11, 16)
  };
}

function timeToMinutes(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function scheduleForWeekday(weekday) {
  if (weekday >= 1 && weekday <= 4) return 'MON_THU';
  if (weekday === 5) return 'FRI';
  return null;
}

function inBreak(dayKey, minutes) {
  const breaks = BREAKS[dayKey] || [];
  return breaks.find((b) => minutes >= b.start && minutes <= b.end) || null;
}

/**
 * Decide whether a WIB instant is an active monitoring slot.
 * @returns {{active:boolean, reason:string, dayKey:string|null, time:string,
 *            dateKey:string, slot:string|null, provider:string}}
 */
function evaluateInstant(now, options) {
  const o = options || {};
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.getTime())) {
    return { active: false, reason: 'INVALID_TIME', dayKey: null, time: null, dateKey: null, slot: null, provider: PROVIDER };
  }
  const p = jakartaParts(instant);
  const dayKey = scheduleForWeekday(p.weekday);
  const base = { dayKey, time: p.time, dateKey: p.dateKey, slot: null, provider: PROVIDER };
  if (!dayKey) return Object.assign(base, { active: false, reason: p.weekday === 0 || p.weekday === 6 ? 'WEEKEND_SKIP' : 'INVALID_WEEKDAY' });

  const holidays = o.holidaySet instanceof Set ? o.holidaySet : getSeedHolidaySet();
  if (holidays.has(p.dateKey)) return Object.assign(base, { active: false, reason: 'IDX_HOLIDAY_SKIP' });

  // The owner's explicit slot list is authoritative. It intentionally contains
  // two in-break checkpoints (12:05 Mon-Thu inside the 12:00-13:30 lunch break,
  // and 11:35 Fri inside the 11:30-14:00 prayer break). Those are session-close
  // checkpoints that read the LAST VERIFIED price, not live-tick monitoring.
  // The break guard therefore applies to every NON-listed time, and an explicit
  // in-break slot is flagged `in_break_checkpoint` so the exception is auditable.
  const slots = SCHEDULE[dayKey];
  const slot = slots.find((s) => timeToMinutes(s) === p.minutes);
  const breakInfo = inBreak(dayKey, p.minutes);
  if (!slot) {
    return Object.assign(base, { active: false, reason: breakInfo ? breakInfo.label : 'NOT_A_SCHEDULED_SLOT' });
  }
  return Object.assign(base, {
    active: true,
    reason: 'SCHEDULED_SLOT',
    slot,
    in_break_checkpoint: !!breakInfo,
    break_label: breakInfo ? breakInfo.label : null,
    price_mode: breakInfo ? 'LAST_VERIFIED_PRICE' : 'LIVE_TICK'
  });
}

/** Full schedule matrix for evidence (no execution). */
function scheduleMatrix(options) {
  const holidays = (options && options.holidaySet) || getSeedHolidaySet();
  const rows = [];
  for (const dayKey of ['MON_THU', 'FRI']) {
    for (const slot of SCHEDULE[dayKey]) {
      const minutes = timeToMinutes(slot);
      rows.push({
        dayKey,
        slot,
        provider: PROVIDER,
        inBreak: !!inBreak(dayKey, minutes),
        monitorFields: MONITOR_FIELDS.slice(),
        reScreen: false,
        reRank: false
      });
    }
  }
  return {
    provider: PROVIDER,
    weekend: 'SKIP',
    idxHoliday: 'SKIP',
    holidayCount: holidays instanceof Set ? holidays.size : 0,
    rows
  };
}

/**
 * Build the single-fetch plan for one active slot. Top5 reuses the Top20 fetch:
 * exactly one Yahoo ZERO_QUOTA fetch per ticker, no re-screen/re-rank.
 */
function buildFetchPlan(activeDecision, candidates, options) {
  const o = options || {};
  if (!activeDecision || !activeDecision.active) {
    return { ok: false, reason: activeDecision ? activeDecision.reason : 'INACTIVE_SLOT', fetches: [], httpRequests: 0, billedUnits: 0 };
  }
  const top20 = Array.isArray(o.top20) ? o.top20 : (Array.isArray(candidates) ? candidates : []);
  const top5Tickers = Array.isArray(o.top5Tickers) ? o.top5Tickers.map((t) => String(t).toUpperCase()) : top20.slice(0, 5).map((r) => String((r && (r.ticker || r.symbol)) || '').toUpperCase()).filter(Boolean);
  const top5Set = new Set(top5Tickers);
  const fetches = top20.map((row) => {
    const ticker = String((row && (row.ticker || row.symbol)) || '').toUpperCase();
    return {
      ticker,
      provider: PROVIDER,
      fields: MONITOR_FIELDS.slice(),
      reusedByTop5: top5Set.has(ticker),
      reScreen: false,
      reRank: false
    };
  }).filter((f) => f.ticker);
  return {
    ok: true,
    reason: null,
    slot: activeDecision.slot,
    dateKey: activeDecision.dateKey,
    fetches,
    fetchCount: fetches.length,
    top5ReuseCount: fetches.filter((f) => f.reusedByTop5).length,
    httpRequests: 0,
    billedUnits: 0
  };
}

module.exports = {
  SCHEDULE,
  BREAKS,
  MONITOR_FIELDS,
  PROVIDER,
  jakartaParts,
  timeToMinutes,
  scheduleForWeekday,
  inBreak,
  evaluateInstant,
  scheduleMatrix,
  buildFetchPlan
};
