'use strict';

/**
 * test/v6/financial-publication-monitor.test.js
 * V6 W3 — financial publication monitor (user anchors, not regulatory deadlines).
 *
 * Coverage (13):
 *   (a) Q1 anchor = 30 Apr
 *   (b) Q2 = 31 Jul
 *   (c) Q3 = 31 Oct
 *   (d) Q4 = 31 Jan next year
 *   (e) FY separate track
 *   (f) non-calendar fiscal year derivation
 *   (g) weekend shift records both dates
 *   (h) 15-day retry cadence
 *   (i) stop after PUBLISHED_VERIFIED
 *   (j) revision reopens
 *   (k) NOT_DUE skip
 *   (l) no fabricated publication date
 *   (m) dry-run makes zero provider calls
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const monitor = require('../../lib/financial-publication-monitor');
const { runPublicationCheck } = require('../../tools/run-financial-publication-check');

function anchorFor(period, fiscalYear = 2026, fiscalYearEnd = '12-31') {
  const anchors = monitor.computeAnchors({ fiscalYear, fiscalYearEnd });
  return anchors.find(function (a) { return a.period === period; });
}

// (a) Q1 anchor = 30 Apr
test('(a) Q1 nominal check date is 30 Apr', function () {
  const a = anchorFor('Q1');
  assert.equal(a.period_end, '2026-03-31');
  assert.equal(a.nominal_check_date, '2026-04-30');
});

// (b) Q2 = 31 Jul
test('(b) Q2 nominal check date is 31 Jul', function () {
  const a = anchorFor('Q2');
  assert.equal(a.period_end, '2026-06-30');
  assert.equal(a.nominal_check_date, '2026-07-31');
});

// (c) Q3 = 31 Oct
test('(c) Q3 nominal check date is 31 Oct', function () {
  const a = anchorFor('Q3');
  assert.equal(a.period_end, '2026-09-30');
  assert.equal(a.nominal_check_date, '2026-10-31');
});

// (d) Q4 = 31 Jan next year
test('(d) Q4 nominal check date is 31 Jan of the NEXT year', function () {
  const a = anchorFor('Q4');
  assert.equal(a.period_end, '2026-12-31');
  assert.equal(a.nominal_check_date, '2027-01-31');
});

// (e) FY separate track
test('(e) FY is a separate track from Q4 and may publish later', function () {
  const q4 = anchorFor('Q4');
  const fy = anchorFor('FY');
  assert.equal(fy.period, 'FY');
  assert.equal(fy.period_end, '2026-12-31');
  // FY nominal is 3 months after FYE (end of March), strictly later than Q4.
  assert.equal(fy.nominal_check_date, '2027-03-31');
  assert.ok(fy.nominal_check_date > q4.nominal_check_date);
});

// (f) non-calendar fiscal year derivation
test('(f) non-calendar fiscal year derives anchors from fiscal_year_end', function () {
  // Fiscal year ends 30 June. Q1 ends 30 Sep -> check 31 Oct.
  const anchors = monitor.computeAnchors({ fiscalYear: 2026, fiscalYearEnd: '06-30' });
  const q1 = anchors.find(function (a) { return a.period === 'Q1'; });
  const q4 = anchors.find(function (a) { return a.period === 'Q4'; });
  const fy = anchors.find(function (a) { return a.period === 'FY'; });
  assert.equal(q1.period_end, '2025-09-30');
  assert.equal(q1.nominal_check_date, '2025-10-31');
  assert.equal(q4.period_end, '2026-06-30');
  assert.equal(q4.nominal_check_date, '2026-07-31');
  assert.equal(fy.period_end, '2026-06-30');
  assert.equal(fy.nominal_check_date, '2026-09-30');
});

// (g) weekend shift records both dates
test('(g) weekend shift records BOTH nominal and actual check dates', function () {
  // 2026-10-31 is a Saturday -> shift to Monday 2026-11-02.
  const a = anchorFor('Q3');
  assert.equal(a.nominal_check_date, '2026-10-31');
  assert.equal(a.actual_check_date, '2026-11-02');
  assert.equal(a.shifted, true);
});

// (h) 15-day retry cadence
test('(h) missing publication retries every 15 days by default', function () {
  const rec = monitor.blankRecord('BBRI', 2026, anchorFor('Q1'));
  const after = monitor.applyCheckOutcome(rec, {
    published: false,
    now: '2026-05-01',
    retryIntervalDays: 15
  });
  assert.equal(after.status, monitor.STATUS.MISSING_RETRY);
  assert.equal(after.retry_count, 1);
  assert.equal(after.next_check_at, '2026-05-16');
});

// (i) stop after PUBLISHED_VERIFIED
test('(i) retry loop stops after PUBLISHED_VERIFIED', function () {
  const rec = monitor.blankRecord('BBRI', 2026, anchorFor('Q1'));
  const published = monitor.applyCheckOutcome(rec, {
    published: true,
    publicationAt: '2026-04-28',
    sourceUrl: 'https://example.test/bbri-q1.pdf',
    checksum: 'a'.repeat(64),
    now: '2026-05-01'
  });
  assert.equal(published.status, monitor.STATUS.PUBLISHED_VERIFIED);
  assert.equal(published.publication_at, '2026-04-28');
  assert.equal(published.next_check_at, null);

  const verdict = monitor.evaluateRecord(published, { now: '2026-06-01' });
  assert.equal(verdict.due, false);
  assert.equal(verdict.reason, 'already_published_verified');
});

// (j) revision reopens
test('(j) a changed checksum reopens a verified record', function () {
  const rec = monitor.blankRecord('BBRI', 2026, anchorFor('Q1'));
  const published = monitor.applyCheckOutcome(rec, {
    published: true,
    publicationAt: '2026-04-28',
    sourceUrl: 'https://example.test/offline-bbri-q1.pdf',
    checksum: 'b'.repeat(64),
    now: '2026-05-01'
  });
  const same = monitor.detectRevision(published, 'b'.repeat(64), { now: '2026-06-01' });
  assert.equal(same.revision, false);

  const changed = monitor.detectRevision(published, 'c'.repeat(64), { now: '2026-06-01' });
  assert.equal(changed.revision, true);
  assert.equal(changed.record.status, monitor.STATUS.REVISION_DETECTED);

  const verdict = monitor.evaluateRecord(changed.record, { now: '2026-06-01' });
  assert.equal(verdict.due, true);
  assert.equal(verdict.reason, 'revision_reopen');
});

// (k) NOT_DUE skip
test('(k) a record before its first check is NOT_DUE and skipped', function () {
  const rec = monitor.blankRecord('BBRI', 2026, anchorFor('Q1'));
  const verdict = monitor.evaluateRecord(rec, { now: '2026-04-01' });
  assert.equal(verdict.due, false);
  assert.equal(verdict.status, monitor.STATUS.NOT_DUE);
  assert.equal(verdict.reason, 'before_first_check');
});

// (l) no fabricated publication date
test('(l) a published flag without an observed date never fabricates publication_at', function () {
  const rec = monitor.blankRecord('BBRI', 2026, anchorFor('Q1'));
  const after = monitor.applyCheckOutcome(rec, {
    published: true,
    publicationAt: null,
    now: '2026-05-01'
  });
  assert.equal(after.publication_at, null);
  assert.equal(after.status, monitor.STATUS.PENDING);
  assert.notEqual(after.status, monitor.STATUS.PUBLISHED_VERIFIED);
});

// (m) dry-run makes zero provider calls
test('(m) dry-run makes zero provider calls', function () {
  const report = runPublicationCheck({ dryRun: true, now: '2026-05-01' });
  assert.equal(report.ok, true);
  assert.equal(report.dryRun, true);
  assert.equal(report.providerCalls, 0);
  for (const p of report.planned) {
    assert.equal(p.provider_call, false);
    assert.equal(p.would_fetch, false);
  }
});
