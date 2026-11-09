#!/usr/bin/env node
'use strict';

/**
 * test/v5/market-data-contract.test.js
 * ============================================================================
 * UNIT TESTS — lib/market-data-contract.js
 * ============================================================================
 *
 * These tests exist to make the V5 P0 fix *falsifiable*:
 *   - `0` must survive as a known value (BUG-V5-P1-023 anti-pattern).
 *   - Unknown must be `null`, never a believable default (P0-001/P0-002).
 *   - `pick()` must never manufacture a fallback constant.
 *   - OHLCV violations must be rejected (N6).
 *   - Unknown must render `'—'`, and a known `0` must NOT render `'—'`
 *     (P0-011 class: "Rp 0" vs "no data").
 *
 * Run:
 *   node test/v5/market-data-contract.test.js
 *
 * Exits 0 when every assertion holds, 1 otherwise.
 * ============================================================================
 */

const path = require('node:path');
const assert = require('node:assert');

const C = require(path.resolve(__dirname, '..', '..', 'lib', 'market-data-contract.js'));

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    process.stdout.write('PASS  ' + name + '\n');
  } catch (err) {
    results.push({ name, ok: false, error: String((err && err.message) || err) });
    process.stdout.write('FAIL  ' + name + '\n      ' + String((err && err.message) || err) + '\n');
  }
}

/* -------------------------------------------------------------------------- */
/* DATA_STATUS vocabulary                                                     */
/* -------------------------------------------------------------------------- */

test('DATA_STATUS exposes the full frozen vocabulary', () => {
  const expected = ['AVAILABLE', 'PARTIAL', 'STALE', 'NOT_PUBLISHED', 'SOURCE_UNAVAILABLE', 'VALIDATION_FAILED', 'QUARANTINED'];
  assert.deepStrictEqual(Object.keys(C.DATA_STATUS), expected);
  assert.strictEqual(Object.isFrozen(C.DATA_STATUS), true);
  // Every listed value is the upper-case key itself (no accidental aliasing).
  for (const key of expected) assert.strictEqual(C.DATA_STATUS[key], key);
});

/* -------------------------------------------------------------------------- */
/* isKnown — 0 IS known                                                       */
/* -------------------------------------------------------------------------- */

test('isKnown(0) === true and isKnown(0.0) === true', () => {
  assert.strictEqual(C.isKnown(0), true);
  assert.strictEqual(C.isKnown(0.0), true);
  assert.strictEqual(C.isKnown(-0), true);
  assert.strictEqual(C.isKnownNumber(0), true);
  assert.strictEqual(C.numberOrNull(0), 0);
});

test('isKnown rejects every unknown shape, including NaN and empty string', () => {
  for (const v of [null, undefined, NaN, '', '   ', Infinity, -Infinity, {}, []]) {
    assert.strictEqual(C.isKnown(v), false, 'expected unknown: ' + String(v));
  }
});

test('isKnown accepts finite numbers and non-empty text', () => {
  assert.strictEqual(C.isKnown(1), true);
  assert.strictEqual(C.isKnown(-12.5), true);
  assert.strictEqual(C.isKnown('BREN'), true);
  assert.strictEqual(C.isKnown('0'), true, 'the string "0" is a known datum');
});

/* -------------------------------------------------------------------------- */
/* unknown() — the single canonical sentinel                                  */
/* -------------------------------------------------------------------------- */

test('unknown() returns null and nothing else', () => {
  assert.strictEqual(C.unknown(), null);
  assert.strictEqual(C.UNKNOWN, null);
});

test('numberOrNull preserves 0 but nulls non-finite input', () => {
  assert.strictEqual(C.numberOrNull(0), 0);
  assert.strictEqual(C.numberOrNull('0'), 0);
  assert.strictEqual(C.numberOrNull('2100'), 2100);
  assert.strictEqual(C.numberOrNull(null), null);
  assert.strictEqual(C.numberOrNull(NaN), null);
  assert.strictEqual(C.numberOrNull(''), null);
  assert.strictEqual(C.numberOrNull('abc'), null);
});

/* -------------------------------------------------------------------------- */
/* pick() — never fabricates a fallback constant                              */
/* -------------------------------------------------------------------------- */

