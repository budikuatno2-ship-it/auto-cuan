'use strict';

/**
 * test/v6/ledger-v3-classifier.test.js
 * ============================================================================
 * M-P0c — Ledger V3 strict-provenance classifier tests.
 *
 * Covers the 8 required cases:
 *   (a) existence-only             => UNKNOWN_SOURCE, never ORIGINAL
 *   (b) strict-identity + brokers  => ORIGINAL_PROVIDER_VALID
 *   (c) brokers:[] + sidecar       => NO_FOREIGN_FLOW_PROVIDER_CONFIRMED
 *   (d) null candle volume         => UNKNOWN_CANDLE
 *   (e) 0 candle volume            => NO_TRADE_CANDIDATE path
 *   (f) pseudo-ticker              => FIXTURE_EXCLUDED
 *   (g) derived-computable         => DERIVED_COMPUTABLE when ALL+F valid
 *   (h) sums: v3 counts reconcile with v2 row count
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const zlib = require('zlib');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const cls = require(path.join(ROOT, 'lib', 'ledger-v3-classifier.js'));
const { classifyCandleVolume } = require(path.join(ROOT, 'lib', 'v6-foreign-classifier.js'));

const SHA = 'a'.repeat(64);

/* (a) existence-only is NEVER ORIGINAL ------------------------------------- */
test('M-P0c-(a): file existence alone => UNKNOWN_SOURCE, never ORIGINAL', () => {
  const r = cls.classifyLedgerV3({ ticker: 'BBRI', fileExists: true });
  assert.equal(r.status, 'UNKNOWN_SOURCE');
  assert.notEqual(r.status, 'ORIGINAL_PROVIDER_VALID');
  // v2 row mapping downgrades the false promotion
  const m = cls.mapV2RowToV3({
    ticker: 'BBRI', trade_date: '2026-01-02', dataset: 'ALL',
    status: 'VERIFIED_PROVIDER_ORIGINAL',
  });
  assert.equal(m.status, 'UNKNOWN_SOURCE');
  assert.equal(m.reason, 'V2_PROMOTION_UNVERIFIED');
  assert.equal(m.downgraded, true);
});

/* (b) strict-identity + non-empty brokers => ORIGINAL ----------------------- */
test('M-P0c-(b): strict date identity + non-empty brokers + sha256 => ORIGINAL_PROVIDER_VALID', () => {
  const r = cls.classifyLedgerV3({
    ticker: 'BBRI',
    requestedDate: '2026-11-02',
    payloadStartDate: '2026-11-02',
    payloadEndDate: '2026-11-02',
    brokers: [{ code: 'YU', netValue: 1000 }],
    sha256: SHA,
  });
  assert.equal(r.status, 'ORIGINAL_PROVIDER_VALID');
  assert.equal(r.precedence, 6);
});

/* (c) brokers:[] proven via sidecar => NO_FOREIGN_FLOW ---------------------- */
test('M-P0c-(c): sidecar proves brokers:[] => NO_FOREIGN_FLOW_PROVIDER_CONFIRMED', () => {
  const r = cls.classifyLedgerV3({ ticker: 'BBRI', sidecarNoTrade: true });
  assert.equal(r.status, 'NO_FOREIGN_FLOW_PROVIDER_CONFIRMED');
  // on-disk proof path too
  const r2 = cls.classifyLedgerV3({ ticker: 'BBRI', onDiskNoTrade: true });
  assert.equal(r2.status, 'NO_FOREIGN_FLOW_PROVIDER_CONFIRMED');
});

/* (d) null candle volume => UNKNOWN_CANDLE (null-as-zero bug fixed) --------- */
test('M-P0c-(d): null/empty candle volume => UNKNOWN_CANDLE, not NO_TRADE', () => {
  assert.equal(classifyCandleVolume(null), 'UNKNOWN_CANDLE');
  assert.equal(classifyCandleVolume(''), 'UNKNOWN_CANDLE');
  assert.equal(classifyCandleVolume(undefined), 'UNKNOWN_CANDLE');
  const r = cls.classifyLedgerV3({ ticker: 'BBRI', candleVolume: '' });
  assert.equal(r.status, 'UNKNOWN_CANDLE');
});

/* (e) 0 candle volume => NO_TRADE_CANDIDATE path ---------------------------- */
test('M-P0c-(e): zero candle volume => NO_TRADE candidate path (confirmed vs candidate)', () => {
  assert.equal(classifyCandleVolume(0), 'NO_TRADE_CANDIDATE');
  const confirmed = cls.classifyLedgerV3({ ticker: 'BBRI', candleVolume: 0, noTradeConfirmed: true });
  assert.equal(confirmed.status, 'NO_TRADE_TICKER_CONFIRMED');
  const candidate = cls.classifyLedgerV3({ ticker: 'BBRI', candleVolume: 0 });
  assert.equal(candidate.status, 'LISTED_NOT_TRADED');
});

