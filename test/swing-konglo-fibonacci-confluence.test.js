'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fibConfluence = require('../lib/fibonacci-confluence');
const idxTick = require('../lib/idx-tick-normalization');
const sectorHot = require('../api/sector-hot');

const {
  candidatePassesTelegramCandidateDigestGate,
  formatRichTelegramCandidateBlock,
  fmtTelegramSignalBlock,
  formatSwingTelegramMessage
} = sectorHot.__test;

// ============================================================
// HELPER: build candles with uptrend then pullback for Fib testing
// Uses explicit swing points that the algorithm can clearly detect
// ============================================================
function buildCandlesWithSwingPoints(swingLow, swingHigh, currentPrice, candleCount) {
  candleCount = candleCount || 60;
  var candles = [];
  var swingLowIdx = 10; // Clear swing low early
  var swingHighIdx = candleCount - 15; // Clear swing high before end
  var range = swingHigh - swingLow;

  for (var i = 0; i < candleCount; i++) {
    var price;
    if (i < swingLowIdx) {
      // Pre-swing-low: prices slightly above swing low (descending into it)
      price = swingLow + range * 0.15 - (range * 0.15 * (i / swingLowIdx));
    } else if (i === swingLowIdx) {
      // Swing low candle
      price = swingLow;
    } else if (i <= swingHighIdx) {
      // Uptrend from swing low to swing high
      var upProgress = (i - swingLowIdx) / (swingHighIdx - swingLowIdx);
      price = swingLow + range * upProgress;
    } else {
      // Pullback from swing high to current
      var downProgress = (i - swingHighIdx) / (candleCount - 1 - swingHighIdx);
      price = swingHigh - (swingHigh - currentPrice) * downProgress;
    }

    var vol = range * 0.008; // Small volatility
    candles.push({
      open: price,
      high: price + vol,
      low: price - vol,
      close: price + vol * 0.5,
      volume: 1000000
    });
  }

  // Make swing low point clearly lower than neighbors (wing=3)
  for (var a = swingLowIdx - 3; a < swingLowIdx; a++) {
    if (a >= 0) candles[a].low = swingLow + range * 0.05;
  }
  for (var b = swingLowIdx + 1; b <= swingLowIdx + 3; b++) {
    if (b < candleCount) candles[b].low = swingLow + range * 0.05;
  }
  candles[swingLowIdx].low = swingLow;
  candles[swingLowIdx].close = swingLow + vol;

  // Make swing high point clearly higher than neighbors (wing=3)
  for (var c = swingHighIdx - 3; c < swingHighIdx; c++) {
    if (c >= 0) candles[c].high = swingHigh - range * 0.05;
  }
  for (var d = swingHighIdx + 1; d <= swingHighIdx + 3; d++) {
    if (d < candleCount) candles[d].high = swingHigh - range * 0.05;
  }
  candles[swingHighIdx].high = swingHigh;
  candles[swingHighIdx].close = swingHigh - vol;

  // Last candle at current price
  var lastIdx = candles.length - 1;
  candles[lastIdx].close = currentPrice;
  candles[lastIdx].high = currentPrice + vol;
  candles[lastIdx].low = currentPrice - vol;
  candles[lastIdx].open = currentPrice;

  return candles;
}

// Base swing candidate with valid plan
function validSwingCandidate(overrides) {
  return Object.assign({
    ticker: 'BBRI', category: 'Swing Konglo', status: 'Watchlist', final_status: 'Watchlist',
    score: 72, daily_score: 72, risk_reward: 1.8,
    entry_low: 4600, entry_high: 4700, entry1: 4600, entry2: 4700,
    stop_loss: 4400, sl: 4400, tp1: 5100, tp1n: 5100, tp2: 5400, tp2n: 5400,
    last_price: 4650, lastn: 4650, volume_ratio_20d: 1.1, volume_ratio_avg20: 1.1,
    value_today: 5000000000, tx_value_1d: 5000000000, avg_tx_value_7d: 5000000000,
    trading_plan_valid: true, plan_quality_status: 'VALID',
    risk_label: 'Medium Risk', risk_label_v2: 'Medium Risk',
    support: 4400, resistance: 5200,
    telegram_verdict: 'Potensi swing moderat.'
  }, overrides || {});
}

