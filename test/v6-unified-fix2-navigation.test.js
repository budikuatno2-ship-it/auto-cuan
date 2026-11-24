'use strict';

/**
 * FIX 2 regression contract — all 19 sidebar tabs open their own container.
 * Static served-source invariants + real served-DOM navigation probe.
 * Guardrails: loopback-only, snapshot DB, Telegram OFF, no paid provider,
 * no DB writes, no deploy, no screenshots.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SNAPSHOT = path.join(ROOT, 'audit-evidence', 'v6_recovery_17nov', 'polish_final_20261121_v1', 'task_1_4', 'market.sqlite.snapshot');

// The 19 sidebar tabs and the page container each must mount.
const TABS = [
  ['dashboard', 'page-dashboard'],
  ['screener', 'page-screener'],
  ['sektor', 'page-sektor'],
  ['catatan-admin', 'page-catatan-admin'],
  ['analisis', 'page-analisis'],
  ['bandarmologi', 'page-analisis'],
  ['intel', 'page-analisis'],
  ['hunter', 'page-analisis'],
  ['insider', 'page-analisis'],
  ['ranking', 'page-analisis'],
  ['financial', 'page-analisis'],
  ['market-structure', 'page-analisis'],
  ['watchlist', 'page-watchlist'],
  ['portofolio', 'page-portofolio'],
  ['trackrecord', 'page-trackrecord'],
  ['money-management', 'page-money-management'],
  // Langganan VIP is intentionally served via the Account Center panel;
  // #page-subscription is removed by website-approved-access.js because
  // subscription provisioning is disabled. Asserted separately below.
  ['pattern', 'page-analisis'],
  ['admin-console', 'page-admin-console']
];

test('FIX2-STATIC: all 19 sidebar items carry a data-sidebar-page and a navigateTo route', () => {
  const html = read('public/index.html');
  const buttons = html.match(/<button[^>]*data-sidebar-page="[^"]+"[^>]*>/g) || [];
  assert.equal(buttons.length, 19, 'exactly 19 sidebar tabs');
  const pages = buttons.map((b) => (b.match(/data-sidebar-page="([^"]+)"/) || [])[1]);
  assert.equal(new Set(pages).size, 19, '19 distinct sidebar page keys');
  for (const b of buttons) {
    assert.ok(/onclick="navigateTo\(|openAccountSubscription/.test(b),
      'every sidebar tab routes through navigateTo or Account Center: ' + b.slice(0, 120));
  }
});

test('FIX2-STATIC: no bounce-to-dashboard rewrite remains for premium/subscription routes', () => {
  const html = read('public/index.html');
  assert.ok(!/if \(page === 'subscription'\) \{\s*page = 'dashboard';/.test(html),
    'subscription must not rewrite to dashboard');
  assert.ok(!/isDeniedWebsiteAccess\(\) && isPremiumFeaturePage\(currentPage\)\) \{\s*clearRenderedPremiumData\(\);\s*navigateTo\('dashboard'\)/.test(html),
    'premium denial must not bounce to dashboard');
  assert.match(html, /function renderPremiumAccessDenial\(page\)/, 'honest in-place denial renderer present');
  assert.match(html, /data-active-page/, 'active_page exposed on body for route assertions');
});

test('FIX2-STATIC: Portfolio checkAccess is navigation-safe', () => {
  const src = read('public/portfolio-command-center.js');
  assert.match(src, /var gate = \$\('accessGate'\);\s*\/\/ FIX 2|if \(!gate\) return;/, 'gate null guard');
  assert.match(src, /gateGeneration/, 'stale generation guard present');
  assert.ok(!/console\.log\('\[Portfolio checkAccess\]/.test(src), 'no verbose checkAccess logs');
});

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}
function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function check() {
      const req = http.get(url, (res) => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('server timeout ' + url));
        else setTimeout(check, 250);
      });
    })();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServedPage(t, fn) {
  if (!fs.existsSync(CHROME) || !fs.existsSync(SNAPSHOT)) {
    t.skip('BLOCKED: Chrome/snapshot unavailable for served-DOM probe');
    return null;
  }
  let puppeteer = null;
  try { puppeteer = require('puppeteer-core'); } catch (_) {
    t.skip('BLOCKED: puppeteer-core unavailable');
    return null;
  }
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const server = spawn(process.execPath, [path.join(ROOT, 'tools', 'local-dev-server.js')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), NODE_ENV: 'development', AUTO_CUAN_MARKET_DB: SNAPSHOT,
      TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', DISABLE_TELEGRAM: '1',
      AUTO_CUAN_TELEGRAM_OFF: '1', GEMINI_API_KEY: ''
    },
    shell: false, stdio: 'ignore'
  });
  let browser = null;
  try {
    await waitForServer(base + '/api/version');
    browser = await puppeteer.launch({
      executablePath: CHROME, headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-background-networking', '--disable-component-update', '--no-first-run',
        '--disable-sync', '--no-default-browser-check']
    });
    const page = await browser.newPage();
    const errors = [];
    const badHttp = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    page.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(base)) badHttp.push(r.status() + ' ' + r.url()); });
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      if (u.startsWith(base) || u.startsWith('data:') || u.startsWith('blob:')) return req.continue();
      return req.abort(); // loopback only: zero paid-provider / IDX / Telegram calls
    });
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.setItem('auto_cuan_onboarding_seen', 'true');
        localStorage.setItem('autocuan_entered_app', 'true');
        localStorage.setItem('autocuan_user', 'budi');
        localStorage.setItem('autocuan_is_admin', 'true');
        localStorage.setItem('autocuan_logged_in', 'true');
      } catch (_) {}
    });
    await page.goto(base + '/dashboard?nobar=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => typeof navigateTo === 'function', { timeout: 30000 });
    await sleep(1500);
    // Discard ambient load-time requests; measure only navigation-triggered HTTP.
    errors.length = 0;
    badHttp.length = 0;
    return await fn(page, base, errors, badHttp);
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
}

test('FIX2-DOM: all 19 sidebar tabs open their own container with 0 uncaught exceptions and 0 HTTP >=400', async (t) => {
  await withServedPage(t, async (page, base, errors, badHttp) => {
    const results = [];
    for (const [pageKey, containerId] of TABS) {
      const r = await page.evaluate((args) => {
        const [key, id] = args;
        try { navigateTo(key); } catch (e) { return { key, error: String(e && e.message || e) }; }
        const el = document.getElementById(id);
        const rect = el ? el.getBoundingClientRect() : null;
        return {
          key,
          active: document.body.getAttribute('data-active-page'),
          visible: Boolean(el && !el.classList.contains('hidden')),
          height: rect ? Math.round(rect.height) : 0,
          sidebarActive: Boolean(document.querySelector('#appSidebar [data-sidebar-page="' + key + '"]')),
          subTab: window.__ACTIVE_ANALISIS_SUBTAB__ || null
        };
      }, [pageKey, containerId]);
      results.push(r);
      await sleep(120);
    }
    for (const r of results) {
      assert.ok(!r.error, r.key + ' threw: ' + r.error);
      const isSubTab = ["bandarmologi","intel","hunter","insider","ranking","financial","market-structure","pattern"].includes(r.key);
      assert.equal(r.active, isSubTab ? 'analisis' : r.key,
        r.key + ' active_page mismatch: ' + JSON.stringify(r));
      if (isSubTab) {
        assert.equal(r.subTab, r.key, r.key + ' analysis sub-tab mismatch: ' + JSON.stringify(r));
      }
      assert.equal(r.visible, true, r.key + ' container not visible: ' + JSON.stringify(r));
      assert.ok(r.height > 100, r.key + ' container height <= 100px: ' + JSON.stringify(r));
      assert.equal(r.sidebarActive, true, r.key + ' sidebar item missing');
    }
    assert.deepEqual(errors, [], '0 uncaught exceptions: ' + JSON.stringify(errors));
    // Known ambient background pollers (pre-existing, not navigation-triggered):
    //   /data/top5-radar.json 404 (optional static file), /api/whats-new 401 (guest endpoint).
    const navHttp = badHttp.filter((x) => !/\/data\/top5-radar\.json|\/api\/whats-new/.test(x));
    assert.deepEqual(navHttp, [], '0 navigation-triggered HTTP >=400: ' + JSON.stringify(navHttp));
  });
});

test('FIX2-DOM: Sektor Hot and PANTAU group specifically mount their containers', async (t) => {
  await withServedPage(t, async (page, base, errors, badHttp) => {
    for (const key of ['sektor', 'watchlist', 'portofolio', 'trackrecord', 'money-management']) {
      const r = await page.evaluate((k) => {
        navigateTo(k);
        const id = 'page-' + k;
        const el = document.getElementById(id);
        return { k, active: document.body.getAttribute('data-active-page'), visible: Boolean(el && !el.classList.contains('hidden')) };
      }, key);
      assert.equal(r.active, key, key + ' active_page mismatch');
      assert.equal(r.visible, true, key + ' container hidden');
      await sleep(120);
    }
    // Langganan VIP opens the Account Center subscription panel (the
    // standalone #page-subscription is intentionally removed at runtime).
    const sub = await page.evaluate(() => {
      if (typeof window.openAccountSubscription !== 'function') return { ok: false, reason: 'no opener' };
      window.openAccountSubscription();
      const center = document.getElementById('acAccountCenter');
      const panel = document.getElementById('acPanelLangganan');
      return { ok: Boolean(center && !center.hidden && panel && !panel.hidden) };
    });
    assert.equal(sub.ok, true, 'Langganan VIP opens Account Center subscription panel: ' + JSON.stringify(sub));
    assert.deepEqual(errors, [], '0 uncaught exceptions on Sektor Hot / PANTAU journey');
  });
});
