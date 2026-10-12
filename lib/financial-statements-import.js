'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Normalizes numbers safely.
 */
function numOrNull(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extracts a numeric value from nested objects given multiple possible property paths.
 */
function extractFirstNumber(obj, paths) {
  if (!obj || typeof obj !== 'object') return null;
  for (const p of paths) {
    const parts = Array.isArray(p) ? p : p.split('.');
    let curr = obj;
    let found = true;
    for (const key of parts) {
      if (curr && typeof curr === 'object' && key in curr) {
        curr = curr[key];
      } else {
        found = false;
        break;
      }
    }
    if (found) {
      const num = numOrNull(curr);
      if (num != null) return num;
    }
  }
  return null;
}

/**
 * Formats a raw IDR value into Miliar IDR (dividing by 1e9).
 * E.g. Rp 50.000.000 -> 0.05 Miliar IDR.
 * E.g. Rp 281.687.555.000.000 -> 281687.56 Miliar IDR.
 */
function toMiliarIdr(rawVal) {
  const n = numOrNull(rawVal);
  if (n == null) return null;
  return Math.round((n / 1e9) * 100) / 100;
}

/**
 * Normalizes date-only (YYYY-MM-DD) or ISO timestamp into numeric epoch milliseconds (UTC).
 * Returns null if value is missing, empty, or unparseable.
 */
function parseDateToEpoch(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Pattern 1: Date-only YYYY-MM-DD (normalized to UTC midnight 00:00:00.000Z)
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const month = Number(dateOnlyMatch[2]) - 1;
    const day = Number(dateOnlyMatch[3]);
    const d = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
    if (d.getUTCFullYear() === year && d.getUTCMonth() === month && d.getUTCDate() === day) {
      return d.getTime();
    }
    return null;
  }

  // Pattern 2: ISO timestamp with timezone or offset (e.g. 2026-10-05T14:00:00Z, 2026-10-05T20:00:00+07:00)
  if (/^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i.test(trimmed)) {
    const epoch = Date.parse(trimmed);
    return Number.isFinite(epoch) ? epoch : null;
  }

  return null;
}

/**
 * Validates ISO date or timestamp string (YYYY-MM-DD or ISO 8601).
 */
function isValidDateString(d) {
  return parseDateToEpoch(d) != null;
}

/**
 * Determines whether incoming data may overwrite existing data according to numeric time provenance.
 * - Parses and normalizes all timestamps to UTC epoch milliseconds before comparison.
 * - Fail-closed: If existing data has a valid verified date, undated or invalid incoming data
 *   is strictly rejected and cannot overwrite it.
 */
function canUpdateProvenance(existingDate, incomingDate) {
  const existingEpoch = parseDateToEpoch(existingDate);
  const incomingEpoch = parseDateToEpoch(incomingDate);

  // If existing record has no verified date, incoming is allowed (upgrades unverified data)
  if (existingEpoch == null) {
    return true;
  }

  // Fail-closed: incoming has no parseable date; cannot overwrite verified dated record
  if (incomingEpoch == null) {
    return false;
  }

  // Both have valid dates: compare numerically by epoch ms (UTC)
  return incomingEpoch >= existingEpoch;
}

/**
 * Helper to parse a statement period string into a numeric sortable score.
 * E.g. 'Q1 2026' -> 20261, 'Q2 2026' -> 20262, 'FY 2025' -> 20254
 */
function parsePeriodScore(periodStr) {
  if (!periodStr || typeof periodStr !== 'string') return null;
  const match = /(?:(Q[1-4])\s*(\d{4})|(\d{4})\s*(Q[1-4])|FY\s*(\d{4})|(\d{4}))/i.exec(periodStr.trim());
  if (!match) return null;
  const qStr = (match[1] || match[4] || '').toUpperCase();
  const yearStr = match[2] || match[3] || match[5] || match[6];
  const year = Number(yearStr);
  if (!Number.isFinite(year)) return null;
  let qNum = 4;
  if (qStr === 'Q1') qNum = 1;
  else if (qStr === 'Q2') qNum = 2;
  else if (qStr === 'Q3') qNum = 3;
  else if (qStr === 'Q4') qNum = 4;
  return year * 10 + qNum;
}

