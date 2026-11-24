'use strict';

/**
 * test/v6/telegram-policy.test.js — M-P1c Telegram notification policy tests.
 * Pure decision tests + track-record lifecycle tests + dry-run skip logging.
 * No network access, no real Telegram sends, no filesystem writes to data/.
 */

const test = require('node:test');
const assert = require('node:assert');

const policy = require('../../lib/telegram-policy');
const top20 = require('../../lib/track-record-top20');
const notifier = require('../../lib/telegram-notifier');

// Weekday Wednesday (UTC) — not a weekend.
const WEEKDAY_NOW = new Date('2026-11-18T13:00:00Z'); // Wed
const WEEKEND_NOW = new Date('2026-11-21T13:00:00Z'); // Sat

function row(ticker, opts = {}) {
  return {
    ticker,
    rank: opts.rank,
    score: opts.score != null ? opts.score : 80,
    entry: opts.entry != null ? opts.entry : 1000,
    entry1: opts.entry1 != null ? opts.entry1 : 980,
    entry2: opts.entry2 != null ? opts.entry2 : 1000,
    sl: opts.sl != null ? opts.sl : 950,
    tp1: opts.tp1 != null ? opts.tp1 : 1080,
    tp2: opts.tp2 != null ? opts.tp2 : 1150,
    actionable: opts.actionable !== false
  };
}

function makeSnapshot(id, tickers, overrides = {}) {
  const rows = tickers.map((t, i) => {
    const base = row(t, { rank: i + 1 });
    const patch = (overrides[t] != null) ? overrides[t] : {};
    return Object.assign(base, patch);
  });
  return Object.assign({ snapshot_id: id, generated_at: '2026-11-18T13:00:00Z', rows }, overrides.__snapshot || {});
}

function top20Snapshot(id, generatedAt) {
  const rows = [];
  for (let i = 1; i <= 20; i++) {
    rows.push(row('T' + String(i).padStart(2, '0'), {
      rank: i,
      score: 90 - i,
      actionable: i <= 8
    }));
  }
  return { snapshot_id: id, generated_at: generatedAt || '2026-11-18T13:00:00Z', rows };
}

test('(a) identical snapshot => no notify + IDENTICAL_SNAPSHOT reason', () => {
  const snap = makeSnapshot('snap-001', ['BBRI', 'BRPT', 'ANTM', 'TLKM', 'ASII']);
  const d = policy.shouldNotifyTop5({
    prevSnapshot: snap,
    nextSnapshot: snap,
    now: WEEKDAY_NOW
  });
  assert.strictEqual(d.shouldNotify, false);
  assert.strictEqual(d.reason, policy.REASONS.IDENTICAL_SNAPSHOT);
});

test('(b) 1 ticker swap in Top5 => notify MEMBERSHIP change', () => {
  const prev = makeSnapshot('snap-001', ['BBRI', 'BRPT', 'ANTM', 'TLKM', 'ASII']);
  const next = makeSnapshot('snap-002', ['BBRI', 'BRPT', 'ANTM', 'TLKM', 'BMRI']);
  const d = policy.shouldNotifyTop5({ prevSnapshot: prev, nextSnapshot: next, now: WEEKDAY_NOW });
  assert.strictEqual(d.shouldNotify, true);
  assert.strictEqual(d.reason, policy.REASONS.NOTIFY_MEMBERSHIP_CHANGE);
  assert.deepStrictEqual(d.details.added, ['BMRI']);
  assert.deepStrictEqual(d.details.removed, ['ASII']);
});

test('(c) score change above threshold => notify SCORE_CHANGE', () => {
  const prev = makeSnapshot('snap-001', ['BBRI', 'BRPT', 'ANTM', 'TLKM', 'ASII']);
  const next = makeSnapshot('snap-002', ['BBRI', 'BRPT', 'ANTM', 'TLKM', 'ASII'], {
    BBRI: { score: 95 } // +18.75% > default 5% threshold
  });
  const d = policy.shouldNotifyTop5({ prevSnapshot: prev, nextSnapshot: next, now: WEEKDAY_NOW });
  assert.strictEqual(d.shouldNotify, true);
  assert.strictEqual(d.reason, policy.REASONS.NOTIFY_SCORE_CHANGE);
  assert.strictEqual(d.changeClass, policy.CHANGE_CLASSES.SCORE_CHANGE);
});

