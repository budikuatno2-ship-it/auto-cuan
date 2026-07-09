'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const gate = require('../lib/daytrade-intraday-dry-run-gate');

// Helper to create mock bundle
function mockBundle(date, overrides = {}) {
  return {
    date,
    validation_status: overrides.validation_status || 'PASS',
    provider_matched_count: overrides.provider_matched_count ?? 15,
    provider_missing_count: overrides.provider_missing_count ?? 0,
    data_quality_counts: overrides.data_quality_counts || { OK: 10, NO_INTRADAY_DATA: 0, INCOMPLETE_INTRADAY: 0 },
    priority_label_counts: overrides.priority_label_counts || { INTRADAY_OK: 10 },
    confirmation_label_counts: overrides.confirmation_label_counts || { INTRADAY_CONFIRM: 10 },
    ...overrides
  };
}

// Helper to create mock aggregate
function mockAggregate(date, overrides = {}) {
  return {
    date,
    aggregate_status: overrides.aggregate_status || 'PASS',
    sample_count: overrides.sample_count ?? 10,
    metrics: overrides.metrics || {
      average_provider_matched_count: 15,
      total_provider_missing_count: 0,
      top5_churn_ratio: 0.1,
      avg_absolute_score_delta: 2.5
    },
    repeated_no_intraday_data_tickers: overrides.repeated_no_intraday_data_tickers || [],
    repeated_incomplete_intraday_tickers: overrides.repeated_incomplete_intraday_tickers || [],
    repeated_intraday_unknown_tickers: overrides.repeated_intraday_unknown_tickers || [],
    ...overrides
  };
}

// Helper to create mock policy
function mockPolicy(date, overrides = {}) {
  return {
    date,
    policy_status: overrides.policy_status || 'PASS',
    decision_counts: overrides.decision_counts || { OK_FOR_INTRADAY_DRY_RUN: 10 },
    fallback_action_counts: overrides.fallback_action_counts || { UNCHANGED: 10 },
    watch_next_session_tickers: overrides.watch_next_session_tickers || [],
    ok_for_intraday_dry_run_tickers: overrides.ok_for_intraday_dry_run_tickers || ['AAA', 'BBB', 'CCC'],
    ...overrides
  };
}

test('BLOCK when policy file missing', () => {
  const bundle = mockBundle('2026-07-08');
  const aggregate = mockAggregate('2026-07-08');
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [{ name: 'bundle', date: '2026-07-08' }, { name: 'aggregate', date: '2026-07-08' }] };
  
  const result = gate.evaluateGate(bundle, aggregate, null, dateAlignment);
  
  assert.equal(result.gateStatus, 'BLOCK');
  assert.ok(result.blockReasons.includes('policy file missing'));
});

test('BLOCK when date mismatch', () => {
  const bundle = mockBundle('2026-07-08');
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-09'); // Different date
  const dateAlignment = { aligned: false, date: null, dates: [{ name: 'bundle', date: '2026-07-08' }, { name: 'aggregate', date: '2026-07-08' }, { name: 'policy', date: '2026-07-09' }], uniqueDates: ['2026-07-08', '2026-07-09'] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'BLOCK');
  assert.ok(result.blockReasons.some(r => r.includes('report date mismatch')));
});

test('BLOCK when bundle validation_status BLOCK', () => {
  const bundle = mockBundle('2026-07-08', { validation_status: 'BLOCK' });
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-08');
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'BLOCK');
  assert.ok(result.blockReasons.includes('validation bundle validation_status is BLOCK'));
});

test('BLOCK when policy_status BLOCK', () => {
  const bundle = mockBundle('2026-07-08');
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-08', { policy_status: 'BLOCK' });
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'BLOCK');
  assert.ok(result.blockReasons.includes('policy policy_status is BLOCK'));
});

test('BLOCK when provider_missing_count > 0', () => {
  const bundle = mockBundle('2026-07-08', { provider_missing_count: 3 });
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-08');
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'BLOCK');
  assert.ok(result.blockReasons.some(r => r.includes('provider_missing_count') && r.includes('> 0')));
});

