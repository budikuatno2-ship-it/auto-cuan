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
  const cron = read('deploy/vps/final-schedule.cron');
  assert.match(cron, /^45 22 \* \* 1-5 .*run-broker-hunter-indexer\.sh/m);
  // The builder must be the scheduled program (no accidental wrong target).
  assert.match(cron, /run-broker-hunter-indexer\.sh/);
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
  const cron = read('deploy/vps/final-schedule.cron');
  assert.match(cron, /^45 19 \* \* 1-5 .*run-backlog-age-alarm\.sh/m);
});
