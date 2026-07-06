/**
 * Test script for Risk Guard v1 — simulates sample outputs
 * Uses mock data to verify logic without needing live Supabase/Yahoo.
 *
 * SOURCE OF TRUTH: Supabase stock_boards table (via /api/quote boardResult).
 * public/assets/fca-stocks.js is LEGACY and NOT used by Risk Guard.
 *
 * Correct board values (from user + Supabase):
 * - BBCA: board = UTAMA, isFca = false, minPriceGuard = 50
 * - NAYZ: board = AKSELERASI, isFca = false, minPriceGuard = 1
 * - WMUU: board = PENGEMBANGAN, isFca = false, minPriceGuard = 50
 * - FCA_STOCK (synthetic, e.g. LUCK): board = PEMANTAUAN_KHUSUS, isFca = true, minPriceGuard = 1
 */

// === SAFE BOARD NORMALIZATION (same as in quote.js) ===
function normalizeBoardSafe(board) {
  if (!board || !board.success) {
    return { level: 'unknown', label: 'Board data unavailable/stale' };
  }
  var b = board.board;
  if (!b || typeof b !== 'string') {
    return { level: 'unknown', label: 'Board field empty' };
  }
  var upper = b.toUpperCase().trim();
  if (upper === 'PEMANTAUAN_KHUSUS' || board.isFca === true) {
    return { level: 'high', label: 'Pemantauan Khusus / FCA' };
  }
  if (upper === 'AKSELERASI') {
    return { level: 'elevated', label: 'Papan Akselerasi' };
  }
  if (upper === 'UTAMA') {
    return { level: 'normal', label: 'Papan Utama' };
  }
  if (upper === 'PENGEMBANGAN') {
    return { level: 'normal', label: 'Papan Pengembangan' };
  }
  if (upper === 'EKONOMI_BARU') {
    return { level: 'normal', label: 'Papan Ekonomi Baru' };
  }
  return { level: 'unknown', label: 'Board: ' + b + ' (tidak dikenali)' };
}