// ============================================================
// TEST 1: Candidate near Fib 38.2-61.8 + valid plan => passes digest gate and exposes "Fib confluence sehat"
// ============================================================
test('Fib confluence sehat: candidate near Fib 38.2-61.8 with valid plan passes digest gate', function() {
  // swing high=5200, swing low=4200, range=1000
  // fib_382 = 5200 - 1000*0.382 = 4818
  // fib_618 = 5200 - 1000*0.618 = 4582
  // Price at 4700 is between fib_382(~4820) and fib_618(~4580) => healthy zone
  var candles = buildCandlesWithSwingPoints(4200, 5200, 4700, 60);
  var candidate = { last_price: 4700, entry_low: 4650, entry_high: 4750, support: 4200 };

  var result = fibConfluence.evaluateFibConfluence(candles, candidate);

  assert.equal(result.fib_confluence_status, 'confluence_sehat');
  assert.equal(result.fib_confluence_label, 'Fib confluence sehat');
  assert.ok(result.fib_confluence_note.indexOf('38.2') >= 0 || result.fib_confluence_note.indexOf('Fib') >= 0);
  assert.ok(result.fib_levels !== null);
  assert.ok(result.fib_levels.fib_382 > 0);
  assert.ok(result.fib_levels.fib_500 > 0);
  assert.ok(result.fib_levels.fib_618 > 0);

  // Candidate with fib should still pass digest gate (fib is NOT a blocker)
  var fullCandidate = validSwingCandidate({
    last_price: 4700,
    entry_low: 4650, entry_high: 4750,
    fib_confluence_status: result.fib_confluence_status,
    fib_confluence_label: result.fib_confluence_label,
    fib_confluence_note: result.fib_confluence_note
  });
  var gateResult = candidatePassesTelegramCandidateDigestGate(fullCandidate, 'swing_konglo_auto');
  assert.equal(gateResult, true, 'Fib confluence sehat candidate must pass digest gate');
});

// ============================================================
// TEST 2: Candidate above ideal Fib area => still appears with "Di atas area Fib" warning/note
// ============================================================
test('Di atas area Fib: candidate above ideal Fib area still appears with warning', function() {
  // swing high=5200, swing low=4200, range=1000
  // fib_382 = 5200 - 1000*0.382 = 4818
  // Price at 5050 > fib_382 => above ideal area
  var candles = buildCandlesWithSwingPoints(4200, 5200, 5050, 60);
  var candidate = { last_price: 5050, entry_low: 5000, entry_high: 5100, support: 4800 };

  var result = fibConfluence.evaluateFibConfluence(candles, candidate);

  assert.equal(result.fib_confluence_status, 'di_atas_fib');
  assert.equal(result.fib_confluence_label, 'Di atas area Fib');
  assert.ok(result.fib_confluence_note.indexOf('tunggu pullback') >= 0 || result.fib_confluence_note.indexOf('di atas') >= 0);

  // Candidate must still pass digest gate — fib is NOT a hard gate.
  // TP1/TP2 raised above the entry range so the candidate keeps a valid positive
  // upside (conservative entry = entry_high = 5100); otherwise the min-upside gate
  // correctly rejects a 0%-upside plan and this would not exercise the fib path.
  var fullCandidate = validSwingCandidate({
    last_price: 5050,
    entry_low: 5000, entry_high: 5100,
    tp1: 5600, tp1n: 5600, tp2: 5900, tp2n: 5900,
    fib_confluence_status: result.fib_confluence_status,
    fib_confluence_label: result.fib_confluence_label
  });
  var gateResult = candidatePassesTelegramCandidateDigestGate(fullCandidate, 'swing_konglo_auto');
  assert.equal(gateResult, true, 'Di atas area Fib candidate must still pass digest gate (soft signal only)');
});

