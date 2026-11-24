'use strict';

const {validDay, timestamp} = require('./insider-source-visibility');
const STATES = new Set(['LISTED','SUSPENDED','NO_TRADE','NOT_LISTED','TICKER_CHANGED']);
function provenance(r) {
  return !!r && r.verified === true && typeof r.source === 'string' && !!r.source.trim()
    && timestamp(r.source_as_of) !== null && typeof r.source_sha256 === 'string' && /^[a-f0-9]{64}$/i.test(r.source_sha256);
}
function evidence(r) { return {source:r.source,source_as_of:r.source_as_of,source_sha256:r.source_sha256}; }
function active(r, date) { return r.effective_from <= date && (r.effective_to == null || date < r.effective_to); }
function interval(r) {
  return validDay(r.effective_from) && (r.effective_to == null || (validDay(r.effective_to) && r.effective_from < r.effective_to));
}
/** Read-only reference consumer. Verification flags must be supplied by a trusted importer,
 * never by a public request. No filesystem/live-universe fallback is authoritative.
 * Intervals are [effective_from, effective_to): listing/resume day included,
 * delisting/suspension end day excluded. NOT_LISTED is an explicit interval.
 */
function resolveEligibility(ticker, date, reference = {}) {
  const clean = typeof ticker === 'string' ? ticker.trim().toUpperCase() : '';
  const result = (status,reason,rows=[]) => ({ticker:clean,date,status,reason,evidence:rows.map(evidence)});
  if (!/^[A-Z0-9]{1,12}$/.test(clean) || !validDay(date)) return result('UNKNOWN','INVALID_TICKER_OR_DATE');
  const records = Array.isArray(reference.records) ? reference.records : [];
  const relevant = records.filter(r => r && r.ticker === clean);
  if (relevant.some(r => !provenance(r) || !interval(r) || !STATES.has(r.state) || typeof r.security_id !== 'string' || !r.security_id.trim())) return result('UNKNOWN','INVALID_OR_UNVERIFIED_TICKER_REFERENCE');
  const matches = relevant.filter(r => active(r,date));
  if (matches.length === 0) {
    const boundary = relevant.filter(r => r.state === 'LISTED' && r.effective_to === date);
    if (boundary.length === 1) {
      const id = boundary[0].security_id;
      const replacements = records.filter(r => r && r.security_id === id && r.ticker !== clean && r.effective_from === date && active(r,date));
      if (replacements.length > 1 || replacements.some(r => !provenance(r) || !interval(r) || r.state !== 'LISTED')) return result('UNKNOWN','CONFLICTING_OR_UNVERIFIED_TICKER_CHANGE',[boundary[0], ...replacements]);
      const replacement = replacements[0];
      return result('INELIGIBLE',replacement ? 'TICKER_CHANGED' : 'NOT_LISTED_ON_DATE',[boundary[0], ...(replacement ? [replacement] : [])]);
    }
  }
  if (matches.length !== 1) return result('UNKNOWN',matches.length ? 'CONFLICTING_OR_DUPLICATE_TICKER_REFERENCE' : 'NO_DATE_EFFECTIVE_TICKER_REFERENCE');
  const row = matches[0];
  // An issuer/security cannot simultaneously trade under two symbols. Ticker changes
  // must terminate the old interval and begin a new one; no implicit alias remapping.
  const identities = records.filter(r => r && r.security_id === row.security_id && active(r,date));
  if (identities.length !== 1 || identities.some(r => !provenance(r) || !interval(r))) return result('UNKNOWN','CONFLICTING_SECURITY_IDENTITY');
  const reasons = {SUSPENDED:'SUSPENDED_VERIFIED',NO_TRADE:'NO_TRADE_PROVEN',NOT_LISTED:'NOT_LISTED_ON_DATE',TICKER_CHANGED:'TICKER_CHANGED'};
  if (row.state !== 'LISTED') return result('INELIGIBLE',reasons[row.state],[row]);
  const calendar = (Array.isArray(reference.calendar) ? reference.calendar : []).filter(r => r && r.date === date);
  if (calendar.length !== 1) return result('UNKNOWN',calendar.length ? 'CONFLICTING_OR_DUPLICATE_CALENDAR' : 'CALENDAR_NOT_VERIFIED',[row]);
  const day = calendar[0];
  if (!provenance(day) || !['TRADING_DAY','HOLIDAY','WEEKEND','EXCHANGE_CLOSED'].includes(day.state)) return result('UNKNOWN','CALENDAR_NOT_VERIFIED',[row]);
  return day.state === 'TRADING_DAY' ? result('ELIGIBLE','LISTED_ON_VERIFIED_TRADING_DAY',[row,day]) : result('INELIGIBLE','NON_TRADING_DAY',[row,day]);
}
function preflightEligibility(tickers, date, reference) {
  const rows = [...new Set(tickers)].map(t => resolveEligibility(t,date,reference));
  return {rows,status:rows.length && rows.every(r=>r.status !== 'UNKNOWN') ? 'RESOLVED_SUPPLIED_CANDIDATES' : 'UNKNOWN',historical_denominator:null};
}
module.exports = {resolveEligibility,preflightEligibility};
