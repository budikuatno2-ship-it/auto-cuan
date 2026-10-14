'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bandarmologiService = require('../lib/bandarmologi-service');

test('normalizeBrokerSummary reconciles net flow with real BBCA broker data (foreign institutional subset)', () => {
  // Realistic BBCA trading session sample with foreign & domestic institutional brokers
  const bbcaSample = {
    stock_code: 'BBCA',
    date: '2026-10-12',
    brokers: [
      { broker: 'CC', broker_code: 'CC', broker_name: 'MANDIRI SEKURITAS', bval: 185400000000, sval: 43400000000, bvol: 195000, svol: 45600, net_val: 142000000000 },
      { broker: 'ZP', broker_code: 'ZP', broker_name: 'MAYBANK SEKURITAS', bval: 92300000000, sval: 13800000000, bvol: 97000, svol: 14500, net_val: 78500000000 },
      { broker: 'RX', broker_code: 'RX', broker_name: 'MACQUARIE SEKURITAS', bval: 64100000000, sval: 12900000000, bvol: 67400, svol: 13500, net_val: 51200000000 },
      { broker: 'AK', broker_code: 'AK', broker_name: 'UBS SEKURITAS', bval: 15200000000, sval: 110200000000, bvol: 16000, svol: 116000, net_val: -95000000000 },
      { broker: 'BK', broker_code: 'BK', broker_name: 'J.P. MORGAN SEKURITAS', bval: 12300000000, sval: 84300000000, bvol: 12900, svol: 88700, net_val: -72000000000 },
      { broker: 'KZ', broker_code: 'KZ', broker_name: 'CLSA SEKURITAS', bval: 7100000000, sval: 45600000000, bvol: 7400, svol: 48000, net_val: -38500000000 }
    ]
  };

  const normalized = bandarmologiService.normalizeBrokerSummary(bbcaSample, '2026-10-12', 'BBCA');
  assert.ok(normalized, 'Normalized broker summary should exist');

  // Reconciliation:
  // Foreign institutional whitelist (AK, BK, RX, KZ, ZP, CS, DB):
  // Foreign Buyers: ZP (+78.5 Mrd), RX (+51.2 Mrd) = +129.7 Mrd
  // Foreign Sellers: AK (-95.0 Mrd), BK (-72.0 Mrd), KZ (-38.5 Mrd) = -205.5 Mrd
  // Domestic Broker CC (Mandiri, +142 Mrd) is excluded from foreign institutional net flow
  // Net Foreign Institutional Flow = +129.7 Mrd - 205.5 Mrd = -75.8 Mrd (-75,800,000,000 IDR)
  const expectedForeignNet = -75800000000;
  assert.equal(normalized.net_flow, expectedForeignNet);
  assert.equal(normalized.total_net_flow, expectedForeignNet);

  // Unit must be explicit "Mrd", never ambiguous "M"
  assert.equal(normalized.net_flow_formatted, '-75.80 Mrd');
  assert.doesNotMatch(normalized.net_flow_formatted, /\sM$/);

  // Classification threshold check (|net| >= 5e9 => BIG_DISTRIBUTION)
  assert.equal(normalized.net_status, 'BIG_DISTRIBUTION');
  assert.equal(normalized.net_label, 'Big Distribution');
});

test('normalizeBrokerSummary reconciles net flow via top buyers and sellers when foreign subset is neutral', () => {
  // Pure domestic brokers session (no foreign institutional whitelist codes)
  const domesticSample = {
    stock_code: 'BBCA',
    date: '2026-10-12',
    top_buyers: [
      { broker: 'CC', broker_code: 'CC', bval: 50000000000, net_val: 40000000000 },
      { broker: 'NI', broker_code: 'NI', bval: 30000000000, net_val: 25000000000 }
    ],
    top_sellers: [
      { broker: 'PD', broker_code: 'PD', sval: 20000000000, net_val: -15000000000 }
    ]
  };

  const normalized = bandarmologiService.normalizeBrokerSummary(domesticSample, '2026-10-12', 'BBCA');
  assert.ok(normalized);
  // Net = (40 Mrd + 25 Mrd) - 15 Mrd = +50 Mrd (50,000,000,000 IDR)
  assert.equal(normalized.net_flow, 50000000000);
  assert.equal(normalized.net_flow_formatted, '+50.00 Mrd');
  assert.equal(normalized.net_status, 'BIG_ACCUMULATION');
  assert.equal(normalized.net_label, 'Big Accumulation');
});

test('normalizeBrokerSummary preserves precomputed net_flow when explicit', () => {
  const explicitSample = {
    stock_code: 'BBCA',
    date: '2026-10-12',
    net_flow: 12500000000,
    top_buyers: [],
    top_sellers: []
  };

  const normalized = bandarmologiService.normalizeBrokerSummary(explicitSample, '2026-10-12', 'BBCA');
  assert.equal(normalized.net_flow, 12500000000);
  assert.equal(normalized.net_flow_formatted, '+12.50 Mrd');
});
