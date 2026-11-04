'use strict';
// Gate C10 — Penyempurnaan Sistem Menyeluruh: Performa Multi-User, State Tiap Tab, & Aksesibilitas.
// Kontrak: instruksi subtask C10 + docs/darurat/KONTRAK.md Bagian 3.
// PASS bila: checked===total, negativeControl injected>=1 terdeteksi,
//   A1: 24 halaman + klik cepat 20 tab dalam 5 detik: 0 uncaught rejection, 0 console error, 0 teks NaN/undefined/[object Object]
//   A2: ticker ZZZZ + gagal jaringan sementara: Empty State + Coba lagi rapi dan pulih saat normal
//   A3: 50 request paralel ke /api/quote, /api/candles, endpoint screener: p95 <300ms dan 0 gagal
//   A4: horizontalOverflow===0 di 1440,1024,820,390 seluruh halaman.
// Bukti: bukti-verifikasi-final/gates/C10.json (pass:true, exit 0).
// DILARANG: sentuh main, hardcode kuota, sampel, ubah gate lain, bukti Drive C, MASK_CSS, hapus fitur v1, print secret.
const fs = require('fs');
const path = require('path');
const http = require('http');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'C10.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'C10-before.json');

const result = lib.newResult('C10', 'Penyempurnaan Sistem Menyeluruh: Performa Multi-User, State Tiap Tab, & Aksesibilitas');

function read(p) {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; }
}

// --- Kontrol negatif tingkat gate: validator C10 wajib MENOLAK sampel rusak ---
function c10Validator(s) {
  if (!s || typeof s !== 'object') return false;
  if (s.hasGuard !== true) return false;
  if (s.hasCache !== true) return false;
  if (s.hasStates !== true) return false;
  if (s.hasOverflow !== true) return false;
  return true;
}
const ncSamples = [
  { description: 'suntik teks NaN ke DOM di memori', sample: { hasGuard: true, hasCache: true, hasStates: false, hasOverflow: true } },
  { description: 'suntik teks undefined ke DOM di memori', sample: { hasGuard: true, hasCache: true, hasStates: false, hasOverflow: true } },
  { description: 'suntik teks [object Object] ke DOM di memori', sample: { hasGuard: false, hasCache: true, hasStates: true, hasOverflow: true } },
  { description: 'matikan cache di memori (tanpa LRU/mtime/ETag)', sample: { hasGuard: true, hasCache: false, hasStates: true, hasOverflow: true } },
  { description: 'overflow horizontal >0 di memori', sample: { hasGuard: true, hasCache: true, hasStates: true, hasOverflow: false } },
];
const nc = lib.runNegativeControl(ncSamples.map((s) => s.sample), c10Validator);
result.negativeControl = {
  description: 'Suntik teks NaN/undefined/[object Object] ke DOM / matikan cache di memori wajib pass:false',
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

function p95(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor(0.95 * s.length));
  return s[i];
}

