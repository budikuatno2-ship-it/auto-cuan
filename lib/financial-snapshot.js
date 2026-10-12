'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildPbvContext } = require('./daily-pbv');
const { priceFreshness } = require('./daily-market-context-builder');

function numberOrNull(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isColumnError(error) {
  if (!error) return false;
  return error.code === '42703' || /column.*does not exist/i.test(error.message || '');
}

async function queryStockFundamentals(db, ticker) {
  // Column sets in decreasing order of schema richness:
  // 1. Full schema (SQLite VPS store / updated remote schema)
  // 2. Without financial_statements column
  // 3. Base Postgres schema (without market_cap, market_cap_source, market_cap_as_of)
  // 4. Bare minimal schema
  const columnSets = [
    'ticker,name,company_name,book_value_per_share,equity,shares_outstanding,market_cap,market_cap_source,market_cap_as_of,fundamental_period,source,updated_at,financial_statements',
    'ticker,book_value_per_share,equity,shares_outstanding,market_cap,market_cap_source,market_cap_as_of,fundamental_period,source,updated_at,financial_statements',
    'ticker,book_value_per_share,equity,shares_outstanding,market_cap,market_cap_source,market_cap_as_of,fundamental_period,source,updated_at',
    'ticker,book_value_per_share,equity,shares_outstanding,fundamental_period,source,updated_at',
    'ticker,book_value_per_share,fundamental_period,source,updated_at'
  ];

  let result = null;
  for (let i = 0; i < columnSets.length; i++) {
    result = await db.from('stock_fundamentals')
      .select(columnSets[i])
      .eq('ticker', ticker)
      .maybeSingle();

    // If query succeeded or failed with a non-column error (e.g. storage down, table missing, 500),
    // stop immediately so we don't hide real storage failures.
    if (!result || !result.error || !isColumnError(result.error)) {
      break;
    }
  }
  return result;
}

let ownershipJsonCache = null;

function lookupOwnershipName(ticker) {
  if (!ownershipJsonCache) {
    try {
      const p = path.join(__dirname, '..', 'data', 'insider-network', 'ownership_30sep2026.json');
      if (fs.existsSync(p)) {
        ownershipJsonCache = JSON.parse(fs.readFileSync(p, 'utf8'));
      } else {
        ownershipJsonCache = [];
      }
    } catch (_) {
      ownershipJsonCache = [];
    }
  }
  const item = (ownershipJsonCache || []).find((x) => x && x.ticker === ticker);
  return item && item.name ? item.name : null;
}

const KNOWN_ACRONYMS = new Set(['BCA', 'BRI', 'BNI', 'BSI', 'BTN', 'CIMB', 'DBS', 'OCBC', 'UOB', 'BTPN', 'MNC', 'SCMA', 'ICBP', 'INDF', 'ASII', 'TLKM', 'BBCA', 'BBRI', 'BMRI', 'TASPEN', 'BPJS', 'IDX', 'BEI', 'KSEI', 'KPEI']);

function formatCompanyName(rawName, ticker) {
  if (!rawName) return 'PT ' + ticker + ' Tbk';
  let clean = String(rawName).trim().replace(/^PT\.?\s+/i, '').replace(/\.$/, '').trim();
  clean = clean.replace(/\bTbk\b/i, '').trim();
  const words = clean.split(/\s+/).map((w) => {
    const upper = w.toUpperCase();
    if (KNOWN_ACRONYMS.has(upper)) return upper;
    if (w.length <= 1) return upper;
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  });
  return 'PT ' + words.join(' ') + ' Tbk';
}

async function buildFinancialSnapshot(db, ticker) {
  const [fundamentals, prices] = await Promise.all([
    queryStockFundamentals(db, ticker),
    db.from('stock_daily_history')
      .select('close,trade_date,data_source,data_quality_status')
      .eq('ticker', ticker).order('trade_date', { ascending: false }).limit(1)
  ]);
  if (!fundamentals || fundamentals.error || fundamentals.data === undefined || !prices || prices.error || !Array.isArray(prices.data)) {
    throw new Error('Financial snapshot storage unavailable');
  }
  const row = fundamentals.data;
  const latest = (prices.data || [])[0] || null;
  const lastPrice = latest ? Number(latest.close) : null;
  const pbv = buildPbvContext(lastPrice, row);

  let rawCompanyName = (row && (row.company_name || row.name)) || null;
  if (!rawCompanyName) {
    try {
      const boardRes = await db.from('stock_boards').select('company_name').eq('ticker', ticker).maybeSingle();
      if (boardRes && boardRes.data && boardRes.data.company_name) {
        rawCompanyName = boardRes.data.company_name;
      }
    } catch (_) {}
  }
  if (!rawCompanyName) {
    rawCompanyName = lookupOwnershipName(ticker);
  }
  const companyName = formatCompanyName(rawCompanyName, ticker);

  // Detailed statements resolution (from DB row or disk fallback)
  let statements = (row && row.financial_statements) ? row.financial_statements : null;
  if (!statements) {
    try {
      const fsImport = require('./financial-statements-import');
      const statementsDir = path.join(__dirname, '..', 'data', 'arjum-data', 'financial-statements', ticker);
      if (fs.existsSync(statementsDir)) {
        const parsed = fsImport.parseTickerStatements(statementsDir, ticker);
        if (parsed && (parsed.quarterly || parsed.annual)) {
          statements = {
            quarterly: parsed.quarterly || null,
            annual: parsed.annual || null,
            source: parsed.source || 'IDX Financial Statement',
            updated_at: parsed.collected_at || new Date().toISOString()
          };
        }
      }
    } catch (_) {
      // Safe best-effort disk fallback
    }
  }

  const sharesOutstanding = row ? numberOrNull(row.shares_outstanding) : null;
  let marketCap = row ? numberOrNull(row.market_cap) : null;
  let marketCapSource = row ? row.market_cap_source || null : null;
  let marketCapAsOf = row ? row.market_cap_as_of || null : null;

  if (sharesOutstanding != null && lastPrice != null && lastPrice > 0) {
    if (marketCap == null || marketCap <= 0) {
      marketCap = Math.round(sharesOutstanding * lastPrice);
      marketCapSource = 'calculated (shares_outstanding * last_price)';
      marketCapAsOf = latest ? latest.trade_date : null;
    }
  }

  const dataAvailable = pbv.data_available || Boolean(row && (
    sharesOutstanding != null || marketCap != null || numberOrNull(row.equity) != null
  ));

  return {
    ticker,
    name: companyName,
    company_name: companyName,
    status: dataAvailable ? 'available' : (row ? 'missing' : 'unknown'),
    fundamental: {
      ...pbv,
      name: companyName,
      company_name: companyName,
      equity: row ? numberOrNull(row.equity) : null,
      shares_outstanding: sharesOutstanding,
      market_cap: marketCap,
      market_cap_source: marketCapSource,
      market_cap_as_of: marketCapAsOf,
      data_available: dataAvailable
    },
    financial_statements: statements || null,
    price: {
      last: lastPrice,
      last_price_as_of: latest ? latest.trade_date : null,
      last_price_source: latest ? latest.data_source || 'stock_daily_history' : null,
      last_price_data_quality_status: latest ? latest.data_quality_status || null : null,
      freshness: priceFreshness(latest ? latest.trade_date : null, new Date())
    }
  };
}

module.exports = { buildFinancialSnapshot, queryStockFundamentals };
