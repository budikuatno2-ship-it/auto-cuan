'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const adminNotesHandler = require('../lib/admin-notes-handler.js');
const {
  validateTickSize,
  checkForbiddenWords,
  calculateInitialStatus,
  evaluateNoteStatus
} = adminNotesHandler;

test('Catatan Admin Backend Validation: BEI Tick Size Rules', () => {
  // < 200: step 1
  assert.equal(validateTickSize(50, 'Price').valid, true);
  assert.equal(validateTickSize(125, 'Price').valid, true);
  assert.equal(validateTickSize(199, 'Price').valid, true);
  assert.equal(validateTickSize(0, 'Price').valid, false); // invalid zero
  assert.equal(validateTickSize(-50, 'Price').valid, false); // invalid negative

  // 200 - 500: step 2
  assert.equal(validateTickSize(200, 'Price').valid, true);
  assert.equal(validateTickSize(250, 'Price').valid, true);
  assert.equal(validateTickSize(251, 'Price').valid, false);
  assert.equal(validateTickSize(498, 'Price').valid, true);
  assert.equal(validateTickSize(499, 'Price').valid, false);

  // 500 - 2000: step 5
  assert.equal(validateTickSize(500, 'Price').valid, true);
  assert.equal(validateTickSize(1250, 'Price').valid, true);
  assert.equal(validateTickSize(1252, 'Price').valid, false);
  assert.equal(validateTickSize(1995, 'Price').valid, true);
  assert.equal(validateTickSize(1998, 'Price').valid, false);

  // 2000 - 5000: step 10
  assert.equal(validateTickSize(2000, 'Price').valid, true);
  assert.equal(validateTickSize(3450, 'Price').valid, true);
  assert.equal(validateTickSize(3455, 'Price').valid, false);
  assert.equal(validateTickSize(4990, 'Price').valid, true);

  // >= 5000: step 25
  assert.equal(validateTickSize(5000, 'Price').valid, true);
  assert.equal(validateTickSize(8975, 'Price').valid, true);
  assert.equal(validateTickSize(8980, 'Price').valid, false);
  assert.equal(validateTickSize(9000, 'Price').valid, true);
});

test('Catatan Admin Backend Validation: Forbidden Promotional Words Rejection', () => {
  const forbidden = [
    'pasti naik besok',
    'saham ini dijamin cuan',
    'ada jaminan terbang',
    'wajib beli sekarang',
    'harus beli jangan sampai ketinggalan',
    'investasi tanpa risiko',
    'strategi anti rugi 100%',
    'profit 100% modal balik',
    'segera all in di sini',
    'langsung hajar kanan bos'
  ];

  for (const phrase of forbidden) {
    const res = checkForbiddenWords(phrase);
    assert.equal(res.found, true, `Should detect forbidden words in: "${phrase}"`);
    assert.ok(res.word, `Should report matching forbidden word in: "${phrase}"`);
  }

  // Permitted analytical descriptions
  const validReasons = [
    'Akumulasi broker asing konsisten 3 hari berturut di area support 8.800.',
    'Breakout pola ascending triangle volume meningkat 2x rata-rata 20 hari.',
    'Peluang swing trading dengan rasio risk:reward 1:2,5.'
  ];

  for (const reason of validReasons) {
    const res = checkForbiddenWords(reason);
    assert.equal(res.found, false, `Should allow neutral reasoning: "${reason}"`);
  }
});