/* (f) pseudo-ticker => FIXTURE_EXCLUDED ------------------------------------- */
test('M-P0c-(f): pseudo-tickers CURR1/GUARD1-6/HIST1 => FIXTURE_EXCLUDED', () => {
  for (const t of ['CURR1', 'GUARD1', 'GUARD2', 'GUARD3', 'GUARD4', 'GUARD5', 'GUARD6', 'HIST1']) {
    const r = cls.classifyLedgerV3({ ticker: t, fileExists: true, strictIdentity: true, sha256: SHA });
    assert.equal(r.status, 'FIXTURE_EXCLUDED', t);
  }
  const m = cls.mapV2RowToV3({ ticker: 'CURR1', trade_date: '2026-01-02', dataset: 'ALL', status: 'SYNTHETIC_UNVERIFIED' });
  assert.equal(m.status, 'FIXTURE_EXCLUDED');
});

/* (g) derived-computable when ALL + F valid --------------------------------- */
test('M-P0c-(g): derived-computable inputs => DERIVED_COMPUTABLE', () => {
  const r = cls.classifyLedgerV3({ ticker: 'BBRI', derivedComputable: true });
  assert.equal(r.status, 'DERIVED_COMPUTABLE');
});

/* (h) sums: v3 ledger reconciles with v2 row count -------------------------- */
test('M-P0c-(h): v3 per-key output reconciles exactly with the v2 row count', () => {
  const gzPath = path.join(ROOT, 'docs', 'v6', 'v6-ledger-v3-per-key.csv.gz');
  assert.equal(fs.existsSync(gzPath), true, 'v6-ledger-v3-per-key.csv.gz must exist');
  const lines = zlib.gunzipSync(fs.readFileSync(gzPath)).toString('utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  const dataRows = lines.length - 1; // minus header
  const v2Rows = 632772;
  assert.equal(dataRows, v2Rows, `v3 rows (${dataRows}) must equal v2 rows (${v2Rows})`);

  // every emitted status is in the frozen vocabulary
  const allowed = new Set(cls.ALL_V3_STATUSES);
  const counts = new Map();
  for (let i = 1; i < lines.length; i++) {
    const st = lines[i].split(',')[4];
    assert.equal(allowed.has(st), true, `status ${st} must be in the frozen v3 vocabulary`);
    counts.set(st, (counts.get(st) || 0) + 1);
  }
  const sum = [...counts.values()].reduce((a, b) => a + b, 0);
  assert.equal(sum, v2Rows, 'status counts must sum to the v2 row count');

  // no v2 false-ORIGINAL survives: ORIGINAL_PROVIDER_VALID only from evidence
  assert.equal(counts.get('ORIGINAL_PROVIDER_VALID'), 15272,
    'ORIGINAL_PROVIDER_VALID must equal the F4d strict-identity evidence count (8,325 ALL + 6,947 F)');
  assert.equal(counts.get('UNKNOWN_SOURCE') > 0, true, 'existence-only v2 originals must appear as UNKNOWN_SOURCE');
  assert.equal(counts.get('FIXTURE_EXCLUDED'), 5048,
    'FIXTURE_EXCLUDED must equal 8 pseudo-tickers x dates x datasets (5,048)');

  // summary CSVs exist and their counts reconcile
  const byDs = fs.readFileSync(path.join(ROOT, 'docs', 'v6', 'v6-ledger-v3-summary-by-dataset-status.csv'), 'utf8')
    .split(/\r?\n/).filter((l) => l.trim() !== '');
  let dsSum = 0;
  for (let i = 1; i < byDs.length; i++) dsSum += Number(byDs[i].split(',')[2]);
  assert.equal(dsSum, v2Rows, 'dataset-status summary must sum to the v2 row count');

  const byMonth = fs.readFileSync(path.join(ROOT, 'docs', 'v6', 'v6-ledger-v3-summary-by-month.csv'), 'utf8')
    .split(/\r?\n/).filter((l) => l.trim() !== '');
  let mSum = 0;
  for (let i = 1; i < byMonth.length; i++) mSum += Number(byMonth[i].split(',')[3]);
  assert.equal(mSum, v2Rows, 'monthly summary must sum to the v2 row count');
});
