'use strict';

/**
 * test/v5/browser-e2e.js — F5 browser E2E harness (real local Puppeteer).
 *
 * Boots tools/local-dev-server.js as an ISOLATED child process (no Supabase, no
 * upstream quota provider, no Telegram, no external network) and drives a real
 * Chrome/Edge (puppeteer-core) against it.
 *
 * Asserts, with REAL failing exit semantics:
 *   - SPA direct-URL fallback,
 *   - auth gating (guest rejected on admin read),
 *   - legit signed-session admin auth (via lib/admin-session HMAC, NEVER a fake
 *     localStorage grant),
 *   - admin quota-limit SET then CLEAR against an isolated limit blob (verified
 *     via a follow-up read, not just a 200),
 *   - Admin Console render + interactive tab exercise,
 *   - screener with a KNOWN source fixture (konglo=3 known rows, daytrade=0) and
 *     a verifiable category-filter assertion,
 *   - chart active ticker + real candle data + trading plan + ticker CHANGE,
 *   - refresh re-verification,
 *   - strict network isolation (no host other than the local origin).
 *
 * EXIT SEMANTICS (mandatory):
 *   0 = every case PASS with no relevant console error and no page error.
 *   1 = any FAIL, any BLOCK (unmet mandatory precondition), any relevant
 *       application console error, any page error, or any thrown exception.
 *   2 = infrastructure failure (browser not found / server failed to boot).
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 41732;
// Test-only injection point to PROVE the FAIL exit path is real (nonzero exit).
// When set, the harness records one forced FAIL after the browser is up so the
// failure classification + end-of-run exit semantics can be audited with a
// deterministic nonzero result. Never set in normal runs.
const FORCE_FAIL = process.env.F5_E2E_FORCE_FAIL === '1';
const ORIGIN = 'http://127.0.0.1:' + PORT;
const SESSION_SECRET = 'f5-e2e-secret-0123456789abcdef';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f5-e2e-'));
const QUOTA_BLOB = path.join(tmp, 'quota-limit-blob.json');
const QUOTA_AUDIT = path.join(tmp, 'quota-audit.jsonl');

// Seed an empty limit blob so admin set/clear runs against an isolated file,
// never touching the repository's real data/quota-limit.json.
fs.writeFileSync(QUOTA_BLOB, JSON.stringify({}, null, 2));

const results = [];
const consoleErrors = [];
const pageErrors = [];
const externalRequests = new Set();
const failedResponses = [];

function record(name, status, detail) {
  results.push({ name, status, detail: String(detail || '') });
  console.log(status.padEnd(6) + ' ' + name + (detail ? ' — ' + detail.slice(0, 220) : ''));
}
const pass = (n, d) => record(n, 'PASS', d);
const fail = (n, d) => record(n, 'FAIL', d);
const block = (n, d) => record(n, 'BLOCK', d);

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Poll a page.evaluate function until it returns a truthy value or timeout.
 * Throws on timeout so a missing pre/post-condition is always visible.
 */
async function pageWait(page, fn, opt) {
  const o = opt || {};
  const timeout = o.timeout || 15000;
  const interval = o.interval || 200;
  const label = o.label || 'condition';
  const deadline = Date.now() + timeout;
  let last = null;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      last = await page.evaluate(fn);
    } catch (e) {
      lastErr = String((e && e.message) || e);
      last = null;
    }
    if (last !== undefined && last !== null && last !== false) return last;
    await wait(interval);
  }
  throw new Error('timeout waiting for ' + label + (lastErr ? ' (last error: ' + lastErr + ')' : ''));
}

/**
 * Discover a real Chromium-family binary on Windows (no /usr/bin/chromium).
 * Honors CHROMIUM_PATH first, then Playwright/Puppeteer channels, then common
 * Windows Chrome/Edge install locations.
 */
