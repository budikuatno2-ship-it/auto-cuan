'use strict';

/**
 * Verified multi-year financial history for DeepScan.
 *
 * The module never scrapes or fabricates fundamentals. Rows must come from
 * stock_financial_history with explicit provenance. Annual coverage is checked
 * year-by-year so a missing fiscal year cannot silently become a complete
 * 2020->latest formula.
 */

const crypto = require('node:crypto');
const fcaTransition2026 = require('./fca-transition-2026');
const { isValidIdxTicker } = require('./idx-ticker');

const HISTORY_START_YEAR = 2020;
const PERIOD_TYPES = new Set(['FY','Q1','Q2','Q3','Q4','H1','9M','TTM']);
const MAX_CSV_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 20000;

function safeTicker(value) {
  return fcaTransition2026.normalizeTicker(value);
}
function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
function validDate(value) {
  const s = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}
function normalizePeriodType(value) {
  const v = String(value || '').trim().toUpperCase();
  return PERIOD_TYPES.has(v) ? v : null;
}
function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null;
  const ticker = safeTicker(row.ticker);
  const periodEnd = validDate(row.period_end);
  const periodType = normalizePeriodType(row.period_type);
  const fiscalYear = Number(row.fiscal_year || (periodEnd && periodEnd.slice(0, 4)));
  if (!ticker || !isValidIdxTicker(ticker) || !periodEnd || !periodType ||
      !Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2100) return null;
  return {
    ticker,
    period_end: periodEnd,
    period_type: periodType,
    fiscal_year: fiscalYear,
    currency: String(row.currency || 'IDR').trim().toUpperCase() || 'IDR',
    revenue: numOrNull(row.revenue),
    operating_income: numOrNull(row.operating_income),
    net_income: numOrNull(row.net_income),
    operating_cash_flow: numOrNull(row.operating_cash_flow),
    capital_expenditure: numOrNull(row.capital_expenditure),
    free_cash_flow: numOrNull(row.free_cash_flow),
    total_assets: numOrNull(row.total_assets),
    total_liabilities: numOrNull(row.total_liabilities),
    equity: numOrNull(row.equity),
    shares_outstanding: numOrNull(row.shares_outstanding),
    eps: numOrNull(row.eps),
    book_value_per_share: numOrNull(row.book_value_per_share),
    source: String(row.source || '').trim(),
    source_document: row.source_document == null ? null : String(row.source_document).trim() || null,
    verified_at: row.verified_at || null,
    updated_at: row.updated_at || null
  };
}

function normalizeRows(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const normalized = normalizeRow(row);
    if (normalized) out.push(normalized);
  }
  return out.sort((a,b) =>
    a.fiscal_year - b.fiscal_year ||
    a.period_end.localeCompare(b.period_end) ||
    a.period_type.localeCompare(b.period_type)
  );
}

function annualRows(rows) {
  const byYear = new Map();
  for (const row of normalizeRows(rows)) {
    if (row.period_type !== 'FY') continue;
    const existing = byYear.get(row.fiscal_year);
    if (!existing || row.period_end > existing.period_end) byYear.set(row.fiscal_year, row);
  }
  return Array.from(byYear.values()).sort((a,b) => a.fiscal_year - b.fiscal_year);
}

function latestRequiredFiscalYear(asOfDate) {
  const s = validDate(asOfDate) || new Date().toISOString().slice(0,10);
  const year = Number(s.slice(0,4));
  const month = Number(s.slice(5,7));

  // Conservative publication-availability policy: a fiscal year becomes
  // mandatory for weekly DeepScan only from May onward. Jan-Apr still require
  // the prior completed reporting cycle, avoiding a predictable yearly outage
  // while issuers are still publishing/verifying annual statements.
  return month >= 5 ? year - 1 : year - 2;
}

function requiredStartYear(firstCandleDate) {
  const first = validDate(firstCandleDate);
  if (!first) return HISTORY_START_YEAR;
  return Math.max(HISTORY_START_YEAR, Number(first.slice(0,4)));
}

function validateAnnualCoverage(rows, options) {
  options = options || {};
  const annual = annualRows(rows);
  const startYear = requiredStartYear(options.firstCandleDate);
  const endYear = Number.isInteger(options.latestFiscalYear)
    ? options.latestFiscalYear
    : latestRequiredFiscalYear(options.asOfDate);
  const byYear = new Map(annual.map(row => [row.fiscal_year, row]));
  const missingYears = [];
  const incompleteYears = [];

  for (let year = startYear; year <= endYear; year++) {
    const row = byYear.get(year);
    if (!row) {
      missingYears.push(year);
      continue;
    }
    // Minimum universal formula inputs. Cash-flow fields are optional because
    // financial-sector reporting differs; when present they enrich the score.
    if (row.revenue == null || row.net_income == null || row.equity == null ||
        !row.source) incompleteYears.push(year);
  }

  return {
    complete: missingYears.length === 0 && incompleteYears.length === 0 && endYear >= startYear,
    start_year: startYear,
    end_year: endYear,
    annual_count: annual.length,
    required_count: Math.max(0, endYear - startYear + 1),
    missing_years: missingYears,
    incomplete_years: incompleteYears,
    annual_rows: annual
  };
}

