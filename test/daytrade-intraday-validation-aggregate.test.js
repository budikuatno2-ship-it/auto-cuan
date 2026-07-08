'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const lib = require('../lib/daytrade-intraday-validation-aggregate');

function sample(date, overrides) {
  return Object.assign({
    date,
    validation_status: 'PASS',
    intraday_candidates_count: 4,
    provider_matched_count: 4,
    provider_missing_count: 0,
    data_quality_counts: { OK: 4 },
    priority_label_counts: { INTRADAY_OK: 4 },
    confirmation_label_counts: { INTRADAY_CONFIRM: 4 },
    top5_entering: [],
    top5_leaving: [],
    top_score_movers: [],
    no_intraday_data_tickers: [],
    incomplete_intraday_tickers: [],
    intraday_unknown_tickers: []
  }, overrides || {});
}

function aggregate(samples) { return lib.buildAggregateReport(samples, { nowMs: Date.UTC(2026, 6, 8) }); }

test('BLOCK when sample_count < 3', () => {
  const report = aggregate([sample('2026-07-07'), sample('2026-07-08')]);
  assert.equal(report.aggregate_status, 'BLOCK');
  assert.ok(report.block_reasons.includes('sample_count < 3'));
});

test('BLOCK when any sample is BLOCK', () => {
  const report = aggregate([sample('2026-07-06'), sample('2026-07-07', { validation_status: 'BLOCK' }), sample('2026-07-08')]);
  assert.equal(report.aggregate_status, 'BLOCK');
  assert.ok(report.block_reasons.includes('BLOCK appears in at least one sample'));
});

test('BLOCK when any NO_INTRADAY_DATA exists', () => {
  const report = aggregate([sample('2026-07-06'), sample('2026-07-07', { data_quality_counts: { OK: 3, NO_INTRADAY_DATA: 1 }, no_intraday_data_tickers: ['BRAM'] }), sample('2026-07-08')]);
  assert.equal(report.aggregate_status, 'BLOCK');
  assert.ok(report.block_reasons.includes('NO_INTRADAY_DATA count > 0 in at least one sample'));
});

test('BLOCK when any INCOMPLETE_INTRADAY exists', () => {
  const report = aggregate([sample('2026-07-06'), sample('2026-07-07', { data_quality_counts: { OK: 3, INCOMPLETE_INTRADAY: 1 }, incomplete_intraday_tickers: ['BBSI'] }), sample('2026-07-08')]);
  assert.equal(report.aggregate_status, 'BLOCK');
  assert.ok(report.block_reasons.includes('INCOMPLETE_INTRADAY count > 0 in at least one sample'));
});

test('repeated ticker aggregation', () => {
  const report = aggregate([
    sample('2026-07-06', { data_quality_counts: { OK: 2, NO_INTRADAY_DATA: 1 }, no_intraday_data_tickers: ['BRAM'], intraday_unknown_tickers: ['BRAM'], top_score_movers: ['BRAM (+6)'], top5_entering: ['AAA'] }),
    sample('2026-07-07', { data_quality_counts: { OK: 2, NO_INTRADAY_DATA: 1 }, no_intraday_data_tickers: ['BRAM'], intraday_unknown_tickers: ['BRAM'], top_score_movers: ['BRAM (-7)'], top5_entering: ['AAA'] }),
    sample('2026-07-08', { data_quality_counts: { OK: 2, INCOMPLETE_INTRADAY: 1 }, incomplete_intraday_tickers: ['BBSI'] })
  ]);
  assert.deepEqual(report.repeated_no_intraday_data_tickers, [{ ticker: 'BRAM', count: 2 }]);
  assert.deepEqual(report.repeated_intraday_unknown_tickers, [{ ticker: 'BRAM', count: 2 }]);
  assert.deepEqual(report.top_recurring_score_movers[0], { ticker: 'BRAM', count: 2 });
  assert.deepEqual(report.top5_entering_frequency[0], { ticker: 'AAA', count: 2 });
});


test('INTRADAY_UNKNOWN metrics sum priority and confirmation unknown counts', () => {
  const report = aggregate([
    sample('2026-07-06'),
    sample('2026-07-07', {
      priority_label_counts: { INTRADAY_UNKNOWN: 2 },
      confirmation_label_counts: { INTRADAY_UNKNOWN: 2 }
    }),
    sample('2026-07-08')
  ]);
  assert.equal(report.metrics.intraday_unknown.max, 4);
  assert.ok(report.block_reasons.includes('INTRADAY_UNKNOWN count > 0 in at least one sample'));
});

