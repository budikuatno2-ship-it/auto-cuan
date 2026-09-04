'use strict';

// ===========================================================================
// Regression BUG-016: the Track Record table and CSV export printed the entry
// range backwards — "Rp 1.250–Rp 1.200" instead of "Rp 1.200–Rp 1.250".
//
// In `telegram_daily_picks`, entry1 is the UPPER bound and entry2 the LOWER
// one. All three writers agree:
//
//   api/sector-hot.js:7136-7137            entry1: identity.entry_high
//   api/sector-hot.js:6997 (via getEntry1) entry1 = entry_high
//   lib/intraday-fast-watcher-publisher.js:211-212  entry1: entryHigh
//
// and the convention is stated outright at api/sector-hot.js:3519-3520.
// lib/track-record-service.js:203-204 forwards both fields untouched, so the
// data reaching the browser is correct — only the render order was wrong:
//
//   var entryText = s.entry1 ? formatRp(s.entry1) : '—';
//   if (s.entry2 && s.entry2 !== s.entry1) entryText += '–' + formatRp(s.entry2);
//
// Display-only. No gate, ranking, or trading calculation reads these strings.
//
// LOCAL / STATIC ONLY. No browser, network, or backend involvement.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RUNTIME_PATH = path.join(ROOT, 'public', 'track-record-runtime.js');
const SOURCE = fs.readFileSync(RUNTIME_PATH, 'utf8');
const runtime = require('../public/track-record-runtime.js');

const ENTRY_COLUMN = 4; // 'Entry' in TRACK_RECORD_CSV_HEADERS

function csvEntryCell(signal) {
  return runtime.formatTrackRecordCsvRow(signal)[ENTRY_COLUMN];
}

// --- The bug itself ---------------------------------------------------------

test('a real row (entry1 = upper, entry2 = lower) renders low to high in the CSV', () => {
  // Shaped exactly like a telegram_daily_picks row: entry_high landed in
  // entry1, entry_low in entry2.
  assert.equal(csvEntryCell({ entry1: 1250, entry2: 1200 }), '1200-1250');
});

test('bounds are ordered, not merely swapped', () => {
  // Already ascending must stay ascending — a blind swap would break this.
  assert.equal(csvEntryCell({ entry1: 1200, entry2: 1250 }), '1200-1250');
});

test('trEntryBounds returns ascending bounds regardless of field order', () => {
  assert.deepEqual(runtime.trEntryBounds({ entry1: 1250, entry2: 1200 }), [1200, 1250]);
  assert.deepEqual(runtime.trEntryBounds({ entry1: 1200, entry2: 1250 }), [1200, 1250]);
});

test('the ordering holds for prices below 1000 and for wide ranges', () => {
  assert.equal(csvEntryCell({ entry1: 246, entry2: 208 }), '208-246');
  assert.equal(csvEntryCell({ entry1: 9200, entry2: 4050 }), '4050-9200');
});

// --- Edge cases that must not regress --------------------------------------

test('equal bounds collapse to a single value', () => {
  assert.equal(csvEntryCell({ entry1: 1200, entry2: 1200 }), '1200');
  assert.deepEqual(runtime.trEntryBounds({ entry1: 1200, entry2: 1200 }), [1200]);
});

test('a single present bound renders alone, from either field', () => {
  assert.equal(csvEntryCell({ entry1: 1250, entry2: null }), '1250');
  // Previously this printed the em dash even though entry2 was known, because
  // the guard tested entry1 alone.
  assert.equal(csvEntryCell({ entry1: null, entry2: 1250 }), '1250');
});

test('a row with no usable bound still renders the placeholder', () => {
  assert.equal(csvEntryCell({ entry1: null, entry2: null }), '—');
  assert.equal(csvEntryCell({}), '—');
  assert.deepEqual(runtime.trEntryBounds({}), []);
});

test('non-finite values are treated as absent, never printed as NaN', () => {
  assert.equal(csvEntryCell({ entry1: NaN, entry2: 1200 }), '1200');
  assert.equal(csvEntryCell({ entry1: Infinity, entry2: NaN }), '—');
  assert.ok(!/NaN|Infinity/.test(csvEntryCell({ entry1: NaN, entry2: Infinity })));
});

test('numeric strings from the API are ordered numerically, not lexically', () => {
  // '9200' > '10500' lexically but not numerically.
  assert.equal(csvEntryCell({ entry1: '10500', entry2: '9200' }), '9200-10500');
});

// --- The table path shares the same helper ---------------------------------

test('the table renderer derives its entry text from trEntryBounds', () => {
  const start = SOURCE.indexOf('function renderTrackRecordTable(');
  assert.ok(start > 0, 'renderTrackRecordTable not found');
  const body = SOURCE.slice(start, SOURCE.indexOf('\n}', start));
  assert.ok(/trEntryBounds\(s\)/.test(body), 'table renderer must use trEntryBounds');
  assert.ok(
    !/entryText \+= '–' \+ formatRp\(s\.entry2\)/.test(body),
    'the old unordered concatenation must be gone from the table renderer'
  );
});

test('the CSV row builder derives its entry cell from trEntryBounds', () => {
  const start = SOURCE.indexOf('function formatTrackRecordCsvRow(');
  assert.ok(start > 0, 'formatTrackRecordCsvRow not found');
  const body = SOURCE.slice(start, SOURCE.indexOf('\n}', start));
  assert.ok(/trEntryBounds\(s\)/.test(body), 'CSV builder must use trEntryBounds');
  assert.ok(
    !/s\.entry1 \+ '-' \+ s\.entry2/.test(body),
    'the old unordered concatenation must be gone from the CSV builder'
  );
});

test('CSV escaping still applies to the entry cell', () => {
  // The dash-joined value carries no comma/quote/newline, so it must stay bare.
  assert.equal(runtime.escapeCsvCell(csvEntryCell({ entry1: 1250, entry2: 1200 })), '1200-1250');
});
