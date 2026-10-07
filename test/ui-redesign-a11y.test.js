'use strict';

// ===========================================================================
// Focused regression tests for the PREMIUM UI ELEVATION redesign.
//
// LOCAL / STATIC + MOCKED ONLY. Most tests parse public/index.html or execute
// extracted helpers in a Node vm. The two registration contracts use the existing
// Chromium/Puppeteer stack with a localhost fixture and blocked external requests.
// No real auth backend, Supabase, Telegram, or credentials are touched.
//
// Purpose: prove the redesign preserved every critical existing behaviour and
// added the intended accessibility / usability improvements, so the elevated UI
// cannot silently regress auth, admin, device, Telegram, screener, or safety
// behaviour.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'public', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
// The design-system tokens and most page-level CSS were extracted from an
// inline <style>/:root block into cacheable external stylesheets (see the
// <link> tags and the load-strategy comment near the top of index.html).
const indexShellCss = fs.readFileSync(path.join(ROOT, 'public', 'index-shell.css'), 'utf8');
const uiThemeCss = fs.readFileSync(path.join(ROOT, 'public', 'ui-theme.css'), 'utf8');

// Brace-matched extraction of a top-level function (same approach as siblings).
function extractFunction(signature) {
  const start = html.indexOf(signature);
  assert.ok(start >= 0, 'function must exist: ' + signature);
  const i = html.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) return html.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces for ' + signature);
}

// ---------------------------------------------------------------------------
// 1. Login & registration controls remain available and wired
// ---------------------------------------------------------------------------
test('login controls remain available (username, password, submit, forgot-pw)', () => {
  assert.ok(html.indexOf('id="loginUsername"') >= 0);
  assert.ok(html.indexOf('id="loginPassword"') >= 0);
  assert.ok(html.indexOf('id="loginBtn"') >= 0);
  assert.ok(html.indexOf('onclick="doLogin()"') >= 0);
  assert.ok(html.indexOf('closeLoginModal();openSelfResetModal()') >= 0, 'Forgot Password intact');
  assert.ok(html.indexOf('>Lupa Password?<') >= 0);
});

test('registration controls remain available (username, password x2, submit)', async () => {
  await withRegistrationPage(checkRegistrationControls);
});

