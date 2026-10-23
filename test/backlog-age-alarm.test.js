'use strict';

// B3 (22 Oct 2026) — the H-1 refill backlog must raise an alert when it is older
// than 24h and NOT shrinking. The 19 Oct stall (50 filled, ~920 empty) alerted
// nobody. These tests pin the decision logic and the tool's marker reading.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const alarm = require('../lib/backlog-age-alarm');
const tool = require('../tools/check-backlog-age');

const HOUR = 3600000;

test('B3: no alert when there is no backlog', () => {
  const d = alarm.evaluate({ now: Date.now(), pendingCount: 0, firstSeenAt: new Date(Date.now() - 72 * HOUR).toISOString() });
  assert.equal(d.shouldAlert, false);
  assert.equal(d.reason, 'no_backlog');
});

test('B3: no alert while the backlog is still young (<24h)', () => {
  const now = Date.now();
  const d = alarm.evaluate({ now, pendingCount: 900, firstSeenAt: new Date(now - 6 * HOUR).toISOString(), previousPending: 900 });
  assert.equal(d.shouldAlert, false);
  assert.equal(d.reason, 'still_young');
});

test('B3: no alert when the backlog is old but DECREASING (queue is draining)', () => {
  const now = Date.now();
  const d = alarm.evaluate({ now, pendingCount: 800, previousPending: 900, firstSeenAt: new Date(now - 30 * HOUR).toISOString() });
  assert.equal(d.shouldAlert, false);
  assert.equal(d.reason, 'decreasing');
});

test('B3: alert when the backlog is old AND not shrinking', () => {
  const now = Date.now();
  const d = alarm.evaluate({ now, pendingCount: 920, previousPending: 920, firstSeenAt: new Date(now - 30 * HOUR).toISOString() });
  assert.equal(d.shouldAlert, true);
  assert.equal(d.reason, 'stale_not_decreasing');
  assert.ok(d.ageHours >= 24);
});

test('B3: alert fires at most once per WIB day', () => {
  const now = Date.now();
  const base = { now, pendingCount: 920, previousPending: 920, firstSeenAt: new Date(now - 30 * HOUR).toISOString() };
  const first = alarm.evaluate(Object.assign({}, base, { nowWibDay: '2026-10-23' }));
  assert.equal(first.shouldAlert, true);
  const second = alarm.evaluate(Object.assign({}, base, { nowWibDay: '2026-10-23', lastAlertDay: '2026-10-23', lastAlertAt: now - 60000 }));
  assert.equal(second.shouldAlert, false);
  assert.equal(second.reason, 'already_alerted_today');
});

test('B3: message contains the pending/total counts and the age, no secrets', () => {
  const msg = alarm.buildMessage({ pendingCount: 920, totalTickers: 970, ageHours: 31, staleHours: 24, reason: 'stale_not_decreasing' });
  assert.match(msg, /920 \/ 970/);
  assert.match(msg, /31 jam/);
  assert.doesNotMatch(msg, /token|secret|168\.\d|password/i);
});

test('B3: the tool reports a stalled backlog and records Admin-Console state from real markers', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-alarm-'));
  const dataDir = path.join(tmp, 'arjum-data');
  const markers = path.join(dataDir, '_daily-update-marker');
  fs.mkdirSync(markers, { recursive: true });
  // Two recent markers: the newest is stalled (pending unchanged).
  fs.writeFileSync(path.join(markers, '2026-10-20.json'), JSON.stringify({ complete: false, pending: 921, total_tickers: 970 }));
  fs.writeFileSync(path.join(markers, '2026-10-21.json'), JSON.stringify({ complete: false, pending: 920, total_tickers: 970 }));
  const state = path.join(tmp, 'backlog-age-alarm.json');
  const now = Date.parse('2026-10-23T12:00:00Z');

  const env = { ARJUM_DATA_DIR: dataDir, BACKLOG_ALARM_STATE: state, BACKLOG_ALARM_NOW_MS: String(now) };

  // First sighting records the episode start but does not alert yet.
  const first = await tool.run([], env);
  assert.equal(first.pending, 920);
  assert.equal(first.alerted, false);
  // Simulate 30h later with the SAME pending count -> should alert.
  const laterEnv = Object.assign({}, env, { BACKLOG_ALARM_NOW_MS: String(now + 30 * HOUR) });
  const later = await tool.run([], laterEnv);
  assert.equal(later.pending, 920);
  assert.equal(later.reason, 'stale_not_decreasing');

  const persisted = JSON.parse(fs.readFileSync(state, 'utf8'));
  assert.equal(persisted.pending, 920);
  assert.equal(persisted.target_date, '2026-10-21');
  fs.rmSync(tmp, { recursive: true, force: true });
});