test('BLOCK when NO_INTRADAY_DATA exists', () => {
  const bundle = mockBundle('2026-07-08', { data_quality_counts: { NO_INTRADAY_DATA: 2, OK: 10 } });
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-08');
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'BLOCK');
  assert.ok(result.blockReasons.some(r => r.includes('NO_INTRADAY_DATA')));
});

test('BLOCK when INCOMPLETE_INTRADAY exists', () => {
  const bundle = mockBundle('2026-07-08', { data_quality_counts: { INCOMPLETE_INTRADAY: 2, OK: 10 } });
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-08');
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'BLOCK');
  assert.ok(result.blockReasons.some(r => r.includes('INCOMPLETE_INTRADAY')));
});

test('BLOCK when INTRADAY_UNKNOWN in priority labels', () => {
  const bundle = mockBundle('2026-07-08', { priority_label_counts: { INTRADAY_UNKNOWN: 2, INTRADAY_OK: 10 } });
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-08');
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'BLOCK');
  assert.ok(result.blockReasons.some(r => r.includes('priority_label_counts.INTRADAY_UNKNOWN')));
});

test('BLOCK when INTRADAY_UNKNOWN in confirmation labels', () => {
  const bundle = mockBundle('2026-07-08', { confirmation_label_counts: { INTRADAY_UNKNOWN: 2, INTRADAY_CONFIRM: 10 } });
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-08');
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'BLOCK');
  assert.ok(result.blockReasons.some(r => r.includes('confirmation_label_counts.INTRADAY_UNKNOWN')));
});

test('BLOCK when DAILY_SCORE_ONLY exists', () => {
  const bundle = mockBundle('2026-07-08');
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-08', { fallback_action_counts: { DAILY_SCORE_ONLY: 2, UNCHANGED: 10 } });
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'BLOCK');
  assert.ok(result.blockReasons.includes('policy fallback_action_counts.DAILY_SCORE_ONLY > 0'));
});

test('BLOCK when recurring no_intraday_data exists', () => {
  const bundle = mockBundle('2026-07-08');
  const aggregate = mockAggregate('2026-07-08', { repeated_no_intraday_data_tickers: ['AAA', 'BBB'] });
  const policy = mockPolicy('2026-07-08');
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'BLOCK');
  assert.ok(result.blockReasons.includes('recurring no_intraday_data exists in aggregate'));
});

test('BLOCK when recurring intraday_unknown exists', () => {
  const bundle = mockBundle('2026-07-08');
  const aggregate = mockAggregate('2026-07-08', { repeated_intraday_unknown_tickers: ['CCC'] });
  const policy = mockPolicy('2026-07-08');
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'BLOCK');
  assert.ok(result.blockReasons.includes('recurring intraday_unknown exists in aggregate'));
});


test('BLOCK when recurring incomplete_intraday exists', () => {
  const bundle = mockBundle('2026-07-08');
  const aggregate = mockAggregate('2026-07-08', { repeated_incomplete_intraday_tickers: ['BBSI'] });
  const policy = mockPolicy('2026-07-08');
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };

  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);

  assert.equal(result.gateStatus, 'BLOCK');
  assert.ok(result.blockReasons.includes('recurring incomplete_intraday exists in aggregate'));
});

test('WARN when aggregate missing but bundle/policy clean', () => {
  const bundle = mockBundle('2026-07-08');
  const policy = mockPolicy('2026-07-08');
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, null, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'WARN');
  assert.ok(result.warnReasons.includes('aggregate file missing'));
});

test('WARN when policy_status WARN', () => {
  const bundle = mockBundle('2026-07-08');
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-08', { policy_status: 'WARN' });
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'WARN');
  assert.ok(result.warnReasons.includes('policy policy_status is WARN'));
});

test('WARN when watch_next_session_tickers exists', () => {
  const bundle = mockBundle('2026-07-08');
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-08', { watch_next_session_tickers: ['AAA'] });
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'WARN');
  assert.ok(result.warnReasons.some(r => r.includes('watch_next_session_tickers')));
});

