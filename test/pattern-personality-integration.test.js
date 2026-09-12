'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const patternPersonality = require('../lib/pattern-personality');
const telegramTemplates = require('../lib/telegram-templates');
const sectorHot = require('../api/sector-hot');

const EXPECTED_PATTERNS = [
  { key: 'COMBO_FX_TECH_MA5', samples: 67, pf: 2.06, wr: 64.2, mfe: 9.8, mae: -5.9, expectedBonus: 15 },
  { key: 'FX_STRONG_BUY', samples: 67, pf: 1.80, wr: 61.2, mfe: 10.8, mae: -5.4, expectedBonus: 10 },
  { key: 'TECH_ABOVE_MA20', samples: 137, pf: 1.90, wr: 60.6, mfe: 11.0, mae: -8.2, expectedBonus: 10 },
  { key: 'TECH_ABOVE_MA5', samples: 143, pf: 1.89, wr: 60.1, mfe: 10.8, mae: -8.9, expectedBonus: 10 },
  { key: 'VOL_WARM_1P2_1P5', samples: 15, pf: 1.46, wr: 60.0, mfe: 11.8, mae: -7.1, expectedBonus: 3 },
  { key: 'RSI_OVERBOUGHT_65P', samples: 122, pf: 1.73, wr: 59.8, mfe: 10.2, mae: -8.7, expectedBonus: 6 },
  { key: 'COMBO_BROKER_FX', samples: 28, pf: 1.71, wr: 57.1, mfe: 12.3, mae: -5.9, expectedBonus: 6 },
  { key: 'COMBO_BROKER_TECH', samples: 66, pf: 1.67, wr: 56.1, mfe: 12.6, mae: -9.2, expectedBonus: 6 },
  { key: 'TRAP_CHG5_VOL3_CLIMAX', samples: 9, pf: 1.84, wr: 55.6, mfe: 29.1, mae: -5.9, expectedBonus: 10 },
  { key: 'BROKER_TOP3_CONCENTRATION', samples: 77, pf: 1.57, wr: 54.5, mfe: 11.7, mae: -10.3, expectedBonus: 3 }
];

test('T-PP-01: Catalog contains all 10 patterns with accurate statistical metrics', () => {
  assert.equal(Object.keys(patternPersonality.PATTERN_PERSONALITY_CATALOG).length, 10);

  for (const exp of EXPECTED_PATTERNS) {
    const p = patternPersonality.getPatternPersonality(exp.key);
    assert.ok(p, `Pattern ${exp.key} should exist in catalog`);
    assert.equal(p.key, exp.key);
    assert.equal(p.samples, exp.samples);
    assert.equal(p.pf, exp.pf);
    assert.equal(p.wr, exp.wr);
    assert.equal(p.mfe, exp.mfe);
    assert.equal(p.mae, exp.mae);
  }
});

test('T-PP-02: calculatePatternScoreBonus adheres strictly to profit factor tiers', () => {
  for (const exp of EXPECTED_PATTERNS) {
    const bonus = patternPersonality.calculatePatternScoreBonus(exp.key);
    assert.equal(bonus, exp.expectedBonus, `Bonus for ${exp.key} (PF ${exp.pf}) should be ${exp.expectedBonus}`);
  }

  // Edge cases
  assert.equal(patternPersonality.calculatePatternScoreBonus(null), 0);
  assert.equal(patternPersonality.calculatePatternScoreBonus(''), 0);
  assert.equal(patternPersonality.calculatePatternScoreBonus('UNKNOWN_PATTERN'), 0);
});

test('T-PP-03: formatPatternPersonalityLine formats standard Telegram Edge line', () => {
  const line1 = patternPersonality.formatPatternPersonalityLine('COMBO_FX_TECH_MA5');
  assert.equal(line1, 'COMBO_FX_TECH_MA5 · WR 64.2% · PF 2.06 (MFE +9.8% · MAE -5.9%)');

  const line2 = patternPersonality.formatPatternPersonalityLine('TRAP_CHG5_VOL3_CLIMAX');
  assert.equal(line2, 'TRAP_CHG5_VOL3_CLIMAX · WR 55.6% · PF 1.84 (MFE +29.1% · MAE -5.9%)');

  assert.equal(patternPersonality.formatPatternPersonalityLine(null), null);
});

test('T-PP-04: matchTickerPattern matches candidate indicators correctly', () => {
  // 1. Combo Foreign + Tech MA5
  const c1 = {
    last_price: 5000,
    ma5: 4900,
    foreign_net: 5000000000
  };
  assert.equal(patternPersonality.matchTickerPattern(c1), 'COMBO_FX_TECH_MA5');

  // 2. Trap Climax
  const c2 = {
    change_pct: 6.5,
    volume_ratio_20d: 3.5
  };
  assert.equal(patternPersonality.matchTickerPattern(c2), 'TRAP_CHG5_VOL3_CLIMAX');

  // 3. RSI Overbought 65+
  const c3 = {
    last_price: 2000,
    rsi14: 68
  };
  assert.equal(patternPersonality.matchTickerPattern(c3), 'RSI_OVERBOUGHT_65P');

  // 4. Volume Warm
  const c4 = {
    volume_ratio_20d: 1.35
  };
  assert.equal(patternPersonality.matchTickerPattern(c4), 'VOL_WARM_1P2_1P5');

  // 5. Explicit pattern key override
  const c5 = {
    pattern_personality: 'FX_STRONG_BUY'
  };
  assert.equal(patternPersonality.matchTickerPattern(c5), 'FX_STRONG_BUY');
});