// === RISK GUARD CALCULATION (same as in quote.js) ===
function calculateRiskGuard(quote, board) {
  if (!quote || !quote.success) {
    return {
      level: 'Unknown',
      riskScore: 50,
      actionBias: 'Wait Confirmation',
      reasons: ['Data quote tidak tersedia'],
      warnings: ['no_data'],
      floors: { applied: false }
    };
  }

  var price = quote.last;
  var rsi = quote.rsi14;
  var volVsAvg = quote.volumeVsAvg20;
  var setupLabel = quote.setupLabel;
  var autoCuanScore = quote.autoCuanScore;
  var breakoutConf = quote.breakoutConfirmation;

  var reasons = [];
  var warnings = [];
  var riskScore = 0;

  // Board source: ONLY from boardResult (Supabase stock_boards).
  // Never from fca-stocks.js or any hardcoded list.
  var boardInfo = normalizeBoardSafe(board);
  var boardLevel = boardInfo.level;
  var boardLabel = boardInfo.label;

  // BOARD RISK
  if (boardLevel === 'high') {
    return {
      level: 'Very High',
      riskScore: 90,
      actionBias: 'Avoid Dulu',
      reasons: ['Board: ' + boardLabel + ' — FCA/Pemantauan Khusus', 'Likuiditas sangat terbatas', 'Risiko delisting / suspensi'],
      warnings: ['fca_override', 'hard_avoid'],
      floors: { applied: true, trigger: 'PEMANTAUAN_KHUSUS/FCA hard override' },
      catalystReduction: 0,
      boardInfo: { boardLevel: boardLevel, boardLabel: boardLabel, source: 'supabase' }
    };
  }

  if (boardLevel === 'elevated') {
    riskScore += 25;
    reasons.push('Board: ' + boardLabel + ' — likuiditas ketat, risiko tinggi');
    warnings.push('board_akselerasi');
  } else if (boardLevel === 'unknown') {
    riskScore += 10;
    reasons.push('Board data tidak tersedia/stale — risiko tidak diketahui');
    warnings.push('board_unknown');
  }
  // 'normal' (UTAMA, PENGEMBANGAN, EKONOMI_BARU) = no board penalty

  // PRICE RISK
  if (price != null) {
    if (price <= 50) {
      riskScore += 20;
      reasons.push('Harga sangat rendah (Rp ' + price + ') — area gocap/near-gocap');
      warnings.push('very_low_price');
    } else if (price <= 100) {
      riskScore += 15;
      reasons.push('Harga rendah (Rp ' + price + ') — speculative area');
      warnings.push('low_price');
    } else if (price <= 200) {
      riskScore += 8;
      reasons.push('Harga masih low-price (Rp ' + price + ') — perlu konfirmasi kuat');
      warnings.push('low_price_area');
    }
  }

  // SETUP LABEL RISK
  var setupStatus = (setupLabel && setupLabel.status) ? setupLabel.status : null;
  if (setupStatus === 'High Risk Speculative') {
    riskScore += 20;
    reasons.push('Setup Label: High Risk Speculative');
    warnings.push('high_risk_speculative_label');
  } else if (setupStatus === 'Speculative Watch') {
    riskScore += 12;
    reasons.push('Setup Label: Speculative Watch — catalyst ada tapi konfirmasi lemah');
    warnings.push('speculative_watch_label');
  } else if (setupStatus === 'Avoid Dulu') {
    riskScore += 25;
    reasons.push('Setup Label: Avoid Dulu — kondisi teknikal bearish');
    warnings.push('avoid_label');
  } else if (setupStatus === 'Bearish Continuation') {
    riskScore += 20;
    reasons.push('Setup Label: Bearish Continuation — trend turun berlanjut');
    warnings.push('bearish_continuation_label');
  } else if (setupStatus === 'Breakdown Risk') {
    riskScore += 15;
    reasons.push('Setup Label: breakdown risk terdeteksi');
  } else if (setupStatus === 'Sideways / No Trade') {
    riskScore += 5;
  }

  // BREAKOUT CONFIRMATION RISK
  var breakoutStatus = (breakoutConf && breakoutConf.status) ? breakoutConf.status : null;
  if (breakoutStatus === 'Breakdown Risk') {
    riskScore += 15;
    reasons.push('Breakout Confirmation: Breakdown Risk — harga di bawah support');
    warnings.push('breakdown_risk');
  } else if (breakoutStatus === 'Rejection Risk') {
    riskScore += 8;
    reasons.push('Breakout Confirmation: Rejection Risk — momentum lemah di resistance');
  }

  // AUTO-CUAN SCORE RISK
  var grade = (autoCuanScore && autoCuanScore.grade) ? autoCuanScore.grade : null;
  var score = (autoCuanScore && autoCuanScore.score != null) ? autoCuanScore.score : null;
  if (grade === 'E') {
    riskScore += 18;
    reasons.push('Auto-Cuan Grade E (score ' + score + '/100) — very weak setup');
    warnings.push('grade_e');
  } else if (grade === 'D') {
    riskScore += 12;
    reasons.push('Auto-Cuan Grade D (score ' + score + '/100) — weak setup');
    warnings.push('grade_d');
  } else if (grade === 'C') {
    riskScore += 5;
    if (setupStatus === 'Speculative Watch' || setupStatus === 'High Risk Speculative') {
      riskScore += 5;
      reasons.push('Auto-Cuan Grade C + speculative label — mixed setup');
    }
  }

  // TECHNICAL WEAKNESS
  if (rsi != null && rsi < 35) {
    riskScore += 5;
    reasons.push('RSI ' + rsi + ' — momentum sangat lemah');
  }
  if (volVsAvg != null && volVsAvg < 0.5) {
    riskScore += 5;
    reasons.push('Volume sangat rendah (' + volVsAvg + 'x avg) — likuiditas lemah');
    warnings.push('very_low_volume');
  }

  // POSITIVE CATALYST REDUCTION (capped at 5, cannot breach floors)
  var catalystReduction = 0;
  var newsData = quote.news;
  if (newsData && newsData.success && newsData.items && newsData.items.length > 0) {
    var positiveCount = 0;
    var negativeCount = 0;
    for (var i = 0; i < newsData.items.length; i++) {
      var impact = newsData.items[i].possibleImpact || newsData.items[i].impact || 'neutral';
      if (impact === 'positive') positiveCount++;
      else if (impact === 'negative') negativeCount++;
    }
    if (positiveCount > 0 && negativeCount === 0) {
      catalystReduction = Math.min(5, positiveCount * 3);
      reasons.push('Katalis positif terdeteksi (pengurangan risiko terbatas -' + catalystReduction + ')');
    } else if (negativeCount > 0 && positiveCount === 0) {
      riskScore += 5;
      reasons.push('Katalis negatif terdeteksi');
      warnings.push('negative_catalyst');
    }
  }

  riskScore = riskScore - catalystReduction;

  // RISK FLOORS (minimum levels — catalyst cannot reduce below these)
  var floorApplied = false;
  var floorTrigger = null;
  var minimumScore = 0;

  if (boardLevel === 'elevated') {
    minimumScore = Math.max(minimumScore, 30);
    if (!floorTrigger) floorTrigger = 'Board AKSELERASI → minimum Medium';
  }

  if (price != null && price <= 200) {
    var technicalsStrong = (rsi != null && rsi >= 55) && (volVsAvg != null && volVsAvg >= 1.5);
    var gradeGood = (grade === 'A' || grade === 'B');
    if (!(technicalsStrong && gradeGood)) {
      minimumScore = Math.max(minimumScore, 25);
      if (!floorTrigger) floorTrigger = 'Price <= 200 tanpa konfirmasi kuat → minimum Medium';
    }
  }

  if (setupStatus === 'Speculative Watch') {
    minimumScore = Math.max(minimumScore, 25);
    if (!floorTrigger) floorTrigger = 'Setup Speculative Watch → minimum Medium';
  }

  if (setupStatus === 'High Risk Speculative') {
    minimumScore = Math.max(minimumScore, 45);
    if (!floorTrigger) floorTrigger = 'Setup High Risk Speculative → minimum High';
  }

  if (setupStatus === 'Avoid Dulu' || setupStatus === 'Bearish Continuation') {
    minimumScore = Math.max(minimumScore, 50);
    if (!floorTrigger) floorTrigger = 'Setup ' + setupStatus + ' → minimum High';
  }

  if (breakoutStatus === 'Breakdown Risk') {
    minimumScore = Math.max(minimumScore, 45);
    if (!floorTrigger) floorTrigger = 'Breakout Confirmation Breakdown Risk → minimum High';
  }

  if (grade === 'D' || grade === 'E') {
    minimumScore = Math.max(minimumScore, 45);
    if (!floorTrigger) floorTrigger = 'Grade ' + grade + ' → minimum High';
  }

  if (grade === 'C' && (setupStatus === 'Speculative Watch' || setupStatus === 'High Risk Speculative')) {
    minimumScore = Math.max(minimumScore, 30);
    if (!floorTrigger) floorTrigger = 'Grade C + speculative label → minimum Medium';
  }

  // Enforce floor
  if (riskScore < minimumScore) {
    riskScore = minimumScore;
    floorApplied = true;
  }

  // Clamp to 0-100 (catalyst cannot make risk negative)
  if (riskScore < 0) riskScore = 0;
  riskScore = Math.min(100, riskScore);

  // DETERMINE LEVEL
  var level;
  if (riskScore >= 75) level = 'Very High';
  else if (riskScore >= 45) level = 'High';
  else if (riskScore >= 25) level = 'Medium';
  else if (riskScore >= 10) level = 'Low';
  else level = 'Very Low';

  // DETERMINE ACTION BIAS
  var actionBias;
  if (level === 'Very High') {
    actionBias = 'Avoid Dulu';
  } else if (level === 'High') {
    actionBias = 'Small Position Only';
  } else if (level === 'Medium') {
    actionBias = 'Wait Confirmation';
  } else if (level === 'Low') {
    actionBias = 'Normal Watch';
  } else {
    actionBias = 'Normal Watch';
  }

  if (setupStatus === 'Speculative Watch' && level === 'Medium') {
    actionBias = 'Wait Confirmation';
  }
  if (setupStatus === 'High Risk Speculative') {
    actionBias = 'Small Position Only';
  }

  return {
    level: level,
    riskScore: riskScore,
    actionBias: actionBias,
    reasons: reasons.slice(0, 6),
    warnings: warnings.slice(0, 5),
    floors: {
      applied: floorApplied,
      trigger: floorTrigger || null,
      minimumScore: minimumScore > 0 ? minimumScore : null
    },
    catalystReduction: catalystReduction,
    boardInfo: {
      boardLevel: boardLevel,
      boardLabel: boardLabel,
      source: (board && board.success) ? 'supabase' : 'unavailable'
    }
  };
}


