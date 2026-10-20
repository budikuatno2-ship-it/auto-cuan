'use strict';

/**
 * Arjum failure classification + per-run failure summary (B1, 2026-10-20).
 *
 * Root problem this fixes: on 2026-10-19 the daily broker update sent 921
 * broker-summary requests that ALL failed (error 921/921, 0 persisted), but the
 * log recorded only the aggregate count — never the failure KIND. With no
 * status/type on record, the root cause of an entire day of lost data was
 * unprovable after the fact.
 *
 * This module is pure and dependency-free so it can be unit-tested without
 * booting a job. Every Arjum request failure should be classified with
 * classifyArjumFailure() and recorded via createFailureSummary(). The caller
 * prints the summary at the end of a run ("by type") and may persist it.
 *
 * Failure kinds (stable identifiers, safe to grep/aggregate):
 *   rate_limited     HTTP 429 or any "quota/rate limit/too many" message
 *   provider_5xx     HTTP 5xx (502/503/530 Cloudflare, 500/504, ...)
 *   transport        timeout / aborted / ECONNRESET / socket hang up / DNS
 *   auth             HTTP 401/403 (missing or rejected API key)
 *   client_4xx       other HTTP 4xx (400/404/422 ...)
 *   parse            invalid / empty JSON body
 *   unknown          anything else (no status, no recognizable error)
 */

const FAILURE_KINDS = Object.freeze([
  'rate_limited',
  'provider_5xx',
  'transport',
  'auth',
  'client_4xx',
  'parse',
  'unknown'
]);

/**
 * Classify a failed Arjum fetch result into a stable kind.
 * @param {{ok?: boolean, status?: number, error?: string, rateLimited?: boolean}} res
 * @returns {{kind: string, status: number|null, detail: string}}
 */
function classifyArjumFailure(res) {
  if (!res || typeof res !== 'object') {
    return { kind: 'unknown', status: null, detail: '' };
  }
  const msg = String(res.error || '').toLowerCase();
  const status = Number.isFinite(Number(res.status)) ? Number(res.status) : null;

  // Rate limit / quota wins over everything (it is the caller's hard stop).
  if (res.rateLimited === true || status === 429 ||
      /quota|rate.?limit|too many requests|limit reached|quota exceeded/.test(msg)) {
    return { kind: 'rate_limited', status, detail: res.error || (status ? `HTTP ${status}` : 'rate limited') };
  }

  // Transport first: a 504/408 or any timeout/connection keyword is a transport
  // failure even though 504 is technically a 5xx. This keeps the diagnosis
  // honest ("network/timeout" vs "provider returned 5xx").
  if (status === 504 || status === 408 ||
      /timeout|timed out|aborted|econnreset|etimedout|eai_again|econnrefused|socket hang up|network|fetch failed/.test(msg)) {
    return { kind: 'transport', status, detail: res.error || (status ? `HTTP ${status}` : 'transport error') };
  }

  if (status != null && status >= 500 && status <= 599) {
    return { kind: 'provider_5xx', status, detail: res.error || `HTTP ${status}` };
  }

  if (status === 401 || status === 403) {
    return { kind: 'auth', status, detail: res.error || `HTTP ${status}` };
  }

  if (/invalid json|unexpected token|empty response|invalid_yahoo|parse/.test(msg)) {
    return { kind: 'parse', status, detail: res.error || 'parse error' };
  }

  if (status != null && status >= 400 && status <= 499) {
    return { kind: 'client_4xx', status, detail: res.error || `HTTP ${status}` };
  }

  return { kind: 'unknown', status, detail: res.error || (status != null ? `HTTP ${status}` : '') };
}

/**
 * Create an in-memory, bounded failure summary for one run.
 * recordFailure() stores the kind + a bounded sample; formatSummary() renders
 * a stable multi-line block for the run log.
 */
function createFailureSummary(options = {}) {
  const maxSamplesPerKind = Number.isFinite(options.maxSamplesPerKind) && options.maxSamplesPerKind > 0
    ? Math.floor(options.maxSamplesPerKind)
    : 5;
  const counts = Object.create(null);
  const samples = Object.create(null);
  const firstAt = Object.create(null);
  const lastAt = Object.create(null);
  let total = 0;

  function recordFailure(res, context = {}) {
    const classified = classifyArjumFailure(res);
    total += 1;
    counts[classified.kind] = (counts[classified.kind] || 0) + 1;
    const now = context.at || new Date().toISOString();
    if (!firstAt[classified.kind]) firstAt[classified.kind] = now;
    lastAt[classified.kind] = now;
    if (!samples[classified.kind]) samples[classified.kind] = [];
    if (samples[classified.kind].length < maxSamplesPerKind) {
      samples[classified.kind].push({
        at: now,
        ticker: context.ticker || null,
        status: classified.status,
        detail: String(classified.detail || '').slice(0, 160)
      });
    }
    return classified;
  }

  function countsByKind() {
    const out = {};
    for (const kind of FAILURE_KINDS) {
      if (counts[kind]) out[kind] = counts[kind];
    }
    return out;
  }

  function toJSON() {
    return {
      total,
      counts: countsByKind(),
      first_at: Object.assign({}, firstAt),
      last_at: Object.assign({}, lastAt),
      samples: Object.assign({}, samples)
    };
  }

  function formatSummary() {
    const lines = [`Arjum failure summary: total=${total}`];
    for (const kind of FAILURE_KINDS) {
      if (!counts[kind]) continue;
      lines.push(`  - ${kind}: ${counts[kind]}`);
    }
    if (total === 0) lines.push('  (tidak ada kegagalan)');
    return lines.join('\n');
  }

  return {
    recordFailure,
    countsByKind,
    countOf: (kind) => counts[kind] || 0,
    getTotal: () => total,
    toJSON,
    formatSummary
  };
}

/**
 * B2 helper: decide whether a sequence of early requests shows a systemic
 * outage that justifies stopping a job instead of burning the rest of the
 * daily quota. Designed to be called after each of the first N requests.
 *
 * @param {Array<{kind?: string}>} outcomes ordered results (kind null/undefined = success)
 * @param {{minFirst?: number, failureRatio?: number, ratioWindow?: number}} [opts]
 * @returns {{trip: boolean, reason: string}}
 */
function shouldTripEarly(options = {}) {
  const outcomes = Array.isArray(options.outcomes) ? options.outcomes : [];
  const minFirst = Number.isFinite(options.minFirst) && options.minFirst > 0
    ? Math.floor(options.minFirst) : 20;
  const windowSize = Number.isFinite(options.ratioWindow) && options.ratioWindow > 0
    ? Math.floor(options.ratioWindow) : 50;
  const failureRatio = Number.isFinite(options.failureRatio) && options.failureRatio > 0
    ? options.failureRatio : 0.5;

  const isFail = (o) => Boolean(o && o.kind);
  const firstN = outcomes.slice(0, minFirst);

  // Rule 1: the first `minFirst` attempts all failed.
  if (firstN.length >= minFirst && firstN.every(isFail)) {
    return { trip: true, reason: `first_${minFirst}_all_failed` };
  }

  // Rule 2: > failureRatio of the first `windowSize` attempts failed.
  const win = outcomes.slice(0, windowSize);
  if (win.length >= windowSize) {
    const failed = win.filter(isFail).length;
    if (failed / win.length > failureRatio) {
      return { trip: true, reason: `>${Math.round(failureRatio * 100)}pct_failed_in_first_${windowSize}` };
    }
  }

  return { trip: false, reason: '' };
}

module.exports = {
  FAILURE_KINDS,
  classifyArjumFailure,
  createFailureSummary,
  shouldTripEarly
};