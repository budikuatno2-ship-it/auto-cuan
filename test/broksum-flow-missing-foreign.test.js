'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeDomestic } = require('../lib/broksum-flow');

test('BUG-01: Domestic flow returns incomplete when foreign data is missing or incomplete', async (t) => {
  const dummyAll = {
    stock_code: 'BBRI',
    broker_start_date: '2026-10-23',
    broker_end_date: '2026-10-23',
    flow: 'all',
    all_data: true,
    brokers: [
      { broker_code: 'CC', bval: 5000000000, sval: 2000000000, bvol: 50000, svol: 20000, bfrq: 100, sfrq: 40 },
      { broker_code: 'YP', bval: 3000000000, sval: 4000000000, bvol: 30000, svol: 40000, bfrq: 60, sfrq: 80 }
    ],
    broker_levels: [
      {
        buy: { broker_code: 'CC', bval: 5000000000, bvol: 50000, bfrq: 100 },
        sell: { broker_code: 'YP', sval: 4000000000, svol: 40000, sfrq: 80 }
      }
    ]
  };

  await t.test('returns { flow: "D", is_complete: false, status: "foreign_missing", data: null } when foreignBroksum is null', () => {
    const result = computeDomestic(dummyAll, null);

    assert.equal(result.flow, 'D');
    assert.equal(result.is_complete, false, 'is_complete must be false when foreign is missing');
    assert.equal(result.status, 'foreign_missing');
    assert.equal(result.data, null);
    assert.ok(result.brokers === undefined || (Array.isArray(result.brokers) && result.brokers.length === 0), 'Must not copy all brokers to domestic');
  });

  await t.test('returns incomplete when foreignBroksum is undefined', () => {
    const result = computeDomestic(dummyAll, undefined);

    assert.equal(result.flow, 'D');
    assert.equal(result.is_complete, false);
    assert.equal(result.status, 'foreign_missing');
    assert.equal(result.data, null);
  });

  await t.test('returns incomplete when foreignBroksum has incomplete status or missing broker arrays', () => {
    const resultIncomplete = computeDomestic(dummyAll, { flow: 'F', status: 'foreign_missing' });
    assert.equal(resultIncomplete.flow, 'D');
    assert.equal(resultIncomplete.is_complete, false);
    assert.equal(resultIncomplete.status, 'foreign_missing');
    assert.equal(resultIncomplete.data, null);

    const resultEmptyObj = computeDomestic(dummyAll, {});
    assert.equal(resultEmptyObj.flow, 'D');
    assert.equal(resultEmptyObj.is_complete, false);
    assert.equal(resultEmptyObj.status, 'foreign_missing');
    assert.equal(resultEmptyObj.data, null);
  });

  await t.test('does not fake allBroksum values as domestic (flow != D with is_complete: true)', () => {
    const result = computeDomestic(dummyAll, null);
    // Crucial check: verify that ALL values are NOT surfaced as complete domestic data
    assert.notEqual(result.is_complete, true);
    assert.notEqual(result.status, 'complete');
  });
});