// ===== TEST CASES =====
console.log('\n========================================');
console.log('RISK GUARD v1 — SAMPLE OUTPUT VERIFICATION');
console.log('Board source: Supabase stock_boards ONLY');
console.log('fca-stocks.js: NOT used by Risk Guard');
console.log('========================================\n');

// --- BBCA: Blue-chip, Papan Utama ---
// Board from Supabase: UTAMA, isFca=false, minPriceGuard=50
var bbcaBoard = { success: true, companyName: 'Bank Central Asia Tbk.', board: 'UTAMA', isFca: false, minPriceGuard: 50 };
var bbcaQuote = {
  success: true, ticker: 'BBCA', last: 9250, rsi14: 58, volumeVsAvg20: 1.1,
  setupLabel: { status: 'Breakout Watch', confidence: 'medium', reasons: ['Price di atas MA20'] },
  autoCuanScore: { score: 72, grade: 'B', confidence: 'high' },
  breakoutConfirmation: { status: 'Breakout Watch', confidence: 'medium' },
  news: { success: true, items: [{ title: 'BBCA laba naik 12%', possibleImpact: 'positive' }] }
};

var bbcaResult = calculateRiskGuard(bbcaQuote, bbcaBoard);
console.log('=== BBCA ===');
console.log('  Board (Supabase): UTAMA, isFca=false, minPriceGuard=50');
console.log('  Level:', bbcaResult.level);
console.log('  Risk Score:', bbcaResult.riskScore + '/100');
console.log('  Action Bias:', bbcaResult.actionBias);
console.log('  Floor Applied:', bbcaResult.floors.applied ? 'YES — ' + bbcaResult.floors.trigger : 'No');
console.log('  Catalyst Reduction:', bbcaResult.catalystReduction);
console.log('  Reasons:', bbcaResult.reasons.join('; ') || '(none)');
console.log('  Warnings:', bbcaResult.warnings.join(', ') || '(none)');
console.log('  Board Info:', JSON.stringify(bbcaResult.boardInfo));
console.log('');