test('pick() returns the first known value, preserving 0', () => {
  assert.strictEqual(C.pick(0, 82), 0, 'zero must win over a later default');
  assert.strictEqual(C.pick(null, 0, 82), 0);
  assert.strictEqual(C.pick(undefined, '', 2100), 2100);
  assert.strictEqual(C.pick('BREN', 'fallback'), 'BREN');
});

test('pick() returns null (never a constant) when every candidate is unknown', () => {
  assert.strictEqual(C.pick(), null);
  assert.strictEqual(C.pick(null, undefined, NaN, ''), null);
  // The exact P0-002 shapes: `item.score || 82`, `item.chg || 1.8`.
  assert.strictEqual(C.pick(null, undefined), null);
});

test('pickNumber() ignores non-numeric text instead of coercing it', () => {
  assert.strictEqual(C.pickNumber('abc', null, 0), 0);
  assert.strictEqual(C.pickNumber('abc', null), null);
  assert.strictEqual(C.pickNumber(undefined, 2.46), 2.46);
});

test('pickText() trims and rejects empty/whitespace text', () => {
  assert.strictEqual(C.pickText('', '   ', ' Swing Ready '), 'Swing Ready');
  assert.strictEqual(C.pickText('', null), null);
});

/* -------------------------------------------------------------------------- */
/* formatValue — '—' for unknown, never for a known zero                      */
/* -------------------------------------------------------------------------- */

test("unknown value renders the em dash '—'", () => {
  assert.strictEqual(C.formatValue(null), '\u2014');
  assert.strictEqual(C.formatValue(undefined), '\u2014');
  assert.strictEqual(C.formatValue(NaN), '\u2014');
  assert.strictEqual(C.formatValue(''), '\u2014');
  for (const unit of ['price', 'pct', 'idr', 'volume']) {
    assert.strictEqual(C.formatValue(null, { unit }), '\u2014', 'unit=' + unit);
  }
});

test('a known zero renders a real zero, never the em dash (P0-011 class)', () => {
  assert.strictEqual(C.formatValue(0), '0');
  assert.strictEqual(C.formatPercent(0), '0,00%');
  assert.strictEqual(C.formatIDR(0), 'Rp 0');
  assert.strictEqual(C.formatVolume(0), '0 lembar');
  assert.strictEqual(C.formatPrice(0), 'Rp 0');
});

test('formatters use the repository conventions', () => {
  assert.strictEqual(C.formatPrice(2100), 'Rp 2.100');
  assert.strictEqual(C.formatPercent(1.45), '+1,45%');
  assert.strictEqual(C.formatPercent(-0.82), '\u22120,82%');
  assert.strictEqual(C.formatIDR(36977850000), 'Rp 36.98 M');
  assert.strictEqual(C.formatVolume(17608500), '17,61 Jt lembar');
});

/* -------------------------------------------------------------------------- */
/* attachProvenance                                                           */
/* -------------------------------------------------------------------------- */

test('attachProvenance records source, trade date and status', () => {
  const row = C.attachProvenance({ ticker: 'BREN', last_price: 2100 }, {
    source: 'data/screener-v3f04-daytrade.json#radar',
    tradeDate: '2026-11-03',
    sourceTimestamp: '2026-11-03T15:43:21.260Z',
    status: C.DATA_STATUS.AVAILABLE
  });
  assert.strictEqual(row.ticker, 'BREN');
  assert.strictEqual(row.last_price, 2100);
  assert.strictEqual(row.data_status, 'AVAILABLE');
  assert.strictEqual(row.provenance.source, 'data/screener-v3f04-daytrade.json#radar');
  assert.strictEqual(row.provenance.tradeDate, '2026-11-03');
  assert.strictEqual(row.provenance.synthetic, false);
  assert.ok(row.provenance.ingestionTimestamp, 'ingestion timestamp is always stamped');
});

test('attachProvenance refuses an unknown status and never invents one silently', () => {
  const row = C.attachProvenance({ ticker: 'XXXX' }, { source: 'x.json', status: 'TOTALLY_MADE_UP' });
  // Falls back to the source-derived status, not to the bogus token.
  assert.strictEqual(row.data_status, 'AVAILABLE');
  assert.strictEqual(C.normalizeStatus('not_a_status'), null);
  assert.strictEqual(C.normalizeStatus('partial'), 'PARTIAL');
});

