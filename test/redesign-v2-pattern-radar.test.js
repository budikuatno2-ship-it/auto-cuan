'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const patternRadarHtml = fs.readFileSync(path.join(ROOT, 'public', 'pattern-radar.html'), 'utf8');
const adminUsersHandler = require('../api/admin-users');
const { createSessionToken } = require('../lib/admin-session');
const vercelJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const localDevServer = fs.readFileSync(path.join(ROOT, 'tools', 'local-dev-server.js'), 'utf8');

test('Pattern Radar server endpoint enforces authentication and 403 Forbidden for non-admin', async () => {
  process.env.SESSION_SECRET = 'test_secret_32_bytes_pattern_radar_super_safe';

  // 1. Unauthenticated request -> 401
  const reqUnauth = {
    method: 'POST',
    headers: { host: 'autocuan.web.id' },
    body: { action: 'pattern_radar_scan' }
  };
  let codeUnauth = 0;
  let jsonUnauth = null;
  const resUnauth = {
    status(c) { codeUnauth = c; return this; },
    json(j) { jsonUnauth = j; return this; }
  };
  await adminUsersHandler(reqUnauth, resUnauth);
  assert.equal(codeUnauth, 401, 'expected 401 for unauthenticated request');
  assert.equal(jsonUnauth.success, false);

  // 2. Non-admin request -> 403 Forbidden
  const normalToken = createSessionToken({ userId: 'usr_normal', username: 'regular_trader', isAdmin: false });
  const reqNonAdmin = {
    method: 'POST',
    headers: {
      host: 'autocuan.web.id',
      cookie: `ac_sess=${normalToken}`
    },
    body: { action: 'pattern_radar_scan' }
  };
  let codeForbidden = 0;
  let jsonForbidden = null;
  const resForbidden = {
    status(c) { codeForbidden = c; return this; },
    json(j) { jsonForbidden = j; return this; }
  };
  await adminUsersHandler(reqNonAdmin, resForbidden);
  assert.equal(codeForbidden, 403, 'expected 403 Forbidden for non-admin');
  assert.equal(jsonForbidden.success, false);
});

test('Pattern Radar server endpoint returns calculated pattern dataset for authorized admin', async () => {
  process.env.SESSION_SECRET = 'test_secret_32_bytes_pattern_radar_super_safe';

  const adminToken = createSessionToken({ userId: 'usr_admin', username: 'budi', isAdmin: true });
  const reqAdmin = {
    method: 'POST',
    headers: {
      host: 'autocuan.web.id',
      cookie: `ac_sess=${adminToken}`
    },
    body: { action: 'pattern_radar_scan', min_similarity: 85, pattern: 'all' }
  };
  let codeAdmin = 0;
  let jsonAdmin = null;
  const resAdmin = {
    status(c) { codeAdmin = c; return this; },
    json(j) { jsonAdmin = j; return this; }
  };
  await adminUsersHandler(reqAdmin, resAdmin);
  assert.equal(codeAdmin, 200);
  assert.equal(jsonAdmin.success, true);
  assert.equal(jsonAdmin.scanned_count, 840);
  assert.equal(jsonAdmin.horizon_days, 20);
  assert.ok(Array.isArray(jsonAdmin.rows));
  assert.ok(jsonAdmin.rows.length >= 3);

  // Verify rows structure
  for (const row of jsonAdmin.rows) {
    assert.ok(row.ticker);
    assert.ok(row.pattern);
    assert.ok(row.similarity >= 85);
    assert.ok(row.breakout > 0);
    assert.ok(row.target > 0);
    assert.ok(row.status);
    assert.ok(row.shape);
  }

  // Verify zero internal provider names or VPS infrastructure terms
  const payloadStr = JSON.stringify(jsonAdmin);
  assert.doesNotMatch(payloadStr, /arjum/i);
  assert.doesNotMatch(payloadStr, /vps/i);
});

