'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const lib = require('../lib/daytrade-intraday-policy');
const cli = require('../tools/report-daytrade-intraday-policy');

function bundle(overrides) {
  return Object.assign({
    date: '2026-07-08',
    validation_status: 'PASS',
    no_intraday_data_tickers: [],
    incomplete_intraday_tickers: [],
    intraday_unknown_tickers: [],
    rows: []
  }, overrides || {});
}

function aggregate(overrides) {
  return Object.assign({
    date: '2026-07-08',
    aggregate_status: 'PASS',
    repeated_no_intraday_data_tickers: [],
    repeated_incomplete_intraday_tickers: [],
    repeated_intraday_unknown_tickers: []
  }, overrides || {});
}

test('BLOCK when NO_INTRADAY_DATA ticker exists', () => {
  const report = lib.buildPolicyReport(bundle({
    no_intraday_data_tickers: ['BRAM'],
    rows: [
      { ticker: 'BRAM', data_quality: 'NO_INTRADAY_DATA', intraday_priority_label: 'INTRADAY_UNKNOWN', intraday_confirmation_label: 'INTRADAY_UNKNOWN' },
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  }), null);
  assert.equal(report.policy_status, 'BLOCK');
  assert.ok(report.tickers_by_decision.BLOCK_PRODUCTION_ENABLE.includes('BRAM'));
  assert.ok(report.tickers_by_fallback_action.DAILY_SCORE_ONLY.includes('BRAM'));
});

test('BLOCK when INTRADAY_UNKNOWN ticker exists', () => {
  const report = lib.buildPolicyReport(bundle({
    intraday_unknown_tickers: ['IDPR'],
    rows: [
      { ticker: 'IDPR', data_quality: 'OK', intraday_priority_label: 'INTRADAY_UNKNOWN', intraday_confirmation_label: 'INTRADAY_UNKNOWN' },
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  }), null);
  assert.equal(report.policy_status, 'BLOCK');
  assert.ok(report.tickers_by_decision.BLOCK_PRODUCTION_ENABLE.includes('IDPR'));
  assert.ok(report.block_reasons.includes('BLOCK_PRODUCTION_ENABLE ticker exists'));
});

test('WARN when only INCOMPLETE_INTRADAY ticker exists', () => {
  const report = lib.buildPolicyReport(bundle({
    incomplete_intraday_tickers: ['BBSI'],
    rows: [
      { ticker: 'BBSI', data_quality: 'INCOMPLETE_INTRADAY', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' },
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  }), null);
  assert.equal(report.policy_status, 'WARN');
  assert.ok(report.tickers_by_decision.EXCLUDE_INTRADAY_ADJUSTMENT.includes('BBSI'));
  assert.ok(report.tickers_by_fallback_action.DAILY_SCORE_ONLY.includes('BBSI'));
});


test('STALE_CACHE row is DAILY_SCORE_ONLY and policy carries intraday diagnostics', () => {
  const report = lib.buildPolicyReport(bundle({
    rows: [{
      ticker: 'BBSI',
      data_quality: 'STALE_CACHE',
      intraday_priority_label: 'INTRADAY_UNKNOWN',
      intraday_confirmation_label: 'INTRADAY_CAUTION',
      intraday_data_diagnostics: {
        session_date: '2026-07-08',
        updated_at: '2026-07-08T09:00:00.000Z',
        candle_count: 4,
        valid_ohlc_candles: 4,
        zero_ohlc_candles: 0,
        positive_volume_candles: 4,
        total_volume: 12345,
        source: 'yahoo',
        interval: '15m'
      }
    }]
  }), null);
  assert.ok(report.tickers_by_fallback_action.DAILY_SCORE_ONLY.includes('BBSI'));
  assert.equal(report.policies[0].intraday_data_diagnostics.session_date, '2026-07-08');
  assert.equal(report.incomplete_intraday_diagnostics[0].total_volume, 12345);
  assert.match(lib.markdownReport(report), /Incomplete Intraday Diagnostics/);
});

test('PASS when only OK tickers exist', () => {
  const report = lib.buildPolicyReport(bundle({
    rows: [
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' },
      { ticker: 'BBB', data_quality: 'OK', intraday_priority_label: 'INTRADAY_STRONG', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  }), null);
  assert.equal(report.policy_status, 'PASS');
  assert.deepEqual(report.ok_for_intraday_dry_run_tickers, ['AAA', 'BBB']);
});

test('repeated_no_intraday_data_tickers overrides bundle OK and blocks', () => {
  const report = lib.buildPolicyReport(bundle({
    rows: [{ ticker: 'BRAM', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }]
  }), aggregate({
    repeated_no_intraday_data_tickers: [{ ticker: 'BRAM', count: 2 }]
  }));
  assert.equal(report.policy_status, 'BLOCK');
  assert.ok(report.block_reasons.includes('recurring NO_INTRADAY_DATA ticker exists'));
  assert.ok(report.tickers_by_decision.BLOCK_PRODUCTION_ENABLE.includes('BRAM'));
});

test('repeated_intraday_unknown_tickers overrides bundle OK and blocks', () => {
  const report = lib.buildPolicyReport(bundle({
    rows: [{ ticker: 'IDPR', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }]
  }), aggregate({
    repeated_intraday_unknown_tickers: [{ ticker: 'IDPR', count: 2 }]
  }));
  assert.equal(report.policy_status, 'BLOCK');
  assert.ok(report.block_reasons.includes('recurring INTRADAY_UNKNOWN ticker exists'));
  assert.ok(report.tickers_by_decision.BLOCK_PRODUCTION_ENABLE.includes('IDPR'));
});

test('repeated_incomplete_intraday_tickers overrides bundle OK and creates daily-only exclude', () => {
  const report = lib.buildPolicyReport(bundle({
    rows: [{ ticker: 'BBSI', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }]
  }), aggregate({
    repeated_incomplete_intraday_tickers: [{ ticker: 'BBSI', count: 2 }]
  }));
  assert.equal(report.policy_status, 'WARN');
  assert.ok(report.tickers_by_decision.EXCLUDE_INTRADAY_ADJUSTMENT.includes('BBSI'));
  assert.ok(report.tickers_by_fallback_action.DAILY_SCORE_ONLY.includes('BBSI'));
});

test('legacy aggregate recurring field names still work as fallback', () => {
  const report = lib.buildPolicyReport(bundle({
    rows: [{ ticker: 'LEGACY', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }]
  }), {
    aggregate_status: 'PASS',
    no_intraday_data_tickers: [{ ticker: 'LEGACY', count: 2 }]
  });
  assert.equal(report.policy_status, 'BLOCK');
  assert.ok(report.tickers_by_decision.BLOCK_PRODUCTION_ENABLE.includes('LEGACY'));
});

test('OK + INTRADAY_CAUTION remains OK_FOR_INTRADAY_DRY_RUN and is watched', () => {
  const report = lib.buildPolicyReport(bundle({
    rows: [
      { ticker: 'CAUT', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CAUTION' },
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  }), null);
  assert.equal(report.policy_status, 'WARN');
  assert.ok(report.tickers_by_decision.OK_FOR_INTRADAY_DRY_RUN.includes('CAUT'));
  assert.ok(report.ok_for_intraday_dry_run_tickers.includes('CAUT'));
  assert.ok(report.watch_next_session_tickers.includes('CAUT'));
  assert.ok(report.warn_reasons.includes('watch_next_session_tickers exists'));
});

test('OK + INTRADAY_AVOID remains OK_FOR_INTRADAY_DRY_RUN and is watched', () => {
  const report = lib.buildPolicyReport(bundle({
    rows: [
      { ticker: 'AVOID', data_quality: 'OK', intraday_priority_label: 'INTRADAY_AVOID', intraday_confirmation_label: 'INTRADAY_CONFIRM' },
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  }), null);
  assert.equal(report.policy_status, 'WARN');
  assert.ok(report.tickers_by_decision.OK_FOR_INTRADAY_DRY_RUN.includes('AVOID'));
  assert.ok(report.ok_for_intraday_dry_run_tickers.includes('AVOID'));
  assert.ok(report.watch_next_session_tickers.includes('AVOID'));
});

test('aggregate_status BLOCK overrides clean bundle', () => {
  const report = lib.buildPolicyReport(bundle({
    rows: [{ ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }]
  }), aggregate({ aggregate_status: 'BLOCK' }));
  assert.equal(report.policy_status, 'BLOCK');
  assert.ok(report.block_reasons.includes('aggregate_status is BLOCK'));
});

test('aggregate_status WARN warns clean bundle', () => {
  const report = lib.buildPolicyReport(bundle({
    rows: [{ ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }]
  }), aggregate({ aggregate_status: 'WARN' }));
  assert.equal(report.policy_status, 'WARN');
  assert.ok(report.warn_reasons.includes('aggregate_status is WARN'));
});

test('missing aggregate still works using bundle only', () => {
  const report = lib.buildPolicyReport(bundle({
    rows: [{ ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }]
  }), null);
  assert.equal(report.has_aggregate, false);
  assert.equal(report.policy_status, 'PASS');
});

test('markdown includes policy status, recommendation, decisions, watch list, daily-only, and read-only confirmation', () => {
  const report = lib.buildPolicyReport(bundle({
    no_intraday_data_tickers: ['BRAM'],
    rows: [
      { ticker: 'BRAM', data_quality: 'NO_INTRADAY_DATA', intraday_priority_label: 'INTRADAY_UNKNOWN', intraday_confirmation_label: 'INTRADAY_UNKNOWN' },
      { ticker: 'CAUT', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CAUTION' }
    ]
  }), null);
  const md = lib.markdownReport(report);
  assert.match(md, /policy_status:/);
  assert.match(md, /recommendation:/);
  assert.match(md, /Tickers by Decision/);
  assert.match(md, /Watch Next Session Tickers/);
  assert.match(md, /DAILY_SCORE_ONLY/);
  assert.match(md, /does NOT enable DAYTRADE_INTRADAY_SCORE_ENABLED/);
});

test('latestFile returns newest matching file by date', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-latest-'));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-bundle-2026-07-07.json'), '{}');
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-bundle-2026-07-08.json'), '{}');
  const latest = await lib.latestFile(dir, lib.BUNDLE_PREFIX);
  assert.equal(path.basename(latest), 'daytrade-intraday-validation-bundle-2026-07-08.json');
});

test('loadInputs loads bundle and optional aggregate from latest files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-load-'));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-bundle-2026-07-08.json'), JSON.stringify(bundle({ rows: [{ ticker: 'AAA', data_quality: 'OK' }] })));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-aggregate-2026-07-08.json'), JSON.stringify(aggregate({ aggregate_status: 'PASS' })));
  const inputs = await lib.loadInputs({ reportsDir: dir });
  assert.equal(inputs.bundle.date, '2026-07-08');
  assert.equal(inputs.aggregate.aggregate_status, 'PASS');
});

test('loadInputs works without aggregate file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-load-no-aggregate-'));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-bundle-2026-07-08.json'), JSON.stringify(bundle({ rows: [{ ticker: 'AAA', data_quality: 'OK' }] })));
  const inputs = await lib.loadInputs({ reportsDir: dir });
  assert.equal(inputs.bundle.date, '2026-07-08');
  assert.equal(inputs.aggregate, null);
});

