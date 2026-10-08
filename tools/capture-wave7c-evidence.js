'use strict';
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots', 'wave7-evidence');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3058;
const BASE_URL = `http://127.0.0.1:${PORT}`;

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      http.get(url, (res) => {
        resolve();
      }).on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timeout waiting for server at ${url}`));
        } else {
          setTimeout(check, 300);
        }
      });
    }
    check();
  });
}

async function run() {
  console.log(`[Wave7C-Evidence] Starting local-dev-server on port ${PORT}...`);
  const serverProcess = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SUPABASE_URL: '' },
    stdio: 'ignore'
  });

  let browser;
  try {
    await waitForServer(`${BASE_URL}/health`);
    console.log('[Wave7C-Evidence] Server is ready.');

    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'x-autocuan-preview': '1' });
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

    // Seed empty portfolio storage & admin auth
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('autocuan_user', 'budi');
      localStorage.setItem('autocuan_role', 'admin');
      localStorage.setItem('autocuan_is_admin', 'true');
      localStorage.setItem('autocuan_auth', '1');
      localStorage.setItem('autocuan_logged_in', 'true');
      localStorage.setItem('autocuan_username', 'budi');
      localStorage.setItem('autocuan_user_id', 'usr_budi_01');
      localStorage.setItem('auto_cuan_onboarding_seen', 'true');
      localStorage.setItem('has_seen_onboarding', 'true');
      localStorage.setItem('autocuan_onboarding_completed', 'true');
      localStorage.setItem('autocuan_portfolio_plans_local-dev-admin', JSON.stringify([]));
      localStorage.setItem('autocuan_portfolio_prices_local-dev-admin', JSON.stringify({}));
      localStorage.setItem('autocuan_portfolio_plans_usr_budi_01', JSON.stringify([]));
      localStorage.setItem('autocuan_portfolio_prices_usr_budi_01', JSON.stringify({}));
      localStorage.setItem('autocuan_watchlist_usr_budi_01', JSON.stringify([]));
      document.cookie = 'autocuan_session=test-budi-admin; path=/';
    });

    await page.setRequestInterception(true);
    let returnEmptyWatchlist = false;

    page.on('request', (req) => {
      if (returnEmptyWatchlist && req.url().includes('action=watchlist')) {
        req.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, watchlist: [] })
        });
      } else {
        req.continue();
      }
    });

    // 1. wave7c-portfolio-empty-light-1440x900.png
    console.log('Capturing 1. wave7c-portfolio-empty-light-1440x900.png...');
    await page.goto(`${BASE_URL}/dashboard?page=portofolio&preview=1`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      if (typeof window.applyAppTheme === 'function') window.applyAppTheme('light');
      if (typeof window.navigateTo === 'function') window.navigateTo('portofolio');
      if (typeof window.openPortfolioTab === 'function') window.openPortfolioTab('today');
    });
    await new Promise(r => setTimeout(r, 1000));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave7c-portfolio-empty-light-1440x900.png') });

    // 2. wave7c-portfolio-empty-dark-1440x900.png
    console.log('Capturing 2. wave7c-portfolio-empty-dark-1440x900.png...');
    await page.evaluate(() => {
      if (typeof window.applyAppTheme === 'function') window.applyAppTheme('dark');
      if (typeof window.navigateTo === 'function') window.navigateTo('portofolio');
      if (typeof window.openPortfolioTab === 'function') window.openPortfolioTab('today');
    });
    await new Promise(r => setTimeout(r, 1000));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave7c-portfolio-empty-dark-1440x900.png') });

    // 3. wave7c-monitoring-states-light-1440x900.png (Watchlist Empty in Light Mode)
    console.log('Capturing 3. wave7c-monitoring-states-light-1440x900.png...');
    returnEmptyWatchlist = true;
    await page.evaluate(async () => {
      if (typeof window.applyAppTheme === 'function') window.applyAppTheme('light');
      if (typeof window.navigateTo === 'function') window.navigateTo('watchlist');
      if (window.AutoCuanKeepAlive && typeof window.AutoCuanKeepAlive.invalidate === 'function') {
        window.AutoCuanKeepAlive.invalidate('/api/sector-hot?action=watchlist');
      }
      if (typeof window.loadUserWatchlist === 'function') {
        await window.loadUserWatchlist(true);
      }
    });
    await new Promise(r => setTimeout(r, 1200));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave7c-monitoring-states-light-1440x900.png') });

    // 4. wave7c-monitoring-states-dark-1440x900.png (Watchlist Empty in Dark Mode)
    console.log('Capturing 4. wave7c-monitoring-states-dark-1440x900.png...');
    await page.evaluate(async () => {
      if (typeof window.applyAppTheme === 'function') window.applyAppTheme('dark');
      if (typeof window.navigateTo === 'function') window.navigateTo('watchlist');
      if (window.AutoCuanKeepAlive && typeof window.AutoCuanKeepAlive.invalidate === 'function') {
        window.AutoCuanKeepAlive.invalidate('/api/sector-hot?action=watchlist');
      }
      if (typeof window.loadUserWatchlist === 'function') {
        await window.loadUserWatchlist(true);
      }
    });
    await new Promise(r => setTimeout(r, 1200));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave7c-monitoring-states-dark-1440x900.png') });

    console.log('Successfully captured all 4 required evidence screenshots!');
  } finally {
    if (browser) await browser.close();
    serverProcess.kill();
  }
}

run().catch((err) => {
  console.error('[Wave7C-Evidence] Error:', err);
  process.exit(1);
});
