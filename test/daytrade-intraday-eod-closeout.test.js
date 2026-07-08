'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const lib = require('../lib/daytrade-intraday-eod-closeout');

function inputs(overrides) {
  overrides = overrides || {};
  return {
    bundle: Object.assign({ date: '2026-07-08', validation_status: 'PASS', provider_matched_count: 20, provider_missing_count: 0, data_quality_counts: {}, priority_label_counts: {}, confirmation_label_counts: {} }, overrides.bundle || {}),
    aggregate: Object.assign({ date: '2026-07-08', aggregate_status: 'PASS', session_spacing_status: 'OK', min_session_gap_minutes: 60, session_span_minutes: 240, block_reasons: [], repeated_no_intraday_data_tickers: [], repeated_incomplete_intraday_tickers: [], repeated_intraday_unknown_tickers: [] }, overrides.aggregate || {}),
    policy: Object.assign({ date: '2026-07-08', policy_status: 'PASS', fallback_action_counts: {}, coverage_status: 'OK' }, overrides.policy || {}),
    gate: Object.assign({ date: '2026-07-08', gate_status: 'PASS', provider_metrics: { provider_matched_count: 20, provider_missing_count: 0 }, policy_summary: { coverage_status: 'OK' }, block_reasons: [] }, overrides.gate || {}),
    runbook: Object.assign({ date: '2026-07-08', status: 'READY_FOR_MANUAL_APPROVAL' }, overrides.runbook || {})
  };
}

test('force done for day + gate BLOCK => DONE_FOR_DAY_NOT_READY and no more archives', () => {
  const report = lib.buildCloseoutReport(inputs({ gate: { gate_status: 'BLOCK' }, runbook: { status: 'NOT_READY' } }), { forceDoneForDay: true, nowMs: Date.parse('2026-07-08T07:00:00Z') });
  assert.equal(report.closeout_status, 'DONE_FOR_DAY_NOT_READY');
  assert.equal(report.should_collect_more_archives_today, false);
  assert.match(report.recommendation, /Done for today\. Do not run more archive collection today/);
});


test('regression: real runbook status field NOT_READY forces DONE_FOR_DAY_NOT_READY with blocked gate', () => {
  const report = lib.buildCloseoutReport(inputs({
    gate: { gate_status: 'BLOCK' },
    runbook: { status: 'NOT_READY' }
  }), { forceDoneForDay: true });
  assert.equal(report.runbook_status, 'NOT_READY');
  assert.equal(report.closeout_status, 'DONE_FOR_DAY_NOT_READY');
  assert.equal(report.should_collect_more_archives_today, false);
});

test('after market close + gate BLOCK => DONE_FOR_DAY_NOT_READY', () => {
  const report = lib.buildCloseoutReport(inputs({ gate: { gate_status: 'BLOCK' }, runbook: { status: 'NOT_READY' } }), { timezone: 'Asia/Jakarta', marketCloseLocal: '16:00', nowMs: Date.parse('2026-07-08T09:30:00Z') });
  assert.equal(report.market_closed_for_closeout, true);
  assert.equal(report.closeout_status, 'DONE_FOR_DAY_NOT_READY');
});

test('spacing-only blocker before market close => NEED_MORE_SPACED_SAMPLES', () => {
  const report = lib.buildCloseoutReport(inputs({
    gate: { gate_status: 'BLOCK', block_reasons: ['session samples too close: 10 minutes'] },
    runbook: { status: 'NOT_READY' },
    aggregate: { aggregate_status: 'BLOCK', session_spacing_status: 'BLOCK', block_reasons: ['session span too short'] }
  }), { timezone: 'Asia/Jakarta', marketCloseLocal: '16:00', nowMs: Date.parse('2026-07-08T07:00:00Z') });
  assert.equal(report.closeout_status, 'NEED_MORE_SPACED_SAMPLES');
  assert.equal(report.should_collect_more_archives_today, true);
  assert.deepEqual(report.non_spacing_blockers, []);
});


