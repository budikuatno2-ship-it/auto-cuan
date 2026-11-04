#!/usr/bin/env node
'use strict';
// FASE 20 live probe: navigate with a signed admin session and inspect real DOM contracts.
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'fase20-live-probe.json');
const BASE = 'http://127.0.0.1:3000';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*SESSION_SECRET\s*=\s*(.+)$/);
    if (m) {
      const v = m[1].trim().replace(/^["']|["']$/g, '');
      if (v) { process.env.SESSION_SECRET = v; return v; }
    }
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const secret = loadSecret();
  if (!secret) { console.error('NO SECRET'); process.exit(1); }
  const session = require(path.join(ROOT, 'lib', 'admin-session.js'));
  const token = session.createSessionToken({ userId: 'audit-fase20-probe', username: 'budi', isAdmin: true });

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-features=Translate']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  // Seed the session cookie for the local origin.
  await page.setCookie({
    name: 'ac_sess', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax'
  });
  await page.setExtraHTTPHeaders({ 'x-autocuan-preview': '1' });

  const report = {};

  async function visit(label, url, waitMs) {
    try {
      await page.goto(BASE + url, { waitUntil: 'networkidle2', timeout: 30000 });
    } catch (e) {
      report[label] = { error: e.message.slice(0, 200) };
      return;
    }
    await sleep(waitMs || 1800);
    const info = await page.evaluate(() => {
      const vis = id => {
        const el = document.getElementById(id);
        if (!el) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), display: cs.display, vis: cs.visibility,
                 hidden: el.classList.contains('hidden') };
      };
      const pageIds = Array.from(document.querySelectorAll('[id^="page-"]')).map(e => e.id);
      const visiblePages = pageIds.filter(id => {
        const el = document.getElementById(id);
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && !el.classList.contains('hidden') && el.getBoundingClientRect().height > 0;
      });
      return {
        path: location.pathname + location.search,
        title: document.title,
        currentPage: typeof window.currentPage !== 'undefined' ? window.currentPage : null,
        landingVisible: vis('landingPage'),
        appVisible: vis('app'),
        gateVisible: vis('accessGate'),
        maintVisible: vis('maintenanceScreen'),
        visiblePages,
        bodyLen: (document.body.innerText || '').length,
        bodyHead: (document.body.innerText || '').slice(0, 160).replace(/\s+/g, ' '),
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
        h1: (document.querySelector('h1') || {}).textContent || null
      };
    });
    report[label] = info;
  }

  await visit('landing', '/');
  await visit('dashboard', '/dashboard?page=dashboard');
  await visit('screener', '/dashboard?page=screener');
  await visit('sektor', '/dashboard?page=sektor');
  await visit('catatan-admin', '/dashboard?page=catatan-admin');
  await visit('analisis-chart', '/dashboard?page=analisis&tab=analisis-chart');
  await visit('bandarmologi', '/dashboard?page=analisis&tab=bandarmologi');
  await visit('intel', '/dashboard?page=analisis&tab=intel');
  await visit('hunter', '/dashboard?page=analisis&tab=hunter');
  await visit('insider', '/dashboard?page=analisis&tab=insider');
  await visit('ranking', '/dashboard?page=analisis&tab=ranking');
  await visit('financial', '/dashboard?page=analisis&tab=financial');
  await visit('market-structure', '/dashboard?page=analisis&tab=market-structure');
  await visit('watchlist', '/dashboard?page=watchlist');
  await visit('portofolio', '/dashboard?page=portofolio');
  await visit('trackrecord', '/dashboard?page=trackrecord');
  await visit('money-management', '/dashboard?page=money-management');
  await visit('admin-console', '/dashboard?page=admin-console');
  await visit('pattern-radar', '/pattern-radar');
  await visit('ketentuan', '/ketentuan');
  await visit('maintenance', '/maintenance');
  await visit('notfound', '/this-page-does-not-exist-fase20');

  // Portfolio tab structure
  await visit('portofolio-2', '/dashboard?page=portofolio', 2500);
  report.portfolioTabs = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('[data-tab]')).map(b => ({
      tab: b.getAttribute('data-tab'),
      tag: b.tagName,
      cls: (b.className || '').toString().slice(0, 40),
      text: (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
    }));
    const panels = Array.from(document.querySelectorAll('[id^="portPanel"], .port-panel, [data-port-panel]')).map(p => p.id || p.className);
    return { buttons: btns, panels, hasOpenPortfolioTab: typeof window.openPortfolioTab === 'function',
             hasSwitchPortfolioTab: typeof window.switchPortfolioTab === 'function',
             fns: Object.keys(window).filter(k => /portfolio|portofolio/i.test(k) && typeof window[k] === 'function') };
  });

  // Bandarmologi section structure
  await visit('bandar-2', '/dashboard?page=analisis&tab=bandarmologi', 2500);
  report.bandar = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('[data-bandar-section], #bandarViewInd button, #bandarmologiContent [role="tab"]')).map(b => ({
      attr: b.getAttribute('data-bandar-section'),
      id: b.id,
      text: (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
    }));
    return { buttons: btns, fns: Object.keys(window).filter(k => /bandar/i.test(k) && typeof window[k] === 'function') };
  });

  // Admin console tabs
  await visit('admin-2', '/dashboard?page=admin-console', 3000);
  report.adminTabs = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('#adminNavTabs .tbtn')).map(t => (t.textContent || '').replace(/\s+/g, ' ').trim());
    const panels = Array.from(document.querySelectorAll('[id^="panelTab"]')).map(p => ({ id: p.id, display: p.style.display }));
    return { tabs, panels };
  });

  // Analisis sub-tabs structure
  await visit('analisis-2', '/dashboard?page=analisis&tab=analisis-chart', 2500);
  report.analisisTabs = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('[data-analysis-tab]')).map(b => ({
      tab: b.getAttribute('data-analysis-tab'),
      text: (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      cls: (b.className || '').toString().slice(0, 40)
    }));
    return { buttons: btns, fns: Object.keys(window).filter(k => /analisis|analysis/i.test(k) && typeof window[k] === 'function').slice(0, 40) };
  });

  // Auth modals
  await visit('landing-2', '/', 2000);
  report.authModals = await page.evaluate(() => {
    const ids = ['authChoiceModal', 'loginModal', 'registerModal', 'selfResetModal', 'googleProfileModal', 'resetPasswordModal'];
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) { out[id] = null; continue; }
      const cs = getComputedStyle(el);
      out[id] = { display: cs.display, vis: cs.visibility, opacity: cs.opacity,
                  cls: (el.className || '').toString().slice(0, 60),
                  hidden: el.classList.contains('hidden') };
    }
    return { modals: out, fns: Object.keys(window).filter(k => /openLogin|openRegister|openSelfReset|openAuthChoice/i.test(k)) };
  });

  await browser.close();
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2).slice(0, 12000));
  console.log('\nWROTE ' + OUT);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
