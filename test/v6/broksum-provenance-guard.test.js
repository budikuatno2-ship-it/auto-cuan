'use strict';

/**
 * test/v6/broksum-provenance-guard.test.js
 * V6-F5b — provenance guard for the broker-summary datasets.
 *
 * Coverage required by the F5b scope:
 *   - stale date rejected
 *   - synthetic rejected
 *   - valid provider accepted
 *   - NO_TRADE rejected
 *   - null / 0 volume not silently accepted
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const provenance = require('../../lib/broksum-provenance');
const {
  isActionableBrokerDataset,
  isActionableForeignFlow,
  isActionableDomesticFlow,
  REJECT_REASONS
} = provenance;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A genuine provider ALL payload for a single session. */
function providerAll(date = '2026-11-13') {
  return {
    stock_code: 'BBRI',
    brokers: [
      { broker_code: 'CC', broker_name: 'MANDIRI SEKURITAS', bval: 976000, bvol: 400, bfrq: 1, sfrq: 0, sval: 0, svol: 0, nval: 976000, nvol: 400 },
      { broker_code: 'XC', broker_name: 'AJAIB SEKURITAS ASIA', bval: 2729800, bvol: 11500, bfrq: 4, sfrq: 0, sval: 0, svol: 0, nval: 2729800, nvol: 11500 }
    ],
    broker_levels: [],
    broker_start_date: date,
    broker_end_date: date,
    flow: 'all'
  };
}

/** A genuine provider F payload for a single session. */
function providerForeign(date = '2026-11-13') {
  return {
    stock_code: 'BBRI',
    brokers: [
      { broker_code: 'AK', broker_name: 'UBS SEKURITAS INDONESIA', bval: 500000, bvol: 200, sfrq: 0, sval: 0, svol: 0 }
    ],
    broker_levels: [],
    broker_start_date: date,
    broker_end_date: date,
    flow: 'F'
  };
}

/** A payload whose session window is an OLDER session than the one asked for. */
function stalePayload(date = '2026-11-12') {
  const p = providerAll(date);
  p.flow = 'all';
  return p;
}

/** A payload the repo derives locally from ALL (never a provider original). */
function syntheticPayload() {
  return {
    stock_code: 'BBRI',
    ticker: 'BBRI',
    date: '2026-11-13',
    flow: 'F',
    status: 'RELEASED',
    is_complete: false,
    provenance: 'DERIVED_LOCAL',
    computed_from: 'broker_code_heuristic_from_all',
    data_status: 'PARTIAL',
    brokers: [{ broker_code: 'AK', bval: 500000, bvol: 200, sval: 0, svol: 0 }],
    broker_levels: []
  };
}

/** A provider-released session with zero broker rows (a real non-trade). */
function noTradePayload(date = '2026-11-13') {
  return {
    stock_code: 'BBRI',
    brokers: [],
    broker_levels: [],
    broker_start_date: date,
    broker_end_date: date,
    flow: 'F'
  };
}

// ---------------------------------------------------------------------------
// 1. Valid provider payload is ACCEPTED
// ---------------------------------------------------------------------------
test('v6 broksum provenance: a genuine provider ALL payload is actionable', () => {
  const res = isActionableBrokerDataset({
    dataset: providerAll('2026-11-13'),
    date: '2026-11-13',
    ticker: 'BBRI',
    flow: 'ALL'
  });
  assert.equal(res.actionable, true, 'valid provider ALL must be actionable');
  assert.equal(res.reason, 'OK');
  assert.ok(res.flow.totalVol > 0, 'flow must expose the measured volume');
});

test('v6 broksum provenance: a genuine provider F payload is actionable', () => {
  const res = isActionableForeignFlow(providerForeign('2026-11-13'), {
    date: '2026-11-13',
    ticker: 'BBRI'
  });
  assert.equal(res.actionable, true);
  assert.equal(res.reason, 'OK');
});

test('v6 broksum provenance: a genuine provider D payload is actionable', () => {
  const d = {
    stock_code: 'BBRI',
    flow: 'D',
    status: 'RELEASED',
    data_asing_dirilis: true,
    date: '2026-11-13',
    broker_start_date: '2026-11-13',
    broker_end_date: '2026-11-13',
    brokers: [{ broker_code: 'CC', bval: 476000, bvol: 200, sval: 0, svol: 0 }],
    broker_levels: []
  };
  const res = isActionableDomesticFlow(d, { date: '2026-11-13', ticker: 'BBRI' });
  assert.equal(res.actionable, true);
  assert.equal(res.reason, 'OK');
});

