'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { syncDateRange } = require('../lib/daily-history-sqlite-sync');
const { getVpsMarketStore } = require('../lib/vps-market-store');

test('R06 & R07: SQLite KV canonical schema and real transactional syncDateRange (dry-run & live)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-sync-test-'));
  const dbPath = path.join(tmp, 'market.sqlite');
  const candleDir = path.join(tmp, 'daily-candles');
  fs.mkdirSync(candleDir, { recursive: true });

  // 1. Siapkan fixture candle lokal
  const fixtureBbca = {
    code: 'BBCA',
    candles: [
      { date: '2026-11-03', open: 10100, high: 10250, low: 10050, close: 10200, volume: 5000000 },
      { date: '2026-11-04', open: 10200, high: 10300, low: 10150, close: 10250, volume: 6000000 },
      { date: '2026-11-05', open: 10250, high: 10350, low: 10200, close: 10300, volume: 5500000 },
      { date: '2026-11-13', open: 10300, high: 10400, low: 10250, close: 10350, volume: 7000000 }
    ]
  };
  const fixtureBbri = {
    code: 'BBRI',
    candles: [
      { date: '2026-11-03', open: 5400, high: 5450, low: 5350, close: 5425, volume: 15000000 },
      { date: '2026-11-04', open: 5425, high: 5500, low: 5400, close: 5475, volume: 16000000 },
      { date: '2026-11-13', open: 5450, high: 5525, low: 5425, close: 5500, volume: 18000000 }
    ]
  };

  fs.writeFileSync(path.join(candleDir, 'BBCA.json'), JSON.stringify(fixtureBbca));
  fs.writeFileSync(path.join(candleDir, 'BBRI.json'), JSON.stringify(fixtureBbri));

  try {
    // Inisialisasi store SQLite
    const store = getVpsMarketStore(dbPath);
    const db = store.db;

    // 2. Pembuktian R06: kueri kolom 'data' atau 'date' langsung pada market_rows MELEMPAR EXCEPTION
    assert.throws(() => {
      db.prepare("SELECT max(json_extract(data, '$.date')) FROM market_rows WHERE table_name = 'stock_daily_history'").get();
    }, /no such column: data/, 'Kueri runbook lama dengan kolom "data" harus gagal fatal');

    // 3. Uji Mode DRY-RUN (R07): verifikasi baris dihitung nyata, tapi database TIDAK dimutasi
    const dryRes = await syncDateRange({
      dbPath,
      candleDir,
      startDate: '2026-11-03',
      endDate: '2026-11-13',
      dryRun: true
    });

    assert.equal(dryRes.ok, true);
    assert.equal(dryRes.dry_run, true);
    assert.equal(dryRes.tickers_scanned, 2);
    assert.equal(dryRes.tickers_with_rows, 2);
    assert.equal(dryRes.total_valid_rows, 7); // 4 baris BBCA + 3 baris BBRI
    assert.equal(dryRes.rows_upserted, 0); // 0 baris ditulis pada dry-run

    // Pastikan di database masih 0 baris
    const preCount = db.prepare("SELECT count(*) as count FROM market_rows WHERE table_name = 'stock_daily_history'").get();
    assert.equal(preCount.count, 0, 'Database harus tetap kosong setelah dry-run');

    // 4. Uji Mode LIVE (R07): mutasi transaksi riil
    const liveRes = await syncDateRange({
      dbPath,
      candleDir,
      startDate: '2026-11-03',
      endDate: '2026-11-13',
      dryRun: false
    });

    assert.equal(liveRes.ok, true);
    assert.equal(liveRes.dry_run, false);
    assert.equal(liveRes.rows_upserted, 7);
    assert.equal(liveRes.verified_count, 7);
    assert.equal(liveRes.max_trade_date, '2026-11-13');

    // 5. Pembuktian R06 Canonical Query:
    // SELECT count(*), max(json_extract(row_json, '$.trade_date')) FROM market_rows WHERE table_name = 'stock_daily_history'
    const canonicalVerify = db.prepare(
      "SELECT count(*) as count, max(json_extract(row_json, '$.trade_date')) as max_date " +
      "FROM market_rows WHERE table_name = 'stock_daily_history'"
    ).get();

    assert.equal(canonicalVerify.count, 7, 'Canonical row count must match');
    assert.equal(canonicalVerify.max_date, '2026-11-13', 'Canonical max trade date must match');

    // Verifikasi isi row_json
    const sampleRow = db.prepare(
      "SELECT row_key, row_json FROM market_rows WHERE table_name = 'stock_daily_history' " +
      "AND json_extract(row_json, '$.ticker') = 'BBCA' AND json_extract(row_json, '$.trade_date') = '2026-11-13'"
    ).get();
    assert.ok(sampleRow, 'Row BBCA 2026-11-13 must exist');
    const parsed = JSON.parse(sampleRow.row_json);
    assert.equal(parsed.ticker, 'BBCA');
    assert.equal(parsed.trade_date, '2026-11-13');
    assert.equal(parsed.close, 10350);

  } finally {
    try {
      const { closeVpsMarketStore } = require('../lib/vps-market-store');
      closeVpsMarketStore();
    } catch (_) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
});
