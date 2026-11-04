#!/usr/bin/env node
"use strict";
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const BASE = process.cwd();
const KONTRAK_PATH = path.join(BASE, 'bukti-verifikasi-final', 'fase02', 'kontrak-per-kanvas.json');
const SELISIH_OUT = path.join(BASE, 'bukti-verifikasi-final', 'fase02', 'selisih-struktur-kanvas.json');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9876;
const ROOT_URL = 'http://localhost:' + PORT;

const { diffHalaman } = require('./compare-dc-lib.js');
const kontrak = JSON.parse(fs.readFileSync(KONTRAK_PATH, 'utf8'));

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

const PAGE_MAP = {
  'Dashboard': { route: 'dashboard' },
  'Screener': { route: 'screener' },
  'Sektor Hot': { route: 'sektor' },
  'Catatan Admin': { route: 'catatan-admin' },
  'Analisis & Chart': { route: 'analisis', hash: 'analisis-chart' },
  'Bandarmologi': { route: 'analisis', hash: 'bandarmologi' },
  'Sinyal Intelijen': { route: 'analisis', hash: 'intel' },
  'Broker Hunter': { route: 'analisis', hash: 'hunter' },
  'Insider': { route: 'analisis', hash: 'insider' },
  'Ranking': { route: 'analisis', hash: 'ranking' },
  'Financial': { route: 'analisis', hash: 'financial' },
  'Struktur Pasar': { route: 'analisis', hash: 'market-structure' },
  'Pattern Radar': { route: 'analisis', hash: 'pattern' },
  'Watchlist': { route: 'watchlist' },
  'Portfolio': { route: 'portofolio' },
  'Track Record': { route: 'trackrecord' },
  'Kelola Keuangan': { route: 'kelola-keuangan' },
  'Admin Console': { route: 'admin-console' },
  'Pusat Akun': { route: 'account-center' },
  'Login': { route: 'landing', hash: 'login' },
  'Register': { route: 'landing', hash: 'register' },
  'Recovery': { route: 'landing', hash: 'recovery' },
  'Auth Gmail': { route: 'landing', hash: 'gmail' },
  'Landing': { route: 'landing' },
  'Maintenance': { route: 'maintenance' },
  'Ketentuan': { route: 'ketentuan' },
  'Mobile': { route: 'mobile' },
  'Mobile Screener': { route: 'mobile-screener' },
};

async function extractAppDOM(page, pageName) {
  return await page.evaluate((name) => {
    // Scope to the active (visible) page-content container
    let container = null;
    const pages = document.querySelectorAll('.page-content, [id^="page-"]');
    for (const p of pages) {
      if (p.offsetParent !== null && p.querySelector('h1, h2, table, .ph, .sheet')) {
        container = p; break;
      }
    }
    if (!container) container = document.body;
    const q = (sel) => container.querySelectorAll(sel);

    const r = { halaman: name };
    const h1s = container.querySelectorAll('h1');
    for (const h of h1s) {
      if (h.offsetParent !== null && h.textContent.trim()) {
        r.judul = h.textContent.trim().slice(0, 100); break;
      }
    }
    if (!r.judul) r.judul = '';
    const tabSet = new Set();
    container.querySelectorAll('[role="tab"]').forEach(el => {
      const t = el.textContent.trim();
      if (t && t.length < 60) tabSet.add(t);
    });
    container.querySelectorAll('[role="tablist"] button').forEach(el => {
      const t = el.textContent.trim();
      if (t && t.length < 60) tabSet.add(t);
    });
    r.tab = [...tabSet];
    const btnSet = new Set();
    container.querySelectorAll('button').forEach(el => {
      if (el.offsetParent !== null) {
        const t = el.textContent.trim();
        if (t && t.length < 120) btnSet.add(t.slice(0, 80));
      }
    });
    r.tombol = [...btnSet];
    const thSet = new Set();
    container.querySelectorAll('th').forEach(el => {
      const t = el.textContent.trim();
      if (t && t.length < 80) thSet.add(t);
    });
    r.kolom_tabel = [...thSet];
    let mc = 0;
    container.querySelectorAll('.lbl, .card, .metric-card, [data-metric]').forEach(el => {
      if (el.offsetParent !== null) mc++;
    });
    r.kartu_metrik = mc;
    const ariaSet = new Set();
    container.querySelectorAll('[aria-label]').forEach(el => {
      const v = el.getAttribute('aria-label');
      if (v && v.trim()) ariaSet.add(v.trim());
    });
    r.aria_labels = [...ariaSet];
    const komp = [];
    if (container.querySelector('canvas')) komp.push('canvas');
    if (container.querySelector('svg')) komp.push('svg');
    if (container.querySelector('details')) komp.push('details');
    if (container.querySelector('select')) komp.push('select');
    if (container.querySelector('input[type="date"]')) komp.push('input[type=date]');
    if (container.querySelector('input[type="checkbox"]')) komp.push('input[type=checkbox]');
    if (container.querySelector('[role="tablist"]')) komp.push('tablist');
    if (container.querySelector('.vbar, [class*="vbar"]')) komp.push('vbar');
    r.komponen_khusus = komp;
    return r;
  }, pageName);
}

async function main() {
  console.log('Starting static server on port ' + PORT + '...');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!filePath.startsWith('/')) filePath = '/' + filePath;
    const full = path.join(BASE, 'public', filePath);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const ext = path.extname(full).toLowerCase();
      const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(full).pipe(res);
    } else {
      res.writeHead(404); res.end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.listen(PORT, resolve);
    server.on('error', reject);
  });
  console.log('Static server running.');

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });
  console.log('Browser launched.');

  const perHalaman = {};
  let pagesChecked = 0;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    for (const [name, info] of Object.entries(PAGE_MAP)) {
      if (!kontrak.halaman[name]) {
        console.log('  SKIP (no kontrak):', name);
        continue;
      }
      console.log('Navigating to:', name, '->', info.route, info.hash || '');
      try {
        const hashPart = info.hash ? '#' + info.hash : '';
        const targetUrl = ROOT_URL + '/index.html#' + info.route + hashPart;
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await pause(2500);
        const appDOM = await extractAppDOM(page, name);
        perHalaman[name] = diffHalaman(kontrak.halaman[name], appDOM);
        pagesChecked++;
      } catch (e) {
        console.error('  FAILED:', name, e.message);
        perHalaman[name] = { error: e.message, elemen_hilang: [], elemen_berlebih: [], selisih_tab: { kanvas: [], aplikasi: [] } };
      }
    }

    await browser.close();
  } catch (e) {
    console.error('Fatal error:', e);
    try { await browser.close(); } catch (_) {}
  } finally {
    server.close();
  }

  const result = {
    total_kanvas: kontrak.total_kanvas,
    halaman_diperiksa: pagesChecked,
    checkedAt: new Date().toISOString(),
    per_halaman: perHalaman
  };
  fs.writeFileSync(SELISIH_OUT, JSON.stringify(result, null, 2));
  console.log('Written:', SELISIH_OUT);
  console.log('Pages checked:', pagesChecked, '/', kontrak.total_kanvas);
}

main().catch(e => { console.error(e); process.exit(1); });