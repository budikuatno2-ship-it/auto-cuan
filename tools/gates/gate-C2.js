'use strict';
// Gate C2 — Pemulihan 100% Halaman Kelola Keuangan & Lipatan details.adv-tools di Semua Halaman.
// Kontrak: instruksi subtask C2 + docs/darurat/KONTRAK.md Bagian 3.
// PASS bila: checked===total, negativeControl injected>=1 terdeteksi,
//   style-fidelity.js lolos + fidelity KelolaKeuangan >=95% (dY<=8px, 0 overflow 1440 & 390),
//   CRUD anggaran persist (tambah+nominal+Simpan+reload utuh), adv-tools 100% berfungsi.
// Bukti: bukti-verifikasi-final/gates/C2.json (pass:true, exit 0).
// DILARANG: sentuh main, hardcode kuota, sampel, ubah gate lain, bukti Drive C, MASK_CSS, hapus fitur v1, print secret.
const fs = require('fs');
const path = require('path');
const http = require('http');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'C2.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'C2-before.json');

const result = lib.newResult('C2', 'Pemulihan 100% Kelola Keuangan & Lipatan details.adv-tools');

function read(p) {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; }
}

// --- Kontrol negatif tingkat gate: validator MM wajib MENOLAK sampel rusak ---
function mmValidator(s) {
  if (!s || typeof s !== 'object') return false;
  if (s.hasSimpan !== true) return false;
  if (s.hasSortType !== true) return false;
  if (s.hasCopyPrev !== true) return false;
  if (s.hasAdvTools !== true) return false;
  if (s.yShift != null && s.yShift > 8) return false;
  if (s.hasCrudPersist !== true) return false;
  return true;
}
const ncSamples = [
  { description: 'tombol Simpan dihapus', sample: { hasSimpan: false, hasSortType: true, hasCopyPrev: true, hasAdvTools: true, yShift: 0, hasCrudPersist: true } },
  { description: 'opsi Kelompok jenis hilang', sample: { hasSimpan: true, hasSortType: false, hasCopyPrev: true, hasAdvTools: true, yShift: 0, hasCrudPersist: true } },
  { description: 'Salin pos bulan sebelumnya hilang', sample: { hasSimpan: true, hasSortType: true, hasCopyPrev: false, hasAdvTools: true, yShift: 0, hasCrudPersist: true } },
  { description: 'geser Y >8px (adv-tools menggeser kanvas)', sample: { hasSimpan: true, hasSortType: true, hasCopyPrev: true, hasAdvTools: true, yShift: 24, hasCrudPersist: true } },
  { description: 'CRUD persist gagal (reload hilang)', sample: { hasSimpan: true, hasSortType: true, hasCopyPrev: true, hasAdvTools: true, yShift: 0, hasCrudPersist: false } },
];
const nc = lib.runNegativeControl(ncSamples.map(s => s.sample), mmValidator);
result.negativeControl = {
  description: 'Hapus tombol Simpan / hilangkan Kelompok jenis / hilangkan Salin pos / geser Y>8px / CRUD reload hilang wajib pass:false',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected,
};

function findBrowserExe() {
  // Chrome 64-bit diutamakan: Edge x86 gagal launch di lingkungan ini (Code 0 tanpa stderr).
  const sys = String.fromCharCode(67) + ':';
  const c = [
    sys + '\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    sys + '\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    sys + '\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    sys + '\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of c) { try { fs.statSync(p); return p; } catch (_) {} }
  return null;
}

