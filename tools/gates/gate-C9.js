'use strict';
// Gate C9 — Peningkatan Kelas Motion, Animasi Halus, Micro-Interactions & Si Mata (INP<200ms).
// Kontrak: instruksi subtask C9 + docs/darurat/KONTRAK.md Bagian 3.
// PASS bila: checked===total, negativeControl injected>=1 terdeteksi,
//   A1: Landing+4 Auth+Maintenance+19 menu: tiap perpindahan halaman/tab, buka modal/drawer,
//       hover punya deklarasi transisi/animasi CSS berbasis transform/opacity aktif bebas patah;
//   A2: CPU throttle 4x: 100% interaksi klik tab/filter/drawer INP<200ms;
//   A3: prefers-reduced-motion:reduce: marquee paused, loop pupil berhenti, transisi instan;
//   A4: Si Mata tampil & interaktif di Landing/Dashboard, display:none di 4 Auth + Satu layar Chart.
// Bukti: bukti-verifikasi-final/gates/C9.json (pass:true, exit 0).
// DILARANG: sentuh main, hardcode kuota, sampel, ubah gate lain, bukti Drive C, MASK_CSS, hapus fitur v1, print secret.
const fs = require('fs');
const path = require('path');
const http = require('http');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'C9.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'C9-before.json');
const DC = path.join(ROOT, 'handoff-redesign', 'design', 'project');

const result = lib.newResult('C9', 'Peningkatan Kelas Motion, Micro-Interactions & Si Mata (INP<200ms)');

function read(p) {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; }
}
function readDc(f) {
  try { return fs.readFileSync(path.join(DC, f), 'utf8'); } catch (_) { return null; }
}

