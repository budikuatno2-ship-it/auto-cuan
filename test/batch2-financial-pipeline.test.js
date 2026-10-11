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
const importFinancialStatements = require('../tools/import-financial-statements');

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
  // Rp 50.000.000 (50 juta) must be 0.05 miliar, not 50.000.000 miliar
  assert.equal(toMiliarIdr(50000000), 0.05);
  assert.equal(toMiliarIdr(281687555000000), 281687.56);
  assert.equal(toMiliarIdr(15000000000), 15);
  assert.equal(toMiliarIdr(0), 0);
  assert.equal(toMiliarIdr(null), null);
});

test('Batch 2: CLI argument parsing rejects conflicting --apply and --dry-run flags', () => {
  assert.throws(() => {
    importFinancialStatements.parseArgs(['--apply', '--dry-run']);
  }, /Konflik argumen: --apply dan --dry-run/);
});

test('Batch 2: Importer enforces explicit target DB guard and prevents accidental production writes', async () => {
  // Mode --apply without --db-path must throw
  await assert.rejects(async () => {
    await importFinancialStatements.main(['--apply']);
  }, /Safety guard: Mode --apply membutuhkan target database eksplisit/);

  // Mode --apply targeting production DB without env must throw
  await assert.rejects(async () => {
    await importFinancialStatements.main(['--apply', '--db-path', '/home/ubuntu/auto-cuan-data/market.sqlite']);
  }, /Safety guard: Penulisan langsung ke database produksi/);
});

test('Batch 2: Provenance rules prevent older snapshot from overwriting newer record', () => {
  const existing = {
    ticker: 'BBCA',
    market_cap: 800000000000000,
    market_cap_as_of: '2026-10-05',
    financial_statements: {
      updated_at: '2026-10-05T10:00:00Z',
      quarterly: { periods: ['Q2 2026'] }
    }
  };

  // Incoming older snapshot (2026-09-29 < 2026-10-05)
  const mergedOlder = buildMergedFundamentalRecord({
    ticker: 'BBCA',
    existingRecord: existing,
    parsedStatements: {
      collected_at: '2026-09-29T10:00:00Z',
      equity: 200000000000000,
      fundamental_period: 'Q1 2026'
    },
    marketCapInfo: {
      market_cap: 700000000000000,
      date: '2026-09-29'
    }
  });

  // Older market cap and statements must NOT overwrite newer existing record
  assert.equal(mergedOlder.market_cap, 800000000000000);
  assert.equal(mergedOlder.market_cap_as_of, '2026-10-05');
  assert.equal(mergedOlder.financial_statements.updated_at, '2026-10-05T10:00:00Z');

  // When date is missing, do NOT fabricate fake date
  const mergedNoDate = buildMergedFundamentalRecord({
    ticker: 'UNVR',
    existingRecord: null,
    marketCapInfo: {
      market_cap: 100000000000,
      date: null
    }
  });
  assert.equal(mergedNoDate.market_cap_as_of, null);

  // P0 REPRODUCTION: Undated incoming data must NEVER overwrite dated verified snapshot (fail-closed)
  const existingDated = {
    ticker: 'BBCA',
    market_cap: 800000000000000,
    market_cap_as_of: '2026-10-05',
    financial_statements: {
      updated_at: '2026-10-05T10:00:00Z',
      collected_at: '2026-10-05T10:00:00Z',
      quarterly: { periods: ['Q2 2026'] }
    }
  };

  const incomingUndated = buildMergedFundamentalRecord({
    ticker: 'BBCA',
    existingRecord: existingDated,
    parsedStatements: {
      collected_at: null, // Undated statements
      equity: 100000000000000,
      fundamental_period: 'Q1 2026'
    },
    marketCapInfo: {
      market_cap: 700000000000000, // Undated market cap
      date: null
    }
  });

  // Must preserve existing verified snapshot and date!
  assert.equal(incomingUndated.market_cap, 800000000000000, 'Undated market cap must not overwrite dated market cap');
  assert.equal(incomingUndated.market_cap_as_of, '2026-10-05', 'Existing market_cap_as_of must not be lost');
  assert.equal(incomingUndated.financial_statements.updated_at, '2026-10-05T10:00:00Z', 'Undated statements must not overwrite dated statements');
});

