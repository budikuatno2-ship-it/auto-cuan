'use strict';

// Missing, unknown and zero must never be dressed up as a real reading.
//
// Three defects this file locks down, each reproduced in the running product
// before it was fixed:
//
//   * changeDisplay(0) returned "+0,00%" in gain green. A Screener grid where
//     several names had not moved read as a row of small winners.
//   * swingTierColor() fell through to the INVALID/AVOID red for any tier it
//     did not recognise, so a row whose swing_tier the server had not sent was
//     painted with a red danger badge reading "-".
//   * getDayTradeStatusColor() fell through to amber caution for an empty
//     status, presenting unlabelled rows as judged-risky ones.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extractFunction(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing ' + name);
  const brace = html.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    if (html[i] === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced ' + name);
}

function extractVar(name) {
  const start = html.indexOf('var ' + name + ' = ');
  assert.ok(start >= 0, 'missing var ' + name);
  const end = html.indexOf('\n};', start);
  if (end < 0) {
    const line = html.indexOf('\n', start);
    return html.slice(start, line + 1);
  }
  return html.slice(start, end + 3);
}

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext([
  extractFunction('safeDisplayText'),
  extractFunction('normalizeActionLabel'),
  extractFunction('changeDisplay'),
  extractVar('SWING_TIER_LABELS'),
  extractVar('SWING_TIER_COLORS'),
  extractVar('SWING_TIER_UNKNOWN_LABEL'),
  extractVar('SWING_TIER_UNKNOWN_COLOR'),
  extractFunction('swingTierShort'),
  extractFunction('swingTierColor'),
  extractFunction('swingTierTitle'),
  extractFunction('isDayTradeConfirmedSignalStatus'),
  extractFunction('getDayTradeStatusColor'),
  extractFunction('getDayTradeStatusBackground'),
  extractFunction('getDayTradeSemanticLabel')
].join('\n'), sandbox);

const GAIN = '#6ee7b7';
const LOSS = '#fca5a5';
const CAUTION = '#fde047';
const RED_BADGE = 'bg-red-500/10 text-red-400';

test('a flat close is neutral and unsigned, never a small gain', () => {
  const flat = sandbox.changeDisplay(0);
  assert.equal(flat.known, true);
  assert.equal(flat.flat, true);
  assert.equal(flat.text, '0,00%');
  assert.notEqual(flat.hex, GAIN);
  assert.notEqual(flat.hex, LOSS);
  assert.doesNotMatch(flat.text, /^[+−-]/);

  // Anything that rounds to zero at the requested precision is flat too: an
  // signed "+0,0%" is just as misleading as "+0,00%".
  const rounded = sandbox.changeDisplay(0.004, 1);
  assert.equal(rounded.flat, true);
  assert.equal(rounded.text, '0,0%');
});

test('real movement keeps its sign and its direction colour', () => {
  const up = sandbox.changeDisplay(1.37);
  assert.equal(up.text, '+1,37%');
  assert.equal(up.hex, GAIN);
  assert.equal(up.flat, false);

  const down = sandbox.changeDisplay(-1.37);
  assert.equal(down.text, '−1,37%');
  assert.equal(down.hex, LOSS);
  assert.equal(down.flat, false);
});

test('an unavailable change stays visibly unavailable', () => {
  [null, undefined, '', 'n/a', NaN, Infinity].forEach(value => {
    const view = sandbox.changeDisplay(value);
    assert.equal(view.known, false, String(value));
    assert.equal(view.text, '—', String(value));
    assert.notEqual(view.hex, GAIN);
    assert.notEqual(view.hex, LOSS);
  });
});

test('an unknown swing tier is grey and says so, never the AVOID red', () => {
  ['', null, undefined, 'SOMETHING_NEW'].forEach(tier => {
    assert.equal(sandbox.swingTierColor(tier), 'bg-gray-500/10 text-gray-400', String(tier));
    assert.notEqual(sandbox.swingTierColor(tier), RED_BADGE, String(tier));
    assert.equal(sandbox.swingTierShort(tier), 'TIER —', String(tier));
    assert.match(sandbox.swingTierTitle(tier), /tidak tersedia/i);
  });
});

test('a real AVOID tier keeps the red badge it has earned', () => {
  ['AVOID', 'INVALID'].forEach(tier => {
    assert.equal(sandbox.swingTierColor(tier), RED_BADGE, tier);
    assert.equal(sandbox.swingTierShort(tier), 'AVOID', tier);
    assert.equal(sandbox.swingTierTitle(tier), '');
  });
  assert.equal(sandbox.swingTierColor('A_PLUS_SWING'), 'bg-emerald-500/20 text-emerald-300');
  assert.equal(sandbox.swingTierShort('A_PLUS_SWING'), 'A+ SWING');
});

test('an unlabelled day-trade row is neutral, not a caution', () => {
  [''].concat([null, undefined]).forEach(status => {
    assert.notEqual(sandbox.getDayTradeStatusColor(status), CAUTION, String(status));
    assert.equal(sandbox.getDayTradeStatusColor(status), '#9ca3af', String(status));
    assert.equal(sandbox.getDayTradeStatusBackground(status), 'rgba(148,163,184,0.10)', String(status));
    assert.equal(sandbox.getDayTradeSemanticLabel(status), '-', String(status));
  });
});

test('a real day-trade verdict keeps its own colour', () => {
  assert.equal(sandbox.getDayTradeStatusColor('AVOID'), LOSS);
  assert.equal(sandbox.getDayTradeStatusColor('TRADE_CANDIDATE'), GAIN);
  assert.equal(sandbox.getDayTradeStatusColor('EARLY_RADAR'), '#93c5fd');
  assert.equal(sandbox.getDayTradeSemanticLabel('AVOID'), 'HINDARI');
});
