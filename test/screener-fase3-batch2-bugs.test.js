'use strict';

const assert = require('assert');
const tradePlanV2 = require('../lib/trade-plan-v2');
const candleEngine = require('../lib/candle-pattern-engine');
const intradayEngine = require('../lib/intraday-engine');

let failedCount = 0;
let passedCount = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passedCount++;
  } catch (err) {
    console.log(`FAIL: ${name} -> ${err.message}`);
    failedCount++;
    throw err;
  }
}

// BUG-F3-06: Coercion null pada evaluasi stop loss (stopLoss >= entryLow)
// Candidate hanya memiliki entry_high (1000), entryLow menjadi null.
// Stop loss 935 di bawah entry (1000) tidak boleh ditolak dengan STOP_NOT_BELOW_ENTRY.
runTest('BUG-F3-06: buildTradePlanV2 must not reject candidate below entryFloor as STOP_NOT_BELOW_ENTRY', () => {
  const planBug06 = tradePlanV2.buildTradePlanV2(
    { ticker: 'BBCA', entry_high: 1000, support: 950, atr14: 20 },
    { screener_type: 'SWING_NON_KONGLO' }
  );
  assert.notStrictEqual(planBug06.reject_reason, 'STOP_NOT_BELOW_ENTRY');
  assert.strictEqual(planBug06.stop_loss, 935);
});

// BUG-F3-07: Overhead resistance level menerima support bawah saat entryHigh bernilai null
// Candidate hanya menyuplai entry_low (1000), entryHigh menjadi null.
// Level 500 di bawah entry tidak boleh dipilih sebagai overhead resistance.
runTest('BUG-F3-07: buildTradePlanV2 must not select sub-entry level (500) as resistance', () => {
  const planBug07 = tradePlanV2.buildTradePlanV2(
    { ticker: 'BBRI', entry_low: 1000, support: 950, local_resistance: 500, atr14: 20 },
    { screener_type: 'SWING_NON_KONGLO' }
  );
  assert.notStrictEqual(planBug07.resistance, 500);
});

// BUG-F3-08: False reassurance SUPPORT_HOLDING saat penutupan harga di bawah garis support
// Bar ditutup di 99 (di bawah support 100), harus ditandai SUPPORT_WEAKENING bukan SUPPORT_HOLDING.
runTest('BUG-F3-08: deriveSupportTestState must mark close below support as SUPPORT_WEAKENING', () => {
  const supportStateBug08 = tradePlanV2.deriveSupportTestState({
    support: 100,
    bufferedSupport: 98,
    tolerance: 0,
    observations: [{ open: 105, high: 105, low: 99, close: 99 }]
  });
  assert.strictEqual(supportStateBug08.support_test_state, 'SUPPORT_WEAKENING');
  assert.notStrictEqual(supportStateBug08.support_test_state, 'SUPPORT_HOLDING');
});

// BUG-F3-09: Dead gate konfirmasi volume & support menghasilkan konfirmasi palsu ('Bullish confirmation')
// Candle bullish dengan volume sangat rendah (ratio 0.05) dan jauh dari support harus mengembalikan 'No confirmation'.
runTest('BUG-F3-09: detectPattern must return No confirmation when volume and support are absent', () => {
  const candleBug09 = candleEngine.detectPattern(
    [{ open: 100, high: 105, low: 99, close: 104, volume: 50 }],
    { volumeAvg20: 1000, support: 50 }
  );
  assert.strictEqual(candleBug09.confirmation, 'No confirmation');
});

// BUG-F3-10: Candle data korup berisi NaN ditetapkan sebagai 'Bearish candle' valid
// c0.open bernilai NaN harus ditolak oleh guard dan mengembalikan pola null (empty).
runTest('BUG-F3-10: detectPattern must reject NaN candle values without producing Bearish candle', () => {
  const candleBug10 = candleEngine.detectPattern(
    [{ open: NaN, high: 100, low: 90, close: 95, volume: 1000 }]
  );
  assert.strictEqual(candleBug10.pattern, null);
  assert.strictEqual(candleBug10.bias, null);
});

// BUG-F3-11: File lib/intraday-engine.js harus dapat dimuat tanpa error
runTest('BUG-F3-11: lib/intraday-engine must be resolvable and export valid module', () => {
  assert.ok(intradayEngine && typeof intradayEngine === 'object');
});

console.log(`\nFase 3 Batch 2 Test Summary: ${passedCount} passed, ${failedCount} failed.`);