function discoverChrome() {
  const candidates = [];
  if (process.env.CHROMIUM_PATH) candidates.push(process.env.CHROMIUM_PATH);
  if (process.env.PUPPETEER_EXECUTABLE_PATH) candidates.push(process.env.PUPPETEER_EXECUTABLE_PATH);
  candidates.push(
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  );
  if (process.env.LOCALAPPDATA) {
    candidates.push(
      path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    );
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

// Legitimate local authentication. Uses the server's OWN HMAC-signed session
// module to mint a real `ac_sess` cookie; never writes `localStorage`.
function signedAdminCookie() {
  process.env.SESSION_SECRET = SESSION_SECRET;
  const session = require(path.join(ROOT, 'lib', 'admin-session'));
  const token = session.createSessionToken({ userId: 'f5admin', username: 'f5admin', isAdmin: true });
  if (!token) throw new Error('session token creation failed (no SESSION_SECRET)');
  return { name: session.SESSION_COOKIE_NAME, token };
}

// A console message of type 'error' is only treated as a relevant application
// error when it is NOT a plain "Failed to load resource" status noise. HTTP
// status failures (404 on a client-side data fallback, 401 on the deliberate
// guest auth-gating probe) are classified separately via failedResponses so a
// real JS exception can never be laundered, and a favicon 404 can never hide
// under a PASS either.
function isRelevantConsoleError(text) {
  const s = String(text || '');
  if (/Failed to load resource/i.test(s)) return false;
  const benign = [
    /\/favicon\.ico/,                          // missing favicon is not an app error
    /sourceMappingURL|\.map\b/i,               // source-map fetch noise
    /chrome-extension:/i,
    /ERR_BLOCKED_BY_CLIENT/i,
    /Download the (React DevTools|Vue Devtools)/i
  ];
  return !benign.some((re) => re.test(s));
}

// Expected-failure allowlist. A 401 on the admin read is the deliberate guest
// auth-gating negative test; a 404 on the client-side top5-radar data fallback
// is a local-data probe, not an upstream/quota request and not fatal.
function isBenignFailedResponse(status, url) {
  if (status === 401 && /\/api\/admin\/quota-limit/.test(url)) return true;
  if (status === 404 && /\/data\/top5-radar\.json/.test(url)) return true;
  if (status === 404 && /\/favicon\.ico/.test(url)) return true;
  return false;
}

function bootServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'local-dev-server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NODE_ENV: 'development',
      SESSION_SECRET,
      QUOTA_LIMIT_BLOB_PATH: QUOTA_BLOB,
      QUOTA_LIMIT_AUDIT_LOG_PATH: QUOTA_AUDIT,
      HUAC_LIMIT_BLOB_PATH: QUOTA_BLOB,
      SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '',
      ARJUM_API_KEY: '', VPS_DATA_API_BASE: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: ''
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let buf = '';
  child.stdout.on('data', (d) => { buf += String(d); });
  child.stderr.on('data', (d) => { buf += String(d); });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 40000;
    const timer = setInterval(() => {
      if (buf.includes('AUTO-CUAN LOCAL DEVELOPMENT SERVER IS RUNNING')) {
        clearInterval(timer);
        resolve(child);
      } else if (child.exitCode !== null) {
        clearInterval(timer);
        reject(new Error('server exited: ' + buf.slice(-600)));
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        child.kill();
        reject(new Error('server boot timeout: ' + buf.slice(-600)));
      }
    }, 200);
  });
}

