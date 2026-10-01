'use strict';

// Regression: the public share view ranked Day Trade rows with
//   (statusPri[a.status] || 10) - (statusPri[b.status] || 10)
// and A_PLUS_SETUP has priority 0. `0 || 10` is 10 — the fallback reserved for
// statuses the table does not recognise — so the highest-conviction rows sorted
// below every AVOID row. The displayed order contradicted the ranking it
// claimed to present.
//
// This test extracts the real priority table and the real comparator out of
// public/index.html and exercises them, so it asserts on behaviour rather than
// on the presence of a string.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');

function loadShareComparator() {
  const source = fs.readFileSync(INDEX, 'utf8');

  const priorityMatch = source.match(/var statusPri = (\{[^}]*'A_PLUS_SETUP'[^}]*\});/);
  assert.ok(priorityMatch, 'statusPri table not found in public/index.html');

  const comparatorMatch = source.match(
    /\.sort\((function\s*\(a, b\)\s*\{\s*return \(statusPri\[[\s\S]*?\);\s*\})\)/
  );
  assert.ok(comparatorMatch, 'share-view sort comparator not found in public/index.html');

  const context = vm.createContext({});
  vm.runInContext('var statusPri = ' + priorityMatch[1] + ';', context, { filename: 'statusPri' });
  return vm.runInContext('(' + comparatorMatch[1] + ')', context, { filename: 'comparator' });
}

function rank(rows) {
  return rows.slice().sort(loadShareComparator()).map(function (row) { return row.status; });
}

test('A_PLUS_SETUP outranks every other status', () => {
  const order = rank([
    { status: 'AVOID', daytrade_score: 90 },
    { status: 'WAIT_PULLBACK', daytrade_score: 80 },
    { status: 'A_PLUS_SETUP', daytrade_score: 70 },
    { status: 'TRADE_CANDIDATE', daytrade_score: 85 }
  ]);

  assert.equal(order[0], 'A_PLUS_SETUP');
  assert.deepEqual(order, ['A_PLUS_SETUP', 'TRADE_CANDIDATE', 'WAIT_PULLBACK', 'AVOID']);
});

test('A_PLUS_SETUP outranks AVOID even when AVOID carries the higher score', () => {
  const order = rank([
    { status: 'AVOID', daytrade_score: 99 },
    { status: 'A_PLUS_SETUP', daytrade_score: 1 }
  ]);

  assert.deepEqual(order, ['A_PLUS_SETUP', 'AVOID']);
});

test('an unrecognised status sorts below every known status', () => {
  const order = rank([
    { status: 'SOMETHING_NEW', daytrade_score: 99 },
    { status: 'AVOID', daytrade_score: 1 },
    { status: 'A_PLUS_SETUP', daytrade_score: 50 }
  ]);

  assert.deepEqual(order, ['A_PLUS_SETUP', 'AVOID', 'SOMETHING_NEW']);
});

test('rows sharing a status fall back to descending day trade score', () => {
  const order = rank([
    { status: 'A_PLUS_SETUP', daytrade_score: 60 },
    { status: 'A_PLUS_SETUP', daytrade_score: 95 }
  ]).length;

  const scores = [
    { status: 'A_PLUS_SETUP', daytrade_score: 60 },
    { status: 'A_PLUS_SETUP', daytrade_score: 95 }
  ].sort(loadShareComparator()).map(function (row) { return row.daytrade_score; });

  assert.equal(order, 2);
  assert.deepEqual(scores, [95, 60]);
});
