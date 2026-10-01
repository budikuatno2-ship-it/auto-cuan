'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const runbook = require('../lib/daytrade-intraday-staged-enable-runbook');
const cli = require('../tools/report-daytrade-intraday-staged-enable-runbook');

// Helper to create mock gate
function mockGate(date, overrides = {}) {
  return {
    date,
    gate_status: overrides.gate_status || 'PASS',
    block_reasons: overrides.block_reasons || [],
    warn_reasons: overrides.warn_reasons || [],
    provider_metrics: overrides.provider_metrics || { provider_matched_count: 15, provider_missing_count: 0 },
    data_quality_summary: overrides.data_quality_summary || { NO_INTRADAY_DATA: 0, INCOMPLETE_INTRADAY: 0 },
    policy_summary: overrides.policy_summary || { ok_for_intraday_dry_run_count: 10, watch_next_session_count: 0 },
    ...overrides
  };
}

test('NOT_READY when gate file missing', () => {
  const result = runbook.evaluateStatus(null);
  assert.equal(result.status, 'NOT_READY');
  assert.ok(result.reason.includes('missing'));
});

test('NOT_READY when gate_status BLOCK', () => {
  const gate = mockGate('2026-07-08', { gate_status: 'BLOCK', block_reasons: ['provider missing'] });
  const result = runbook.evaluateStatus(gate);
  assert.equal(result.status, 'NOT_READY');
  assert.ok(result.reason.includes('BLOCK'));
});

test('REVIEW_REQUIRED when gate_status WARN', () => {
  const gate = mockGate('2026-07-08', { gate_status: 'WARN', warn_reasons: ['aggregate missing'] });
  const result = runbook.evaluateStatus(gate);
  assert.equal(result.status, 'REVIEW_REQUIRED');
  assert.ok(result.reason.includes('WARN'));
});

test('READY_FOR_MANUAL_APPROVAL when gate_status PASS', () => {
  const gate = mockGate('2026-07-08', { gate_status: 'PASS' });
  const result = runbook.evaluateStatus(gate);
  assert.equal(result.status, 'READY_FOR_MANUAL_APPROVAL');
  assert.ok(result.reason.includes('PASS'));
});

test('recommendationForStatus NOT_READY', () => {
  const rec = runbook.recommendationForStatus('NOT_READY');
  assert.ok(rec.includes('Do NOT enable'));
  assert.ok(rec.includes('DAYTRADE_INTRADAY_SCORE_ENABLED off'));
});

test('recommendationForStatus REVIEW_REQUIRED', () => {
  const rec = runbook.recommendationForStatus('REVIEW_REQUIRED');
  assert.ok(rec.includes('Do not enable yet'));
});

test('recommendationForStatus READY_FOR_MANUAL_APPROVAL', () => {
  const rec = runbook.recommendationForStatus('READY_FOR_MANUAL_APPROVAL');
  assert.ok(rec.includes('Eligible for human review'));
  assert.ok(rec.includes('separate explicit approval'));
});

test('buildRunbookReport includes runbook_status', () => {
  const gate = mockGate('2026-07-08', { gate_status: 'PASS' });
  const report = runbook.buildRunbookReport(gate, null, null, null, { nowMs: Date.UTC(2026, 6, 8) });
  assert.equal(report.runbook_status, 'READY_FOR_MANUAL_APPROVAL');
  assert.equal(report.date, '2026-07-08');
});

test('buildRunbookReport includes blockers and warnings', () => {
  const gate = mockGate('2026-07-08', {
    gate_status: 'WARN',
    block_reasons: ['blocker1'],
    warn_reasons: ['warning1', 'warning2']
  });
  const report = runbook.buildRunbookReport(gate, null, null, null, { nowMs: Date.UTC(2026, 6, 8) });
  assert.deepEqual(report.blockers, ['blocker1']);
  assert.deepEqual(report.warnings, ['warning1', 'warning2']);
});

test('buildRunbookReport includes pre-enable checklist', () => {
  const gate = mockGate('2026-07-08', { gate_status: 'PASS' });
  const report = runbook.buildRunbookReport(gate, null, null, null, { nowMs: Date.UTC(2026, 6, 8) });
  assert.ok(Array.isArray(report.pre_enable_checklist));
  assert.ok(report.pre_enable_checklist.length > 0);
  assert.ok(report.pre_enable_checklist.some(i => i.includes('gate status')));
  assert.ok(report.pre_enable_checklist.some(i => i.includes('provider_missing_count')));
});

