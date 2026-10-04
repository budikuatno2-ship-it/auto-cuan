'use strict';

const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'test-artifacts', 'wave2a-screenshots');
if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

// Mock data sets
const KONG_RESULTS = [
  {
    ticker: 'BBCA',
    group_code: 'Djarum',
    swing_tier: 'A_PLUS_SWING',
    confidence: 'A+',
    confidence_label: 'A+',
    confidence_notes: 'Konfirmasi volume dan broker',
    score: 92,
    last_price: 10250,
    change_pct: 1.85,
    rsi14: 58.4,
    volume_ratio_avg20: 2.1,
    entry_low: 10100,
    entry_high: 10300,
    stop_loss: 9900,
    tp1: 10700,
    tp2: 11100,
    risk_reward: 2.5,
    entry_timing: 'Masih dekat area entry',
    direction: 'swing kuat',
    status_reason: 'Konfirmasi akumulasi broker dan breakout MA20 valid.'
  },
  {
    ticker: 'ASII',
    group_code: 'Astra',
    swing_tier: 'SWING_READY',
    confidence: 'A',
    confidence_label: 'A',
    confidence_notes: 'Breakout konklusif',
    score: 84,
    last_price: 5125,
    change_pct: 0.98,
    rsi14: 52.1,
    volume_ratio_avg20: 1.45,
    entry_low: 5050,
    entry_high: 5150,
    stop_loss: 4950,
    tp1: 5450,
    tp2: 5650,
    risk_reward: 2.1,
    entry_timing: 'Masih dekat area entry',
    direction: 'swing kuat',
    status_reason: 'Setup swing ready menembus resisten minor.'
  },
  {
    ticker: 'BRPT',
    group_code: 'Barito',
    swing_tier: 'WAIT_PULLBACK',
    confidence: 'B',
    confidence_label: 'B',
    confidence_notes: 'Menunggu retracement',
    score: 72,
    last_price: 1150,
    change_pct: 4.25,
    rsi14: 67.8,
    volume_ratio_avg20: 3.2,
    entry_low: 1080,
    entry_high: 1120,
    stop_loss: 1040,
    tp1: 1250,
    tp2: 1320,
    risk_reward: 1.8,
    entry_timing: 'Tunggu pullback ke area entry',
    direction: 'moderat',
    status_reason: 'Harga spike, tunggu pullback sehat sebelum entry.'
  },
  {
    ticker: 'INDF',
    group_code: 'Salim',
    swing_tier: 'WATCHLIST',
    confidence: 'B',
    confidence_label: 'B',
    confidence_notes: 'Base consolidation',
    score: 68,
    last_price: 6850,
    change_pct: -0.36,
    rsi14: 48.2,
    volume_ratio_avg20: 0.95,
    entry_low: 6750,
    entry_high: 6850,
    stop_loss: 6600,
    tp1: 7250,
    tp2: 7450,
    risk_reward: 2.0,
    entry_timing: 'Tunggu breakout resistance',
    direction: 'Watchlist',
    status_reason: 'Konsolidasi base dekat support kuat.'
  },
  {
    ticker: 'EMTK',
    group_code: 'Emtek',
    swing_tier: 'AVOID',
    confidence: 'C',
    confidence_label: 'C',
    confidence_notes: 'Distribusi aktif',
    score: 42,
    last_price: 430,
    change_pct: -2.71,
    rsi14: 38.5,
    volume_ratio_avg20: 0.65,
    entry_low: 420,
    entry_high: 440,
    stop_loss: 400,
    tp1: 470,
    tp2: 490,
    risk_reward: 1.2,
    entry_timing: 'Hindari',
    direction: 'Rawan',
    status_reason: 'Tren breakdown MA20 dan distribusi berkelanjutan.'
  }
];

const NK_RESULTS = [
  {
    rank: 1,
    ticker: 'MEDC',
    board: 'UTAMA',
    swing_tier: 'A_PLUS_SWING',
    confidence: 'A+',
    confidence_label: 'A+',
    confidence_notes: 'Energy momentum',
    score: 94,
    last_price: 1320,
    change_pct: 3.53,
    rsi14: 62.4,
    volume_ratio_avg20: 2.8,
    entry_low: 1290,
    entry_high: 1330,
    stop_loss: 1240,
    tp1: 1420,
    tp2: 1480,
    risk_reward: 2.6,
    entry_timing: 'Masih dekat area entry',
    direction: 'swing kuat',
    status_reason: 'Breakout volume masif didukung lonjakan minyak global.'
  },
  {
    rank: 2,
    ticker: 'ACES',
    board: 'UTAMA',
    swing_tier: 'SWING_READY',
    confidence: 'A',
    confidence_label: 'A',
    confidence_notes: 'Retail revival',
    score: 86,
    last_price: 845,
    change_pct: 1.81,
    rsi14: 56.1,
    volume_ratio_avg20: 1.6,
    entry_low: 830,
    entry_high: 850,
    stop_loss: 805,
    tp1: 910,
    tp2: 950,
    risk_reward: 2.2,
    entry_timing: 'Masih dekat area entry',
    direction: 'swing kuat',
    status_reason: 'Akumulasi bertahap dengan struktur higher high.'
  }
];

