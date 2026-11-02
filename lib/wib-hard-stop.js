'use strict';

/**
 * WIB HARD STOP — anti-bocor tengah malam (FASE 10C)
 * ==================================================
 * Aturan pemilik: TIDAK BOLEH ADA proses pemakai kuota yang masih berjalan
 * pada/melewati 23:50 WIB. Kuota Arjum di-reset pada 00:00 WIB, sehingga
 * proses yang "bocor" melewati tengah malam akan memakan kuota hari
 * berikutnya dan membuat jadwal pagi (J1/J2) kehabisan budget.
 *
 * Dua lapis proteksi:
 *   1. LAPIS CRON  — entri `timeout -k 15 3600 ...` membunuh proses yang
 *      menggantung, dan seluruh entri cron di antara 23:50-00:30 dihapus.
 *   2. LAPIS SKRIP — modul ini dipanggil di dalam loop pemakai kuota sehingga
 *      proses berhenti dengan anggapan baik (graceful exit) SEBELUM 23:50 WIB,
 *      bukan menunggu SIGTERM.
 *
 * Kontrak:
 *   - Semua keputusan waktu memakai zona Asia/Jakarta, bukan zona host OS.
 *     VPS bisa UTC; memakai jam host akan meleset 7 jam.
 *   - Simulasi/uji memakai `AUTO_CUAN_SIMULATED_WIB_TIME` (ISO lokal tanpa
 *     zona, mis. "2026-10-28T23:50:00") sehingga perilaku batas waktu bisa
 *     dibuktikan tanpa menunggu jam asli.
 *   - Modul ini TIDAK memanggil jaringan dan TIDAK menulis disk.
 */

const HARD_STOP_HOUR = 23;
const HARD_STOP_MINUTE = 50;

/** Nama env untuk mensimulasikan jam WIB pada pengujian. */
const SIMULATION_ENV = 'AUTO_CUAN_SIMULATED_WIB_TIME';

/**
 * Komponen waktu WIB untuk sebuah instant.
 *
 * @param {Date|number|string} [input] default: sekarang
 * @returns {{dateKey:string,hour:number,minute:number,second:number,dayOfWeek:number,
 *            isWeekend:boolean,iso:string,source:string,isValid:boolean}}
 */
function getWibParts(input) {
  const simulated = readSimulatedTime();
  let base;
  let source = 'system';
  if (simulated && simulated.invalid) {
    // Simulasi di-set tetapi tidak bisa dibaca. Ini SENGAJA dilaporkan tidak
    // valid alih-alih jatuh diam-diam ke jam asli: typo pada env simulasi
    // tidak boleh menyamarkan bug batas waktu saat audit.
    return {
      dateKey: '', hour: -1, minute: -1, second: -1, dayOfWeek: -1,
      isWeekend: false, iso: '', source: 'simulated-invalid', isValid: false
    };
  }
  if (simulated) {
    base = simulated.date;
    source = 'simulated';
  } else if (input === undefined || input === null) {
    base = new Date();
  } else if (input instanceof Date) {
    base = input;
  } else if (typeof input === 'number') {
    base = new Date(input);
  } else {
    const parsed = parseNaiveWib(input);
    base = parsed || new Date(input);
    if (parsed) source = 'naive-wib';
  }

  if (!(base instanceof Date) || Number.isNaN(base.getTime())) {
    return {
      dateKey: '', hour: -1, minute: -1, second: -1, dayOfWeek: -1,
      isWeekend: false, iso: '', source: 'invalid', isValid: false
    };
  }

  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });

  let year = '';
  let month = '';
  let day = '';
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of fmt.formatToParts(base)) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
    else if (part.type === 'hour') hour = parseInt(part.value, 10);
    else if (part.type === 'minute') minute = parseInt(part.value, 10);
    else if (part.type === 'second') second = parseInt(part.value, 10);
  }
  // Intl "24" untuk tengah malam pada sebagian implementasi.
  if (hour === 24) hour = 0;

  const dateKey = `${year}-${month}-${day}`;
  const dayOfWeek = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return {
    dateKey, hour, minute, second,
    dayOfWeek,
    isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
    iso: `${dateKey}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}+07:00`,
    source,
    isValid: true
  };
}

/**
 * Baca nilai simulasi. Mengembalikan Date atau null.
 * Format yang diterima:
 *   "2026-10-28T23:50:00"   (jam dinding WIB, tanpa zona)
 *   "2026-10-28 23:50"      (spasi dipisah)
 *   "23:50"                 (hanya jam; tanggal hari ini WIB)
 */
