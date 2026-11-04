#!/usr/bin/env node
'use strict';
// FASE 20 — diagnose the exact console errors + spinner/banner sources.
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
  { name: 'pattern_radar', url: '/pattern-radar', auth: 'admin' },
  { name: 'maintenance', url: '/maintenance', auth: 'anon' },
  { name: '404', url: '/fase20-route-tidak-ada', auth: 'anon' },
  { name: 'catatan_admin', url: '/dashboard?page=catatan-admin', auth: 'admin' },
  { name: 'sinyal_intelijen', url: '/dashboard?page=analisis&tab=intel', auth: 'admin' },
  { name: 'broker_hunter', url: '/dashboard?page=analisis&tab=hunter', auth: 'admin' }
];

(async () => {
  loadSecret();
  const sessionAuth = require(path.join(ROOT, 'lib', 'admin-session.js'));
  const token = sessionAuth.createSessionToken({ userId: 'fase20-diag', username: 'budi', isAdmin: true });

  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  for (const t of TARGETS) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    if (t.auth === 'admin') {
      await page.setCookie({ name: 'ac_sess', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' });
    }
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
    page.on('pageerror', e => errs.push('PAGEERROR: ' + String(e && e.message).slice(0, 200)));
    await page.goto('http://127.0.0.1:3000' + t.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await sleep(4000);

    const diag = await page.evaluate(() => {
      const spinnerSel = '.spinner,.spinner-sm,.ac-loading,.ac-spinner,.spinner-border';
      const spinners = Array.from(document.querySelectorAll(spinnerSel)).map(el => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          id: el.id || null,
          cls: (el.className || '').toString().slice(0, 60),
          display: cs.display, vis: cs.visibility,
          w: Math.round(r.width), h: Math.round(r.height),
          visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 4 && r.height > 4,
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          parentId: el.parentElement ? (el.parentElement.id || el.parentElement.className || '').toString().slice(0, 40) : null
        };
      }).filter(s => s.visible);
      const body = (document.body && document.body.innerText) || '';
      const m = body.match(/[^\n]{0,80}(Terjadi kesalahan|Gagal memuat|Something went wrong|Internal Server Error)[^\n]{0,80}/i);
      return {
        spinners,
        errorBannerMatch: m ? m[0].replace(/\s+/g, ' ').slice(0, 200) : null,
        bodyHead: body.replace(/\s+/g, ' ').trim().slice(0, 260)
      };
    });

    console.log('===== ' + t.name + ' :: ' + t.url);
    console.log('  consoleErrors(' + errs.length + '):');
    errs.forEach(e => console.log('     - ' + e));
    console.log('  spinners visible: ' + JSON.stringify(diag.spinners));
    console.log('  errorBanner: ' + diag.errorBannerMatch);
    console.log('  bodyHead: ' + diag.bodyHead);
    console.log('');
    await page.close();
  }

  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
