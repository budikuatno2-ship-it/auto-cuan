'use strict';

/**
 * lib/ksei-ownership-store.js
 * ============================================================================
 * Durable owner-uploadable KSEI / Struktur Pasar JSON store.
 *
 * Allows Admin Console (Admin only, CSRF-checked) to upload updated KSEI
 * monthly JSON releases (e.g. 30 Okt 2026) safely:
 *   - Size guard up to 15 MB
 *   - Validates & normalizes multiple JSON shapes (issuer list, wrapped rows,
 *     or flat KSEI shareholder rows)
 *   - Creates timestamped backup under data/insider-network/backups/ before overwrite
 *   - Atomic write (tmp + renameSync) to ownership_active.json + ksei-active-meta.json
 *   - Falls back cleanly to ownership_30sep2026.json when no upload has replaced it
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const DEFAULT_ROOT = path.resolve(__dirname, '..');

function insiderDir(rootDir) {
  return path.join(rootDir || DEFAULT_ROOT, 'data', 'insider-network');
}

function activeFilePath(rootDir) {
  return path.join(insiderDir(rootDir), 'ownership_active.json');
}

function legacySepFilePath(rootDir) {
  return path.join(insiderDir(rootDir), 'ownership_30sep2026.json');
}

function metaFilePath(rootDir) {
  return path.join(insiderDir(rootDir), 'ksei-active-meta.json');
}

function parseLocaleNum(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  let s = String(val).trim().replace(/%/g, '').replace(/\s+/g, '');
  if (!s || s === '-' || s === '—') return null;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d+,\d+$/.test(s)) {
    s = s.replace(',', '.');
  } else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    s = s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  const raw = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(tmp, raw, 'utf8');
  fs.renameSync(tmp, filePath);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function normalizeInvestor(inv) {
  if (!inv || typeof inv !== 'object') return null;
  const investorName = String(
    inv.investorName || inv.investor_name || inv.name || inv.nama || inv.pemegang_saham || inv.holder || ''
  ).trim();
  if (!investorName) return null;
  const investorType = String(inv.investorType || inv.investor_type || inv.type || inv.jenis || inv.kategori || '').trim() || 'LAINNYA';
  const lfRaw = String(inv.localForeign || inv.local_foreign || inv.origin || inv.status || '').trim().toUpperCase();
  const localForeign = (lfRaw === 'F' || lfRaw === 'FOREIGN' || lfRaw === 'ASING' || lfRaw === 'A') ? 'F'
    : ((lfRaw === 'L' || lfRaw === 'LOCAL' || lfRaw === 'LOKAL') ? 'L' : (lfRaw || 'L'));
  const totalHoldingShare = parseLocaleNum(
    inv.totalHoldingShare != null ? inv.totalHoldingShare
      : (inv.total_holding_shares != null ? inv.total_holding_shares : (inv.shares != null ? inv.shares : inv.jumlah_saham))
  );
  const percentage = parseLocaleNum(
    inv.percentage != null ? inv.percentage
      : (inv.pct != null ? inv.pct : (inv.persentase != null ? inv.persentase : inv.porsi))
  );
  const change = parseLocaleNum(inv.change != null ? inv.change : inv.perubahan) || 0;
  return {
    investorName,
    investorType,
    localForeign,
    domicile: String(inv.domicile || inv.domisili || '').trim(),
    totalHoldingShare: totalHoldingShare != null ? Math.round(totalHoldingShare) : 0,
    percentage: percentage != null ? Number(percentage.toFixed(4)) : null,
    hasPrevData: inv.hasPrevData != null ? Boolean(inv.hasPrevData) : true,
    change
  };
}

function normalizeOwnershipPayload(rawPayload, opts = {}) {
  let rootObj = rawPayload;
  if (typeof rootObj === 'string') {
    if (Buffer.byteLength(rootObj, 'utf8') > MAX_UPLOAD_BYTES) {
      throw new Error('Ukuran file JSON melebihi batas maksimal 15 MB.');
    }
    try {
      rootObj = JSON.parse(rootObj);
    } catch (_) {
      throw new Error('File bukan JSON yang valid.');
    }
  }
  if (!rootObj || typeof rootObj !== 'object') {
    throw new Error('Struktur JSON kosong atau tidak dikenali.');
  }

  let asOf = opts.asOf || null;
  let source = opts.source || null;
  let rawItems = null;

  if (Array.isArray(rootObj)) {
    rawItems = rootObj;
  } else {
    asOf = asOf || rootObj.as_of || rootObj.asOf || rootObj.tanggal || rootObj.release_date || null;
    source = source || rootObj.source || rootObj.sumber || null;
    rawItems = rootObj.rows || rootObj.data || rootObj.emitens || rootObj.items || rootObj.records || rootObj.ownership;
  }

  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error('JSON harus berisi array emiten/pemegang saham yang tidak kosong.');
  }

  const byTicker = new Map();
  let shareholderRows = 0;

  for (const entry of rawItems) {
    if (!entry || typeof entry !== 'object') continue;
    const rawTicker = entry.ticker || entry.kode || entry.kode_efek || entry.code || entry.emiten || entry.stock_code;
    const ticker = String(rawTicker || '').trim().toUpperCase().replace(/\.JK$/i, '');
    if (!/^[A-Z0-9]{3,6}$/.test(ticker)) continue;

    const invListRaw = Array.isArray(entry.investors) ? entry.investors
      : (Array.isArray(entry.shareholders) ? entry.shareholders
        : (Array.isArray(entry.holders) ? entry.holders
          : (Array.isArray(entry.pemegang_saham) ? entry.pemegang_saham : null)));

    if (!byTicker.has(ticker)) {
      const ffRaw = parseLocaleNum(
        entry.freeFloat != null ? entry.freeFloat
          : (entry.free_float_pct != null ? entry.free_float_pct : (entry.freeFloatKsei != null ? entry.freeFloatKsei : entry.free_float))
      );
      const ffIdxRaw = parseLocaleNum(entry.freeFloatIdx != null ? entry.freeFloatIdx : ffRaw);
      byTicker.set(ticker, {
        ticker,
        name: String(entry.name || entry.company_name || entry.nama_emiten || ('PT ' + ticker + ' Tbk')).trim(),
        sector: String(entry.sector || entry.sektor || 'Umum').trim(),
        freeFloat: ffRaw != null ? Number(ffRaw.toFixed(2)) : null,
        freeFloatKsei: ffRaw != null ? Number(ffRaw.toFixed(2)) : null,
        freeFloatIdx: ffIdxRaw != null ? Number(ffIdxRaw.toFixed(2)) : null,
        hsc_flag: entry.hsc_flag === true ? true : (entry.hsc_flag === false ? false : null),
        hsc_source: entry.hsc_source || null,
        hsc_as_of: entry.hsc_as_of || (asOf && entry.hsc_flag != null ? asOf : null),
        as_of: entry.as_of || asOf || null,
        investors: []
      });
    }

    const bucket = byTicker.get(ticker);
    if (invListRaw) {
      for (const inv of invListRaw) {
        const norm = normalizeInvestor(inv);
        if (norm) {
          bucket.investors.push(norm);
          shareholderRows++;
        }
      }
    } else if (entry.investorName || entry.investor_name || entry.pemegang_saham || entry.holder || entry.nama_pemegang_saham) {
      const norm = normalizeInvestor({
        investorName: entry.investorName || entry.investor_name || entry.pemegang_saham || entry.holder || entry.nama_pemegang_saham,
        investorType: entry.investorType || entry.investor_type || entry.type || entry.jenis,
        localForeign: entry.localForeign || entry.local_foreign || entry.status,
        domicile: entry.domicile || entry.domisili,
        totalHoldingShare: entry.totalHoldingShare || entry.total_holding_shares || entry.shares || entry.jumlah_saham,
        percentage: entry.percentage || entry.pct || entry.persentase,
        change: entry.change
      });
      if (norm) {
        bucket.investors.push(norm);
        shareholderRows++;
      }
    }
  }

  const normalized = [...byTicker.values()];
  if (normalized.length === 0) {
    throw new Error('Tidak ditemukan kode saham IDX yang valid (4 huruf) dalam JSON.');
  }

  for (const item of normalized) {
    item.investors.sort((a, b) => (b.percentage || 0) - (a.percentage || 0) || (b.totalHoldingShare || 0) - (a.totalHoldingShare || 0));
  }

  return {
    items: normalized,
    tickerCount: normalized.length,
    shareholderRows,
    asOf: asOf || new Date().toISOString().slice(0, 10),
    source: source || 'KSEI Kepemilikan Efek (Upload Admin)'
  };
}

function getActiveOwnershipMeta(rootDir = DEFAULT_ROOT) {
  const mPath = metaFilePath(rootDir);
  if (fs.existsSync(mPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      if (m && typeof m === 'object') return m;
    } catch (_) {}
  }

  const sepPath = legacySepFilePath(rootDir);
  if (fs.existsSync(sepPath)) {
    try {
      const raw = fs.readFileSync(sepPath, 'utf8');
      const items = JSON.parse(raw);
      const count = Array.isArray(items) ? items.length : 0;
      const rows = Array.isArray(items)
        ? items.reduce((s, it) => s + (Array.isArray(it && it.investors) ? it.investors.length : 0), 0)
        : 0;
      return {
        active_file: 'ownership_30sep2026.json',
        as_of: '2026-09-30',
        source: 'KSEI 30 Sep 2026 (Baseline)',
        ticker_count: count,
        shareholder_rows: rows,
        sha256: crypto.createHash('sha256').update(raw).digest('hex'),
        uploaded_at: null,
        uploaded_by: 'baseline'
      };
    } catch (_) {}
  }

  return {
    active_file: null,
    as_of: null,
    source: null,
    ticker_count: 0,
    shareholder_rows: 0,
    sha256: null,
    uploaded_at: null,
    uploaded_by: null
  };
}

function loadActiveOwnership(rootDir = DEFAULT_ROOT) {
  const actPath = activeFilePath(rootDir);
  if (fs.existsSync(actPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(actPath, 'utf8'));
      if (Array.isArray(parsed) && parsed.length > 0) {
        return { items: parsed, meta: getActiveOwnershipMeta(rootDir) };
      }
    } catch (_) {}
  }
  const sepPath = legacySepFilePath(rootDir);
  if (fs.existsSync(sepPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(sepPath, 'utf8'));
      if (Array.isArray(parsed)) {
        return { items: parsed, meta: getActiveOwnershipMeta(rootDir) };
      }
    } catch (_) {}
  }
  return { items: [], meta: getActiveOwnershipMeta(rootDir) };
}

function saveUploadedOwnership(rawPayload, opts = {}, rootDir = DEFAULT_ROOT) {
  const normalized = normalizeOwnershipPayload(rawPayload, {
    asOf: opts.asOf || opts.as_of,
    source: opts.source
  });

  const dir = insiderDir(rootDir);
  const backupsDir = path.join(dir, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const currentActive = activeFilePath(rootDir);
  if (fs.existsSync(currentActive)) {
    fs.copyFileSync(currentActive, path.join(backupsDir, 'ownership_active_' + stamp + '.json'));
  }

  const sha256 = atomicWriteJson(currentActive, normalized.items);
  const meta = {
    active_file: 'ownership_active.json',
    filename: opts.filename ? String(opts.filename).slice(0, 140) : 'ksei_upload.json',
    as_of: normalized.asOf,
    source: normalized.source,
    ticker_count: normalized.tickerCount,
    shareholder_rows: normalized.shareholderRows,
    sha256,
    uploaded_at: new Date().toISOString(),
    uploaded_by: String(opts.uploadedBy || 'admin')
  };
  atomicWriteJson(metaFilePath(rootDir), meta);

  // Also sync baseline cache invalidation in consumers when running inside app
  if (rootDir === DEFAULT_ROOT) {
    try {
      const sp = require('../api/struktur-pasar');
      if (typeof sp.invalidateCache === 'function') sp.invalidateCache();
    } catch (_) {}
    try {
      const ins = require('./insider-network-service');
      if (typeof ins.invalidateSep2026Cache === 'function') ins.invalidateSep2026Cache();
    } catch (_) {}
  }

  return meta;
}

module.exports = {
  MAX_UPLOAD_BYTES,
  normalizeOwnershipPayload,
  getActiveOwnershipMeta,
  loadActiveOwnership,
  saveUploadedOwnership
};