test('WARN when top5_churn_ratio >= 0.5', () => {
  const bundle = mockBundle('2026-07-08');
  const aggregate = mockAggregate('2026-07-08', { metrics: { top5_churn_ratio: 0.6, avg_absolute_score_delta: 2 } });
  const policy = mockPolicy('2026-07-08');
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'WARN');
  assert.ok(result.warnReasons.some(r => r.includes('top5_churn_ratio')));
});

test('WARN when avg_absolute_score_delta > 5', () => {
  const bundle = mockBundle('2026-07-08');
  const aggregate = mockAggregate('2026-07-08', { metrics: { top5_churn_ratio: 0.1, avg_absolute_score_delta: 7 } });
  const policy = mockPolicy('2026-07-08');
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'WARN');
  assert.ok(result.warnReasons.some(r => r.includes('avg_absolute_score_delta')));
});

test('WARN when sample_count < 5', () => {
  const bundle = mockBundle('2026-07-08');
  const aggregate = mockAggregate('2026-07-08', { sample_count: 3 });
  const policy = mockPolicy('2026-07-08');
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'WARN');
  assert.ok(result.warnReasons.some(r => r.includes('sample_count')));
});

test('WARN when no OK_FOR_INTRADAY_DRY_RUN tickers', () => {
  const bundle = mockBundle('2026-07-08');
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-08', { ok_for_intraday_dry_run_tickers: [] });
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'WARN');
  assert.ok(result.warnReasons.some(r => r.includes('no OK_FOR_INTRADAY_DRY_RUN')));
});

test('PASS with clean bundle, clean aggregate, clean policy, provider matched >= 10', () => {
  const bundle = mockBundle('2026-07-08', { provider_matched_count: 15, provider_missing_count: 0 });
  const aggregate = mockAggregate('2026-07-08', { sample_count: 10, metrics: { top5_churn_ratio: 0.1, avg_absolute_score_delta: 2 } });
  const policy = mockPolicy('2026-07-08', { ok_for_intraday_dry_run_tickers: ['AAA', 'BBB'] });
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'PASS');
  assert.equal(result.blockReasons.length, 0);
  assert.equal(result.warnReasons.length, 0);
});

test('BLOCK when provider_matched_count < 10', () => {
  const bundle = mockBundle('2026-07-08', { provider_matched_count: 5, provider_missing_count: 0 });
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-08');
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'BLOCK');
  assert.ok(result.blockReasons.some(r => r.includes('provider_matched_count') && r.includes('< 10')));
});

test('BLOCK when aggregate_status is BLOCK', () => {
  const bundle = mockBundle('2026-07-08');
  const aggregate = mockAggregate('2026-07-08', { aggregate_status: 'BLOCK' });
  const policy = mockPolicy('2026-07-08');
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'BLOCK');
  assert.ok(result.blockReasons.includes('aggregate aggregate_status is BLOCK'));
});

test('BLOCK when decision_counts.BLOCK_PRODUCTION_ENABLE > 0', () => {
  const bundle = mockBundle('2026-07-08');
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-08', { decision_counts: { BLOCK_PRODUCTION_ENABLE: 1, OK_FOR_INTRADAY_DRY_RUN: 10 } });
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'BLOCK');
  assert.ok(result.blockReasons.includes('policy decision_counts.BLOCK_PRODUCTION_ENABLE > 0'));
});

test('recommendation text for BLOCK', () => {
  const rec = gate.recommendationForStatus('BLOCK');
  assert.match(rec, /Do NOT enable production intraday scoring/);
  assert.match(rec, /DAYTRADE_INTRADAY_SCORE_ENABLED off/);
});

test('recommendation text for WARN', () => {
  const rec = gate.recommendationForStatus('WARN');
  assert.match(rec, /Dry-run gate has warnings/);
  assert.match(rec, /Keep production flag off/);
});

