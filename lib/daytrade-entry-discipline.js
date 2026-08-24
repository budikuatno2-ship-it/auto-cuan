'use strict';

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function firstFinite(row, keys) {
  for (const key of keys) {
    const n = finite(row && row[key]);
    if (n != null) return n;
  }
  return null;
}
/**
 * Pure no-pay-up guard. Uses the canonical entry zone already produced by the
 * screener; it never invents or recomputes a new entry price.
 */
function deriveDayTradeEntryDiscipline(row) {
  row = row || {};
  const entryLow = firstFinite(row, ['entry_low', 'entry1', 'entry_1']);
  const entryHigh = firstFinite(row, ['entry_high', 'entry2', 'entry_2']);
  const current = firstFinite(row, ['last_price', 'current_price', 'price', 'close']);
  const unverifiable = (reason) => ({
    entry_reference_price: entryHigh,
    entry_chase_pct: null,
    entry_discipline_status: 'ENTRY_UNVERIFIED',
    entry_discipline_label: 'Entry belum dapat diverifikasi',
    entry_executable_now: false,
    entry_discipline_reason: reason
  });
  if (entryLow == null || entryHigh == null || entryLow <= 0 || entryHigh <= 0 || entryHigh < entryLow) {
    return unverifiable('Canonical entry zone tidak lengkap atau tidak valid.');
  }
  if (current == null || current <= 0) {
    return unverifiable('Harga saat ini tidak tersedia untuk memverifikasi apakah entry masih valid.');
  }
  const chasePct = ((current - entryHigh) / entryHigh) * 100;
  if (current > entryHigh) {
    return {
      entry_reference_price: entryHigh,
      entry_chase_pct: chasePct,
      entry_discipline_status: 'WAIT_PULLBACK',
      entry_discipline_label: 'Wait pullback — jangan pay up',
      entry_executable_now: false,
      entry_discipline_reason: 'Harga saat ini sudah di atas batas atas canonical entry zone; jangan mengejar harga. Tunggu kembali ke area entry yang sudah ditentukan.'
    };
  }
  if (current >= entryLow) {
    return {
      entry_reference_price: entryHigh,
      entry_chase_pct: chasePct,
      entry_discipline_status: 'WITHIN_ENTRY_RANGE',
      entry_discipline_label: 'Dalam entry range',
      entry_executable_now: true,
      entry_discipline_reason: 'Harga saat ini masih berada di dalam canonical entry zone.'
    };
  }
  return {
    entry_reference_price: entryHigh,
    entry_chase_pct: chasePct,
    entry_discipline_status: 'AT_OR_BELOW_ENTRY',
    entry_discipline_label: 'Di bawah entry range',
    entry_executable_now: true,
    entry_discipline_reason: 'Harga belum melewati batas atas canonical entry zone; tidak ada pay-up.'
  };
}
function decorateDayTradeEntryDiscipline(row) {
  return Object.assign({}, row || {}, deriveDayTradeEntryDiscipline(row));
}
module.exports = { deriveDayTradeEntryDiscipline, decorateDayTradeEntryDiscipline };
