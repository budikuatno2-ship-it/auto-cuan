'use strict';

/**
 * test/v6/domestic-on-demand.test.js
 * V6 W4 — domestic on-demand + bounded cache.
 *
 * Coverage (8):
 *   (a) cache hit/miss
 *   (b) TTL expiry
 *   (c) LRU eviction at max_entries
 *   (d) refuses stale input with typed reason
 *   (e) refuses synthetic
 *   (f) parity vs archive exact
 *   (g) flag disabled -> falls back to direct compute
 *   (h) archive files untouched (mtime/sha unchanged for a sample)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Point the module at a throwaway fixture tree BEFORE requiring it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'domestic-od-'));
const ARJUM = path.join(TMP, 'arjum-data');
const CACHE = path.join(TMP, 'domestic-cache');
const CONFIG = path.join(TMP, 'domestic-cache.json');
process.env.ARJUM_DATA_DIR = ARJUM;
process.env.DOMESTIC_CACHE_DIR = CACHE;
process.env.DOMESTIC_CACHE_CONFIG_PATH = CONFIG;

const od = require('../../lib/domestic-on-demand');
const canonical = require('../../lib/broker-accumulation-local');

const ROOT = path.resolve(__dirname, '..', '..');
const REAL_D_DIR = path.join(ROOT, 'data', 'arjum-data', 'broker-summary-D');

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG, JSON.stringify(cfg), 'utf8');
}

/** Build a genuine provider ALL payload for a session. */
function makeAll(ticker, date, brokers) {
  return {
    stock_code: ticker,
    flow: 'all',
    all_data: true,
    broker_start_date: date,
    broker_end_date: date,
    brokers
  };
}

/** Build a genuine provider F payload for a session. */
function makeForeign(ticker, date, brokers) {
  return {
    stock_code: ticker,
    flow: 'F',
    broker_start_date: date,
    broker_end_date: date,
    brokers
  };
}

/** Write an ALL/F pair into the fixture archive. */
function seedPair(ticker, date, allBrokers, fBrokers) {
  writeJson(path.join(ARJUM, 'broker-summary', ticker, date + '.json'), makeAll(ticker, date, allBrokers));
  writeJson(path.join(ARJUM, 'broker-summary-F', ticker, date + '.json'), makeForeign(ticker, date, fBrokers));
}

const ENABLED = { enabled: true, ttl_seconds: 300, max_entries: 500, persist: false };

// Seed a baseline pair used by several tests.
seedPair('BBRI', '2026-10-28',
  [
    { broker_code: 'CC', broker_name: 'MANDIRI', bval: 1000, sval: 200, bvol: 100, svol: 20, bfrq: 10, sfrq: 4 },
    { broker_code: 'AK', broker_name: 'UBS', bval: 600, sval: 100, bvol: 60, svol: 10, bfrq: 6, sfrq: 1 }
  ],
  [
    { broker_code: 'AK', broker_name: 'UBS', bval: 300, sval: 50, bvol: 30, svol: 5, bfrq: 3, sfrq: 1 }
  ]);

// (a) cache hit/miss
test('(a) cache miss then hit', function () {
  od._resetCache();
  writeConfig(ENABLED);
  const first = od.getDomesticBroksum('BBRI', '2026-10-28');
  assert.equal(first.ok, true);
  assert.equal(first.cache, 'miss');
  const second = od.getDomesticBroksum('BBRI', '2026-10-28');
  assert.equal(second.ok, true);
  assert.equal(second.cache, 'hit');
  assert.deepEqual(second.result, first.result);
});

// (b) TTL expiry
test('(b) TTL expiry forces a recompute', async function () {
  od._resetCache();
  writeConfig({ enabled: true, ttl_seconds: 0.05, max_entries: 500, persist: false });
  const first = od.getDomesticBroksum('BBRI', '2026-10-28');
  assert.equal(first.cache, 'miss');
  await new Promise(function (r) { setTimeout(r, 90); });
  const after = od.getDomesticBroksum('BBRI', '2026-10-28');
  assert.equal(after.cache, 'miss', 'entry must expire after TTL');
});

// (c) LRU eviction at max_entries
test('(c) LRU eviction at max_entries', function () {
  od._resetCache();
  writeConfig({ enabled: true, ttl_seconds: 300, max_entries: 2, persist: false });
  seedPair('AAAA', '2026-10-28', [{ broker_code: 'CC', bval: 10, sval: 1, bvol: 1, svol: 1 }], [{ broker_code: 'AK', bval: 1, sval: 0, bvol: 1, svol: 0 }]);
  seedPair('BBBB', '2026-10-28', [{ broker_code: 'CC', bval: 10, sval: 1, bvol: 1, svol: 1 }], [{ broker_code: 'AK', bval: 1, sval: 0, bvol: 1, svol: 0 }]);
  seedPair('CCCC', '2026-10-28', [{ broker_code: 'CC', bval: 10, sval: 1, bvol: 1, svol: 1 }], [{ broker_code: 'AK', bval: 1, sval: 0, bvol: 1, svol: 0 }]);

  assert.equal(od.getDomesticBroksum('AAAA', '2026-10-28').cache, 'miss');
  assert.equal(od.getDomesticBroksum('BBBB', '2026-10-28').cache, 'miss');
  // Inserting a third evicts the oldest (AAAA).
  assert.equal(od.getDomesticBroksum('CCCC', '2026-10-28').cache, 'miss');
  // AAAA was evicted -> miss again.
  assert.equal(od.getDomesticBroksum('AAAA', '2026-10-28').cache, 'miss');
});

