'use strict';

/**
 * Tests for the date-parameterization of the intraday sample collector.
 *
 * The collector now takes an EXPLICIT --sample-date YYYY-MM-DD and uses it for
 * validation, the output directory, run records and the final summary. It never
 * silently uses the current wall-clock date, rejects invalid date formats, and
 * rejects a run whose actual WIB date differs from --sample-date.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const collector = require('../tools/intraday-sample-collector');

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'collector-date-test-'));
}

// A deterministic mock fetch returning >=20 valid candles so the engine can run.
function mockFetch() {
  return async () => ({
    candles: Array.from({ length: 25 }, (_, i) => ({
      time: 1753000000 + i * 86400,
      date: '2026-07-' + String(i + 1).padStart(2, '0'),
      open: 100, high: 105, low: 95, close: 102, volume: 1000000
    })),
    freshness: {
      provider: 'yahoo_chart_1d', fetch_timestamp: new Date().toISOString(),
      network_fetch: true, cache_hit: false, cache_age_seconds: 0,
      is_stale: false, stale_reason: null, candle_count: 25
    }
  });
}

// ===================================================================
// parseSampleDate — strict YYYY-MM-DD validator
// ===================================================================

test('parseSampleDate accepts real calendar dates and rejects invalid ones', () => {
  assert.equal(collector.parseSampleDate('2026-07-23').valid, true);
  assert.equal(collector.parseSampleDate('2026-07-23').year, 2026);
  // Bad formats
  assert.equal(collector.parseSampleDate('2026-7-3').valid, false);
  assert.equal(collector.parseSampleDate('20260723').valid, false);
  assert.equal(collector.parseSampleDate('not-a-date').valid, false);
  assert.equal(collector.parseSampleDate('').valid, false);
  assert.equal(collector.parseSampleDate(20260723).valid, false);
  // Impossible calendar dates
  assert.equal(collector.parseSampleDate('2026-13-40').valid, false);
  assert.equal(collector.parseSampleDate('2026-02-30').valid, false);
});

// ===================================================================
// validateSampleDate — actual WIB date must equal the EXPLICIT sample date
// ===================================================================

test('validateSampleDate accepts a matching explicit sample date', () => {
  // 2026-07-23 02:15 UTC = 09:15 WIB on 2026-07-23
  const ok = collector.validateSampleDate(Date.parse('2026-07-23T02:15:00Z'), '2026-07-23');
  assert.equal(ok.valid, true);
  assert.equal(ok.date, '2026-07-23');
  assert.equal(ok.year, 2026);
});

test('validateSampleDate rejects when the actual WIB date differs from the explicit sample date', () => {
  // Actual WIB day is 2026-07-22 but the explicit sample date is 2026-07-23.
  const wrongDay = collector.validateSampleDate(Date.parse('2026-07-22T02:15:00Z'), '2026-07-23');
  assert.equal(wrongDay.valid, false);
  assert.equal(wrongDay.reason, 'wrong_date');
  // Wrong year.
  const wrongYear = collector.validateSampleDate(Date.parse('2025-07-23T02:15:00Z'), '2026-07-23');
  assert.equal(wrongYear.valid, false);
  assert.equal(wrongYear.reason, 'wrong_year');
});

test('validateSampleDate rejects an invalid explicit sample-date format', () => {
  const r = collector.validateSampleDate(Date.parse('2026-07-23T02:15:00Z'), '2026-13-40');
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'invalid_sample_date_format');
});

test('validateSampleDate never silently uses the current date (invalid timestamp rejected)', () => {
  assert.equal(collector.validateSampleDate('2026-07-23', '2026-07-23').reason, 'invalid_timestamp');
  assert.equal(collector.validateSampleDate(NaN, '2026-07-23').reason, 'invalid_timestamp');
});

test('validateSampleDate defaults to the legacy SAMPLE_DATE for backward compatibility', () => {
  assert.equal(collector.SAMPLE_DATE, '2026-07-21');
  const ok = collector.validateSampleDate(Date.parse('2026-07-21T02:15:00Z'));
  assert.equal(ok.valid, true);
  assert.equal(ok.date, '2026-07-21');
});

// ===================================================================
// runSampleCollection — explicit sample date controls the output directory
// ===================================================================

test('explicit sample date controls the output directory', async () => {
  const base = await tmpdir();
  const sampleRoot = path.join(base, 'intraday-samples');
  await fs.writeFile(path.join(base, 'tickers.txt'), 'AAAA\n');
  const res = await collector.runSampleCollection({
    scheduledTime: '09:15',
    sampleDate: '2026-07-23',
    sampleRoot,
    tickersFile: path.join(base, 'tickers.txt'),
    cacheDir: base,
    fetchFn: mockFetch(),
    limit: 1,
    dryRun: false,
    skipDateValidation: true,
    skipProductionCheck: true
  });
  assert.equal(res.status, 'success');
  assert.equal(res.run.sample_date, '2026-07-23');
  // Files were written under <sampleRoot>/2026-07-23/, never any other date dir.
  const dateDir = path.join(sampleRoot, '2026-07-23');
  await fs.access(path.join(dateDir, 'runs.jsonl'));
  const entries = await fs.readdir(sampleRoot);
  assert.deepEqual(entries.sort(), ['2026-07-23']);
});

test('a different explicit sample date writes to its own directory', async () => {
  const base = await tmpdir();
  const sampleRoot = path.join(base, 'intraday-samples');
  await fs.writeFile(path.join(base, 'tickers.txt'), 'AAAA\n');
  const common = {
    scheduledTime: '09:15', sampleRoot,
    tickersFile: path.join(base, 'tickers.txt'), cacheDir: base,
    fetchFn: mockFetch(), limit: 1, dryRun: false,
    skipDateValidation: true, skipProductionCheck: true
  };
  await collector.runSampleCollection(Object.assign({}, common, { sampleDate: '2026-07-23', lockFile: path.join(base, 'a.lock') }));
  await collector.runSampleCollection(Object.assign({}, common, { sampleDate: '2026-07-24', lockFile: path.join(base, 'b.lock') }));
  const entries = await fs.readdir(sampleRoot);
  assert.deepEqual(entries.sort(), ['2026-07-23', '2026-07-24']);
});

// ===================================================================
// runSampleCollection — rejections
// ===================================================================

test('an invalid sample-date format is rejected', async () => {
  const base = await tmpdir();
  await fs.writeFile(path.join(base, 'tickers.txt'), 'AAAA\n');
  const res = await collector.runSampleCollection({
    scheduledTime: '09:15', sampleDate: '2026-13-40', sampleRoot: path.join(base, 'samples'),
    tickersFile: path.join(base, 'tickers.txt'), cacheDir: base, fetchFn: mockFetch(), limit: 1,
    skipDateValidation: true, skipProductionCheck: true
  });
  assert.equal(res.status, 'rejected');
  assert.equal(res.reason, 'invalid_sample_date_format');
});

test('an invalid scheduled time is rejected under an explicit sample date', async () => {
  const base = await tmpdir();
  await fs.writeFile(path.join(base, 'tickers.txt'), 'AAAA\n');
  // A lunch-break time is not one of the 21 approved slots -> rejected.
  const breakTime = await collector.runSampleCollection({
    scheduledTime: '12:15', sampleDate: '2026-07-23', sampleRoot: path.join(base, 'samples'),
    tickersFile: path.join(base, 'tickers.txt'), cacheDir: base, fetchFn: mockFetch(), limit: 1,
    skipDateValidation: true, skipProductionCheck: true
  });
  assert.equal(breakTime.status, 'rejected');
  assert.equal(breakTime.reason, 'not_in_approved_schedule');

  const notScheduled = await collector.runSampleCollection({
    scheduledTime: '09:16', sampleDate: '2026-07-23', sampleRoot: path.join(base, 'samples'),
    tickersFile: path.join(base, 'tickers.txt'), cacheDir: base, fetchFn: mockFetch(), limit: 1,
    skipDateValidation: true, skipProductionCheck: true
  });
  assert.equal(notScheduled.status, 'rejected');
  assert.equal(notScheduled.reason, 'not_in_approved_schedule');
});

test('a wrong WIB date is rejected when date validation is enforced', async () => {
  const base = await tmpdir();
  await fs.writeFile(path.join(base, 'tickers.txt'), 'AAAA\n');
  // A far-past sample date can never equal the actual WIB date -> rejected.
  const res = await collector.runSampleCollection({
    scheduledTime: '09:15', sampleDate: '2020-01-01', sampleRoot: path.join(base, 'samples'),
    tickersFile: path.join(base, 'tickers.txt'), cacheDir: base, fetchFn: mockFetch(), limit: 1,
    skipDateValidation: false, skipProductionCheck: true
  });
  assert.equal(res.status, 'rejected');
  assert.ok(['wrong_date', 'wrong_year'].includes(res.reason), 'expected wrong_date/wrong_year, got ' + res.reason);
});

// ===================================================================
// API surface invariant
// ===================================================================

test('API JavaScript endpoint count remains exactly 12', async () => {
  const entries = await fs.readdir(path.join(__dirname, '..', 'api'));
  assert.equal(entries.filter((f) => f.endsWith('.js')).length, 12);
});
