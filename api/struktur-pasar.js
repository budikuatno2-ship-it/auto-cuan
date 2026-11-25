'use strict';

/**
 * api/struktur-pasar.js
 * ============================================================================
 * Endpoint API Struktur Pasar & Kepemilikan KSEI Auto-Cuan V6
 * Menyajikan:
 * - Free float terevaluasi (KSEI & IDX Keterbukaan dengan rekonsiliasi eksplisit, REQ-20)
 * - Status HSC yang netral (Unknown = null / "— / Belum dievaluasi", bukan otomatis "Tidak HSC", REQ-21, REQ-22)
 * - Roster lengkap pemegang saham aktual (nama, lembar, %, status pengendali, as_of, sumber, REQ-38)
 * - Mendukung query filter by ticker: `/api/struktur-pasar?ticker=BBCA`
 * - Disajikan dari cache in-memory Buffer untuk waktu respon < 5 ms.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const kseiStore = require('../lib/ksei-ownership-store');
const OWNERSHIP_PATH = path.join(ROOT, 'data', 'insider-network', 'ownership_30sep2026.json');
const HSC_OVERRIDES_PATH = path.join(ROOT, 'data', 'market-structure-manual-overrides.json');

let _cachedStrukturPasar = null;
let _cachedBuffer = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 15 * 60 * 1000;

function invalidateCache() {
  _cachedStrukturPasar = null;
  _cachedBuffer = null;
  _cachedAt = 0;
}

/**
 * 13C: a valid as_of is a real ISO date (YYYY-MM-DD) or a parseable date
 * string. Anything else (null, '', '-', '—', 'unknown') is NOT a valid
 * provenance date and must fail closed.
 */
function isValidAsOf(value) {
  if (value == null) return false;
  const s = String(value).trim();
  if (!s || s === '-' || s === '—' || s.toLowerCase() === 'unknown' || s.toLowerCase() === 'n/a') return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return true;
  return Number.isFinite(Date.parse(s));
}

/**
 * 13C: PURE fail-closed HSC resolver. A verdict (true/false) that carries no
 * valid as_of degrades to UNKNOWN (null) with reason MISSING_AS_OF. A verdict
 * with a real as_of is preserved. Exported for direct unit testing so the
 * contract can be verified without touching the on-disk dataset.
 */
function resolveHscFailClosed(hscFlag, hscSource, hscAsOf) {
  let flag = (hscFlag === true) ? true : (hscFlag === false ? false : null);
  let source = hscSource || null;
  let asOf = hscAsOf || null;
  let reason = null;
  if (flag !== null && !isValidAsOf(asOf)) {
    flag = null;
    asOf = null;
    reason = 'MISSING_AS_OF';
  }
  return { flag, source, as_of: asOf, reason };
}

function loadHscOverrides() {
  const map = new Map();
  if (fs.existsSync(HSC_OVERRIDES_PATH)) {
    try {
      const content = JSON.parse(fs.readFileSync(HSC_OVERRIDES_PATH, 'utf8'));
      const rows = (content && Array.isArray(content.rows)) ? content.rows : [];
      rows.forEach(r => {
        if (r && r.ticker) {
          map.set(String(r.ticker).trim().toUpperCase(), r);
        }
      });
    } catch (_) {}
  }
  return map;
}

