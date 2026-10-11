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

async function queryStockFundamentals(db, ticker) {
  // First attempt: select full columns including financial_statements
  let result = await db.from('stock_fundamentals')
    .select('ticker,book_value_per_share,equity,shares_outstanding,market_cap,market_cap_source,market_cap_as_of,fundamental_period,source,updated_at,financial_statements')
    .eq('ticker', ticker).maybeSingle();

  // If column error occurs (e.g. Postgres 42703 column does not exist on remote Supabase),
  // fallback gracefully to base columns without financial_statements.
  if (result && result.error && (result.error.code === '42703' || /column.*does not exist/i.test(result.error.message || ''))) {
    result = await db.from('stock_fundamentals')
      .select('ticker,book_value_per_share,equity,shares_outstanding,market_cap,market_cap_source,market_cap_as_of,fundamental_period,source,updated_at')
      .eq('ticker', ticker).maybeSingle();
  }
  return result;
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

  const dataAvailable = pbv.data_available || Boolean(row && (
    numberOrNull(row.shares_outstanding) != null || numberOrNull(row.market_cap) != null || numberOrNull(row.equity) != null
  ));

  return {
    ticker,
    status: dataAvailable ? 'available' : (row ? 'missing' : 'unknown'),
    fundamental: {
      ...pbv,
      equity: row ? numberOrNull(row.equity) : null,
      shares_outstanding: row ? numberOrNull(row.shares_outstanding) : null,
      market_cap: row ? numberOrNull(row.market_cap) : null,
      market_cap_source: row ? row.market_cap_source || null : null,
      market_cap_as_of: row ? row.market_cap_as_of || null : null,
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

module.exports = { buildFinancialSnapshot };
