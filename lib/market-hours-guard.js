/**
 * Centralized Market Hours Guard — Auto-Cuan IDX Trading Engine
 *
 * Strict IDX (Indonesia Stock Exchange) Official Schedule (WIB / Asia/Jakarta / UTC+7):
 *
 * A. Senin s/d Kamis (Monday - Thursday):
 *    - Sesi 1: 09:00 s/d 11:58 WIB (buffer 2 menit sebelum 12:00) -> 'SESSION_1' (true)
 *    - Istirahat: 11:58 s/d 13:30 WIB -> 'CLOSED' (false)
 *    - Sesi 2: 13:30 s/d 15:45 WIB -> 'SESSION_2' (true)
 *    - Di luar jam tersebut -> 'CLOSED' (false)
 *
 * B. Khusus Hari Jumat (Friday):
 *    - Sesi 1: 09:00 s/d 11:28 WIB (buffer 2 menit sebelum 11:30) -> 'SESSION_1' (true)
 *    - Istirahat Sholat Jumat: 11:28 s/d 14:00 WIB -> 'CLOSED' (false)
 *    - Sesi 2: 14:00 s/d 15:45 WIB -> 'SESSION_2' (true)
 *    - Di luar jam tersebut -> 'CLOSED' (false)
 *
 * C. Sabtu, Minggu, & Libur:
 *    - Mutlak 'CLOSED' (false). Hari libur bursa dinilai dari kalender seed
 *      (lib/idx-holidays-2026-seed-data.js) atau holidaySet yang di-inject
 *      pemanggil; tanpa data libur yang bisa dipercaya guard TIDAK menebak.
 *
 * DUA LEVEL KEPUTUSAN:
 *
 *   - getMarketSession() + isMarketOpen() — GERBANG OTORITATIF sesi.
 *     Keduanya memakai buffer 2 menit yang SAMA: sesi 1 benar-benar berakhir
 *     11:58/11:28, supaya order book yang sudah beku tidak ter-broadcast.
 *
 *   - getMarketSessionStatus() — KLASIFIKASI RUN-MODE runner intraday.
 *     *Mempertahankan jam penuh* 09:00-12:00/11:30 untuk diagnosis
 *     "Kenapa Tidak Scan?": pada 11:59 Mon runner sudah di luar broadcast
 *     namun status-nya tetap LIVE_MARKET (SESSION_1), sedangkan isOpen dan
 *     broadcast_allowed sudah false — operator melihat "sesi masih LIVE,
 *     namun broadcast diblokir buffer" alih-alih "runner keliru CLOSED".
 *     Stage-2 dan Batch-3 memang mengunci kontrak inilah (A1/A7/B3-01/B3-05).
 *     Fase 13 memperbaiki kesenjangan broadcast, bukan menutupnya.
 */

'use strict';

// Hari libur bursa: satu sumber kebenaran yang sama dipakai lib/idx-trading-calendar.js
// (getSeedHolidaySet). Sebelumnya guard ini HANYA memeriksa weekend, sehingga hari
// libur bursa di hari kerja dilaporkan SESSION_1/LIVE_MARKET dan broadcast Telegram
// tetap dikirim padahal bursa tutup total — bertentangan dengan kontrak header
// "Sabtu, Minggu, & Libur: Mutlak 'CLOSED'".
const { IDX_HOLIDAYS_2026 } = require('./idx-holidays-2026-seed-data');

const SEED_HOLIDAY_SET = new Set(IDX_HOLIDAYS_2026.map((h) => h.trade_date));

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * Holiday set resolution. Explicit injection wins so tests and cron jobs can
 * load the DB calendar (idx_trading_calendar) once per batch; otherwise the
 * bundled 2026 seed is used so a holiday is never silently treated as trading.
 */
function resolveHolidaySet(holidaySet) {
  if (holidaySet instanceof Set) return holidaySet;
  if (Array.isArray(holidaySet)) return new Set(holidaySet.map((d) => String(d).slice(0, 10)));
  return SEED_HOLIDAY_SET;
}

