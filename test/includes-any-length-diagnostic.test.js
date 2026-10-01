'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sectorHot = require('../api/sector-hot');

// BUG-025 regression: the safety gate must scan the FULL text. Previously
// includesAny truncated to 300 chars and joinTelegramTexts truncated each part
// to 120 chars, so a trigger word past the cutoff was silently missed and a
// risky signal could broadcast (fail-OPEN). These tests lock the fail-CLOSED
// behavior: no truncation on the gate path.
test('BUG-025: includesAny scans the full text and never truncates', () => {
  const { includesAny } = sectorHot.__test;
  assert.equal(typeof includesAny, 'function', 'includesAny should be exported in __test');

  // Short text with a matching keyword.
  assert.equal(includesAny('Setup A+ Breakout valid candle', ['invalid candle', 'breakout']), true);

  // Keyword inside the first 300 chars.
  const longPrefix = 'A'.repeat(100) + ' invalid candle ' + 'B'.repeat(300);
  assert.equal(includesAny(longPrefix, ['invalid candle', 'below sl']), true);

  // Keyword ONLY after 300 chars — must now be found (was missed before the fix).
  const longTextMissed = 'X'.repeat(320) + ' fatal below sl violation';
  assert.equal(includesAny(longTextMissed, ['fatal below sl violation', 'sl kena']), true);

  // Keyword far beyond 300 chars (e.g. tail of a long status_reason).
  const veryLong = 'Y'.repeat(5000) + ' weak liquidity';
  assert.equal(includesAny(veryLong, ['weak liquidity']), true);

  // Non-matching text still returns false.
  assert.equal(includesAny('Z'.repeat(1000), ['stale', 'invalid plan']), false);
});

test('BUG-025: joinTelegramTexts keeps every part intact (no 120-char cap)', () => {
  const { joinTelegramTexts } = sectorHot.__test;
  assert.equal(typeof joinTelegramTexts, 'function', 'joinTelegramTexts should be exported in __test');

  const longPart = 'A'.repeat(400) + ' stale';
  const joined = joinTelegramTexts([longPart, 'short']);
  assert.ok(joined.indexOf('stale') >= 0, 'trigger word at the tail of a long part must survive');
  assert.ok(joined.length > 400, 'long parts must not be truncated to 120 chars');
});