// ---------------------------------------------------------------------------
// 2. STALE date rejected
// ---------------------------------------------------------------------------
test('v6 broksum provenance: a stale session date is rejected', () => {
  const res = isActionableBrokerDataset({
    dataset: stalePayload('2026-11-12'),
    date: '2026-11-13',
    flow: 'ALL'
  });
  assert.equal(res.actionable, false, 'stale payload must not be actionable');
  assert.equal(res.reason, REJECT_REASONS.DATE_MISMATCH);
});

test('v6 broksum provenance: a payload with a mismatched broker window is rejected', () => {
  const p = providerAll('2026-11-13');
  p.broker_start_date = '2026-11-10';
  p.broker_end_date = '2026-11-13';
  const res = isActionableBrokerDataset({ dataset: p, date: '2026-11-13', flow: 'ALL' });
  assert.equal(res.actionable, false);
  assert.equal(res.reason, REJECT_REASONS.DATE_MISMATCH);
});

test('v6 broksum provenance: a payload with no session window is rejected', () => {
  const p = providerAll('2026-11-13');
  delete p.broker_start_date;
  delete p.broker_end_date;
  delete p.date;
  const res = isActionableBrokerDataset({ dataset: p, date: '2026-11-13', flow: 'ALL' });
  assert.equal(res.actionable, false);
  assert.equal(res.reason, REJECT_REASONS.DATE_ABSENT);
});

// ---------------------------------------------------------------------------
// 3. SYNTHETIC rejected
// ---------------------------------------------------------------------------
test('v6 broksum provenance: a DERIVED_LOCAL (synthetic) foreign payload is rejected', () => {
  const res = isActionableBrokerDataset({
    dataset: syntheticPayload(),
    date: '2026-11-13',
    flow: 'F'
  });
  assert.equal(res.actionable, false, 'synthetic payload must not be actionable');
  assert.equal(res.reason, REJECT_REASONS.DERIVED_LOCAL);
});

test('v6 broksum provenance: a payload carrying computed_from is rejected as synthetic', () => {
  const p = providerForeign('2026-11-13');
  p.computed_from = 'broker_code_heuristic_from_all';
  const res = isActionableBrokerDataset({ dataset: p, date: '2026-11-13', flow: 'F' });
  assert.equal(res.actionable, false);
  assert.equal(res.reason, REJECT_REASONS.SYNTHETIC);
});

test('v6 broksum provenance: a LEGACY foreign payload is rejected', () => {
  const p = providerForeign('2026-11-13');
  p.status = 'LEGACY';
  const res = isActionableBrokerDataset({ dataset: p, date: '2026-11-13', flow: 'F' });
  assert.equal(res.actionable, false);
  assert.equal(res.reason, REJECT_REASONS.SYNTHETIC);
});

test('v6 broksum provenance: a fixture payload is rejected', () => {
  const p = providerForeign('2026-11-13');
  p.is_fixture = true;
  const res = isActionableBrokerDataset({ dataset: p, date: '2026-11-13', flow: 'F' });
  assert.equal(res.actionable, false);
  assert.equal(res.reason, REJECT_REASONS.FIXTURE);
});

// ---------------------------------------------------------------------------
// 4. NO_TRADE rejected (unless explicitly allowed)
// ---------------------------------------------------------------------------
test('v6 broksum provenance: a NO_TRADE session is rejected for flow purposes', () => {
  const res = isActionableBrokerDataset({
    dataset: noTradePayload('2026-11-13'),
    date: '2026-11-13',
    flow: 'F'
  });
  assert.equal(res.actionable, false, 'NO_TRADE must not be silently accepted as a flow');
  assert.equal(res.reason, REJECT_REASONS.NO_TRADE_FOR_FLOW);
});

test('v6 broksum provenance: a NO_TRADE session can be accepted when explicitly allowed', () => {
  const res = isActionableBrokerDataset({
    dataset: noTradePayload('2026-11-13'),
    date: '2026-11-13',
    flow: 'F',
    allowNoTrade: true
  });
  assert.equal(res.actionable, true);
  assert.equal(res.reason, 'NO_TRADE_ACCEPTED');
});

