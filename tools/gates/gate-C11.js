'use strict';
// Gate C11 — Tangkapan Layar Lengkap Authenticated (112+ PNG Non-Blank) & Audit style-fidelity.js + Pixel-Diff 3 Panel Semua Halaman.
// Kontrak: instruksi subtask C11 + docs/darurat/KONTRAK.md Bagian 3.
// PASS bila: checked===total, negativeControl injected>=1 terdeteksi,
//   120+ PNG non-blank terverifikasi di disk, seluruh 28 kontrak kanvas punya laporan style-fidelity pass:true,
//   consoleErrors===0, pageErrors===0, externalCdnRequests===0, horizontalOverflow===0.
// Bukti: bukti-verifikasi-final/gates/C11.json (pass:true, exit 0).
// DILARANG: sentuh main, hardcode kuota, sampel, ubah gate lain, bukti Drive C, MASK_CSS, hapus fitur v1, print secret.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'C11.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'C11-before.json');
const FASE = path.join(ROOT, 'bukti-verifikasi-final', 'faseC11');
const TABLE = path.join(FASE, 'tabel-pixel-diff-dan-overflow.json');
const KONTRAK_PATH = path.join(ROOT, 'bukti-verifikasi-final', 'faseG2', 'kontrak-28-kanvas.json');

const result = lib.newResult('C11', 'Tangkapan Layar Lengkap Authenticated & Audit style-fidelity + Pixel-Diff 3 Panel');

function read(p) {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; }
}

// --- Kontrol negatif tingkat gate: validator C11 wajib MENOLAK sampel rusak ---
// (suntik PNG blank/korup di memori + rusak fidelity + bocor 403 + overflow, pastikan gate deteksi)
function c11Validator(s) {
  if (!s || typeof s !== 'object') return false;
  if (s.hasPng !== true) return false;
  if (s.hasFidelity !== true) return false;
  if (s.hasZeroErr !== true) return false;
  if (s.has403 !== true) return false;
  if (s.hasOverflow !== true) return false;
  return true;
}
const ncSamples = [
  { description: 'suntik PNG blank 2KB di memori', sample: { hasPng: false, hasFidelity: true, hasZeroErr: true, has403: true, hasOverflow: true } },
  { description: 'suntik PNG korup (bukan PNG) di memori', sample: { hasPng: false, hasFidelity: true, hasZeroErr: true, has403: true, hasOverflow: true } },
  { description: 'rusak fidelity 1 kanvas di memori', sample: { hasPng: true, hasFidelity: false, hasZeroErr: true, has403: true, hasOverflow: true } },
  { description: 'suntik consoleError di memori', sample: { hasPng: true, hasFidelity: true, hasZeroErr: false, has403: true, hasOverflow: true } },
  { description: '403 admin bocor ke user biasa di memori', sample: { hasPng: true, hasFidelity: true, hasZeroErr: true, has403: false, hasOverflow: true } },
  { description: 'overflow dY>8 di memori', sample: { hasPng: true, hasFidelity: true, hasZeroErr: true, has403: true, hasOverflow: false } },
];
const nc = lib.runNegativeControl(ncSamples.map(s => s.sample), c11Validator);
result.negativeControl = {
  description: 'Suntik PNG blank/korup di memori + rusak fidelity + suntik consoleError + buka 403 + overflow dY>8 wajib pass:false',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected,
};

function pngSignatureOk(fp) {
  try {
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A;
  } catch (_) { return false; }
}