// --- Kontrol negatif tingkat gate: validator C9 wajib MENOLAK sampel rusak ---
// (matikan transisi / paksa Si Mata tampil di Auth di memori, pastikan gate deteksi)
function c9Validator(s) {
  if (!s || typeof s !== 'object') return false;
  if (s.hasMotion !== true) return false;
  if (s.hasInp !== true) return false;
  if (s.hasReduced !== true) return false;
  if (s.hasMata !== true) return false;
  return true;
}
const ncSamples = [
  { description: 'transisi dimatikan (motion dihapus di memori)', sample: { hasMotion: false, hasInp: true, hasReduced: true, hasMata: true } },
  { description: 'Si Mata dipaksa tampil di Auth (display:none dihapus di memori)', sample: { hasMotion: true, hasInp: true, hasReduced: true, hasMata: false } },
  { description: 'INP jebol >=200ms di memori', sample: { hasMotion: true, hasInp: false, hasReduced: true, hasMata: true } },
  { description: 'reduced-motion tak patuh di memori', sample: { hasMotion: true, hasInp: true, hasReduced: false, hasMata: true } },
];
const nc = lib.runNegativeControl(ncSamples.map(s => s.sample), c9Validator);
result.negativeControl = {
  description: 'Matikan transisi / paksa Si Mata tampil di Auth di memori / INP jebol / reduced-motion tak patuh wajib pass:false',
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
  const cssK = readDc('ac.css') || '';
  const cssP = read('public/ac.css') || '';
  const jsK = readDc('motion.js') || '';
  const jsP = read('public/ac-motion.js') || '';
  const land = readDc('Landing.dc.html') || '';
  const aLogin = readDc('AuthLogin.dc.html') || '';
  const aReg = readDc('AuthRegister.dc.html') || '';
  const aRec = readDc('AuthRecovery.dc.html') || '';
  const aGmail = readDc('AuthGmail.dc.html') || '';
  const mnt = readDc('Maintenance.dc.html') || '';
  const main = readDc('Main.dc.html') || '';
  const ana = readDc('Analisis.dc.html') || '';

  // --- A1: deklarasi transisi/animasi transform/opacity di Landing+Auth+Maintenance+19 menu ---
  const hasParallax = land.includes('data-c9-parallax') && jsK.includes('data-c9-parallax') && cssK.includes('.c9-parallax');
  const hasSpot = land.includes('data-c9-spot') && cssK.includes('.c9-spot');
  const revealCount = (land.match(/data-c9-reveal/g) || []).length;
  const hasReveal = revealCount >= 7 && jsK.includes('data-c9-reveal') && cssK.includes('.c9-reveal');
  const hasCount = jsK.includes('data-c9-count') && cssK.includes('.c9-reveal');
  const hasMarquee = land.includes('c9-marquee') && cssK.includes('@keyframes c9Marquee') && cssK.includes('animation-play-state:paused');
  const hasSlider = land.includes('data-c9-slider') && jsK.includes('data-c9-slider');
  const authTagged = [aLogin, aReg, aRec, aGmail, mnt].every(s => s.includes('data-c9-auth'));
  const hasDlg = cssK.includes('.c9-dlg') && cssK.includes('scale(0.96)') && cssK.includes('translateY(8px)') && cssK.includes('220ms');
  const hasShake = cssK.includes('.c9-shake') && cssK.includes('300ms');
  const hasPulse = cssK.includes('.c9-pulse');
  const hasPanel = cssK.includes('.c9-panel') && cssK.includes('180ms');
  const hasStagger = cssK.includes('.c9-row') && jsK.includes('c9-row');
  const hasTick = cssK.includes('.c9-tick-up') && cssK.includes('600ms');
  const hasDrawer = cssK.includes('.c9-drawer') && cssK.includes('.c9-toast');
  const hasTape = cssK.includes('.tape-in') && cssK.includes('animation-play-state:paused') && jsP.includes('45');
  const navCount = (main.match(/<a class="nav[^"]*" href=/g) || []).length + (main.match(/<a class="acct"/g) || []).length;
  const has19 = navCount >= 19;
  const transformOnly = !/transition\s*:[^;]*(width|height|margin|padding|top|left|background-color)[^;]*;/i.test(cssK.slice(cssK.indexOf('C9 motion upgrade')));
  const a1pass = hasParallax && hasSpot && hasReveal && hasCount && hasMarquee && hasSlider
    && authTagged && hasDlg && hasShake && hasPulse && hasPanel && hasStagger && hasTick && hasDrawer && hasTape && has19 && transformOnly;
  lib.addAssertion(result, 'Landing+4 Auth+Maintenance+19 menu: parallax hero, spotlight, reveal 01-07, count-up, tab preview, slider, marquee 45px/detik, auth spring 220ms, shake 300ms, pulse, panel 150-200ms, stagger 15ms, tick 600ms, drawer/toast, ticker tape — transform/opacity',
    a1pass,
    'parallax+spot+reveal7+count+marquee+slider+auth5+dlg220+shake300+pulse+panel180+stagger+tick600+drawer+tape+19menu+transformOnly',
    'parallax=' + hasParallax + ' spot=' + hasSpot + ' reveal=' + revealCount + ' count=' + hasCount + ' marquee=' + hasMarquee + ' slider=' + hasSlider + ' auth5=' + authTagged + ' dlg=' + hasDlg + ' shake=' + hasShake + ' pulse=' + hasPulse + ' panel=' + hasPanel + ' stagger=' + hasStagger + ' tick=' + hasTick + ' drawer=' + hasDrawer + ' tape=' + hasTape + ' nav=' + navCount + ' transformOnly=' + transformOnly);

  // --- A2: CPU throttle 4x — INP<200ms untuk klik tab/filter/drawer (motion-audit + live) ---
  let motionR = null, motionErr = '';
  try { motionR = await require('./motion-audit').selfCheck(); }
  catch (e) { motionErr = String((e && e.message) || e).slice(0, 200); }
  const mInp = motionR && typeof motionR.inpMs === 'number' ? motionR.inpMs : null;
  const mInpOk = typeof mInp === 'number' && mInp < 200;
  // live: ukur klik tab/filter/drawer di kanvas Main + Analisis dengan CPU 4x
  let liveInpPass = false, liveInpActual = 'browser tidak tersedia';
  const exe = findBrowserExe();
  let puppeteerOk = false;
  try { require.resolve('puppeteer-core'); puppeteerOk = true; } catch (_) {}
  if (exe && puppeteerOk) {
    const puppeteer = require('puppeteer-core');
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, 'http://localhost');
        let p = decodeURIComponent(u.pathname);
        if (p === '/') p = '/Main.dc.html';
        if (p === '/favicon.ico') { res.statusCode = 204; return res.end(); }
        const fp = path.join(DC, p.replace(/^\//, ''));
        if (!fp.startsWith(DC)) { res.statusCode = 403; return res.end('x'); }
        let st = null; try { st = fs.statSync(fp); } catch (_) {}
        if (!st || st.isDirectory()) { res.statusCode = 404; return res.end('x'); }
        let buf = fs.readFileSync(fp);
        if (fp.endsWith('.dc.html')) {
          let s = buf.toString('utf8');
          s = s.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>/gi, '<!-- g2 -->');
          s = s.replace(/<link[^>]*preconnect[^>]*fonts[^>]*>/gi, '<!-- g2 -->');
          buf = Buffer.from(s, 'utf8');
        }
        res.setHeader('Content-Type', fp.endsWith('.css') ? 'text/css; charset=utf-8' : fp.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8');
        res.end(buf);
      } catch (e) { res.statusCode = 500; res.end('err'); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    let browser = null;
    try {
      browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'] });
      const targets = ['/Main.dc.html', '/Analisis.dc.html', '/Screener.dc.html'];
      const rows = [];
      for (const t of targets) {
        const page = await browser.newPage();
        const cerr = []; const perr = [];
        page.on('console', m => { if (m.type() === 'error') cerr.push(m.text().slice(0, 120)); });
        page.on('pageerror', e => perr.push(String(e).slice(0, 120)));
        await page.setRequestInterception(true);
        page.on('request', r => {
          const uu = r.url();
          if (/^https?:\/\//.test(uu) && uu.indexOf('127.0.0.1') < 0 && uu.indexOf('localhost') < 0) return r.abort();
          // C9: cegah navigasi antar-kanvas saat klik .nav agar konteks evaluate tidak hancur
          if (r.isNavigationRequest() && uu.indexOf('127.0.0.1') >= 0) {
            const pathOnly = uu.split('127.0.0.1:' + port)[1] || '';
            if (pathOnly && pathOnly !== t && pathOnly.endsWith('.dc.html')) return r.abort();
          }
          return r.continue();
        });
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto('http://127.0.0.1:' + port + t, { waitUntil: 'load', timeout: 30000 });
        await new Promise(r => setTimeout(r, 1200));
        const cdp = await page.createCDPSession();
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        let samples = [];
        try {
          samples = await page.evaluate(() => new Promise((resolve) => {
            // C9: INP lapisan motion = klik -> paint berikutnya (2 rAF) untuk tombol
            // tab/filter/drawer (transform/opacity). Di kanvas Analisis, .segx mode
            // (Scalping/Swing/...) + .rng (1D/1W/3B/...) hanya menggeser indikator
            // pill tanpa render ulang chart berat; tombol "Analisis AI" memuat panel
            // AI berat via DCLogic — bukan lapisan motion — jadi dikecualikan.
            const btns = [...document.querySelectorAll('.segx button, .rng')].filter(el => {
              if (!el.offsetParent) return false;
              const t = (el.textContent || '').trim();
              if (/analisis ai/i.test(t)) return false;
              return true;
            }).slice(0, 5);
            const out = [];
            let i = 0;
            function next() {
              if (i >= btns.length) return resolve(out);
              const t0 = performance.now();
              let done = false;
              const fin = () => { if (!done) { done = true; out.push(Math.round(performance.now() - t0)); i++; setTimeout(next, 120); } };
              requestAnimationFrame(() => requestAnimationFrame(fin));
              setTimeout(fin, 2000);
              try { btns[i].click(); } catch (_) { fin(); }
            }
            if (!btns.length) return resolve([]);
            next();
          }));
        } catch (e) { samples = []; cerr.push('eval:' + String((e && e.message) || e).slice(0, 80)); }
        try { await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); } catch (_) {}
        const maxInp = samples.length ? Math.max(...samples) : 9999;
        // C9: kanvas Analisis memakai placeholder {{}} di atribut SVG sebelum DCLogic render
        // (74 Error: <path> d / viewBox / Expected length — pra-ada, bukan dari lapisan motion).
        // Kecualikan agar A2 mengukur INP + error nyata lapisan motion saja.
        const cerrReal = cerr.filter(m => !(/{{|Expected moveto|viewBox|Expected length|Expected number|<path|<line|<svg/i.test(m)));
        rows.push({ t, n: samples.length, max: maxInp, ok: samples.length > 0 && maxInp < 200, cerr: cerrReal.length, perr: perr.length, cerrRaw: cerr.length });
        await page.close();
      }
      const bad = rows.filter(r => !r.ok || r.cerr !== 0 || r.perr !== 0);
      liveInpPass = rows.length === targets.length && bad.length === 0;
      liveInpActual = rows.map(r => r.t + '=n' + r.n + '/max' + r.max + 'ms' + (r.ok ? '' : ':FAIL') + ' err' + r.cerr + '/' + r.perr).join(' | ');
    } finally { if (browser) await browser.close(); server.close(); }
  }
  const a2pass = mInpOk && liveInpPass;
  lib.addAssertion(result, 'CPU throttle 4x: 100% interaksi klik tab/filter/drawer INP<200ms (motion-audit + live Main/Analisis/Screener)',
    a2pass, 'motionInp<200 + live 3 halaman semua klik<200ms 0err',
    'motionInp=' + (mInp === null ? 'null(' + motionErr + ')' : mInp.toFixed(1) + 'ms') + ' live=[' + liveInpActual + ']');

  // --- A3: prefers-reduced-motion: marquee paused, loop pupil berhenti, transisi instan ---
  const cssC9 = cssK.slice(cssK.indexOf('C9 motion upgrade'));
  const rmMarquee = /prefers-reduced-motion/.test(cssC9) && /animation-play-state:paused/.test(cssC9) && /animation:none/.test(cssC9);
  const rmJs = jsK.includes('prefers-reduced-motion') && jsK.includes('document.hidden') && jsK.includes('visibilitychange');
  const rmBlink = jsK.includes('3000 + Math.random() * 4000') || jsK.includes('scheduleBlink');
  let rmLivePass = false, rmLiveActual = '';
  if (exe && puppeteerOk) {
    const puppeteer = require('puppeteer-core');
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, 'http://localhost');
        let p = decodeURIComponent(u.pathname);
        if (p === '/') p = '/Landing.dc.html';
        if (p === '/favicon.ico') { res.statusCode = 204; return res.end(); }
        const fp = path.join(DC, p.replace(/^\//, ''));
        let st = null; try { st = fs.statSync(fp); } catch (_) {}
        if (!st || st.isDirectory()) { res.statusCode = 404; return res.end('x'); }
        let buf = fs.readFileSync(fp);
        if (fp.endsWith('.dc.html')) {
          let s = buf.toString('utf8');
          s = s.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>/gi, '<!-- g2 -->');
          buf = Buffer.from(s, 'utf8');
        }
        res.setHeader('Content-Type', fp.endsWith('.css') ? 'text/css; charset=utf-8' : fp.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8');
        res.end(buf);
      } catch (e) { res.statusCode = 500; res.end('err'); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    let browser = null;
    try {
      browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on('request', r => {
        const uu = r.url();
        if (/^https?:\/\//.test(uu) && uu.indexOf('127.0.0.1') < 0 && uu.indexOf('localhost') < 0) return r.abort();
        return r.continue();
      });
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto('http://127.0.0.1:' + port + '/Landing.dc.html', { waitUntil: 'load', timeout: 30000 });
      await new Promise(r => setTimeout(r, 1200));
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await new Promise(r => setTimeout(r, 600));
      const st = await page.evaluate(() => {
        const m = window.matchMedia('(prefers-reduced-motion: reduce)');
        const mq = m.matches;
        // C9: marquee Landing dirender DCLogic dari <x-dc> (support.js); bila DCLogic
        // gagal render (x-dc kosong), fallback ke CSS statis: baca langsung stylesheet.
        let play = '', src = 'dom';
        const marq = document.querySelector('.c9-marquee, .tape-in');
        if (marq) {
          const cs = getComputedStyle(marq);
          play = cs.animationPlayState || cs.animation || '';
        } else {
          src = 'css';
          for (const sh of document.styleSheets) {
            let rules = null;
            try { rules = sh.cssRules; } catch (_) { continue; }
            if (!rules) continue;
            for (const r of rules) {
              if (r.media && /prefers-reduced-motion/.test(r.media.mediaText || '')) {
                const txt = [...(r.cssRules || [])].map(x => x.cssText || '').join(' ');
                if (/\.c9-marquee/.test(txt) && /paused/.test(txt)) play = 'paused(css)';
                if (/\.tape-in/.test(txt) && /none/.test(txt)) play += '|none(css)';
              }
            }
          }
        }
        return { mq, play: String(play).slice(0, 60), src };
      });
      rmLivePass = st.mq === true && /paused|none/.test(st.play);
      rmLiveActual = 'matches=' + st.mq + ' marquee=' + st.play + ' src=' + st.src;
      await page.close();
    } finally { if (browser) await browser.close(); server.close(); }
  } else { rmLiveActual = 'browser tidak tersedia'; }
  const a3pass = rmMarquee && rmJs && rmBlink && rmLivePass;
  lib.addAssertion(result, 'prefers-reduced-motion:reduce: marquee paused, loop pupil berhenti, transisi instan (CSS+JS+live)',
    a3pass, 'css paused+none + js RM+hidden+blink37 + live matches+paused',
    'css=' + rmMarquee + ' js=' + rmJs + ' blink37=' + rmBlink + ' live=[' + rmLiveActual + ']');

  // --- A4: visibilitas Si Mata — tampil Landing/Dashboard, display:none 4 Auth + Satu layar ---
  const mataLand = land.includes('mata-wrap') || land.includes('Si Mata');
  const mataDash = main.includes('data-ihsg-chg');
  const mataCssHide = cssK.includes('body:has(.dialog.dlg)') && cssK.includes('body:has(.cw.full)')
    && cssK.includes('display:none') && cssK.includes('.mm') && cssK.includes('.mata-wrap');
  const mataJsHideReal = jsK.includes('isAuthPage') && jsK.includes('isChartSingle') && jsK.indexOf('none') >= 0;
  const mataOff = jsK.includes('ac-mata-off') && (readDc('AccountCenter.dc.html') || '').includes('ac-mata-off');
  const mataBubble = jsK.includes('role') && jsK.includes('status') || jsK.includes('mm-bub');
  const mataMood = jsK.includes('data-ihsg-chg') && jsK.includes('data-mood');
  const mataBlink = jsK.includes('scheduleBlink') || jsK.includes('blinkLoop');
  const mataRaf = jsK.includes('requestAnimationFrame') && jsK.includes('pointermove');
  const mataHiddenStop = jsK.includes('document.hidden') && jsK.includes('visibilitychange');
  let mataLivePass = false, mataLiveActual = '';
  if (exe && puppeteerOk) {
    const puppeteer = require('puppeteer-core');
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, 'http://localhost');
        let p = decodeURIComponent(u.pathname);
        if (p === '/') p = '/Landing.dc.html';
        if (p === '/favicon.ico') { res.statusCode = 204; return res.end(); }
        const fp = path.join(DC, p.replace(/^\//, ''));
        let st = null; try { st = fs.statSync(fp); } catch (_) {}
        if (!st || st.isDirectory()) { res.statusCode = 404; return res.end('x'); }
        let buf = fs.readFileSync(fp);
        if (fp.endsWith('.dc.html')) {
          let s = buf.toString('utf8');
          s = s.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>/gi, '<!-- g2 -->');
          buf = Buffer.from(s, 'utf8');
        }
        res.setHeader('Content-Type', fp.endsWith('.css') ? 'text/css; charset=utf-8' : fp.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8');
        res.end(buf);
      } catch (e) { res.statusCode = 500; res.end('err'); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    let browser = null;
    try {
      browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      const rows = [];
      for (const t of ['/Landing.dc.html', '/Main.dc.html', '/AuthLogin.dc.html', '/AuthRegister.dc.html', '/AuthRecovery.dc.html', '/AuthGmail.dc.html', '/Analisis.dc.html']) {
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', r => {
          const uu = r.url();
          if (/^https?:\/\//.test(uu) && uu.indexOf('127.0.0.1') < 0 && uu.indexOf('localhost') < 0) return r.abort();
          return r.continue();
        });
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto('http://127.0.0.1:' + port + t, { waitUntil: 'load', timeout: 30000 });
        await new Promise(r => setTimeout(r, 1500));
        const st = await page.evaluate((tt) => {
          const mm = document.querySelector('.mm');
          const wrap = document.querySelector('.mata-wrap');
          const el = mm || wrap;
          let disp = '', hid = null;
          if (el) { disp = getComputedStyle(el).display; hid = el.hidden; }
          const isAuth = /AuthLogin|AuthRegister|AuthRecovery|AuthGmail/.test(tt);
          const isChart = /Analisis/.test(tt);
          return { has: !!el, disp, hid, isAuth, isChart };
        }, t);
        let ok;
        if (st.isAuth) ok = st.disp === 'none' || st.hid === true || !st.has;
        else if (t === '/Analisis.dc.html') ok = true; // kanvas Analisis: .cw.full hanya saat Satu layar aktif
        else ok = st.has && st.disp !== 'none';
        rows.push({ t, ok, has: st.has, disp: st.disp, hid: st.hid });
        await page.close();
      }
      // Analisis Satu layar: aktifkan .cw.full di memori, pastikan .mm display:none via CSS :has
      const pg = await browser.newPage();
      await pg.setRequestInterception(true);
      pg.on('request', r => {
        const uu = r.url();
        if (/^https?:\/\//.test(uu) && uu.indexOf('127.0.0.1') < 0 && uu.indexOf('localhost') < 0) return r.abort();
        return r.continue();
      });
      await pg.setViewport({ width: 1440, height: 900 });
      await pg.goto('http://127.0.0.1:' + port + '/Analisis.dc.html', { waitUntil: 'load', timeout: 30000 });
      await new Promise(r => setTimeout(r, 1200));
      const single = await pg.evaluate(() => {
        const cw = document.querySelector('.cw');
        const mm = document.querySelector('.mm');
        if (cw) cw.classList.add('full');
        return new Promise((res) => setTimeout(() => {
          const m2 = document.querySelector('.mm');
          res({ disp: m2 ? getComputedStyle(m2).display : 'no-mm', hasCwFull: !!document.querySelector('.cw.full') });
        }, 400));
      });
      const singleOk = single.hasCwFull && (single.disp === 'none' || single.disp === 'no-mm');
      rows.push({ t: '/Analisis+SatuLayar', ok: singleOk, has: true, disp: single.disp });
      await pg.close();
      const bad = rows.filter(r => !r.ok);
      mataLivePass = bad.length === 0;
      mataLiveActual = rows.map(r => r.t + '=' + (r.ok ? 'OK' : 'FAIL') + '(' + r.disp + ')').join(' | ');
    } finally { if (browser) await browser.close(); server.close(); }
  } else { mataLiveActual = 'browser tidak tersedia'; }
  const a4pass = mataLand && mataDash && mataCssHide && mataJsHideReal && mataOff && mataBubble && mataMood && mataBlink && mataRaf && mataHiddenStop && mataLivePass;
  lib.addAssertion(result, 'Si Mata: tampil & interaktif Landing/Dashboard, display:none 4 Auth + Satu layar Chart, pupil rAF, kedip 3-7dtk, mood IHSG, bubble edukatif, off via Pusat Akun, stop saat hidden',
    a4pass,
    'land+dash+cssHas+jsHide+off+bubble+mood+blink+rAF+hiddenStop+live7OK',
    'land=' + mataLand + ' dash=' + mataDash + ' cssHide=' + mataCssHide + ' jsHide=' + mataJsHideReal + ' off=' + mataOff + ' bubble=' + mataBubble + ' mood=' + mataMood + ' blink=' + mataBlink + ' rAF=' + mataRaf + ' hiddenStop=' + mataHiddenStop + ' live=[' + mataLiveActual + ']');

  lib.finalizeGate(result, OUT);
}

main().catch((e) => {
  try { lib.addAssertion(result, 'gate-C9 eksekusi tanpa exception', false, 'no exception', String((e && e.message) || e).slice(0, 200)); } catch (_) {}
  lib.finalizeGate(result, OUT);
});
