#!/usr/bin/env node
'use strict';
// FASE 20 probe: can the .dc.html design canvases render in a real browser?
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const CANVAS_DIR = path.join(ROOT, 'handoff-redesign', 'design', 'project');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 3131;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/Main.dc.html';
  const fp = path.join(CANVAS_DIR, p);
  if (!fp.startsWith(CANVAS_DIR) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.statusCode = 404; return res.end('nf');
  }
  res.setHeader('Content-Type', MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream');
  fs.createReadStream(fp).pipe(res);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const targets = ['Main', 'Screener', 'SektorHot', 'Analisis', 'Portfolio', 'AdminConsole', 'Landing', 'AuthLogin'];
  for (const t of targets) {
    const p = await browser.newPage();
    await p.setViewport({ width: 1440, height: 900 });
    await p.setRequestInterception(true);
    p.on('request', req => {
      const u = req.url();
      if (u.startsWith('http://127.0.0.1:' + PORT) || u.startsWith('data:') || u.startsWith('blob:')) req.continue();
      else req.abort();
    });
    const errs = [];
    p.on('pageerror', e => errs.push(String(e.message).slice(0, 100)));
    try {
      await p.goto('http://127.0.0.1:' + PORT + '/' + t + '.dc.html', { waitUntil: 'networkidle2', timeout: 20000 });
      await sleep(1200);
      const info = await p.evaluate(() => ({
        bodyLen: (document.body.innerText || '').length,
        h: document.documentElement.scrollHeight,
        w: document.documentElement.scrollWidth,
        hasApp: Boolean(document.querySelector('.app, .side, .shell, main')),
        head: (document.body.innerText || '').slice(0, 80).replace(/\s+/g, ' ')
      }));
      const dest = path.join(ROOT, 'tools', 'canvas-probe-' + t + '.png');
      await p.screenshot({ path: dest, fullPage: false });
      const kb = Math.round(fs.statSync(dest).size / 1024);
      console.log(t.padEnd(14), 'len=' + String(info.bodyLen).padEnd(6), 'h=' + String(info.h).padEnd(6), 'w=' + info.w, 'app=' + info.hasApp, 'kb=' + kb, 'errs=' + errs.length, '| ' + info.head.slice(0, 50));
    } catch (e) {
      console.log(t.padEnd(14), 'ERROR', e.message.slice(0, 80));
    }
    await p.close();
  }
  await browser.close();
  server.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