test('(d) score change below threshold => no notify (NO_MATERIAL_CHANGE)', () => {
  const prev = makeSnapshot('snap-001', ['BBRI', 'BRPT', 'ANTM', 'TLKM', 'ASII']);
  const next = makeSnapshot('snap-002', ['BBRI', 'BRPT', 'ANTM', 'TLKM', 'ASII'], {
    BBRI: { score: 81 } // +1.25% < 5% threshold
  });
  const d = policy.shouldNotifyTop5({ prevSnapshot: prev, nextSnapshot: next, now: WEEKDAY_NOW });
  assert.strictEqual(d.shouldNotify, false);
  assert.strictEqual(d.reason, policy.REASONS.NO_MATERIAL_CHANGE);
});

test('(c2) entry level change => notify ENTRY_LEVEL_CHANGE', () => {
  const prev = makeSnapshot('snap-001', ['BBRI', 'BRPT', 'ANTM', 'TLKM', 'ASII']);
  const next = makeSnapshot('snap-002', ['BBRI', 'BRPT', 'ANTM', 'TLKM', 'ASII'], {
    BBRI: { sl: 940 } // SL moved
  });
  const d = policy.shouldNotifyTop5({ prevSnapshot: prev, nextSnapshot: next, now: WEEKDAY_NOW });
  assert.strictEqual(d.shouldNotify, true);
  assert.strictEqual(d.reason, policy.REASONS.NOTIFY_ENTRY_LEVEL_CHANGE);
  assert.strictEqual(d.changeClass, policy.CHANGE_CLASSES.ENTRY_LEVEL_CHANGE);
});

test('(e) readiness flip => notify READINESS_FLIP', () => {
  const prev = makeSnapshot('snap-001', ['BBRI', 'BRPT', 'ANTM', 'TLKM', 'ASII']);
  const next = makeSnapshot('snap-002', ['BBRI', 'BRPT', 'ANTM', 'TLKM', 'ASII'], {
    BBRI: { actionable: false }
  });
  const d = policy.shouldNotifyTop5({ prevSnapshot: prev, nextSnapshot: next, now: WEEKDAY_NOW });
  assert.strictEqual(d.shouldNotify, true);
  assert.strictEqual(d.reason, policy.REASONS.NOTIFY_READINESS_FLIP);
  assert.strictEqual(d.changeClass, policy.CHANGE_CLASSES.READINESS_FLIP);
});

test('(f) weekend => NO_SESSION_WEEKEND, no fabricated daily picks', () => {
  const prev = makeSnapshot('snap-001', ['BBRI', 'BRPT', 'ANTM', 'TLKM', 'ASII']);
  const next = makeSnapshot('snap-002', ['BBRI', 'BRPT', 'ANTM', 'TLKM', 'BMRI']);
  const d = policy.shouldNotifyTop5({ prevSnapshot: prev, nextSnapshot: next, now: WEEKEND_NOW });
  assert.strictEqual(d.shouldNotify, false);
  assert.strictEqual(d.reason, policy.REASONS.NO_SESSION_WEEKEND);
});

test('(g) no READY candidates => NO_VALID_CANDIDATE, never a fake BUY', () => {
  const prev = makeSnapshot('snap-001', ['BBRI', 'BRPT', 'ANTM', 'TLKM', 'ASII']);
  const next = makeSnapshot('snap-002', ['BBRI', 'BRPT', 'ANTM', 'TLKM', 'BMRI'], {
    BBRI: { actionable: false }, BRPT: { actionable: false }, ANTM: { actionable: false },
    TLKM: { actionable: false }, BMRI: { actionable: false }
  });
  const d = policy.shouldNotifyTop5({ prevSnapshot: prev, nextSnapshot: next, now: WEEKDAY_NOW });
  assert.strictEqual(d.shouldNotify, false);
  assert.strictEqual(d.reason, policy.REASONS.NO_VALID_CANDIDATE);
});

