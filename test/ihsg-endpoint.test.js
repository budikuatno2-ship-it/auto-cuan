'use strict';

// ===========================================================================
// IHSG disk-first contract (hermetic).
//
// Both /api/candles?ticker=IHSG and lib/market-regime read
// `process.cwd()/data/daily-candles/IHSG.json`. That file is GITIGNORED runtime
// data, so this test must generate its own fixture and run inside a temp cwd —
// otherwise it only passes on a developer machine that happens to hold the real
// cache and fails on a clean CI clone.
//
// Covered contract:
//   1. /api/candles?ticker=IHSG serves the disk cache (not Yahoo).
//   2. marketRegime.fetchIhsgDailyCandles reads the same disk cache.
//   3. During market hours the live Yahoo intraday bar is appended/updated
//      without discarding the historical disk series.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const candles = require('../api/candles');
const marketRegime = require('../lib/market-regime');

const LAST_DISK_DATE = '2026-10-16';
const LAST_DISK_CLOSE = 5185.1;
const LAST_DISK_VOLUME = 64872651800;
const CANDLE_COUNT = 600;

function buildIhsgFixture() {
  const rows = [];
  // Walk backwards over calendar days, keeping weekdays only, until we have
  // CANDLE_COUNT sessions. The final row is the LAST_DISK_* contract row.
  let cursor = new Date(LAST_DISK_DATE + 'T00:00:00Z');
  for (let i = 0; i < CANDLE_COUNT; i++) {
    while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) {
      cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
    }
    const date = cursor.toISOString().slice(0, 10);
    const isLast = i === 0;
    const close = isLast ? LAST_DISK_CLOSE : Math.round((5000 + (i % 40) * 3.25) * 100) / 100;
    rows.push({
      date,
      open: close - 10,
      high: close + 15,
      low: close - 20,
      close,
      volume: isLast ? LAST_DISK_VOLUME : 50000000000 + i * 1000
    });
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
  }
  return { code: 'IHSG', source: 'fixture', candles: rows.sort((a, b) => a.date.localeCompare(b.date)) };
}

function withIhsgFixture(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ihsg-fixture-'));
  const dir = path.join(tmp, 'data', 'daily-candles');
  fs.mkdirSync(dir, { recursive: true });
  const fixture = buildIhsgFixture();
  fs.writeFileSync(path.join(dir, 'IHSG.json'), JSON.stringify(fixture));

  const previousCwd = process.cwd();
  process.chdir(tmp);
  return Promise.resolve()
    .then(() => fn(fixture))
    .finally(() => {
      try { process.chdir(previousCwd); } catch (_) {}
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
      try { candles.__test.resetPatternDetector(); } catch (_) {}
      try { candles.__test.clock.now = () => new Date(); } catch (_) {}
      try { candles.__test.clearCache(); } catch (_) {}
      try { delete global.fetch; } catch (_) {}
    });
}

test('Langkah 1: /api/candles?ticker=IHSG reads disk cache when available', async () => {
  await withIhsgFixture(async () => {
    candles.__test.clearCache();
    candles.__test.clock.now = () => new Date('2026-10-19T10:00:00+07:00');
    // Any network call would be a contract violation: the disk cache must win.
    global.fetch = async () => { throw new Error('network must not be used for IHSG disk-first'); };

    const req = { method: 'GET', query: { ticker: 'IHSG' }, headers: {} };
    let jsonOutput = null;
    const res = {
      statusCode: 200,
      setHeader: () => {},
      status: function(code) { this.statusCode = code; return this; },
      json: function(data) { jsonOutput = data; return this; }
    };

    await candles(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(jsonOutput.success, true);
    assert.equal(jsonOutput.ticker, 'IHSG');
    assert.equal(jsonOutput.source, 'Data Historis T-1');
    assert.equal(jsonOutput.totalCandles >= 500, true);
    assert.equal(jsonOutput.latest.date, LAST_DISK_DATE);
    assert.equal(jsonOutput.latest.last, LAST_DISK_CLOSE);
    assert.equal(jsonOutput.latest.volume, LAST_DISK_VOLUME);
  });
});

test('Langkah 1: marketRegime.fetchIhsgDailyCandles reads disk cache', async () => {
  await withIhsgFixture(async () => {
    const daily = await marketRegime.fetchIhsgDailyCandles({ skipLive: true });
    assert.equal(Array.isArray(daily), true);
    assert.equal(daily.length >= 500, true);
    const last = daily[daily.length - 1];
    assert.equal(last.date, LAST_DISK_DATE);
    assert.equal(Math.round(last.close * 10) / 10, LAST_DISK_CLOSE);
  });
});

test('C3 [BUG FIX]: marketRegime.fetchIhsgDailyCandles appends live intraday bar to historical disk series', async () => {
  await withIhsgFixture(async () => {
    const origFetch = global.fetch;
    try {
      // Mock global fetch to return an intraday bar for Monday 2026-10-19 at 10:00 WIB
      global.fetch = async (url) => {
        if (String(url).includes('%5EJKSE')) {
          return {
            ok: true,
            json: async () => ({
              chart: {
                result: [{
                  timestamp: [Math.floor(new Date('2026-10-19T03:00:00Z').getTime() / 1000)], // 10:00 WIB
                  indicators: {
                    quote: [{
                      close: [5250.75]
                    }]
                  }
                }]
              }
            })
          };
        }
        return origFetch(url);
      };

      const candlesWithLive = await marketRegime.fetchIhsgDailyCandles();
      assert.equal(Array.isArray(candlesWithLive), true);
      // Preserves all historical bars (+1 live bar)
      assert.equal(candlesWithLive.length >= CANDLE_COUNT + 1, true);

      // Latest bar is today's live intraday price from Yahoo
      const liveBar = candlesWithLive[candlesWithLive.length - 1];
      assert.equal(liveBar.date, '2026-10-19');
      assert.equal(liveBar.close, 5250.75);

      // Previous bar remains the last disk session
      const prevBar = candlesWithLive[candlesWithLive.length - 2];
      assert.equal(prevBar.date, LAST_DISK_DATE);
      assert.equal(Math.round(prevBar.close * 10) / 10, LAST_DISK_CLOSE);

      // Market regime is evaluated using live 5250.75 instead of the stale close
      const regime = await marketRegime.getMarketRegime();
      assert.ok(regime);
      assert.ok(regime.market_regime_label);
    } finally {
      global.fetch = origFetch;
    }
  });
});
