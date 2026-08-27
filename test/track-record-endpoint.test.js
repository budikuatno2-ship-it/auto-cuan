'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function requireSectorHotWithStub() {
  const origLoad = Module._load;
  const abs = require.resolve('../api/sector-hot');
  delete require.cache[abs];
  Module._load = function (request, parent, isMain) {
    if (request === '@supabase/supabase-js') {
      return {
        createClient: function () {
          return {};
        }
      };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    return require('../api/sector-hot');
  } finally {
    Module._load = origLoad;
  }
}

test('handleTrackRecord handles query with mock supabase client', async () => {
  const sectorHot = requireSectorHotWithStub();
  const handler = sectorHot.__test && sectorHot.__test.handleTrackRecord;
  assert.equal(typeof handler, 'function');

  const mockRows = [
    {
      id: 10,
      ticker: 'BBCA',
      date: '2026-08-20',
      category: 'Day Trade',
      monitor_source: 'daytrade_signal',
      entry1: 10000,
      tp1: 10500,
      tp2: 11000,
      sl: 9700,
      status: 'TP1_HIT',
      first_sent_at: '2026-08-20T02:00:00Z',
      hit_entry_at: '2026-08-20T02:15:00Z',
      hit_tp1_at: '2026-08-20T03:00:00Z'
    },
    {
      id: 11,
      ticker: 'ASII',
      date: '2026-08-21',
      category: 'Swing Konglo',
      monitor_source: 'swing_konglo',
      entry1: 5000,
      tp1: 5400,
      tp2: 5700,
      sl: 4800,
      status: 'SL_HIT',
      first_sent_at: '2026-08-21T01:00:00Z',
      hit_sl_at: '2026-08-21T05:00:00Z'
    }
  ];

  const mockSupabase = {
    from(table) {
      assert.equal(table, 'telegram_daily_picks');
      return {
        select() {
          return {
            order() {
              return {
                order() {
                  return {
                    limit() {
                      return Promise.resolve({ data: mockRows, error: null });
                    }
                  };
                }
              };
            }
          };
        }
      };
    }
  };

  let statusCode = 0;
  let jsonResult = null;
  const mockReq = { query: { limit: '100' } };
  const mockRes = {
    status(c) {
      statusCode = c;
      return this;
    },
    json(obj) {
      jsonResult = obj;
      return this;
    }
  };

  await handler(mockReq, mockRes, mockSupabase);

  assert.equal(statusCode, 200);
  assert.equal(jsonResult.success, true);
  assert.equal(jsonResult.summary.total_signals, 2);
  assert.equal(jsonResult.summary.tp1_hits, 1);
  assert.equal(jsonResult.summary.sl_hits, 1);
  assert.equal(jsonResult.summary.win_rate_tp1, '50.0%');
  assert.equal(jsonResult.signals.length, 2);
});

test('handleTrackRecord handles database error safely with valid fallback format', async () => {
  const sectorHot = requireSectorHotWithStub();
  const handler = sectorHot.__test && sectorHot.__test.handleTrackRecord;

  const mockSupabase = {
    from() {
      return {
        select() {
          return {
            order() {
              return {
                order() {
                  return {
                    limit() {
                      return Promise.resolve({ data: null, error: { message: 'DB connection timeout' } });
                    }
                  };
                }
              };
            }
          };
        }
      };
    }
  };

  let statusCode = 0;
  let jsonResult = null;
  const mockReq = { query: {} };
  const mockRes = {
    status(c) {
      statusCode = c;
      return this;
    },
    json(obj) {
      jsonResult = obj;
      return this;
    }
  };

  await handler(mockReq, mockRes, mockSupabase);

  assert.equal(statusCode, 200);
  assert.equal(jsonResult.success, false);
  assert.equal(jsonResult.summary.total_signals, 0);
  assert.equal(Array.isArray(jsonResult.signals), true);
  assert.equal(jsonResult.signals.length, 0);
});
