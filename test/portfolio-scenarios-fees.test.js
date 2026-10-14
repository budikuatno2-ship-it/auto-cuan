'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Calculator = require('../public/portfolio-position-scenarios');

test('Calculator.calculateScaleOutWithFees accurately computes gross, fees, and net for scale-out and break-even stop', () => {
  const result = Calculator.calculateScaleOutWithFees({
    entry: 1000,
    stop: 950,
    tp1: 1100,
    tp2: 1200,
    lots: 10,
    tp1Pct: 50,
    buyFeePct: 0.15,
    sellFeePct: 0.25
  });

  assert.equal(result.valid, true);
  assert.equal(result.totalShares, 1000);
  assert.equal(result.buyGross, 1000000);
  assert.equal(result.buyFee, 1500); // 1,000,000 * 0.15%

  // Stop Loss
  assert.equal(result.stopResultGross, -50000); // (950 - 1000) * 1000
  // sell fee: 950,000 * 0.25% = 2375. Total fee: 1500 + 2375 = 3875
  assert.equal(result.stopResultNet, -53875);

  // Pure TP1
  assert.equal(result.tp1ResultGross, 100000);
  // sell fee: 1,100,000 * 0.25% = 2750. Total fee: 1500 + 2750 = 4250
  assert.equal(result.tp1ResultNet, 95750);

  // Scale-out (50% TP1, 50% TP2)
  assert.equal(result.tp1Lots, 5);
  assert.equal(result.tp2Lots, 5);
  assert.equal(result.partialGross, 150000); // 50,000 + 100,000
  // buy fee: 1500. TP1 sell fee: 550,000 * 0.25% = 1375. TP2 sell fee: 600,000 * 0.25% = 1500. Total fee: 4375
  assert.equal(result.partialTotalFee, 4375);
  assert.equal(result.partialNet, 145625);

  // Break-Even Stop (50% TP1 @ 1100, 50% sisa exit @ 1000)
  assert.equal(result.breakEvenGross, 50000);
  // buy fee: 1500. TP1 sell fee: 1375. Entry sell fee: 500,000 * 0.25% = 1250. Total fee: 4125
  assert.equal(result.breakEvenTotalFee, 4125);
  assert.equal(result.breakEvenNet, 45875);
});

test('Calculator.calculateScaleOutWithFees handles custom user fee overrides', () => {
  const result = Calculator.calculateScaleOutWithFees({
    entry: 2000,
    stop: 1900,
    tp1: 2200,
    tp2: 2400,
    lots: 20,
    tp1Pct: 25,
    buyFeePct: 0.20, // 0.20%
    sellFeePct: 0.30  // 0.30%
  });

  assert.equal(result.valid, true);
  assert.equal(result.totalShares, 2000);
  assert.equal(result.buyGross, 4000000);
  assert.equal(result.buyFee, 8000); // 4,000,000 * 0.20%

  // 25% of 20 lots = 5 lots (500 shares) at TP1, 15 lots (1500 shares) at TP2
  assert.equal(result.tp1Lots, 5);
  assert.equal(result.tp2Lots, 15);
  const tp1Gross = (2200 - 2000) * 500; // 100,000
  const tp2Gross = (2400 - 2000) * 1500; // 600,000
  assert.equal(result.partialGross, tp1Gross + tp2Gross); // 700,000

  const tp1SellFee = 2200 * 500 * 0.003; // 3,300
  const tp2SellFee = 2400 * 1500 * 0.003; // 10,800
  const totalFee = 8000 + tp1SellFee + tp2SellFee; // 22,100
  assert.equal(result.partialTotalFee, totalFee);
  assert.equal(result.partialNet, 700000 - 22100);
});

test('Calculator.calculateScaleOutWithFees protects against inverted stop loss (stop > entry)', () => {
  const result = Calculator.calculateScaleOutWithFees({
    entry: 1000,
    stop: 1050, // Inverted!
    tp1: 1100,
    tp2: 1200,
    lots: 10
  });

  assert.equal(result.valid, true);
  assert.equal(result.stopResultGross, null);
  assert.equal(result.stopResultNet, null);
});

test('Calculator.calculateScaleOutWithFees handles zero or invalid input gracefully', () => {
  const empty = Calculator.calculateScaleOutWithFees(null);
  assert.equal(empty.valid, false);
  assert.equal(empty.buyGross, 0);
  assert.equal(empty.partialNet, null);

  const zeroLots = Calculator.calculateScaleOutWithFees({ entry: 1000, lots: 0 });
  assert.equal(zeroLots.valid, false);
});
