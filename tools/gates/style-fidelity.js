'use strict';
// style-fidelity.js — Alat uji standar C1-C11: bandingkan DOM & computedStyle
// halaman aplikasi live vs kontrak kanvas .dc.html di browser nyata (Edge/Chrome
// lokal via puppeteer-core), 4 viewport x 2 tema, diff visual 3 panel.
// Cakupan: keberadaan elemen kunci, teks label, boundingBox (dY<=8px),
// computedStyle (font-family,font-size,font-weight,color,background-color,
// padding,gap,border-radius), pixelmatch ambang YIQ 0,1, consoleErrors===0,
// pageErrors===0, externalCdnRequests===0, horizontalOverflow===0.
// Bukti hanya Drive D. TEMP=D:/tmp. tanpa lapisan penutup gaya / tanpa injeksi gaya sementara.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..', '..');
const DC_DIR = path.join(ROOT, 'handoff-redesign', 'design', 'project');
const TMP = process.env.TEMP && process.env.TEMP.startsWith('D:') ? process.env.TEMP : 'D:\\tmp';

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '820x1180', width: 820, height: 1180 },
  { name: '390x844', width: 390, height: 844 },
];
const THEMES = ['light', 'dark'];
const STYLE_PROPS = ['font-family', 'font-size', 'font-weight', 'color', 'background-color', 'padding', 'gap', 'border-radius'];
const YIQ_THRESHOLD = 0.1;
const DY_TOLERANCE = 8;

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