// ============================================================
// TEST 3: Candidate below Fib 61.8 / weak structure => still appears if plan valid, with warning
// ============================================================
test('Fib structure lemah: candidate below Fib 61.8 still appears with warning if plan valid', function() {
  // swing high=5200, swing low=4200, range=1000
  // fib_618 = 5200 - 1000*0.618 = 4582
  // Price at 4350 < fib_618 => below healthy zone
  var candles = buildCandlesWithSwingPoints(4200, 5200, 4350, 60);
  var candidate = { last_price: 4350, entry_low: 4300, entry_high: 4400, support: 4200 };

  var result = fibConfluence.evaluateFibConfluence(candles, candidate);

  assert.equal(result.fib_confluence_status, 'fib_structure_lemah');
  assert.equal(result.fib_confluence_label, 'Fib structure lemah');
  assert.ok(result.fib_confluence_note.indexOf('melemah') >= 0 || result.fib_confluence_note.indexOf('konfirmasi') >= 0);

  // Candidate must still pass digest gate — fib never blocks
  var fullCandidate = validSwingCandidate({
    last_price: 4350, lastn: 4350,
    entry_low: 4300, entry_high: 4400, entry1: 4300, entry2: 4400,
    stop_loss: 4100, sl: 4100,
    tp1: 4700, tp1n: 4700, tp2: 4900, tp2n: 4900,
    support: 4200, resistance: 5200,
    risk_reward: 1.8,
    fib_confluence_status: result.fib_confluence_status,
    fib_confluence_label: result.fib_confluence_label
  });
  var gateResult = candidatePassesTelegramCandidateDigestGate(fullCandidate, 'swing_konglo_auto');
  assert.equal(gateResult, true, 'Fib structure lemah candidate must still pass digest gate (soft signal only)');
});

// ============================================================
// TEST 4: Insufficient candle data => no crash, safe "Fib belum cukup data" output
// ============================================================
test('Fib belum cukup data: insufficient candles returns safe output without crash', function() {
  // null candles
  var r1 = fibConfluence.evaluateFibConfluence(null, { last_price: 5000 });
  assert.equal(r1.fib_confluence_status, 'insufficient_data');
  assert.equal(r1.fib_confluence_label, 'Fib belum cukup data');
  assert.ok(r1.fib_confluence_note.indexOf('belum cukup') >= 0);
  assert.equal(r1.fib_nearest_label, null);
  assert.equal(r1.fib_nearest_level, null);
  assert.equal(r1.fib_levels, null);

  // Empty candles array
  var r2 = fibConfluence.evaluateFibConfluence([], { last_price: 5000 });
  assert.equal(r2.fib_confluence_status, 'insufficient_data');
  assert.equal(r2.fib_confluence_label, 'Fib belum cukup data');

  // Too few candles (< 20)
  var fewCandles = [];
  for (var i = 0; i < 15; i++) {
    fewCandles.push({ open: 1000, high: 1010, low: 990, close: 1005, volume: 100000 });
  }
  var r3 = fibConfluence.evaluateFibConfluence(fewCandles, { last_price: 1005 });
  assert.equal(r3.fib_confluence_status, 'insufficient_data');
  assert.equal(r3.fib_confluence_label, 'Fib belum cukup data');

  // Flat data (range < 3%)
  var flatCandles = [];
  for (var j = 0; j < 30; j++) {
    flatCandles.push({ open: 5000, high: 5050, low: 4980, close: 5010, volume: 500000 });
  }
  var r4 = fibConfluence.evaluateFibConfluence(flatCandles, { last_price: 5010 });
  assert.equal(r4.fib_confluence_status, 'insufficient_data');
  assert.equal(r4.fib_confluence_label, 'Fib belum cukup data');

  // Null candidate
  var r5 = fibConfluence.evaluateFibConfluence(fewCandles, null);
  assert.equal(r5.fib_confluence_status, 'insufficient_data');

  // Candidate with zero price
  var r6 = fibConfluence.evaluateFibConfluence(fewCandles, { last_price: 0 });
  assert.equal(r6.fib_confluence_status, 'insufficient_data');
});

// ============================================================
// TEST 5: Fib levels are rounded to valid IDX tick levels
// ============================================================
test('Fib levels are rounded to valid IDX tick sizes', function() {
  // Test calculateFibLevels directly
  var result = fibConfluence.calculateFibLevels(5500, 4200);
  assert.ok(result !== null);
  assert.ok(result.levels !== null);

  // All levels should be valid IDX tick-aligned prices
  var levelKeys = ['fib_0', 'fib_236', 'fib_382', 'fib_500', 'fib_618', 'fib_786', 'fib_100'];
  for (var i = 0; i < levelKeys.length; i++) {
    var level = result.levels[levelKeys[i]];
    assert.ok(level > 0, levelKeys[i] + ' should be positive');
    var isValid = idxTick.isValidIdxPriceLevel(level);
    assert.ok(isValid, levelKeys[i] + ' (' + level + ') must be valid IDX tick level');
  }

  // Test with lower price bracket (tick=1 for <200, tick=2 for 200-500)
  var result2 = fibConfluence.calculateFibLevels(450, 180);
  assert.ok(result2 !== null);
  for (var j = 0; j < levelKeys.length; j++) {
    var level2 = result2.levels[levelKeys[j]];
    assert.ok(level2 > 0, levelKeys[j] + ' should be positive (low bracket)');
    var isValid2 = idxTick.isValidIdxPriceLevel(level2);
    assert.ok(isValid2, levelKeys[j] + ' (' + level2 + ') must be valid IDX tick level (low bracket)');
  }

  // Test with high price bracket (tick=25 for >=5000)
  var result3 = fibConfluence.calculateFibLevels(8000, 5500);
  assert.ok(result3 !== null);
  for (var k = 0; k < levelKeys.length; k++) {
    var level3 = result3.levels[levelKeys[k]];
    assert.ok(level3 > 0, levelKeys[k] + ' should be positive (high bracket)');
    var isValid3 = idxTick.isValidIdxPriceLevel(level3);
    assert.ok(isValid3, levelKeys[k] + ' (' + level3 + ') must be valid IDX tick level (high bracket)');
  }
});

