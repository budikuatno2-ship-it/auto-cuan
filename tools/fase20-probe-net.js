#!/usr/bin/env node
'use strict';
// FASE 20 probe: record every network request made by each page (external vs local)
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:3000';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*SESSION_SECRET\s*=\s*(.+)$/);
    if (m) { const v = m[1].trim().replace(/^["']|["']$/g, ''); if (v) { process.env.SESSION_SECRET = v; return v; } }
  }
  return null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const secret = loadSecret();
  const session = require(path.join(ROOT, 'lib', 'admin-session.js'));
  const token = session.createSessionToken({ userId: 'audit-fase20-net', username: 'budi', isAdmin: true });

  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const urls = {
    landing: '/',
    dashboard: '/dashboard?page=dashboard',
    screener: '/dashboard?page=screener',
    sektor: '/dashboard?page=sektor',
    catatanAdmin: '/dashboard?page=catatan-admin',
    analisisChart: '/dashboard?page=analisis&tab=analisis-chart',
    bandarmologi: '/dashboard?page=analisis&tab=bandarmologi',
    intel: '/dashboard?page=analisis&tab=intel',
    hunter: '/dashboard?page=analisis&tab=hunter',
    insider: '/dashboard?page=analisis&tab=insider',
    ranking: '/dashboard?page=analisis&tab=ranking',
    financial: '/dashboard?page=analisis&tab=financial',
    marketStructure: '/dashboard?page=analisis&tab=market-structure',
    watchlist: '/dashboard?page=watchlist',
    portofolio: '/dashboard?page=portofolio',
    trackrecord: '/dashboard?page=trackrecord',
    moneyManagement: '/dashboard?page=money-management',
    adminConsole: '/dashboard?page=admin-console',
    patternRadar: '/pattern-radar',
    ketentuan: '/ketentuan',
    maintenance: '/maintenance',
    notFound: '/zzz-not-found-fase20'
  };

  const report = {};

  for (const [name, url] of Object.entries(urls)) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setCookie({ name: 'ac_sess', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' });
    const external = [];
    const failed = [];
    page.on('request', req => {
      const u = req.url();
      if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(u) && !u.startsWith('data:') && !u.startsWith('blob:')) {
        external.push({ url: u.slice(0, 160), type: req.resourceType() });
      }
    });
    page.on('requestfailed', req => {
      failed.push({ url: req.url().slice(0, 140), err: (req.failure() || {}).errorText });
    });
    try {
      await page.goto(BASE + url, { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(2000);
    } catch (e) {
      report[name] = { error: e.message.slice(0, 160), external, failedCount: failed.length };
      await page.close();
      continue;
    }
    report[name] = {
      external,
      externalCount: external.length,
      failedCount: failed.length,
      failedSample: failed.slice(0, 5)
    };
    await page.close();
  }

  await browser.close();
  fs.writeFileSync(path.join(ROOT, 'tools', 'fase20-net-probe.json'), JSON.stringify(report, null, 2));
  for (const [k, v] of Object.entries(report)) {
    console.log(k.padEnd(18) + ' external=' + (v.externalCount !== undefined ? v.externalCount : 'ERR') +
      ' failedReq=' + v.failedCount + (v.externalCount ? '  ' + JSON.stringify(v.external.slice(0, 3)) : ''));
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