test('(h) event_id dedupe is stable for the same transition', () => {
  const prev = makeSnapshot('snap-001', ['BBRI', 'BRPT', 'ANTM', 'TLKM', 'ASII']);
  const next = makeSnapshot('snap-002', ['BBRI', 'BRPT', 'ANTM', 'TLKM', 'BMRI']);
  const d1 = policy.shouldNotifyTop5({ prevSnapshot: prev, nextSnapshot: next, now: WEEKDAY_NOW });
  const d2 = policy.shouldNotifyTop5({ prevSnapshot: prev, nextSnapshot: next, now: WEEKDAY_NOW });
  assert.strictEqual(d1.event_id, d2.event_id);
  assert.notStrictEqual(d1.event_id, d2.event_id.slice(0, 15) + 'x'); // sanity: not degenerate
  // Different transition class => different event id.
  const next3 = makeSnapshot('snap-002', ['BBRI', 'BRPT', 'ANTM', 'TLKM', 'ASII'], { BBRI: { sl: 940 } });
  const d3 = policy.shouldNotifyTop5({ prevSnapshot: prev, nextSnapshot: next3, now: WEEKDAY_NOW });
  assert.notStrictEqual(d1.event_id, d3.event_id);
});

// -- track-record-top20 ------------------------------------------------------

test('(i) all 20 rows recorded, Top5 flagged highlighted', () => {
  const snapshot = top20Snapshot('tr-snap-001');
  const memStore = { rows: {}, order: [], snapshots: [] };
  const store = {
    load: () => memStore,
    save: (doc) => { Object.assign(memStore, doc); return true; }
  };
  const res = top20.recordTop20Snapshot({ snapshot, store });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.recordedCount, 20);
  assert.strictEqual(res.highlightedCount, 5);
  const rows = Object.values(memStore.rows);
  assert.strictEqual(rows.length, 20);
  for (const r of rows) {
    assert.strictEqual(r.highlighted, r.rank <= 5);
  }
  assert.ok(memStore.snapshots.includes('tr-snap-001'));
});

test('(j) lifecycle transitions WAITING -> FLOATING -> RESOLVED', () => {
  const snapshot = {
    snapshot_id: 'lc-001',
    rows: [{ ticker: 'BBRI', rank: 1, score: 90, entry: 1000, sl: 950, tp1: 1080, tp2: 1150, actionable: true, expiry_at: '2026-11-25' }]
  };
  const cost = { slippagePct: 0.25, feePct: 0.10, sides: 1 };
  let r = top20.buildRowsForSnapshot({ snapshot, topN: 5 })[0];
  assert.strictEqual(r.status, top20.ROW_STATUS.WAITING);

  // Bar dips to entry: fill.
  let step = top20.applyObservation(r, { lastPrice: 1005, low: 995, high: 1008, now: '2026-11-19' }, cost);
  r = step.row;
  assert.strictEqual(r.status, top20.ROW_STATUS.FLOATING);
  assert.strictEqual(r.entry_fill_price, 1000);
  assert.ok(step.transition === 'WAITING->FLOATING');

  // Open position: floating gain tracked.
  step = top20.applyObservation(r, { lastPrice: 1040, low: 1030, high: 1045, now: '2026-11-20' }, cost);
  r = step.row;
  assert.strictEqual(r.status, top20.ROW_STATUS.FLOATING);
  assert.strictEqual(r.price_since_signal, 1040);
  assert.ok(r.price_since_signal_pct === 4);
  assert.ok(r.floating_gain_pct === 3.65); // 4 - (0.25+0.10) one side

  // TP1 touched: resolved, realized gain net of one round trip side.
  step = top20.applyObservation(r, { lastPrice: 1085, low: 1075, high: 1090, now: '2026-11-21' }, cost);
  r = step.row;
  assert.strictEqual(r.status, top20.ROW_STATUS.RESOLVED);
  assert.strictEqual(r.tp_level_hit, 1);
  assert.ok(r.realized_gain_pct === 7.65); // (1080-1000)/1000*100 = 8 - 0.35
  assert.ok(step.transition === 'FLOATING->RESOLVED');
});

