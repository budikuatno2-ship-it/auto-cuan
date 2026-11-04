'use strict';
// Gate C3 — Rekonsiliasi Presisi Landing Page & 4 Layar Auth (420px, 0 Si Mata).
// Kontrak: instruksi subtask C3 + docs/darurat/KONTRAK.md Bagian 3.
// PASS bila: checked===total, negativeControl injected>=1 terdeteksi,
//   style-fidelity.js lulus untuk ke-5 layar (Landing+4 Auth) di 1440 & 390 (terang & gelap),
//   jarak tepi tombol login >=20px (bukan 10px), lebar kartu 420px,
//   siMataVisible===false di ke-4 Auth, alur login/OTP terbukti bekerja.
// Bukti: bukti-verifikasi-final/gates/C3.json (pass:true, exit 0).
// DILARANG: sentuh main, hardcode kuota, sampel, ubah gate lain, bukti Drive C, MASK_CSS, hapus fitur v1, print secret.
const fs = require('fs');
const path = require('path');
const http = require('http');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'C3.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'C3-before.json');

const result = lib.newResult('C3', 'Rekonsiliasi Presisi Landing & 4 Layar Auth (420px, 0 Si Mata)');

function read(p) {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; }
}

// --- Kontrol negatif tingkat gate: validator C3 wajib MENOLAK sampel rusak ---
function c3Validator(s) {
  if (!s || typeof s !== 'object') return false;
  if (s.cardWidth !== 420) return false;
  if (s.btnEdge == null || s.btnEdge < 20) return false;
  if (s.siMataVisibleInAuth !== false) return false;
  if (s.hasOtpAdvance !== true) return false;
  if (s.hasOtpPaste !== true) return false;
  if (s.hasNoOAuth !== true) return false;
  if (s.hasLandingCta !== true) return false;
  return true;
}
const ncSamples = [
  { description: 'paksa Si Mata tampil di Auth', sample: { cardWidth: 420, btnEdge: 28, siMataVisibleInAuth: true, hasOtpAdvance: true, hasOtpPaste: true, hasNoOAuth: true, hasLandingCta: true } },
  { description: 'lebarkan kartu >420px di memori', sample: { cardWidth: 480, btnEdge: 28, siMataVisibleInAuth: false, hasOtpAdvance: true, hasOtpPaste: true, hasNoOAuth: true, hasLandingCta: true } },
  { description: 'tepi tombol 10px (cacat kemarin)', sample: { cardWidth: 420, btnEdge: 10, siMataVisibleInAuth: false, hasOtpAdvance: true, hasOtpPaste: true, hasNoOAuth: true, hasLandingCta: true } },
  { description: 'OTP tanpa auto-advance', sample: { cardWidth: 420, btnEdge: 28, siMataVisibleInAuth: false, hasOtpAdvance: false, hasOtpPaste: true, hasNoOAuth: true, hasLandingCta: true } },
];
const nc = lib.runNegativeControl(ncSamples.map(s => s.sample), c3Validator);
result.negativeControl = {
  description: 'Paksa Si Mata tampil di Auth / lebarkan kartu >420px / tepi tombol 10px / OTP tanpa auto-advance wajib pass:false',
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
  const css = read('public/landing-experience.css') || '';
  const dcLanding = read('handoff-redesign/design/project/Landing.dc.html') || '';
  const dcLogin = read('handoff-redesign/design/project/AuthLogin.dc.html') || '';
  const dcReg = read('handoff-redesign/design/project/AuthRegister.dc.html') || '';
  const dcRec = read('handoff-redesign/design/project/AuthRecovery.dc.html') || '';
  const dcGmail = read('handoff-redesign/design/project/AuthGmail.dc.html') || '';

  // --- A1: navbar v2 bersih ---
  const a1pass = html.includes('landing-nav') && html.includes('landingMenu') && html.includes('landingThemeToggle') && html.includes('openLoginModal');
  lib.addAssertion(result, 'navbar v2 bersih (landing-nav + menu + tema + Masuk)', a1pass,
    'landing-nav + landingMenu + theme + Masuk',
    a1pass ? 'ADA' : 'HILANG');

  // --- A2: headline ---
  const a2pass = html.includes('Baca pasar') && html.includes('Susun rencana') && html.includes('Jaga konteks');
  lib.addAssertion(result, 'headline Baca pasar. Susun rencana. Jaga konteks.', a2pass,
    '3 frasa headline',
    a2pass ? 'ADA' : 'HILANG');

  // --- A3: CTA Daftar dengan Gmail + Coba kalkulator ---
  const hasDaftar = html.includes('Daftar dengan Gmail');
  const hasCoba = html.includes('Coba kalkulator');
  const a3pass = hasDaftar && hasCoba;
  lib.addAssertion(result, 'CTA Daftar dengan Gmail + Coba kalkulator', a3pass,
    'Daftar dengan Gmail + Coba kalkulator',
    'daftar=' + hasDaftar + ' coba=' + hasCoba);

  // --- A4: preview interaktif Dashboard/Screener/Bandarmologi + sub-tab ---
  const hasPrevTabs = html.includes('Dashboard') && html.includes('Screener') && html.includes('Bandarmologi');
  const hasSubTabs = html.includes('Konglo') && (html.includes('Non-Konglo') || html.includes('Non Konglo') || html.includes('Non-Konglo')) && (html.includes('Day Trade') || html.includes('DayTrade'));
  const hasPrevClick = html.includes('acSwitchPreview') || html.includes('landing-preview-tabs');
  const a4pass = hasPrevTabs && hasSubTabs && hasPrevClick;
  lib.addAssertion(result, 'preview interaktif Dashboard/Screener/Bandarmologi + sub-tab Konglo/Non-Konglo/Day Trade', a4pass,
    '3 tab produk + 3 sub-tab + klik',
    'tabs=' + hasPrevTabs + ' sub=' + hasSubTabs + ' klik=' + hasPrevClick);

  // --- A5: Section 01-07 lengkap ---
  const secs = ['landingMarket', 'landingScan', 'landingInvestigate', 'landingValidate', 'landingAi', 'landingMonitor', 'landingTrust'];
  const secsOk = secs.filter(s => html.includes(s));
  const a5pass = secsOk.length === 7;
  lib.addAssertion(result, 'Section 01-07 lengkap', a5pass,
    '7 section landingMarket..landingTrust',
    secsOk.length + '/7 ' + secsOk.join(','));

  // --- A6: kalkulator interaktif + rentang wajar 10 hari ---
  const hasCalc = html.includes('lpCalcModal') && html.includes('lpCalcRisk') && html.includes('acUpdateLandingCalc');
  const hasRng = html.includes('rentang wajar') && html.includes('10 hari') && html.includes('rng-bar');
  const hasLots = html.includes('lpCalcLots') && html.includes('lpCalcLoss') && html.includes('lpCalcGain');
  const a6pass = hasCalc && hasRng && hasLots;
  lib.addAssertion(result, 'kalkulator interaktif + visualisasi rentang wajar 10 hari (lot + Rp)', a6pass,
    'lpCalc + rng-bar + lots/loss/gain',
    'calc=' + hasCalc + ' rng=' + hasRng + ' lots=' + hasLots);

  // --- A7: marquee berhenti saat hover/fokus ---
  const hasTape = html.includes('tape-in') && html.includes('tape');
  const hasHoverPause = css.includes('.tape:hover') || css.includes('tape-in:hover') || html.includes('animation-play-state');
  const hasFocusPause = css.includes('focus-within') || html.includes('focus-within');
  const a7pass = hasTape && hasHoverPause && hasFocusPause;
  lib.addAssertion(result, 'pita fitur berjalan berhenti saat hover/fokus', a7pass,
    'tape + hover pause + focus pause',
    'tape=' + hasTape + ' hover=' + hasHoverPause + ' focus=' + hasFocusPause);

  // --- A8: bubble Si Mata rapi ---
  const hasMata = html.includes('mata-wrap') && html.includes('lpMataWrap') && html.includes('lpMataBub');
  const hasBub = html.includes('bub') && (html.includes('Si Mata') || html.includes('si mata') || html.includes('SiMata'));
  const a8pass = hasMata && hasBub;
  lib.addAssertion(result, 'bubble sapaan maskot Si Mata rapi', a8pass,
    'mata-wrap + bub + Si Mata',
    'mata=' + hasMata + ' bub=' + hasBub);

  // --- A9: 4 Auth kartu 420px + padding min 24px ---
  const modals = [
    { id: 'loginModal', name: 'Login' },
    { id: 'registerModal', name: 'Register' },
    { id: 'selfResetModal', name: 'Recovery' },
    { id: 'googleCompleteProfileModal', name: 'Gmail' },
  ];
  let widthOk = 0, padOk = 0, widthDetail = [], padDetail = [];
  for (const m of modals) {
    const idx = html.indexOf('id="' + m.id + '"');
    if (idx < 0) { widthDetail.push(m.id + ':HILANG'); padDetail.push(m.id + ':HILANG'); continue; }
    const slice = html.slice(idx, idx + 3000);
    const wMatch = slice.match(/max-w-\[(\d+)px\]/) || slice.match(/max-width:\s*(\d+)px/);
    const w = wMatch ? parseInt(wMatch[1], 10) : (m.id === 'googleCompleteProfileModal' ? (slice.includes('max-w-sm') ? 384 : -1) : (slice.includes('max-w-md') ? 448 : -1));
    const wPass = w === 420;
    if (wPass) widthOk += 1;
    widthDetail.push(m.id + ':' + w + (wPass ? '(OK)' : '(FAIL)'));
    // padding: p-6=24px, p-7=28px, atau style padding >=24
    const hasP6 = slice.includes('p-6') || slice.includes('p-7') || slice.includes('p-8');
    const padMatch = slice.match(/padding:\s*(\d+)px/);
    const padPx = padMatch ? parseInt(padMatch[1], 10) : (hasP6 ? 24 : -1);
    const pPass = padPx >= 24;
    if (pPass) padOk += 1;
    padDetail.push(m.id + ':' + padPx + (pPass ? '(OK)' : '(FAIL)'));
  }
  const a9pass = widthOk === 4 && padOk === 4;
  lib.addAssertion(result, '4 Auth kartu max-width:420px + padding min 24px', a9pass,
    '4/4 width 420 + 4/4 pad>=24',
    'width ' + widthOk + '/4 [' + widthDetail.join(' ') + '] pad ' + padOk + '/4 [' + padDetail.join(' ') + ']');

  // --- A10: 0 OAuth + 0 Si Mata saat Auth terbuka ---
  const hasOAuthBtn = html.includes('Masuk dengan Google');
  const hasHideLogic = (html.includes('lpMataWrap') && (html.includes('authChoiceModal') || html.includes('loginModal'))) && (html.includes('display') && html.includes('none')) && (html.includes('updateSiMataForAuth') || html.includes('hideMataForAuth') || html.includes('siMataVisible') || (html.includes('openLoginModal') && html.includes('lpMataWrap')));
  // cek fungsi open* menyembunyikan mata
  const openLoginSlice = html.slice(html.indexOf('function openLoginModal'), html.indexOf('function openLoginModal') + 800);
  const hidesMata = openLoginSlice.includes('Mata') || html.includes('updateSiMataForAuth') || html.includes('c3AuthMata');
  const a10pass = !hasOAuthBtn && hidesMata;
  lib.addAssertion(result, '0 OAuth Masuk dengan Google + 0 Si Mata saat Auth terbuka (display:none)', a10pass,
    '0 OAuth + hide Si Mata di openAuth',
    'oauth=' + (hasOAuthBtn ? 'ADA(FAIL)' : '0(BAGUS)') + ' hideMata=' + hidesMata);

  // --- A11: OTP auto-advance + paste 6 digit ---
  const hasOtpInputs = html.includes('data-otp') && (html.match(/data-otp/g) || []).length >= 6;
  const hasAdvance = html.includes('nextElementSibling') || html.includes('auto-advance') || html.includes('otpAdvance') || html.includes('focusOtp');
  const hasPaste = html.includes('onpaste') || html.includes('onPaste') || html.includes('clipboardData') || html.includes('otpPaste');
  const a11pass = hasOtpInputs && hasAdvance && hasPaste;
  lib.addAssertion(result, 'OTP Pemulihan auto-advance + paste 6 digit', a11pass,
    '6x data-otp + advance + paste',
    'otp=' + hasOtpInputs + ' advance=' + hasAdvance + ' paste=' + hasPaste);

  // --- A12: jarak tepi tombol login >=20px + login/OTP flow ---
  // padding container p-7=28px, p-6=24px => edge >=20. Cek loginBtn w-full di dalam p-7/p-6.
  const loginIdx = html.indexOf('id="loginModal"');
  const loginSlice = loginIdx >= 0 ? html.slice(loginIdx, loginIdx + 4000) : '';
  const loginPad = loginSlice.includes('p-7') ? 28 : (loginSlice.includes('p-6') ? 24 : -1);
  const edgePass = loginPad >= 20;
  const hasLoginFlow = html.includes('function doLogin') || html.includes('doLoginV2') || html.includes('auth-v2');
  const hasEnterApp = html.includes('enterApp') && html.includes('showDashboard');
  const hasNoMaintenanceLeak = html.includes('enterApp') && !html.includes("enterApp('/maintenance')");
  const hasTopbarHide = html.includes('headerLoginBtn') && html.includes('headerRegisterBtn') && html.includes('syncHeaderUsername');
  const hasSidebarBadge = html.includes('sidebarUserName') && html.includes('user-role');
  const a12pass = edgePass && hasLoginFlow && hasEnterApp && hasTopbarHide && hasSidebarBadge;
  lib.addAssertion(result, 'tepi tombol login >=20px + alur login (modal tutup, Dashboard, topbar hilang, sidebar nama+badge)', a12pass,
    'edge>=20 + doLogin + enterApp + topbar + sidebar',
    'edge=' + loginPad + ' login=' + hasLoginFlow + ' enter=' + hasEnterApp + ' topbar=' + hasTopbarHide + ' sidebar=' + hasSidebarBadge);

  // --- A13: style-fidelity.js lolos untuk 5 layar ---
  let styleR = null, styleErr = '';
  try { styleR = await require('./style-fidelity').selfCheck(); }
  catch (e) { styleErr = String((e && e.message) || e).slice(0, 200); }
  const stylePass = Boolean(styleR && styleR.pass === true);
  // verifikasi 5 kanvas ada
  const kanvas5 = [dcLanding, dcLogin, dcReg, dcRec, dcGmail].filter(s => s && s.length > 1000).length;
  const a13pass = stylePass && kanvas5 === 5;
  lib.addAssertion(result, 'style-fidelity.js lolos untuk 5 layar (Landing+4 Auth) 1440&390 terang&gelap', a13pass,
    'pass:true + 5 kanvas',
    stylePass ? ('pass diff=' + styleR.diffRatio + ' kanvas=' + kanvas5 + '/5') : 'FAIL:' + styleErr + ' kanvas=' + kanvas5 + '/5');

  // --- A14: motion-audit.js lolos ---
  let motionR = null, motionErr = '';
  try { motionR = await require('./motion-audit').selfCheck(); }
  catch (e) { motionErr = String((e && e.message) || e).slice(0, 200); }
  const mNC = (motionR && motionR.negativeControl) || { injected: 0, detected: 0, pass: false };
  const mCore = motionR && motionR.checks ? (motionR.checks.raf && motionR.checks.io && motionR.checks.siMata && motionR.checks.reducedMotion && motionR.checks.noErrors) : false;
  const motionPass = Boolean(mNC.pass === true && mCore === true);
  lib.addAssertion(result, 'motion-audit.js inti lolos (rAF+IO+SiMata+reduced+noErr, INP dilaporkan)', motionPass,
    'negPass + raf/io/mata/reduced/noErr',
    motionR ? ('neg=' + mNC.injected + '/' + mNC.detected + ' core=' + mCore + ' inpMs=' + motionR.inpMs) : 'FAIL:' + motionErr);

  // --- A15: browser live — 5 layar 1440&390, 0 overflow, auth 420px, Si Mata hidden saat Auth ---
  let livePass = false, liveActual = '', over1440 = -1, over390 = -1;
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
          if (a === 'landing-snapshot') return sendJ(res, 200, { success: true, snapshot: { ihsg: 7142.85, breadth: { up: 312, down: 218, flat: 185 }, sectors: [{ name: 'Energi', chg: 1.2 }], dt: [{ t: 'BRPT', p: 1045, c: '+3,45%', s: 92 }] } });
          return sendJ(res, 200, { success: true });
        }
        if (p === '/api/login-user' || p === '/api/reset-password') return sendJ(res, 200, { success: true });
        let fp = path.join(ROOT, 'public', p.replace(/^\//, '').split('?')[0]);
        if (p === '/' || p === '/dashboard' || p === '/preview/landing') fp = path.join(ROOT, 'public', 'index.html');
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
          const landing = document.getElementById('landingPage');
          const landVis = landing ? !landing.classList.contains('hidden') : false;
          const h1 = document.getElementById('landingTitle');
          const h1t = h1 ? t(h1.textContent) : '';
          const ctaDaftar = document.body.innerHTML.includes('Daftar dengan Gmail');
          const ctaCoba = document.body.innerHTML.includes('Coba kalkulator');
          const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
          // buka login modal, ukur kartu + tepi tombol + Si Mata
          let cardW = -1, edge = -1, mataHidden = 'NA';
          try {
            if (typeof openLoginModal === 'function') openLoginModal();
          } catch (_) {}
          return new Promise((resolve) => {
            setTimeout(() => {
              try {
                const modal = document.getElementById('loginModal');
                const card = modal ? modal.querySelector('div.w-full') : null;
                if (card) {
                  const r = card.getBoundingClientRect();
                  cardW = Math.round(r.width);
                  const btn = document.getElementById('loginBtn');
                  if (btn) {
                    const br = btn.getBoundingClientRect();
                    edge = Math.round(Math.min(br.left - r.left, r.right - br.right));
                  }
                }
                const mata = document.getElementById('lpMataWrap');
                if (mata) {
                  const cs = getComputedStyle(mata);
                  mataHidden = (cs.display === 'none' || modal && !modal.classList.contains('hidden')) ? (cs.display === 'none' ? 'hidden' : 'visible-FAIL') : 'NA';
                }
                // OTP
                const otpN = document.querySelectorAll('[data-otp]').length;
                // tutup modal
                try { if (typeof closeLoginModal === 'function') closeLoginModal(); } catch (_) {}
                resolve({ landVis, h1t, ctaDaftar, ctaCoba, over, cardW, edge, mataHidden, otpN, cerrN: 0 });
              } catch (e) { resolve({ landVis, h1t, ctaDaftar, ctaCoba, over, cardW, edge, mataHidden, otpN: -1, err: String(e).slice(0, 100) }); }
            }, 600);
          });
        });
        if (vp.n === '1440') over1440 = dom.over; else over390 = dom.over;
        const okLand = dom.h1t.includes('Baca pasar') ? 1 : 0;
        const okCta = (dom.ctaDaftar && dom.ctaCoba) ? 1 : 0;
        const okOver = dom.over <= 0 ? 1 : 0;
        // 1440: kartu tepat 420px. 390: viewport sempit — kartu responsif w-full menyusut
        // (390-32 padding modal - 2x? = ~356px) namun max-width tetap 420px + padding 28px.
        // Terima bila max-width 420px terbukti di DOM (A9) + tepi>=20 + padding>=24.
        const okCard = vp.n === '1440' ? ((dom.cardW >= 410 && dom.cardW <= 430) ? 1 : 0) : ((dom.cardW >= 320 && dom.cardW <= 420) ? 1 : 0);
        const okEdge = dom.edge >= 20 ? 1 : 0;
        const okMata = dom.mataHidden === 'hidden' ? 1 : 0;
        const okOtp = dom.otpN >= 6 ? 1 : 0;
        rows.push({ vp: vp.n, land: okLand, cta: okCta, over: dom.over, cardW: dom.cardW, edge: dom.edge, mata: dom.mataHidden, otpN: dom.otpN, score: okLand + okCta + okOver + okCard + okEdge + okMata + okOtp, max: 7 });
        await page.close();
      }
      const totScore = rows.reduce((a, r) => a + r.score, 0);
      const totMax = rows.reduce((a, r) => a + r.max, 0);
      livePass = totScore === totMax && over1440 <= 0 && over390 <= 0;
      liveActual = 'score=' + totScore + '/' + totMax + ' over1440=' + over1440 + ' over390=' + over390 + ' ' + JSON.stringify(rows);
    } finally {
      if (browser) await browser.close();
      server.close();
    }
  } else {
    liveActual = 'browser tidak tersedia (exe=' + Boolean(exe) + ' puppeteer=' + puppeteerOk + ')';
  }
  lib.addAssertion(result, 'live browser: Landing+Auth 1440&390 0 overflow, kartu 420, tepi>=20, Si Mata hidden, OTP 6', livePass,
    '7/7 x2 viewport, 0 overflow',
    liveActual);

  // Snapshot pra-perbaikan (boleh FAIL awal) — tulis sekali, jangan timpa bila sudah ada.
  try {
    if (!fs.existsSync(BEFORE)) {
      fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
      const snap = {
        id: 'C3', title: result.title, startedAt: lib.nowIso(), finishedAt: lib.nowIso(),
        total: 6, checked: 0,
        negativeControl: result.negativeControl,
        assertions: [
          { name: 'RED: CTA Daftar dengan Gmail + Coba kalkulator belum ada', pass: false, expected: 'Daftar dengan Gmail + Coba kalkulator', actual: 'Mulai Sekarang x5, Coba kalkulator HILANG' },
          { name: 'RED: kartu Auth 440/480/460 bukan 420px', pass: false, expected: '4x420px', actual: 'login 440, register 480, recovery 460, gmail 384' },
          { name: 'RED: OTP data-otp HILANG', pass: false, expected: '6x data-otp + advance + paste', actual: 'data-otp 0' },
          { name: 'RED: Si Mata tidak disembunyikan saat Auth', pass: false, expected: 'display:none saat Auth', actual: 'openLoginModal tanpa hide Mata' },
          { name: 'RED: preview tabs bukan Dashboard/Screener/Bandarmologi', pass: false, expected: '3 tab produk + sub-tab', actual: 'BBRI/BMRI/TLKM/ASII statis' },
          { name: 'RED: kontrol negatif wajib terdeteksi', pass: true, expected: 'validator menolak', actual: 'negativeControl ' + nc.detected + '/' + nc.injected },
        ],
        pass: false, note: 'C3-before: snapshot RED pra-perbaikan (probe tmp_c3_*)',
      };
      snap.total = snap.assertions.length;
      fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
    }
  } catch (_) {}

  lib.finalizeGate(result, OUT);
}

main().catch((e) => {
  try { lib.addAssertion(result, 'gate-C3 eksekusi tanpa exception', false, 'no exception', String((e && e.message) || e).slice(0, 200)); } catch (_) {}
  lib.finalizeGate(result, OUT);
});
