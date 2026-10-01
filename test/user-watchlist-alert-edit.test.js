'use strict';

// Regression coverage for the missing "edit alert" capability reported during
// the Watchlist audit: users could only create or delete a price alert, never
// change its target price/condition without deleting and re-adding it.
// lib/user-watchlist-service.js had no updateAlert() export at all, so this
// suite fails to even require it on the pre-fix code.

const test = require('node:test');
const assert = require('node:assert/strict');
const watchlistService = require('../lib/user-watchlist-service');

function mockSupabaseForUpdate(expected, returnedRow) {
  return {
    from(table) {
      assert.equal(table, 'app_user_alerts');
      return {
        update(updates) {
          assert.equal(updates.condition_type, expected.condition_type);
          assert.equal(updates.target_price, expected.target_price);
          assert.equal(updates.is_triggered, false);
          return {
            eq(field, value) {
              if (field === 'id') assert.equal(value, expected.alertId);
              if (field === 'user_id') assert.equal(value, expected.userId);
              return this;
            },
            select() {
              return {
                maybeSingle() {
                  return Promise.resolve({ data: returnedRow, error: null });
                }
              };
            }
          };
        }
      };
    }
  };
}

test('updateAlert changes target_price and condition_type on an existing alert', async () => {
  const row = { id: 'alert-1', user_id: 'u1', ticker: 'BBCA', condition_type: 'PRICE_BELOW', target_price: 9000, is_active: true, is_triggered: false };
  const supabase = mockSupabaseForUpdate(
    { alertId: 'alert-1', userId: 'u1', condition_type: 'PRICE_BELOW', target_price: 9000 },
    row
  );

  const result = await watchlistService.updateAlert(supabase, 'u1', 'alert-1', {
    condition_type: 'PRICE_BELOW',
    target_price: 9000
  });

  assert.equal(result.success, true);
  assert.equal(result.alert.target_price, 9000);
  assert.equal(result.alert.condition_type, 'PRICE_BELOW');
});

test('updateAlert rejects an invalid condition_type without touching the database', async () => {
  const supabase = { from() { throw new Error('should not query when validation fails'); } };
  const result = await watchlistService.updateAlert(supabase, 'u1', 'alert-1', {
    condition_type: 'NOT_A_REAL_CONDITION',
    target_price: 9000
  });
  assert.equal(result.success, false);
  assert.match(result.error, /condition_type tidak valid/);
});

test('updateAlert requires at least one field to change', async () => {
  const supabase = { from() { throw new Error('should not query with an empty payload'); } };
  const result = await watchlistService.updateAlert(supabase, 'u1', 'alert-1', {});
  assert.equal(result.success, false);
});