function buildStrukturPasarData() {
  const now = Date.now();
  if (_cachedStrukturPasar && _cachedBuffer && (now - _cachedAt < CACHE_TTL_MS)) {
    return { data: _cachedStrukturPasar, buffer: _cachedBuffer };
  }

  const loaded = kseiStore.loadActiveOwnership(ROOT);
  let list = Array.isArray(loaded.items) ? loaded.items.slice() : [];
  const activeAsOf = (loaded.meta && loaded.meta.as_of) || '2026-09-30';
  if (!list.length && fs.existsSync(OWNERSHIP_PATH)) {
    try { list = JSON.parse(fs.readFileSync(OWNERSHIP_PATH, 'utf8')) || []; } catch (_) {}
  }

  const hscOverridesMap = loadHscOverrides();

  // Ensure tickers from overrides (such as MSKY) are included if not present in primary snapshot
  const seenTickers = new Set(list.map(i => String(i.ticker).toUpperCase()));
  for (const [ovTicker, ov] of hscOverridesMap.entries()) {
    if (!seenTickers.has(ovTicker)) {
      seenTickers.add(ovTicker);
      list.push({
        ticker: ovTicker,
        name: ov.name || ('PT ' + ovTicker + ' Tbk'),
        sector: ov.sector || 'Umum',
        freeFloat: ov.free_float_pct != null ? Number(ov.free_float_pct) : null,
        freeFloatIdx: ov.free_float_pct != null ? Number(ov.free_float_pct) : null,
        investors: []
      });
    }
  }

  const formatted = list.map((item) => {
    const ticker = String(item.ticker || '').trim().toUpperCase();
    const ov = hscOverridesMap.get(ticker) || null;

    const hasOwnership = Array.isArray(item.investors) && item.investors.length > 0;
    const topInv = hasOwnership ? item.investors[0] : null;
    const pengendali = topInv
      ? `${topInv.investorName || topInv.name} (${Number(topInv.percentage || 0).toFixed(2)}%)`
      : 'Publik';

    // Free Float KSEI
    const rawFfKsei = item.freeFloatKsei != null ? item.freeFloatKsei : item.freeFloat;
    const ffKsei = rawFfKsei != null && Number.isFinite(Number(rawFfKsei)) ? Number(rawFfKsei) : null;

    // Free Float IDX (dari overrides resmi bursa jika ada)
    let ffIdx = item.freeFloatIdx != null && Number.isFinite(Number(item.freeFloatIdx))
      ? Number(item.freeFloatIdx)
      : null;
    let ffIdxAsOf = null;
    let ffIdxSource = null;
    if (ov && ov.free_float_pct != null) {
      ffIdx = Number(ov.free_float_pct);
      ffIdxAsOf = ov.free_float_as_of || null;
      ffIdxSource = ov.free_float_source || null;
    }

    // Rekonsiliasi REQ-20: Nilai efektif & diferensiasi sumber
    // Jangan menimpa salah satu; tampilkan keduanya jika berbeda
    const effectiveFf = ffKsei != null ? ffKsei : (ffIdx != null ? ffIdx : null);

    // HSC Status REQ-21 & REQ-22:
    // Status unknown HARUS null, BUKAN false. Jangan menurunkan status hanya dari free_float < 15%.
    let hscFlag = null;
    let hscSource = null;
    let hscAsOf = null;
    let hscReason = null;

    // Fail-closed REQUIRED: HSC verdict WITHOUT source/as_of must NOT receive a
    // fabricated official source/date. Show UNKNOWN ("— / Belum dievaluasi")
    // instead of a made-up "IDX Pengumuman Resmi" stamp.
    if (ov && ov.hsc_flag !== undefined && ov.hsc_flag !== null) {
      hscFlag = ov.hsc_flag === true;
      hscSource = ov.hsc_source || null;
      hscAsOf = ov.hsc_as_of || null;
    } else if (item.hsc_flag !== undefined && item.hsc_flag !== null) {
      hscFlag = item.hsc_flag === true;
      hscSource = item.hsc_source || null;
      hscAsOf = item.hsc_as_of || null;
    }

    // 13C FAIL-CLOSED PROVENANCE: an HSC verdict (true OR false) that carries no
    // valid as_of is NOT trustworthy — it must degrade to UNKNOWN with an
    // explicit reason code, never keep a verdict stamped with a fake date.
    {
      const resolved = resolveHscFailClosed(hscFlag, hscSource, hscAsOf);
      hscFlag = resolved.flag;
      hscSource = resolved.source;
      hscAsOf = resolved.as_of;
      hscReason = resolved.reason;
    }

    // Market structure risk guard (independen dari HSC)
    let guard = 'NORMAL';
    if (effectiveFf == null) {
      guard = 'UNKNOWN';
    } else if (hscFlag === true) {
      guard = 'HIGH_RISK';
    } else if (effectiveFf < 15) {
      guard = 'CAUTION'; // Free float < 15% adalah kewaspadaan likuiditas
    }

    // Normalize investors roster (REQ-38)
    const normalizedInvestors = (item.investors || []).map((inv, idx) => {
      const name = inv.investorName || inv.name || '-';
      const pct = inv.percentage != null && Number.isFinite(Number(inv.percentage))
        ? Number(inv.percentage)
        : null;
      const shares = inv.totalHoldingShare != null ? Number(inv.totalHoldingShare) : (inv.shares != null ? Number(inv.shares) : 0);
      const ctrlText = String(inv.isController ?? inv.pengendali ?? '').toLowerCase();
      const isCtrl = ctrlText === 'true' || ctrlText === '1' || ctrlText === 'ya' || ctrlText === 'yes'
        || (typeof inv.investorType === 'string' && inv.investorType.toLowerCase().includes('pengendali'))
        || (idx === 0 && pct && pct >= 50);

      return {
        no: idx + 1,
        ticker,
        investor_name: name,
        investorName: name,
        name,
        shares,
        percentage: pct,
        percentage_formatted: pct != null ? pct.toFixed(2) + '%' : '—',
        category: inv.investorType || inv.category || 'Pemegang Saham',
        investorType: inv.investorType || inv.category || 'Pemegang Saham',
        domicile: inv.domicile || 'INDONESIA',
        is_controller: isCtrl,
        isController: isCtrl,
        as_of: inv.asOf || inv.as_of || null,
        source: inv.source || null
      };
    });

    return {
      ticker,
      name: item.name || item.company_name || ticker,
      company_name: item.name || item.company_name || ticker,
      sector: item.sector || 'Umum',
      investorCount: normalizedInvestors.length,
      investor_count: normalizedInvestors.length,
      float: item.float != null ? Number(item.float) : (effectiveFf != null ? Number((100 - effectiveFf).toFixed(2)) : null),
      freeFloat: effectiveFf,
      free_float_pct: effectiveFf,
      // Rekonsiliasi eksplisit (REQ-20)
      free_float_ksei: ffKsei,
      free_float_idx: ffIdx,
      free_float_source: ffIdxSource || (ffKsei != null ? 'KSEI' : null),
      free_float_as_of: ffIdxAsOf || null,
      as_of_trade_date: null,
      reconciliation_note: item.reconciliationNote || (ffKsei !== null && ffIdx !== null && ffKsei !== ffIdx
        ? `Terdapat perbedaan metodologi pencatatan: KSEI mencatat porsi scripless publik ${ffKsei.toFixed(2)}%, sedangkan IDX menetapkan ${ffIdx.toFixed(2)}% berdasarkan Peraturan No. I-A.`
        : null),
      data_complete: effectiveFf != null && normalizedInvestors.length > 0,
      market_structure_guard: guard,
      // HSC State fail-closed (REQ-21, REQ-22)
      hsc_flag: hscFlag, // true = aktif, false = tidak terindikasi, null = belum dievaluasi
      hsc_source: hscSource,
      hsc_as_of: hscAsOf,
      // 13C: explicit reason when a verdict was withheld for missing provenance.
      hsc_reason: hscReason,
      hsc_status_text: hscFlag === true ? 'HSC Aktif' : (hscFlag === false ? 'Tidak HSC' : '— / Belum dievaluasi'),
      pengendali: pengendali,
      controller_name: pengendali,
      investors: normalizedInvestors
    };
  });

  _cachedStrukturPasar = {
    success: true,
    count: formatted.length,
    universe: formatted,
    rows: formatted,
    data: formatted,
    as_of: activeAsOf,
    source: (loaded.meta && loaded.meta.source) || 'KSEI'
  };
  _cachedBuffer = Buffer.from(JSON.stringify(_cachedStrukturPasar));
  _cachedAt = now;

  return { data: _cachedStrukturPasar, buffer: _cachedBuffer };
}

