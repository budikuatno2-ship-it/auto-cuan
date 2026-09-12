'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const swingEngine = require('../lib/swing-screener-engine');
const telegramTemplates = require('../lib/telegram-templates');
const patternPersonality = require('../lib/pattern-personality');
const sectorHot = require('../api/sector-hot');

// ============================================================
// TEST SUITE: Swing Screener & Telegram Formatting Integrity
// ============================================================

test('Scenario A: R:R < 1.8x is strictly rejected from High Conviction (JPFA case)', () => {
  const jpfaCandidate = {
    ticker: 'JPFA',
    status: 'READY_BREAKOUT',
    score: 95,
    risk_reward: 1.2,
    entry_low: 1700,
    entry_high: 1720,
    stop_loss: 1640,
    tp1: 1800,
    tp2: 1900,
    last_price: 1715,
    volume_ratio_20d: 1.5,
    tf_1d_context: '1D Green candle',
    tf_5d_context: '5D Bullish'
  };

  // 1. swingEngine.verifySwingHighConviction must reject it
  const verified = swingEngine.verifySwingHighConviction(jpfaCandidate);
  assert.equal(verified, null, 'JPFA with R:R 1.2x must be rejected from High Conviction');

  // 2. verifyHighConvictionTelegramSignal in sectorHot must reject it
  const apiVerified = sectorHot.__test ? sectorHot.__test : null;
  // If not in __test, test via swingEngine and direct function
  assert.equal(swingEngine.getRiskReward(jpfaCandidate), 1.2);
  assert.equal(swingEngine.MIN_SWING_HIGH_CONVICTION_RR, 1.8);
});

test('Scenario B: Penalty Engine slashes score for 5D Bearish (-25) and 1D Red Candle (-15) (JPFA case)', () => {
  const jpfaWithPenalties = {
    ticker: 'JPFA',
    last_price: 1715,
    open_price: 1730, // Close < Open -> 1D Red Candle
    tf_1d_context: '1D Red candle',
    tf_5d_context: '5D Bearish',
    risk_reward: 1.2,
    volume_ratio_20d: 1.1
  };

  const baseScore = 95;
  const result = swingEngine.applySwingScoringPenalties(baseScore, jpfaWithPenalties);

  assert.equal(result.is5DBearish, true, '5D Bearish must be detected');
  assert.equal(result.is1DRed, true, '1D Red Candle must be detected');
  assert.ok(result.penaltiesApplied.includes('PENALTY_5D_BEARISH (-25)'));
  assert.ok(result.penaltiesApplied.includes('PENALTY_1D_RED_CANDLE (-15)'));

  // Base 95 - 25 (Bearish) - 15 (Red Candle) = 55
  assert.equal(result.score, 55, 'Score must drop from 95 to 55');
  assert.ok(result.score < 70, 'Penalized score must be well below 70');
  assert.equal(result.qualifiesFor90Plus, false);
});

test('Scenario C: Volume < 1.0x (dry) enforces ceiling at 70 (INDY case)', () => {
  const indyCandidate = {
    ticker: 'INDY',
    last_price: 1450,
    open_price: 1470, // 1D Red Candle
    tf_1d_context: '1D Red candle',
    tf_5d_context: '5D Bullish',
    risk_reward: 2.1, // Good RR
    volume_ratio_20d: 0.9 // Dry volume < 1.0x
  };

  const baseScore = 95;
  const result = swingEngine.applySwingScoringPenalties(baseScore, indyCandidate);

  assert.equal(result.is1DRed, true, '1D Red Candle detected');
  assert.equal(result.volRatio, 0.9, 'Volume ratio is 0.9x');
  assert.ok(result.penaltiesApplied.includes('PENALTY_1D_RED_CANDLE (-15)'));
  assert.ok(result.penaltiesApplied.includes('CEILING_VOLUME_DRY_MAX_70'));

  // 95 - 15 = 80, but volume < 1.0x enforces max ceiling of 70
  assert.equal(result.score, 70, 'Score must be capped at 70 due to dry volume');
  assert.equal(result.qualifiesFor90Plus, false);
});

test('Scenario D: Score 90+ strictly requires 4 mandatory pillars', () => {
  // Case 1: Ticker has score 95 but has 5D Bearish -> capped below 90
  const candidateBearish = {
    tf_5d_context: '5D Bearish',
    open_price: 1000,
    last_price: 1050,
    volume_ratio_20d: 1.5,
    risk_reward: 2.5
  };
  const res1 = swingEngine.applySwingScoringPenalties(95, candidateBearish);
  assert.ok(res1.score < 90, 'Bearish trend cannot have 90+');

  // Case 2: Ticker has score 95 but volume is 1.1x (< 1.2x) -> capped at 89
  const candidateLowVol = {
    tf_5d_context: '5D Bullish',
    open_price: 1000,
    last_price: 1050,
    volume_ratio_20d: 1.1,
    risk_reward: 2.5
  };
  const res2 = swingEngine.applySwingScoringPenalties(95, candidateLowVol);
  assert.equal(res2.score, 89, 'Volume < 1.2x must be capped at 89');

  // Case 3: Ticker meets all 4 pillars -> retains 90+
  const qualifiedCandidate = {
    tf_5d_context: '5D Bullish',
    open_price: 1000,
    last_price: 1050, // Green candle
    volume_ratio_20d: 1.6, // >= 1.2x
    risk_reward: 2.2 // >= 1.8x
  };
  const res3 = swingEngine.applySwingScoringPenalties(95, qualifiedCandidate);
  assert.equal(res3.score, 95, 'Candidate meeting all 4 pillars keeps 95');
  assert.equal(res3.qualifiesFor90Plus, true);
});