test('recommendation text for PASS', () => {
  const rec = gate.recommendationForStatus('PASS');
  assert.match(rec, /Dry-run gate passed/);
  assert.match(rec, /separate staged enable PR/);
});

test('markdown includes recommendation and read-only confirmation', () => {
  const bundle = mockBundle('2026-07-08');
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-08');
  const report = gate.buildGateReport(bundle, aggregate, policy, {});
  const md = gate.markdownReport(report);
  
  assert.match(md, /gate_status: \*\*PASS\*\*/);
  assert.match(md, /recommendation:/);
  assert.match(md, /Read-only Confirmation/);
  assert.match(md, /DAYTRADE_INTRADAY_SCORE_ENABLED/);
  assert.match(md, /OK_FOR_INTRADAY_DRY_RUN Tickers/);
  assert.match(md, /WATCH_NEXT_SESSION Tickers/);
});

test('CLI argument parsing', () => {
  const argv = ['node', 'script', '--reports-dir', 'custom/reports', '--bundle-file', 'bundle.json', '--aggregate-file', 'agg.json', '--policy-file', 'pol.json', '--json'];
  const args = gate.parseArgs(argv);
  
  assert.equal(args.reportsDir, 'custom/reports');
  assert.equal(args.bundleFile, 'bundle.json');
  assert.equal(args.aggregateFile, 'agg.json');
  assert.equal(args.policyFile, 'pol.json');
  assert.equal(args.writeJson, true);
});

test('CLI argument parsing without optional args', () => {
  const argv = ['node', 'script'];
  const args = gate.parseArgs(argv);
  
  assert.equal(args.reportsDir, gate.DEFAULT_REPORTS_DIR);
  assert.equal(args.bundleFile, null);
  assert.equal(args.aggregateFile, null);
  assert.equal(args.policyFile, null);
  assert.equal(args.writeJson, false);
});

test('date alignment check', () => {
  const bundle = { date: '2026-07-08', _file: '/path/bundle-2026-07-08.json' };
  const aggregate = { date: '2026-07-08', _file: '/path/aggregate-2026-07-08.json' };
  const policy = { date: '2026-07-08', _file: '/path/policy-2026-07-08.json' };
  
  const result = gate.checkDateAlignment(bundle, aggregate, policy);
  
  assert.equal(result.aligned, true);
  assert.equal(result.date, '2026-07-08');
});

test('date alignment check - mismatch', () => {
  const bundle = { date: '2026-07-08' };
  const aggregate = { date: '2026-07-09' };
  const policy = { date: '2026-07-08' };
  
  const result = gate.checkDateAlignment(bundle, aggregate, policy);
  
  assert.equal(result.aligned, false);
  assert.ok(result.uniqueDates.includes('2026-07-08'));
  assert.ok(result.uniqueDates.includes('2026-07-09'));
});

test('no Supabase writes/API/SQL/UI/cron/AI changes', async () => {
  const source = await fs.readFile(path.join(process.cwd(), 'lib', 'daytrade-intraday-dry-run-gate.js'), 'utf8');
  assert.doesNotMatch(source, /send_radar|telegram\.send|supabase\.from\([^)]*\)\.insert|\.upsert\(|\.update\(/i);
  const toolSource = await fs.readFile(path.join(process.cwd(), 'tools', 'report-daytrade-intraday-dry-run-gate.js'), 'utf8');
  assert.doesNotMatch(toolSource, /send_radar|telegram\.send|supabase\.from\([^)]*\)\.insert|\.upsert\(|\.update\(/i);
  const executableSource = source.replace(/read_only_confirmation: '[^']*'/g, 'read_only_confirmation');
  const toolExecutableSource = toolSource.replace(/read_only_confirmation: '[^']*'/g, 'read_only_confirmation');
  assert.doesNotMatch(executableSource, /api\/|migrations|CREATE\s+TABLE|ALTER\s+TABLE|dashboard|cron/i);
  assert.doesNotMatch(toolExecutableSource, /api\/|migrations|CREATE\s+TABLE|ALTER\s+TABLE|dashboard|cron/i);
});

test('WARN when EXCLUDE_INTRADAY_ADJUSTMENT exists', () => {
  const bundle = mockBundle('2026-07-08');
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-08', { decision_counts: { EXCLUDE_INTRADAY_ADJUSTMENT: 2, OK_FOR_INTRADAY_DRY_RUN: 10 } });
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'WARN');
  assert.ok(result.warnReasons.some(r => r.includes('EXCLUDE_INTRADAY_ADJUSTMENT')));
});

test('WARN when aggregate_status is WARN', () => {
  const bundle = mockBundle('2026-07-08');
  const aggregate = mockAggregate('2026-07-08', { aggregate_status: 'WARN' });
  const policy = mockPolicy('2026-07-08');
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'WARN');
  assert.ok(result.warnReasons.includes('aggregate aggregate_status is WARN'));
});

