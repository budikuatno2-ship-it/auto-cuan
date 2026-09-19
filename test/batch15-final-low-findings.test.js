'use strict';

// Batch 15 — final LOW findings sweep.
// Covers: F-060 (dead validation), F-064 (unescaped echo), F-088 (WIB
// double-shift), F-009 (header-derived base URL), F-096 (vacuous test).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const LT = '&' + 'lt;';
const GT = '&' + 'gt;';
const AMP = '&' + 'amp;';
const VACUOUS = 'assert' + '.ok(true)';

// ---------------------------------------------------------------------------
// F-060 — direct_answer length validation must fire on the RAW input, not the
// already-sliced normalized value (which could never exceed 600).
// ---------------------------------------------------------------------------
test('F-060: over-long direct_answer is rejected, not silently truncated', () => {
  const contract = require('../lib/ai-answer-contract');

  const tooLong = contract.validateAnswer({
    direct_answer: 'x'.repeat(700),
    action: 'a',
    invalidation: 'i'
  });
  assert.equal(tooLong.valid, false);
  assert.match(tooLong.errors.join(' | '), /direct_answer terlalu panjang/);

  // Exactly at the limit is still accepted.
  const atLimit = contract.validateAnswer({
    direct_answer: 'y'.repeat(600),
    action: 'a',
    invalidation: 'i'
  });
  assert.equal(atLimit.valid, true, JSON.stringify(atLimit.errors));

  // The normalized value is still capped at 600 (contract unchanged).
  assert.equal(contract.normalizeAnswer({ direct_answer: 'z'.repeat(700) }).direct_answer.length, 600);
});

// ---------------------------------------------------------------------------
// F-064 — ticker_only echo must strip enrichment blocks and escape HTML.
// ---------------------------------------------------------------------------
test('F-064: escapeHtmlText neutralises markup', () => {
  const { escapeHtmlText } = require('../lib/analyze-legacy').__test;
  const out = escapeHtmlText('<img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<img'), 'raw tag must not survive');
  assert.ok(out.includes(LT + 'img'), 'tag must be entity-escaped');
  assert.equal(escapeHtmlText('a & b'), 'a ' + AMP + ' b');
});

test('F-064: stripEnrichmentBlocks removes [Info:] and [Auto-Cuan] blocks', () => {
  const { stripEnrichmentBlocks } = require('../lib/analyze-legacy').__test;
  assert.equal(stripEnrichmentBlocks('BBCA\n[Info: <img src=x>]').trim(), 'BBCA');
  assert.equal(stripEnrichmentBlocks('BBCA\n[Auto-Cuan Market Data] Support 1').trim(), 'BBCA');
});

test('F-064: ticker_only response path escapes the echoed message', () => {
  const src = read('lib/analyze-legacy.js');
  assert.match(src, /tickerOnlyDisplay = escapeHtmlText\(stripEnrichmentBlocks\(chatMessage\)/);
  // The old raw interpolation must be gone.
  assert.ok(!src.includes("chatMessage.trim().toUpperCase() + '</strong> terdeteksi"));
});

// ---------------------------------------------------------------------------
// F-088 — getRelativeDate must not double-shift WIB.
// ---------------------------------------------------------------------------
test('F-088: getRelativeDate no longer double-shifts the WIB day boundary', () => {
  const html = read('public/index.html');
  const start = html.indexOf('function getRelativeDate(isoString) {');
  assert.ok(start > -1, 'getRelativeDate must exist');
  const end = html.indexOf('\n}', start) + 2;
  const fnSrc = html.slice(start, end);
  // The removed API is assembled at runtime so this file's own literal does not
  // match the source scan.
  const tzApi = 'getTimezone' + 'Offset';
  assert.ok(!fnSrc.includes(tzApi), 'double-shift must be removed');
});

test('F-088: getRelativeDate labels same-day and previous-day correctly at 18:00 WIB', () => {
  const html = read('public/index.html');
  const start = html.indexOf('function getRelativeDate(isoString) {');
  const end = html.indexOf('\n}', start) + 2;
  const fnSrc = html.slice(start, end);

  const RealDate = Date;
  function fakeDate(nowIso) {
    return class extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(nowIso);
        else super(...args);
      }
      static now() { return new RealDate(nowIso).getTime(); }
    };
  }

  // now = 2026-09-18 18:00 WIB (11:00 UTC)
  const sandbox = { Date: fakeDate('2026-09-18T11:00:00Z') };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc + '\nthis.getRelativeDate = getRelativeDate;', sandbox);

  // target = 2026-09-18 10:00 WIB (03:00 UTC) -> same WIB day
  assert.equal(sandbox.getRelativeDate('2026-09-18T03:00:00Z'), 'Hari ini');
  // target = 2026-09-17 10:00 WIB -> previous WIB day
  assert.equal(sandbox.getRelativeDate('2026-09-17T03:00:00Z'), 'Kemarin');
});

// ---------------------------------------------------------------------------
// F-009 — Telegram chart base URL must prefer a configured origin over headers.
// ---------------------------------------------------------------------------
test('F-009: getRequestBaseUrl prefers configured base over caller headers', () => {
  const sectorHot = require('../api/sector-hot');
  const fn = sectorHot.__test.getRequestBaseUrl;
  assert.equal(typeof fn, 'function');

  const req = { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' } };
  const prev = process.env.PUBLIC_BASE_URL;
  try {
    process.env.PUBLIC_BASE_URL = 'https://autocuan.web.id/';
    assert.equal(fn(req), 'https://autocuan.web.id');
    delete process.env.PUBLIC_BASE_URL;
    assert.equal(fn(req), 'https://evil.example');
  } finally {
    if (prev === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = prev;
  }
});

// ---------------------------------------------------------------------------
// F-096 — the placeholder vacuous test is replaced by a real assertion.
// ---------------------------------------------------------------------------
test('F-096: no vacuous placeholder remains in the collector suite', () => {
  const src = read('test/intraday-sample-collector.test.js');
  assert.ok(!src.includes(VACUOUS), 'vacuous placeholder must be gone');
  assert.match(src, /collector module exposes its safety-critical surface/);
});
