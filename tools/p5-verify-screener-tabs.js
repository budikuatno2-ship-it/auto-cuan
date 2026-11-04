'use strict';
// P5 — Verifikasi Playwright nyata: buka Screener, klik tab Konglo/Non-Konglo/Day Trade.
// Ketiga tab wajib render baris saham riil dengan 0 console.error, 0 pageerror, 0 pesan error.
// Tanpa print secret. Output JSON ke stdout + file bila diminta.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const ORIGIN = process.env.P5_ORIGIN || 'http://127.0.0.1:3000';
const OUT_PATH = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : null;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function tabReport(page, type, btnId, paneId, tbodyId) {
  await page.evaluate((t) => {
    if (typeof switchScreenerType === 'function') switchScreenerType(t);
  }, type);
  await pause(2500);
  return page.evaluate((paneId2, tbodyId2, btnId2) => {
    const pane = document.getElementById(paneId2);
    const tbody = document.getElementById(tbodyId2);
    const btn = document.getElementById(btnId2);
    const rows = tbody ? Array.from(tbody.querySelectorAll('tr')) : [];
    const realRows = rows.filter((tr) => {
      const txt = (tr.innerText || '').trim();
      if (!txt) return false;
      if (/belum ada|gagal|error|login|memuat/i.test(txt) && txt.length < 120) return false;
      return /[A-Z]{3,}/.test(txt);
    });
    const firstTickers = realRows.slice(0, 5).map((tr) => (tr.innerText || '').trim().slice(0, 12));
    return {
      paneVisible: !!(pane && !pane.classList.contains('hidden')),
      btnPressed: btn ? btn.getAttribute('aria-pressed') : null,
      totalTr: rows.length,
      realRows: realRows.length,
      firstTickers
    };
  }, paneId, tbodyId, btnId);
}

async function run() {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900']
  });
  const consoleErrors = [];
  const pageErrors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
    });
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err).slice(0, 300)));
    await page.goto(ORIGIN + '/preview/screener', { waitUntil: 'networkidle2', timeout: 45000 });
    await pause(3000);
    // Pastikan masuk halaman screener.
    const onScreener = await page.evaluate(() => !!document.getElementById('page-screener'));
    const konglo = await tabReport(page, 'konglo', 'scrTypeKonglo', 'screenerKongloPane', 'screenerTableBody');
    const nk = await tabReport(page, 'nonkonglo', 'scrTypeNonKonglo', 'screenerNonKongloPane', 'nkScreenerTableBody');
    const dt = await tabReport(page, 'daytrade', 'scrTypeDayTrade', 'screenerDayTradePane', 'dtScreenerTableBody');
    const shotDir = path.resolve(__dirname, '..', 'bukti-verifikasi-final', 'faseP5');
    try { fs.mkdirSync(shotDir, { recursive: true }); } catch (_) {}
    try { await page.screenshot({ path: path.join(shotDir, 'screener-daytrade-tab.png') }); } catch (_) {}
    const result = {
      ok: true,
      origin: ORIGIN,
      onScreener,
      tabs: { konglo, nonkonglo: nk, daytrade: dt },
      consoleErrors,
      pageErrors,
      pass: onScreener === true
        && konglo.realRows > 0 && nk.realRows > 0 && dt.realRows > 0
        && consoleErrors.length === 0 && pageErrors.length === 0
    };
    if (OUT_PATH) {
      fs.mkdirSync(path.dirname(path.resolve(OUT_PATH)), { recursive: true });
      fs.writeFileSync(path.resolve(OUT_PATH), JSON.stringify(result, null, 2));
    }
    console.log(JSON.stringify(result, null, 2));
    await browser.close();
    process.exitCode = result.pass ? 0 : 2;
  } catch (e) {
    try { await browser.close(); } catch (_) {}
    const fail = { ok: false, error: String(e && e.message || e), consoleErrors, pageErrors, pass: false };
    console.log(JSON.stringify(fail, null, 2));
    if (OUT_PATH) {
      try {
        fs.mkdirSync(path.dirname(path.resolve(OUT_PATH)), { recursive: true });
        fs.writeFileSync(path.resolve(OUT_PATH), JSON.stringify(fail, null, 2));
      } catch (_) {}
    }
    process.exitCode = 1;
  }
}

run();
