'use strict';

const assert = require('assert');
const tradePlanV2 = require('../lib/trade-plan-v2');
const candleEngine = require('../lib/candle-pattern-engine');
const intradayEngine = require('../lib/intraday-engine');

// BUG-F3-06: Coercion null pada evaluasi stop loss (stopLoss >= entryLow)
// Candidate hanya memiliki entry_high (1000), entryLow menjadi null.
// 935 >= null dievaluasi sebagai 935 >= 0 (true), memicu penolakan STOP_NOT_BELOW_ENTRY.
const planBug06 = tradePlanV2.buildTradePlanV2(
  { ticker: 'BBCA', entry_high: 1000, support: 950, atr14: 20 },
  { screener_type: 'SWING_NON_KONGLO' }
);
assert.strictEqual(planBug06.status, 'REJECTED');
assert.strictEqual(planBug06.reject_reason, 'STOP_NOT_BELOW_ENTRY');

// BUG-F3-07: Overhead resistance level menerima support bawah saat entryHigh bernilai null
// Candidate hanya menyuplai entry_low (1000), entryHigh menjadi null.
// Level 500 > null dievaluasi 500 > 0 (true), sehingga level 500 dipilih sebagai resistance.
const planBug07 = tradePlanV2.buildTradePlanV2(
  { ticker: 'BBRI', entry_low: 1000, support: 950, local_resistance: 500, atr14: 20 },
  { screener_type: 'SWING_NON_KONGLO' }
);
assert.strictEqual(planBug07.resistance, 500);

// BUG-F3-08: False reassurance SUPPORT_HOLDING saat penutupan harga di bawah garis support
// Bar ditutup di 99 (di bawah support 100), namun karena masih di atas buffered 98,
// state fallback ke SUPPORT_HOLDING ("price holding above support").
const supportStateBug08 = tradePlanV2.deriveSupportTestState({
  support: 100,
  bufferedSupport: 98,
  tolerance: 0,
  observations: [{ open: 105, high: 105, low: 99, close: 99 }]
});
assert.strictEqual(supportStateBug08.support_test_state, 'SUPPORT_HOLDING');
assert.strictEqual(supportStateBug08.reason, 'price holding above support');

// BUG-F3-09: Dead gate konfirmasi volume & support menghasilkan konfirmasi palsu ('Bullish confirmation')
// Candle bullish dengan volume sangat rendah (ratio 0.05) dan jauh dari support
// tetap mengembalikan 'Bullish confirmation' karena return fallback tanpa syarat.
const candleBug09 = candleEngine.detectPattern(
  [{ open: 100, high: 105, low: 99, close: 104, volume: 50 }],
  { volumeAvg20: 1000, support: 50 }
);
assert.strictEqual(candleBug09.confirmation, 'Bullish confirmation');

// BUG-F3-10: Candle data korup berisi NaN ditetapkan sebagai 'Bearish candle' valid
// c0.open bernilai NaN lolos guard c0.open == null, menghasilkan pola Bearish candle.
const candleBug10 = candleEngine.detectPattern(
  [{ open: NaN, high: 100, low: 90, close: 95, volume: 1000 }]
);
assert.strictEqual(candleBug10.pattern, 'Bearish candle');
assert.strictEqual(candleBug10.bias, 'Bearish');

// BUG-F3-11: File lib/intraday-engine.js kosong (0 bytes / 0 exports)
// Module mengekspor objek kosong tanpa fungsi kalkulasi intraday.
assert.strictEqual(Object.keys(intradayEngine).length, 0);

console.log('Semua 6 reproduksi bug Fase 3 Batch 2 (BUG-F3-06 s/d BUG-F3-11) terbukti valid.');