module.exports = async function handler(req, res) {
  try {
    const { data, buffer } = buildStrukturPasarData();

    // Query filter by ticker if requested
    const targetTicker = (req && req.query && req.query.ticker) ? String(req.query.ticker).trim().toUpperCase() : null;
    if (targetTicker) {
      const match = data.universe.find(u => u.ticker === targetTicker);
      if (!match) {
        if (res && typeof res.status === 'function') {
          return res.status(404).json({ success: false, error: `Emiten ${targetTicker} tidak ditemukan dalam struktur pasar.` });
        }
        return { success: false, error: 'Not found' };
      }
      const singlePayload = {
        success: true,
        ticker: targetTicker,
        emiten: match,
        roster: match.investors || [],
        roster_count: (match.investors || []).length,
        free_float_reconciliation: {
          effective_free_float_pct: match.free_float_pct,
          free_float_ksei: match.free_float_ksei,
          free_float_idx: match.free_float_idx,
          as_of: match.free_float_as_of,
          source: match.free_float_source,
          note: match.reconciliation_note
        },
        hsc_status: {
          flag: match.hsc_flag,
          status_text: match.hsc_status_text,
          source: match.hsc_source,
          as_of: match.hsc_as_of,
          reason: match.hsc_reason || null
        }
      };
      if (res && typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
        return res.status(200).json(singlePayload);
      }
      return singlePayload;
    }

    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
      res.end(buffer);
      return;
    }
    return data;
  } catch (err) {
    if (res && typeof res.status === 'function') {
      return res.status(500).json({ success: false, error: String((err && err.message) || err) });
    }
    throw err;
  }
};

// 13C: expose the pure fail-closed resolver + cache invalidation for tests.
module.exports.invalidateCache = invalidateCache;
module.exports.buildStrukturPasarData = buildStrukturPasarData;
module.exports.isValidAsOf = isValidAsOf;
module.exports.resolveHscFailClosed = resolveHscFailClosed;

module.exports.buildStrukturPasarData = buildStrukturPasarData;
module.exports.invalidateCache = invalidateCache;