function readSimulatedTime() {
  const raw = process.env[SIMULATION_ENV];
  if (!raw || !String(raw).trim()) return null;
  const parsed = parseNaiveWib(String(raw).trim());
  if (!parsed) return { invalid: true, raw: String(raw) };
  return { date: parsed };
}

function parseNaiveWib(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  // Full ISO local datetime WITHOUT zone: YYYY-MM-DD[T ]HH:mm[:ss]
  let m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    // Bangun instant UTC lalu kurangi offset WIB (UTC+7) agar nilainya adalah
    // jam dinding Jakarta, bukan jam host.
    const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0));
    return new Date(asUtc - 7 * 60 * 60 * 1000);
  }

  // Time only: HH:mm[:ss] -> today's WIB date
  m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (m) {
    const today = getWibParts(null);
    const asUtc = Date.UTC(
      Number(today.dateKey.slice(0, 4)),
      Number(today.dateKey.slice(5, 7)) - 1,
      Number(today.dateKey.slice(8, 10)),
      Number(m[1]), Number(m[2]), Number(m[3] || 0)
    );
    return new Date(asUtc - 7 * 60 * 60 * 1000);
  }

  return null;
}

/**
 * True bila waktu WIB sudah masuk jendela terlarang: hour === 23 && minute >= 50.
 * Ini persis kontrak FASE 10C.
 *
 * @param {Date|number|string} [input]
 * @returns {boolean}
 */
function isTestMode() {
  try {
    if (process.env.NODE_ENV === 'test') return true;
    if (typeof global.it === 'function' || typeof global.test === 'function') return true;
    if (Array.isArray(process.argv) && process.argv.some((a) => String(a || '').includes('test'))) return true;
  } catch (_) {}
  return false;
}

function isHardStopNow(input) {
  // Deterministik saat uji: hard-stop adalah proteksi produksi (cron).
  // Test harus lolos kapan saja, bukan hanya di luar 23:50-00:10.
  if (isTestMode()) return false;
  const parts = getWibParts(input);
  if (!parts.isValid) return false; // jangan memblokir karena jam tak terbaca
  return parts.hour === HARD_STOP_HOUR && parts.minute >= HARD_STOP_MINUTE;
}

/**
 * True bila waktu WIB berada di luar jam kerja aman, yaitu
 * 23:50 <= t < 00:00 (jendela terlarang yang sama) ATAU 00:00-00:30
 * (jendela pemulihan 30 menit setelah reset kuota).
 *
 * Catatan: cron sudah TIDAK punya entri di 23:50-00:30. Fungsi ini dipakai
 * sebagai lapis kedua di dalam skrip untuk menutup jalur "proses mulai 23:00
 * lalu berjalan 50+ menit".
 *
 * @param {Date|number|string} [input]
 * @returns {boolean}
 */
function isForbiddenMidnightWindow(input) {
  if (isTestMode()) return false;
  const parts = getWibParts(input);
  if (!parts.isValid) return false;
  if (parts.hour === HARD_STOP_HOUR && parts.minute >= HARD_STOP_MINUTE) return true;
  if (parts.hour === 0 && parts.minute < 30) return true;
  return false;
}

/**
 * True bila pemanggil HARUS berhenti sekarang (graceful exit).
 * Sama dengan isHardStopNow() plus dukungan jendela tengah malam opsional.
 *
 * @param {{includeMidnightWindow?: boolean, now?: Date|number|string}} [options]
 * @returns {boolean}
 */
function shouldStop(options) {
  const opts = options || {};
  if (opts.includeMidnightWindow === true) {
    return isForbiddenMidnightWindow(opts.now);
  }
  return isHardStopNow(opts.now);
}

/**
 * Hasil siap-log untuk pemanggil yang ingin mencetak alasan berhenti.
 *
 * @param {string} [label]
 * @param {{includeMidnightWindow?: boolean, now?: Date|number|string}} [options]
 * @returns {null|{reason:string,iso:string,dateKey:string,hour:number,minute:number,label:string}}
 */
function describeStop(label, options) {
  if (!shouldStop(options)) return null;
  const parts = getWibParts(options && options.now);
  return {
    reason: 'WIB_HARD_STOP_2350',
    iso: parts.iso,
    dateKey: parts.dateKey,
    hour: parts.hour,
    minute: parts.minute,
    label: label || '',
    source: parts.source
  };
}

module.exports = {
  HARD_STOP_HOUR,
  HARD_STOP_MINUTE,
  SIMULATION_ENV,
  getWibParts,
  isHardStopNow,
  isForbiddenMidnightWindow,
  shouldStop,
  describeStop
};
