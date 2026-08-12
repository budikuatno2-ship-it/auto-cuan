'use strict';

// ===========================================================================
// A missing daily change must not render as a flat one.
//
// The bug
// -------
// Nine render sites across the Ranking tables, the share tables, the Sektor
// detail tables and the Day Trade cards computed their change cell as:
//
//   var chgColor = (r.change_pct || 0) >= 0 ? 'text-emerald-400' : 'text-red-400';
//   ... ((r.change_pct || 0) >= 0 ? '+' : '') + (r.change_pct != null ? ... : '0') + '%'
//
// `(null || 0)` is 0, and `0 >= 0` is true, so a row with no change data printed
// "+0.00%" in the gain colour — i.e. "this stock is flat today" when the truth
// was "we do not have today's move for it". In the same table row, last_price,
// RSI, Vol/Avg and the entry area all already rendered an em dash for null, so
// the change column was the lone exception.
//
// Two of those sites were worse: they printed `chgSign + formatPct(value)`, and
// formatPct returns '-' for null, yielding the string "+-" in green.
//
// Sektor Hot already did this correctly for g.avg_change_pct (null renders '-'
// in grey). changeDisplay() generalises that existing convention; those Sektor
// Hot sites are deliberately left as they are.
//
// LOCAL / STATIC ONLY. The helper is extracted from public/index.html and run
// directly, so these are real behavioural assertions, not string matching.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// Pull the real helper out of the page and evaluate it.
function loadChangeDisplay() {
  const start = html.indexOf('function changeDisplay(');
  assert.ok(start > 0, 'changeDisplay must exist in public/index.html');
  // Balance braces from the function keyword to its closing brace.
  let depth = 0;
  let end = -1;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth += 1;
    else if (html[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.ok(end > start, 'could not delimit changeDisplay');
  const source = html.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(source + '; return changeDisplay;')();
}

const changeDisplay = loadChangeDisplay();

// ---------------------------------------------------------------------------
// Missing values
// ---------------------------------------------------------------------------

for (const missing of [null, undefined, '', NaN, 'abc', {}]) {
  test('a missing change (' + JSON.stringify(missing) + ') renders as unknown, not zero', () => {
    const view = changeDisplay(missing);
    assert.equal(view.known, false);
    assert.equal(view.text, '—', 'missing data must read as an em dash, like its neighbouring cells');
    assert.doesNotMatch(view.text, /%/, 'no percentage may be implied');
    assert.doesNotMatch(view.text, /^\+/, 'no sign may be implied');
    assert.equal(view.cls, 'text-gray-500', 'unknown must not wear the gain colour');
    assert.equal(view.hex, '#6b7280');
  });
}

test('a missing change never produces the "+-" string', () => {
  // The exact artefact two Sektor detail cells used to emit.
  const view = changeDisplay(null);
  assert.notEqual(view.text, '+-');
  assert.doesNotMatch(view.text, /\+-/);
});

// ---------------------------------------------------------------------------
// Real values
// ---------------------------------------------------------------------------

test('a genuine zero is still shown as zero, in the gain colour', () => {
  // Flat is a real, known reading and must remain distinguishable from missing.
  const view = changeDisplay(0);
  assert.equal(view.known, true);
  assert.equal(view.text, '+0,00%');
  assert.equal(view.cls, 'text-emerald-400');
});

test('a gain is signed and green', () => {
  const view = changeDisplay(1.234);
  assert.equal(view.text, '+1,23%');
  assert.equal(view.cls, 'text-emerald-400');
  assert.equal(view.hex, '#6ee7b7');
});

test('a loss keeps its sign and is red', () => {
  // The old sites rendered `sign + formatPct(value)`, and formatPct applies
  // Math.abs() while the sign expression only ever produced '+' or ''. Sektor
  // Hot showed a -0.85% group as "0,85%": identical in shape to a gain, with
  // only the red colour to distinguish it.
  const view = changeDisplay(-2.5);
  assert.match(view.text, /^[-−]/, 'a loss must carry a visible sign, not rely on colour');
  assert.equal(view.text, '−2,50%');
  assert.equal(view.cls, 'text-red-400');
  assert.equal(view.hex, '#fca5a5');
});

test('a loss is never rendered as a bare positive-looking number', () => {
  for (const v of [-0.85, -0.01, -12.5, '-3.2']) {
    const text = changeDisplay(v).text;
    assert.match(text, /^[-−]/, JSON.stringify(v) + ' rendered as ' + text + ' without a sign');
  }
});

test('decimals use the Indonesian comma, matching prices and formatPct', () => {
  // The page is lang="id" and formats prices with toLocaleString('id-ID').
  // A row must not mix "1,24%" with "1.24%".
  assert.ok(changeDisplay(1.24).text.includes(','));
  assert.ok(!changeDisplay(1.24).text.includes('.'));
  assert.ok(changeDisplay(-1.24).text.includes(','));
});

test('numeric strings from the API are accepted', () => {
  assert.equal(changeDisplay('3.5').text, '+3,50%');
  assert.equal(changeDisplay('-1.25').text, '−1,25%');
});

test('the decimal precision is configurable for the compact Day Trade cards', () => {
  assert.equal(changeDisplay(1.26, 1).text, '+1,3%');
  assert.equal(changeDisplay(1.26).text, '+1,26%');
});

test('infinities are treated as unknown rather than printed', () => {
  assert.equal(changeDisplay(Infinity).known, false);
  assert.equal(changeDisplay(-Infinity).known, false);
});

// ---------------------------------------------------------------------------
// Source guards: the broken pattern must not come back
// ---------------------------------------------------------------------------

test('no render site collapses a null change to zero', () => {
  const code = html.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(
    code,
    /\(r\.change_pct \|\| 0\)/,
    '`(r.change_pct || 0)` turns missing data into a flat reading'
  );
  assert.doesNotMatch(code, /var chg = r\.change_pct \|\| 0;/);
});

test('no render site pairs a sign with formatPct', () => {
  assert.doesNotMatch(
    html,
    /chgSign \+ formatPct\(r\.change_pct\)/,
    'formatPct returns a dash for null, so a prepended sign yields "+-"'
  );
});

test('no site pairs a hand-rolled sign with an absolute-valued formatter', () => {
  // formatPct() applies Math.abs(), so any `sign + formatPct(x)` construction
  // silently drops the minus on a loss.
  assert.doesNotMatch(html, /Sign \+ formatPct\(/);
  assert.doesNotMatch(html, /chgSign/, 'the sign variables that dropped the minus are gone');
  assert.doesNotMatch(html, /pctSign/);
});

test('formatPct itself is left alone for the non-signed callers', () => {
  // It is still the right helper where the sign is not part of the reading.
  assert.match(html, /function formatPct\(val\)/);
});

test('every change cell now goes through the helper', () => {
  assert.ok((html.match(/chgView/g) || []).length >= 18, 'all rewritten sites should use chgView');
  assert.doesNotMatch(html, /chgCol\b/, 'the old inline hex variable must be gone');
});