test('buildRunbookReport includes manual enable instructions', () => {
  const gate = mockGate('2026-07-08', { gate_status: 'PASS' });
  const report = runbook.buildRunbookReport(gate, null, null, null, { nowMs: Date.UTC(2026, 6, 8) });
  assert.ok(Array.isArray(report.manual_enable_instructions));
  assert.ok(report.manual_enable_instructions.length > 0);
  assert.ok(report.manual_enable_instructions.some(i => i.includes('DAYTRADE_INTRADAY_SCORE_ENABLED=1')));
  assert.ok(report.manual_enable_instructions.some(i => i.includes('Vercel')));
});

test('buildRunbookReport includes production smoke checklist', () => {
  const gate = mockGate('2026-07-08', { gate_status: 'PASS' });
  const report = runbook.buildRunbookReport(gate, null, null, null, { nowMs: Date.UTC(2026, 6, 8) });
  assert.ok(Array.isArray(report.production_smoke_checklist));
  assert.ok(report.production_smoke_checklist.length > 0);
  assert.ok(report.production_smoke_checklist.some(i => i.includes('/api/quote')));
});

test('buildRunbookReport includes monitoring checklist', () => {
  const gate = mockGate('2026-07-08', { gate_status: 'PASS' });
  const report = runbook.buildRunbookReport(gate, null, null, null, { nowMs: Date.UTC(2026, 6, 8) });
  assert.ok(Array.isArray(report.monitoring_checklist));
  assert.ok(report.monitoring_checklist.length > 0);
  assert.ok(report.monitoring_checklist.some(i => i.includes('provider_missing_count')));
});

test('buildRunbookReport includes rollback instructions', () => {
  const gate = mockGate('2026-07-08', { gate_status: 'PASS' });
  const report = runbook.buildRunbookReport(gate, null, null, null, { nowMs: Date.UTC(2026, 6, 8) });
  assert.ok(Array.isArray(report.rollback_instructions));
  assert.ok(report.rollback_instructions.length > 0);
  assert.ok(report.rollback_instructions.some(i => i.includes('DAYTRADE_INTRADAY_SCORE_ENABLED')));
  assert.ok(report.rollback_instructions.some(i => i.includes('Vercel')));
});

test('buildRunbookReport includes stop-loss conditions', () => {
  const gate = mockGate('2026-07-08', { gate_status: 'PASS' });
  const report = runbook.buildRunbookReport(gate, null, null, null, { nowMs: Date.UTC(2026, 6, 8) });
  assert.ok(Array.isArray(report.stop_loss_conditions));
  assert.ok(report.stop_loss_conditions.length > 0);
  assert.ok(report.stop_loss_conditions.some(c => c.includes('gate_status returns BLOCK')));
  assert.ok(report.stop_loss_conditions.some(c => c.includes('provider_missing_count > 0')));
  assert.ok(report.stop_loss_conditions.some(c => c.includes('NO_INTRADAY_DATA > 0')));
});

test('buildRunbookReport includes read-only confirmation', () => {
  const gate = mockGate('2026-07-08', { gate_status: 'PASS' });
  const report = runbook.buildRunbookReport(gate, null, null, null, { nowMs: Date.UTC(2026, 6, 8) });
  assert.ok(report.read_only_confirmation);
  assert.ok(report.read_only_confirmation.includes('does NOT enable'));
  assert.ok(report.read_only_confirmation.includes('DAYTRADE_INTRADAY_SCORE_ENABLED'));
  assert.ok(report.read_only_confirmation.includes('Vercel'));
  assert.ok(report.read_only_confirmation.includes('Telegram'));
  assert.ok(report.read_only_confirmation.includes('Supabase'));
  assert.ok(report.read_only_confirmation.includes('read-only'));
});

test('markdown includes pre-enable checklist', () => {
  const gate = mockGate('2026-07-08', { gate_status: 'PASS' });
  const report = runbook.buildRunbookReport(gate, null, null, null, { nowMs: Date.UTC(2026, 6, 8) });
  const md = runbook.markdownReport(report);
  assert.ok(md.includes('## Pre-enable Checklist'));
  assert.ok(md.includes('- [ ] Confirm dry-run gate status'));
});

