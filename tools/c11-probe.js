#!/usr/bin/env node
'use strict';
// Probe C11: muat public/index.html via server statis + mock API, cek console/page errors, overflow, screenshot size.
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
function sendJ(res, code, o) { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); }
const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const pth = decodeURIComponent(u.pathname);
    const a = u.searchParams.get('action');
    if (pth === '/api/reset-password' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let j = {};
        try { j = JSON.parse(body || '{}'); } catch (_) {}
        if (j.action === 'session-status') {
          // Tiru sesi admin VIP budi tanpa DB: sukses langsung
          return sendJ(res, 200, { success: true, userId: 'u-budi', username: 'budi', isAdmin: true, isReview: false });
        }
        return sendJ(res, 200, { success: true });
      });
      return;
    }
    if (pth === '/api/login-user') return sendJ(res, 200, { success: true });
    if (pth === '/api/sector-hot') return sendJ(res, 200, { success: true, snapshot: null, sectors: [], signals: [], watchlist: [], history: [] });
    if (pth === '/api/quote') return sendJ(res, 200, { success: true, snapshot: null });
    if (pth === '/api/candles') return sendJ(res, 200, { success: true, candles: [] });
    if (pth === '/api/track-record') return sendJ(res, 200, { success: true, summary: {}, signals: [] });
    if (pth === '/api/admin-users') return sendJ(res, 200, { success: true, admin: 'budi', quota: { used: 0, limit: 1, pct: 0 }, online_summary: {}, datasets: [], jobs: [] });
    if (pth === '/api/maintenance-settings') return sendJ(res, 200, { success: true, maintenance: false, config: { maintenanceMode: false } });
    if (pth === '/api/admin-logs') return sendJ(res, 200, { success: true, logs: [] });
    if (pth === '/api/analyze') return sendJ(res, 200, { success: true });
    if (pth === '/api/money-management') return sendJ(res, 200, { success: true });
    if (pth === '/api/review-access') return sendJ(res, 200, { success: true });
    if (pth === '/api/log') return sendJ(res, 200, { success: true });
    if (pth === '/api/register-user') return sendJ(res, 200, { success: true });
    if (pth.startsWith('/api/')) return sendJ(res, 200, { success: true });
    if (pth === '/' || pth === '/index.html') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'))); }
    let rel = pth.replace(/^\//, '').split('?')[0];
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
  console.log('BASE=' + base);
  const puppeteer = require('puppeteer-core');
  const exe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'] });
  const page = await browser.newPage();
  const cerr = []; const perr = []; const extReq = [];
  page.on('console', m => { if (m.type() === 'error') cerr.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => perr.push(String(e).slice(0, 200)));
  await page.setRequestInterception(true);
  page.on('request', r => {
    const uu = r.url();
    if (/^https?:\/\//.test(uu) && uu.indexOf('127.0.0.1') < 0 && uu.indexOf('localhost') < 0) { extReq.push(uu.slice(0, 100)); return r.abort(); }
    return r.continue();
  });
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(base + '/', { waitUntil: 'load', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));
  // Suntik sesi admin VIP budi
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
  await new Promise(r => setTimeout(r, 500));
  const navs = ['dashboard', 'screener', 'sektor', 'catatan-admin', 'watchlist', 'portofolio', 'trackrecord', 'money-management', 'admin-console'];
  for (const n of navs) {
    try {
      await page.evaluate((pg) => { try { if (typeof navigateTo === 'function') navigateTo(pg); } catch (e) { window.__navErr = String(e).slice(0, 100); } }, n);
      await new Promise(r => setTimeout(r, 1500));
      const st = await page.evaluate(() => ({
        navErr: window.__navErr || null,
        over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bodyLen: document.body.innerHTML.length,
        hasSpinner: /spinner|Memuat|Loading/i.test(document.body.innerText.slice(0, 2000))
      }));
      console.log(n + ' over=' + st.over + ' len=' + st.bodyLen + ' spin=' + st.hasSpinner + ' err=' + st.navErr);
    } catch (e) { console.log(n + ' EXC ' + String(e).slice(0, 100)); }
  }
  // Analisis sub-tabs
  for (const sub of ['analisis-chart', 'bandarmologi', 'intel', 'hunter', 'insider', 'ranking', 'financial', 'market-structure', 'pattern']) {
    try {
      await page.evaluate((s) => { try { navigateTo('analisis', s); } catch (e) { window.__navErr = String(e).slice(0, 100); } }, sub);
      await new Promise(r => setTimeout(r, 1500));
      const st = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth, len: document.body.innerHTML.length }));
      console.log('analisis/' + sub + ' over=' + st.over + ' len=' + st.len);
    } catch (e) { console.log('analisis/' + sub + ' EXC'); }
  }
  // Auth modals
  for (const fn of ['openLoginModal', 'openRegisterModal', 'openSelfResetModal']) {
    try {
      await page.evaluate((f) => { try { window[f](); } catch (e) {} }, fn);
      await new Promise(r => setTimeout(r, 800));
      const vis = await page.evaluate((f) => {
        const ids = { openLoginModal: 'loginModal', openRegisterModal: 'registerModal', openSelfResetModal: 'authV2ResetModal' };
        const el = document.getElementById(ids[f]);
        if (!el) return 'no-el';
        const r = el.getBoundingClientRect();
        return 'hidden=' + el.classList.contains('hidden') + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height);
      }, fn);
      console.log(fn + ' ' + vis);
      await page.keyboard.press('Escape');
      await new Promise(r => setTimeout(r, 400));
    } catch (e) { console.log(fn + ' EXC'); }
  }
  // Screenshot uji
  const shot = await page.screenshot({ encoding: 'binary' });
  fs.mkdirSync('D:\\tmp', { recursive: true });
  fs.writeFileSync('D:\\tmp\\c11-probe.png', Buffer.from(shot));
  console.log('shot bytes=' + shot.length + ' cerr=' + cerr.length + ' perr=' + perr.length + ' ext=' + extReq.length);
  console.log('CERR:' + JSON.stringify(cerr.slice(0, 5)));
  console.log('PERR:' + JSON.stringify(perr.slice(0, 5)));
  console.log('EXT:' + JSON.stringify(extReq.slice(0, 5)));
  await browser.close();
  server.close();
})().catch(e => { console.error('PROBE_FAIL ' + e.message); process.exit(1); });
