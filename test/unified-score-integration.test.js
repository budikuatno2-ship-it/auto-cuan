'use strict';

/**
 * Unified Scoring — integration & backward-compatibility contract.
 *
 * `unified-score.test.js` proves the math. This file proves the *wiring*: that
 * the module is actually called on every path that feeds a stock card, and that
 * the 159-field frontend contract in public/index.html survives the change.
 *
 * The static assertions below are intentionally reading the source rather than
 * executing it, because api/sector-hot.js is a 15k-line serverless handler whose
 * enrichment paths require Supabase, Yahoo, and disk caches to run. Asserting on
 * the source is how we catch "someone added a new screener path and forgot the
 * unified call" without standing up the whole stack.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const unified = require('../lib/unified-score');

test('lib/unified-score.js exports the documented public API', () => {
  const api = [
    'calculateUnifiedScore', 'applyUnifiedScore', 'applyUnifiedScoreBatch',
    'getUnifiedScore', 'gradeFor', 'resolveVolumeRatio',
    'WEIGHTS', 'HARD_PENALTIES', 'SCORE_ALIASES', 'VOLUME_RATIO_ALIASES'
  ];
  for (const name of api) {
    assert.ok(unified[name] !== undefined, 'missing export: ' + name);
  }
});

// ---------------------------------------------------------------------------
// Wiring: every card-feeding path must call the unified engine
// ---------------------------------------------------------------------------

test('api/sector-hot.js requires lib/unified-score', () => {
  const src = read('api/sector-hot.js');
  assert.match(src, /require\(['"]\.\.\/lib\/unified-score['"]\)/,
    'sector-hot.js must require the unified scoring module');
});

test('enrichConfluenceRows applies the unified score', () => {
  const src = read('api/sector-hot.js');
  const fnStart = src.indexOf('async function enrichConfluenceRows');
  assert.ok(fnStart > -1, 'enrichConfluenceRows must exist');
  // Grab a generous window — the function is short but the file is minified-ish
  // in places, so we search the body rather than counting braces.
  const body = src.slice(fnStart, fnStart + 2000);
  assert.match(body, /unifiedScore\.applyUnifiedScore\(/,
    'enrichConfluenceRows (Swing Konglo + Non-Konglo + Day Trade cards) must apply the unified score');
});

test('the Top 5 row-assembly path applies the unified score', () => {
  const src = read('api/sector-hot.js');
  const marker = 'bandarmologiConfluence.computeBandarmologiConfluence(out.ticker)';
  const idx = src.indexOf(marker);
  assert.ok(idx > -1, 'Top 5 row assembly must exist');
  const window = src.slice(idx, idx + 1200);
  assert.match(window, /unifiedScore\.applyUnifiedScore\(/,
    'the Top 5 path has its own row assembly and must apply the unified score too');
});

test('the unified score is applied after bandarmologi enrichment', () => {
  // Ordering matters: the bandarmologi component reads CR3/CR5 metrics and the
  // bandar verdict, which are only present after enrichCandidateWithBandarmologi.
  const src = read('api/sector-hot.js');
  const fnStart = src.indexOf('async function enrichConfluenceRows');
  const body = src.slice(fnStart, fnStart + 2000);
  const bandarIdx = body.indexOf('enrichCandidateWithBandarmologi');
  const unifiedIdx = body.indexOf('unifiedScore.applyUnifiedScore');
  assert.ok(bandarIdx > -1 && unifiedIdx > -1);
  assert.ok(unifiedIdx > bandarIdx,
    'unified score must run after bandarmologi enrichment so CR3/CR5 are available');
});

// ---------------------------------------------------------------------------
// Telegram / web parity (Fase 3 Langkah 3)
// ---------------------------------------------------------------------------

test('getTelegramScore prefers unified_score', () => {
  const src = read('api/sector-hot.js');
  const fnStart = src.indexOf('function getTelegramScore');
  assert.ok(fnStart > -1);
  const body = src.slice(fnStart, fnStart + 700);
  assert.match(body, /toNum\(r\.unified_score\)/,
    'getTelegramScore must read unified_score first so Telegram matches the web card');
});

test('computeTelegramConvictionScore returns unified_score verbatim', () => {
  const src = read('api/sector-hot.js');
  const fnStart = src.indexOf('function computeTelegramConvictionScore');
  assert.ok(fnStart > -1);
  const body = src.slice(fnStart, fnStart + 900);
  assert.match(body, /toNum\(r\.unified_score\)/,
    'the conviction derivation must short-circuit on unified_score');
  assert.match(body, /if \(unified !== null\) return unified;/,
    'it must return the unified number unchanged, with no further adjustment');
});

test('the interactive bot prefers unified_score in its scan card', () => {
  const src = read('lib/telegram-interactive-bot.js');
  assert.match(src, /row\.unified_score != null \? row\.unified_score/,
    'formatScanCard must prefer unified_score');
});

test('the interactive bot prefers unified_score for the AI opinion payload', () => {
  const src = read('lib/telegram-interactive-bot.js');
  const occurrences = (src.match(/row\.unified_score != null \? row\.unified_score/g) || []).length;
  assert.ok(occurrences >= 2,
    'both formatScanCard and the /opini payload must prefer unified_score (found ' + occurrences + ')');
});

test('telegram-templates prefers unified_score', () => {
  const src = read('lib/telegram-templates.js');
  assert.match(src, /r\.unified_score \|\| r\.conviction_score/,
    'the template score resolver must try unified_score first');
});

// ---------------------------------------------------------------------------
// Frontend contract preservation (Fase 3 Langkah 2)
// ---------------------------------------------------------------------------

test('the frontend still reads the three score fields we now write', () => {
  // If a future refactor renames these in public/index.html, the alias list in
  // lib/unified-score.js becomes stale and cards silently show nothing.
  const html = read('public/index.html');
  assert.match(html, /r\.daytrade_score/, 'Day Trade card must still read r.daytrade_score');
  assert.match(html, /var sc = r\.score \|\| 0;/, 'Konglo/Non-Konglo cards must still read r.score');
  assert.match(html, /r\.combined_score/, 'Top 5 must still read r.combined_score');
});

test('the frontend still reads the three volume-ratio fields we now write', () => {
  const html = read('public/index.html');
  assert.match(html, /r\.volume_ratio_20d/, 'Day Trade card reads volume_ratio_20d');
  assert.match(html, /r\.volume_ratio != null/, 'Konglo/Non-Konglo cards read volume_ratio');
  assert.match(html, /formatRatio\(r\.volume_ratio_avg20\)/, 'the table reads volume_ratio_avg20');
});

test('the frontend trading-plan contract is untouched by this change', () => {
  const html = read('public/index.html');
  // normalizeDisplayLevels() is the single client-side normaliser; the unified
  // engine must never rewrite the fields it consumes.
  for (const field of ['entry_low', 'entry_high', 'stop_loss', 'tp1', 'tp2', 'risk_reward']) {
    assert.ok(html.includes('r.' + field), 'frontend must still read r.' + field);
  }
});

test('the frontend bandar badge contract is untouched by this change', () => {
  const html = read('public/index.html');
  assert.match(html, /r\.bandar_label/, 'the bandar badge reads r.bandar_label');
  assert.match(html, /r\.bandar_consistent_windows/, 'the bandar badge reads r.bandar_consistent_windows');
});

test('the legacy additive bandar formula fields are neutralised before the card sees them', () => {
  // The Konglo card prints "(Base: N + Bandar: +M)" when both are truthy. Since
  // bandarmologi is now a 25-pt component, that formula must not survive.
  const row = {
    ticker: 'X', category: 'Swing Konglo',
    score: 78, score_before_bandarmologi: 78, bandar_score_bonus: 4,
    bandar_label: 'Accumulation'
  };
  unified.applyUnifiedScore(row);
  const cardWouldPrintFormula = row.score_before_bandarmologi != null && row.bandar_score_bonus;
  assert.ok(!cardWouldPrintFormula, 'the card must not print the stale Base+Bandar formula');
});

test('a full round-trip keeps every frontend-consumed field populated', () => {
  // Simulate the exact sequence enrichConfluenceRows performs, then assert the
  // fields the card layer reads are all still present and well-typed.
  const row = {
    ticker: 'BBCA', category: 'Swing Konglo',
    last_price: 8750, change_pct: 1.2, swing_tier: 'SWING_READY',
    entry_low: 8600, entry_high: 8750, stop_loss: 8400, tp1: 9200, tp2: 9600,
    risk_reward: 2.1,
    bandar_label: 'Accumulation', bandar_consistent_windows: ['7D', '1M'],
    bandarmologi_metrics: { cr3: 0.65, cr5: 0.82 },
    volume_ratio_20d: 1.8, value_today: 80e9,
    foreign_1d: 3e9, foreign_3d: 8e9, foreign_7d: 20e9,
    ma20: 8600, ma50: 8400, rsi14: 58,
    status_reason: 'Akumulasi bandar terdeteksi',
    score: 72
  };

  unified.applyUnifiedScore(row, { mode: 'swing' });

  // Identity
  assert.strictEqual(row.ticker, 'BBCA');
  assert.strictEqual(row.swing_tier, 'SWING_READY');
  // Score — all four aliases identical
  const scores = [row.unified_score, row.score, row.daytrade_score, row.combined_score];
  assert.strictEqual(new Set(scores).size, 1, 'all score aliases must be identical');
  assert.ok(row.unified_score >= 0 && row.unified_score <= 100);
  // Trading plan — untouched
  assert.strictEqual(row.entry_low, 8600);
  assert.strictEqual(row.entry_high, 8750);
  assert.strictEqual(row.stop_loss, 8400);
  assert.strictEqual(row.tp1, 9200);
  assert.strictEqual(row.tp2, 9600);
  assert.strictEqual(row.risk_reward, 2.1);
  // Bandarmologi — untouched
  assert.strictEqual(row.bandar_label, 'Accumulation');
  assert.deepStrictEqual(row.bandar_consistent_windows, ['7D', '1M']);
  // Volume — all three aliases identical (frontend Bug #1)
  assert.strictEqual(row.volume_ratio_20d, 1.8);
  assert.strictEqual(row.volume_ratio, 1.8);
  assert.strictEqual(row.volume_ratio_avg20, 1.8);
  // Audit trail
  assert.strictEqual(row.score_before_unified, 72);
  assert.ok(Array.isArray(row.unified_score_breakdown));
});

test('the score colour bands still receive a valid number', () => {
  // public/index.html picks a colour with `sc >= 80 / 65 / 50`. A null or NaN
  // would fall through to the red band and paint a healthy ticker as danger.
  const rows = [
    { ticker: 'A', category: 'Swing Konglo', bandar_label: 'Accumulation', value_today: 50e9, volume_ratio_20d: 2, risk_reward: 3, ma20: 100, ma50: 95, last_price: 110, rsi14: 55 },
    { ticker: 'B', category: 'Day Trade', bandar_label: 'Distribution', entry_chase_pct: 9 },
    { ticker: 'C', category: 'Swing Non-Konglo' }
  ];
  for (const row of rows) {
    unified.applyUnifiedScore(row);
    assert.ok(Number.isFinite(row.score), row.ticker + ': score must be a finite number');
    assert.ok(row.score >= 0 && row.score <= 100, row.ticker + ': score must be 0-100');
  }
});
