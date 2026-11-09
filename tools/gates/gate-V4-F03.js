'use strict';

/**
 * tools/gates/gate-V4-F03.js
 * Gate Penguji Anti-Bohong FASE V4-F03:
 * 1. Navigasi ke /admin-console via klik sidebar:
 *    - Sidebar 19 menu di kiri ada dan berukuran >= 200px (width >= 200, display !== 'none').
 *    - Konten Admin Console termuat di dalam Workstation Shell.
 * 2. Reload browser (F5) pada URL /admin-console:
 *    - Sidebar kiri TETAP ada dan berukuran >= 200px.
 *    - Anti dual-render: tidak menyajikan admin.html standalone yang menghilangkan sidebar.
 * 3. Buka direct URL /analisis-saham?ticker=IHSG:
 *    - Sidebar kiri TETAP ada dan berukuran >= 200px.
 *    - Teks usang "Analisis Saham & Cockpit AI" TIDAK ADA (0 occurrences).
 *    - 6 sub-tab Analisis Saham tersedia (Analisis AI, Chart Workstation, Bandarmologi,
 *      Sinyal Intelijen, Broker Hunter, Jejaring Insider).
 * 4. Mencetak 'PASS: Gate V4-F03 LULUS'.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v4', 'F03.json');

const result = lib.newResult(
  'V4-F03',
  'Penyatuan Single-Shell SPA (Basmi Dual-Render /admin-console & /analisis-saham) & Kunci Permanen 19 Menu Sidebar'
);

// --- Kontrol Negatif (Negative Control) ---
function routeIntegrityValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (typeof sample.route !== 'string' || !sample.route.startsWith('/')) return false;
  if (sample.hasSidebar !== true) return false;
  if (typeof sample.sidebarWidth !== 'number' || sample.sidebarWidth < 200) return false;
  if (typeof sample.sidebarCount !== 'number' || sample.sidebarCount !== 19) return false;
  if (sample.noSlop !== true) return false;
  if (typeof sample.subtabCount !== 'number' || sample.subtabCount < 6) return false;
  return true;
}

const negativeSamples = [
  null,
  { route: '/admin-console', hasSidebar: false, sidebarWidth: 0, sidebarCount: 0, noSlop: true, subtabCount: 6 },
  { route: '/admin-console', hasSidebar: true, sidebarWidth: 150, sidebarCount: 19, noSlop: true, subtabCount: 6 }, // < 200px
  { route: '/admin-console', hasSidebar: true, sidebarWidth: 240, sidebarCount: 15, noSlop: true, subtabCount: 6 }, // not 19 items
  { route: '/analisis-saham', hasSidebar: true, sidebarWidth: 240, sidebarCount: 19, noSlop: false, subtabCount: 6 }, // contains slop
  { route: '/analisis-saham', hasSidebar: true, sidebarWidth: 240, sidebarCount: 19, noSlop: true, subtabCount: 4 }, // < 6 subtabs
  { route: 'invalid-route', hasSidebar: true, sidebarWidth: 240, sidebarCount: 19, noSlop: true, subtabCount: 6 }
];

const nc = lib.runNegativeControl(negativeSamples, routeIntegrityValidator);
result.negativeControl = {
  description: 'Injeksi sampel korup (dual-render tanpa sidebar, sidebar < 200px, menu != 19, teks kuno cockpit, subtab < 6); validator wajib menolak 100%',
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
  console.log('[GATE V4-F03] Memulai Verifikasi Otentik Playwright Browser...');

  // 1. Luncurkan browser headless
  let browser = null;
  let playwright = null;
  try {
    playwright = require('playwright');
  } catch (_) {}

  if (playwright && playwright.chromium) {
    console.log('[BROWSER] Menggunakan engine Playwright Chromium');
    browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800']
    });
  } else {
    console.log('[BROWSER] Menggunakan engine Puppeteer-Core dengan browser Chromium lokal');
    const puppeteer = require('puppeteer-core');
    const exe = findBrowserExe();
    if (!exe) throw new Error('Tidak ditemukan instalasi Chrome/Edge Chromium di sistem!');
    browser = await puppeteer.launch({
      executablePath: exe,
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800']
    });
  }

  // 2. Start server lokal pada port terisolasi
  const testPort = await getFreePort();
  console.log(`[SERVER] Memulai server terisolasi pada port ${testPort}...`);
  const serverChild = spawn(process.execPath, [path.join(ROOT, 'tools', 'local-dev-server.js')], {
    env: { ...process.env, PORT: String(testPort), HOST: '127.0.0.1', NODE_ENV: 'test' },
    stdio: 'ignore'
  });

  try {
    await waitForServer(testPort);
    const baseUrl = `http://127.0.0.1:${testPort}`;

    const context = await browser.newContext ? await browser.newContext({ viewport: { width: 1280, height: 800 } }) : null;
    const page = context ? await context.newPage() : await browser.newPage();
    if (page.setViewport) {
      await page.setViewport({ width: 1280, height: 800 });
    }

    // =========================================================================
    // LANGKAH 1: Buka /admin-console via klik navigasi sidebar
    // =========================================================================
    console.log('[LANGKAH 1] Navigasi ke Admin Console via klik sidebar...');
    await page.goto(baseUrl + '/preview/dashboard', { waitUntil: 'load', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1200));

    // Pastikan session admin aktif
    await page.evaluate(() => {
      localStorage.setItem('autocuan_logged_in', 'true');
      localStorage.setItem('autocuan_user', 'budi');
      localStorage.setItem('autocuan_is_admin', 'true');
      localStorage.setItem('autocuan_role', 'ADMIN');
      localStorage.setItem('autocuan_entered_app', 'true');
    });

    // Cari dan klik menu Admin Console di sidebar
    await page.waitForSelector('#tabAdminConsole', { timeout: 10000 });
    await page.click('#tabAdminConsole');
    await new Promise((r) => setTimeout(r, 1000));

    // Evaluasi DOM Sidebar dan Konten Admin
    const step1Data = await page.evaluate(() => {
      const sb = document.getElementById('appSidebar');
      const rect = sb ? sb.getBoundingClientRect() : { width: 0, height: 0 };
      const display = sb ? window.getComputedStyle(sb).display : 'none';
      const visible = sb ? !sb.classList.contains('hidden') : false;
      const items = document.querySelectorAll('#appSidebar .sidebar-item');
      const adminSection = document.getElementById('page-admin-console');
      const adminVisible = adminSection ? !adminSection.classList.contains('hidden') : false;
      const adminContent = document.getElementById('adminMainContent');
      const currentUrl = window.location.pathname;

      return {
        hasSidebar: Boolean(sb),
        width: Math.round(rect.width),
        display,
        visible,
        itemCount: items.length,
        adminSectionFound: Boolean(adminSection),
        adminVisible,
        hasAdminMainContent: Boolean(adminContent),
        currentUrl
      };
    });

    console.log('[LANGKAH 1 RESULT]', JSON.stringify(step1Data));

    lib.addAssertion(
      result,
      'Langkah 1: Navigasi sidebar ke /admin-console menampilkan sidebar dengan width >= 200px',
      step1Data.hasSidebar === true && step1Data.width >= 200 && step1Data.display !== 'none',
      '>= 200px & display != none',
      `${step1Data.width}px, display=${step1Data.display}`
    );

    lib.addAssertion(
      result,
      'Langkah 1: Sidebar memuat tepat 19 menu item yang terkunci dan aktif',
      step1Data.itemCount === 19,
      19,
      step1Data.itemCount
    );

    lib.addAssertion(
      result,
      'Langkah 1: Konten Admin Console terintegrasi di dalam Workstation Shell (#page-admin-console)',
      step1Data.adminSectionFound === true && step1Data.adminVisible === true,
      true,
      step1Data.adminVisible
    );

    // =========================================================================
    // LANGKAH 2: Lakukan reload (F5) pada URL /admin-console
    // =========================================================================
    console.log('[LANGKAH 2] Melakukan page.reload() (F5) pada URL /admin-console...');
    await page.reload({ waitUntil: 'load', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1500));

    const step2Data = await page.evaluate(() => {
      const sb = document.getElementById('appSidebar');
      const rect = sb ? sb.getBoundingClientRect() : { width: 0, height: 0 };
      const display = sb ? window.getComputedStyle(sb).display : 'none';
      const items = document.querySelectorAll('#appSidebar .sidebar-item');
      const adminSection = document.getElementById('page-admin-console');
      const adminVisible = adminSection ? !adminSection.classList.contains('hidden') : false;
      const currentUrl = window.location.pathname;
      const hasStandaloneHeader = Boolean(document.querySelector('.app-header .brand-copy'));

      return {
        hasSidebar: Boolean(sb),
        width: Math.round(rect.width),
        display,
        itemCount: items.length,
        adminSectionFound: Boolean(adminSection),
        adminVisible,
        currentUrl,
        hasStandaloneHeader
      };
    });

    console.log('[LANGKAH 2 RESULT]', JSON.stringify(step2Data));

    lib.addAssertion(
      result,
      'Langkah 2 (F5 /admin-console): Sidebar kiri TETAP utuh, aktif, dan berukuran >= 200px setelah reload',
      step2Data.hasSidebar === true && step2Data.width >= 200 && step2Data.display !== 'none',
      '>= 200px & display != none',
      `${step2Data.width}px, display=${step2Data.display}`
    );

    lib.addAssertion(
      result,
      'Langkah 2: Anti dual-render terbukti - server menyajikan Single-Shell SPA (19 menu utuh, bukan standalone admin.html)',
      step2Data.itemCount === 19 && step2Data.adminSectionFound === true && step2Data.hasStandaloneHeader === false,
      'Single-Shell with 19 items & no standalone header',
      `items=${step2Data.itemCount}, standaloneHeader=${step2Data.hasStandaloneHeader}`
    );

    // =========================================================================
    // LANGKAH 3: Buka direct URL /analisis-saham?ticker=IHSG
    // =========================================================================
    console.log('[LANGKAH 3] Membuka direct URL /analisis-saham?ticker=IHSG...');
    await page.goto(baseUrl + '/analisis-saham?ticker=IHSG', { waitUntil: 'load', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2000));

    const step3Data = await page.evaluate(() => {
      const sb = document.getElementById('appSidebar');
      const rect = sb ? sb.getBoundingClientRect() : { width: 0, height: 0 };
      const display = sb ? window.getComputedStyle(sb).display : 'none';
      const items = document.querySelectorAll('#appSidebar .sidebar-item');

      // Cek ketiadaan teks kuno "Analisis Saham & Cockpit AI"
      const fullHtml = document.documentElement.innerHTML;
      const fullText = document.body ? document.body.innerText : '';
      const docTitle = document.title || '';

      const slopPattern = /Analisis\s+Saham\s+&\s+Cockpit\s+AI/i;
      const slopOccurrencesHtml = (fullHtml.match(/Analisis\s+Saham\s+&\s+Cockpit\s+AI/gi) || []).length;
      const slopOccurrencesText = (fullText.match(slopPattern) || []).length;
      const slopOccurrencesTitle = (docTitle.match(slopPattern) || []).length;
      const totalSlop = slopOccurrencesHtml + slopOccurrencesText + slopOccurrencesTitle;

      // Cek ketersediaan 6 sub-tab Analisis Saham
      const subtabs = [
        { id: 'tabAnalisisText', name: 'Analisis AI', el: document.getElementById('tabAnalisisText') },
        { id: 'tabChartWorkstationLens', name: 'Chart Workstation', el: document.getElementById('tabChartWorkstationLens') },
        { id: 'tabBandarmologiSub', name: 'Bandarmologi', el: document.getElementById('tabBandarmologiSub') },
        { id: 'tabSinyalIntelijenSub', name: 'Sinyal Intelijen', el: document.getElementById('tabSinyalIntelijenSub') },
        { id: 'tabBrokerHunterSub', name: 'Broker Hunter', el: document.getElementById('tabBrokerHunterSub') },
        { id: 'tabJejaringInsiderSub', name: 'Jejaring Insider', el: document.getElementById('tabJejaringInsiderSub') }
      ];

      const subtabCheck = subtabs.map(st => ({
        id: st.id,
        name: st.name,
        found: Boolean(st.el),
        text: st.el ? (st.el.textContent || '').trim() : '',
        visible: st.el ? window.getComputedStyle(st.el).display !== 'none' : false
      }));

      const all6Found = subtabCheck.every(s => s.found);
      const activeTicker = (document.getElementById('unifiedActiveTickerBadge') || {}).textContent || '';

      return {
        hasSidebar: Boolean(sb),
        width: Math.round(rect.width),
        display,
        itemCount: items.length,
        totalSlop,
        subtabCheck,
        all6Found,
        activeTicker: activeTicker.trim(),
        currentUrl: window.location.pathname + window.location.search
      };
    });

    console.log('[LANGKAH 3 RESULT]', JSON.stringify(step3Data));

    lib.addAssertion(
      result,
      'Langkah 3 (direct URL /analisis-saham?ticker=IHSG): Sidebar kiri TETAP ada dan berukuran >= 200px',
      step3Data.hasSidebar === true && step3Data.width >= 200 && step3Data.display !== 'none',
      '>= 200px & display != none',
      `${step3Data.width}px, display=${step3Data.display}`
    );

    lib.addAssertion(
      result,
      'Langkah 3: Teks/template usang "Analisis Saham & Cockpit AI" TIDAK ADA (0 occurrences)',
      step3Data.totalSlop === 0,
      0,
      step3Data.totalSlop
    );

    lib.addAssertion(
      result,
      'Langkah 3: Tepat 6 sub-tab Analisis Saham tersedia (Analisis AI, Chart Workstation, Bandarmologi, Sinyal Intelijen, Broker Hunter, Jejaring Insider)',
      step3Data.all6Found === true,
      '6 subtabs available',
      step3Data.subtabCheck.map(s => `${s.name}:${s.found}`).join(', ')
    );

  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    if (serverChild) {
      try { serverChild.kill('SIGTERM'); } catch (_) {}
    }
  }

  // Detail Asersi
  console.log('\n--- HASIL ASERSI DETAIL GATE V4-F03 ---');
  for (const a of result.assertions) {
    const mark = a.pass ? '✔ PASS' : '✖ FAIL';
    console.log(`${mark}: ${a.name}`);
    console.log(`   Expected: ${a.expected}`);
    console.log(`   Actual:   ${a.actual}`);
  }

  const allPassed = result.assertions.every((a) => a.pass === true);
  if (allPassed) {
    console.log('\n======================================================');
    console.log('PASS: Gate V4-F03 LULUS');
    console.log('======================================================\n');
  } else {
    console.error('\nFAIL: Gate V4-F03 GAGAL');
  }

  // Finalisasi gate
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  lib.finalizeGate(result, OUT);
}

main().catch((err) => {
  console.error('[GATE V4-F03 FATAL ERROR]', err);
  process.exit(1);
});