function cagr(first, last, periods) {
  const a = Number(first), b = Number(last);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0 || periods <= 0) return null;
  return (Math.pow(b / a, 1 / periods) - 1) * 100;
}
function ratioPositive(rows, field) {
  const usable = rows.filter(row => row[field] != null && Number.isFinite(Number(row[field])));
  if (!usable.length) return null;
  return usable.filter(row => Number(row[field]) > 0).length / usable.length;
}

function computeMetrics(rows) {
  const annual = annualRows(rows);
  if (!annual.length) return null;
  const first = annual[0], last = annual[annual.length - 1];
  const periods = last.fiscal_year - first.fiscal_year;
  const revenueCagr = cagr(first.revenue, last.revenue, periods);
  const incomeCagr = cagr(first.net_income, last.net_income, periods);
  const equityCagr = cagr(first.equity, last.equity, periods);
  const epsCagr = cagr(first.eps, last.eps, periods);
  const profitPositiveRatio = ratioPositive(annual, 'net_income');
  const ocfPositiveRatio = ratioPositive(annual, 'operating_cash_flow');
  const fcfPositiveRatio = ratioPositive(annual, 'free_cash_flow');
  const latestMargin = Number(last.revenue) !== 0 && last.revenue != null && last.net_income != null
    ? Number(last.net_income) / Number(last.revenue) * 100 : null;

  return {
    first_fiscal_year: first.fiscal_year,
    last_fiscal_year: last.fiscal_year,
    annual_count: annual.length,
    revenue_cagr_pct: revenueCagr,
    net_income_cagr_pct: incomeCagr,
    equity_cagr_pct: equityCagr,
    eps_cagr_pct: epsCagr,
    profit_positive_ratio: profitPositiveRatio,
    ocf_positive_ratio: ocfPositiveRatio,
    fcf_positive_ratio: fcfPositiveRatio,
    latest_net_margin_pct: latestMargin
  };
}

function scoreMetrics(metrics) {
  if (!metrics) return { score: 0, reasons: ['financial_history_missing'] };
  let score = 0;
  const reasons = [];

  if (metrics.revenue_cagr_pct != null) {
    if (metrics.revenue_cagr_pct >= 10) { score += 5; reasons.push('revenue_CAGR>=10%'); }
    else if (metrics.revenue_cagr_pct >= 0) { score += 2; reasons.push('revenue_CAGR_non_negative'); }
    else if (metrics.revenue_cagr_pct <= -8) { score -= 3; reasons.push('revenue_CAGR<=-8%'); }
  }
  if (metrics.net_income_cagr_pct != null) {
    if (metrics.net_income_cagr_pct >= 12) { score += 6; reasons.push('net_income_CAGR>=12%'); }
    else if (metrics.net_income_cagr_pct >= 0) { score += 3; reasons.push('net_income_CAGR_non_negative'); }
    else if (metrics.net_income_cagr_pct <= -10) { score -= 4; reasons.push('net_income_CAGR<=-10%'); }
  }
  if (metrics.equity_cagr_pct != null) {
    if (metrics.equity_cagr_pct >= 8) { score += 4; reasons.push('equity_CAGR>=8%'); }
    else if (metrics.equity_cagr_pct >= 0) { score += 2; reasons.push('equity_CAGR_non_negative'); }
    else { score -= 2; reasons.push('equity_contracting'); }
  }
  if (metrics.eps_cagr_pct != null && metrics.eps_cagr_pct >= 10) {
    score += 3; reasons.push('EPS_CAGR>=10%');
  }
  if (metrics.profit_positive_ratio != null) {
    if (metrics.profit_positive_ratio >= 0.8) { score += 4; reasons.push('profit_consistency>=80%'); }
    else if (metrics.profit_positive_ratio < 0.5) { score -= 3; reasons.push('profit_consistency<50%'); }
  }
  // Cash-flow metrics enrich but do not penalize absence because statement
  // structures differ across sectors.
  if (metrics.ocf_positive_ratio != null && metrics.ocf_positive_ratio >= 0.8) {
    score += 2; reasons.push('OCF_positive>=80%');
  }
  if (metrics.fcf_positive_ratio != null && metrics.fcf_positive_ratio >= 0.7) {
    score += 2; reasons.push('FCF_positive>=70%');
  }
  if (metrics.latest_net_margin_pct != null && metrics.latest_net_margin_pct > 0) {
    score += 1; reasons.push('latest_margin_positive');
  }
  return { score: Math.max(-10, Math.min(25, score)), reasons };
}

function buildContext(rows, options) {
  const coverage = validateAnnualCoverage(rows, options);
  const metrics = computeMetrics(coverage.annual_rows);
  const scored = scoreMetrics(metrics);
  return {
    data_available: coverage.annual_count > 0,
    complete: coverage.complete,
    coverage,
    metrics,
    score: coverage.complete ? scored.score : 0,
    reasons: coverage.complete ? scored.reasons : ['financial_history_incomplete']
  };
}

