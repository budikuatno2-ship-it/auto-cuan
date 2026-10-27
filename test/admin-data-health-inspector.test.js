'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const adminConsoleHtml = fs.readFileSync(path.join(ROOT, 'public', 'admin-console.html'), 'utf8');
const adminUsersHandler = require('../api/admin-users');
const { inspectDataHealth } = require('../lib/admin-console-service');
const { createSessionToken } = require('../lib/admin-session');

test('inspectDataHealth returns all 7 dataset categories with truthful metrics and no internal names', () => {
  const result = inspectDataHealth(ROOT);

  assert.ok(result);
  assert.equal(result.total_categories, 7, 'must inspect exactly 7 data categories');
  assert.ok(Array.isArray(result.categories));
  assert.equal(result.categories.length, 7);

  const categoryIds = result.categories.map(c => c.id);
  assert.deepEqual(categoryIds, [
    'broker_summary_all',
    'broker_summary_foreign',
    'broker_summary_domestic',
    'candle_eod_volume',
    'broker_accumulation_hunter',
    'insider_network_ksei',
    'hot_sectors_intel_screener'
  ]);

  // Overall status must be one of 'ok', 'warn', 'bad'
  assert.ok(['ok', 'warn', 'bad'].includes(result.overall_status));
  assert.ok(result.overall_label);

  // Check Category 1: Broker Summary - Semua (ALL)
  const catAll = result.categories.find(c => c.id === 'broker_summary_all');
  assert.equal(catAll.metrics.total_universe, 962);
  assert.ok(catAll.metrics.complete_count >= 0, 'complete_count should be tracked from disk');
  assert.ok(catAll.metrics.pending_count >= 0);
  assert.ok(typeof catAll.metrics.latest_trade_date === 'string', 'latest trade date should be extracted from disk archive');

  // Check Category 2: Broker Summary - Asing (Foreign / F)
  const catForeign = result.categories.find(c => c.id === 'broker_summary_foreign');
  assert.equal(catForeign.metrics.total_universe, 962);
  assert.ok(['ok', 'warn', 'bad'].includes(catForeign.status_code));

  // Check Category 3: Broker Summary - Domestik (Domestik / D)
  const catDomestik = result.categories.find(c => c.id === 'broker_summary_domestic');
  assert.equal(catDomestik.metrics.calculation_formula, 'ALL - F');

  // Check Category 4: Candle Harian EOD & Volume Bursa
  const catCandle = result.categories.find(c => c.id === 'candle_eod_volume');
  assert.equal(catCandle.metrics.total_universe, 962);
  assert.ok(catCandle.metrics.active_candle_count >= 1);
  assert.ok(catCandle.metrics.total_candles > 0);
  assert.ok(catCandle.metrics.anomaly_bars_count >= 0);

  // Check Category 5: Akumulasi Broker & Indeks Broker Hunter
  const catHunter = result.categories.find(c => c.id === 'broker_accumulation_hunter');
  assert.equal(catHunter.metrics.hunter_indexes_count, 463, 'must count exactly 463 broker hunter index files');
  assert.deepEqual(catHunter.metrics.accumulation_horizons, ['1H', '3H', '5H', '20H']);
  assert.equal(catHunter.status_code, 'ok');

  // Check Category 6: Jejaring Insider & Kepemilikan KSEI
  const catInsider = result.categories.find(c => c.id === 'insider_network_ksei');
  assert.equal(catInsider.metrics.total_entities, 11219, 'must verify 11,219 KSEI entities in database');
  assert.equal(catInsider.metrics.total_tickers, 962, 'must cover 962 tickers');
  assert.equal(catInsider.metrics.ksei_release_date, '30 Sep 2026');
  assert.equal(catInsider.status_code, 'ok');

  // Check Category 7: Sektor Hot, Sinyal Intelijen & Screener
  const catIntel = result.categories.find(c => c.id === 'hot_sectors_intel_screener');
  assert.equal(catIntel.metrics.intel_catalogs_count, 14, 'must count 14 bandarmologi intel catalog files');
  assert.equal(catIntel.status_code, 'ok');

  // Verify Zero forbidden internal names across all categories
  for (const c of result.categories) {
    const text = JSON.stringify(c).toLowerCase();
    assert.ok(!text.includes('arjum'), `forbidden internal name 'arjum' found in ${c.id}`);
    assert.ok(!text.includes('vps'), `forbidden internal name 'vps' found in ${c.id}`);
    assert.ok(!text.includes('crontab'), `forbidden internal name 'crontab' found in ${c.id}`);
  }
});

test('api/admin-users enforces strict 403 Forbidden for non-admin on data_health_inspect', async () => {
  process.env.SESSION_SECRET = 'test_secret_32_bytes_super_safe_admin_test';

  // 1. Unauthenticated request -> 401
  const reqUnauth = {
    method: 'POST',
    headers: { host: 'autocuan.web.id' },
    body: { action: 'data_health_inspect' }
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

  // 2. Authenticated non-admin request -> 403 Forbidden
  const nonAdminToken = createSessionToken({ userId: 'usr_normal', username: 'regular_user', isAdmin: false });
  const reqNonAdmin = {
    method: 'POST',
    headers: {
      host: 'autocuan.web.id',
      cookie: `ac_sess=${nonAdminToken}`
    },
    body: { action: 'data_health_inspect' }
  };
  let codeForbidden = 0;
  let jsonForbidden = null;
  const resForbidden = {
    status(c) { codeForbidden = c; return this; },
    json(j) { jsonForbidden = j; return this; }
  };
  await adminUsersHandler(reqNonAdmin, resForbidden);
  assert.equal(codeForbidden, 403, 'expected 403 Forbidden for non-admin user');
  assert.equal(jsonForbidden.success, false);

  // 3. Authenticated admin request -> 200 OK with data_health
  const adminToken = createSessionToken({ userId: 'usr_admin', username: 'budi', isAdmin: true });
  const reqAdmin = {
    method: 'POST',
    headers: {
      host: 'autocuan.web.id',
      cookie: `ac_sess=${adminToken}`
    },
    body: { action: 'data_health_inspect' }
  };
  let codeAdmin = 0;
  let jsonAdmin = null;
  const resAdmin = {
    status(c) { codeAdmin = c; return this; },
    json(j) { jsonAdmin = j; return this; }
  };
  await adminUsersHandler(reqAdmin, resAdmin);
  assert.equal(codeAdmin, 200, 'expected 200 OK for admin session');
  assert.equal(jsonAdmin.success, true);
  assert.ok(jsonAdmin.data_health);
  assert.equal(jsonAdmin.data_health.total_categories, 7);
});

test('public/admin-console.html includes complete Data Health Inspector UI and controls', () => {
  assert.ok(adminConsoleHtml.includes('Pemeriksa Kesehatan &amp; Kelengkapan Data'));
  assert.ok(adminConsoleHtml.includes('btnRefreshDataHealth'));
  assert.ok(adminConsoleHtml.includes('Periksa Ulang Status Data'));
  assert.ok(adminConsoleHtml.includes('dataHealthTbody'));
  assert.ok(adminConsoleHtml.includes('healthOverallBadge'));
  assert.ok(adminConsoleHtml.includes('refreshDataHealth'));
  assert.ok(adminConsoleHtml.includes('renderDataHealth'));
  assert.ok(adminConsoleHtml.includes('962 emiten'));
  assert.ok(adminConsoleHtml.includes('7 Kategori'));

  // Ensure no forbidden internal provider names appear anywhere in HTML
  assert.ok(!adminConsoleHtml.toLowerCase().includes('arjum'));
});
