'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('api/sector-hot.js', 'utf8');

test('CRON_SECRET is accepted only from Bearer authorization, not query string', () => {
  const start = source.indexOf('function verifyCronSecret(req)');
  const end = source.indexOf('function isWithinNkRunWindow', start);
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /req\.query\.secret|querySecret/);
  assert.match(block, /authorization/);
  assert.match(block, /timingSafeEqual/);
});

test('shared daily-pick row builder populates DB lock identity when derivable', () => {
  const start = source.indexOf('function dailyPickInsertRowFromCandidate');
  const end = source.indexOf('function normalizeMonitorSourceValue', start);
  const block = source.slice(start, end);
  assert.match(block, /buildMonitorPlanIdentity/);
  assert.match(block, /row\.monitor_source = identity\.monitor_source/);
  assert.match(block, /row\.plan_lock_id = identity\.plan_lock_id/);
});
