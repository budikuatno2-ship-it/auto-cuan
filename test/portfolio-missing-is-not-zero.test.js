'use strict';

// ===========================================================================
// MISSING DATA IS NOT ZERO.
//
// JavaScript coerces Number(null), Number(''), Number('   ') and Number([]) all
// to 0, and 0 is finite. public/portfolio-command-center.js accepted that in
// four helpers, so:
//
//   num(null)      -> 0            an absent value became a real one
//   money(null)    -> "Rp 0"       an unknown price became a confident zero
//   pct(null)      -> "0.00%"      an unknown percentage became flat
//   pnlClass(null) -> flat         "exactly break-even" about a position whose
//                                  price we never had
//
// On a financial surface that is not a formatting nit — it is the product
// asserting a number it does not hold. It reached the current-price column, the
// P/L column, the ticker drawer, optional TP1/TP2 on saveOwned(), journal
// numeric fields, and quote() responses with no usable price.
//
// A single `finite()` gate now separates missing from zero. Genuine 0, '0' and
// 0.0 remain real readings and are still rendered.
//
// No formula changed. num()'s stripping character class is byte-identical to
// the original, because how a typed string maps to a number is input semantics;
// only the empty case moved.
//
// The helpers are extracted from the real source and executed, so these are
// behavioural assertions rather than string matching. LOCAL / STATIC ONLY.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'portfolio-command-center.js'), 'utf8'
);

// Pull the helper block out of the IIFE and evaluate just that.
const helpers = (() => {
  const start = SOURCE.indexOf('function finite(');
  const end = SOURCE.indexOf('function ticker(');
  assert.ok(start > 0 && end > start, 'the helper block must be locatable');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    SOURCE.slice(start, end) + '\nthis.finite=finite;this.num=num;this.money=money;this.pct=pct;this.pnlClass=pnlClass;',
    sandbox
  );
  return sandbox;
})();

const { num, money, pct, pnlClass } = helpers;

// The exact matrix the audit asked for.
const MISSING = [
  ['null', null],
  ['undefined', undefined],
  ['empty string', ''],
  ['whitespace', '   '],
  ['tab and newline', '\t\n'],
  ['invalid string', 'abc'],
  ['non-numeric symbols', '--'],
  ['boolean true', true],
  ['boolean false', false],
  ['NaN', NaN],
  ['Infinity', Infinity]
];

const GENUINE_ZERO = [['number 0', 0], ['string "0"', '0'], ['float 0.0', 0.0], ['"0.00"', '0.00']];

// ---------------------------------------------------------------------------
// Missing must read as missing
// ---------------------------------------------------------------------------

for (const [label, value] of MISSING) {
  test('num(' + label + ') is missing, not 0', () => {
    assert.equal(num(value), null, label + ' must not become a real number');
  });

  test('money(' + label + ') renders an em dash, not Rp 0', () => {
    const out = money(value);
    assert.equal(out, '—');
    assert.doesNotMatch(out, /Rp/, 'the product must not assert a currency amount it does not have');
    assert.doesNotMatch(out, /0/);
  });

  test('pct(' + label + ') renders an em dash, not 0.00%', () => {
    const out = pct(value);
    assert.equal(out, '—');
    assert.doesNotMatch(out, /%/);
  });

  test('pnlClass(' + label + ') is unknown, not flat', () => {
    const out = pnlClass(value);
    assert.match(out, /pnl-unknown/, 'unknown P/L must not be painted as break-even');
    assert.doesNotMatch(out, /pnl-flat|pnl-up|pnl-down/);
  });
}

// ---------------------------------------------------------------------------
// Genuine zero must survive
// ---------------------------------------------------------------------------

for (const [label, value] of GENUINE_ZERO) {
  test('a genuine zero (' + label + ') stays a real, rendered zero', () => {
    assert.equal(num(value), 0, 'zero is a reading, not an absence');
    assert.equal(money(value), 'Rp 0', 'a measured zero must remain visible');
    assert.equal(pct(value), '0.00%');
    assert.match(pnlClass(value), /pnl-flat/, 'break-even is flat, and distinct from unknown');
  });
}

