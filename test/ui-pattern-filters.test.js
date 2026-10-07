'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('vm');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const indexHtml = fs.readFileSync(htmlPath, 'utf8');

test('T-UIPF-01: HTML contains quick filter container, dropdown and checkbox toggle with correct IDs', () => {
  assert.match(indexHtml, /id="patternFilterContainer"/, 'Should contain patternFilterContainer');
  assert.match(indexHtml, /<select[^>]*id="filter-pattern-personality"[^>]*>/, 'Should contain select with id filter-pattern-personality');
  assert.match(indexHtml, /<input[^>]*type="checkbox"[^>]*id="filter-high-wr"[^>]*>/, 'Should contain checkbox with id filter-high-wr');
  assert.match(indexHtml, /Hanya Win Rate ≥ 60%/, 'Should contain label Hanya Win Rate ≥ 60%');
});

function assertPatternOptions(source) {
  const expectedOptions = [
    { value: 'all', label: 'Semua pola' },
    { value: 'COMBO_FX_TECH_MA5', label: 'Aliran asing + harga di atas MA5 (WR 64.2% · PF 2.06)' },
    { value: 'FX_STRONG_BUY', label: 'Akumulasi asing kuat (WR 61.2% · PF 1.80)' },
    { value: 'TECH_ABOVE_MA20', label: 'Harga di atas MA20 (WR 60.6% · PF 1.90)' },
    { value: 'TECH_ABOVE_MA5', label: 'Harga di atas MA5 (WR 60.1% · PF 1.89)' },
    { value: 'VOL_WARM_1P2_1P5', label: 'Volume 1,2–1,5× rata-rata (WR 60.0% · PF 1.46)' },
    { value: 'RSI_OVERBOUGHT_65P', label: 'Momentum RSI 65–69 (WR 59.8% · PF 1.73)' },
    { value: 'COMBO_BROKER_FX', label: 'Akumulasi broker + aliran asing (WR 57.1% · PF 1.71)' },
    { value: 'COMBO_BROKER_TECH', label: 'Akumulasi broker + harga di atas MA (WR 56.1% · PF 1.67)' },
    { value: 'TRAP_CHG5_VOL3_CLIMAX', label: 'Kenaikan ≥5% + volume ≥3× (WR 55.6% · PF 1.84)' },
    { value: 'BROKER_TOP3_CONCENTRATION', label: 'Konsentrasi akumulasi 3 broker teratas (WR 54.5% · PF 1.57)' }
  ];
  const select = source.match(/<select\b[^>]*id="filter-pattern-personality"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(select, 'canonical filter select exists');
  const actual = [...select[1].matchAll(/<option\b[^>]*value="([^"]+)"[^>]*>([\s\S]*?)<\/option>/g)].map(m => ({ value: m[1], label: m[2].trim() }));
  assert.deepEqual(actual.map(o => o.value), expectedOptions.map(o => o.value), 'internal enum values are unchanged');
  assert.deepEqual(actual.map(o => o.label), expectedOptions.map(o => o.label), 'visible labels are human-readable with original metrics');
}
test('T-UIPF-02: human labels retain all 10 original filter enum values and metrics', () => assertPatternOptions(indexHtml));
test('pattern filter negative controls reject changed enum values and raw labels', () => {
  assert.throws(() => assertPatternOptions(indexHtml.replace('value="FX_STRONG_BUY"', 'value="FX_CHANGED"')), assert.AssertionError);
  assert.throws(() => assertPatternOptions(indexHtml.replace('Akumulasi asing kuat (WR', 'FX_STRONG_BUY (WR')), assert.AssertionError);
});

test('T-UIPF-03: PATTERN_PERSONALITY_UI_CATALOG contains all 10 patterns with WR and PF metrics', () => {
  const match = indexHtml.match(/var PATTERN_PERSONALITY_UI_CATALOG = [\s\S]*?window\.patternPersonalityBadgeHtml = patternPersonalityBadgeHtml;/);
  assert.ok(match, 'pattern catalog snippet must be found in index.html');

  const ctx = { window: {}, escapeHtml: (s) => s };
  ctx.window = ctx;
  vm.runInNewContext(match[0], ctx);

  const catalog = ctx.PATTERN_PERSONALITY_UI_CATALOG;
  assert.ok(catalog, 'PATTERN_PERSONALITY_UI_CATALOG should exist');

  const keys = [
    'COMBO_FX_TECH_MA5',
    'FX_STRONG_BUY',
    'TECH_ABOVE_MA20',
    'TECH_ABOVE_MA5',
    'VOL_WARM_1P2_1P5',
    'RSI_OVERBOUGHT_65P',
    'COMBO_BROKER_FX',
    'COMBO_BROKER_TECH',
    'TRAP_CHG5_VOL3_CLIMAX',
    'BROKER_TOP3_CONCENTRATION'
  ];

  keys.forEach((k) => {
    assert.ok(catalog[k], `Catalog should have key ${k}`);
    assert.equal(typeof catalog[k].wr, 'number', `${k} wr should be a number`);
    assert.equal(typeof catalog[k].pf, 'number', `${k} pf should be a number`);
  });

  assert.equal(catalog.COMBO_FX_TECH_MA5.wr, 64.2);
  assert.equal(catalog.FX_STRONG_BUY.wr, 61.2);
  assert.equal(catalog.TECH_ABOVE_MA20.wr, 60.6);
  assert.equal(catalog.TECH_ABOVE_MA5.wr, 60.1);
  assert.equal(catalog.VOL_WARM_1P2_1P5.wr, 60.0);
  assert.equal(catalog.RSI_OVERBOUGHT_65P.wr, 59.8);
  assert.equal(catalog.COMBO_BROKER_FX.wr, 57.1);
  assert.equal(catalog.COMBO_BROKER_TECH.wr, 56.1);
  assert.equal(catalog.TRAP_CHG5_VOL3_CLIMAX.wr, 55.6);
  assert.equal(catalog.BROKER_TOP3_CONCENTRATION.wr, 54.5);
});

test('T-UIPF-04: extractPatternPersonalityKey extracts pattern key from multiple candidate fields', () => {
  const match = indexHtml.match(/var PATTERN_PERSONALITY_UI_CATALOG = [\s\S]*?window\.patternPersonalityBadgeHtml = patternPersonalityBadgeHtml;/);
  const ctx = { window: {}, escapeHtml: (s) => s };
  ctx.window = ctx;
  vm.runInNewContext(match[0], ctx);

  assert.equal(ctx.extractPatternPersonalityKey({ pattern_personality: 'COMBO_FX_TECH_MA5' }), 'COMBO_FX_TECH_MA5');
  assert.equal(ctx.extractPatternPersonalityKey({ patternPersonality: 'FX_STRONG_BUY' }), 'FX_STRONG_BUY');
  assert.equal(ctx.extractPatternPersonalityKey({ matched_pattern: 'TECH_ABOVE_MA20' }), 'TECH_ABOVE_MA20');
  assert.equal(ctx.extractPatternPersonalityKey({ pattern_key: 'TECH_ABOVE_MA5' }), 'TECH_ABOVE_MA5');
  assert.equal(ctx.extractPatternPersonalityKey({ notes: 'Edge: VOL_WARM_1P2_1P5 · WR 60%' }), 'VOL_WARM_1P2_1P5');
  assert.equal(ctx.extractPatternPersonalityKey({ status_reason: 'Edge: RSI_OVERBOUGHT_65P' }), 'RSI_OVERBOUGHT_65P');
  assert.equal(ctx.extractPatternPersonalityKey({}), '');
  assert.equal(ctx.extractPatternPersonalityKey(null), '');
});

test('T-UIPF-05: matchesPatternPersonalityFilters evaluates default all and specific pattern filters', () => {
  const match = indexHtml.match(/var PATTERN_PERSONALITY_UI_CATALOG = [\s\S]*?window\.patternPersonalityBadgeHtml = patternPersonalityBadgeHtml;/);
  const ctx = { window: {}, escapeHtml: (s) => s };
  ctx.window = ctx;
  vm.runInNewContext(match[0], ctx);

  const r1 = { ticker: 'BBCA', pattern_personality: 'COMBO_FX_TECH_MA5' };
  const r2 = { ticker: 'ASII', pattern_personality: 'FX_STRONG_BUY' };
  const r3 = { ticker: 'GOTO' }; // no pattern

  // Default 'all' without high WR toggle -> passes everything
  assert.equal(ctx.matchesPatternPersonalityFilters(r1, 'all', false), true);
  assert.equal(ctx.matchesPatternPersonalityFilters(r2, 'all', false), true);
  assert.equal(ctx.matchesPatternPersonalityFilters(r3, 'all', false), true);

  // Specific pattern filter -> only matching candidate passes
  assert.equal(ctx.matchesPatternPersonalityFilters(r1, 'COMBO_FX_TECH_MA5', false), true);
  assert.equal(ctx.matchesPatternPersonalityFilters(r2, 'COMBO_FX_TECH_MA5', false), false);
  assert.equal(ctx.matchesPatternPersonalityFilters(r3, 'COMBO_FX_TECH_MA5', false), false);
});

test('T-UIPF-06: matchesPatternPersonalityFilters isolates only Top 5 patterns when high WR toggle is active (WR >= 60%)', () => {
  const match = indexHtml.match(/var PATTERN_PERSONALITY_UI_CATALOG = [\s\S]*?window\.patternPersonalityBadgeHtml = patternPersonalityBadgeHtml;/);
  const ctx = { window: {}, escapeHtml: (s) => s };
  ctx.window = ctx;
  vm.runInNewContext(match[0], ctx);

  const top5 = [
    { ticker: 'T1', pattern_personality: 'COMBO_FX_TECH_MA5' }, // 64.2%
    { ticker: 'T2', pattern_personality: 'FX_STRONG_BUY' },     // 61.2%
    { ticker: 'T3', pattern_personality: 'TECH_ABOVE_MA20' },   // 60.6%
    { ticker: 'T4', pattern_personality: 'TECH_ABOVE_MA5' },    // 60.1%
    { ticker: 'T5', pattern_personality: 'VOL_WARM_1P2_1P5' }   // 60.0%
  ];

  const lowerWr = [
    { ticker: 'L1', pattern_personality: 'RSI_OVERBOUGHT_65P' },       // 59.8%
    { ticker: 'L2', pattern_personality: 'COMBO_BROKER_FX' },          // 57.1%
    { ticker: 'L3', pattern_personality: 'COMBO_BROKER_TECH' },        // 56.1%
    { ticker: 'L4', pattern_personality: 'TRAP_CHG5_VOL3_CLIMAX' },    // 55.6%
    { ticker: 'L5', pattern_personality: 'BROKER_TOP3_CONCENTRATION' },// 54.5%
    { ticker: 'L6' } // None
  ];

  top5.forEach((item) => {
    assert.equal(ctx.matchesPatternPersonalityFilters(item, 'all', true), true, `${item.pattern_personality} should pass WR >= 60%`);
  });

  lowerWr.forEach((item) => {
    assert.equal(ctx.matchesPatternPersonalityFilters(item, 'all', true), false, `${item.pattern_personality || 'none'} should be rejected by WR >= 60%`);
  });
});

test('T-UIPF-07: Conjunctive logic (AND) between specific pattern filter and high WR toggle', () => {
  const match = indexHtml.match(/var PATTERN_PERSONALITY_UI_CATALOG = [\s\S]*?window\.patternPersonalityBadgeHtml = patternPersonalityBadgeHtml;/);
  const ctx = { window: {}, escapeHtml: (s) => s };
  ctx.window = ctx;
  vm.runInNewContext(match[0], ctx);

  const highCand = { ticker: 'BBCA', pattern_personality: 'COMBO_FX_TECH_MA5' };
  const lowCand = { ticker: 'BRPT', pattern_personality: 'BROKER_TOP3_CONCENTRATION' };

  // High WR pattern matching selected pattern -> PASS
  assert.equal(ctx.matchesPatternPersonalityFilters(highCand, 'COMBO_FX_TECH_MA5', true), true);

  // High WR pattern but wrong pattern selected -> FAIL
  assert.equal(ctx.matchesPatternPersonalityFilters(highCand, 'FX_STRONG_BUY', true), false);

  // Pattern matches selected, but WR < 60% with toggle active -> FAIL
  assert.equal(ctx.matchesPatternPersonalityFilters(lowCand, 'BROKER_TOP3_CONCENTRATION', true), false);
});

test('T-UIPF-08: Empty state message helper provides friendly feedback when pattern filter is active', () => {
  const scriptSnippet = indexHtml.match(/function getPatternPersonalityEmptyMessage[\s\S]*?window\.getPatternPersonalityEmptyMessage = getPatternPersonalityEmptyMessage;/);
  assert.ok(scriptSnippet, 'getPatternPersonalityEmptyMessage must exist in index.html');

  const fakeDom = {
    'filter-pattern-personality': { value: 'all' },
    'filter-high-wr': { checked: false }
  };

  const ctx = {
    window: {},
    STRICT_EMPTY_TEXT: 'Belum ada data',
    document: {
      getElementById: (id) => fakeDom[id] || null
    }
  };
  ctx.window = ctx;
  vm.runInNewContext(scriptSnippet[0], ctx);

  // Inactive filters -> returns default
  assert.equal(ctx.getPatternPersonalityEmptyMessage('Custom Default'), 'Custom Default');

  // Dropdown active -> returns friendly filter empty message
  fakeDom['filter-pattern-personality'].value = 'FX_STRONG_BUY';
  assert.equal(ctx.getPatternPersonalityEmptyMessage('Custom Default'), 'Tidak ada saham yang cocok dengan filter Pattern Personality / Win Rate yang dipilih.');

  // Dropdown reset, checkbox active -> returns friendly filter empty message
  fakeDom['filter-pattern-personality'].value = 'all';
  fakeDom['filter-high-wr'].checked = true;
  assert.equal(ctx.getPatternPersonalityEmptyMessage('Custom Default'), 'Tidak ada saham yang cocok dengan filter Pattern Personality / Win Rate yang dipilih.');
});
