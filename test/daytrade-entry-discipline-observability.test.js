'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeDayTradeEntryDiscipline } = require('../lib/daytrade-entry-discipline-observability');

test('summarizes status, executable and blocked counts', () => {
  const q = summarizeDayTradeEntryDiscipline([
    { entry_discipline_status: 'WITHIN_ENTRY_RANGE', entry_executable_now: true, entry_chase_pct: -1 },
    { entry_discipline_status: 'AT_OR_BELOW_ENTRY', entry_executable_now: true, entry_chase_pct: -2 },
    { entry_discipline_status: 'WAIT_PULLBACK', entry_executable_now: false, entry_chase_pct: 3 },
    { entry_discipline_status: 'ENTRY_UNVERIFIED', entry_executable_now: false, entry_chase_pct: null }
  ]);
  assert.equal(q.total_count, 4);
  assert.equal(q.executable_count, 2);
  assert.equal(q.blocked_count, 2);
  assert.equal(q.chased_count, 1);
  assert.equal(q.chased_pct, 25);
  assert.equal(q.by_status.WAIT_PULLBACK.count, 1);
  assert.equal(q.by_status.WAIT_PULLBACK.blocked_count, 1);
  assert.equal(q.by_status.WITHIN_ENTRY_RANGE.executable_count, 1);
});

test('empty input is stable and does not divide by zero', () => {
  const q = summarizeDayTradeEntryDiscipline([]);
  assert.equal(q.total_count, 0);
  assert.equal(q.executable_count, 0);
  assert.equal(q.blocked_count, 0);
  assert.equal(q.chased_pct, null);
  assert.equal(q.chase_pct_avg, null);
});

test('unknown or missing status fails into ENTRY_UNVERIFIED audit bucket', () => {
  const q = summarizeDayTradeEntryDiscipline([{ entry_executable_now: false }]);
  assert.equal(q.by_status.ENTRY_UNVERIFIED.count, 1);
  assert.equal(q.blocked_count, 1);
});