/**
 * Evaluates whether incoming financial statements may overwrite existing statements.
 * - Uses source collection timestamp (collected_at), NEVER the local DB write timestamp (updated_at).
 * - For legacy records without collected_at: new reports with genuine collected_at are welcomed.
 * - When both lack collected_at: compares statement periods (e.g. Q2 2026 >= Q1 2026).
 * - Fail-closed: undated incoming data cannot overwrite a verified collected_at record.
 */
function canUpdateStatementsProvenance(current, parsedStatements) {
  if (!parsedStatements) return false;
  if (!current || !current.financial_statements) return true;

  const existingFs = current.financial_statements;
  const existingCollectedAt = existingFs.collected_at || null;
  const incomingCollectedAt = parsedStatements.collected_at || null;

  const existingEpoch = parseDateToEpoch(existingCollectedAt);
  const incomingEpoch = parseDateToEpoch(incomingCollectedAt);

  // 1. Existing record has verified source collected_at
  if (existingEpoch != null) {
    if (incomingEpoch == null) return false; // Fail-closed: undated incoming rejected
    return incomingEpoch >= existingEpoch;
  }

  // 2. Existing record is a legacy row without collected_at: incoming with genuine collected_at upgrades it
  if (incomingEpoch != null) {
    return true;
  }

  // 3. Neither has source collected_at: compare statement periods
  const existingPeriod = current.fundamental_period || existingFs.period || null;
  const incomingPeriod = parsedStatements.fundamental_period || null;
  const existingScore = parsePeriodScore(existingPeriod);
  const incomingScore = parsePeriodScore(incomingPeriod);

  if (existingScore != null && incomingScore != null) {
    return incomingScore >= existingScore;
  }
  if (existingScore != null && incomingScore == null) {
    return false;
  }

  return true;
}

/**
 * Reads and parses JSON file if exists, returning null otherwise.
 */
function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (_) {
    return null;
  }
}

/**
 * Loads market cap batch files from directory.
 * Returns Map<ticker, { ticker, listed_shares, market_cap, close, date }>
 */
function loadMarketCapData(marketCapDir) {
  const resultMap = new Map();
  if (!marketCapDir || !fs.existsSync(marketCapDir)) return resultMap;

  const files = fs.readdirSync(marketCapDir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const fullPath = path.join(marketCapDir, file);
    const json = readJsonSafe(fullPath);
    if (!json) continue;

    const date = json.date || (json.data && json.data.date) || null;
    const items = Array.isArray(json)
      ? json
      : Array.isArray(json.items)
      ? json.items
      : Array.isArray(json.data)
      ? json.data
      : (json.data && Array.isArray(json.data.data))
      ? json.data.data
      : (json.data && Array.isArray(json.data.items))
      ? json.data.items
      : [];

    for (const item of items) {
      const tickerRaw = item.ticker || item.stock_code || item.code;
      if (!tickerRaw) continue;
      const ticker = String(tickerRaw).trim().toUpperCase().replace(/\.JK$/, '');
      const listedShares = numOrNull(item.listed_shares || item.shares_outstanding || item.shares);
      const marketCap = numOrNull(item.market_cap || item.marketCap);
      const close = numOrNull(item.close || item.price || item.last_price);

      const rawDate = item.date || date || null;
      const validDate = isValidDateString(rawDate) ? rawDate.trim() : null;

      const candidate = {
        ticker,
        listed_shares: listedShares,
        market_cap: marketCap,
        close,
        date: validDate
      };

      if (!resultMap.has(ticker)) {
        resultMap.set(ticker, candidate);
      } else {
        // Duplicate ticker in batch files:
        // Select snapshot strictly based on valid source date, never file read order.
        const existing = resultMap.get(ticker);
        if (canUpdateProvenance(existing.date, candidate.date)) {
          // If candidate is newer or existing had no valid date, use candidate
          resultMap.set(ticker, candidate);
        }
      }
    }
  }

  return resultMap;
}

/**
 * Parses a single statement JSON file (Arjum format).
 */
function parseStatementFile(filePath) {
  const json = readJsonSafe(filePath);
  if (!json) return null;
  const data = json.data || json;
  const items = Array.isArray(data.items) ? data.items : [];
  return {
    ticker: json.ticker || data.stock_code || null,
    report_type: json.report_type || data.report_type || null,
    period: json.period || data.period || null,
    collected_at: json.collected_at || null,
    items
  };
}

/**
 * Extracts and organizes financial statements for a ticker from a directory.
 */
