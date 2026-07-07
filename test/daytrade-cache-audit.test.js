'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const audit = require('../lib/daytrade-cache-audit');

async function tmpdir() { return fs.mkdtemp(path.join(os.tmpdir(), 'daytrade-cache-audit-')); }
function candle(i) { return { time: 1700000000 + i * 86400, date: '2024-01-' + String((i % 28) + 1).padStart(2, '0'), open: 1, high: 2, low: 1, close: 2, volume: 1000 }; }
function payload(ticker, updatedAt, count, extra) { return Object.assign({ version: 1, ticker, range: '90d', interval: '1d', updated_at: updatedAt, candles: Array.from({ length: count }, (_, i) => candle(i)) }, extra || {}); }

test('valid cache file parsing', () => {
  const nowMs = Date.parse('2026-07-07T03:00:00Z');
  const item = audit.parseCachePayload(JSON.stringify(payload('BBCA', '2026-07-07T02:50:00Z', 90)), 'BBCA.json', nowMs, 15 * 60000);
  assert.equal(item.valid, true);
  assert.equal(item.ticker, 'BBCA');
  assert.equal(item.candle_count, 90);
  assert.equal(item.has_min_candles, true);
});

test('corrupt cache file handling', async () => {
  const dir = await tmpdir();
  await fs.writeFile(path.join(dir, 'BAD.json'), '{not-json');
  const result = await audit.auditCache({ cacheDir: dir, nowMs: Date.parse('2026-07-07T03:00:00Z') });
  assert.equal(result.total_cache_files, 1);
  assert.equal(result.valid_cache_files, 0);
  assert.equal(result.invalid_corrupt_cache_files, 1);
  assert.match(result.samples.invalid[0].error, /JSON/);
});

test('freshness and stale age bucket classification', async () => {
  const dir = await tmpdir();
  const nowMs = Date.parse('2026-07-07T03:00:00Z');
  await fs.writeFile(path.join(dir, 'FRESH.json'), JSON.stringify(payload('FRESH', '2026-07-07T02:50:00Z', 20)));
  await fs.writeFile(path.join(dir, 'MID.json'), JSON.stringify(payload('MID', '2026-07-07T02:30:00Z', 20)));
  await fs.writeFile(path.join(dir, 'OLD.json'), JSON.stringify(payload('OLD', '2026-07-06T13:00:00Z', 20)));
  const result = await audit.auditCache({ cacheDir: dir, nowMs, ttlMs: 15 * 60000 });
  assert.equal(result.cache_age_buckets['<15m'], 1);
  assert.equal(result.cache_age_buckets['15m-1h'], 1);
  assert.equal(result.cache_age_buckets['>12h'], 1);
  assert.equal(result.fresh_count, 1);
  assert.equal(result.stale_count, 2);
});

test('candle count validation', async () => {
  const dir = await tmpdir();
  const nowMs = Date.parse('2026-07-07T03:00:00Z');
  await fs.writeFile(path.join(dir, 'ENOUGH.json'), JSON.stringify(payload('ENOUGH', '2026-07-07T02:55:00Z', 20)));
  await fs.writeFile(path.join(dir, 'SHORT.json'), JSON.stringify(payload('SHORT', '2026-07-07T02:55:00Z', 19)));
  const result = await audit.auditCache({ cacheDir: dir, nowMs });
  assert.equal(result.tickers_with_gte_20_candles, 1);
  assert.equal(result.tickers_with_lt_20_candles, 1);
});

test('interval/range mismatch detection', async () => {
  const dir = await tmpdir();
  await fs.writeFile(path.join(dir, 'BADRANGE.json'), JSON.stringify(payload('BADRANGE', '2026-07-07T02:55:00Z', 20, { range: '30d', interval: '5m' })));
  const result = await audit.auditCache({ cacheDir: dir, nowMs: Date.parse('2026-07-07T03:00:00Z') });
  assert.equal(result.interval_range_mismatch, 1);
  assert.equal(result.samples.interval_range_mismatch[0].ticker, 'BADRANGE');
});

test('missing logs do not fail', async () => {
  const result = await audit.summarizeLogs({ logsFile: path.join(await tmpdir(), 'missing.jsonl') });
  assert.equal(result.logs_found, false);
  assert.equal(result.total_runs, 0);
});

test('log summary parsing if sample JSONL exists', async () => {
  const dir = await tmpdir();
  const file = path.join(dir, 'runs.jsonl');
  await fs.writeFile(file, [
    JSON.stringify({ started_at: '2026-07-07T09:00:00Z', ended_at: '2026-07-07T09:01:00Z', tickers_scanned: 5, cache_hit_count: 3, cache_miss_count: 2, fetch_fail_count: 1, stale_fallback_count: 1, rejected_reasons_summary: { insufficient_candles: 2 } }),
    JSON.stringify({ started_at: '2026-07-07T10:00:00Z', ended_at: '2026-07-07T10:01:00Z', tickers_scanned: 6, cache_hit_count: 4 })
  ].join('\n') + '\n');
  const result = await audit.summarizeLogs({ logsFile: file });
  assert.equal(result.logs_found, true);
  assert.equal(result.total_runs, 2);
  assert.equal(result.latest_run_timestamp, '2026-07-07T10:01:00Z');
  assert.equal(result.totals.ticker_count, 11);
  assert.equal(result.totals.cache_hit, 7);
  assert.equal(result.totals.stale_fallback, 1);
  assert.deepEqual(result.top_errors[0], { error: 'insufficient_candles', count: 2 });
});
