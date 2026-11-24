'use strict';

/**
 * lib/admin-ownership-import.js
 * ============================================================================
 * Engine Administrasi & Impor Data Pemegang Saham (Ownership Roster) dan Status HSC
 * Sesuai arahan V6:
 * - REQ-20: Rekonsiliasi Free Float IDX vs KSEI
 * - REQ-21/22: HSC State Neutrality (Unknown = "— / Belum dievaluasi", bukan otomatis "Tidak HSC")
 * - REQ-38: Detail Pemegang Saham (Shareholder Roster lengkap per emiten)
 * - REQ-39: Alur Admin Upload & Import (Preview -> Validasi -> Ringkasan -> Apply -> Idempotent -> Rollback)
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const OWNERSHIP_PATH = path.join(ROOT, 'data', 'insider-network', 'ownership_30sep2026.json');
const ROSTER_PATH = path.join(ROOT, 'data', 'insider-network', 'roster_30sep2026.json');
const HSC_OVERRIDES_PATH = path.join(ROOT, 'data', 'market-structure-manual-overrides.json');
const BACKUP_DIR = path.join(ROOT, 'data', 'backups', 'ownership');
const AUDIT_LOG_PATH = path.join(ROOT, 'data', 'security', 'ownership-audit.log.jsonl');

function ensureDirectories() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  const secDir = path.dirname(AUDIT_LOG_PATH);
  if (!fs.existsSync(secDir)) {
    fs.mkdirSync(secDir, { recursive: true });
  }
}

/**
 * Strip a recognized locale unit / suffix and return the numeric core.
 * Supports: percent (%), lot / lembar / saham / shares, multiplier (x / kali / T / M / B).
 * A trailing minus or en-dash means "none"/"unknown" and yields null downstream.
 */
function stripUnitSuffix(str) {
  let s = str;
  const units = [
    /\s*(?:lot|lembar|lbr|saham|shares?)\s*$/i,
    /\s*(?:x|kali)\s*$/i,
    /\s*%\s*$/,
    /\s*(?:triliun|trilion|T)\s*$/i,
    /\s*(?:miliar|billion|M)\s*$/i,
    /\s*(?:juta|million|juta)\s*$/i
  ];
  for (const re of units) {
    if (re.test(s)) { s = s.replace(re, '').trim(); break; }
  }
  return s;
}

/**
 * Parse Indonesian / standard numeric values safely.
 *
 * Locale rules (explicit, deterministic):
 *   - Multiple dots are ALWAYS thousand separators: "1.234.567" -> 1234567.
 *   - A single dot is ALWAYS a decimal point: "1.234" -> 1.234, "41.82" -> 41.82.
 *     A single ID-style thousand separator (e.g. "50.000" meaning 50000) is
 *     ambiguous with a decimal and is therefore NOT guessed: "50.000" -> 50 (the
 *     decimal reading) rather than silently inflating to 50000.
 *   - Comma-as-decimal Indonesian: "41,82" -> 41.82; mixed "1.234.567,89".
 *   - Recognized unit suffixes are stripped before numeric conversion.
 *
 * This function NEVER returns a guessed unit or locale: it returns the numeric
 * value, or `null` when the input is not a recognizable number.
 */
function parseIndonesianNumber(val) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  let str = stripUnitSuffix(String(val).trim());
  if (!str || str === '-' || str === '—' || str.toLowerCase() === 'n/a' || str.toLowerCase() === 'null') return null;

  const dots = (str.match(/\./g) || []).length;

  if (str.includes(',') && str.includes('.')) {
    if (str.indexOf('.') < str.indexOf(',')) {
      // Indonesian thousand dots + comma decimal: 1.234.567,89
      str = str.replace(/\./g, '').replace(',', '.');
    } else {
      // US thousand commas + dot decimal: 1,234,567.89
      str = str.replace(/,/g, '');
    }
  } else if (str.includes(',')) {
    // Indonesian decimal comma: 41,82 -> 41.82
    str = str.replace(',', '.');
  } else if (dots > 1) {
    // Indonesian thousand dots only: 1.234.567 -> 1234567
    str = str.replace(/\./g, '');
  }

  // Single dot retained as a decimal point (see locale contract above).

  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

