'use strict';

/**
 * Market Structure Risk v1
 *
 * Pure, fail-closed context builder for verified free-float and HSC inputs.
 *
 * Design rules:
 * - Never infer free float from "100 - top holders".
 * - Never treat missing HSC data as HSC=false.
 * - Free float / HSC are risk context, not an automatic buy/sell decision.
 * - The 15% threshold reflects the IDX Regulation I-A minimum that became
 *   effective 31 Mar 2026, with phased implementation for listed companies.
 */

const IDX_MIN_FREE_FLOAT_PCT = 15;

function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeFreeFloatPct(value) {
  const n = numOrNull(value);
  if (n === null || n < 0 || n > 100) return null;
  return Math.round(n * 10000) / 10000;
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (['true', 'yes', 'y', 'hsc', 'high', 'flagged'].includes(text)) return true;
  if (['false', 'no', 'n', 'clear', 'not_hsc', 'not-hsc'].includes(text)) return false;
  return null;
}

function buildMarketStructureContext(row) {
  row = row || {};

  const freeFloatPct = normalizeFreeFloatPct(
    row.free_float_pct != null ? row.free_float_pct : row.freeFloatPct
  );
  const hscFlag = normalizeBoolean(
    row.hsc_flag != null ? row.hsc_flag : row.hscFlag
  );

  const freeFloatSource = row.free_float_source || row.freeFloatSource || null;
  const freeFloatAsOf = row.free_float_as_of || row.freeFloatAsOf || null;
  const hscSource = row.hsc_source || row.hscSource || null;
  const hscAsOf = row.hsc_as_of || row.hscAsOf || null;

  const freeFloatAvailable = freeFloatPct !== null && !!freeFloatSource;
  const hscAvailable = hscFlag !== null && !!hscSource;

  let status = 'DATA_INCOMPLETE';
  let guard = 'UNKNOWN';
  let note = 'Data struktur kepemilikan belum lengkap; jangan menebak free float atau status HSC.';

  if (hscAvailable && hscFlag === true) {
    status = 'HIGH_SHAREHOLDING_CONCENTRATION';
    guard = 'CAUTION';
    note = 'HSC terverifikasi; konsentrasi kepemilikan tinggi perlu dipertimbangkan bersama likuiditas dan price action.';
  } else if (freeFloatAvailable && freeFloatPct < IDX_MIN_FREE_FLOAT_PCT) {
    status = 'BELOW_IDX_FREE_FLOAT_MINIMUM';
    guard = 'CAUTION';
    note = 'Free float terverifikasi di bawah 15%; perlakukan sebagai risiko struktur/likuiditas tambahan, bukan auto-reject.';
  } else if (freeFloatAvailable && hscAvailable && hscFlag === false) {
    status = 'STRUCTURE_VERIFIED';
    guard = 'NORMAL';
    note = 'Free float memenuhi ambang 15% dan snapshot HSC terverifikasi tidak flagged; likuiditas tetap harus dinilai terpisah.';
  } else if (freeFloatAvailable) {
    status = freeFloatPct >= IDX_MIN_FREE_FLOAT_PCT
      ? 'FREE_FLOAT_VERIFIED_HSC_UNKNOWN'
      : 'BELOW_IDX_FREE_FLOAT_MINIMUM';
    guard = freeFloatPct >= IDX_MIN_FREE_FLOAT_PCT ? 'UNKNOWN' : 'CAUTION';
    note = freeFloatPct >= IDX_MIN_FREE_FLOAT_PCT
      ? 'Free float terverifikasi memenuhi 15%, tetapi status HSC belum terverifikasi.'
      : 'Free float terverifikasi di bawah 15%; status HSC belum terverifikasi.';
  } else if (hscAvailable) {
    status = hscFlag ? 'HIGH_SHAREHOLDING_CONCENTRATION' : 'HSC_VERIFIED_FREE_FLOAT_UNKNOWN';
    guard = hscFlag ? 'CAUTION' : 'UNKNOWN';
    note = hscFlag
      ? 'HSC terverifikasi; free float belum tersedia.'
      : 'Snapshot HSC terverifikasi tidak flagged; free float belum tersedia.';
  }

  return {
    free_float_pct: freeFloatPct,
    free_float_source: freeFloatSource,
    free_float_as_of: freeFloatAsOf,
    free_float_available: freeFloatAvailable,
    hsc_flag: hscFlag,
    hsc_source: hscSource,
    hsc_as_of: hscAsOf,
    hsc_available: hscAvailable,
    idx_min_free_float_pct: IDX_MIN_FREE_FLOAT_PCT,
    below_idx_min_free_float: freeFloatAvailable ? freeFloatPct < IDX_MIN_FREE_FLOAT_PCT : null,
    market_structure_status: status,
    market_structure_guard: guard,
    market_structure_note: note,
    data_available: freeFloatAvailable || hscAvailable
  };
}

module.exports = {
  IDX_MIN_FREE_FLOAT_PCT,
  normalizeFreeFloatPct,
  normalizeBoolean,
  buildMarketStructureContext
};
