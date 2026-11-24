'use strict';

/**
 * lib/financial-publication-adapter.js — M-P1d Live Adapter Honesty Layer
 * ============================================================================
 * Pluggable source interface for financial publication metadata. The monitor
 * (lib/financial-publication-monitor.js) may ONLY set PUBLISHED_VERIFIED from
 * adapter evidence; a source that cannot honestly answer returns
 * SOURCE_UNAVAILABLE and the monitor reports BLOCKED_UPSTREAM instead of
 * pretending the quarter is published or missing.
 *
 * SOURCE INTERFACE
 * ----------------
 * Each source is:
 *   {
 *     id: string,
 *     fetchPublicationIndex({ ticker, period, fiscalYear })
 *       -> { available: true,  publication_at, source_url, audited_reviewed, checksum }
 *        | { available: false, reason: string }   // SOURCE_UNAVAILABLE shape
 *   }
 *
 * HONESTY CONTRACT
 * ----------------
 *  - `publication_at` is ONLY ever surfaced from explicit adapter evidence.
 *    There is no code path in this module that derives or fabricates it.
 *  - The IDX/OJK official metadata source is NOT IMPLEMENTED in this codebase
 *    (no verified upstream metadata API/scrape exists here). The built-in
 *    'idx-ojk-official' source returns SOURCE_UNAVAILABLE with reason
 *    'UNIMPLEMENTED_LIVE_SOURCE' so the monitor reports BLOCKED_UPSTREAM
 *    honestly instead of running an unverified fetch loop.
 * ============================================================================
 */

const monitor = require('./financial-publication-monitor');

const ADAPTER_VERSION = 'financial-publication-adapter-v1';

const OUTCOME = Object.freeze({
  VERIFIED: 'PUBLISHED_VERIFIED',
  NOT_PUBLISHED: 'NOT_PUBLISHED',
  BLOCKED_UPSTREAM: 'BLOCKED_UPSTREAM'
});

/** Build a source object with a normalized fetch wrapper. */
function createSource(definition) {
  if (!definition || typeof definition.id !== 'string' || !definition.id.trim()) {
    throw new Error('source id is required');
  }
  if (typeof definition.fetchPublicationIndex !== 'function') {
    throw new Error('source fetchPublicationIndex must be a function');
  }
  return {
    id: definition.id.trim(),
    version: definition.version || ADAPTER_VERSION,
    async fetchPublicationIndex(query) {
      const result = await definition.fetchPublicationIndex(query);
      if (!result || typeof result !== 'object') {
        return { available: false, reason: 'SOURCE_RETURNED_INVALID_SHAPE' };
      }
      if (result.available !== true) {
        return { available: false, not_published: result.not_published === true,
          reason: String(result.reason || 'SOURCE_UNAVAILABLE') };
      }
      // Evidence without publication_at is an unknown observation, not proof
      // that the issuer has not published. Keep it separate from an explicit
      // negative response so callers cannot turn missing metadata into MISSING.
      if (result.publication_at == null) {
        return { available: false, reason: 'PUBLICATION_DATE_EVIDENCE_MISSING' };
      }
      return {
        available: true,
        publication_at: result.publication_at,
        source_url: result.source_url || null,
        audited_reviewed: result.audited_reviewed === true,
        checksum: result.checksum != null ? String(result.checksum) : null
      };
    }
  };
}

/**
 * The official IDX/OJK publication metadata source. UNIMPLEMENTED: this
 * codebase contains no verified IDX/OJK metadata adapter, so it always returns
 * SOURCE_UNAVAILABLE. The monitor must treat this as BLOCKED_UPSTREAM and
 * never loop-fetch against it.
 */
function createUnimplementedIdxOjkSource() {
  return createSource({
    id: 'idx-ojk-official',
    version: ADAPTER_VERSION,
    async fetchPublicationIndex() {
      return {
        available: false,
        reason: 'UNIMPLEMENTED_LIVE_SOURCE: IDX/OJK official publication metadata adapter is not implemented in this codebase; XREQ-09 stays LOCAL_PLANNER_ONLY/BLOCKED_UPSTREAM until a real metadata source is approved.'
      };
    }
  });
}

/**
 * Local-evidence source: reads publication metadata previously imported and
 * verified locally (data/financial-publication/local-evidence.json keyed by
 * `TICKER|FY|PERIOD`). Only explicit recorded evidence is served; anything
 * absent is SOURCE_UNAVAILABLE with reason NO_LOCAL_EVIDENCE. No network.
 */
