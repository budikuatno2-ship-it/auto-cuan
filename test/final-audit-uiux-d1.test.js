'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const puppeteer = require('puppeteer-core');

const root = path.resolve(__dirname, '..');
const publicRoot = path.join(root, 'public');
const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-cuan-d1-'));
const records = [
  { ticker: 'BBCA', free_float_pct: 20, hsc_flag: false, market_structure_guard: 'NORMAL' },
  { ticker: 'TLKM', free_float_pct: 0, hsc_flag: true, market_structure_guard: 'CAUTION' },
  { ticker: 'ASII', free_float_pct: null, hsc_flag: null, market_structure_guard: 'UNKNOWN' }
].map(row => ({ ...row, free_float_source: 'Local exchange fixture', free_float_as_of: '2026-10-05', hsc_source: 'Local HSC fixture', hsc_as_of: '2026-10-05', as_of_trade_date: '2026-10-05', regulatory_compliance_status: 'NOT_EVALUATED', market_structure_note: 'Referensi risiko, bukan putusan kepatuhan.' }));
let server, browser, page, origin, mode = 'success', detailReads = 0;
const evidence = [];
const record = (name, value) => evidence.push({ name, value });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

before(async () => {
  fs.mkdirSync(evidenceRoot, { recursive: true });
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      let body = ''; for await (const chunk of req) body += chunk;
      let input = {}; try { input = JSON.parse(body); } catch (_) {}
      const action = url.searchParams.get('action');
      let payload = { success: true, data: [], rows: [], results: [] };
      if (action === 'daily-market-context-list') {
        if (mode === 'loading') await pause(600);
        payload = mode === 'error' ? { success: false, error: 'Daftar fixture tidak tersedia. Coba lagi.' } : { success: true, data: mode === 'empty' ? [] : records };
      } else if (action === 'daily-market-context') {
        detailReads++;
        payload = { success: true, context: { market_structure: records.find(row => row.ticker === url.searchParams.get('ticker')) } };
      } else if (action === 'financial-snapshot') {
        payload = { success: true, snapshot: { fundamental: { pbv: 3, book_value_per_share: 3000, market_cap: 9000000000, shares_outstanding: 1000000, fundamental_period: 'Q3-2026', fundamental_source: 'Local verified filing', fundamental_updated_at: '2026-10-06' }, price: { last_price_as_of: '2026-10-05', last_price_source: 'Local EOD', freshness: 'fresh' } } };
      } else if (input.action === 'session-status') {
        payload = { success: true, userId: 'd1-local-user', username: 'auditfixture', isAdmin: false, isApproved: true, google_link_state: 'linked', google_link_required: false, email_required: false };
      } else if (input.action === 'account-google-status') {
        payload = { success: true, google_link_state: 'linked', google_linked: true, required: false };
      } else if (input.action === 'account-profile') {
        payload = { success: true, profile: { username: 'auditfixture', is_approved: true, is_admin: false, subscription: { entitlement: { premium: true } } } };
      } else if (url.pathname === '/api/maintenance-settings') {
        payload = { success: true, config: { maintenanceMode: false } };
      }
      res.writeHead(mode === 'error' && action === 'daily-market-context-list' ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload)); return;
    }
    const route = url.pathname === '/analisis-saham' ? '/analisis-saham.html' : url.pathname;
    const file = path.resolve(publicRoot, '.' + (path.extname(route) ? route : '/index.html'));
    if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, userDataDir: path.join(evidenceRoot, 'regression-profile'), args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', request => request.url().startsWith(origin + '/') ? request.continue() : request.abort());
  await page.evaluateOnNewDocument(() => {
    window.__d1Listeners = { document: 0, window: 0 };
    for (const [target, key] of [[document, 'document'], [window, 'window']]) {
      const original = target.addEventListener.bind(target);
      target.addEventListener = function (...args) { window.__d1Listeners[key]++; return original(...args); };
    }
  });
});
after(async () => {
  try { if (browser) await browser.close(); } finally {
    try { if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
    finally { fs.rmSync(evidenceRoot, { recursive: true, force: true }); }
  }
});
beforeEach(async () => {
  mode = 'success'; detailReads = 0;
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(origin + '/dashboard?page=analisis&tab=market-structure', { waitUntil: 'networkidle0' });
  await page.evaluate(() => { hideOnboardingGuide(true); setWorkspaceSidebarVisible(true); applyAppTheme('light'); });
  await page.waitForFunction(() => typeof loadStrukturPasarUniverse === 'function' && document.getElementById('marketStructureDataState')?.hidden);
});
const rows = () => page.$$eval('#marketStructureTableBody tr[data-ticker]', list => list.map(row => ({ ticker: row.dataset.ticker, text: row.innerText, visible: !!row.getBoundingClientRect().height, pressed: row.getAttribute('aria-pressed') })));
const search = async value => { await page.$eval('#marketStructureSearchInput', (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, value); };

test('D1 successful response displays three selectable records in the actual SPA template', async () => {
  const actual = await rows();
  record('STRUCTURE_SUCCESS_WITH_LIST', actual);
  assert.equal(actual.length, 3); assert.ok(actual.every(row => row.visible));
  assert.deepEqual(actual.map(row => row.ticker), ['TLKM', 'BBCA', 'ASII']);
  assert.equal(detailReads, 0, 'universe load must not fan out detail requests');
});
test('D1 search filters one ticker and clearing restores the universe', async () => {
  await search('BBCA'); assert.deepEqual((await rows()).map(row => row.ticker), ['BBCA']);
  await search(''); assert.equal((await rows()).length, 3);
});
test('D1 sort and reference filters preserve zero/missing and HSC tri-state', async () => {
  const actual = await rows();
  assert.match(actual.find(row => row.ticker === 'TLKM').text, /0%/);
  assert.match(actual.find(row => row.ticker === 'ASII').text, /—/);
  assert.match(actual.find(row => row.ticker === 'TLKM').text, /HSC Aktif/);
  assert.match(actual.find(row => row.ticker === 'BBCA').text, /Non-HSC/);
  assert.match(actual.find(row => row.ticker === 'ASII').text, /Belum terverifikasi/);
  await page.click('#marketStructureFilterLowFF'); assert.deepEqual((await rows()).map(row => row.ticker), ['TLKM']);
  await page.click('#marketStructureFilterHsc'); assert.deepEqual((await rows()).map(row => row.ticker), ['TLKM']);
  await page.click('#marketStructureFilterIncomplete'); assert.deepEqual((await rows()).map(row => row.ticker), ['ASII']);
  await page.click('#marketStructureFilterAll'); await page.select('#marketStructureSortSelect', 'ticker_asc');
  assert.deepEqual((await rows()).map(row => row.ticker), ['ASII', 'BBCA', 'TLKM']);
  record('MISSING_AND_TRISTATE', actual);
});
test('D1 keyboard selection opens supported detail and closes with list context preserved', async () => {
  await search('BBCA'); await page.select('#marketStructureSortSelect', 'ticker_asc');
  await page.focus('#marketStructureTableBody [data-ticker="BBCA"]');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineWidth);
  assert.ok(parseFloat(outline) >= 2);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.getElementById('marketStructureDetailPane').hidden);
  assert.equal(await page.$eval('#marketStructureFreeFloatSource', el => el.innerText), 'Local exchange fixture');
  assert.match(await page.$eval('#marketStructureFreeFloatAsOf', el => el.innerText), /2026-10-05/);
  assert.equal((await rows())[0].pressed, 'true');
  await page.click('#marketStructureDetailClose');
  assert.equal(await page.$eval('#marketStructureSearchInput', el => el.value), 'BBCA');
  assert.equal(await page.$eval('#marketStructureSortSelect', el => el.value), 'ticker_asc');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.ticker), 'BBCA');
  assert.deepEqual((await rows()).map(row => row.ticker), ['BBCA']);
});
test('D1 no search results and empty universe show a truthful empty result', async () => {
  await search('ZZZZ'); assert.equal((await rows()).length, 0);
  assert.match(await page.$eval('#marketStructureTableBody', el => el.innerText), /Tidak ada saham/);
  await search(''); mode = 'empty'; await page.evaluate(() => loadStrukturPasarUniverse());
  assert.equal((await rows()).length, 0);
  assert.match(await page.$eval('#marketStructureTableBody', el => el.innerText), /Tidak ada saham/);
});
test('D1 first request failure is an error, not empty success', async () => {
  mode = 'error'; await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.getElementById('marketStructureDataState')?.innerText.includes('Daftar fixture tidak tersedia'));
  assert.equal(await page.$eval('#marketStructureDataState', el => !!el.getBoundingClientRect().height), true);
  assert.equal((await rows()).length, 0);
  record('INITIAL_FAILURE', await page.$eval('#marketStructureDataState', el => el.innerText));
});
test('D1 failed refresh retains valid rows with a local error notice', async () => {
  mode = 'error'; await page.evaluate(() => loadStrukturPasarUniverse());
  assert.equal((await rows()).length, 3);
  assert.match(await page.$eval('#marketStructureRefreshBanner', el => el.innerText), /Gagal memperbarui/);
  assert.equal(await page.$eval('#marketStructureRefreshBanner', el => !!el.getBoundingClientRect().height), true);
});
test('D1 repeated navigation retains controls and does not duplicate rows or listeners', async () => {
  await search('BBCA'); await page.select('#marketStructureSortSelect', 'ticker_asc');
  const before = await page.evaluate(() => ({ ...window.__d1Listeners }));
  for (let i = 0; i < 5; i++) { await page.evaluate(() => navigateTo('dashboard')); await page.evaluate(() => navigateTo('analisis', 'market-structure')); await pause(100); }
  const after = await page.evaluate(() => window.__d1Listeners);
  assert.deepEqual(after, before); assert.equal((await rows()).length, 1);
  assert.equal(await page.$$eval('#marketStructureSearchInput', els => els.length), 1);
  assert.equal(await page.$eval('#marketStructureSearchInput', el => el.value), 'BBCA');
  await search(''); assert.equal((await rows()).length, 3);
  record('REPEATED_NAVIGATION', { before, after });
});
for (const [theme, width] of [['light',320],['light',390],['light',768],['light',1024],['light',1440],['light',1920],['dark',390],['dark',1440]]) {
  test(`D1 ${theme} ${width}: populated list, usable detail, keyboard return and no page overflow`, async () => {
    await page.setViewport({ width, height: 900 }); await page.evaluate(theme => applyAppTheme(theme), theme); await pause(100);
    assert.equal((await rows()).length, 3); assert.ok((await rows()).every(row => row.visible));
    const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, font: getComputedStyle(document.getElementById('marketStructureSearchInput')).fontSize, controls: [...document.querySelectorAll('#panel-tab-market-structure button,#marketStructureSearchInput,#marketStructureSortSelect')].filter(el => el.getBoundingClientRect().width).map(el => ({ id: el.id, height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width })) }));
    record('MATRIX_GEOMETRY', { theme, ...geometry });
    assert.ok(geometry.scroll <= geometry.client + 1, JSON.stringify(geometry));
    if (width < 1024) { assert.equal(geometry.font, '16px'); assert.ok(geometry.controls.every(control => control.height >= 44 && control.width >= 44)); }
    await search('TLKM'); await page.focus('#marketStructureTableBody [data-ticker="TLKM"]'); await page.keyboard.press('Enter'); await pause(100);
    const closeId = width < 1024 ? 'marketStructureSheetClose' : 'marketStructureDetailClose';
    assert.equal(await page.$eval(width < 1024 ? '#marketStructureSheetFreeFloat' : '#marketStructureFreeFloat', el => el.innerText), '0%');
    if (width < 1024) {
      assert.equal(await page.$eval('#marketStructureDetailSheet', el => !!el.getBoundingClientRect().height), true);
      assert.equal(await page.$eval('#marketStructureBackgroundWrapper', el => el.inert), true);
      await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement.closest('#marketStructureDetailSheet')), true);
      await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
      assert.equal(await page.evaluate(() => !!document.activeElement.closest('#marketStructureDetailSheet')), true);
    }
    await page.click('#' + closeId); assert.equal(await page.$eval('#marketStructureSearchInput', el => el.value), 'TLKM');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.ticker), 'TLKM'); await search('');
    record('MATRIX', { theme, ...geometry });
    await page.mouse.move(0, 0); await pause(350);
    if (theme === 'light' && width === 390) { await page.click('#marketStructureTableBody [data-ticker="ASII"]'); await pause(350); record('SETTLED_DETAIL', await page.evaluate(() => { const el = document.querySelector('.ac-detail-sheet-panel'); const rect = el.getBoundingClientRect(); return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, opacity: getComputedStyle(el).opacity, filter: getComputedStyle(el).filter, ancestors: [...(function* () { let a = el; while (a) { yield a; a = a.parentElement; } })()].map(a => ({ id: a.id, opacity: getComputedStyle(a).opacity, filter: getComputedStyle(a).filter, transform: getComputedStyle(a).transform })) }; }));  await page.keyboard.press('Escape'); }
  });
}
test('D1 reachable standalone and fetched fallback render the same list workflow', async () => {
  await page.goto(origin + '/analisis-saham?tab=market-structure', { waitUntil: 'networkidle0' });
  await page.evaluate(() => switchAnalisisTab('market-structure'));
  await page.waitForFunction(() => document.querySelectorAll('#marketStructureTableBody tr[data-ticker]').length === 3);
  assert.ok((await rows()).every(row => row.visible));
  await page.goto(origin + '/dashboard', { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.getElementById('tpl-analisis-saham').remove());
  await page.evaluate(() => navigateTo('analisis', 'market-structure'));
  await page.waitForFunction(() => document.querySelectorAll('#marketStructureTableBody tr[data-ticker]').length === 3);
  assert.ok((await rows()).every(row => row.visible));
});
test('D1 Research navigation preserves the compact Batch B Financial runtime', async () => {
  await page.evaluate(() => navigateTo('analisis', 'financial'));
  await page.waitForFunction(() => document.getElementById('financialPbv').innerText === '3x');
  assert.equal(await page.$eval('#financialSource', el => el.innerText), 'Local verified filing');
  assert.equal(await page.$$eval('#panel-tab-financial .ac-financial-orbit', els => els.length), 0);
});

test('D1 detail return preserves simultaneous search, filter, sort and table position', async () => {
  await page.setViewport({ width: 390, height: 900 });
  await page.click('#marketStructureFilterLowFF');
  await search('TL'); await page.select('#marketStructureSortSelect', 'ticker_asc');
  await page.focus('#marketStructureTableBody [data-ticker="TLKM"]');
  const context = () => page.evaluate(() => {
    const table = document.getElementById('marketStructureTableContainer');
    return { search: document.getElementById('marketStructureSearchInput').value, sort: document.getElementById('marketStructureSortSelect').value, filter: document.getElementById('marketStructureFilterLowFF').classList.contains('is-active'), left: table.scrollLeft, top: table.scrollTop };
  });
  await page.$eval('#marketStructureTableContainer', el => { el.scrollLeft = el.scrollWidth - el.clientWidth; });
  const before = await context(); assert.equal(before.filter, true); assert.ok(before.left > 0);
  await page.keyboard.press('Enter'); await pause(350);
  const settled = await page.$eval('.ac-detail-sheet-panel', el => {
    const r = el.getBoundingClientRect(); const button = document.getElementById('marketStructureSheetClose'); const b = button.getBoundingClientRect();
    return { opacity: getComputedStyle(el).opacity, visibleClose: button.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)), withinViewport: r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight };
  });
  assert.equal(settled.opacity, '1'); assert.ok(settled.visibleClose); assert.ok(settled.withinViewport);
  await page.keyboard.press('Escape');
  assert.deepEqual(await context(), before);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.ticker), 'TLKM');
  assert.deepEqual((await rows()).map(row => row.ticker), ['TLKM']);
  record('SIMULTANEOUS_CONTEXT_RETURN', { before, after: await context(), settled });
});
