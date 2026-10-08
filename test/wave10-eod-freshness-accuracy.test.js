'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveScreenerEodBadge } = require('../lib/screener-eod-badge');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = read('public/index.html');
const partial = read('public/partials/analisis-saham.partial.html');
const partialSrc = read('partials/analisis-saham.partial.html');
const runtime = read('public/analisis-saham-runtime.js');

test('Wave 10 Acceptance: Financial text accuracy & neutral loading state', () => {
  // 1. Initial DOM must show neutral loading state, NOT pre-filled "Data Lengkap 4/4"
  assert.match(html, /id="financialStatusBadge"[^>]*>Memuat\.\.\.<\/span>/);
  assert.match(html, /id="financialCoverage"[^>]*>— \/ 4<\/span>/);
  assert.match(partial, /id="financialStatusBadge"[^>]*>Memuat\.\.\.<\/span>/);
  assert.match(partial, /id="financialCoverage"[^>]*>— \/ 4<\/span>/);
  assert.match(partialSrc, /id="financialStatusBadge"[^>]*>Memuat\.\.\.<\/span>/);
  assert.match(partialSrc, /id="financialCoverage"[^>]*>— \/ 4<\/span>/);

  // 2. Subtitle copy must be truthful (official issuer statements, not blanket terverifikasi claims)
  assert.doesNotMatch(html, /<p class="ac-financial-subtitle">Snapshot terverifikasi/);
  assert.match(html, /<p class="ac-financial-subtitle">Snapshot rasio dan nilai buku dari laporan keuangan resmi emiten\./);
  assert.match(partial, /<p class="ac-financial-subtitle">Snapshot rasio dan nilai buku dari laporan keuangan resmi emiten\./);
  assert.match(partialSrc, /<p class="ac-financial-subtitle">Snapshot rasio dan nilai buku dari laporan keuangan resmi emiten\./);

  // 3. Statement section copy must avoid claiming unverified data is terverifikasi
  assert.doesNotMatch(html, /<p class="ac-financial-statements-subtitle">[^<]*terverifikasi/);
  assert.doesNotMatch(partial, /<p class="ac-financial-statements-subtitle">[^<]*terverifikasi/);

  // 4. Runtime distinguishes formal verification from completeness count
  assert.match(runtime, /var hasVerifiedProvenance = Boolean\(f\.verified \|\| f\.provenance_verified\);/);
  assert.match(runtime, /statusBadge\.textContent = 'Snapshot Terverifikasi';/);
  assert.match(runtime, /statusBadge\.textContent = 'Data Lengkap 4\/4';/);
});

test('Wave 10 Acceptance: Dashboard freshness eliminates false intraday claims on EOD snapshots', () => {
  // 1. updateGlobalLiveRadarStatus checks authoritative EOD markers
  assert.match(html, /metaOrFreshness\.is_eod_final === true \|\| metaOrFreshness\.session_status === 'FINAL_EOD' \|\| metaOrFreshness\.top5_locked === true/);

  // 2. EOD final snapshots label "EOD (Selesai)" or "EOD / T-1", never false "Intraday"
  assert.match(html, /label = 'EOD \(Selesai\)';/);
  assert.match(html, /label = 'EOD \/ T-1';/);

  // 3. Status 'eod' styling supported in Navbar chip and Hero badge
  assert.match(html, /\} else if \(status === 'eod'\) \{/);
});