test('INTRADAY_UNKNOWN metrics fall back to unknown ticker count when label counts are zero', () => {
  const report = aggregate([
    sample('2026-07-06'),
    sample('2026-07-07', {
      priority_label_counts: {},
      confirmation_label_counts: {},
      intraday_unknown_tickers: ['BRAM', 'IDPR']
    }),
    sample('2026-07-08')
  ]);
  assert.equal(report.metrics.intraday_unknown.max, 2);
  assert.ok(report.block_reasons.includes('INTRADAY_UNKNOWN count > 0 in at least one sample'));
});

test('PASS when 3 clean PASS samples exist', () => {
  const report = aggregate([sample('2026-07-06'), sample('2026-07-07'), sample('2026-07-08')]);
  assert.equal(report.aggregate_status, 'PASS');
  assert.deepEqual(report.block_reasons, []);
  assert.deepEqual(report.warn_reasons, []);
});


test('aggregate avg_absolute_score_delta uses untruncated bundle metric, not top_score_movers', () => {
  const report = aggregate([
    sample('2026-07-06', { avg_absolute_score_delta: 4, top_score_movers: ['AAA (+10)', 'BBB (-10)'] }),
    sample('2026-07-07', { avg_absolute_score_delta: 5, top_score_movers: ['CCC (+9)'] }),
    sample('2026-07-08', { avg_absolute_score_delta: 5, top_score_movers: ['DDD (-8)'] })
  ]);
  assert.equal(report.metrics.avg_absolute_score_delta, 4.67);
  assert.equal(report.aggregate_status, 'PASS');
  assert.equal(report.warn_reasons.includes('avg absolute score delta > 5'), false);
  assert.deepEqual(report.top_recurring_score_movers.map((r) => r.ticker).sort(), ['AAA', 'BBB', 'CCC', 'DDD']);
});

test('markdown contains recommendation and read-only confirmation', () => {
  const md = lib.markdownReport(aggregate([sample('2026-07-06'), sample('2026-07-07'), sample('2026-07-08')]));
  assert.match(md, /recommendation:/);
  assert.match(md, /Read-only Confirmation/);
  assert.match(md, /does not enable DAYTRADE_INTRADAY_SCORE_ENABLED/);
});

test('graceful error when no bundle JSON files exist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aggregate-empty-'));
  await assert.rejects(() => lib.loadBundles({ reportsDir: dir }), /No daytrade intraday validation bundle JSON files found/);
});

test('loadBundles reads local bundle JSON files and respects day limit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aggregate-load-'));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-bundle-2026-07-06.json'), JSON.stringify(sample('2026-07-06')));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-bundle-2026-07-07.json'), JSON.stringify(sample('2026-07-07')));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-bundle-2026-07-08.json'), JSON.stringify(sample('2026-07-08')));
  const samples = await lib.loadBundles({ reportsDir: dir, days: 2 });
  assert.deepEqual(samples.map((s) => s.date), ['2026-07-08', '2026-07-07']);
});

test('loadBundles ignores session archives unless explicitly included', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aggregate-default-'));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-bundle-2026-07-08.json'), JSON.stringify(sample('2026-07-08', { generated_at: '2026-07-08T08:00:00.000Z' })));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-bundle-session-2026-07-08T09-00-00Z.json'), JSON.stringify(sample('2026-07-08', {
    session_id: 's-0900',
    generated_at: '2026-07-08T09:00:00.000Z',
    report_date: '2026-07-08'
  })));
  const samples = await lib.loadBundles({ reportsDir: dir, days: 5 });
  assert.equal(samples.length, 1);
  assert.deepEqual(samples.map((s) => s._source_type), ['daily']);
});

test('loadBundles includes multiple session archive files and reports source counts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aggregate-sessions-'));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-bundle-2026-07-08.json'), JSON.stringify(sample('2026-07-08', { generated_at: '2026-07-08T08:00:00.000Z' })));
  for (const hour of ['09', '10']) {
    await fs.writeFile(path.join(dir, `daytrade-intraday-validation-bundle-session-2026-07-08T${hour}-00-00Z.json`), JSON.stringify(sample('2026-07-08', {
      session_id: `s-${hour}`,
      generated_at: `2026-07-08T${hour}:00:00.000Z`,
      report_date: '2026-07-08'
    })));
  }
  const samples = await lib.loadBundles({ reportsDir: dir, days: 5, includeSessionArchives: true });
  assert.equal(samples.length, 3);
  assert.deepEqual(samples.map((s) => s._sample_id), ['s-10', 's-09', '2026-07-08T08:00:00.000Z|2026-07-08']);
  const report = aggregate(samples);
  assert.deepEqual(report.sample_source_counts, { daily: 1, session_archive: 2 });
});