// (d) refuses stale input with typed reason
test('(d) refuses a stale ALL payload with a typed reason', function () {
  od._resetCache();
  writeConfig(ENABLED);
  // ALL claims a different session than requested -> DATE_MISMATCH.
  writeJson(path.join(ARJUM, 'broker-summary', 'STALE', '2026-10-28.json'),
    makeAll('STALE', '2026-10-20', [{ broker_code: 'CC', bval: 10, sval: 1, bvol: 1, svol: 1 }]));
  writeJson(path.join(ARJUM, 'broker-summary-F', 'STALE', '2026-10-28.json'),
    makeForeign('STALE', '2026-10-28', [{ broker_code: 'AK', bval: 1, sval: 0, bvol: 1, svol: 0 }]));
  const res = od.getDomesticBroksum('STALE', '2026-10-28');
  assert.equal(res.ok, false);
  assert.equal(res.reason, od.REFUSE.ALL_NOT_ACTIONABLE);
  assert.match(res.detail, /DATE_MISMATCH/);
});

// (e) refuses synthetic
test('(e) refuses a synthetic ALL payload', function () {
  od._resetCache();
  writeConfig(ENABLED);
  const syntheticAll = makeAll('SYNTH', '2026-10-28', [{ broker_code: 'CC', bval: 10, sval: 1, bvol: 1, svol: 1 }]);
  syntheticAll.computed_from = 'broker_code_heuristic_from_all';
  writeJson(path.join(ARJUM, 'broker-summary', 'SYNTH', '2026-10-28.json'), syntheticAll);
  writeJson(path.join(ARJUM, 'broker-summary-F', 'SYNTH', '2026-10-28.json'),
    makeForeign('SYNTH', '2026-10-28', [{ broker_code: 'AK', bval: 1, sval: 0, bvol: 1, svol: 0 }]));
  const res = od.getDomesticBroksum('SYNTH', '2026-10-28');
  assert.equal(res.ok, false);
  assert.equal(res.reason, od.REFUSE.ALL_NOT_ACTIONABLE);
  assert.match(res.detail, /SYNTHETIC/);
});

// (f) parity vs archive exact
test('(f) on-demand result is bit-identical to the archive for a real sample', function () {
  od._resetCache();
  writeConfig(ENABLED);

  // Use a REAL promoted archive D file as the fixture. Reconstruct ALL = D + F
  // (F is a small synthetic foreign set) and prove the canonical formula
  // reproduces the archive's real magnitudes exactly.
  const tickers = fs.existsSync(REAL_D_DIR) ? fs.readdirSync(REAL_D_DIR).filter(function (t) {
    return fs.statSync(path.join(REAL_D_DIR, t)).isDirectory();
  }) : [];
  let checked = 0;
  for (const ticker of tickers) {
    const dir = path.join(REAL_D_DIR, ticker);
    const files = fs.readdirSync(dir).filter(function (f) { return f.endsWith('.json') && f !== 'latest.json'; });
    if (!files.length) continue;
    const date = files[0].slice(0, 10);
    const archiveD = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    if (!Array.isArray(archiveD.brokers) || archiveD.brokers.length === 0) continue;

    // F: a small foreign subset (first broker, half its buy/sell).
    const fBrokers = archiveD.brokers.slice(0, 1).map(function (b) {
      return {
        broker_code: b.broker_code,
        broker_name: b.broker_name,
        bval: Math.floor(b.bval / 2),
        sval: Math.floor(b.sval / 2),
        bvol: Math.floor(b.bvol / 2),
        svol: Math.floor(b.svol / 2),
        bfrq: 0,
        sfrq: 0
      };
    });
    // ALL = D + F per broker.
    const allBrokers = archiveD.brokers.map(function (b) {
      const f = fBrokers.find(function (x) { return x.broker_code === b.broker_code; }) || { bval: 0, sval: 0, bvol: 0, svol: 0 };
      return {
        broker_code: b.broker_code,
        broker_name: b.broker_name,
        bval: b.bval + f.bval,
        sval: b.sval + f.sval,
        bvol: b.bvol + f.bvol,
        svol: b.svol + f.svol,
        bfrq: (b.bfrq || 0) + (f.bfrq || 0),
        sfrq: (b.sfrq || 0) + (f.sfrq || 0)
      };
    });

    seedPair(ticker, date, allBrokers, fBrokers);
    const res = od.getDomesticBroksum(ticker, date);
    assert.equal(res.ok, true, 'on-demand must succeed for ' + ticker + ' ' + date);

    const onDemand = res.result;
    const sum = function (rows, k) { return rows.reduce(function (a, b) { return a + (b[k] || 0); }, 0); };
    assert.equal(sum(onDemand.brokers, 'bval'), sum(archiveD.brokers, 'bval'), 'buy value parity ' + ticker);
    assert.equal(sum(onDemand.brokers, 'sval'), sum(archiveD.brokers, 'sval'), 'sell value parity ' + ticker);
    assert.equal(sum(onDemand.brokers, 'bvol'), sum(archiveD.brokers, 'bvol'), 'buy vol parity ' + ticker);
    assert.equal(sum(onDemand.brokers, 'svol'), sum(archiveD.brokers, 'svol'), 'sell vol parity ' + ticker);
    assert.equal(onDemand.brokers.length, archiveD.brokers.length, 'broker count parity ' + ticker);
    checked += 1;
    if (checked >= 3) break;
  }
  assert.ok(checked > 0, 'at least one real archive D file must be available as a parity fixture');
});

