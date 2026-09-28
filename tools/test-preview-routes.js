'use strict';

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3042;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const PREVIEW_ROUTES = [
  { name: '1. Landing', path: '/preview/landing', expectHtml: 'autocuan-preview-bar' },
  { name: '2. Dashboard', path: '/preview/dashboard', expectHtml: 'page-dashboard' },
  { name: '3. Analisis Saham', path: '/preview/analisis-saham', expectHtml: 'page-analisis' },
  { name: '4. Sektor Hot', path: '/preview/sektor-hot', expectHtml: 'page-sektor' },
  { name: '5. Screener', path: '/preview/screener', expectHtml: 'page-screener' },
  { name: '6. Watchlist', path: '/preview/watchlist', expectHtml: 'page-watchlist' },
  { name: '7. Track Record', path: '/preview/track-record', expectHtml: 'page-trackrecord' },
  { name: '8. Portofolio', path: '/preview/portofolio', expectHtml: 'page-portofolio' },
  { name: '9. Kelola Keuangan', path: '/preview/kelola-keuangan', expectHtml: 'page-money-management' }
];

const PREVIEW_APIS = [
  { name: 'Landing Snapshot', url: '/api/sector-hot?action=landing-snapshot', check: d => d.success && d.snapshot },
  { name: 'Top 5 Daily Picks', url: '/api/sector-hot?action=web-daily-picks', check: d => d.success && d.top5_locked && d.top5.length > 0 },
  { name: 'Sektor Hot Groups', url: '/api/sector-hot', check: d => d.success && d.groups.length > 0 },
  { name: 'Screener Swing Konglo', url: '/api/sector-hot?action=screener', check: d => d.success && d.results.length > 0 },
  { name: 'Screener Swing NK', url: '/api/sector-hot?action=nk-screener-results', check: d => d.success && d.results.length > 0 },
  { name: 'Screener Daytrade', url: '/api/sector-hot?action=daytrade-screener', check: d => d.success && d.results.length > 0 },
  { name: 'Watchlist', url: '/api/sector-hot?action=watchlist', check: d => d.success && d.watchlist.length > 0 },
  { name: 'Track Record', url: '/api/track-record', check: d => d.success && d.summary && d.signals.length > 0 },
  { name: 'IHSG Live Quote', url: '/api/quote?ticker=IHSG', check: d => d.success && d.last > 0 },
  { name: 'Candles T-1', url: '/api/candles?ticker=BBCA', check: d => d.success && d.candles.length > 0 },
  { name: 'Money Management Cashflow', url: '/api/money-management?action=get-cashflow', check: d => d.success && d.data },
  { name: 'Money Management Journal', url: '/api/money-management?action=get-journal', check: d => d.success && Array.isArray(d.data) }
];

function fetchHttp(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'Host': `${parsed.hostname}:${parsed.port}`,
        'User-Agent': 'Preview-Tester/1.0',
        ...headers
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForServer(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetchHttp(`${BASE_URL}/preview/landing`);
      if (res.status === 200) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Server start timed out');
}

async function run() {
  console.log(`[Test] Launching local-dev-server on port ${PORT}...`);
  const server = spawn('node', ['tools/local-dev-server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });

  try {
    await waitForServer();
    console.log('[Test] Server is live!\n');

    let allPassed = true;

    console.log('=== TESTING 9 PREVIEW HTML ROUTES ===');
    for (const route of PREVIEW_ROUTES) {
      const res = await fetchHttp(`${BASE_URL}${route.path}`);
      const ok = res.status === 200 && res.body.includes(route.expectHtml);
      if (ok) {
        console.log(` ✔ ${route.name.padEnd(20)} [${route.path}] -> HTTP ${res.status} OK (Size: ${res.body.length} bytes)`);
      } else {
        console.error(` ✘ ${route.name.padEnd(20)} [${route.path}] -> HTTP ${res.status}, contains expect: ${res.body.includes(route.expectHtml)}`);
        allPassed = false;
      }
    }

    console.log('\n=== TESTING ZERO-AUTH MOCK API ENDPOINTS ===');
    for (const api of PREVIEW_APIS) {
      const res = await fetchHttp(`${BASE_URL}${api.url}`, {
        'Referer': `${BASE_URL}/preview/dashboard`,
        'X-AutoCuan-Preview': '1'
      });
      let json = null;
      try { json = JSON.parse(res.body); } catch (_) {}
      const ok = res.status === 200 && json && api.check(json);
      if (ok) {
        console.log(` ✔ ${api.name.padEnd(28)} [${api.url}] -> HTTP ${res.status} OK (JSON valid)`);
      } else {
        console.error(` ✘ ${api.name.padEnd(28)} [${api.url}] -> HTTP ${res.status}, body: ${res.body.slice(0, 100)}`);
        allPassed = false;
      }
    }

    if (!allPassed) {
      console.error('\nSome checks failed!');
      process.exitCode = 1;
    } else {
      console.log('\nALL 9 PREVIEW ROUTES & ZERO-AUTH MOCKS TESTED AND VERIFIED 100% SUCCESSFUL!');
    }
  } finally {
    server.kill();
  }
}

run().catch(err => {
  console.error('[Test Error]:', err);
  process.exit(1);
});
