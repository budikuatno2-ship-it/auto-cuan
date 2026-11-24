'use strict';

/**
 * SERVED-UI REPAIR REGRESSION CONTRACT (final_clean_5files_20261121_v1).
 *
 * Two proven production defects, measured on the SERVED surface
 * (public/index.html + its shared runtime/CSS), not on the unreachable
 * public/admin-console.html rewrite target:
 *
 *   1. Exactly ONE "Layar Penuh" control on desktop and mobile. The redundant
 *      cockpit header button (`<chartId>_fs`) must be gone; the workstation
 *      toolbar button (`<chartId>_fullscreen_btn`) is the single control and
 *      is the one that toggles to "Keluar Layar Penuh".
 *   2. The rightmost ENABLED / Aktif column of the admin schedule table must
 *      be inside its horizontal-scroll container at 1440x900 (not clipped).
 *
 * Guardrails: loopback-only HTTP, snapshot DB, Telegram OFF, no paid provider,
 * no DB writes, no screenshots, no deploy.
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
const ADMIN_CONFIG = JSON.parse(read('data/admin-schedule-config.json'));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
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

/* ------------------------------------------------------------------ */
/* Static source invariants (fast, always run)                         */
/* ------------------------------------------------------------------ */

test('SERVED-UI: cockpit header no longer renders a duplicate _fs fullscreen button', () => {
  const cockpit = read('public/unified-cockpit-runtime.js');
  assert.ok(!/id="' \+ chartId \+ '_fs"/.test(cockpit),
    'unified-cockpit-runtime.js must not render the redundant _fs header button');
  assert.ok(!/UnifiedCockpit\.openFullscreen\(\)/.test(cockpit),
    'no header button wired to the duplicate openFullscreen path');
  // The shared viewer path itself stays intact for the standalone Chart page.
  assert.match(read('public/index.html'), /function openChartPageFullscreen\(\)/);
});

test('SERVED-UI: workstation owns the single working fullscreen control', () => {
  const ws = read('public/chart-workstation.js');
  const fsButtons = ws.match(/id="' \+ chartId \+ '_fullscreen_btn"/g) || [];
  assert.equal(fsButtons.length, 1, 'exactly one _fullscreen_btn definition in served runtime');
  assert.match(ws, /aria-label="Layar Penuh"/);
  assert.match(ws, /Keluar Layar Penuh/, 'single control toggles to one exit state');
  assert.match(ws, /requestFullscreen/);
  assert.match(ws, /exitFullscreen/);
  assert.match(ws, /fullscreenchange/);
});

test('SERVED-UI: served admin table uses ENABLED / Aktif header and no 1080px min-width', () => {
  const html = read('public/index.html');
  const start = html.indexOf('<tbody id="jobsPipelineTbody">');
  assert.ok(start > 0, 'served jobs table present');
  const before = html.slice(Math.max(0, start - 900), start);
  assert.match(before, /ENABLED \/ Aktif/, 'served header is ENABLED / Aktif');
  assert.ok(!/min-width:1080px/.test(before), 'legacy 1080px min-width removed from served table');
  assert.ok(!/>Enable</.test(before), 'legacy bare "Enable" header removed');
});

/* ------------------------------------------------------------------ */
/* Live served-DOM geometry (real Chrome, loopback only)               */
/* ------------------------------------------------------------------ */

let puppeteer = null;
try { puppeteer = require('puppeteer-core'); } catch (_) { /* handled below */ }

