'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const cmp = require('../lib/daytrade-compare-report');

async function tmpdir() { return fs.mkdtemp(path.join(os.tmpdir(), 'daytrade-compare-')); }

test('matching tickers and score delta calculation', () => {
  const result = cmp.compareDayTrade([
    { ticker: 'BBCA', daytrade_score: 80, status: 'READY_BREAKOUT', entry_low: 100, entry_high: 102, tp1: 110, tp2: 120, stop_loss: 95, risk_reward: 2 }
  ], [
    { ticker: 'bbca', daytrade_score: 75, status: 'READY_BREAKOUT', entry_low: 100, entry_high: 102, tp1: 110, tp2: 120, stop_loss: 95, risk_reward: 2 }
  ]);
  assert.equal(result.metrics.matched_tickers, 1);
  assert.equal(result.metrics.score_delta_avg, 5);
  assert.equal(result.metrics.score_delta_max, 5);
  assert.equal(result.rows[0].score_delta, 5);
});

test('local_only and production_only tickers are reported', () => {
  const result = cmp.compareDayTrade([{ ticker: 'LOCAL', score: 1 }], [{ ticker: 'PROD', score: 1 }]);
  assert.deepEqual(result.metrics.local_only, ['LOCAL']);
  assert.deepEqual(result.metrics.production_only, ['PROD']);
  assert.equal(result.metrics.matched_tickers, 0);
});

test('level mismatch tolerance allows small rounding differences', () => {
  const result = cmp.compareDayTrade([
    { ticker: 'BBRI', entry1: 100.004, entry2: 101, tp1: 110, tp2: 120, sl: 95, rr: 1.5 }
  ], [
    { ticker: 'BBRI', entry1: 100, entry2: 101.02, tp1: 111, tp2: 120, sl: 95.02, rr: 1.5 }
  ], { levelTolerance: 0.01 });
  assert.equal(result.metrics.level_delta_counts.entry1, 0);
  assert.equal(result.metrics.level_delta_counts.entry2, 1);
  assert.equal(result.metrics.level_delta_counts.tp1, 1);
  assert.equal(result.metrics.level_delta_counts.sl, 1);
});

test('status mismatch is counted', () => {
  const result = cmp.compareDayTrade([{ ticker: 'BMRI', status: 'READY_BREAKOUT' }], [{ ticker: 'BMRI', status: 'WAIT_PULLBACK' }]);
  assert.equal(result.metrics.status_mismatch_count, 1);
  assert.equal(result.rows[0].status_mismatch, true);
});

test('missing local logs are graceful', async () => {
  const result = await cmp.readLatestLocalRun(path.join(await tmpdir(), 'missing.jsonl'));
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/);
  assert.deepEqual(result.rows, []);
});

test('latest local run prefers newest timestamp and top_candidates fallback', async () => {
  const dir = await tmpdir();
  const file = path.join(dir, 'runs.jsonl');
  await fs.writeFile(file, [
    JSON.stringify({ ended_at: '2026-07-07T01:00:00Z', top_candidates: [{ ticker: 'OLD', score: 1 }] }),
    JSON.stringify({ ended_at: '2026-07-07T02:00:00Z', top_candidates: [{ ticker: 'NEW', score: 2 }] })
  ].join('\n') + '\n');
  const result = await cmp.readLatestLocalRun(file);
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].ticker, 'NEW');
});

test('no secret output from sanitizer', () => {
  const sanitized = cmp.sanitizeForOutput('GET https://x.test/api?action=daytrade-screener&token=supersecret Authorization: Bearer abc.def.ghi');
  assert.equal(sanitized.includes('supersecret'), false);
  assert.equal(sanitized.includes('abc.def.ghi'), false);
  assert.match(sanitized, /token=\[REDACTED\]/);
  assert.match(sanitized, /Bearer \[REDACTED\]/);
});