// --- NAYZ: Akselerasi, low price, speculative, with positive catalyst ---
// Board from Supabase: AKSELERASI, isFca=false, minPriceGuard=1
var nayzBoard = { success: true, companyName: 'Hassana Boga Sejahtera Tbk.', board: 'AKSELERASI', isFca: false, minPriceGuard: 1 };
var nayzQuote = {
  success: true, ticker: 'NAYZ', last: 57, rsi14: 45, volumeVsAvg20: 1.1,
  setupLabel: { status: 'Speculative Watch', confidence: 'low', reasons: ['Ada katalis/news', 'Volume aktif', 'Konfirmasi trend belum kuat'] },
  autoCuanScore: { score: 52, grade: 'C', confidence: 'medium' },
  breakoutConfirmation: { status: 'Sideways / Wait', confidence: 'medium' },
  news: { success: true, items: [{ title: 'NAYZ ekspansi pabrik baru', possibleImpact: 'positive' }] }
};

var nayzResult = calculateRiskGuard(nayzQuote, nayzBoard);
console.log('=== NAYZ ===');
console.log('  Board (Supabase): AKSELERASI, isFca=false, minPriceGuard=1');
console.log('  Level:', nayzResult.level);
console.log('  Risk Score:', nayzResult.riskScore + '/100');
console.log('  Action Bias:', nayzResult.actionBias);
console.log('  Floor Applied:', nayzResult.floors.applied ? 'YES — ' + nayzResult.floors.trigger : 'No');
console.log('  Catalyst Reduction:', nayzResult.catalystReduction);
console.log('  Reasons:', nayzResult.reasons.join('; '));
console.log('  Warnings:', nayzResult.warnings.join(', ') || '(none)');
console.log('  Board Info:', JSON.stringify(nayzResult.boardInfo));
console.log('');