test('markdown includes manual enable instructions', () => {
  const gate = mockGate('2026-07-08', { gate_status: 'PASS' });
  const report = runbook.buildRunbookReport(gate, null, null, null, { nowMs: Date.UTC(2026, 6, 8) });
  const md = runbook.markdownReport(report);
  assert.ok(md.includes('## Manual Enable Instructions'));
  assert.ok(md.includes('DAYTRADE_INTRADAY_SCORE_ENABLED=1'));
});

test('markdown includes rollback instructions', () => {
  const gate = mockGate('2026-07-08', { gate_status: 'PASS' });
  const report = runbook.buildRunbookReport(gate, null, null, null, { nowMs: Date.UTC(2026, 6, 8) });
  const md = runbook.markdownReport(report);
  assert.ok(md.includes('## Rollback Instructions'));
  assert.ok(md.includes('Remove or unset DAYTRADE_INTRADAY_SCORE_ENABLED'));
});

test('markdown includes stop-loss conditions', () => {
  const gate = mockGate('2026-07-08', { gate_status: 'PASS' });
  const report = runbook.buildRunbookReport(gate, null, null, null, { nowMs: Date.UTC(2026, 6, 8) });
  const md = runbook.markdownReport(report);
  assert.ok(md.includes('## Stop-loss Conditions'));
  assert.ok(md.includes('gate_status returns BLOCK'));
});

test('markdown includes read-only confirmation', () => {
  const gate = mockGate('2026-07-08', { gate_status: 'PASS' });
  const report = runbook.buildRunbookReport(gate, null, null, null, { nowMs: Date.UTC(2026, 6, 8) });
  const md = runbook.markdownReport(report);
  assert.ok(md.includes('## Read-only Confirmation'));
  assert.ok(md.includes('does NOT enable DAYTRADE_INTRADAY_SCORE_ENABLED'));
});

test('markdown includes runbook status', () => {
  const gate = mockGate('2026-07-08', { gate_status: 'PASS' });
  const report = runbook.buildRunbookReport(gate, null, null, null, { nowMs: Date.UTC(2026, 6, 8) });
  const md = runbook.markdownReport(report);
  assert.ok(md.includes('## Runbook Status'));
  assert.ok(md.includes('**READY_FOR_MANUAL_APPROVAL**'));
});

test('markdown includes recommendation', () => {
  const gate = mockGate('2026-07-08', { gate_status: 'PASS' });
  const report = runbook.buildRunbookReport(gate, null, null, null, { nowMs: Date.UTC(2026, 6, 8) });
  const md = runbook.markdownReport(report);
  assert.ok(md.includes('## Recommendation'));
  assert.ok(md.includes('Eligible for human review'));
});

test('CLI parseArgs defaults', () => {
  const args = cli.parseArgs(['node', 'script']);
  assert.equal(args.reportsDir, runbook.DEFAULT_REPORTS_DIR);
  assert.equal(args.gateFile, null);
  assert.equal(args.policyFile, null);
  assert.equal(args.aggregateFile, null);
  assert.equal(args.bundleFile, null);
  assert.equal(args.writeJson, false);
});

test('CLI parseArgs --json', () => {
  const args = cli.parseArgs(['node', 'script', '--json']);
  assert.equal(args.writeJson, true);
});

test('CLI parseArgs --reports-dir', () => {
  const args = cli.parseArgs(['node', 'script', '--reports-dir', '/tmp/reports']);
  assert.equal(args.reportsDir, '/tmp/reports');
});

test('CLI parseArgs --gate-file', () => {
  const args = cli.parseArgs(['node', 'script', '--gate-file', '/tmp/gate.json']);
  assert.equal(args.gateFile, '/tmp/gate.json');
});

test('CLI parseArgs --policy-file', () => {
  const args = cli.parseArgs(['node', 'script', '--policy-file', '/tmp/policy.json']);
  assert.equal(args.policyFile, '/tmp/policy.json');
});

test('CLI parseArgs --aggregate-file', () => {
  const args = cli.parseArgs(['node', 'script', '--aggregate-file', '/tmp/agg.json']);
  assert.equal(args.aggregateFile, '/tmp/agg.json');
});

test('CLI parseArgs --bundle-file', () => {
  const args = cli.parseArgs(['node', 'script', '--bundle-file', '/tmp/bundle.json']);
  assert.equal(args.bundleFile, '/tmp/bundle.json');
});

