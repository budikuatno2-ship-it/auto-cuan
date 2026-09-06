'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PositionSizing = require('../public/position-sizing-calculator');

test('PositionSizing.calculate - standard trade setup', () => {
  // Modal: Rp 10.000.000, Risk: 1% (= Rp 100.000)
  // Entry: 1.000, SL: 950 (delta = 50 per share = Rp 5.000 per lot)
  // TP1: 1.100 (+100 = Rp 10.000 per lot)
  // TP2: 1.200 (+200 = Rp 20.000 per lot)
  const res = PositionSizing.calculate({
    capital: 10000000,
    riskPct: 1.0,
    entry: 1000,
    sl: 950,
    tp1: 1100,
    tp2: 1200
  });

  assert.equal(res.isValid, true);
  assert.equal(res.deltaP, 50);
  assert.equal(res.riskPerLot, 5000);
  assert.equal(res.costPerLot, 100000);
  // Lots = 100.000 / 5.000 = 20 lot
  assert.equal(res.lots, 20);
  assert.equal(res.shares, 2000);
  assert.equal(res.positionValue, 2000000); // 20 lot * 100 * 1000 = Rp 2.000.000
  assert.equal(res.actualRiskIdr, 100000);  // 20 lot * 5.000 = Rp 100.000
  assert.equal(res.actualRiskPct, 1.0);
  assert.equal(res.profitTp1Idr, 200000);   // 20 lot * 10.000 = Rp 200.000
  assert.equal(res.profitTp1Pct, 2.0);
  assert.equal(res.profitTp2Idr, 400000);   // 20 lot * 20.000 = Rp 400.000
  assert.equal(res.profitTp2Pct, 4.0);
  assert.equal(res.cappedByCapital, false);
});

test('PositionSizing.calculate - capital cap constraint', () => {
  // Modal: Rp 2.000.000, Risk: 5% (= Rp 100.000)
  // Entry: 2.000, SL: 1.990 (delta = 10 per share = Rp 1.000 per lot)
  // Lot by risk = 100.000 / 1.000 = 100 lot (cost = 100 * 200.000 = Rp 20.000.000 > Capital)
  // Lot by capital = 2.000.000 / 200.000 = 10 lot
  const res = PositionSizing.calculate({
    capital: 2000000,
    riskPct: 5.0,
    entry: 2000,
    sl: 1990
  });

  assert.equal(res.isValid, true);
  assert.equal(res.lots, 10);
  assert.equal(res.positionValue, 2000000);
  assert.equal(res.cappedByCapital, true);
  assert.equal(res.actualRiskIdr, 10000); // 10 lot * 1.000 = Rp 10.000
});

test('PositionSizing.calculate - insufficient capital for 1 lot', () => {
  // Modal: Rp 500.000, Risk: 1% (= Rp 5.000)
  // Entry: 5.000, SL: 4.800 (delta = 200 -> Rp 20.000 per lot risk, cost = Rp 500.000 per lot)
  // Risk budget Rp 5.000 < Rp 20.000 risk per lot -> 0 lot
  const res = PositionSizing.calculate({
    capital: 500000,
    riskPct: 1.0,
    entry: 5000,
    sl: 4800
  });

  assert.equal(res.isValid, true);
  assert.equal(res.lots, 0);
  assert.equal(res.positionValue, 0);
  assert.equal(res.actualRiskIdr, 0);
});

test('PositionSizing.calculate - invalid entries (SL >= Entry)', () => {
  const res = PositionSizing.calculate({
    capital: 10000000,
    riskPct: 1.0,
    entry: 1000,
    sl: 1050
  });

  assert.equal(res.isValid, false);
  assert.match(res.reason, /lebih rendah/);
});

test('PositionSizing.calculate - zero or missing levels', () => {
  const res = PositionSizing.calculate({
    capital: 10000000,
    riskPct: 1.0,
    entry: 0,
    sl: 0
  });

  assert.equal(res.isValid, false);
  assert.match(res.reason, /belum valid/);
});
