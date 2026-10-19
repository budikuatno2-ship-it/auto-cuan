'use strict';

// B1 (security): the unauthenticated /data/* route must be default-deny.
//
// These tests pin down the allowlist decision for every path shape an attacker
// (or the legitimate frontend) can send, and assert that the dev/production
// origin actually applies the gate before serving any file from data/.
//
// Only path strings and HTTP status codes are used; no premium file content is
// read or printed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isAllowedDataPath, ALLOWED_INDEX_PREFIX } = require('../lib/data-route-allowlist');

// ---------------------------------------------------------------------------
// Allowlisted paths (the ONLY legitimate unauthenticated consumer)
// ---------------------------------------------------------------------------
test('B1: the exact allowlisted bandarmologi intel indexes are served', () => {
  const allowed = [
    '/data/bandarmologi-intel-indexes/latest_1d.json',
    '/data/bandarmologi-intel-indexes/latest_5d.json',
    '/data/bandarmologi-intel-indexes/latest_7d.json',
    '/data/bandarmologi-intel-indexes/latest_14d.json',
    '/data/bandarmologi-intel-indexes/latest_30d.json',
    '/data/bandarmologi-intel-indexes/latest_60d.json',
    // Relative-to-DATA_DIR form used by serveData()
    '/bandarmologi-intel-indexes/latest_7d.json',
    'bandarmologi-intel-indexes/latest_7d.json',
    // query strings are stripped by the router before this check; verify that
    // a bare path still matches when the caller passes the pre-split path.
    '/data/bandarmologi-intel-indexes/latest_7d.json'
  ];
  for (const p of allowed) assert.equal(isAllowedDataPath(p), true, 'should allow: ' + p);
});

test('B1: the consumer code and allowlist prefix stay in agreement', () => {
  const runtime = fs.readFileSync(path.join(__dirname, '..', 'public', 'bandarmologi-runtime.js'), 'utf8');
  // The frontend must request exactly the allowlisted prefix.
  assert.match(runtime, /\/data\/bandarmologi-intel-indexes\/latest_/);
  assert.equal(ALLOWED_INDEX_PREFIX, 'bandarmologi-intel-indexes/latest_');
});

// ---------------------------------------------------------------------------
// Default-deny: everything else is refused
// ---------------------------------------------------------------------------
test('B1: premium and unrelated data paths are all refused', () => {
  const denied = [
    '/data/daily-candles/AADI.json',
    '/data/broker-hunter-indexes/AG-7d.json',
    '/data/arjum-data/broker-summary/BBCA/latest.json',
    '/data/insider-network/network.json',
    '/data/screener-latest.json',
    '/data/daytrade-ohlcv-cache/BBCA.json',
    '/data/.env',
    '/data/.git/config',
    '/data/bandarmologi-intel-indexes/catalog.json',
    // latest.json (no range suffix) is NOT a consumer path; keep it denied.
    '/data/bandarmologi-intel-indexes/latest.json',
    '/data/bandarmologi-intel-indexes/latest_7d.json.bak',
    '/data/bandarmologi-intel-indexes/latest_7d',
    '/data/bandarmologi-intel-indexes/latest_7d.csv',
    '/data/bandarmologi-intel-indexes/prefix_latest_7d.json',
    '/data/bandarmologi-intel-indexes/latest_7d/../../secret.json',
    '/data/bandarmologi-intel-indexes/../broker-hunter-indexes/AG-7d.json',
    '/data/',
    '/data',
    ''
  ];
  for (const p of denied) assert.equal(isAllowedDataPath(p), false, 'should deny: ' + p);
});

// ---------------------------------------------------------------------------
// Traversal / encoding defences
// ---------------------------------------------------------------------------
test('B1: traversal, backslash and NUL cannot reach an allowed prefix', () => {
  const attacks = [
    '/data/bandarmologi-intel-indexes/../broker-hunter-indexes/AG-7d.json',
    '/data/bandarmologi-intel-indexes/..%2fbroker-hunter-indexes/AG-7d.json',
    '/data/bandarmologi-intel-indexes/%2e%2e/broker-hunter-indexes/AG-7d.json',
    // double-encoded: after one decode this is "..%2fbroker-hunter-indexes/AG-7d.json"
    '/data/bandarmologi-intel-indexes/latest_7d.json%252f..%252f..%252f.env',
    '/data/bandarmologi-intel-indexes\\..\\broker-hunter-indexes\\AG-7d.json',
    '/data/bandarmologi-intel-indexes/latest_7d.json\u0000.env',
    '/data/bandarmologi-intel-indexes/./latest_7d.json',
    '/data/bandarmologi-intel-indexes/latest_../7d.json'
  ];
  for (const p of attacks) assert.equal(isAllowedDataPath(p), false, 'traversal must be denied: ' + p);
});

// ---------------------------------------------------------------------------
// Server wiring: the origin applies the gate before serving data/
// ---------------------------------------------------------------------------
test('B1: local-dev-server applies the allowlist and answers 404 for non-allowlisted data', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'local-dev-server.js'), 'utf8');
  assert.match(src, /const \{ isAllowedDataPath \} = require\('\.\.\/lib\/data-route-allowlist'\)/);
  // The gate must run before serveData is invoked for /data/.
  const gateIdx = src.indexOf("if (!isAllowedDataPath(pathname))");
  const serveIdx = src.indexOf('serveData(req,res,pathname.slice');
  assert.ok(gateIdx >= 0, 'the /data/ gate must exist');
  assert.ok(serveIdx >= 0, 'serveData must still be reachable for allowlisted paths');
  assert.ok(gateIdx < serveIdx, 'the 404 gate must be evaluated before serveData');
  // The refusal is a 404 (not 403) so protected files are not disclosed.
  assert.match(src, /res\.statusCode = 404;[\s\S]{0,120}404 Not Found/);
});

// ---------------------------------------------------------------------------
// Real repo data (when present) follows the same rule
// ---------------------------------------------------------------------------
test('B1: a real bandarmologi index is allowed while a real candle export is refused', () => {
  const idx = path.join(__dirname, '..', 'data', 'bandarmologi-intel-indexes', 'latest_7d.json');
  const candle = path.join(__dirname, '..', 'data', 'daily-candles', 'AADI.json');
  if (fs.existsSync(idx)) assert.equal(isAllowedDataPath('/data/bandarmologi-intel-indexes/latest_7d.json'), true);
  if (fs.existsSync(candle)) assert.equal(isAllowedDataPath('/data/daily-candles/AADI.json'), false);
});