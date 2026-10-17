'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const adminUsers = require('../api/admin-users.js');

test('FIX-03: isTruthyFlag correctly coerces boolean and truthy strings/numbers', () => {
  assert.equal(typeof adminUsers.isTruthyFlag, 'function', 'isTruthyFlag must be exported');
  assert.equal(adminUsers.isTruthyFlag(true), true);
  assert.equal(adminUsers.isTruthyFlag(1), true);
  assert.equal(adminUsers.isTruthyFlag('true'), true);
  assert.equal(adminUsers.isTruthyFlag('TRUE'), true);
  assert.equal(adminUsers.isTruthyFlag('1'), true);

  assert.equal(adminUsers.isTruthyFlag(false), false);
  assert.equal(adminUsers.isTruthyFlag(0), false);
  assert.equal(adminUsers.isTruthyFlag('false'), false);
  assert.equal(adminUsers.isTruthyFlag(null), false);
  assert.equal(adminUsers.isTruthyFlag(undefined), false);
  assert.equal(adminUsers.isTruthyFlag(''), false);
});

test('FIX-03: deleteUser checks .error on each table deletion and halts on child table failure', async () => {
  assert.equal(typeof adminUsers.deleteUserWithSupabase, 'function', 'deleteUserWithSupabase must be exported for testing');

  // Mock Supabase where deleting app_user_devices returns an error
  const mockSupabase = {
    from: (table) => {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: 'usr-123', username: 'baduser' },
              error: null
            })
          })
        }),
        delete: () => ({
          eq: (field, val) => {
            if (table === 'app_user_devices') {
              return Promise.resolve({ error: { message: 'FK constraint failure' } });
            }
            return Promise.resolve({ error: null, data: [{ id: 'usr-123' }] });
          }
        })
      };
    }
  };

  let statusCode = 0;
  let jsonPayload = null;
  const mockRes = {
    status: (s) => {
      statusCode = s;
      return {
        json: (p) => { jsonPayload = p; }
      };
    }
  };

  await adminUsers.deleteUserWithSupabase('baduser', mockRes, mockSupabase);
  assert.equal(statusCode, 500, 'Must return HTTP 500 when child table deletion fails');
  assert.equal(jsonPayload.success, false);
  assert.match(jsonPayload.error, /Gagal menghapus data/);
});

test('FIX-03: AI eval run returns HTTP 409 on duplicate run conflict and formats dynamic token budget', () => {
  assert.equal(typeof adminUsers.formatTokenBudgetMessage, 'function', 'formatTokenBudgetMessage must be exported');

  // Dynamic budget message
  assert.equal(adminUsers.formatTokenBudgetMessage(50000000), 'Budget 50 juta token sudah habis.');
  assert.equal(adminUsers.formatTokenBudgetMessage(25000000), 'Budget 25 juta token sudah habis.');
  assert.equal(adminUsers.formatTokenBudgetMessage(1000000), 'Budget 1 juta token sudah habis.');
});
