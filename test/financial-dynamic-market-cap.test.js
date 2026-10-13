const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildFinancialSnapshot } = require('../lib/financial-snapshot');
const { buildContextFromRows } = require('../lib/daily-market-context-builder');
const marketStore = require('../lib/vps-market-store');

test('Fase 2 S14: Dynamic market cap calculation reconciles BBCA price Rp 5.950 with 122.04B shares', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-cuan-fase2-'));
  const dbPath = path.join(tmpDir, 'market.sqlite');
  let store = null;

  try {
    store = new marketStore.VpsMarketStore(dbPath);

    // Seed stock_fundamentals with BBCA shares and stale 1.275 T market cap (from Rp 10.450 era)
    const sharesBbca = 122042299500;
    const staleMarketCap = 1275342029775000;
    store.writeRow('stock_fundamentals', {
      ticker: 'BBCA',
      shares_outstanding: sharesBbca,
      market_cap: staleMarketCap,
      market_cap_source: 'stock_fundamentals',
      market_cap_as_of: '2026-10-09',
      equity: 281687555000000,
      fundamental_period: 'Q1 2026',
      fundamental_source: 'arjum financial-statements',
      fundamental_updated_at: '2026-10-09T08:00:00Z'
    }, ['ticker'], true);

    // Seed latest trading history at Rp 5.950 as of 2026-10-12
    const closingPrice = 5950;
    store.writeRow('stock_daily_history', {
      ticker: 'BBCA',
      trade_date: '2026-10-12',
      close: closingPrice,
      open: 5975,
      high: 6000,
      low: 5925,
      volume: 85000000,
      data_source: 'daily_candles',
      data_quality_status: 'ok',
      updated_at: '2026-10-12T16:15:00Z'
    }, ['ticker', 'trade_date'], true);

    const snapshot = await buildFinancialSnapshot(store, 'BBCA');

    // Expected: 122,042,299,500 * 5,950 = 726,151,682,025,000 (Rp 726,15 T)
    const expectedDynamicMarketCap = sharesBbca * closingPrice;
    assert.equal(expectedDynamicMarketCap, 726151682025000);

    assert.equal(snapshot.ticker, 'BBCA');
    assert.equal(snapshot.status, 'available');
    assert.equal(snapshot.price.last, closingPrice);
    assert.equal(snapshot.fundamental.shares_outstanding, sharesBbca);

    // Verifies S14: market cap must be dynamic, not the stale 1.275 T
    assert.equal(snapshot.fundamental.market_cap, expectedDynamicMarketCap);
    assert.equal(snapshot.fundamental.market_cap_source, 'calculated (shares_outstanding * last_price)');

    // Verifies S15: market cap as-of date is synchronized with latest price date
    assert.equal(snapshot.fundamental.market_cap_as_of, '2026-10-12');
  } finally {
    if (store && store.db && typeof store.db.close === 'function') {
      try { store.db.close(); } catch (_) {}
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
});

test('Fase 2 S14: Fallback to stored market cap when daily price is unavailable', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-cuan-fase2-fallback-'));
  const dbPath = path.join(tmpDir, 'market.sqlite');
  let store = null;

  try {
    store = new marketStore.VpsMarketStore(dbPath);

    const shares = 5000000000;
    const staticCap = 50000000000000;
    store.writeRow('stock_fundamentals', {
      ticker: 'TEST',
      shares_outstanding: shares,
      market_cap: staticCap,
      market_cap_source: 'stock_fundamentals',
      market_cap_as_of: '2026-09-30',
      equity: 20000000000000,
      fundamental_period: 'Q2 2026',
      fundamental_source: 'arjum financial-statements',
      fundamental_updated_at: '2026-09-30T10:00:00Z'
    }, ['ticker'], true);

    const snapshot = await buildFinancialSnapshot(store, 'TEST');
    assert.equal(snapshot.ticker, 'TEST');
    assert.equal(snapshot.fundamental.market_cap, staticCap);
    assert.equal(snapshot.fundamental.market_cap_source, 'stock_fundamentals');
    assert.equal(snapshot.fundamental.market_cap_as_of, '2026-09-30');
  } finally {
    if (store && store.db && typeof store.db.close === 'function') {
      try { store.db.close(); } catch (_) {}
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
});

test('Fase 2: buildContextFromRows calculates dynamic market cap in daily context builder', () => {
  const historyRows = [
    { trade_date: '2026-10-12', close: 5950, open: 5975, high: 6000, low: 5925, volume: 100000 }
  ];
  const fundamentalsRow = {
    ticker: 'BBCA',
    shares_outstanding: 122042299500,
    market_cap: 1275342029775000,
    market_cap_source: 'stock_fundamentals',
    market_cap_as_of: '2026-10-09'
  };

  const context = buildContextFromRows('BBCA', historyRows, [], fundamentalsRow, null);
  assert.equal(context.fundamental.market_cap, 726151682025000);
  assert.equal(context.fundamental.market_cap_source, 'calculated (shares_outstanding * last_price)');
  assert.equal(context.fundamental.market_cap_as_of, '2026-10-12');
});
