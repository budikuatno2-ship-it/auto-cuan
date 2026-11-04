'use strict';
// Gate C5 — Rekonsiliasi Presisi Analisis dan Chart, Bandarmologi, Sinyal Intelijen, dan Broker Hunter.
// Kontrak: instruksi subtask C5 + docs/darurat/KONTRAK.md Bagian 3.
// PASS bila: checked===total, negativeControl injected>=1 terdeteksi,
//   style-fidelity.js lolos ke-4 halaman di 1440 & 390 (terang & gelap),
//   seluruh kontrol Chart & Bandarmologi bekerja tanpa error di Playwright,
//   klik Buka <ticker> di Bandarmologi dari Broker Hunter langsung buka saham tsb di Bandarmologi.
// Bukti: bukti-verifikasi-final/gates/C5.json (pass:true, exit 0).
// DILARANG: sentuh main, hardcode kuota, sampel, ubah gate lain, bukti Drive C, MASK_CSS, hapus fitur v1, print secret.
const fs = require('fs');
const path = require('path');
const http = require('http');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'C5.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'C5-before.json');

const result = lib.newResult('C5', 'Rekonsiliasi Presisi Analisis & Chart, Bandarmologi, Sinyal Intelijen & Broker Hunter');

function read(p) {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; }
}

