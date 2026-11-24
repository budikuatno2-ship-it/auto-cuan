'use strict';
// V6 RECOVERY TAHAP 2 — regression test: IHSG job is Yahoo ^JKSE, ZERO_QUOTA.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('ihsg catalog default uses Yahoo ^JKSE with ZERO_QUOTA, not Arjum history', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'admin-schedule-store.js'), 'utf8');
  const block = source.slice(source.indexOf("key: 'ihsg'"), source.indexOf("key: 'lifecycle'"));
  assert.match(block, /Yahoo Finance/);
  assert.match(block, /\^JKSE/);
  assert.match(block, /0 kuota Arjum/);
  assert.match(block, /defaultCostClass: 'ZERO_QUOTA'/);
  assert.doesNotMatch(block, /1 request Arjum history/);
  assert.doesNotMatch(block, /defaultCostClass: 'LOW'/);
});
