'use strict';
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots', 'wave2-shell-navigation');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3039;
const BASE_URL = `http://127.0.0.1:${PORT}`;

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      http.get(url, (res) => {
        resolve();
      }).on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error('Server start timed out on ' + url));
        } else {
          setTimeout(check, 300);
        }
      });
    }
    check();
  });
}

async function run() {
  console.log('[Wave2-Capture] Starting local-dev-server on port ' + PORT + '...');
  const serverProcess = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });

  let browser;
  try {
    await waitForServer(BASE_URL);
    console.log('[Wave2-Capture] local-dev-server ready at ' + BASE_URL);

    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();

    async function setSession(theme = 'light') {
      await page.evaluate((th) => {
        localStorage.setItem('autocuan_user', 'budi');
        localStorage.setItem('autocuan_role', 'ADMIN');
        localStorage.setItem('autocuan_auth', '1');
        localStorage.setItem('autocuan_logged_in', 'true');
        localStorage.setItem('autocuan_theme', th);
        localStorage.setItem('auto_cuan_onboarding_seen', 'true');
        document.cookie = 'autocuan_session=test-budi-admin; path=/';
      }, theme);
    }

    async function ensurePremiumAndTheme(theme = 'light') {
      await page.evaluate((th) => {
        if (typeof window.applyAppTheme === 'function') {
          window.applyAppTheme(th);
        }
        window.premiumAccessState = { state: 'ready', premium: true, accessLevel: 'admin' };
        if (typeof window.applyPremiumAccessUi === 'function') {
          window.applyPremiumAccessUi();
        }
      }, theme);
    }

    // 1. Desktop Shell + Quiet Topbar + Final Sidebar IA (1440x900 Light) - Unobstructed
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2' });
    await setSession('light');
    await page.reload({ waitUntil: 'networkidle2' });
    await ensurePremiumAndTheme('light');
    await new Promise(r => setTimeout(r, 800));
    const dest1 = path.join(SCREENSHOT_DIR, '01-desktop-shell-quiet-topbar-1440x900.png');
    await page.screenshot({ path: dest1 });
    console.log('[Wave2-Capture] Saved: ' + dest1);

    // 2. Desktop Account Card & Navigation Hierarchy Detail (Screener Discover active)
    await page.evaluate(() => {
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('screener');
      }
    });
    await new Promise(r => setTimeout(r, 800));
    const dest2 = path.join(SCREENSHOT_DIR, '02-desktop-sidebar-active-discover-1440x900.png');
    await page.screenshot({ path: dest2 });
    console.log('[Wave2-Capture] Saved: ' + dest2);

    // 3. Tablet Navigation State (768x1024 Light) - Unobstructed
    await page.setViewport({ width: 768, height: 1024 });
    await page.evaluate(() => {
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('dashboard');
      }
    });
    await page.reload({ waitUntil: 'networkidle2' });
    await ensurePremiumAndTheme('light');
    await new Promise(r => setTimeout(r, 800));
    const dest3 = path.join(SCREENSHOT_DIR, '03-tablet-navigation-768x1024.png');
    await page.screenshot({ path: dest3 });
    console.log('[Wave2-Capture] Saved: ' + dest3);

    // 4. Mobile Navigation State (390x844 Light) with Quiet Header & Floating Launcher
    await page.setViewport({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'networkidle2' });
    await ensurePremiumAndTheme('light');
    await new Promise(r => setTimeout(r, 800));
    const dest4 = path.join(SCREENSHOT_DIR, '04-mobile-navigation-390x844.png');
    await page.screenshot({ path: dest4 });
    console.log('[Wave2-Capture] Saved: ' + dest4);

    // 5. Desktop Dark Shell (1440x900 Dark) - Unobstructed
    await page.setViewport({ width: 1440, height: 900 });
    await setSession('dark');
    await page.reload({ waitUntil: 'networkidle2' });
    await ensurePremiumAndTheme('dark');
    await new Promise(r => setTimeout(r, 800));
    const dest5 = path.join(SCREENSHOT_DIR, '05-desktop-shell-dark-1440x900.png');
    await page.screenshot({ path: dest5 });
    console.log('[Wave2-Capture] Saved: ' + dest5);

    // 6. Account Center Opened from Sidebar Profile Entry (1440x900 Light)
    await page.setViewport({ width: 1440, height: 900 });
    await setSession('light');
    await page.reload({ waitUntil: 'networkidle2' });
    await ensurePremiumAndTheme('light');
    await new Promise(r => setTimeout(r, 800));
    await page.evaluate(() => {
      var profileBtn = document.querySelector('#appSidebar .sidebar-profile-button');
      if (profileBtn) profileBtn.click();
      else if (typeof window.openAccountProfile === 'function') window.openAccountProfile();
    });
    await new Promise(r => setTimeout(r, 800));
    const dest6 = path.join(SCREENSHOT_DIR, '06-desktop-account-center-modal-1440x900.png');
    await page.screenshot({ path: dest6 });
    console.log('[Wave2-Capture] Saved: ' + dest6);

    // 7. Sidebar MONITOR Group Visibility Check (1440x900 Light)
    await page.reload({ waitUntil: 'networkidle2' });
    await ensurePremiumAndTheme('light');
    const monitorStatus = await page.evaluate(() => {
      const monitorSection = document.querySelector('.sidebar-nav-group[aria-label="Monitor"]');
      const watchlistBtn = document.querySelector('button[data-sidebar-page="watchlist"]');
      const portfolioBtn = document.querySelector('button[data-sidebar-page="portofolio"]');
      const trackRecordBtn = document.querySelector('button[data-sidebar-page="trackrecord"]');
      return {
        sectionFound: !!monitorSection,
        watchlistVisible: watchlistBtn ? !watchlistBtn.classList.contains('hidden') : false,
        portfolioVisible: portfolioBtn ? !portfolioBtn.classList.contains('hidden') : false,
        trackRecordVisible: trackRecordBtn ? !trackRecordBtn.classList.contains('hidden') : false
      };
    });
    console.log('[Wave2-Capture] MONITOR Group status:', monitorStatus);
    await page.evaluate(() => {
      const nav = document.querySelector('#appSidebar .sidebar-nav');
      if (nav) nav.scrollTop = nav.scrollHeight;
    });
    await new Promise(r => setTimeout(r, 400));
    const dest7 = path.join(SCREENSHOT_DIR, '07-sidebar-monitor-group-1440x900.png');
    await page.screenshot({ path: dest7 });
    console.log('[Wave2-Capture] Saved: ' + dest7);

    console.log('[Wave2-Capture] All Wave 2 evidence screenshots captured successfully.');
  } finally {
    if (browser) await browser.close();
    serverProcess.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error('[Wave2-Capture] Error:', err);
  process.exit(1);
});
