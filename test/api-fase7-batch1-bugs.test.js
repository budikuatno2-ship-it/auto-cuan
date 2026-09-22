'use strict';

/**
 * FASE 7 — Target 2: Web API Endpoints & Response Formatting.
 *
 * Reproduction tests for the API-layer findings documented in
 * MASTER_ALL_BUG_FINDINGS_FASE1_TO_9.md (BUG-QUOTE-01..06, BUG-CAN-01..04).
 * These assert the post-fix contract: parameter validation, response schema
 * (success/error), and fail-safe behaviour when upstream data is empty.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const quote = require('../api/quote.js');
const candles = require('../api/candles.js');

const quoteTest = quote.__test;
const candlesTest = candles.__test;

// ---------------------------------------------------------------------------
// BUG-QUOTE-01 — Fibonacci levels must follow the trend direction
// ---------------------------------------------------------------------------
test('BUG-QUOTE-01: downward retracement measures levels from the swing low', () => {
  // A rebound off a low: 20 bars falling to ~500, then a partial recovery that
  // stays in the lower half of the swing range (so the trend stays "downward").
  const candlesInput = [];
  for (let i = 0; i < 20; i++) {
    const close = 1000 - i * 25;
    candlesInput.push({ time: '2026-01-' + String(i + 1).padStart(2, '0'), open: close + 10, high: close + 20, low: close - 10, close, volume: 1000 + i });
  }
  for (let i = 0; i < 10; i++) {
    const close = 520 + i * 20;
    candlesInput.push({ time: '2026-02-' + String(i + 1).padStart(2, '0'), open: close - 10, high: close + 20, low: close - 20, close, volume: 2000 + i });
  }

  const fib = quoteTest.calculateFibonacciLevels(candlesInput);
  assert.ok(fib, 'expected Fibonacci levels for a valid series');
  assert.equal(fib.trend, 'downward_retracement');

  // In a rebound, Fib 23.6% sits NEAR the low and Fib 78.6% sits NEAR the high.
  assert.ok(
    fib.levels.fib236 < fib.levels.fib786,
    `Fib 23.6% (${fib.levels.fib236}) must be lower/closer to the low than Fib 78.6% (${fib.levels.fib786})`
  );
  // Every level must stay inside the swing range.
  Object.keys(fib.levels).forEach((key) => {
    assert.ok(
      fib.levels[key] >= fib.swingLow && fib.levels[key] <= fib.swingHigh,
      `${key} (${fib.levels[key]}) must stay within [${fib.swingLow}, ${fib.swingHigh}]`
    );
  });
});

test('BUG-QUOTE-01b: upward retracement keeps measuring levels from the swing high', () => {
  const candlesInput = [];
  for (let i = 0; i < 20; i++) {
    const close = 500 + i * 25;
    candlesInput.push({ time: '2026-01-' + String(i + 1).padStart(2, '0'), open: close - 10, high: close + 20, low: close - 20, close, volume: 1000 + i });
  }
  // A shallow pullback that stays in the upper part of the range.
  for (let i = 0; i < 10; i++) {
    const close = 960 - i * 10;
    candlesInput.push({ time: '2026-02-' + String(i + 1).padStart(2, '0'), open: close + 10, high: close + 20, low: close - 20, close, volume: 2000 + i });
  }

  const fib = quoteTest.calculateFibonacciLevels(candlesInput);
  assert.ok(fib, 'expected Fibonacci levels for a valid series');
  assert.equal(fib.trend, 'upward_retracement');
  // Correction in an uptrend: 23.6% stays near the high, 78.6% near the low.
  assert.ok(
    fib.levels.fib236 > fib.levels.fib786,
    `Fib 23.6% (${fib.levels.fib236}) must stay above Fib 78.6% (${fib.levels.fib786}) in an uptrend`
  );
});

// ---------------------------------------------------------------------------
// BUG-QUOTE-05 — benchmark index symbols containing digits
// ---------------------------------------------------------------------------
test('BUG-QUOTE-05: ticker validation accepts BEI benchmark indices with digits', async () => {
  const accepted = ['LQ45', 'IDX30', 'IDX80', 'JII70', 'BBCA'];
  for (const ticker of accepted) {
    const res = makeRes();
    // No upstream call is expected to succeed in this environment; the point is
    // that validation must NOT reject the symbol with a 400.
    global.fetch = async () => ({ ok: false, json: async () => ({}) });
    try {
      await quote({ method: 'GET', query: { ticker }, headers: {} }, res);
    } finally {
      delete global.fetch;
    }
    assert.notEqual(res.code, 400, `${ticker} must not be rejected as an invalid ticker format`);
  }
});

test('BUG-QUOTE-05b: genuinely malformed tickers are still rejected with a standard error schema', async () => {
  for (const ticker of ['A', 'TOOLONGTICKER', 'BB CA', '$$$']) {
    const res = makeRes();
    await quote({ method: 'GET', query: { ticker }, headers: {} }, res);
    assert.equal(res.code, 400, `${ticker} must be rejected`);
    assert.equal(res.body.success, false, 'error responses must carry success:false');
    assert.ok(res.body.error, 'error responses must carry an error message');
  }
});

// ---------------------------------------------------------------------------
// BUG-QUOTE-06 — calcRSI must not leak NaN
// ---------------------------------------------------------------------------
test('BUG-QUOTE-06: calcRSI returns null (never NaN) on non-finite input', () => {
  assert.equal(quoteTest.calcRSI([1, 2, null, 4, 5, 6], 5), null);
  assert.equal(quoteTest.calcRSI([1, 2, NaN, 4, 5, 6], 5), null);
  assert.equal(quoteTest.calcRSI([1, 2, undefined, 4, 5, 6], 5), null);
  assert.equal(quoteTest.calcRSI([1, 2, Infinity, 4, 5, 6], 5), null);
  const result = quoteTest.calcRSI([1, 2, null, 4, 5, 6], 5);
  assert.equal(Number.isNaN(result), false, 'NaN must never escape calcRSI');
});

test('BUG-QUOTE-06b: calcRSI keeps its numeric contract on clean data', () => {
  assert.equal(quoteTest.calcRSI([1, 2, 3, 4, 5, 6], 5), 100);
  assert.equal(quoteTest.calcRSI([6, 5, 4, 3, 2, 1], 5), 0);
  assert.equal(quoteTest.calcRSI([5, 5, 5, 5, 5, 5], 5), 50);
  assert.equal(quoteTest.calcRSI([1, 2], 5), null);
  assert.equal(quoteTest.calcRSI(null, 5), null);
});

// ---------------------------------------------------------------------------
// BUG-QUOTE-04 — floors.applied must never be true with a null trigger
// ---------------------------------------------------------------------------
test('BUG-QUOTE-04: floors.applied is never true while floorTrigger is null', () => {
  // A quote with no risk floors triggered at all.
  const quotePayload = {
    success: true,
    last: 1000,
    ma20: 990,
    ma50: 980,
    ma100: 970,
    ma200: 960,
    rsi14: 55,
    volumeVsAvg20: 1.2,
    changePct: 0.5,
    high52w: 1200,
    low52w: 800
  };
  const board = { is_active: true, board_type: 'main', last_price: 1000 };
  const guard = quoteTest.calculateRiskGuard(quotePayload, board);
  assert.ok(guard && guard.floors, 'risk guard must expose a floors object');
  if (guard.floors.applied === true) {
    assert.ok(guard.floors.trigger, 'floors.applied=true requires a non-null trigger');
  } else {
    assert.equal(guard.floors.trigger, null);
  }
});

// ---------------------------------------------------------------------------
// BUG-CAN-01 — Pattern Map access follows the admin session, not a username
// ---------------------------------------------------------------------------
test('BUG-CAN-01: hasPatternMapAccess grants any valid admin session', () => {
  const original = require('../lib/admin-session');
  const stub = {
    requireAdminSession: () => ({ ok: true, session: { un: 'admin' } })
  };
  const modulePath = require.resolve('../lib/admin-session');
  const cached = require.cache[modulePath];
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports: stub };
  try {
    const freshCandles = freshRequire('../api/candles.js');
    assert.equal(
      freshCandles.__test.hasPatternMapAccess({}),
      true,
      'an authenticated admin session must be able to read Pattern Map regardless of username'
    );
    stub.requireAdminSession = () => ({ ok: false });
    const deniedCandles = freshRequire('../api/candles.js');
    assert.equal(
      deniedCandles.__test.hasPatternMapAccess({}),
      false,
      'an unauthenticated request must still be denied'
    );
  } finally {
    if (cached) require.cache[modulePath] = cached; else delete require.cache[modulePath];
    require.cache[require.resolve('../api/candles.js')] = undefined;
    delete require.cache[require.resolve('../api/candles.js')];
    void original;
  }
});

test('BUG-CAN-01b: private pattern payload fields are only stripped for non-admins', () => {
  const payload = {
    success: true,
    ticker: 'BBCA',
    patternMap: { points: [] },
    classicPatterns: [{ name: 'Double Bottom' }]
  };
  // A caller with no session gets the public projection.
  const publicView = candlesTest.responseForRequest(payload, { headers: {} });
  assert.equal(publicView.patternMap, undefined);
  assert.equal(publicView.classicPatterns, undefined);
  // The original object is never mutated.
  assert.ok(payload.patternMap, 'responseForRequest must not mutate its input');
});

// ---------------------------------------------------------------------------
// BUG-CAN-03 — candles ticker validation accepts benchmark indices
// ---------------------------------------------------------------------------
test('BUG-CAN-03: candles endpoint accepts benchmark index symbols with digits', async () => {
  for (const ticker of ['LQ45', 'IDX30', 'IHSG']) {
    const res = makeRes();
    global.fetch = async () => ({ ok: false, json: async () => ({}) });
    try {
      await candles({ method: 'GET', query: { ticker }, headers: {} }, res);
    } finally {
      delete global.fetch;
    }
    assert.notEqual(res.code, 400, `${ticker} must not be rejected as an invalid ticker format`);
  }
});

test('BUG-CAN-03b: malformed candles tickers are rejected with a standard error schema', async () => {
  for (const ticker of ['A', 'TOOLONGTICKER', 'BB CA']) {
    const res = makeRes();
    await candles({ method: 'GET', query: { ticker }, headers: {} }, res);
    assert.equal(res.code, 400, `${ticker} must be rejected`);
    assert.equal(res.body.success, false, 'error responses must carry success:false');
    assert.ok(res.body.error, 'error responses must carry an error message');
  }
});

// ---------------------------------------------------------------------------
// BUG-CAN-02 — OHLC validation must reject non-finite legs
// ---------------------------------------------------------------------------
test('BUG-CAN-02: candles parser drops rows with non-finite OHLC legs', async () => {
  candlesTest.clearCache();
  const rows = [
    { timestamp: 1784000000, open: 100, high: 105, low: 95, close: 102, volume: 1000 },
    { timestamp: 1784086400, open: NaN, high: 105, low: 95, close: 102, volume: 1000 },
    { timestamp: 1784172800, open: 100, high: null, low: 95, close: 102, volume: 1000 },
    { timestamp: 1784259200, open: 100, high: 105, low: undefined, close: 102, volume: 1000 },
    { timestamp: 1784345600, open: 100, high: 105, low: 95, close: Infinity, volume: 1000 },
    { timestamp: 1784432000, open: 100, high: 105, low: 95, close: 103, volume: 1200 }
  ];
  global.fetch = async () => ({ ok: true, json: async () => yahooPayload(rows) });
  try {
    const res = makeRes();
    await candles({ method: 'GET', query: { ticker: 'BBCA' }, headers: { cookie: adminCookie() } }, res);
    assert.ok(Array.isArray(res.body.candles), 'expected a candles array');
    res.body.candles.forEach((candle) => {
      ['open', 'high', 'low', 'close'].forEach((leg) => {
        assert.ok(
          Number.isFinite(candle[leg]),
          `candle ${candle.time} leg ${leg} must be finite, got ${candle[leg]}`
        );
      });
    });
  } finally {
    delete global.fetch;
    candlesTest.clearCache();
  }
});

// ---------------------------------------------------------------------------
// BUG-CAN-04 — volume ratio stays within its documented contract
// ---------------------------------------------------------------------------
test('BUG-CAN-04: calcVolumeRatio keeps the trailing-window contract and never returns NaN', () => {
  // Contract fixed by test/chart-t1-candles.test.js (the SSOT for this
  // endpoint): the averaging window is the trailing `period` bars, and the
  // ratio is the latest volume over that average.
  const volumes = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
  const ratio = candlesTest.calcVolumeRatio(volumes, 2400, 20);
  assert.equal(Number.isFinite(ratio), true, 'ratio must be a finite number');
  assert.equal(ratio, 2.29); // mean(100..2000) = 1050 -> 2400/1050

  // Degenerate inputs must degrade to 0 rather than NaN/Infinity.
  assert.equal(candlesTest.calcVolumeRatio([], 100, 20), 0);
  assert.equal(candlesTest.calcVolumeRatio([0, 0, 0], 100, 20), 0);
  assert.equal(candlesTest.calcVolumeRatio(volumes, 0, 20), 0);
  assert.equal(candlesTest.calcVolumeRatio(volumes, NaN, 20), 0);
  assert.equal(candlesTest.calcVolumeRatio(null, 100, 20), 0);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeRes() {
  const res = {
    code: null,
    body: null,
    headers: {},
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(key, value) { this.headers[key] = value; return this; },
    end() { return this; }
  };
  return res;
}

function freshRequire(relativePath) {
  const resolved = require.resolve(relativePath);
  delete require.cache[resolved];
  const loaded = require(relativePath);
  delete require.cache[resolved];
  return loaded;
}

function adminCookie() {
  // The tests that need an admin session stub the session module directly; this
  // helper exists so the cookie shape stays realistic for the public path.
  return 'autocuan_admin_session=test';
}

function yahooPayload(rows) {
  return {
    chart: {
      result: [{
        timestamp: rows.map((r) => r.timestamp),
        indicators: {
          quote: [{
            open: rows.map((r) => r.open),
            high: rows.map((r) => r.high),
            low: rows.map((r) => r.low),
            close: rows.map((r) => r.close),
            volume: rows.map((r) => r.volume)
          }]
        }
      }]
    }
  };
}
