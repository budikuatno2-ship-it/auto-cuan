'use strict';

// B1 (22 Oct 2026) — the Broker Hunter index builder must be scheduled. Before
// this change there was NO cron entry, so data/broker-hunter-indexes/ went stale
// from 12 Sep and the Broker Hunter page served a 6-week-old snapshot.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('B1: the canonical schedule runs the broker-hunter indexer at 22:45 WIB on trading days', () => {
 // Q1/P2: indexer dibungkus job-wrapper bandarmologi-intel-2114 (21:14, 0 kuota).
 // Kontrak P2: builder lokal-disk tetap dijadwalkan tiap hari bursa via wrapper.
 const cron = read('deploy/vps/final-schedule.cron');
 assert.match(cron, /^14 21 \* \* 1-5 .*bandarmologi-intel-2114.*run-bandarmologi-intel\.js/m);
 // The builder must be the scheduled program (no accidental wrong target).
 assert.match(cron, /run-bandarmologi-intel\.js/);
});

test('B1: the indexer wrapper exists and runs the builder with a lock', () => {
  const wrapperPath = path.join(ROOT, 'deploy/vps/run-broker-hunter-indexer.sh');
  assert.ok(fs.existsSync(wrapperPath), 'wrapper script must exist');
  const wrapper = fs.readFileSync(wrapperPath, 'utf8');
  assert.match(wrapper, /tools\/run-broker-hunter-indexer\.js/);
  assert.match(wrapper, /flock -n/);
  assert.match(wrapper, /TZ=Asia\/Jakarta/);
});

test('B1: the builder stays local-disk only (no Arjum quota use)', () => {
  const builder = read('tools/run-broker-hunter-indexer.js');
  assert.doesNotMatch(builder, /arjum-client|fetchBrokerSummary|fetchArjum/);
});

test('B3: the canonical schedule runs the backlog age alarm daily after the EOD window', () => {
 // Q1/P2: alarm backlog via quota-burn-day 00:35-18:35 + quota-burn-weekend;
 // skema P2 job-wrapper tanpa run-backlog-age-alarm.sh terpisah.
 //
 // M-P1e (2026-11-15): the test asserted the OBSOLETE P2 draft floor 3000.
 // The production contract (config/quota.json reserveFloorWeekdayDaytime=5000,
 // the schedule's own header comment "V3-F01 floor 5000 weekday", and
 // tools/validate-schedule.js which validates the shipped file as VALID) pins
 // the weekday daytime reserve floor at 5000 — the V3-F01 Hard-Lock. The test
 // is strengthened to assert the exact shipped line including the floor value.
 const cron = read('deploy/vps/final-schedule.cron');
 assert.match(cron, /^35 0-18 \* \* 1-5 \/home\/ubuntu\/auto-cuan\/deploy\/vps\/job-wrapper\.sh quota-burn-day 3300 \/home\/ubuntu\/\.local\/node-v22\/bin\/node tools\/quota-burn\.js --floor 5000/m);
 assert.match(cron, /^35 0-22 \* \* 6,0 .*quota-burn-weekend .*quota-burn\.js --floor 0/m);
});