test('BLOCK when bundle missing', () => {
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-08');
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [{ name: 'aggregate', date: '2026-07-08' }, { name: 'policy', date: '2026-07-08' }] };
  
  const result = gate.evaluateGate(null, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'BLOCK');
  assert.ok(result.blockReasons.includes('bundle file missing'));
});

test('PASS when all dates aligned and clean', () => {
  const bundle = mockBundle('2026-07-08', { 
    provider_matched_count: 12, 
    provider_missing_count: 0,
    data_quality_counts: { OK: 12 }
  });
  const aggregate = mockAggregate('2026-07-08', { 
    sample_count: 7,
    metrics: { top5_churn_ratio: 0.2, avg_absolute_score_delta: 3 },
    repeated_no_intraday_data_tickers: [],
    repeated_intraday_unknown_tickers: []
  });
  const policy = mockPolicy('2026-07-08', { 
    ok_for_intraday_dry_run_tickers: ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'],
    decision_counts: { OK_FOR_INTRADAY_DRY_RUN: 5 },
    fallback_action_counts: { UNCHANGED: 5 },
    watch_next_session_tickers: []
  });
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };
  
  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  
  assert.equal(result.gateStatus, 'PASS');
});
test('BLOCK when policy coverage is INCOMPLETE and markdown includes policy coverage summary', () => {
  const bundle = mockBundle('2026-07-08', { rows: Array.from({ length: 16 }, (_, i) => ({ ticker: `T${i}` })) });
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-08', { coverage_status: 'INCOMPLETE', policy_evaluated_count: 4, bundle_candidate_count: 16, total_tickers_evaluated: 4 });
  const report = gate.buildGateReport(bundle, aggregate, policy, { nowMs: Date.UTC(2026, 6, 8) });
  assert.equal(report.gate_status, 'BLOCK');
  assert.ok(report.block_reasons.includes('policy coverage incomplete: evaluated 4/16 candidates'));
  const md = gate.markdownReport(report);
  assert.match(md, /evaluated_count: 4/);
  assert.match(md, /bundle_candidate_count: 16/);
  assert.match(md, /coverage_status: INCOMPLETE/);
});

test('PASS scenario requires coverage_status OK', () => {
  const bundle = mockBundle('2026-07-08', { rows: Array.from({ length: 3 }, (_, i) => ({ ticker: `T${i}` })) });
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-08', { coverage_status: 'OK', policy_evaluated_count: 3, bundle_candidate_count: 3, total_tickers_evaluated: 3 });
  const result = gate.evaluateGate(bundle, aggregate, policy, { aligned: true, date: '2026-07-08', dates: [] });
  assert.equal(result.gateStatus, 'PASS');
});

test('markdown renders recurring incomplete_intraday object as ticker count text', () => {
  const report = gate.buildGateReport(
    mockBundle('2026-07-08'),
    mockAggregate('2026-07-08', { repeated_incomplete_intraday_tickers: [{ ticker: 'BBSI', count: 3 }] }),
    mockPolicy('2026-07-08'),
    { nowMs: Date.UTC(2026, 6, 8) }
  );
  const md = gate.markdownReport(report);
  assert.ok(md.includes('- no_intraday_data: none'));
  assert.ok(md.includes('- incomplete_intraday: BBSI (3)'));
  assert.ok(md.includes('- intraday_unknown: none'));
  assert.ok(!md.includes('[object Object]'));
});

