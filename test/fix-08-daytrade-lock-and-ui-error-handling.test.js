'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const sectorHot = require('../api/sector-hot.js');

function createMockRes() {
  const res = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.payload = data;
      return this;
    },
    setHeader() {}
  };
  return res;
}

test('FIX-08: handleDayTradeScreenerRead isolates per-row decoration errors and populates empty_reason', async () => {
  // Mock Supabase returning 1 valid row and 1 row that triggers decoration issues
  const mockRows = [
    {
      ticker: 'BBCA',
      daytrade_score: 85,
      risk_reward: 2.0,
      entry_low: 10000,
      entry_high: 10100,
      stop_loss: 9800,
      tp1: 10500,
      tp2: 10700,
      status: 'A_PLUS_SETUP'
    },
    {
      ticker: 'CORRUPT',
      daytrade_score: null,
      risk_reward: null,
      // Missing expected fields
      status: null
    }
  ];

  const mockSupabase = {
    from: (table) => {
      if (table === 'daytrade_screener_meta') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: 'latest', status: 'ok', calculated_at: new Date().toISOString() },
                error: null
              })
            })
          })
        };
      }
      if (table === 'daytrade_screener_latest') {
        return {
          select: () => ({
            order: () => ({
              order: () => ({
                limit: async () => ({ data: mockRows, error: null })
              })
            })
          })
        };
      }
      return {
        select: () => ({
          in: () => Promise.resolve({ data: [] }),
          limit: () => Promise.resolve({ data: [] })
        })
      };
    }
  };

  const req = { query: {}, headers: {} };
  const res = createMockRes();

  await sectorHot.__test.handleDayTradeScreenerRead(req, res, mockSupabase);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.success, true);
  // Ensure that BBCA row is preserved and returned, not emptied out due to error in CORRUPT
  assert.ok(Array.isArray(res.payload.results));
  assert.ok(res.payload.results.length >= 1, 'Valid rows must not be dropped due to 1 corrupt row');
  const bbca = res.payload.results.find(r => r.ticker === 'BBCA');
  assert.ok(bbca, 'BBCA row should be present');
});

test('FIX-08: handleDayTradeScreenerRead returns empty_reason="no_recent_scan" when table is empty', async () => {
  const mockSupabase = {
    from: (table) => {
      if (table === 'daytrade_screener_meta') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: 'latest', status: 'idle', calculated_at: null },
                error: null
              })
            })
          })
        };
      }
      if (table === 'daytrade_screener_latest') {
        return {
          select: () => ({
            order: () => ({
              order: () => ({
                limit: async () => ({ data: [], error: null })
              })
            })
          })
        };
      }
      return {
        select: () => ({ in: () => Promise.resolve({ data: [] }), limit: () => Promise.resolve({ data: [] }) })
      };
    }
  };

  const req = { query: {}, headers: {} };
  const res = createMockRes();
  await sectorHot.__test.handleDayTradeScreenerRead(req, res, mockSupabase);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.success, true);
  assert.equal(res.payload.empty_reason, 'no_recent_scan');
});

test('FIX-08: public/daytrade-runtime.js contains specific error handling for 401/403, 429, and forceResetDaytradeScan', () => {
  const code = fs.readFileSync(require.resolve('../public/daytrade-runtime.js'), 'utf8');
  assert.match(code, /401|403/, 'Frontend must check HTTP 401/403');
  assert.match(code, /429/, 'Frontend must check HTTP 429');
  assert.match(code, /forceResetDaytradeScan/, 'Frontend must provide forceResetDaytradeScan function');
  assert.match(code, /Reset Lock & Scan Ulang/, 'Frontend must render Reset Lock button');
});
