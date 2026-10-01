'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const lib = require('../lib/daytrade-adjusted-vs-normal-report');

function run(overrides) {
  return Object.assign({
    ended_at: '2026-01-01T00:00:00Z',
    results: [
      { ticker: 'AAA', daytrade_score: 90, status: 'READY' },
      { ticker: 'BBB', daytrade_score: 80, status: 'READY' },
      { ticker: 'CCC', daytrade_score: 70, status: 'WAIT' },
      { ticker: 'DDD', daytrade_score: 60, status: 'WAIT' },
      { ticker: 'EEE', daytrade_score: 50, status: 'WAIT' },
      { ticker: 'FFF', daytrade_score: 40, status: 'WAIT' }
    ]
  }, overrides || {});
}

test('parses latest normal/adjusted entries from JSONL', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adjusted-vs-normal-'));
  const file = path.join(dir, 'runs.jsonl');
  await fs.writeFile(file, [
    JSON.stringify(run({ ended_at: '2026-01-01T00:00:00Z' })),
    JSON.stringify(run({ ended_at: '2026-01-02T00:00:00Z', intraday_adjustment_provider_used: true, intraday_score_enabled: true }))
  ].join('\n') + '\n');
  const inputs = await lib.loadInputs({ logsFile: file });
  assert.equal(inputs.normal.ended_at, '2026-01-01T00:00:00Z');
  assert.equal(inputs.adjusted.ended_at, '2026-01-02T00:00:00Z');
});

test('compares score/rank deltas and summary counts', () => {
  const adjusted = run({ results: [
    { ticker: 'BBB', daytrade_score: 95, intraday_priority_label: 'INTRADAY_STRONG', intraday_confirmation_label: 'INTRADAY_CONFIRM', intraday_score_adjustment_applied: 15, intraday_score_adjustment_reasons: ['VWAP_SUPPORT +3'] },
    { ticker: 'AAA', daytrade_score: 90, intraday_priority_label: 'INTRADAY_WAIT' },
    { ticker: 'CCC', daytrade_score: 70 },
    { ticker: 'DDD', daytrade_score: 60 },
    { ticker: 'EEE', daytrade_score: 50 },
    { ticker: 'GGG', daytrade_score: 10 }
  ] });
  const out = lib.compareRuns(run(), adjusted);
  const bbb = out.rows.find((r) => r.ticker === 'BBB');
  assert.equal(bbb.score_delta, 15);
  assert.equal(bbb.normal_rank, 2);
  assert.equal(bbb.adjusted_rank, 1);
  assert.equal(bbb.rank_delta, -1);
  assert.equal(out.metrics.normal_count, 6);
  assert.equal(out.metrics.adjusted_count, 6);
  assert.equal(out.metrics.matched_tickers, 5);
  assert.deepEqual(out.metrics.normal_only, ['FFF']);
  assert.deepEqual(out.metrics.adjusted_only, ['GGG']);
});

test('computes ranks by score descending instead of source array order', () => {
  const normal = run({ results: [
    { ticker: 'LOW', daytrade_score: 10 },
    { ticker: 'HIGH', daytrade_score: 90 },
    { ticker: 'MID', daytrade_score: 50 }
  ] });
  const adjusted = run({ results: [
    { ticker: 'MID', daytrade_score: 50 },
    { ticker: 'LOW', daytrade_score: 10 },
    { ticker: 'HIGH', daytrade_score: 90 }
  ] });
  const out = lib.compareRuns(normal, adjusted);
  const high = out.rows.find((r) => r.ticker === 'HIGH');
  const low = out.rows.find((r) => r.ticker === 'LOW');
  assert.equal(high.normal_rank, 1);
  assert.equal(high.adjusted_rank, 1);
  assert.equal(low.normal_rank, 3);
  assert.equal(low.adjusted_rank, 3);
  assert.deepEqual(out.rows.map((r) => r.ticker), ['HIGH', 'MID', 'LOW']);
});

test('detects Top 5 and Top 20 entering/leaving', () => {
  const normalResults = Array.from({ length: 21 }, (_, i) => ({ ticker: 'T' + String(i + 1).padStart(2, '0'), daytrade_score: 100 - i }));
  const adjustedResults = [{ ticker: 'NEW', daytrade_score: 999 }].concat(normalResults.slice(0, 19));
  const out = lib.compareRuns(run({ results: normalResults }), run({ results: adjustedResults }));
  assert.ok(out.metrics.top5_entering.includes('NEW'));
  assert.ok(out.metrics.top5_leaving.includes('T05'));
  assert.ok(out.metrics.top20_entering.includes('NEW'));
  assert.ok(out.metrics.top20_leaving.includes('T20'));
});

test('low match and large churn warnings', () => {
  const out = lib.compareRuns(run({ results: [{ ticker: 'AAA', daytrade_score: 1 }, { ticker: 'BBB', daytrade_score: 1 }, { ticker: 'CCC', daytrade_score: 1 }, { ticker: 'DDD', daytrade_score: 1 }, { ticker: 'EEE', daytrade_score: 1 }] }), run({ results: [{ ticker: 'ZZZ', daytrade_score: 9 }, { ticker: 'YYY', daytrade_score: 8 }, { ticker: 'XXX', daytrade_score: 7 }, { ticker: 'WWW', daytrade_score: 6 }, { ticker: 'VVV', daytrade_score: 5 }] }));
  assert.ok(out.metrics.cautions.includes('LOW_MATCHED_TICKER_COUNT'));
  assert.ok(out.metrics.cautions.includes('LARGE_TOP5_CHURN'));
});

test('missing files graceful error', async () => {
  await assert.rejects(() => lib.loadInputs({ normalFile: '/tmp/no-such-normal.json', adjustedFile: '/tmp/no-such-adjusted.json' }), /Input file not found/);
  await assert.rejects(() => lib.loadInputs({ logsFile: '/tmp/no-such-runs.jsonl' }), /Logs file not found/);
});

test('markdown includes read-only no production write behavior confirmation', () => {
  const report = lib.buildReport(run(), run({ intraday_adjustment_provider_used: true, intraday_score_enabled: true }), {}, { date: '2026-01-01' });
  const md = lib.markdownReport(report);
  assert.match(md, /does not write Supabase/);
  assert.match(md, /does not .*send Telegram/);
});