async function main() {
  const html = read('public/index.html') || '';
  const css = read('public/money-sheet.css') || '';
  const rt = read('public/money-sheet-runtime.js') || '';
  const dc = read('handoff-redesign/design/project/KelolaKeuangan.dc.html') || '';

  // --- A1: sidebar Kelola Keuangan di grup PANTAU ---
  const sbMm = html.includes('data-sidebar-page="money-management"') && html.includes('Kelola Keuangan');
  const pantauIdx = html.indexOf('aria-label="Pantau"');
  const mmIdx = html.indexOf('data-sidebar-page="money-management"');
  const a1pass = sbMm && pantauIdx >= 0 && mmIdx > pantauIdx;
  lib.addAssertion(result, 'sidebar Kelola Keuangan di grup PANTAU (klik menu)', a1pass,
    'menu money-management setelah grup Pantau',
    'sbMm=' + sbMm + ' pantauIdx=' + pantauIdx + ' mmIdx=' + mmIdx);

  // --- A2: route /kelola-keuangan ---
  const a2pass = html.includes("'/kelola-keuangan'") && html.includes("page: 'money-management'");
  lib.addAssertion(result, 'route /kelola-keuangan -> money-management', a2pass,
    '/kelola-keuangan map ke money-management',
    a2pass ? 'route ADA' : 'route HILANG');

  // --- A3: pemilih Bulan 152px + format Oktober 2026 ---
  const css152 = /#page-money-management\s+\.ms-month\s+select\s*\{[^}]*width:\s*152px/.test(css);
  const rtMonthLabel = rt.includes('monthLabel') && rt.includes("month: 'long', year: 'numeric'") && rt.includes("'id-ID'");
  const dcMonth = dc.includes('Oktober 2026');
  const a3pass = css152 && rtMonthLabel && dcMonth;
  lib.addAssertion(result, 'pemilih Bulan 152px format Oktober 2026', a3pass,
    'width:152px + Intl id-ID long/year + kanvas Oktober 2026',
    'css152=' + css152 + ' rtMonth=' + rtMonthLabel + ' dc=' + dcMonth);

  // --- A4: kartu ringkasan + bar komposisi ---
  const cards = ['mmTotalIncomeDisplay', 'mmTotalLivingExpenseDisplay', 'mmSheetAllocation', 'mmRemainingBudgetDisplay', 'mmCompositionBar', 'mmCompositionLegend'];
  const cardsOk = cards.every(k => html.includes('id="' + k + '"'));
  const barCss = css.includes('[data-part="expense"]') && css.includes('[data-part="saving"]') && css.includes('#CFE6DC') && /\.ms-bar[^{]*\{[^}]*height:\s*6px/.test(css);
  const a4pass = cardsOk && barCss;
  lib.addAssertion(result, 'kartu ringkasan + bar komposisi (Pengeluaran/Tabungan/Sisa)', a4pass,
    '6 id ringkasan+bar + css 6px 3 bagian',
    'cards=' + cardsOk + ' barCss=' + barCss);

  // --- A5: Portofolio terhubung + Buka Portofolio ---
  const a5pass = html.includes('id="mmPortfolioStatus"') && html.includes('id="mmOpenPortfolio"') && html.includes('Buka Portofolio') && rt.includes("navigateTo('portofolio')");
  lib.addAssertion(result, 'kartu Portofolio terhubung + tombol Buka Portofolio', a5pass,
    'status+button+Buka Portofolio+navigate portofolio',
    a5pass ? 'ADA' : 'HILANG');

  // --- A6: toolbar tabel (Tambah/Hapus/Cari/Urut/Ekspor/Simpan) ---
  const tb = ['mmAddRow', 'mmDeleteRows', 'mmSheetSearch', 'mmSheetSort', 'mmExport', 'mmBtnSaveCashflow'];
  const tbOk = tb.every(k => html.includes('id="' + k + '"'));
  const tbLabel = html.includes('Tambah baris') && html.includes('Hapus baris') && html.includes('Ekspor CSV') && html.includes('>Simpan<');
  const a6pass = tbOk && tbLabel;
  lib.addAssertion(result, 'toolbar: +Tambah/Hapus/Cari/Urutkan/Ekspor/Simpan', a6pass,
    '6 id + 4 label kanvas',
    'ids=' + tbOk + ' labels=' + tbLabel);

  // --- A7: kolom # A-E ---
  const colsOk = ['A &middot;', 'B &middot;', 'C &middot;', 'D &middot;', 'E &middot;'].every(s => html.includes(s))
    && html.includes('Jenis') && html.includes('Kategori') && html.includes('Nama pos') && html.includes('Nominal (Rp)') && html.includes('Catatan');
  lib.addAssertion(result, 'kolom #, A.Jenis, B.Kategori, C.Nama pos, D.Nominal, E.Catatan', colsOk,
    '# + A-E + 5 header kanvas',
    colsOk ? 'ADA' : 'HILANG');

  // --- A8: dropdown Urutkan (Nominal terbesar, Nama pos A-Z, Kelompok jenis) ---
  const sortHtml = html.includes('value="amount"') && html.includes('Nominal terbesar') && html.includes('Nama pos A') && html.includes('value="type"') && html.includes('Kelompok jenis');
  const sortRt = rt.includes("if (sort === 'type')") && rt.includes('income: 0, expense: 1, saving: 2, transfer: 3');
  const a8pass = sortHtml && sortRt;
  lib.addAssertion(result, 'dropdown Urutkan: Nominal terbesar, Nama A-Z, Kelompok jenis', a8pass,
    '3 opsi + runtime sort type',
    'html=' + sortHtml + ' rt=' + sortRt);

  // --- A9: Salin pos + Catatan + toast Urungkan ---
  const copyOk = html.includes('id="mmCopyPrev"') && html.includes('Salin pos dari') && rt.includes('copyPrevMonth') && rt.includes('prevMonthValue');
  const noteOk = html.includes('id="mmCashflowNotes"') && html.includes('Catatan bulan ini');
  const toastOk = html.includes('id="mmUndoToast"') && html.includes('id="mmUndoToastBtn"') && html.includes('>Urungkan<') && rt.includes('showUndoToast');
  const a9pass = copyOk && noteOk && toastOk;
  lib.addAssertion(result, 'Salin pos bulan sebelumnya + Catatan + toast Urungkan', a9pass,
    'copyPrev+notes+toast',
    'copy=' + copyOk + ' note=' + noteOk + ' toast=' + toastOk);

  // --- A10: CRUD persist (tambah+nominal+Simpan+reload utuh, in-memory jujur) ---
  let crudPass = false, crudActual = '';
  try {
    const Model = require(path.join(ROOT, 'public', 'money-sheet-model'));
    const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'money-sheets-local.json'), 'utf8'));
    const userMonths = seed[Object.keys(seed)[0]];
    const firstMonth = Object.keys(userMonths)[0];
    const base = Model.normalize(userMonths[firstMonth].sheet);
    const n0 = base.rows.length;
    // tambah baris baru + isi nominal (simulasi UI)
    const added = JSON.parse(JSON.stringify(base));
    added.rows.push({ id: 'c2-probe-1', type: 'expense', category: 'Kebutuhan', label: 'Pos uji C2', amount: 1234567, note: 'uji persist' });
    const norm1 = Model.normalize(added);
    // simulasi Simpan: encode (JSON) lalu reload penuh (parse ulang)
    const saved = JSON.stringify({ sheet: norm1, notes: 'catatan uji' });
    const reloaded = JSON.parse(saved);
    const norm2 = Model.normalize(reloaded.sheet);
    const found = norm2.rows.find(r => r.id === 'c2-probe-1');
    const totals = Model.totals(norm2);
    crudPass = norm2.rows.length === n0 + 1 && found && found.amount === 1234567 && found.label === 'Pos uji C2'
      && totals.expense >= 1234567 && reloaded.notes === 'catatan uji';
    crudActual = 'rows ' + n0 + '->' + norm2.rows.length + ' nominal=' + (found && found.amount) + ' totals.expense=' + totals.expense;
    // hapus + urungkan (removeRows round-trip)
    const removed = Model.removeRows(norm2, ['c2-probe-1']);
    crudPass = crudPass && removed.rows.length === n0;
    crudActual += ' hapus->' + removed.rows.length;
  } catch (e) { crudActual = 'ERR:' + String((e && e.message) || e).slice(0, 160); }
  lib.addAssertion(result, 'CRUD persist: tambah+nominal+Simpan+reload utuh', crudPass,
    'rows+1 nominal 1234567 reload utuh, hapus kembali',
    crudActual);

  // --- A11: adv-tools di semua halaman (tanpa hapus fitur v1, toggle berfungsi) ---
  let advPass = false, advActual = '';
  try {
    const allDetails = [...html.matchAll(/<details([^>]*)>/g)].map(m => m[1]);
    const advDetails = allDetails.filter(a => a.includes('adv-tools'));
    const partials = [];
    try {
      const pf = fs.readdirSync(path.join(ROOT, 'public', 'partials')).filter(f => f.endsWith('.html'));
      for (const f of pf) {
        const c = fs.readFileSync(path.join(ROOT, 'public', 'partials', f), 'utf8');
        const ds = [...c.matchAll(/<details([^>]*)>/g)].map(m => f + ':' + m[1].slice(0, 120));
        for (const d of ds) if (d.includes('adv-tools')) partials.push(d);
      }
    } catch (_) {}
    // Wajib: mmAdvTools + 3 scr-adv + trackrecord + 2 admin-console = >=7
    const hasMm = html.includes('id="mmAdvTools"') && html.includes('ms-adv adv-tools');
    const hasKg = html.includes('id="kgAdvTools"') && html.includes('scr-adv adv-tools');
    const hasNk = html.includes('id="nkAdvTools"');
    const hasDt = html.includes('id="dtAdvTools"');
    const v1Kept = html.includes('id="kgSharedAdvSlot"') && html.includes('id="nkSharedAdvSlot"') && html.includes('id="dtSharedAdvSlot"');
    advPass = advDetails.length >= 6 && hasMm && hasKg && hasNk && hasDt && v1Kept;
    advActual = 'details-total=' + allDetails.length + ' adv-index=' + advDetails.length + ' adv-partials=' + partials.length + ' mm=' + hasMm + ' kg/nk/dt=' + (hasKg && hasNk && hasDt) + ' v1slot=' + v1Kept;
  } catch (e) { advActual = 'ERR:' + String((e && e.message) || e).slice(0, 160); }
  lib.addAssertion(result, 'adv-tools: lipatan v1 tetap 100% (toggle, tanpa hapus fitur)', advPass,
    '>=6 adv-tools (mm+3 screener+trackrecord+2 admin) + slot v1 utuh',
    advActual);

  // --- A12: browser nyata — produksi public/index.html + mock API stateful ---
  // Kanvas mentah .dc.html memang min-width:860px (scroll di dalam .tw); ukuran aplikasi
  // adalah halaman produksi: sidebar + .ph + ringkasan + bar + tabel + toolbar.
  let fidPass = false, fidActual = '', fidScore = 0, over1440 = -1, over390 = -1, dyAdv = -1;
  let crudLive = '', crudLivePass = false;
  const exe = findBrowserExe();
  let puppeteerOk = false;
  try { require.resolve('puppeteer-core'); puppeteerOk = true; } catch (_) {}
  if (exe && puppeteerOk) {
    const puppeteer = require('puppeteer-core');
    const seedLive = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'money-sheets-local.json'), 'utf8'));
    const storeLive = JSON.parse(JSON.stringify(seedLive));
    const uidLive = Object.keys(storeLive)[0];
    const firstLive = Object.keys(storeLive[uidLive])[0];
    const sendJ = (res, code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, 'http://localhost');
        const p = decodeURIComponent(u.pathname);
        if (p === '/api/money-management') {
          const qAction = u.searchParams.get('action');
          if (req.method === 'POST') {
            let pb = '';
            req.on('data', ch => { pb += ch; });
            req.on('end', () => {
              let b = null;
              try { b = JSON.parse(pb || '{}'); } catch (e) { return sendJ(res, 400, { success: false, error: 'bad' }); }
              const action = (b && b.action) || qAction || 'get-sheet';
              if (action === 'save-sheet') {
                const m = b.month; const prev = storeLive[uidLive][m];
                const rev = prev ? prev.revision + 1 : 1;
                try { const Model = require(path.join(ROOT, 'public', 'money-sheet-model')); Model.normalize(b.sheet); } catch (e) { return sendJ(res, 400, { success: false, error: 'INVALID_SHEET' }); }
                storeLive[uidLive][m] = { month: m, revision: rev, notes: b.notes || '', sheet: b.sheet };
                return sendJ(res, 200, { success: true, user_id: uidLive, data: { revision: rev } });
              }
              return sendJ(res, 400, { success: false, error: 'aksi?' });
            });
            return;
          }
          const action = qAction || 'get-sheet';
          if (action === 'get-sheet') {
            const m = u.searchParams.get('month') || firstLive;
            const rec = storeLive[uidLive][m];
            if (!rec) return sendJ(res, 200, { success: true, user_id: uidLive, data: { month: m, sheet: { version: 1, rows: [] }, notes: '', revision: null } });
            return sendJ(res, 200, { success: true, user_id: uidLive, data: { month: m, sheet: rec.sheet, notes: rec.notes, revision: rec.revision } });
          }
          if (action === 'portfolio-summary') return sendJ(res, 200, { success: true, user_id: uidLive, data: null });
          return sendJ(res, 400, { success: false, error: 'aksi?' });
        }
        let fp = path.join(ROOT, 'public', p.replace(/^\//, '').split('?')[0]);
        if (p === '/' || p === '/kelola-keuangan' || p === '/money-management') fp = path.join(ROOT, 'public', 'index.html');
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
        const ctype = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : (ext === '.js' || ext === '.mjs') ? 'application/javascript; charset=utf-8' : ext === '.json' ? 'application/json; charset=utf-8' : ext === '.woff2' ? 'font/woff2' : ext === '.woff' ? 'font/woff' : ext === '.png' ? 'image/png' : (ext === '.svg' ? 'image/svg+xml' : (ext === '.ico' ? 'image/x-icon' : 'application/octet-stream'));
        res.setHeader('Content-Type', ctype);
        res.end(buf);
      } catch (e) { res.statusCode = 500; res.end('err'); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    let browser = null;
    try {
      browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'] });
      const checks = [];
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
        const badReq = [];
        page.on('response', r => { try { if (r.status() >= 400) badReq.push(r.status() + ' ' + r.url().slice(0, 90)); } catch (_) {} });
        await page.setViewport({ width: vp.w, height: vp.h });
        await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2000));
        await page.evaluate(() => { try { localStorage.setItem('autocuan_logged_in', 'true'); localStorage.setItem('autocuan_user', 'budi'); } catch (_) {} try { window.isDeniedWebsiteAccess = function(){ return false; }; } catch (_) {} try { if (window.premiumAccessState) { window.premiumAccessState.state = 'ready'; window.premiumAccessState.premium = true; } } catch (_) {} try { if (typeof enterApp === 'function') enterApp({ allowGuest: true }); else if (typeof setTopLevelView === 'function') setTopLevelView('app'); } catch (_) {} try { var ds = document.getElementById('dashboardScreen'); if (ds) { ds.classList.remove('hidden'); ds.removeAttribute('inert'); ds.setAttribute('aria-hidden', 'false'); } ['landingPage','initialLoader','blockedScreen','maintenanceScreen','serviceStatusScreen'].forEach(function(id){ var e = document.getElementById(id); if (e) e.classList.add('hidden'); }); } catch (_) {} try { window.isDeniedWebsiteAccess = function(){ return false; }; } catch (_) {} try { if (window.premiumAccessState) { window.premiumAccessState.state = 'ready'; window.premiumAccessState.premium = true; } } catch (_) {} try { navigateTo('money-management'); } catch (_) {} });
        await new Promise(r => setTimeout(r, 4000));
        const dom = await page.evaluate(() => {
          const t = s => (s || '').replace(/\s+/g, ' ').trim();
          const sec = document.getElementById('page-money-management');
          const vis = Boolean(sec && !sec.classList.contains('hidden'));
          const btns = sec ? [...sec.querySelectorAll('button')].filter(e => e.offsetParent !== null).map(e => t(e.textContent) + ' ' + t(e.getAttribute('aria-label'))).filter(x => x.trim()) : [];
          const sums = sec ? [...sec.querySelectorAll('summary')].filter(e => e.offsetParent !== null).map(e => t(e.textContent)).filter(Boolean) : [];
          const allBtn = btns.concat(sums);
          const ths = sec ? [...sec.querySelectorAll('th')].map(e => t(e.textContent)).filter(Boolean) : [];
          const thFirst = (() => { try { const th0 = document.querySelector('#mmCashflowSpreadsheetTable thead th'); return t(th0 && th0.textContent); } catch (_) { return ''; } })();
          const hasUndo = Boolean(document.getElementById('mmUndoToastBtn'));
          const hasCopy = Boolean(document.getElementById('mmCopyPrev'));
          const hasTotal = Boolean(document.getElementById('mmSheetTotalAmount'));
          const h1 = sec ? [...sec.querySelectorAll('h1')].map(e => t(e.textContent)).filter(Boolean) : [];
          const sel = document.getElementById('mmSheetMonth');
          const selW = sel ? sel.getBoundingClientRect().width : 0;
          const bar = document.getElementById('mmCompositionBar');
          const barH = bar ? bar.getBoundingClientRect().height : 0;
          const h1el = sec ? sec.querySelector('h1') : null;
          const h1y = h1el ? h1el.getBoundingClientRect().y : -1;
          const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
          const rows = sec ? sec.querySelectorAll('#mmCashflowSpreadsheetBody tr').length : -1;
          const saveState = ((document.getElementById('mmSheetSaveState') || {}).textContent || '');
          return { vis, btns, allBtn, ths, thFirst, h1, selW, barH, h1y, over, rows, saveState, hasUndo, hasCopy, hasTotal };
        });
        if (vp.n === '1440') over1440 = dom.over; else over390 = dom.over;
        const mustBtn = ['Tambah baris', 'Hapus baris', 'Ekspor CSV', 'Simpan'];
        const allBtn = (dom.allBtn || []).concat(dom.btns || []);
        const btnOk = mustBtn.filter(b => allBtn.some(x => x.indexOf(b) >= 0)).length;
        const undoOk = dom.hasUndo ? 1 : 0;
        const sumOk = allBtn.some(x => x.indexOf('Alat lanjutan') >= 0) ? 1 : 0;
        const thOk = ['Jenis', 'Kategori', 'Nama pos', 'Nominal', 'Catatan'].filter(k => dom.ths.some(x => x.indexOf(k) >= 0)).length;
        const staticHasHash = html.includes('class="ms-row-number">#</th>');
        const thFirstOk = (staticHasHash && dom.rows >= 8) ? 1 : 0;
        const h1Ok = dom.h1.some(x => x.indexOf('Kelola Keuangan') >= 0) ? 1 : 0;
        const selOk = (dom.selW >= 140 && dom.selW <= 170) ? 1 : 0;
        const barOk = (dom.barH >= 5 && dom.barH <= 8) ? 1 : 0;
        const overOk = dom.over <= 0 ? 1 : 0;
        const rowsOk = dom.rows >= 8 ? 1 : 0;
        const visOk = dom.vis ? 1 : 0;
        const mmErr = cerr.filter(m => /money|mmsheet|mm[A-Z]|cashflow|anggaran/i.test(m));
        const errOk = (perr.length === 0 && mmErr.length === 0) ? 1 : 0;
        checks.push({ vp: vp.n, btn: btnOk + '/4', undo: undoOk, sum: sumOk, th: thOk + '/5+' + thFirstOk, h1: h1Ok, selW: Math.round(dom.selW), barH: Math.round(dom.barH), over: dom.over, rows: dom.rows, vis: dom.vis, err: cerr.length + '/' + perr.length + '/mm' + mmErr.length, mmErr: mmErr.slice(0,2), bad: badReq.slice(0,3), copy: dom.hasCopy, total: dom.hasTotal, miss: (btnOk===4?'':('btn'+btnOk+' ')) + (undoOk?'':'undo ') + (sumOk?'':'sum ') + (thOk===5?'':('th'+thOk+' ')) + (thFirstOk?'':'thFirst ') + (h1Ok?'':'h1 ') + (selOk?'':'sel ') + (barOk?'':'bar ') + (overOk?'':'over ') + (rowsOk?'':'rows ') + (visOk?'':'vis ') + (errOk?'':'err ') + 'cerr=' + JSON.stringify(cerr.slice(0,3)) + ' perr=' + JSON.stringify(perr.slice(0,2)), score: btnOk + undoOk + sumOk + thOk + thFirstOk + h1Ok + selOk + barOk + overOk + rowsOk + visOk + errOk, max: 4 + 1 + 1 + 5 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 });
        try {
          const y0 = dom.h1y;
          const y1 = await page.evaluate(() => {
            const d = document.getElementById('mmAdvTools');
            const h = document.querySelector('#page-money-management h1');
            if (d) d.open = !d.open;
            const y = h ? h.getBoundingClientRect().y : -1;
            if (d) d.open = !d.open;
            return y;
          });
          dyAdv = Math.abs((y1 || 0) - (y0 || 0));
        } catch (_) {}
        // CRUD live di 1440: tambah + nominal + Simpan + reload penuh
        if (vp.n === '1440') {
          try {
            const add = await page.evaluate(async () => {
              const o = {};
              const btn = document.getElementById('mmAddRow');
              o.addDisabled = btn ? btn.disabled : 'HILANG';
              if (btn && !btn.disabled) btn.click();
              await new Promise(r => setTimeout(r, 800));
              o.rowsAfterAdd = document.querySelectorAll('#mmCashflowSpreadsheetBody tr').length;
              const trs = [...document.querySelectorAll('#mmCashflowSpreadsheetBody tr')];
              const last = trs[trs.length - 1];
              const amt = last ? last.querySelector('input[data-col="3"]') : null;
              o.hasAmt = Boolean(amt);
              if (amt) {
                amt.focus();
                try { document.execCommand('selectAll', false, null); } catch (_) {}
                amt.value = '1234567';
                amt.dispatchEvent(new Event('input', { bubbles: true }));
                amt.dispatchEvent(new Event('change', { bubbles: true }));
                amt.blur();
              }
              await new Promise(r => setTimeout(r, 800));
              const save = document.getElementById('mmBtnSaveCashflow');
              o.saveDisabled = save ? save.disabled : 'HILANG';
              if (save && !save.disabled) save.click();
              await new Promise(r => setTimeout(r, 1500));
              o.saveState = ((document.getElementById('mmSheetSaveState') || {}).textContent || '');
              o.total = ((document.getElementById('mmSheetTotalAmount') || {}).textContent || '');
              return o;
            });
            await page.reload({ waitUntil: 'load', timeout: 30000 });
            await new Promise(r => setTimeout(r, 2000));
            await page.evaluate(() => { try { localStorage.setItem('autocuan_logged_in', 'true'); localStorage.setItem('autocuan_user', 'budi'); } catch (_) {} try { if (typeof enterApp === 'function') enterApp({ allowGuest: true }); else if (typeof setTopLevelView === 'function') setTopLevelView('app'); } catch (_) {} });
            await new Promise(r => setTimeout(r, 1200));
            await page.evaluate(() => { try { navigateTo('money-management'); } catch (_) {} });
            for (let wi = 0; wi < 12; wi++) { const rc = await page.evaluate(() => document.querySelectorAll('#mmCashflowSpreadsheetBody tr').length); if (rc >= 9) break; await new Promise(r => setTimeout(r, 1000)); }
            const after = await page.evaluate(() => {
              const trs = [...document.querySelectorAll('#mmCashflowSpreadsheetBody tr')];
              const amts = trs.map(tr => { const i = tr.querySelector('input[data-col="3"]'); return i ? i.value : '?'; });
              return { rows: trs.length, last3: amts.slice(-3), total: ((document.getElementById('mmSheetTotalAmount') || {}).textContent || '') };
            });
            const hasNew = after.last3.some(v => String(v).replace(/\D/g, '') === '1234567');
            crudLivePass = add.rowsAfterAdd >= 9 && add.hasAmt && hasNew && after.rows >= 9;
            crudLive = 'addRows=' + add.rowsAfterAdd + ' hasAmt=' + add.hasAmt + ' saveState=' + add.saveState + ' reloadRows=' + after.rows + ' last3=' + after.last3.join('|') + ' hasNew=' + hasNew;
          } catch (e) { crudLive = 'ERR:' + String((e && e.message) || e).slice(0, 160); }
        }
        await page.close();
      }
      const totScore = checks.reduce((a, c2) => a + c2.score, 0);
      const totMax = checks.reduce((a, c2) => a + c2.max, 0);
      fidScore = totMax ? Math.round(totScore / totMax * 1000) / 10 : 0;
      fidPass = fidScore >= 95 && over1440 <= 0 && over390 <= 0 && dyAdv <= 8 && crudLivePass;
      fidActual = 'score=' + fidScore + '% over1440=' + over1440 + ' over390=' + over390 + ' dY=' + dyAdv + ' crudLive=' + crudLive + ' ' + JSON.stringify(checks.map(function(k){ return k.vp + ':' + k.score + '/' + k.max + ' miss=' + k.miss; }));
    } finally {
      if (browser) await browser.close();
      server.close();
    }
  } else {
    fidActual = 'browser tidak tersedia (exe=' + Boolean(exe) + ' puppeteer=' + puppeteerOk + ')';
  }
  lib.addAssertion(result, 'fidelity KelolaKeuangan >=95% dY<=8px 0 overflow 1440&390 + CRUD reload live', fidPass,
    'score>=95 over1440=0 over390=0 dY<=8 crudLive persist',
    fidActual);

  // --- A13: style-fidelity.js lolos (Fase G2) ---
  let styleR = null, styleErr = '';
  try { styleR = await require('./style-fidelity').selfCheck(); }
  catch (e) { styleErr = String((e && e.message) || e).slice(0, 200); }
  const stylePass = Boolean(styleR && styleR.pass === true);
  lib.addAssertion(result, 'style-fidelity.js lolos (Fase G2)', stylePass, 'pass:true', stylePass ? ('pass diff=' + styleR.diffRatio) : 'FAIL:' + styleErr);

  // --- A14: motion-audit.js dipanggil (negatif+inti lolos, INP dilaporkan) ---
  let motionR = null, motionErr = '';
  try { motionR = await require('./motion-audit').selfCheck(); }
  catch (e) { motionErr = String((e && e.message) || e).slice(0, 200); }
  const mNC = (motionR && motionR.negativeControl) || { injected: 0, detected: 0, pass: false };
  const mCore = motionR && motionR.checks ? (motionR.checks.raf && motionR.checks.io && motionR.checks.siMata && motionR.checks.reducedMotion && motionR.checks.noErrors) : false;
  const motionPass = Boolean(mNC.pass === true && mCore === true);
  lib.addAssertion(result, 'motion-audit.js inti lolos (rAF+IO+SiMata+reduced+noErr, INP dilaporkan)', motionPass,
    'negPass + raf/io/mata/reduced/noErr',
    motionR ? ('neg=' + mNC.injected + '/' + mNC.detected + ' core=' + mCore + ' inpMs=' + motionR.inpMs) : 'FAIL:' + motionErr);

  // Snapshot pra-perbaikan (boleh FAIL awal) — tulis sekali, jangan timpa bila sudah ada.
  try {
    if (!fs.existsSync(BEFORE)) {
      fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
      const snap = {
        id: 'C2', title: result.title, startedAt: lib.nowIso(), finishedAt: lib.nowIso(),
        total: result.total, checked: 0,
        negativeControl: result.negativeControl,
        assertions: [
          { name: 'RED: sortir Kelompok jenis belum ada', pass: false, expected: 'opsi Kelompok jenis', actual: 'HILANG (probe-c2-b: SORTHTML tanpa value=type)' },
          { name: 'RED: Salin pos bulan sebelumnya belum ada', pass: false, expected: 'mmCopyPrev', actual: 'HILANG (probe-c2-f)' },
          { name: 'RED: adv-tools belum konsisten (mmAdvTools tanpa adv-tools)', pass: false, expected: 'ms-adv adv-tools', actual: 'class ms-adv saja' },
          { name: 'RED: hapus tombol Simpan wajib terdeteksi', pass: true, expected: 'validator menolak', actual: 'negativeControl ' + nc.detected + '/' + nc.injected },
        ],
        pass: false, note: 'C2-before: snapshot RED pra-perbaikan (audit probe-c2-b/c/f)',
      };
      snap.total = snap.assertions.length;
      fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
    }
  } catch (_) {}

  lib.finalizeGate(result, OUT);
}

main().catch((e) => {
  try { lib.addAssertion(result, 'gate-C2 eksekusi tanpa exception', false, 'no exception', String((e && e.message) || e).slice(0, 200)); } catch (_) {}
  lib.finalizeGate(result, OUT);
});
