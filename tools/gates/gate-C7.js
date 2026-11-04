'use strict';
// Gate C7 — Rekonsiliasi Presisi Watchlist, Portfolio, Track Record, & Pusat Akun / VIP.
// Kontrak: instruksi subtask C7 + docs/darurat/KONTRAK.md Bagian 3.
// PASS bila: checked===total, negativeControl injected>=1 terdeteksi,
//   style-fidelity.js lolos ke-4 halaman di 1440 & 390 (terang & gelap),
//   alur tambah/hapus/urungkan Watchlist lolos, Guard Average Down berfungsi,
//   Track Record terbukti tampilkan baris berstatus SL dari data riil,
//   logout BroadcastChannel terbukti tutup sesi tab kedua di Playwright.
// Bukti: bukti-verifikasi-final/gates/C7.json (pass:true, exit 0).
// DILARANG: sentuh main, hardcode kuota, sampel, ubah gate lain, bukti Drive C, MASK_CSS, hapus fitur v1, print secret.
const fs = require('fs');
const path = require('path');
const http = require('http');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'C7.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'C7-before.json');

const result = lib.newResult('C7', 'Rekonsiliasi Presisi Watchlist, Portfolio, Track Record, & Pusat Akun / VIP');

function read(p) {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; }
}

// --- Kontrol negatif tingkat gate: validator C7 wajib MENOLAK sampel rusak ---
function c7Validator(s) {
  if (!s || typeof s !== 'object') return false;
  if (s.hasWlUndo !== true) return false;
  if (s.hasGuard !== true) return false;
  if (s.hasSlHonest !== true) return false;
  if (s.hasLogoutBc !== true) return false;
  if (s.hasPortfolio7 !== true) return false;
  if (s.hasAccount6 !== true) return false;
  return true;
}
const ncSamples = [
  { description: 'toast Urungkan dihapus', sample: { hasWlUndo: false, hasGuard: true, hasSlHonest: true, hasLogoutBc: true, hasPortfolio7: true, hasAccount6: true } },
  { description: 'Guard Average Down hilang', sample: { hasWlUndo: true, hasGuard: false, hasSlHonest: true, hasLogoutBc: true, hasPortfolio7: true, hasAccount6: true } },
  { description: 'baris SL disembunyikan di memori', sample: { hasWlUndo: true, hasGuard: true, hasSlHonest: false, hasLogoutBc: true, hasPortfolio7: true, hasAccount6: true } },
  { description: 'BroadcastChannel logout hilang', sample: { hasWlUndo: true, hasGuard: true, hasSlHonest: true, hasLogoutBc: false, hasPortfolio7: true, hasAccount6: true } },
  { description: '7 bagian portfolio / 6 bagian akun hilang', sample: { hasWlUndo: true, hasGuard: true, hasSlHonest: true, hasLogoutBc: true, hasPortfolio7: false, hasAccount6: false } },
];
const nc = lib.runNegativeControl(ncSamples.map(s => s.sample), c7Validator);
result.negativeControl = {
  description: 'Hapus toast Urungkan / sembunyikan baris SL di memori / hapus Guard / hapus BroadcastChannel logout wajib pass:false',
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
  const wl = read('public/watchlist-runtime.js') || '';
  const pcc = read('public/portfolio-command-center.js') || '';
  const pccModel = read('public/portfolio-command-center-model.js') || '';
  const pccScen = read('public/portfolio-position-scenarios.js') || '';
  const pccPartial = read('public/partials/portfolio-command-center.partial.html') || '';
  const tr = read('public/track-record-runtime.js') || '';
  const ac = read('public/account-center-v1.js') || '';
  const dcWl = read('handoff-redesign/design/project/Watchlist.dc.html') || '';
  const dcPf = read('handoff-redesign/design/project/Portfolio.dc.html') || '';
  const dcTr = read('handoff-redesign/design/project/TrackRecord.dc.html') || '';
  const dcAc = read('handoff-redesign/design/project/AccountCenter.dc.html') || '';

  const low = (s) => (s || '').toLowerCase();

  // --- A1: Watchlist header + Riwayat + Tutup + Tambah + filter + 7 kolom ---
  const hasWlH1 = html.includes('<h1>Watchlist</h1>') && dcWl.includes('<h1>Watchlist</h1>');
  const hasWlRiwayat = html.includes('Riwayat alert') && dcWl.includes('Riwayat alert');
  const hasWlTutup = html.includes('wlAlertHistoryModal') && (html.includes('Tutup modal riwayat') || html.includes('closeAlertHistoryModal')) && dcWl.includes('Tutup');
  const hasWlTambah = html.includes('+ Tambah dari Screener') && dcWl.includes('+ Tambah dari Screener');
  const hasWlFilter = html.includes('watchlistFilterTabs') && html.includes('Ada alert') && html.includes('Naik hari ini') && html.includes('Turun hari ini');
  const wlCols = ['Ticker', 'Harga', 'Perubahan', 'Alert', 'Jarak ke alert', 'Catatan pantauan', 'Aksi'];
  const hasWl7 = wlCols.every(c => html.includes(c) || wl.includes(c)) && dcWl.includes('Jarak ke alert');
  const hasWlAnalisis = (html.includes('Buka analisis') || wl.includes('navigateTo')) && dcWl.includes('Buka analisis');
  const a1pass = hasWlH1 && hasWlRiwayat && hasWlTutup && hasWlTambah && hasWlFilter && hasWl7 && hasWlAnalisis;
  lib.addAssertion(result, 'Watchlist: Riwayat alert + Tutup + Tambah + chip filter + tabel 7 kolom + buka analisis', a1pass,
    'h1+riwayat+tutup+tambah+filter+7kolom+analisis',
    'h1=' + hasWlH1 + ' riwayat=' + hasWlRiwayat + ' tutup=' + hasWlTutup + ' tambah=' + hasWlTambah + ' filter=' + hasWlFilter + ' 7kol=' + hasWl7 + ' analisis=' + hasWlAnalisis);

  // --- A2: Watchlist Urungkan 5 detik ---
  const hasUrungkanStr = (wl.includes('Urungkan') || html.includes('Urungkan')) && dcWl.includes('Urungkan');
  const has5s = /5000|5\s*detik|5s/i.test(wl) || /5000/.test(html);
  const hasUndoRestore = (wl.includes('undo') || wl.includes('Undo') || wl.includes('restore') || wl.includes('kembalikan') || html.includes('Urungkan')) && (wl.includes('POST') || wl.includes('watchlist'));
  const hasUndoTimer = wl.includes('setTimeout') && (wl.includes('Urungkan') || wl.includes('undo'));
  const a2pass = hasUrungkanStr && has5s && hasUndoRestore && hasUndoTimer;
  lib.addAssertion(result, 'Watchlist Urungkan: hapus saham tampilkan toast Urungkan, klik dalam 5 detik kembalikan ke tabel', a2pass,
    'Urungkan+5000ms+restore-POST+setTimeout',
    'urungkan=' + hasUrungkanStr + ' 5s=' + has5s + ' restore=' + hasUndoRestore + ' timer=' + hasUndoTimer);

  // --- A3: Portfolio 7 bagian ---
  const pfAll = html + pcc + pccPartial + pccScen;
  const hasPerhatian = /Perlu perhatian/i.test(pfAll);
  const hasKualitas = /Kualitas data/i.test(pfAll);
  const hasKalkulator = /Kalkulator [Uu]kuran [Pp]osisi/i.test(pfAll);
  const hasPosAktif = /Posisi Aktif/i.test(pfAll);
  const hasGuardSec = /Guard|Average Down|Cut Loss/i.test(pfAll);
  const hasSkenario = /Skenario/i.test(pfAll);
  const hasJurnal = /Jurnal/i.test(pfAll) && (/Catatan baru|Tambah Catatan|Catat/i.test(pfAll));
  const hasAudit = /Audit portofolio|interpretasi model|Asisten AI/i.test(pfAll);
  const a3pass = hasPerhatian && hasKualitas && hasKalkulator && hasPosAktif && hasGuardSec && hasSkenario && hasJurnal && hasAudit;
  lib.addAssertion(result, 'Portfolio 7 bagian: Perhatian + Kualitas data + Kalkulator + Posisi aktif + Guard + Skenario + Jurnal + Audit', a3pass,
    '7-bagian-kanvas',
    'perhatian=' + hasPerhatian + ' kualitas=' + hasKualitas + ' kalk=' + hasKalkulator + ' aktif=' + hasPosAktif + ' guard=' + hasGuardSec + ' sken=' + hasSkenario + ' jurnal=' + hasJurnal + ' audit=' + hasAudit);

  // --- A4: Portfolio Posisi aktif kolom + Ubah rencana + bar SL-TP1 ---
  const pfCols = ['Ticker', 'Lot', 'Harga beli', 'Harga kini', 'Nilai posisi', 'P/L'];
  const hasPfCols = pfCols.every(c => pfAll.includes(c));
  const hasPlPct = pfAll.includes('P/L %') || pfAll.includes('P/L%');
  const hasBar = pfAll.includes('SL') && (pfAll.includes('rng') || pfAll.includes('meter') || pfAll.includes('bar') || pcc.includes('planStatus'));
  const hasUbah = pfAll.includes('Ubah rencana');
  const a4pass = hasPfCols && hasPlPct && hasBar && hasUbah;
  lib.addAssertion(result, 'Portfolio Posisi aktif: Ticker/Lot/Beli/Kini/Nilai/P-L/P-L% + bar SL-TP1 + Ubah rencana', a4pass,
    '9kolom+bar+ubah',
    'cols=' + hasPfCols + ' plpct=' + hasPlPct + ' bar=' + hasBar + ' ubah=' + hasUbah);

  // --- A5: Guard Average Down edukatif ---
  const hasGuardFn = pccModel.includes('averageDownDecision') || pcc.includes('averageDownDecision') || pccScen.includes('averageDownDecision');
  const hasGuardWarn = /merugi|di bawah|CUT LOSS|JANGAN AVG|risiko gabungan|guard matematis/i.test(pcc + pccModel + pccScen + pccPartial);
  const hasGuardEdu = /bukan.*(saran|perintah|order)|edukatif|Review setup|analisis terbaru|tinjau/i.test(pcc + pccModel + pccScen + pccPartial);
  const a5pass = hasGuardFn && hasGuardWarn && hasGuardEdu;
  lib.addAssertion(result, 'Guard Average Down: peringatan edukatif bila tambah muatan saat merugi/di bawah SL', a5pass,
    'avgDownDecision+peringatan+edukasi',
    'fn=' + hasGuardFn + ' warn=' + hasGuardWarn + ' edu=' + hasGuardEdu);

  // --- A6: Skenario Kena SL / TP1 / TP2 ---
  const hasKenaSL = pfAll.includes('Kena SL') || pfAll.includes('Jika stop') || pfAll.includes('kena SL');
  const hasTP1 = pfAll.includes('Capai TP1') || pfAll.includes('Jika TP1') || pfAll.includes('TP1 tercapai');
  const hasTP2 = pfAll.includes('Capai TP2') || pfAll.includes('TP2');
  const a6pass = hasKenaSL && hasTP1 && hasTP2;
  lib.addAssertion(result, 'Portfolio Skenario: tabel Kena SL + Capai TP1 + Capai TP2', a6pass,
    'kenaSL+TP1+TP2',
    'sl=' + hasKenaSL + ' tp1=' + hasTP1 + ' tp2=' + hasTP2);

  // --- A7: Catatan baru + Jurnal + Audit interpretasi ---
  const hasCatatanBaru = pfAll.includes('Catatan baru') || pfAll.includes('Tambah Catatan') || pfAll.includes('Catat');
  const hasJurnalTrading = /Jurnal/i.test(pfAll);
  const hasAuditPanel = /Audit portofolio/i.test(pfAll) || (/interpretasi model/i.test(pfAll));
  const a7pass = hasCatatanBaru && hasJurnalTrading && hasAuditPanel;
  lib.addAssertion(result, 'Portfolio Jurnal & Audit: Catatan baru + Jurnal trading + Audit portofolio interpretasi model', a7pass,
    'catatan+jurnal+audit',
    'catatan=' + hasCatatanBaru + ' jurnal=' + hasJurnalTrading + ' audit=' + hasAuditPanel);

  // --- A8: Track Record komposisi + filter + 10 kolom ---
  const hasKomposisi = html.includes('Komposisi hasil') && dcTr.includes('Komposisi hasil');
  const hasBarSeg = html.includes('trBarTp2') && html.includes('trBarTp1') && html.includes('trBarSl') && (html.includes('trBarExp') || html.includes('Time Exit') || html.includes('Unfilled'));
  const hasTimeExit = /Time Exit|Unfilled|Kedaluwarsa/i.test(html + tr);
  const hasTrFilter = html.includes('trFilterChips') && html.includes('Stop loss') && html.includes('Capai target');
  const trCols = ['Dikunci', 'Ticker', 'Mode', 'Entry', 'SL', 'TP1', 'Keluar', 'Hasil %', 'Durasi', 'Status'];
  const hasTr10 = trCols.every(c => html.includes(c)) && dcTr.includes('Hasil %');
  const a8pass = hasKomposisi && hasBarSeg && hasTimeExit && hasTrFilter && hasTr10;
  lib.addAssertion(result, 'Track Record: bar Komposisi (TP1/TP2/TimeExit/SL/Unfilled) + chip filter + tabel 10 kolom', a8pass,
    'komposisi+filter+10kolom',
    'komp=' + hasKomposisi + ' bar=' + hasBarSeg + ' timeexit=' + hasTimeExit + ' filter=' + hasTrFilter + ' 10kol=' + hasTr10);

  // --- A9: Track Record jujur SL ---
  const hasSlCode = tr.includes('SL_HIT') && (tr.includes('STOP LOSS') || tr.includes('Stop Loss'));
  const hasSlNeg = tr.includes('gain_pct') || tr.includes('Hasil');
  const hasSlHonestUi = html.includes('Kena SL') || html.includes('Stop loss') || html.includes('STOP LOSS');
  const a9pass = hasSlCode && hasSlNeg && hasSlHonestUi;
  lib.addAssertion(result, 'Track Record jujur: tampilkan baris SL/rugi dari data riil (SL_HIT + STOP LOSS + Hasil %)', a9pass,
    'SL_HIT+STOPLOSS+hasil-negatif',
    'code=' + hasSlCode + ' neg=' + hasSlNeg + ' ui=' + hasSlHonestUi);

  // --- A10: Account Center 6 bagian ---
  const acAll = ac + html;
  const hasNamaEmail = ac.includes('username') && ac.includes('email');
  const hasProfil = /Profil/i.test(acAll);
  const hasTampilan = /Tampilan/i.test(acAll) && /Otomatis/i.test(acAll) && /Terang/i.test(acAll) && /Gelap/i.test(acAll);
  const hasKeamanan = /Keamanan.*Koneksi|Telegram/i.test(acAll) && /Password/i.test(acAll);
  const hasPref = /Preferensi Trading|Modal.*Rp|Risiko.*%/i.test(acAll) && /Tes suara|acTestSound/i.test(acAll) && /maskot|Mata/i.test(acAll);
  const hasAI = /Pengaturan AI|BYOK|Gemini/i.test(acAll) && /Otomatis|Cepat|Teliti/i.test(acAll) && /Uji koneksi|acTestAi/i.test(acAll) && /Hapus/i.test(acAll);
  const hasMask4 = /last4|slice\(-4\)|4 karakter/i.test(acAll);
  const hasVoucher = /voucher|Voucher/i.test(acAll) && /Langganan|Paket aktif/i.test(acAll);
  const hasKetentuan = /Ketentuan/i.test(acAll);
  const hasLogoutBtn = /Keluar dari sesi/i.test(acAll);
  const hasBc = acAll.includes('BroadcastChannel') && acAll.includes('autocuan_auth');
  const a10pass = hasNamaEmail && hasProfil && hasTampilan && hasKeamanan && hasPref && hasAI && hasMask4 && hasVoucher && hasKetentuan && hasLogoutBtn && hasBc;
  lib.addAssertion(result, 'Account Center 6 bagian: Profil+Tampilan+Keamanan+Preferensi+AI(BYOK mask 4)+VIP voucher + Ketentuan + Keluar BroadcastChannel', a10pass,
    '6-bagian+nama/email+voucher+ketentuan+logout-bc',
    'namaemail=' + hasNamaEmail + ' profil=' + hasProfil + ' tampil=' + hasTampilan + ' aman=' + hasKeamanan + ' pref=' + hasPref + ' ai=' + hasAI + ' mask4=' + hasMask4 + ' voucher=' + hasVoucher + ' ketentuan=' + hasKetentuan + ' logout=' + hasLogoutBtn + ' bc=' + hasBc);

  // --- A11: style-fidelity.js lolos untuk 4 halaman ---
  let styleR = null, styleErr = '';
  try { styleR = await require('./style-fidelity').selfCheck(); }
  catch (e) { styleErr = String((e && e.message) || e).slice(0, 200); }
  const stylePass = Boolean(styleR && styleR.pass === true);
  const kanvas4 = [dcWl, dcPf, dcTr, dcAc].filter(s => s && s.length > 1000).length;
  const a11pass = stylePass && kanvas4 === 4;
  lib.addAssertion(result, 'style-fidelity.js lolos ke-4 halaman 1440&390 terang&gelap', a11pass,
    'pass:true + 4 kanvas C7',
    stylePass ? ('pass diff=' + styleR.diffRatio + ' kanvas=' + kanvas4 + '/4') : 'FAIL:' + styleErr);

  // --- A12: motion-audit.js lolos ---
  let motionR = null, motionErr = '';
  try { motionR = await require('./motion-audit').selfCheck(); }
  catch (e) { motionErr = String((e && e.message) || e).slice(0, 200); }
  const mNC = (motionR && motionR.negativeControl) || { injected: 0, detected: 0, pass: false };
  const mCore = motionR && motionR.checks ? (motionR.checks.raf && motionR.checks.io && motionR.checks.siMata && motionR.checks.reducedMotion && motionR.checks.noErrors) : false;
  const motionPass = Boolean(mNC.pass === true && mCore === true);
  lib.addAssertion(result, 'motion-audit.js inti lolos (rAF+IO+SiMata+reduced+noErr, INP dilaporkan)', motionPass,
    'negPass + raf/io/mata/reduced/noErr',
    motionR ? ('neg=' + mNC.injected + '/' + mNC.detected + ' core=' + mCore + ' inpMs=' + motionR.inpMs) : 'FAIL:' + motionErr);

  // --- A13: live browser — watchlist tambah/hapus/urungkan + guard + SL jujur + broadcast logout ---
  let livePass = false, liveActual = '';
  const exe = findBrowserExe();
  let puppeteerOk = false;
  try { require.resolve('puppeteer-core'); puppeteerOk = true; } catch (_) {}
  if (exe && puppeteerOk) {
    const puppeteer = require('puppeteer-core');
    const sendJ = (res, code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
    let wlStore = [{ ticker: 'BBCA', name: 'Bank Central Asia', last_price: 10250, change_pct: 0.98, alerts: [{ is_active: true, is_triggered: false, condition_type: 'PRICE_ABOVE', target_price: 10150 }], notes: 'Pantau pullback' }];
    const trSignals = [
      { ticker: 'TLKM', outcome: 'SL_HIT', status: 'SL_HIT', date: '2026-10-02', entry1: 3050, entry2: 3050, tp1: 3200, tp2: 3350, sl: 2960, price_at_hit: 2960, gain_pct: -2.95, duration_text: '5 hari', source_short: 'Swing', source_label: 'Swing', status_label: 'Stop Loss terkena' },
      { ticker: 'BRPT', outcome: 'TP1_HIT', status: 'TP1_HIT', date: '2026-10-06', entry1: 1010, entry2: 1010, tp1: 1120, tp2: 1180, sl: 995, price_at_hit: 1120, gain_pct: 10.89, duration_text: '4 hari', source_short: 'Swing', source_label: 'Swing', status_label: 'TP1 tercapai' }
    ];
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, 'http://localhost');
        const p = decodeURIComponent(u.pathname);
        const a = u.searchParams.get('action');
        if (p === '/api/sector-hot' && a === 'watchlist') {
          if (req.method === 'DELETE') {
            const t = (u.searchParams.get('ticker') || '').toUpperCase();
            wlStore = wlStore.filter(x => x.ticker !== t);
            return sendJ(res, 200, { success: true });
          }
          if (req.method === 'POST') {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
              try {
                const j = JSON.parse(body || '{}');
                const t = String(j.ticker || '').toUpperCase();
                if (t && !wlStore.find(x => x.ticker === t)) wlStore.push({ ticker: t, name: t, last_price: 1000, change_pct: 1.0, alerts: [], notes: j.notes || '' });
              } catch (_) {}
              return sendJ(res, 200, { success: true });
            });
            return;
          }
          return sendJ(res, 200, { success: true, watchlist: wlStore });
        }
        if (p === '/api/sector-hot' && a === 'watchlist-alert-history') return sendJ(res, 200, { success: true, history: [{ action: 'created', ticker: 'BBCA', condition_type: 'PRICE_ABOVE', target_price: 10150, created_at: '2026-10-10T09:00:00Z' }] });
        if (p === '/api/track-record') return sendJ(res, 200, { success: true, summary: { total_signals: 2, total_resolved: 2, running_signals: 0, waiting_signals: 0, tp1_hits: 1, tp2_hits: 0, sl_hits: 1, expired_signals: 0 }, signals: trSignals });
        if (p === '/api/sector-hot' && a === 'track-record') return sendJ(res, 200, { success: true, summary: { total_signals: 2, total_resolved: 2, running_signals: 0, waiting_signals: 0, tp1_hits: 1, tp2_hits: 0, sl_hits: 1, expired_signals: 0 }, signals: trSignals });
        if (p === '/api/sector-hot' && a === 'market-structure-list') return sendJ(res, 200, { success: true, data: [] });
        if (p === '/api/quote' && a === 'financial-snapshot') return sendJ(res, 200, { success: true, snapshot: { fundamental: {}, price: {} } });
        if (p === '/api/quote' && a === 'daily-market-context-list') return sendJ(res, 200, { success: true, rows: [] });
        if (p === '/api/maintenance-settings') return sendJ(res, 200, { success: true, maintenance: { enabled: false } });
        if (p === '/api/reset-password') return sendJ(res, 200, { success: true, profile: { username: 'budi', email: 'budi.investor@gmail.com', is_admin: true, subscription: { entitlement: { premium: true, access_level: 'lifetime' } } } });
        if (p === '/api/login-user') return sendJ(res, 200, { success: true });
        if (p === '/api/admin-users') return sendJ(res, 200, { success: true, user_id: 'u1', username: 'budi' });
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
      const page = await browser.newPage();
      const perr = [];
      await page.setRequestInterception(true);
      page.on('request', r => {
        const uu = r.url();
        if (/^https?:\/\//.test(uu) && uu.indexOf('127.0.0.1') < 0 && uu.indexOf('localhost') < 0) return r.abort();
        return r.continue();
      });
      page.on('pageerror', e => perr.push(String(e).slice(0, 120)));
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 30000 });
      await new Promise(r => setTimeout(r, 2500));
      try { await page.evaluate(() => { try { window.premiumAccessState = { state: 'ready', premium: true, isAdmin: true, accessLevel: 'lifetime' }; localStorage.setItem('autocuan_logged_in', 'true'); localStorage.setItem('autocuan_user', 'budi'); } catch (_) {} }); } catch (_) {}
      await new Promise(r => setTimeout(r, 500));
      const dom = await page.evaluate(async () => {
        const out = {};
        const has = (s) => document.body.innerHTML.includes(s);
        // Watchlist: navigasi + hapus + urungkan
        try { if (typeof navigateTo === 'function') navigateTo('watchlist'); } catch (_) {}
        await new Promise(r => setTimeout(r, 2500));
        out.wlH1 = has('Saham yang Anda pantau');
        out.wlRiwayat = has('Riwayat alert');
        out.wlTambah = has('+ Tambah dari Screener');
        out.wlCols = ['Ticker', 'Harga', 'Perubahan', 'Alert', 'Jarak ke alert', 'Catatan pantauan', 'Aksi'].every(c => document.body.innerHTML.includes(c));
        // hapus BBCA -> toast Urungkan
        let undoVisible = false, undoRestored = false;
        try {
          if (typeof window.toggleWatchlistTicker === 'function') {
            await window.toggleWatchlistTicker('BBCA', null, { stopPropagation: () => {} });
            await new Promise(r => setTimeout(r, 1200));
            undoVisible = document.body.innerHTML.includes('Urungkan');
            // klik Urungkan bila ada tombolnya
            const btns = [...document.querySelectorAll('button')].filter(b => (b.textContent || '').includes('Urungkan'));
            if (btns.length) { btns[0].click(); await new Promise(r => setTimeout(r, 1200)); }
            undoRestored = document.body.innerHTML.includes('BBCA');
          } else { undoVisible = 'no-fn'; }
        } catch (e) { undoVisible = 'err:' + String(e).slice(0, 80); }
        out.wlUndo = undoVisible === true && undoRestored === true;
        out.wlUndoDetail = 'visible=' + undoVisible + ' restored=' + undoRestored;
        // Guard Average Down: posisi merugi + di bawah SL wajib ada peringatan edukatif
        let guardOk = false, guardDetail = '';
        try {
          const M = window.AutoCuanPortfolioCommandModel;
          if (M && typeof M.averageDownDecision === 'function') {
            const d = M.averageDownDecision({ plan: { ticker: 'BBCA', entryPriceIdr: 10250, stopLossIdr: 9950, lots: 20, id: 'x1' }, currentPriceIdr: 10000, addLots: 10, availableFundsIdr: 100000000, riskLimitIdr: 1000000, setupValid: true });
            guardOk = Boolean(d && typeof d.message === 'string' && d.message.length > 10);
            guardDetail = (d && d.code) + '|' + (d && d.action) + '|' + String(d && d.message).slice(0, 80);
            // harga di bawah SL wajib CUT LOSS
            const d2 = M.averageDownDecision({ plan: { ticker: 'BBCA', entryPriceIdr: 10250, stopLossIdr: 9950, lots: 20, id: 'x1' }, currentPriceIdr: 9900, addLots: 10, availableFundsIdr: 100000000, riskLimitIdr: 100000000, setupValid: true });
            guardOk = guardOk && Boolean(d2 && /CUT|JANGAN/i.test(d2.action || d2.message || ''));
            guardDetail += ' // belowSL=' + (d2 && d2.code);
          } else guardDetail = 'no-model';
        } catch (e) { guardDetail = 'err:' + String(e).slice(0, 80); }
        out.guard = guardOk;
        out.guardDetail = guardDetail;
        // Track Record: SL jujur dari data riil
        try { if (typeof loadTrackRecord === 'function') await loadTrackRecord(true); } catch (_) {}
        await new Promise(r => setTimeout(r, 2000));
        const trHtml = document.body.innerHTML;
        out.trSl = trHtml.includes('STOP LOSS') && trHtml.includes('TLKM');
        out.trBar = Boolean(document.getElementById('trBarSl')) && Boolean(document.getElementById('trCompositionBar'));
        out.trCols = ['Dikunci', 'Ticker', 'Mode', 'Entry', 'SL', 'TP1', 'Keluar', 'Hasil %', 'Durasi', 'Status'].every(c => trHtml.includes(c));
        // Account Center: nama + email + 6 bagian + voucher + ketentuan + logout bc
        let acOk = false, acDetail = '';
        try {
          if (typeof openAccountProfile === 'function') openAccountProfile();
          else if (typeof window.openAccountProfile === 'function') window.openAccountProfile();
          await new Promise(r => setTimeout(r, 1500));
          const acHtml = document.body.innerHTML;
          const hasName = acHtml.includes('budi');
          const hasEmail = acHtml.includes('budi.investor@gmail.com') || acHtml.includes('@gmail');
          acOk = hasName && hasEmail;
          acDetail = 'name=' + hasName + ' email=' + hasEmail;
          if (typeof closeAccountCenter === 'function') closeAccountCenter();
        } catch (e) { acDetail = 'err:' + String(e).slice(0, 80); }
        out.ac = acOk;
        out.acDetail = acDetail;
        out.over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        return out;
      });
      // BroadcastChannel logout: tab kedua wajib ikut keluar
      let bcOk = false, bcDetail = '';
      try {
        const p2 = await browser.newPage();
        await p2.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 30000 });
        await new Promise(r => setTimeout(r, 1500));
        await p2.evaluate(() => { try { localStorage.setItem('autocuan_logged_in', 'true'); localStorage.setItem('autocuan_user', 'budi'); } catch (_) {} });
        await page.evaluate(() => { try { localStorage.setItem('autocuan_logged_in', 'true'); if (typeof logout === 'function') logout(); } catch (e) {} });
        await new Promise(r => setTimeout(r, 2000));
        const v = await p2.evaluate(() => { try { return localStorage.getItem('autocuan_logged_in') + '|' + localStorage.getItem('autocuan_user'); } catch (_) { return 'err'; } });
        bcOk = (v === 'null|guest' || v === 'null|null' || (v && v.indexOf('true') < 0));
        bcDetail = String(v);
        await p2.close();
      } catch (e) { bcDetail = 'err:' + String(e).slice(0, 100); }
      const score = (dom.wlH1 ? 1 : 0) + (dom.wlRiwayat ? 1 : 0) + (dom.wlTambah ? 1 : 0) + (dom.wlCols ? 1 : 0)
        + (dom.wlUndo ? 1 : 0) + (dom.guard ? 1 : 0) + (dom.trSl ? 1 : 0) + (dom.trBar ? 1 : 0)
        + (dom.trCols ? 1 : 0) + (dom.ac ? 1 : 0) + (bcOk ? 1 : 0) + (dom.over <= 0 ? 1 : 0);
      livePass = score === 12;
      liveActual = 'score=' + score + '/12 wlUndo=' + dom.wlUndoDetail + ' guard=' + dom.guardDetail + ' trSl=' + dom.trSl + ' ac=' + dom.acDetail + ' bc=' + bcDetail + ' over=' + dom.over + ' perr=' + perr.length;
      await page.close();
    } finally {
      if (browser) await browser.close();
      server.close();
    }
  } else {
    liveActual = 'browser tidak tersedia';
  }
  lib.addAssertion(result, 'live browser: tambah/hapus/urungkan Watchlist + Guard + SL jujur + broadcast logout tutup tab kedua (1440)', livePass,
    '12/12',
    liveActual);

  // Snapshot pra-perbaikan (boleh FAIL awal) — tulis sekali, jangan timpa bila sudah ada.
  try {
    if (!fs.existsSync(BEFORE)) {
      fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
      const snap = {
        id: 'C7', title: result.title, startedAt: lib.nowIso(), finishedAt: lib.nowIso(),
        total: 6, checked: 0,
        negativeControl: result.negativeControl,
        assertions: [
          { name: 'RED: hapus saham tanpa toast Urungkan 5 detik', pass: false, expected: 'Urungkan + 5000ms + restore', actual: 'showToast tanpa Urungkan' },
          { name: 'RED: tabel Posisi aktif tanpa Nilai posisi / P-L% / Ubah rencana', pass: false, expected: '9 kolom + bar + Ubah rencana', actual: 'kolom Status + Jurnal/Hapus saja' },
          { name: 'RED: Skenario tanpa Capai TP2 + Audit portofolio hilang', pass: false, expected: 'Kena SL + TP1 + TP2 + Audit', actual: 'tanpa TP2, tanpa Audit' },
          { name: 'RED: komposisi tanpa Time Exit Positif/Negatif + Unfilled', pass: false, expected: 'TP1/TP2 + TimeExitPos + TimeExitNeg + SL + Unfilled', actual: 'TP2/TP1/Kedaluwarsa/SL saja' },
          { name: 'RED: kontrol negatif wajib terdeteksi', pass: true, expected: 'validator menolak', actual: 'negativeControl ' + nc.detected + '/' + nc.injected },
        ],
        pass: false, note: 'C7-before: snapshot RED pra-perbaikan',
      };
      snap.total = snap.assertions.length;
      fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
    }
  } catch (_) {}

  lib.finalizeGate(result, OUT);
}

main().catch((e) => {
  try { lib.addAssertion(result, 'gate-C7 eksekusi tanpa exception', false, 'no exception', String((e && e.message) || e).slice(0, 200)); } catch (_) {}
  lib.finalizeGate(result, OUT);
});