/**
 * Normalize boolean for HSC.
 * Returns true, false, or null (unknown).
 *
 * The string "false" (and equivalents) MUST map to `false`, never to `true`
 * via the JS truthiness of a non-empty string.
 */
function parseHscBoolean(val) {
  if (val === true || val === false) return val;
  if (val === null || val === undefined || val === '') return null;
  const str = String(val).trim().toLowerCase();
  if (['1', 'true', 'ya', 'yes', 'hsc', 'aktif', 'high'].includes(str)) return true;
  if (['0', 'false', 'tidak', 'no', 'clear', 'tidak hsc', 'bukan'].includes(str)) return false;
  return null; // Unknown / belum dievaluasi
}

/**
 * Strict boolean coercion used for flags like `isController` / `pengendali`.
 * Unlike `Boolean('false') === true`, this maps string falsy values correctly.
 */
function parseBooleanStrict(val) {
  if (val === true) return true;
  if (val === false) return false;
  if (val === null || val === undefined || val === '') return false;
  const str = String(val).trim().toLowerCase();
  if (['1', 'true', 'ya', 'yes', 'y', 'pengendali', 'controller'].includes(str)) return true;
  if (['0', 'false', 'tidak', 'no', 'n', 'bukan', '-', '—'].includes(str)) return false;
  return false;
}

/**
 * Safe CSV row splitter considering quotes
 */
function parseCsvLines(csvText) {
  return String(csvText || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);
}
function parseCsvRow(line, delimiter = ',') {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      cells.push(current.trim().replace(/^"(.*)"$/, '$1').trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim().replace(/^"(.*)"$/, '$1').trim());
  return cells;
}

/**
 * Parse & Validate Ownership / Shareholder Roster payload
 */