async function loadHistoryMap(db, tickers) {
  const map = new Map();
  if (!db || typeof db.from !== 'function') return map;
  const universe = Array.from(new Set((tickers || []).map(safeTicker).filter(isValidIdxTicker)));
  const chunkSize = 200;
  for (let i=0;i<universe.length;i+=chunkSize) {
    const chunk = universe.slice(i,i+chunkSize);
    const res = await db
      .from('stock_financial_history')
      .select('*')
      .in('ticker', chunk)
      .gte('fiscal_year', HISTORY_START_YEAR)
      .order('fiscal_year', { ascending: true })
      .limit(20000);
    if (res.error) throw new Error('deepscan_financial_history_query_failed');
    for (const row of res.data || []) {
      const normalized = normalizeRow(row);
      if (!normalized) continue;
      if (!map.has(normalized.ticker)) map.set(normalized.ticker, []);
      map.get(normalized.ticker).push(normalized);
    }
  }
  for (const [ticker, rows] of map.entries()) map.set(ticker, normalizeRows(rows));
  return map;
}

function latestUsableFundamentalRow(rows) {
  const normalized = normalizeRows(rows).slice().sort((a,b) =>
    b.period_end.localeCompare(a.period_end) || b.period_type.localeCompare(a.period_type)
  );
  for (const row of normalized) {
    const direct = numOrNull(row.book_value_per_share);
    const equity = numOrNull(row.equity);
    const shares = numOrNull(row.shares_outstanding);
    if ((direct != null && direct > 0) || (equity != null && shares != null && shares > 0)) {
      return {
        ticker: row.ticker,
        book_value_per_share: direct,
        equity,
        shares_outstanding: shares,
        fundamental_period: row.period_type + row.fiscal_year,
        source: row.source,
        updated_at: row.updated_at || row.verified_at || null
      };
    }
  }
  return null;
}

function parseCsv(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  if (!source.trim()) throw new Error('CSV kosong.');
  if (Buffer.byteLength(source, 'utf8') > MAX_CSV_BYTES) throw new Error('CSV melebihi batas 8 MB.');

  const rows = [];
  let row = [], value = '', quoted = false;
  for (let i=0;i<source.length;i++) {
    const ch=source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i+1] === '"') { value += '"'; i++; } else quoted=false;
      } else value += ch;
    } else if (ch === '"') quoted=true;
    else if (ch === ',') { row.push(value.trim()); value=''; }
    else if (ch === '\n') { row.push(value.trim()); value=''; if (row.some(Boolean)) rows.push(row); row=[]; }
    else if (ch !== '\r') value += ch;
  }
  if (quoted) throw new Error('CSV tidak valid: tanda kutip belum ditutup.');
  row.push(value.trim()); if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) throw new Error('CSV tidak memiliki baris data.');

  const headers=rows[0].map(x=>String(x||'').trim().toLowerCase());
  for (const required of ['ticker','period_end','period_type','source']) {
    if (!headers.includes(required)) throw new Error('Kolom CSV wajib tidak ditemukan: '+required);
  }

  const out=[], seen=new Set();
  for (let i=1;i<rows.length;i++) {
    if (out.length >= MAX_ROWS) throw new Error('Jumlah data melebihi batas '+MAX_ROWS+' baris.');
    const obj={};
    headers.forEach((h,j)=>{ obj[h]=rows[i][j] == null ? '' : rows[i][j]; });
    obj.fiscal_year = obj.fiscal_year || String(obj.period_end || '').slice(0,4);
    const normalized=normalizeRow(obj);
    if (!normalized) throw new Error('Baris financial-history tidak valid: '+(i+1));
    if (!normalized.source) throw new Error('Source wajib pada baris '+(i+1));
    if (normalized.revenue == null && normalized.net_income == null && normalized.equity == null) {
      throw new Error('Baris '+(i+1)+' tidak memiliki metrik financial utama.');
    }
    const key=normalized.ticker+'|'+normalized.period_end+'|'+normalized.period_type;
    if (seen.has(key)) throw new Error('Financial period duplikat pada baris '+(i+1)+': '+key);
    seen.add(key);
    out.push(normalized);
  }
  return {
    rows: out,
    summary: {
      row_count: out.length,
      ticker_count: new Set(out.map(x=>x.ticker)).size,
      sha256: crypto.createHash('sha256').update(source).digest('hex')
    }
  };
}

module.exports = {
  HISTORY_START_YEAR,
  PERIOD_TYPES,
  normalizeRow,
  normalizeRows,
  annualRows,
  latestRequiredFiscalYear,
  requiredStartYear,
  validateAnnualCoverage,
  computeMetrics,
  scoreMetrics,
  buildContext,
  loadHistoryMap,
  latestUsableFundamentalRow,
  parseCsv
};