test('formatSummaryItem supports string, ticker/key/value count objects', () => {
  assert.equal(gate.formatSummaryItem('BBSI'), 'BBSI');
  assert.equal(gate.formatSummaryItem({ ticker: 'BBSI', count: 3 }), 'BBSI (3)');
  assert.equal(gate.formatSummaryItem({ key: 'BRAM', count: 2 }), 'BRAM (2)');
  assert.equal(gate.formatSummaryItem({ value: 'IDPR', count: 4 }), 'IDPR (4)');
});

test('PASS_WITH_QUARANTINE when only explicit quarantine blockers remain', () => {
  const bundle = mockBundle('2026-07-08', {
    validation_status: 'PASS',
    provider_missing_count: 2,
    data_quality_counts: { NO_INTRADAY_DATA: 2, INCOMPLETE_INTRADAY: 0, OK: 10 },
    priority_label_counts: { INTRADAY_UNKNOWN: 2, INTRADAY_OK: 10 },
    confirmation_label_counts: { INTRADAY_UNKNOWN: 2, INTRADAY_CONFIRM: 10 },
    non_quarantined_provider_missing_count: 0,
    non_quarantined_incomplete_intraday_count: 0,
    non_quarantined_intraday_unknown_count: 0,
    intraday_quarantine_count: 2,
    intraday_quarantine_tickers: [
      { ticker: 'BBSI', quarantine_reason: 'REPEATED_INTRADAY_BLOCKER count=3 threshold=2', quarantine_action: 'DAILY_SCORE_ONLY' },
      { ticker: 'SDPC', quarantine_reason: 'REPEATED_INTRADAY_BLOCKER count=2 threshold=2', quarantine_action: 'DAILY_SCORE_ONLY' }
    ]
  });
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-08', { fallback_action_counts: { DAILY_SCORE_ONLY: 2, UNCHANGED: 10 } });
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };

  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  assert.equal(result.gateStatus, 'PASS_WITH_QUARANTINE');
  assert.ok(result.warnReasons.some((r) => r.includes('PASS_WITH_QUARANTINE')));
  assert.equal(result.blockReasons.length, 0);

  const report = gate.buildGateReport(bundle, aggregate, policy, { nowMs: Date.UTC(2026, 6, 9) });
  assert.equal(report.gate_status, 'PASS_WITH_QUARANTINE');
  assert.equal(report.provider_metrics.non_quarantined_provider_missing_count, 0);
  assert.equal(report.data_quality_summary.intraday_quarantine_count, 2);
  assert.match(report.recommendation, /Keep DAYTRADE_INTRADAY_SCORE_ENABLED off/);
  assert.match(gate.markdownReport(report), /intraday_quarantine_tickers/);
});

test('non-quarantined blockers still BLOCK dry-run gate', () => {
  const bundle = mockBundle('2026-07-08', {
    provider_missing_count: 2,
    data_quality_counts: { NO_INTRADAY_DATA: 2, OK: 10 },
    non_quarantined_provider_missing_count: 1,
    intraday_quarantine_count: 1,
    intraday_quarantine_tickers: [{ ticker: 'BBSI', quarantine_action: 'DAILY_SCORE_ONLY' }]
  });
  const aggregate = mockAggregate('2026-07-08');
  const policy = mockPolicy('2026-07-08');
  const dateAlignment = { aligned: true, date: '2026-07-08', dates: [] };

  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment);
  assert.equal(result.gateStatus, 'BLOCK');
  assert.ok(result.blockReasons.some((r) => r.includes('non_quarantined_provider_missing_count')));
});