function parseAndValidateOwnership(rawText, formatHint = 'auto') {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) {
    throw new Error('Data input kosong.');
  }

  const isJson = formatHint === 'json' || (formatHint === 'auto' && (trimmed.startsWith('[') || trimmed.startsWith('{')));
  const result = {
    type: 'OWNERSHIP_ROSTER',
    sha256: crypto.createHash('sha256').update(Buffer.from(trimmed)).digest('hex'),
    totalRows: 0,
    validRows: 0,
    invalidRows: 0,
    errors: [],
    tickers: [],
    parsedData: []
  };

  if (isJson) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`Format JSON tidak valid: ${e.message}`);
    }

    const items = Array.isArray(parsed) ? parsed : (parsed.data || parsed.rows || [parsed]);
    result.totalRows = items.length;

    const seenTickers = new Set();
    items.forEach((item, idx) => {
      const rowIdx = idx + 1;
      const ticker = String(item.ticker || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!ticker) {
        result.invalidRows++;
        result.errors.push({ row: rowIdx, error: 'Ticker kosong atau tidak valid' });
        return;
      }

      if (seenTickers.has(ticker)) {
        result.invalidRows++;
        result.errors.push({ row: rowIdx, ticker, error: `Ticker duplikat: ${ticker}` });
        return;
      }
      seenTickers.add(ticker);

      const freeFloatKsei = parseIndonesianNumber(item.free_float_ksei ?? item.freeFloatKsei ?? item.freeFloat);
      const freeFloatIdx = parseIndonesianNumber(item.free_float_idx ?? item.freeFloatIdx);
      const rawInvestors = Array.isArray(item.investors) ? item.investors : [];

      const cleanInvestors = [];
      let totalHoldingPct = 0;
      let hasInvestorError = false;

      rawInvestors.forEach((inv, invIdx) => {
        const invName = String(inv.investorName || inv.name || inv.investor_name || '').trim();
        if (!invName) {
          hasInvestorError = true;
          result.errors.push({ row: rowIdx, ticker, error: `Investor #${invIdx + 1} nama kosong` });
          return;
        }
        const shares = parseIndonesianNumber(inv.shares ?? inv.totalHoldingShare ?? inv.total_holding_shares);
        const percentage = parseIndonesianNumber(inv.percentage ?? inv.pct);
        if (percentage !== null && (percentage < 0 || percentage > 100)) {
          hasInvestorError = true;
          result.errors.push({ row: rowIdx, ticker, error: `Investor ${invName} persentase tidak valid: ${percentage}%` });
          return;
        }
        if (percentage !== null) totalHoldingPct += percentage;

        cleanInvestors.push({
          investorName: invName,
          investorType: inv.investorType || inv.category || 'Pemegang Saham',
          localForeign: inv.localForeign || (inv.nationality === 'foreign' ? 'F' : 'D'),
          domicile: inv.domicile || 'INDONESIA',
          totalHoldingShare: shares,
          shares: shares,
          percentage: percentage,
          // Boolean('false') would be `true`; use strict coercion so "false"/"0"
          // are never treated as a controller flag.
          isController: parseBooleanStrict(inv.isController ?? inv.pengendali) || (typeof inv.category === 'string' && inv.category.toLowerCase().includes('pengendali')),
          // Fail-closed provenance: a missing as_of stays null. Never stamp a
          // fabricated snapshot date onto a holder that did not carry one.
          asOf: inv.asOf || inv.as_of || item.as_of || null,
          source: inv.source || item.source || 'KSEI'
        });
      });

      if (hasInvestorError) {
        result.invalidRows++;
        return;
      }

      result.validRows++;
      result.tickers.push(ticker);
      result.parsedData.push({
        ticker,
        name: item.name || item.company_name || ('PT ' + ticker + ' Tbk'),
        sector: item.sector || 'Umum',
        investorCount: cleanInvestors.length,
        freeFloat: freeFloatKsei,
        freeFloatKsei: freeFloatKsei,
        freeFloatIdx: freeFloatIdx,
        freeFloatDiff: (freeFloatKsei !== null && freeFloatIdx !== null) ? Number((freeFloatKsei - freeFloatIdx).toFixed(2)) : null,
        reconciliationNote: item.reconciliationNote || item.free_float_reconciliation_note || null,
        // Fail-closed: no fabricated snapshot date when the source omits as_of.
        asOf: item.as_of || null,
        source: item.source || 'KSEI / IDX Keterbukaan',
        investors: cleanInvestors
      });
    });

  } else {
    // Parse CSV
    const lines = parseCsvLines(trimmed);
    if (lines.length < 2) {
      throw new Error('CSV minimal memiliki header dan satu baris data.');
    }

    const firstLine = lines[0];
    const delimiter = (firstLine.includes(';') && !firstLine.includes(',')) ? ';' : ',';
    const rawHeaders = parseCsvRow(firstLine, delimiter).map(h => h.toLowerCase().trim().replace(/[\s_-]+/g, ''));

    const tickerIdx = rawHeaders.findIndex(h => h === 'ticker' || h === 'kode' || h === 'emiten');
    const nameIdx = rawHeaders.findIndex(h => h === 'investorname' || h === 'namapemegangsaham' || h === 'investor' || h === 'nama');
    const sharesIdx = rawHeaders.findIndex(h => h === 'shares' || h === 'totalholdingshare' || h === 'lembarsaham' || h === 'jumlah');
    const pctIdx = rawHeaders.findIndex(h => h === 'percentage' || h === 'persen' || h === 'pct' || h === 'persentase');
    const catIdx = rawHeaders.findIndex(h => h === 'category' || h === 'tipe' || h === 'type' || h === 'kategori');
    const ctrlIdx = rawHeaders.findIndex(h => h === 'iscontroller' || h === 'pengendali');
    const asOfIdx = rawHeaders.findIndex(h => h === 'asof' || h === 'pertanggal' || h === 'tanggal');
    const srcIdx = rawHeaders.findIndex(h => h === 'source' || h === 'sumber');
    const ffKseiIdx = rawHeaders.findIndex(h => h === 'freefloatksei' || h === 'freefloat' || h === 'ffksei');
    const ffIdxIdx = rawHeaders.findIndex(h => h === 'freefloatidx' || h === 'ffidx');

    if (tickerIdx === -1 || nameIdx === -1) {
      throw new Error('CSV wajib memiliki kolom "ticker" dan "investor_name" / "nama".');
    }

    result.totalRows = lines.length - 1;
    const tickerMap = new Map();

    for (let i = 1; i < lines.length; i++) {
      const rowNum = i + 1;
      const cols = parseCsvRow(lines[i], delimiter);
      const rawTicker = cols[tickerIdx] || '';
      const ticker = rawTicker.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      const invName = (cols[nameIdx] || '').trim();

      if (!ticker || !invName) {
        result.invalidRows++;
        result.errors.push({ row: rowNum, error: 'Ticker atau nama pemegang saham kosong.' });
        continue;
      }

      const shares = sharesIdx !== -1 ? parseIndonesianNumber(cols[sharesIdx]) : null;
      const percentage = pctIdx !== -1 ? parseIndonesianNumber(cols[pctIdx]) : null;
      if (percentage !== null && (percentage < 0 || percentage > 100)) {
        result.invalidRows++;
        result.errors.push({ row: rowNum, ticker, error: `Persentase tidak valid: ${cols[pctIdx]}` });
        continue;
      }

      const cat = catIdx !== -1 ? (cols[catIdx] || 'Pemegang Saham') : 'Pemegang Saham';
      const isCtrl = ctrlIdx !== -1 ? (cols[ctrlIdx] === '1' || String(cols[ctrlIdx]).toLowerCase() === 'ya' || String(cols[ctrlIdx]).toLowerCase() === 'true') : false;
      // Fail-closed: a CSV row without an as_of column/value keeps asOf null
      // instead of silently defaulting to a fabricated 2026-09-30 snapshot.
      const asOf = asOfIdx !== -1 && cols[asOfIdx] ? cols[asOfIdx].trim() : null;
      const src = srcIdx !== -1 && cols[srcIdx] ? cols[srcIdx].trim() : 'KSEI';
      const ffKsei = ffKseiIdx !== -1 ? parseIndonesianNumber(cols[ffKseiIdx]) : null;
      const ffIdx = ffIdxIdx !== -1 ? parseIndonesianNumber(cols[ffIdxIdx]) : null;

      if (!tickerMap.has(ticker)) {
        tickerMap.set(ticker, {
          ticker,
          name: 'PT ' + ticker + ' Tbk',
          freeFloat: ffKsei,
          freeFloatKsei: ffKsei,
          freeFloatIdx: ffIdx,
          asOf,
          source: src,
          investors: []
        });
      }

      const entry = tickerMap.get(ticker);
      if (ffKsei !== null && entry.freeFloatKsei === null) entry.freeFloatKsei = ffKsei;
      if (ffIdx !== null && entry.freeFloatIdx === null) entry.freeFloatIdx = ffIdx;

      entry.investors.push({
        investorName: invName,
        investorType: cat,
        localForeign: 'D',
        domicile: 'INDONESIA',
        totalHoldingShare: shares,
        percentage,
        isController: isCtrl,
        asOf,
        source: src
      });
      result.validRows++;
    }

    result.parsedData = Array.from(tickerMap.values());
    result.tickers = Array.from(tickerMap.keys());
  }

  return result;
}