/**
 * True bila tanggal (WIB) adalah hari libur bursa menurut holidaySet.
 * Invalid date -> false (fail-open di sini saja; pemanggil tetap fail-closed
 * karena getWibComponents menandai waktu invalid dan sesi menjadi CLOSED).
 */
function isExchangeHoliday(dateInput, holidaySet) {
  const wib = getWibComponents(dateInput);
  if (!wib.isValid) return false;
  return resolveHolidaySet(holidaySet).has(wib.dateStr);
}

/**
 * Naive datetime strings ('YYYY-MM-DD HH:mm[:ss]' / 'YYYY-MM-DDTHH:mm[:ss]' tanpa
 * zona) WAJIB dibaca sebagai jam dinding Jakarta. `new Date(string)` memakai
 * timezone host OS: di VPS UTC '2026-03-30 09:30:00' menjadi 16:30 WIB (CLOSED)
 * sementara di laptop WIB menjadi 09:30 WIB (SESSION_1) — kontrak modul
 * "independent of host OS timezone" dilanggar. String dengan zona (Z / ±hh:mm)
 * dan objek Date tetap diteruskan apa adanya.
 */
const NAIVE_WIB_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

function normalizeDateInput(dateInput) {
  if (typeof dateInput !== 'string') return dateInput;
  const m = NAIVE_WIB_RE.exec(dateInput.trim());
  if (!m) return dateInput;
  const ms = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6] || 0), Number((m[7] || '0').padEnd(3, '0'))
  );
  return new Date(ms - WIB_OFFSET_MS);
}

// --- Jam bursa otoritatif (menit sejak 00:00 WIB) ---
// Broadcast gate AND run-mode classifier session length.
// F13-01: was 720/690; now recomputed so isMarketOpen agrees with getMarketSession.
// But the STATUS classifier intentionally keeps the full window — see header.
const FULL_SESSION_1_END_MINUTES = 12 * 60;         // 12:00 full window (for status)
const FULL_FRIDAY_SESSION_1_END_MINUTES = 11 * 60 + 30; // 11:30

const SESSION_1_START_MINUTES = 9 * 60;        // 09:00
const SESSION_1_END_MINUTES = 11 * 60 + 58;    // 11:58 (Mon-Thu) — broadcast gate
const SESSION_2_START_MINUTES = 13 * 60 + 30;  // 13:30
const SESSION_2_END_MINUTES = 15 * 60 + 45;    // 15:45

// Jumat
const FRIDAY_SESSION_1_END_MINUTES = 11 * 60 + 28; // 11:28
const FRIDAY_SESSION_2_START_MINUTES = 14 * 60;    // 14:00

// Hard cut-off radar pantauan Day Trade: SETELAH 14:30 WIB tidak ada lagi
// radar/sinyal pantauan baru menjelang closing (AFTERNOON_EXIT rule).
// 14:30 sendiri masih diizinkan (menit terakhir jendela eksekusi); yang
// diblokir adalah 14:31 dst, termasuk radar 15:37 WIB menjelang closing.
const DAYTRADE_RADAR_CUTOFF_MINUTES = 14 * 60 + 30; // 14:30

/**
 * Normalizes input date to explicit WIB date components (UTC+7)
 * Deterministic calculation independent of host OS timezone (e.g. UTC on Oracle Cloud VPS)
 *
 * @param {Date|number|string} [dateInput]
 * @returns {{ dayOfWeek: number, hours: number, minutes: number, seconds: number, totalMinutes: number, dateStr: string, timeStr: string, isValid: boolean }}
 */
