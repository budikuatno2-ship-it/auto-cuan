'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.VPS_FETCHER_ALLOW_IN_TESTS = '1';
process.env.VPS_SSH_KEY = path.join(os.tmpdir(), 'missing-key.pem');
process.env.VPS_DATA_API_BASE = 'http://127.0.0.1:1';

const vpsFetcher = require('../../lib/vps-data-fetcher');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-stale-'));
const tickerDir = path.join(tmpDir, 'broker-summary', 'TESTSTALE');
fs.mkdirSync(tickerDir, { recursive: true });
fs.writeFileSync(path.join(tickerDir, 'latest.json'), JSON.stringify({
  stock_code: 'TESTSTALE',
  date: '2026-09-22',
  brokers: [{ broker_code: 'YP', bval: 1000, bvol: 10 }]
}));

const liveMarketTime = Date.parse('2026-09-23T03:00:00Z'); // 10:00 WIB Wed
const offHoursTime = Date.parse('2026-09-23T13:00:00Z'); // 20:00 WIB Wed (offline max age 12h)

// Stale for off-hours: 20 hours old
const mtimeOffHours = (offHoursTime - 20 * 3600 * 1000) / 1000;
fs.utimesSync(path.join(tickerDir, 'latest.json'), mtimeOffHours, mtimeOffHours);

process.env.ARJUM_DATA_DIR = tmpDir;

let capturedWarnings = [];
const origWarn = console.warn;
console.warn = (...args) => { capturedWarnings.push(args.join(' ')); };

const origDateNow = Date.now;

try {
  // Test 1: Outside market hours (20:00 WIB Wed)
  Date.now = () => offHoursTime;

  vpsFetcher.__resetMemoryCaches();
  capturedWarnings = [];
  const res1 = vpsFetcher.fetchLivePriceFromVpsSync('TESTSTALE');
  assert.equal(res1.price_source, 'vps_local_cache_stale');
  const staleWarnings1 = capturedWarnings.filter(w => w.includes('vps_local_cache_stale'));
  assert.equal(staleWarnings1.length, 0, 'No stale warning outside market hours');
  process.stdout.write('Test 1 PASSED: Zero warning outside market hours\n');

  // Test 2: Mock market hours (10:00 WIB Wed) with 2h old snapshot (stale for live session <30m)
  Date.now = () => liveMarketTime;
  const mtimeLive = (liveMarketTime - 2 * 3600 * 1000) / 1000;
  fs.utimesSync(path.join(tickerDir, 'latest.json'), mtimeLive, mtimeLive);

  vpsFetcher.__resetMemoryCaches();
  capturedWarnings = [];
  const res2 = vpsFetcher.fetchLivePriceFromVpsSync('TESTSTALE');
  assert.equal(res2.price_source, 'vps_local_cache_stale');
  const staleWarnings2 = capturedWarnings.filter(w => w.includes('vps_local_cache_stale'));
  assert.equal(staleWarnings2.length, 1, 'Logged once in market hours');
  process.stdout.write('Test 2 PASSED: Logged once in market hours\n');

  // Test 3: Second call within 5 minutes during market hours
  Date.now = () => liveMarketTime + 5 * 60 * 1000;
  const tickerDir2 = path.join(tmpDir, 'broker-summary', 'TESTSTALE2');
  fs.mkdirSync(tickerDir2, { recursive: true });
  fs.writeFileSync(path.join(tickerDir2, 'latest.json'), JSON.stringify({
    stock_code: 'TESTSTALE2',
    date: '2026-09-22',
    brokers: [{ broker_code: 'YP', bval: 1000, bvol: 10 }]
  }));
  fs.utimesSync(path.join(tickerDir2, 'latest.json'), mtimeLive, mtimeLive);

  capturedWarnings = [];
  const res3 = vpsFetcher.fetchLivePriceFromVpsSync('TESTSTALE2');
  assert.equal(res3.price_source, 'vps_local_cache_stale');
  const staleWarnings3 = capturedWarnings.filter(w => w.includes('vps_local_cache_stale'));
  assert.equal(staleWarnings3.length, 0, 'Throttled within 10 min');
  process.stdout.write('Test 3 PASSED: Warning throttled within 10 min window\n');

  // Test 4: After 11 minutes
  Date.now = () => liveMarketTime + 11 * 60 * 1000;
  capturedWarnings = [];
  const res4 = vpsFetcher.fetchLivePriceFromVpsSync('TESTSTALE2');
  assert.equal(res4.price_source, 'vps_local_cache_stale');
  const staleWarnings4 = capturedWarnings.filter(w => w.includes('vps_local_cache_stale'));
  assert.equal(staleWarnings4.length, 1, 'Logged after 10 min window');
  process.stdout.write('Test 4 PASSED: Warning logged after 10 min window\n');

  process.stdout.write('ALL VERIFICATIONS PASSED!\n');
} finally {
  Date.now = origDateNow;
  console.warn = origWarn;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