/**
 * Parse & Validate HSC Status and Free Float reconciliation table
 * Format supported:
 * 1. JSON Array:
 *    [{ "ticker": "BREN", "hsc_flag": true, "hsc_source": "IDX Peng-...", "hsc_as_of": "2026-09-30", "free_float_idx": 11.73, "free_float_ksei": 12.50 }]
 * 2. CSV format:
 *    ticker, hsc_flag, hsc_source, hsc_as_of, free_float_idx, free_float_ksei, note
 */
function parseAndValidateHscList(rawText, formatHint = 'auto') {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) {
    throw new Error('Data input kosong.');
  }

  const isJson = formatHint === 'json' || (formatHint === 'auto' && (trimmed.startsWith('[') || trimmed.startsWith('{')));
  const result = {
    type: 'HSC_STATUS_LIST',
    sha256: crypto.createHash('sha256').update(Buffer.from(trimmed)).digest('hex'),
    totalRows: 0,
    validRows: 0,
    invalidRows: 0,
    errors: [],
    parsedData: []
  };

  if (isJson) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`Format JSON tidak valid: ${e.message}`);
    }

    const items = Array.isArray(parsed) ? parsed : (parsed.rows || parsed.data || [parsed]);
    result.totalRows = items.length;

    const seenTickers = new Set();
    items.forEach((item, idx) => {
      const rowIdx = idx + 1;
      const ticker = String(item.ticker || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!ticker) {
        result.invalidRows++;
        result.errors.push({ row: rowIdx, error: 'Ticker kosong.' });
        return;
      }
      if (seenTickers.has(ticker)) {
        result.invalidRows++;
        result.errors.push({ row: rowIdx, ticker, error: `Ticker duplikat: ${ticker}` });
        return;
      }
      seenTickers.add(ticker);

      const hscFlag = parseHscBoolean(item.hsc_flag ?? item.hscFlag ?? item.is_hsc);
      const ffIdx = parseIndonesianNumber(item.free_float_idx ?? item.free_float_pct ?? item.freeFloatIdx);
      const ffKsei = parseIndonesianNumber(item.free_float_ksei ?? item.freeFloatKsei ?? item.freeFloat);

      result.validRows++;
      result.parsedData.push({
        ticker,
        hsc_flag: hscFlag, // true, false, or null (unknown)
        // Fail-closed provenance: an HSC verdict WITHOUT source/as_of must NOT
        // be stamped with a fabricated official source/date.
        hsc_source: item.hsc_source || item.hscSource || null,
        hsc_as_of: item.hsc_as_of || item.hscAsOf || null,
        free_float_idx: ffIdx,
        free_float_ksei: ffKsei,
        free_float_source: item.free_float_source || item.freeFloatSource || null,
        free_float_as_of: item.free_float_as_of || item.freeFloatAsOf || null,
        note: item.note || item.keterangan || null
      });
    });

  } else {
    // Parse CSV
    const lines = parseCsvLines(trimmed);
    if (lines.length < 2) {
      throw new Error('CSV minimal memiliki header dan satu baris data.');
    }
    const firstLine = lines[0];
    const delimiter = (firstLine.includes(';') && !firstLine.includes(',')) ? ';' : ',';
    const rawHeaders = parseCsvRow(firstLine, delimiter).map(h => h.toLowerCase().trim().replace(/[\s_-]+/g, ''));

    const tickerIdx = rawHeaders.findIndex(h => h === 'ticker' || h === 'kode' || h === 'emiten');
    const hscIdx = rawHeaders.findIndex(h => h === 'hscflag' || h === 'hsc' || h === 'ishsc' || h === 'statushsc');
    const hscSrcIdx = rawHeaders.findIndex(h => h === 'hscsource' || h === 'sumberhsc');
    const hscDateIdx = rawHeaders.findIndex(h => h === 'hscasof' || h === 'tanggalhsc');
    const ffIdxIdx = rawHeaders.findIndex(h => h === 'freefloatidx' || h === 'ffidx');
    const ffKseiIdx = rawHeaders.findIndex(h => h === 'freefloatksei' || h === 'ffksei' || h === 'freefloat');
    const noteIdx = rawHeaders.findIndex(h => h === 'note' || h === 'keterangan');

    if (tickerIdx === -1) {
      throw new Error('CSV wajib memiliki kolom "ticker".');
    }

    result.totalRows = lines.length - 1;
    const seen = new Set();

    for (let i = 1; i < lines.length; i++) {
      const rowNum = i + 1;
      const cols = parseCsvRow(lines[i], delimiter);
      const ticker = (cols[tickerIdx] || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!ticker) {
        result.invalidRows++;
        result.errors.push({ row: rowNum, error: 'Ticker kosong.' });
        continue;
      }
      if (seen.has(ticker)) {
        result.invalidRows++;
        result.errors.push({ row: rowNum, ticker, error: `Ticker duplikat: ${ticker}` });
        continue;
      }
      seen.add(ticker);

      const rawHsc = hscIdx !== -1 ? cols[hscIdx] : null;
      const hscFlag = parseHscBoolean(rawHsc);
      const ffIdx = ffIdxIdx !== -1 ? parseIndonesianNumber(cols[ffIdxIdx]) : null;
      const ffKsei = ffKseiIdx !== -1 ? parseIndonesianNumber(cols[ffKseiIdx]) : null;
      const hscSrc = hscSrcIdx !== -1 ? (cols[hscSrcIdx] || null) : null;
      const hscAsOf = hscDateIdx !== -1 ? (cols[hscDateIdx] || null) : null;
      const note = noteIdx !== -1 ? (cols[noteIdx] || null) : null;

      result.validRows++;
      result.parsedData.push({
        ticker,
        hsc_flag: hscFlag,
        hsc_source: hscSrc,
        hsc_as_of: hscAsOf,
        free_float_idx: ffIdx,
        free_float_ksei: ffKsei,
        free_float_source: null,
        free_float_as_of: null,
        note
      });
    }
  }

  return result;
}

