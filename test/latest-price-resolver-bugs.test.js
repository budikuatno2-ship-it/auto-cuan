'use strict';

const assert = require('assert');
const {
  resolveLatestPrice,
  isFresh,
  rowPrice,
  rowDate
} = require('../lib/latest-price-resolver');

// Test 1: Older price source chosen over newer price source (Inversion of Freshness)
{
  const rows = {
    daytrade_screener_latest: {
      last_price: 1000,
      updated_at: '2026-08-10T10:00:00Z' // 26 hours ago
    },
    swing_screener_latest: {
      last_price: 1500,
      updated_at: '2026-08-11T11:00:00Z' // 1 hour ago
    }
  };
  const res = resolveLatestPrice(rows, { now: '2026-08-11T12:00:00Z' });
  assert.strictEqual(
    res.price,
    1500,
    'Bug 1: Freshness resolver must select the genuinely newest price, not older daytrade row'
  );
}

// Test 2: Date-only string on morning of trading day rejected as future timestamp
{
  const row = { trade_date: '2026-08-12', last_price: 2500 };
  // Jakarta 05:00 WIB = 2026-08-11 22:00 UTC
  const fresh = isFresh(row, { now: '2026-08-11T22:00:00.000Z' });
  assert.strictEqual(
    fresh,
    true,
    'Bug 2: Today date-only trade_date must be fresh on morning of trading day'
  );
}

// Test 3: Monday morning rejects Friday close as stale due to 48h limit
{
  const fridayClose = {
    daytrade_screener_latest: {
      last_price: 3000,
      updated_at: '2026-08-07T09:00:00.000Z' // Friday 16:00 WIB
    }
  };
  // Monday 09:00 WIB = 2026-08-10 02:00 UTC (65 hours later)
  const res = resolveLatestPrice(fridayClose, { now: '2026-08-10T02:00:00.000Z' });
  assert.strictEqual(
    res.stale,
    false,
    'Bug 3: Friday close must not be marked stale on Monday morning market open'
  );
}

// Test 4: Missing field 'price' from PRICE_FIELDS
{
  const priceOnlyRow = { price: 4200 };
  assert.strictEqual(
    rowPrice(priceOnlyRow),
    4200,
    'Bug 4: rowPrice must support standard "price" property'
  );
}

// Test 5: Missing field 'as_of_date' and 'date' from DATE_FIELDS
{
  const dateRow = { as_of_date: '2026-08-12', last_price: 1000 };
  assert.strictEqual(
    rowDate(dateRow),
    '2026-08-12',
    'Bug 5: rowDate must recognize "as_of_date" and "date"'
  );
}

// Test 6: Boolean true in last property coerced to price 1
{
  const booleanLastRow = { last: true, close: 5000 };
  assert.strictEqual(
    rowPrice(booleanLastRow),
    5000,
    'Bug 6: Boolean true in last property must not be coerced to price 1'
  );
}
