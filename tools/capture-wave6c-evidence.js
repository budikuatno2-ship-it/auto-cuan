'use strict';
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots', 'wave6c-evidence');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3056;
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
  console.log(`[Wave6c-Capture] Starting local-dev-server on port ${PORT}...`);
  const serverProcess = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SUPABASE_URL: '' },
    stdio: 'ignore'
  });

  let browser;
  try {
    await waitForServer(`${BASE_URL}/health`);
    console.log(`[Wave6c-Capture] local-dev-server ready at ${BASE_URL}`);

    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'x-autocuan-preview': '1' });

    // Setup authenticated user state
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
      document.cookie = 'autocuan_session=test-budi-admin; path=/';
    });

    // 1. Desktop Light Dashboard (1440x900)
    console.log('[Wave6c-Capture] Capturing 1. wave6c-desktop-light-dashboard-1440x900.png');
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      if (typeof applyAppTheme === 'function') applyAppTheme('light');
      if (typeof navigateTo === 'function') navigateTo('dashboard');
    });
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'wave6c-desktop-light-dashboard-1440x900.png'),
      fullPage: false
    });

    // 2. Desktop Light Broker Hunter (1440x900)
    console.log('[Wave6c-Capture] Capturing 2. wave6c-desktop-light-broker-hunter-1440x900.png');
    await page.evaluate(() => {
      if (typeof navigateTo === 'function') navigateTo('analisis', 'hunter');
    });
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'wave6c-desktop-light-broker-hunter-1440x900.png'),
      fullPage: false
    });

    // 3. Desktop Dark Sinyal Intelijen (1440x900)
    console.log('[Wave6c-Capture] Capturing 3. wave6c-desktop-dark-sinyal-1440x900.png');
    await page.evaluate(() => {
      if (typeof applyAppTheme === 'function') applyAppTheme('dark');
      if (typeof navigateTo === 'function') navigateTo('analisis', 'intel');
    });
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'wave6c-desktop-dark-sinyal-1440x900.png'),
      fullPage: false
    });

    // 4. Mobile Dashboard (390x844)
    console.log('[Wave6c-Capture] Capturing 4. wave6c-mobile-dashboard-390x844.png');
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => {
      if (typeof applyAppTheme === 'function') applyAppTheme('light');
      if (typeof navigateTo === 'function') navigateTo('dashboard');
      if (typeof closeMobileSidebar === 'function') closeMobileSidebar();
    });
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'wave6c-mobile-dashboard-390x844.png'),
      fullPage: false
    });

    // 5. Mobile Nav Open (390x844)
    console.log('[Wave6c-Capture] Capturing 5. wave6c-mobile-nav-open-390x844.png');
    await page.evaluate(() => {
      if (typeof toggleSidebarCollapse === 'function') toggleSidebarCollapse();
    });
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'wave6c-mobile-nav-open-390x844.png'),
      fullPage: false
    });

    // 6. Mobile Data Route (Screener) (390x844)
    console.log('[Wave6c-Capture] Capturing 6. wave6c-mobile-data-route-390x844.png');
    await page.evaluate(() => {
      if (typeof closeMobileSidebar === 'function') closeMobileSidebar();
      if (typeof navigateTo === 'function') navigateTo('screener');
    });
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'wave6c-mobile-data-route-390x844.png'),
      fullPage: false
    });

    console.log('[Wave6c-Capture] All 6 evidence screenshots captured successfully.');
    await browser.close();
  } finally {
    serverProcess.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error('[Wave6c-Capture] Failed:', err);
  process.exit(1);
});
