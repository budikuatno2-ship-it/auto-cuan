'use strict';

/**
 * Snapshot freshness contract — BUG-3C-02.
 *
 * tools/run-screener.js can dispatch recommendations to Telegram from
 * data/screener-latest.json. Before this module existed, nothing validated the
 * snapshot's trading date, so a frozen 2026-09-30 snapshot was broadcast as
 * "current" recommendations on 2026-10-01 whenever the upstream producer
 * failed (BUG-RT-02 → BUG-3C-02 cascade).
 *
 * The invariant is deliberately NOT "age < 24 hours": trading days, weekends,
 * exchange holidays, lunch breaks and after-hours dispatch all exist. The
 * expected snapshot date is resolved with the canonical IDX trading calendar
 * (lib/idx-trading-calendar.js, backed by the 2026 holiday seed), never by
 * naive calendar subtraction.
 *
 * Scheduled-send semantics — mode-specific (the applicable session differs):
 *
 *   mode                | scheduled role                  | acceptable snapshot date
 *   --------------------|---------------------------------|--------------------------------
 *   daytrade            | intraday live 09:15/10:30/13:45 | current session OR the latest
 *                       |                                 | completed session (previous
 *                       |                                 | trading day). The only snapshot
 *                       |                                 | producer runs at 19:00 WIB; the
 *                       |                                 | morning/midday runs consume the
 *                       |                                 | most recent EOD production by
 *                       |                                 | design. Anything older is stale.
 *   swing-konglo        | EOD 19:15                       | current WIB trading date only
 *   swing-non-konglo    | EOD 19:30                       | current WIB trading date only
 *   top5                | EOD lock 19:45                  | current WIB trading date only
 *   dispatch            | EOD 19:45 (all pillars)         | current WIB trading date only
 *   fastwatcher         | owned by the canonical intraday engine (run-fastwatcher.sh);
 *                       | run-screener only keeps the diagnostic mode
 *
 * The EOD 19:15-19:45 runners follow the 19:00 WIB same-day producer; a
 * previous-day snapshot is the exact 2026-10-01 broadcast failure
 * ("2026-09-30 recommendations broadcast on 2026-10-01 by three runners").
 * The DayTrade 09:15-13:45 runners precede that day's producer; requiring
 * same-day there would structurally block every scheduled DayTrade run, so
 * their applicable session is the latest completed one.
 *
 * Non-send (dry-run) inspection is NOT blocked: the report carries explicit
 * `freshness` metadata (stale=true, reason, dates, trading-session age) so a
 * local operator can see WHY it would be blocked. `--send` + stale snapshot
 * fails closed: no Telegram call, non-zero exit, clear STALE_SNAPSHOT log.
 *
 * Failure semantics:
 *   - missing/unparseable snapshot date  -> MISSING_SNAPSHOT_DATE (fail closed)
 *   - snapshot date is not the current WIB trading date -> STALE_SNAPSHOT
 *   - today is not an IDX trading day    -> NON_TRADING_DAY (fail closed)
 *   - snapshot date is in the future     -> FUTURE_SNAPSHOT (fail closed)
 * Freshness is derived ONLY from snapshot metadata (market_date / run_date /
 * trade_date / updated_at / generated_at). Nothing here rewrites or touches
 * the snapshot file, and no timestamp is ever fabricated.
 */

const calendar = require('./idx-trading-calendar');
const { getWibComponents } = require('./market-hours-guard');

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Modes whose scheduled run follows the same-day 19:00 WIB producer.
const SAME_DAY_MODES = new Set(['swing-konglo', 'swing-non-konglo', 'top5', 'dispatch']);
// Modes whose scheduled run precedes that day's producer and therefore uses
// the latest completed trading session (current session also acceptable).
const LATEST_COMPLETED_SESSION_MODES = new Set(['daytrade']);

// Ordered metadata fields that may carry the snapshot's trading date.
const DATE_FIELDS = ['market_date', 'run_date', 'trade_date'];
const TIMESTAMP_FIELDS = ['updated_at', 'updatedAt', 'generated_at', 'generatedAt'];

const MAX_AGE_SESSIONS_SCAN = 120;

