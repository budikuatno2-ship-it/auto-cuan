'use strict';

/**
 * BATCH 3 / FASE 6 — Day-Trade OHLCV cache: TTL honesty, corruption handling
 * and the eviction/write race.
 *
 * Zero-trust: every assertion was reproduced against the REAL implementation
 * before it was touched (see scratch/batch3-probe*.js).
 *
 * The cache is the only candle source when the upstream provider is down, so
 * the two failure modes that matter are (a) SERVING something that is not real
 * data, and (b) REFUSING to serve real data because of a transient filesystem
 * race. Both are covered below.
 *
 * Network: none. All fixtures are local temp files; the provider fetchFn is
 * stubbed. Windows-specific rename semantics are simulated by patching
 * fs/promises, never by depending on the host OS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const cache = require('../lib/daytrade-ohlcv-cache');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohlcv-batch3-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

function candles(n, base) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      time: 1758000000 + i * 86400,
      date: '2026-06-' + String(1 + (i % 28)).padStart(2, '0'),
      open: (base || 100) + i,
      high: (base || 100) + i + 2,
      low: (base || 100) + i - 2,
      close: (base || 100) + i + 1,
      volume: 1000000 + i
    });
  }
  return out;
}

function writeRaw(dir, ticker, payload) {
  fs.writeFileSync(path.join(dir, ticker + '.json'), typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function cachedFile(dir, ticker, ageMs, count) {
  writeRaw(dir, ticker, {
    version: 1,
    ticker,
    source: 'fixture',
    updated_at: new Date(Date.now() - ageMs).toISOString(),
    candles: candles(count == null ? 30 : count)
  });
}

// ---------------------------------------------------------------------------
// F6-B3-01 — a corrupt cache file must be DISTINGUISHABLE from a missing one
// readCache returned the same `{ hit: false }` shape for "no file yet" and for
// "file exists but is unparseable". A consumer therefore could not tell a cold
// start from on-disk corruption, and nothing surfaced the corruption for
// repair. `corrupt` makes the difference observable.
// ---------------------------------------------------------------------------
test('F6-B3-01: a corrupt cache file must be flagged as corrupt, not as a cache miss', async (t) => {
  const dir = tmpdir(t);

  writeRaw(dir, 'TRUNCATED', '{"candles": [ {"open": 1, "cl');
  const truncated = await cache.readCache(dir, 'TRUNCATED', Date.now(), 15 * 60 * 1000);
  assert.equal(truncated.hit, false, 'a truncated file must never count as a hit');
  assert.equal(truncated.corrupt, true, 'truncated JSON must be reported as corrupt');
  assert.ok(truncated.error, 'the parse failure must stay observable for logging');

  writeRaw(dir, 'SHAPE', { updated_at: new Date().toISOString(), candles: 'not-an-array' });
  const wrongShape = await cache.readCache(dir, 'SHAPE', Date.now(), 15 * 60 * 1000);
  assert.equal(wrongShape.hit, false);
  assert.equal(wrongShape.corrupt, true, 'a wrong-shaped payload is corruption, not an empty cache');

  writeRaw(dir, 'EMPTY', { updated_at: new Date().toISOString(), candles: [] });
  const empty = await cache.readCache(dir, 'EMPTY', Date.now(), 15 * 60 * 1000);
  assert.equal(empty.hit, false);
  assert.notEqual(empty.corrupt, true, 'an empty (but valid) series is not corruption');

  const missing = await cache.readCache(dir, 'NEVER-WRITTEN', Date.now(), 15 * 60 * 1000);
  assert.equal(missing.hit, false);
  assert.notEqual(missing.corrupt, true, 'a file that does not exist must not be reported as corrupt');
});

test('F6-B3-01b: a corrupt cache is never served, even as an upstream-failure fallback', async (t) => {
  const dir = tmpdir(t);
  writeRaw(dir, 'BROKEN', '{"version": 1, "candles": [ {"time": 1, ');

  const provider = cache.createCacheProvider({
    cacheDir: dir,
    ttlMs: 15 * 60 * 1000,
    fetchFn: async () => { throw new Error('upstream down'); }
  });
  const result = await provider.fetchWithCache('BROKEN');

  assert.equal(result, null, 'corruption must fail closed: a broken file is not a stale-but-usable series');
  const stats = provider.getStats();
  assert.equal(stats.staleFallback, 0, 'a corrupt file must never be counted as a stale fallback');
  assert.equal(stats.fetchFail, 1);
});

// ---------------------------------------------------------------------------
// F6-B3-02 — a transient read failure must not masquerade as "no cache"
// On Windows, replacing a file that another handle has open raises EPERM, and
// a reader that lands exactly in that window got EPERM from readFile. The old
// code reported it as `hit: false` with no retry, so a perfectly good cache was
// treated as absent and a full upstream fetch was issued (or the caller got
// null when upstream was also down).
// ---------------------------------------------------------------------------
test('F6-B3-02: a transient EPERM/EACCES/EBUSY read must be retried, not reported as a miss', async (t) => {
  const dir = tmpdir(t);
  cachedFile(dir, 'RACED', 1000, 30);

  const realReadFile = fsp.readFile;
  let attempts = 0;
  fsp.readFile = async function (file, encoding) {
    attempts++;
    if (attempts <= 2) {
      const err = new Error('simulated transient lock');
      err.code = attempts === 1 ? 'EPERM' : 'EBUSY';
      throw err;
    }
    return realReadFile.call(fsp, file, encoding);
  };
  t.after(() => { fsp.readFile = realReadFile; });

  const res = await cache.readCache(dir, 'RACED', Date.now(), 15 * 60 * 1000);
  fsp.readFile = realReadFile;

  assert.equal(res.hit, true, 'a cache locked for two attempts must still be served');
  assert.equal(res.candles.length, 30);
  assert.ok(attempts >= 3, `the reader must have retried past the transient errors (attempts=${attempts})`);
});

test('F6-B3-02b: a persistent read failure is still reported as a miss (no infinite retry)', async (t) => {
  const dir = tmpdir(t);
  cachedFile(dir, 'LOCKED', 1000, 30);

  const realReadFile = fsp.readFile;
  let attempts = 0;
  fsp.readFile = async function () {
    attempts++;
    const err = new Error('simulated persistent lock');
    err.code = 'EPERM';
    throw err;
  };
  t.after(() => { fsp.readFile = realReadFile; });

  const res = await cache.readCache(dir, 'LOCKED', Date.now(), 15 * 60 * 1000);
  fsp.readFile = realReadFile;

  assert.equal(res.hit, false, 'a persistently unreadable file cannot be served');
  assert.ok(attempts >= 2 && attempts <= 20, `retries must be bounded (attempts=${attempts})`);
});

// ---------------------------------------------------------------------------
// F6-B3-03 — the atomic writer must never fall back to clobbering a non-file
// writeFileAtomic retried the rename and, after exhausting the retries, wrote
// the payload IN PLACE. That fallback is only sound when the destination is a
// regular file: against a directory the in-place write throws EISDIR *after*
// the temp file was created, and the caller cannot tell the two apart.
// ---------------------------------------------------------------------------
test('F6-B3-03: writeFileAtomic must refuse a directory destination without side effects', async (t) => {
  const dir = tmpdir(t);
  const destDir = path.join(dir, 'CACHE-as-directory');
  fs.mkdirSync(destDir);
  fs.writeFileSync(path.join(destDir, 'keep.txt'), 'keep');

  let thrown = null;
  try {
    await cache.writeFileAtomic(destDir, 'payload');
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, 'writing a payload over a directory must fail loudly, never silently');
  assert.equal(thrown.code, 'EISDIR', 'the error must identify the real cause');
  assert.ok(fs.statSync(destDir).isDirectory(), 'the directory must survive untouched');
  assert.equal(fs.readFileSync(path.join(destDir, 'keep.txt'), 'utf8'), 'keep', 'existing contents must survive');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp file may be left behind');
});

test('F6-B3-03b: a successful atomic replace never leaves a temp file behind', async (t) => {
  const dir = tmpdir(t);
  const target = path.join(dir, 'CACHE.json');
  fs.writeFileSync(target, 'OLD');

  const ok = await cache.writeFileAtomic(target, 'NEW');
  assert.equal(ok, true, 'the rename path must report success');
  assert.equal(fs.readFileSync(target, 'utf8'), 'NEW');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'temp files must be cleaned up');
});

// ---------------------------------------------------------------------------
// F6-B3-04 — the stale-fallback ceiling must be enforced AND observable
// A 200-day-old series was handed to the technical-analysis pipeline as if it
// were current. The ceiling exists (F3-007); this locks the observable
// counter so an operator can see the fallback being refused rather than
// guessing why a ticker went dark.
//
// CROSS-BATCH BLOCKER FIX (Batch 4, 24 Sept 2026) — WALL-CLOCK DETERMINISM.
// The "RECENT" fixture used to be 6 HOURS old, which is stale under the
// configured 15-minute TTL but FRESH under the 12-hour off-market TTL that
// getEffectiveTtl() applies on weekends, before 09:00 WIB and after 15:30 WIB.
// Outside market hours the entry was therefore served via the cacheHit path
// instead of the stale-fallback path, so `stats.staleFallback` stayed 0 and
// this assertion failed. Proof of the wall-clock dependency:
//   - Batch 3 CI run 35973008820 PASSED at 08:03:18Z (15:03 WIB, market hours)
//   - Batch 4 CI run 35979641392 FAILED at 09:10:40Z (16:10 WIB, after close)
// The fixture is now 13 HOURS old: longer than BOTH the 15-minute in-market
// TTL and the 12-hour off-market TTL, so the entry is genuinely stale in every
// window and the assertion is deterministic at any hour. The scenario under
// test (an in-window fallback is served AND counted) is unchanged — it still
// exercises the same branch of isUsableStaleFallback.
// ---------------------------------------------------------------------------
const OFF_MARKET_TTL_MS = 12 * HOUR_MS; // mirrors getEffectiveTtl outside IDX hours
const IN_WINDOW_STALE_AGE_MS = OFF_MARKET_TTL_MS + HOUR_MS; // 13h > both ceilings

test('F6-B3-04: an ancient cache is refused and counted, a recent one is served and counted', async (t) => {
  const dir = tmpdir(t);

  cachedFile(dir, 'ANCIENT', 200 * DAY_MS, 30);
  cachedFile(dir, 'RECENT', IN_WINDOW_STALE_AGE_MS, 30);

  const provider = cache.createCacheProvider({
    cacheDir: dir,
    ttlMs: 15 * 60 * 1000,
    fetchFn: async () => { throw new Error('upstream down'); }
  });

  const ancient = await provider.fetchWithCache('ANCIENT');
  assert.equal(ancient, null, 'a 200-day-old series must never be served as a fallback');
  const recent = await provider.fetchWithCache('RECENT');
  assert.ok(Array.isArray(recent) && recent.length >= 20, 'a 6-hour-old series is still operationally useful');

  const stats = provider.getStats();
  assert.equal(stats.staleRejected, 1, 'refusing an over-age fallback must be observable');
  assert.equal(stats.staleFallback, 1, 'serving an in-window fallback must be counted');
});

test('F6-B3-04b: the stale ceiling is configurable and an unverifiable write time is never usable', async (t) => {
  const dir = tmpdir(t);
  cachedFile(dir, 'TIGHT', 2 * DAY_MS, 30);

  const strict = cache.createCacheProvider({
    cacheDir: dir,
    ttlMs: 15 * 60 * 1000,
    maxStaleFallbackMs: DAY_MS,
    fetchFn: async () => { throw new Error('upstream down'); }
  });
  assert.equal(await strict.fetchWithCache('TIGHT'), null, 'a 2-day-old series exceeds a 1-day ceiling');

  const loose = cache.createCacheProvider({
    cacheDir: dir,
    ttlMs: 15 * 60 * 1000,
    maxStaleFallbackMs: 7 * DAY_MS,
    fetchFn: async () => { throw new Error('upstream down'); }
  });
  assert.ok(await loose.fetchWithCache('TIGHT'), 'the same series is usable under a 7-day ceiling');

  // A payload with no usable updated_at cannot be age-checked, so it is not a
  // legitimate fallback.
  writeRaw(dir, 'NOTIME', { version: 1, candles: candles(30) });
  const noTime = cache.createCacheProvider({
    cacheDir: dir,
    ttlMs: 15 * 60 * 1000,
    fetchFn: async () => { throw new Error('upstream down'); }
  });
  assert.equal(await noTime.fetchWithCache('NOTIME'), null, 'an unverifiable age must fail closed');
});

// ---------------------------------------------------------------------------
// F6-B3-05 — eviction/write race: concurrent writers must never tear the file
// The writer used to fall back to an in-place write when the rename was
// refused, which is exactly the torn-read window the atomic write exists to
// remove. Under six concurrent writers this produced observable corruption.
// ---------------------------------------------------------------------------
test('F6-B3-05: concurrent writers and readers must never observe a torn snapshot', async (t) => {
  const dir = tmpdir(t);
  const TICKER = 'RACE';
  await cache.writeCache(dir, TICKER, candles(30, 1), 'seed');
  const file = path.join(dir, TICKER + '.json');

  let torn = 0;
  let reads = 0;
  let stop = false;

  const readers = [];
  for (let r = 0; r < 3; r++) {
    readers.push((async () => {
      while (!stop) {
        reads++;
        try {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (!Array.isArray(parsed.candles) || parsed.candles.length === 0) torn++;
        } catch (_) {
          torn++;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })());
  }

  const writers = [];
  for (let w = 0; w < 6; w++) {
    writers.push((async () => {
      for (let i = 0; i < 25; i++) {
        await cache.writeCache(dir, TICKER, candles(30, 100 + w * 1000 + i), 'writer-' + w);
      }
    })());
  }

  await Promise.all(writers);
  stop = true;
  await Promise.all(readers);

  assert.ok(reads > 20, `the readers must actually interleave with the writers (only ${reads} reads)`);
  assert.equal(torn, 0, `${torn} of ${reads} concurrent reads observed a torn snapshot — writes must stay atomic`);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'concurrent writes must not leak temp files');
});

// ---------------------------------------------------------------------------
// F6-B3-06 — TTL honesty across the session boundary (regression lock)
// ---------------------------------------------------------------------------
test('F6-B3-06: the effective TTL widens outside IDX hours and stays strict inside', () => {
  const ttl = 15 * 60 * 1000;
  const thursdayMidday = Date.parse('2026-09-03T04:00:00Z'); // 11:00 WIB
  const thursdayEvening = Date.parse('2026-09-03T11:00:00Z'); // 18:00 WIB
  const saturdayMidday = Date.parse('2026-09-05T04:00:00Z');  // Saturday 11:00 WIB

  assert.equal(cache.getEffectiveTtl(ttl, thursdayMidday), ttl, 'inside hours the configured TTL applies');
  assert.equal(cache.getEffectiveTtl(ttl, thursdayEvening), 12 * HOUR_MS, 'after the close the window widens');
  assert.equal(cache.getEffectiveTtl(ttl, saturdayMidday), 12 * HOUR_MS, 'weekends widen the window');
});
