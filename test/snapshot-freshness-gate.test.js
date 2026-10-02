'use strict';

// BUG-3C-02 regression — snapshot freshness gate.
//
// Invariant: production `--send` must never dispatch a snapshot that does not
// represent the current WIB trading date. The verdict comes from the canonical
// IDX trading calendar (weekend/holiday aware), never naive `age < 24 hours`.
// Every test is offline: no Telegram, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const freshness = require('../lib/snapshot-freshness');
const calendar = require('../lib/idx-trading-calendar');
const runner = require('../tools/run-screener');

const ROOT = path.resolve(__dirname, '..');

function freshRoot(snapshot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-freshness-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'screener-latest.json'), JSON.stringify(snapshot));
  return root;
}

function evaluate(snapshot, nowIso, mode) {
  return freshness.evaluateSnapshotFreshness({
    snapshot,
    mode: mode || 'daytrade',
    now: new Date(nowIso)
  });
}

// 2026-09-24 = Thursday trading day; 2026-09-25 = Friday trading day;
// 2026-09-26/27 = weekend; 2026-09-28 = Monday trading day.
// 2026-05-14 (Kenaikan Yesus Kristus) is in the IDX 2026 holiday seed.

test('FR-A: same trading date is fresh for every mode (allowed)', () => {
  const result = evaluate({ updated_at: '2026-09-24T09:30:06.606Z' }, '2026-09-24T04:00:00Z', 'swing-konglo');
  assert.equal(result.fresh, true);
  assert.equal(result.stale, false);
  assert.equal(result.reason, 'fresh');
  assert.equal(result.snapshot_date, '2026-09-24');
  assert.equal(result.expected_date, '2026-09-24');
  assert.equal(result.age_sessions, 0);
  assert.deepEqual(result.acceptable_dates, ['2026-09-24'], 'EOD modes accept the current date only');

  for (const mode of ['daytrade', 'swing-konglo', 'swing-non-konglo', 'top5', 'dispatch']) {
    const perMode = evaluate({ updated_at: '2026-09-24T09:30:06.606Z' }, '2026-09-24T04:00:00Z', mode);
    assert.equal(perMode.fresh, true, mode + ' must accept the current trading date');
  }
});

test('FR-B: previous trading date during a live session is blocked for the EOD swing modes', () => {
  // Swing Konglo EOD 19:15 consumes the SAME-day 19:00 producer: Wednesday's
  // snapshot on Thursday evening is the exact stale-broadcast failure.
  const swing = evaluate({ updated_at: '2026-09-23T09:30:00Z' }, '2026-09-24T12:15:00Z', 'swing-konglo');
  assert.equal(swing.fresh, false);
  assert.equal(swing.reason, 'STALE_SNAPSHOT');
  assert.equal(swing.snapshot_date, '2026-09-23');
  assert.equal(swing.expected_date, '2026-09-24');
  assert.equal(swing.age_sessions, 1);

  // DayTrade 09:15-13:45 runs BEFORE that day's 19:00 producer: the latest
  // completed session (Wednesday) is the applicable snapshot and is allowed.
  const daytrade = evaluate({ updated_at: '2026-09-23T09:30:00Z' }, '2026-09-24T04:00:00Z', 'daytrade');
  assert.equal(daytrade.fresh, true, 'daytrade morning run uses the latest completed session');
  assert.deepEqual(daytrade.acceptable_dates, ['2026-09-23', '2026-09-24']);
  assert.equal(daytrade.age_sessions, 1);

  // Two sessions old is stale even for DayTrade.
  const tooOld = evaluate({ updated_at: '2026-09-22T09:30:00Z' }, '2026-09-24T04:00:00Z', 'daytrade');
  assert.equal(tooOld.fresh, false);
  assert.equal(tooOld.reason, 'STALE_SNAPSHOT');
  assert.equal(tooOld.age_sessions, 2);
});

