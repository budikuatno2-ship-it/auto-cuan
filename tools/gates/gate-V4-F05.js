'use strict';

/**
 * tools/gates/gate-V4-F05.js
 * Gate Penguji Anti-Bohong FASE V4-F05:
 * 1. Periksa berkas data/ohlcv/IHSG.json dan respon API /api/chart?ticker=IHSG:
 *    - Harga close bar terakhir IHSG wajib > 6000 (kisaran wajar ~7.000 s.d. 7.700).
 *    - Bukan 4904.29 atau 5266.13.
 * 2. Periksa berkas data/ohlcv/BBCA.json dan respon API /api/chart?ticker=BBCA:
 *    - Harga close bar terakhir BBCA wajib > 7500 (kisaran wajar ~9.000 s.d. 10.500).
 *    - Bukan 4840.
 * 3. Buka Playwright browser pada /dashboard dan /analisis-saham?ticker=IHSG:
 *    - Header radar/dashboard TIDAK memuat teks "1 Nov 2026".
 *    - Teks harga IHSG di bar/layar tidak menampilkan "4.904" atau "5.266".
 * 4. Catat bukti otentik ke bukti-verifikasi-final/gates-v4/F05.json.
 * 5. Cetak 'PASS: Gate V4-F05 LULUS'.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v4', 'F05.json');

const result = lib.newResult(
  'V4-F05',
  'Pemulihan Data Harga Riil Yahoo Finance (IHSG & 963 Saham BEI — 0 Kuota Arjum) & Perbaikan Timestamp Radar'
);

// --- Kontrol Negatif (Negative Control Validator) ---
function f05Validator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (typeof sample.ihsgClose !== 'number' || sample.ihsgClose <= 6000) return false;
  if (sample.ihsgClose === 4904.29 || sample.ihsgClose === 5266.13) return false;
  if (typeof sample.bbcaClose !== 'number' || sample.bbcaClose <= 7500) return false;
  if (sample.bbcaClose === 4840) return false;
  if (sample.hasStaleDateNov1 === true) return false;
  if (sample.hasCorruptIhsgDisplay === true) return false;
  return true;
}

const negativeSamples = [
  null,
  // Sampel korup 1: IHSG rusak pada harga 4904.29
  {
    ihsgClose: 4904.29,
    bbcaClose: 9860,
    hasStaleDateNov1: false,
    hasCorruptIhsgDisplay: false
  },
  // Sampel korup 2: IHSG rusak pada harga 5266.13
  {
    ihsgClose: 5266.13,
    bbcaClose: 9860,
    hasStaleDateNov1: false,
    hasCorruptIhsgDisplay: false
  },
  // Sampel korup 3: BBCA rusak salah split ganda 4840
  {
    ihsgClose: 7480.25,
    bbcaClose: 4840,
    hasStaleDateNov1: false,
    hasCorruptIhsgDisplay: false
  },
  // Sampel korup 4: Layar masih memuat teks basi "1 Nov 2026"
  {
    ihsgClose: 7480.25,
    bbcaClose: 9860,
    hasStaleDateNov1: true,
    hasCorruptIhsgDisplay: false
  },
  // Sampel korup 5: Layar masih menampilkan harga 4.904 atau 5.266
  {
    ihsgClose: 7480.25,
    bbcaClose: 9860,
    hasStaleDateNov1: false,
    hasCorruptIhsgDisplay: true
  }
];

const nc = lib.runNegativeControl(negativeSamples, f05Validator);
result.negativeControl = {
  description: 'Injeksi sampel korup (IHSG 4904.29/5266.13, BBCA salah split 4840, timestamp basi 1 Nov 2026, display korup); validator wajib menolak 100%',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

function findBrowserExe() {
  const sys = 'C:';
  const c = [
    sys + '\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    sys + '\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    sys + '\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    sys + '\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const p of c) {
    try {
      fs.statSync(p);
      return p;
    } catch (_) {}
  }
  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function waitForServer(port, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
        if (res.statusCode === 200) return resolve();
        setTimeout(check, 100);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('Server start timeout'));
        setTimeout(check, 100);
      });
      req.end();
    };
    check();
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('[GATE V4-F05] Memulai Verifikasi Otentik Harga Riil & Timestamp Radar...');

  let browser = null;
  let playwright = null;
  try { playwright = require('playwright'); } catch (_) {}

  if (playwright && playwright.chromium) {
    console.log('[BROWSER] Menggunakan engine Playwright Chromium');
    browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900']
    });
  } else {
    console.log('[BROWSER] Menggunakan engine Puppeteer-Core');
    const puppeteer = require('puppeteer-core');
    const exe = findBrowserExe();
    if (!exe) throw new Error('Browser Chromium tidak ditemukan di sistem!');
    browser = await puppeteer.launch({
      executablePath: exe,
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900']
    });
  }

  const testPort = await getFreePort();
  console.log(`[SERVER] Memulai server terisolasi pada port ${testPort}...`);
  const serverChild = spawn(process.execPath, [path.join(ROOT, 'tools', 'local-dev-server.js')], {
    env: { ...process.env, PORT: String(testPort), HOST: '127.0.0.1', NODE_ENV: 'test' },
    stdio: 'ignore'
  });

  try {
    await waitForServer(testPort);
    const baseUrl = `http://127.0.0.1:${testPort}`;

    // =========================================================================
    // ASERSI 1: File data/ohlcv/IHSG.json & Respon API /api/chart?ticker=IHSG
    // =========================================================================
    console.log('[ASERSI 1] Memeriksa data/ohlcv/IHSG.json dan /api/chart?ticker=IHSG...');
    const ihsgFilePath = path.join(ROOT, 'data', 'ohlcv', 'IHSG.json');
    const ihsgFileExists = fs.existsSync(ihsgFilePath);
    let ihsgFileClose = 0;
    if (ihsgFileExists) {
      const fileData = JSON.parse(fs.readFileSync(ihsgFilePath, 'utf8'));
      const candles = fileData.candles || fileData;
      ihsgFileClose = candles.length ? Number(candles[candles.length - 1].close) : 0;
    }

    const ihsgApiRes = await fetchJson(`${baseUrl}/api/chart?ticker=IHSG`);
    const ihsgApiCandles = (ihsgApiRes.json && ihsgApiRes.json.candles) || [];
    const ihsgApiClose = ihsgApiCandles.length ? Number(ihsgApiCandles[ihsgApiCandles.length - 1].close) : 0;

    const assert1Pass = ihsgFileExists &&
      ihsgFileClose > 6000 &&
      ihsgFileClose !== 4904.29 &&
      ihsgFileClose !== 5266.13 &&
      ihsgApiRes.status === 200 &&
      ihsgApiClose > 6000 &&
      ihsgApiClose !== 4904.29 &&
      ihsgApiClose !== 5266.13;

    lib.addAssertion(
      result,
      'Asersi 1: IHSG File & API /api/chart wajib > 6000 dan bukan 4904.29 / 5266.13',
      assert1Pass,
      '> 6000 (kisaran wajar ~7.000 s.d. 7.700, bukan 4904.29 atau 5266.13)',
      `File close: ${ihsgFileClose}, API close: ${ihsgApiClose}`
    );

    // =========================================================================
    // ASERSI 2: File data/ohlcv/BBCA.json & Respon API /api/chart?ticker=BBCA
    // =========================================================================
    console.log('[ASERSI 2] Memeriksa data/ohlcv/BBCA.json dan /api/chart?ticker=BBCA...');
    const bbcaFilePath = path.join(ROOT, 'data', 'ohlcv', 'BBCA.json');
    const bbcaFileExists = fs.existsSync(bbcaFilePath);
    let bbcaFileClose = 0;
    if (bbcaFileExists) {
      const fileData = JSON.parse(fs.readFileSync(bbcaFilePath, 'utf8'));
      const candles = fileData.candles || fileData;
      bbcaFileClose = candles.length ? Number(candles[candles.length - 1].close) : 0;
    }

    const bbcaApiRes = await fetchJson(`${baseUrl}/api/chart?ticker=BBCA`);
    const bbcaApiCandles = (bbcaApiRes.json && bbcaApiRes.json.candles) || [];
    const bbcaApiClose = bbcaApiCandles.length ? Number(bbcaApiCandles[bbcaApiCandles.length - 1].close) : 0;

    const assert2Pass = bbcaFileExists &&
      bbcaFileClose > 7500 &&
      bbcaFileClose !== 4840 &&
      bbcaApiRes.status === 200 &&
      bbcaApiClose > 7500 &&
      bbcaApiClose !== 4840;

    lib.addAssertion(
      result,
      'Asersi 2: BBCA File & API /api/chart wajib > 7500 dan bukan 4840 (bebas split ganda)',
      assert2Pass,
      '> 7500 (kisaran wajar ~9.000 s.d. 10.500, bukan 4840)',
      `File close: ${bbcaFileClose}, API close: ${bbcaApiClose}`
    );

    // =========================================================================
    // ASERSI 3: Playwright Browser Test pada /dashboard
    // =========================================================================
    console.log('[ASERSI 3] Membuka /dashboard dan mengaudit DOM...');
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'load', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2000));

    const dashBodyText = await page.evaluate(() => document.body.innerText || '');
    const dashRadarChip = await page.evaluate(() => {
      const chip = document.getElementById('globalLiveRadarChip');
      return chip ? chip.innerText.trim() : '';
    });
    const dashIhsgPrice = await page.evaluate(() => {
      const el = document.getElementById('ihsgLast');
      return el ? el.innerText.trim() : '';
    });

    const hasStaleNov1Dash = dashBodyText.includes('1 Nov 2026') || dashRadarChip.includes('1 Nov 2026');
    const hasCorruptIhsgDash = dashBodyText.includes('4.904') || dashBodyText.includes('5.266') ||
      dashIhsgPrice.includes('4.904') || dashIhsgPrice.includes('5.266');

    const assert3Pass = !hasStaleNov1Dash && !hasCorruptIhsgDash;

    lib.addAssertion(
      result,
      'Asersi 3: Halaman /dashboard TIDAK memuat "1 Nov 2026" dan IHSG tidak menampilkan 4.904 atau 5.266',
      assert3Pass,
      'Bebas dari teks "1 Nov 2026", "4.904", "5.266"',
      `Radar Chip: "${dashRadarChip}", IHSG Last: "${dashIhsgPrice}", StaleNov1: ${hasStaleNov1Dash}, CorruptIhsg: ${hasCorruptIhsgDash}`
    );

    // =========================================================================
    // ASERSI 4: Playwright Browser Test pada /analisis-saham?ticker=IHSG
    // =========================================================================
    console.log('[ASERSI 4] Membuka /analisis-saham?ticker=IHSG dan mengaudit DOM...');
    await page.goto(`${baseUrl}/analisis-saham?ticker=IHSG`, { waitUntil: 'load', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2500));

    const analisisBodyText = await page.evaluate(() => document.body.innerText || '');
    const analisisRadarChip = await page.evaluate(() => {
      const chip = document.getElementById('globalLiveRadarChip');
      return chip ? chip.innerText.trim() : '';
    });

    const hasStaleNov1Analisis = analisisBodyText.includes('1 Nov 2026') || analisisRadarChip.includes('1 Nov 2026');
    const hasCorruptIhsgAnalisis = analisisBodyText.includes('4.904') || analisisBodyText.includes('5.266');

    const assert4Pass = !hasStaleNov1Analisis && !hasCorruptIhsgAnalisis;

    lib.addAssertion(
      result,
      'Asersi 4: Halaman /analisis-saham?ticker=IHSG TIDAK memuat "1 Nov 2026" dan harga tidak menampilkan 4.904 atau 5.266',
      assert4Pass,
      'Bebas dari teks "1 Nov 2026", "4.904", "5.266"',
      `Radar Chip: "${analisisRadarChip}", StaleNov1: ${hasStaleNov1Analisis}, CorruptIhsg: ${hasCorruptIhsgAnalisis}`
    );

    await page.close();

    // =========================================================================
    // REKAPITULASI HASIL GATE
    // =========================================================================
    console.log('\n--- HASIL ASERSI DETAIL GATE V4-F05 ---');
    for (const a of result.assertions) {
      const mark = a.pass ? '✔ PASS' : '✖ FAIL';
      console.log(`${mark}: ${a.name}`);
      console.log(`   Expected: ${a.expected}`);
      console.log(`   Actual:   ${a.actual}`);
    }

    const allPassed = result.assertions.every((a) => a.pass === true);
    if (allPassed) {
      console.log('\n======================================================');
      console.log('PASS: Gate V4-F05 LULUS');
      console.log('======================================================\n');
    } else {
      console.error('\nFAIL: Gate V4-F05 GAGAL');
      process.exitCode = 1;
    }

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    lib.finalizeGate(result, OUT);

  } catch (err) {
    console.error('Error saat eksekusi Gate V4-F05:', err);
    result.error = err.message;
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    lib.finalizeGate(result, OUT);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (serverChild) {
      try {
        serverChild.kill('SIGTERM');
      } catch (_) {}
    }
  }
}

main().catch((err) => {
  console.error('[GATE V4-F05 FATAL ERROR]', err);
  process.exit(1);
});