test('zero and missing are never rendered the same way', () => {
  assert.notEqual(money(0), money(null));
  assert.notEqual(pct(0), pct(null));
  assert.notEqual(pnlClass(0), pnlClass(null));
  assert.notEqual(num(0), num(null));
});

// ---------------------------------------------------------------------------
// Real values are untouched
// ---------------------------------------------------------------------------

test('positive and negative values format as before', () => {
  assert.equal(num(9800), 9800);
  assert.equal(num(-250), -250);
  assert.equal(money(9800), 'Rp 9.800');
  assert.equal(money(-249000), 'Rp -249.000');
  assert.equal(pct(1.5), '1.50%');
  assert.equal(pct(-2.25), '-2.25%');
  assert.match(pnlClass(1), /pnl-up/);
  assert.match(pnlClass(-1), /pnl-down/);
});

test('typed input still parses the way it always did', () => {
  // The stripping class is unchanged on purpose: altering it would silently
  // change what gets stored from the Catat Posisi form.
  const stripping = SOURCE.match(/function num\(value\) \{[\s\S]*?\n  \}/);
  assert.ok(stripping, 'num() must exist');
  assert.match(stripping[0], /replace\(\/\[\^0-9\.-\]\/g, ''\)/, 'the original character class must be preserved');
  assert.equal(num('9800'), 9800);
  assert.equal(num('Rp 9800'), 9800);
});

// ---------------------------------------------------------------------------
// The four scenarios the audit named
// ---------------------------------------------------------------------------

test('a missing quote price does not render as Rp 0', () => {
  // quote() returns num(data.last ?? data.price ?? data.close); a response with
  // no usable price yields undefined there.
  const priceFromEmptyQuote = num(undefined);
  assert.equal(priceFromEmptyQuote, null);
  assert.equal(money(priceFromEmptyQuote), '—');
});

test('a missing P/L does not render as Rp 0', () => {
  // renderWatch(): pnl = current && entry ? ... : null
  const current = num(undefined);
  const pnl = current && 9800 ? (current - 9800) * 5 * 100 : null;
  assert.equal(pnl, null);
  assert.equal(money(pnl), '—');
  assert.match(pnlClass(pnl), /pnl-unknown/);
});

test('a blank optional TP does not become a fabricated financial value', () => {
  // saveOwned() stores tp1Idr: num($('ownedTp1').value) directly. A blank field
  // used to persist tp1Idr: 0 — a target price of Rp 0 written into the plan.
  const tp1FromBlankField = num('');
  assert.equal(tp1FromBlankField, null, 'a blank target must be absent, not zero');
  assert.equal(money(tp1FromBlankField), '—', 'and must not display as a price');
});

test('a blank journal amount does not become Rp 0', () => {
  assert.equal(num(''), null);
  assert.equal(money(num('')), '—');
});

test('genuine numeric zero remains distinguishable and renderable', () => {
  // The counter-case: a real zero must not be swept up by the missing gate.
  assert.equal(money(0), 'Rp 0');
  assert.notEqual(money(0), '—');
  assert.match(pnlClass(0), /pnl-flat/);
});

// ---------------------------------------------------------------------------
// Source guards
// ---------------------------------------------------------------------------

test('no helper falls back to a bare Number() coercion', () => {
  for (const fn of ['function money(', 'function pct(', 'function pnlClass(']) {
    const at = SOURCE.indexOf(fn);
    assert.ok(at > 0, fn + ' must exist');
    const body = SOURCE.slice(at, SOURCE.indexOf('\n  }', at));
    assert.match(body, /finite\(value\)/, fn + ' must route through the finite() gate');
    assert.doesNotMatch(body, /Number\(value\)/, fn + ' must not coerce directly');
  }
});

test('the finite gate rejects the coercions that caused this', () => {
  const { finite } = helpers;
  assert.equal(finite(null), null);
  assert.equal(finite(''), null);
  assert.equal(finite('  '), null);
  assert.equal(finite([]), null, 'Number([]) is 0 — an array is not a reading');
  assert.equal(finite(true), null, 'Number(true) is 1 — a boolean is not a reading');
  assert.equal(finite(0), 0, 'but a real zero passes through');
});
