'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../api/sector-hot'), 'utf8');
const start = source.indexOf('async function finalizeDtScreener');
const end = source.indexOf('function getDtRunningStartedAt', start);
const finalizer = source.slice(start, end);

test('Day Trade finalizer reads only persisted columns and surfaces database errors', () => {
  assert.match(finalizer, /select\('ticker, daytrade_score, status'\)/);
  assert.doesNotMatch(finalizer, /select\([^\n]*action_label/);
  assert.match(finalizer, /if \(readErr\)/);
  assert.match(finalizer, /daytrade_finalize_read_failed/);
  assert.match(finalizer, /daytrade_finalize_trim_failed/);
  assert.match(finalizer, /var actionLabelDistribution = \{\};/);
});
