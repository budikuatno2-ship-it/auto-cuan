#!/usr/bin/env node
'use strict';
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'autocuan-local-verification-secret-key-2026-valid';
const { createSessionToken } = require('../lib/admin-session');

const OUT = path.join(__dirname, '..', 'bukti-verifikasi-final', 'fase16');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const EXE = 'C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe';
const BASE = 'https://autocuan.web.id';

// Generate admin test session token
const session = require('../lib/admin-session');
const testToken = session.createSessionToken({
  userId: 'audit-roo-fase16-001',
  email: 'audit@auto-cuan.internal',
  role: 'admin',
  displayName: 'AuditRoo',
  deviceId: 'puppeteer-edge-audit-20261028'
});

console.log('Token generated:', (testToken || '(null)').substring(0, 40) + '...');

const PAGES = [
  '/?page=dashboard', '/?page=screener', '/?page=sector-hot',
  '/?page=catatan-admin', '/?page=analisis', '/?page=chart',
  '/?page=bandarmologi', '/?page=sinyal-intelijen', '/?page=broker-hunter',
  '/?page=insider', '/?page=ranking', '/?page=financial',
  '/?page=struktur-pasar', '/?page=watchlist', '/?page=portfolio',
  '/?page=track-record', '/?page=account-center', '/?page=kelola-keuangan',
  '/?page=pattern-radar', '/?page=admin-console'
];

const VPS = [
  { n: '1440_light', w: 1440, h: 900, s: 'light' },
  { n: '1440_dark', w: 1440, h: 900, s: 'dark' },
  { n: '390_light', w: 390, h: 844, s: 'light' },
  { n: '390_dark', w: 390, h: 844, s: 'dark' },
];

const log = [];
let totalSnaps = 0;

(async () => {
  const b = await puppeteer.launch({ executablePath: EXE, headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  const p = await b.newPage();

  // Set session cookie
  await p.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await p.setCookie({
    name: 'auto_cuan_session',
    value: testToken,
    domain: 'autocuan.web.id',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax'
  });

  for (const pageUrl of PAGES) {
    const name = pageUrl.replace('/?page=', '').replace(/\//g, '_');
    const url = BASE + pageUrl;
    console.log('Processing:', name);
    try {
      await p.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      console.log('  FAIL:', e.message.substring(0, 60));
      log.push({ page: name, status: 'FAIL', error: e.message });
      continue;
    }

    for (const v of VPS) {
      await p.setViewport({ width: v.w, height: v.h, deviceScaleFactor: 2 });
      await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: v.s }]);
      await new Promise(r => setTimeout(r, 1000));

      const boxes = await p.evaluate(() => {
        const r = {};
        document.querySelectorAll('.ph, .sidebar, nav, .ana-ctx, table, .card-metric, .btn, .tab, [role="tab"]').forEach(el => {
          const rc = el.getBoundingClientRect();
          if (rc.width > 0) {
            const id = (el.className?.toString() || el.tagName).substring(0, 25);
            r[id] = r[id] || [];
            r[id].push({
              x: Math.round(rc.x), y: Math.round(rc.y),
              w: Math.round(rc.width), h: Math.round(rc.height)
            });
          }
        });
        return r;
      });
      const overflow = await p.evaluate(() => ({
        h: document.documentElement.scrollWidth - window.innerWidth,
        v: document.documentElement.scrollHeight - window.innerHeight
      }));

      const fname = name + '_' + v.n + '.png';
      const fp = path.join(OUT, fname);
      await p.screenshot({ path: fp, fullPage: true });
      const sz = fs.statSync(fp).size;
      totalSnaps++;
      log.push({ page: name, viewport: v.n, sizeKB: Math.round(sz / 1024), overflowH: overflow.h, overflowV: overflow.v, boxGroups: Object.keys(boxes).length });
    }
  }

  await b.close();
  fs.writeFileSync(path.join(OUT, 'capture-log.json'), JSON.stringify({ total: totalSnaps, log, generatedAt: new Date().toISOString(), tokenSource: 'lib/admin-session.js::createSessionToken' }, null, 2));
  console.log('\n=== DONE ===');
  console.log('Total screenshots:', totalSnaps);
  console.log('Output directory:', OUT);
})();