'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sectorHot = require('../api/sector-hot.js');
const { evaluateMonitorStatus } = sectorHot.__test;

const NOW = new Date().toISOString();

test('Finding #4: active RUNNING position with price +6% above entryHigh (below TP1) is NOT expired', function () {
  const pick = {
    ticker: 'ASII',
    status: 'RUNNING',
    is_final: false,
    entry1: 1000,
    entry2: 980,
    tp1: 1080,
    tp2: 1150,
    sl: 950,
    hit_entry_at: NOW,
    first_sent_at: NOW,
    created_at: NOW,
    raw_payload: { monitor_source: 'swing_konglo' }
  };

  const px = {
    last: 1060,
    open: 1000,
    high: 1060,
    low: 1000,
    at: NOW,
    bestEffort: false,
    source: 'daytrade_screener_latest'
  };

  const ev = evaluateMonitorStatus(pick, px);
  assert.equal(ev.status, 'RUNNING', 'Active position must remain RUNNING, not EXPIRED');
  assert.equal(ev.isFinal, false, 'Must not be final');
  assert.ok(/menuju TP1/i.test(ev.note) || /Posisi aktif/i.test(ev.note), 'Note indicates active tracking');
});

test('Finding #4: pre-entry setup (not yet entered) with price > entryHigh * 1.05 IS expired (runaway price)', function () {
  const pick = {
    ticker: 'BBRI',
    status: 'WAITING',
    is_final: false,
    entry1: 1000,
    entry2: 980,
    tp1: 1080,
    tp2: 1150,
    sl: 950,
    hit_entry_at: null,
    first_sent_at: NOW,
    created_at: NOW,
    raw_payload: { monitor_source: 'swing_konglo' }
  };

  const px = {
    last: 1060,
    open: 1055,
    high: 1065,
    low: 1055,
    at: NOW,
    bestEffort: false,
    source: 'daytrade_screener_latest'
  };

  const ev = evaluateMonitorStatus(pick, px);
  assert.equal(ev.status, 'EXPIRED', 'Unentered setup with runaway price must be EXPIRED');
  assert.equal(ev.isFinal, false);
  assert.ok(/terlalu jauh/i.test(ev.note), 'Note indicates price too far from entry');
});

test('Finding #4: active position correctly hits TP1 when price reaches tp1 level', function () {
  const pick = {
    ticker: 'ASII',
    status: 'RUNNING',
    is_final: false,
    entry1: 1000,
    entry2: 980,
    tp1: 1080,
    tp2: 1150,
    sl: 950,
    hit_entry_at: NOW,
    first_sent_at: NOW,
    created_at: NOW,
    raw_payload: { monitor_source: 'swing_konglo' }
  };

  const px = {
    last: 1085,
    open: 1050,
    high: 1090,
    low: 1050,
    at: NOW,
    bestEffort: false,
    source: 'daytrade_screener_latest'
  };

  const ev = evaluateMonitorStatus(pick, px);
  assert.equal(ev.status, 'TP1_HIT', 'Must detect TP1 hit');
  assert.equal(ev.isFinal, false, 'TP1 is not final (keeps tracking for TP2)');
});
