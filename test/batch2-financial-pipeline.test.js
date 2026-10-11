'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  extractFirstNumber,
  numOrNull,
  toMiliarIdr,
  loadMarketCapData,
  parseTickerStatements,
  buildMergedFundamentalRecord
} = require('../lib/financial-statements-import');
const { buildFinancialSnapshot } = require('../lib/financial-snapshot');
const marketStore = require('../lib/vps-market-store');

test('Batch 2: extractFirstNumber handles deeply nested and alternative paths', () => {
  const sample = {
    liabilitas_dana_syirkah_temporer_dan_ekuitas: {
      ekuitas: {
        ekuitas: 281687555000000
      }
    }
  };
  const extracted = extractFirstNumber(sample, [
    'liabilitas_dana_syirkah_temporer_dan_ekuitas.ekuitas.ekuitas',
    'total_ekuitas'
  ]);
  assert.equal(extracted, 281687555000000);

  const flatSample = { total_ekuitas: 5000000000 };
  const extractedFlat = extractFirstNumber(flatSample, [
    'liabilitas_dana_syirkah_temporer_dan_ekuitas.ekuitas.ekuitas',
    'total_ekuitas'
  ]);
  assert.equal(extractedFlat, 5000000000);

  assert.equal(extractFirstNumber({}, ['nonexistent.path']), null);
});

test('Batch 2: toMiliarIdr scales raw IDR to Miliar accurately without corrupting smaller numbers', () => {
  assert.equal(toMiliarIdr(281687555000000), 281687.56);
  assert.equal(toMiliarIdr(15000000000), 15);
  assert.equal(toMiliarIdr(500), 500); // Already in smaller scale or ratio
  assert.equal(toMiliarIdr(null), null);
});

test('Batch 2: buildMergedFundamentalRecord strictly preserves market structure invariants', () => {
  const existingRecord = {
    ticker: 'BBCA',
    free_float_pct: 41.82,
    free_float_source: 'IDX ownership',
    free_float_as_of: '2026-08-31',
    hsc_flag: false,
    hsc_source: 'IDX HSC',
    hsc_as_of: '2026-10-01',
    regulatory_compliance_status: 'STRUCTURE_VERIFIED'
  };

  const parsedStatements = {
    equity: 281687555000000,
    fundamental_period: 'FY 2025',
    source: 'arjum financial-statements',
    quarterly: { periods: ['Q1 2026'], income_statement: { periods: ['Q1 2026'], rows: [] } },
    annual: { periods: ['FY 2025'], income_statement: { periods: ['FY 2025'], rows: [] } }
  };

  const marketCapInfo = {
    ticker: 'BBCA',
    listed_shares: 122042299500,
    market_cap: 750560141925000,
    date: '2026-09-29'
  };

  const merged = buildMergedFundamentalRecord({
    ticker: 'BBCA',
    existingRecord,
    parsedStatements,
    marketCapInfo
  });

  // Verify market structure preserved untouched
  assert.equal(merged.free_float_pct, 41.82);
  assert.equal(merged.free_float_source, 'IDX ownership');
  assert.equal(merged.free_float_as_of, '2026-08-31');
  assert.equal(merged.hsc_flag, false);
  assert.equal(merged.hsc_as_of, '2026-10-01');

  // Verify financial fundamentals added correctly
  assert.equal(merged.equity, 281687555000000);
  assert.equal(merged.shares_outstanding, 122042299500);
  assert.equal(merged.market_cap, 750560141925000);
  assert.equal(merged.market_cap_as_of, '2026-09-29');
  assert.equal(merged.market_cap_source, 'IDX market-cap snapshot');
  assert.equal(merged.fundamental_period, 'FY 2025');

  // BVPS = 281687555000000 / 122042299500 ≈ 2308.11
  assert.ok(merged.book_value_per_share > 2300 && merged.book_value_per_share < 2310);
  assert.equal(merged.book_value_per_share, 2308.11);

  // Statements attached
  assert.ok(merged.financial_statements);
  assert.ok(merged.financial_statements.quarterly);
  assert.ok(merged.financial_statements.annual);
});

test('Batch 2: Idempotent merge produces exact same record on subsequent execution', () => {
  const initial = {
    ticker: 'TLKM',
    free_float_pct: 47.91,
    free_float_as_of: '2026-08-31'
  };
  const statements = { equity: 130000000000000, fundamental_period: 'FY 2025' };
  const mcap = { listed_shares: 99062216600, market_cap: 300000000000000, date: '2026-09-29' };

  const pass1 = buildMergedFundamentalRecord({
    ticker: 'TLKM',
    existingRecord: initial,
    parsedStatements: statements,
    marketCapInfo: mcap
  });

  const pass2 = buildMergedFundamentalRecord({
    ticker: 'TLKM',
    existingRecord: pass1,
    parsedStatements: statements,
    marketCapInfo: mcap
  });

  assert.equal(pass1.book_value_per_share, pass2.book_value_per_share);
  assert.equal(pass1.equity, pass2.equity);
  assert.equal(pass1.market_cap, pass2.market_cap);
  assert.equal(pass1.free_float_pct, pass2.free_float_pct);
});

