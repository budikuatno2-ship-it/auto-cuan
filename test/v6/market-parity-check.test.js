'use strict';

/**
 * test/v6/market-parity-check.test.js
 * ============================================================================
 * V6 (W6) — MARKET PARITY COMPARISON LOGIC
 * ============================================================================
 * Proves the pure comparison contract of tools/check-market-parity.js:
 *   (a) equal rows pass
 *   (b) date mismatch flagged
 *   (c) null vs 0 distinguished
 *   (d) missing sqlite row flagged
 *   (e) volume unit mismatch flagged
 *   (f) dry-run performs no writes
 *
 * NO production DB access, NO provider calls. Fixtures only.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const parity = require(path.join(ROOT, 'tools', 'check-market-parity.js'));

const R = parity.REASONS;

/* (a) equal rows pass */
test('(a) equal flat/sqlite rows -> OK', () => {
  const flat = { close: 5325, volume: 92364800, date: '2026-11-02' };
  const sq = { close: 5325, volume: 92364800, date: '2026-11-02' };
  const r = parity.compareRow(flat, sq, { date: '2026-11-02' });
  assert.equal(r.reason, R.OK);
  assert.equal(r.closeEqual, true);
  assert.equal(r.volumeEqual, true);
});

/* (b) date mismatch flagged */
test('(b) sqlite trade_date differs from key date -> DATE_MISMATCH', () => {
  const flat = { close: 5325, volume: 100, date: '2026-11-02' };
  const sq = { close: 5325, volume: 100, date: '2026-10-30' };
  const r = parity.compareRow(flat, sq, { date: '2026-11-02' });
  assert.equal(r.reason, R.DATE_MISMATCH);
});

/* (c) null vs 0 distinguished */
test('(c) null close vs 0 close -> NULL_VS_ZERO (never coerced)', () => {
  const flat = { close: null, volume: 100, date: '2026-11-02' };
  const sq = { close: 0, volume: 100, date: '2026-11-02' };
  const r = parity.compareRow(flat, sq, { date: '2026-11-02' });
  assert.equal(r.reason, R.NULL_VS_ZERO);
  assert.equal(r.closeEqual, false);

  // Both null is NOT a mismatch (UNKNOWN == UNKNOWN).
  const bothNull = parity.compareRow(
    { close: null, volume: null, date: '2026-11-02' },
    { close: null, volume: null, date: '2026-11-02' },
    { date: '2026-11-02' }
  );
  assert.equal(bothNull.reason, R.OK);
});

/* (d) missing sqlite row flagged */
test('(d) flat present but sqlite row absent -> MISSING_SQLITE_ROW', () => {
  const flat = { close: 5325, volume: 100, date: '2026-11-02' };
  const r = parity.compareRow(flat, null, { date: '2026-11-02' });
  assert.equal(r.reason, R.MISSING_SQLITE_ROW);
});

/* (e) volume unit mismatch flagged */
test('(e) volume unit mismatch (shares vs lots) -> VOLUME_UNIT_MISMATCH', () => {
  const flat = { close: 5325, volume: 92364800, date: '2026-11-02' };
  const sq = { close: 5325, volume: 923648, date: '2026-11-02' }; // /100 lots
  const r = parity.compareRow(flat, sq, { date: '2026-11-02' });
  assert.equal(r.reason, R.VOLUME_UNIT_MISMATCH);
  assert.equal(r.closeEqual, true);
  assert.equal(r.volumeEqual, false);
});

/* (f) dry-run performs no writes */
test('(f) dry-run performs no writes (report file never created)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-parity-'));
  const flatDir = path.join(tmp, 'flat');
  fs.mkdirSync(flatDir, { recursive: true });
  fs.writeFileSync(path.join(flatDir, 'BBCA.json'), JSON.stringify({
    candles_120: [
      { date: '2026-11-02', close: 5325, volume: 100 },
      { date: '2026-11-03', close: 5330, volume: 200 }
    ]
  }));

  const reportPath = path.join(tmp, 'report.csv');
  const res = parity.runParity({
    dbPath: path.join(tmp, 'nonexistent.sqlite'),
    flatDir,
    tickers: ['BBCA'],
    dates: ['2026-11-02', '2026-11-03'],
    writeReport: reportPath,
    dryRun: true
  });

  assert.equal(res.dryRun, true);
  assert.equal(res.wroteReport, false, 'dry-run must not write a report');
  assert.equal(fs.existsSync(reportPath), false, 'report file must not exist');
  // With no sqlite, every flat row is a missing-sqlite-row mismatch.
  assert.equal(res.summary.total, 2);
  assert.equal(res.summary.mismatch, 2);
  assert.ok(res.summary.byReason[R.MISSING_SQLITE_ROW] >= 1);

  // --report-only also suppresses writes.
  const res2 = parity.runParity({
    dbPath: path.join(tmp, 'nonexistent.sqlite'),
    flatDir,
    tickers: ['BBCA'],
    dates: ['2026-11-02'],
    writeReport: reportPath,
    reportOnly: true
  });
  assert.equal(res2.wroteReport, false);
  assert.equal(fs.existsSync(reportPath), false);
});