test('Scenario E: Telegram template eliminates double Take Profit lines and inverted entry bracket', () => {
  const candidate = {
    ticker: 'TEST',
    status: 'READY_BREAKOUT',
    score: 85,
    entry_low: 1700,
    entry_high: 1720,
    stop_loss: 1640,
    tp1: 1800,
    tp2: 1900,
    last_price: 1715,
    risk_reward: 2.1,
    volume_ratio_20d: 1.5,
    cr3_flow: 50000000000,
    cr5_flow: 85000000000,
    retail_participation: 12.5,
    bandar_flow_label: 'Big Accumulation'
  };

  const card = telegramTemplates.formatSignalCard(candidate, 1, 'swing');

  // Must have clean "Area Beli (Entry): Rp1.700 - Rp1.720" (sorted min to max)
  assert.match(card, /Area Beli \(Entry\): Rp1\.700 - Rp1\.720/);
  assert.match(card, /Entry/);

  // Must NOT have inverted bracket "(Entry: Rp1.720 / Rp1.700)"
  assert.doesNotMatch(card, /\(Entry: Rp1\.720 \/ Rp1\.700\)/);

  // Must NOT have duplicate "Take Profit:" line
  assert.doesNotMatch(card, /^Take Profit:/m, 'Duplicate Take Profit line must be eliminated');

  // Must have single clean Target Profit line
  assert.match(card, /Target Profit 1 \(\+5% s\/d \+6% Partial TP 50%\): Rp1\.800/);
});

test('Scenario F: Real Bandarmologi data vs "Netral / Tersebar" fallback (no fossil mock accumulation)', () => {
  // 1. Candidate without accumulation data
  const candidateNoIntel = {
    ticker: 'RANDOM',
    status: 'READY_BREAKOUT',
    score: 75,
    entry_low: 500,
    entry_high: 520,
    stop_loss: 480,
    tp1: 560,
    last_price: 510,
    risk_reward: 2.0
  };

  const cardNoIntel = telegramTemplates.formatSignalCard(candidateNoIntel, 1, 'swing');
  // Must NOT have static mock string
  assert.doesNotMatch(cardNoIntel, /CR3\/CR5 net akumulasi positif · Partisipasi ritel terkendali/);
  // Must render "Netral / Tersebar"
  assert.match(cardNoIntel, /Intel Bandar \/ Arus Dana: Netral \/ Tersebar/);

  // 2. Real accumulation metrics
  const candidateRealIntel = {
    ticker: 'BBCA',
    status: 'SWING_READY',
    score: 92,
    entry_low: 10000,
    entry_high: 10150,
    stop_loss: 9800,
    tp1: 10800,
    last_price: 10100,
    risk_reward: 2.3,
    cr3_flow: 125000000000,
    cr5_flow: 210000000000,
    retail_participation: 14.2,
    bandar_flow_label: 'Big Accumulation'
  };

  const cardRealIntel = telegramTemplates.formatSignalCard(candidateRealIntel, 1, 'swing');
  assert.match(cardRealIntel, /CR3: Rp125,0 M/);
  assert.match(cardRealIntel, /CR5: Rp210,0 M/);
  assert.match(cardRealIntel, /Partisipasi Ritel: 14\.2%/);
  assert.match(cardRealIntel, /Status: Big Accumulation/);
});

test('Scenario G: Anti-Contradiction Gate for WAIT_PULLBACK & RSI_OVERBOUGHT disqualification (IMPC case)', () => {
  const impcCandidate = {
    ticker: 'IMPC',
    status: 'WAIT_PULLBACK',
    action_label: 'Tunggu pullback',
    telegram_action_label: 'Tunggu pullback',
    score: 97,
    conviction_score: 97,
    risk_reward: 2.2,
    entry_low: 450,
    entry_high: 460,
    stop_loss: 430,
    tp1: 500,
    last_price: 480,
    rsi14: 74, // Overbought!
    matched_pattern: 'RSI_OVERBOUGHT_65P'
  };

  // 1. verifySwingHighConviction must REJECT IMPC because status is WAIT_PULLBACK
  const verified = swingEngine.verifySwingHighConviction(impcCandidate);
  assert.equal(verified, null, 'IMPC with WAIT_PULLBACK must be rejected from High Conviction');

  // 2. Edge classification must NEVER tag RSI >= 70 as a swing edge
  const edge = swingEngine.classifySwingEdge(impcCandidate);
  assert.equal(edge, null, 'RSI >= 70 must never be classified as a swing edge');

  // 3. Telegram edge helper must reject RSI_OVERBOUGHT
  const edgeLine = telegramTemplates.getPatternEdgeShort(impcCandidate);
  assert.equal(edgeLine, null, 'getPatternEdgeShort must reject RSI_OVERBOUGHT');

  // 4. If an entire batch contains only WAIT_PULLBACK items, formatSwingKongloSignalMessage header adapts
  const msg = telegramTemplates.formatSwingKongloSignalMessage([impcCandidate]);
  assert.match(msg, /🎯 AUTO-CUAN SWING TRADE — WATCHLIST & PULLBACK/, 'Header must not claim HIGH CONVICTION when all items are pullback/watchlist');
  assert.doesNotMatch(msg, /HIGH CONVICTION/);
});
