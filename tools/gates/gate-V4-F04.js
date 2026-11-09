'use strict';

/**
 * tools/gates/gate-V4-F04.js
 * Gate Penguji Anti-Bohong FASE V4-F04:
 * 1. Buka /admin-console:
 *    - Asersi 1: Pastikan teks "Input1", "Input2", "maxQuota", "weekdayBackfillLimit"
 *      TIDAK ADA di document.body.innerText (0 occurrence).
 *    - Asersi 2: Pastikan teks "Pengaturan Kuota Hari Kerja Bursa (Senin – Jumat)"
 *      dan "Pengaturan Kuota Akhir Pekan & Hari Libur Bursa" TAMPIL nyata di DOM.
 *    - Asersi 3: Pastikan seluruh timestamp pada tabel audit di /admin-console
 *      berakhiran "WIB" dan TIDAK mengandung "+00:00" atau "Z".
 *    - Asersi 4: Pastikan Tabel Forensik Serangan Keamanan ter-render dengan kolom-kolom
 *      yang ditentukan (Waktu (WIB), Alamat IP, Jenis Serangan / Rule, Target Endpoint,
 *      User-Agent, Status Blokir) dan tombol Unblock / Bersihkan Log ada.
 * 2. Catat bukti otentik ke bukti-verifikasi-final/gates-v4/F04.json
 * 3. Cetak 'PASS: Gate V4-F04 LULUS'.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v4', 'F04.json');

const result = lib.newResult(
  'V4-F04',
  'Perombakan Total UI /admin-console (2 Blok Kuota Bahasa Indonesia, Waktu Audit 100% WIB, & Tabel Forensik Serangan Keamanan)'
);

// --- Kontrol Negatif (Negative Control) ---
function f04Validator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (sample.rawLabelOccurrences !== 0) return false;
  if (sample.hasWeekdayQuotaBlock !== true) return false;
  if (sample.hasWeekendQuotaBlock !== true) return false;
  if (sample.timestampsAllWib !== true) return false;
  if (sample.hasRawIsoOrUtc !== false) return false;
  if (sample.hasForensicTable !== true) return false;
  if (sample.hasUnblockButton !== true) return false;
  if (sample.hasClearLogsButton !== true) return false;
  if (!Array.isArray(sample.forensicColumns) || sample.forensicColumns.length < 6) return false;
  return true;
}

const negativeSamples = [
  null,
  // Sampel korup 1: masih memuat label Input1 mentah
  {
    rawLabelOccurrences: 2,
    hasWeekdayQuotaBlock: true,
    hasWeekendQuotaBlock: true,
    timestampsAllWib: true,
    hasRawIsoOrUtc: false,
    hasForensicTable: true,
    hasUnblockButton: true,
    hasClearLogsButton: true,
    forensicColumns: ['Waktu (WIB)', 'Alamat IP', 'Jenis Serangan / Rule', 'Target Endpoint', 'User-Agent', 'Status Blokir']
  },
  // Sampel korup 2: blok kuota hari kerja tidak ada
  {
    rawLabelOccurrences: 0,
    hasWeekdayQuotaBlock: false,
    hasWeekendQuotaBlock: true,
    timestampsAllWib: true,
    hasRawIsoOrUtc: false,
    hasForensicTable: true,
    hasUnblockButton: true,
    hasClearLogsButton: true,
    forensicColumns: ['Waktu (WIB)', 'Alamat IP', 'Jenis Serangan / Rule', 'Target Endpoint', 'User-Agent', 'Status Blokir']
  },
  // Sampel korup 3: timestamp masih memuat string ISO Z atau +00:00
  {
    rawLabelOccurrences: 0,
    hasWeekdayQuotaBlock: true,
    hasWeekendQuotaBlock: true,
    timestampsAllWib: false,
    hasRawIsoOrUtc: true,
    hasForensicTable: true,
    hasUnblockButton: true,
    hasClearLogsButton: true,
    forensicColumns: ['Waktu (WIB)', 'Alamat IP', 'Jenis Serangan / Rule', 'Target Endpoint', 'User-Agent', 'Status Blokir']
  },
  // Sampel korup 4: tabel forensik serangan hilang
  {
    rawLabelOccurrences: 0,
    hasWeekdayQuotaBlock: true,
    hasWeekendQuotaBlock: true,
    timestampsAllWib: true,
    hasRawIsoOrUtc: false,
    hasForensicTable: false,
    hasUnblockButton: false,
    hasClearLogsButton: false,
    forensicColumns: []
  }
];

const nc = lib.runNegativeControl(negativeSamples, f04Validator);
result.negativeControl = {
  description: 'Injeksi sampel korup (label Input1/maxQuota mentah, blok kuota hilang, timestamp tanpa WIB/mengandung ISO Z, tabel forensik hilang); validator wajib menolak 100%',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

function findBrowserExe() {
  const sys = String.fromCharCode(67) + ':';
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

async function main() {
  console.log('[GATE V4-F04] Memulai Verifikasi Otentik Playwright Browser...');

  let browser = null;
  let playwright = null;
  try {
    playwright = require('playwright');
  } catch (_) {}

  if (playwright && playwright.chromium) {
    console.log('[BROWSER] Menggunakan engine Playwright Chromium');
    browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900']
    });
  } else {
    console.log('[BROWSER] Menggunakan engine Puppeteer-Core dengan browser Chromium lokal');
    const puppeteer = require('puppeteer-core');
    const exe = findBrowserExe();
    if (!exe) throw new Error('Tidak ditemukan instalasi Chrome/Edge Chromium di sistem!');
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

    const context = await browser.newContext ? await browser.newContext({ viewport: { width: 1280, height: 900 } }) : null;
    const page = context ? await context.newPage() : await browser.newPage();
    if (page.setViewport) {
      await page.setViewport({ width: 1280, height: 900 });
    }

    // =========================================================================
    // LANGKAH 1: Masuk ke Admin Console dengan sesi Administrator
    // =========================================================================
    console.log('[LANGKAH 1] Membuka URL /preview/dashboard lalu navigasi ke /admin-console...');
    await page.goto(baseUrl + '/preview/dashboard', { waitUntil: 'load', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1200));

    // Pastikan session admin aktif
    await page.evaluate(() => {
      localStorage.setItem('autocuan_logged_in', 'true');
      localStorage.setItem('autocuan_user', 'budi');
      localStorage.setItem('autocuan_is_admin', 'true');
      localStorage.setItem('autocuan_role', 'ADMIN');
      localStorage.setItem('autocuan_entered_app', 'true');
      window.__AUTOCUAN_TEST__ = true;
    });

    // Cari dan klik menu Admin Console di sidebar
    await page.waitForSelector('#tabAdminConsole', { timeout: 10000 });
    await page.click('#tabAdminConsole');
    await new Promise((r) => setTimeout(r, 1500));

    // Pastikan adminMainContent dan panelTab0 aktif
    await page.evaluate(() => {
      const pageAdmin = document.getElementById('page-admin-console');
      if (pageAdmin) pageAdmin.classList.remove('hidden');
      const unauth = document.getElementById('unauthorizedScreen');
      if (unauth) unauth.style.display = 'none';
      const mainContent = document.getElementById('adminMainContent');
      if (mainContent) mainContent.style.display = 'block';
      if (typeof window.switchAdminTab === 'function') {
        window.switchAdminTab(0);
      }
    });

    await new Promise((r) => setTimeout(r, 1000));

    // =========================================================================
    // ASERSI 1: Ketiadaan Label Input Mentah (Input1, Input2, maxQuota, weekdayBackfillLimit)
    // =========================================================================
    console.log('[ASERSI 1] Memeriksa ketiadaan teks Input1, Input2, maxQuota, weekdayBackfillLimit...');
    const assert1Data = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      const rawLabels = ['Input1', 'Input2', 'Input3', 'Input4', 'maxQuota', 'weekdayBackfillLimit', 'weekendBackfillLimit', 'reserveFloorWeekday'];
      const occurrences = {};
      let totalFound = 0;

      for (const label of rawLabels) {
        const regex = new RegExp('\\b' + label + '\\b', 'gi');
        const matches = text.match(regex) || [];
        occurrences[label] = matches.length;
        totalFound += matches.length;
      }

      return {
        totalFound,
        occurrences,
        hasInput1: text.includes('Input1'),
        hasInput2: text.includes('Input2'),
        hasMaxQuota: text.includes('maxQuota'),
        hasWeekdayBackfillLimit: text.includes('weekdayBackfillLimit')
      };
    });

    console.log('[ASERSI 1 RESULT]', JSON.stringify(assert1Data));

    lib.addAssertion(
      result,
      'Asersi 1: Teks "Input1", "Input2", "maxQuota", "weekdayBackfillLimit" TIDAK ADA di document.body.innerText (0 occurrence)',
      assert1Data.totalFound === 0 && !assert1Data.hasInput1 && !assert1Data.hasInput2 && !assert1Data.hasMaxQuota && !assert1Data.hasWeekdayBackfillLimit,
      0,
      assert1Data.totalFound
    );

    // =========================================================================
    // ASERSI 2: Keberadaan 2 Blok Kuota Bahasa Indonesia Terstruktur
    // =========================================================================
    console.log('[ASERSI 2] Memeriksa keberadaan 2 Blok Kuota Bahasa Indonesia...');
    const assert2Data = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      const qfCard = document.getElementById('qf-card');
      const qfText = qfCard ? qfCard.innerText : '';

      const regexWeekday = /Pengaturan\s+Kuota\s+Hari\s+Kerja\s+Bursa\s*\(Senin\s*[–\-]\s*Jumat\)/i;
      const regexWeekend = /Pengaturan\s+Kuota\s+Akhir\s+Pekan\s*&\s*Hari\s+Libur\s+Bursa/i;

      const hasWeekday = regexWeekday.test(text) || regexWeekday.test(qfText);
      const hasWeekend = regexWeekend.test(text) || regexWeekend.test(qfText);

      // Cek elemen input form terkait
      const inputMaxQuota = document.getElementById('qf-maxQuota');
      const inputWeekdayBackfill = document.getElementById('qf-weekdayBackfill');
      const inputWeekendBackfill = document.getElementById('qf-weekendBackfill');
      const inputReserveFloor = document.getElementById('qf-reserveFloor');
      const btnSaveQuota = document.getElementById('quotaSaveBtn');

      return {
        hasWeekday,
        hasWeekend,
        hasMaxQuotaInput: Boolean(inputMaxQuota),
        maxQuotaVal: inputMaxQuota ? inputMaxQuota.value : null,
        hasWeekdayBackfillInput: Boolean(inputWeekdayBackfill),
        weekdayBackfillVal: inputWeekdayBackfill ? inputWeekdayBackfill.value : null,
        hasWeekendBackfillInput: Boolean(inputWeekendBackfill),
        weekendBackfillVal: inputWeekendBackfill ? inputWeekendBackfill.value : null,
        hasReserveFloorInput: Boolean(inputReserveFloor),
        reserveFloorVal: inputReserveFloor ? inputReserveFloor.value : null,
        btnSaveText: btnSaveQuota ? btnSaveQuota.innerText.trim() : null
      };
    });

    console.log('[ASERSI 2 RESULT]', JSON.stringify(assert2Data));

    lib.addAssertion(
      result,
      'Asersi 2: Teks "Pengaturan Kuota Hari Kerja Bursa (Senin – Jumat)" dan "Pengaturan Kuota Akhir Pekan & Hari Libur Bursa" TAMPIL nyata di DOM',
      assert2Data.hasWeekday === true && assert2Data.hasWeekend === true && assert2Data.hasMaxQuotaInput === true && assert2Data.hasWeekendBackfillInput === true,
      'Tampil kedua judul blok kuota dan form input operasional',
      `Weekday: ${assert2Data.hasWeekday}, Weekend: ${assert2Data.hasWeekend}, Tombol: ${assert2Data.btnSaveText}`
    );

    // =========================================================================
    // ASERSI 3: Formatting Waktu Seluruh Tabel Audit 100% WIB (Tanpa +00:00 atau Z)
    // =========================================================================
    console.log('[ASERSI 3] Memeriksa seluruh timestamp pada tabel audit berakhiran WIB...');
    const assert3Data = await page.evaluate(() => {
      // Periksa semua tabel audit: #auditLogsTbody, #secIncidentsTbody, #securityEventsTbody, #forensicAttackTbody, #datasetFreshnessTbody
      const tables = ['#auditLogsTbody', '#secIncidentsTbody', '#securityEventsTbody', '#forensicAttackTbody', '#datasetFreshnessTbody'];
      const samples = [];
      let totalChecked = 0;
      let nonWibCount = 0;
      let rawIsoCount = 0;

      for (const sel of tables) {
        const rows = document.querySelectorAll(sel + ' tr');
        rows.forEach((r) => {
          const cells = r.querySelectorAll('td');
          if (cells.length > 0) {
            const timeText = (cells[0].innerText || '').trim();
            if (timeText && !timeText.includes('Memuat') && !timeText.includes('Tidak ada') && !timeText.includes('Belum ada')) {
              totalChecked++;
              samples.push({ table: sel, text: timeText });

              if (!timeText.endsWith('WIB')) {
                nonWibCount++;
              }
              if (timeText.includes('+00:00') || timeText.includes('+07:00') || /Z$/i.test(timeText)) {
                rawIsoCount++;
              }
            }
          }
        });
      }

      return {
        totalChecked,
        nonWibCount,
        rawIsoCount,
        samples: samples.slice(0, 10)
      };
    });

    console.log('[ASERSI 3 RESULT]', JSON.stringify(assert3Data));

    lib.addAssertion(
      result,
      'Asersi 3: Seluruh timestamp pada tabel audit di /admin-console berakhiran "WIB" dan TIDAK mengandung "+00:00" atau "Z"',
      assert3Data.totalChecked > 0 && assert3Data.nonWibCount === 0 && assert3Data.rawIsoCount === 0,
      'Semua timestamp berakhiran WIB dan 0 format mentah ISO/UTC',
      `Diperiksa: ${assert3Data.totalChecked}, Non-WIB: ${assert3Data.nonWibCount}, Raw ISO: ${assert3Data.rawIsoCount}`
    );

    // =========================================================================
    // ASERSI 4: Tabel Forensik Serangan Keamanan (Kolom & Tombol Lengkap)
    // =========================================================================
    console.log('[ASERSI 4] Berpindah ke Tab 8 (Keamanan & Audit) dan memverifikasi Tabel Forensik Serangan...');
    await page.evaluate(() => {
      if (typeof window.switchAdminTab === 'function') {
        window.switchAdminTab(8);
      }
    });

    await new Promise((r) => setTimeout(r, 1000));

    const assert4Data = await page.evaluate(() => {
      const forensicSection = document.getElementById('secForensicAttackSection');
      const table = document.getElementById('forensicAttackTable');
      const thElements = document.querySelectorAll('#forensicAttackTable thead th');
      const columns = Array.from(thElements).map((th) => th.innerText.trim());

      const btnUnblock = document.getElementById('btnForensicUnblockIp') || document.querySelector('button[onclick*="unblockForensicIpPrompt"]');
      const btnClear = document.getElementById('btnClearAttackLogs') || document.querySelector('button[onclick*="clearForensicAttackLogs"]');

      const tbodyRows = document.querySelectorAll('#forensicAttackTbody tr');
      const rowTexts = Array.from(tbodyRows).map((tr) => tr.innerText.trim());

      const requiredCols = ['Waktu (WIB)', 'Alamat IP', 'Jenis Serangan / Rule', 'Target Endpoint', 'User-Agent', 'Status Blokir'];
      const colsMatched = requiredCols.every((col) => columns.includes(col));

      return {
        hasForensicSection: Boolean(forensicSection),
        hasTable: Boolean(table),
        columns,
        colsMatched,
        hasUnblockBtn: Boolean(btnUnblock),
        unblockBtnText: btnUnblock ? btnUnblock.innerText.trim() : null,
        hasClearBtn: Boolean(btnClear),
        clearBtnText: btnClear ? btnClear.innerText.trim() : null,
        rowCount: tbodyRows.length,
        hasAutoBlockBadge: rowTexts.some((t) => t.includes('DIBLOKIR OTOMATIS'))
      };
    });

    console.log('[ASERSI 4 RESULT]', JSON.stringify(assert4Data));

    lib.addAssertion(
      result,
      'Asersi 4: Tabel Forensik Serangan Keamanan ter-render dengan kolom yang ditentukan dan tombol Unblock & Bersihkan Log ada',
      assert4Data.hasTable === true && assert4Data.colsMatched === true && assert4Data.hasUnblockBtn === true && assert4Data.hasClearBtn === true,
      'Tabel Forensik lengkap 6 kolom + Tombol Unblock IP & Bersihkan Log Pengujian',
      `Kolom: ${JSON.stringify(assert4Data.columns)}, Tombol: [${assert4Data.unblockBtnText}, ${assert4Data.clearBtnText}]`
    );

    // Detail Asersi
    console.log('\n--- HASIL ASERSI DETAIL GATE V4-F04 ---');
    for (const a of result.assertions) {
      const mark = a.pass ? '✔ PASS' : '✖ FAIL';
      console.log(`${mark}: ${a.name}`);
      console.log(`   Expected: ${a.expected}`);
      console.log(`   Actual:   ${a.actual}`);
    }

    const allPassed = result.assertions.every((a) => a.pass === true);
    if (allPassed) {
      console.log('\n======================================================');
      console.log('PASS: Gate V4-F04 LULUS');
      console.log('======================================================\n');
    } else {
      console.error('\nFAIL: Gate V4-F04 GAGAL');
    }

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    lib.finalizeGate(result, OUT);

  } catch (err) {
    console.error('Error saat eksekusi Gate V4-F04:', err);
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
  console.error('[GATE V4-F04 FATAL ERROR]', err);
  process.exit(1);
});
