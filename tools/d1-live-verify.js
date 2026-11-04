'use strict';
// D1 live verification: Playwright langsung ke https://autocuan.web.id, login Admin,
// kumpulkan HTTP status, console.error, pageerror, kuota dinamis, DayTrade, Screener,
// dan tangkapan live ke bukti-verifikasi-final/faseD1/.
// Kredensial admin dibaca dari env AC_TEST_USER/AC_TEST_PASS (tidak pernah di-print).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FASE = path.join(ROOT, 'bukti-verifikasi-final', 'faseD1');
const LIVE_URL = 'https://autocuan.web.id';

function findBrowserExe() {
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const p of cands) {
    try {
      fs.statSync(p);
      return p;
    } catch (_) {}
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(FASE, { recursive: true });
  const exe = findBrowserExe();
  if (!exe) {
    console.error('BROWSER_NOT_FOUND');
    process.exit(1);
  }
  const user = process.env.AC_TEST_USER || '';
  const pass = process.env.AC_TEST_PASS || '';
  if (!user || !pass) {
    console.error('ADMIN_CREDS_MISSING (set AC_TEST_USER/AC_TEST_PASS env, tanpa print nilai)');
    process.exit(1);
  }
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(String(m.text()).slice(0, 300));
  });
  page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e).slice(0, 300)));

  const out = { url: LIVE_URL, httpStatus: 0, consoleErrors: [], pageErrors: [], quota: null, daytrade: null, screener: null, shots: [] };

  async function shot(name) {
    const fp = path.join(FASE, name);
    await page.screenshot({ path: fp, fullPage: false });
    out.shots.push(name);
  }

  // 1. Landing
  let resp = await page.goto(LIVE_URL + '/', { waitUntil: 'networkidle2', timeout: 60000 });
  out.httpStatus = resp ? resp.status() : 0;
  await sleep(2000);
  await shot('D1-01-landing.png');

  // 2. Masuk (login modal)
  await page.evaluate(() => {
    if (typeof openLoginModal === 'function') openLoginModal();
    else {
      const b = document.querySelector('button[onclick*="openLoginModal"]') || document.getElementById('navLoginBtn');
      if (b) b.click();
    }
  });
  await sleep(1200);
  await shot('D1-02-masuk.png');

  // 3. Login sebagai Admin (kredensial dari env, tidak di-print)
  await page.evaluate((u, p) => {
    const ui = document.getElementById('loginUsername');
    const pw = document.getElementById('loginPassword');
    if (ui) {
      ui.focus();
      ui.value = '';
      document.execCommand && document.execCommand('selectAll', false, null);
    }
    if (pw) pw.value = '';
    if (ui) {
      ui.value = u;
      ui.dispatchEvent(new Event('input', { bubbles: true }));
      ui.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (pw) {
      pw.value = p;
      pw.dispatchEvent(new Event('input', { bubbles: true }));
      pw.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, user, pass);
  await sleep(500);
  await page.evaluate(() => {
    if (typeof doLogin === 'function') doLogin();
    else {
      const f = document.getElementById('loginForm');
      if (f) f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
  });
  await sleep(6000);
  await shot('D1-03-dashboard.png');

  // 4. Dashboard state
  const dash = await page.evaluate(() => ({
    bodyLen: (document.body.innerText || '').length,
    head: (document.body.innerText || '').slice(0, 200).replace(/\s+/g, ' ')
  }));
  out.dashboard = dash;

  // 5. Screener 3 mode
  await page.evaluate(() => {
    if (typeof navigateTo === 'function') navigateTo('screener');
  });
  await sleep(4000);
  await shot('D1-04-screener-daytrade.png');
  const screener = await page.evaluate(() => {
    const t = document.body.innerText || '';
    const rows = document.querySelectorAll('table tbody tr').length;
    return { bodyLen: t.length, tableRows: rows, hasError: /error|gagal|tidak dapat/i.test(t.slice(0, 2000)) };
  });
  out.screenerProbe = screener;

  // 6. Analisis & Chart BBCA + IHSG
  await page.evaluate(() => {
    if (typeof navigateTo === 'function') navigateTo('analisis', 'analisis-chart');
  });
  await sleep(4000);
  await shot('D1-05-analisis-chart-BBCA.png');
  await page.evaluate(() => {
    const inp = document.getElementById('analisisInput') || document.getElementById('chartTickerInput');
    if (inp) {
      inp.value = 'IHSG';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    if (typeof UnifiedCockpit !== 'undefined' && typeof UnifiedCockpit.loadUnifiedChart === 'function') {
      try { UnifiedCockpit.loadUnifiedChart('IHSG'); } catch (_) {}
    }
  });
  await sleep(4000);
  await shot('D1-06-analisis-chart-IHSG.png');

  // 7. Bandarmologi
  await page.evaluate(() => {
    if (typeof navigateTo === 'function') navigateTo('analisis', 'bandarmologi');
  });
  await sleep(3500);
  await shot('D1-07-bandarmologi.png');

  // 8. Financial BRPT Q2 2026
  await page.evaluate(() => {
    if (typeof navigateTo === 'function') navigateTo('analisis', 'financial');
  });
  await sleep(3500);
  await page.evaluate(() => {
    const inp = document.getElementById('financialTickerInput');
    if (inp) {
      inp.value = 'BRPT';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
  });
  await sleep(3500);
  await shot('D1-08-financial-BRPT-Q2-2026.png');

  // 9. Struktur Pasar
  await page.evaluate(() => {
    if (typeof navigateTo === 'function') navigateTo('analisis', 'market-structure');
  });
  await sleep(3500);
  await shot('D1-09-struktur-pasar.png');

  // 10. Kelola Keuangan
  await page.evaluate(() => {
    if (typeof navigateTo === 'function') navigateTo('money-management');
  });
  await sleep(3500);
  await shot('D1-10-kelola-keuangan.png');

  // 11. Admin Console Ringkasan + kuota + daytrade + screener modes
  await page.evaluate(() => {
    if (typeof navigateTo === 'function') navigateTo('admin-console');
  });
  await sleep(5000);
  await shot('D1-11-admin-console-ringkasan.png');
  const admin = await page.evaluate(() => {
    const qEl = document.getElementById('statQuotaNum');
    const quotaText = qEl ? (qEl.innerText || '') : '';
    const quotaLabel = (() => {
      const els = Array.from(document.querySelectorAll('.lbl'));
      const hit = els.find((e) => /Kuota API data/i.test(e.textContent || ''));
      return hit ? hit.textContent.trim() : '';
    })();
    const t = document.body.innerText || '';
    return { quotaText, quotaLabel, bodyLen: t.length, bodyHead: t.slice(0, 500) };
  });
  out.quota = { text: admin.quotaText, label: admin.quotaLabel || 'Kuota API data' };
  out.quotaLabelOk = /Kuota API data/i.test(admin.quotaLabel || '');

  // DayTrade snapshot via API kuota + screener modes via DOM/API
  const extra = await page.evaluate(async () => {
    const res = {};
    try {
      const r = await fetch('/api/sector-hot?action=daytrade-screener', { credentials: 'same-origin' });
      const j = await r.json();
      const rows = Array.isArray(j.rows) ? j.rows : (Array.isArray(j.data) ? j.data : []);
      res.daytrade = { rows: rows.length, snapshotDate: j.snapshotDate || j.as_of || null, stale: j.stale === true, error: j.success === false ? (j.error || 'api-false') : null };
    } catch (e) {
      res.daytrade = { rows: 0, error: String((e && e.message) || e).slice(0, 120) };
    }
    try {
      const modes = {};
      for (const m of ['daytrade', 'konglo', 'nonkonglo']) {
        try {
          const r = await fetch('/api/sector-hot?action=screener&mode=' + m, { credentials: 'same-origin' });
          const j = await r.json();
          const rows = Array.isArray(j.rows) ? j.rows : (Array.isArray(j.data) ? j.data : []);
          modes[m] = { rows: rows.length, error: j.success === false ? (j.error || 'api-false') : null };
        } catch (e) {
          modes[m] = { rows: 0, error: String((e && e.message) || e).slice(0, 120) };
        }
      }
      res.screener = { modes };
    } catch (e) {
      res.screener = { error: String((e && e.message) || e).slice(0, 120), modes: {} };
    }
    return res;
  });
  out.daytrade = extra.daytrade;
  out.screener = extra.screener;

  // Admin Console tab Job & Data Pipeline + Keamanan
  await page.evaluate(() => {
    if (typeof switchAdminTab === 'function') {
      try { switchAdminTab(1); } catch (_) {}
    }
  });
  await sleep(2500);
  await shot('D1-12-admin-console-job-pipeline.png');
  await page.evaluate(() => {
    if (typeof switchAdminTab === 'function') {
      try { switchAdminTab(8); } catch (_) {}
    }
  });
  await sleep(2500);
  await shot('D1-13-admin-console-keamanan.png');

  out.consoleErrors = consoleErrors;
  out.pageErrors = pageErrors;
  out.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(FASE, 'live-verify.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ http: out.httpStatus, ce: consoleErrors.length, pe: pageErrors.length, shots: out.shots.length }, null, 2));
  await browser.close();
  if (out.httpStatus !== 200 || consoleErrors.length > 0 || pageErrors.length > 0) process.exit(1);
})().catch((e) => {
  console.error('LIVE_VERIFY_FATAL: ' + String((e && e.message) || e).slice(0, 300));
  process.exit(1);
});