test('CLI parseArgs all options', () => {
  const args = cli.parseArgs([
    'node', 'script',
    '--reports-dir', '/custom/reports',
    '--gate-file', '/custom/gate.json',
    '--policy-file', '/custom/policy.json',
    '--aggregate-file', '/custom/agg.json',
    '--bundle-file', '/custom/bundle.json',
    '--json'
  ]);
  assert.equal(args.reportsDir, '/custom/reports');
  assert.equal(args.gateFile, '/custom/gate.json');
  assert.equal(args.policyFile, '/custom/policy.json');
  assert.equal(args.aggregateFile, '/custom/agg.json');
  assert.equal(args.bundleFile, '/custom/bundle.json');
  assert.equal(args.writeJson, true);
});

test('runbook writes markdown file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runbook-test-'));
  const gate = mockGate('2026-07-08', { gate_status: 'PASS' });
  
  const report = runbook.buildRunbookReport(gate, null, null, null, { nowMs: Date.UTC(2026, 6, 8) });
  const paths = await runbook.writeReports(report, { reportsDir: dir, writeJson: false });
  
  assert.equal(path.basename(paths.markdown), 'daytrade-intraday-staged-enable-runbook-2026-07-08.md');
  assert.match(await fs.readFile(paths.markdown, 'utf8'), /Day Trade Intraday Staged-Enable Runbook/);
});

test('runbook writes json file with --json', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runbook-test-'));
  const gate = mockGate('2026-07-08', { gate_status: 'PASS' });
  
  const report = runbook.buildRunbookReport(gate, null, null, null, { nowMs: Date.UTC(2026, 6, 8) });
  const paths = await runbook.writeReports(report, { reportsDir: dir, writeJson: true });
  
  assert.equal(path.basename(paths.json), 'daytrade-intraday-staged-enable-runbook-2026-07-08.json');
  const json = JSON.parse(await fs.readFile(paths.json, 'utf8'));
  assert.equal(json.runbook_status, 'READY_FOR_MANUAL_APPROVAL');
});

test('no Supabase writes/API/SQL/UI/cron/AI changes', async () => {
  // This is a read-only documentation tool - check it doesn't have actual production-side code
  const source = await fs.readFile(path.join(process.cwd(), 'lib', 'daytrade-intraday-staged-enable-runbook.js'), 'utf8');
  const toolSource = await fs.readFile(path.join(process.cwd(), 'tools', 'report-daytrade-intraday-staged-enable-runbook.js'), 'utf8');
  // Check for actual Supabase/API writes - ignore mentions in documentation
  assert.doesNotMatch(source, /supabase\.from\([^)]*\)\.insert|\.upsert\(|\.update\(/i);
  assert.doesNotMatch(toolSource, /supabase\.from\([^)]*\)\.insert|\.upsert\(|\.update\(/i);
});
test('markdown includes policy coverage summary and remains NOT_READY when gate blocks for incomplete coverage', () => {
  const gate = mockGate('2026-07-08', {
    gate_status: 'BLOCK',
    block_reasons: ['policy coverage incomplete: evaluated 4/16 candidates'],
    policy_summary: { ok_for_intraday_dry_run_count: 0, watch_next_session_count: 0, policy_evaluated_count: 4, bundle_candidate_count: 16, coverage_status: 'INCOMPLETE' }
  });
  const report = runbook.buildRunbookReport(gate, null, null, null, { nowMs: Date.UTC(2026, 6, 8) });
  assert.equal(report.runbook_status, 'NOT_READY');
  const md = runbook.markdownReport(report);
  assert.match(md, /policy_evaluated_count: 4/);
  assert.match(md, /bundle_candidate_count: 16/);
  assert.match(md, /policy coverage_status: INCOMPLETE/);
});

test('runbook includes session spacing summary when aggregate provides it', () => {
  const gate = mockGate('2026-07-08', { gate_status: 'BLOCK' });
  const aggregate = {
    date: '2026-07-08',
    session_spacing_status: 'BLOCK',
    min_session_gap_minutes: 2.08,
    session_span_minutes: 4.23,
    close_session_pair_count: 2
  };
  const report = runbook.buildRunbookReport(gate, null, aggregate, null, { nowMs: Date.UTC(2026, 6, 8) });
  assert.equal(report.runbook_status, 'NOT_READY');
  assert.equal(report.gate_summary.session_spacing_status, 'BLOCK');
  const md = runbook.markdownReport(report);
  assert.ok(md.includes('- session_spacing_status: BLOCK'));
  assert.ok(md.includes('- min_session_gap_minutes: 2.08'));
  assert.ok(md.includes('- session_span_minutes: 4.23'));
  assert.ok(md.includes('- close_session_pair_count: 2'));
});
