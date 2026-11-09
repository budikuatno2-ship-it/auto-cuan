'use strict';
const test = require('node:test');
const assert = require('node:assert');

const {
  FOREIGN_SET,
  classifyForeignRecord,
  normalizeLegacyForeign,
  summarizeBrokerRows
} = require('../../lib/legacy-foreign-adapter');

// Sanitized fixture mirroring the REAL schema shape observed on VPS:
// BBCA broker-summary-F/2026-10-30.json -> flow:"F", brokers[] (mixed domestic+foreign),
// broker_levels[] present, NO foreign_net/net_flow/top_buyers.
const MIXED_LEGACY_FIXTURE = {
  stock_code: 'BBCA',
  brokers: [
    { broker_code: 'BK', broker_name: 'J.P. MORGAN SEKURITAS', bval: 232420368000, bvol: 46751900, sval: 85679052500, svol: 17241400, nval: 146741315500, nvol: 29510500 },
    { broker_code: 'CC', broker_name: 'MANDIRI SEKURITAS', bval: 67023386000, bvol: 13521600, sval: 49103761500, svol: 9905700, nval: 17919624500, nvol: 3615900 },
    { broker_code: 'AK', broker_name: 'UBS SEKURITAS', bval: 232055742000, bvol: 46752900, sval: 177377345000, svol: 35748900, nval: 54678397000, nvol: 11004000 }
  ],
  broker_levels: [],
  broker_start_date: '2026-10-30',
  broker_end_date: '2026-10-30',
  broker_date_min: '2020-01-02',
  broker_date_max: '2026-10-30',
  broker_net: false,
  flow: 'F'
};

const MODERN_FIXTURE = {
  stock_code: 'BBCA',
  date: '2026-11-02',
  flow: 'F',
  status: 'RELEASED',
  is_complete: true,
  brokers: [{ broker_code: 'EP', bval: 10, sval: 5, nval: 5 }],
  foreign_net: 5,
  net_flow: 5,
  top_buyers: [{ broker_code: 'EP' }]
};

const EMPTY_FIXTURE = { stock_code: 'BBCA', brokers: [], broker_levels: [], flow: 'F', broker_net: false };

test('classify: modern RELEASED record -> MODERN', () => {
  assert.strictEqual(classifyForeignRecord(MODERN_FIXTURE), 'MODERN');
});

test('classify: mixed legacy (domestic + foreign, no foreign decomposition) -> LEGACY_BROKSUM_MIXED', () => {
  assert.strictEqual(classifyForeignRecord(MIXED_LEGACY_FIXTURE), 'LEGACY_BROKSUM_MIXED');
});

test('classify: foreign-only legacy -> LEGACY_FOREIGN_ONLY', () => {
  const fOnly = { ...MIXED_LEGACY_FIXTURE, brokers: MIXED_LEGACY_FIXTURE.brokers.filter(b => FOREIGN_SET.has(b.broker_code)) };
  assert.strictEqual(classifyForeignRecord(fOnly), 'LEGACY_FOREIGN_ONLY');
});

test('classify: empty legacy -> EMPTY', () => {
  assert.strictEqual(classifyForeignRecord(EMPTY_FIXTURE), 'EMPTY');
});

test('classify: garbage -> INVALID', () => {
  assert.strictEqual(classifyForeignRecord(null), 'INVALID');
});

test('normalizeLegacyForeign: NEVER fabricates foreign_net (stays null + NOT_PUBLISHED)', () => {
  const out = normalizeLegacyForeign(MIXED_LEGACY_FIXTURE, { requestedDate: '2026-10-30' });
  assert.strictEqual(out.foreign_net, null);
  assert.strictEqual(out.net_flow, null);
  assert.strictEqual(out.foreign_net_val, null);
  assert.strictEqual(out.broker_net, null);
  assert.strictEqual(out.foreign_net_status, 'NOT_PUBLISHED');
  assert.strictEqual(out.status, 'LEGACY');
  assert.strictEqual(out.is_complete, false);
  assert.strictEqual(out.data_status, 'PARTIAL');
});

test('normalizeLegacyForeign: foreign_brokers is a strict FOREIGN_SET subset (no invented rows)', () => {
  const out = normalizeLegacyForeign(MIXED_LEGACY_FIXTURE, { requestedDate: '2026-10-30' });
  assert.deepStrictEqual(out.foreign_brokers.map(b => b.broker_code), ['BK', 'AK']);
  // 'CC' (domestic) must NOT appear in foreign-only subset
  assert.ok(!out.foreign_brokers.some(b => b.broker_code === 'CC'));
});

test('normalizeLegacyForeign: real broker rows preserved verbatim (count + values)', () => {
  const out = normalizeLegacyForeign(MIXED_LEGACY_FIXTURE, { requestedDate: '2026-10-30' });
  assert.strictEqual(out.brokers.length, 3);
  assert.strictEqual(out.brokers[0].bval, 232420368000);
  assert.strictEqual(out.brokers[1].bval, 67023386000);
});

test('normalizeLegacyForeign: derived totals come ONLY from real broker values', () => {
  const out = normalizeLegacyForeign(MIXED_LEGACY_FIXTURE, { requestedDate: '2026-10-30' });
  assert.strictEqual(out.total_buy_val, 232420368000 + 67023386000 + 232055742000);
  assert.strictEqual(out.total_sell_val, 85679052500 + 49103761500 + 177377345000);
});

test('summarizeBrokerRows: dedupes brokers across brokers[] and broker_levels[]', () => {
  const payload = {
    brokers: [{ broker_code: 'BK', bval: 100, sval: 50 }],
    broker_levels: [
      { buy: { broker_code: 'BK', bval: 100, sval: 0 }, sell: null },
      { buy: { broker_code: 'EP', bval: 25, sval: 0 }, sell: { broker_code: 'EP', bval: 0, sval: 10 } }
    ]
  };
  const info = summarizeBrokerRows(payload);
  assert.deepStrictEqual(info.brokers.map(b => b.broker_code), ['BK', 'EP']);
  assert.strictEqual(info.totalBuy, 125);
  assert.strictEqual(info.totalSell, 60);
});