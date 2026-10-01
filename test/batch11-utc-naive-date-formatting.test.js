'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var t1Policy = require('../lib/chart-t1-policy');
var idxCalendar = require('../lib/idx-trading-calendar');

// ============================================================
// Batch 11 — Konversi Tanggal UTC Naif -> Jakarta (WIB)
//
// Bug: `new Date(ts * 1000).toISOString().slice(0, 10)` memotong tanggal
// UTC. Untuk bar dengan timestamp >= 17:00 UTC (00:00 WIB keesokan hari),
// tanggal mundur satu hari. Helper resmi Jakarta harus dipakai.
// ============================================================

// 01:00 UTC = 08:00 WIB (hari yang sama)
var TS_0100_UTC = Date.UTC(2026, 8, 18, 1, 0, 0) / 1000; // 2026-09-18T01:00Z
// 22:00 UTC = 05:00 WIB HARI BERIKUTNYA
var TS_2200_UTC = Date.UTC(2026, 8, 18, 22, 0, 0) / 1000; // 2026-09-18T22:00Z

test('B11.1 formatJakartaDate: 01:00 UTC (08:00 WIB) tetap tanggal kalender yang sama', function () {
  var d = new Date(TS_0100_UTC * 1000);
  assert.strictEqual(t1Policy.formatJakartaDate(d), '2026-09-18');
  // Bukti bug lama: potongan UTC naif juga 2026-09-18 (kebetulan benar di jam ini)
  assert.strictEqual(d.toISOString().slice(0, 10), '2026-09-18');
});

test('B11.2 formatJakartaDate: 22:00 UTC (05:00 WIB besok) maju ke hari berikutnya', function () {
  var d = new Date(TS_2200_UTC * 1000);
  // WIB = 2026-09-19 05:00 -> tanggal kalender Jakarta = 2026-09-19
  assert.strictEqual(t1Policy.formatJakartaDate(d), '2026-09-19');
  // Potongan UTC naif SALAH: mundur ke 2026-09-18 (bug yang diperbaiki)
  assert.strictEqual(d.toISOString().slice(0, 10), '2026-09-18');
  assert.notStrictEqual(t1Policy.formatJakartaDate(d), d.toISOString().slice(0, 10));
});

test('B11.3 toDateKey (idx-trading-calendar) konsisten dengan formatJakartaDate', function () {
  assert.strictEqual(idxCalendar.toDateKey(new Date(TS_0100_UTC * 1000)), '2026-09-18');
  assert.strictEqual(idxCalendar.toDateKey(new Date(TS_2200_UTC * 1000)), '2026-09-19');
});

test('B11.4 getJakartaDateFromTimestamp (sector-hot) memakai offset WIB +07:00', function () {
  // Replikasi helper internal api/sector-hot.js (tidak diekspor) untuk mengunci kontrak.
  function getJakartaDateFromTimestamp(value) {
    if (!value) return null;
    var s = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    var d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return new Date(d.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  assert.strictEqual(getJakartaDateFromTimestamp(new Date(TS_0100_UTC * 1000)), '2026-09-18');
  assert.strictEqual(getJakartaDateFromTimestamp(new Date(TS_2200_UTC * 1000)), '2026-09-19');
});

// ============================================================
// Source-level: file produksi tidak lagi memotong UTC naif pada
// timestamp candle/bar (kelas bug Batch 11).
// ============================================================

var ROOT = path.join(__dirname, '..');

function readSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('B11.5 api/sector-hot.js: price_date/chart OHLC tidak lagi potong UTC naif', function () {
  var src = readSource('api/sector-hot.js');
  // Pola terlarang pada timestamp candle: new Date(...).toISOString().slice(0, 10)
  var forbidden = /new Date\([^)]*\)\.toISOString\(\)\.slice\(0,\s*10\)/g;
  var matches = src.match(forbidden) || [];
  assert.strictEqual(matches.length, 0, 'Masih ada potongan UTC naif: ' + matches.join(' | '));
  // Helper WIB resmi harus dipakai untuk price_date
  assert.ok(src.includes('getJakartaDateFromTimestamp(new Date(candles[lastIdx].time * 1000))'));
  assert.ok(src.includes('getJakartaDateFromTimestamp(new Date(latest.ts * 1000))'));
  assert.ok(src.includes('getJakartaDateFromTimestamp(new Date(validDays[lastIdx].ts * 1000))'));
});

test('B11.6 lib/bandarmologi-intel-service.js: candleDate memakai formatJakartaDate', function () {
  var src = readSource('lib/bandarmologi-intel-service.js');
  assert.ok(src.includes("require('./chart-t1-policy')"));
  assert.ok(src.includes('formatJakartaDate(new Date(lastCandle.time * 1000))'));
  assert.ok(src.includes('formatJakartaDate(new Date(last.time * 1000))'));
  assert.ok(!/new Date\(lastCandle\.time \* 1000\)\.toISOString\(\)\.slice\(0,\s*10\)/.test(src));
  assert.ok(!/new Date\(last\.time \* 1000\)\.toISOString\(\)\.slice\(0,\s*10\)/.test(src));
});

test('B11.7 lib/daily-history-collector.js: trade_date memakai toDateKey', function () {
  var src = readSource('lib/daily-history-collector.js');
  assert.ok(src.includes('toDateKey(new Date(meta.regularMarketTime * 1000))'));
  assert.ok(src.includes('toDateKey(new Date(timestamps[i] * 1000))'));
  assert.ok(!/new Date\(timestamps\[i\] \* 1000\)\.toISOString\(\)\.slice\(0,\s*10\)/.test(src));
});

test('B11.8 lib/chart-image-renderer.js: label tanggal candle memakai formatJakartaDate', function () {
  var src = readSource('lib/chart-image-renderer.js');
  assert.ok(src.includes("require('./chart-t1-policy')"));
  assert.ok(src.includes('formatJakartaDate(new Date(timestamps[i] * 1000))'));
  assert.ok(!/new Date\(timestamps\[i\] \* 1000\)\.toISOString\(\)\.slice\(0,\s*10\)/.test(src));
});

test('B11.9 lib/context-ai-router-v7.js: marketDate fallback memakai formatJakartaDate', function () {
  var src = readSource('lib/context-ai-router-v7.js');
  assert.ok(src.includes("require('./chart-t1-policy')"));
  assert.ok(src.includes('formatJakartaDate(new Date())'));
  assert.ok(!/new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/.test(src));
});

test('B11.10 lib/bandarmologi-screener-scoring.js: evalDateStr fallback memakai formatJakartaDate', function () {
  var src = readSource('lib/bandarmologi-screener-scoring.js');
  assert.ok(src.includes("require('./chart-t1-policy')"));
  assert.ok(src.includes('formatJakartaDate(new Date())'));
  assert.ok(!/new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/.test(src));
});

test('B11.11 lib/ai-analysis-cache.js: marketDate cache key memakai formatJakartaDate', function () {
  var src = readSource('lib/ai-analysis-cache.js');
  assert.ok(src.includes("require('./chart-t1-policy')"));
  assert.ok(src.includes('formatJakartaDate(new Date())'));
  assert.ok(!/new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/.test(src));
});
