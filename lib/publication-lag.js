'use strict';

/**
 * lib/publication-lag.js
 * ============================================================================
 * V5 Phase 3 — Fundamental Publication Lag Guard (N10 / BUG-V5-P1-012)
 * ============================================================================
 *
 * INVARIANT
 *   A fundamental record (financial statement, ratio, market-structure fact)
 *   must NEVER be treated as known/usable on a live surface before its
 *   publication date. Consumption is ordered against the publication date
 *   plus a configurable lag:
 *
 *       usable  <=>  asOfDate >= publishedAt + publicationLagDays (trading days)
 *
 *   A record that carries NO publication date is UNKNOWN_PUBLICATION and is
 *   NOT usable on live surfaces. It may only be consumed when the caller
 *   explicitly passes `allowUnverified: true` — and that escape hatch is
 *   always logged so the audit trail records every unverified read.
 *
 * DESIGN NOTES
 *   - The lag is counted in TRADING days (Sat/Sun skipped) because IDX
 *     publishes financial statements on trading days. Default lag = 1
 *     trading day, configurable via policy.publicationLagDays.
 *   - This module never mutates caller data and never performs I/O.
 *
 * CONSUMERS (live surfaces wired in V5 Phase 3):
 *   - lib/local-market-subset-store.js  getFinancialSnapshot  (chart fundamentals panel)
 *   - lib/daily-market-context-builder.js buildContextFromRows (AI analysis context)
 *   - lib/financial-snapshot.js buildFinancialSnapshot        (fundamental snapshot API)
 *   - lib/backtest-individual-964.js checkFundamentalQ2       (point-in-time backtest guard)
 * ============================================================================
 */

const DEFAULT_PUBLICATION_LAG_DAYS = 1; // trading days

/** Item-level keys recognised as a publication/announcement timestamp. */
const PUBLICATION_DATE_KEYS = [
  'published_at',
  'publication_date',
  'publish_date',
  'announcement_date',
  'announced_at',
  'filing_date',
  'effective_date'
];

/** Metadata marker written by scripts/backfill-fundamental-publication-dates.js */
const REGULATORY_DEADLINE_BASIS = 'regulatory_deadline_conservative';