// ============================================================
// TEST 6: Telegram Swing Konglo formatter includes Fib line when available
// ============================================================
test('Telegram Swing Konglo formatter includes Fib line when available', function() {
  var candidate = validSwingCandidate({
    fib_confluence_label: 'Fib confluence sehat',
    fib_confluence_status: 'confluence_sehat',
    fib_confluence_note: 'Entry/pullback dekat area Fib 38.2-61.8.',
    fib_nearest_label: '50%',
    fib_nearest_level: 4800
  });

  // Test fmtTelegramSignalBlock (used by formatSwingTelegramMessage)
  var block = fmtTelegramSignalBlock(candidate, 1, 'swing');
  assert.ok(block.indexOf('Fib:') >= 0, 'Swing telegram block must contain Fib line');
  assert.ok(block.indexOf('Fib confluence sehat') >= 0, 'Fib line must show label');
  assert.ok(block.indexOf('50%') >= 0, 'Fib line must show nearest percentage');
  assert.ok(block.indexOf('4.800') >= 0, 'Fib line must show nearest level price');

  // Fib line must come before Verdict
  var fibIdx = block.indexOf('Fib:');
  var verdictIdx = block.indexOf('Verdict:');
  assert.ok(fibIdx < verdictIdx, 'Fib line must appear before Verdict line');

  // Test formatRichTelegramCandidateBlock
  var richBlock = formatRichTelegramCandidateBlock(candidate, 1, 'swing');
  assert.ok(richBlock.indexOf('Fib:') >= 0, 'Rich format block must contain Fib line');
  assert.ok(richBlock.indexOf('Fib confluence sehat') >= 0, 'Rich Fib line must show label');

  // Test with "Di atas area Fib"
  var candidate2 = validSwingCandidate({
    fib_confluence_label: 'Di atas area Fib',
    fib_confluence_status: 'di_atas_fib',
    fib_nearest_label: '23.6%',
    fib_nearest_level: 5100
  });
  var block2 = fmtTelegramSignalBlock(candidate2, 2, 'swing');
  assert.ok(block2.indexOf('Fib:') >= 0);
  assert.ok(block2.indexOf('Di atas area Fib') >= 0);

  // Test with "Fib structure lemah"
  var candidate3 = validSwingCandidate({
    fib_confluence_label: 'Fib structure lemah',
    fib_confluence_status: 'fib_structure_lemah',
    fib_nearest_label: '78.6%',
    fib_nearest_level: 4300
  });
  var block3 = fmtTelegramSignalBlock(candidate3, 3, 'swing');
  assert.ok(block3.indexOf('Fib:') >= 0);
  assert.ok(block3.indexOf('Fib structure lemah') >= 0);
});

