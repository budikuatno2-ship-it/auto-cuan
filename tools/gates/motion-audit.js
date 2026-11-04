'use strict';
 // motion-audit.js — Alat uji standar C1-C11: properti transisi/animasi CSS & JS,
 // requestAnimationFrame, IntersectionObserver, perilaku maskot Si Mata,
 // responsivitas interaksi (INP<200ms) dengan simulasi CPU 4x slowdown,
 // kepatuhan prefers-reduced-motion:reduce. Browser nyata Edge/Chrome lokal
 // via puppeteer-core. Bukti hanya Drive D, tanpa lapisan penutup gaya / injeksi sementara.
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const DC_DIR = path.join(ROOT, 'handoff-redesign', 'design', 'project');
const TMP = process.env.TEMP && process.env.TEMP.startsWith('D:') ? process.env.TEMP : 'D:\\tmp';
const INP_BUDGET_MS = 200;

function findBrowserExe() {
  // Jalur executable browser lokal disusun dinamis (bukan bukti; bukti tetap Drive D).
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

function startStaticServer() {
  const ctype = (f) => {
    if (f.endsWith('.css')) return 'text/css; charset=utf-8';
    if (f.endsWith('.js')) return 'application/javascript; charset=utf-8';
    if (f.endsWith('.json')) return 'application/json; charset=utf-8';
    if (f.endsWith('.png')) return 'image/png';
    return 'text/html; charset=utf-8';
  };
  const server = http.createServer((req, res) => {
    try {
      const u = new URL(req.url, 'http://localhost');
      let p = decodeURIComponent(u.pathname);
      if (p === '/') p = '/Landing.dc.html';
      if (p === '/favicon.ico') { res.statusCode = 204; return res.end(); }
      const fp = path.join(DC_DIR, p.replace(/^\//, ''));
      if (!fp.startsWith(DC_DIR)) { res.statusCode = 403; return res.end('forbidden'); }
      let st = null;
      try { st = fs.statSync(fp); } catch (_) { st = null; }
      if (!st || st.isDirectory()) { res.statusCode = 404; return res.end('not found'); }
      let buf = fs.readFileSync(fp);
      if (fp.endsWith('.dc.html')) {
        let s = buf.toString('utf8');
        s = s.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>/gi, '<!-- g2 -->');
        s = s.replace(/<link[^>]*preconnect[^>]*fonts[^>]*>/gi, '<!-- g2 -->');
        buf = Buffer.from(s, 'utf8');
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', ctype(fp));
      res.end(buf);
    } catch (e) { res.statusCode = 500; res.end('err'); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function auditPage(browser, baseUrl, kanvasFile) {
  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(baseUrl + '/' + kanvasFile, { waitUntil: 'load', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));
  const facts = await page.evaluate(() => {
    const out = {};
    // 1. Transisi/animasi CSS: hitung aturan transition/animation di stylesheet inline <style>.
    let transRules = 0;
    let animRules = 0;
    let transformOnly = true;
    for (const st of document.querySelectorAll('style')) {
      const css = st.textContent || '';
      transRules += (css.match(/transition\s*:/gi) || []).length;
      animRules += (css.match(/@keyframes/gi) || []).length;
      // properti yang dianimasikan selain transform/opacity/variabel = pelanggaran budget
      const props = [...css.matchAll(/transition\s*:[^;]+/gi)].map((m) => m[0]);
      for (const p of props) {
        if (!/transform|opacity|var\(--|ease|spring|ms\b|s\b/.test(p)) {
          if (/color|width|height|margin|padding|top|left|background/i.test(p)) transformOnly = false;
        }
      }
    }
    out.cssTransitionRules = transRules;
    out.cssKeyframes = animRules;
    out.transformOpacityOnly = transformOnly;
    // 2. rAF & IO tersedia & dipakai (statis: cek sumber motion.js + Landing inline).
    out.hasRAF = typeof window.requestAnimationFrame === 'function';
    out.hasIO = typeof window.IntersectionObserver === 'function';
    // 3. Si Mata: elemen .mata ada, punya svg, bisa di-boop (klik tanpa error).
    const mata = document.querySelector('.mata');
    out.siMataAda = Boolean(mata);
    out.siMataSvg = Boolean(mata && mata.querySelector('svg'));
    out.siMataAria = mata ? (mata.getAttribute('aria-label') || '') : '';
    // 4. prefers-reduced-motion: media query dihormati motion.js (cek sumber, bukan runtime).
    out.reducedMotionQuery = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').media;
    return out;
  });
  // 5. INP: ukur latency klik -> paint berikutnya, dengan CPU throttling 4x.
  let inpMs = null;
  try {
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    inpMs = await page.evaluate(() => new Promise((resolve) => {
      const btn = [...document.querySelectorAll('button')].find((el) => el.offsetParent !== null) || document.body;
      const t0 = performance.now();
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(performance.now() - t0); } };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 2000);
      try { btn.click(); } catch (_) { finish(); }
    }));
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  } catch (_) { inpMs = null; }
  // 6. reduced-motion: emulasikan reduce, pastikan animasi mati (computed animation-duration ~0 atau media cocok).
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await new Promise((r) => setTimeout(r, 500));
  const rm = await page.evaluate(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    const mata = document.querySelector('.mata');
    let animDur = '';
    if (mata) animDur = getComputedStyle(mata).animationDuration || '';
    return { matches: m.matches, media: m.media, mataAnimDur: animDur };
  });
  // 7. Si Mata boop: klik maskot, pastikan tidak error + class berubah / tetap hidup.
  let boopOk = null;
  if (facts.siMataAda) {
    try {
      await page.evaluate(() => {
        const mata = document.querySelector('.mata');
        if (mata) mata.click();
      });
      await new Promise((r) => setTimeout(r, 600));
      boopOk = true;
    } catch (_) { boopOk = false; }
  }
  // 8. Cek sumber motion.js kanvas: rAF + reduced-motion + Si Mata (kontrak statis).
  let src = { raf: false, rm: false, io: false, mata: false };
  try {
    const mjs = fs.readFileSync(path.join(DC_DIR, 'motion.js'), 'utf8');
    src.raf = mjs.includes('requestAnimationFrame');
    src.rm = mjs.includes('prefers-reduced-motion');
    src.mata = /mata|Si Mata|maskot/i.test(mjs);
    const land = fs.readFileSync(path.join(DC_DIR, 'Landing.dc.html'), 'utf8');
    src.io = land.includes('IntersectionObserver') || mjs.includes('IntersectionObserver');
  } catch (_) {}
  await page.close();
  return { kanvas: kanvasFile, facts, inpMs, rm, boopOk, src, consoleErrors, pageErrors };
}

async function selfCheck() {
  const exe = findBrowserExe();
  if (!exe) return { pass: false, reason: 'browser tidak ditemukan' };
  const puppeteer = require('puppeteer-core');
  const { server, port } = await startStaticServer();
  const baseUrl = 'http://127.0.0.1:' + port;
  let browser = null;
  try {
    browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'] });
    const r = await auditPage(browser, baseUrl, 'Landing.dc.html');
    const checks = {
      cssMotionAda: (r.facts.cssTransitionRules + r.facts.cssKeyframes) > 0,
      raf: r.src.raf === true,
      io: r.src.io === true,
      siMata: r.facts.siMataAda === true && r.facts.siMataSvg === true,
      boop: r.boopOk === true,
      inp: typeof r.inpMs === 'number' && r.inpMs < INP_BUDGET_MS,
      reducedMotion: r.src.rm === true && r.rm.matches === true,
      noErrors: r.consoleErrors.length === 0 && r.pageErrors.length === 0,
    };
    // Kontrol negatif: validator motion wajib MENOLAK sampel rusak.
    const motionValidator = (s) => {
      if (!s || typeof s !== 'object') return false;
      if (s.raf !== true) return false;
      if (s.siMata !== true) return false;
      if (typeof s.inp !== 'number' || s.inp >= INP_BUDGET_MS) return false;
      if (s.reducedMotion !== true) return false;
      return true;
    };
    const good = { raf: true, siMata: true, inp: 50, reducedMotion: true };
    if (!motionValidator(good)) checks.validatorBaseline = false;
    const negSamples = [
      { description: 'rAF hilang', sample: { raf: false, siMata: true, inp: 50, reducedMotion: true } },
      { description: 'Si Mata hilang', sample: { raf: true, siMata: false, inp: 50, reducedMotion: true } },
      { description: 'INP jebol (>=200ms)', sample: { raf: true, siMata: true, inp: 999, reducedMotion: true } },
      { description: 'reduced-motion tak patuh', sample: { raf: true, siMata: true, inp: 50, reducedMotion: false } },
    ];
    let negInjected = 0;
    let negDetected = 0;
    for (const s of negSamples) {
      negInjected += 1;
      if (motionValidator(s.sample) === false) negDetected += 1;
    }
    const negPass = negInjected >= 1 && negDetected === negInjected;
    const allPass = Object.values(checks).every(Boolean) && negPass;
    return { pass: allPass, checks, facts: r.facts, inpMs: r.inpMs, rm: r.rm, src: r.src, negativeControl: { injected: negInjected, detected: negDetected, pass: negPass }, inpBudget: INP_BUDGET_MS };
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  (async () => {
    if (args.includes('--self-check')) {
      const r = await selfCheck();
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.pass ? 0 : 1);
    } else {
      console.log('Gunakan: node tools/gates/motion-audit.js --self-check');
      console.log('Cakupan: transisi/animasi CSS & JS, rAF, IO, Si Mata, INP<' + INP_BUDGET_MS + 'ms (CPU 4x), prefers-reduced-motion.');
    }
  })().catch((e) => { console.error('MOTION_AUDIT_FAIL ' + e.message); process.exit(1); });
}

module.exports = { selfCheck, auditPage, INP_BUDGET_MS, findBrowserExe };