test('(j2) SL hit resolves as loss; expiry without entry => EXPIRED', () => {
  const cost = { slippagePct: 0.25, feePct: 0.10, sides: 1 };
  const snapshot = {
    snapshot_id: 'lc-002',
    rows: [{ ticker: 'BRPT', rank: 2, score: 88, entry: 500, sl: 475, tp1: 540, tp2: 580, actionable: true, expiry_at: '2026-11-25' }]
  };
  let r = top20.buildRowsForSnapshot({ snapshot })[0];

  // Fill then SL.
  r = top20.applyObservation(r, { lastPrice: 498, low: 495, high: 502, now: '2026-11-19' }, cost).row;
  assert.strictEqual(r.status, top20.ROW_STATUS.FLOATING);
  r = top20.applyObservation(r, { lastPrice: 474, low: 473, high: 480, now: '2026-11-20' }, cost).row;
  assert.strictEqual(r.status, top20.ROW_STATUS.RESOLVED);
  assert.ok(r.sl_hit_at === '2026-11-20');
  assert.ok(r.realized_gain_pct < 0);

  // Fresh row that never fills and passes expiry.
  let r2 = top20.buildRowsForSnapshot({ snapshot: { snapshot_id: 'lc-003', rows: [{ ticker: 'ANTM', rank: 3, score: 85, entry: 2000, sl: 1900, tp1: 2160, tp2: 2300, actionable: true, expiry_at: '2026-11-20' }] } })[0];
  const step2 = top20.applyObservation(r2, { lastPrice: 2100, low: 2050, high: 2110, now: '2026-11-26' }, cost);
  assert.strictEqual(step2.row.status, top20.ROW_STATUS.EXPIRED);
  assert.ok(step2.transition === 'WAITING->EXPIRED');
});

test('(k) fee/slippage applied consistently with the existing ledger convention', () => {
  // Same formula as lib/track-record-live-ledger.applyCosts (shared, not duplicated).
  const gross = 8; // +8%
  const expected = ledger_check(gross);
  assert.strictEqual(top20.realizedGainPct(1000, 1080, {}), expected);
  assert.strictEqual(
    top20.floatingGainPct(1000, 1040, {}),
    require('../../lib/track-record-live-ledger').applyCosts(4, { sides: 1 })
  );

  function ledger_check(g) {
    const ledger = require('../../lib/track-record-live-ledger');
    return ledger.applyCosts(g, {});
  }
});

// -- dry-run policy skip path ------------------------------------------------

test('(l) dry-run policy skip sends nothing and records the skip reason', async () => {
  const recorded = [];
  const originalRecorder = notifier.getDryRunRecorder();
  notifier.setDryRunRecorder((rec) => { recorded.push(rec); return { recorded: true }; });

  try {
    const decision = { shouldNotify: false, reason: 'IDENTICAL_SNAPSHOT', event_id: 'evt-123', details: { prev_snapshot_id: 'p1', next_snapshot_id: 'p1' } };
    const res = await notifier.sendTelegramMessageWithPolicy('Top5 list', decision, { dry_run: true });
    assert.strictEqual(res.sent, false);
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.policy_skipped, true);
    assert.strictEqual(res.reason, 'policy_skip_IDENTICAL_SNAPSHOT');
    assert.strictEqual(recorded.length, 1);
    assert.ok(recorded[0].text.includes('[POLICY_SKIP]'));
    assert.ok(recorded[0].text.includes('IDENTICAL_SNAPSHOT'));
    assert.strictEqual(recorded[0].source, 'telegram-policy');
  } finally {
    notifier.setDryRunRecorder(originalRecorder);
  }
});

test('(l2) policy-allowed message still fails closed without TELEGRAM_LIVE (no network)', async () => {
  const recorded = [];
  const originalRecorder = notifier.getDryRunRecorder();
  notifier.setDryRunRecorder((rec) => { recorded.push(rec); return { recorded: true }; });

  try {
    const decision = { shouldNotify: true, reason: 'NOTIFY_MEMBERSHIP_CHANGE', event_id: 'evt-456', details: {} };
    // Never set TELEGRAM_LIVE=true; the gate must refuse -> dry-run record, no send.
    const res = await notifier.sendTelegramMessageWithPolicy('Top5 list', decision, {
      dry_run: true,
      skip_market_guard: true
    });
    assert.strictEqual(res.sent, false);
    assert.strictEqual(res.skipped, true);
    assert.ok(res.dry_run === true || res.reason === 'dry_run' || String(res.reason).indexOf('dry_run') === 0);
    assert.strictEqual(recorded.length, 1);
  } finally {
    notifier.setDryRunRecorder(originalRecorder);
  }
});
