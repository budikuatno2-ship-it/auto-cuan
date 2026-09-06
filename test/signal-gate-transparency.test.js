'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const transparency = require('../public/signal-gate-transparency');

test('evaluateGates evaluates all 5 gates on strong setup', () => {
  const signal = {
    ticker: 'BBRI',
    last_price: 5200,
    ma20: 5050,
    rsi14: 62.5,
    volume_ratio_20d: 2.1,
    value_today: 45000000000,
    risk_reward: 2.3,
    status: 'READY_BREAKOUT',
    notes: 'Breakout resistance didukung akumulasi broker asing.'
  };

  const evalResult = transparency.evaluateGates(signal, 'daytrade');
  assert.equal(evalResult.totalCount, 5);
  assert.equal(evalResult.passedCount, 5);
  assert.equal(evalResult.allPassed, true);

  const gatesById = {};
  evalResult.gates.forEach(g => { gatesById[g.id] = g; });

  assert.equal(gatesById.liquidity.passed, true);
  assert.match(gatesById.liquidity.actual, /45.*M/);
  assert.equal(gatesById.volume.passed, true);
  assert.match(gatesById.volume.actual, /2.10x/);
  assert.equal(gatesById.trend.passed, true);
  assert.match(gatesById.trend.actual, /\+3.0% vs MA20/);
  assert.equal(gatesById.rsi.passed, true);
  assert.match(gatesById.rsi.actual, /62.5/);
  assert.equal(gatesById.rr.passed, true);
  assert.match(gatesById.rr.actual, /2.3/);
});

test('evaluateGates flags gates that do not meet thresholds', () => {
  const weakSignal = {
    ticker: 'WEAK',
    last_price: 1000,
    ma20: 1200, // Price is -16.7% below MA20 (fails trend)
    rsi14: 85,  // Overbought > 78 (fails RSI)
    volume_ratio_20d: 0.5, // Fails volume (< 1.2x)
    value_today: 500000000, // 500 Jt (< 3M DT min)
    risk_reward: 0.8 // Fails RR (< 1.2)
  };

  const evalResult = transparency.evaluateGates(weakSignal, 'daytrade');
  assert.equal(evalResult.totalCount, 5);
  assert.equal(evalResult.allPassed, false);
  assert.ok(evalResult.passedCount < 3);

  const gatesById = {};
  evalResult.gates.forEach(g => { gatesById[g.id] = g; });
  assert.equal(gatesById.trend.passed, false);
  assert.equal(gatesById.rsi.passed, false);
  assert.equal(gatesById.volume.passed, false);
});

test('renderDetailBox produces structured HTML checklist', () => {
  const signal = {
    ticker: 'BBRI',
    last_price: 5200,
    ma20: 5050,
    rsi14: 62.5,
    volume_ratio_20d: 2.1,
    value_today: 45000000000,
    risk_reward: 2.3,
    status: 'READY_BREAKOUT',
    notes: 'Breakout resistance didukung akumulasi broker asing.'
  };

  const html = transparency.renderDetailBox(signal, 'daytrade');
  assert.match(html, /Kenapa Sinyal Ini Lolos Gate\?/);
  assert.match(html, /5\/5 Gate Terpenuhi/);
  assert.match(html, /Likuiditas Transaksi/);
  assert.match(html, /Akumulasi Volume/);
  assert.match(html, /Tren Harga \(MA20\)/);
  assert.match(html, /Momentum RSI 14/);
  assert.match(html, /Risk \/ Reward Ratio/);
  assert.match(html, /Breakout resistance didukung akumulasi/);
});

test('renderCardButton produces trigger button and collapsible drawer', () => {
  const signal = {
    ticker: 'BBRI',
    last_price: 5200,
    ma20: 5050,
    rsi14: 62,
    volume_ratio_20d: 2.1,
    value_today: 45000000000,
    risk_reward: 2.3
  };

  const html = transparency.renderCardButton(signal, 'daytrade');
  assert.match(html, /Mengapa muncul\?/);
  assert.match(html, /acGateDrawer_BBRI/);
  assert.match(html, /ac-gate-drawer hidden/);
  assert.match(html, /Kriteria Lolos Seleksi/);
  assert.match(html, /Vol Ratio/);
});
