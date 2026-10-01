'use strict';
/**
 * FASE 3 — Forensic audit guard suite for lib/market-hours-guard.js
 * (Batch 2, canonical name per the audit mandate).
 *
 * The Phase-3 mandate for this file covers market-hours-guard, cutoff session,
 * and holiday/weekend edge cases. Three real defects were reproduced against the
 * implementation before the fix:
 *
 *   MHG-F3-01  HOLIDAY BLINDNESS — the guard only checked Saturday/Sunday, so an
 *              exchange holiday falling on a weekday (2026-01-01, 2026-08-17,
 *              2026-05-27 …) was reported SESSION_1 / LIVE_MARKET, isMarketOpen
 *              was true, and the Telegram broadcast gate stayed open while the
 *              exchange was completely shut. The file header already promised
 *              "Sabtu, Minggu, & Libur: Mutlak 'CLOSED'" — the implementation
 *              contradicted its own contract.
 *
 *   MHG-F3-02  HOST-TIMEZONE DEPENDENCE — a naive datetime string
 *              ('2026-03-30 09:30:00', the SQL timestamp shape) was parsed with
 *              the host OS zone: on a UTC VPS it became 16:30 WIB (CLOSED) but
 *              on a WIB laptop 09:30 WIB (SESSION_1). The module documents
 *              "Deterministic calculation independent of host OS timezone" —
 *              production and local runs disagreed.
 *
 *   MHG-F3-03  CUTOFF CONSISTENCY — the 14:30 radar cutoff, the session
 *              classifier, and the broadcast gate must agree, and a holiday must
 *              fail closed for new radar signals too (not just for open/closed).
 *
 * Every assertion below is written so it FAILS against the pre-fix
 * implementation and PASSES after the fix.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../lib/market-hours-guard');
const { IDX_HOLIDAYS_2026 } = require('../lib/idx-holidays-2026-seed-data');

// WIB wall-clock -> instant. Using the explicit +07:00 offset keeps these tests
// independent of the host timezone on which the suite runs.
function wib(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00+07:00`);
}

// Non-holiday reference dates (September 2026 has no seed holidays).
const THU = '2026-09-17';
const FRI = '2026-09-18';
const SAT = '2026-09-19';
const SUN = '2026-09-20';

// Seed holidays that fall on a weekday — these are the exact dates that used to
// be reported as an open market.
const WEEKDAY_HOLIDAYS = IDX_HOLIDAYS_2026
  .map((h) => h.trade_date)
  .filter((d) => {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    return dow !== 0 && dow !== 6;
  });

// ---------------------------------------------------------------------------
// MHG-F3-01 — hari libur bursa di hari kerja WAJIB CLOSED
// ---------------------------------------------------------------------------

test('MHG-F3-01a: weekday exchange holiday is CLOSED, never SESSION_1', () => {
  assert.ok(WEEKDAY_HOLIDAYS.length > 0, 'seed harus memuat libur hari kerja untuk diuji');

  for (const date of WEEKDAY_HOLIDAYS) {
    assert.equal(guard.getMarketSession(wib(date, '10:00')), 'CLOSED',
      `${date} adalah libur bursa — tidak boleh dilaporkan sebagai sesi terbuka`);
    assert.equal(guard.isMarketOpen(wib(date, '10:00')), false,
      `${date} libur bursa — isMarketOpen harus false (broadcast gate tertutup)`);
  }
});

test('MHG-F3-01b: holiday is CLOSED for both session windows and around the 14:30 cutoff', () => {
  const holiday = '2026-08-17'; // Monday, Proklamasi Kemerdekaan
  for (const t of ['09:00', '10:30', '13:30', '14:29', '14:30', '15:45']) {
    assert.equal(guard.getMarketSession(wib(holiday, t)), 'CLOSED',
      `${holiday} ${t} WIB harus CLOSED sepanjang hari`);
    assert.equal(guard.isMarketOpen(wib(holiday, t)), false,
      `${holiday} ${t} WIB tidak boleh membuka broadcast`);
  }
});

test('MHG-F3-01c: status classifier reports a holiday with reason=holiday (not LIVE_MARKET)', () => {
  const status = guard.getMarketSessionStatus(wib('2026-08-17', '10:30'));
  assert.equal(status.isOpen, false, 'libur bursa bukan LIVE_MARKET');
  assert.equal(status.status, 'OUTSIDE_MARKET');
  assert.equal(status.session, 'CLOSED');
  assert.equal(status.run_mode, 'OUTSIDE_MARKET');
  assert.equal(status.reason, 'holiday', 'alasan harus spesifik holiday, bukan weekend/after_close');
  assert.equal(status.broadcast_allowed, false, 'broadcast_allowed wajib false saat libur');
  assert.equal(status.minutes_to_session_end, null);
});

test('MHG-F3-01d: a new radar signal must fail closed on a holiday', () => {
  const holiday = '2026-01-01'; // Thursday, Tahun Baru 2026
  assert.equal(guard.isAfternoonExitCutoff(wib(holiday, '10:00')), true,
    'cutoff harus true di hari libur (fail-closed: jangan kirim radar baru)');
  const window = guard.evaluateDayTradeRadarWindow(wib(holiday, '10:00'));
  assert.equal(window.allowed, false, 'radar baru tidak boleh lolos di hari libur');
  assert.equal(window.reason, 'holiday');
});

test('MHG-F3-01e: holiday rejection must not leak into the next trading day', () => {
  // 2026-08-17 is a Monday holiday; Tuesday 2026-08-18 is a normal trading day.
  assert.equal(guard.getMarketSession(wib('2026-08-17', '10:00')), 'CLOSED');
  assert.equal(guard.getMarketSession(wib('2026-08-18', '10:00')), 'SESSION_1',
    'hari bursa setelah libur harus kembali normal');
  assert.equal(guard.isMarketOpen(wib('2026-08-18', '10:00')), true);
  const window = guard.evaluateDayTradeRadarWindow(wib('2026-08-18', '10:00'));
  assert.equal(window.allowed, true);
});

test('MHG-F3-01f: an injected holidaySet is honoured (DB calendar injection point)', () => {
  const custom = new Set(['2026-09-17']);
  assert.equal(guard.getMarketSession(wib(THU, '10:00'), custom), 'CLOSED',
    'hari yang di-inject sebagai libur harus CLOSED');
  assert.equal(guard.isMarketOpen(wib(THU, '10:00'), custom), false);
  assert.equal(guard.getMarketSessionStatus(wib(THU, '10:00'), custom).reason, 'holiday');
  // A non-holiday day is unaffected by the injected set.
  assert.equal(guard.getMarketSession(wib(FRI, '10:00'), custom), 'SESSION_1');
});

test('MHG-F3-01g: resolveHolidaySet accepts Set / array / undefined without crashing', () => {
  assert.ok(guard.resolveHolidaySet(undefined) instanceof Set, 'default harus Set seed');
  assert.equal(guard.resolveHolidaySet(undefined).size, IDX_HOLIDAYS_2026.length);
  assert.ok(guard.resolveHolidaySet(['2026-09-17']) instanceof Set);
  assert.equal(guard.resolveHolidaySet(['2026-09-17']).has('2026-09-17'), true);
  assert.equal(guard.resolveHolidaySet(new Set(['2026-09-17'])).has('2026-09-17'), true);
});

test('MHG-F3-01h: isExchangeHoliday reports the seed calendar correctly', () => {
  assert.equal(guard.isExchangeHoliday(wib('2026-08-17', '10:00')), true);
  assert.equal(guard.isExchangeHoliday(wib(THU, '10:00')), false, 'hari bursa normal bukan libur');
  assert.equal(guard.isExchangeHoliday('invalid-date'), false, 'input invalid -> bukan libur (ditolak di jalur sesi)');
});

// ---------------------------------------------------------------------------
// MHG-F3-02 — parsing deterministik, tidak bergantung timezone host OS
// ---------------------------------------------------------------------------

test('MHG-F3-02a: naive datetime string is read as Jakarta wall clock', () => {
  const c = guard.getWibComponents('2026-03-30 09:30:00');
  assert.equal(c.isValid, true);
  assert.equal(c.hours, 9, 'jam harus dibaca apa adanya sebagai WIB, bukan digeser zona host');
  assert.equal(c.minutes, 30);
  assert.equal(c.timeStr, '09:30');
  assert.equal(c.dateStr, '2026-03-30');
});

test('MHG-F3-02b: naive string drives the session, not the host timezone', () => {
  assert.equal(guard.getMarketSession('2026-03-30 09:30:00'), 'SESSION_1',
    '09:30 WIB adalah sesi 1 terlepas dari zona host');
  assert.equal(guard.isMarketOpen('2026-03-30 09:30:00'), true);
  assert.equal(guard.getMarketSession('2026-03-30 12:45:00'), 'CLOSED',
    '12:45 WIB adalah jeda siang');
});

test('MHG-F3-02c: T-separated naive strings and minute precision parse the same way', () => {
  for (const s of ['2026-03-30T09:30:00', '2026-03-30 09:30', '2026-03-30T09:30']) {
    const c = guard.getWibComponents(s);
    assert.equal(c.timeStr, '09:30', `${s} harus dibaca sebagai 09:30 WIB`);
    assert.equal(guard.getMarketSession(s), 'SESSION_1');
  }
});

test('MHG-F3-02d: strings carrying an explicit zone are NOT re-interpreted', () => {
  // 02:30Z == 09:30 WIB. Explicit-zone strings must keep their instant semantics.
  const c = guard.getWibComponents('2026-03-30T02:30:00Z');
  assert.equal(c.timeStr, '09:30', 'instant UTC harus dikonversi ke WIB, bukan diperlakukan sebagai WIB mentah');
  assert.equal(guard.getMarketSession('2026-03-30T02:30:00Z'), 'SESSION_1');
  assert.equal(guard.getWibComponents('2026-03-30T02:30:00+07:00').timeStr, '02:30',
    'offset +07:00 harus dihormati apa adanya');
});

test('MHG-F3-02e: Date objects keep instant semantics', () => {
  const d = new Date('2026-03-30T02:30:00Z');
  assert.equal(guard.getWibComponents(d).timeStr, '09:30');
  assert.equal(guard.getMarketSession(d), 'SESSION_1');
});

test('MHG-F3-02f: normalizeDateInput only rewrites naive strings', () => {
  const d = new Date('2026-03-30T02:30:00Z');
  assert.equal(guard.normalizeDateInput(d), d, 'objek Date tidak boleh diubah');
  assert.equal(guard.normalizeDateInput(1774000000000), 1774000000000, 'epoch number diteruskan');
  assert.equal(guard.normalizeDateInput('2026-03-30T02:30:00Z'), '2026-03-30T02:30:00Z',
    'string berzona diteruskan apa adanya');
  const normalized = guard.normalizeDateInput('2026-03-30 09:30:00');
  assert.ok(normalized instanceof Date, 'string naive harus menjadi Date');
  assert.equal(normalized.getTime(), Date.parse('2026-03-30T09:30:00+07:00'),
    'hasil normalisasi harus sama dengan instant 09:30 WIB');
});

test('MHG-F3-02g: invalid input still fails closed', () => {
  assert.equal(guard.getMarketSession('invalid-date'), 'CLOSED');
  assert.equal(guard.isMarketOpen('invalid-date'), false);
  assert.equal(guard.isAfternoonExitCutoff('invalid-date'), true);
  assert.equal(guard.getWibComponents('invalid-date').isValid, false);
  assert.equal(guard.getMarketSessionStatus('invalid-date').reason, 'invalid_time');
});

// ---------------------------------------------------------------------------
// MHG-F3-03 — cutoff 14:30 & konsistensi lapisan sesi
// ---------------------------------------------------------------------------

test('MHG-F3-03a: the 14:30 cutoff boundary is exact (14:30 allowed, 14:31 blocked)', () => {
  assert.equal(guard.isAfternoonExitCutoff(wib(THU, '14:29')), false);
  assert.equal(guard.isAfternoonExitCutoff(wib(THU, '14:30')), false, '14:30 adalah menit terakhir yang diizinkan');
  assert.equal(guard.isAfternoonExitCutoff(wib(THU, '14:31')), true);
  assert.equal(guard.isAfternoonExitCutoff(wib(THU, '15:00')), true);
});

test('MHG-F3-03b: radar window agrees with the cutoff and with the session', () => {
  assert.equal(guard.evaluateDayTradeRadarWindow(wib(THU, '14:30')).allowed, true);
  assert.equal(guard.evaluateDayTradeRadarWindow(wib(THU, '14:30')).reason, 'within_radar_window');
  assert.equal(guard.evaluateDayTradeRadarWindow(wib(THU, '14:31')).allowed, false);
  assert.equal(guard.evaluateDayTradeRadarWindow(wib(THU, '14:31')).reason, 'after_1430_wib_cutoff');
  assert.equal(guard.evaluateDayTradeRadarWindow(wib(THU, '12:45')).reason, 'lunch_break',
    'jeda siang harus dilaporkan sebagai lunch_break, bukan cutoff');
});

test('MHG-F3-03c: weekend is CLOSED and fails closed for radar (reason=weekend)', () => {
  for (const [date, label] of [[SAT, 'Sabtu'], [SUN, 'Minggu']]) {
    assert.equal(guard.getMarketSession(wib(date, '10:00')), 'CLOSED', `${label} harus CLOSED`);
    assert.equal(guard.isMarketOpen(wib(date, '10:00')), false);
    assert.equal(guard.isAfternoonExitCutoff(wib(date, '10:00')), true, `${label} harus fail-closed untuk radar`);
    const window = guard.evaluateDayTradeRadarWindow(wib(date, '10:00'));
    assert.equal(window.allowed, false);
    assert.equal(window.reason, 'weekend');
    assert.equal(guard.getMarketSessionStatus(wib(date, '10:00')).reason, 'weekend');
  }
});

test('MHG-F3-03d: broadcast gate (isMarketOpen) never disagrees with the session classifier', () => {
  // Sampled across both sessions on a Thursday and a Friday, plus the breaks.
  const samples = [
    [THU, '08:59'], [THU, '09:00'], [THU, '10:30'], [THU, '11:57'], [THU, '11:58'],
    [THU, '11:59'], [THU, '12:00'], [THU, '13:29'], [THU, '13:30'], [THU, '15:45'], [THU, '15:46'],
    [FRI, '09:00'], [FRI, '11:27'], [FRI, '11:28'], [FRI, '11:29'], [FRI, '13:59'],
    [FRI, '14:00'], [FRI, '15:45'], [FRI, '15:46']
  ];
  for (const [d, t] of samples) {
    const bySession = guard.getMarketSession(wib(d, t)) !== 'CLOSED';
    const byGuard = guard.isMarketOpen(wib(d, t));
    const byBroadcast = guard.getMarketSessionStatus(wib(d, t)).broadcast_allowed;
    assert.equal(byGuard, bySession, `isMarketOpen vs getMarketSession berbeda di ${d} ${t}`);
    assert.equal(byBroadcast, bySession, `broadcast_allowed vs getMarketSession berbeda di ${d} ${t}`);
  }
});

test('MHG-F3-03e: session 1 broadcast buffer stays 11:58 (Mon-Thu) / 11:28 (Fri)', () => {
  assert.equal(guard.getMarketSession(wib(THU, '11:58')), 'SESSION_1');
  assert.equal(guard.getMarketSession(wib(THU, '11:59')), 'CLOSED');
  assert.equal(guard.getMarketSession(wib(FRI, '11:28')), 'SESSION_1');
  assert.equal(guard.getMarketSession(wib(FRI, '11:29')), 'CLOSED');
  // The STATUS classifier intentionally keeps the FULL window for diagnosis.
  const s1159 = guard.getMarketSessionStatus(wib(THU, '11:59'));
  assert.equal(s1159.isOpen, true, 'status full-window tetap LIVE untuk diagnosis Stage-2');
  assert.equal(s1159.session, 'SESSION_1');
  assert.equal(s1159.broadcast_allowed, false, 'namun broadcast tetap diblokir buffer');
});

test('MHG-F3-03f: run_mode mapping is unchanged', () => {
  assert.equal(guard.getMarketSessionStatus(wib(THU, '09:30')).run_mode, 'MORNING_SCOUT');
  assert.equal(guard.getMarketSessionStatus(wib(THU, '11:00')).run_mode, 'MIDDAY_CHECK');
  assert.equal(guard.getMarketSessionStatus(wib(THU, '14:00')).run_mode, 'AFTERNOON_EXIT');
  assert.equal(guard.getMarketSessionStatus(wib(THU, '08:00')).run_mode, 'OUTSIDE_MARKET');
  assert.equal(guard.getMarketSessionStatus(wib(SAT, '10:00')).run_mode, 'OUTSIDE_MARKET');
});

// ---------------------------------------------------------------------------
// Anti-over-fix: normal trading days must stay fully open
// ---------------------------------------------------------------------------

test('ANTI-OVERFIX: a normal week is unaffected by the holiday rule', () => {
  const week = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'];
  for (const d of week) {
    assert.equal(guard.isExchangeHoliday(wib(d, '10:00')), false, `${d} bukan libur`);
    assert.equal(guard.getMarketSession(wib(d, '10:00')), 'SESSION_1', `${d} harus sesi 1`);
    assert.equal(guard.isMarketOpen(wib(d, '10:00')), true);
    assert.equal(guard.evaluateDayTradeRadarWindow(wib(d, '10:00')).allowed, true);
  }
});

test('ANTI-OVERFIX: seed holiday list is the single source of truth (22 entries)', () => {
  assert.equal(IDX_HOLIDAYS_2026.length, 22, 'daftar libur 2026 tidak boleh berubah diam-diam');
  assert.equal(guard.SEED_HOLIDAY_SET.size, IDX_HOLIDAYS_2026.length);
  assert.equal(guard.SEED_HOLIDAY_SET.has('2026-08-17'), true);
  assert.equal(guard.SEED_HOLIDAY_SET.has('2026-09-17'), false);
});

test('ANTI-OVERFIX: exported session constants keep their documented values', () => {
  assert.equal(guard.SESSION_1_START_MINUTES, 540);
  assert.equal(guard.SESSION_1_END_MINUTES, 718, 'broadcast gate 11:58');
  assert.equal(guard.SESSION_2_START_MINUTES, 810);
  assert.equal(guard.SESSION_2_END_MINUTES, 945);
  assert.equal(guard.FRIDAY_SESSION_1_END_MINUTES, 688, 'Jumat 11:28');
  assert.equal(guard.FRIDAY_SESSION_2_START_MINUTES, 840, 'Jumat 14:00');
  assert.equal(guard.DAYTRADE_RADAR_CUTOFF_MINUTES, 870, 'cutoff 14:30');
  assert.equal(guard.FULL_SESSION_1_END_MINUTES, 720, 'status full window 12:00');
  assert.equal(guard.FULL_FRIDAY_SESSION_1_END_MINUTES, 690, 'status Jumat 11:30');
});
