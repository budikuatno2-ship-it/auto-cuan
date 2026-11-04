'use strict';
// Gate V3-F13 — Automasi Uji Browser Nyata (BrowserSkill + browser-use) Lintas 19 Menu,
// Seluruh Sub-Tab, & 4 Viewport.
// Verifikasi: puppeteer-core + Chrome nyata + local-dev-server preview zero-auth
// (login otomatis sesi admin budi) klik tiap menu & sub-tab satu per satu di
// 4 viewport (1920x1080, 1440x900, 768x1024, 390x844).
// Konsep Tencent BrowserSkill: getBoundingClientRect + getComputedStyle tiap
// kunjungan; browser-use: sesi admin budi otomatis via preview injection.
// Syarat: selisih posisi horizontal <=8px, 0 console error, 0 page error,
// 0 request gagal (>=400), 0 overflow horizontal.
// ATURAN BESI: no GH polling/sleep, no Vercel, Windows node -e, data riil, anti-gate-gaming.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const childProcess = require('child_process');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v3', 'F13.json');

const result = lib.newResult('V3-F13', 'Uji browser nyata 19 menu + sub-tab x 4 viewport: posisi<=8px, 0 error, 0 gagal, 0 overflow');

function read(p) { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; } }
function existsRaw(p) { try { return fs.existsSync(path.join(ROOT, p)); } catch (_) { return false; } }

// Kontrol negatif: validator kunjungan wajib MENOLAK sampel korup.
function visitValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (typeof sample.label !== 'string' || !sample.label) return false;
  if (sample.consoleErrors !== 0) return false;
  if (sample.pageErrors !== 0) return false;
  if (sample.failedRequests !== 0) return false;
  if (sample.overflow !== false) return false;
  if (typeof sample.dx !== 'number' || !(sample.dx <= 8)) return false;
  return true;
}

const VIEWPORTS = [
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '390x844', width: 390, height: 844 }
];
// 19 menu hallmark V3-F10 (PAGES19 di public/app.js).
const MENUS19 = ['dashboard', 'screener', 'sektor', 'catatan-admin', 'analisis',
  'bandarmologi', 'intel', 'hunter', 'insider', 'ranking', 'financial',
  'market-structure', 'watchlist', 'portofolio', 'trackrecord',
  'kelola-keuangan', 'subscription', 'pattern', 'admin-console'];
const ANALISIS_SUBS = ['analisis-chart', 'bandarmologi', 'intel', 'hunter', 'insider',
  'ranking', 'financial', 'market-structure', 'pattern'];
const PORTFOLIO_SUBS = ['today', 'planner', 'watch', 'risk', 'scenarios', 'journal', 'ai'];

function findChrome() {
  const c = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ];
  for (const p of c) { try { fs.statSync(p); return p; } catch (_) {} }
  return null;
}

function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 8000 }, (resp) => {
      resp.resume();
      resp.on('end', () => resolve(resp.statusCode));
      resp.on('close', () => resolve(resp.statusCode));
    });
    r.on('error', reject);
    r.on('timeout', () => { try { r.destroy(); } catch (_) {} reject(new Error('timeout')); });
  });
}