function mockProviderCacheQuality(date, overrides = {}) {
  return {
    date,
    quality_status: overrides.quality_status || 'PASS_WITH_QUARANTINE',
    provider_missing_count: overrides.provider_missing_count ?? 3,
    total_provider_missing_count: overrides.total_provider_missing_count ?? 3,
    visible_provider_missing_count: overrides.visible_provider_missing_count ?? 3,
    quarantined_provider_missing_count: overrides.quarantined_provider_missing_count ?? 3,
    non_quarantined_provider_missing_count: overrides.non_quarantined_provider_missing_count ?? 0,
    non_quarantined_incomplete_intraday_count: overrides.non_quarantined_incomplete_intraday_count ?? 0,
    non_quarantined_intraday_unknown_count: overrides.non_quarantined_intraday_unknown_count ?? 0,
    intraday_quarantine_count: overrides.intraday_quarantine_count ?? 3,
    intraday_quarantine_tickers: overrides.intraday_quarantine_tickers || [
      { ticker: 'BBSI', quarantine_action: 'DAILY_SCORE_ONLY' },
      { ticker: 'SDPC', quarantine_action: 'DAILY_SCORE_ONLY' },
      { ticker: 'TCID', quarantine_action: 'DAILY_SCORE_ONLY' }
    ],
    ...overrides
  };
}

test('PASS_WITH_QUARANTINE uses local provider/cache quality report as supplemental quarantine context', () => {
  const bundle = mockBundle('2026-07-09', {
    provider_missing_count: 3,
    data_quality_counts: { NO_INTRADAY_DATA: 3, INCOMPLETE_INTRADAY: 3, OK: 10 },
    priority_label_counts: { INTRADAY_UNKNOWN: 3, INTRADAY_OK: 10 },
    confirmation_label_counts: { INTRADAY_UNKNOWN: 3, INTRADAY_CONFIRM: 10 }
  });
  const aggregate = mockAggregate('2026-07-09', {
    repeated_no_intraday_data_tickers: ['BBSI', 'SDPC', 'TCID'],
    repeated_incomplete_intraday_tickers: ['BBSI', 'SDPC', 'TCID'],
    repeated_intraday_unknown_tickers: ['BBSI', 'SDPC', 'TCID']
  });
  const policy = mockPolicy('2026-07-09', { fallback_action_counts: { DAILY_SCORE_ONLY: 3, UNCHANGED: 10 } });
  const providerCacheQuality = mockProviderCacheQuality('2026-07-09');
  const dateAlignment = gate.checkDateAlignment(bundle, aggregate, policy, providerCacheQuality);

  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment, providerCacheQuality);
  assert.equal(result.gateStatus, 'PASS_WITH_QUARANTINE');
  assert.equal(result.blockReasons.length, 0);

  const report = gate.buildGateReport(bundle, aggregate, policy, { providerCacheQuality, nowMs: Date.UTC(2026, 6, 9) });
  assert.equal(report.gate_status, 'PASS_WITH_QUARANTINE');
  assert.deepEqual(report.quarantine_summary, {
    provider_cache_quality_status: 'PASS_WITH_QUARANTINE',
    intraday_quarantine_count: 3,
    intraday_quarantine_tickers: providerCacheQuality.intraday_quarantine_tickers,
    total_provider_missing_count: 3,
    visible_provider_missing_count: 3,
    quarantined_provider_missing_count: 3,
    non_quarantined_provider_missing_count: 0,
    non_quarantined_incomplete_intraday_count: 0,
    non_quarantined_intraday_unknown_count: 0
  });
  assert.equal(report.provider_metrics.provider_missing_count, 3);
  assert.equal(report.provider_metrics.non_quarantined_provider_missing_count, 0);
  assert.equal(report.data_quality_summary.non_quarantined_incomplete_intraday_count, 0);
  assert.equal(report.data_quality_summary.non_quarantined_intraday_unknown_count, 0);
  assert.match(report.recommendation, /Keep DAYTRADE_INTRADAY_SCORE_ENABLED off/);

  const md = gate.markdownReport(report);
  assert.match(md, /Quarantine Summary/);
  assert.match(md, /provider_cache_quality_status: PASS_WITH_QUARANTINE/);
  assert.match(md, /total_provider_missing_count: 3/);
  assert.match(md, /non_quarantined_provider_missing_count: 0/);
});

