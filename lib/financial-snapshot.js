'use strict';

const { buildPbvContext } = require('./daily-pbv');
const { priceFreshness } = require('./daily-market-context-builder');

function numberOrNull(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function buildFinancialSnapshot(db, ticker) {
  const [fundamentals, prices] = await Promise.all([
    db.from('stock_fundamentals')
      .select('ticker,book_value_per_share,equity,shares_outstanding,market_cap,market_cap_source,market_cap_as_of,fundamental_period,source,updated_at')
      .eq('ticker', ticker).maybeSingle(),
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
  return {
    ticker,
    fundamental: {
      ...pbv,
      equity: row ? numberOrNull(row.equity) : null,
      shares_outstanding: row ? numberOrNull(row.shares_outstanding) : null,
      market_cap: row ? numberOrNull(row.market_cap) : null,
      market_cap_source: row ? row.market_cap_source || null : null,
      market_cap_as_of: row ? row.market_cap_as_of || null : null,
      data_available: pbv.data_available || Boolean(row && (
        numberOrNull(row.shares_outstanding) != null || numberOrNull(row.market_cap) != null
      ))
    },
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
