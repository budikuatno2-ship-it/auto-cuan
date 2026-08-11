'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseFundamentalsCsv, handleAdminFundamentalsUpload } = require('../lib/admin-fundamentals-upload');
const { makeFakeSupabase } = require('./helpers/fake-supabase');

function makeRes() {
  let _status = 200;
  let _body = null;
  return {
    status(code) { _status = code; return this; },
    json(data) { _body = data; return this; },
    getStatus() { return _status; },
    getBody() { return _body; }
  };
}

test('parses a valid CSV with book_value_per_share directly', () => {
  const csv = 'ticker,book_value_per_share,fundamental_period,source\nBBCA,3000,FY2025,manual_entry\n';
  const parsed = parseFundamentalsCsv(csv);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].ticker, 'BBCA');
  assert.equal(parsed.rows[0].book_value_per_share, 3000);
});

test('parses a valid CSV deriving BVPS from equity + shares_outstanding', () => {
  const csv = 'ticker,equity,shares_outstanding,fundamental_period,source\nTLKM,500000,1000,FY2025,manual_entry\n';
  const parsed = parseFundamentalsCsv(csv);
  assert.equal(parsed.rows[0].equity, 500000);
  assert.equal(parsed.rows[0].shares_outstanding, 1000);
  assert.equal(parsed.rows[0].book_value_per_share, null); // stored as given, PBV module derives BVPS later
});

test('rejects a CSV missing both book_value_per_share and equity/shares_outstanding columns', () => {
  const csv = 'ticker,fundamental_period,source\nBBCA,FY2025,manual_entry\n';
  assert.throws(() => parseFundamentalsCsv(csv), /book_value_per_share/);
});

test('rejects a row with equity but no shares_outstanding value (cannot derive BVPS)', () => {
  const csv = 'ticker,equity,shares_outstanding,fundamental_period,source\nBBCA,500000,,FY2025,manual_entry\n';
  assert.throws(() => parseFundamentalsCsv(csv), /tidak memiliki data cukup/);
});

test('rejects duplicate tickers in the same CSV', () => {
  const csv = 'ticker,book_value_per_share,fundamental_period,source\nBBCA,3000,FY2025,x\nBBCA,3100,FY2025,x\n';
  assert.throws(() => parseFundamentalsCsv(csv), /duplikat/);
});

test('rejects a missing required column (fundamental_period)', () => {
  const csv = 'ticker,book_value_per_share,source\nBBCA,3000,x\n';
  assert.throws(() => parseFundamentalsCsv(csv), /fundamental_period/);
});

test('handleAdminFundamentalsUpload preview mode does not write to the database', async () => {
  const csv = 'ticker,book_value_per_share,fundamental_period,source\nBBCA,3000,FY2025,manual_entry\n';
  const supabase = makeFakeSupabase();
  const res = makeRes();
  await handleAdminFundamentalsUpload({ body: { mode: 'preview', csv } }, res, supabase);
  assert.equal(res.getBody().preview, true);
  assert.equal((supabase._tables.stock_fundamentals || []).length, 0);
});

test('handleAdminFundamentalsUpload import mode is idempotent on repeated identical uploads', async () => {
  const csv = 'ticker,book_value_per_share,fundamental_period,source\nBBCA,3000,FY2025,manual_entry\n';
  const supabase = makeFakeSupabase();

  await handleAdminFundamentalsUpload({ body: { mode: 'import', csv } }, makeRes(), supabase);
  await handleAdminFundamentalsUpload({ body: { mode: 'import', csv } }, makeRes(), supabase);

  const rows = supabase._tables.stock_fundamentals.filter((r) => r.ticker === 'BBCA');
  assert.equal(rows.length, 1);
});

test('handleAdminFundamentalsUpload rejects import mode without a supabase client (not configured)', async () => {
  const csv = 'ticker,book_value_per_share,fundamental_period,source\nBBCA,3000,FY2025,manual_entry\n';
  const res = makeRes();
  await handleAdminFundamentalsUpload({ body: { mode: 'import', csv } }, res, null);
  assert.equal(res.getStatus(), 503);
});
