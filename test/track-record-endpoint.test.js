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

// ---------------------------------------------------------------------------
// /api/track-record is an ALIAS, not a new serverless function.
//
// The tab used to call /api/sector-hot?action=track-record directly and could
// be answered with an HTML page by the VPS/Nginx edge, producing the browser
// error: Unexpected token '<', "<!DOCTYPE "... is not valid JSON.
//
// The fix routes a stable JSON URL onto the existing sector-hot function, so
// the API function budget is untouched. Every layer that can answer the request
// must carry the alias, or the tab regresses on whichever layer is missing it.
// ---------------------------------------------------------------------------
test('the /api/track-record alias exists on every layer that can answer it', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.join(__dirname, '..');

  // 1. Vercel edge.
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const rule = (vercel.rewrites || []).find(r => r.source === '/api/track-record');
  assert.ok(rule, 'vercel.json must rewrite /api/track-record');
  assert.match(rule.destination, /action=track-record/);

  // 2. Nginx edge (VPS).
  const nginx = fs.readFileSync(path.join(ROOT, 'deploy', 'nginx', 'autocuan'), 'utf8');
  assert.match(nginx, /location = \/api\/track-record/, 'Nginx must define the exact-match alias location');
  assert.match(nginx, /action=track-record/, 'Nginx alias must forward to the track-record action');

  // 3. Origin server (VPS fallback / local dev).
  const origin = fs.readFileSync(path.join(ROOT, 'tools', 'local-dev-server.js'), 'utf8');
  assert.match(origin, /endpointName === 'track-record'/, 'origin server must resolve the track-record alias');

  // 4. The client must still fall back, so a stale edge cannot blank the tab.
  //
  // The read goes through a one-line bridge (`trFetch`) that resolves to the
  // keep-alive SWR store when it is present and to plain `fetch` otherwise, so
  // the contract is the alias URL being requested — not the callee's name.
  const runtime = fs.readFileSync(path.join(ROOT, 'public', 'track-record-runtime.js'), 'utf8');
  assert.match(runtime, /\(\s*'\/api\/track-record'\s*\)/, 'runtime must call the stable alias URL');
  assert.match(runtime, /action=track-record/, 'runtime must keep the sector-hot fallback');
  assert.match(runtime, /startsWith\('<'\)/, 'runtime must detect an HTML response before parsing');
  assert.match(
    runtime,
    /AutoCuanKeepAlive[\s\S]{0,120}cachedFetch/,
    'the bridge must resolve to the keep-alive store when it exists'
  );
});