// ============================================================
// TEST 7: Formatter never outputs undefined, null, [object Object], raw_payload, debug, sample_rejected, stageByTicker
// ============================================================
test('Formatter never outputs undefined, null, [object Object], raw_payload, debug, sample_rejected, stageByTicker', function() {
  var FORBIDDEN_PATTERNS = ['undefined', 'null', '[object Object]', 'raw_payload', 'debug', 'sample_rejected', 'stageByTicker'];

  // Test with full fib data
  var candidate = validSwingCandidate({
    fib_confluence_label: 'Fib confluence sehat',
    fib_confluence_status: 'confluence_sehat',
    fib_confluence_note: 'Entry/pullback dekat area Fib 38.2-61.8.',
    fib_nearest_label: '50%',
    fib_nearest_level: 4800
  });
  var block = fmtTelegramSignalBlock(candidate, 1, 'swing');
  for (var i = 0; i < FORBIDDEN_PATTERNS.length; i++) {
    assert.ok(block.indexOf(FORBIDDEN_PATTERNS[i]) === -1,
      'fmtTelegramSignalBlock must not contain "' + FORBIDDEN_PATTERNS[i] + '", got: ' + block.substring(0, 200));
  }

  // Test with null fib data (should not crash, should not show "null")
  var candidate2 = validSwingCandidate({
    fib_confluence_label: null,
    fib_confluence_status: null,
    fib_confluence_note: null,
    fib_nearest_label: null,
    fib_nearest_level: null
  });
  var block2 = fmtTelegramSignalBlock(candidate2, 1, 'swing');
  for (var j = 0; j < FORBIDDEN_PATTERNS.length; j++) {
    assert.ok(block2.indexOf(FORBIDDEN_PATTERNS[j]) === -1,
      'fmtTelegramSignalBlock (null fib) must not contain "' + FORBIDDEN_PATTERNS[j] + '"');
  }

  // Test with insufficient fib data label (should NOT show Fib line at all)
  var candidate3 = validSwingCandidate({
    fib_confluence_label: 'Fib belum cukup data',
    fib_confluence_status: 'insufficient_data',
    fib_nearest_label: null,
    fib_nearest_level: null
  });
  var block3 = fmtTelegramSignalBlock(candidate3, 1, 'swing');
  assert.ok(block3.indexOf('Fib:') === -1, 'Insufficient fib data should not show Fib line');
  for (var k = 0; k < FORBIDDEN_PATTERNS.length; k++) {
    assert.ok(block3.indexOf(FORBIDDEN_PATTERNS[k]) === -1,
      'fmtTelegramSignalBlock (insufficient) must not contain "' + FORBIDDEN_PATTERNS[k] + '"');
  }

  // Test formatRichTelegramCandidateBlock too
  var richBlock = formatRichTelegramCandidateBlock(candidate, 1, 'swing');
  for (var m = 0; m < FORBIDDEN_PATTERNS.length; m++) {
    assert.ok(richBlock.indexOf(FORBIDDEN_PATTERNS[m]) === -1,
      'formatRichTelegramCandidateBlock must not contain "' + FORBIDDEN_PATTERNS[m] + '"');
  }

  // Test with completely missing fib fields (undefined in object)
  var candidate4 = validSwingCandidate({});
  delete candidate4.fib_confluence_label;
  delete candidate4.fib_confluence_status;
  var block4 = fmtTelegramSignalBlock(candidate4, 1, 'swing');
  assert.ok(block4.indexOf('Fib:') === -1, 'Missing fib fields should not show Fib line');
  for (var n = 0; n < FORBIDDEN_PATTERNS.length; n++) {
    assert.ok(block4.indexOf(FORBIDDEN_PATTERNS[n]) === -1,
      'fmtTelegramSignalBlock (missing fib) must not contain "' + FORBIDDEN_PATTERNS[n] + '"');
  }
});

// ============================================================
// TEST 8: Day Trade tests remain unchanged — Fib does NOT appear in Day Trade
// ============================================================
test('Day Trade: Fib confluence does NOT appear in Day Trade telegram output', function() {
  var dayCandidate = {
    ticker: 'BBCA', category: 'Day Trade', status: 'READY_BREAKOUT', final_status: 'READY_BREAKOUT',
    score: 85, daytrade_score: 85, risk_reward: 2.5,
    entry_low: 9500, entry_high: 9600, entry1: 9500, entry2: 9600,
    stop_loss: 9200, sl: 9200, tp1: 10100, tp1n: 10100, tp2: 10500, tp2n: 10500,
    last_price: 9550, lastn: 9550, volume_ratio_20d: 1.5, volume_ratio_avg20: 1.5,
    value_today: 15000000000, tx_value_1d: 15000000000, avg_tx_value_7d: 12000000000,
    trading_plan_valid: true, plan_quality_status: 'VALID',
    risk_label: 'Low Risk', risk_label_v2: 'Low Risk',
    telegram_verdict: 'Potensi naik kuat.',
    // Even if fib data is attached (shouldn't happen for DT, but test safety)
    fib_confluence_label: 'Fib confluence sehat',
    fib_confluence_status: 'confluence_sehat',
    fib_nearest_label: '50%',
    fib_nearest_level: 9400
  };

  // fmtTelegramSignalBlock with daytrade mode must NOT show Fib
  var block = fmtTelegramSignalBlock(dayCandidate, 1, 'daytrade');
  assert.ok(block.indexOf('Fib:') === -1, 'Day Trade telegram must NOT contain Fib line');
  assert.ok(block.indexOf('Fib confluence') === -1, 'Day Trade telegram must NOT contain Fib label');

  // formatRichTelegramCandidateBlock with daytrade mode must NOT show Fib
  var richBlock = formatRichTelegramCandidateBlock(dayCandidate, 1, 'daytrade');
  assert.ok(richBlock.indexOf('Fib:') === -1, 'Day Trade rich format must NOT contain Fib line');
});