test('FR-C: previous trading date at the same-day evening EOD job is blocked', () => {
  // 19:15 WIB on Thursday 2026-09-24 = 12:15 UTC. Snapshot is Wednesday's.
  const result = evaluate({ updated_at: '2026-09-23T12:00:00Z' }, '2026-09-24T12:15:00Z', 'swing-konglo');
  assert.equal(result.fresh, false);
  assert.equal(result.reason, 'STALE_SNAPSHOT');
  assert.equal(result.age_sessions, 1);

  // Same fixture at the 19:45 dispatch slot is also blocked.
  const dispatch = evaluate({ updated_at: '2026-09-23T12:00:00Z' }, '2026-09-24T12:45:00Z', 'dispatch');
  assert.equal(dispatch.fresh, false);
  assert.equal(dispatch.reason, 'STALE_SNAPSHOT');
});

test('FR-D: Friday snapshot on Monday is blocked for EOD modes (weekend does not refresh)', () => {
  const result = evaluate({ updated_at: '2026-09-25T09:30:00Z' }, '2026-09-28T12:15:00Z', 'swing-non-konglo');
  assert.equal(result.fresh, false);
  assert.equal(result.reason, 'STALE_SNAPSHOT');
  // Friday → Monday is exactly ONE trading session, not three calendar days.
  assert.equal(result.age_sessions, 1, 'weekend must not count as extra trading sessions');
});

test('FR-E: weekend/non-trading-day logic uses the trading calendar, not naive subtraction', () => {
  // Saturday run: not a trading day → fail closed regardless of snapshot date.
  const saturday = evaluate({ updated_at: '2026-09-26T04:00:00Z' }, '2026-09-26T04:00:00Z');
  assert.equal(saturday.fresh, false);
  assert.equal(saturday.reason, 'NON_TRADING_DAY');
  assert.equal(saturday.is_trading_day_today, false);

  // Session-age arithmetic across the weekend: Thursday snapshot on Monday = 2 sessions.
  const thursdayToMonday = evaluate({ updated_at: '2026-09-24T09:30:00Z' }, '2026-09-28T04:00:00Z');
  assert.equal(thursdayToMonday.age_sessions, 2, 'Thu→Mon crosses two completed sessions (Fri, Mon)');
});

test('FR-F: holiday boundary uses the IDX calendar', () => {
  // 2026-05-14 is an IDX holiday → NON_TRADING_DAY even though it is a Thursday.
  const holiday = evaluate({ updated_at: '2026-05-13T09:30:00Z' }, '2026-05-14T04:00:00Z');
  assert.equal(holiday.fresh, false);
  assert.equal(holiday.reason, 'NON_TRADING_DAY');

  // 2026-05-15 (Friday) is also an IDX cuti bersama holiday.
  const cuti = evaluate({ updated_at: '2026-05-13T09:30:00Z' }, '2026-05-15T04:00:00Z');
  assert.equal(cuti.reason, 'NON_TRADING_DAY');

  // The next trading day after the 13th is the 18th (Mon). Under the EOD rule
  // the 13th snapshot is stale on the 18th; the session age is 1 completed
  // trading session, not 5 calendar days.
  const nextTrading = evaluate({ updated_at: '2026-05-13T09:30:00Z' }, '2026-05-18T12:15:00Z', 'swing-konglo');
  assert.equal(nextTrading.reason, 'STALE_SNAPSHOT');
  assert.equal(nextTrading.age_sessions, 1);
});

test('FR-G: missing snapshot date metadata is blocked for --send (fail closed)', () => {
  const noDate = evaluate({ daytrade: [{ ticker: 'BBCA' }] }, '2026-09-24T04:00:00Z');
  assert.equal(noDate.fresh, false);
  assert.equal(noDate.reason, 'MISSING_SNAPSHOT_DATE');
  assert.equal(noDate.snapshot_date, null);

  const corruptDate = evaluate({ updated_at: 'not-a-timestamp' }, '2026-09-24T04:00:00Z');
  assert.equal(corruptDate.reason, 'MISSING_SNAPSHOT_DATE');

  // Future-dated snapshot metadata is also rejected.
  const future = evaluate({ updated_at: '2026-09-25T04:00:00Z' }, '2026-09-24T04:00:00Z');
  assert.equal(future.reason, 'FUTURE_SNAPSHOT');
});