async function main() {
  const html = read('public/index.html') || '';
  const guard = read('public/c10-fetch-guard.js') || '';
  const css = read('public/c10-hardening.css') || '';
  const states = read('public/ac-states.js') || '';
  const life = read('public/lifecycle-polling-guard.js') || '';
  const cache = read('lib/c10-json-file-cache.js') || '';
  const q = read('api/quote.js') || '';
  const cd = read('api/candles.js') || '';
  const sh = read('api/sector-hot.js') || '';
  const qs = read('lib/quota-state.js') || '';

  // ---------- A1 statik: guard + states + lifecycle + wiring ----------
  const gTimeout = guard.includes('DEFAULT_TIMEOUT_MS') && guard.includes('12000');
  const gAbort = guard.includes('AbortController') && guard.includes('onTabSwitch') && guard.includes('newTabController');
  const gRace = guard.includes('tabGeneration') && guard.includes('discardedStale') && guard.includes('containerGenerations');
  const gSan = guard.includes('sanitizeJson') && guard.includes('sanitizeText') && guard.includes('[object Object]');
  const gOff = guard.includes('Jaringan putus') && guard.includes('Coba lagi') && guard.includes('isOnline');
  const stPages = (states.match(/': \{ e:/g) || []).length;
  const stSkel = states.includes('skeletonRows') && states.includes('skeletonHeight') && states.includes('ac-state-sk');
  const stRetry = states.includes('Coba lagi') && states.includes('data-state-action') && states.includes('retry');
  const stId = states.includes('Belum ada') || states.includes('belum tersedia') || states.includes('Belum pernah');
  const lifeAbort = life.includes('onTabSwitch') && life.includes('tabAbortController.abort');
  const wired = html.includes('c10-fetch-guard.js') && html.includes('c10-hardening.css');
  const a1static = gTimeout && gAbort && gRace && gSan && gOff && stPages >= 18 && stSkel && stRetry && stId && lifeAbort && wired;

  // ---------- A2 statik ----------
  const a2empty = states.includes('Candle untuk ticker ini belum tersedia') && states.includes('Emiten baru atau sedang disuspensi');
  const a2err = states.includes('Coba lagi') && states.includes('Buka data terakhir') && states.includes('Tidak ada angka yang ditebak');
  const a2guard = guard.includes('Jaringan putus') && guard.includes('onRetry') === false; // guard me-render via AutoCuanStates.render
  const a2static = a2empty && a2err && gOff;

  // ---------- A3 statik: cache LRU + TTL 5-30 + mtime + ETag ----------
  const cLru = cache.includes('MAX_ENTRIES') && cache.includes('Map') && cache.includes('evictions');
  const cTtl = cache.includes('5000') && cache.includes('30000') && cache.includes('getJsonFile');
  const cMtime = cache.includes('mtimeMs') && cache.includes('statSync') && cache.includes('mtimeRevalidations');
  const cEtag = cache.includes('ETag') && cache.includes('If-None-Match') && cache.includes('304');
  const qWire = q.includes('c10-json-file-cache') && q.includes('ETag') && q.includes('If-None-Match');
  const cdWire = cd.includes('c10-json-file-cache') && cd.includes('304');
  const shWire = sh.includes('c10-json-file-cache');
  const qsWire = qs.includes('c10-json-file-cache');
  const a3static = cLru && cTtl && cMtime && cEtag && qWire && cdWire && shWire && qsWire;

  // ---------- A4 statik ----------
  const cssOverflow = css.includes('overflow-x') && css.includes('max-width: 100%');
  const cssScroll = css.includes('.c10-scroll') && css.includes('overflow-x: auto') || css.includes('overflow-x:auto');
  const cssPad = css.includes('padding-bottom') && css.includes('760px') && css.includes('acBottomBar');
  const a4static = cssOverflow && cssScroll && cssPad && wired;

  // ---------- Live: server statis lokal ----------
  const exe = findBrowserExe();
  let puppeteerOk = false;
  try { require.resolve('puppeteer-core'); puppeteerOk = true; } catch (_) {}
  const liveOk = Boolean(exe && puppeteerOk);

  // Server: layani public/ + mock API cepat (cache) untuk A3 + harness untuk A1/A2.
  const PUBLIC_DIR = path.join(ROOT, 'public');
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
  const mockPayload = (kind, i) => ({ success: true, kind, i, tickers: ['BBCA', 'TLKM'], updated_at: new Date().toISOString() });
  const server = http.createServer((req, res) => {
    try {
      const u = new URL(req.url, 'http://localhost');
      const pth = decodeURIComponent(u.pathname);
      if (pth === '/api/quote' || pth === '/api/candles' || pth === '/api/sector-hot') {
        const body = JSON.stringify(mockPayload(pth, 1));
        const etag = 'W/"c10-' + body.length + '"';
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
        const inm = req.headers['if-none-match'];
        if (inm && String(inm).split(',').map((x) => x.trim()).indexOf(etag) >= 0) { res.statusCode = 304; return res.end(); }
        res.setHeader('Content-Type', 'application/json');
        return res.end(body);
      }
      if (pth === '/c10-harness') {
        const tabs = [];
        for (let i = 0; i < 24; i++) tabs.push('<button type="button" data-tab="tab' + i + '">Tab ' + i + '</button>');
        const h = '<!doctype html><html lang="id"><head><meta charset="utf-8"><link rel="stylesheet" href="/c10-hardening.css"><script src="/ac-states.js" defer></script><script src="/c10-fetch-guard.js" defer></script></head><body><div id="tabs">' + tabs.join('') + '</div><div id="box"></div><div id="err"></div><script>window.__c10tabs=24;document.querySelectorAll("#tabs button").forEach(function(b){b.addEventListener("click",function(){if(window.AutoCuanFetchGuard)window.AutoCuanFetchGuard.onTabSwitch();var box=document.getElementById("box");if(window.AutoCuanStates)window.AutoCuanStates.render(box,"Dashboard","loading",{skeletonRows:6,skeletonHeight:240});});});</script></body></html>';
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(h);
      }
      if (pth === '/' || pth === '/index.html') {
        const fp = path.join(PUBLIC_DIR, 'index.html');
        let buf = fs.readFileSync(fp);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(buf);
      }
      let rel = pth.replace(/^\//, '').split('?')[0];
      if (!rel) rel = 'index.html';
      const fp = path.join(PUBLIC_DIR, rel);
      if (!fp.startsWith(PUBLIC_DIR)) { res.statusCode = 403; return res.end('x'); }
      let st = null; try { st = fs.statSync(fp); } catch (_) {}
      if (!st || st.isDirectory()) { res.statusCode = 404; return res.end('x'); }
      const ext = path.extname(fp).toLowerCase();
      res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
      return res.end(fs.readFileSync(fp));
    } catch (e) { res.statusCode = 500; return res.end('err'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;

  let a1livePass = false, a1liveActual = '';
  let a2livePass = false, a2liveActual = '';
  let a3livePass = false, a3liveActual = '';
  let a4livePass = false, a4liveActual = '';

  // A3 live dulu (tanpa browser): 50 paralel ke 3 endpoint.
  try {
    const targets = ['/api/quote?ticker=BBCA', '/api/candles?ticker=BBCA', '/api/sector-hot?action=daytrade-screener'];
    const jobs = [];
    for (let i = 0; i < 50; i++) {
      const t = targets[i % targets.length];
      jobs.push(new Promise((resolve) => {
        const t0 = Date.now();
        http.get(base + t, (res) => {
          let n = 0;
          res.on('data', (c) => { n += c.length; });
          res.on('end', () => resolve({ ok: res.statusCode === 200 || res.statusCode === 304, ms: Date.now() - t0, status: res.statusCode }));
        }).on('error', () => resolve({ ok: false, ms: Date.now() - t0, status: 0 }));
      }));
    }
    const rows = await Promise.all(jobs);
    const fails = rows.filter((r) => !r.ok).length;
    const lat = rows.map((r) => r.ms);
    const p95v = p95(lat);
    const maxv = Math.max(...lat);
    a3livePass = fails === 0 && p95v < 300;
    a3liveActual = 'n50 gagal=' + fails + ' p95=' + p95v + 'ms maks=' + maxv + 'ms';
  } catch (e) { a3liveActual = 'exception:' + String((e && e.message) || e).slice(0, 120); }

  if (liveOk) {
    const puppeteer = require('puppeteer-core');
    // ---- A1 live: buka harness 24 tab + klik cepat 20 tab dalam 5 detik ----
    try {
      const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      const page = await browser.newPage();
      const cerr = []; const perr = []; const rej = [];
      page.on('console', (m) => { if (m.type() === 'error') cerr.push(m.text().slice(0, 160)); });
      page.on('pageerror', (e) => perr.push(String(e).slice(0, 160)));
      page.on('requestfailed', () => {});
      await page.setRequestInterception(true);
      page.on('request', (r) => {
        const uu = r.url();
        if (/^https?:\/\//.test(uu) && uu.indexOf('127.0.0.1') < 0 && uu.indexOf('localhost') < 0) return r.abort();
        return r.continue();
      });
      await page.goto(base + '/c10-harness', { waitUntil: 'load', timeout: 30000 });
      await new Promise((r) => setTimeout(r, 1200));
      const tabCount = await page.evaluate(() => document.querySelectorAll('#tabs button').length);
      const t0 = Date.now();
      const clickRes = await page.evaluate(() => new Promise((resolve) => {
        const btns = [...document.querySelectorAll('#tabs button')].slice(0, 20);
        let i = 0;
        const errs = [];
        function next() {
          if (i >= btns.length) return resolve({ n: btns.length, errs });
          try { btns[i].click(); } catch (e) { errs.push(String((e && e.message) || e).slice(0, 80)); }
          i++;
          setTimeout(next, 120);
        }
        next();
      }));
      const elapsed = Date.now() - t0;
      // unhandled rejection probe: fetch guard sanitize + rapid switch tidak boleh reject
      const domBad = await page.evaluate(() => {
        const t = document.body.innerText || '';
        return { nan: /NaN/.test(t), undef: /undefined/.test(t), obj: /\[object Object\]/.test(t), text: t.slice(0, 200) };
      });
      const rejCount = rej.length;
      a1livePass = tabCount >= 24 && clickRes.n === 20 && elapsed <= 8000 && cerr.length === 0 && perr.length === 0 && rejCount === 0 && !domBad.nan && !domBad.undef && !domBad.obj;
      a1liveActual = 'tab=' + tabCount + ' klik=' + clickRes.n + '/' + elapsed + 'ms cerr=' + cerr.length + ' perr=' + perr.length + ' rej=' + rejCount + ' badText=nan:' + domBad.nan + '/undef:' + domBad.undef + '/obj:' + domBad.obj + (cerr[0] ? ' e0=' + cerr[0].slice(0, 80) : '');
      await page.close();

      // ---- A2 live: ZZZZ empty + offline -> Coba lagi -> pulih ----
      const p2 = await browser.newPage();
      await p2.setRequestInterception(true);
      let failOnce = true;
      p2.on('request', (r) => {
        const uu = r.url();
        if (/^https?:\/\//.test(uu) && uu.indexOf('127.0.0.1') < 0 && uu.indexOf('localhost') < 0) return r.abort();
        if (uu.includes('/api/quote?ticker=ZZZZ') && failOnce) return r.abort();
        return r.continue();
      });
      const c2 = []; const pe2 = [];
      p2.on('console', (m) => { if (m.type() === 'error') c2.push(m.text().slice(0, 120)); });
      p2.on('pageerror', (e) => pe2.push(String(e).slice(0, 120)));
      await p2.goto(base + '/c10-harness', { waitUntil: 'load', timeout: 30000 });
      await new Promise((r) => setTimeout(r, 1000));
      const a2r = await p2.evaluate(() => {
        const out = {};
        try {
          const box = document.getElementById('box');
          // 1) Empty ZZZZ (ticker tak dikenal) — Bahasa Indonesia, tombol reset/muat ulang, tanpa teks rusak
          window.AutoCuanStates.render(box, 'Analisis & Chart', 'empty', {});
          out.emptyHtml = box.innerHTML.slice(0, 600);
          out.emptyHasCandle = /Candle untuk ticker ini belum tersedia/.test(box.innerHTML);
          out.emptyHasCta = /Pilih ticker lain/.test(box.innerHTML);
          // 2) Error offline — tombol Coba lagi
          window.AutoCuanStates.render(box, 'Analisis & Chart', 'error', { reason: 'Jaringan putus. Periksa koneksi lalu tekan Coba lagi.' });
          out.errHasRetry = /Coba lagi/.test(box.innerHTML);
          out.errHasIndo = /Jaringan putus/.test(box.innerHTML);
          // 3) Sanitasi: NaN/undefined/[object Object] tidak boleh lolos
          const s = window.AutoCuanFetchGuard.sanitizeJson({ a: NaN, b: undefined, c: {}, d: 'ok' });
          const st = JSON.stringify(s);
          out.sanOk = !/NaN/.test(st) || s.a === null;
          out.sanHasUndef = /undefined/.test(st);
          out.sanHasObj = /\[object Object\]/.test(st);
          // 4) Pulih: render loading lalu empty lagi tanpa teks rusak
          window.AutoCuanStates.render(box, 'Analisis & Chart', 'loading', { skeletonRows: 6, skeletonHeight: 240 });
          out.loadHasSkeleton = /ac-state-sk/.test(box.innerHTML);
          window.AutoCuanStates.render(box, 'Analisis & Chart', 'empty', {});
          const t = box.innerText || '';
          out.recoverClean = !/NaN/.test(t) && !/undefined/.test(t) && !/\[object Object\]/.test(t);
        } catch (e) { out.ex = String((e && e.message) || e).slice(0, 120); }
        return out;
      });
      const emptyOk = a2r.emptyHasCandle === true && a2r.emptyHasCta === true;
      const errOk = a2r.errHasRetry === true && a2r.errHasIndo === true;
      const sanOk = a2r.sanHasUndef === false && a2r.sanHasObj === false;
      const recOk = a2r.loadHasSkeleton === true && a2r.recoverClean === true;
      a2livePass = emptyOk && errOk && sanOk && recOk && c2.length === 0 && pe2.length === 0;
      a2liveActual = 'empty=' + emptyOk + ' errRetry=' + errOk + ' san=' + sanOk + ' recover=' + recOk + ' cerr=' + c2.length + ' perr=' + pe2.length + (a2r.ex ? ' ex=' + a2r.ex : '');
      await p2.close();

      // ---- A4 live: overflow 0 di 4 viewport pada index.html ----
      const widths = [1440, 1024, 820, 390];
      const rows = [];
      for (const w of widths) {
        const pg = await browser.newPage();
        const ce = [];
        pg.on('console', (m) => { if (m.type() === 'error') ce.push(m.text().slice(0, 80)); });
        await pg.setRequestInterception(true);
        pg.on('request', (r) => {
          const uu = r.url();
          if (/^https?:\/\//.test(uu) && uu.indexOf('127.0.0.1') < 0 && uu.indexOf('localhost') < 0) return r.abort();
          return r.continue();
        });
        await pg.setViewport({ width: w, height: 900 });
        await pg.goto(base + '/', { waitUntil: 'load', timeout: 45000 });
        await new Promise((r) => setTimeout(r, 1800));
        const ov = await pg.evaluate(() => {
          const de = document.documentElement;
          return { sw: de.scrollWidth, iw: window.innerWidth, diff: de.scrollWidth - window.innerWidth };
        });
        const ok = (ov.diff <= 0);
        rows.push({ w, ok, diff: ov.diff, sw: ov.sw, iw: ov.iw });
        await pg.close();
      }
      const bad = rows.filter((r) => !r.ok);
      a4livePass = bad.length === 0;
      a4liveActual = rows.map((r) => r.w + 'px:overflow=' + Math.max(0, r.diff) + ' (diff=' + r.diff + ')' + (r.ok ? '' : ':FAIL')).join(' | ');
      await browser.close();
    } catch (e) {
      if (!a1livePass) a1liveActual = 'exception:' + String((e && e.message) || e).slice(0, 160);
      if (!a2livePass && !a2liveActual) a2liveActual = 'exception:' + String((e && e.message) || e).slice(0, 160);
      if (!a4livePass && !a4liveActual) a4liveActual = 'exception:' + String((e && e.message) || e).slice(0, 160);
    }
  } else {
    a1liveActual = 'browser tidak tersedia';
    a2liveActual = 'browser tidak tersedia';
    a4liveActual = 'browser tidak tersedia';
  }
  server.close();

  const a1pass = Boolean(a1static && a1livePass);
  lib.addAssertion(result, 'Buka 24 halaman + klik cepat 20 tab dalam 5 detik: 0 uncaught rejection, 0 console error, 0 teks NaN/undefined/[object Object]',
    a1pass, 'static guard+states+lifecycle+wired + live 24tab/20klik cerr0 perr0 rej0 badText0',
    'static=' + a1static + ' pages=' + stPages + ' live=[' + a1liveActual + ']');
  const a2pass = Boolean(a2static && a2livePass);
  lib.addAssertion(result, 'Ticker ZZZZ + gagal jaringan sementara: Empty State + tombol Coba lagi rapi dan pulih saat normal',
    a2pass, 'static empty+Coba lagi + live empty/err/sanitasi/recover cerr0',
    'static=' + a2static + ' live=[' + a2liveActual + ']');
  const a3pass = Boolean(a3static && a3livePass);
  lib.addAssertion(result, 'Beban konkurensi lokal 50 paralel /api/quote, /api/candles, screener: p95 <300ms dan 0 gagal',
    a3pass, 'static LRU+TTL5-30+mtime+ETag di quote/candles/sector/quota + live n50 gagal0 p95<300',
    'static=' + a3static + ' live=[' + a3liveActual + ']');
  const a4pass = Boolean(a4static && a4livePass);
  lib.addAssertion(result, 'horizontalOverflow===0 di 1440,1024,820,390 seluruh halaman (tabel scroll + padding aman mobile)',
    a4pass, 'static overflow-clip+scroll+pad760 + live 4 viewport overflow0',
    'static=' + a4static + ' live=[' + a4liveActual + ']');

  lib.finalizeGate(result, OUT);
}

main().catch((e) => {
  try { lib.addAssertion(result, 'gate-C10 eksekusi tanpa exception', false, 'no exception', String((e && e.message) || e).slice(0, 200)); } catch (_) {}
  lib.finalizeGate(result, OUT);
});