/**
 * Compare incoming parsed data against existing dataset to generate summary diff:
 * - added: tickers newly introduced
 * - updated: tickers modified
 * - unchanged: tickers with identical values
 */
function computeDiffSummary(parsedResult) {
  ensureDirectories();
  let existingList = [];
  if (fs.existsSync(OWNERSHIP_PATH)) {
    try {
      existingList = JSON.parse(fs.readFileSync(OWNERSHIP_PATH, 'utf8')) || [];
    } catch (_) {}
  }
  const existingMap = new Map();
  existingList.forEach(item => existingMap.set(String(item.ticker).toUpperCase(), item));

  let added = 0;
  let updated = 0;
  let unchanged = 0;

  parsedResult.parsedData.forEach(item => {
    const existing = existingMap.get(item.ticker);
    if (!existing) {
      added++;
    } else {
      // Check if any significant fields differ
      let hasDiff = false;
      if (item.freeFloat != null && item.freeFloat !== existing.freeFloat) hasDiff = true;
      if (item.freeFloatIdx != null && item.freeFloatIdx !== existing.freeFloatIdx) hasDiff = true;
      if (item.freeFloatKsei != null && item.freeFloatKsei !== existing.freeFloatKsei) hasDiff = true;
      if (item.hsc_flag !== undefined && item.hsc_flag !== existing.hsc_flag) hasDiff = true;

      const incInvestors = item.investors || [];
      const curInvestors = existing.investors || [];
      if (incInvestors.length !== curInvestors.length && incInvestors.length > 0) {
        hasDiff = true;
      }

      if (hasDiff) {
        updated++;
      } else {
        unchanged++;
      }
    }
  });

  return {
    totalParsed: parsedResult.parsedData.length,
    validRows: parsedResult.validRows,
    invalidRows: parsedResult.invalidRows,
    added,
    updated,
    unchanged,
    errorCount: parsedResult.errors.length,
    errors: parsedResult.errors.slice(0, 50)
  };
}