// --- WMUU: Pengembangan, NOT FCA, NOT Akselerasi ---
// Board from Supabase: PENGEMBANGAN, isFca=false, minPriceGuard=50
// Technicals: weak but NOT penalized by FCA/Akselerasi board
var wmuuBoard = { success: true, companyName: 'Widodo Makmur Unggas Tbk.', board: 'PENGEMBANGAN', isFca: false, minPriceGuard: 50 };
var wmuuQuote = {
  success: true, ticker: 'WMUU', last: 50, rsi14: 38, volumeVsAvg20: 0.6,
  setupLabel: { status: 'Bearish Continuation', confidence: 'high', reasons: ['Price di bawah MA20 dan MA50', 'RSI lemah'] },
  autoCuanScore: { score: 32, grade: 'E', confidence: 'low' },
  breakoutConfirmation: { status: 'Breakdown Risk', confidence: 'high' },
  news: { success: false, items: [] }
};

var wmuuResult = calculateRiskGuard(wmuuQuote, wmuuBoard);
console.log('=== WMUU ===');
console.log('  Board (Supabase): PENGEMBANGAN, isFca=false, minPriceGuard=50');
console.log('  NOT FCA. NOT Akselerasi. No board penalty applied.');
console.log('  Level:', wmuuResult.level);
console.log('  Risk Score:', wmuuResult.riskScore + '/100');
console.log('  Action Bias:', wmuuResult.actionBias);
console.log('  Floor Applied:', wmuuResult.floors.applied ? 'YES — ' + wmuuResult.floors.trigger : 'No');
console.log('  Reasons:', wmuuResult.reasons.join('; '));
console.log('  Warnings:', wmuuResult.warnings.join(', ') || '(none)');
console.log('  Board Info:', JSON.stringify(wmuuResult.boardInfo));
console.log('');

// --- FCA_STOCK (synthetic: LUCK) ---
// Board from Supabase: PEMANTAUAN_KHUSUS, isFca=true, minPriceGuard=1
var fcaBoard = { success: true, companyName: 'Sentral Mitra Informatika Tbk.', board: 'PEMANTAUAN_KHUSUS', isFca: true, minPriceGuard: 1 };
var fcaQuote = {
  success: true, ticker: 'LUCK', last: 25, rsi14: 30, volumeVsAvg20: 0.3,
  setupLabel: { status: 'Avoid Dulu', confidence: 'high', reasons: ['Board: Pemantauan Khusus / FCA', 'Price below all MA'] },
  autoCuanScore: { score: 15, grade: 'E', confidence: 'low' },
  breakoutConfirmation: { status: 'Breakdown Risk', confidence: 'high' },
  news: { success: false, items: [] }
};

var fcaResult = calculateRiskGuard(fcaQuote, fcaBoard);
console.log('=== FCA_STOCK (LUCK) ===');
console.log('  Board (Supabase): PEMANTAUAN_KHUSUS, isFca=true, minPriceGuard=1');
console.log('  Level:', fcaResult.level);
console.log('  Risk Score:', fcaResult.riskScore + '/100');
console.log('  Action Bias:', fcaResult.actionBias);
console.log('  Floor Applied:', fcaResult.floors.applied ? 'YES — ' + fcaResult.floors.trigger : 'No');
console.log('  Reasons:', fcaResult.reasons.join('; '));
console.log('  Warnings:', fcaResult.warnings.join(', ') || '(none)');
console.log('  Board Info:', JSON.stringify(fcaResult.boardInfo));
console.log('');

// --- NAYZ with board data MISSING (safe fallback) ---
var nayzBoardMissing = { success: false, companyName: null, board: 'UNKNOWN', isFca: false, minPriceGuard: 50 };
var nayzQuoteMissing = {
  success: true, ticker: 'NAYZ', last: 57, rsi14: 45, volumeVsAvg20: 1.1,
  setupLabel: { status: 'Speculative Watch', confidence: 'low', reasons: ['Ada katalis'] },
  autoCuanScore: { score: 52, grade: 'C', confidence: 'medium' },
  breakoutConfirmation: { status: 'Sideways / Wait', confidence: 'medium' },
  news: { success: true, items: [{ title: 'Ekspansi baru', possibleImpact: 'positive' }] }
};

