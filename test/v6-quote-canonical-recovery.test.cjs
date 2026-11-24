'use strict';
// Offline canonical quote regression. No provider or workspace data writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const quote = require('../api/quote');

for (const [ticker, close, volume] of [['BBCA', 5600, null], ['IHSG', 5320.98095703125, 0], ['TLKM', 3100, 100]]) {
  test(`quote canonical ${ticker}: exact price/source/date/volume without network`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'OFFLINE_quote_'));
    const dbPath = path.join(root, 'market.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE market_rows(table_name TEXT,row_key TEXT,row_json TEXT,updated_at TEXT)');
    const row = { ticker, trade_date: '2026-11-16', open: close, high: close + 10, low: close - 10, close, volume, source: 'yahoo_chart', source_sha256: 'offline-receipt' };
    db.prepare('INSERT INTO market_rows VALUES(?,?,?,?)').run('stock_daily_history', ticker + '\x1f2026-11-16', JSON.stringify(row), '2026-11-17');
    db.close();
    const prior = process.env.AUTO_CUAN_MARKET_DB;
    const fetch = global.fetch;
    process.env.AUTO_CUAN_MARKET_DB = dbPath;
    let calls = 0;
    global.fetch = async () => { calls++; throw Error('OFFLINE'); };
    t.after(() => { global.fetch = fetch; if (prior === undefined) delete process.env.AUTO_CUAN_MARKET_DB; else process.env.AUTO_CUAN_MARKET_DB = prior; fs.rmSync(root, {recursive:true,force:true}); });
    const got = await quote.fetchYahooQuote(ticker);
    assert.equal(got.success, true);
    assert.equal(got.last, close);
    assert.equal(got.volume, volume);
    assert.equal(got.latestBarDate, row.trade_date);
    assert.equal(got.provenance.source_sha256, 'offline-receipt');
    assert.equal(got.provenance.storage, 'sqlite_market_rows');
    assert.equal(got.volumeAvg20, null);
    assert.equal(got.volumeVsAvg20, null);
    assert.equal(calls, 0);
    // Same ticker must not leak cached data across canonical databases.
    const changed = new DatabaseSync(dbPath);
    changed.prepare('UPDATE market_rows SET row_json=?').run(JSON.stringify({...row, close:close+1}));
    changed.close();
    assert.equal((await quote.fetchYahooQuote(ticker)).last, close+1);
  });
}
