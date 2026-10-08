'use strict';
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots', 'wave6-dashboard-research');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3050;
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
  console.log(`[Wave6b-Capture] Starting local-dev-server on port ${PORT}...`);
  const serverProcess = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SUPABASE_URL: '' },
    stdio: 'ignore'
  });

  let browser;
  try {
    await waitForServer(`${BASE_URL}/health`);
    console.log(`[Wave6b-Capture] local-dev-server ready at ${BASE_URL}`);

    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'x-autocuan-preview': '1' });

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

    async function dismissOverlays() {
      await page.evaluate(() => {
        if (typeof window.hideOnboardingGuide === 'function') {
          window.hideOnboardingGuide(true);
        }
        const modal = document.getElementById('accountCenterModal');
        if (modal) {
          modal.classList.add('hidden');
          modal.style.display = 'none';
        }
        const backdrop = document.querySelector('.modal-backdrop');
        if (backdrop) {
          backdrop.classList.add('hidden');
          backdrop.style.display = 'none';
        }
      });
    }

    async function setLight() {
      await page.evaluate(() => {
        if (typeof window.applyAppTheme === 'function') {
          window.applyAppTheme('light');
        } else {
          document.documentElement.classList.remove('dark');
          document.documentElement.classList.add('light');
          document.documentElement.setAttribute('data-theme', 'light');
          if (document.body) {
            document.body.classList.remove('dark');
            document.body.classList.add('light');
          }
        }
        localStorage.setItem('theme', 'light');
        localStorage.setItem('autocuan_theme', 'light');
        localStorage.setItem('auto_cuan_theme', 'light');
      });
      await new Promise(r => setTimeout(r, 200));
    }

    async function setDark() {
      await page.evaluate(() => {
        if (typeof window.applyAppTheme === 'function') {
          window.applyAppTheme('dark');
        } else {
          document.documentElement.classList.remove('light');
          document.documentElement.classList.add('dark');
          document.documentElement.setAttribute('data-theme', 'dark');
          if (document.body) {
            document.body.classList.remove('light');
            document.body.classList.add('dark');
          }
        }
        localStorage.setItem('theme', 'dark');
        localStorage.setItem('autocuan_theme', 'dark');
        localStorage.setItem('auto_cuan_theme', 'dark');
      });
      await new Promise(r => setTimeout(r, 200));
    }

    // 1. Desktop Light (1440x900)
    console.log('[Wave6b-Capture] Capturing Desktop Light...');
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2' });
    await setLight();
    await dismissOverlays();
    await new Promise(r => setTimeout(r, 600));

    const lightPath = path.join(SCREENSHOT_DIR, 'wave6b-sidebar-desktop-light-1440x900.png');
    await page.screenshot({ path: lightPath, fullPage: false });
    console.log(`Saved: ${lightPath}`);

    // 2. Desktop Dark (1440x900)
    console.log('[Wave6b-Capture] Capturing Desktop Dark...');
    await setDark();
    await dismissOverlays();
    await new Promise(r => setTimeout(r, 600));

    const darkPath = path.join(SCREENSHOT_DIR, 'wave6b-sidebar-desktop-dark-1440x900.png');
    await page.screenshot({ path: darkPath, fullPage: false });
    console.log(`Saved: ${darkPath}`);

    // 3. Mobile View (390x844) with sidebar drawer open
    console.log('[Wave6b-Capture] Capturing Mobile View with drawer open...');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await setLight();
    await dismissOverlays();
    await page.evaluate(() => {
      if (typeof window.openMobileSidebar === 'function') {
        window.openMobileSidebar();
      } else {
        const sidebar = document.getElementById('appSidebar');
        if (sidebar) sidebar.classList.add('mobile-open');
        const scrim = document.getElementById('sidebarScrim');
        if (scrim) scrim.classList.remove('hidden');
      }
    });
    await new Promise(r => setTimeout(r, 600));

    const mobilePath = path.join(SCREENSHOT_DIR, 'wave6b-sidebar-mobile-390x844.png');
    await page.screenshot({ path: mobilePath, fullPage: false });
    console.log(`Saved: ${mobilePath}`);

    console.log('[Wave6b-Capture] All 3 screenshots captured successfully.');
  } finally {
    if (browser) await browser.close();
    serverProcess.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error('[Wave6b-Capture] ERROR:', err);
  process.exit(1);
});