/**
 * Perform Atomic Backup of active ownership & overrides data
 */
function createBackup(actor = 'admin') {
  ensureDirectories();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupId = `backup_${timestamp}_${crypto.randomBytes(4).toString('hex')}`;
  const backupFile = path.join(BACKUP_DIR, `${backupId}.json`);

  let ownershipData = null;
  let hscData = null;
  if (fs.existsSync(OWNERSHIP_PATH)) {
    try { ownershipData = JSON.parse(fs.readFileSync(OWNERSHIP_PATH, 'utf8')); } catch (_) {}
  }
  if (fs.existsSync(HSC_OVERRIDES_PATH)) {
    try { hscData = JSON.parse(fs.readFileSync(HSC_OVERRIDES_PATH, 'utf8')); } catch (_) {}
  }

  const payload = {
    backupId,
    timestamp: new Date().toISOString(),
    actor,
    ownershipCount: Array.isArray(ownershipData) ? ownershipData.length : 0,
    ownershipData,
    hscData
  };

  fs.writeFileSync(backupFile, JSON.stringify(payload, null, 2), 'utf8');
  return { backupId, backupFile, timestamp: payload.timestamp };
}

/**
 * Append audit log entry (chained JSONL)
 */
function appendAuditLog(entry) {
  ensureDirectories();
  const record = Object.assign({
    eventId: crypto.randomUUID(),
    timestampIso: new Date().toISOString(),
    processPid: process.pid
  }, entry);
  fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Apply parsed Ownership / HSC dataset to production files
 * Idempotent, creates backup first, logs audit trail, clears in-memory caches.
 */
function applyImport(parsedResult, actor = 'admin') {
  ensureDirectories();
  if (!parsedResult || !Array.isArray(parsedResult.parsedData) || parsedResult.parsedData.length === 0) {
    throw new Error('Tidak ada data valid yang dapat diterapkan.');
  }

  // 1. Create rollback backup snapshot
  const backup = createBackup(actor);

  // 2. Read existing ownership data
  let existingList = [];
  if (fs.existsSync(OWNERSHIP_PATH)) {
    try {
      existingList = JSON.parse(fs.readFileSync(OWNERSHIP_PATH, 'utf8')) || [];
    } catch (_) {}
  }

  const map = new Map();
  existingList.forEach(item => map.set(String(item.ticker).toUpperCase(), item));

  // Also read HSC overrides
  let hscOverrides = { schema_version: '1.0', rows: [] };
  if (fs.existsSync(HSC_OVERRIDES_PATH)) {
    try {
      hscOverrides = JSON.parse(fs.readFileSync(HSC_OVERRIDES_PATH, 'utf8')) || hscOverrides;
      if (!Array.isArray(hscOverrides.rows)) hscOverrides.rows = [];
    } catch (_) {}
  }
  const hscMap = new Map();
  hscOverrides.rows.forEach(r => hscMap.set(String(r.ticker).toUpperCase(), r));

  const touchedTickers = [];

  // 3. Merge incoming data
  parsedResult.parsedData.forEach(item => {
    const ticker = item.ticker;
    touchedTickers.push(ticker);
    let target = map.get(ticker);

    if (!target) {
      target = {
        ticker,
        name: item.name || ('PT ' + ticker + ' Tbk'),
        sector: item.sector || 'Umum',
        investorCount: (item.investors && item.investors.length) || 0,
        float: item.freeFloat != null ? Number((100 - item.freeFloat).toFixed(2)) : null,
        freeFloat: item.freeFloat,
        investors: []
      };
      map.set(ticker, target);
    }

    // Update fields
    if (item.name) target.name = item.name;
    if (item.sector) target.sector = item.sector;
    if (item.freeFloat != null) target.freeFloat = item.freeFloat;
    if (item.freeFloatKsei != null) target.freeFloatKsei = item.freeFloatKsei;
    if (item.freeFloatIdx != null) target.freeFloatIdx = item.freeFloatIdx;
    if (item.reconciliationNote) target.reconciliationNote = item.reconciliationNote;

    if (item.hsc_flag !== undefined) {
      target.hsc_flag = item.hsc_flag;
      target.hsc_source = item.hsc_source;
      target.hsc_as_of = item.hsc_as_of;

      // Update HSC overrides store
      let ov = hscMap.get(ticker);
      if (!ov) {
        ov = { ticker };
        hscOverrides.rows.push(ov);
        hscMap.set(ticker, ov);
      }
      ov.hsc_flag = item.hsc_flag;
      ov.hsc_source = item.hsc_source;
      ov.hsc_as_of = item.hsc_as_of;
      if (item.free_float_idx != null) ov.free_float_pct = item.free_float_idx;
      if (item.note) ov.note = item.note;
    }

    if (Array.isArray(item.investors) && item.investors.length > 0) {
      target.investors = item.investors;
      target.investorCount = item.investors.length;
    }
  });

  const updatedOwnershipList = Array.from(map.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));

  // 4. Write back atomic files
  fs.writeFileSync(OWNERSHIP_PATH, JSON.stringify(updatedOwnershipList, null, 2), 'utf8');
  fs.writeFileSync(HSC_OVERRIDES_PATH, JSON.stringify(hscOverrides, null, 2), 'utf8');

  // 5. Invalidate caches
  try {
    const strukturPasarApi = require('../api/struktur-pasar');
    if (typeof strukturPasarApi.invalidateCache === 'function') {
      strukturPasarApi.invalidateCache();
    }
  } catch (_) {}

  // 6. Record audit log
  appendAuditLog({
    action: 'APPLY_OWNERSHIP_IMPORT',
    actor,
    backupId: backup.backupId,
    fileSha256: parsedResult.sha256,
    importedTickersCount: touchedTickers.length,
    totalUniverseCount: updatedOwnershipList.length
  });

  return {
    success: true,
    backupId: backup.backupId,
    appliedTickers: touchedTickers.length,
    totalTickers: updatedOwnershipList.length
  };
}

