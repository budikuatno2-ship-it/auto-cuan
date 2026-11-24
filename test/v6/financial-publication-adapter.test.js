'use strict';

/**
 * test/v6/financial-publication-adapter.test.js — M-P1d adapter honesty tests.
 * Zero network access: sources are stubbed in-memory. The UNIMPLEMENTED
 * IDX/OJK source is exercised to prove honest BLOCKED_UPSTREAM behavior.
 */

const test = require('node:test');
const assert = require('node:assert');

const adapter = require('../../lib/financial-publication-adapter');
const monitor = require('../../lib/financial-publication-monitor');

function makeRecord(overrides = {}) {
  return Object.assign({
    ticker: 'BBRI',
    fiscal_year: 2026,
    period: 'Q3',
    period_end: '2026-09-30',
    nominal_check_date: '2026-10-31',
    actual_check_date: '2026-10-30',
    publication_at: null,
    retrieval_at: null,
    source_url: null,
    audited_reviewed: false,
    as_of: null,
    status: monitor.STATUS.DUE,
    checksum: null,
    last_check_at: null,
    next_check_at: null,
    retry_count: 0
  }, overrides);
}

test('(a) stub adapter returns evidence => PUBLISHED_VERIFIED with checksum', async () => {
  const checksum = 'a'.repeat(64);
  const src = adapter.createSource({
    id: 'stub-live',
    async fetchPublicationIndex() {
      return {
        available: true,
        publication_at: '2026-10-28',
        source_url: 'https://example.local/BBRI/Q3-2026',
        audited_reviewed: false,
        checksum
      };
    }
  });
  const rec = makeRecord();
  const res = await adapter.checkWithAdapter(rec, src, { now: '2026-10-30' });
  assert.strictEqual(res.outcome, adapter.OUTCOME.VERIFIED);
  assert.strictEqual(res.record.status, monitor.STATUS.PUBLISHED_VERIFIED);
  assert.strictEqual(res.record.publication_at, '2026-10-28');
  assert.strictEqual(res.record.checksum, checksum);
  assert.strictEqual(res.record.next_check_at, null); // loop stops
});

test('(b) stub returns null publication => upstream unknown + retry scheduled', async () => {
  const src = adapter.createSource({
    id: 'stub-live',
    async fetchPublicationIndex() {
      return { available: true, publication_at: null, checksum: 'x' };
    }
  });
  const rec = makeRecord();
  const res = await adapter.checkWithAdapter(rec, src, { now: '2026-10-30' });
  assert.strictEqual(res.outcome, adapter.OUTCOME.BLOCKED_UPSTREAM);
  assert.strictEqual(res.record.status, monitor.STATUS.UPSTREAM_UNAVAILABLE);
  assert.strictEqual(res.record.publication_at, null);
  assert.strictEqual(res.record.retry_count, 0);
  assert.strictEqual(res.record.next_check_at, '2026-11-14'); // 15-day default cadence
});

test('(c) UNIMPLEMENTED IDX/OJK source => SOURCE_UNAVAILABLE => BLOCKED_UPSTREAM, no fetch loop', async () => {
  const src = adapter.createUnimplementedIdxOjkSource();
  assert.strictEqual(src.id, 'idx-ojk-official');
  let calls = 0;
  const wrapped = adapter.createSource({
    id: 'counter',
    async fetchPublicationIndex(q) { calls++; return src.fetchPublicationIndex(q); }
  });
  const rec = makeRecord();
  const res = await adapter.checkWithAdapter(rec, wrapped, { now: '2026-10-30' });
  assert.strictEqual(calls, 1); // exactly one attempt, no loop
  assert.strictEqual(res.outcome, adapter.OUTCOME.BLOCKED_UPSTREAM);
  assert.strictEqual(res.record.status, monitor.STATUS.UPSTREAM_UNAVAILABLE);
  assert.strictEqual(res.record.publication_at, null); // never fabricated
  assert.ok(String(res.reason).startsWith('UNIMPLEMENTED_LIVE_SOURCE'));
  assert.strictEqual(res.record.next_check_at, '2026-11-14'); // backoff scheduled
});

test('(d) revision detection: changed checksum reopens a verified record', async () => {
  const previousChecksum = 'b'.repeat(64);
  const rec = makeRecord({
    status: monitor.STATUS.PUBLISHED_VERIFIED,
    publication_at: '2026-10-28',
    retrieval_at: '2026-10-30',
    source_url: 'https://example.local/BBRI/Q3-2026',
    checksum: previousChecksum,
    audited_reviewed: false,
    as_of: '2026-10-30'
  });
  let fetchCount = 0;
  const src = adapter.createSource({
    id: 'stub-live',
    async fetchPublicationIndex() {
      fetchCount++;
      return {
        available: true,
        publication_at: '2026-11-10', // revised publication date
        source_url: 'https://example.local/BBRI/Q3-2026-r2',
        checksum: 'c'.repeat(64) // CHANGED SHA-256 shape
      };
    }
  });
  const res = await adapter.checkWithAdapter(rec, src, { now: '2026-11-12' });
  assert.strictEqual(fetchCount, 1);
  assert.strictEqual(res.revision, true);
  assert.strictEqual(res.outcome, adapter.OUTCOME.VERIFIED);
  // Reopened via REVISION_DETECTED then re-verified with the NEW evidence.
  assert.strictEqual(res.record.status, monitor.STATUS.PUBLISHED_VERIFIED);
  assert.strictEqual(res.record.checksum, 'c'.repeat(64));
  assert.strictEqual(res.record.publication_at, '2026-11-10');
});

