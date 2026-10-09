'use strict';
const puppeteer = require('D:/auto-cuan-2/node_modules/puppeteer-core');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots', 'integrity-audit');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3049;
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
  console.log(`[Integrity-Capture] Starting local-dev-server on port ${PORT}...`);
  const serverProcess = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SUPABASE_URL: '' },
    stdio: 'ignore'
  });

  let browser;
  try {
    await waitForServer(`${BASE_URL}/health`);
    console.log(`[Integrity-Capture] local-dev-server ready at ${BASE_URL}`);

    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();

    async function setLight() {
      await page.evaluate(() => {
        document.documentElement.classList.remove('dark');
        document.documentElement.classList.add('light');
        document.documentElement.setAttribute('data-theme', 'light');
        localStorage.setItem('theme', 'light');
        localStorage.setItem('autocuan_theme', 'light');
      });
    }

    async function dismissOverlays() {
      await page.evaluate(() => {
        localStorage.setItem('autocuan_logged_in', 'true');
        localStorage.setItem('autocuan_username', 'budi');
        localStorage.setItem('autocuan_role', 'admin');
        localStorage.setItem('autocuan_is_admin', 'true');
        localStorage.setItem('autocuan_user_id', 'usr_budi_01');
        localStorage.setItem('auto_cuan_onboarding_seen', 'true');
        localStorage.setItem('has_seen_onboarding', 'true');
        if (typeof window.hideOnboardingGuide === 'function') {
          window.hideOnboardingGuide(true);
        }
        const modal = document.getElementById('accountCenterModal');
        if (modal) {
          modal.classList.add('hidden');
          modal.style.display = 'none';
        }
        const onboarding = document.getElementById('onboardingModal');
        if (onboarding) {
          onboarding.classList.add('hidden');
          onboarding.style.display = 'none';
        }
      });
    }

    // 1. integrity-shell-dashboard-1440x900.png
    console.log('[Integrity-Capture] Capturing integrity-shell-dashboard-1440x900.png...');
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/dashboard?page=dashboard&preview=1`, { waitUntil: 'networkidle2' });
    await dismissOverlays();
    await setLight();
    await page.evaluate(async () => {
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('dashboard');
      }
      await new Promise(r => setTimeout(r, 600));
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'integrity-shell-dashboard-1440x900.png') });

    // 2. integrity-financial-1440x900.png
    console.log('[Integrity-Capture] Capturing integrity-financial-1440x900.png...');
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/dashboard?page=analisis&tab=financial&ticker=BBCA&preview=1`, { waitUntil: 'networkidle2' });
    await dismissOverlays();
    await setLight();
    await page.evaluate(async () => {
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('analisis', 'financial');
      }
      if (typeof window.loadFinancialStructureTab === 'function') {
        await window.loadFinancialStructureTab('financial', 'BBCA');
      }
      await new Promise(r => setTimeout(r, 600));
    });
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'integrity-financial-1440x900.png') });

    // 3. integrity-structure-market-1440x900.png
    console.log('[Integrity-Capture] Capturing integrity-structure-market-1440x900.png...');
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/dashboard?page=analisis&tab=market-structure&ticker=BBCA&preview=1`, { waitUntil: 'networkidle2' });
    await dismissOverlays();
    await setLight();
    await page.evaluate(async () => {
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('analisis', 'market-structure');
      }
      if (typeof window.loadFinancialStructureTab === 'function') {
        await window.loadFinancialStructureTab('market-structure', 'BBCA');
      }
      await new Promise(r => setTimeout(r, 600));
    });
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'integrity-structure-market-1440x900.png') });

    // 4. integrity-screener-1440x900.png
    console.log('[Integrity-Capture] Capturing integrity-screener-1440x900.png...');
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/dashboard?page=screener&mode=konglo&preview=1`, { waitUntil: 'networkidle2' });
    await dismissOverlays();
    await setLight();
    await page.evaluate(async () => {
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('screener');
      }
      if (typeof window.switchScreenerSubTab === 'function') {
        window.switchScreenerSubTab('konglo');
      }
      if (typeof window.loadSwingScreener === 'function') {
        await window.loadSwingScreener();
      }
      await new Promise(r => setTimeout(r, 600));
      if (window.AutoCuanScreener && typeof window.AutoCuanScreener.selectRow === 'function') {
        window.AutoCuanScreener.selectRow('konglo', 'BBCA');
      }
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'integrity-screener-1440x900.png') });

    // 5. integrity-mobile-390x844.png
    console.log('[Integrity-Capture] Capturing integrity-mobile-390x844.png...');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(`${BASE_URL}/dashboard?page=dashboard&preview=1`, { waitUntil: 'networkidle2' });
    await dismissOverlays();
    await setLight();
    await page.evaluate(async () => {
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('dashboard');
      }
      await new Promise(r => setTimeout(r, 600));
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'integrity-mobile-390x844.png') });

    console.log('[Integrity-Capture] All 5 integrity screenshots captured successfully.');
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    serverProcess.kill();
  }
}

run().catch((err) => {
  console.error('[Integrity-Capture] ERROR:', err);
  process.exit(1);
});
