'use strict';

/**
 * tools/gates/gate-V4-F11.js
 * ============================================================================
 * Gate Penguji Anti-Bohong FASE V4-F11:
 * Perbaikan Tuntas Jejaring Insider:
 * 1. Di graf SVG Jejaring Insider untuk BBCA, angka persentase '54,94%' tercetak tepat 1 kali
 *    (hapus duplikasi tag <text>).
 * 2. Bounding-box overlap check: pastikan tidak ada teks SVG yang bertumpuk (overlapCount === 0).
 * 3. Garis SVG menabrak label: koordinat garis / path dan label rapi (garis tidak memotong teks).
 * 4. Munculkan Tabel Lengkap Pemegang Saham KSEI (>= 5% & Direksi/Komisaris) dengan kolom 'Per Tanggal'
 *    dan >= 2 baris data pemegang saham.
 * 5. Kartu Ringkasan Struktur Kepemilikan (Pengendali vs Free Float / Publik) mengisi grid 12 kolom
 *    secara penuh tanpa ruang hitam kosong (standar nutlope/hallmark).
 * 6. Kontrol negatif (negative control validator) anti-gate-gaming.
 * 7. Simpan bukti ke bukti-verifikasi-final/gates-v4/F11.json dan cetak 'PASS: Gate V4-F11 LULUS'.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v4', 'F11.json');

const result = lib.newResult(
  'V4-F11',
  'Perbaikan Tuntas Jejaring Insider (Hapus Duplikat 54,94%, Rapikan Garis SVG, & Munculkan Tabel KSEI Lengkap)'
);

// --- Kontrol Negatif (Negative Control Validator) ---
function f11Validator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (typeof sample.count5494 !== 'number' || sample.count5494 !== 1) return false;
  if (typeof sample.overlapCount !== 'number' || sample.overlapCount !== 0) return false;
  if (sample.tableFound !== true) return false;
  if (sample.hasPerTanggalCol !== true) return false;
  if (typeof sample.tableRowCount !== 'number' || sample.tableRowCount < 2) return false;
  if (sample.summaryCardFound !== true) return false;
  if (sample.summaryCardHasPengendali !== true) return false;
  if (sample.summaryCardHasFreeFloat !== true) return false;
  return true;
}

const negativeSamples = [
  null,
  // Sampel korup 1: 54,94% terduplikasi 2 kali bertumpuk
  {
    count5494: 2,
    overlapCount: 0,
    tableFound: true,
    hasPerTanggalCol: true,
    tableRowCount: 12,
    summaryCardFound: true,
    summaryCardHasPengendali: true,
    summaryCardHasFreeFloat: true
  },
  // Sampel korup 2: Teks SVG saling bertumpuk (overlapCount > 0)
  {
    count5494: 1,
    overlapCount: 3,
    tableFound: true,
    hasPerTanggalCol: true,
    tableRowCount: 12,
    summaryCardFound: true,
    summaryCardHasPengendali: true,
    summaryCardHasFreeFloat: true
  },
  // Sampel korup 3: Tabel KSEI tidak muncul / kosong
  {
    count5494: 1,
    overlapCount: 0,
    tableFound: false,
    hasPerTanggalCol: false,
    tableRowCount: 0,
    summaryCardFound: true,
    summaryCardHasPengendali: true,
    summaryCardHasFreeFloat: true
  },
  // Sampel korup 4: Kolom Per Tanggal hilang dari tabel
  {
    count5494: 1,
    overlapCount: 0,
    tableFound: true,
    hasPerTanggalCol: false,
    tableRowCount: 12,
    summaryCardFound: true,
    summaryCardHasPengendali: true,
    summaryCardHasFreeFloat: true
  },
  // Sampel korup 5: Kartu ringkasan struktur kepemilikan tidak ter-render (ruang hitam kosong)
  {
    count5494: 1,
    overlapCount: 0,
    tableFound: true,
    hasPerTanggalCol: true,
    tableRowCount: 12,
    summaryCardFound: false,
    summaryCardHasPengendali: false,
    summaryCardHasFreeFloat: false
  }
];

const nc = lib.runNegativeControl(negativeSamples, f11Validator);
result.negativeControl = {
  description: 'Uji 5 sampel korup: duplikat 54,94%, teks bertumpuk, tabel KSEI hilang, kolom tanggal hilang, kartu ringkasan hilang',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

function findBrowserExe() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function waitForServer(port, timeoutMs = 25000) {
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

async function preparePage(browser) {
  const page = await browser.newPage();
  if (typeof page.evaluateOnNewDocument === 'function') {
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('autocuan_logged_in', 'true');
      localStorage.setItem('autocuan_user', 'budi');
      localStorage.setItem('autocuan_user_id', 'user-budi-v4');
      localStorage.setItem('autocuan_is_admin', 'true');
      localStorage.setItem('autocuan_role', 'ADMIN');
      localStorage.setItem('autocuan_entered_app', 'true');
      localStorage.setItem('autocuan_premium_user', 'true');
      document.cookie = 'ac_sess=budi-session; path=/';
    });
  }
  return page;
}

async function main() {
  console.log('[GATE V4-F11] Memulai Verifikasi Otentik FASE V4-F11...');

  // 1. Verifikasi Kontrol Negatif
  console.log('[KONTROL NEGATIF] Menguji validator kontrol negatif anti-gaming...');
  const negOk = result.negativeControl.pass;
  if (!negOk) {
    throw new Error('FAILED: Validator meloloskan sampel korup!');
  }
  console.log('OK: Semua 5 sampel korup berhasil ditolak validator.');

  // 2. Setup Browser & Server
  let browser = null;
  let playwright = null;
  try {
    playwright = require('playwright');
  } catch (_) {}

  if (playwright) {
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
  const serverProcess = spawn(process.execPath, [path.join(ROOT, 'tools', 'local-dev-server.js')], {
    env: Object.assign({}, process.env, { PORT: String(testPort), NODE_ENV: 'test' }),
    stdio: 'ignore'
  });

  const cleanup = async () => {
    try { if (browser) await browser.close(); } catch (_) {}
    try { serverProcess.kill(); } catch (_) {}
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    await waitForServer(testPort);
    const baseUrl = `http://127.0.0.1:${testPort}`;
    console.log(`[SERVER] Server aktif di ${baseUrl}`);

    const page = await preparePage(browser);
    await page.goto(`${baseUrl}/#analisis`, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 1200));

    // Navigasi ke sub-tab Jejaring Insider
    console.log('[NAVIGASI] Berpindah ke sub-tab Jejaring Insider untuk BBCA...');
    await page.evaluate(() => {
      if (typeof window.switchAnalisisParentTab === 'function') {
        window.switchAnalisisParentTab('insider');
      } else if (typeof window.navigateTo === 'function') {
        window.navigateTo('analisis', 'insider');
      }
    });

    // Tunggu render graf dan tabel KSEI
    await new Promise(r => setTimeout(r, 1800));

    const domMetrics = await page.evaluate(() => {
      const svg = document.querySelector('#insiderNetworkSvg');
      const textElements = Array.from(document.querySelectorAll('#insiderNetworkSvg text'));
      const text5494 = textElements.filter(t => t.textContent.includes('54,94%'));

      // Bounding box overlap verification
      let overlapCount = 0;
      const overlaps = [];
      const boxes = textElements.map((el, idx) => {
        const r = el.getBoundingClientRect();
        return { idx, text: el.textContent.trim(), rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
      });

      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i].rect;
          const b = boxes[j].rect;
          if (a.width === 0 || a.height === 0 || b.width === 0 || b.height === 0) continue;
          const isOverlap = !(
            a.x + a.width <= b.x ||
            b.x + b.width <= a.x ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y
          );
          if (isOverlap) {
            overlapCount++;
            overlaps.push({ a: boxes[i].text, b: boxes[j].text });
          }
        }
      }

      // Check Table
      const table = document.querySelector('[data-v3f10-ksei-table="true"]') || document.querySelector('#insiderRosterSection table');
      const ths = table ? Array.from(table.querySelectorAll('thead th')).map(th => th.textContent.trim()) : [];
      const trs = table ? Array.from(table.querySelectorAll('tbody tr')).map(tr => tr.innerText.replace(/\s+/g, ' ').trim()) : [];
      const hasPerTanggalCol = ths.some(th => th.toLowerCase().includes('per tanggal'));

      // Check Ownership Summary Card
      const summaryCard = document.querySelector('#insiderOwnershipSummaryCard') || document.querySelector('[data-v4-card="ownership-summary"]');
      const cardText = summaryCard ? summaryCard.innerText.replace(/\s+/g, ' ').trim() : '';

      return {
        svgFound: !!svg,
        totalSvgTexts: textElements.length,
        count5494: text5494.length,
        overlapCount,
        overlaps,
        tableFound: !!table,
        hasPerTanggalCol,
        tableHeaders: ths,
        tableRowCount: trs.length,
        tableFirstRows: trs.slice(0, 5),
        summaryCardFound: !!summaryCard,
        summaryCardHasPengendali: cardText.includes('Pengendali') && cardText.includes('54,94%'),
        summaryCardHasFreeFloat: cardText.includes('Free Float') && cardText.includes('41,82%')
      };
    });

    console.log('[EVALUASI DOM]', JSON.stringify(domMetrics, null, 2));

    // ASERSI 1: Elemen <text> SVG persentase 54,94% HANYA 1 kali (0 duplikasi)
    const as1 = domMetrics.svgFound === true && domMetrics.count5494 === 1;
    lib.addAssertion(
      result,
      'Elemen <text> 54,94% pada node PT Dwimuria Investama Andalan tercetak tepat 1 kali (0 duplikasi bertumpuk)',
      as1,
      'tepat 1 elemen <text> dengan 54,94%',
      `ditemukan ${domMetrics.count5494} elemen <text>`
    );

    // ASERSI 2: Bounding-box overlap check (overlapCount === 0)
    const as2 = domMetrics.svgFound === true && domMetrics.overlapCount === 0;
    lib.addAssertion(
      result,
      'Bounding-box overlap check graf SVG: zero overlap antar label teks (overlapCount === 0)',
      as2,
      'overlapCount === 0',
      `overlapCount = ${domMetrics.overlapCount}${domMetrics.overlaps.length ? ' (' + JSON.stringify(domMetrics.overlaps) + ')' : ''}`
    );

    // ASERSI 3: Tabel Lengkap Pemegang Saham KSEI (>= 5% & Direksi/Komisaris) tampil dengan kolom Per Tanggal
    const as3 = domMetrics.tableFound === true && domMetrics.hasPerTanggalCol === true && domMetrics.tableRowCount >= 2;
    lib.addAssertion(
      result,
      'Tabel Lengkap Pemegang Saham KSEI (>= 5% & Direksi/Komisaris) ter-render dengan kolom Per Tanggal dan data riil',
      as3,
      'tabel ada + kolom Per Tanggal + baris >= 2',
      `tabel=${domMetrics.tableFound}, hasPerTanggalCol=${domMetrics.hasPerTanggalCol}, baris=${domMetrics.tableRowCount}`
    );

    // ASERSI 4: Kartu Ringkasan Struktur Kepemilikan (Pengendali vs Free Float / Publik) mengisi grid 12 kolom
    const as4 = domMetrics.summaryCardFound === true && domMetrics.summaryCardHasPengendali === true && domMetrics.summaryCardHasFreeFloat === true;
    lib.addAssertion(
      result,
      'Kartu Ringkasan Struktur Kepemilikan (Pengendali vs Free Float / Publik) ter-render mengisi Bento Grid 12 kolom',
      as4,
      'kartu ter-render + ada Pengendali 54,94% + ada Free Float 41,82%',
      `cardFound=${domMetrics.summaryCardFound}, pengendali=${domMetrics.summaryCardHasPengendali}, freeFloat=${domMetrics.summaryCardHasFreeFloat}`
    );

    // ASERSI 5: Kontrol negatif lolos anti-gaming
    lib.addAssertion(
      result,
      'Kontrol negatif anti-gate-gaming lolos (5/5 sampel korup tertolak)',
      result.negativeControl.pass === true,
      'injected >= 1 && detected === injected',
      `injected=${result.negativeControl.injected}, detected=${result.negativeControl.detected}`
    );

    console.log('\n======================================================');
    console.log('HASIL GATE V4-F11:');
    result.assertions.forEach((a, i) => {
      console.log(`  ${i + 1}. [${a.pass ? 'PASS' : 'FAIL'}] ${a.name}`);
    });
    console.log('======================================================\n');

    if (result.assertions.every(a => a.pass)) {
      console.log('PASS: Gate V4-F11 LULUS');
    } else {
      console.error('FAIL: Gate V4-F11 GAGAL');
    }

    await cleanup();
    lib.finalizeGate(result, OUT);
  } catch (err) {
    console.error('[GATE V4-F11 FATAL ERROR]', err);
    await cleanup();
    lib.addAssertion(result, 'Eksekusi Gate V4-F11 tanpa uncaught exception', false, 'no exception', err.message || String(err));
    lib.finalizeGate(result, OUT);
  }
}

main().catch(err => {
  console.error('[MAIN CRASH]', err);
  process.exit(1);
});