/**
 * List available backups for rollback
 */
function listBackups() {
  ensureDirectories();
  if (!fs.existsSync(BACKUP_DIR)) return [];
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('backup_') && f.endsWith('.json'));
  files.sort().reverse();

  return files.slice(0, 30).map(file => {
    try {
      const full = path.join(BACKUP_DIR, file);
      const stat = fs.statSync(full);
      const content = JSON.parse(fs.readFileSync(full, 'utf8'));
      return {
        backupId: content.backupId || file.replace('.json', ''),
        filename: file,
        timestamp: content.timestamp || stat.mtime.toISOString(),
        actor: content.actor || 'unknown',
        ownershipCount: content.ownershipCount || 0,
        sizeBytes: stat.size
      };
    } catch (_) {
      return { backupId: file.replace('.json', ''), filename: file, error: 'File unreadable' };
    }
  });
}

/**
 * Rollback to a specific backup ID
 */
function rollbackToBackup(backupId, actor = 'admin') {
  ensureDirectories();
  const safeId = String(backupId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const backupFile = path.join(BACKUP_DIR, `${safeId}.json`);
  if (!fs.existsSync(backupFile)) {
    throw new Error(`Backup ID tidak ditemukan: ${safeId}`);
  }

  const payload = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  if (!payload || !Array.isArray(payload.ownershipData)) {
    throw new Error('Data backup korup atau tidak memiliki snapshot ownership yang valid.');
  }

  // Pre-rollback backup of current state
  const preRollback = createBackup(`pre-rollback-before-${safeId}`);

  // Restore files
  fs.writeFileSync(OWNERSHIP_PATH, JSON.stringify(payload.ownershipData, null, 2), 'utf8');
  if (payload.hscData) {
    fs.writeFileSync(HSC_OVERRIDES_PATH, JSON.stringify(payload.hscData, null, 2), 'utf8');
  }

  // Invalidate caches
  try {
    const strukturPasarApi = require('../api/struktur-pasar');
    if (typeof strukturPasarApi.invalidateCache === 'function') {
      strukturPasarApi.invalidateCache();
    }
  } catch (_) {}

  appendAuditLog({
    action: 'ROLLBACK_OWNERSHIP_DATASET',
    actor,
    restoredBackupId: safeId,
    safetyBackupId: preRollback.backupId,
    restoredCount: payload.ownershipData.length
  });

  return {
    success: true,
    restoredBackupId: safeId,
    safetyBackupId: preRollback.backupId,
    restoredCount: payload.ownershipData.length
  };
}

module.exports = {
  parseIndonesianNumber,
  parseHscBoolean,
  parseBooleanStrict,
  parseCsvLines,
  parseCsvRow,
  parseAndValidateOwnership,
  parseAndValidateHscList,
  computeDiffSummary,
  createBackup,
  applyImport,
  listBackups,
  rollbackToBackup,
  appendAuditLog
};