test('Catatan Admin Backend Validation: Status Lifecycle & Target Evaluation', () => {
  // calculateInitialStatus
  assert.equal(calculateInitialStatus(8900, 8800, 9000, 8500), 'Di area pantau');
  assert.equal(calculateInitialStatus(9200, 8800, 9000, 8500), 'Menunggu harga turun ke area');
  assert.equal(calculateInitialStatus(8600, 8800, 9000, 8500), 'Di bawah area pantau');

  const baseNote = {
    zone_lo: 8800,
    zone_hi: 9000,
    target: 9500,
    risk_limit: 8500,
    status: 'Di area pantau',
    expires_at: new Date(Date.now() + 86400000).toISOString()
  };

  // 1. In zone
  const evaluatedInZone = evaluateNoteStatus({ ...baseNote }, { high: 8950, low: 8850, price: 8900 });
  assert.equal(evaluatedInZone.status, 'Di area pantau');

  // 2. Above zone but below target
  const evaluatedAboveZone = evaluateNoteStatus({ ...baseNote }, { high: 9100, low: 9050, price: 9075 });
  assert.equal(evaluatedAboveZone.status, 'Menunggu harga turun ke area');

  // 3. Below zone but above risk limit
  const evaluatedBelowZone = evaluateNoteStatus({ ...baseNote }, { high: 8750, low: 8650, price: 8700 });
  assert.equal(evaluatedBelowZone.status, 'Di bawah area pantau');

  // 4. Hit target (high >= target)
  const evaluatedTarget = evaluateNoteStatus({ ...baseNote }, { high: 9500, low: 8900, price: 9475 });
  assert.equal(evaluatedTarget.status, 'Kena target');
  assert.ok(evaluatedTarget.result_pct > 6.0 && evaluatedTarget.result_pct < 7.0);

  // 5. Hit stop loss (low <= risk_limit)
  const evaluatedSl = evaluateNoteStatus({ ...baseNote }, { high: 8800, low: 8450, price: 8475 });
  assert.equal(evaluatedSl.status, 'Kena batas risiko');
  assert.ok(evaluatedSl.result_pct < -4.0 && evaluatedSl.result_pct > -5.0);

  // 6. Expired
  const expiredNote = {
    ...baseNote,
    expires_at: new Date(Date.now() - 3600000).toISOString()
  };
  const evaluatedExpired = evaluateNoteStatus(expiredNote, null);
  assert.equal(evaluatedExpired.status, 'Kedaluwarsa');
});

test('Catatan Admin UI Integration: Markup, Routes, and Banners', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // Page container
  assert.ok(indexHtml.includes('id="page-catatan-admin"'), 'Must have #page-catatan-admin');
  assert.ok(indexHtml.includes('id="anActiveGrid"'), 'Must have #anActiveGrid');
  assert.ok(indexHtml.includes('id="anHistoryTableBody"'), 'Must have #anHistoryTableBody');
  assert.ok(indexHtml.includes('id="btnNewAdminNote"'), 'Must have #btnNewAdminNote');
  assert.ok(indexHtml.includes('id="adminNoteDrawer"'), 'Must have #adminNoteDrawer');
  assert.ok(indexHtml.includes('id="anTickerInput"'), 'Must have #anTickerInput');
  assert.ok(indexHtml.includes('id="anTargetInput"'), 'Must have #anTargetInput');
  assert.ok(indexHtml.includes('id="anRiskLimitInput"'), 'Must have #anRiskLimitInput');

  // Route support
  assert.ok(indexHtml.includes("path === '/catatan-admin'"), 'Route /catatan-admin mapped in parseAppRoute');
  assert.ok(indexHtml.includes("getCanonicalRouteUrl"), 'getCanonicalRouteUrl must handle catatan-admin');
  assert.ok(indexHtml.includes("'catatan-admin': 'catatan-admin'"), 'prevMap must include catatan-admin');

  // Mandatory disclaimer
  assert.ok(indexHtml.includes('Bukan rekomendasi beli atau jual') || indexHtml.includes('bukan ajakan atau rekomendasi beli atau jual'), 'Must state not buy/sell recommendation');
  assert.ok(indexHtml.includes('Keputusan dan risikonya sepenuhnya di tangan masing-masing'), 'Must state user responsibility');

  // Dashboard integration section
  assert.ok(indexHtml.includes('id="adminNotesDashboardSection"'), 'Must have dashboard section');

  // Workstation chart banner
  assert.ok(indexHtml.includes('id="catatanAdminChartBanner"'), 'Must have chart banner in index.html');

  // Partial check
  const partialHtml = fs.readFileSync(path.join(__dirname, '../public/partials/analisis-saham.partial.html'), 'utf8');
  assert.ok(partialHtml.includes('id="catatanAdminChartBanner"'), 'Must have chart banner in analisis-saham partial');
});