test('Wave 10 Acceptance: Screener EOD badge accuracy across all 6 trading calendar scenarios', () => {
  // Reference base date: Wednesday 2026-10-07 11:00 WIB (before close)
  const wedBeforeClose = new Date('2026-10-07T04:00:00Z'); // 11:00 WIB
  // Wednesday 2026-10-07 17:00 WIB (after close)
  const wedAfterClose = new Date('2026-10-07T10:00:00Z'); // 17:00 WIB
  // Saturday 2026-10-10 14:00 WIB (weekend)
  const satWeekend = new Date('2026-10-10T07:00:00Z'); // 14:00 WIB
  // Sunday 2026-10-11 10:00 WIB (weekend)
  const sunWeekend = new Date('2026-10-11T03:00:00Z'); // 10:00 WIB
  // Thursday 2026-10-08 (Market Holiday)
  const holidayDate = new Date('2026-10-08T05:00:00Z'); // 12:00 WIB

  // (a) Weekdays before close:
  // (a1) Today's intraday partial data
  const resIntraday = resolveScreenerEodBadge({
    trading_date: '2026-10-07',
    session_status: 'INTRADAY_PARTIAL',
    is_intraday: true
  }, wedBeforeClose, false);
  assert.equal(resIntraday.badgeCode, 'INTRADAY');
  assert.equal(resIntraday.label, 'INTRADAY');

  // (a2) Prior day's completed EOD session (T-1) while viewing today before market close
  const resT1Morning = resolveScreenerEodBadge({
    trading_date: '2026-10-06',
    session_status: 'FINAL_EOD',
    is_eod_final: true
  }, wedBeforeClose, false);
  assert.equal(resT1Morning.badgeCode, 'T1');
  assert.equal(resT1Morning.label, 'EOD · T-1');

  // (b) Weekdays after close:
  // Today's session completed with authoritative finalization marker
  const resTodayFinal = resolveScreenerEodBadge({
    trading_date: '2026-10-07',
    session_status: 'FINAL_EOD',
    is_eod_final: true
  }, wedAfterClose, false);
  assert.equal(resTodayFinal.badgeCode, 'TODAY');
  assert.equal(resTodayFinal.label, 'EOD · TODAY');

  // (c) Saturday / Sunday (Weekend):
  // Viewing Friday 2026-10-09 close from Saturday or Sunday -> EOD · T-1, NOT stale!
  const resSatViewingFri = resolveScreenerEodBadge({
    trading_date: '2026-10-09',
    session_status: 'FINAL_EOD',
    is_eod_final: true
  }, satWeekend, false);
  assert.equal(resSatViewingFri.badgeCode, 'T1');
  assert.equal(resSatViewingFri.label, 'EOD · T-1');

  const resSunViewingFri = resolveScreenerEodBadge({
    trading_date: '2026-10-09',
    session_status: 'FINAL_EOD',
    is_eod_final: true
  }, sunWeekend, false);
  assert.equal(resSunViewingFri.badgeCode, 'T1');
  assert.equal(resSunViewingFri.label, 'EOD · T-1');

  // (d) Market holiday:
  // Today is an official holiday; snapshot is from previous valid trading day (2026-10-07)
  const resHoliday = resolveScreenerEodBadge({
    trading_date: '2026-10-07',
    is_holiday: true,
    holiday_name: 'Hari Libur Nasional',
    session_status: 'HOLIDAY_CLOSED'
  }, holidayDate, false);
  assert.equal(resHoliday.badgeCode, 'T1');
  assert.equal(resHoliday.label, 'EOD · T-1');

  // (e) Missing finalization marker:
  // Today's date without FINAL_EOD or is_eod_final -> never falsely claims EOD · TODAY
  const resUnfinalized = resolveScreenerEodBadge({
    trading_date: '2026-10-07',
    // Missing FINAL_EOD / is_eod_final
  }, wedAfterClose, false);
  assert.notEqual(resUnfinalized.badgeCode, 'TODAY');
  assert.notEqual(resUnfinalized.label, 'EOD · TODAY');
  assert.equal(resUnfinalized.badgeCode, 'PENDING');
  assert.equal(resUnfinalized.label, 'EOD · PENDING');

  // (f) Stale historical snapshot:
  // Data from last month -> strictly marked STALE
  const resHistoricalStale = resolveScreenerEodBadge({
    trading_date: '2026-09-01',
    session_status: 'FINAL_EOD',
    is_eod_final: true
  }, wedAfterClose, false);
  assert.equal(resHistoricalStale.badgeCode, 'STALE');
  assert.equal(resHistoricalStale.label, 'STALE');

  // Preview route compatibility:
  const resPreview = resolveScreenerEodBadge({
    trading_date: '2026-10-07',
    session_status: 'FINAL_EOD',
    is_eod_final: true
  }, wedAfterClose, true);
  assert.equal(resPreview.label, 'MOCK DATA');
});

test('Wave 10 Acceptance: Dashboard freshness note is conditional on dataset trading date', () => {
  // 1. dashMarketFreshnessNote exists in index.html
  assert.match(html, /id="dashMarketFreshnessNote"[^>]*class="market-tile-note"/);

  // 2. renderMarketBand updates dashMarketFreshnessNote
  assert.match(html, /var freshnessNote = document\.getElementById\('dashMarketFreshnessNote'\);/);
  assert.match(html, /freshnessNote\.textContent = 'Semua angka radar memakai snapshot penutupan harian sesi hari ini \(EOD\)\.';/);
  assert.match(html, /freshnessNote\.textContent = 'Semua angka radar memakai candle harian yang sudah selesai \(T-1\)\.';/);
  assert.match(html, /freshnessNote\.textContent = 'Status pembaruan data radar belum tersedia\.';/);
});

test('Wave 10 Acceptance: Mobile Screener restores compact readable title while hiding subtitle', () => {
  const css = read('public/ui-theme.css');
  assert.match(css, /#page-screener\.page-content \.page-header\s*\{\s*display:\s*block;/);
  assert.match(css, /#page-screener\.page-content \.page-header \.page-title\s*\{\s*font-size:\s*15px;/);
  assert.match(css, /#page-screener\.page-content \.page-subtitle[^{]*\{\s*display:\s*none;\s*\}/);
});