function getWibComponents(dateInput) {
  // Naive 'YYYY-MM-DD HH:mm[:ss]' dibaca sebagai jam dinding Jakarta, bukan jam
  // host OS — lihat normalizeDateInput() untuk alasan lengkapnya.
  const normalized = normalizeDateInput(dateInput);
  const d = normalized == null ? new Date() : new Date(normalized);
  if (Number.isNaN(d.getTime())) {
    return {
      dayOfWeek: -1,
      hours: -1,
      minutes: -1,
      seconds: -1,
      totalMinutes: -1,
      dateStr: '',
      timeStr: '',
      isValid: false
    };
  }

  // Add 7 hours to UTC timestamp to compute deterministic Jakarta time
  const wibMs = d.getTime() + WIB_OFFSET_MS;
  const wibDate = new Date(wibMs);

  const dayOfWeek = wibDate.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 5 = Friday, 6 = Saturday
  const hours = wibDate.getUTCHours();
  const minutes = wibDate.getUTCMinutes();
  const seconds = wibDate.getUTCSeconds();
  const totalMinutes = hours * 60 + minutes;

  const dateStr = wibDate.toISOString().slice(0, 10);
  const timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

  return {
    dayOfWeek,
    hours,
    minutes,
    seconds,
    totalMinutes,
    dateStr,
    timeStr,
    isValid: true
  };
}

/**
 * Current time already shifted to WIB. Callers that need WIB wall-clock
 * components must read them through getUTC*() (the Date is WIB-shifted).
 *
 * @returns {Date}
 */
function getWibNow() {
  return new Date(Date.now() + (7 * 60 * 60 * 1000));
}

/**
 * Current WIB trading date as YYYY-MM-DD.
 * @returns {string}
 */
function getWibDateString() {
  return getWibNow().toISOString().slice(0, 10);
}

/**
 * Resolves current market session identifier according to IDX schedule
 *
 * Mon-Thu Sesi 1 uses broadcast gate 11:58, Fri uses 11:28.
 *
 * @param {Date|number|string} [date]
 * @returns {'SESSION_1'|'SESSION_2'|'CLOSED'}
 */
function getMarketSession(date = new Date(), holidaySet) {
  const wib = getWibComponents(normalizeDateInput(date));
  if (!wib.isValid) return 'CLOSED';

  // Weekend: Saturday (6) or Sunday (0)
  if (wib.dayOfWeek === 0 || wib.dayOfWeek === 6) {
    return 'CLOSED';
  }

  // Hari libur bursa (Senin-Jumat) juga CLOSED sesuai kontrak header.
  if (resolveHolidaySet(holidaySet).has(wib.dateStr)) {
    return 'CLOSED';
  }

  const isFriday = (wib.dayOfWeek === 5);

  if (isFriday) {
    if (wib.totalMinutes >= 540 && wib.totalMinutes <= 688) {
      return 'SESSION_1';
    }
    if (wib.totalMinutes >= 840 && wib.totalMinutes <= 945) {
      return 'SESSION_2';
    }
  } else {
    if (wib.totalMinutes >= 540 && wib.totalMinutes <= 718) {
      return 'SESSION_1';
    }
    if (wib.totalMinutes >= 810 && wib.totalMinutes <= 945) {
      return 'SESSION_2';
    }
  }

  // Break / Pre-market / Post-market / Night
  return 'CLOSED';
}

/**
 * Validates if IDX market is currently open for trading / signal broadcast
 *
 * @param {Date|number|string} [date]
 * @returns {boolean} True strictly during Session 1 or Session 2, false otherwise
 */
function isMarketOpen(date = new Date(), holidaySet) {
  const session = getMarketSession(date, holidaySet);
  return session === 'SESSION_1' || session === 'SESSION_2';
}

/**
 * KLASIFIKASI SESI untuk RUN MODE runner intraday.
 *
 * FULL window (09:00-12:00 / 09:00-11:30) adalah protokol Stage-2:
 * 11:59 Mon-Thu dan 11:29 Fri tetap SESSION_1 / LIVE_MARKET sehingga
 * diagnosis "Kenapa Tidak Scan?" di still-path tidak terkecoh.  Sisi
 * broadcast (isMarketOpen/broadcast_allowed) menggunakan buffer dan
 * akan false pada dua menit terakhir — perbedaan ini disengaja dan
 * diuji oleh A7 (isOpen true namun broadcast_allowed false).
 *
 * @param {Date|number|string} [dateInput]
 * @returns {{
 *   isOpen: boolean,
 *   session: 'PRE'|'SESSION_1'|'BREAK'|'SESSION_2'|'CLOSED',
 *   status: 'LIVE_MARKET'|'OUTSIDE_MARKET',
 *   run_mode: 'MORNING_SCOUT'|'MIDDAY_CHECK'|'AFTERNOON_EXIT'|'OUTSIDE_MARKET',
 *   reason: string,
 *   wib_date: string,
 *   wib_time: string,
 *   total_minutes: number,
 *   minutes_to_session_end: number|null,
 *   radar_cutoff_passed: boolean,
 *   broadcast_allowed: boolean
 * }}
 */
