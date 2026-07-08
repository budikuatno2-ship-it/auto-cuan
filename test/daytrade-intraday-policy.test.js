'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const lib = require('../lib/daytrade-intraday-policy');

function makeBundle(date, overrides) {
  // Start with clean base - no default rows
  const base = {
    date,
    validation_status: 'PASS',
    intraday_candidates_count: 0,
    provider_matched_count: 0,
    provider_missing_count: 0,
    data_quality_counts: {},
    priority_label_counts: {},
    confirmation_label_counts: {},
    top5_entering: [],
    top5_leaving: [],
    top_score_movers: [],
    no_intraday_data_tickers: [],
    incomplete_intraday_tickers: [],
    intraday_unknown_tickers: [],
    rows: []
  };
  return Object.assign(base, overrides || {});
}

function makeAggregate(date, overrides) {
  return Object.assign({
    date,
    aggregate_status: 'PASS',
    sample_count: 3,
    repeated_no_intraday_data_tickers: [],
    repeated_incomplete_intraday_tickers: [],
    repeated_intraday_unknown_tickers: [],
    no_intraday_data_tickers: [],
    incomplete_intraday_tickers: [],
    intraday_unknown_tickers: []
  }, overrides || {});
}

test('BLOCK when NO_INTRADAY_DATA ticker exists', () => {
  const bundle = makeBundle('2026-07-08', {
    data_quality_counts: { OK: 2, NO_INTRADAY_DATA: 1 },
    no_intraday_data_tickers: ['BRAM'],
    rows: [
      { ticker: 'BRAM', data_quality: 'NO_INTRADAY_DATA', intraday_priority_label: 'INTRADAY_UNKNOWN', intraday_confirmation_label: 'INTRADAY_UNKNOWN' },
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  });

  const report = lib.buildPolicyReport(bundle, null);
  assert.equal(report.policy_status, 'BLOCK');
  assert.ok(report.block_reasons.includes('BLOCK_PRODUCTION_ENABLE ticker exists'));
  assert.ok(report.tickers_by_decision['BLOCK_PRODUCTION_ENABLE'].includes('BRAM'));
});

test('BLOCK when INTRADAY_UNKNOWN ticker exists', () => {
  const bundle = makeBundle('2026-07-08', {
    data_quality_counts: { OK: 2, INTRADAY_UNKNOWN: 1 },
    intraday_unknown_tickers: ['IDPR'],
    rows: [
      { ticker: 'IDPR', data_quality: 'OK', intraday_priority_label: 'INTRADAY_UNKNOWN', intraday_confirmation_label: 'INTRADAY_UNKNOWN' },
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  });

  const report = lib.buildPolicyReport(bundle, null);
  assert.equal(report.policy_status, 'BLOCK');
  assert.ok(report.block_reasons.includes('BLOCK_PRODUCTION_ENABLE ticker exists'));
  assert.ok(report.tickers_by_decision['BLOCK_PRODUCTION_ENABLE'].includes('IDPR'));
});

test('WARN when only INCOMPLETE_INTRADAY ticker exists', () => {
  const bundle = makeBundle('2026-07-08', {
    data_quality_counts: { OK: 2, INCOMPLETE_INTRADAY: 1 },
    incomplete_intraday_tickers: ['BBSI'],
    rows: [
      { ticker: 'BBSI', data_quality: 'INCOMPLETE_INTRADAY', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' },
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  });

  const report = lib.buildPolicyReport(bundle, null);
  assert.equal(report.policy_status, 'WARN');
  assert.ok(report.warn_reasons.includes('EXCLUDE_INTRADAY_ADJUSTMENT ticker exists'));
  assert.ok(report.tickers_by_decision['EXCLUDE_INTRADAY_ADJUSTMENT'].includes('BBSI'));
});

test('PASS when only OK tickers exist', () => {
  const bundle = makeBundle('2026-07-08', {
    data_quality_counts: { OK: 3 },
    rows: [
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' },
      { ticker: 'BBB', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' },
      { ticker: 'CCC', data_quality: 'OK', intraday_priority_label: 'INTRADAY_STRONG', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  });

  const report = lib.buildPolicyReport(bundle, null);
  assert.equal(report.policy_status, 'PASS');
  assert.deepEqual(report.ok_for_intraday_dry_run_tickers.sort(), ['AAA', 'BBB', 'CCC']);
});

test('recurring aggregate blockers override bundle OK', () => {
  const bundle = makeBundle('2026-07-08', {
    data_quality_counts: { OK: 2 },
    rows: [
      { ticker: 'BRAM', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' },
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  });

  const aggregate = makeAggregate('2026-07-08', {
    aggregate_status: 'PASS',
    no_intraday_data_tickers: [{ ticker: 'BRAM', count: 2 }]
  });

  const report = lib.buildPolicyReport(bundle, aggregate);
  assert.equal(report.policy_status, 'BLOCK');
  assert.ok(report.block_reasons.includes('recurring NO_INTRADAY_DATA ticker exists'));
  assert.ok(report.tickers_by_decision['BLOCK_PRODUCTION_ENABLE'].includes('BRAM'));
});

test('missing aggregate file still works using bundle only', () => {
  const bundle = makeBundle('2026-07-08', {
    data_quality_counts: { OK: 3 },
    rows: [
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  });

  const report = lib.buildPolicyReport(bundle, null);
  assert.equal(report.policy_status, 'PASS');
  assert.equal(report.has_aggregate, false);
});

test('WATCH_NEXT_SESSION for non-recurring issues (CAUTION)', () => {
  const bundle = makeBundle('2026-07-08', {
    data_quality_counts: { OK: 2, INTRADAY_CAUTION: 1 },
    rows: [
      { ticker: 'TEST', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CAUTION' },
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  });

  const report = lib.buildPolicyReport(bundle, null);
  // WARN because WATCH_NEXT_SESSION exists
  assert.equal(report.policy_status, 'WARN');
  // But fallback should still be UNCHANGED (OK for intraday)
  assert.ok(report.tickers_by_decision['WATCH_NEXT_SESSION'].includes('TEST'));
  assert.equal(report.tickers_by_fallback_action['UNCHANGED'].includes('TEST'), true);
});

test('BLOCK when aggregate_status is BLOCK', () => {
  const bundle = makeBundle('2026-07-08', {
    data_quality_counts: { OK: 2 },
    rows: [
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  });

  const aggregate = makeAggregate('2026-07-08', {
    aggregate_status: 'BLOCK'
  });

  const report = lib.buildPolicyReport(bundle, aggregate);
  assert.equal(report.policy_status, 'BLOCK');
  assert.ok(report.block_reasons.includes('aggregate_status is BLOCK'));
});

test('WARN when aggregate_status is WARN', () => {
  const bundle = makeBundle('2026-07-08', {
    data_quality_counts: { OK: 2 },
    rows: [
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  });

  const aggregate = makeAggregate('2026-07-08', {
    aggregate_status: 'WARN'
  });

  const report = lib.buildPolicyReport(bundle, aggregate);
  assert.equal(report.policy_status, 'WARN');
  assert.ok(report.warn_reasons.includes('aggregate_status is WARN'));
});

test('INTRADAY_AVOID with OK data leads to WATCH_NEXT_SESSION (not excluded)', () => {
  const bundle = makeBundle('2026-07-08', {
    data_quality_counts: { OK: 2 },
    rows: [
      { ticker: 'AVOID', data_quality: 'OK', intraday_priority_label: 'INTRADAY_AVOID', intraday_confirmation_label: 'INTRADAY_CONFIRM' },
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  });

  const report = lib.buildPolicyReport(bundle, null);
  assert.equal(report.policy_status, 'WARN');
  // AVOID with OK data quality -> WATCH_NEXT_SESSION with UNCHANGED fallback
  assert.ok(report.tickers_by_decision['WATCH_NEXT_SESSION'].includes('AVOID'));
  assert.equal(report.tickers_by_fallback_action['UNCHANGED'].includes('AVOID'), true);
});

test('decision_counts tracks all decisions', () => {
  const bundle = makeBundle('2026-07-08', {
    data_quality_counts: { OK: 1, NO_INTRADAY_DATA: 1, INCOMPLETE_INTRADAY: 1 },
    no_intraday_data_tickers: ['BRAM'],
    incomplete_intraday_tickers: ['BBSI'],
    rows: [
      { ticker: 'BRAM', data_quality: 'NO_INTRADAY_DATA', intraday_priority_label: 'INTRADAY_UNKNOWN', intraday_confirmation_label: 'INTRADAY_UNKNOWN' },
      { ticker: 'BBSI', data_quality: 'INCOMPLETE_INTRADAY', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' },
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  });

  const report = lib.buildPolicyReport(bundle, null);
  assert.equal(report.decision_counts['BLOCK_PRODUCTION_ENABLE'], 1);
  assert.equal(report.decision_counts['EXCLUDE_INTRADAY_ADJUSTMENT'], 1);
  assert.equal(report.decision_counts['OK_FOR_INTRADAY_DRY_RUN'], 1);
});

test('NO_INTRADAY_DATA ticker appears in BLOCK_PRODUCTION_ENABLE and DAILY_SCORE_ONLY fallback', () => {
  const bundle = makeBundle('2026-07-08', {
    data_quality_counts: { OK: 1, NO_INTRADAY_DATA: 1 },
    no_intraday_data_tickers: ['BRAM'],
    rows: [
      { ticker: 'BRAM', data_quality: 'NO_INTRADAY_DATA', intraday_priority_label: 'INTRADAY_UNKNOWN', intraday_confirmation_label: 'INTRADAY_UNKNOWN' },
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  });

  const report = lib.buildPolicyReport(bundle, null);
  assert.equal(report.policy_status, 'BLOCK');
  assert.ok(report.tickers_by_decision['BLOCK_PRODUCTION_ENABLE'].includes('BRAM'));
  assert.ok(report.tickers_by_fallback_action['DAILY_SCORE_ONLY'].includes('BRAM'));
  assert.equal(report.fallback_action_counts['DAILY_SCORE_ONLY'], 1);
});

test('INCOMPLETE_INTRADAY ticker appears in EXCLUDE_INTRADAY_ADJUSTMENT and DAILY_SCORE_ONLY fallback', () => {
  const bundle = makeBundle('2026-07-08', {
    data_quality_counts: { OK: 1, INCOMPLETE_INTRADAY: 1 },
    incomplete_intraday_tickers: ['BBSI'],
    rows: [
      { ticker: 'BBSI', data_quality: 'INCOMPLETE_INTRADAY', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' },
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  });

  const report = lib.buildPolicyReport(bundle, null);
  assert.equal(report.policy_status, 'WARN');
  assert.ok(report.tickers_by_decision['EXCLUDE_INTRADAY_ADJUSTMENT'].includes('BBSI'));
  assert.ok(report.tickers_by_fallback_action['DAILY_SCORE_ONLY'].includes('BBSI'));
  assert.equal(report.fallback_action_counts['DAILY_SCORE_ONLY'], 1);
});

test('OK data-quality ticker with CAUTION has UNCHANGED fallback (still OK for intraday)', () => {
  const bundle = makeBundle('2026-07-08', {
    data_quality_counts: { OK: 2 },
    rows: [
      { ticker: 'CAUT', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CAUTION' },
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  });

  const report = lib.buildPolicyReport(bundle, null);
  // Should be WARN because there's a WATCH_NEXT_SESSION ticker now
  assert.equal(report.policy_status, 'WARN');
  // CAUT ticker in WATCH_NEXT_SESSION with UNCHANGED fallback (still OK for intraday)
  assert.ok(report.tickers_by_decision['WATCH_NEXT_SESSION'].includes('CAUT'));
  assert.equal(report.tickers_by_fallback_action['UNCHANGED'].includes('CAUT'), true);
});

test('OK_FOR_INTRADAY_DRY_RUN ticker has UNCHANGED fallback', () => {
  const bundle = makeBundle('2026-07-08', {
    data_quality_counts: { OK: 2 },
    rows: [
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' },
      { ticker: 'BBB', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  });

  const report = lib.buildPolicyReport(bundle, null);
  assert.ok(report.tickers_by_fallback_action['UNCHANGED'].includes('AAA'));
  assert.ok(report.tickers_by_fallback_action['UNCHANGED'].includes('BBB'));
  assert.equal(report.fallback_action_counts['UNCHANGED'], 2);
});

test('recurring incomplete_intraday triggers WARN', () => {
  const bundle = makeBundle('2026-07-08', {
    data_quality_counts: { OK: 1 },
    rows: [
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  });

  const aggregate = makeAggregate('2026-07-08', {
    aggregate_status: 'PASS',
    incomplete_intraday_tickers: [{ ticker: 'AMFG', count: 2 }]
  });

  const report = lib.buildPolicyReport(bundle, aggregate);
  assert.equal(report.policy_status, 'WARN');
  assert.ok(report.warn_reasons.includes('EXCLUDE_INTRADAY_ADJUSTMENT ticker exists'));
});

test('recurring intraday_unknown triggers BLOCK', () => {
  const bundle = makeBundle('2026-07-08', {
    data_quality_counts: { OK: 1 },
    rows: [
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  });

  const aggregate = makeAggregate('2026-07-08', {
    aggregate_status: 'PASS',
    intraday_unknown_tickers: [{ ticker: 'UNKN', count: 2 }]
  });

  const report = lib.buildPolicyReport(bundle, aggregate);
  assert.equal(report.policy_status, 'BLOCK');
  assert.ok(report.block_reasons.includes('recurring INTRADAY_UNKNOWN ticker exists'));
});

test('markdown includes policy_status, recommendation, tickers by decision, and read-only confirmation', () => {
  const bundle = makeBundle('2026-07-08', {
    data_quality_counts: { OK: 2 },
    rows: [
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' },
      { ticker: 'BBB', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  });

  const report = lib.buildPolicyReport(bundle, null);
  const md = lib.markdownReport(report);

  assert.match(md, /policy_status: \*\*PASS\*\*/);
  assert.match(md, /recommendation:/);
  assert.match(md, /## Tickers by Decision/);
  assert.match(md, /## Read-only Confirmation/);
  assert.match(md, /does NOT enable DAYTRADE_INTRADAY_SCORE_ENABLED/);
});

test('markdown includes DAILY_SCORE_ONLY section', () => {
  const bundle = makeBundle('2026-07-08', {
    data_quality_counts: { OK: 1, NO_INTRADAY_DATA: 1 },
    no_intraday_data_tickers: ['BRAM'],
    rows: [
      { ticker: 'BRAM', data_quality: 'NO_INTRADAY_DATA', intraday_priority_label: 'INTRADAY_UNKNOWN', intraday_confirmation_label: 'INTRADAY_UNKNOWN' },
      { ticker: 'AAA', data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM' }
    ]
  });

  const report = lib.buildPolicyReport(bundle, null);
  const md = lib.markdownReport(report);

  assert.match(md, /## DAILY_SCORE_ONLY/);
  assert.match(md, /should use daily score only/);
  assert.ok(md.includes('BRAM'));
});

test('CLI argument parsing', () => {
  const parse = lib.parseArgs;

  const args1 = parse(['node', 'script', '--json']);
  assert.equal(args1.writeJson, true);

  const args2 = parse(['node', 'script', '--reports-dir', '/custom/path']);
  assert.equal(args2.reportsDir, '/custom/path');

  const args3 = parse(['node', 'script', '--bundle-file', '/path/to/bundle.json']);
  assert.equal(args3.bundleFile, '/path/to/bundle.json');

  const args4 = parse(['node', 'script', '--aggregate-file', '/path/to/agg.json', '--json']);
  assert.equal(args4.aggregateFile, '/path/to/agg.json');
  assert.equal(args4.writeJson, true);
});

test('POLICY_DECISIONS contains all expected decisions', () => {
  assert.ok(lib.POLICY_DECISIONS.BLOCK_PRODUCTION_ENABLE);
  assert.ok(lib.POLICY_DECISIONS.EXCLUDE_INTRADAY_ADJUSTMENT);
  assert.ok(lib.POLICY_DECISIONS.DAILY_SCORE_ONLY);
  assert.ok(lib.POLICY_DECISIONS.WATCH_NEXT_SESSION);
  assert.ok(lib.POLICY_DECISIONS.OK_FOR_INTRADAY_DRY_RUN);

  assert.equal(lib.POLICY_DECISIONS.BLOCK_PRODUCTION_ENABLE.scoring_impact, 'BLOCKED');
  assert.equal(lib.POLICY_DECISIONS.EXCLUDE_INTRADAY_ADJUSTMENT.scoring_impact, 'DAILY_ONLY');
  assert.equal(lib.POLICY_DECISIONS.OK_FOR_INTRADAY_DRY_RUN.scoring_impact, 'UNCHANGED');
});

test('loadInputs throws when no bundle found', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-empty-'));
  await assert.rejects(() => lib.loadInputs({ reportsDir: dir }), /No validation bundle found/);
});

test('loadInputs loads bundle and optional aggregate', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-load-'));
  // Write bundle file with correct prefix
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-bundle-2026-07-08.json'), JSON.stringify(makeBundle('2026-07-08')));
  // Write aggregate file with correct prefix
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-aggregate-2026-07-08.json'), JSON.stringify(makeAggregate('2026-07-08')));

  const { bundle, aggregate } = await lib.loadInputs({ reportsDir: dir });
  assert.equal(bundle.date, '2026-07-08');
  assert.equal(aggregate.date, '2026-07-08');
});

test('writeReports creates markdown file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-write-'));
  const bundle = makeBundle('2026-07-08');
  const report = lib.buildPolicyReport(bundle, null);
  const paths = await lib.writeReports(report, { reportsDir: dir });

  assert.equal(paths.markdown.endsWith('.md'), true);
  const content = await fs.readFile(paths.markdown, 'utf8');
  assert.match(content, /^# Day Trade Intraday Policy Report/);
});

test('writeReports creates json file when requested', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-write-json-'));
  const bundle = makeBundle('2026-07-08');
  const report = lib.buildPolicyReport(bundle, null);
  const paths = await lib.writeReports(report, { reportsDir: dir, writeJson: true });

  assert.ok(paths.json);
  const content = JSON.parse(await fs.readFile(paths.json, 'utf8'));
  assert.equal(content.date, '2026-07-08');
  assert.equal(content.policy_status, 'PASS');
});

test('decidePolicy returns correct decision for each case', () => {
  // NO_INTRADAY_DATA via data_quality on bundle level
  let result = lib.decidePolicy('BRAM', { data_quality: 'NO_INTRADAY_DATA', rows: [] }, {});
  assert.equal(result.decision, 'BLOCK_PRODUCTION_ENABLE');

  // INTRADAY_UNKNOWN via bundle-level labels (no matching row)
  result = lib.decidePolicy('IDPR', { data_quality: 'OK', intraday_priority_label: 'INTRADAY_UNKNOWN', rows: [{ ticker: 'OTHER', data_quality: 'OK' }] }, {});
  assert.equal(result.decision, 'BLOCK_PRODUCTION_ENABLE');

  // INCOMPLETE_INTRADAY
  result = lib.decidePolicy('BBSI', { data_quality: 'INCOMPLETE_INTRADAY', rows: [] }, {});
  assert.equal(result.decision, 'EXCLUDE_INTRADAY_ADJUSTMENT');

  // OK with no issues
  result = lib.decidePolicy('AAA', { data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CONFIRM', rows: [] }, {});
  assert.equal(result.decision, 'OK_FOR_INTRADAY_DRY_RUN');

  // OK with CAUTION
  result = lib.decidePolicy('CAUT', { data_quality: 'OK', intraday_priority_label: 'INTRADAY_OK', intraday_confirmation_label: 'INTRADAY_CAUTION', rows: [] }, {});
  assert.equal(result.decision, 'WATCH_NEXT_SESSION');
});