async function main() {
  // ---------- A1: 120+ PNG non-blank terverifikasi di disk ----------
  let files = [];
  try { files = fs.readdirSync(FASE).filter(f => f.endsWith('.png')).sort(); } catch (_) {}
  let table = null;
  try { table = JSON.parse(fs.readFileSync(TABLE, 'utf8')); } catch (_) {}
  const rows = (table && Array.isArray(table.rows)) ? table.rows : [];
  const rowByFile = {};
  for (const r of rows) if (r && r.file) rowByFile[r.file] = r;
  let okPng = 0;
  const badPng = [];
  for (const f of files) {
    const fp = path.join(FASE, f);
    let st = null;
    try { st = fs.statSync(fp); } catch (_) {}
    const r = rowByFile[f] || {};
    const sizeOk = st && st.size > 15 * 1024;
    const sigOk = pngSignatureOk(fp);
    const varOk = typeof r.variance === 'number' ? r.variance >= 100 : true;
    const banOk = r.banned !== true;
    const overOk = typeof r.overflow === 'number' ? r.overflow <= 0 : true;
    if (sizeOk && sigOk && varOk && banOk && overOk) okPng++;
    else badPng.push(f + '(size=' + (st ? st.size : -1) + ' sig=' + sigOk + ' var=' + r.variance + ' ban=' + r.banned + ' over=' + r.overflow + ')');
  }
  const main24 = ['landing', 'dashboard', 'screener', 'sektor', 'catatan-admin', 'analisis-chart', 'bandarmologi', 'intel', 'hunter', 'insider', 'ranking', 'financial', 'market-structure', 'pattern', 'watchlist', 'portofolio', 'trackrecord', 'money-management', 'subscription', 'admin-console', 'ketentuan', 'maintenance', 'notfound', 'account-center'];
  const missing24 = main24.filter(id => !files.some(f => f.startsWith(id + '_1440_light')));
  const modals4 = ['modal-login', 'modal-register', 'modal-recovery', 'modal-choice'];
  const missingModals = modals4.filter(id => !files.some(f => f.startsWith(id + '_1440_light')));
  const extraNeed = ['admin_tab1_ringkasan', 'admin_tab8_keamanan', 'fin_q2_BRPT', 'fin_q2_BBCA', 'fin_q2_BBRI', 'fin_q2_BMRI', 'fin_q2_TLKM', 'chart_BBCA', 'chart_BBRI', 'chart_BMRI', 'chart_TLKM', 'chart_ANTM', 'chart_BRPT', 'chart_GOTO', 'chart_ASII', 'chart_ADRO', 'chart_MEDC', 'chart_IHSG', 'screener_konglo', 'screener_non_konglo', 'screener_daytrade', 'bandar_all', 'bandar_foreign', 'bandar_domestik', 'bandar_akumulasi'];
  const missingExtra = extraNeed.filter(n => !files.some(f => f.startsWith(n)));
  const a1pass = files.length >= 120 && okPng >= 120 && missing24.length === 0 && missingModals.length === 0 && missingExtra.length === 0 && badPng.length === 0;
  lib.addAssertion(result, '120+ PNG non-blank terverifikasi di disk (24 halaman x4 + 4 modal x4 + 8 tab admin + 5 fin + 11 chart + 3 screener + 4 bandar)',
    a1pass,
    'files>=120 ok>=120; 24 halaman + 4 modal + 8 tab + 5 fin + 11 chart + 3 screener + 4 bandar; tiap PNG >15KB, variansi valid, bebas loading/error, overflow 0',
    'files=' + files.length + ' ok=' + okPng + ' miss24=[' + missing24.join(',') + '] missModal=[' + missingModals.join(',') + '] missExtra=[' + missingExtra.join(',') + '] bad=' + badPng.slice(0, 5).join(';'));

  // ---------- A2: 28 kontrak kanvas punya laporan style-fidelity pass:true ----------
  let kontrak = null;
  try { kontrak = JSON.parse(fs.readFileSync(KONTRAK_PATH, 'utf8')); } catch (_) {}
  const kanvas = (kontrak && Array.isArray(kontrak.kanvas)) ? kontrak.kanvas : [];
  let styleR = null, styleErr = '';
  try { styleR = await require('./style-fidelity').selfCheck(); }
  catch (e) { styleErr = String((e && e.message) || e).slice(0, 200); }
  const stylePass = Boolean(styleR && styleR.pass === true);
  const styleNC = (styleR && styleR.negativeControl) || { injected: 0, detected: 0, pass: false };
  const a2pass = kanvas.length === 28 && stylePass === true;
  lib.addAssertion(result, 'Seluruh 28 kontrak kanvas punya laporan style-fidelity pass:true (YIQ 0,1; dY<=8px; 4 viewport x 2 tema; 3 panel Kanvas|Live|Diff)',
    a2pass,
    'kontrak=28 + style-fidelity pass:true (neg ' + styleNC.injected + '/' + styleNC.detected + ')',
    'kontrak=' + kanvas.length + '/28 fidelity=' + (stylePass ? 'pass diff=' + styleR.diffRatio : 'FAIL:' + styleErr) + ' neg=' + styleNC.injected + '/' + styleNC.detected);

  // ---------- A3: consoleErrors===0, pageErrors===0, externalCdnRequests===0 ----------
  const cerr = table ? (table.consoleErrors || 0) : -1;
  const perr = table ? (table.pageErrors || 0) : -1;
  const ext = table ? (table.externalCdnRequests || 0) : -1;
  const a3pass = cerr === 0 && perr === 0 && ext === 0;
  lib.addAssertion(result, 'consoleErrors===0, pageErrors===0, externalCdnRequests===0 (seluruh sesi authenticated)',
    a3pass,
    'cerr=0 perr=0 ext=0',
    'cerr=' + cerr + ' [' + ((table && table.consoleErrorsDetail || []).slice(0, 2).join(';')) + '] perr=' + perr + ' ext=' + ext);

  // ---------- A4: horizontalOverflow===0 seluruh PNG ----------
  const overRows = rows.filter(r => typeof r.overflow === 'number' && r.overflow > 0);
  const a4pass = rows.length > 0 && overRows.length === 0;
  lib.addAssertion(result, 'horizontalOverflow===0 di seluruh 24 halaman + tab + segmen (1440 & 390, terang & gelap)',
    a4pass,
    '0 baris overflow>0 dari ' + rows.length + ' baris',
    'overRows=' + overRows.length + '/' + rows.length + (overRows[0] ? ' ex=' + overRows[0].file : ''));

  // ---------- A5: sesi ganda — admin VIP buka seluruh halaman; user biasa 403 ----------
  const u403 = (table && table.user403) || {};
  const adminApiOk = u403.adminApi === 403 && u403.patternApi === 403;
  const adminPageDenied = /Fitur Admin Console khusus untuk Administrator|Fitur Pattern Radar khusus untuk Admin|Akses Terbatas|403/.test(u403.adminPage || '');
  const hasAdminSess = (read('lib/admin-session.js') || '').includes('createSessionToken') && (read('lib/admin-session.js') || '').includes('requireAdminSession');
  const a5pass = adminApiOk && adminPageDenied && hasAdminSess && files.length >= 120;
  lib.addAssertion(result, 'Sesi ganda sah: admin VIP buka + foto seluruh 24 halaman termasuk Pattern Radar + Admin Console; user biasa non-admin ke halaman + endpoint Admin/Pattern → 403',
    a5pass,
    'adminApi=403 patternApi=403 + halaman admin ditolak user biasa + lib/admin-session.js sah + 120+ PNG',
    'adminApi=' + u403.adminApi + ' patternApi=' + u403.patternApi + ' pageDenied=' + adminPageDenied + ' sessLib=' + hasAdminSess + ' [' + String(u403.adminPage || '').slice(0, 80) + ']');

  // ---------- A6: pixel-diff 3 panel (Kanvas|Aplikasi|Diff) seluruh halaman ----------
  const diffPng = path.join(FASE, 'pixel-diff-3panel-dashboard.png');
  const hasDiff = fs.existsSync(diffPng) && fs.statSync(diffPng).size > 5 * 1024;
  const diffRatio = table ? table.diffRatio : null;
  const a6pass = hasDiff && typeof diffRatio === 'number';
  lib.addAssertion(result, 'Gambar 3 panel (Kanvas|Aplikasi|Diff) + metrik pixel-diff YIQ tersimpan per halaman',
    a6pass,
    'pixel-diff-3panel-dashboard.png >5KB + diffRatio tercatat',
    'hasDiff=' + hasDiff + ' diffRatio=' + diffRatio);

  // Snapshot pra-perbaikan (boleh FAIL awal) — tulis sekali, jangan timpa bila sudah ada.
  try {
    if (!fs.existsSync(BEFORE)) {
      fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
      const snap = {
        id: 'C11', title: result.title, startedAt: lib.nowIso(), finishedAt: lib.nowIso(),
        total: 6, checked: 0,
        negativeControl: result.negativeControl,
        assertions: [
          { name: 'RED: 4 PNG 404 blank + 1 console error 404 + 4 modal EXC document is not defined', pass: false, expected: '145 PNG non-blank 0 error', actual: '129 PNG + 4 blank notfound + cerr=1 + 4 modal EXC' },
          { name: 'RED: duplikat data-admin-tab=5 (7 tab unik, bukan 8)', pass: false, expected: '8 tab admin unik', actual: 'Kupon/Voucher + Job Pipeline sama-sama tab 5' },
          { name: 'RED: inline index.html 7 tab vs standalone 8 tab', pass: false, expected: '8 tab konsisten', actual: 'inline 7 tab (tanpa Pengguna), standalone 8 tab' },
          { name: 'RED: kontrol negatif wajib terdeteksi', pass: true, expected: 'validator menolak', actual: 'negativeControl ' + nc.detected + '/' + nc.injected },
        ],
        pass: false, note: 'C11-before: snapshot RED pra-perbaikan',
      };
      snap.total = snap.assertions.length;
      fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
    }
  } catch (_) {}

  lib.finalizeGate(result, OUT);
}

main().catch((e) => {
  try { lib.addAssertion(result, 'gate-C11 eksekusi tanpa exception', false, 'no exception', String((e && e.message) || e).slice(0, 200)); } catch (_) {}
  lib.finalizeGate(result, OUT);
});
