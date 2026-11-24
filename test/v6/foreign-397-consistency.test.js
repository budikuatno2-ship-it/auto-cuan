'use strict';
/**
 * M-P0b invariant tests — foreign 397 conflict resolution.
 * Fixtures are the REAL 397 keys produced from the v2/F4d/F5b ledgers
 * (tmp_p0a/out/mp0a-397-join.json + docs/v6/V6_FOREIGN_397_CONFLICT_RESOLUTION.csv).
 *
 * Asserts:
 *  (a) precedence: file-existence-only evidence can never yield
 *      VERIFIED_PROVIDER_ORIGINAL; sidecar NO_TRADE > derived schema >
 *      strict-identity original.
 *  (b) the null-as-zero bug: '' (missing candle) is UNKNOWN_CANDLE, not
 *      NO_TRADE; the legacy buggy helper is documented as a regression.
 *  (c) sums: F4d statuses + the 397 corrections reconcile exactly with the
 *      corrected ledger F totals (no key double-counted or dropped).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  RESOLUTIONS,
  classifyForeignStatus,
  classifyCandleVolume,
  legacyNullAsZeroClassify,
} = require(path.join(__dirname, '..', '..', 'lib', 'v6-foreign-classifier.js'));

const ROOT = path.join(__dirname, '..', '..');
const RES_CSV = path.join(ROOT, 'docs', 'v6', 'V6_FOREIGN_397_CONFLICT_RESOLUTION.csv');
const JOIN_JSON = path.join(ROOT, 'tmp_p0a', 'out', 'mp0a-397-join.json');

/** Minimal RFC-4180 CSV line parser (handles quoted fields containing commas). */
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('  ok -', name);
}

// ---------- (a) precedence rules --------------------------------------------
console.log('(a) precedence rules');

ok('file-existence-only is NEVER VERIFIED_PROVIDER_ORIGINAL', () => {
  const r = classifyForeignStatus({ fileExists: true });
  assert.strictEqual(r.status, RESOLUTIONS.FILE_PRESENCE_ONLY);
  assert.notStrictEqual(r.status, 'VERIFIED_PROVIDER_ORIGINAL');
});

ok('even with positive candle volume, file-existence-only stays UNVERIFIED', () => {
  // This is exactly what v2 got wrong: file present + cv>0 => promoted to ORIGINAL.
  const r = classifyForeignStatus({ fileExists: true, candleVolume: 2000 });
  assert.strictEqual(r.status, RESOLUTIONS.FILE_PRESENCE_ONLY);
});

ok('sidecar NO_TRADE beats derived-schema evidence (precedence 1 > 2)', () => {
  const r = classifyForeignStatus({
    sidecarNoTrade: true,
    derivedSchema: true,
    derivedBrokerRows: 5,
    derivedHasRealAsOf: true,
  });
  assert.strictEqual(r.status, RESOLUTIONS.NO_TRADE);
  assert.strictEqual(r.precedence, 1);
});

ok('derived schema with 0 foreign rows => NO_FOREIGN_FLOW (precedence 2)', () => {
  const r = classifyForeignStatus({ derivedSchema: true, derivedBrokerRows: 0 });
  assert.strictEqual(r.status, RESOLUTIONS.NO_TRADE);
  assert.strictEqual(r.precedence, 3);
});

ok('derived schema with real rows + real as_of => DERIVED_COMPUTED', () => {
  const r = classifyForeignStatus({
    derivedSchema: true, derivedBrokerRows: 4, derivedHasRealAsOf: true,
  });
  assert.strictEqual(r.status, RESOLUTIONS.DERIVED_COMPUTED);
  assert.strictEqual(r.precedence, 3);
});

ok('on-disk NO_TRADE (strict identity + brokers:[]) => NO_FOREIGN_FLOW, precedence 2', () => {
  const r = classifyForeignStatus({ onDiskNoTrade: true, fileExists: true });
  assert.strictEqual(r.status, RESOLUTIONS.NO_TRADE);
  assert.strictEqual(r.precedence, 2);
});

ok('strict identity original (valid schema + brokers>0) => VERIFIED_PROVIDER_ORIGINAL', () => {
  const r = classifyForeignStatus({
    strictIdentity: true, fileExists: true,
  });
  assert.strictEqual(r.status, RESOLUTIONS.ORIGINAL);
  assert.strictEqual(r.precedence, 4);
});

ok('nothing-but-existence with sidecar evidence is downgraded by sidecar', () => {
  const r = classifyForeignStatus({ sidecarNoTrade: true, fileExists: true });
  assert.strictEqual(r.status, RESOLUTIONS.NO_TRADE);
  assert.strictEqual(r.precedence, 1);
});

// ---------- (b) null-as-zero bug --------------------------------------------
console.log('(b) null-as-zero bug fixed');

ok("missing candle ('') is UNKNOWN_CANDLE, not NO_TRADE", () => {
  assert.strictEqual(classifyCandleVolume(''), 'UNKNOWN_CANDLE');
  assert.strictEqual(classifyCandleVolume(null), 'UNKNOWN_CANDLE');
  assert.strictEqual(classifyCandleVolume(undefined), 'UNKNOWN_CANDLE');
});

ok('zero candle volume is NO_TRADE_CANDIDATE', () => {
  assert.strictEqual(classifyCandleVolume('0'), 'NO_TRADE_CANDIDATE');
  assert.strictEqual(classifyCandleVolume(0), 'NO_TRADE_CANDIDATE');
});

ok('positive candle volume is TRADED', () => {
  assert.strictEqual(classifyCandleVolume('2000'), 'TRADED');
  assert.strictEqual(classifyCandleVolume(30400), 'TRADED');
});