test('writeReports writes markdown and optional JSON', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-write-'));
  const report = lib.buildPolicyReport(bundle({ rows: [{ ticker: 'AAA', data_quality: 'OK' }] }), null, { nowMs: Date.UTC(2026, 6, 8) });
  const paths = await lib.writeReports(report, { reportsDir: dir, writeJson: true });
  assert.equal(path.basename(paths.markdown), 'daytrade-intraday-policy-2026-07-08.md');
  assert.equal(path.basename(paths.json), 'daytrade-intraday-policy-2026-07-08.json');
  assert.match(await fs.readFile(paths.markdown, 'utf8'), /Day Trade Intraday Policy Report/);
});

test('run builds and writes policy report', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-run-'));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-bundle-2026-07-08.json'), JSON.stringify(bundle({ rows: [{ ticker: 'AAA', data_quality: 'OK' }] })));
  const result = await lib.run({ reportsDir: dir, writeJson: true });
  assert.equal(result.report.policy_status, 'PASS');
  assert.ok(result.paths.markdown.endsWith('.md'));
  assert.ok(result.paths.json.endsWith('.json'));
});

test('CLI parseArgs supports report options', () => {
  const args = cli.parseArgs(['node', 'tool', '--reports-dir', 'tmp', '--bundle-file', 'bundle.json', '--aggregate-file', 'aggregate.json', '--json']);
  assert.equal(args.reportsDir, 'tmp');
  assert.equal(args.bundleFile, 'bundle.json');
  assert.equal(args.aggregateFile, 'aggregate.json');
  assert.equal(args.writeJson, true);
});