test('Batch 2: Isolated SQLite store end-to-end import and buildFinancialSnapshot query', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-cuan-fin-test-'));
  const dbPath = path.join(tmpDir, 'test-market.sqlite');

  try {
    const store = new marketStore.VpsMarketStore(dbPath);

    // Seed existing stock_fundamentals row with market structure only (mimicking pre-fix state)
    store.writeRow('stock_fundamentals', {
      ticker: 'BBCA',
      free_float_pct: 41.82,
      free_float_source: 'KSEI',
      free_float_as_of: '2026-08-31',
      hsc_flag: false,
      hsc_as_of: '2026-10-01',
      updated_at: '2026-10-01T02:00:00Z'
    }, ['ticker'], true);

    // Seed daily price history
    store.writeRow('stock_daily_history', {
      ticker: 'BBCA',
      trade_date: '2026-10-09',
      close: 10450,
      open: 10400,
      high: 10500,
      low: 10350,
      volume: 45000000,
      data_source: 'daily_candles',
      data_quality_status: 'ok',
      updated_at: '2026-10-09T16:00:00Z'
    }, ['ticker', 'trade_date'], true);

    // Before import: snapshot has no market cap or equity
    const preSnapshot = await buildFinancialSnapshot(store, 'BBCA');
    assert.equal(preSnapshot.fundamental.equity, null);
    assert.equal(preSnapshot.fundamental.market_cap, null);
    assert.equal(preSnapshot.fundamental.pbv, null);
    assert.equal(preSnapshot.fundamental.data_available, false);
    assert.equal(preSnapshot.status, 'missing');

    // Simulate import of statements & market cap
    const merged = buildMergedFundamentalRecord({
      ticker: 'BBCA',
      existingRecord: store.queryRows('stock_fundamentals', { filters: [{ field: 'ticker', op: 'eq', value: 'BBCA' }] })[0],
      parsedStatements: {
        equity: 281687555000000,
        fundamental_period: 'Q1 2026',
        source: 'arjum financial-statements',
        quarterly: {
          periods: ['Q1 2026'],
          income_statement: { periods: ['Q1 2026'], rows: [{ type: 'item', label: 'Pendapatan Usaha', values: [20000], unit: 'idr' }] },
          balance_sheet: { periods: ['Q1 2026'], rows: [{ type: 'total', label: 'Total Ekuitas', values: [281687.56], unit: 'idr' }] },
          cash_flow: { periods: ['Q1 2026'], rows: [{ type: 'total', label: 'Kenaikan Kas', values: [5000], unit: 'idr' }] },
          ratios: { periods: ['Q1 2026'], rows: [{ type: 'item', label: 'ROE', values: [18.5], unit: 'pct' }] }
        }
      },
      marketCapInfo: {
        ticker: 'BBCA',
        listed_shares: 122042299500,
        market_cap: 750560141925000,
        date: '2026-09-29'
      }
    });

    store.writeRow('stock_fundamentals', merged, ['ticker'], true);

    // After import: snapshot has full 4/4 coverage!
    const postSnapshot = await buildFinancialSnapshot(store, 'BBCA');
    assert.equal(postSnapshot.ticker, 'BBCA');
    assert.equal(postSnapshot.status, 'available');
    assert.equal(postSnapshot.fundamental.equity, 281687555000000);
    assert.equal(postSnapshot.fundamental.shares_outstanding, 122042299500);
    assert.equal(postSnapshot.fundamental.market_cap, 750560141925000);
    assert.equal(postSnapshot.fundamental.book_value_per_share, 2308.11);
    // PBV = 10450 / 2308.11 ≈ 4.53
    assert.equal(postSnapshot.fundamental.pbv, 4.53);
    assert.equal(postSnapshot.fundamental.data_available, true);
    assert.equal(postSnapshot.price.last, 10450);

    // Statements available for multi-period table workstation
    assert.ok(postSnapshot.financial_statements);
    assert.ok(postSnapshot.financial_statements.quarterly);
    assert.equal(postSnapshot.financial_statements.quarterly.income_statement.rows[0].label, 'Pendapatan Usaha');
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
});