// ---------------------------------------------------------------------------
// 2. Password visibility toggle still works (behavioural)
// ---------------------------------------------------------------------------
test('password visibility toggle flips type and preserves value (behavioural)', () => {
  // Exactly one shared implementation.
  assert.equal((html.match(/function togglePasswordVisibility\(/g) || []).length, 1);
  const src = extractFunction('function togglePasswordVisibility');
  const toggle = new Function('document', src + '\nreturn togglePasswordVisibility;')({
    getElementById: function () { return input; }
  });
  var input = { type: 'password', value: 'S3cret!!', selectionStart: 2, selectionEnd: 2, focus() {}, setSelectionRange() {} };
  const btn = { _a: {}, setAttribute(k, v) { this._a[k] = v; }, innerHTML: '' };
  toggle('loginPassword', btn);
  assert.equal(input.type, 'text');
  assert.equal(input.value, 'S3cret!!');
  assert.equal(btn._a['aria-pressed'], 'true');
  toggle('loginPassword', btn);
  assert.equal(input.type, 'password');
  assert.equal(btn._a['aria-pressed'], 'false');
  // All three toggle buttons still wired to the shared function.
  assert.ok(html.indexOf("togglePasswordVisibility('loginPassword', this)") >= 0);
  assert.ok(html.indexOf("togglePasswordVisibility('regPassword', this)") >= 0);
  assert.ok(html.indexOf("togglePasswordVisibility('regPasswordConfirm', this)") >= 0);
});

// ---------------------------------------------------------------------------
// 3+4+9. Admin filters, approved count, and action targeting (behavioural)
// ---------------------------------------------------------------------------
function loadAdminHelpers() {
  const start = html.indexOf('function userIsPending(u)');
  const end = html.indexOf('// ===== APPROVED-USERS-HELPERS-END =====');
  assert.ok(start >= 0 && end > start);
  const src = html.slice(start, end);
  const sandbox = { console: console };
  vm.createContext(sandbox);
  vm.runInContext(src +
    '\nthis.__api={adminUserMatchesFilter:adminUserMatchesFilter,renderApprovedUsersTable:renderApprovedUsersTable,' +
    'telegramStatusLabel:telegramStatusLabel,maskDeviceId:maskDeviceId,renderDeviceDetailsHtml:renderDeviceDetailsHtml,' +
    'escapeAdminHtml:escapeAdminHtml};', sandbox);
  return sandbox.__api;
}

const nowIso = new Date().toISOString();
function population() {
  return [
    { username: 'readyA', is_approved: false, is_blocked: false, telegram_verified_at: nowIso, devices: ['d1'] },
    { username: 'unverifiedA', is_approved: false, is_blocked: false, telegram_verified_at: null, devices: [] },
    { username: 'blockedA', is_approved: false, is_blocked: true, telegram_verified_at: nowIso, devices: ['d2'] },
    { username: 'budi', is_approved: true, is_blocked: false, telegram_verified_at: nowIso, channel_joined_at: nowIso, devices: ['b1'] },
    { username: 'approvedJoined', is_approved: true, is_blocked: false, telegram_verified_at: nowIso, channel_joined_at: nowIso, devices: ['s1', 's2'] },
    { username: 'approvedNotJoined', is_approved: true, is_blocked: false, telegram_verified_at: nowIso, channel_joined_at: null, devices: [] }
  ];
}

test('admin filters still select the correct users after redesign', () => {
  const api = loadAdminHelpers();
  const users = population();
  const approved = users.filter(u => api.adminUserMatchesFilter(u, 'approved')).map(u => u.username).sort();
  assert.deepEqual(approved, ['approvedJoined', 'approvedNotJoined', 'budi']);
  users.filter(u => api.adminUserMatchesFilter(u, 'pending')).forEach(u => assert.equal(u.is_approved, false));
});

test('approved-user count remains correct and data-derived', () => {
  const api = loadAdminHelpers();
  assert.equal(population().filter(u => api.adminUserMatchesFilter(u, 'approved')).length, 3);
});

test('safe admin actions target the correct username; no Delete control', () => {
  const api = loadAdminHelpers();
  const rowHtml = api.renderApprovedUsersTable([{ username: 'targetuser', is_approved: true, is_blocked: false, devices: [] }]);
  assert.ok(rowHtml.indexOf("adminUserAction('block','targetuser')") !== -1);
  assert.ok(rowHtml.indexOf("adminUserAction('reset_devices','targetuser')") !== -1);
  assert.ok(rowHtml.indexOf("openResetPasswordModal('targetuser')") !== -1);
  assert.ok(rowHtml.indexOf("openDeviceModal('targetuser')") !== -1);
  assert.equal(/delete/i.test(rowHtml), false, 'no delete control in approved table');
});

// ---------------------------------------------------------------------------
// 5. budi remains safely supported (server-derived admin; no local shortcut)
// ---------------------------------------------------------------------------
test('budi remains safely supported (server-gated admin, exempt from bad-name block)', () => {
  assert.doesNotMatch(html, /if \(password === '\.'\)/);
  assert.doesNotMatch(html, /autocuan_is_admin', 'true'\)/);
  assert.match(html, /data\.isAdmin === true && String\(data\.username[^)]*\)\.toLowerCase\(\) === 'budi'/);
  // The bad-username filter now lives at registration only; login has no
  // client-side username gate, so budi's login path is untouched.
  const loginStart = html.indexOf('async function doLogin');
  const loginEnd = html.indexOf('function showPendingLoginApproval');
  assert.ok(loginStart > 0 && loginEnd > loginStart, 'doLogin boundaries found');
  assert.doesNotMatch(html.slice(loginStart, loginEnd), /isBadUsername/);
});

// ---------------------------------------------------------------------------
// 6+7. Device modal masking preserved (behavioural)
// ---------------------------------------------------------------------------
test('device IDs remain masked and raw IDs never rendered', () => {
  const api = loadAdminHelpers();
  const raw = 'srv_12ab34567890cd89cd';
  assert.notEqual(api.maskDeviceId(raw), raw);
  assert.ok(api.maskDeviceId(raw).indexOf('\u2022') !== -1);
  const modalHtml = api.renderDeviceDetailsHtml({ username: 'u', is_approved: true, devices: [raw], device_id: raw });
  assert.ok(modalHtml.indexOf(raw) === -1, 'raw device id never in modal HTML');
});

test('device modal open/close functions and DOM hooks remain intact', () => {
  assert.ok(html.indexOf('id="deviceDetailsModal"') >= 0);
  assert.ok(html.indexOf('id="deviceDetailsBody"') >= 0);
  assert.ok(html.indexOf('id="deviceDetailsTitle"') >= 0);
  assert.match(extractFunction('function openDeviceModal'), /deviceDetailsModal/);
  assert.match(extractFunction('function closeDeviceModal'), /classList\.add\('hidden'\)/);
});

// ---------------------------------------------------------------------------
// 8. Telegram status still correct
// ---------------------------------------------------------------------------
test('telegram status labels remain correct', () => {
  const api = loadAdminHelpers();
  assert.ok(api.telegramStatusLabel({ channel_joined_at: nowIso, telegram_verified_at: nowIso }).indexOf('Sudah Join Channel') !== -1);
  assert.ok(api.telegramStatusLabel({ channel_joined_at: null, telegram_verified_at: nowIso }).indexOf('Terverifikasi') !== -1);
  assert.ok(api.telegramStatusLabel({ channel_joined_at: null, telegram_verified_at: null }).indexOf('Belum Verifikasi') !== -1);
});

// ---------------------------------------------------------------------------
// 12. Safe user-content escaping preserved (behavioural)
// ---------------------------------------------------------------------------
test('user-controlled content is still HTML-escaped', () => {
  const api = loadAdminHelpers();
  const rowHtml = api.renderApprovedUsersTable([{ username: '<script>x</script>', is_approved: true, is_blocked: false, devices: [] }]);
  assert.ok(rowHtml.indexOf('<script>x</script>') === -1);
  assert.ok(rowHtml.indexOf('&lt;script&gt;') !== -1);
  assert.equal(api.escapeAdminHtml('<b>&"\''), '&lt;b&gt;&amp;&quot;&#039;');
});

// ---------------------------------------------------------------------------
// 10. Modal keyboard behaviour (Escape-to-close + focus trap + focus restore)
// ---------------------------------------------------------------------------
test('modal accessibility manager: Escape-to-close for auth/admin modals', () => {
  assert.match(html, /var MODAL_CLOSERS = \{/, 'modal closer registry present');
  ['loginModal', 'registerModal', 'selfResetModal', 'resetPasswordModal', 'deviceDetailsModal', 'authChoiceModal'].forEach(function (id) {
    assert.ok(html.indexOf(id + ':') !== -1, 'managed modal registered: ' + id);
  });
  // Escape handler + delegates to each modal's existing close function.
  assert.match(html, /e\.key !== 'Escape'/);
  assert.match(html, /function closeModalById/);
  // onboarding keeps its own special Escape handling (not double-managed).
  assert.ok(html.indexOf('onboardingModal:') === -1, 'onboardingModal excluded from generic Escape manager');
});

test('modal accessibility manager: Tab focus trap + focus restoration present', () => {
  assert.match(html, /e\.key !== 'Tab'/, 'Tab focus-trap handler present');
  assert.match(html, /lastFocusByModal/, 'focus is remembered per modal');
  assert.match(html, /MutationObserver/, 'open/close observed to move + restore focus');
  assert.match(html, /function topmostOpenModal/);
});

// ---------------------------------------------------------------------------
// 11. Keyboard-operable tabs / nav (native <button> elements)
// ---------------------------------------------------------------------------
test('primary navigation and screener tabs are keyboard-operable <button> elements', () => {
  assert.match(html, /<button[^>]*class="nav-btn active"[^>]*data-page="dashboard"/);
  // Screener tab controls are buttons (focusable + Enter/Space operable by default).
  assert.ok(/class="[^"]*screener-tab/.test(html) || html.indexOf('dt-screener-tab') >= 0);
});

// ---------------------------------------------------------------------------
// 13. Responsive / mobile structures remain present
// ---------------------------------------------------------------------------
test('responsive/mobile classes and structures remain present', () => {
  assert.ok(html.indexOf('width=device-width') >= 0, 'responsive viewport meta present');
  assert.ok(html.indexOf('mobile-nav-row') >= 0, 'mobile nav row present');
  assert.ok(html.indexOf('overflow-x-auto') >= 0, 'horizontal scroll containers present');
  assert.ok(indexShellCss.indexOf('@media (max-width: 640px)') >= 0, 'mobile breakpoints present');
  assert.ok(indexShellCss.indexOf('overflow-x: hidden') >= 0, 'body horizontal-overflow guard present');
  // Approved-users table stays inside a horizontal scroll wrapper on small screens.
  assert.match(extractFunction('function renderApprovedUsersTable'), /overflow-x-auto/);
});

// ---------------------------------------------------------------------------
// 14. Loading & error states recover safely
// ---------------------------------------------------------------------------
test('login re-enables its button in finally (recovers after error)', () => {
  const src = extractFunction('async function doLogin');
  assert.match(src, /finally\s*\{[^}]*loginBtn\.disabled = false/);
  assert.match(src, /loginBtn\.innerHTML = 'Masuk'/);
});

test('register re-enables its button in finally (recovers after error)', async () => {
  await withRegistrationPage(checkRegistrationRecovery);
});

test('validation/status messages expose accessible live regions', () => {
  assert.match(html, /id="loginError"[^>]*role="alert"/);
  assert.match(html, /id="registerError"[^>]*role="alert"/);
  assert.match(html, /id="resetPwError"[^>]*role="alert"/);
  assert.match(html, /id="toastContainer"[^>]*aria-live="polite"/);
});

// ---------------------------------------------------------------------------
// 15. Double-submit protection added where the code was vulnerable
// ---------------------------------------------------------------------------
test('doResetPassword guards against duplicate submissions', () => {
  const src = extractFunction('async function doResetPassword');
  assert.match(src, /if \(doResetPassword\._busy\) return;/);
  assert.match(src, /doResetPassword\._busy = true;/);
  assert.match(src, /finally\s*\{[\s\S]*doResetPassword\._busy = false;/);
});

test('doSelfResetPassword guards against duplicate submissions', () => {
  const src = extractFunction('async function doSelfResetPassword');
  assert.match(src, /if \(doSelfResetPassword\._busy\) return;/);
  assert.match(src, /doSelfResetPassword\._busy = true;/);
  assert.match(src, /finally\s*\{[\s\S]*doSelfResetPassword\._busy = false;/);
});

// ---------------------------------------------------------------------------
// 16+17. Delete User remains absent; API JS count remains exactly 13
// ---------------------------------------------------------------------------
test('Delete User lives only in the guarded admin flow (not in the approved table)', () => {
  const start = html.indexOf('function renderApprovedUsersTable');
  const end = html.indexOf('// ===== APPROVED-USERS-HELPERS-END =====');
  assert.equal(/delete/i.test(html.slice(start, end)), false, 'approved table itself stays delete-free');
  const adminApi = fs.readFileSync(path.join(ROOT, 'api', 'admin-users.js'), 'utf8');
  assert.ok(/action === 'delete_user'/.test(adminApi), 'delete_user action exists');
  assert.ok(/requireAdminSession\(req\)/.test(adminApi), 'delete requires a signed admin session');
  assert.ok(/targetUsername === 'budi' \|\| targetUsername === 'review'/.test(adminApi), 'budi/review protected');
});

test('API JavaScript file count remains exactly 13', () => {
  // Unchanged: /api/track-record is a vercel.json REWRITE onto
  // /api/sector-hot?action=track-record, so it adds no serverless function.
  const files = fs.readdirSync(path.join(ROOT, 'api')).filter(f => f.endsWith('.js'));
  assert.equal(files.length, 13, 'API JS count must remain 13; got ' + files.length);
});

test('/api/track-record is aliased to the sector-hot track-record action', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const rule = (config.rewrites || []).find(r => r.source === '/api/track-record');
  assert.ok(rule, '/api/track-record rewrite must exist so the tab never hits an HTML 404');
  assert.match(rule.destination, /action=track-record/);
});

// ---------------------------------------------------------------------------
// Redesign additions: design system, skip link, reduced motion, no dup IDs
// ---------------------------------------------------------------------------
test('coherent design-system tokens are defined in :root', () => {
  assert.match(uiThemeCss, /:root\s*\{[\s\S]*--ac-brand:/);
  // --ac-focus was deliberately split into --ac-focus-color and --ac-focus-ring,
  // one token per job (see the "one focus treatment" contract in
  // design-system-institutional-pass.test.js).
  ['--ac-surface-1', '--ac-border', '--ac-radius-md', '--ac-space-4', '--ac-shadow-md', '--ac-focus-color', '--ac-focus-ring', '--ac-font-sans']
    .forEach(function (tok) { assert.ok(uiThemeCss.indexOf(tok) !== -1, 'design token present: ' + tok); });
});

test('accessibility primitives present: skip link, focus-visible, reduced motion', () => {
  assert.match(html, /class="skip-link"/);
  assert.match(html, /skipToMainContent/);
  assert.match(indexShellCss, /:focus-visible\s*\{/);
  assert.match(indexShellCss, /@media \(prefers-reduced-motion: reduce\)/);
});

test('premium typography (Inter) and mobile theming metadata added', () => {
  assert.match(html, /fonts\.googleapis\.com\/css2\?family=Inter/);
  assert.match(html, /name="theme-color"/);
  assert.match(html, /name="color-scheme"/);
});

test('no duplicate DOM ids remain in index.html', () => {
  const ids = (html.match(/\sid="[a-zA-Z0-9_-]+"/g) || []).map(function (s) { return s.trim(); });
  const seen = {}, dups = [];
  ids.forEach(function (id) { if (seen[id]) { if (dups.indexOf(id) === -1) dups.push(id); } seen[id] = true; });
  assert.deepEqual(dups, [], 'duplicate ids found: ' + dups.join(', '));
});

test('every inline <script> block still parses (no syntax breakage from redesign)', () => {
  const re = /<script(\b[^>]*)>([\s\S]*?)<\/script>/gi;
  let m, checked = 0;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (/type\s*=\s*["'](?!text\/javascript|module|application\/javascript)/.test(attrs)) continue;
    checked++;
    assert.doesNotThrow(() => new vm.Script(m[2]), 'inline script block #' + checked + ' should parse');
  }
  assert.ok(checked >= 1);
});

// Local runtime fixture reused from the D2 browser testing approach.
const http = require('node:http');
const puppeteer = require('puppeteer-core');
const REGISTRATION_IDS = ['regEmail', 'regUsername', 'regPassword', 'regPasswordConfirm', 'regTermsAccepted', 'registerBtn'];
async function withRegistrationPage(check) {
  const publicRoot = path.join(ROOT, 'public');
  const evidenceRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'auto-cuan-auth-'));
  const fixture = { requests: [], pending: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      let raw = ''; for await (const part of req) raw += part;
      let input = {}; try { input = JSON.parse(raw); } catch (_) {}
      if (url.pathname === '/api/register-user') {
        fixture.requests.push(input); fixture.pending.push(res); return;
      }
      let data = { success: true, data: [], rows: [] };
      if (input.action === 'session-status') data = { success: false, error: 'Local guest fixture' };
      if (input.action === 'account-google-status') data = { success: true, google_link_state: 'unavailable', required: false };
      if (url.pathname === '/api/maintenance-settings') data = { success: true, config: { maintenanceMode: false } };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); return;
    }
    const file = path.resolve(publicRoot, '.' + (path.extname(url.pathname) ? url.pathname : '/index.html'));
    if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file));
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, userDataDir: fs.mkdtempSync(path.join(evidenceRoot, 'auth-profile-')), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage(); page.setDefaultTimeout(5000);
    await page.setRequestInterception(true);
    page.on('request', req => req.url().startsWith(origin + '/') ? req.continue() : req.abort());
    fixture.open = async width => {
      await page.setViewport({ width, height: 900 });
      await page.goto(origin + '/', { waitUntil: 'networkidle0' });
      await page.evaluate(() => hideOnboardingGuide(true));
      await page.waitForFunction(() => window.__AUTOCUAN_ACCOUNT_CENTER_LAZY_V1__);
      await page.addScriptTag({ url: origin + '/account-center-v1.js' });
      await page.evaluate(() => openRegisterModal());
      await page.waitForSelector('#regEmail', { visible: true });
    };
    fixture.fill = async () => {
      for (const [id, value] of Object.entries({ regEmail: 't1fixture@gmail.com', regUsername: 't1fixture', regPassword: 'StrongPass123', regPasswordConfirm: 'StrongPass123' })) await page.type('#' + id, value);
      await page.click('#regTermsAccepted');
    };
    fixture.reply = payload => {
      const res = fixture.pending.shift(); assert.ok(res, 'one pending registration request');
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };
    fixture.waitPending = async () => {
      for (let n = 0; !fixture.pending.length && n < 100; n++) await new Promise(r => setTimeout(r, 20));
      assert.equal(fixture.pending.length, 1, 'one pending request');
    };
    await check(page, fixture);
  } finally {
    for (const res of fixture.pending) res.destroy();
    try { if (browser) await browser.close(); } finally {
      try { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      finally { fs.rmSync(evidenceRoot, { recursive: true, force: true }); }
    }
  }
}
async function assertRegisterControls(page) {
  const controls = await page.evaluate(ids => ids.map(id => {
    const el = document.getElementById(id);
    if (!el) return { id, present: false };
    const style = getComputedStyle(el);
    return { id, present: true, inForm: el.form?.id === 'registerFormFields', visible: !!el.getClientRects().length && style.visibility === 'visible' && style.opacity !== '0' && !el.closest('[hidden], [inert], [aria-hidden="true"]'), disabled: el.disabled, type: el.type };
  }), REGISTRATION_IDS);
  for (const c of controls) {
    assert.equal(c.present, true, c.id + ' exists'); assert.equal(c.inForm, true, c.id + ' belongs to the registration form');
    assert.equal(c.visible, true, c.id + ' is visible'); assert.equal(c.disabled, false, c.id + ' is usable with valid fields and consent');
  }
  assert.deepEqual(controls.map(c => c.type), ['email', 'text', 'password', 'password', 'checkbox', 'submit']);
  assert.equal(await page.$$eval('#registerFormFields input[type=checkbox]', els => els.length), 1, 'single consent');
}
async function assertRegisterRecovered(page) {
  assert.equal(await page.$eval('#registerBtn', el => el.disabled), false, 'failed registration restores submit usability');
  assert.equal(await page.evaluate(() => Boolean(doRegister._busy)), false, 'pending guard released');
  assert.equal(await page.$eval('#registerBtn', el => el.textContent.trim()), 'Daftar');
}
async function checkRegistrationControls(page, fixture) {
  for (const width of [390, 1440]) {
    await fixture.open(width);
    assert.equal(await page.$eval('#registerBtn', el => el.disabled), true, 'invalid form cannot submit');
    await fixture.fill(); await assertRegisterControls(page);
  }
}
async function checkRegistrationRecovery(page, fixture) {
  for (const failure of [{ success: false, error: 'Local registration failure' }, 'not valid JSON']) {
    await fixture.open(390); await fixture.fill();
    const snapshot = () => page.evaluate(() => ['regEmail','regUsername','regPassword','regPasswordConfirm'].map(id => document.getElementById(id).value).concat(document.getElementById('regTermsAccepted').checked));
    const before = await snapshot(), count = fixture.requests.length;
    await page.click('#registerBtn'); await fixture.waitPending();
    assert.equal(await page.$eval('#registerBtn', el => el.disabled), true, 'pending submit disabled');
    assert.equal(await page.evaluate(() => Boolean(doRegister._busy)), true);
    await page.evaluate(() => Promise.all([doRegister(), doRegister()]));
    assert.equal(fixture.requests.length, count + 1, 'pending guard prevents duplicate requests');
    fixture.reply(failure);
    await page.waitForFunction(() => !doRegister._busy && !document.getElementById('registerError').classList.contains('hidden'));
    await assertRegisterRecovered(page); assert.deepEqual(await snapshot(), before, 'failure preserves fields and consent');
    await page.click('#registerBtn'); await fixture.waitPending();
    assert.equal(fixture.requests.length, count + 2, 'retry submits exactly once');
    fixture.reply({ success: true, approval_status: 'pending', approval_code: 'AC-ABC123' });
    await page.waitForFunction(() => !doRegister._busy && !document.getElementById('registerApprovalPanel').classList.contains('hidden'));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fixture.requests.length, count + 2, 'no duplicate retry request');
  }
}