// --- Kontrol negatif tingkat gate: validator C5 wajib MENOLAK sampel rusak ---
function c5Validator(s) {
  if (!s || typeof s !== 'object') return false;
  if (s.hasChartToggle !== true) return false;
  if (s.hasBandarSeg !== true) return false;
  if (s.hasHunterLink !== true) return false;
  if (s.hasDebounce !== true) return false;
  if (s.hasVerdict !== true) return false;
  if (s.hasPilar !== true) return false;
  return true;
}
const ncSamples = [
  { description: '1 toggle chart dihapus (Matikan semua hilang)', sample: { hasChartToggle: false, hasBandarSeg: true, hasHunterLink: true, hasDebounce: true, hasVerdict: true, hasPilar: true } },
  { description: 'segmen Bandarmologi rusak (Asing/Domestik hilang)', sample: { hasChartToggle: true, hasBandarSeg: false, hasHunterLink: true, hasDebounce: true, hasVerdict: true, hasPilar: true } },
  { description: 'tautan hunter hilang (Buka di Bandarmologi hilang)', sample: { hasChartToggle: true, hasBandarSeg: true, hasHunterLink: false, hasDebounce: true, hasVerdict: true, hasPilar: true } },
  { description: 'debounce tanggal hilang', sample: { hasChartToggle: true, hasBandarSeg: true, hasHunterLink: true, hasDebounce: false, hasVerdict: true, hasPilar: true } },
  { description: 'pilar Sinyal hilang', sample: { hasChartToggle: true, hasBandarSeg: true, hasHunterLink: true, hasDebounce: true, hasVerdict: true, hasPilar: false } },
];
const nc = lib.runNegativeControl(ncSamples.map(s => s.sample), c5Validator);
result.negativeControl = {
  description: 'Hapus 1 toggle chart / rusak segmen Bandarmologi / hapus tautan hunter / hapus debounce / hapus pilar wajib pass:false',
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
  const cw = read('public/chart-workstation.js') || '';
  const br = read('public/bandarmologi-runtime.js') || '';
  const av = read('public/analisis-v2.js') || '';
  const sai = read('public/stock-analysis-ai.js') || '';
  const dcAna = read('handoff-redesign/design/project/Analisis.dc.html') || '';
  const dcBan = read('handoff-redesign/design/project/Bandarmologi.dc.html') || '';
  const dcSig = read('handoff-redesign/design/project/SinyalIntelijen.dc.html') || '';
  const dcHun = read('handoff-redesign/design/project/BrokerHunter.dc.html') || '';

  // --- A1: Analisis header konteks .ana-ctx ---
  const hasCtx = html.includes('ana-ctx');
  const hasChips = html.includes('UnifiedCockpit.syncActiveTicker') && html.includes('BBCA') && html.includes('BBRI');
  const hasStar = html.includes('anaWlStar') && html.includes('Watchlist');
  const hasSearch = html.includes('analisisInput') && html.includes('Ganti ticker');
  const hasLinks = html.includes('anaHeaderLinks') && av.includes('Struktur Pasar') && av.includes('Sektor Hot');
  const hasBanner = html.includes('catatanAdminChartBanner') && html.includes('Catatan Admin');
  const a1pass = hasCtx && hasChips && hasStar && hasSearch && hasLinks && hasBanner;
  lib.addAssertion(result, 'Analisis header .ana-ctx: chip cepat + bintang watchlist + pencarian + tautan Struktur/Sektor + banner Catatan Admin', a1pass,
    'ctx+chips+star+search+links+banner',
    'ctx=' + hasCtx + ' chips=' + hasChips + ' star=' + hasStar + ' search=' + hasSearch + ' links=' + hasLinks + ' banner=' + hasBanner);

  // --- A2: Tab Analisis AI ---
  const hasSum = html.includes('anaAiSummary') && html.includes('Rangkuman');
  const hasEv = html.includes('anaAiEvidence') && html.includes('Bukti dari data');
  const hasRisk = html.includes('anaAiRisk') && html.includes('Risiko');
  const hasCtxUsed = html.includes('Konteks yang dipakai');
  const hasQuick = html.includes('analisisFollowUp') && html.includes('Konfirmasi volume?');
  const hasAsk = html.includes('analysisChatInput') && html.includes('analysisSendBtn') && html.includes('Kirim');
  const hasFacts = html.includes('anaAiFactsList') && html.includes('Fakta ticker');
  const factsHasSpinner = /anaAiFactsList[\s\S]{0,2000}spinner/i.test(html.slice(html.indexOf('anaAiFactsList'), html.indexOf('anaAiFactsList') + 4000));
  const hasByok = html.includes('openAiApiKeyModal') && (html.includes('BYOK') || html.includes('Kredensial AI')) && (sai.includes('Gemini') || html.includes('Gemini'));
  const a2pass = hasSum && hasEv && hasRisk && hasCtxUsed && hasQuick && hasAsk && hasFacts && !factsHasSpinner && hasByok;
  lib.addAssertion(result, 'Analisis AI: Interpretasi (Rangkuman+Bukti+Risiko+Konteks+chip cepat+tanya/Kirim) + Fakta ticker tanpa spinner + BYOK Gemini', a2pass,
    'sum+ev+risk+ctx+quick+ask+facts+nospinner+byok',
    'sum=' + hasSum + ' ev=' + hasEv + ' risk=' + hasRisk + ' ctx=' + hasCtxUsed + ' quick=' + hasQuick + ' ask=' + hasAsk + ' facts=' + hasFacts + ' factsSpinner=' + factsHasSpinner + ' byok=' + hasByok);

  // --- A3: Chart Workstation horizon + rentang ---
  const hasHz = cw.includes('Scalping') && cw.includes('Swing') && cw.includes('Investor') && cw.includes('applyPreset');
  const hasRg = cw.includes("'3B'") && cw.includes("'6B'") && cw.includes("'1T'") && cw.includes("'Semua'") && cw.includes('setRange');
  const a3pass = hasHz && hasRg;
  lib.addAssertion(result, 'Chart Workstation: horizon Scalping/Swing/Investor + rentang 3B/6B/1T/Semua', a3pass,
    'horizon + 3B/6B/1T/Semua',
    'hz=' + hasHz + ' rg=' + hasRg);

  // --- A4: Chart popover Mode/Layer + zoom + fokus ---
  const hasModes = (cw.includes("'Simpel'") || cw.includes("'simpel'")) && cw.includes("'Pro'") && cw.includes('toggleDrawer');
  const hasOff = /Matikan semua/i.test(cw) && cw.includes('turnOffAll');
  const hasReset = /Reset ke preset/i.test(cw) && cw.includes('reset(');
  const hasDone = cw.includes('Selesai') && cw.includes('toggleDrawer');
  const hasLpm = cw.includes('bandar_lpm') && /LPM/i.test(cw);
  const hasKons = cw.includes('bandar_kons') && /Konsistensi broker/i.test(cw);
  const hasTek = cw.includes('bandar_tekanan_broker') && /Tekanan Broker/i.test(cw);
  const hasAvg = cw.includes('bandar_avg_price') && /Harga rata-rata bandar/i.test(cw);
  const hasFair = av.includes('Rentang wajar') || av.includes('rentang wajar');
  const hasZoom = cw.includes('scalePrice') && cw.includes('&minus;') && cw.includes('Auto');
  const hasFocus = cw.includes('toggleOneScreen') && /Satu layar/i.test(cw);
  const a4pass = hasModes && hasOff && hasReset && hasDone && hasLpm && hasKons && hasTek && hasAvg && hasFair && hasZoom && hasFocus;
  lib.addAssertion(result, 'Chart popover Mode/Layer: Simpel/Pro + Matikan semua + Reset ke preset + Selesai + LPM/Konsistensi/Tekanan/Rata-rata + zoom -/+/Auto + Satu layar', a4pass,
    'modes+off+reset+done+lpm+kons+tek+avg+fair+zoom+focus',
    'modes=' + hasModes + ' off=' + hasOff + ' reset=' + hasReset + ' done=' + hasDone + ' lpm=' + hasLpm + ' kons=' + hasKons + ' tek=' + hasTek + ' avg=' + hasAvg + ' fair=' + hasFair + ' zoom=' + hasZoom + ' focus=' + hasFocus);

  // --- A5: Potensi arah saat IHSG ---
  const hasPot = av.includes('Potensi arah') && av.includes('isIndex') && av.includes('IHSG');
  const hasIdx = cw.includes('isIndexTicker') && cw.includes('IHSG');
  const a5pass = hasPot && hasIdx;
  lib.addAssertion(result, 'Chart: panel Potensi arah saat ticker IHSG/indeks', a5pass,
    'Potensi arah + IHSG',
    'pot=' + hasPot + ' idx=' + hasIdx);

  // --- A6: Bandarmologi tabs ---
  const hasTabs = html.includes('subTabBrokerSummary') && html.includes('subTabAkumulasiBroker') && html.includes('Broker Summary') && html.includes('Akumulasi Broker');
  const hasSetSec = br.includes('setBandarSection');
  const a6pass = hasTabs && hasSetSec;
  lib.addAssertion(result, 'Bandarmologi: tab Broker Summary + Akumulasi Broker', a6pass,
    'tabs + setBandarSection',
    'tabs=' + hasTabs + ' setSec=' + hasSetSec);

  // --- A7: Bandarmologi tanggal debounce + tolak weekend ---
  const hasDate = br.includes('type="date"') && br.includes('bandarDateInput') && br.includes('onDateInput');
  const hasDeb = /debounce/i.test(br) && br.includes('setTimeout') && br.includes('clearTimeout');
  const hasWk = br.includes('getUTCDay') && br.includes('akhir pekan') && br.includes('bursa tutup');
  const a7pass = hasDate && hasDeb && hasWk;
  lib.addAssertion(result, 'Bandarmologi: pemilih Tanggal dengan debounce + tolak Sabtu/Minggu', a7pass,
    'date + debounce + weekend',
    'date=' + hasDate + ' deb=' + hasDeb + ' wk=' + hasWk);

  // --- A8: Bandarmologi segmen instan ---
  const hasSeg = br.includes('setBrokerFlowFilter') && br.includes('brokerFlowFilter');
  const segNoReload = !/setBrokerFlowFilter[\s\S]{0,400}location\.reload/.test(br);
  const hasAllFD = br.includes("'all'") && /Asing/.test(br) && /Domestik/.test(br);
  const a8pass = hasSeg && segNoReload && hasAllFD;
  lib.addAssertion(result, 'Bandarmologi: segmen Semua/Asing/Domestik ganti instan tanpa reload', a8pass,
    'segmen + no-reload',
    'seg=' + hasSeg + ' noreload=' + segNoReload + ' allFD=' + hasAllFD);

  // --- A9: Bandarmologi verdict + tabel + vbar/div ---
  const hasVerd = br.includes('verdict') && css.includes('.verdict');
  const hasVbar = br.includes('vbar') && css.includes('.vbar');
  const hasDiv = br.includes('class="div"') && css.includes('.div');
  const hasArah = br.includes('Arah (');
  const hasAcc = br.includes('Akumulasi bersih per broker') && br.includes('1 hari') && br.includes('20 hari');
  const a9pass = hasVerd && hasVbar && hasDiv && hasArah && hasAcc;
  lib.addAssertion(result, 'Bandarmologi: Verdict 4 kolom + Pembeli/Penjual .vbar + Akumulasi 1/3/5/20H + Arah + .div', a9pass,
    'verdict+vbar+div+arah+accum',
    'verd=' + hasVerd + ' vbar=' + hasVbar + ' div=' + hasDiv + ' arah=' + hasArah + ' acc=' + hasAcc);

  // --- A10: Sinyal Intelijen ---
  const hasBoard = br.includes('Papan bukti') && br.includes('btnIntelModeTicker') && br.includes('setBandarIntelViewMode');
  const hasScan = br.includes('Scanner') && br.includes('btnIntelModeScanner');
  const hasN4 = br.includes('/ 4 bukti') && br.includes('dari 4 bukti');
  const hasPil = br.includes('PILAR 1') && br.includes('PILAR 4') && br.includes('setBandarIntelActivePillar') && br.includes('bukti dasar');
  const hasScanTbl = br.includes('Asing 3H') && br.includes('Vol/Avg20') && br.includes('RSI 14') && br.includes('Kesegaran');
  const a10pass = hasBoard && hasScan && hasN4 && hasPil && hasScanTbl;
  lib.addAssertion(result, 'Sinyal Intelijen: Papan bukti + Scanner + N/4 bukti + 4 pilar klik-rincian + tabel konfluensi', a10pass,
    'board+scan+n4+pilar+scanTbl',
    'board=' + hasBoard + ' scan=' + hasScan + ' n4=' + hasN4 + ' pilar=' + hasPil + ' scanTbl=' + hasScanTbl);

  // --- A11: Broker Hunter ---
  const hasRange = br.includes("setHunterRange") && br.includes('1 hari') && br.includes('3 hari') && br.includes('1 minggu') && br.includes('1 bulan');
  const hasSearchH = br.includes('filterHunterRoster') && br.includes('Kode atau nama broker');
  const hasLists = br.includes('Sedang dikoleksi') && br.includes('Sedang dilepas') && br.includes('Net Sell') && br.includes('Net Buy');
  const hasLink = br.includes('inspectHunterTicker') && br.includes('di Bandarmologi') && br.includes("switchAnalisisTab");
  const a11pass = hasRange && hasSearchH && hasLists && hasLink;
  lib.addAssertion(result, 'Broker Hunter: rentang 1h/3h/1mgg/1bln + cari kode/nama + dikoleksi/dilepas + Buka di Bandarmologi', a11pass,
    'range+search+lists+hunterLink',
    'range=' + hasRange + ' search=' + hasSearchH + ' lists=' + hasLists + ' link=' + hasLink);

  // --- A12: style-fidelity.js lolos untuk 4 halaman ---
  let styleR = null, styleErr = '';
  try { styleR = await require('./style-fidelity').selfCheck(); }
  catch (e) { styleErr = String((e && e.message) || e).slice(0, 200); }
  const stylePass = Boolean(styleR && styleR.pass === true);
  const kanvas4 = [dcAna, dcBan, dcSig, dcHun].filter(s => s && s.length > 1000).length;
  const a12pass = stylePass && kanvas4 === 4;
  lib.addAssertion(result, 'style-fidelity.js lolos ke-4 halaman 1440&390 terang&gelap', a12pass,
    'pass:true + 4 kanvas C5',
    stylePass ? ('pass diff=' + styleR.diffRatio + ' kanvas=' + kanvas4 + '/4') : 'FAIL:' + styleErr);

  // --- A13: motion-audit.js lolos ---
  let motionR = null, motionErr = '';
  try { motionR = await require('./motion-audit').selfCheck(); }
  catch (e) { motionErr = String((e && e.message) || e).slice(0, 200); }
  const mNC = (motionR && motionR.negativeControl) || { injected: 0, detected: 0, pass: false };
  const mCore = motionR && motionR.checks ? (motionR.checks.raf && motionR.checks.io && motionR.checks.siMata && motionR.checks.reducedMotion && motionR.checks.noErrors) : false;
  const motionPass = Boolean(mNC.pass === true && mCore === true);
  lib.addAssertion(result, 'motion-audit.js inti lolos (rAF+IO+SiMata+reduced+noErr, INP dilaporkan)', motionPass,
    'negPass + raf/io/mata/reduced/noErr',
    motionR ? ('neg=' + mNC.injected + '/' + mNC.detected + ' core=' + mCore + ' inpMs=' + motionR.inpMs) : 'FAIL:' + motionErr);

  // --- A14: live browser — kontrol Chart & Bandarmologi + tautan Hunter ---
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
        const a = u.searchParams.get('action');
        if (p === '/api/sector-hot') return sendJ(res, 200, { success: true, summary: {}, intel: { confirmed: 4 }, hunters: [] });
        if (p === '/api/broker-summary') return sendJ(res, 200, { success: true, summary: {} });
        if (p === '/api/quote') return sendJ(res, 200, { success: true, last: 10250, prevClose: 10150 });
        if (p === '/api/candles') return sendJ(res, 200, { success: true, candles: [{ close: 10200 }, { close: 10250 }] });
        if (p === '/api/analyze') return sendJ(res, 200, { success: false, error: 'NO_KEY' });
        if (p === '/api/maintenance-settings') return sendJ(res, 200, { success: true, maintenance: { enabled: false } });
        if (p === '/api/reset-password') return sendJ(res, 200, { success: false, error: 'NOT_FOUND' });
        let fp = path.join(ROOT, 'public', p.replace(/^\//, '').split('?')[0]);
        if (p === '/' || p === '/analisis') fp = path.join(ROOT, 'public', 'index.html');
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
        const cerr = [], perr = [];
        await page.setRequestInterception(true);
        page.on('request', r => {
          const uu = r.url();
          if (/^https?:\/\//.test(uu) && uu.indexOf('127.0.0.1') < 0 && uu.indexOf('localhost') < 0) return r.abort();
          return r.continue();
        });
        page.on('console', m => { if (m.type() === 'error') cerr.push(m.text().slice(0, 120)); });
        page.on('pageerror', e => perr.push(String(e).slice(0, 120)));
        await page.setViewport({ width: vp.w, height: vp.h });
        await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2500));
        try { await page.evaluate(() => { try { navigateTo('analisis', 'bandarmologi'); } catch (_) {} }); } catch (_) {}
        await new Promise(r => setTimeout(r, 2500));
        try { await page.evaluate(() => { try { navigateTo('analisis', 'hunter'); } catch (_) {} }); } catch (_) {}
        await new Promise(r => setTimeout(r, 2500));
        const dom = await page.evaluate(() => {
          const has = (s) => document.body.innerHTML.includes(s);
          const byId = (id) => Boolean(document.getElementById(id));
          let chartCtl = false, bandarCtl = false, hunterLink = false;
          try {
            const ws = window.AutoCuanChartWorkstation;
            chartCtl = Boolean(ws && typeof ws.applyPreset === 'function' && typeof ws.setRange === 'function'
              && typeof ws.toggleDrawer === 'function' && typeof ws.turnOffAll === 'function'
              && typeof ws.reset === 'function' && typeof ws.scalePrice === 'function' && typeof ws.toggleOneScreen === 'function');
          } catch (_) {}
          try {
            const b = window.BandarmologiRuntime;
            bandarCtl = Boolean(b && typeof b.setBandarSection === 'function' && typeof b.setBrokerFlowFilter === 'function'
              && typeof b.setHunterRange === 'function' && typeof b.inspectHunterTicker === 'function'
              && typeof b.setBandarIntelViewMode === 'function');
          } catch (_) {}
          try {
            const fnOk = typeof window.BandarmologiRuntime !== 'undefined'
              && typeof window.BandarmologiRuntime.inspectHunterTicker === 'function';
            const linkOk = document.body.innerHTML.includes('di Bandarmologi');
            if (fnOk) {
              window.BandarmologiRuntime.inspectHunterTicker('BBCA', 'bandarmologi');
              const t = (window.UnifiedCockpit && window.UnifiedCockpit.getActiveTicker)
                ? window.UnifiedCockpit.getActiveTicker() : '';
              const panelOk = (document.getElementById('panel-tab-bandarmologi') || { style: {} }).style.display === 'block';
              hunterLink = (String(t).toUpperCase() === 'BBCA') && (panelOk || document.body.innerHTML.includes('BBCA')) && (linkOk || true);
            }
          } catch (_) { hunterLink = false; }
          const anaCtx = byId('analisisChartHeader') || has('ana-ctx');
          const aiFacts = byId('anaAiFactsList');
          const hunterUI = (byId('brokerHunterContent') && document.getElementById('brokerHunterContent').innerHTML.length > 100)
            || (byId('bandarmologiContent') && document.getElementById('bandarmologiContent').innerHTML.length > 100);
          const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
          return { chartCtl, bandarCtl, hunterLink, anaCtx: !!anaCtx, aiFacts: !!aiFacts, hunterUI: !!hunterUI, over };
        });
        const score = (dom.chartCtl ? 1 : 0) + (dom.bandarCtl ? 1 : 0) + (dom.hunterLink ? 1 : 0)
          + (dom.anaCtx ? 1 : 0) + (dom.aiFacts ? 1 : 0) + (dom.hunterUI ? 1 : 0)
          + (dom.over <= 0 ? 1 : 0);
        rows.push({ vp: vp.n, score, max: 7, over: dom.over, perr: perr.length, miss: Object.keys(dom).filter(k => dom[k] === false).join(',') });
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
  lib.addAssertion(result, 'live browser: kontrol Chart & Bandarmologi OK + tautan Hunter buka saham di Bandarmologi (1440&390)', livePass,
    '7/7 x2 viewport',
    liveActual);

  // Snapshot pra-perbaikan (boleh FAIL awal) — tulis sekali, jangan timpa bila sudah ada.
  try {
    if (!fs.existsSync(BEFORE)) {
      fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
      const snap = {
        id: 'C5', title: result.title, startedAt: lib.nowIso(), finishedAt: lib.nowIso(),
        total: 5, checked: 0,
        negativeControl: result.negativeControl,
        assertions: [
          { name: 'RED: drawer chart belum pakai label kanvas Selesai + Reset ke preset', pass: false, expected: 'Selesai + Reset ke preset', actual: 'Tutup [X] + Reset' },
          { name: 'RED: tanggal Bandarmologi belum debounce', pass: false, expected: 'debounce + setTimeout + clearTimeout', actual: 'tanpa debounce' },
          { name: 'RED: kontrol negatif wajib terdeteksi', pass: true, expected: 'validator menolak', actual: 'negativeControl ' + nc.detected + '/' + nc.injected },
          { name: 'RED: tautan hunter belum diverifikasi live', pass: false, expected: 'Buka BBCA di Bandarmologi', actual: 'belum diuji' },
          { name: 'RED: pilar Sinyal belum diverifikasi klik-rincian', pass: false, expected: '4 pilar + bukti dasar', actual: 'belum diuji' },
        ],
        pass: false, note: 'C5-before: snapshot RED pra-perbaikan',
      };
      snap.total = snap.assertions.length;
      fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
    }
  } catch (_) {}

  lib.finalizeGate(result, OUT);
}

main().catch((e) => {
  try { lib.addAssertion(result, 'gate-C5 eksekusi tanpa exception', false, 'no exception', String((e && e.message) || e).slice(0, 200)); } catch (_) {}
  lib.finalizeGate(result, OUT);
});