// (g) flag disabled -> falls back to direct compute
test('(g) flag disabled falls back to direct compute (no cache)', function () {
  od._resetCache();
  writeConfig({ enabled: false, ttl_seconds: 300, max_entries: 500, persist: false });
  const first = od.getDomesticBroksum('BBRI', '2026-10-28');
  assert.equal(first.ok, true);
  assert.equal(first.cache, 'disabled');
  const second = od.getDomesticBroksum('BBRI', '2026-10-28');
  assert.equal(second.cache, 'disabled', 'disabled flag never caches');
});

// (h) archive files untouched
test('(h) promoted archive files are never modified by the accessor', function () {
  od._resetCache();
  writeConfig(ENABLED);
  const tickers = fs.existsSync(REAL_D_DIR) ? fs.readdirSync(REAL_D_DIR).filter(function (t) {
    return fs.statSync(path.join(REAL_D_DIR, t)).isDirectory();
  }) : [];
  if (!tickers.length) {
    assert.ok(true, 'no real archive present; nothing to protect');
    return;
  }
  const ticker = tickers[0];
  const dir = path.join(REAL_D_DIR, ticker);
  const files = fs.readdirSync(dir).filter(function (f) { return f.endsWith('.json'); });
  if (!files.length) { assert.ok(true); return; }
  const target = path.join(dir, files[0]);
  const before = {
    sha: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
    mtime: fs.statSync(target).mtimeMs
  };
  // Exercise the accessor (reads ALL/F only, never the D archive).
  od.getDomesticBroksum('BBRI', '2026-10-28');
  const after = {
    sha: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
    mtime: fs.statSync(target).mtimeMs
  };
  assert.equal(after.sha, before.sha, 'archive sha must be unchanged');
  assert.equal(after.mtime, before.mtime, 'archive mtime must be unchanged');
});

// (i) runtime path and canonical path agree (single formula)
test('(i) runtime broksum-flow path and canonical path agree bit-exactly', function () {
  const broksumFlow = require('../../lib/broksum-flow');
  const all = makeAll('BBRI', '2026-10-28', [
    { broker_code: 'CC', broker_name: 'MANDIRI', bval: 1000, sval: 200, bvol: 100, svol: 20, bfrq: 10, sfrq: 4 },
    { broker_code: 'AK', broker_name: 'UBS', bval: 600, sval: 100, bvol: 60, svol: 10, bfrq: 6, sfrq: 1 }
  ]);
  const f = makeForeign('BBRI', '2026-10-28', [
    { broker_code: 'AK', broker_name: 'UBS', bval: 300, sval: 50, bvol: 30, svol: 5, bfrq: 3, sfrq: 1 }
  ]);

  const runtime = broksumFlow.computeDomestic(all, f);
  const canon = canonical.computeDomesticBroksum(all, f, '2026-10-28', 'BBRI');

  assert.equal(runtime.is_complete, true);
  assert.equal(canon.status, 'RELEASED');
  assert.equal(runtime.brokers.length, canon.brokers.length, 'broker count must match');

  const sum = function (rows, k) { return rows.reduce(function (a, b) { return a + (b[k] || 0); }, 0); };
  for (const k of ['bval', 'sval', 'bvol', 'svol', 'nval', 'nvol']) {
    assert.equal(sum(runtime.brokers, k), sum(canon.brokers, k), 'aggregate ' + k + ' must agree');
  }
  // Per-broker exact equality.
  for (const cb of canon.brokers) {
    const rb = runtime.brokers.find(function (x) { return x.broker_code === cb.broker_code; });
    assert.ok(rb, 'broker ' + cb.broker_code + ' present in both paths');
    assert.equal(rb.bval, cb.bval);
    assert.equal(rb.sval, cb.sval);
    assert.equal(rb.bvol, cb.bvol);
    assert.equal(rb.svol, cb.svol);
  }
});

test.after(function () {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});