const DT_RESULTS = [
  {
    ticker: 'BUMI',
    board: 'UTAMA',
    status: 'READY_BREAKOUT',
    daytrade_score: 95,
    confidence: 'A+',
    confidence_label: 'A+',
    confidence_notes: 'High flow',
    setup: 'Breakout VWAP',
    last_price: 142,
    change_pct: 5.19,
    volume_ratio_20d: 3.8,
    value_today: 185000000000,
    prespike_score: 88,
    momentum_score: 92,
    entry_low: 138,
    entry_high: 143,
    stop_loss: 135,
    tp1: 152,
    tp2: 158,
    risk_reward: 2.8,
    entry_timing: 'Masih dekat area entry',
    direction: 'naik kuat',
    time_plan: 'Sesi 1 Pagi',
    signal_reason: 'Lonjakan volume transaksi masif di pembukaan pasar.'
  },
  {
    ticker: 'DOID',
    board: 'UTAMA',
    status: 'PRE_SPIKE_WATCH',
    daytrade_score: 82,
    confidence: 'A',
    confidence_label: 'A',
    confidence_notes: 'Pre-spike flow',
    setup: 'Pre-Spike Flow',
    last_price: 615,
    change_pct: 2.5,
    volume_ratio_20d: 1.9,
    value_today: 42000000000,
    prespike_score: 85,
    momentum_score: 78,
    entry_low: 600,
    entry_high: 620,
    stop_loss: 585,
    tp1: 655,
    tp2: 680,
    risk_reward: 2.1,
    entry_timing: 'Masih dekat area entry',
    direction: 'naik moderat',
    time_plan: 'Sesi 1 / Sesi 2',
    signal_reason: 'Deteksi akumulasi awal sebelum spike resisten.'
  }
];

// Mock HTTP server
const server = http.createServer((req, res) => {
  req.resume();
  const url = new URL(req.url, 'http://localhost:3344');

  if (url.pathname === '/api/maintenance-settings') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, config: { maintenanceMode: false } }));
    return;
  }

  if (url.pathname === '/api/admin-users' || url.pathname === '/api/subscription/access') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, user_id: 'test-user-id', tier: 'approved', is_approved: true }));
    return;
  }

  if (url.pathname === '/api/auth/me' || url.pathname === '/api/login-user') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, user: { username: 'trader_pro', is_approved: true } }));
    return;
  }

  if (url.pathname === '/api/reset-password') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      profile: {
        username: 'trader_pro',
        is_admin: false,
        is_approved: true,
        subscription: {
          entitlement: {
            premium: true,
            access_level: 'premium'
          }
        }
      }
    }));
    return;
  }

  if (url.pathname === '/api/sector-hot') {
    const action = url.searchParams.get('action');
    if (action === 'screener') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        meta: { universe_count: 52, scanned_count: 52, failed_count: 0, calculated_at: new Date().toISOString(), status: 'ok' },
        results: KONG_RESULTS
      }));
      return;
    }
    if (action === 'non_konglo_screener') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        meta: { universe_count: 120, scanned_count: 120, failed_count: 0, calculated_at: new Date().toISOString(), status: 'ok' },
        results: NK_RESULTS
      }));
      return;
    }
    if (action === 'daytrade_screener' || action === 'daytrade-screener') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        meta: { universe_count: 85, scanned_count: 85, failed_count: 0, calculated_at: new Date().toISOString(), status: 'ok' },
        results: DT_RESULTS
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, results: [] }));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // Serve static files
  let filePath = path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'laptop-1024', width: 1024, height: 768 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'mobile-390', width: 390, height: 844, isMobile: true, hasTouch: true }
];