test('ticker normalization strips .JK suffix', () => {
  const report = lib.buildPolicyReport(bundle({
    no_intraday_data_tickers: ['BRAM.JK'],
    rows: [{ ticker: 'BRAM', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }]
  }), null);
  assert.ok(report.tickers_by_decision.BLOCK_PRODUCTION_ENABLE.includes('BRAM'));
});

test('bundle rows coverage evaluates all 16 candidates and keeps OK caution eligible with watch metadata', () => {
  const ok = Array.from({ length: 12 }, (_, i) => ({
    ticker: `OK${String(i).padStart(2, '0')}`,
    data_quality: 'OK',
    intraday_priority_label: i === 0 ? 'INTRADAY_AVOID' : 'INTRADAY_OK',
    intraday_confirmation_label: i === 1 ? 'INTRADAY_CAUTION' : 'INTRADAY_CONFIRM'
  }));
  const report = lib.buildPolicyReport(bundle({
    intraday_candidates_count: 16,
    rows: ok.concat([
      { ticker: 'AMFG', data_quality: 'INCOMPLETE_INTRADAY', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' },
      { ticker: 'BBSI', data_quality: 'INCOMPLETE_INTRADAY', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' },
      { ticker: 'BRAM', data_quality: 'NO_INTRADAY_DATA', intraday_priority_label: 'INTRADAY_UNKNOWN', intraday_confirmation_label: 'INTRADAY_UNKNOWN' },
      { ticker: 'IDPR', data_quality: 'NO_INTRADAY_DATA', intraday_priority_label: 'INTRADAY_UNKNOWN', intraday_confirmation_label: 'INTRADAY_UNKNOWN' }
    ])
  }), null);
  assert.equal(report.total_tickers_evaluated, 16);
  assert.equal(report.bundle_candidate_count, 16);
  assert.equal(report.policy_evaluated_count, 16);
  assert.equal(report.coverage_status, 'OK');
  assert.equal(report.ok_for_intraday_dry_run_tickers.length, 12);
  assert.deepEqual(report.tickers_by_decision.EXCLUDE_INTRADAY_ADJUSTMENT.sort(), ['AMFG', 'BBSI']);
  assert.deepEqual(report.tickers_by_decision.BLOCK_PRODUCTION_ENABLE.sort(), ['BRAM', 'IDPR']);
  assert.ok(report.tickers_by_fallback_action.DAILY_SCORE_ONLY.includes('AMFG'));
  assert.ok(report.tickers_by_fallback_action.DAILY_SCORE_ONLY.includes('BRAM'));
  assert.ok(report.ok_for_intraday_dry_run_tickers.includes('OK00'));
  assert.ok(report.watch_next_session_tickers.includes('OK00'));
  assert.ok(report.watch_next_session_tickers.includes('OK01'));
});

test('coverage is incomplete when candidate count exceeds evaluated rows', () => {
  const report = lib.buildPolicyReport(bundle({ intraday_candidates_count: 16, rows: [{ ticker: 'AAA', data_quality: 'OK' }] }), null);
  assert.equal(report.coverage_status, 'INCOMPLETE');
  assert.equal(report.policy_status, 'BLOCK');
  assert.match(lib.markdownReport(report), /coverage_status: INCOMPLETE/);
});