function getMarketSessionStatus(dateInput, holidaySet) {
  const resolved = normalizeDateInput(dateInput == null ? new Date() : dateInput);
  const wib = getWibComponents(resolved);
  if (!wib.isValid) {
    return {
      isOpen: false,
      session: 'CLOSED',
      status: 'OUTSIDE_MARKET',
      run_mode: 'OUTSIDE_MARKET',
      reason: 'invalid_time',
      wib_date: '',
      wib_time: '',
      total_minutes: -1,
      minutes_to_session_end: null,
      radar_cutoff_passed: true,
      broadcast_allowed: false
    };
  }

  const base = {
    wib_date: wib.dateStr,
    wib_time: wib.timeStr,
    total_minutes: wib.totalMinutes,
    radar_cutoff_passed: wib.totalMinutes > DAYTRADE_RADAR_CUTOFF_MINUTES,
    broadcast_allowed: isMarketOpen(resolved, holidaySet)
  };

  if (wib.dayOfWeek === 0 || wib.dayOfWeek === 6) {
    return Object.assign(base, {
      isOpen: false,
      session: 'CLOSED',
      status: 'OUTSIDE_MARKET',
      run_mode: 'OUTSIDE_MARKET',
      reason: 'weekend',
      minutes_to_session_end: null
    });
  }

  // Hari libur bursa di hari kerja: bursa tutup total, bukan LIVE_MARKET.
  // Diperiksa SETELAH weekend agar alasan tetap spesifik ('holiday' vs 'weekend').
  if (resolveHolidaySet(holidaySet).has(wib.dateStr)) {
    return Object.assign(base, {
      isOpen: false,
      session: 'CLOSED',
      status: 'OUTSIDE_MARKET',
      run_mode: 'OUTSIDE_MARKET',
      reason: 'holiday',
      minutes_to_session_end: null
    });
  }

  const isFriday = (wib.dayOfWeek === 5);
  // Status FULL window vs broadcast window — intentionally wider.
  const fullSession1End = isFriday ? FULL_FRIDAY_SESSION_1_END_MINUTES : FULL_SESSION_1_END_MINUTES;
  const session2Start = isFriday ? FRIDAY_SESSION_2_START_MINUTES : SESSION_2_START_MINUTES;
  const openMin = SESSION_1_START_MINUTES;
  const closeMin = SESSION_2_END_MINUTES;

  if (wib.totalMinutes < openMin) {
    return Object.assign(base, {
      isOpen: false,
      session: 'PRE',
      status: 'OUTSIDE_MARKET',
      run_mode: 'OUTSIDE_MARKET',
      reason: 'before_open',
      minutes_to_session_end: openMin - wib.totalMinutes
    });
  }

  if (wib.totalMinutes < fullSession1End) {
    return Object.assign(base, {
      isOpen: true,
      session: 'SESSION_1',
      status: 'LIVE_MARKET',
      run_mode: wib.totalMinutes <= 630 ? 'MORNING_SCOUT' : 'MIDDAY_CHECK',
      reason: isFriday ? 'friday_session_1' : 'session_1',
      minutes_to_session_end: fullSession1End - wib.totalMinutes
    });
  }

  if (wib.totalMinutes < session2Start) {
    return Object.assign(base, {
      isOpen: false,
      session: 'BREAK',
      status: 'OUTSIDE_MARKET',
      run_mode: 'OUTSIDE_MARKET',
      reason: isFriday ? 'friday_break' : 'lunch_break',
      minutes_to_session_end: session2Start - wib.totalMinutes
    });
  }

  if (wib.totalMinutes <= closeMin) {
    return Object.assign(base, {
      isOpen: true,
      session: 'SESSION_2',
      status: 'LIVE_MARKET',
      run_mode: 'AFTERNOON_EXIT',
      reason: isFriday ? 'friday_session_2' : 'session_2',
      minutes_to_session_end: closeMin - wib.totalMinutes
    });
  }

  return Object.assign(base, {
    isOpen: false,
    session: 'CLOSED',
    status: 'OUTSIDE_MARKET',
    run_mode: 'OUTSIDE_MARKET',
    reason: 'after_close',
    minutes_to_session_end: null
  });
}