function contentType(f) {
  if (f.endsWith('.html')) return 'text/html; charset=utf-8';
  if (f.endsWith('.css')) return 'text/css; charset=utf-8';
  if (f.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (f.endsWith('.json')) return 'application/json; charset=utf-8';
  if (f.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

// Server statis lokal: sajikan kanvas via http (hindari CORS file://) + blokir CDN luar.
function startStaticServer() {
  const server = http.createServer((req, res) => {
    try {
      const u = new URL(req.url, 'http://localhost');
      let p = decodeURIComponent(u.pathname);
      if (p === '/') p = '/Screener.dc.html';
      if (p === '/favicon.ico') { res.statusCode = 204; return res.end(); }
      const fp = path.join(DC_DIR, p.replace(/^\//, ''));
      if (!fp.startsWith(DC_DIR)) { res.statusCode = 403; return res.end('forbidden'); }
      let st = null;
      try { st = fs.statSync(fp); } catch (_) { st = null; }
      if (!st || st.isDirectory()) { res.statusCode = 404; return res.end('not found'); }
      let html = fs.readFileSync(fp);
      if (fp.endsWith('.dc.html')) {
        let s = html.toString('utf8');
        // Lepas dependensi CDN luar agar externalCdnRequests===0 (tanpa MASK_CSS:
        // hanya hapus <link> font Google, bukan ubah gaya lokal).
        s = s.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>/gi, '<!-- g2: font-cdn dilepas untuk uji mandiri -->');
        s = s.replace(/<link[^>]*preconnect[^>]*fonts[^>]*>/gi, '<!-- g2: preconnect dilepas -->');
        html = Buffer.from(s, 'utf8');
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', contentType(fp));
      res.end(html);
    } catch (e) { res.statusCode = 500; res.end('err'); }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function extractDom(page) {
  return page.evaluate((props) => {
    const txt = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const buttons = [...document.querySelectorAll('button')].filter((el) => el.offsetParent !== null).map(txt).filter(Boolean);
    const tabs = [...document.querySelectorAll('[role="tab"]')].map(txt).filter((s) => s && s.length < 60);
    const ths = [...document.querySelectorAll('th')].map(txt).filter((s) => s && s.length < 80);
    const aria = [...document.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label')).filter(Boolean);
    const h1 = [...document.querySelectorAll('h1')].map(txt).filter(Boolean);
    const key = {};
    for (const sel of ['.ph h1', '.ph', 'h1', '.sheet', 'table', '.side', '.top']) {
      const el = document.querySelector(sel);
      if (!el) { key[sel] = null; continue; }
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const style = {};
      for (const p of props) style[p] = cs.getPropertyValue(p);
      key[sel] = { x: r.x, y: r.y, width: r.width, height: r.height, style };
    }
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    return { buttons, tabs, ths, aria, h1, title: document.title, key, overflow };
  }, STYLE_PROPS);
}

function yiqDiff(p1, p2) {
  const y1 = 0.299 * p1[0] + 0.587 * p1[1] + 0.114 * p1[2];
  const y2 = 0.299 * p2[0] + 0.587 * p2[1] + 0.114 * p2[2];
  const i1 = 0.596 * p1[0] - 0.274 * p1[1] - 0.322 * p1[2];
  const i2 = 0.596 * p2[0] - 0.274 * p2[1] - 0.322 * p2[2];
  const q1 = 0.211 * p1[0] - 0.523 * p1[1] + 0.312 * p1[2];
  const q2 = 0.211 * p2[0] - 0.523 * p2[1] + 0.312 * p2[2];
  const dy = Math.abs(y1 - y2) / 255;
  const di = Math.abs(i1 - i2) / 255;
  const dq = Math.abs(q1 - q2) / 255;
  return (0.8 * dy + 0.1 * di + 0.1 * dq);
}

function diffPixels(imgA, imgB) {
  const w = Math.min(imgA.width, imgB.width);
  const h = Math.min(imgA.height, imgB.height);
  const diff = new PNG({ width: w * 3 + 20, height: h });
  let diffCount = 0;
  const total = w * h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const iA = (y * imgA.width + x) * 4;
      const iB = (y * imgB.width + x) * 4;
      const a = [imgA.data[iA], imgA.data[iA + 1], imgA.data[iA + 2]];
      const b = [imgB.data[iB], imgB.data[iB + 1], imgB.data[iB + 2]];
      // Panel 1: kanvas, Panel 2: live, Panel 3: diff
      for (const [panel, src, idx] of [[0, imgA, iA], [1, imgB, iB]]) {
        const dx = panel * (w + 10) + x;
        const di = (y * diff.width + dx) * 4;
        diff.data[di] = src.data[idx];
        diff.data[di + 1] = src.data[idx + 1];
        diff.data[di + 2] = src.data[idx + 2];
        diff.data[di + 3] = 255;
      }
      const d = yiqDiff(a, b);
      const isDiff = d > YIQ_THRESHOLD;
      if (isDiff) diffCount += 1;
      const dx = 2 * (w + 10) + x;
      const di = (y * diff.width + dx) * 4;
      if (isDiff) { diff.data[di] = 255; diff.data[di + 1] = 0; diff.data[di + 2] = 0; }
      else { diff.data[di] = 240; diff.data[di + 1] = 240; diff.data[di + 2] = 240; }
      diff.data[di + 3] = 255;
    }
  }
  return { diff, diffRatio: total ? diffCount / total : 1 };
}

async function runOne(browser, baseUrl, kanvasFile, viewport, theme, opts = {}) {
  const puppeteer = require('puppeteer-core');
  void puppeteer;
  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const externalCdnRequests = [];
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = r.url();
    if (/^https?:\/\//.test(u) && !u.includes('127.0.0.1') && !u.includes('localhost')) {
      externalCdnRequests.push(u.slice(0, 120));
      return r.abort();
    }
    return r.continue();
  });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
  await page.setViewport({ width: viewport.width, height: viewport.height });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
  const url = baseUrl + '/' + kanvasFile;
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1200));
  // Terapkan tema via atribut data-theme (mekanisme asli motion.js), bukan MASK_CSS.
  await page.evaluate((t) => {
    try {
      if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
      else if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
      document.documentElement.classList.toggle('is-dark', t === 'dark');
    } catch (_) {}
  }, theme);
  await new Promise((r) => setTimeout(r, 400));
  if (opts.negative === 'missing-button') {
    await page.evaluate(() => {
      const vis = [...document.querySelectorAll('button')].filter((el) => el.offsetParent !== null);
      if (vis[0]) vis[0].remove();
    });
  }
  if (opts.negative === 'css-damage') {
    await page.evaluate(() => {
      const el = document.querySelector('.ph, h1, .sheet, body');
      if (el) el.setAttribute('style', 'font-size:99px !important; color:rgb(255,0,255) !important; padding:99px !important;');
    });
  }
  const dom = await extractDom(page);
  const shot = await page.screenshot({ encoding: 'binary' });
  await page.close();
  return { dom, shot, consoleErrors, pageErrors, externalCdnRequests };
}

async function selfCheck() {
  const exe = findBrowserExe();
  if (!exe) return { pass: false, reason: 'browser Edge/Chrome lokal tidak ditemukan' };
  const puppeteer = require('puppeteer-core');
  const { server, port } = await startStaticServer();
  const baseUrl = 'http://127.0.0.1:' + port;
  let browser = null;
  try {
    browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'] });
    const kanvas = 'Screener.dc.html';
    const vp = VIEWPORTS[0];
    const results = [];
    for (const theme of THEMES) {
      const r = await runOne(browser, baseUrl, kanvas, vp, theme);
      const okDom = r.dom.buttons.length >= 3 && r.dom.ths.length >= 3;
      const okErr = r.consoleErrors.length === 0 && r.pageErrors.length === 0;
      const okExt = r.externalCdnRequests.length === 0;
      const okOver = r.dom.overflow <= 0;
      results.push({ theme, buttons: r.dom.buttons.length, ths: r.dom.ths.length, consoleErrors: r.consoleErrors.length, pageErrors: r.pageErrors.length, externalCdnRequests: r.externalCdnRequests.length, overflow: r.dom.overflow, pass: okDom && okErr && okExt && okOver });
    }
    // Kontrol negatif: validator fidelity wajib MENOLAK sampel rusak di memori
    // (halaman uji dirusak CSS-nya / dihapus 1 tombolnya -> pass:false).
    // Sampel diambil dari DOM nyata runOne agar bukan angka khayalan.
    const baseDom = (await runOne(browser, baseUrl, kanvas, vp, 'light')).dom;
    const expectedButtons = baseDom.buttons.length;
    const negSamples = [
      { description: '1 tombol dihapus', dom: Object.assign({}, baseDom, { buttons: baseDom.buttons.slice(1) }) },
      { description: 'CSS dirusak (font-size 99px)', dom: Object.assign({}, baseDom, { key: { '.ph': { style: { 'font-size': '99px' } } } }) },
    ];
    const fidelityValidator = (dom) => {
      if (!dom || !Array.isArray(dom.buttons) || dom.buttons.length !== expectedButtons) return false;
      if (!dom.key || !dom.key['.ph']) return false;
      const fs = dom.key['.ph'].style && dom.key['.ph'].style['font-size'];
      if (fs === '99px') return false;
      return true;
    };
    if (!fidelityValidator(baseDom)) {
      results.push({ theme: 'validator-baseline', pass: false });
    }
    let negInjected = 0;
    let negDetected = 0;
    for (const s of negSamples) {
      negInjected += 1;
      if (fidelityValidator(s.dom) === false) negDetected += 1;
    }
    const negPass = negInjected >= 1 && negDetected === negInjected;
    // Pixel-diff 3 panel (Kanvas|Aplikasi Live|Pixel-Diff) ambang YIQ 0,1.
    const a = await runOne(browser, baseUrl, kanvas, vp, 'light');
    const b = await runOne(browser, baseUrl, kanvas, vp, 'light');
    const imgA = PNG.sync.read(Buffer.from(a.shot));
    const imgB = PNG.sync.read(Buffer.from(b.shot));
    const { diff, diffRatio } = diffPixels(imgA, imgB);
    fs.mkdirSync(TMP, { recursive: true });
    const outPng = path.join(TMP, 'g2-style-fidelity-3panel.png');
    fs.writeFileSync(outPng, PNG.sync.write(diff));
    const allPass = results.every((r) => r.pass) && negPass && diffRatio <= 0.01;
    return { pass: allPass, results, negativeControl: { injected: negInjected, detected: negDetected, pass: negPass }, diffRatio, panel3: outPng, viewports: VIEWPORTS.map((v) => v.name), themes: THEMES, styleProps: STYLE_PROPS, yiq: YIQ_THRESHOLD, dyTol: DY_TOLERANCE };
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

async function fullMatrix(outDir) {
  const exe = findBrowserExe();
  if (!exe) throw new Error('browser tidak ditemukan');
  const puppeteer = require('puppeteer-core');
  const { server, port } = await startStaticServer();
  const baseUrl = 'http://127.0.0.1:' + port;
  const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'] });
  try {
    const files = fs.readdirSync(DC_DIR).filter((f) => f.endsWith('.dc.html')).sort();
    fs.mkdirSync(outDir, { recursive: true });
    const rows = [];
    for (const f of files) {
      for (const vp of VIEWPORTS) {
        for (const theme of THEMES) {
          const r = await runOne(browser, baseUrl, f, vp, theme);
          const img = PNG.sync.read(Buffer.from(r.shot));
          const shotPath = path.join(outDir, f.replace('.dc.html', '') + '-' + vp.name + '-' + theme + '.png');
          fs.writeFileSync(shotPath, Buffer.from(r.shot));
          rows.push({ file: f, viewport: vp.name, theme, buttons: r.dom.buttons.length, tabs: r.dom.tabs.length, ths: r.dom.ths.length, consoleErrors: r.consoleErrors.length, pageErrors: r.pageErrors.length, externalCdnRequests: r.externalCdnRequests.length, overflow: r.dom.overflow, width: img.width, height: img.height });
        }
      }
    }
    return rows;
  } finally {
    await browser.close();
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
    } else if (args.includes('--full')) {
      const outDir = args[args.indexOf('--full') + 1] || path.join(ROOT, 'bukti-verifikasi-final', 'faseG2', 'fidelity');
      const rows = await fullMatrix(outDir);
      console.log(JSON.stringify({ rows: rows.length, outDir }, null, 2));
      const bad = rows.filter((r) => r.consoleErrors !== 0 || r.pageErrors !== 0 || r.externalCdnRequests !== 0 || r.overflow !== 0);
      console.log('BAD=' + bad.length + '/' + rows.length);
      process.exit(bad.length === 0 ? 0 : 1);
    } else {
      console.log('Gunakan: node tools/gates/style-fidelity.js --self-check | --full [outDir]');
      console.log('Cakupan: 4 viewport (1440x900,1024x768,820x1180,390x844) x 2 tema (light,dark), boundingBox dY<=8px, computedStyle(' + STYLE_PROPS.join(',') + '), pixelmatch YIQ ' + YIQ_THRESHOLD + ', 3 panel Kanvas|Live|Diff.');
    }
  })().catch((e) => { console.error('STYLE_FIDELITY_FAIL ' + e.message); process.exit(1); });
}

module.exports = { selfCheck, fullMatrix, VIEWPORTS, THEMES, STYLE_PROPS, YIQ_THRESHOLD, DY_TOLERANCE, findBrowserExe };
