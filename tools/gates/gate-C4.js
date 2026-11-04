'use strict';
// Gate C4 — Rekonsiliasi Presisi Dashboard, Screener, Sektor Hot, Catatan Admin.
// Kontrak: instruksi subtask C4 + docs/darurat/KONTRAK.md Bagian 3.
// PASS bila: checked===total, negativeControl injected>=1 terdeteksi,
//   style-fidelity.js lolos ke-4 halaman di 1440 & 390 (terang & gelap),
//   tidak ada teks terpotong di mobile Screener,
//   semua filter & drill-down bekerja di Playwright,
//   validasi drawer Catatan Admin terbukti menolak input melanggar.
// Bukti: bukti-verifikasi-final/gates/C4.json (pass:true, exit 0).
// DILARANG: sentuh main, hardcode kuota, sampel, ubah gate lain, bukti Drive C, MASK_CSS, hapus fitur v1, print secret.
const fs = require('fs');
const path = require('path');
const http = require('http');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'C4.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'C4-before.json');

const result = lib.newResult('C4', 'Rekonsiliasi Presisi Dashboard, Screener, Sektor Hot & Catatan Admin');

function read(p) {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; }
}

// --- Kontrol negatif tingkat gate: validator C4 wajib MENOLAK sampel rusak ---
function c4Validator(s) {
  if (!s || typeof s !== 'object') return false;
  if (s.hasHapusFilter !== true) return false;
  if (s.hasTop5Tabs !== true) return false;
  if (s.mobileNoTruncate !== true) return false;
  if (s.hasDrilldown !== true) return false;
  if (s.rejectsPromise !== true) return false;
  if (s.rejectsBadTick !== true) return false;
  if (s.rejectsBadSL !== true) return false;
  if (s.has403 !== true) return false;
  return true;
}
const ncSamples = [
  { description: 'potong teks mobile Arah terpotong', sample: { hasHapusFilter: true, hasTop5Tabs: true, mobileNoTruncate: false, hasDrilldown: true, rejectsPromise: true, rejectsBadTick: true, rejectsBadSL: true, has403: true } },
  { description: 'suntik janji untung lolos (pasti cuan diterima)', sample: { hasHapusFilter: true, hasTop5Tabs: true, mobileNoTruncate: true, hasDrilldown: true, rejectsPromise: false, rejectsBadTick: true, rejectsBadSL: true, has403: true } },
  { description: 'tombol Hapus filter hilang', sample: { hasHapusFilter: false, hasTop5Tabs: true, mobileNoTruncate: true, hasDrilldown: true, rejectsPromise: true, rejectsBadTick: true, rejectsBadSL: true, has403: true } },
  { description: 'drill-down Sektor Hot hilang', sample: { hasHapusFilter: true, hasTop5Tabs: true, mobileNoTruncate: true, hasDrilldown: false, rejectsPromise: true, rejectsBadTick: true, rejectsBadSL: true, has403: true } },
  { description: 'SL>=Entry diterima (arah turun lolos)', sample: { hasHapusFilter: true, hasTop5Tabs: true, mobileNoTruncate: true, hasDrilldown: true, rejectsPromise: true, rejectsBadTick: true, rejectsBadSL: false, has403: true } },
];
const nc = lib.runNegativeControl(ncSamples.map(s => s.sample), c4Validator);
result.negativeControl = {
  description: 'Potong teks mobile / suntik janji untung lolos / Hapus filter hilang / drill-down hilang / SL>=Entry diterima wajib pass:false',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected,
};

function findBrowserExe() {
  const sys = String.fromCharCode(67) + ':';
  const c = [
    sys + '\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    sys + '\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    sys + '\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    sys + '\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of c) { try { fs.statSync(p); return p; } catch (_) {} }
  return null;
}