test('FR-H: stale snapshot in non-send inspection mode is explicitly marked stale, never silently fresh', () => {
  // Two sessions old: stale even for the daytrade latest-completed-session rule.
  const root = freshRoot({ daytrade: [{ ticker: 'BBCA', score: 90 }], updated_at: '2026-09-22T09:30:00Z' });
  try {
    const report = runner.analyze(
      { mode: 'daytrade', dryRun: true, send: false, json: false },
      { rootDir: root, env: {}, now: new Date('2026-09-24T04:00:00Z') }
    );
    // Dry-run inspection is allowed but MUST be explicitly marked stale.
    assert.equal(report.freshness.stale, true);
    assert.equal(report.freshness.reason, 'STALE_SNAPSHOT');
    assert.ok(report.reasons.some((r) => r.indexOf('stale_snapshot') === 0),
      'the stale verdict must be visible in the diagnostics');
    // Never silently treated as fresh: healthy requires zero reasons.
    assert.equal(report.healthy, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FR-I: Telegram adapter is not invoked when the snapshot is stale', async () => {
  const root = freshRoot({ daytrade: [{ ticker: 'BBCA', score: 90 }], updated_at: '2026-09-22T09:30:00Z' });
  let sent = false;
  try {
    const out = await runner.main(
      ['node', 'run-screener.js', '--mode=daytrade', '--send'],
      {
        rootDir: root,
        now: new Date('2026-09-24T04:00:00Z'),
        env: { TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: '-100' },
        log: () => {},
        notifier: { sendTelegramMessage: async () => { sent = true; return { sent: true }; } }
      }
    );
    assert.equal(sent, false, 'stale snapshot must never reach Telegram');
    assert.equal(out.exitCode, 2);
    assert.equal(out.blocked, 'STALE_SNAPSHOT');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FR-J: freshness comes from snapshot metadata, and metadata fields are honored in priority order', () => {
  // Explicit market_date/run_date beat a timestamp.
  const explicit = evaluate({
    market_date: '2026-09-24',
    updated_at: '2026-09-23T09:30:00Z'
  }, '2026-09-24T04:00:00Z');
  assert.equal(explicit.fresh, true);
  assert.equal(explicit.snapshot_date_field, 'market_date');

  // An explicit run_date beats the (newer) timestamp, evaluated under the EOD
  // swing rule where the previous session is stale.
  const runDate = evaluate({
    run_date: '2026-09-23',
    updated_at: '2026-09-24T09:30:00Z'
  }, '2026-09-24T12:15:00Z', 'swing-konglo');
  assert.equal(runDate.reason, 'STALE_SNAPSHOT');
  assert.equal(runDate.snapshot_date_field, 'run_date');

  // Timestamp-only snapshots resolve to the Jakarta wall-clock date.
  const lateUtc = evaluate({ updated_at: '2026-09-23T20:00:00Z' }, '2026-09-24T04:00:00Z');
  assert.equal(lateUtc.snapshot_date, '2026-09-24', '23:00 UTC on the 23rd is 06:00 WIB on the 24th');
  assert.equal(lateUtc.fresh, true);
});

test('FR-K: the trading-session age helper is bounded and calendar-driven', () => {
  const holidays = calendar.getSeedHolidaySet();
  assert.equal(freshness.tradingSessionsBetween('2026-09-24', '2026-09-24', holidays), 0);
  assert.equal(freshness.tradingSessionsBetween('2026-09-24', '2026-09-25', holidays), 1);
  assert.equal(freshness.tradingSessionsBetween('2026-09-25', '2026-09-28', holidays), 1);
  assert.equal(freshness.tradingSessionsBetween('2026-09-24', '2026-09-30', holidays), 4);
});
