'use strict';

// Versioned worksheet endpoints. The existing journal endpoints and stored
// records are deliberately left intact; Finance no longer renders that journal.
const Sheet = require('../public/money-sheet-model');
const Portfolio = require('../public/portfolio-command-center-model');
const { isSameOrigin } = require('./admin-session');
const ACTIONS = new Set(['get-sheet', 'save-sheet', 'portfolio-summary']);

function fail(res, status, code, error) { return res.status(status).json({ success: false, code, error }); }
function databaseFailure(res, error) {
  if (error && ['42703', 'PGRST204'].includes(error.code)) return fail(res, 503, 'SHEET_MIGRATION_REQUIRED', 'Penyimpanan lembar kerja belum siap. Jalankan migrasi money-sheet-v1 sebelum menyimpan.');
  return fail(res, 503, 'STORAGE_UNAVAILABLE', 'Penyimpanan belum tersedia. Perubahan Anda belum disimpan; coba kembali.');
}

async function handle({ req, res, supabase, user, action }) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  // Override the legacy wildcard. These endpoints carry personal financial data.
  if (typeof res.removeHeader === 'function') res.removeHeader('Access-Control-Allow-Origin');
  if (!user || !user.id) return fail(res, 401, 'UNAUTHORIZED', 'Silakan login kembali.');
  if (!isSameOrigin(req)) return fail(res, 403, 'ORIGIN_DENIED', 'Permintaan lintas situs ditolak.');
  if (req.method !== (action === 'save-sheet' ? 'POST' : 'GET')) return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan.');
  if (!supabase) return fail(res, 503, 'STORAGE_UNAVAILABLE', 'Database belum tersedia. Tidak ada data yang disimpan.');

  try {
    if (action === 'portfolio-summary') {
      const result = await supabase.from('app_user_portfolio_state').select('state, updated_at').eq('user_id', user.id).maybeSingle();
      if (result.error) return databaseFailure(res, result.error);
      if (!result.data) return res.status(200).json({ success: true, user_id: user.id, data: null });
      const state = result.data.state || {};
      // Same model as Portfolio, no second definition of exposure or P/L.
      const summary = Portfolio.summarize(state.plans, state.prices);
      return res.status(200).json({ success: true, user_id: user.id, data: { source: 'cloud', planCount: summary.planCount, totalExposureIdr: summary.totalExposureIdr, totalPnlIdr: summary.totalPnlIdr, missingPriceCount: summary.missingPriceCount, updated_at: result.data.updated_at, price_updated_at: state.price_updated_at || null } });
    }

    const input = action === 'save-sheet' ? (req.body || {}) : (req.query || {});
    const month = input.month || Sheet.currentMonth();
    if (!Sheet.validMonth(month)) return fail(res, 400, 'INVALID_MONTH', 'Bulan harus YYYY-MM (1900 sampai 2199).');

    if (action === 'get-sheet') {
      const result = await supabase.from('user_personal_cashflow').select('*, sheet_data, sheet_revision').eq('user_id', user.id).eq('month', month).maybeSingle();
      if (result.error) return databaseFailure(res, result.error);
      const row = result.data;
      let sheet;
      try { sheet = row && row.sheet_data != null ? Sheet.normalize(row.sheet_data) : Sheet.fromLegacy(row); }
      catch (_) { return fail(res, 422, 'LEGACY_DATA_REVIEW', 'Data lama tidak dapat dikonversi tanpa mengubah nominal. Data asli tetap utuh; tinjau sebelum migrasi.'); }
      return res.status(200).json({ success: true, user_id: user.id, data: { month, sheet, notes: row && row.notes || '', revision: row ? row.sheet_revision : null, updated_at: row && row.updated_at || null } });
    }

    let sheet, notes, expected;
    try {
      sheet = Sheet.normalize(input.sheet);
      notes = input.notes == null ? '' : input.notes;
      if (typeof notes !== 'string' || notes.length > 500) throw new Error('Catatan bulan maksimal 500 karakter.');
      expected = input.expected_revision;
      if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0 || expected >= 2147483647)) throw new Error('Revisi data tidak valid. Muat ulang lembar kerja.');
      if (!Object.prototype.hasOwnProperty.call(input, 'expected_revision')) throw new Error('Revisi wajib disertakan.');
    } catch (error) { return fail(res, 400, 'INVALID_SHEET', error.message); }
    const payload = Object.assign(Sheet.toLegacy(sheet), { sheet_data: sheet, sheet_revision: expected == null ? 1 : expected + 1, notes, updated_at: new Date().toISOString() });
    // CAS prevents two devices/tabs from silently overwriting one another.
    let result;
    if (expected === null) {
      result = await supabase.from('user_personal_cashflow').insert(Object.assign({ user_id: user.id, month }, payload)).select('sheet_revision, updated_at').single();
    } else {
      result = await supabase.from('user_personal_cashflow').update(payload).eq('user_id', user.id).eq('month', month).eq('sheet_revision', expected).select('sheet_revision, updated_at').maybeSingle();
    }
    if ((result.error && result.error.code === '23505') || (!result.error && !result.data)) return fail(res, 409, 'SHEET_CONFLICT', 'Lembar kerja berubah di tab/perangkat lain. Ekspor perubahan Anda, lalu muat ulang sebelum menggabungkannya.');
    if (result.error) return databaseFailure(res, result.error);
    return res.status(200).json({ success: true, user_id: user.id, data: { revision: result.data.sheet_revision, updated_at: result.data.updated_at } });
  } catch (_) { return fail(res, 503, 'STORAGE_UNAVAILABLE', 'Koneksi penyimpanan terputus. Perubahan Anda belum disimpan.'); }
}
module.exports = { ACTIONS, handle };
