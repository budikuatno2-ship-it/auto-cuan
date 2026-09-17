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
 */

'use strict';

/**
 * Normalizes input date to explicit WIB date components (UTC+7)
 * Deterministic calculation independent of host OS timezone (e.g. UTC on Oracle Cloud VPS)
 *
 * @param {Date|number|string} [dateInput]
 * @returns {{ dayOfWeek: number, hours: number, minutes: number, totalMinutes: number, dateStr: string, timeStr: string, isValid: boolean }}
 */
function getWibComponents(dateInput) {
  const d = dateInput == null ? new Date() : new Date(dateInput);
  if (Number.isNaN(d.getTime())) {
    return {
      dayOfWeek: -1,
      hours: -1,
      minutes: -1,
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
  const totalMinutes = hours * 60 + minutes;

  const dateStr = wibDate.toISOString().slice(0, 10);
  const timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

  return {
    dayOfWeek,
    hours,
    minutes,
    totalMinutes,
    dateStr,
    timeStr,
    isValid: true
  };
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
 * @param {Date|number|string} [date]
 * @returns {boolean} True strictly during Session 1 or Session 2, false otherwise
 */
function isMarketOpen(date = new Date()) {
  const session = getMarketSession(date);
  return session === 'SESSION_1' || session === 'SESSION_2';
}

module.exports = {
  getWibComponents,
  getMarketSession,
  isMarketOpen
};
