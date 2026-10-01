'use strict';

/**
 * AUDIT FASE 10 (BATCH 6) — Telegram Template Formatting & HTML Parse Safety
 *
 * Regression suite for the template layer that every Telegram alert funnels
 * through:
 *   - lib/telegram-templates.js
 *
 * Findings covered (each test FAILS on the pre-fix code):
 *   F10T-01  fmtSignedValue leaked numeric strings verbatim (no +/- sign format)
 *   F10T-02  fmtSignedValue leaked sentinel strings ('NaN'/'undefined'/'null')
 *   F10T-03  no HTML entity encoder existed for parse_mode:'HTML' consumers
 *   F10T-04  escapeHtml must be null-safe and stringify numbers
 *   F10T-05  escaped output must survive a <b>…</b> Telegram wrapper
 *   F10T-06  signal card must never leak NaN / undefined / null% placeholders
 *   F10T-07  monitor hit message must not render a raw 'Net Flow: NaN' line
 *   F10T-08  safe() must keep comparison operators (< >) intact (regression guard)
 *
 * LOCAL / OFFLINE ONLY — pure formatting, no network, no timers.
 *
 * NOTE: entity literals are assembled with String.fromCharCode(38) because a
 * literal ampersand sequence in source is fragile across editors/transforms
 * (same idiom as lib/foreign-flow-recap.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const templates = require('../lib/telegram-templates');

const AMP = String.fromCharCode(38);
const AMP_ENTITY = AMP + 'amp;';
const LT_ENTITY = AMP + 'lt;';
const GT_ENTITY = AMP + 'gt;';

// ---------------------------------------------------------------------------
// F10T-01 — fmtSignedValue numeric-string precision (+/- sign format)
// ---------------------------------------------------------------------------
test('F10T-01 fmtSignedValue must sign-format numeric strings, not leak them verbatim', () => {
  assert.equal(templates.fmtSignedValue('5000000000'), '+Rp5,0 M', 'positive numeric string must render with + sign');
  assert.equal(templates.fmtSignedValue('-2500000000'), '-Rp2,5 M', 'negative numeric string must render with - sign');
  assert.equal(templates.fmtSignedValue('1000000'), '+Rp1 jt', 'millions bucket must be used');
  assert.equal(templates.fmtSignedValue('1500'), '+Rp1.500', 'small values must use the grouped rupiah format');
});

// ---------------------------------------------------------------------------
// F10T-02 — fmtSignedValue sentinel sanitisation
// ---------------------------------------------------------------------------
test('F10T-02 fmtSignedValue must sanitise sentinel strings to the honest - placeholder', () => {
  assert.equal(templates.fmtSignedValue('NaN'), '-');
  assert.equal(templates.fmtSignedValue('undefined'), '-');
  assert.equal(templates.fmtSignedValue('null'), '-');
  assert.equal(templates.fmtSignedValue('[object Object]'), '-');
  assert.equal(templates.fmtSignedValue('   '), '-');
});

test('F10T-02b fmtSignedValue must keep already-formatted values verbatim', () => {
  assert.equal(templates.fmtSignedValue('+Rp 1 M'), '+Rp 1 M');
  assert.equal(templates.fmtSignedValue('-Rp 2,5 M'), '-Rp 2,5 M');
});

test('F10T-02c fmtSignedValue numeric inputs keep their sign semantics', () => {
  assert.equal(templates.fmtSignedValue(0), '-');
  assert.equal(templates.fmtSignedValue(NaN), '-');
  assert.equal(templates.fmtSignedValue(null), '-');
  assert.equal(templates.fmtSignedValue(1500000), '+Rp2 jt');
  assert.equal(templates.fmtSignedValue(-1500000000), '-Rp1,5 M');
});

// ---------------------------------------------------------------------------
// F10T-03 — HTML entity encoder for parse_mode:'HTML'
// ---------------------------------------------------------------------------
test('F10T-03 escapeHtml must neutralise amp, lt and gt for Telegram HTML parse_mode', () => {
  assert.equal(typeof templates.escapeHtml, 'function', 'escapeHtml must be exported so HTML consumers can escape interpolated values');
  assert.equal(templates.escapeHtml('A' + AMP + 'B'), 'A' + AMP_ENTITY + 'B');
  assert.equal(templates.escapeHtml('1 < 2 > 0'), '1 ' + LT_ENTITY + ' 2 ' + GT_ENTITY + ' 0');
  assert.equal(templates.escapeHtml('<b>bold</b>'), LT_ENTITY + 'b' + GT_ENTITY + 'bold' + LT_ENTITY + '/b' + GT_ENTITY);
  assert.equal(templates.escapeHtml(LT_ENTITY + 'already' + GT_ENTITY), AMP_ENTITY + 'lt;already' + AMP_ENTITY + 'gt;');
});

test('F10T-04 escapeHtml must be null-safe and stringify numbers', () => {
  assert.equal(templates.escapeHtml(null), '');
  assert.equal(templates.escapeHtml(undefined), '');
  assert.equal(templates.escapeHtml(42), '42');
  assert.equal(templates.escapeHtml(0), '0');
});

test('F10T-05 an escaped ticker must survive a Telegram <b> wrapper with zero raw entities', () => {
  const line = '<b>' + templates.escapeHtml('A' + AMP + 'B<C>') + '</b>';
  assert.equal(line, '<b>A' + AMP_ENTITY + 'B' + LT_ENTITY + 'C' + GT_ENTITY + '</b>');
  const inner = line.slice(3, -4);
  // Strip the three legal entities; anything raw (amp, lt, gt) left means
  // Telegram would answer 400 Bad Request: can't parse entities.
  const stripped = inner
    .split(AMP_ENTITY).join('')
    .split(LT_ENTITY).join('')
    .split(GT_ENTITY).join('');
  assert.equal(/[<>&]/.test(stripped), false, 'no raw entity character may survive inside the bold tag');
});

// ---------------------------------------------------------------------------
// F10T-06 / F10T-07 — signal rendering precision
// ---------------------------------------------------------------------------
test('F10T-06 signal card must not leak NaN/undefined/null% placeholders', () => {
  const card = templates.formatSignalCard({
    ticker: 'TEST',
    status: 'READY_BREAKOUT',
    entry_low: NaN,
    entry_high: undefined,
    stop_loss: null,
    tp1: NaN,
    tp2: undefined,
    risk_reward: NaN,
    last_price: NaN,
    volume_ratio_20d: NaN
  }, 1, 'daytrade');
  assert.doesNotMatch(card, /NaN/);
  assert.doesNotMatch(card, /undefined/);
  assert.doesNotMatch(card, /null%/);
});

test('F10T-07 monitor hit message must not render a raw NaN net-flow string', () => {
  const msg = templates.formatMonitorHitMessage(
    { ticker: 'BBRI', category: 'Swing Konglo', monitor_source: 'swing_konglo', entry1: 5000, entry2: 4950, tp1: 5400, sl: 4750 },
    { status: 'EARLY_EXIT_DISTRIBUTION', cr3: 65, cr5: 78, net_flow: 'NaN', retail_participation: 58 },
    { last: 4920 }
  );
  assert.doesNotMatch(msg, /Net Flow: NaN/);
  assert.match(msg, /Net Flow: -/);
});

test('F10T-08 safe() must keep comparison operators intact (no tag stripping of lt/gt)', () => {
  const raw = 'Beli jika Price < 1500 dan MA > 1200';
  assert.equal(templates.safe(raw), raw);
});
