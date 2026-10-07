'use strict';
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots', 'wave1-foundations');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3038;
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
  console.log('[Wave1-Capture] Starting local-dev-server on port ' + PORT + '...');
  const serverProcess = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });

  let browser;
  try {
    await waitForServer(BASE_URL);
    console.log('[Wave1-Capture] local-dev-server ready at ' + BASE_URL);

    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();

    async function setSession(theme = 'light', suppressOnboarding = true) {
      await page.evaluate((th, supp) => {
        localStorage.setItem('autocuan_user', 'budi');
        localStorage.setItem('autocuan_role', 'ADMIN');
        localStorage.setItem('autocuan_auth', '1');
        localStorage.setItem('autocuan_theme', th);
        if (supp) {
          localStorage.setItem('auto_cuan_onboarding_seen', 'true');
        } else {
          localStorage.removeItem('auto_cuan_onboarding_seen');
        }
        document.cookie = 'autocuan_session=test-budi-admin; path=/';
      }, theme, suppressOnboarding);
    }

    // 1. Desktop Foundations 1440x900 (Light)
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2' });
    await setSession('light', true);
    await page.reload({ waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 1000));
    const dest1 = path.join(SCREENSHOT_DIR, '01-workstation-foundations-desktop-1440x900.png');
    await page.screenshot({ path: dest1 });
    console.log('[Wave1-Capture] Saved: ' + dest1);

    // 2. Tablet Foundations 768x1024 (Light)
    await page.setViewport({ width: 768, height: 1024 });
    await page.reload({ waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 800));
    const dest2 = path.join(SCREENSHOT_DIR, '02-workstation-foundations-tablet-768x1024.png');
    await page.screenshot({ path: dest2 });
    console.log('[Wave1-Capture] Saved: ' + dest2);

    // 3. Mobile Foundations 390x844 (Light)
    await page.setViewport({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 800));
    const dest3 = path.join(SCREENSHOT_DIR, '03-workstation-foundations-mobile-390x844.png');
    await page.screenshot({ path: dest3 });
    console.log('[Wave1-Capture] Saved: ' + dest3);

    // 4. Desktop Foundations 1440x900 (Dark - Night Research Mode Verification)
    await page.setViewport({ width: 1440, height: 900 });
    await setSession('dark', true);
    await page.reload({ waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      if (typeof window.applyAppTheme === 'function') {
        window.applyAppTheme('dark');
      }
    });
    await new Promise(r => setTimeout(r, 1000));
    const dest4 = path.join(SCREENSHOT_DIR, '04-workstation-foundations-dark-desktop-1440x900.png');
    await page.screenshot({ path: dest4 });
    console.log('[Wave1-Capture] Saved: ' + dest4);

    // 5. Onboarding Modal Desktop Light (1440x900) - Contrast QC
    await page.setViewport({ width: 1440, height: 900 });
    await setSession('light', false);
    await page.reload({ waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      if (typeof window.applyAppTheme === 'function') window.applyAppTheme('light');
      if (typeof window.showOnboardingGuide === 'function') window.showOnboardingGuide();
    });
    await new Promise(r => setTimeout(r, 800));
    const dest5 = path.join(SCREENSHOT_DIR, '05-onboarding-contrast-desktop-light-1440x900.png');
    await page.screenshot({ path: dest5 });
    console.log('[Wave1-Capture] Saved: ' + dest5);

    // 6. Onboarding Modal Mobile Light (390x844) - Contrast QC
    await page.setViewport({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      if (typeof window.applyAppTheme === 'function') window.applyAppTheme('light');
      if (typeof window.showOnboardingGuide === 'function') window.showOnboardingGuide();
    });
    await new Promise(r => setTimeout(r, 800));
    const dest6 = path.join(SCREENSHOT_DIR, '06-onboarding-contrast-mobile-light-390x844.png');
    await page.screenshot({ path: dest6 });
    console.log('[Wave1-Capture] Saved: ' + dest6);

    // 7. Onboarding Modal Desktop Dark (1440x900) - Contrast QC
    await page.setViewport({ width: 1440, height: 900 });
    await setSession('dark', false);
    await page.reload({ waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      if (typeof window.applyAppTheme === 'function') window.applyAppTheme('dark');
      if (typeof window.showOnboardingGuide === 'function') window.showOnboardingGuide();
    });
    await new Promise(r => setTimeout(r, 800));
    const dest7 = path.join(SCREENSHOT_DIR, '07-onboarding-contrast-desktop-dark-1440x900.png');
    await page.screenshot({ path: dest7 });
    console.log('[Wave1-Capture] Saved: ' + dest7);

    console.log('[Wave1-Capture] Wave 1 screenshot evidence capture complete.');
  } finally {
    if (browser) await browser.close();
    serverProcess.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error('[Wave1-Capture] Error:', err);
  process.exit(1);
});