function parseDateLike(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(value).trim();
  if (!s) return null;
  // Plain YYYY-MM-DD → treat as end-of-day Jakarta so same-day consumption
  // after publication still passes, but the lag still applies forward.
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (plain) {
    const d = new Date(s + 'T16:00:00+07:00');
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseAsOf(asOfDate) {
  const d = parseDateLike(asOfDate);
  if (d) return d;
  // No asOf supplied → "now". Live surfaces consume at wall-clock time.
  return new Date();
}

/**
 * Advance a date by `n` trading days (Mon-Fri). Returns a Date.
 */
function addTradingDays(from, n) {
  const d = new Date(from.getTime());
  let remaining = Math.max(0, Math.round(Number(n) || 0));
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return d;
}

/**
 * Extract the publication date from a fundamental record.
 * Returns { status, publishedAt (Date|null), raw, basis }.
 *   status: 'OK' | 'UNKNOWN_PUBLICATION'
 */
function resolvePublicationDate(fundamental) {
  if (!fundamental || typeof fundamental !== 'object') {
    return { status: 'UNKNOWN_PUBLICATION', publishedAt: null, raw: null, basis: null };
  }
  for (const key of PUBLICATION_DATE_KEYS) {
    if (!(key in fundamental)) continue;
    const raw = fundamental[key];
    const parsed = parseDateLike(raw);
    if (parsed) {
      return {
        status: 'OK',
        publishedAt: parsed,
        raw,
        basis: fundamental.publication_basis || 'explicit'
      };
    }
  }
  return { status: 'UNKNOWN_PUBLICATION', publishedAt: null, raw: null, basis: null };
}

let allowUnverifiedLogSink = null;
function setAllowUnverifiedLogSink(fn) { allowUnverifiedLogSink = typeof fn === 'function' ? fn : null; }
function logAllowUnverified(context) {
  const entry = {
    at: new Date().toISOString(),
    event: 'PUBLICATION_LAG_ALLOW_UNVERIFIED',
    context: context || null
  };
  // Always emit to stdout (forensic trail); never throw.
  try { process.stdout.write('[publication-lag] ' + JSON.stringify(entry) + '\n'); } catch (_) {}
  if (allowUnverifiedLogSink) {
    try { allowUnverifiedLogSink(entry); } catch (_) {}
  }
}

/**
 * The gate. Returns a decision object; never throws.
 *
 * @param {Object} fundamental   Fundamental record (may be null/shape-less).
 * @param {String|Date|null} asOfDate  Consumption timestamp / trading date.
 * @param {Object} [policy]
 * @param {Number} [policy.publicationLagDays=1]  Trading-day lag after publication.
 * @param {Boolean} [policy.allowUnverified=false] Explicit escape hatch for
 *        UNKNOWN_PUBLICATION records; every use is logged.
 * @param {String} [policy.context]  Caller label for the audit log.
 * @returns {{usable:boolean, status:'OK'|'UNKNOWN_PUBLICATION', reason:string,
 *            publishedAt:string|null, usableFrom:string|null, asOf:string}}
 */
function gateRecord(fundamental, asOfDate, policy) {
  const opts = policy || {};
  const lagDays = Number.isFinite(Number(opts.publicationLagDays))
    ? Number(opts.publicationLagDays)
    : DEFAULT_PUBLICATION_LAG_DAYS;
  const asOf = parseAsOf(asOfDate);
  const asOfIso = asOf.toISOString();
  const resolved = resolvePublicationDate(fundamental);

  if (resolved.status !== 'OK') {
    if (opts.allowUnverified === true) {
      logAllowUnverified({ surface: opts.context || 'unspecified', asOf: asOfIso });
      return {
        usable: true,
        status: 'UNKNOWN_PUBLICATION',
        reason: 'allowUnverified=true — unverified fundamental consumed (logged)',
        publishedAt: null,
        usableFrom: null,
        asOf: asOfIso
      };
    }
    return {
      usable: false,
      status: 'UNKNOWN_PUBLICATION',
      reason: 'fundamental record carries no publication date (UNKNOWN_PUBLICATION)',
      publishedAt: null,
      usableFrom: null,
      asOf: asOfIso
    };
  }

  const usableFrom = addTradingDays(resolved.publishedAt, lagDays);
  const usable = asOf.getTime() >= usableFrom.getTime();
  return {
    usable,
    status: 'OK',
    reason: usable
      ? 'published ' + resolved.publishedAt.toISOString() + ' + ' + lagDays + ' trading day(s) lag satisfied'
      : 'publication lag not yet satisfied (usable from ' + usableFrom.toISOString() + ')',
    publishedAt: resolved.publishedAt.toISOString(),
    usableFrom: usableFrom.toISOString(),
    asOf: asOfIso
  };
}

/**
 * Convenience predicate — true only when the record is published and the
 * lag window has elapsed at `asOfDate`.
 */
function isPublished(fundamental, asOfDate, policy) {
  return gateRecord(fundamental, asOfDate, policy).usable;
}

/**
 * Conservative regulatory publication deadline for an IDX financial-statement
 * period. Used ONLY by the offline backfill migration
 * (scripts/backfill-fundamental-publication-dates.js) to stamp stored records
 * that predate publication tracking. Deadlines are the LATEST allowed filing
 * date, so the stamped value is an upper bound: consumption gated on it can
 * never see the data earlier than real-world publication.
 *
 *   Q1 / Q3  -> quarter end + 30 calendar days
 *   Q2 (H1)  -> period end + 90 calendar days
 *   Q4 / FY  -> fiscal year end + 90 calendar days
 *
 * @param {String} periodLabel  e.g. "FY 2025", "Q2 2026", "Q1", "FY"
 * @param {String} year         e.g. "2025"
 * @returns {{publishedAt:Date|null, basis:String, periodEnd:String|null}}
 */
function deriveRegulatoryDeadline(periodLabel, year) {
  const label = String(periodLabel || '').toUpperCase();
  const y = parseInt(String(year || '').trim(), 10);
  if (!Number.isFinite(y) || y < 1990 || y > 2100) {
    return { publishedAt: null, basis: null, periodEnd: null };
  }
  let periodEnd = null;
  let days = 0;
  const qMatch = /Q([1-4])/.exec(label);
  const isFY = label.indexOf('FY') >= 0 || qMatch === null;
  if (qMatch) {
    const q = parseInt(qMatch[1], 10);
    const endMonthByQuarter = { 1: '03', 2: '06', 3: '09', 4: '12' };
    const lastDayByQuarter = { 1: '31', 2: '30', 3: '30', 4: '31' };
    periodEnd = y + '-' + endMonthByQuarter[q] + '-' + lastDayByQuarter[q];
    days = (q === 2 || q === 4) ? 90 : 30;
  } else if (isFY) {
    periodEnd = y + '-12-31';
    days = 90;
  }
  if (!periodEnd) return { publishedAt: null, basis: null, periodEnd: null };
  // +16:00 WIB on the deadline day (IDX filings due end of trading day).
  const publishedAt = new Date(periodEnd + 'T16:00:00+07:00');
  publishedAt.setDate(publishedAt.getDate() + days);
  return { publishedAt, basis: REGULATORY_DEADLINE_BASIS, periodEnd };
}

module.exports = {
  DEFAULT_PUBLICATION_LAG_DAYS,
  PUBLICATION_DATE_KEYS,
  REGULATORY_DEADLINE_BASIS,
  resolvePublicationDate,
  gateRecord,
  isPublished,
  addTradingDays,
  deriveRegulatoryDeadline,
  setAllowUnverifiedLogSink
};