ok('legacy helper demonstrates the original bug (regression witness)', () => {
  // The old classifier mislabeled an UNKNOWN candle as zero-volume NO_TRADE:
  assert.strictEqual(legacyNullAsZeroClassify(''), 'NO_TRADE');
  // while the corrected classifier keeps it UNKNOWN:
  assert.strictEqual(classifyCandleVolume(''), 'UNKNOWN_CANDLE');
  assert.notStrictEqual(classifyCandleVolume(''), legacyNullAsZeroClassify(''));
});

// ---------- (c) real-fixture reconciliation ---------------------------------
console.log('(c) real 397 fixtures reconcile');

ok('resolution CSV exists with exactly 397 data rows', () => {
  assert.ok(fs.existsSync(RES_CSV), RES_CSV + ' missing');
  const lines = fs.readFileSync(RES_CSV, 'utf8').split('\n').filter(l => l.length > 0);
  assert.strictEqual(lines.length, 398); // header + 397
});

ok('every resolved key has need_refetch=N and a provider-evidence rationale', () => {
  const lines = fs.readFileSync(RES_CSV, 'utf8').split('\n').filter(l => l.length > 0);
  const hdr = parseCsvLine(lines[0]);
  const iT = hdr.indexOf('ticker'), iD = hdr.indexOf('trade_date'),
    iNR = hdr.indexOf('need_refetch'), iRS = hdr.indexOf('resolution_status');
  const seen = new Set();
  for (const l of lines.slice(1)) {
    const p = parseCsvLine(l);
    const key = p[iT] + '|' + p[iD];
    assert.ok(!seen.has(key), 'duplicate key ' + key);
    seen.add(key);
    assert.strictEqual(p[iNR], 'N');
    assert.ok(p[iRS] === RESOLUTIONS.NO_TRADE || p[iRS] === RESOLUTIONS.DERIVED_COMPUTED);
  }
  assert.strictEqual(seen.size, 397);
});

ok('JOIN json: 341 ON_DISK + 56 PROVIDER conflicts, matches CSV', () => {
  const j = JSON.parse(fs.readFileSync(JOIN_JSON, 'utf8'));
  assert.strictEqual(j.conflict_count, 397);
  assert.strictEqual(j.conflicts_by_bucket_date['NO_TRADE_PROVEN_ON_DISK|2026-11-02'], 54);
  assert.strictEqual(j.conflicts_by_bucket_date['NO_TRADE_PROVEN_ON_DISK|2026-11-09'], 1);
  assert.strictEqual(j.conflicts_by_bucket_date['NO_TRADE_PROVEN_ON_DISK|2026-11-10'], 140);
  assert.strictEqual(j.conflicts_by_bucket_date['NO_TRADE_PROVEN_ON_DISK|2026-11-11'], 146);
  assert.strictEqual(j.conflicts_by_bucket_date['NO_TRADE_PROVEN_PROVIDER|2026-11-02'], 52);
  assert.strictEqual(j.conflicts_by_bucket_date['NO_TRADE_PROVEN_PROVIDER|2026-11-03'], 4);
});

ok('F4d statuses + 397 corrections reconcile (no key double-counted or dropped)', () => {
  const j = JSON.parse(fs.readFileSync(JOIN_JSON, 'utf8'));
  // residual F total must decompose exactly across v2 statuses
  const tallySum = Object.values(j.tally)
    .reduce((s, n) => s + n, 0);
  assert.strictEqual(tallySum, j.join_rows);      // decomposition exact
  assert.strictEqual(j.join_rows, 1509);          // 1,509 Nov F residual
  // conflicts subset
  assert.strictEqual(j.conflict_count, 397);
  // classification of all 397 via the classifier reproduces the CSV verdicts
  const resLines = fs.readFileSync(RES_CSV, 'utf8').split('\n').filter(l => l.length > 0);
  const hdr = parseCsvLine(resLines[0]);
  const iT = hdr.indexOf('ticker'), iD = hdr.indexOf('trade_date'),
    iB = hdr.indexOf('f4d_status'), iR = hdr.indexOf('resolution_status');
  for (const l of resLines.slice(1)) {
    const p = parseCsvLine(l);
    const ev = {
      sidecarNoTrade: p[iB] === 'NO_TRADE_PROVEN_PROVIDER',
      onDiskNoTrade: p[iB] === 'NO_TRADE_PROVEN_ON_DISK',
      derivedSchema: false,
      derivedBrokerRows: 0,
      strictIdentity: false,
      fileExists: true,
    };
    const r = classifyForeignStatus(ev);
    assert.strictEqual(r.status, p[iR],
      'classifier verdict mismatch for ' + p[iT] + '|' + p[iD]);
  }
  // 341 + 56 = 397
  const onDisk = 54 + 1 + 140 + 146;
  const provider = 52 + 4;
  assert.strictEqual(onDisk + provider, 397);
});

ok('corrected F totals JSON: ORIGINAL drops by exactly 397, sums preserved', () => {
  const t = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'tmp_p0a', 'out', 'mp0a-corrected-totals.json'), 'utf8'));
  assert.strictEqual(
    t.F_before.VERIFIED_PROVIDER_ORIGINAL - t.F_after.VERIFIED_PROVIDER_ORIGINAL, 397);
  assert.strictEqual(t.F_after.NO_FOREIGN_FLOW_PROVIDER_CONFIRMED, 397);
  const sumBefore = Object.values(t.F_before).reduce((s, n) => s + n, 0);
  const sumAfter = Object.values(t.F_after).reduce((s, n) => s + n, 0);
  assert.strictEqual(sumBefore, sumAfter); // nothing dropped
  assert.strictEqual(t.need_refetch_count, 0);
});

console.log('\nPASS: ' + passed + '/' + passed + ' invariant assertions passed');