async function waitServer(port, tries) {
  for (let i = 0; i < (tries || 40); i++) {
    try {
      const st = await httpGet(port, '/preview/dashboard');
      if (st === 200) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  // Baseline baik (dx=8 batas toleransi) wajib DITERIMA validator — dicek terpisah,
  // bukan sebagai injeksi (pola gate F10/F11: baseline lolos + sampel korup ditolak).
  const goodVisit = { label: 'ok', consoleErrors: 0, pageErrors: 0, failedRequests: 0, overflow: false, dx: 8 };
  const baselineAccept = visitValidator(goodVisit) === true;
  const ncSamples = [
    null,
    { label: '', consoleErrors: 0, pageErrors: 0, failedRequests: 0, overflow: false, dx: 0 },
    { label: 'x', consoleErrors: 1, pageErrors: 0, failedRequests: 0, overflow: false, dx: 0 },
    { label: 'x', consoleErrors: 0, pageErrors: 1, failedRequests: 0, overflow: false, dx: 0 },
    { label: 'x', consoleErrors: 0, pageErrors: 0, failedRequests: 2, overflow: false, dx: 0 },
    { label: 'x', consoleErrors: 0, pageErrors: 0, failedRequests: 0, overflow: true, dx: 0 },
    { label: 'x', consoleErrors: 0, pageErrors: 0, failedRequests: 0, overflow: false, dx: 25 }
  ];
  const nc = lib.runNegativeControl(ncSamples, visitValidator);
  result.negativeControl = {
    description: 'Baseline dx=8 diterima; suntik null/label-kosong/cerr/pageerr/reqfail/overflow/dx-25 wajib ditolak',
    injected: nc.injected, detected: nc.detected,
    pass: baselineAccept === true && nc.injected >= 1 && nc.detected === nc.injected
  };

  // 1. Scope file ada (hanya scope subtask).
  const scopeFiles = ['tools/gates/gate-V3-F13.js', 'public/app.js', 'tools/local-dev-server.js'];
  const missingScope = scopeFiles.filter((f) => !existsRaw(f));
  lib.addAssertion(result, 'scope V3-F13 selaras (gate+app.js+local-dev-server)',
    missingScope.length === 0, '3/3 ada', missingScope.length ? ('hilang: ' + missingScope.join(',')) : '3/3 ada');

  // 2. Perbaikan observer V3-F10 anti-loop ada (syarat browser nyata tidak macet).
  let obsOk = false;
  let obsDetail = 'tidak terbaca';
  try {
    const appjs = read('public/app.js') || '';
    const hasGuard = appjs.indexOf('_acV3F10Enforcing') >= 0;
    const hasReobserve = appjs.indexOf('_observe19') >= 0;
    const hasExpose = appjs.indexOf('acV3F10Observer') >= 0;
    const noRawLoop = appjs.indexOf('new MutationObserver(function(){enforce19();})') < 0;
    obsOk = hasGuard && hasReobserve && hasExpose && noRawLoop;
    obsDetail = 'guard=' + hasGuard + ' reobserve=' + hasReobserve + ' expose=' + hasExpose + ' norawloop=' + noRawLoop;
  } catch (e) { obsDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'public/app.js observer V3-F10 disconnect-reobserve (anti macet thread utama)',
    obsOk === true, 'guard+reobserve+expose+norawloop', obsDetail);

  // 3. Mock get-sheet/save-sheet/portfolio-summary ada (syarat 0 request gagal).
  let mockOk = false;
  let mockDetail = 'tidak terbaca';
  try {
    const srv = read('tools/local-dev-server.js') || '';
    const hasGet = srv.indexOf("action === 'get-sheet'") >= 0;
    const hasSave = srv.indexOf("action === 'save-sheet'") >= 0;
    const hasPort = srv.indexOf("action === 'portfolio-summary'") >= 0;
    mockOk = hasGet && hasSave && hasPort;
    mockDetail = 'get-sheet=' + hasGet + ' save-sheet=' + hasSave + ' portfolio-summary=' + hasPort;
  } catch (e) { mockDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'local-dev-server mock get-sheet/save-sheet/portfolio-summary (0 gagal >=400)',
    mockOk === true, 'get+save+portfolio mock', mockDetail);

  // 4. Browser nyata tersedia.
  const exe = findChrome();
  lib.addAssertion(result, 'browser nyata Chrome/Edge lokal tersedia (puppeteer-core)',
    typeof exe === 'string' && exe.length > 0, 'chrome/edge ada', exe || 'tidak ditemukan');
  if (!exe) {
    lib.addAssertion(result, 'kontrol negatif lolos (injected>=1, detected==injected)',
      result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected,
      'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);
    lib.finalizeGate(result, OUT);
    return result;
  }

  // 5. Matriks browser nyata: 19 menu + 9 analisis + 7 portofolio x 4 viewport.
  let matrix = null;
  let matrixDetail = 'belum jalan';
  try {
    matrix = await runMatrix(exe);
    matrixDetail = 'vp=' + matrix.viewports.length + ' visits=' + matrix.totalVisits
      + ' bad=' + matrix.badVisits.length + ' cerr=' + matrix.totalConsoleErrors
      + ' perr=' + matrix.totalPageErrors + ' fail=' + matrix.totalFailedRequests
      + ' maxDx=' + matrix.maxDx + ' maxOver=' + matrix.maxOverflowPx;
    result.browserMatrix = matrix.summary;
  } catch (e) { matrixDetail = 'error: ' + String((e && e.message) || e).slice(0, 300); }
  const matrixOk = matrix && matrix.badVisits.length === 0 && matrix.totalConsoleErrors === 0
    && matrix.totalPageErrors === 0 && matrix.totalFailedRequests === 0 && matrix.maxOverflowPx === 0;
  lib.addAssertion(result, 'browser nyata: 19 menu + 16 sub-tab x 4 viewport 100% lolos 0 error 0 overflow',
    matrixOk === true, '140/140 0cerr 0perr 0fail 0over', matrixDetail);

  // 6. browser-use: login otomatis sesi admin budi semua viewport.
  let loginOk = false;
  let loginDetail = 'matriks tidak jalan';
  try {
    if (matrix) {
      loginOk = matrix.viewports.every((v) => v.previewUser && v.previewUser.username === 'budi' && v.previewUser.role === 'ADMIN');
      loginDetail = matrix.viewports.map((v) => v.name + '=' + (v.previewUser ? (v.previewUser.username + '/' + v.previewUser.role) : 'null')).join(' ');
    }
  } catch (e) { loginDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'browser-use: sesi admin budi otomatis (preview injection) 4/4 viewport',
    loginOk === true, 'budi/ADMIN x4', loginDetail);

  // 7. BrowserSkill: selisih posisi horizontal <=8px semua viewport.
  let posOk = false;
  let posDetail = 'matriks tidak jalan';
  try {
    if (matrix) {
      posOk = matrix.maxDx <= 8;
      posDetail = 'maxDx=' + matrix.maxDx + ' per-vp=' + matrix.viewports.map((v) => v.name + ':' + v.dx).join(' ');
    }
  } catch (e) { posDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'BrowserSkill getBoundingClientRect: selisih posisi horizontal <=8px (4 viewport)',
    posOk === true, 'maxDx<=8', posDetail);

  // 8-11. Nol global per kategori.
  if (matrix) {
    lib.addAssertion(result, '0 console error seluruh halaman+sub-tab (4 viewport)',
      matrix.totalConsoleErrors === 0, '0', String(matrix.totalConsoleErrors));
    lib.addAssertion(result, '0 page error seluruh halaman+sub-tab (4 viewport)',
      matrix.totalPageErrors === 0, '0', String(matrix.totalPageErrors));
    lib.addAssertion(result, '0 request gagal (>=400) seluruh halaman+sub-tab (4 viewport)',
      matrix.totalFailedRequests === 0, '0', String(matrix.totalFailedRequests));
    lib.addAssertion(result, '0 overflow horizontal seluruh halaman+sub-tab (4 viewport)',
      matrix.maxOverflowPx === 0, '0px', String(matrix.maxOverflowPx) + 'px');
  } else {
    lib.addAssertion(result, '0 console error seluruh halaman+sub-tab (4 viewport)', false, '0', matrixDetail);
    lib.addAssertion(result, '0 page error seluruh halaman+sub-tab (4 viewport)', false, '0', matrixDetail);
    lib.addAssertion(result, '0 request gagal (>=400) seluruh halaman+sub-tab (4 viewport)', false, '0', matrixDetail);
    lib.addAssertion(result, '0 overflow horizontal seluruh halaman+sub-tab (4 viewport)', false, '0px', matrixDetail);
  }

  // 12. Kontrol negatif lolos.
  lib.addAssertion(result, 'kontrol negatif lolos (injected>=1, detected==injected)',
    result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected,
    'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

  lib.finalizeGate(result, OUT);
  return result;
}

async function runMatrix(exe) {
  const port = 31020 + Math.floor(Math.random() * 800);
  const srv = childProcess.spawn(process.execPath, ['tools/local-dev-server.js'],
    { env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1' }), stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const ready = await waitServer(port, 40);
    if (!ready) throw new Error('dev-server tidak siap di port ' + port);
    const puppeteer = require('puppeteer-core');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-f13-'));
    const browser = await puppeteer.launch({
      executablePath: exe, headless: true, protocolTimeout: 120000, userDataDir: tmpDir,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--proxy-server=direct://', '--proxy-bypass-list=*', '--disable-gpu', '--no-first-run', '--no-default-browser-check']
    });
    const viewports = [];
    let totalVisits = 0;
    const badVisits = [];
    let totalConsoleErrors = 0;
    let totalPageErrors = 0;
    let totalFailedRequests = 0;
    let maxDx = 0;
    let maxOverflowPx = 0;
    try {
      for (const vp of VIEWPORTS) {
        const page = await browser.newPage();
        await page.setViewport({ width: vp.width, height: vp.height });
        const cerr = [];
        const perr = [];
        const fail = [];
        page.on('console', (m) => { try { if (m.type() === 'error') cerr.push(m.text().slice(0, 200)); } catch (_) {} });
        page.on('pageerror', (e) => { try { perr.push(String((e && e.message) || e).slice(0, 200)); } catch (_) {} });
        page.on('response', (r) => { try { if (r.status() >= 400) fail.push(r.status() + ' ' + r.url().slice(0, 140)); } catch (_) {} });
        page.on('requestfailed', (r) => {
          try {
            const u = r.url() || '';
            const et = (r.failure() && r.failure().errorText) || '';
            if (/aborted|cancel|ERR_ABORTED/i.test(et)) return;
            if (/cdn|google|gstatic|fonts\.google/.test(u)) return;
            fail.push('REQFAIL ' + u.slice(0, 140) + ' ' + et);
          } catch (_) {}
        });
        await page.goto('http://127.0.0.1:' + port + '/preview/dashboard', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(6000);
        const boot = await page.evaluate(() => ({
          user: window.__AUTOCUAN_PREVIEW_USER__ || null,
          navFn: typeof window.navigateTo,
          preview: !!window.__AUTOCUAN_PREVIEW_MODE__
        }));
        const xs = [];
        let vpBad = 0;
        let vpVisits = 0;
        async function visit(label, pg, sub) {
          vpVisits += 1;
          totalVisits += 1;
          const bc = cerr.length, bp = perr.length, bf = fail.length;
          try {
            await page.evaluate((p, s) => { try { window.navigateTo(p, s || undefined); } catch (_) {} }, pg, sub);
            await sleep(1500);
            const info = await page.evaluate(() => {
              // BrowserSkill: rect + computedStyle.
              const host = document.querySelector('#appContent') || document.body;
              const r = host.getBoundingClientRect();
              const cs = getComputedStyle(host);
              return {
                x: r.x, y: r.y, w: r.width, h: r.height,
                display: cs.getPropertyValue('display'),
                overflow: { sw: document.documentElement.scrollWidth, iw: window.innerWidth }
              };
            });
            xs.push(info.x);
            const dc = cerr.length - bc, dp = perr.length - bp, df = fail.length - bf;
            const overPx = Math.max(0, info.overflow.sw - info.overflow.iw - 1);
            if (overPx > maxOverflowPx) maxOverflowPx = overPx;
            const over = overPx > 0;
            totalConsoleErrors += dc;
            totalPageErrors += dp;
            totalFailedRequests += df;
            const ok = dc === 0 && dp === 0 && df === 0 && !over;
            if (!ok) {
              vpBad += 1;
              badVisits.push({ viewport: vp.name, label, dc, dp, df, overPx, sw: info.overflow.sw, iw: info.overflow.iw });
            }
            return ok;
          } catch (e) {
            vpBad += 1;
            badVisits.push({ viewport: vp.name, label, evalErr: String((e && e.message) || e).slice(0, 150) });
            return false;
          }
        }
        for (const pg of MENUS19) await visit('MENU:' + pg, pg, null);
        for (const s of ANALISIS_SUBS) await visit('SUB-analisis:' + s, 'analisis', s);
        for (const s of PORTFOLIO_SUBS) await visit('SUB-portofolio:' + s, 'portofolio', s);
        const dx = xs.length ? (Math.max.apply(null, xs) - Math.min.apply(null, xs)) : 0;
        if (dx > maxDx) maxDx = dx;
        viewports.push({
          name: vp.name, width: vp.width, height: vp.height,
          visits: vpVisits, bad: vpBad, dx,
          previewUser: boot.user, previewMode: boot.preview, navFn: boot.navFn,
          consoleErrors: cerr.length, pageErrors: perr.length, failedRequests: fail.length,
          consoleSamples: [...new Set(cerr)].slice(0, 5),
          failedSamples: [...new Set(fail)].slice(0, 5)
        });
        try { await page.close(); } catch (_) {}
      }
    } finally {
      try { await browser.close(); } catch (_) {}
    }
    const summary = {
      viewports: viewports.map((v) => ({ name: v.name, visits: v.visits, bad: v.bad, dx: v.dx, cerr: v.consoleErrors, perr: v.pageErrors, fail: v.failedRequests, user: v.previewUser })),
      totalVisits, badCount: badVisits.length,
      totalConsoleErrors, totalPageErrors, totalFailedRequests, maxDx, maxOverflowPx,
      badVisits: badVisits.slice(0, 20)
    };
    return { viewports, totalVisits, badVisits, totalConsoleErrors, totalPageErrors, totalFailedRequests, maxDx, maxOverflowPx, summary };
  } finally {
    try { srv.kill(); } catch (_) {}
  }
}

main().catch((e) => {
  try {
    lib.addAssertion(result, 'gate tidak crash', false, 'no-crash', String((e && e.message) || e).slice(0, 300));
    lib.finalizeGate(result, OUT);
  } catch (_) { process.exit(1); }
});