test('Pattern Radar HTML markup contains canvas controls, tables, disclaimers, and 403 gate', () => {
  // Page header & kick
  assert.match(patternRadarHtml, /Admin · akses khusus/);
  assert.match(patternRadarHtml, /<h1>Pattern Radar<\/h1>/);

  // Filter Pola
  assert.match(patternRadarHtml, /id="patternSelect"/);
  assert.match(patternRadarHtml, /<option value="all">Semua pola<\/option>/);
  assert.match(patternRadarHtml, /<option value="Double Bottom">Double Bottom<\/option>/);
  assert.match(patternRadarHtml, /<option value="Bullish Flag">Bullish Flag<\/option>/);
  assert.match(patternRadarHtml, /<option value="Ascending Triangle">Ascending Triangle<\/option>/);

  // Slider Kemiripan min
  assert.match(patternRadarHtml, /id="minSimilarityRange"/);
  assert.match(patternRadarHtml, /min="80"/);
  assert.match(patternRadarHtml, /max="95"/);
  assert.match(patternRadarHtml, /value="85"/);
  assert.match(patternRadarHtml, /id="minSimilarityDisplay"/);

  // Horizon
  assert.match(patternRadarHtml, /Horizon <span class="mut" style="font-weight:500">20 hari bursa<\/span>/);

  // Scan button & progress
  assert.match(patternRadarHtml, /id="scanBtn"/);
  assert.match(patternRadarHtml, /id="cancelScanBtn"/);
  assert.match(patternRadarHtml, /id="scanProgressArea"/);
  assert.match(patternRadarHtml, /id="scanProgressBar"/);

  // Table headers
  assert.match(patternRadarHtml, /<th>Ticker<\/th>/);
  assert.match(patternRadarHtml, /<th>Pola<\/th>/);
  assert.match(patternRadarHtml, /<th[^>]*>Bentuk<\/th>/);
  assert.match(patternRadarHtml, /<th class="r">Kemiripan<\/th>/);
  assert.match(patternRadarHtml, /<th class="r">Area breakout<\/th>/);
  assert.match(patternRadarHtml, /<th class="r">Target proyeksi<\/th>/);
  assert.match(patternRadarHtml, /<th>Status validasi<\/th>/);

  // Table container overflow
  assert.match(patternRadarHtml, /overflow-x:\s*auto/);

  // Methodology & disclaimer
  assert.match(patternRadarHtml, /Metode/);
  assert.match(patternRadarHtml, /z-score \+ Pearson/);
  assert.match(patternRadarHtml, /Riwayat pendek/);
  assert.match(patternRadarHtml, /Target proyeksi adalah estimasi teknikal.*bukan.*keuntungan/i);

  // 403 Forbidden Screen for Non-Admin
  assert.match(patternRadarHtml, /id="adminDeniedScreen"/);
  assert.match(patternRadarHtml, /403 · Akses Khusus Administrator/);

  // Zero internal provider names or IP columns
  assert.doesNotMatch(patternRadarHtml, /arjum/i);
  assert.doesNotMatch(patternRadarHtml, /<th>Alamat IP<\/th>/i);
});

test('Pattern Radar route rewrites are present in vercel.json and local-dev-server.js', () => {
  const rewritePatternRadar = vercelJson.rewrites.find(r => r.source === '/pattern-radar');
  assert.ok(rewritePatternRadar, 'expected rewrite rule for /pattern-radar');
  assert.equal(rewritePatternRadar.destination, '/pattern-radar.html');

  const rewritePattern = vercelJson.rewrites.find(r => r.source === '/pattern');
  assert.ok(rewritePattern, 'expected rewrite rule for /pattern');
  assert.equal(rewritePattern.destination, '/index.html');

  assert.match(localDevServer, /'\/pattern-radar':\s*'\/pattern-radar\.html'/);
  assert.match(localDevServer, /'\/pattern':\s*'\/index\.html'/);
});