test('(d2) identical checksum on verified record => no revision, loop stays stopped', async () => {
  const checksum = 'd'.repeat(64);
  const rec = makeRecord({
    status: monitor.STATUS.PUBLISHED_VERIFIED,
    publication_at: '2026-10-28',
    retrieval_at: '2026-10-30',
    source_url: 'https://example.local/BBRI/Q3-2026',
    audited_reviewed: false,
    as_of: '2026-10-30',
    checksum
  });
  const src = adapter.createSource({
    id: 'stub-live',
    async fetchPublicationIndex() {
      return { available: true, publication_at: '2026-10-28', source_url: 'https://example.local/BBRI/Q3-2026', checksum };
    }
  });
  const res = await adapter.checkWithAdapter(rec, src, { now: '2026-11-12' });
  assert.strictEqual(res.revision, false);
  assert.strictEqual(res.record.checksum, checksum);
});

test('(e) dry-run / local-evidence source makes zero network calls', async () => {
  // Track any accidental network use.
  const originalFetch = global.fetch;
  let networkCalls = 0;
  global.fetch = async () => { networkCalls++; throw new Error('NETWORK FORBIDDEN IN TEST'); };
  try {
    const local = adapter.createLocalEvidenceSource({
      'BBRI|2026|Q3': {
        publication_at: '2026-10-28',
        source_url: 'https://local.invalid/data/financial-imports/BBRI-q3-2026.json',
        checksum: 'e'.repeat(64)
      }
    });
    const res = await adapter.checkWithAdapter(makeRecord(), local, { now: '2026-10-30' });
    assert.strictEqual(res.outcome, adapter.OUTCOME.VERIFIED);
    assert.strictEqual(networkCalls, 0);

    // Missing local evidence: honest unavailable, still zero network.
    const missing = adapter.createLocalEvidenceSource({});
    const res2 = await adapter.checkWithAdapter(makeRecord({ ticker: 'TLKM' }), missing, { now: '2026-10-30' });
    assert.strictEqual(res2.outcome, adapter.OUTCOME.BLOCKED_UPSTREAM);
    assert.strictEqual(res2.reason, 'NO_LOCAL_EVIDENCE');
    assert.strictEqual(networkCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('(f) no fabricated publication_at ever: invalid adapter shapes normalize to unavailable', async () => {
  // Source returns garbage -> no crash, no evidence.
  const garbage = adapter.createSource({ id: 'garbage', async fetchPublicationIndex() { return null; } });
  const res1 = await adapter.checkWithAdapter(makeRecord(), garbage, { now: '2026-10-30' });
  assert.strictEqual(res1.outcome, adapter.OUTCOME.BLOCKED_UPSTREAM);
  assert.strictEqual(res1.record.publication_at, null);

  // Missing date is unknown, not evidence that publication did not occur.
  const noDate = adapter.createSource({
    id: 'no-date',
    async fetchPublicationIndex() { return { available: true, checksum: 'x', source_url: 'y' }; }
  });
  const res2 = await adapter.checkWithAdapter(makeRecord(), noDate, { now: '2026-10-30' });
  assert.strictEqual(res2.outcome, adapter.OUTCOME.BLOCKED_UPSTREAM);
  assert.strictEqual(res2.record.publication_at, null);
  assert.strictEqual(res2.record.status, monitor.STATUS.UPSTREAM_UNAVAILABLE);

  // Unimplemented source never yields a date either.
  const unimpl = await adapter.createUnimplementedIdxOjkSource().fetchPublicationIndex({});
  assert.strictEqual(unimpl.available, false);
  assert.strictEqual(unimpl.publication_at, undefined);
});

test('(g) resolveSource returns honest built-ins only', async () => {
  const official = adapter.resolveSource('idx-ojk-official');
  assert.strictEqual(official.id, 'idx-ojk-official');
  const local = adapter.resolveSource('local-evidence', { evidenceMap: {} });
  assert.strictEqual(local.id, 'local-evidence');
  assert.strictEqual(adapter.resolveSource('nonexistent'), null);
  assert.throws(() => adapter.createSource({ id: 'x' }), /fetchPublicationIndex/);
});
