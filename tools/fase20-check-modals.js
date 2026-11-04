#!/usr/bin/env node
'use strict';
// FASE 20 — verify auth modal visibility at capture time.
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

(async () => {
  loadSecret();
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1800);

  const before = await page.evaluate(() => {
    const ids = ['authChoiceModal', 'loginModal', 'registerModal', 'selfResetModal'];
    const o = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      o[id] = el ? { hidden: el.classList.contains('hidden'), display: getComputedStyle(el).display, h: Math.round(el.getBoundingClientRect().height) } : null;
    }
    o.fns = {
      openLoginModal: typeof window.openLoginModal,
      openRegisterModal: typeof window.openRegisterModal,
      openSelfResetModal: typeof window.openSelfResetModal,
      openAuthChoiceModal: typeof window.openAuthChoiceModal
    };
    return o;
  });
  console.log('BEFORE:', JSON.stringify(before, null, 1));

  for (const [kind, fn] of [['login', 'openLoginModal'], ['register', 'openRegisterModal'], ['recovery', 'openSelfResetModal'], ['choice', 'openAuthChoiceModal']]) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1500);
    const res = await page.evaluate(function (f) {
      try { if (typeof window[f] === 'function') { window[f](); return 'called'; } return 'missing'; }
      catch (e) { return 'throw:' + e.message; }
    }, fn);
    await sleep(900);
    const after = await page.evaluate(() => {
      const ids = ['authChoiceModal', 'loginModal', 'registerModal', 'selfResetModal'];
      const o = {};
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) { o[id] = null; continue; }
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        o[id] = { display: cs.display, h: Math.round(r.height), hidden: el.classList.contains('hidden'), vis: r.height > 50 };
      }
      return o;
    });
    console.log(kind.padEnd(9), res.padEnd(10), JSON.stringify(after));
  }

  // check portfolio tab clicking
  await page.goto('http://127.0.0.1:3000/dashboard?page=portofolio', { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  const port = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('#page-portofolio [data-tab]')).map(b => b.getAttribute('data-tab'));
    const panels = Array.from(document.querySelectorAll('[id^="page-"]')).filter(e => {
      const cs = getComputedStyle(e);
      return cs.display !== 'none' && !e.classList.contains('hidden');
    }).map(e => e.id);
    return { tabs, panels };
  });
  console.log('PORTFOLIO:', JSON.stringify(port));

  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