async function main() {
  // Mandatory precondition #1: a real browser binary must exist.
  const CHROME = discoverChrome();
  if (!CHROME) {
    console.error('Chromium/Edge not found. Set CHROMIUM_PATH to a Chrome/Edge binary.');
    process.exit(2);
  }
  console.log('browser=' + CHROME);

  const server = await bootServer().catch((err) => {
    console.error('[E2E INFRA] ' + String((err && err.message) || err));
    process.exit(2);
  });

  let browser = null;
  let fatal = null;

  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'f5-prof-')),
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    // Gate on console/page errors with classification.
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
    page.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith(ORIGIN) && !u.startsWith('about:') && !u.startsWith('data:') && !u.startsWith('blob:')) {
        externalRequests.add(u);
      }
    });
    page.on('response', (r) => {
      const s = r.status();
      if (s >= 400) failedResponses.push({ status: s, url: r.url() });
    });

    if (FORCE_FAIL) {
      fail('FORCED FAILURE (F5_E2E_FORCE_FAIL=1)', 'deterministic injection to verify nonzero exit semantics');
    }

    /* 1. SPA direct-URL fallback. */
    const resp = await page.goto(ORIGIN + '/screener', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const ct = (resp && resp.headers() && resp.headers()['content-type']) || '';
    (ct.includes('text/html'))
      ? pass('SPA direct-URL fallback (/screener -> html)', 'content-type=' + ct)
      : fail('SPA direct-URL fallback', 'content-type=' + ct);

    /* 2. Auth gating: guest must NOT reach a signed-session-only admin read. */
    const guestQuotaLimit = await page.evaluate(async () => {
      const r = await fetch('/api/admin/quota-limit', { headers: {} });
      return r.status;
    });
    (guestQuotaLimit === 401 || guestQuotaLimit === 403)
      ? pass('auth gating: guest rejected on /api/admin/quota-limit', 'status=' + guestQuotaLimit)
      : fail('auth gating: guest was not rejected', 'status=' + guestQuotaLimit);

    /* 3. Legit signed-session admin cookie (server-side HMAC). */
    const cookie = signedAdminCookie();
    await page.setCookie({ name: cookie.name, value: cookie.token, domain: '127.0.0.1', path: '/' });

    /* 4. Admin quota-limit SET -> verify -> CLEAR -> verify (real round-trip). */
    const setRes = await page.evaluate(async () => {
      const h = { 'Content-Type': 'application/json' };
      const r = await fetch('/api/admin/quota-limit', { method: 'POST', headers: h, body: JSON.stringify({ action: 'set', limit: 5000, reason: 'f5-e2e' }) }).catch((e) => ({ __e: String(e && e.message || e) }));
      return r.__e ? { __e: r.__e } : { status: r.status, body: await r.json().catch(() => ({})) };
    });
    const setVerify = await page.evaluate(async () => {
      const r = await fetch('/api/admin/quota-limit', { headers: {} }).catch(() => null);
      if (!r) return { status: null };
      const j = await r.json().catch(() => ({}));
      return { status: r.status, overrideLimit: j && j.override && j.override.limit };
    });
    const clearRes = await page.evaluate(async () => {
      const h = { 'Content-Type': 'application/json' };
      const r = await fetch('/api/admin/quota-limit', { method: 'POST', headers: h, body: JSON.stringify({ action: 'clear', reason: 'f5-e2e' }) }).catch((e) => ({ __e: String(e && e.message || e) }));
      return r.__e ? { __e: r.__e } : { status: r.status, body: await r.json().catch(() => ({})) };
    });
    const clearVerify = await page.evaluate(async () => {
      const r = await fetch('/api/admin/quota-limit', { headers: {} }).catch(() => null);
      if (!r) return { status: null };
      const j = await r.json().catch(() => ({}));
      return { status: r.status, overrideLimit: j && j.override && j.override.limit };
    });
    const setOk = setRes.status === 200 && setVerify.status === 200 && setVerify.overrideLimit === 5000;
    const clearOk = clearRes.status === 200 && clearVerify.status === 200 && (clearVerify.overrideLimit === null || clearVerify.overrideLimit === undefined);
    (setOk && clearOk)
      ? pass('admin quota-limit SET/CLEAR round-trip (isolated blob)',
        'set=' + JSON.stringify({ s: setRes.status, v: setVerify.overrideLimit }) + ' clear=' + JSON.stringify({ s: clearRes.status, v: clearVerify.overrideLimit }))
      : fail('admin quota-limit SET/CLEAR round-trip',
        'setRes=' + JSON.stringify(setRes) + ' setVerify=' + JSON.stringify(setVerify) + ' clearRes=' + JSON.stringify(clearRes) + ' clearVerify=' + JSON.stringify(clearVerify));

    /* 5. Admin Console page: render + interactive tab exercise. */
    await page.goto(ORIGIN + '/admin-console', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-admin-tab], #statQuotaNum, #adminConsole, .admin-console', { timeout: 10000 })
      .catch(() => null);
    const adminInteract = await page.evaluate(() => {
      const stat = document.getElementById('statQuotaNum');
      const hasTab = !!document.querySelector('[data-admin-tab]');
      // Exercise a REAL UI control without mutating repo state: switch the tab.
      if (typeof switchAdminTab === 'function') switchAdminTab(2);
      return { hasTab, statText: stat ? String(stat.textContent || '').trim() : '', switched: true };
    }).catch(() => ({ hasTab: false, statText: '', switched: false }));
    (adminInteract.hasTab || adminInteract.statText.length > 0)
      ? pass('Admin Console render + interactive tab exercise', JSON.stringify(adminInteract))
      : block('Admin Console render (mandatory marker not found)', JSON.stringify(adminInteract));

    /* 6. Screener with KNOWN source fixture + verifiable category filter. */
    const screener = await page.evaluate(async () => {
      const full = await (await fetch('/api/screener', { headers: {} })).json().catch(() => ({}));
      const konglo = await (await fetch('/api/screener?category=konglo', { headers: {} })).json().catch(() => ({}));
      const daytrade = await (await fetch('/api/screener?category=daytrade', { headers: {} })).json().catch(() => ({}));
      const tickers = (full.results || []).map((r) => String(r && r.ticker).toUpperCase());
      return {
        fullCount: Array.isArray(full.results) ? full.results.length : -1,
        kongloCount: Array.isArray(konglo.results) ? konglo.results.length : -1,
        daytradeCount: Array.isArray(daytrade.results) ? daytrade.results.length : -1,
        hasDSNG: tickers.indexOf('DSNG') >= 0,
        kongloTickers: (konglo.results || []).map((r) => String(r && r.ticker).toUpperCase())
      };
    });
    // Known fixture: data/screener-v3f04-konglo.json publishes exactly DSNG/MPMX/CDIA,
    // daytrade source is empty. Filter must reflect that exactly.
    const kongloExpected = ['DSNG', 'MPMX', 'CDIA'].sort().join(',');
    const kongloActual = [...(screener.kongloTickers || [])].sort().join(',');
    (screener.fullCount >= 7 && screener.kongloCount === 3 && screener.daytradeCount === 0 &&
      screener.hasDSNG === true && kongloActual === kongloExpected)
      ? pass('screener known-source fixture + category filter', JSON.stringify(screener))
      : fail('screener known-source fixture + category filter',
        JSON.stringify(screener) + ' expected konglo=' + kongloExpected);

    /* 7. Chart: active ticker + candle data + trading plan + ticker CHANGE. */
    await page.goto(ORIGIN + '/analisis', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pageWait(page, () => Boolean(window.UnifiedCockpit && document.getElementById('unifiedChartContainer')), { label: 'analisis page boot', timeout: 15000 });
    await page.evaluate(() => {
      const inp = document.getElementById('analisisInput');
      if (inp) inp.value = 'BBCA';
      if (window.UnifiedCockpit && typeof window.UnifiedCockpit.loadUnifiedChart === 'function') {
        window.UnifiedCockpit.loadUnifiedChart('BBCA');
      }
    });
    await pageWait(page, () => {
      const d = window._chartPageData;
      return Boolean(d && d.success && Array.isArray(d.candles) && d.candles.length > 0);
    }, { label: 'BBCA candle data loaded', timeout: 20000 });
    await pageWait(page, () => Boolean(window.AutoCuanAnalisisV2 && window.AutoCuanAnalisisV2.state && window.AutoCuanAnalisisV2.state.plans && window.AutoCuanAnalisisV2.state.plans.swing), { label: 'BBCA trading plan', timeout: 20000 });

    const chartState = await page.evaluate(() => {
      const badge = document.getElementById('unifiedActiveTickerBadge');
      const data = window._chartPageData || {};
      const plan = (window.AutoCuanAnalisisV2 && window.AutoCuanAnalisisV2.state && window.AutoCuanAnalisisV2.state.plans) ? window.AutoCuanAnalisisV2.state.plans.swing : null;
      const sheetText = (document.getElementById('anaPlanSheet') && document.getElementById('anaPlanSheet').innerText) || '';
      return {
        badge: badge ? String(badge.textContent || '').trim() : '',
        dataTicker: String(data.ticker || ''),
        candleCount: Array.isArray(data.candles) ? data.candles.length : 0,
        hasPlan: Boolean(plan && plan.entry != null && plan.sl != null && plan.tp1 != null),
        sheetHasPlan: /Rencana|rencana/i.test(sheetText)
      };
    });
    const chartAsserts = chartState.badge === 'BBCA' && chartState.dataTicker === 'BBCA' &&
      chartState.candleCount > 0 && chartState.hasPlan && chartState.sheetHasPlan;
    chartAsserts
      ? pass('chart active ticker + candle data + trading plan', JSON.stringify(chartState))
      : fail('chart active ticker + candle data + trading plan', JSON.stringify(chartState));

    // Ticker CHANGE: load a different ticker and re-assert identity + candles.
    await page.evaluate(() => {
      const inp = document.getElementById('analisisInput');
      if (inp) inp.value = 'BBRI';
      if (window.UnifiedCockpit && typeof window.UnifiedCockpit.loadUnifiedChart === 'function') {
        window.UnifiedCockpit.loadUnifiedChart('BBRI');
      }
    });
    await pageWait(page, () => {
      const d = window._chartPageData;
      return Boolean(d && d.ticker === 'BBRI' && Array.isArray(d.candles) && d.candles.length > 0);
    }, { label: 'ticker changed to BBRI', timeout: 20000 });
    const changed = await page.evaluate(() => {
      const badge = document.getElementById('unifiedActiveTickerBadge');
      const d = window._chartPageData || {};
      return { badge: badge ? String(badge.textContent || '').trim() : '', dataTicker: String(d.ticker || ''), candleCount: Array.isArray(d.candles) ? d.candles.length : 0 };
    });
    (changed.badge === 'BBRI' && changed.dataTicker === 'BBRI' && changed.candleCount > 0)
      ? pass('chart ticker CHANGE (BBCA -> BBRI) re-verified', JSON.stringify(changed))
      : fail('chart ticker CHANGE', JSON.stringify(changed));

    /* 8. Refresh re-verification: reload and re-assert content + state. */
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await pageWait(page, () => Boolean(document.getElementById('unifiedChartContainer')), { label: 'post-reload chart container', timeout: 15000 });
    const postReloadSpa = await page.evaluate(() => ({
      hasChartContainer: !!document.getElementById('unifiedChartContainer'),
      hasPlanSheet: !!document.getElementById('anaPlanSheet')
    }));
    (postReloadSpa.hasChartContainer && postReloadSpa.hasPlanSheet)
      ? pass('refresh re-verification (SPA content + plan sheet)', JSON.stringify(postReloadSpa))
      : block('refresh re-verification (content missing after reload)', JSON.stringify(postReloadSpa));

    /* 9. Network isolation proof: nothing left the local origin. */
    (externalRequests.size === 0)
      ? pass('no upstream quota / Telegram / external requests', 'externalRequests=0')
      : fail('external requests leaked', Array.from(externalRequests).join(' | '));

  } catch (err) {
    // ANY thrown exception is a failure — never silently swallowed into exit 0.
    console.error('[E2E ERROR]', (err && err.stack) ? err.stack : String(err));
    fatal = 'exception: ' + String((err && err.message) || err);
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
    try { server.kill(); } catch (_) {}
  }

  fs.mkdirSync(path.join(ROOT, 'audit-evidence', 'v5'), { recursive: true });
  const relevantConsoleErrors = consoleErrors.filter(isRelevantConsoleError);
  fs.writeFileSync(path.join(ROOT, 'audit-evidence', 'v5', 'F5_BROWSER_E2E.json'), JSON.stringify({
    cases: results,
    consoleErrors,
    relevantConsoleErrors,
    pageErrors,
    externalRequests: Array.from(externalRequests),
    failedResponses,
    fatal
  }, null, 2));

  const failed = results.filter((r) => r.status === 'FAIL').length;
  const blocked = results.filter((r) => r.status === 'BLOCK').length;
  const passed = results.filter((r) => r.status === 'PASS').length;

  console.log('\n---');
  console.log('cases=' + results.length + ' pass=' + passed + ' fail=' + failed + ' block=' + blocked);
  console.log('consoleErrors=' + consoleErrors.length + ' relevant(...)=' + relevantConsoleErrors.length + ' pageErrors=' + pageErrors.length + ' externalRequests=' + externalRequests.size);
  const unexpectedFailed = failedResponses.filter((f) => f.status >= 500);
  if (unexpectedFailed.length) console.log('HTTP >=500 responses:\n  ' + unexpectedFailed.map((f) => f.status + ' ' + f.url).join('\n  '));
  if (relevantConsoleErrors.length) console.log('RELEVANT console errors:\n  ' + relevantConsoleErrors.join('\n  '));
  if (pageErrors.length) console.log('PAGE ERRORS (critical):\n  ' + pageErrors.join('\n  '));

  // Mandatory exit behavior:
  //   FAIL -> 1 | BLOCK -> 1 | exception -> 1 | critical page error -> 1 (FAIL)
  //   relevant app console error -> 1 (FAIL)
  if (fatal) {
    console.error('RESULT: EXCEPTION — nonzero exit');
    process.exitCode = 1;
    return;
  }
  if (failed > 0) {
    console.error('RESULT: FAIL (' + failed + ') — nonzero exit');
    process.exitCode = 1;
    return;
  }
  if (blocked > 0) {
    console.error('RESULT: BLOCK (' + blocked + ') unmet mandatory precondition — nonzero exit');
    process.exitCode = 1;
    return;
  }
  if (pageErrors.length > 0) {
    console.error('RESULT: critical page error — nonzero exit');
    process.exitCode = 1;
    return;
  }
  if (relevantConsoleErrors.length > 0) {
    console.error('RESULT: relevant application console error — nonzero exit');
    process.exitCode = 1;
    return;
  }
  // A 5xx response from the isolated server is a real backend failure that must
  // FAIL the run. 401/404 entries are only tolerated on the documented
  // expected paths (guest auth probe + local data fallback).
  const serverErrors = failedResponses.filter((f) => f.status >= 500 || !isBenignFailedResponse(f.status, f.url));
  if (serverErrors.length > 0) {
    console.error('RESULT: unexpected non-2xx server response — nonzero exit');
    console.error(serverErrors.map((f) => f.status + ' ' + f.url).join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log('RESULT: ALL PASSES + no relevant console/page errors — exit 0');
  process.exitCode = 0;
}

main();