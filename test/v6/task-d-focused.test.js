'use strict';
/**
 * TASK D — focused regression tests: Telegram Top5/Top20 push readiness,
 * intraday Yahoo ZERO_QUOTA schedules, TP/SL hit status, and the proven
 * SL_HIT emission defect. All state is in-memory; no network, no DB, no cron.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const push = require('../../lib/task-d-telegram-push');
const sched = require('../../lib/task-d-intraday-schedule');
const tpsl = require('../../lib/task-d-tpsl-status');
const progress = require('../../lib/top5-progress-monitor');

function readyRow(ticker, overrides) {
  return Object.assign({
    ticker,
    readiness_status: 'READY',
    actionable: true,
    snapshot_id: 'SNAP-20261120',
    snapshot_date: '2026-11-20',
    entry: 5000, sl: 4900, tp1: 5300, tp2: 5600,
    score: 88.4
  }, overrides || {});
}

function mockTransport(id) {
  const calls = [];
  return {
    id: id || 'MOCK-OFFLINE-E2E',
    calls,
    send(payload) {
      calls.push(payload);
      return { ok: true, receipt_id: 'MOCK-RECEIPT-' + (calls.length), live: false };
    }
  };
}

// ---------------------------------------------------------------------------
// Telegram push readiness
// ---------------------------------------------------------------------------

test('D1: message format contains ticker, entry, SL, TP1/TP2, R/R, score, snapshot date', () => {
  const msg = push.formatCandidateMessage('TOP5', readyRow('BBRI'));
  assert.match(msg, /\[TOP5\] BBRI/);
  assert.match(msg, /Snapshot 2026-11-20/);
  assert.match(msg, /Entry Rp5\.000/);
  assert.match(msg, /SL Rp4\.900/);
  assert.match(msg, /TP1 Rp5\.300/);
  assert.match(msg, /TP2 Rp5\.600/);
  assert.match(msg, /R\/R 3\.00x/);
  assert.match(msg, /Score 88\.4/);
});

test('D2: readiness guard blocks NOT_READY rows with zero sends', () => {
  const t = mockTransport();
  const r = push.preparePush({
    scope: 'TOP5', config: { enabled: true },
    rows: [readyRow('BBRI'), readyRow('GOTO', { readiness_status: 'NOT_READY' })]
  }, { transport: t });
  assert.equal(r.ok, true);
  assert.equal(r.sent, 1);
  assert.equal(t.calls.length, 1);
  assert.deepEqual(r.skipped.map((s) => s.reason), ['NOT_READY']);
});

test('D3: Admin toggle OFF blocks all sends; live transport rejected', () => {
  const t = mockTransport();
  const off = push.preparePush({ scope: 'TOP20', config: { enabled: false }, rows: [readyRow('BBRI')] }, { transport: t });
  assert.equal(off.reason, push.REASON.DISABLED);
  assert.equal(t.calls.length, 0);
  const live = { id: 'LIVE-PROVIDER', send: () => { throw new Error('must not be called'); } };
  const bad = push.preparePush({ scope: 'TOP20', config: { enabled: true }, rows: [readyRow('BBRI')] }, { transport: live });
  assert.equal(bad.reason, push.REASON.MOCK_ONLY);
});

test('D4: dedupe suppresses repeated snapshot/ticker/event; dedicated chat routing', () => {
  const t = mockTransport();
  const idem = push.createMemoryIdempotencyStore();
  const input = { scope: 'TOP5', config: { enabled: true }, rows: [readyRow('BBRI')], idempotency: idem, eventType: 'PUSH' };
  const first = push.preparePush(input, { transport: t });
  const second = push.preparePush(input, { transport: t });
  assert.equal(first.sent, 1);
  assert.equal(second.sent, 0);
  assert.equal(second.skipped[0].reason, push.REASON.DUPLICATE);
  assert.equal(t.calls.length, 1);
  assert.equal(first.chat_route, 'TOP5_CHANNEL');
  const top20 = push.preparePush({ scope: 'TOP20', config: { enabled: true }, rows: [readyRow('BBRI')] }, { transport: t });
  assert.equal(top20.chat_route, 'TOP20_CHANNEL');
});

test('D5: anti-secret leak — token/chat-id-like text blocked and payload redacted', () => {
  const t = mockTransport();
  const r = push.preparePush({
    scope: 'TOP5', config: { enabled: true },
    rows: [readyRow('BBRI', { ticker: 'bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ' })]
  }, { transport: t });
  assert.equal(r.sent, 0);
  assert.equal(r.skipped[0].reason, push.REASON.SECRET_LIKE_TEXT);
  assert.equal(t.calls.length, 0);
  assert.equal(push.looksLikeSecret('chat_id: 6396446903'), true);
  assert.equal(push.looksLikeSecret('BBRI entry 5000'), false);
});

test('D6: mocked receipts report 0 live sends / 0 billed units', () => {
  const t = mockTransport();
  const r = push.preparePush({ scope: 'TOP20', config: { enabled: true }, rows: [readyRow('BBRI'), readyRow('TLKM')] }, { transport: t });
  assert.equal(r.sent, 2);
  assert.equal(r.httpRequests, 0);
  assert.equal(r.billedUnits, 0);
  assert.equal(r.transport_id, 'MOCK-OFFLINE-E2E');
  assert.ok(r.messages.every((m) => m.receipt.live === false));
});

// ---------------------------------------------------------------------------
// Intraday schedule
// ---------------------------------------------------------------------------

test('D7: Mon-Thu schedule matrix exact and lunch break respected', () => {
  assert.deepEqual(Array.from(sched.SCHEDULE.MON_THU), ['09:10', '10:05', '11:05', '12:05', '13:40', '14:40', '15:40', '16:15', '17:00']);
  assert.equal(sched.evaluateInstant(new Date('2026-11-19T02:10:00Z')).active, true); // 09:10 WIB Wed
  assert.equal(sched.evaluateInstant(new Date('2026-11-19T05:15:00Z')).reason, 'LUNCH_BREAK'); // 12:15 WIB
  assert.equal(sched.evaluateInstant(new Date('2026-11-19T05:05:00Z')).in_break_checkpoint, true); // 12:05 explicit checkpoint
  assert.equal(sched.evaluateInstant(new Date('2026-11-19T05:05:00Z')).price_mode, 'LAST_VERIFIED_PRICE');
  assert.equal(sched.evaluateInstant(new Date('2026-11-19T06:30:00Z')).reason, 'LUNCH_BREAK'); // 13:30 WIB (break end exclusive)
  assert.equal(sched.evaluateInstant(new Date('2026-11-19T06:40:00Z')).active, true); // 13:40 WIB
});

test('D8: Friday schedule matrix exact and Friday prayer break respected', () => {
  assert.deepEqual(Array.from(sched.SCHEDULE.FRI), ['09:10', '10:05', '11:05', '11:35', '14:10', '15:05', '15:40', '16:15', '17:00']);
  const checkpoint = sched.evaluateInstant(new Date('2026-11-20T04:35:00Z')); // 11:35 WIB Fri
  assert.equal(checkpoint.active, true);
  assert.equal(checkpoint.in_break_checkpoint, true);
  assert.equal(checkpoint.price_mode, 'LAST_VERIFIED_PRICE');
  assert.equal(sched.evaluateInstant(new Date('2026-11-20T04:45:00Z')).reason, 'FRIDAY_PRAYER_BREAK'); // 11:45 WIB
  assert.equal(sched.evaluateInstant(new Date('2026-11-20T07:10:00Z')).active, true); // 14:10 WIB
});

test('D9: weekend and IDX holiday SKIP', () => {
  assert.equal(sched.evaluateInstant(new Date('2026-11-21T02:10:00Z')).reason, 'WEEKEND_SKIP'); // Sat
  assert.equal(sched.evaluateInstant(new Date('2026-11-22T02:10:00Z')).reason, 'WEEKEND_SKIP'); // Sun
  const holiday = new Set(['2026-11-19']);
  assert.equal(sched.evaluateInstant(new Date('2026-11-19T02:10:00Z'), { holidaySet: holiday }).reason, 'IDX_HOLIDAY_SKIP');
});

test('D10: fetch plan is Yahoo ZERO_QUOTA only; Top5 reuses Top20 fetch; no re-screen/re-rank', () => {
  const active = sched.evaluateInstant(new Date('2026-11-19T02:10:00Z'));
  const top20 = ['BBRI', 'TLKM', 'BMRI', 'ASII', 'UNTR', 'GOTO'].map((t) => ({ ticker: t }));
  const plan = sched.buildFetchPlan(active, top20, { top5Tickers: ['BBRI', 'TLKM', 'BMRI', 'ASII', 'UNTR'] });
  assert.equal(plan.ok, true);
  assert.equal(plan.fetchCount, 6);
  assert.equal(plan.top5ReuseCount, 5);
  assert.equal(plan.httpRequests, 0);
  assert.equal(plan.billedUnits, 0);
  assert.ok(plan.fetches.every((f) => f.provider === 'YAHOO_ZERO_QUOTA' && f.reScreen === false && f.reRank === false));
  const inactive = sched.buildFetchPlan(sched.evaluateInstant(new Date('2026-11-19T05:15:00Z')), top20, {});
  assert.equal(inactive.ok, false);
  assert.equal(inactive.fetches.length, 0);
});

// ---------------------------------------------------------------------------
// TP/SL status
// ---------------------------------------------------------------------------

test('D11: TP1/TP2/SL hit simulation with WIB hit time labels', () => {
  const row = { ticker: 'BBRI', entry: 5000, sl: 4900, tp1: 5300, tp2: 5600 };
  const tp1 = tpsl.classifyHit(row, { price: 5350, now: new Date('2026-11-20T03:05:00Z') }); // 10:05 WIB
  assert.equal(tp1.status, 'KENA TP1');
  assert.equal(tp1.label, 'Kena TP1 \u00B7 10:05 WIB');
  const tp2 = tpsl.classifyHit(row, { price: 5650, now: new Date('2026-11-20T07:10:00Z') }); // 14:10 WIB
  assert.equal(tp2.status, 'KENA TP2');
  assert.equal(tp2.label, 'Kena TP2 \u00B7 14:10 WIB');
  const sl = tpsl.classifyHit(row, { price: 4850, now: new Date('2026-11-20T04:35:00Z') }); // 11:35 WIB
  assert.equal(sl.status, 'KENA SL');
  assert.equal(sl.label, 'Kena SL \u00B7 11:35 WIB');
  const active = tpsl.classifyHit(row, { price: 5100, now: new Date('2026-11-20T02:10:00Z') });
  assert.equal(active.status, 'AKTIF');
  assert.equal(active.label, 'AKTIF/PANTAU');
});

test('D12: conservative tie-break — SL wins when a bar touches SL and TP', () => {
  const row = { ticker: 'BBRI', entry: 5000, sl: 4900, tp1: 5300, tp2: 5600 };
  const r = tpsl.classifyHit(row, { high: 5700, low: 4850, now: new Date('2026-11-20T03:05:00Z') });
  assert.equal(r.status, 'KENA SL');
});

test('D13: terminal hit is sticky; later observation cannot reset to AKTIF', () => {
  const store = tpsl.createMemoryStore();
  const row = { ticker: 'BBRI', entry: 5000, sl: 4900, tp1: 5300, tp2: 5600, snapshot_id: 'S1' };
  const first = tpsl.applyObservation(row, { price: 5350, now: new Date('2026-11-20T03:05:00Z') }, { store, scope: 'TOP20' });
  assert.equal(first.row.tp_sl_status, 'KENA TP1');
  const second = tpsl.applyObservation(row, { price: 5100, now: new Date('2026-11-20T06:40:00Z') }, { store, scope: 'TOP20' });
  assert.equal(second.row.tp_sl_status, 'KENA TP1');
  assert.equal(second.row.tp_sl_hit_at_wib, '10:05');
  const decorated = tpsl.decorateRows([row], { store, scope: 'TOP20' });
  assert.equal(decorated[0].tp_sl_label, 'Kena TP1 \u00B7 10:05 WIB');
});

test('D14: REGRESSION — SL_HIT is emitted and sendable (proven defect fixed)', () => {
  const row = { ticker: 'BBRI', entry: 5000, sl: 4900, tp1: 5300, tp2: 5600, latest_price: 4850, latest_price_at: '2026-11-20T03:05:00Z' };
  const detected = progress.detectTop5ProgressEvents(row, 4850, { now: new Date('2026-11-20T03:05:00Z'), hasDurableIdempotency: true });
  const sl = detected.events.find((e) => e.type === 'SL_HIT');
  assert.ok(sl, 'SL_HIT event must be emitted when price <= SL');
  assert.equal(sl.actionable, true);
  assert.equal(sl.notification_enabled, true);
  assert.ok(!detected.events.some((e) => e.type === 'SL_NEAR'), 'SL_NEAR must not duplicate a confirmed SL_HIT');
});