test('Batch 2: loadMarketCapData resolves duplicate tickers strictly by valid source date, independent of file read order', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-cuan-mcap-dupe-'));
  try {
    // File 1: dated 2026-10-05
    fs.writeFileSync(path.join(tmpDir, '01_latest.json'), JSON.stringify({
      date: '2026-10-05',
      items: [
        { ticker: 'BBCA', market_cap: 850000000000000, listed_shares: 123000000000, close: 10500 }
      ]
    }));
    // File 2: dated 2026-09-29 (older)
    fs.writeFileSync(path.join(tmpDir, '02_older.json'), JSON.stringify({
      date: '2026-09-29',
      items: [
        { ticker: 'BBCA', market_cap: 750000000000000, listed_shares: 122000000000, close: 10000 }
      ]
    }));
    // File 3: invalid/corrupt date
    fs.writeFileSync(path.join(tmpDir, '03_invalid_date.json'), JSON.stringify({
      date: 'NOT_A_DATE',
      items: [
        { ticker: 'BBCA', market_cap: 1000000, listed_shares: 100, close: 50 }
      ]
    }));

    // Normal order load
    const map1 = loadMarketCapData(tmpDir);
    const bbca1 = map1.get('BBCA');
    assert.ok(bbca1);
    assert.equal(bbca1.date, '2026-10-05');
    assert.equal(bbca1.market_cap, 850000000000000);

    // Now test reverse file order in another directory
    const tmpDirRev = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-cuan-mcap-rev-'));
    try {
      // Name files so older is read after newer or vice versa
      fs.writeFileSync(path.join(tmpDirRev, 'a_older.json'), JSON.stringify({
        date: '2026-09-29',
        items: [{ ticker: 'BBCA', market_cap: 750000000000000, listed_shares: 122000000000, close: 10000 }]
      }));
      fs.writeFileSync(path.join(tmpDirRev, 'z_newer.json'), JSON.stringify({
        date: '2026-10-05',
        items: [{ ticker: 'BBCA', market_cap: 850000000000000, listed_shares: 123000000000, close: 10500 }]
      }));
      const mapRev = loadMarketCapData(tmpDirRev);
      const bbcaRev = mapRev.get('BBCA');
      assert.equal(bbcaRev.date, '2026-10-05');
      assert.equal(bbcaRev.market_cap, 850000000000000);
    } finally {
      try { fs.rmSync(tmpDirRev, { recursive: true, force: true }); } catch (_) {}
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
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

test('Batch 2: End-to-end CLI importer processes union of statement and market cap sources into temp SQLite', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-cuan-importer-e2e-'));
  const statementsDir = path.join(tmpRoot, 'financial-statements');
  const marketCapDir = path.join(tmpRoot, 'market-cap');
  const dbPath = path.join(tmpRoot, 'e2e-market.sqlite');

  fs.mkdirSync(statementsDir, { recursive: true });
  fs.mkdirSync(marketCapDir, { recursive: true });

  try {
    // 1. Ticker STMT: only has statement directory (no market cap)
    const stmtOnlyDir = path.join(statementsDir, 'STMT');
    fs.mkdirSync(stmtOnlyDir, { recursive: true });
    fs.writeFileSync(path.join(stmtOnlyDir, 'INCOME_STATEMENT-quarterly.json'), JSON.stringify({
      ticker: 'STMT',
      period: 'Q1 2026',
      collected_at: '2026-10-01T00:00:00Z',
      items: [{
        label: 'Q1 2026',
        data: {
          pendapatan: { pendapatan: 50000000 },
          laba_rugi_periode_berjalan: 10000000
        }
      }]
    }));
    fs.writeFileSync(path.join(stmtOnlyDir, 'BALANCE_SHEET-quarterly.json'), JSON.stringify({
      ticker: 'STMT',
      period: 'Q1 2026',
      collected_at: '2026-10-01T00:00:00Z',
      items: [{
        label: 'Q1 2026',
        data: { total_ekuitas: 100000000 }
      }]
    }));

    // 2. Ticker MCAP: only has market cap file (no statement directory)
    fs.writeFileSync(path.join(marketCapDir, 'market-cap-batch.json'), JSON.stringify({
      date: '2026-10-08',
      items: [
        { ticker: 'MCAP', listed_shares: 5000000, market_cap: 25000000000, close: 5000 },
        { ticker: 'BOTH', listed_shares: 1000000, market_cap: 10000000000, close: 10000 }
      ]
    }));

    // 3. Ticker BOTH: also has statement directory
    const bothDir = path.join(statementsDir, 'BOTH');
    fs.mkdirSync(bothDir, { recursive: true });
    fs.writeFileSync(path.join(bothDir, 'BALANCE_SHEET-quarterly.json'), JSON.stringify({
      ticker: 'BOTH',
      period: 'Q1 2026',
      collected_at: '2026-10-02T00:00:00Z',
      items: [{
        label: 'Q1 2026',
        data: { total_ekuitas: 5000000000 }
      }]
    }));

    // Run import via main with CLI args
    await importFinancialStatements.main([
      '--apply',
      '--db-path', dbPath,
      '--statements-dir', statementsDir,
      '--market-cap-dir', marketCapDir
    ]);

    // Verify stored records in SQLite
    const store = new marketStore.VpsMarketStore(dbPath);
    const rows = store.readTable('stock_fundamentals');

    const tickers = rows.map((r) => r.ticker).sort();
    assert.deepEqual(tickers, ['BOTH', 'MCAP', 'STMT'], 'Union of statements and market-cap must be imported');

    // Verify STMT
    const stmtRow = rows.find((r) => r.ticker === 'STMT');
    assert.equal(stmtRow.equity, 100000000);
    assert.equal(stmtRow.market_cap == null, true);
    // Verify 50.000.000 IDR -> 0.05 miliar in statement table!
    const incRow = stmtRow.financial_statements.quarterly.income_statement.rows.find((r) => r.type === 'item' && r.label === 'Pendapatan Usaha');
    assert.equal(incRow.values[0], 0.05);

    // Verify MCAP
    const mcapRow = rows.find((r) => r.ticker === 'MCAP');
    assert.equal(mcapRow.market_cap, 25000000000);
    assert.equal(mcapRow.shares_outstanding, 5000000);
    assert.equal(mcapRow.market_cap_as_of, '2026-10-08');

    // Verify BOTH
    const bothRow = rows.find((r) => r.ticker === 'BOTH');
    assert.equal(bothRow.equity, 5000000000);
    assert.equal(bothRow.shares_outstanding, 1000000);
    assert.equal(bothRow.market_cap, 10000000000);
    // BVPS = 5.000.000.000 / 1.000.000 = 5000
    assert.equal(bothRow.book_value_per_share, 5000);
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (_) {}
  }
});
