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
const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-cuan-d2-'));
const records = [
  { ticker: 'BBCA', free_float_pct: 20, hsc_flag: false, market_structure_guard: 'NORMAL' },
  { ticker: 'TLKM', free_float_pct: 0, hsc_flag: true, market_structure_guard: 'CAUTION' },
  { ticker: 'ASII', free_float_pct: null, hsc_flag: null, market_structure_guard: 'UNKNOWN' }
].map(row => ({ ...row, free_float_source: 'Local exchange fixture', free_float_as_of: '2026-10-05', hsc_source: 'Local HSC fixture', hsc_as_of: '2026-10-05', as_of_trade_date: '2026-10-05', regulatory_compliance_status: 'NOT_EVALUATED', market_structure_note: 'Referensi risiko, bukan putusan kepatuhan.' }));
let server, browser, page, origin, mode = 'success', detailReads = 0;
const evidence = [];
const record = (name, value) => evidence.push({ name, value });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

let googleState = { success: true, google_link_state: 'unavailable', required: false };
let submissions = [];
let googleError = false;
before(async () => {
  fs.mkdirSync(evidenceRoot, { recursive: true });
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/register-user') { let body = ''; for await (const chunk of req) body += chunk; submissions.push(JSON.parse(body)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Local fixture response' })); return; }
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
        payload = googleError ? { success: false, error: 'Local status error' } : googleState;
      } else if (input.action === 'account-profile') {
        payload = { success: true, profile: { username: 'auditfixture', is_approved: true, is_admin: false, subscription: { entitlement: { premium: true } } } };
      } else if (url.pathname === '/api/maintenance-settings') {
        payload = { success: true, config: { maintenanceMode: false } };
      }
      res.writeHead(googleError && input.action === 'account-google-status' ? 503 : mode === 'error' && action === 'daily-market-context-list' ? 503 : 200, { 'Content-Type': 'application/json' });
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
  browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, userDataDir: path.join(evidenceRoot, 'browser-profile'), args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
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
  googleState = { success: true, google_link_state: 'unavailable', required: false }; submissions = []; googleError = false;
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__AUTOCUAN_ACCOUNT_CENTER_LAZY_V1__);
  await page.evaluate(() => { if (typeof hideOnboardingGuide === 'function') hideOnboardingGuide(true); applyAppTheme('light'); });
});
const visible = selector => page.$eval(selector, el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
const openRegister = async () => { await page.evaluate(() => openRegisterModal()); await pause(100); };
const fields = async () => page.evaluate(() => {
  for (const [id, value] of Object.entries({ regUsername: 'd2fixture', regEmail: 'd2fixture@gmail.com', regPassword: 'StrongPass123', regPasswordConfirm: 'StrongPass123' })) { const el = document.getElementById(id); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }
});
test('D2 register renders one consent and eligibility agrees with the submitted payload', async () => {
  await openRegister();
  assert.equal(await page.$$eval('#registerFormFields input[type=checkbox]', els => els.filter(el => el.getClientRects().length).length), 1);
  assert.equal(await page.$eval('#registerBtn', el => el.disabled), true);
  await fields(); assert.equal(await page.$eval('#registerBtn', el => el.disabled), true);
  await page.evaluate(() => doRegister()); assert.equal(submissions.length, 0);
  await page.click('#regTermsAccepted'); assert.equal(await page.$eval('#registerBtn', el => el.disabled), false);
  await page.click('#registerBtn'); await page.waitForFunction(() => document.getElementById('registerError').textContent === 'Local fixture response');
  assert.equal(submissions.length, 1); assert.equal(submissions[0].termsAccepted, true); assert.equal(submissions[0].termsVersion, '2026-08-16-v1');
  record('REGISTER_PAYLOAD', { ...submissions[0], passwordHash: '[redacted]' });
  await page.click('#regTermsAccepted'); assert.equal(await page.$eval('#registerBtn', el => el.disabled), true);
});
test('D2 required fields and password validity govern eligibility with accepted consent', async () => {
  await openRegister(); await page.click('#regTermsAccepted'); assert.equal(await page.$eval('#registerBtn', el => el.disabled), true);
  await fields(); assert.equal(await page.$eval('#registerBtn', el => el.disabled), false);
  for (const [id, value] of [['regEmail','invalid'],['regPasswordConfirm','Mismatch'],['regUsername','budi'],['regPassword','weak']]) {
    await fields(); await page.$eval('#'+id, (el,value) => { el.value=value; el.dispatchEvent(new Event('input',{bubbles:true})); }, value);
    assert.equal(await page.$eval('#registerBtn', el => el.disabled), true, id);
  }
});
for (const width of [390,1440]) test('D2 Terms returns to one consent without losing form state at '+width, async () => {
  await page.setViewport({ width, height: 900 }); await openRegister(); await fields(); await page.click('#regTermsAccepted');
  await page.click('#regOpenTerms'); await page.waitForFunction(() => document.getElementById('standaloneTermsModal')?.style.display !== 'none');
  assert.match(await page.$eval('#standaloneTermsTitle', el => el.innerText), /Ketentuan Auto-Cuan/);
  await page.click('#closeStandaloneTermsBtn'); assert.equal(await visible('#registerFormFields'), true);
  assert.equal(await page.$eval('#regUsername', el => el.value), 'd2fixture'); assert.equal(await page.$eval('#regTermsAccepted', el => el.checked), true);
  assert.equal(await page.$eval('#registerBtn', el => el.disabled), false);
  const geometry = await page.$eval('#regTermsAccepted', el => { const r=el.closest('label').getBoundingClientRect(); return {height:r.height,left:r.left,right:r.right,width:innerWidth,overflow:document.documentElement.scrollWidth}; });
  assert.ok(geometry.height>=44 && geometry.left>=0 && geometry.right<=width && geometry.overflow<=width);
  record('REGISTER_GEOMETRY', {width,...geometry});

  for(let i=0;i<3;i++) { await page.evaluate(() => {closeRegisterModal();openRegisterModal();}); await pause(50); }
  await page.addScriptTag({ url: origin + '/account-center-v1.js' });
  assert.equal(await page.$$eval('#registerFormFields input[type=checkbox]', els => els.length), 1);
  await fields(); await page.click('#regTermsAccepted'); await page.click('#registerBtn'); await pause(150); assert.equal(submissions.length,1);
});
for (const theme of ['light','dark']) for (const state of ['unlinked','linked','unavailable','eligible','ineligible','granted']) test('D2 Google '+state+' '+theme+' truthful visibility', async () => {
  await page.setViewport({width:390,height:900}); await page.evaluate(theme => applyAppTheme(theme),theme);
  const linked = ['linked','granted'].includes(state);
  googleState = { success: true, google_link_state: state==='unavailable'?'unavailable':linked?'linked':'unlinked', google_linked: linked, required: !linked && state!=='unavailable', google_link_required: !linked && state!=='unavailable', google_bonus_eligible: state==='eligible', google_bonus_granted: state==='granted', google_email_masked: 'd***@gmail.com' };
  await page.evaluate(() => { window.__AUTOCUAN_AUTHENTICATED_SESSION__={ google_link_state:'unlinked',google_link_required:true }; });
  await page.evaluate(() => enforceLegacyGmail());
  if(state==='unavailable') { assert.equal(await page.$eval('#legacyGmailDialog', el=>el.open),false); assert.equal(await page.$eval('#googleLinkSuccess',el=>el.hidden),true); }
  else {
    assert.equal(await visible('#googleLinkSuccess'),linked); assert.equal(await visible('#googleLinkBtn'),!linked);
    assert.equal(await visible('#legacyGmailBonusNotice'),state==='eligible');
    assert.equal(await visible('#googleLinkBonusBadge'),state==='granted');
    if(linked) assert.equal(await page.$eval('#googleLinkMaskedEmail',el=>el.innerText),'d***@gmail.com');
    assert.equal(await page.$eval('#legacyGmailDescription',el=>el.innerText.includes('7 hari')),state==='eligible');
  }
  record('GOOGLE_MATRIX', {theme,state,linked});
});

test('D2 failed Google status does not invent a mandatory gate or linked success', async () => {
  googleError = true;
  await page.evaluate(() => { window.__AUTOCUAN_AUTHENTICATED_SESSION__ = { google_link_state: 'unavailable', google_link_required: false, email_required: false }; });
  await page.evaluate(() => enforceLegacyGmail());
  const result = await page.evaluate(() => ({ open: !!document.getElementById('legacyGmailDialog')?.open, successVisible: !!document.getElementById('googleLinkSuccess')?.getClientRects().length, state: window.__AUTOCUAN_AUTHENTICATED_SESSION__.google_link_state }));
  assert.deepEqual(result, { open: false, successVisible: false, state: 'unavailable' }); record('GOOGLE_ERROR', result);
});