var nayzMissingResult = calculateRiskGuard(nayzQuoteMissing, nayzBoardMissing);
console.log('=== NAYZ (Board MISSING — safe fallback) ===');
console.log('  Board: unavailable (success=false)');
console.log('  NOT marked FCA. NOT marked AKSELERASI. Warning added.');
console.log('  Level:', nayzMissingResult.level);
console.log('  Risk Score:', nayzMissingResult.riskScore + '/100');
console.log('  Action Bias:', nayzMissingResult.actionBias);
console.log('  Floor Applied:', nayzMissingResult.floors.applied ? 'YES — ' + nayzMissingResult.floors.trigger : 'No');
console.log('  Board Info:', JSON.stringify(nayzMissingResult.boardInfo));
console.log('  Reasons:', nayzMissingResult.reasons.join('; '));
console.log('  Warnings:', nayzMissingResult.warnings.join(', ') || '(none)');
console.log('');

// ===== VERIFICATION =====
console.log('========================================');
console.log('VERIFICATION SUMMARY');
console.log('========================================\n');

var allPass = true;
function check(name, condition, msg) {
  if (!condition) { console.log('  FAIL: ' + name + ' — ' + msg); allPass = false; }
  else { console.log('  PASS: ' + name); }
}

// BBCA checks
check('BBCA level Low/VeryLow', bbcaResult.level === 'Low' || bbcaResult.level === 'Very Low', 'got ' + bbcaResult.level);
check('BBCA bias Normal Watch', bbcaResult.actionBias === 'Normal Watch', 'got ' + bbcaResult.actionBias);
check('BBCA no FCA penalty', bbcaResult.boardInfo.boardLevel === 'normal', 'got ' + bbcaResult.boardInfo.boardLevel);
console.log('');

// NAYZ checks
check('NAYZ level NOT Low', nayzResult.level !== 'Low' && nayzResult.level !== 'Very Low', 'got ' + nayzResult.level);
check('NAYZ score >= 25', nayzResult.riskScore >= 25, 'got ' + nayzResult.riskScore);
check('NAYZ board elevated (AKSELERASI)', nayzResult.boardInfo.boardLevel === 'elevated', 'got ' + nayzResult.boardInfo.boardLevel);
check('NAYZ has akselerasi warning', nayzResult.warnings.indexOf('board_akselerasi') >= 0, 'missing board_akselerasi warning');
console.log('');

// WMUU checks — critical: must NOT have FCA or AKSELERASI penalty
check('WMUU level NOT Very High', wmuuResult.level !== 'Very High', 'got ' + wmuuResult.level + ' (should not be FCA-override)');
check('WMUU board normal (PENGEMBANGAN)', wmuuResult.boardInfo.boardLevel === 'normal', 'got ' + wmuuResult.boardInfo.boardLevel);
check('WMUU no FCA warning', wmuuResult.warnings.indexOf('fca_override') === -1, 'has fca_override warning');
check('WMUU no akselerasi warning', wmuuResult.warnings.indexOf('board_akselerasi') === -1, 'has board_akselerasi warning');
check('WMUU bias NOT Avoid Dulu', wmuuResult.actionBias !== 'Avoid Dulu', 'got ' + wmuuResult.actionBias);
console.log('');

// FCA checks
check('FCA level Very High', fcaResult.level === 'Very High', 'got ' + fcaResult.level);
check('FCA bias Avoid Dulu', fcaResult.actionBias === 'Avoid Dulu', 'got ' + fcaResult.actionBias);
check('FCA score 90', fcaResult.riskScore === 90, 'got ' + fcaResult.riskScore);
console.log('');

// Board missing checks
check('NAYZ-missing board unknown', nayzMissingResult.boardInfo.boardLevel === 'unknown', 'got ' + nayzMissingResult.boardInfo.boardLevel);
check('NAYZ-missing NOT FCA', nayzMissingResult.warnings.indexOf('fca_override') === -1, 'incorrectly marked FCA');
check('NAYZ-missing NOT akselerasi', nayzMissingResult.warnings.indexOf('board_akselerasi') === -1, 'incorrectly marked akselerasi');
check('NAYZ-missing has unknown warning', nayzMissingResult.warnings.indexOf('board_unknown') >= 0, 'missing board_unknown warning');
console.log('');

if (allPass) {
  console.log('ALL CHECKS PASSED ✓\n');
} else {
  console.log('SOME CHECKS FAILED ✗\n');
  process.exit(1);
}