// ---------------------------------------------------------------------------
// 5. null / 0 volume not silently accepted
// ---------------------------------------------------------------------------
test('v6 broksum provenance: a null payload is rejected', () => {
  const res = isActionableBrokerDataset({ dataset: null, date: '2026-11-13', flow: 'ALL' });
  assert.equal(res.actionable, false);
  assert.equal(res.reason, REJECT_REASONS.MISSING_PAYLOAD);
});

test('v6 broksum provenance: an undefined payload is rejected', () => {
  const res = isActionableBrokerDataset({ dataset: undefined, date: '2026-11-13', flow: 'ALL' });
  assert.equal(res.actionable, false);
  assert.equal(res.reason, REJECT_REASONS.MISSING_PAYLOAD);
});

test('v6 broksum provenance: rows with null/zero volume are rejected', () => {
  const p = {
    stock_code: 'BBRI',
    flow: 'all',
    broker_start_date: '2026-11-13',
    broker_end_date: '2026-11-13',
    brokers: [
      { broker_code: 'CC', bval: null, bvol: null, sval: null, svol: null },
      { broker_code: 'XC', bval: 0, bvol: 0, sval: 0, svol: 0 }
    ],
    broker_levels: []
  };
  const res = isActionableBrokerDataset({ dataset: p, date: '2026-11-13', flow: 'ALL' });
  assert.equal(res.actionable, false, 'null/0 volume must not be silently accepted');
  assert.equal(res.reason, REJECT_REASONS.ZERO_VOLUME);
});

test('v6 broksum provenance: a non-object payload is rejected', () => {
  const res = isActionableBrokerDataset({ dataset: 'not-a-payload', date: '2026-11-13', flow: 'ALL' });
  assert.equal(res.actionable, false);
  assert.equal(res.reason, REJECT_REASONS.NOT_AN_OBJECT);
});

// ---------------------------------------------------------------------------
// 6. Additional guards
// ---------------------------------------------------------------------------
test('v6 broksum provenance: a foreign payload is rejected when used as an ALL dataset', () => {
  const res = isActionableBrokerDataset({
    dataset: providerForeign('2026-11-13'),
    date: '2026-11-13',
    flow: 'ALL'
  });
  assert.equal(res.actionable, false);
  assert.equal(res.reason, REJECT_REASONS.DATASET_MISMATCH);
});

test('v6 broksum provenance: an unreleased foreign payload is rejected', () => {
  const p = providerForeign('2026-11-13');
  p.status = 'FOREIGN_NOT_RELEASED';
  const res = isActionableBrokerDataset({ dataset: p, date: '2026-11-13', flow: 'F' });
  assert.equal(res.actionable, false);
  assert.equal(res.reason, REJECT_REASONS.FOREIGN_NOT_RELEASED);
});

test('v6 broksum provenance: a clipped-ALL payload is rejected as incomplete', () => {
  const p = providerAll('2026-11-13');
  p.status = 'ALL_CLIPPED_INCOMPLETE';
  const res = isActionableBrokerDataset({ dataset: p, date: '2026-11-13', flow: 'ALL' });
  assert.equal(res.actionable, false);
  assert.equal(res.reason, REJECT_REASONS.INCOMPLETE);
});

test('v6 broksum provenance: a ticker mismatch is rejected', () => {
  const res = isActionableBrokerDataset({
    dataset: providerAll('2026-11-13'),
    date: '2026-11-13',
    ticker: 'TLKM',
    flow: 'ALL'
  });
  assert.equal(res.actionable, false);
  assert.equal(res.reason, REJECT_REASONS.DATE_MISMATCH);
});

test('v6 broksum provenance: broker_levels-only payloads are measured correctly', () => {
  const p = {
    stock_code: 'BBRI',
    flow: 'all',
    broker_start_date: '2026-11-13',
    broker_end_date: '2026-11-13',
    brokers: [],
    broker_levels: [
      { buy: { broker_code: 'CC', bval: 100000, bvol: 100 }, sell: { broker_code: 'XC', sval: 50000, svol: 50 } }
    ]
  };
  const res = isActionableBrokerDataset({ dataset: p, date: '2026-11-13', flow: 'ALL' });
  assert.equal(res.actionable, true);
  assert.equal(res.flow.buyVal, 100000);
  assert.equal(res.flow.sellVal, 50000);
  assert.equal(res.flow.totalVol, 150);
});
