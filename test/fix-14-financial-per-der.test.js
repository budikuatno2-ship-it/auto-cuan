'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const { buildFinancialSnapshot } = require('../lib/financial-snapshot.js');

test('FIX-14: buildFinancialSnapshot computes PER and DER fail-closed without fabricating numbers', async () => {
  // Mock DB with valid fundamentals
  const mockDb = {
    from: (table) => {
      if (table === 'stock_fundamentals') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  ticker: 'BBCA',
                  book_value_per_share: 2500,
                  equity: 200000000000,
                  liabilities: 100000000000,
                  eps: 500,
                  shares_outstanding: 1000000000,
                  market_cap: 10000000000000,
                  fundamental_period: 'Q2 2026',
                  source: 'IDX'
                },
                error: null
              })
            })
          })
        };
      }
      if (table === 'stock_daily_history') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({
                  data: [{ close: 10000, trade_date: '2026-10-15', data_source: 'idx' }],
                  error: null
                })
              })
            })
          })
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) };
    }
  };

  const snap = await buildFinancialSnapshot(mockDb, 'BBCA');
  assert.equal(snap.ticker, 'BBCA');
  // PER = lastPrice (10000) / eps (500) = 20
  assert.equal(snap.fundamental.per, 20.0);
  // DER = liabilities (100B) / equity (200B) = 0.5
  assert.equal(snap.fundamental.der, 0.5);

  // When eps and liabilities are missing -> null, not fabricated numbers
  const mockDbEmpty = {
    from: (table) => {
      if (table === 'stock_fundamentals') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  ticker: 'GOTO',
                  book_value_per_share: 50,
                  fundamental_period: 'Q2 2026',
                  source: 'IDX'
                },
                error: null
              })
            })
          })
        };
      }
      if (table === 'stock_daily_history') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({
                  data: [{ close: 50, trade_date: '2026-10-15', data_source: 'idx' }],
                  error: null
                })
              })
            })
          })
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) };
    }
  };

  const snapEmpty = await buildFinancialSnapshot(mockDbEmpty, 'GOTO');
  assert.equal(snapEmpty.fundamental.per, null, 'PER must be null when EPS is missing');
  assert.equal(snapEmpty.fundamental.der, null, 'DER must be null when liabilities/equity is missing');
});

test('FIX-14: UI files bind financialPer and financialDer and partials maintain byte-parity', () => {
  const runtimeCode = fs.readFileSync(require.resolve('../public/analisis-saham-runtime.js'), 'utf8');
  assert.match(runtimeCode, /financialPer/, 'Runtime must populate financialPer');
  assert.match(runtimeCode, /financialDer/, 'Runtime must populate financialDer');

  const p1 = fs.readFileSync(require.resolve('../partials/analisis-saham.partial.html'));
  const p2 = fs.readFileSync(require.resolve('../public/partials/analisis-saham.partial.html'));

  assert.match(p1.toString('utf8'), /id="financialPer"/);
  assert.match(p1.toString('utf8'), /id="financialDer"/);

  const hash1 = crypto.createHash('sha1').update(p1).digest('hex');
  const hash2 = crypto.createHash('sha1').update(p2).digest('hex');
  assert.equal(hash1, hash2, 'partials/analisis-saham.partial.html and public/partials/analisis-saham.partial.html must be byte-identical');
});