async function withServedPage(t, fn) {
  if (!puppeteer || !fs.existsSync(CHROME) || !fs.existsSync(SNAPSHOT)) {
    t.skip('BLOCKED: Chrome/puppeteer/snapshot unavailable for served-DOM probe');
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
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      try {
        if (u.startsWith(base) || u.startsWith('data:') || u.startsWith('blob:')) {
          const parsed = new URL(u);
          if (parsed.pathname === '/api/admin/schedule-settings' && req.method() === 'GET') {
            const jobs = Array.isArray(ADMIN_CONFIG.jobs)
              ? ADMIN_CONFIG.jobs.map((j) => Object.assign({}, j))
              : Object.keys(ADMIN_CONFIG.jobs || {}).map((key) => Object.assign({ key }, ADMIN_CONFIG.jobs[key]));
            return req.respond({ status: 200, contentType: 'application/json',
              body: JSON.stringify({ success: true, config: Object.assign({}, ADMIN_CONFIG, { jobs }) }) });
          }
          return req.continue();
        }
        return req.abort(); // loopback only: zero paid-provider / IDX / Telegram calls
      } catch (_) { try { return req.continue(); } catch (__) {} }
    });
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.setItem('auto_cuan_onboarding_seen', 'true');
        localStorage.setItem('autocuan_entered_app', 'true');
        localStorage.setItem('autocuan_user', 'budi');
        localStorage.setItem('autocuan_is_admin', 'true');
      } catch (_) {}
    });
    return await fn(page, base);
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
}

async function loadChart(page, base, width, height, mobile) {
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: !!mobile, hasTouch: !!mobile });
  await page.goto(base + '/preview/analisis-saham?nobar=1&ticker=BBCA', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(() => {
    const om = document.getElementById('onboardingModal');
    if (om) { om.style.display = 'none'; om.setAttribute('aria-hidden', 'true'); }
    const bar = document.getElementById('autocuan-preview-bar');
    if (bar) bar.style.display = 'none';
  });
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const ok = await page.evaluate(() => {
      const reg = window.__chartRegistry || {};
      const id = Object.keys(reg).find((k) => reg[k] && /BBCA/i.test(reg[k].ticker || ''));
      if (!id) return false;
      return Array.from(document.querySelectorAll('canvas')).some((c) => {
        const r = c.getBoundingClientRect(); return r.width > 100 && r.height > 100;
      });
    });
    if (ok) break;
    await sleep(400);
  }
  await sleep(1200);
}

async function countFullscreen(page) {
  return page.evaluate(() => {
    const txt = (el) => String(el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
    const buttons = Array.from(document.querySelectorAll('button')).filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(b).display !== 'none';
    });
    return {
      enter: buttons.filter((b) => txt(b) === 'Layar Penuh' || b.getAttribute('aria-label') === 'Layar Penuh').length,
      exit: buttons.filter((b) => txt(b) === 'Keluar Layar Penuh' || b.getAttribute('aria-label') === 'Keluar Layar Penuh').length
    };
  });
}

test('SERVED-UI: exactly one Layar Penuh on desktop and mobile; one exit state after click', async (t) => {
  await withServedPage(t, async (page, base) => {
    await loadChart(page, base, 1440, 900, false);
    const desktop = await countFullscreen(page);
    assert.equal(desktop.enter, 1, 'desktop has exactly one Layar Penuh control: ' + JSON.stringify(desktop));
    assert.equal(desktop.exit, 0, 'desktop has no exit control before click');

    const clicked = await page.evaluate(() => {
      const reg = window.__chartRegistry || {};
      const id = Object.keys(reg).find((k) => reg[k] && /BBCA/i.test(reg[k].ticker || '')) || Object.keys(reg)[0];
      const btn = id ? document.getElementById(id + '_fullscreen_btn') : null;
      if (!btn) return false;
      btn.click(); return true;
    });
    assert.equal(clicked, true, 'single workstation fullscreen control is clickable');
    await sleep(600);
    const after = await countFullscreen(page);
    assert.equal(after.exit, 1, 'exactly one Keluar Layar Penuh state after click: ' + JSON.stringify(after));

    await loadChart(page, base, 390, 844, true);
    const mobile = await countFullscreen(page);
    assert.equal(mobile.enter, 1, 'mobile has exactly one Layar Penuh control: ' + JSON.stringify(mobile));
    assert.equal(mobile.exit, 0, 'mobile has no exit control before click');
  });
});