test('attachProvenance with no source reports SOURCE_UNAVAILABLE', () => {
  const row = C.attachProvenance({ ticker: 'XXXX' }, {});
  assert.strictEqual(row.data_status, 'SOURCE_UNAVAILABLE');
  assert.strictEqual(row.provenance.source, null);
});

/* -------------------------------------------------------------------------- */
/* validateOhlcv                                                              */
/* -------------------------------------------------------------------------- */

test('validateOhlcv accepts a structurally valid bar, volume 0 included', () => {
  const res = C.validateOhlcv({ open: 2070, high: 2170, low: 1935, close: 2100, volume: 17608500 });
  assert.strictEqual(res.valid, true, JSON.stringify(res.errors));
  assert.deepStrictEqual(res.errors, []);
  assert.strictEqual(C.validateOhlcv({ open: 10, high: 10, low: 10, close: 10, volume: 0 }).valid, true);
});

test('validateOhlcv rejects high below low', () => {
  const res = C.validateOhlcv({ open: 100, high: 90, low: 110, close: 100, volume: 1 });
  assert.strictEqual(res.valid, false);
  assert.ok(res.errors.includes('HIGH_BELOW_LOW'), JSON.stringify(res.errors));
});

test('validateOhlcv rejects open and close outside [low, high]', () => {
  const openOut = C.validateOhlcv({ open: 120, high: 110, low: 100, close: 105, volume: 1 });
  assert.strictEqual(openOut.valid, false);
  assert.ok(openOut.errors.includes('OPEN_OUTSIDE_LOW_HIGH'), JSON.stringify(openOut.errors));

  const closeOut = C.validateOhlcv({ open: 105, high: 110, low: 100, close: 130, volume: 1 });
  assert.strictEqual(closeOut.valid, false);
  assert.ok(closeOut.errors.includes('CLOSE_OUTSIDE_LOW_HIGH'), JSON.stringify(closeOut.errors));
});

test('validateOhlcv rejects negative volume and an unknown price', () => {
  const negVol = C.validateOhlcv({ open: 100, high: 110, low: 90, close: 105, volume: -1 });
  assert.strictEqual(negVol.valid, false);
  assert.ok(negVol.errors.includes('NEGATIVE_VOLUME'), JSON.stringify(negVol.errors));

  const missing = C.validateOhlcv({ open: null, high: 110, low: 90, close: 105, volume: 1 });
  assert.strictEqual(missing.valid, false);
  assert.ok(missing.errors.includes('OPEN_NOT_NUMERIC'), JSON.stringify(missing.errors));

  assert.strictEqual(C.validateOhlcv(null).valid, false);
});

/* -------------------------------------------------------------------------- */
/* guardConstantPrice                                                         */
/* -------------------------------------------------------------------------- */

test('guardConstantPrice rejects an unbacked synthetic constant', () => {
  assert.throws(() => C.guardConstantPrice(1550, [1550]), /SYNTHETIC_PRICE_CONSTANT/);
  assert.throws(() => C.guardConstantPrice(1420), /SYNTHETIC_PRICE_CONSTANT/);

  const soft = C.guardConstantPrice(380, null, { throwOnViolation: false });
  assert.ok(soft instanceof Error);
  assert.strictEqual(soft.code, 'SYNTHETIC_PRICE_CONSTANT');
});

test('guardConstantPrice accepts a real price even when the number is a known constant', () => {
  // DSNG genuinely trades at 1550 in the source file; provenance makes it real.
  assert.strictEqual(C.guardConstantPrice(1550, [1550], { provenance: 'data/screener-v3f04-konglo.json' }), null);
  assert.strictEqual(C.guardConstantPrice(2100), null);
  assert.strictEqual(C.guardConstantPrice(null), null);
});

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

const failed = results.filter((r) => !r.ok);
process.stdout.write('\n' + (results.length - failed.length) + '/' + results.length + ' assertions passed\n');
if (failed.length > 0) {
  for (const f of failed) process.stdout.write('  FAILED: ' + f.name + ' -> ' + f.error + '\n');
  process.exit(1);
}
process.exit(0);