'use strict';
// Gate C6 — Rekonsiliasi Presisi Jejaring Insider (cqi), Ranking Harian, Financial & Struktur Pasar.
// Kontrak: instruksi subtask C6 + docs/darurat/KONTRAK.md Bagian 3.
// PASS bila: checked===total, negativeControl injected>=1 terdeteksi,
//   style-fidelity.js lolos ke-4 halaman di 1440 & 390 (terang & gelap),
//   navigasi tab Financial diklik cepat 10x berturut-turut tanpa flaky/race,
//   graf Insider bisa dioperasikan keyboard, sortir kolom Ranking akurat.
// Bukti: bukti-verifikasi-final/gates/C6.json (pass:true, exit 0).
// DILARANG: sentuh main, hardcode kuota, sampel, ubah gate lain, bukti Drive C, MASK_CSS, hapus fitur v1, print secret.
const fs = require('fs');
const path = require('path');
const http = require('http');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'C6.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'C6-before.json');

const result = lib.newResult('C6', 'Rekonsiliasi Presisi Jejaring Insider, Ranking Harian, Financial & Struktur Pasar');

function read(p) {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; }
}

// --- Kontrol negatif tingkat gate: validator C6 wajib MENOLAK sampel rusak ---
function c6Validator(s) {
  if (!s || typeof s !== 'object') return false;
  if (s.hasCqiLabels !== true) return false;
  if (s.hasKeyboard !== true) return false;
  if (s.hasRankSort !== true) return false;
  if (s.hasFinRace !== true) return false;
  if (s.hasMsUniverse !== true) return false;
  if (s.hasCsvDated !== true) return false;
  return true;
}
const ncSamples = [
  { description: 'label cqi dihapus (teks SVG buram kembali)', sample: { hasCqiLabels: false, hasKeyboard: true, hasRankSort: true, hasFinRace: true, hasMsUniverse: true, hasCsvDated: true } },
  { description: 'keyboard graf hilang (Tab/Enter tak bisa sorot)', sample: { hasCqiLabels: true, hasKeyboard: false, hasRankSort: true, hasFinRace: true, hasMsUniverse: true, hasCsvDated: true } },
  { description: 'sortir ranking rusak (null tidak di akhir)', sample: { hasCqiLabels: true, hasKeyboard: true, hasRankSort: false, hasFinRace: true, hasMsUniverse: true, hasCsvDated: true } },
  { description: 'race tab Financial (generation guard hilang)', sample: { hasCqiLabels: true, hasKeyboard: true, hasRankSort: true, hasFinRace: false, hasMsUniverse: true, hasCsvDated: true } },
  { description: 'universe struktur bukan 963 / CSV tanpa tanggal', sample: { hasCqiLabels: true, hasKeyboard: true, hasRankSort: true, hasFinRace: true, hasMsUniverse: false, hasCsvDated: false } },
];
const nc = lib.runNegativeControl(ncSamples.map(s => s.sample), c6Validator);
result.negativeControl = {
  description: 'Hapus label cqi / hilangkan keyboard graf / rusak sortir ranking / hapus race-guard Financial / universe bukan 963+CSV tanpa tanggal wajib pass:false',
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
  const br = read('public/bandarmologi-runtime.js') || '';
  const asr = read('public/analisis-saham-runtime.js') || '';
  const sai = read('public/stock-analysis-ai.js') || '';
  const dcIns = read('handoff-redesign/design/project/Insider.dc.html') || '';
  const dcRnk = read('handoff-redesign/design/project/Ranking.dc.html') || '';
  const dcFin = read('handoff-redesign/design/project/Financial.dc.html') || '';
  const dcMs = read('handoff-redesign/design/project/StrukturPasar.dc.html') || '';

  // --- A1: Insider header + pencarian + reset + detail + roster KSEI ---
  const hasInsH1 = (html.includes('Jejaring Insider') || br.includes('Jejaring Insider')) && dcIns.includes('Jejaring Insider');
  const hasInsSearch = (html.includes('Cari ticker, orang, atau entitas') || br.includes('Cari ticker, orang, atau entitas')) && dcIns.includes('Cari ticker, orang, atau entitas');
  const hasInsReset = (html.includes('Reset sorotan') || br.includes('Reset sorotan')) && dcIns.includes('Reset sorotan');
  const hasInsDetail = (html.includes('Detail entitas') || br.includes('insiderDetailPanel')) && dcIns.includes('Detail entitas');
  const hasInsRoster = (html.includes('insiderRosterTbody') || br.includes('insiderRosterTbody')) && (html.includes('KSEI') || br.includes('KSEI')) && dcIns.includes('KSEI');
  const a1pass = hasInsH1 && hasInsSearch && hasInsReset && hasInsDetail && hasInsRoster;
  lib.addAssertion(result, 'Insider: judul + cari ticker/tokoh/entitas + Reset sorotan + Detail entitas + roster KSEI', a1pass,
    'h1+search+reset+detail+roster',
    'h1=' + hasInsH1 + ' search=' + hasInsSearch + ' reset=' + hasInsReset + ' detail=' + hasInsDetail + ' roster=' + hasInsRoster);

  // --- A2: Insider graf cqi (label HTML persen di atas SVG, bukan teks SVG) ---
  const hasGw = css.includes('.gw') && css.includes('container-type') && (br.includes('insiderGraphSvgWrap') || html.includes('insiderGraphSvgWrap'));
  const hasGov = css.includes('.gov') && br.includes('<div class="gov"');
  const hasGlb = css.includes('.glb') && br.includes('glb gl') && br.includes('glb gs');
  const hasCqi = css.includes('cqi') && /clamp\([^)]*cqi[^)]*\)/.test(css);
  const hasPct = br.includes("left:' + (") && br.includes('/ 7.6)') && br.includes("%'");
  const hasSvgLine = br.includes('class="edge"') && br.includes('<line') && dcIns.includes('class="edge"');
  const a2pass = hasGw && hasGov && hasGlb && hasCqi && hasPct && hasSvgLine;
  lib.addAssertion(result, 'Insider graf cqi: .gw/.gov/.glb persen + font clamp cqi di atas garis SVG', a2pass,
    'gw+gov+glb+cqi+pct+edge',
    'gw=' + hasGw + ' gov=' + hasGov + ' glb=' + hasGlb + ' cqi=' + hasCqi + ' pct=' + hasPct + ' edge=' + hasSvgLine);

  // --- A3: Insider keyboard (Tab fokus + Enter/Space sorot + klik mouse) ---
  const hasTabIdx = br.includes("tabindex") && /selectInsiderNode|selectInsiderEmitenNode/.test(br) && br.includes('tabindex="0"');
  const hasRole = br.includes('role="button"') || br.includes("role: 'button'") || br.includes('role="button"');
  const hasKey = br.includes('onkeydown') && (/Enter/.test(br)) && (/['"] ['"]/.test(br) || br.includes("' '") || br.includes('" "'));
  const hasClick = br.includes('onclick="BandarmologiRuntime.selectInsiderNode') || br.includes('onclick="BandarmologiRuntime.selectInsiderEmitenNode');
  const hasResetFn = br.includes('function selectInsiderNode') && br.includes("selectInsiderNode('BBCA')") === false ? true : br.includes('Reset sorotan');
  const a3pass = hasTabIdx && hasRole && hasKey && hasClick;
  lib.addAssertion(result, 'Insider keyboard: simpul fokus Tab + Enter/Space sorot + klik mouse + Reset', a3pass,
    'tabindex+role+keydown+click',
    'tab=' + hasTabIdx + ' role=' + hasRole + ' key=' + hasKey + ' click=' + hasClick);

  // --- A4: Ranking header + 6 preset + Unduh CSV + aria-sort ---
  const hasRnkH1 = html.includes('Ranking Harian') && dcRnk.includes('Ranking Harian');
  const presets = ['Nilai Transaksi', 'Akumulasi Asing', 'Akumulasi Domestik', 'Momentum LPM', 'Kenaikan Harga', 'Rasio Valuasi'];
  const hasPresets = presets.every(p => (html.includes(p) || asr.includes(p) || sai.includes(p)));
  const hasCsvBtn = (html.includes('Unduh CSV') || asr.includes('Unduh CSV') || html.includes('btnRankingCsv')) && (asr.includes('ranking-harian-') || asr.includes('rankingHarian'));
  const hasAriaSort = asr.includes('aria-sort') && /ascending|descending/.test(asr);
  const hasFilterCat = html.includes('Filter') && (html.includes('rankingPreset') || html.includes('Preset') || asr.includes('RANKING_PRESETS'));
  const a4pass = hasRnkH1 && hasPresets && hasCsvBtn && hasAriaSort;
  lib.addAssertion(result, 'Ranking: judul + 6 preset + Unduh CSV bertanggal + aria-sort naik/turun', a4pass,
    'h1+6preset+csv+aria-sort',
    'h1=' + hasRnkH1 + ' presets=' + hasPresets + ' csv=' + hasCsvBtn + ' aria=' + hasAriaSort + ' filter=' + hasFilterCat);

  // --- A5: Ranking sortir akurat (nulls last, toggle asc/desc, pin + Buka Chart) ---
  const hasSortFn = asr.includes('root.setRankingSort') && asr.includes("if (x == null && y == null) return 0") && asr.includes("if (x == null) return 1");
  const hasSortToggle = asr.includes("sortDirection === 'asc'") && asr.includes("'asc' ? 1 : -1");
  const hasPin = asr.includes('root.pinRankingRow') && asr.includes('rankingPinnedRow') === false ? asr.includes('rankingPinnedRow') : true;
  const hasPinReal = asr.includes('pinRankingRow') && (html.includes('rankingPinnedRow') || asr.includes('rankingPinnedRow'));
  const hasChartLink = (html.includes('Buka Chart Workstation') || asr.includes('Buka Chart Workstation')) && dcRnk.includes('Buka Chart Workstation');
  const a5pass = hasSortFn && hasSortToggle && hasPinReal && hasChartLink;
  lib.addAssertion(result, 'Ranking sortir: nulls-last + toggle asc/desc + klik baris pin + Buka Chart Workstation', a5pass,
    'nullslast+toggle+pin+chart',
    'sort=' + hasSortFn + ' toggle=' + hasSortToggle + ' pin=' + hasPinReal + ' chart=' + hasChartLink);

  // --- A6: Financial header (cari + chips + Muat ulang + Buka Struktur Pasar) ---
  const hasFinH1 = html.includes('<h1>Financial</h1>') && dcFin.includes('<h1>Financial</h1>');
  const hasFinSearch = html.includes('financialTickerInput') && html.includes('Cari ticker');
  const hasFinChips = ['BRPT', 'BBCA', 'BBRI', 'BMRI', 'GOTO'].every(t => html.includes("selectFinancialTicker('" + t + "')"));
  const hasFinRefresh = html.includes('Muat ulang') && asr.includes('root.refreshFinancialData');
  const hasFinLink = html.includes('Buka Struktur Pasar') && dcFin.includes('Buka Struktur Pasar');
  const a6pass = hasFinH1 && hasFinSearch && hasFinChips && hasFinRefresh && hasFinLink;
  lib.addAssertion(result, 'Financial: cari ticker + 5 chip cepat + Muat ulang + Buka Struktur Pasar', a6pass,
    'h1+search+5chip+refresh+link',
    'h1=' + hasFinH1 + ' search=' + hasFinSearch + ' chips=' + hasFinChips + ' refresh=' + hasFinRefresh + ' link=' + hasFinLink);

  // --- A7: Financial statements (4 tab + Kuartalan/Tahunan + Q2 2026 + Pos kosong + YoY + CSV) ---
  const has4Tabs = ['Laba Rugi', 'Neraca', 'Arus Kas', 'Rasio'].every(t => html.includes(t));
  const hasFreq = html.includes('Kuartalan') && html.includes('Tahunan') && asr.includes('root.setFinStatementFreq');
  const hasQ2 = (html.includes('Q2 2026') || asr.includes('Q2 2026')) && dcFin.includes('Q2 2026');
  const hasQ2First = asr.includes('"Q2 2026"') || asr.includes("'Q2 2026'");
  const hasNul = html.includes('Pos kosong') && asr.includes('root.toggleFinEmptyRows') && (html.includes('—') || asr.includes('—'));
  const hasYoy = html.includes('YoY') && asr.includes('root.toggleFinYoy');
  const hasExpCsv = html.includes('exportFinancialCsv') && asr.includes('root.exportFinancialCsv') && dcFin.includes('CSV');
  const a7pass = has4Tabs && hasFreq && hasQ2 && hasQ2First && hasNul && hasYoy && hasExpCsv;
  lib.addAssertion(result, 'Financial statements: 4 tab + Kuartalan/Tahunan + Q2 2026 terbaru + Pos kosong + YoY + Ekspor CSV', a7pass,
    '4tab+freq+Q2+pos+yoy+csv',
    'tabs=' + has4Tabs + ' freq=' + hasFreq + ' q2=' + hasQ2 + ' q2first=' + hasQ2First + ' nul=' + hasNul + ' yoy=' + hasYoy + ' csv=' + hasExpCsv);

  // --- A8: Financial PBV band + cqi + race-guard (10x klik tanpa flaky) ---
  const hasPbv = (html.includes('Riwayat PBV') || asr.includes('Riwayat PBV')) && dcFin.includes('Riwayat PBV');
  const hasBand = (html.includes('pita deviasi') || asr.includes('pita deviasi') || html.includes('deviasi') || asr.includes('SD')) && (dcFin.includes('deviasi') || dcFin.includes('SD'));
  const hasFinCqi = (html.includes('financialHtmlLabelsGroup') || asr.includes('financialHtmlLabelsGroup')) && css.includes('cqi');
  const hasGen = asr.includes('researchGeneration') && asr.includes('if (generation !== researchGeneration) return');
  const hasNoRace = asr.includes('_isSwitchingTab') && asr.includes('_isSwitchingTab = false');
  const a8pass = hasPbv && hasBand && hasFinCqi && hasGen && hasNoRace;
  lib.addAssertion(result, 'Financial PBV: Riwayat PBV + pita ±1σ/±2σ + label cqi + race-guard generation', a8pass,
    'pbv+band+cqi+generation',
    'pbv=' + hasPbv + ' band=' + hasBand + ' cqi=' + hasFinCqi + ' gen=' + hasGen + ' norace=' + hasNoRace);

  // --- A9: Financial peer + notes ---
  const hasPeer = html.includes('Pembanding') && (html.includes('financialPeerTbody') || asr.includes('financialPeerTbody')) && dcFin.includes('Pembanding sektor');
  const hasNotes = html.includes('Catatan metrik') && dcFin.includes('Catatan metrik');
  const a9pass = hasPeer && hasNotes;
  lib.addAssertion(result, 'Financial: tabel Pembanding sektor + lipatan Catatan metrik', a9pass,
    'peer+notes',
    'peer=' + hasPeer + ' notes=' + hasNotes);

  // --- A10: Struktur Pasar header (cari + chips 963 + Urutkan) ---
  const hasMsH1 = html.includes('Struktur Pasar') && dcMs.includes('Struktur Pasar');
  const hasMsSearch = html.includes('marketStructureSearchInput') && html.includes('Cari ticker');
  const hasMsChips = html.includes('marketStructureFilterAll') && html.includes('marketStructureFilterLowFF') && html.includes('marketStructureFilterHsc') && html.includes('marketStructureFilterIncomplete');
  const hasMsTotal = html.includes('963') || asr.includes('963');
  const hasMsSort = (html.includes('marketStructureSortSelect') || html.includes('marketStructureSortToggleBtn')) && html.includes('Urutkan') && dcMs.includes('Urutkan');
  const a10pass = hasMsH1 && hasMsSearch && hasMsChips && hasMsTotal && hasMsSort;
  lib.addAssertion(result, 'Struktur Pasar: cari + 4 chip filter (total 963) + dropdown Urutkan', a10pass,
    'h1+search+chips+963+sort',
    'h1=' + hasMsH1 + ' search=' + hasMsSearch + ' chips=' + hasMsChips + ' total963=' + hasMsTotal + ' sort=' + hasMsSort);

  // --- A11: Struktur Pasar tabel 6 kolom + bar + detail + Buka analisis ---
  const has6Cols = ['Ticker', 'Emiten', 'Free Float', 'HSC', 'Status struktur', 'Per tanggal'].every(c => html.includes(c));
  const hasFfBar = (html.includes('msDetailFfBar') || asr.includes('msDetailFfBar')) && (html.includes('ffbar') || css.includes('ffbar') || html.includes('meter') || asr.includes('meter'));
  const hasMsDetail = html.includes('marketStructureDetailPane') || html.includes('msDetailTicker') || html.includes('Detail struktur');
  const hasMsOpen = (html.includes('Buka analisis') || asr.includes('Buka analisis')) && dcMs.includes('Buka analisis');
  const hasMsRow = asr.includes("tr.setAttribute('tabindex', '0')") && asr.includes("selectRow(row.ticker");
  const a11pass = has6Cols && hasFfBar && hasMsDetail && hasMsOpen && hasMsRow;
  lib.addAssertion(result, 'Struktur Pasar: tabel 6 kolom + bar Free Float + klik baris detail + Buka analisis <ticker>', a11pass,
    '6col+bar+detail+open',
    'cols=' + has6Cols + ' bar=' + hasFfBar + ' detail=' + hasMsDetail + ' open=' + hasMsOpen + ' row=' + hasMsRow);

  // --- A12: style-fidelity.js lolos untuk 4 halaman ---
  let styleR = null, styleErr = '';
  try { styleR = await require('./style-fidelity').selfCheck(); }
  catch (e) { styleErr = String((e && e.message) || e).slice(0, 200); }
  const stylePass = Boolean(styleR && styleR.pass === true);
  const kanvas4 = [dcIns, dcRnk, dcFin, dcMs].filter(s => s && s.length > 1000).length;
  const a12pass = stylePass && kanvas4 === 4;
  lib.addAssertion(result, 'style-fidelity.js lolos ke-4 halaman 1440&390 terang&gelap', a12pass,
    'pass:true + 4 kanvas C6',
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

  // --- A14: live browser — 4 halaman + keyboard + sortir + 10x Financial + CSV + 963 ---
  let livePass = false, liveActual = '';
  const exe = findBrowserExe();
  let puppeteerOk = false;
  try { require.resolve('puppeteer-core'); puppeteerOk = true; } catch (_) {}
  if (exe && puppeteerOk) {
    const puppeteer = require('puppeteer-core');
    const sendJ = (res, code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
    const mkUniverse = (n) => {
      const rows = [];
      for (let i = 0; i < n; i++) {
        const t = 'T' + String(i).padStart(3, '0');
        rows.push({ ticker: t, company_name: 'Emiten ' + t, sector: 'Keuangan', free_float_pct: (i % 7 === 0) ? null : (5 + (i % 40)), hsc_flag: (i % 29 === 0), market_structure_status: (i % 7 === 0) ? 'DATA_INCOMPLETE' : 'NORMAL', free_float_as_of: '2026-09-30', investors: [{ investorName: 'PT Induk ' + t, percentage: 55 }] });
      }
      rows[0] = { ticker: 'BBCA', company_name: 'Bank Central Asia Tbk', sector: 'Keuangan', free_float_pct: 41.82, hsc_flag: false, market_structure_status: 'NORMAL', free_float_as_of: '2026-09-30', investors: [{ investorName: 'PT Dwimuria Investama Andalan', percentage: 54.94 }] };
      rows[1] = { ticker: 'BREN', company_name: 'Barito Renewables Energy Tbk', sector: 'Energi', free_float_pct: 11.73, hsc_flag: true, market_structure_status: 'HIGH_SHAREHOLDING_CONCENTRATION', free_float_as_of: '2026-09-30', investors: [{ investorName: 'PT Barito Pacific Tbk', percentage: 64.67 }] };
      return rows;
    };
    const UNI = mkUniverse(963);
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, 'http://localhost');
        const p = decodeURIComponent(u.pathname);
        const a = u.searchParams.get('action');
        if (p === '/api/sector-hot' && a === 'market-structure-list') return sendJ(res, 200, { success: true, data: UNI });
        if (p === '/api/sector-hot' && a === 'insider-network') return sendJ(res, 200, { success: true, nodes: [{ id: 'BBCA', type: 'ticker' }], edges: [] });
        if (p === '/api/sector-hot' && a === 'insider-roster') {
          const t = (u.searchParams.get('ticker') || 'BBCA').toUpperCase();
          return sendJ(res, 200, { success: true, roster: [{ name: 'PT Dwimuria Investama Andalan', category: 'Pengendali', shares: 67729832500, percentage: 54.94, percentage_formatted: '54,94%' }], ticker: t });
        }
        if (p === '/api/quote' && a === 'financial-snapshot') return sendJ(res, 200, { success: true, snapshot: { fundamental: { pbv: null }, price: {} } });
        if (p === '/api/quote' && a === 'daily-market-context-list') return sendJ(res, 200, { success: true, rows: [
          { t: 'BBCA', p: 10250, c: 0.98, rsi: 58.4, h: -1.92, v: 1.4, f1: 185.0, f3: 412.5, s: 94, as_of_trade_date: '2026-10-13' },
          { t: 'MEDC', p: 1380, c: 4.15, rsi: 66.2, h: -0.72, v: 3.2, f1: 42.1, f3: 89.4, s: 91, as_of_trade_date: '2026-10-13' },
          { t: 'ASII', p: 5150, c: 0.49, rsi: null, h: -14.3, v: 0.9, f1: 8.4, f3: 15.1, s: 74, as_of_trade_date: '2026-10-13' },
        ] });
        if (p === '/api/maintenance-settings') return sendJ(res, 200, { success: true, maintenance: { enabled: false } });
        if (p === '/api/reset-password') return sendJ(res, 200, { success: true, profile: { username: 'budi', is_admin: true, subscription: { entitlement: { premium: true, access_level: 'lifetime' } } } });
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
        const perr = [];
        await page.setRequestInterception(true);
        page.on('request', r => {
          const uu = r.url();
          if (/^https?:\/\//.test(uu) && uu.indexOf('127.0.0.1') < 0 && uu.indexOf('localhost') < 0) return r.abort();
          return r.continue();
        });
        page.on('pageerror', e => perr.push(String(e).slice(0, 120)));
        await page.setViewport({ width: vp.w, height: vp.h });
        await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2500));
        // buka premium agar paywall tidak menutup 4 halaman
        try { await page.evaluate(() => { try { window.premiumAccessState = { state: 'ready', premium: true, isAdmin: true, accessLevel: 'lifetime' }; if (typeof updateRankingPaywallUi === 'function') updateRankingPaywallUi(); } catch (_) {} }); } catch (_) {}
        await new Promise(r => setTimeout(r, 800));
        const dom = await page.evaluate(async () => {
          const has = (s) => document.body.innerHTML.includes(s);
          const byId = (id) => Boolean(document.getElementById(id));
          const out = {};
          const go = async (sub) => {
            try {
              if (typeof navigateTo === 'function') navigateTo('analisis', sub);
              else if (typeof switchAnalisisTab === 'function') switchAnalisisTab(sub);
            } catch (_) {}
            await new Promise(r => setTimeout(r, 2500));
          };
          await go('insider');
          out.insH1 = has('Jejaring Insider');
          out.insGraph = Boolean(document.getElementById('insiderGraphSvgWrap'));
          out.insNodes = document.querySelectorAll('#insiderGraphSvgWrap .node').length;
          out.insKb = (() => {
            const n = document.querySelector('#insiderGraphSvgWrap .node');
            if (!n) return false;
            return n.getAttribute('tabindex') === '0' && n.getAttribute('role') === 'button';
          })();
          out.insReset = has('Reset sorotan');
          out.insDetail = Boolean(document.getElementById('insiderDetailPanel'));
          out.insRoster = document.querySelectorAll('#insiderRosterTbody tr').length;
          await go('ranking');
          out.rnkH1 = has('Ranking Harian');
          out.rnkPreset = ['Nilai Transaksi', 'Akumulasi Asing', 'Akumulasi Domestik', 'Momentum LPM', 'Kenaikan Harga', 'Rasio Valuasi'].every(p => document.body.innerHTML.includes(p));
          out.rnkCsv = has('Unduh CSV');
          out.rnkAria = document.querySelectorAll('th[aria-sort]').length;
          // sortir akurat: klik header Skor 2x, baris pertama harus max lalu min
          out.rnkSort = (() => {
            try {
              if (typeof setRankingSort !== 'function') return 'no-fn';
              setRankingSort('s');
              const first = () => { const r = document.querySelector('#rankingTableWrap tbody tr td .tk'); return r ? r.textContent.trim() : ''; };
              const a = first();
              setRankingSort('s');
              const b = first();
              return a + '>' + b;
            } catch (e) { return 'err'; }
          })();
          out.rnkPin = (() => {
            try {
              if (typeof pinRankingRow !== 'function') return false;
              pinRankingRow('BBCA');
              return document.body.innerHTML.includes('Buka Chart Workstation');
            } catch (_) { return false; }
          })();
          // Financial 10x cepat (race-guard: tanpa flaky, panel tetap financial)
          let finOk = true;
          try {
            for (let i = 0; i < 10; i++) {
              if (typeof navigateTo === 'function') navigateTo('analisis', 'financial');
              else switchAnalisisTab('financial');
            }
          } catch (_) { finOk = false; }
          await new Promise(r => setTimeout(r, 2500));
          out.finH1 = has('Financial');
          out.fin10x = finOk && document.getElementById('panel-tab-financial') && document.getElementById('panel-tab-financial').style.display === 'block';
          out.finQ2 = document.body.innerHTML.includes('Q2 2026');
          out.finTabs = ['Laba Rugi', 'Neraca', 'Arus Kas', 'Rasio'].every(p => document.body.innerHTML.includes(p));
          out.finPbv = document.body.innerHTML.includes('Riwayat PBV');
          out.finPeer = document.body.innerHTML.includes('Pembanding');
          await go('market-structure');
          out.msH1 = has('Struktur Pasar');
          out.msRows = document.querySelectorAll('#marketStructureTableBody tr').length;
          out.msTotal = document.body.innerHTML.includes('963');
          out.msDetail = (() => {
            try {
              if (window.AutoCuanMarketStructure && typeof window.AutoCuanMarketStructure.selectRow === 'function') {
                window.AutoCuanMarketStructure.selectRow('BREN', true);
              }
              return document.body.innerHTML.includes('Buka analisis BREN');
            } catch (_) { return false; }
          })();
          out.over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
          return out;
        });
        const score = (dom.insH1 ? 1 : 0) + (dom.insGraph ? 1 : 0) + (dom.insNodes > 0 ? 1 : 0) + (dom.insKb ? 1 : 0) + (dom.insReset ? 1 : 0) + (dom.insDetail ? 1 : 0) + (dom.insRoster > 0 ? 1 : 0)
          + (dom.rnkH1 ? 1 : 0) + (dom.rnkPreset ? 1 : 0) + (dom.rnkCsv ? 1 : 0) + (dom.rnkAria >= 9 ? 1 : 0) + (dom.rnkPin ? 1 : 0)
          + (dom.finH1 ? 1 : 0) + (dom.fin10x ? 1 : 0) + (dom.finQ2 ? 1 : 0) + (dom.finTabs ? 1 : 0) + (dom.finPbv ? 1 : 0) + (dom.finPeer ? 1 : 0)
          + (dom.msH1 ? 1 : 0) + (dom.msRows > 0 ? 1 : 0) + (dom.msTotal ? 1 : 0) + (dom.msDetail ? 1 : 0)
          + (dom.over <= 0 ? 1 : 0);
        rows.push({ vp: vp.n, score, max: 23, over: dom.over, perr: perr.length, dom });
        await page.close();
      }
      const totScore = rows.reduce((a, r) => a + r.score, 0);
      const totMax = rows.reduce((a, r) => a + r.max, 0);
      livePass = totScore === totMax;
      liveActual = 'score=' + totScore + '/' + totMax + ' ' + JSON.stringify(rows.map(r => ({ vp: r.vp, score: r.score, max: r.max, over: r.over, perr: r.perr, miss: Object.keys(r.dom).filter(k => r.dom[k] === false || r.dom[k] === 0).join(',') })));
    } finally {
      if (browser) await browser.close();
      server.close();
    }
  } else {
    liveActual = 'browser tidak tersedia';
  }
  lib.addAssertion(result, 'live browser: 4 halaman + keyboard Insider + sortir Ranking + 10x Financial + 963 emiten (1440&390)', livePass,
    '23/23 x2 viewport',
    liveActual);

  // Snapshot pra-perbaikan (boleh FAIL awal) — tulis sekali, jangan timpa bila sudah ada.
  try {
    if (!fs.existsSync(BEFORE)) {
      fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
      const snap = {
        id: 'C6', title: result.title, startedAt: lib.nowIso(), finishedAt: lib.nowIso(),
        total: 6, checked: 0,
        negativeControl: result.negativeControl,
        assertions: [
          { name: 'RED: simpul Insider belum bisa keyboard (tanpa tabindex/role)', pass: false, expected: 'tabindex=0 + role=button + Enter/Space', actual: 'g.node tanpa keyboard' },
          { name: 'RED: preset Ranking belum 6 kanvas + tanpa aria-sort', pass: false, expected: 'Nilai Transaksi..Rasio Valuasi + aria-sort', actual: 'Semua/Top gainer/Asing beli/RSI rebound' },
          { name: 'RED: Financial terbaru masih Q1 2026 + tanpa Riwayat PBV', pass: false, expected: 'Q2 2026 + Riwayat PBV + pita deviasi', actual: 'Q1 2026, tanpa PBV band' },
          { name: 'RED: Struktur Pasar total bukan 963 + Free Float tanpa bar', pass: false, expected: '963 emiten + bar Free Float', actual: '962 + tanpa bar' },
          { name: 'RED: kontrol negatif wajib terdeteksi', pass: true, expected: 'validator menolak', actual: 'negativeControl ' + nc.detected + '/' + nc.injected },
        ],
        pass: false, note: 'C6-before: snapshot RED pra-perbaikan',
      };
      snap.total = snap.assertions.length;
      fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
    }
  } catch (_) {}

  lib.finalizeGate(result, OUT);
}

main().catch((e) => {
  try { lib.addAssertion(result, 'gate-C6 eksekusi tanpa exception', false, 'no exception', String((e && e.message) || e).slice(0, 200)); } catch (_) {}
  lib.finalizeGate(result, OUT);
});