test('SERVED-UI: ENABLED column is not clipped at 1440x900', async (t) => {
  await withServedPage(t, async (page, base) => {
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
    await page.goto(base + '/preview/analisis-saham?nobar=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.evaluate(() => {
      const om = document.getElementById('onboardingModal');
      if (om) { om.style.display = 'none'; om.setAttribute('aria-hidden', 'true'); }
    });
    await page.waitForFunction(() => typeof navigateTo === 'function', { timeout: 30000 });
    await sleep(1500);
    const nav = await page.evaluate(() => {
      navigateTo('admin-console');
      return { isAdmin: typeof isAdmin === 'function' ? isAdmin() : null };
    });
    assert.equal(nav.isAdmin, true, 'admin session active for served-surface probe');
    // Preview bootstrap may re-hide the admin page after navigateTo; force the
    // served surface visible so geometry is measured on the real DOM/CSS.
    await page.evaluate(() => {
      const ac = document.getElementById('page-admin-console');
      if (ac) { ac.classList.remove('hidden'); ac.style.display = 'block'; }
    });
    await page.waitForFunction(() => typeof switchAdminTab === 'function', { timeout: 30000 });
    await sleep(1200);
    await page.evaluate(() => switchAdminTab(6));
    await page.waitForFunction(() => {
      const tb = document.getElementById('jobsPipelineTbody');
      return !!tb && tb.querySelectorAll('tr[data-schedule-row]').length > 0;
    }, { timeout: 30000 });
    await sleep(1200);
    await page.evaluate(() => {
      const h = Array.from(document.querySelectorAll('h2')).find((x) => /Job & Data Pipeline/.test(String(x.textContent || '')));
      if (h) h.scrollIntoView({ block: 'start' });
    });
    await sleep(700);
    await page.evaluate(async () => {
      if (typeof refreshCanonicalEodHeader === 'function') await refreshCanonicalEodHeader();
    });
    await sleep(900);

    const m = await page.evaluate(() => {
      const tb = document.getElementById('jobsPipelineTbody');
      const table = tb ? tb.closest('table') : null;
      const tw = table ? table.closest('.tw') : null;
      const ths = table ? Array.from(table.querySelectorAll('thead th')) : [];
      const th = ths.find((x) => /ENABLED|Enable/i.test(String(x.textContent || ''))) || null;
      const sel = tb ? tb.querySelector('select[data-job]') : null;
      const r = (el) => el ? el.getBoundingClientRect() : null;
      const twr = r(tw), etr = r(th), selr = r(sel);
      const p6 = document.getElementById('panelTab6');
      const ac = document.getElementById('page-admin-console');
      return {
        diag: {
          panel6Display: p6 ? getComputedStyle(p6).display : null,
          adminPageDisplay: ac ? getComputedStyle(ac).display : null,
          rowCount: tb ? tb.querySelectorAll('tr[data-schedule-row]').length : 0,
          viewport: [window.innerWidth, window.innerHeight],
          thWidths: ths.map((x) => Math.round(x.getBoundingClientRect().width)),
          thTexts: ths.map((x) => String(x.textContent || '').replace(/\s+/g, ' ').trim())
        },
        header: th ? String(th.textContent || '').replace(/\s+/g, ' ').trim() : null,
        thClipped: th ? (th.scrollWidth > th.clientWidth + 2) : null,
        twRight: twr ? Math.round(twr.right) : null,
        twWidth: twr ? Math.round(twr.width) : null,
        scrollWidth: tw ? tw.scrollWidth : null,
        clientWidth: tw ? tw.clientWidth : null,
        thRight: etr ? Math.round(etr.right) : null,
        selRight: selr ? Math.round(selr.right) : null
      };
    });
    // Diagnostic geometry is part of the evidence, not a screenshot.
    console.log('SERVED_ADMIN_GEOMETRY=' + JSON.stringify(m));
    assert.ok(m.header, 'ENABLED / Aktif header present on served surface');
    assert.equal(m.thClipped, false, 'header text not clipped: ' + JSON.stringify(m));
    assert.ok(m.thRight !== null && m.thRight <= m.twRight + 1,
      'ENABLED header inside scroll container: ' + JSON.stringify(m));
    assert.ok(m.selRight !== null && m.selRight <= m.twRight + 1,
      'ENABLED select inside scroll container: ' + JSON.stringify(m));
  });
});