test('realistic spacing-only aggregate BLOCK with policy BLOCK still needs more spaced samples before close', () => {
  const report = lib.buildCloseoutReport(inputs({
    bundle: { validation_status: 'PASS', provider_missing_count: 0, data_quality_counts: { OK: 20 }, priority_label_counts: {}, confirmation_label_counts: {} },
    aggregate: {
      aggregate_status: 'BLOCK',
      session_spacing_status: 'BLOCK',
      block_reasons: ['session samples too close: 10 minutes', 'session span too short: 20 minutes'],
      repeated_no_intraday_data_tickers: [],
      repeated_incomplete_intraday_tickers: [],
      repeated_intraday_unknown_tickers: []
    },
    policy: { policy_status: 'BLOCK', fallback_action_counts: {}, coverage_status: 'OK' },
    gate: { gate_status: 'BLOCK', block_reasons: ['session_spacing_status BLOCK'] },
    runbook: { status: 'NOT_READY' }
  }), { timezone: 'Asia/Jakarta', marketCloseLocal: '16:00', nowMs: Date.parse('2026-07-08T07:00:00Z') });
  assert.equal(report.closeout_status, 'NEED_MORE_SPACED_SAMPLES');
  assert.equal(report.should_collect_more_archives_today, true);
  assert.ok(report.spacing_blockers.length > 0);
  assert.deepEqual(report.non_spacing_blockers, []);
});

test('non-spacing blocker before market close => NOT_READY_NON_SPACING_BLOCKERS and no more archives', () => {
  const report = lib.buildCloseoutReport(inputs({
    gate: { gate_status: 'BLOCK' }, runbook: { status: 'NOT_READY' },
    bundle: { provider_missing_count: 1 }
  }), { timezone: 'Asia/Jakarta', marketCloseLocal: '16:00', nowMs: Date.parse('2026-07-08T07:00:00Z') });
  assert.equal(report.closeout_status, 'NOT_READY_NON_SPACING_BLOCKERS');
  assert.equal(report.should_collect_more_archives_today, false);
  assert.ok(report.non_spacing_blockers.some((b) => b.includes('provider_missing_count')));
});

test('PASS gate + READY_FOR_MANUAL_APPROVAL => READY_FOR_MANUAL_APPROVAL but still no automatic enable', () => {
  const report = lib.buildCloseoutReport(inputs(), { nowMs: Date.parse('2026-07-08T09:30:00Z') });
  assert.equal(report.closeout_status, 'READY_FOR_MANUAL_APPROVAL');
  assert.equal(report.should_collect_more_archives_today, false);
  assert.match(report.recommendation, /Do not enable automatically/);
});

test('BBSI incomplete is rendered as readable ticker/count text, not [object Object]', () => {
  const report = lib.buildCloseoutReport(inputs({
    gate: { gate_status: 'BLOCK' }, runbook: { status: 'NOT_READY' },
    aggregate: { repeated_incomplete_intraday_tickers: [{ ticker: 'BBSI', count: 3 }] },
    policy: { fallback_action_counts: { DAILY_SCORE_ONLY: 1 } }
  }), { forceDoneForDay: true });
  const md = lib.markdownReport(report);
  assert.match(md, /BBSI \(3\)/);
  assert.doesNotMatch(md, /\[object Object\]/);
});

test('output includes read-only confirmation', () => {
  const report = lib.buildCloseoutReport(inputs({ gate: { gate_status: 'BLOCK' }, runbook: { status: 'NOT_READY' } }), { forceDoneForDay: true });
  const md = lib.markdownReport(report);
  assert.match(md, /Read-only Confirmation/);
  assert.match(md, /does NOT enable DAYTRADE_INTRADAY_SCORE_ENABLED/);
});

test('CLI reads latest reports and writes markdown and json', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eod-closeout-'));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-bundle-2026-07-08.json'), JSON.stringify(inputs().bundle));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-validation-aggregate-2026-07-08.json'), JSON.stringify(inputs().aggregate));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-policy-2026-07-08.json'), JSON.stringify(inputs().policy));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-dry-run-gate-2026-07-08.json'), JSON.stringify(Object.assign(inputs().gate, { gate_status: 'BLOCK' })));
  await fs.writeFile(path.join(dir, 'daytrade-intraday-staged-enable-runbook-2026-07-08.json'), JSON.stringify(Object.assign(inputs().runbook, { status: 'NOT_READY' })));
  const { paths, report } = await lib.run({ reportsDir: dir, forceDoneForDay: true });
  assert.equal(report.closeout_status, 'DONE_FOR_DAY_NOT_READY');
  assert.ok((await fs.stat(paths.markdown)).isFile());
  assert.ok((await fs.stat(paths.json)).isFile());
});
