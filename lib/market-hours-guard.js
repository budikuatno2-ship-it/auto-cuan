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
 *    - Mutlak 'CLOSED' (false).
 *
 * DUA LEVEL KEPUTUSAN (dokumentasi penting, jangan disatukan):
 *
 *   1. getMarketSessionStatus() — KLASIFIKASI SESI (untuk RUN MODE runner).
 *      Memakai jam bursa penuh: Sesi 1 09:00–12:00, Sesi 2 13:30–15:45 WIB
 *      (Jumat: Sesi 1 09:00–11:30, Sesi 2 14:00–15:45). Selama salah satu
 *      sesi berjalan, `status` = 'LIVE_MARKET' dan `isOpen` = true — jadi
 *      runner intraday mengenali dirinya sebagai LIVE_MARKET, bukan
 *      OUTSIDE_MARKET.
 *
 *   2. isMarketOpen() — GEMBOK BROADCAST (lebih konservatif).
 *      Menutup 2 menit sebelum akhir Sesi 1 supaya tidak ada broadcast
 *      memakai order book yang sudah beku. Ini gate yang dipakai
 *      lib/telegram-notifier.js. Perbedaannya disengaja: klasifikasi sesi
 *      vs. izin kirim.
 */

'use strict';

// --- Jam bursa otoritatif (menit sejak 00:00 WIB) ---
const SESSION_1_START_MINUTES = 9 * 60;        // 09:00
const SESSION_1_END_MINUTES = 12 * 60;         // 12:00
const SESSION_2_START_MINUTES = 13 * 60 + 30;  // 13:30
const SESSION_2_END_MINUTES = 15 * 60 + 45;    // 15:45

// Jumat: sesi 1 berakhir 11:30, sesi 2 dibuka 14:00 (sholat Jumat).
const FRIDAY_SESSION_1_END_MINUTES = 11 * 60 + 30; // 11:30
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
  const d = dateInput == null ? new Date() : new Date(dateInput);
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
  const wibMs = d.getTime() + (7 * 60 * 60 * 1000);
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
 * @param {Date|number|string} [date]
 * @returns {'SESSION_1'|'SESSION_2'|'CLOSED'}
 */
function getMarketSession(date = new Date()) {
  const wib = getWibComponents(date);
  if (!wib.isValid) return 'CLOSED';

  // Weekend: Saturday (6) or Sunday (0)
  if (wib.dayOfWeek === 0 || wib.dayOfWeek === 6) {
    return 'CLOSED';
  }

  const isFriday = (wib.dayOfWeek === 5);

  if (isFriday) {
    // Khusus Jumat:
    // Sesi 1: 09:00 s/d 11:28 WIB (540 to 688 total minutes inclusive)
    if (wib.totalMinutes >= 540 && wib.totalMinutes <= 688) {
      return 'SESSION_1';
    }
    // Sesi 2: 14:00 s/d 15:45 WIB (840 to 945 total minutes inclusive)
    if (wib.totalMinutes >= 840 && wib.totalMinutes <= 945) {
      return 'SESSION_2';
    }
  } else {
    // Senin s/d Kamis:
    // Sesi 1: 09:00 s/d 11:58 WIB (540 to 718 total minutes inclusive)
    if (wib.totalMinutes >= 540 && wib.totalMinutes <= 718) {
      return 'SESSION_1';
    }
    // Sesi 2: 13:30 s/d 15:45 WIB (810 to 945 total minutes inclusive)
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
 * Konservatif: menutup 2 menit sebelum akhir Sesi 1 (buffer order book beku).
 *
 * @param {Date|number|string} [date]
 * @returns {boolean} True strictly during Session 1 or Session 2, false otherwise
 */
function isMarketOpen(date = new Date()) {
  const session = getMarketSession(date);
  return session === 'SESSION_1' || session === 'SESSION_2';
}

/**
 * KLASIFIKASI SESI untuk RUN MODE runner intraday.
 *
 * Berbeda dari getMarketSession() (yang membawa buffer 2 menit untuk gembok
 * broadcast), helper ini memakai jam bursa penuh supaya runner mengenali
 * dirinya sebagai LIVE_MARKET selama bursa benar-benar buka:
 *   Senin–Kamis: Sesi 1 09:00–12:00, Sesi 2 13:30–15:45
 *   Jumat:       Sesi 1 09:00–11:30, Sesi 2 14:00–15:45
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
function getMarketSessionStatus(dateInput) {
  const wib = getWibComponents(dateInput == null ? new Date() : dateInput);
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
    broadcast_allowed: isMarketOpen(dateInput == null ? new Date() : dateInput)
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

  const isFriday = (wib.dayOfWeek === 5);
  const session1End = isFriday ? FRIDAY_SESSION_1_END_MINUTES : SESSION_1_END_MINUTES;
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

  if (wib.totalMinutes < session1End) {
    return Object.assign(base, {
      isOpen: true,
      session: 'SESSION_1',
      status: 'LIVE_MARKET',
      run_mode: wib.totalMinutes <= 630 ? 'MORNING_SCOUT' : 'MIDDAY_CHECK',
      reason: isFriday ? 'friday_session_1' : 'session_1',
      minutes_to_session_end: session1End - wib.totalMinutes
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
function isAfternoonExitCutoff(dateInput) {
  const wib = getWibComponents(dateInput == null ? new Date() : dateInput);
  if (!wib.isValid) return true; // fail-closed: waktu tidak dikenal -> jangan kirim
  if (wib.dayOfWeek === 0 || wib.dayOfWeek === 6) return true;
  return wib.totalMinutes > DAYTRADE_RADAR_CUTOFF_MINUTES;
}

/**
 * Bolehkah radar/sinyal pantauan baru dipublikasikan sekarang?
 * Wajib di dalam sesi bursa DAN belum melewati cut-off 14:30 WIB.
 *
 * @param {Date|number|string} [dateInput]
 * @returns {{ allowed: boolean, reason: string, session: string, wib_time: string }}
 */
function evaluateDayTradeRadarWindow(dateInput) {
  const status = getMarketSessionStatus(dateInput);
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
  getWibComponents,
  getWibNow,
  getWibDateString,
  getMarketSession,
  getMarketSessionStatus,
  isMarketOpen,
  isAfternoonExitCutoff,
  evaluateDayTradeRadarWindow
};