function parseTickerStatements(tickerDir, tickerCode) {
  if (!tickerDir || !fs.existsSync(tickerDir)) return null;

  const ticker = String(tickerCode || path.basename(tickerDir)).trim().toUpperCase();

  // File variations
  const bsQuarterly = parseStatementFile(path.join(tickerDir, 'BALANCE_SHEET-quarterly.json'));
  const bsAnnual = parseStatementFile(path.join(tickerDir, 'BALANCE_SHEET-annual.json')) ||
                   parseStatementFile(path.join(tickerDir, 'BALANCE_SHEET-annually.json'));

  const isQuarterly = parseStatementFile(path.join(tickerDir, 'INCOME_STATEMENT-quarterly.json'));
  const isAnnual = parseStatementFile(path.join(tickerDir, 'INCOME_STATEMENT-annual.json')) ||
                   parseStatementFile(path.join(tickerDir, 'INCOME_STATEMENT-annually.json'));

  const cfQuarterly = parseStatementFile(path.join(tickerDir, 'CASH_FLOW_REPORT-quarterly.json'));
  const cfAnnual = parseStatementFile(path.join(tickerDir, 'CASH_FLOW_REPORT-annual.json')) ||
                   parseStatementFile(path.join(tickerDir, 'CASH_FLOW_REPORT-annually.json'));

  if (!bsQuarterly && !bsAnnual && !isQuarterly && !isAnnual && !cfQuarterly && !cfAnnual) {
    return null;
  }

  function buildPeriodStatement(bs, inc, cf, modeLabel) {
    // Gather periods
    const periodSet = new Set();
    [bs, inc, cf].forEach((stmt) => {
      if (stmt && Array.isArray(stmt.items)) {
        stmt.items.forEach((item) => {
          if (item && item.label) periodSet.add(item.label);
        });
      }
    });

    const periods = Array.from(periodSet);
    if (!periods.length) return null;

    // Helper to map period label to item.data
    function createMap(stmt) {
      const map = new Map();
      if (stmt && Array.isArray(stmt.items)) {
        stmt.items.forEach((item) => {
          if (item && item.label) map.set(item.label, item);
        });
      }
      return map;
    }

    const bsMap = createMap(bs);
    const incMap = createMap(inc);
    const cfMap = createMap(cf);

    // 1. Income Statement
    const incRows = [
      { type: 'group', label: 'Pendapatan & Beban Usaha' },
      {
        type: 'item',
        label: 'Pendapatan Usaha',
        unit: 'idr',
        values: periods.map((p) => {
          const it = incMap.get(p);
          const raw = it && extractFirstNumber(it.data, [
            'pendapatan.pendapatan',
            'penjualan_dan_pendapatan_usaha',
            'pendapatan_bunga_bersih',
            'pendapatan_bersih',
            'total_revenue',
            'revenue'
          ]);
          return toMiliarIdr(raw);
        })
      },
      {
        type: 'item',
        label: 'Beban Usaha / Beban Pokok',
        unit: 'idr',
        values: periods.map((p) => {
          const it = incMap.get(p);
          const raw = it && extractFirstNumber(it.data, [
            'beban_pokok_pendapatan',
            'beban_usaha',
            'beban_operasional_lainnya',
            'operating_expense'
          ]);
          return raw != null ? toMiliarIdr(-Math.abs(raw)) : null;
        })
      },
      {
        type: 'total',
        label: 'Laba Usaha / Operasional',
        unit: 'idr',
        values: periods.map((p) => {
          const it = incMap.get(p);
          const raw = it && extractFirstNumber(it.data, [
            'laba_rugi_usaha',
            'laba_usaha',
            'laba_operasional',
            'operating_income'
          ]);
          return toMiliarIdr(raw);
        })
      },
      { type: 'group', label: 'Laba Bersih & Pajak' },
      {
        type: 'item',
        label: 'Beban Pajak Penghasilan',
        unit: 'idr',
        values: periods.map((p) => {
          const it = incMap.get(p);
          const raw = it && extractFirstNumber(it.data, [
            'manfaat_beban_pajak_penghasilan',
            'beban_pajak',
            'tax_expense'
          ]);
          return raw != null ? toMiliarIdr(-Math.abs(raw)) : null;
        })
      },
      {
        type: 'total',
        label: 'Laba Bersih Periode Berjalan',
        unit: 'idr',
        values: periods.map((p) => {
          const it = incMap.get(p);
          const raw = it && extractFirstNumber(it.data, [
            'laba_rugi_periode_berjalan',
            'laba_bersih',
            'laba_rugi_bersih',
            'net_income'
          ]);
          return toMiliarIdr(raw);
        })
      },
      {
        type: 'item',
        label: 'Laba per Saham (EPS) - IDR',
        unit: 'number',
        values: periods.map((p) => {
          const it = incMap.get(p);
          const raw = it && extractFirstNumber(it.data, [
            'laba_rugi_per_saham.dasar',
            'laba_rugi_per_saham',
            'laba_per_saham',
            'eps'
          ]);
          return raw != null ? Math.round(raw * 100) / 100 : null;
        })
      }
    ];

    // 2. Balance Sheet
    const bsRows = [
      { type: 'group', label: 'Aset' },
      {
        type: 'item',
        label: 'Kas & Setara Kas',
        unit: 'idr',
        values: periods.map((p) => {
          const it = bsMap.get(p);
          const raw = it && extractFirstNumber(it.data, [
            'aset.aset_lancar.kas_dan_setara_kas',
            'aset_lancar.kas_dan_setara_kas',
            'kas_dan_setara_kas',
            'cash_and_equivalents'
          ]);
          return toMiliarIdr(raw);
        })
      },
      {
        type: 'item',
        label: 'Aset Lancar',
        unit: 'idr',
        values: periods.map((p) => {
          const it = bsMap.get(p);
          const raw = it && extractFirstNumber(it.data, [
            'aset.aset_lancar.aset_lancar',
            'aset.aset_lancar',
            'aset_lancar',
            'current_assets'
          ]);
          return toMiliarIdr(raw);
        })
      },
      {
        type: 'total',
        label: 'Total Aset',
        unit: 'idr',
        values: periods.map((p) => {
          const it = bsMap.get(p);
          const raw = it && extractFirstNumber(it.data, [
            'aset.aset',
            'total_aset',
            'total_assets'
          ]);
          return toMiliarIdr(raw);
        })
      },
      { type: 'group', label: 'Liabilitas' },
      {
        type: 'item',
        label: 'Liabilitas Jangka Pendek',
        unit: 'idr',
        values: periods.map((p) => {
          const it = bsMap.get(p);
          const raw = it && extractFirstNumber(it.data, [
            'liabilitas_dana_syirkah_temporer_dan_ekuitas.liabilitas.liabilitas_jangka_pendek.liabilitas_jangka_pendek',
            'liabilitas.liabilitas_jangka_pendek',
            'liabilitas_jangka_pendek',
            'current_liabilities'
          ]);
          return toMiliarIdr(raw);
        })
      },
      {
        type: 'total',
        label: 'Total Liabilitas',
        unit: 'idr',
        values: periods.map((p) => {
          const it = bsMap.get(p);
          const raw = it && extractFirstNumber(it.data, [
            'liabilitas_dana_syirkah_temporer_dan_ekuitas.liabilitas.liabilitas',
            'liabilitas.liabilitas',
            'total_liabilitas',
            'total_liabilities'
          ]);
          return toMiliarIdr(raw);
        })
      },
      { type: 'group', label: 'Ekuitas' },
      {
        type: 'total',
        label: 'Total Ekuitas',
        unit: 'idr',
        values: periods.map((p) => {
          const it = bsMap.get(p);
          const raw = it && extractFirstNumber(it.data, [
            'liabilitas_dana_syirkah_temporer_dan_ekuitas.ekuitas.ekuitas',
            'ekuitas.ekuitas',
            'total_ekuitas',
            'ekuitas',
            'equity',
            'total_equity'
          ]);
          return toMiliarIdr(raw);
        })
      }
    ];

    // 3. Cash Flow
    const cfRows = [
      { type: 'group', label: 'Arus Kas Aktivitas' },
      {
        type: 'item',
        label: 'Arus Kas dari Aktivitas Operasi',
        unit: 'idr',
        values: periods.map((p) => {
          const it = cfMap.get(p);
          const raw = it && extractFirstNumber(it.data, [
            'arus_kas_dari_aktivitas_operasi.arus_kas_bersih_yang_diperoleh_dari_digunakan_untuk_aktivitas_operasi',
            'arus_kas_dari_aktivitas_operasi',
            'operating_cash_flow'
          ]);
          return toMiliarIdr(raw);
        })
      },
      {
        type: 'item',
        label: 'Arus Kas dari Aktivitas Investasi',
        unit: 'idr',
        values: periods.map((p) => {
          const it = cfMap.get(p);
          const raw = it && extractFirstNumber(it.data, [
            'arus_kas_dari_aktivitas_investasi.arus_kas_bersih_yang_diperoleh_dari_digunakan_untuk_aktivitas_investasi',
            'arus_kas_dari_aktivitas_investasi',
            'investing_cash_flow'
          ]);
          return toMiliarIdr(raw);
        })
      },
      {
        type: 'item',
        label: 'Arus Kas dari Aktivitas Pendanaan',
        unit: 'idr',
        values: periods.map((p) => {
          const it = cfMap.get(p);
          const raw = it && extractFirstNumber(it.data, [
            'arus_kas_dari_aktivitas_pendanaan.arus_kas_bersih_yang_diperoleh_dari_digunakan_untuk_aktivitas_pendanaan',
            'arus_kas_dari_aktivitas_pendanaan',
            'financing_cash_flow'
          ]);
          return toMiliarIdr(raw);
        })
      },
      {
        type: 'total',
        label: 'Kenaikan (Penurunan) Kas Bersih',
        unit: 'idr',
        values: periods.map((p) => {
          const it = cfMap.get(p);
          const raw = it && extractFirstNumber(it.data, [
            'kenaikan_penurunan_bersih_kas_dan_setara_kas',
            'net_change_in_cash'
          ]);
          return toMiliarIdr(raw);
        })
      }
    ];

    // 4. Ratios
    const ratioRows = [
      { type: 'group', label: 'Rasio Profitabilitas' },
      {
        type: 'item',
        label: 'Return on Equity (ROE)',
        unit: 'pct',
        values: periods.map((p) => {
          const bIt = bsMap.get(p);
          const iIt = incMap.get(p);
          const eq = bIt && extractFirstNumber(bIt.data, [
            'liabilitas_dana_syirkah_temporer_dan_ekuitas.ekuitas.ekuitas',
            'total_ekuitas',
            'ekuitas'
          ]);
          const ni = iIt && extractFirstNumber(iIt.data, [
            'laba_rugi_periode_berjalan',
            'laba_bersih',
            'net_income'
          ]);
          if (eq != null && ni != null && eq > 0) {
            return Math.round(((ni / eq) * 100) * 100) / 100;
          }
          return null;
        })
      },
      {
        type: 'item',
        label: 'Return on Assets (ROA)',
        unit: 'pct',
        values: periods.map((p) => {
          const bIt = bsMap.get(p);
          const iIt = incMap.get(p);
          const aset = bIt && extractFirstNumber(bIt.data, [
            'aset.aset',
            'total_aset',
            'total_assets'
          ]);
          const ni = iIt && extractFirstNumber(iIt.data, [
            'laba_rugi_periode_berjalan',
            'laba_bersih',
            'net_income'
          ]);
          if (aset != null && ni != null && aset > 0) {
            return Math.round(((ni / aset) * 100) * 100) / 100;
          }
          return null;
        })
      }
    ];

    return {
      periods,
      income_statement: { periods, rows: incRows },
      balance_sheet: { periods, rows: bsRows },
      cash_flow: { periods, rows: cfRows },
      ratios: { periods, rows: ratioRows }
    };
  }

  const quarterlyData = buildPeriodStatement(bsQuarterly, isQuarterly, cfQuarterly, 'Kuartalan');
  const annualData = buildPeriodStatement(bsAnnual, isAnnual, cfAnnual, 'Tahunan');

  // Extract latest raw equity from latest annual or quarterly statement
  let latestEquity = null;
  let latestPeriodLabel = null;
  let sourceCollectedAt = null;

  // Prefer latest annual for standard fundamental, or quarterly if newer
  const checkOrder = [bsQuarterly, bsAnnual];
  for (const s of checkOrder) {
    if (s && Array.isArray(s.items) && s.items.length > 0) {
      const latestItem = s.items[0];
      const eq = extractFirstNumber(latestItem && latestItem.data, [
        'liabilitas_dana_syirkah_temporer_dan_ekuitas.ekuitas.ekuitas',
        'ekuitas.ekuitas',
        'total_ekuitas',
        'ekuitas',
        'equity'
      ]);
      if (eq != null && eq > 0 && latestEquity == null) {
        latestEquity = eq;
        latestPeriodLabel = latestItem.label || s.period;
        sourceCollectedAt = s.collected_at;
      }
    }
  }

  return {
    ticker,
    equity: latestEquity,
    fundamental_period: latestPeriodLabel,
    collected_at: sourceCollectedAt,
    quarterly: quarterlyData,
    annual: annualData,
    source: 'arjum financial-statements'
  };
}