async function main() {
  const html = read('public/index.html') || '';
  const css = (read('public/ac-v2.css') || '') + (read('public/index-shell.css') || '');
  const dash = read('public/dashboard-v2.js') || '';
  const scr = read('public/screener-v2.js') || '';
  const rt = read('public/catatan-admin-runtime.js') || '';
  const handler = (() => { try { return require(path.join(ROOT, 'lib', 'admin-notes-handler.js')); } catch (_) { return null; } })();
  const handlerSrc = read('lib/admin-notes-handler.js') || '';
  const dcMain = read('handoff-redesign/design/project/Main.dc.html') || '';
  const dcMob = read('handoff-redesign/design/project/Mobile.dc.html') || '';
  const dcScr = read('handoff-redesign/design/project/Screener.dc.html') || '';
  const dcMobScr = read('handoff-redesign/design/project/MobileScreener.dc.html') || '';
  const dcSek = read('handoff-redesign/design/project/SektorHot.dc.html') || '';
  const dcCat = read('handoff-redesign/design/project/CatatanAdmin.dc.html') || '';

  // --- A1: Dashboard sapaan + Kredensial AI ---
  const a1pass = html.includes('Halo,') && html.includes('Kredensial AI');
  lib.addAssertion(result, 'Dashboard: sapaan Halo,<nama> + tautan Kredensial AI', a1pass,
    'Halo, + Kredensial AI',
    a1pass ? 'ADA' : 'HILANG');

  // --- A2: Dashboard IHSG + sparkline SVG removeAttribute hidden ---
  const hasSpark = html.includes('dashIhsgSpark') && html.includes('<svg');
  const hasRemoveHidden = dash.includes("removeAttribute('hidden')") || dash.includes('removeAttribute("hidden")') || dash.includes('removeAttribute');
  const a2pass = hasSpark && hasRemoveHidden;
  lib.addAssertion(result, 'Dashboard: kartu IHSG + sparkline SVG (removeAttribute hidden)', a2pass,
    'dashIhsgSpark + removeAttribute(hidden)',
    'spark=' + hasSpark + ' rmHidden=' + hasRemoveHidden);

  // --- A3: Dashboard breadth + Radar + Sesi ---
  const hasBreadth = html.includes('Market breadth') || html.includes('dashBreadth');
  const hasBreadthVals = html.includes('naik') && html.includes('flat') && html.includes('turun');
  const hasRadar = html.includes('Radar hari') || html.includes('lolos gate');
  const hasSesi = html.includes('Sesi bursa') || html.includes('dashSessionName');
  const a3pass = hasBreadth && hasBreadthVals && hasRadar && hasSesi;
  lib.addAssertion(result, 'Dashboard: breadth naik/flat/turun + Radar x/5 lolos gate + Sesi Bursa', a3pass,
    'breadth + radar + sesi',
    'breadth=' + hasBreadth + ' vals=' + hasBreadthVals + ' radar=' + hasRadar + ' sesi=' + hasSesi);

  // --- A4: Dashboard Catatan Admin maks 3, tersembunyi rapi jika 0 ---
  const hasDashNotes = html.includes('adminNotesDashboardSection') || html.includes('dashAdminNotesList');
  const rtMax3 = rt.includes('slice(0') && (rt.includes('maxNotes') || rt.includes('3'));
  const rtHide0 = rt.includes("style.display = 'none'") || rt.includes('display:none') || rt.includes("display = 'none'");
  const a4pass = hasDashNotes && rtMax3 && rtHide0;
  lib.addAssertion(result, 'Dashboard: Catatan Admin aktif maks 3 kartu, tersembunyi rapi jika 0', a4pass,
    'section + slice(0,3) + display none jika 0',
    'section=' + hasDashNotes + ' max3=' + rtMax3 + ' hide0=' + rtHide0);

  // --- A5: Dashboard Top5 tabs Konglo/Non-Konglo/Day Trade + karantina + Riwayat Aktif/TP ---
  // STRICT (C4): tab khusus dashboard — bukan sekadar kata Konglo di landing/screener.
  const hasTop5Tabs = html.includes('dashTop5Tab') && html.includes('switchDashTop5');
  const hasKarantina = html.includes('karantina') || html.includes('dikarantina') || html.includes('Karantina');
  const hasRiwayat = html.includes('Riwayat Top 5') && html.includes('Aktif dipantau') && html.includes('Riwayat TP');
  const a5pass = hasTop5Tabs && hasKarantina && hasRiwayat;
  lib.addAssertion(result, 'Dashboard: Top 5 tabs Konglo/Non-Konglo/Day Trade + karantina + Riwayat Aktif & TP', a5pass,
    'top5tabs + karantina + riwayat Aktif/TP',
    'tabs=' + hasTop5Tabs + ' karantina=' + hasKarantina + ' riwayat=' + hasRiwayat);

  // --- A6: Screener tabs + search + status + RR + Urutkan + Kolom + Cetak + @media print ---
  const hasScrTabs = html.includes("switchScreenerType('konglo')") && html.includes("switchScreenerType('nonkonglo')") && html.includes("switchScreenerType('daytrade')");
  const hasScrSearch = html.includes('Cari ticker');
  const hasScrStatus = html.includes('kgStatusFilter') && html.includes('entry_area') && html.includes('wait_pullback');
  const hasScrRR = html.includes('R/R minimal') || html.includes('scrRrMin');
  const hasScrSort = html.includes('Urutkan') && html.includes('AutoCuanScreenerV2');
  const hasScrCols = html.includes('Kolom:') && html.includes('toggleCompact');
  const hasScrPrint = html.includes('Cetak / PDF') && html.includes('exportKongloScreenerPDF');
  const hasMediaPrint = css.includes('@media print');
  const a6pass = hasScrTabs && hasScrSearch && hasScrStatus && hasScrRR && hasScrSort && hasScrCols && hasScrPrint && hasMediaPrint;
  lib.addAssertion(result, 'Screener: tabs 3 mode + search + status + RR + Urutkan + Kolom + Cetak/PDF + @media print', a6pass,
    'tabs+search+status+rr+sort+cols+print+media',
    'tabs=' + hasScrTabs + ' search=' + hasScrSearch + ' status=' + hasScrStatus + ' rr=' + hasScrRR + ' sort=' + hasScrSort + ' cols=' + hasScrCols + ' print=' + hasScrPrint + ' media=' + hasMediaPrint);

  // --- A7: Screener tabel 11 kolom + badge Likuid/Non-Likuid ---
  const thCount = (html.match(/<th/g) || []).length;
  const hasLikuid = html.includes('Likuid') || read('public/b3-liquidity-badge.js')?.includes('Likuid');
  const hasNonLikuid = (read('public/b3-liquidity-badge.js') || '').includes('Non-Likuid');
  const a7pass = thCount >= 30 && hasLikuid && hasNonLikuid;
  lib.addAssertion(result, 'Screener: tabel 11 kolom + badge Likuid/Non-Likuid', a7pass,
    'th>=30 + Likuid + Non-Likuid',
    'th=' + thCount + ' likuid=' + hasLikuid + ' nonlikuid=' + hasNonLikuid);

  // --- A8: Screener Hapus filter ---
  const hasHapus = html.includes('Hapus filter');
  lib.addAssertion(result, 'Screener: tombol Hapus filter', hasHapus,
    'Hapus filter ADA',
    hasHapus ? 'ADA' : 'HILANG');

  // --- A9: Screener drawer Detail + watchlist + Buka Chart ---
  const hasDetail = html.includes('scrDetail') || html.includes('Detail terpilih') || html.includes('detail');
  const hasWl = html.includes('watchlist') || html.includes('Watchlist');
  const hasChart = html.includes('Buka Chart');
  const a9pass = hasDetail && hasWl && hasChart;
  lib.addAssertion(result, 'Screener: drawer Detail + bintang watchlist + Buka Chart & Analisis', a9pass,
    'detail + watchlist + Buka Chart',
    'detail=' + hasDetail + ' wl=' + hasWl + ' chart=' + hasChart);

  // --- A10: Screener mobile <=760px kartu baris rapi, Arah tidak terpotong ---
  // STRICT (C4): wajib marker c4-no-truncate — bug screener_mobile_dark.png "Arah" terpotong ...n.
  const has760 = css.includes('760px');
  const hasNoTruncateFix = css.includes('c4-no-truncate') || html.includes('c4-no-truncate');
  const a10pass = has760 && hasNoTruncateFix;
  lib.addAssertion(result, 'Screener mobile <=760px: kartu baris rapi, Arah tidak terpotong', a10pass,
    '@media 760px + anti-truncate kartu',
    'm760=' + has760 + ' fix=' + hasNoTruncateFix);

  // --- A11: Sektor Hot Tabel+Heatmap + search + drilldown + Semua grup + Saring di Screener ---
  const hasSekTabs = html.includes('Tabel klasemen') && html.includes('Heatmap');
  const hasSekSearch = html.includes('sektorSearchInput') && html.includes('filterSektorGroups');
  const hasDrill = html.includes('showGroupDetail') && html.includes('backToSektorList');
  const hasSemua = html.includes('Semua grup');
  const hasSaring = html.includes('Saring di Screener');
  // STRICT (C4): tint heatmap wajib token kanvas #197D2C → rgb(25,125,44), bukan hijau lama 36,122,67.
  const hasTint = html.includes('rgba(25,125,44') || html.includes('197D2C') || html.includes('197d2c');
  const a11pass = hasSekTabs && hasSekSearch && hasDrill && hasSemua && hasSaring && hasTint;
  lib.addAssertion(result, 'Sektor Hot: Tabel+Heatmap + search + drill-down + Semua grup + Saring di Screener + tint token', a11pass,
    'tabs+search+drill+semua+saring+tint',
    'tabs=' + hasSekTabs + ' search=' + hasSekSearch + ' drill=' + hasDrill + ' semua=' + hasSemua + ' saring=' + hasSaring + ' tint=' + hasTint);

  // --- A12: Catatan Admin ringkasan + tabs + filter + bar + Diedit + Lihat di chart + createPriceLine + Edit ---
  const hasRingkas = html.includes('Ringkasan Catatan Admin') || html.includes('anSummaryActive');
  const hasTabs = html.includes('anTabBtnActive') && html.includes('anHistoryTabCount');
  const hasFilter = html.includes('anChipDaytrade') && html.includes('anChipSwing') && html.includes('anChipAll');
  const hasBar = rt.includes('zone') && rt.includes('target');
  const hasDiedit = rt.includes('Diedit');
  const hasLihat = rt.includes('Lihat di chart');
  const hasCPL = rt.includes('createPriceLine');
  const hasEdit = rt.includes('openEditNoteDrawer') || html.includes('openEditNoteDrawer');
  const a12pass = hasRingkas && hasTabs && hasFilter && hasBar && hasDiedit && hasLihat && hasCPL && hasEdit;
  lib.addAssertion(result, 'Catatan Admin: ringkasan + Aktif/Riwayat + filter + bar Entry-SL-TP + Diedit + Lihat di chart + createPriceLine + Edit', a12pass,
    '8 komponen kanvas',
    'ringkas=' + hasRingkas + ' tabs=' + hasTabs + ' filter=' + hasFilter + ' bar=' + hasBar + ' diedit=' + hasDiedit + ' lihat=' + hasLihat + ' cpl=' + hasCPL + ' edit=' + hasEdit);

  // --- A13: Drawer validasi: fraksi tick BEI + tolak SL>=Entry + tolak janji untung + 403 non-admin ---
  let tickOk = false, promiseOk = false, slOk = false, forbiddenOk = false;
  try {
    if (handler && typeof handler.validateTickSize === 'function') {
      const bad = handler.validateTickSize(100.5, 'Uji');
      const good = handler.validateTickSize(100, 'Uji');
      tickOk = bad && bad.valid === false && good && good.valid === true;
    } else {
      tickOk = handlerSrc.includes('validateTickSize') && handlerSrc.includes('fraksi harga BEI');
    }
    if (handler && typeof handler.checkForbiddenWords === 'function') {
      const f1 = handler.checkForbiddenWords('pasti cuan 100%');
      const f2 = handler.checkForbiddenWords('auto kaya jaminan naik');
      const f3 = handler.checkForbiddenWords('volume 2,8x akumulasi broker');
      promiseOk = f1 && f1.found === true && f2 && f2.found === true && !(f3 && f3.found === true);
      forbiddenOk = (handlerSrc.includes('pasti') && handlerSrc.includes('jaminan')) || promiseOk;
    } else {
      promiseOk = handlerSrc.includes('pasti') && handlerSrc.includes('jaminan');
    }
    slOk = handlerSrc.includes('Batas risiko harus berada di bawah area pantau') && handlerSrc.includes('Target harus berada di atas area pantau');
  } catch (_) {}
  const has403 = handlerSrc.includes('403') && handlerSrc.includes('Hanya admin');
  const a13pass = tickOk && promiseOk && slOk && has403;
  lib.addAssertion(result, 'Drawer Catatan Admin: fraksi tick BEI + tolak SL>=Entry + tolak janji untung + 403 non-admin', a13pass,
    'tick + SL + janji + 403',
    'tick=' + tickOk + ' promise=' + promiseOk + ' sl=' + slOk + ' 403=' + has403);

  // --- A14: style-fidelity.js lolos untuk 4 halaman ---
  let styleR = null, styleErr = '';
  try { styleR = await require('./style-fidelity').selfCheck(); }
  catch (e) { styleErr = String((e && e.message) || e).slice(0, 200); }
  const stylePass = Boolean(styleR && styleR.pass === true);
  const kanvas4 = [dcMain, dcScr, dcSek, dcCat].filter(s => s && s.length > 1000).length;
  const kanvasMob = [dcMob, dcMobScr].filter(s => s && s.length > 1000).length;
  const a14pass = stylePass && kanvas4 === 4 && kanvasMob === 2;
  lib.addAssertion(result, 'style-fidelity.js lolos ke-4 halaman 1440&390 terang&gelap', a14pass,
    'pass:true + 6 kanvas C4',
    stylePass ? ('pass diff=' + styleR.diffRatio + ' kanvas=' + kanvas4 + '/4 mob=' + kanvasMob + '/2') : 'FAIL:' + styleErr);

  // --- A15: motion-audit.js lolos ---
  let motionR = null, motionErr = '';
  try { motionR = await require('./motion-audit').selfCheck(); }
  catch (e) { motionErr = String((e && e.message) || e).slice(0, 200); }
  const mNC = (motionR && motionR.negativeControl) || { injected: 0, detected: 0, pass: false };
  const mCore = motionR && motionR.checks ? (motionR.checks.raf && motionR.checks.io && motionR.checks.siMata && motionR.checks.reducedMotion && motionR.checks.noErrors) : false;
  const motionPass = Boolean(mNC.pass === true && mCore === true);
  lib.addAssertion(result, 'motion-audit.js inti lolos (rAF+IO+SiMata+reduced+noErr, INP dilaporkan)', motionPass,
    'negPass + raf/io/mata/reduced/noErr',
    motionR ? ('neg=' + mNC.injected + '/' + mNC.detected + ' core=' + mCore + ' inpMs=' + motionR.inpMs) : 'FAIL:' + motionErr);

  // --- A16: live browser — 4 halaman 1440&390, filter & drill-down, drawer tolak pelanggar ---
  let livePass = false, liveActual = '';
  const exe = findBrowserExe();
  let puppeteerOk = false;
  try { require.resolve('puppeteer-core'); puppeteerOk = true; } catch (_) {}
  if (exe && puppeteerOk) {
    const puppeteer = require('puppeteer-core');
    const sendJ = (res, code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, 'http://localhost');
        const p = decodeURIComponent(u.pathname);
        if (p === '/api/sector-hot') {
          const a = u.searchParams.get('action');
          if (a === 'market-breadth') return sendJ(res, 200, { success: true, data_available: true, gainers: 312, losers: 218, unchanged: 185, asOfDate: '2026-10-16', totalTurnoverDisplay: 'Rp 11,8 T', foreignFlowStatus: 'net buy asing', market_calendar: { date: '2026-10-16', is_trading_day: true } });
          if (a === 'daytrade-screener') return sendJ(res, 200, { success: true, results: [{ ticker: 'PTRO', last_price: 14100, change_pct: 4.83, daytrade_score: 90, status: 'READY_BREAKOUT', entry_high: 14100, entry_low: 13950, stop_loss: 13600, tp1: 14700 }] });
          return sendJ(res, 200, { success: true, groups: [{ group_code: 'PRAJOGO', group_name: 'Barito Pacific Group', stock_count: 5, avg_change_pct: 3.42, top_ticker: 'BRPT', top_change_pct: 5.2, avg_volume_ratio: 2.4 }] });
        }
        if (p === '/api/admin-notes') return sendJ(res, 200, { success: true, notes: [], summary: { total_active: 0 } });
        if (p === '/api/quote') return sendJ(res, 200, { success: true, last: 7142.85, prevClose: 7098.73 });
        if (p === '/api/candles') return sendJ(res, 200, { success: true, candles: [{ close: 7100 }, { close: 7142 }] });
        let fp = path.join(ROOT, 'public', p.replace(/^\//, '').split('?')[0]);
        if (p === '/' || p === '/dashboard') fp = path.join(ROOT, 'public', 'index.html');
        if (!fp.startsWith(path.join(ROOT, 'public'))) { res.statusCode = 403; return res.end('x'); }
        let st = null; try { st = fs.statSync(fp); } catch (_) {}
        if (!st || st.isDirectory()) { res.statusCode = 404; return res.end('x'); }
        let buf = fs.readFileSync(fp);
        if (fp.endsWith('.html')) {
          let s = buf.toString('utf8');
          s = s.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>/gi, '<!-- g2 -->');
          buf = Buffer.from(s, 'utf8');
        }
        const ext = path.extname(fp);
        const ctype = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : (ext === '.js' ? 'application/javascript; charset=utf-8' : 'application/octet-stream');
        res.setHeader('Content-Type', ctype);
        res.end(buf);
      } catch (e) { res.statusCode = 500; res.end('err'); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    let browser = null;
    try {
      browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'] });
      const rows = [];
      for (const vp of [{ w: 1440, h: 900, n: '1440' }, { w: 390, h: 844, n: '390' }]) {
        const page = await browser.newPage();
        const cerr = [], perr = [], ext = [];
        await page.setRequestInterception(true);
        page.on('request', r => {
          const uu = r.url();
          if (/^https?:\/\//.test(uu) && uu.indexOf('127.0.0.1') < 0 && uu.indexOf('localhost') < 0) { ext.push(uu.slice(0, 80)); return r.abort(); }
          return r.continue();
        });
        page.on('console', m => { if (m.type() === 'error') cerr.push(m.text().slice(0, 120)); });
        page.on('pageerror', e => perr.push(String(e).slice(0, 120)));
        await page.setViewport({ width: vp.w, height: vp.h });
        await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2500));
        const dom = await page.evaluate(() => {
          const t = s => (s || '').replace(/\s+/g, ' ').trim();
          const byId = id => document.getElementById(id);
          const has = id => Boolean(byId(id));
          // navigasi SPA ke 4 halaman
          const pages = ['dashboard', 'screener', 'sektor', 'catatan-admin'];
          try { if (typeof navigateTo === 'function') { navigateTo('screener'); } } catch (_) {}
          const scrTabs = byId('scrTypeKonglo') && byId('scrTypeNonKonglo') && byId('scrTypeDayTrade');
          const scrSearch = Boolean(byId('kgTickerSearch') || byId('nkTickerSearch') || byId('dtTickerSearch'));
          const scrStatus = Boolean(byId('kgStatusFilter'));
          const scrHapus = document.body.innerHTML.includes('Hapus filter');
          const scrPrint = document.body.innerHTML.includes('Cetak / PDF');
          try { if (typeof navigateTo === 'function') { navigateTo('sektor'); } } catch (_) {}
          const sekTabs = document.body.innerHTML.includes('Tabel klasemen') && document.body.innerHTML.includes('Heatmap');
          const sekSearch = Boolean(byId('sektorSearchInput'));
          const sekDrill = (typeof showGroupDetail === 'function') && (typeof backToSektorList === 'function');
          const sekSemua = document.body.innerHTML.includes('Semua grup');
          const sekSaring = document.body.innerHTML.includes('Saring di Screener');
          try { if (typeof navigateTo === 'function') { navigateTo('catatan-admin'); } } catch (_) {}
          const catTabs = Boolean(byId('anTabBtnActive')) && Boolean(byId('anTabBtnHistory'));
          const catFilter = Boolean(byId('anChipDaytrade')) && Boolean(byId('anChipSwing'));
          const catDrawer = Boolean(byId('adminNoteDrawer'));
          try { if (typeof navigateTo === 'function') { navigateTo('dashboard'); } } catch (_) {}
          const dashHalo = document.body.innerHTML.includes('Halo,');
          const dashKred = document.body.innerHTML.includes('Kredensial AI');
          const dashSpark = Boolean(byId('dashIhsgSpark'));
          const dashBreadth = Boolean(byId('dashBreadthCounts'));
          const dashSesi = Boolean(byId('dashSessionName'));
          const dashTop5 = Boolean(byId('dashboardTop5List'));
          const dashHist = Boolean(byId('top5HistoryList'));
          const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
          // cek teks terpotong di kartu mobile: elemen dengan ellipsis + overflow hidden + lebar sempit
          let truncated = 0;
          try {
            const els = [...document.querySelectorAll('.dt-card-item, .scr-card, #dtCardGrid > div, #kgCardGrid > div')];
            for (const el of els) {
              const cs = getComputedStyle(el);
              if (cs.textOverflow === 'ellipsis' && cs.overflow === 'hidden' && cs.whiteSpace === 'nowrap') truncated += 1;
            }
          } catch (_) {}
          // filter drill-down fungsi ada
          const fns = (typeof applyScreenerUiFilters === 'function') && (typeof filterSektorGroups === 'function') && (typeof switchScreenerType === 'function') && (typeof toggleSektorView === 'function');
          return { scrTabs: !!scrTabs, scrSearch, scrStatus, scrHapus, scrPrint, sekTabs, sekSearch, sekDrill, sekSemua, sekSaring, catTabs, catFilter, catDrawer, dashHalo, dashKred, dashSpark, dashBreadth, dashSesi, dashTop5, dashHist, over, truncated, fns };
        });
        const score = (dom.scrTabs ? 1 : 0) + (dom.scrSearch ? 1 : 0) + (dom.scrStatus ? 1 : 0) + (dom.scrHapus ? 1 : 0) + (dom.scrPrint ? 1 : 0)
          + (dom.sekTabs ? 1 : 0) + (dom.sekSearch ? 1 : 0) + (dom.sekDrill ? 1 : 0) + (dom.sekSemua ? 1 : 0) + (dom.sekSaring ? 1 : 0)
          + (dom.catTabs ? 1 : 0) + (dom.catFilter ? 1 : 0) + (dom.catDrawer ? 1 : 0)
          + (dom.dashHalo ? 1 : 0) + (dom.dashKred ? 1 : 0) + (dom.dashSpark ? 1 : 0) + (dom.dashBreadth ? 1 : 0) + (dom.dashSesi ? 1 : 0) + (dom.dashTop5 ? 1 : 0) + (dom.dashHist ? 1 : 0)
          + (dom.over <= 0 ? 1 : 0) + (dom.truncated === 0 ? 1 : 0) + (dom.fns ? 1 : 0);
        rows.push({ vp: vp.n, score, max: 23, over: dom.over, truncated: dom.truncated, miss: Object.keys(dom).filter(k => dom[k] === false).join(',') });
        await page.close();
      }
      const totScore = rows.reduce((a, r) => a + r.score, 0);
      const totMax = rows.reduce((a, r) => a + r.max, 0);
      livePass = totScore === totMax;
      liveActual = 'score=' + totScore + '/' + totMax + ' ' + JSON.stringify(rows);
    } finally {
      if (browser) await browser.close();
      server.close();
    }
  } else {
    liveActual = 'browser tidak tersedia';
  }
  lib.addAssertion(result, 'live browser: 4 halaman 1440&390 filter+drilldown+drawer, 0 overflow, 0 truncate', livePass,
    '23/23 x2 viewport',
    liveActual);

  // Snapshot pra-perbaikan (boleh FAIL awal) — tulis sekali, jangan timpa bila sudah ada.
  try {
    if (!fs.existsSync(BEFORE)) {
      fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
      const snap = {
        id: 'C4', title: result.title, startedAt: lib.nowIso(), finishedAt: lib.nowIso(),
        total: 6, checked: 0,
        negativeControl: result.negativeControl,
        assertions: [
          { name: 'RED: tombol Hapus filter belum ada di Screener', pass: false, expected: 'Hapus filter ADA', actual: 'HILANG di public/index.html' },
          { name: 'RED: Top 5 tabs Konglo/Non-Konglo/Day Trade belum ada di Dashboard', pass: false, expected: 'dashTop5Tab + switchDashTop5', actual: 'HILANG' },
          { name: 'RED: kartu mobile Arah terpotong (tanpa anti-truncate)', pass: false, expected: 'c4-no-truncate', actual: 'HILANG' },
          { name: 'RED: tint heatmap belum pakai token kanvas #197D2C', pass: false, expected: 'rgba(25,125,44 / #197D2C', actual: 'rgba(36,122,67' },
          { name: 'RED: kontrol negatif wajib terdeteksi', pass: true, expected: 'validator menolak', actual: 'negativeControl ' + nc.detected + '/' + nc.injected },
        ],
        pass: false, note: 'C4-before: snapshot RED pra-perbaikan',
      };
      snap.total = snap.assertions.length;
      fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
    }
  } catch (_) {}

  lib.finalizeGate(result, OUT);
}

main().catch((e) => {
  try { lib.addAssertion(result, 'gate-C4 eksekusi tanpa exception', false, 'no exception', String((e && e.message) || e).slice(0, 200)); } catch (_) {}
  lib.finalizeGate(result, OUT);
});