test('loadBundles deduplicates a daily bundle and matching session archive by generated_at/report_date', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aggregate-dedupe-'));
  const base = sample('2026-07-08', { generated_at: '2026-07-08T08:00:00.000Z' });
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-bundle-2026-07-08.json'), JSON.stringify(base));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-bundle-session-2026-07-08T08-00-00Z.json'), JSON.stringify(Object.assign({}, base, {
    session_id: 'session-0800',
    report_date: '2026-07-08',
    source_daily_bundle_path: path.join(dir, 'daytrade-intraday-validation-bundle-2026-07-08.json')
  })));
  const samples = await lib.loadBundles({ reportsDir: dir, includeSessionArchives: true });
  assert.equal(samples.length, 1);
  assert.equal(samples[0]._source_type, 'session_archive');
  assert.equal(samples[0]._sample_id, 'session-0800');
  const report = aggregate(samples);
  assert.equal(report.sample_count, 1);
  assert.deepEqual(report.sample_ids, ['session-0800']);
});

test('loadBundles --samples keeps most recent samples after filtering', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aggregate-limit-'));
  for (const hour of ['08', '09', '10']) {
    await fs.writeFile(path.join(dir, `daytrade-intraday-validation-bundle-session-2026-07-08T${hour}-00-00Z.json`), JSON.stringify(sample('2026-07-08', {
      session_id: `s-${hour}`,
      generated_at: `2026-07-08T${hour}:00:00.000Z`,
      report_date: '2026-07-08'
    })));
  }
  const samples = await lib.loadBundles({ reportsDir: dir, includeSessionArchives: true, samples: 2 });
  assert.deepEqual(samples.map((s) => s.session_id), ['s-10', 's-09']);
  assert.equal(aggregate(samples).aggregate_status, 'BLOCK');
});

test('matching daily copy does not inflate sample_count across multiple archived sessions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aggregate-count-'));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-bundle-2026-07-08.json'), JSON.stringify(sample('2026-07-08', {
    generated_at: '2026-07-08T09:00:00.000Z'
  })));
  for (const hour of ['09', '10']) {
    await fs.writeFile(path.join(dir, `daytrade-intraday-validation-bundle-session-2026-07-08T${hour}-00-00Z.json`), JSON.stringify(sample('2026-07-08', {
      session_id: `session-${hour}`,
      generated_at: `2026-07-08T${hour}:00:00.000Z`,
      report_date: '2026-07-08'
    })));
  }
  const samples = await lib.loadBundles({ reportsDir: dir, includeSessionArchives: true });
  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map((s) => s._sample_id), ['session-10', 'session-09']);
  const report = aggregate(samples);
  assert.equal(report.sample_count, 2);
  assert.deepEqual(report.sample_source_counts, { daily: 0, session_archive: 2 });
});

test('different generated_at session archives remain separate even if session_id matches', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aggregate-different-generated-'));
  for (const hour of ['09', '10']) {
    await fs.writeFile(path.join(dir, `daytrade-intraday-validation-bundle-session-2026-07-08T${hour}-00-00Z.json`), JSON.stringify(sample('2026-07-08', {
      session_id: 'same-display-id',
      generated_at: `2026-07-08T${hour}:00:00.000Z`,
      report_date: '2026-07-08'
    })));
  }
  const samples = await lib.loadBundles({ reportsDir: dir, includeSessionArchives: true });
  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map((s) => s.generated_at), ['2026-07-08T10:00:00.000Z', '2026-07-08T09:00:00.000Z']);
});

test('aggregate with included session archive remains BLOCK when any sample has incomplete intraday', () => {
  const report = aggregate([
    Object.assign(sample('2026-07-08'), { _source_type: 'session_archive', session_id: 's1' }),
    Object.assign(sample('2026-07-08', { data_quality_counts: { OK: 3, INCOMPLETE_INTRADAY: 1 }, incomplete_intraday_tickers: ['AMFG'] }), { _source_type: 'session_archive', session_id: 's2' }),
    Object.assign(sample('2026-07-08'), { _source_type: 'session_archive', session_id: 's3' })
  ]);
  assert.equal(report.aggregate_status, 'BLOCK');
  assert.ok(report.block_reasons.includes('INCOMPLETE_INTRADAY count > 0 in at least one sample'));
});
