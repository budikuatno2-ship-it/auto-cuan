#!/usr/bin/env node
'use strict';
// Probe C11 lanjutan: 390 overflow, recovery modal, admin tabs, financial/chart/screener/bandar hooks.
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
function sendJ(res, code, o) { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); }
const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const pth = decodeURIComponent(u.pathname);
    if (pth === '/api/reset-password' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let j = {};
        try { j = JSON.parse(body || '{}'); } catch (_) {}
        if (j.action === 'session-status') return sendJ(res, 200, { success: true, userId: 'u-budi', username: 'budi', isAdmin: true });
        return sendJ(res, 200, { success: true });
      });
      return;
    }
    if (pth === '/api/login-user') return sendJ(res, 200, { success: true });
    if (pth === '/api/sector-hot') return sendJ(res, 200, { success: true, results: [], sectors: [], signals: [] });
    if (pth === '/api/quote') return sendJ(res, 200, { success: true });
    if (pth === '/api/candles') return sendJ(res, 200, { success: true, candles: [] });
    if (pth === '/api/track-record') return sendJ(res, 200, { success: true, summary: {}, signals: [] });
    if (pth === '/api/admin-users') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let j = {};
        try { j = JSON.parse(body || '{}'); } catch (_) {}
        if (j.action === 'portfolio_access') return sendJ(res, 200, { success: true, user_id: 'u-budi', username: 'budi' });
        return sendJ(res, 200, { success: true, admin: 'budi', quota: { used: 0, limit: 1, pct: 0 }, online_summary: {}, datasets: [], jobs: [] });
      });
      return;
    }
    if (pth === '/api/admin-notes') return sendJ(res, 200, { success: true, summary: { total_active: 3, target_hit: 1, total_evaluated: 5, avg_gain_pct: 2.5 }, notes: [
      { id: '1', ticker: 'BRPT', style: 'swing', status: 'Di area pantau', zone_lo: 1000, zone_hi: 1050, target: 1150, risk_limit: 980, current_price: 1020, reason: 'Volume naik', edits: [] },
      { id: '2', ticker: 'BBCA', style: 'daytrade', status: 'Di area pantau', zone_lo: 9000, zone_hi: 9200, target: 9500, risk_limit: 8900, current_price: 9100, reason: 'Akumulasi broker', edits: [] },
      { id: '3', ticker: 'TLKM', style: 'swing', status: 'Kena target', zone_lo: 3000, zone_hi: 3100, target: 3300, risk_limit: 2950, current_price: 3300, reason: 'Breakout', edits: [] }
    ] });
    if (pth === '/api/maintenance-settings') return sendJ(res, 200, { success: true, maintenance: false, config: { maintenanceMode: false } });
    if (pth === '/api/admin-logs') return sendJ(res, 200, { success: true, logs: [] });
    if (pth === '/api/analyze') return sendJ(res, 200, { success: true });
    if (pth === '/api/money-management') return sendJ(res, 200, { success: true });
    if (pth.startsWith('/api/')) return sendJ(res, 200, { success: true });
    if (pth === '/' || pth === '/index.html') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'))); }
    let rel = pth.replace(/^\//, '').split('?')[0];
    if (rel === 'ketentuan') rel = 'ketentuan.html';
    if (rel === 'maintenance') rel = 'maintenance.html';
    const fp = path.join(PUBLIC_DIR, rel);
    if (!fp.startsWith(PUBLIC_DIR)) { res.statusCode = 403; return res.end('x'); }
    let st = null; try { st = fs.statSync(fp); } catch (_) {}
    if (!st || st.isDirectory()) { res.statusCode = 404; return res.end('x'); }
    const ext = path.extname(fp).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    return res.end(fs.readFileSync(fp));
  } catch (e) { res.statusCode = 500; return res.end('err'); }
});
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  const puppeteer = require('puppeteer-core');
  const exe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'] });
  const page = await browser.newPage();
  const cerr = []; const perr = [];
  page.on('console', m => { if (m.type() === 'error') cerr.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => perr.push(String(e).slice(0, 200)));
  await page.setRequestInterception(true);
  page.on('request', r => {
    const uu = r.url();
    if (/^https?:\/\//.test(uu) && uu.indexOf('127.0.0.1') < 0 && uu.indexOf('localhost') < 0) return r.abort();
    return r.continue();
  });
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(base + '/', { waitUntil: 'load', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2500));
  await page.evaluate(() => {
    try {
      localStorage.setItem('autocuan_logged_in', 'true');
      localStorage.setItem('autocuan_user', 'budi');
      localStorage.setItem('autocuan_user_id', 'u-budi');
      localStorage.setItem('autocuan_is_admin', 'true');
      window.__AUTOCUAN_AUTHENTICATED_SESSION__ = { success: true, userId: 'u-budi', username: 'budi', isAdmin: true };
      window.premiumAccessState = { state: 'ready', premium: true, isAdmin: true, accessLevel: 'lifetime' };
    } catch (_) {}
  });
  // 390 overflow check semua halaman utama
  const pages = ['dashboard', 'screener', 'sektor', 'catatan-admin', 'watchlist', 'portofolio', 'trackrecord', 'money-management', 'admin-console'];
  await page.setViewport({ width: 390, height: 844 });
  for (const n of pages) {
    await page.evaluate((pg) => { try { navigateTo(pg); } catch (_) {} }, n);
    await new Promise(r => setTimeout(r, 1200));
    const st = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth, txt: document.body.innerText.slice(0, 300) }));
    const hasSpin = /Memuat|Loading|spinner/i.test(st.txt);
    console.log('390 ' + n + ' over=' + st.over + ' spin=' + hasSpin + ' txt=' + JSON.stringify(st.txt.slice(0, 120)));
  }
  await page.setViewport({ width: 1440, height: 900 });
  // Recovery modal detail
  await page.evaluate(() => { try { navigateTo('dashboard'); } catch (_) {} });
  await new Promise(r => setTimeout(r, 1000));
  const recFns = await page.evaluate(() => ({
    hasOpenSelfReset: typeof window.openSelfResetModal,
    hasDoSelfReset: typeof window.doSelfResetPassword,
    hasSelfResetModal: Boolean(document.getElementById('selfResetModal')),
    hasAuthV2: Boolean(document.getElementById('authV2ResetModal')),
    hasAuthChoice: Boolean(document.getElementById('authChoiceModal'))
  }));
  console.log('REC_FNS=' + JSON.stringify(recFns));
  try {
    await page.evaluate(() => { try { window.openSelfResetModal(); } catch (e) { window.__recErr = String(e).slice(0, 100); } });
    await new Promise(r => setTimeout(r, 1000));
    const vis = await page.evaluate(() => {
      const ids = ['authV2ResetModal', 'selfResetModal'];
      return ids.map(id => {
        const el = document.getElementById(id);
        if (!el) return id + '=missing';
        const r = el.getBoundingClientRect();
        return id + ' hidden=' + el.classList.contains('hidden') + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height) + ' html=' + el.innerHTML.slice(0, 80).replace(/\n/g, ' ');
      }).join(' | ');
    });
    console.log('REC_VIS=' + vis);
  } catch (e) { console.log('REC_EXC ' + e.message.slice(0, 100)); }
  await page.keyboard.press('Escape');
  // Admin tabs
  await page.evaluate(() => { try { navigateTo('admin-console'); } catch (_) {} });
  await new Promise(r => setTimeout(r, 2000));
  const tabs = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#adminNavTabs button')].map(b => b.textContent.trim().slice(0, 20));
    return { n: btns.length, labels: btns, hasSwitch: typeof window.switchAdminTab };
  });
  console.log('ADMIN_TABS=' + JSON.stringify(tabs));
  for (let i = 0; i < Math.min(8, tabs.n); i++) {
    try {
      await page.evaluate((idx) => { try { window.switchAdminTab(idx); } catch (e) {} }, i);
      await new Promise(r => setTimeout(r, 800));
      const st = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth, len: document.body.innerHTML.length }));
      console.log('admin_tab' + (i + 1) + ' over=' + st.over + ' len=' + st.len);
    } catch (e) { console.log('admin_tab' + (i + 1) + ' EXC'); }
  }
  // Screener modes
  await page.evaluate(() => { try { navigateTo('screener'); } catch (_) {} });
  await new Promise(r => setTimeout(r, 1500));
  const scrModes = await page.evaluate(() => ({ hasSwitch: typeof window.switchScreenerType }));
  console.log('SCR=' + JSON.stringify(scrModes));
  for (const m of ['konglo', 'nonkonglo', 'daytrade']) {
    try {
      await page.evaluate((mm) => { try { window.switchScreenerType(mm); } catch (e) {} }, m);
      await new Promise(r => setTimeout(r, 1000));
      const st = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth, len: document.body.innerHTML.length }));
      console.log('screener_' + m + ' over=' + st.over + ' len=' + st.len);
    } catch (e) { console.log('screener_' + m + ' EXC'); }
  }
  // Financial tickers
  const fins = ['BRPT', 'BBCA', 'BBRI', 'BMRI', 'TLKM'];
  for (const t of fins) {
    try {
      await page.evaluate((tk) => { try { navigateTo('analisis', 'financial', tk); } catch (e) {} }, t);
      await new Promise(r => setTimeout(r, 1200));
      const st = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth, len: document.body.innerHTML.length }));
      console.log('fin_' + t + ' over=' + st.over + ' len=' + st.len);
    } catch (e) { console.log('fin_' + t + ' EXC'); }
  }
  // Chart tickers
  const charts = ['BBCA', 'BBRI', 'BMRI', 'TLKM', 'ANTM', 'BRPT', 'GOTO', 'ASII', 'ADRO', 'MEDC', 'IHSG'];
  for (const t of charts.slice(0, 3)) {
    try {
      await page.evaluate((tk) => { try { navigateTo('analisis', 'analisis-chart', tk); } catch (e) {} }, t);
      await new Promise(r => setTimeout(r, 1200));
      const st = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth, len: document.body.innerHTML.length }));
      console.log('chart_' + t + ' over=' + st.over + ' len=' + st.len);
    } catch (e) { console.log('chart_' + t + ' EXC'); }
  }
  // Bandar segments
  await page.evaluate(() => { try { navigateTo('analisis', 'bandarmologi'); } catch (_) {} });
  await new Promise(r => setTimeout(r, 1500));
  const bandar = await page.evaluate(() => ({
    html: document.body.innerHTML.slice(0, 5000),
    hasBandar: document.body.innerHTML.includes('bandar') || document.body.innerHTML.includes('Bandar')
  }));
  console.log('BANDAR has=' + bandar.hasBandar);
  const bandarFns = await page.evaluate(() => Object.keys(window).filter(k => /bandar|Bandar|broksum|Broksum|foreign|Foreign|domestik|Domestik|akumulasi|Akumulasi/i.test(k)).slice(0, 20));
  console.log('BANDAR_FNS=' + JSON.stringify(bandarFns));
  console.log('CERR=' + JSON.stringify(cerr.slice(0, 10)));
  console.log('PERR=' + JSON.stringify(perr.slice(0, 10)));
  await browser.close();
  server.close();
})().catch(e => { console.error('PROBE2_FAIL ' + e.message); process.exit(1); });
