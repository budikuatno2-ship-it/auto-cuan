'use strict';

// Replaces the in-page selfTestSpacing() block that used to ship inside
// public/index.html.
//
// That block carried ~4KB of sample strings to every visitor in order to run
// only on localhost, and it reported a failure on every single load. The bug
// was in the assertion, not the normalizer: it read `testDiv.textContent`,
// which drops <br> elements, so the separators normalizeFinalStockHtml had just
// inserted were invisible to the check and "MA20: 753.15<br>MA50: 1795.24" was
// read back as "MA20: 753.15MA50: 1795.24".
//
// These tests assert on the produced HTML, which is where the separation
// actually lives, and they run in CI instead of in the browser.

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

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(['sanitizeAIHtml', 'normalizeTechnicalLabels', 'normalizeFinalStockHtml'].map(extractFunction).join('\n'), sandbox);

function normalize(input) {
  return sandbox.normalizeFinalStockHtml(sandbox.sanitizeAIHtml(input));
}

// The separator the normalizer inserts is a <br>. Rendering it as a newline is
// what the browser does; comparing raw text is what the old check got wrong.
function asRenderedText(value) {
  return String(value).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
}

const SAMPLES = {
  latest: 'MA20: 316.30MA50: 313.40MA100: 356.01MA200: 298.52Posisi: di bawah semua MA\nRSI14: 32.09Volume: 0,55x avgLast: 260High: 298Low: 250\nR1: 288R2: 317\nS1: 240S2: 221\nTP1: 288TP2: 317',
  buva: 'MA20: 820.75MA50: 1008.5MA100: 1196MA200: 997.79Posisi: belowMA20\nRSI14: 26.74Volume: 0,79x avgLast: 610High: 675Low: 575\nR1: 665R2: 720\nS1: 565S2: 520\nTP1: N/ATP2: N/A\nInvalidasi: Recovery di atas 620 dengan volume di atas rata-rata 7D danRSI >50.',
  ihsg: 'MA20: 6466,67MA50: 6947,55MA100: 7676,27MA200: 7916,73Posisi: di bawahMA20\nRSI14: 10,75Volume: 0,74x avg20Last: 5594,77High: 5860,67Low: 5594,11\nR1: 5772R2: 5950\nS1: 5505S2: 5416',
  ptro: 'MA20: 4340MA50: 4966.7MA100: 6426.75MA200: 6772.48Posisi: belowMA20\nRSI14: 34.36Volume: 0,76x avgLast: 3650High: 4180Low: 3650\nR1: 4004R2: 4357\nS1: 3474S2: 3297\nTP1: 4004TP2: 4357',
  dssa: 'MA20: 753.15MA50: 1795.24MA100: 2718.13MA200: 3369.34Posisi: Di bawah semua MA\nRSI14: 27.42Volume: 1,29x avg 20DLast: 610High: 740Low: 610\nR1: 696R2: 783\nS1: 566S2: 523\nTP1: 696TP2: 783',
  dssaHtml: '<div class="metric-grid"><div><strong>Moving Average</strong><br>MA20: <b>753.15</b><b>MA50: 1795.24</b><b>MA100: 2718.13</b><b>MA200: 3369.34</b><b>Posisi: Di bawah semua MA</b></div><div><strong>Momentum</strong><br>RSI14: <b>27.42</b><b>Volume: 1,29x avg 20D</b><b>Last: 610</b><b>High: 740</b><b>Low: 610</b></div></div>'
};

const MERGED_DIGIT = /\d(MA20|MA50|MA100|MA200|RSI14|Volume|Last|High|Low|R[1-3]|S[1-3]|TP[1-3]|Posisi)/g;
const MERGED_D_SUFFIX = /\dD(Last|High|Low|Open|Volume|MA\d|RSI)/gi;
const MERGED_WORD = /(below|above|dan|bawah|atas)(MA\d{2,3}|RSI\d*|Volume|Price)/gi;
const MERGED_NA = /N\/A(TP\d|R[1-3]|S[1-3])/gi;
const MERGED_AVG = /avg\d*(Last|High|Low|Volume|Open|MA\d|RSI|R[1-3]|S[1-3]|TP[1-3])/gi;

for (const [name, input] of Object.entries(SAMPLES)) {
  test('a number never runs into the next label: ' + name, () => {
    const rendered = asRenderedText(normalize(input));
    assert.deepEqual(rendered.match(MERGED_DIGIT) || [], [], 'digit merged into a label');
    assert.deepEqual(rendered.match(MERGED_D_SUFFIX) || [], [], 'day-suffix merged into a label');
    assert.deepEqual(rendered.match(MERGED_WORD) || [], [], 'word merged into a label');
    assert.deepEqual(rendered.match(MERGED_NA) || [], [], 'N/A merged into a label');
    assert.deepEqual(rendered.match(MERGED_AVG) || [], [], 'avg merged into a label');
  });
}

test('separation is carried by <br>, which is exactly what the old check could not see', () => {
  const out = normalize(SAMPLES.dssa);
  assert.match(out, /753\.15<br>MA50/);
  // textContent drops <br>, so reading it back reproduces the false failure the
  // in-page self-test reported on every load.
  const textContentEquivalent = out.replace(/<[^>]+>/g, '');
  assert.match(textContentEquivalent, /753\.15MA50/);
});

test('values themselves are never rewritten while spacing is repaired', () => {
  const rendered = asRenderedText(normalize(SAMPLES.dssa));
  ['753.15', '1795.24', '2718.13', '3369.34', '27.42', '610', '740', '696', '783', '566', '523'].forEach(value => {
    assert.ok(rendered.includes(value), 'lost value ' + value);
  });
});

test('the sample fixtures no longer ship to visitors inside index.html', () => {
  assert.doesNotMatch(html, /selfTestSpacing/);
  assert.doesNotMatch(html, /Auto-Cuan DOM-Test FAIL/);
  assert.doesNotMatch(html, /Auto-Cuan Self-Test FAIL/);
});
