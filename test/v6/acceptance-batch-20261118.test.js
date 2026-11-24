'use strict';
// OFFLINE SYNTHETIC FIXTURES ONLY. Never production data or provider evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../../lib/manual-screener');
const monitor = require('../../lib/financial-publication-monitor');
// This suite creates disk fixtures: refuse execution outside the temp mirror.
assert.ok(process.env.OFFLINE_MIRROR_ROOT, 'Use acceptance batch run_offline.py');
assert.equal(path.resolve(__dirname, '../..'), path.resolve(process.env.OFFLINE_MIRROR_ROOT));
const adapter = require('../../lib/financial-publication-adapter');
const insider = require('../../lib/insider-network-service');
const { runPublicationCheck } = require('../../tools/run-financial-publication-check');
const NOW = Date.parse('2026-11-18T05:00:00Z');
const row = (x = {}) => ({ ticker: 'OFFLINE', price: 100, pbv: null, _as_of: '2026-11-17', ...x });
const rule = (field) => ({ field, op: 'gt', value: 0 });
test('isolation enforcement blocks outbound sockets, fetch and writes outside mirror', () => {
  assert.throws(() => require('node:net').connect(443, 'offline.invalid'), /OFFLINE_NETWORK_OR_PROCESS_DENIED/);
  assert.throws(() => global.fetch('https://offline.invalid'), /OFFLINE_NETWORK_OR_PROCESS_DENIED/);
  assert.throws(() => fs.writeFileSync(path.resolve(process.env.OFFLINE_MIRROR_ROOT, '../forbidden-fixture'), 'x'), /OFFLINE_WRITE_OUTSIDE_MIRROR_DENIED/);
});
for (const logic of ['AND', 'OR']) {
  for (const a of [true, false, null]) for (const b of [true, false, null]) {
    test(`XREQ-02 truth table ${logic}(${a},${b}) including nested group`, () => {
      const expected = logic === 'AND' ? (a === false || b === false ? false : a === null || b === null ? null : true)
        : (a === true || b === true ? true : a === null || b === null ? null : false);
      const r = engine.runScreen({ rows: [row({ price: a === null ? null : +a, pbv: b === null ? null : +b })], nowMs: NOW,
        rules: { logic: 'AND', rules: [{ logic, rules: [rule('price'), rule('pbv')] }] } });
      assert.equal(r.matched_count, +(expected === true));
      assert.equal(r.excluded_unknown, +(expected === null));
      assert.equal(r.excluded_null, +(expected === false));
    });
  }
}
test('XREQ-02 actual disk enumeration scans 1105 fixtures beyond both legacy caps', () => {
  const dir = path.resolve(__dirname, '../../data/daily-candles');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 1105; i++) fs.writeFileSync(path.join(dir, `OFFLINE${String(i).padStart(4, '0')}.json`), JSON.stringify({ candles: [
    { date: '2026-11-16', close: 99, volume: null }, { date: '2026-11-17', close: 100 + i, volume: null }
  ] }));
  const r = engine.runScreen({ nowMs: NOW, universeCap: 1, rules: { logic: 'AND', rules: [{ field: 'price', op: 'gt', value: 1203 }] } });
  assert.equal(r.scanned, 1105); assert.equal(r.universe_truncated, false);
  assert.equal(r.matched_count, 1); assert.equal(r.matched[0].ticker, 'OFFLINE1104');
  assert.equal(r.matched[0].values.volume, null); assert.equal(r.matched[0].values.pbv, null);
});
test('REQ-21 partial: HSC predicate independent of free-float threshold', () => {
  const r = engine.runScreen({ rows: [row({ ticker: 'HSC_HIGH', hsc_status: 'HSC', free_float_pct: 40 }),
    row({ ticker: 'NON_LOW', hsc_status: 'NON_HSC', free_float_pct: 5 }), row({ ticker: 'UNKNOWN_LOW', hsc_status: null, free_float_pct: 2 })],
    nowMs: NOW, rules: { logic: 'AND', rules: [{ field: 'hsc_status', op: 'eq', value: 'HSC' }] } });
  assert.deepEqual(r.matched.map(x => x.ticker), ['HSC_HIGH']); assert.equal(r.excluded_unknown, 1);
});
test('REQ-41 missing and nonfinite numeric fields remain UNKNOWN even for neq', () => {
  for (const missing of [null, undefined, NaN, Infinity, 'not-a-number', '']) {
    const result = engine.evaluateRule({ field: 'pbv', op: 'neq', value: 0 }, row({ pbv: missing }));
    assert.equal(result.unknown, true, String(missing)); assert.equal(result.pass, false);
  }
});
test('XREQ-04 disclosure date remains point-in-time, never replaced by scan day', () => {
  const g = insider.buildInsiderNetworkGraph({ name: 'Offline Holder', minPct: 1, records: [
    { ticker: 'AAAA', insider_name: 'Offline Holder', shares_after: 100, pct_after: '2%', date: '2026-09-01' },
    { ticker: 'BBBB', insider_name: 'Offline Holder', shares_after: 100, pct_after: '3%' }
  ] });
  assert.equal(g.edges.find(e => e.ticker === 'AAAA').as_of, '2026-09-01');
  assert.equal(g.edges.find(e => e.ticker === 'BBBB').as_of, null);
});
const record = (period = 'Q3') => monitor.buildRecordsForIssuer({ ticker: 'OFFLINE', fiscalYear: 2026, holidaySet: new Set() }).find(r => r.period === period);
const evidence = (x = {}) => ({ published: true, publicationAt: '2026-10-28', sourceUrl: 'https://offline.invalid/filing', checksum: 'a'.repeat(64), now: '2026-11-18', ...x });
test('XREQ-09 Q1-Q4 windows and separate FY; injected holiday only', () => {
  const anchors = monitor.computeAnchors({ fiscalYear: 2026, holidaySet: new Set(['2026-11-02']) });
  assert.deepEqual(anchors.map(r => r.nominal_check_date), ['2026-04-30', '2026-07-31', '2026-10-31', '2027-01-31', '2027-03-31']);
  assert.equal(anchors[2].actual_check_date, '2026-11-03');
  assert.equal(monitor.evaluateRecord(record('Q4'), { now: '2026-11-18' }).due, false);
});
for (const [label, overrides] of Object.entries({ missing_url: { sourceUrl: null }, missing_checksum: { checksum: null },
  invalid_date: { publicationAt: '2026-02-30' }, future_date: { publicationAt: '2026-12-01' }, before_period_end: { publicationAt: '2026-08-01' } })) {
  test(`XREQ-09 refuses unverified publication: ${label}`, () => {
    const after = monitor.applyCheckOutcome(record(), evidence(overrides));
    assert.notEqual(after.status, monitor.STATUS.PUBLISHED_VERIFIED); assert.equal(after.publication_at, null);
  });
}
test('XREQ-09 FY cannot verify unaudited Q4 evidence', () => {
  assert.notEqual(monitor.applyCheckOutcome(record('FY'), evidence({ publicationAt: '2027-02-10', now: '2027-03-31', auditedReviewed: false })).status, monitor.STATUS.PUBLISHED_VERIFIED);
});
for (const status of ['PENDING', 'UPSTREAM_UNAVAILABLE', 'MISSING_RETRY']) {
  test(`XREQ-09 ${status} honors persisted retry date`, () => {
    assert.equal(monitor.evaluateRecord({ ...record(), status, next_check_at: '2026-11-25' }, { now: '2026-11-18' }).due, false);
  });
}
test('XREQ-09 adapter outcome agrees with rejected monitor evidence', async () => {
  const src = adapter.createSource({ id: 'offline-invalid', async fetchPublicationIndex() {
    return { available: true, publication_at: 'garbage', source_url: 'https://offline.invalid/x', checksum: 'offline' };
  } });
  const r = await adapter.checkWithAdapter(record(), src, { now: '2026-11-18' });
  assert.notEqual(r.outcome, adapter.OUTCOME.VERIFIED); assert.notEqual(r.record.status, monitor.STATUS.PUBLISHED_VERIFIED);
});
test('XREQ-09 real adapter caller rejects malformed source URL and non-SHA256 checksum', async () => {
  for (const candidate of [
    { source_url: 'not a URL', checksum: 'a'.repeat(64) },
    { source_url: 'https://offline.invalid/filing', checksum: 'not-a-sha256' }
  ]) {
    const source = adapter.createSource({ id: 'offline-malformed-evidence', async fetchPublicationIndex() {
      return { available: true, publication_at: '2026-10-28', ...candidate };
    } });
    const result = await adapter.checkWithAdapter(record(), source, { now: '2026-11-18' });
    assert.notEqual(result.outcome, adapter.OUTCOME.VERIFIED);
    assert.notEqual(result.record.status, monitor.STATUS.PUBLISHED_VERIFIED);
    assert.equal(result.evidence, null);
  }
  const directUrl = monitor.applyCheckOutcome(record(), evidence({ sourceUrl: 'not a URL' }));
  assert.notEqual(directUrl.status, monitor.STATUS.PUBLISHED_VERIFIED);
  const directChecksum = monitor.applyCheckOutcome(record(), evidence({ checksum: 'offline-checksum' }));
  assert.notEqual(directChecksum.status, monitor.STATUS.PUBLISHED_VERIFIED);
});
test('XREQ-09 missing publication receipt remains unknown, not confirmed missing', async () => {
  const source = adapter.createSource({ id: 'offline-no-publication-receipt', async fetchPublicationIndex() {
    return { available: true, source_url: 'https://offline.invalid/index', checksum: 'a'.repeat(64) };
  } });
  const result = await adapter.checkWithAdapter(record(), source, { now: '2026-11-18' });
  assert.equal(result.outcome, adapter.OUTCOME.BLOCKED_UPSTREAM);
  assert.equal(result.record.status, monitor.STATUS.UPSTREAM_UNAVAILABLE);
  assert.equal(result.record.publication_at, null);
});
test('XREQ-09 reason text alone is not proof of non-publication', async () => {
  const source = adapter.createSource({ id: 'offline-ambiguous-negative', async fetchPublicationIndex() {
    return { available: false, reason: 'NO_PUBLICATION_DATE_EVIDENCE' };
  } });
  const result = await adapter.checkWithAdapter(record(), source, { now: '2026-11-18' });
  assert.equal(result.outcome, adapter.OUTCOME.BLOCKED_UPSTREAM);
  assert.equal(result.record.status, monitor.STATUS.UPSTREAM_UNAVAILABLE);
});
test('XREQ-09 explicit negative observation requires a separate affirmative flag', async () => {
  const source = adapter.createSource({ id: 'offline-explicit-negative', async fetchPublicationIndex() {
    return { available: false, not_published: true, reason: 'NO_PUBLICATION_DATE_EVIDENCE' };
  } });
  const result = await adapter.checkWithAdapter(record(), source, { now: '2026-11-18' });
  assert.equal(result.outcome, adapter.OUTCOME.NOT_PUBLISHED);
  assert.equal(result.record.status, monitor.STATUS.MISSING_RETRY);
});
test('XREQ-09 valid trimmed publication evidence remains valid after persistence normalization', () => {
  const result = monitor.applyCheckOutcome(record(), evidence({ sourceUrl: ' https://offline.invalid/filing ', checksum: ' ' + 'd'.repeat(64) + ' ' }));
  assert.equal(result.status, monitor.STATUS.PUBLISHED_VERIFIED);
  assert.equal(result.source_url, 'https://offline.invalid/filing');
  assert.equal(result.checksum, 'd'.repeat(64));
  assert.equal(monitor.evaluateRecord(result, { now: '2026-11-19' }).due, false);
});
test('XREQ-09 invalid persisted receipt waits until its configured first-check anchor', () => {
  const anchored = { ...record(), status: monitor.STATUS.PUBLISHED_VERIFIED, publication_at: '2026-10-28',
    retrieval_at: '2026-11-18', as_of: '2026-11-18', source_url: 'not-a-url', checksum: 'unverified', audited_reviewed: false };
  const before = monitor.evaluateRecord(anchored, { now: '2026-10-30' });
  assert.equal(before.due, false);
  assert.equal(before.reason, 'before_first_check');
});
test('XREQ-09 actual publication planner reopens persisted verified records with invalid receipt', () => {
  const statePath = path.resolve(__dirname, '../../data/financial-publication/review-invalid-state.json');
  const validBase = monitor.applyCheckOutcome(record(), evidence());
  const cases = [
    { record: { ...validBase, source_url: 'not-a-url' }, now: '2026-11-18' },
    { record: { ...validBase, checksum: 'unverified' }, now: '2026-11-18' },
    { record: { ...validBase, publication_at: '2026-08-01' }, now: '2026-11-18' },
    { record: { ...validBase, publication_at: '2026-11-19' }, now: '2026-11-18' },
    { record: { ...monitor.applyCheckOutcome(record('FY'), evidence({ publicationAt: '2027-02-10', now: '2027-03-31', auditedReviewed: true })), audited_reviewed: false }, now: '2027-03-31' }
  ];
  const stateDir = path.dirname(statePath);
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    cases.forEach(({ record: staleVerified, now }, index) => {
      const casePath = path.join(stateDir, `review-invalid-state-${index}.json`);
      fs.writeFileSync(casePath, JSON.stringify({ ...monitor.blankState(), issuers: { OFFLINE: { 2026: [staleVerified] } } }));
      try {
        const report = runPublicationCheck({ statePath: casePath, now });
        assert.equal(report.dueCount, 1, `case ${index}`);
        assert.equal(report.planned[0].status, monitor.STATUS.DUE, `case ${index}`);
        assert.equal(report.planned[0].reason, 'invalid_verified_evidence', `case ${index}`);
      } finally { fs.unlinkSync(casePath); }
    });
  } finally { if (fs.existsSync(statePath)) fs.unlinkSync(statePath); }
});
test('XREQ-09 valid evidence stops retries; persisted state/readback isolated', () => {
  const r = monitor.applyCheckOutcome(record(), evidence());
  assert.equal(r.status, monitor.STATUS.PUBLISHED_VERIFIED);
  assert.equal(r.publication_at, '2026-10-28'); assert.equal(r.retrieval_at, '2026-11-18');
  assert.equal(monitor.evaluateRecord(r, { now: '2026-12-01' }).due, false);
  const file = path.resolve(__dirname, '../../data/financial-publication/state.json');
  monitor.saveState({ ...monitor.blankState(), issuers: { OFFLINE: { 2026: [r] } } }, file);
  assert.deepEqual(monitor.loadState(file).state.issuers.OFFLINE[2026][0], r);
});