async function capture() {
  await new Promise(resolve => server.listen(3344, resolve));
  console.log('Mock server listening on port 3344');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const measurements = {};

  try {
    for (const vp of VIEWPORTS) {
      for (const theme of ['dark', 'light']) {
        const page = await browser.newPage();
        await page.setViewport({
          width: vp.width,
          height: vp.height,
          isMobile: Boolean(vp.isMobile),
          hasTouch: Boolean(vp.hasTouch)
        });

        // Set storage before navigating
        await page.goto('http://localhost:3344/', { waitUntil: 'domcontentloaded' });
        await page.evaluate((th) => {
          localStorage.setItem('autocuan_logged_in', 'true');
          localStorage.setItem('autocuan_user', 'trader_pro');
          localStorage.setItem('autocuan_username', 'trader_pro');
          localStorage.setItem('autocuan_user_id', 'test-user-id');
          localStorage.setItem('autocuan_is_admin', 'false');
          localStorage.setItem('autocuan_login_time', Date.now().toString());
          localStorage.setItem('autocuan_entered_app', 'true');
          localStorage.setItem('auto_cuan_onboarding_seen', 'true');
          localStorage.setItem('autocuan_theme', th);
          localStorage.setItem('theme', th);
          if (th === 'light') {
            document.documentElement.classList.add('light');
            document.documentElement.classList.remove('dark');
          } else {
            document.documentElement.classList.add('dark');
            document.documentElement.classList.remove('light');
          }
        }, theme);

        // Reload to let auth state apply and navigate to screener
        await page.goto('http://localhost:3344/', { waitUntil: 'networkidle0' });
        await page.evaluate(async () => {
          if (typeof setTopLevelView === 'function') setTopLevelView('app');
          if (typeof loadPremiumAccess === 'function') await loadPremiumAccess(true);
          if (typeof navigateTo === 'function') navigateTo('screener');
          if (typeof loadSwingScreener === 'function') await loadSwingScreener(true);
        });

        await page.waitForSelector('#screenerTableBody tr', { timeout: 5000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1000));

        // Measure Konglo mode
        const kongloMetrics = await page.evaluate(() => {
          const wrap = document.getElementById('screenerTableWrap');
          const table = wrap ? wrap.querySelector('table') : null;
          const firstRow = table ? table.querySelector('tbody tr') : null;
          const headerRow = table ? table.querySelector('thead tr') : null;
          const headerCols = headerRow ? headerRow.querySelectorAll('th') : [];
          const firstCol = headerCols.length > 0 ? headerCols[0] : null;
          const actionCol = headerCols.length > 0 ? headerCols[headerCols.length - 1] : null;

          // Check computed font of numeric cells
          let numericFontFamily = '';
          if (firstRow) {
            const numTd = firstRow.querySelector('td.tabular-nums');
            if (numTd) numericFontFamily = window.getComputedStyle(numTd).fontFamily;
          }

          return {
            tableOuterWidth: wrap ? wrap.clientWidth : 0,
            tableScrollWidth: wrap ? wrap.scrollWidth : 0,
            visibleViewportWidth: window.innerWidth,
            defaultColumnCount: headerCols.length,
            rowHeight: firstRow ? Math.round(firstRow.getBoundingClientRect().height) : 0,
            headerHeight: headerRow ? Math.round(headerRow.getBoundingClientRect().height) : 0,
            firstColWidth: firstCol ? Math.round(firstCol.getBoundingClientRect().width) : 0,
            actionColWidth: actionCol ? Math.round(actionCol.getBoundingClientRect().width) : 0,
            hasHorizontalOverflow: wrap ? wrap.scrollWidth > wrap.clientWidth : false,
            numericFontFamily: numericFontFamily
          };
        });

        // Test Non-Konglo mode
        await page.evaluate(async () => {
          if (typeof switchScreenerType === 'function') switchScreenerType('nonkonglo');
          if (typeof loadNonKongloScreener === 'function') await loadNonKongloScreener(true);
        });
        await new Promise(r => setTimeout(r, 600));

        const nonKongloMetrics = await page.evaluate(() => {
          const wrap = document.getElementById('nkScreenerTableWrap');
          const table = wrap ? wrap.querySelector('table') : null;
          const firstRow = table ? table.querySelector('tbody tr') : null;
          const headerRow = table ? table.querySelector('thead tr') : null;
          const headerCols = headerRow ? headerRow.querySelectorAll('th') : [];
          const firstCol = headerCols.length > 0 ? headerCols[0] : null;
          const actionCol = headerCols.length > 0 ? headerCols[headerCols.length - 1] : null;

          return {
            tableOuterWidth: wrap ? wrap.clientWidth : 0,
            tableScrollWidth: wrap ? wrap.scrollWidth : 0,
            visibleViewportWidth: window.innerWidth,
            defaultColumnCount: headerCols.length,
            rowHeight: firstRow ? Math.round(firstRow.getBoundingClientRect().height) : 0,
            headerHeight: headerRow ? Math.round(headerRow.getBoundingClientRect().height) : 0,
            firstColWidth: firstCol ? Math.round(firstCol.getBoundingClientRect().width) : 0,
            actionColWidth: actionCol ? Math.round(actionCol.getBoundingClientRect().width) : 0,
            hasHorizontalOverflow: wrap ? wrap.scrollWidth > wrap.clientWidth : false
          };
        });

        // Test Day Trade mode
        await page.evaluate(async () => {
          if (typeof switchScreenerType === 'function') switchScreenerType('daytrade');
          if (typeof loadDayTradeScreener === 'function') await loadDayTradeScreener(true);
        });
        await new Promise(r => setTimeout(r, 600));

        const dayTradeMetrics = await page.evaluate(() => {
          const wrap = document.getElementById('dtScreenerTableWrap');
          const table = wrap ? wrap.querySelector('table') : null;
          const firstRow = table ? table.querySelector('tbody tr') : null;
          const headerRow = table ? table.querySelector('thead tr') : null;
          const headerCols = headerRow ? headerRow.querySelectorAll('th') : [];
          const firstCol = headerCols.length > 0 ? headerCols[0] : null;
          const actionCol = headerCols.length > 0 ? headerCols[headerCols.length - 1] : null;

          return {
            tableOuterWidth: wrap ? wrap.clientWidth : 0,
            tableScrollWidth: wrap ? wrap.scrollWidth : 0,
            visibleViewportWidth: window.innerWidth,
            defaultColumnCount: headerCols.length,
            rowHeight: firstRow ? Math.round(firstRow.getBoundingClientRect().height) : 0,
            headerHeight: headerRow ? Math.round(headerRow.getBoundingClientRect().height) : 0,
            firstColWidth: firstCol ? Math.round(firstCol.getBoundingClientRect().width) : 0,
            actionColWidth: actionCol ? Math.round(actionCol.getBoundingClientRect().width) : 0,
            hasHorizontalOverflow: wrap ? wrap.scrollWidth > wrap.clientWidth : false
          };
        });

        // Switch back to Konglo for screenshots
        await page.evaluate(() => {
          if (typeof switchScreenerType === 'function') switchScreenerType('konglo');
        });
        await new Promise(r => setTimeout(r, 400));

        // Measure interactive touch targets
        const touchTargets = await page.evaluate(() => {
          const modeBtn = document.getElementById('scrTypeKonglo');
          const tabBtn = document.querySelector('.screener-tab');
          const retryBtn = document.getElementById('screenerRetryBtn');
          const selectEl = document.querySelector('#screenerContent select');
          return {
            modeSelectorHeight: modeBtn ? Math.round(modeBtn.getBoundingClientRect().height) : 0,
            tabHeight: tabBtn ? Math.round(tabBtn.getBoundingClientRect().height) : 0,
            retryBtnHeight: retryBtn ? Math.round(retryBtn.getBoundingClientRect().height) : 0,
            selectHeight: selectEl ? Math.round(selectEl.getBoundingClientRect().height) : 0
          };
        });

        const key = `${vp.name}-${theme}`;
        measurements[key] = {
          viewport: vp,
          theme: theme,
          konglo: kongloMetrics,
          nonKonglo: nonKongloMetrics,
          dayTrade: dayTradeMetrics,
          touchTargets: touchTargets
        };

        console.log(`[${key}] Measurements captured.`);

        // Capture general screener screenshot
        const filename = `screener-${vp.name}-${theme}.png`;
        const outPath = path.join(OUT_DIR, filename);
        await page.screenshot({ path: outPath, fullPage: false });
        console.log(`Captured: ${filename}`);

        // If desktop 1440 dark, also capture dedicated non-konglo and daytrade shots
        if (vp.name === 'desktop-1440' && theme === 'dark') {
          // Non-Konglo
          await page.evaluate(() => {
            if (typeof switchScreenerType === 'function') switchScreenerType('nonkonglo');
          });
          await new Promise(r => setTimeout(r, 400));
          await page.screenshot({ path: path.join(OUT_DIR, 'screener-nonkonglo-desktop-1440-dark.png'), fullPage: false });
          console.log('Captured: screener-nonkonglo-desktop-1440-dark.png');

          // Day Trade
          await page.evaluate(() => {
            if (typeof switchScreenerType === 'function') switchScreenerType('daytrade');
          });
          await new Promise(r => setTimeout(r, 400));
          await page.screenshot({ path: path.join(OUT_DIR, 'screener-daytrade-desktop-1440-dark.png'), fullPage: false });
          console.log('Captured: screener-daytrade-desktop-1440-dark.png');
        }

        await page.close();
      }
    }

    fs.writeFileSync(path.join(OUT_DIR, 'metrics.json'), JSON.stringify(measurements, null, 2), 'utf8');
    console.log('Saved metrics to test-artifacts/wave2a-screenshots/metrics.json');

  } finally {
    await browser.close();
    server.close();
    console.log('Capture completed successfully.');
  }
}

capture().catch(err => {
  console.error('Capture error:', err);
  process.exit(1);
});