/**
 * Hard cut-off radar pantauan Day Trade (AFTERNOON_EXIT rule).
 *
 * SETELAH 14:30 WIB tidak boleh ada radar/sinyal pantauan BARU: sisa sesi
 * terlalu pendek untuk eksekusi, dan radar 15:37 WIB menjelang closing
 * hanya menghasilkan noise yang tidak actionable. Menit 14:30 masih boleh.
 *
 * @param {Date|number|string} [dateInput]
 * @returns {boolean} true bila sudah lewat 14:30 WIB (14:31 dst), atau bila
 *   waktu tidak dapat diparse / bukan hari bursa (fail-closed)
 */
function isAfternoonExitCutoff(dateInput, holidaySet) {
  const wib = getWibComponents(normalizeDateInput(dateInput == null ? new Date() : dateInput));
  if (!wib.isValid) return true; // fail-closed: waktu tidak dikenal -> jangan kirim
  if (wib.dayOfWeek === 0 || wib.dayOfWeek === 6) return true;
  // Bukan hari bursa (libur) -> fail-closed, radar baru tidak boleh dikirim.
  if (resolveHolidaySet(holidaySet).has(wib.dateStr)) return true;
  return wib.totalMinutes > DAYTRADE_RADAR_CUTOFF_MINUTES;
}

/**
 * Bolehkah radar/sinyal pantauan baru dipublikasikan sekarang?
 * Wajib di dalam sesi bursa DAN belum melewati cut-off 14:30 WIB.
 *
 * @param {Date|number|string} [dateInput]
 * @returns {{ allowed: boolean, reason: string, session: string, wib_time: string }}
 */
function evaluateDayTradeRadarWindow(dateInput, holidaySet) {
  const status = getMarketSessionStatus(dateInput, holidaySet);
  if (!status.isOpen) {
    return { allowed: false, reason: status.reason || 'market_not_open', session: status.session, wib_time: status.wib_time };
  }
  if (status.radar_cutoff_passed) {
    return { allowed: false, reason: 'after_1430_wib_cutoff', session: status.session, wib_time: status.wib_time };
  }
  return { allowed: true, reason: 'within_radar_window', session: status.session, wib_time: status.wib_time };
}

module.exports = {
  SESSION_1_START_MINUTES,
  SESSION_1_END_MINUTES,
  SESSION_2_START_MINUTES,
  SESSION_2_END_MINUTES,
  FRIDAY_SESSION_1_END_MINUTES,
  FRIDAY_SESSION_2_START_MINUTES,
  DAYTRADE_RADAR_CUTOFF_MINUTES,
  FULL_SESSION_1_END_MINUTES,
  FULL_FRIDAY_SESSION_1_END_MINUTES,
  getWibComponents,
  getWibNow,
  getWibDateString,
  getMarketSession,
  getMarketSessionStatus,
  isMarketOpen,
  isAfternoonExitCutoff,
  evaluateDayTradeRadarWindow,
  // Aditif (Batch 2 / Fase 3): observability + injection point untuk kalender
  // libur DB (idx_trading_calendar) yang dimuat sekali per batch job.
  SEED_HOLIDAY_SET,
  resolveHolidaySet,
  isExchangeHoliday,
  normalizeDateInput
};
