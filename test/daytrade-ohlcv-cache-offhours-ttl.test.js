'use strict';

/**
 * The market-aware cache TTL must actually be able to serve a cache hit.
 *
 * lib/daytrade-ohlcv-cache.js documents the intent plainly:
 *
 *   "During IDX market hours (Mon-Fri 09:00-15:30 WIB), use the configured TTL.
 *    Outside market hours, extend TTL significantly (12 hours) since data won't
 *    change."
 *
 * But fetchWithCache gated the market-aware check behind the RAW check:
 *
 *   if (cached.hit && !cached.stale && cached.candles.length >= 20) {
 *     if (isCacheFresh(cached.updatedAtMs, nowMs, ttlMs)) { ... return cached }
 *   }
 *
 * `cached.stale` comes from readCache, which compares against the raw ttlMs
 * (15 minutes) and knows nothing about market hours. So the outer gate is
 * strictly stricter than the inner one and the 12-hour window could never widen
 * anything: outside market hours every scan re-fetched from Yahoo after 15
 * minutes, for data that cannot have changed because the exchange is shut.
 *
 * More Yahoo calls is not a neutral cost here — upstream timeouts on this exact
 * provider are what BUG-018 was about.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cache = require('../lib/daytrade-ohlcv-cache');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** A WIB wall-clock moment expressed as an epoch ms value. */
function wib(dateStr, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  // The stored instant is WIB minus 7h in UTC.
  return Date.parse(dateStr + 'T00:00:00Z') + (h - 7) * HOUR + m * MINUTE;
}

// 2026-09-03 is a Thursday; 2026-09-05 is a Saturday.
const THURSDAY_MIDDAY = wib('2026-09-03', '11:00');   // inside 09:00-15:30
const THURSDAY_EVENING = wib('2026-09-03', '18:00');  // after close
const THURSDAY_EARLY = wib('2026-09-03', '07:00');    // before open
const SATURDAY_MIDDAY = wib('2026-09-05', '11:00');   // weekend

function candles(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ time: 1700000000 + i * 86400, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
  }
  return out;
}

/**
 * Drive fetchWithCache against a REAL cache file on disk with a fixed clock,
 * recording whether the upstream fetch was reached. No module internals are
 * patched, so the test exercises the same path production takes.
 */
async function run(t, nowMs, cacheAgeMs, cacheCandleCount) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohlcv-cache-test-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  fs.writeFileSync(path.join(dir, 'BBCA.json'), JSON.stringify({
    version: 1,
    ticker: 'BBCA',
    source: 'yahoo',
    updated_at: new Date(nowMs - cacheAgeMs).toISOString(),
    candles: candles(cacheCandleCount == null ? 60 : cacheCandleCount)
  }));

  const realNow = Date.now;
  Date.now = () => nowMs;
  t.after(() => { Date.now = realNow; });

  let fetched = false;
  const provider = cache.createCacheProvider({
    cacheDir: dir,
    ttlMs: 15 * MINUTE,
    fetchFn: async () => { fetched = true; return candles(60); }
  });

  const result = await provider.fetchWithCache('BBCA');
  return { fetched, result, stats: provider.getStats() };
}

// --- getEffectiveTtl: the intent, stated directly -------------------------

test('1. getEffectiveTtl returns 12h outside market hours and the raw TTL inside', () => {
  const ttl = 15 * MINUTE;
  assert.strictEqual(cache.getEffectiveTtl(ttl, THURSDAY_MIDDAY), ttl, 'inside hours');
  assert.strictEqual(cache.getEffectiveTtl(ttl, THURSDAY_EVENING), 12 * HOUR, 'after close');
  assert.strictEqual(cache.getEffectiveTtl(ttl, THURSDAY_EARLY), 12 * HOUR, 'before open');
  assert.strictEqual(cache.getEffectiveTtl(ttl, SATURDAY_MIDDAY), 12 * HOUR, 'weekend');
});

test('2. isCacheFresh already honours the market-aware TTL', () => {
  const ttl = 15 * MINUTE;
  assert.strictEqual(cache.isCacheFresh(THURSDAY_EVENING - 30 * MINUTE, THURSDAY_EVENING, ttl), true);
  assert.strictEqual(cache.isCacheFresh(THURSDAY_MIDDAY - 30 * MINUTE, THURSDAY_MIDDAY, ttl), false);
});

// --- fetchWithCache: does the intent actually reach the caller? ------------

test('3. outside market hours a 30-minute-old cache is SERVED, not refetched', async (t) => {
  const out = await run(t, THURSDAY_EVENING, 30 * MINUTE);
  assert.strictEqual(
    out.fetched, false,
    'the exchange is shut and the data cannot have changed — this must be a cache hit'
  );
  assert.strictEqual(out.stats.cacheHit, 1);
  assert.strictEqual(out.result.length, 60);
});

test('4. on a weekend a 6-hour-old cache is SERVED', async (t) => {
  const out = await run(t, SATURDAY_MIDDAY, 6 * HOUR);
  assert.strictEqual(out.fetched, false);
  assert.strictEqual(out.stats.cacheHit, 1);
});

test('5. outside market hours a 13-hour-old cache is still refetched', async (t) => {
  const out = await run(t, THURSDAY_EVENING, 13 * HOUR);
  assert.strictEqual(out.fetched, true, 'beyond the 12-hour window the cache must not be served');
});

// --- during market hours nothing changes ----------------------------------

test('6. during market hours a 30-minute-old cache is refetched (unchanged)', async (t) => {
  const out = await run(t, THURSDAY_MIDDAY, 30 * MINUTE);
  assert.strictEqual(out.fetched, true, 'inside hours the 15-minute TTL still applies');
});

test('7. during market hours a 5-minute-old cache is served (unchanged)', async (t) => {
  const out = await run(t, THURSDAY_MIDDAY, 5 * MINUTE);
  assert.strictEqual(out.fetched, false);
  assert.strictEqual(out.stats.cacheHit, 1);
});

test('8. a cache with too few candles is never served, in or out of hours', async (t) => {
  const inside = await run(t, THURSDAY_MIDDAY, 1 * MINUTE, 10);
  assert.strictEqual(inside.fetched, true);
});

test('9. a short cache outside hours is refetched too', async (t) => {
  const outside = await run(t, THURSDAY_EVENING, 30 * MINUTE, 10);
  assert.strictEqual(outside.fetched, true);
});
