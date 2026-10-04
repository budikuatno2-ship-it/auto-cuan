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

// Mock server for static files and API responses
const server = http.createServer((req, res) => {
  req.resume();
  const url = new URL(req.url, 'http://localhost:3344');
  // console.log('HTTP:', req.method, url.pathname);

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
        meta: {
          universe_count: 52,
          scanned_count: 52,
          failed_count: 0,
          calculated_at: new Date().toISOString(),
          status: 'ok'
        },
        results: [
          {
            ticker: 'BBCA',
            group_code: 'Djarum',
            swing_tier: 'A_PLUS_SWING',
            confidence: 'A+',
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
        ]
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
        await new Promise(r => setTimeout(r, 1200));

        const accessState = await page.evaluate(() => window.premiumAccessState);
        console.log(`[${vp.name}-${theme}] accessState:`, accessState);

        const filename = `screener-${vp.name}-${theme}.png`;
        const outPath = path.join(OUT_DIR, filename);
        await page.screenshot({ path: outPath, fullPage: false });
        console.log(`Captured: ${filename}`);

        await page.close();
      }
    }
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