/**
 * Builds a merged fundamental record for a ticker.
 * Idempotently merges with existing record (preserving free_float and hsc fields).
 */
function buildMergedFundamentalRecord(options) {
  const { ticker, existingRecord, parsedStatements, marketCapInfo } = options;
  const cleanTicker = String(ticker || '').trim().toUpperCase();

  const current = existingRecord || { ticker: cleanTicker };
  const next = Object.assign({}, current, { ticker: cleanTicker });

  // 1. Statements & Equity
  if (parsedStatements) {
    const shouldUpdateStatements = canUpdateStatementsProvenance(current, parsedStatements);

    if (shouldUpdateStatements) {
      if (parsedStatements.equity != null && parsedStatements.equity > 0) {
        next.equity = parsedStatements.equity;
      }
      if (parsedStatements.fundamental_period) {
        next.fundamental_period = parsedStatements.fundamental_period;
      }
      next.source = parsedStatements.source || next.source || 'arjum financial-statements';

      if (parsedStatements.quarterly || parsedStatements.annual) {
        const incomingCollectedAt = isValidDateString(parsedStatements.collected_at) ? parsedStatements.collected_at.trim() : null;
        next.financial_statements = {
          quarterly: parsedStatements.quarterly || null,
          annual: parsedStatements.annual || null,
          source: parsedStatements.source || 'IDX Financial Statement',
          period: parsedStatements.fundamental_period || null,
          collected_at: incomingCollectedAt || (current.financial_statements && current.financial_statements.collected_at) || null,
          imported_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
      }
    }
  }

  // 2. Market Cap & Shares Outstanding
  if (marketCapInfo) {
    const rawIncomingDate = marketCapInfo.date || null;
    const incomingDate = isValidDateString(rawIncomingDate) ? rawIncomingDate.trim() : null;
    const existingDate = isValidDateString(current.market_cap_as_of) ? current.market_cap_as_of.trim() : null;

    // Fail-closed provenance: incoming without valid date cannot overwrite existing dated market cap
    const shouldUpdateMarketCap = canUpdateProvenance(existingDate, incomingDate);

    if (shouldUpdateMarketCap) {
      if (marketCapInfo.listed_shares != null && marketCapInfo.listed_shares > 0) {
        next.shares_outstanding = marketCapInfo.listed_shares;
      }
      if (marketCapInfo.market_cap != null && marketCapInfo.market_cap > 0) {
        next.market_cap = marketCapInfo.market_cap;
        next.market_cap_source = 'IDX market-cap snapshot';
        next.market_cap_as_of = incomingDate;
      }
    }
  }

  // 3. BVPS calculation
  const eq = numOrNull(next.equity);
  const sh = numOrNull(next.shares_outstanding);
  if (eq != null && sh != null && sh > 0 && eq > 0) {
    next.book_value_per_share = Math.round((eq / sh) * 100) / 100;
  }

  // 4. Invariants preservation
  // DO NOT mutate or erase free_float or hsc fields
  next.free_float_pct = current.free_float_pct != null ? current.free_float_pct : (next.free_float_pct != null ? next.free_float_pct : null);
  next.free_float_source = current.free_float_source != null ? current.free_float_source : (next.free_float_source != null ? next.free_float_source : null);
  next.free_float_as_of = current.free_float_as_of != null ? current.free_float_as_of : (next.free_float_as_of != null ? next.free_float_as_of : null);
  next.hsc_flag = current.hsc_flag != null ? current.hsc_flag : (next.hsc_flag != null ? next.hsc_flag : null);
  next.hsc_source = current.hsc_source != null ? current.hsc_source : (next.hsc_source != null ? next.hsc_source : null);
  next.hsc_as_of = current.hsc_as_of != null ? current.hsc_as_of : (next.hsc_as_of != null ? next.hsc_as_of : null);

  next.updated_at = new Date().toISOString();

  return next;
}

module.exports = {
  extractFirstNumber,
  numOrNull,
  toMiliarIdr,
  parseDateToEpoch,
  isValidDateString,
  canUpdateProvenance,
  parsePeriodScore,
  canUpdateStatementsProvenance,
  loadMarketCapData,
  parseStatementFile,
  parseTickerStatements,
  buildMergedFundamentalRecord
};
