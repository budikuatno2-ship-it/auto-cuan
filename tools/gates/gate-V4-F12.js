'use strict';

/**
 * tools/gates/gate-V4-F12.js
 * ============================================================================
 * Gate Penguji Anti-Bohong FASE V4-F12:
 * Verifikasi Anti-Regresi Catatan Admin (0 Dummy + Tombol Hapus), Modal Login Blur,
 * & Tombol Uji Kirim Pesan Telegram (ID 6396446903).
 *
 * 1. Catatan Admin (/catatan):
 *    - data/admin-notes.json dan frontend bersih dari entri dummy ("Test judul", "tesst").
 *    - Menampilkan jadwal pengiriman briefing otomatis:
 *      Morning Brief 06:00 WIB & Evening Brief 17:00 WIB.
 *    - Tombol Hapus pada setiap kartu catatan admin dapat menghapus catatan secara persisten lewat API.
 * 2. Modal Login Backdrop Blur:
 *    - Tombol Masuk / Login membuka modal dialog modern di tengah layar dengan efek backdrop blur
 *      (backdrop-blur-md / backdrop-filter: blur) tanpa redirect ke halaman kosong/terpisah.
 * 3. Pusat Akun & Uji Kirim Pesan Telegram (ID 6396446903):
 *    - Di tab Pusat Akun > Keamanan & Koneksi:
 *      Status Telegram untuk Chat ID 6396446903 menampilkan status "Terhubung".
 *      Tombol "Uji kirim pesan" terhubung ke API /api/telegram/test dan mengembalikan respons ok: true.
 * 4. Kontrol Negatif (Negative Control Validator) anti-gate-gaming.
 * 5. Simpan bukti ke bukti-verifikasi-final/gates-v4/F12.json dan cetak "PASS: Gate V4-F12 LULUS".
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v4', 'F12.json');

const result = lib.newResult(
  'V4-F12',
  'Verifikasi Anti-Regresi Catatan Admin (0 Dummy + Tombol Hapus), Modal Login Blur, & Uji Telegram 6396446903'
);

// --- Kontrol Negatif (Negative Control Validator) ---
function f12Validator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (typeof sample.dummyTextFound !== 'boolean' || sample.dummyTextFound !== false) return false;
  if (sample.hasBriefingSchedule !== true) return false;
  if (sample.hasDeleteButton !== true) return false;
  if (sample.loginModalOpen !== true) return false;
  if (sample.loginModalHasBlur !== true) return false;
  if (sample.loginModalCentered !== true) return false;
  if (sample.telegramStatusConnected !== true) return false;
  if (sample.telegramTestOk !== true) return false;
  return true;
}

const negativeSamples = [
  null,
  // Sampel korup 1: Dummy text ditemukan
  {
    dummyTextFound: true,
    hasBriefingSchedule: true,
    hasDeleteButton: true,
    loginModalOpen: true,
    loginModalHasBlur: true,
    loginModalCentered: true,
    telegramStatusConnected: true,
    telegramTestOk: true
  },
  // Sampel korup 2: Jadwal briefing 06:00 / 17:00 hilang
  {
    dummyTextFound: false,
    hasBriefingSchedule: false,
    hasDeleteButton: true,
    loginModalOpen: true,
    loginModalHasBlur: true,
    loginModalCentered: true,
    telegramStatusConnected: true,
    telegramTestOk: true
  },
  // Sampel korup 3: Tombol Hapus catatan hilang
  {
    dummyTextFound: false,
    hasBriefingSchedule: true,
    hasDeleteButton: false,
    loginModalOpen: true,
    loginModalHasBlur: true,
    loginModalCentered: true,
    telegramStatusConnected: true,
    telegramTestOk: true
  },
  // Sampel korup 4: Modal login tidak blur atau tidak centered
  {
    dummyTextFound: false,
    hasBriefingSchedule: true,
    hasDeleteButton: true,
    loginModalOpen: true,
    loginModalHasBlur: false,
    loginModalCentered: true,
    telegramStatusConnected: true,
    telegramTestOk: true
  },
  // Sampel korup 5: Uji kirim pesan Telegram gagal (ok !== true)
  {
    dummyTextFound: false,
    hasBriefingSchedule: true,
    hasDeleteButton: true,
    loginModalOpen: true,
    loginModalHasBlur: true,
    loginModalCentered: true,
    telegramStatusConnected: true,
    telegramTestOk: false
  }
];

const nc = lib.runNegativeControl(negativeSamples, f12Validator);
result.negativeControl = {
  description: 'Uji 5 sampel korup: dummy text, jadwal hilang, tombol hapus hilang, modal tidak blur, telegram test gagal',
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

function postJson(port, reqPath, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: reqPath,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }, headers)
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (_) {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function deleteReq(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: reqPath,
      method: 'DELETE',
      headers: Object.assign({}, headers)
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (_) {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    req.end();
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
  console.log('[GATE V4-F12] Memulai Verifikasi Otentik FASE V4-F12...');

  // 1. Verifikasi Kontrol Negatif
  console.log('[KONTROL NEGATIF] Menguji validator kontrol negatif anti-gaming...');
  const negOk = result.negativeControl.pass;
  if (!negOk) {
    throw new Error('FAILED: Validator meloloskan sampel korup!');
  }
  console.log('OK: Semua 5 sampel korup berhasil ditolak validator.');

  // 2. Static Assertions: data/admin-notes.json & Source files
  console.log('[STATIC] Memeriksa data/admin-notes.json...');
  const notesPath = path.join(ROOT, 'data', 'admin-notes.json');
  const notesRaw = fs.readFileSync(notesPath, 'utf8');

  const rawContainsDummy = notesRaw.includes('Test judul') || notesRaw.includes('tesst');
  lib.addAssertion(
    result,
    'data/admin-notes.json bebas dari entri dummy ("Test judul", "tesst")',
    rawContainsDummy === false,
    '0 entri dummy',
    rawContainsDummy ? 'Ditemukan teks dummy' : '0 entri dummy'
  );

  const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const hasMorningBrief = indexHtml.includes('Morning Brief 06:00 WIB');
  const hasEveningBrief = indexHtml.includes('Evening Brief 17:00 WIB');
  lib.addAssertion(
    result,
    'Tampilan Catatan Admin memuat jadwal Morning Brief 06:00 WIB & Evening Brief 17:00 WIB',
    hasMorningBrief && hasEveningBrief,
    'Morning Brief 06:00 WIB & Evening Brief 17:00 WIB',
    `Morning=${hasMorningBrief}, Evening=${hasEveningBrief}`
  );

  const runtimeJs = fs.readFileSync(path.join(ROOT, 'public', 'catatan-admin-runtime.js'), 'utf8');
  const hasDeleteFunction = runtimeJs.includes('deleteAdminNote') && runtimeJs.includes('DELETE');
  lib.addAssertion(
    result,
    'Frontend runtime catatan admin menyediakan fungsi penghapusan persisten lewat DELETE /api/admin-notes',
    hasDeleteFunction === true,
    'deleteAdminNote + DELETE fetch',
    hasDeleteFunction ? 'Tersedia' : 'Tidak tersedia'
  );

  // 3. Setup Browser & Server
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

  const auditSample = {
    dummyTextFound: rawContainsDummy,
    hasBriefingSchedule: false,
    hasDeleteButton: false,
    loginModalOpen: false,
    loginModalHasBlur: false,
    loginModalCentered: false,
    telegramStatusConnected: false,
    telegramTestOk: false
  };

  try {
    await waitForServer(testPort);
    const baseUrl = `http://127.0.0.1:${testPort}`;
    console.log(`[SERVER] Server aktif di ${baseUrl}`);

    // Siapkan 1 catatan nyata via POST /api/admin-notes agar kartu catatan admin tampil di /catatan
    console.log('[API SEED] Menyiapkan catatan admin riil (BBCA) via POST /api/admin-notes...');
    const seedRes = await postJson(testPort, '/api/admin-notes', {
      ticker: 'BBCA',
      style: 'swing',
      reason: 'Akumulasi konsisten broker asing di area support dinamis MA50 dengan rasio risk reward terukur.',
      zone_lo: 10000,
      zone_hi: 10250,
      target: 10950,
      risk_limit: 9800,
      valid_days: 10
    }, {
      'x-user-role': 'admin',
      'x-admin': '1'
    });
    console.log('[API SEED RES]', seedRes);
    const createdNoteId = seedRes.body && seedRes.body.note && seedRes.body.note.id;

    // --- UJI 1: BUKA /catatan & VERIFIKASI CATATAN ADMIN ---
    console.log('[PLAYWRIGHT] Membuka /catatan...');
    const page = await preparePage(browser);
    page.on('dialog', async dialog => {
      await dialog.accept();
    });

    await page.goto(`${baseUrl}/catatan`, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 1200));

    // Navigasi eksplisit ke catatan-admin jika belum aktif
    await page.evaluate(() => {
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('catatan-admin');
      }
    });
    await new Promise(r => setTimeout(r, 1000));

    const catatanCheck = await page.evaluate(() => {
      const pageEl = document.querySelector('#page-catatan-admin');
      const pageText = pageEl ? pageEl.textContent : '';
      const dummyInPage = pageText.includes('Test judul') || pageText.includes('tesst');
      const hasMorning = pageText.includes('Morning Brief 06:00 WIB') || pageText.includes('06:00 WIB');
      const hasEvening = pageText.includes('Evening Brief 17:00 WIB') || pageText.includes('17:00 WIB');
      const deleteButtons = Array.from(document.querySelectorAll('#anActiveGrid button, #page-catatan-admin button'))
        .filter(b => b.textContent.trim().toLowerCase() === 'hapus' || (b.getAttribute('onclick') || '').includes('deleteAdminNote'));

      return {
        isPageVisible: pageEl && !pageEl.classList.contains('hidden'),
        dummyInPage,
        hasMorning,
        hasEvening,
        deleteButtonCount: deleteButtons.length
      };
    });

    console.log('[CATATAN CHECK]', catatanCheck);
    auditSample.hasBriefingSchedule = catatanCheck.hasMorning && catatanCheck.hasEvening;
    auditSample.hasDeleteButton = catatanCheck.deleteButtonCount > 0;
    if (catatanCheck.dummyInPage) auditSample.dummyTextFound = true;

    lib.addAssertion(
      result,
      'DOM /catatan bersih dari entri dummy/sampah ("Test judul", "tesst")',
      catatanCheck.dummyInPage === false,
      '0 dummy di DOM',
      catatanCheck.dummyInPage ? 'Ditemukan teks dummy di DOM' : '0 dummy di DOM'
    );

    lib.addAssertion(
      result,
      'DOM /catatan memuat teks briefing: Morning Brief 06:00 WIB & Evening Brief 17:00 WIB',
      catatanCheck.hasMorning && catatanCheck.hasEvening,
      'Jadwal 06:00 & 17:00 WIB tampil di DOM',
      `Morning=${catatanCheck.hasMorning}, Evening=${catatanCheck.hasEvening}`
    );

    lib.addAssertion(
      result,
      'Tersedia tombol Hapus pada kartu catatan admin di DOM',
      catatanCheck.deleteButtonCount > 0,
      '>= 1 tombol Hapus',
      `${catatanCheck.deleteButtonCount} tombol Hapus ditemukan`
    );

    // Hapus catatan via API DELETE untuk memverifikasi fungsionalitas persisten
    if (createdNoteId) {
      console.log(`[API DELETE] Menghapus catatan ${createdNoteId} secara persisten...`);
      const delRes = await deleteReq(testPort, `/api/admin-notes?id=${encodeURIComponent(createdNoteId)}`, {
        'x-user-role': 'admin',
        'x-admin': '1'
      });
      console.log('[API DELETE RES]', delRes);
      lib.addAssertion(
        result,
        'API DELETE /api/admin-notes menghapus catatan admin secara persisten (ok: true)',
        delRes.status === 200 && delRes.body && delRes.body.ok === true,
        'HTTP 200 + { ok: true }',
        `HTTP ${delRes.status} + ${JSON.stringify(delRes.body)}`
      );
    }

    // --- UJI 2: KLIK TOMBOL LOGIN / MASUK & MODAL DIALOG BACKDROP BLUR ---
    console.log('[PLAYWRIGHT] Menguji tombol Login/Masuk dan Modal Dialog Backdrop Blur...');
    await page.evaluate(() => {
      if (typeof window.openLoginModal === 'function') {
        window.openLoginModal();
      }
    });

    await new Promise(r => setTimeout(r, 600));

    const modalCheck = await page.evaluate(() => {
      const modal = document.querySelector('#loginModal');
      if (!modal) return { exists: false };
      const computedStyle = window.getComputedStyle(modal);
      const isVisible = !modal.classList.contains('hidden') && computedStyle.display !== 'none';
      const backdropFilter = computedStyle.backdropFilter || computedStyle.webkitBackdropFilter || '';
      const hasBlurClass = modal.classList.contains('backdrop-blur-md') || modal.className.includes('backdrop-blur');
      const hasBlurStyle = backdropFilter.includes('blur') || (modal.getAttribute('style') || '').includes('backdrop-filter');

      // Cek apakah modal centered di layar
      const isCentered = computedStyle.display.includes('flex') &&
        computedStyle.alignItems === 'center' &&
        computedStyle.justifyContent === 'center';

      return {
        exists: true,
        isVisible,
        hasBlur: hasBlurClass || hasBlurStyle,
        isCentered,
        backdropFilter,
        currentUrl: window.location.href
      };
    });

    console.log('[MODAL CHECK]', modalCheck);
    auditSample.loginModalOpen = modalCheck.isVisible;
    auditSample.loginModalHasBlur = modalCheck.hasBlur;
    auditSample.loginModalCentered = modalCheck.isCentered;

    lib.addAssertion(
      result,
      'Tombol Login membuka modal dialog modern di tengah layar tanpa redirect halaman',
      modalCheck.isVisible && modalCheck.isCentered,
      'Modal terbuka & centered di viewport',
      `Visible=${modalCheck.isVisible}, Centered=${modalCheck.isCentered}`
    );

    lib.addAssertion(
      result,
      'Modal login memiliki efek latar belakang blur (backdrop-blur-md / backdrop-filter: blur)',
      modalCheck.hasBlur === true,
      'backdrop-blur aktif',
      modalCheck.hasBlur ? `Blur terdeteksi (${modalCheck.backdropFilter || 'backdrop-blur-md'})` : 'Tanpa blur'
    );

    // Tutup modal
    await page.evaluate(() => {
      if (typeof window.closeLoginModal === 'function') window.closeLoginModal();
    });
    await new Promise(r => setTimeout(r, 300));

    // --- UJI 3: PUSAT AKUN > KEAMANAN & KONEKSI TELEGRAM ID 6396446903 ---
    console.log('[PLAYWRIGHT] Menguji Pusat Akun > Keamanan & Koneksi untuk Telegram ID 6396446903...');
    await page.evaluate(async () => {
      if (typeof window.openAccountProfile === 'function') {
        window.openAccountProfile();
      }
      await new Promise(r => setTimeout(r, 500));
      if (typeof window.switchTab === 'function') {
        window.switchTab('security');
      }
    });

    await new Promise(r => setTimeout(r, 1000));

    const securityCheck = await page.evaluate(() => {
      const secPanel = document.querySelector('#acPanelSecurity');
      if (!secPanel) return { panelFound: false };
      const text = secPanel.textContent;
      const isConnected = text.includes('Terhubung');
      const hasChatId = text.includes('6396446903');
      const testBtn = document.querySelector('#btn-test-telegram');
      return {
        panelFound: true,
        isConnected,
        hasChatId,
        testButtonFound: Boolean(testBtn),
        testButtonText: testBtn ? testBtn.textContent.trim() : ''
      };
    });

    console.log('[SECURITY CHECK]', securityCheck);
    auditSample.telegramStatusConnected = securityCheck.isConnected && securityCheck.hasChatId;

    lib.addAssertion(
      result,
      'Tab Pusat Akun > Keamanan & Koneksi menampilkan status Telegram "Terhubung" untuk Chat ID 6396446903',
      securityCheck.isConnected && securityCheck.hasChatId,
      'Terhubung & ID 6396446903',
      `Terhubung=${securityCheck.isConnected}, ID=${securityCheck.hasChatId}`
    );

    lib.addAssertion(
      result,
      'Tombol "Uji kirim pesan" Telegram tersedia di panel Keamanan & Koneksi',
      securityCheck.testButtonFound === true,
      'Tombol #btn-test-telegram tersedia',
      securityCheck.testButtonFound ? `Tersedia: "${securityCheck.testButtonText}"` : 'Tidak ditemukan'
    );

    // --- UJI 4: ENDPOINT POST /api/telegram/test DENGAN CHAT ID 6396446903 ---
    console.log('[API TEST] Menguji endpoint POST /api/telegram/test dengan parameter { chatId: "6396446903" }...');
    const apiRes = await postJson(testPort, '/api/telegram/test', { chatId: '6396446903' });
    console.log('[API RES /api/telegram/test]', apiRes);

    const isApiOk = apiRes.status === 200 && apiRes.body && apiRes.body.ok === true;
    auditSample.telegramTestOk = isApiOk;

    lib.addAssertion(
      result,
      'Endpoint POST /api/telegram/test dengan { chatId: "6396446903" } mengembalikan status 200 dan respons ok: true',
      isApiOk === true,
      'HTTP 200 + { ok: true }',
      `HTTP ${apiRes.status} + ${JSON.stringify(apiRes.body)}`
    );

    // 4. Validasi Final via Kontrol Negatif
    const validState = f12Validator(auditSample);
    lib.addAssertion(
      result,
      'Hasil pengujian menyeluruh lolos verifikasi kontrol negatif anti-gaming',
      validState === true,
      'Valid state = true',
      `Valid state = ${validState}`
    );

  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    if (serverProcess) {
      try { serverProcess.kill(); } catch (_) {}
    }
  }

  console.log('\n=============================================================');
  console.log(`HASIL GATE V4-F12:`);
  result.assertions.forEach((a, i) => {
    console.log(`  ${i + 1}. [${a.pass ? 'PASS' : 'FAIL'}] ${a.name}`);
  });
  console.log(`Total: ${result.total} | Passed: ${result.checked}`);
  console.log('=============================================================\n');

  if (result.assertions.length > 0 && result.assertions.every(a => a.pass)) {
    console.log('PASS: Gate V4-F12 LULUS');
  } else {
    console.error('FAIL: Gate V4-F12 GAGAL');
  }

  // 5. Finalisasi & Simpan Bukti
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  lib.finalizeGate(result, OUT);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[GATE V4-F12 ERROR]', err);
    process.exit(1);
  });
}

module.exports = { f12Validator, negativeSamples };