function createLocalEvidenceSource(evidenceMap) {
  const map = evidenceMap || {};
  return createSource({
    id: 'local-evidence',
    version: ADAPTER_VERSION,
    async fetchPublicationIndex({ ticker, period, fiscalYear }) {
      const key = `${String(ticker || '').trim().toUpperCase()}|${Number(fiscalYear)}|${String(period || '').trim().toUpperCase()}`;
      const hit = map[key];
      if (!hit) return { available: false, reason: 'NO_LOCAL_EVIDENCE' };
      return {
        available: true,
        publication_at: hit.publication_at,
        source_url: hit.source_url || null,
        audited_reviewed: hit.audited_reviewed === true,
        checksum: hit.checksum != null ? String(hit.checksum) : null
      };
    }
  });
}

function resolveSource(id, extra) {
  const wanted = String(id || '').trim().toLowerCase();
  if (wanted === 'idx-ojk-official') return createUnimplementedIdxOjkSource();
  if (wanted === 'local-evidence') return createLocalEvidenceSource(extra && extra.evidenceMap);
  return null;
}

/**
 * Run one adapter-backed check for a record and produce the next record state
 * via the monitor's existing transitions (applyCheckOutcome / detectRevision).
 *
 * Status flow:
 *   evidence with publication_at (+ checksum) -> PUBLISHED_VERIFIED
 *   changed checksum on a verified record     -> REVISION_DETECTED (reopens)
 *   source says "not published" evidence-free -> NOT_PUBLISHED (MISSING_RETRY
 *                                                + next_check_at scheduled)
 *   source unavailable                        -> BLOCKED_UPSTREAM
 *                                                (monitor UPSTREAM_UNAVAILABLE)
 *
 * @param {object} record       monitor record (evaluateRecord-compatible)
 * @param {object} source       adapter source (createSource product)
 * @param {object} [options]    { now, retryIntervalDays, query }
 * @returns {{outcome:string, record:object, evidence:object|null, reason:string|null}}
 */
async function checkWithAdapter(record, source, options = {}) {
  if (!source || typeof source.fetchPublicationIndex !== 'function') {
    throw new Error('adapter source is required');
  }
  const query = Object.assign({
    ticker: record.ticker,
    period: record.period,
    fiscalYear: record.fiscal_year
  }, options.query || {});

  const result = await source.fetchPublicationIndex(query);
  const now = options.now || new Date().toISOString();

  if (result.available === true) {
    // Revision detection first: a verified record with a changed checksum reopens.
    const revision = monitor.detectRevision(record, result.checksum, { now });
    const next = monitor.applyCheckOutcome(revision.record, {
      published: true,
      publicationAt: result.publication_at,
      sourceUrl: result.source_url,
      checksum: result.checksum,
      auditedReviewed: result.audited_reviewed,
      now,
      retryIntervalDays: options.retryIntervalDays
    });
    const verified = next.status === monitor.STATUS.PUBLISHED_VERIFIED;
    return {
      outcome: verified ? OUTCOME.VERIFIED : OUTCOME.BLOCKED_UPSTREAM,
      revision: revision.revision,
      record: next,
      evidence: verified ? result : null,
      reason: verified ? (revision.revision ? 'revision_reverified' : null) : 'INVALID_PUBLICATION_EVIDENCE'
    };
  }

  // Source unavailable or publication evidence absent -> honest BLOCKED_UPSTREAM.
  // Only an explicit reachable negative observation may enter MISSING_RETRY.
  if (result.not_published !== true) {
    return {
      outcome: OUTCOME.BLOCKED_UPSTREAM,
      revision: false,
      record: monitor.applyCheckOutcome(record, {
        upstreamUnavailable: true,
        now,
        retryIntervalDays: options.retryIntervalDays
      }),
      evidence: null,
      reason: result.reason || 'SOURCE_UNAVAILABLE'
    };
  }

  // Source is reachable but observed NO published data -> NOT_PUBLISHED with a
  // scheduled retry (monitor transitions to MISSING_RETRY with next_check_at).
  return {
    outcome: OUTCOME.NOT_PUBLISHED,
    revision: false,
    record: monitor.applyCheckOutcome(record, {
      published: false,
      now,
      retryIntervalDays: options.retryIntervalDays
    }),
    evidence: null,
    reason: result.reason || null
  };
}

module.exports = {
  ADAPTER_VERSION,
  OUTCOME,
  createSource,
  createUnimplementedIdxOjkSource,
  createLocalEvidenceSource,
  resolveSource,
  checkWithAdapter
};
