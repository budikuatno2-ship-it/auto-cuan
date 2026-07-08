'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const lib = require('../lib/daytrade-intraday-score-impact');

function row(ticker, score, adj, extra) {
  return Object.assign({ ticker, score, intraday_score_adjustment_preview: adj, intraday_priority_label: 'INTRADAY_WAIT', intraday_confirmation_label: 'INTRADAY_NEUTRAL', data_quality: 'OK', intraday_score_adjustment_reasons: adj > 0 ? ['VWAP_SUPPORT +3'] : adj < 0 ? ['CHASE_RISK -5'] : [] }, extra || {});
}

test('simulated score applies intraday adjustment', () => {
  const report = lib.simulateImpact([row('AAA', 80, 5)], [], { productionSource: 'intraday' });
  assert.equal(report.all_rows[0].current_score, 80);
  assert.equal(report.all_rows[0].simulated_score, 85);
});

test('score capped at 100', () => {
  const report = lib.simulateImpact([row('AAA', 98, 10)], [], { productionSource: 'intraday' });
  assert.equal(report.all_rows[0].simulated_score, 100);
});

test('score floored at 0', () => {
  const report = lib.simulateImpact([row('AAA', 3, -10)], [], { productionSource: 'intraday' });
  assert.equal(report.all_rows[0].simulated_score, 0);
});

test('current and simulated ranks calculated correctly', () => {
  const report = lib.simulateImpact([row('AAA', 90, -10), row('BBB', 85, 10), row('CCC', 80, 0)], [], { productionSource: 'intraday' });
  const byTicker = Object.fromEntries(report.all_rows.map((r) => [r.ticker, r]));
  assert.equal(byTicker.AAA.current_rank, 1);
  assert.equal(byTicker.AAA.simulated_rank, 2);
  assert.equal(byTicker.BBB.current_rank, 2);
  assert.equal(byTicker.BBB.simulated_rank, 1);
  assert.equal(byTicker.BBB.rank_delta, 1);
});

test('entering/leaving Top 5 detection', () => {
  const rows = [row('A', 100, 0), row('B', 99, 0), row('C', 98, 0), row('D', 97, 0), row('E', 96, -10), row('F', 95, 10)];
  const report = lib.simulateImpact(rows, [], { productionSource: 'intraday' });
  assert.deepEqual(report.summary.entering_top_5, ['F']);
  assert.deepEqual(report.summary.leaving_top_5, ['E']);
});

test('entering/leaving Top 20 detection', () => {
  const rows = Array.from({ length: 21 }, (_, i) => row('T' + String(i + 1).padStart(2, '0'), 100 - i, 0));
  rows[19].intraday_score_adjustment_preview = -10;
  rows[20].intraday_score_adjustment_preview = 10;
  const report = lib.simulateImpact(rows, [], { productionSource: 'intraday' });
  assert.deepEqual(report.summary.entering_top_20, ['T21']);
  assert.deepEqual(report.summary.leaving_top_20, ['T20']);
});

test('promotions/demotions sorted correctly', () => {
  const rows = [row('A', 100, 0), row('B', 99, -10), row('C', 98, -10), row('D', 97, 10), row('E', 96, 10)];
  const report = lib.simulateImpact(rows, [], { productionSource: 'intraday' });
  assert.equal(report.summary.top_promotions[0].ticker, 'D');
  assert.ok(report.summary.top_promotions[0].rank_delta > 0);
  assert.equal(report.summary.top_demotions[0].ticker, 'B');
  assert.ok(report.summary.top_demotions[0].rank_delta < 0);
});

test('missing intraday adjustment handled gracefully as neutral adjustment', () => {
  const report = lib.simulateImpact([{ ticker: 'AAA', score: 70, data_quality: 'OK' }], [], { productionSource: 'intraday' });
  assert.equal(report.all_rows[0].adjustment, 0);
  assert.equal(report.all_rows[0].missing_adjustment, true);
  assert.equal(report.all_rows[0].simulated_score, 70);
});

test('missing production score handled gracefully by skipping row', () => {
  const report = lib.simulateImpact([{ ticker: 'AAA', intraday_score_adjustment_preview: 3 }], [], { productionSource: 'intraday' });
  assert.equal(report.summary.total_rows_simulated, 0);
  assert.deepEqual(report.summary.skipped, [{ ticker: 'AAA', reason: 'missing_production_score' }]);
});

test('report summary includes priority/data-quality counts', () => {
  const report = lib.simulateImpact([
    row('AAA', 80, 3, { intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM', data_quality: 'OK' }),
    row('BBB', 70, -3, { intraday_priority_label: 'INTRADAY_AVOID', intraday_confirmation_label: 'INTRADAY_CAUTION', data_quality: 'STALE_CACHE' })
  ], [], { productionSource: 'intraday' });
  assert.equal(report.summary.intraday_priority_label.INTRADAY_OK, 1);
  assert.equal(report.summary.intraday_priority_label.INTRADAY_AVOID, 1);
  assert.equal(report.summary.intraday_confirmation_label.INTRADAY_CONFIRM, 1);
  assert.equal(report.summary.data_quality.OK, 1);
  assert.match(lib.markdownReport(Object.assign({ date: '2026-07-08' }, report)), /data_quality/);
});

test('report tooling remains read-only with no production write behavior', async () => {
  const libSource = await fs.readFile(path.join(process.cwd(), 'lib', 'daytrade-intraday-score-impact.js'), 'utf8');
  const toolSource = await fs.readFile(path.join(process.cwd(), 'tools', 'report-daytrade-intraday-score-impact.js'), 'utf8');
  const source = libSource + '\n' + toolSource;
  assert.equal(/\.insert\s*\(/.test(source), false);
  assert.equal(/\.upsert\s*\(/.test(source), false);
  assert.equal(/\.delete\s*\(/.test(source), false);
  assert.equal(/sendTelegram|telegram/i.test(source), false);
  assert.equal(/daytrade_screener_latest'\)\.select/.test(source), true);
});
