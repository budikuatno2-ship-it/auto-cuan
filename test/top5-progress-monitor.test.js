'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeTop5Progress, detectTop5ProgressEvents, buildTop5ProgressDiagnostics, deriveTrackingStatus, eventKey } = require('../lib/top5-progress-monitor');

function plan(overrides) { return Object.assign({ ticker: 'ABCD', locked_date: '2026-07-15', entry_price: 100, entry_high: 102, tp1: 105, tp2: 110, sl: 95, latest_price_at: '2026-07-16T08:00:00Z' }, overrides); }
function types(result) { return result.events.map((event) => event.type); }
const fresh = { now: '2026-07-16T10:00:00Z' };

test('uses conservative entry_high and detects TP1', () => {
  const result = detectTop5ProgressEvents(plan(), 106, fresh);
  assert.equal(result.progress.entry_used, 102);
  assert.equal(result.progress.tp1_hit, true);
  assert.ok(types(result).includes('TP1_HIT'));
});
test('detects TP2 and all crossed gain milestones', () => {
  const result = detectTop5ProgressEvents(plan(), 113, fresh);
  assert.ok(types(result).includes('TP2_HIT'));
  assert.deepEqual(types(result).filter((type) => type.startsWith('GAIN_')), ['GAIN_3_PCT', 'GAIN_5_PCT', 'GAIN_10_PCT']);
});
test('event keys are deterministic and distinguish event levels', () => {
  assert.equal(eventKey(plan(), 'TP1_HIT'), 'top5_progress:ABCD:2026-07-15:TP1_HIT:tp1');
  assert.notEqual(eventKey(plan(), 'TP1_HIT'), eventKey(plan(), 'TP2_HIT'));
});
test('stale 217 hour price is blocked and never notification enabled', () => {
  const result = detectTop5ProgressEvents(plan({ latest_price_at: '2026-07-07T09:00:00Z' }), 113, fresh);
  assert.equal(result.progress.stale, true);
  assert.deepEqual(types(result), ['STALE_PRICE']);
  assert.equal(result.events[0].notification_enabled, false);
});
test('blocks avoid, hindari, sell, very high risk, and corporate action rows', () => {
  ['AVOID', 'Hindari', 'SELL', 'Very High Risk'].forEach((status) => assert.equal(computeTop5Progress(plan({ status }), 106, fresh).actionable, false));
  assert.equal(computeTop5Progress(plan({ corporate_action_guard: 'BLOCKED' }), 106, fresh).actionable, false);
});
test('foreign net sell commentary is analytical context and does not block TP progress', () => {
  const result = detectTop5ProgressEvents(plan({ foreign_notes: 'foreign net sell', foreign_label: 'Net Sell' }), 111, fresh);
  assert.equal(result.progress.actionable, true);
  assert.ok(types(result).includes('TP1_HIT'));
  assert.ok(types(result).includes('TP2_HIT'));
  assert.equal(computeTop5Progress(plan({ action_label: 'SELL', foreign_notes: 'net buy' }), 111, fresh).actionable, false);
});
test('reports missing latest price and missing entry as invalid plans', () => {
  assert.equal(computeTop5Progress(plan(), null, fresh).block_reason, 'latest_price_missing');
  assert.equal(computeTop5Progress(plan({ entry_price: null, entry_high: null }), 106, fresh).block_reason, 'entry_missing');
});
test('reports below-entry and near/below SL progress diagnostics', () => {
  const result = detectTop5ProgressEvents(plan(), 94, fresh);
  assert.ok(types(result).includes('BELOW_ENTRY'));
  assert.ok(types(result).includes('SL_NEAR'));
});
test('defaults to dry-run diagnostics without durable idempotency', () => {
  const report = buildTop5ProgressDiagnostics([plan()], fresh);
  assert.equal(report.notification_mode, 'dry_run_only');
  assert.match(report.notification_reason, /real Telegram disabled/i);
  assert.equal(report.results[0].events.every((event) => !event.notification_enabled), true);
});
test('TP1 continues tracking while TP2 completes and SL stops tracking', () => {
  assert.equal(deriveTrackingStatus(plan(), detectTop5ProgressEvents(plan(), 106, fresh), {}, fresh).status, 'TRACKING_TP1');
  assert.equal(deriveTrackingStatus(plan(), detectTop5ProgressEvents(plan(), 111, fresh), {}, fresh).status, 'COMPLETE');
  assert.equal(deriveTrackingStatus(plan(), detectTop5ProgressEvents(plan(), 94, fresh), {}, fresh).status, 'STOP_TRACKING');
});
test('tracking expires after seven days and Swing routine is daily after close', () => {
  const old = plan({ locked_date: '2026-07-01', category: 'Swing Konglo' });
  assert.equal(deriveTrackingStatus(old, detectTop5ProgressEvents(old, 103, fresh), {}, fresh).status, 'MAX_AGE_EXPIRED');
  const swing = plan({ category: 'Swing Konglo' });
  assert.equal(deriveTrackingStatus(swing, detectTop5ProgressEvents(swing, 103, fresh), { last_routine_update_at: '2026-07-16T01:00:00Z' }, Object.assign({}, fresh, { afterMarketClose: true })).routine_update_due, false);
  assert.equal(deriveTrackingStatus(swing, detectTop5ProgressEvents(swing, 103, fresh), { last_routine_update_at: '2026-07-15T10:00:00Z' }, Object.assign({}, fresh, { afterMarketClose: true })).routine_update_due, true);
});
test('TP1 notified state prevents repeated TP1/routine notifications while tracking TP2 or SL', () => {
  const tracked = deriveTrackingStatus(plan(), detectTop5ProgressEvents(plan(), 106, fresh), { tp1_notified: true }, fresh);
  assert.equal(tracked.status, 'TRACKING_AFTER_TP1');
  assert.equal(tracked.routine_update_due, false);
  assert.equal(deriveTrackingStatus(plan(), detectTop5ProgressEvents(plan(), 111, fresh), { tp1_notified: true }, fresh).status, 'COMPLETE');
  assert.equal(deriveTrackingStatus(plan(), detectTop5ProgressEvents(plan(), 94, fresh), { tp1_notified: true }, fresh).status, 'STOP_TRACKING');
});