// ============================================================
// TEST 9: Endpoint count remains 12
// ============================================================
test('API endpoint file count remains exactly 12', function() {
  var apiDir = path.resolve(__dirname, '..', 'api');
  var files = fs.readdirSync(apiDir).filter(function(f) {
    return f.endsWith('.js') && !f.startsWith('.');
  });
  assert.equal(files.length, 12,
    'api/ directory must contain exactly 12 JS files. Found ' + files.length + ': ' + files.join(', '));
});

// ============================================================
// BONUS: Fib module edge cases for robustness
// ============================================================
test('Fib module: findSwingHigh and findSwingLow return valid results', function() {
  var candles = buildCandlesWithSwingPoints(4000, 5500, 4800, 60);

  var swingHigh = fibConfluence.findSwingHigh(candles, 60, 3);
  assert.ok(swingHigh !== null, 'Should find a swing high');
  assert.ok(swingHigh.price > 0, 'Swing high price must be positive');
  assert.ok(swingHigh.index >= 0, 'Swing high index must be valid');

  var swingLow = fibConfluence.findSwingLow(candles, 60, 3);
  assert.ok(swingLow !== null, 'Should find a swing low');
  assert.ok(swingLow.price > 0, 'Swing low price must be positive');
  assert.ok(swingLow.index >= 0, 'Swing low index must be valid');
});

test('Fib module: calculateFibLevels returns null for invalid inputs', function() {
  assert.equal(fibConfluence.calculateFibLevels(0, 0), null);
  assert.equal(fibConfluence.calculateFibLevels(100, 200), null); // high < low
  assert.equal(fibConfluence.calculateFibLevels(100, 100), null); // equal
  assert.equal(fibConfluence.calculateFibLevels(-100, -200), null); // negative
  assert.equal(fibConfluence.calculateFibLevels(null, 100), null);
  assert.equal(fibConfluence.calculateFibLevels(200, null), null);
});

test('Fib module: evaluateFibConfluence returns consistent structure for all statuses', function() {
  var REQUIRED_KEYS = ['fib_confluence_status', 'fib_confluence_label', 'fib_confluence_note', 'fib_nearest_label', 'fib_nearest_level', 'fib_levels'];

  // Test each possible status
  var scenarios = [
    { candles: buildCandlesWithSwingPoints(4000, 5500, 4800, 60), candidate: { last_price: 4800, entry_low: 4750, entry_high: 4850, support: 4000 } },
    { candles: buildCandlesWithSwingPoints(4000, 5500, 5300, 60), candidate: { last_price: 5300, entry_low: 5250, entry_high: 5350, support: 5000 } },
    { candles: buildCandlesWithSwingPoints(4000, 5500, 4100, 60), candidate: { last_price: 4100, entry_low: 4050, entry_high: 4150, support: 3900 } },
    { candles: null, candidate: { last_price: 5000 } }
  ];

  for (var i = 0; i < scenarios.length; i++) {
    var result = fibConfluence.evaluateFibConfluence(scenarios[i].candles, scenarios[i].candidate);
    for (var j = 0; j < REQUIRED_KEYS.length; j++) {
      assert.ok(REQUIRED_KEYS[j] in result, 'Result must have key: ' + REQUIRED_KEYS[j] + ' (scenario ' + i + ')');
    }
    assert.ok(typeof result.fib_confluence_status === 'string', 'status must be string');
    assert.ok(typeof result.fib_confluence_label === 'string', 'label must be string');
    assert.ok(typeof result.fib_confluence_note === 'string', 'note must be string');
  }
});
