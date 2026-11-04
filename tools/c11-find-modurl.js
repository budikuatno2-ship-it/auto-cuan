#!/usr/bin/env node
'use strict';
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
    if (pth.startsWith('/api/')) return sendJ(res, 200, { success: true });
    if (pth === '/' || pth === '/index.html') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'))); }
    const rel = pth.replace(/^\//, '').split('?')[0];
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
  const puppeteer = require('puppeteer-core');
  const exe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  page.on('requestfailed', r => console.log('REQFAIL: ' + r.url().slice(0, 160) + ' :: ' + (r.failure() && r.failure().errorText)));
  page.on('response', async r => {
    const ct = r.headers()['content-type'] || '';
    const url = r.url();
    if (r.status() >= 400) console.log('RESP' + r.status() + ': ' + url.slice(0, 160) + ' ct=' + ct);
  });
  page.on('console', m => { if (m.type() === 'error') console.log('CERR: ' + m.text().slice(0, 250) + ' @' + (m.location() && m.location().url || '')); });
  page.on('pageerror', e => console.log('PERR: ' + String(e).slice(0, 200)));
  await page.setRequestInterception(true);
  page.on('request', r => {
    const uu = r.url();
    if (/^https?:\/\//.test(uu) && uu.indexOf('127.0.0.1') < 0 && uu.indexOf('localhost') < 0) return r.abort();
    return r.continue();
  });
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));
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
  for (const n of ['dashboard', 'analisis', 'portofolio', 'money-management']) {
    await page.evaluate((pg) => { try { navigateTo(pg); } catch (_) {} }, n);
    await new Promise(r => setTimeout(r, 1500));
  }
  await new Promise(r => setTimeout(r, 2000));
  await browser.close();
  server.close();
})().catch(e => { console.error('FAIL ' + e.message); process.exit(1); });