test('provider/cache quality missing keeps conservative BLOCK for bundle provider/cache blockers', () => {
  const bundle = mockBundle('2026-07-09', {
    provider_missing_count: 3,
    data_quality_counts: { NO_INTRADAY_DATA: 3, INCOMPLETE_INTRADAY: 3, OK: 10 },
    priority_label_counts: { INTRADAY_UNKNOWN: 3, INTRADAY_OK: 10 },
    confirmation_label_counts: { INTRADAY_UNKNOWN: 3, INTRADAY_CONFIRM: 10 }
  });
  const aggregate = mockAggregate('2026-07-09');
  const policy = mockPolicy('2026-07-09');
  const report = gate.buildGateReport(bundle, aggregate, policy, { nowMs: Date.UTC(2026, 6, 9) });

  assert.equal(report.gate_status, 'BLOCK');
  assert.equal(report.quarantine_summary, null);
  assert.ok(report.block_reasons.some((r) => r.includes('non_quarantined_provider_missing_count')));
});

test('non-quarantined provider/cache quality blocker keeps BLOCK', () => {
  const bundle = mockBundle('2026-07-09', { provider_missing_count: 3 });
  const aggregate = mockAggregate('2026-07-09');
  const policy = mockPolicy('2026-07-09');
  const providerCacheQuality = mockProviderCacheQuality('2026-07-09', { non_quarantined_provider_missing_count: 1 });
  const dateAlignment = gate.checkDateAlignment(bundle, aggregate, policy, providerCacheQuality);

  const result = gate.evaluateGate(bundle, aggregate, policy, dateAlignment, providerCacheQuality);
  assert.equal(result.gateStatus, 'BLOCK');
  assert.ok(result.blockReasons.some((r) => r.includes('non_quarantined_provider_missing_count')));
});

test('run loads latest provider/cache quality JSON from reports directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dry-run-gate-quality-'));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-bundle-2026-07-09.json'), JSON.stringify(mockBundle('2026-07-09', {
    provider_missing_count: 3,
    data_quality_counts: { NO_INTRADAY_DATA: 3, INCOMPLETE_INTRADAY: 3, OK: 10 },
    priority_label_counts: { INTRADAY_UNKNOWN: 3, INTRADAY_OK: 10 },
    confirmation_label_counts: { INTRADAY_UNKNOWN: 3, INTRADAY_CONFIRM: 10 }
  })));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-aggregate-2026-07-09.json'), JSON.stringify(mockAggregate('2026-07-09', {
    repeated_no_intraday_data_tickers: ['BBSI', 'SDPC', 'TCID'],
    repeated_incomplete_intraday_tickers: ['BBSI', 'SDPC', 'TCID'],
    repeated_intraday_unknown_tickers: ['BBSI', 'SDPC', 'TCID']
  })));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-policy-2026-07-09.json'), JSON.stringify(mockPolicy('2026-07-09', { fallback_action_counts: { DAILY_SCORE_ONLY: 3, UNCHANGED: 10 } })));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-provider-cache-quality-2026-07-09.json'), JSON.stringify(mockProviderCacheQuality('2026-07-09')));

  const { report, paths } = await gate.run({ reportsDir: dir, writeJson: true, nowMs: Date.UTC(2026, 6, 9) });
  assert.equal(report.gate_status, 'PASS_WITH_QUARANTINE');
  assert.equal(report.quarantine_summary.provider_cache_quality_status, 'PASS_WITH_QUARANTINE');
  assert.ok(report.files_used.provider_cache_quality.file.endsWith('daytrade-intraday-provider-cache-quality-2026-07-09.json'));
  assert.ok(paths.json.endsWith('daytrade-intraday-dry-run-gate-2026-07-09.json'));
});