function validDateKey(value) {
  if (typeof value !== 'string' || !DATE_KEY_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Convert a timestamp (ISO string / epoch ms) to its Asia/Jakarta date key.
 * Returns null when the value cannot be parsed. A bare YYYY-MM-DD date key is
 * returned unchanged (it already denotes a calendar/trading date).
 */
function jakartaDateOf(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && DATE_KEY_RE.test(value.trim())) {
    const key = value.trim();
    return validDateKey(key) ? key : null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  try {
    return calendar.toDateKey(parsed);
  } catch (_) {
    return null;
  }
}

/**
 * Extract the snapshot's trading date from its metadata, if present.
 * Priority: explicit trading-date fields, then timestamps (converted to the
 * Jakarta wall-clock date). Returns null when no trustworthy date exists —
 * callers must treat null as fail-closed for sends.
 */
function extractSnapshotDate(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  for (const field of DATE_FIELDS) {
    const key = jakartaDateOf(snapshot[field]);
    if (key) return { date: key, field };
  }
  for (const field of TIMESTAMP_FIELDS) {
    if (snapshot[field] == null || snapshot[field] === '') continue;
    const key = jakartaDateOf(snapshot[field]);
    if (key) return { date: key, field };
  }
  return null;
}

/**
 * Count completed trading sessions between `fromDate` (exclusive) and
 * `toDate` (inclusive) using the IDX calendar. Weekend/holiday runs do not
 * count, so Friday → Monday is 1 trading session, not 3 calendar days.
 * Returns null when the walk exceeds the bounded scan.
 */
function tradingSessionsBetween(fromDate, toDate, holidaySet) {
  if (!validDateKey(fromDate) || !validDateKey(toDate)) return null;
  if (fromDate >= toDate) return 0;
  let cursor = fromDate;
  let sessions = 0;
  for (let i = 0; i < MAX_AGE_SESSIONS_SCAN; i += 1) {
    cursor = calendar.addDaysToKey(cursor, 1);
    if (calendar.isTradingDay(cursor, holidaySet)) sessions += 1;
    if (cursor >= toDate) return sessions;
  }
  return null;
}

/**
 * Evaluate the freshness invariant for a snapshot about to be dispatched.
 *
 * @param {Object} options
 * @param {Object} [options.snapshot] snapshot object (metadata read from it)
 * @param {string|null} [options.snapshotDate] pre-extracted date override
 * @param {string} [options.mode] canonical screener mode (report metadata)
 * @param {Date|string|number} [options.now] instant to evaluate (default now)
 * @param {Set|Array} [options.holidaySet] IDX holiday set (defaults to seed)
 * @returns {{
 *   mode: string, now_wib: string|null, today: string|null,
 *   is_trading_day_today: boolean, snapshot_date: string|null,
 *   snapshot_date_field: string|null, expected_date: string|null,
 *   acceptable_dates: string[], fresh: boolean, stale: boolean, reason: string,
 *   age_sessions: number|null, holiday_source: string
 * }}
 */
function evaluateSnapshotFreshness(options) {
  const opts = options || {};
  const mode = opts.mode || 'daytrade';
  const now = opts.now == null ? new Date() : opts.now;
  const wib = getWibComponents(now);
  const today = wib && wib.isValid ? wib.dateStr : null;
  const holidaySet = opts.holidaySet instanceof Set
    ? opts.holidaySet
    : calendar.getSeedHolidaySet();

  let snapshotDate = null;
  let snapshotField = null;
  if (opts.snapshotDate != null) {
    snapshotDate = jakartaDateOf(opts.snapshotDate);
  } else {
    const extracted = extractSnapshotDate(opts.snapshot);
    if (extracted) {
      snapshotDate = extracted.date;
      snapshotField = extracted.field;
    }
  }

  const isTradingDayToday = Boolean(today && calendar.isTradingDay(today, holidaySet));
  const previousSession = isTradingDayToday
    ? calendar.previousTradingDay(today, holidaySet)
    : null;

  // Mode-specific acceptable snapshot dates. Unknown modes fail closed with
  // the strict same-day rule.
  const acceptableDates = [];
  if (isTradingDayToday) {
    if (LATEST_COMPLETED_SESSION_MODES.has(mode)) {
      if (previousSession) acceptableDates.push(previousSession);
      acceptableDates.push(today);
    } else {
      acceptableDates.push(today);
    }
  }
  const expectedDate = acceptableDates.length ? acceptableDates[acceptableDates.length - 1] : null;

  let reason = 'fresh';
  let fresh = false;

  if (!today) reason = 'INVALID_NOW';
  else if (!isTradingDayToday) reason = 'NON_TRADING_DAY';
  else if (!snapshotDate) reason = 'MISSING_SNAPSHOT_DATE';
  else if (snapshotDate > today) reason = 'FUTURE_SNAPSHOT';
  else if (acceptableDates.includes(snapshotDate)) {
    fresh = true;
    reason = 'fresh';
  } else {
    reason = 'STALE_SNAPSHOT';
  }

  let ageSessions = null;
  if (snapshotDate && today && snapshotDate < today) {
    ageSessions = tradingSessionsBetween(snapshotDate, today, holidaySet);
  } else if (snapshotDate && today && snapshotDate === today) {
    ageSessions = 0;
  }

  return {
    mode,
    now_wib: wib && wib.isValid ? `${wib.dateStr} ${wib.timeStr}` : null,
    today,
    is_trading_day_today: isTradingDayToday,
    snapshot_date: snapshotDate,
    snapshot_date_field: snapshotField,
    expected_date: expectedDate,
    acceptable_dates: acceptableDates,
    fresh,
    stale: !fresh,
    reason,
    age_sessions: ageSessions,
    holiday_source: 'idx_trading_calendar_seed'
  };
}

/**
 * Human/log-friendly one-line reason. Never includes secrets.
 */
function describeFreshness(result) {
  if (!result) return 'freshness_unknown';
  return 'STALE_SNAPSHOT: mode=' + result.mode +
    ' snapshot=' + (result.snapshot_date || 'none') +
    ' expected=' + (result.expected_date || 'none') +
    ' age_sessions=' + (result.age_sessions == null ? 'unknown' : result.age_sessions) +
    ' reason=' + result.reason;
}

module.exports = {
  DATE_FIELDS,
  TIMESTAMP_FIELDS,
  SAME_DAY_MODES,
  LATEST_COMPLETED_SESSION_MODES,
  validDateKey,
  jakartaDateOf,
  extractSnapshotDate,
  tradingSessionsBetween,
  evaluateSnapshotFreshness,
  describeFreshness
};
