'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sectorHot = require('../api/sector-hot');

test('BUG-025: includesAny dry-run diagnostic correctly observes and records truncation without altering behavior', () => {
  const { includesAny, getIncludesAnyDiagnostics, resetIncludesAnyDiagnostics } = sectorHot.__test;
  assert.equal(typeof includesAny, 'function', 'includesAny should be exported in __test');
  assert.equal(typeof getIncludesAnyDiagnostics, 'function', 'getIncludesAnyDiagnostics should be exported in __test');
  assert.equal(typeof resetIncludesAnyDiagnostics, 'function', 'resetIncludesAnyDiagnostics should be exported in __test');

  resetIncludesAnyDiagnostics();

  // Case 1: Short text <= 300 chars with matching keyword
  const shortText = 'Setup A+ Breakout valid candle';
  const match1 = includesAny(shortText, ['invalid candle', 'breakout']);
  assert.equal(match1, true);
  let diag = getIncludesAnyDiagnostics();
  assert.equal(diag.total_calls, 1);
  assert.equal(diag.calls_exceeding_300, 0);
  assert.equal(diag.missed_matches_count, 0);

  // Case 2: Long text > 300 chars with keyword in first 300 chars
  const longPrefix = 'A'.repeat(100) + ' invalid candle ' + 'B'.repeat(300);
  const match2 = includesAny(longPrefix, ['invalid candle', 'below sl']);
  assert.equal(match2, true);
  diag = getIncludesAnyDiagnostics();
  assert.equal(diag.total_calls, 2);
  assert.equal(diag.calls_exceeding_300, 1);
  assert.equal(diag.missed_matches_count, 0);

  // Case 3: Long text > 300 chars where keyword ONLY appears after 300 chars
  // Before fix / in dry-run: this keyword is missed because includesAny cuts at 300.
  // The dry-run diagnostic MUST detect and record this missed match while keeping return value false.
  const longTextMissed = 'X'.repeat(320) + ' fatal below sl violation';
  const match3 = includesAny(longTextMissed, ['fatal below sl violation', 'sl kena']);
  assert.equal(match3, false, 'Existing behavior must be preserved: returns false due to 300-char truncation');

  diag = getIncludesAnyDiagnostics();
  assert.equal(diag.total_calls, 3);
  assert.equal(diag.calls_exceeding_300, 2);
  assert.equal(diag.missed_matches_count, 1, 'Diagnostic must observe that a keyword was missed due to truncation');
  assert.equal(diag.missed_events.length, 1);
  assert.equal(diag.missed_events[0].matched_word, 'fatal below sl violation');
  assert.ok(diag.missed_events[0].text_length > 300);

  // Reset check
  resetIncludesAnyDiagnostics();
  diag = getIncludesAnyDiagnostics();
  assert.equal(diag.total_calls, 0);
  assert.equal(diag.missed_matches_count, 0);
});
