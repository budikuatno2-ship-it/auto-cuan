#!/usr/bin/env node
'use strict';
// FASE 20 — find which API URL returns 500 for catatan-admin / intel / hunter.
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadSecret() {
  const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*SESSION_SECRET\s*=\s*(.+)$/);
    if (m) { const v = m[1].trim().replace(/^["']|["']$/g, ''); if (v) { process.env.SESSION_SECRET = v; return v; } }
  }
  return null;
}

const TARGETS = [
  { name: 'catatan_admin', url: '/dashboard?page=catatan-admin' },
  { name: 'intel', url: '/dashboard?page=analisis&tab=intel' },
  { name: 'hunter', url: '/dashboard?page=analisis&tab=hunter' }
];

(async () => {
  loadSecret();
  const sessionAuth = require(path.join(ROOT, 'lib', 'admin-session.js'));
  const token = sessionAuth.createSessionToken({ userId: 'fase20-diag', username: 'budi', isAdmin: true });
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  for (const t of TARGETS) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setCookie({ name: 'ac_sess', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' });

    const failed = [];
    page.on('response', async res => {
      const st = res.status();
      if (st >= 400 && st !== 401 && st !== 403) {
        let body = '';
        try { body = (await res.text()).slice(0, 400); } catch (_) {}
        failed.push({ status: st, url: res.url().slice(0, 160), method: res.request().method(), body });
      }
    });

    await page.goto('http://127.0.0.1:3000' + t.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await sleep(5000);

    console.log('===== ' + t.name + ' :: ' + t.url);
    if (!failed.length) console.log('  (no 4xx/5xx responses)');
    for (const f of failed) {
      console.log('  HTTP ' + f.status + ' ' + f.method + ' ' + f.url);
      console.log('     body: ' + f.body.replace(/\s+/g, ' ').slice(0, 300));
    }
    console.log('');
    await page.close();
  }
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
