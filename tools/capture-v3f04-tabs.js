'use strict';
// V3-F04 — Capture 3 tab screener berbeda (konglo / nonkonglo / daytrade).
// Output: bukti-verifikasi-final/faseP5/screener-{konglo,nonkonglo,daytrade}-v3f04.png
// BESI: no GH polling/sleep, no Vercel, Windows node -e, data riil, anti-gate-gaming
// (3 file berbeda, hash berbeda — dilarang screenshot kembar).
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const ORIGIN = process.env.P5_ORIGIN || 'http://127.0.0.1:3000';
const OUT_DIR = path.resolve(__dirname, '..', 'bukti-verifikasi-final', 'faseP5');

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, type, file) {
  await page.evaluate((t) => {
    if (typeof switchScreenerType === 'function') switchScreenerType(t);
  }, type);
  await pause(2500);
  const info = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    bodyLen: (document.body ? document.body.innerText.length : 0)
  }));
  await page.screenshot({ path: path.join(OUT_DIR, file) });
  return info;
}

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900']
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(ORIGIN + '/preview/screener', { waitUntil: 'networkidle2', timeout: 45000 });
    await pause(3000);
    const r = {};
    r.konglo = await shot(page, 'konglo', 'screener-konglo-v3f04.png');
    r.nonkonglo = await shot(page, 'nonkonglo', 'screener-nonkonglo-v3f04.png');
    r.daytrade = await shot(page, 'daytrade', 'screener-daytrade-v3f04.png');
    console.log(JSON.stringify({ ok: true, origin: ORIGIN, shots: r }, null, 2));
    await browser.close();
    process.exitCode = 0;
  } catch (e) {
    try { await browser.close(); } catch (_) {}
    console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
    process.exitCode = 1;
  }
}

run();