test('T-PP-05: formatSignalCard renders Edge line under Chart and above Plan when pattern_personality is present', () => {
  const candidate = {
    ticker: 'BBRI',
    status: 'READY_BREAKOUT',
    final_status: 'READY_BREAKOUT',
    daytrade_score: 80,
    risk_reward: 2.5,
    entry_low: 5000,
    entry_high: 5050,
    stop_loss: 4850,
    tp1: 5350,
    tp2: 5600,
    last_price: 5025,
    volume_ratio_20d: 1.8,
    tx_value_1d: 25000000000,
    risk_label_v2: 'Medium Risk',
    liquidity_label: 'Liquid',
    tf_1d_context: 'Green candle',
    tf_5d_context: 'Bullish',
    breakout_confirmation_label: 'Needs close confirmation',
    resistance: 5200,
    candle_pattern: 'Bullish Engulfing',
    pattern_label: 'Cup and Handle',
    telegram_verdict: 'Pantau breakout.',
    pattern_personality: 'COMBO_FX_TECH_MA5'
  };

  const card = telegramTemplates.formatSignalCard(candidate, 1, 'daytrade');

  assert.match(card, /👁 Pattern \/ Setup/);
  assert.match(card, /Chart: Bullish Engulfing · Cup and Handle/);
  assert.match(card, /Edge: COMBO_FX_TECH_MA5 · WR 64\.2% · PF 2\.06 \(MFE \+9\.8% · MAE -5\.9%\)/);
  assert.match(card, /Plan: Pantau breakout\./);

  // Verifikasi urutan baris tepat: Chart -> Edge -> Plan
  const chartIdx = card.indexOf('Chart:');
  const edgeIdx = card.indexOf('Edge:');
  const planIdx = card.indexOf('Plan:');

  assert.ok(chartIdx !== -1, 'Chart line must exist');
  assert.ok(edgeIdx !== -1, 'Edge line must exist');
  assert.ok(planIdx !== -1, 'Plan line must exist');
  assert.ok(chartIdx < edgeIdx, 'Chart must come before Edge');
  assert.ok(edgeIdx < planIdx, 'Edge must come before Plan');
});

test('T-PP-06: formatSignalCard omits Edge line when candidate has no pattern and cannot be matched', () => {
  const candidate = {
    ticker: 'TLKM',
    status: 'WATCHLIST',
    final_status: 'WATCHLIST',
    daytrade_score: 65,
    risk_reward: 2.0,
    entry_low: 3800,
    entry_high: 3850,
    stop_loss: 3700,
    tp1: 4000,
    last_price: 3820,
    risk_label_v2: 'Medium Risk',
    liquidity_label: 'Liquid',
    candle_pattern: 'Doji',
    telegram_verdict: 'Pantau saja.'
  };

  const card = telegramTemplates.formatSignalCard(candidate, 1, 'daytrade');

  assert.match(card, /👁 Pattern \/ Setup/);
  assert.match(card, /Chart: Doji/);
  assert.match(card, /Plan: Pantau saja\./);
  assert.doesNotMatch(card, /Edge:/, 'Edge line must NOT be present when no pattern matches');
});

test('T-PP-07: Full message formatters inherit Edge line transparently', () => {
  const candidate = {
    ticker: 'EXCL',
    status: 'READY_BREAKOUT',
    final_status: 'READY_BREAKOUT',
    entry_low: 2800,
    entry_high: 2850,
    stop_loss: 2700,
    tp1: 3050,
    last_price: 2820,
    volume_ratio_20d: 1.6,
    pattern_personality: 'TECH_ABOVE_MA20'
  };

  const dtMsg = telegramTemplates.formatDayTradeSignalMessage([candidate]);
  assert.match(dtMsg, /AUTO-CUAN DAY TRADE/);
  assert.match(dtMsg, /Edge: TECH_ABOVE_MA20 · WR 60\.6% · PF 1\.90 \(MFE \+11\.0% · MAE -8\.2%\)/);

  const swMsg = telegramTemplates.formatSwingKongloSignalMessage([candidate]);
  assert.match(swMsg, /AUTO-CUAN SWING TRADE/);
  assert.match(swMsg, /Edge: TECH_ABOVE_MA20 · WR 60\.6% · PF 1\.90 \(MFE \+11\.0% · MAE -8\.2%\)/);
});

test('T-PP-08: api/sector-hot enrichCandidateWithPatternPersonality injects pattern and score bonus', () => {
  const enrichFn = sectorHot.__test.enrichCandidateWithPatternPersonality;
  assert.equal(typeof enrichFn, 'function');

  const candidate = {
    ticker: 'ASII',
    last_price: 5200,
    ma5: 5100,
    foreign_net: 8000000000,
    score: 75,
    daytrade_score: 72
  };

  const enriched = enrichFn(candidate);
  assert.equal(enriched.pattern_personality, 'COMBO_FX_TECH_MA5');
  assert.equal(enriched.pattern_score_bonus, 15);
  assert.equal(enriched.score, 90); // 75 + 15
  assert.equal(enriched.daytrade_score, 87); // 72 + 15
});

test('T-PP-09: formatDailyTop5Message renders Edge line properly and migration file exists', () => {
  const fs = require('fs');
  const path = require('path');

  const migrationPath = path.join(__dirname, '..', 'supabase', 'pattern-personality-column-migration.sql');
  assert.ok(fs.existsSync(migrationPath), 'Migration SQL file must exist');

  const candidates = [
    {
      ticker: 'BBCA',
      last_price: 6600,
      entry_low: 6550,
      entry_high: 6600,
      stop_loss: 6400,
      tp1: 6900,
      pattern_personality: 'COMBO_FX_TECH_MA5'
    }
  ];

  const top5Msg = telegramTemplates.formatDailyTop5Message(candidates, '2026-09-12');
  assert.match(top5Msg, /Edge: COMBO_FX_TECH_MA5 · WR 64\.2% · PF 2\.06/);
});

