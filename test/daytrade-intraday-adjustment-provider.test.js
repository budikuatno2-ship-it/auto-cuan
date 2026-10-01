'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const provider = require('../lib/daytrade-intraday-adjustment-provider');
const scoreAdjustment = require('../lib/daytrade-intraday-score-adjustment');
const worker = require('../tools/daytrade-vps-worker-observe');

function row(extra) {
  return Object.assign({
    ticker: ' bbca ',
    intraday_score_adjustment_preview: '5',
    intraday_score_adjustment_reasons: 'VWAP_SUPPORT +3',
    intraday_priority_label: 'INTRADAY_OK',
    intraday_confirmation_label: 'INTRADAY_CONFIRM',
    intraday_labels: ['VWAP_SUPPORT'],
    data_quality: 'OK'
  }, extra || {});
}

test('normalizes intraday adjustment row', () => {
  const normalized = provider.normalizeIntradayAdjustmentRow(row());
  assert.deepEqual(normalized, {
    ticker: 'BBCA',
    intraday_score_adjustment_preview: 5,
    intraday_score_adjustment_reasons: ['VWAP_SUPPORT +3'],
    intraday_priority_label: 'INTRADAY_OK',
    intraday_confirmation_label: 'INTRADAY_CONFIRM',
    intraday_labels: ['VWAP_SUPPORT'],
    data_quality: 'OK'
  });
});

test('builds adjustment map by ticker', () => {
  const map = provider.buildIntradayAdjustmentMap([row({ ticker: 'bbca' }), row({ ticker: 'tlkm', intraday_score_adjustment_preview: -3 })]);
  assert.equal(map.size, 2);
  assert.equal(map.get('BBCA').intraday_score_adjustment_preview, 5);
  assert.equal(map.get('TLKM').intraday_score_adjustment_preview, -3);
});

test('loads JSON report with rows/results/candidates shapes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intraday-adjustments-'));
  for (const [name, payload] of [
    ['rows.json', { rows: [row({ ticker: 'aaa' })] }],
    ['results.json', { results: [row({ ticker: 'bbb' })] }],
    ['candidates.json', { candidates: [row({ ticker: 'ccc' })] }]
  ]) {
    const file = path.join(dir, name);
    await fs.writeFile(file, JSON.stringify(payload));
    const map = provider.loadIntradayAdjustmentFile(file);
    assert.equal(map.size, 1);
  }
});

test('attaches fields by ticker', () => {
  const map = provider.buildIntradayAdjustmentMap([row({ ticker: 'BBCA' })]);
  const candidate = { ticker: 'bbca', daytrade_score: 70 };
  const attached = provider.attachIntradayAdjustmentFields(candidate, map);
  assert.notEqual(attached, candidate);
  assert.equal(attached.daytrade_score, 70);
  assert.equal(attached.intraday_score_adjustment_preview, 5);
  assert.deepEqual(attached.intraday_labels, ['VWAP_SUPPORT']);
});

test('missing ticker is no-op', () => {
  const map = provider.buildIntradayAdjustmentMap([row({ ticker: 'BBCA' })]);
  const candidate = { ticker: 'TLKM', daytrade_score: 70 };
  assert.equal(provider.attachIntradayAdjustmentFields(candidate, map), candidate);
});

test('flag off with attached fields leaves score unchanged', () => {
  const map = provider.buildIntradayAdjustmentMap([row({ ticker: 'BBCA', intraday_score_adjustment_preview: 9 })]);
  const attached = provider.attachIntradayAdjustmentFields({ ticker: 'BBCA', daytrade_score: 70 }, map);
  const output = scoreAdjustment.applyIntradayScoreAdjustment(attached, { env: {} });
  assert.equal(output, attached);
  assert.equal(output.daytrade_score, 70);
});

test('flag on with attached fields adjusts score through existing hook', () => {
  const map = provider.buildIntradayAdjustmentMap([row({ ticker: 'BBCA', intraday_score_adjustment_preview: 9 })]);
  const attached = provider.attachIntradayAdjustmentFields({ ticker: 'BBCA', daytrade_score: 70 }, map);
  const output = scoreAdjustment.applyIntradayScoreAdjustment(attached, { env: { DAYTRADE_INTRADAY_SCORE_ENABLED: '1' } });
  assert.equal(output.daytrade_score, 79);
  assert.equal(output.intraday_score_adjustment_applied, 9);
});

test('finds latest intraday observe report', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intraday-reports-'));
  const oldFile = path.join(dir, 'daytrade-intraday-observe-2026-01-01.json');
  const newFile = path.join(dir, 'daytrade-intraday-observe-2026-01-02.json');
  await fs.writeFile(oldFile, JSON.stringify({ rows: [row({ ticker: 'OLD' })] }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await fs.writeFile(newFile, JSON.stringify({ rows: [row({ ticker: 'NEW' })] }));
  assert.equal(await provider.findLatestIntradayObserveReport(dir), newFile);
});

test('engine option hook is attached before score adjustment and remains absent-safe', async () => {
  const source = await fs.readFile(path.join(process.cwd(), 'lib', 'daytrade-screener-engine.js'), 'utf8');
  const attachIdx = source.indexOf('attachIntradayAdjustmentFields(scored, options.intradayAdjustmentByTicker)');
  const hookIdx = source.indexOf('applyIntradayScoreAdjustment(scored, options)', attachIdx);
  assert.notEqual(attachIdx, -1);
  assert.notEqual(hookIdx, -1);
  assert.ok(attachIdx < hookIdx);
});

test('worker CLI parses adjustment file and latest mode options', () => {
  const args = worker.parseArgs(['node', 'worker', '--mode', 'observe', '--intraday-adjustments-file', '/tmp/report.json', '--latest-intraday-adjustments', '--intraday-reports-dir', 'data/reports']);
  assert.equal(args.intradayAdjustmentsFile, '/tmp/report.json');
  assert.equal(args.latestIntradayAdjustments, 'true');
  assert.equal(args.intradayReportsDir, 'data/reports');
});

test('observe worker stays observe-only with no production write integrations', async () => {
  const source = await fs.readFile(path.join(process.cwd(), 'tools', 'daytrade-vps-worker-observe.js'), 'utf8');
  assert.equal(/require\([^)]*supabase/i.test(source), false);
  assert.equal(/require\([^)]*telegram/i.test(source), false);
  assert.equal(/supabase\.from\(|\.insert\(|\.upsert\(/i.test(source), false);
});
