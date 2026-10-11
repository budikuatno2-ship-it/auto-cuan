'use strict';

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT_DIR = path.resolve(__dirname, '..');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3000;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const OUT_DIRS = [
  path.join(ROOT_DIR),
  path.join(ROOT_DIR, 'screenshots', 'wave10-evidence')
];

OUT_DIRS.forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function checkServer(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      resolve(res.statusCode < 500);
    }).on('error', () => {
      resolve(false);
    });
  });
}

async function run() {
  console.log(`[Wave10-Evidence] Checking server at ${BASE_URL}...`);
  const isUp = await checkServer(`${BASE_URL}/`);
  if (!isUp) {
    console.error(`[Wave10-Evidence] Server not responding at ${BASE_URL}.`);
    process.exit(1);
  }
  console.log('[Wave10-Evidence] Server is responding.');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  async function saveScreenshot(page, filename) {
    for (const outDir of OUT_DIRS) {
      const dest = path.join(outDir, filename);
      await page.screenshot({ path: dest });
      console.log('  Saved:', dest);
    }
  }

  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'x-autocuan-preview': '1' });

    // ─────────────────────────────────────────────────────────────────────────
    // 1. wave10-landing-desktop-light-1440x900.png
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[1/6] Capturing wave10-landing-desktop-light-1440x900.png...');
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/?module=landing`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch (_) {}
      document.documentElement.classList.add('light');
      document.documentElement.classList.remove('dark');
      if (typeof window.applyAppTheme === 'function') window.applyAppTheme('light');
      if (typeof window.showLandingPage === 'function') window.showLandingPage({ skipHistory: true });
    });
    await new Promise(r => setTimeout(r, 800));
    await saveScreenshot(page, 'wave10-landing-desktop-light-1440x900.png');

    // ─────────────────────────────────────────────────────────────────────────
    // 2. wave10-landing-mobile-light-390x844.png
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[2/6] Capturing wave10-landing-mobile-light-390x844.png...');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(`${BASE_URL}/?module=landing`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch (_) {}
      document.documentElement.classList.add('light');
      document.documentElement.classList.remove('dark');
      if (typeof window.applyAppTheme === 'function') window.applyAppTheme('light');
      if (typeof window.showLandingPage === 'function') window.showLandingPage({ skipHistory: true });
    });
    await new Promise(r => setTimeout(r, 800));
    await saveScreenshot(page, 'wave10-landing-mobile-light-390x844.png');

    // ─────────────────────────────────────────────────────────────────────────
    // 3. wave10-dashboard-desktop-dark-1440x900.png
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[3/6] Capturing wave10-dashboard-desktop-dark-1440x900.png...');
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      try {
        localStorage.setItem('autocuan_user', 'budi');
        localStorage.setItem('autocuan_role', 'admin');
        localStorage.setItem('autocuan_is_admin', 'true');
        localStorage.setItem('auto_cuan_onboarding_seen', 'true');
      } catch (_) {}
      const ob = document.getElementById('onboardingModal');
      if (ob) ob.classList.add('hidden');
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
      if (typeof window.applyAppTheme === 'function') window.applyAppTheme('dark');
      if (typeof window.navigateTo === 'function') window.navigateTo('dashboard');
    });
    await new Promise(r => setTimeout(r, 900));
    await saveScreenshot(page, 'wave10-dashboard-desktop-dark-1440x900.png');

    // ─────────────────────────────────────────────────────────────────────────
    // 4. wave10-screener-mobile-light-390x844.png
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[4/6] Capturing wave10-screener-mobile-light-390x844.png...');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      try {
        localStorage.setItem('autocuan_user', 'budi');
        localStorage.setItem('autocuan_role', 'admin');
        localStorage.setItem('autocuan_is_admin', 'true');
        localStorage.setItem('auto_cuan_onboarding_seen', 'true');
      } catch (_) {}
      const ob = document.getElementById('onboardingModal');
      if (ob) ob.classList.add('hidden');
      document.documentElement.classList.add('light');
      document.documentElement.classList.remove('dark');
      if (typeof window.applyAppTheme === 'function') window.applyAppTheme('light');
      if (typeof window.navigateTo === 'function') window.navigateTo('screener');
    });
    await new Promise(r => setTimeout(r, 900));
    await saveScreenshot(page, 'wave10-screener-mobile-light-390x844.png');

    // ─────────────────────────────────────────────────────────────────────────
    // 5. wave10-financial-desktop-light-1440x900.png
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[5/6] Capturing wave10-financial-desktop-light-1440x900.png...');
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      try {
        localStorage.setItem('autocuan_user', 'budi');
        localStorage.setItem('autocuan_role', 'admin');
        localStorage.setItem('autocuan_is_admin', 'true');
        localStorage.setItem('auto_cuan_onboarding_seen', 'true');
      } catch (_) {}
      const ob = document.getElementById('onboardingModal');
      if (ob) ob.classList.add('hidden');
      document.documentElement.classList.add('light');
      document.documentElement.classList.remove('dark');
      if (typeof window.applyAppTheme === 'function') window.applyAppTheme('light');
      if (typeof window.navigateTo === 'function') window.navigateTo('analisis', 'financial');
      if (typeof window.loadFinancialStructureTab === 'function') {
        window.loadFinancialStructureTab('financial', 'BBCA');
      }
    });
    await new Promise(r => setTimeout(r, 1000));
    await saveScreenshot(page, 'wave10-financial-desktop-light-1440x900.png');

    // ─────────────────────────────────────────────────────────────────────────
    // 6. wave10-account-center-mobile-dark-390x844.png
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[6/6] Capturing wave10-account-center-mobile-dark-390x844.png...');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      try {
        localStorage.setItem('autocuan_user', 'budi');
        localStorage.setItem('autocuan_role', 'admin');
        localStorage.setItem('autocuan_is_admin', 'true');
        localStorage.setItem('auto_cuan_onboarding_seen', 'true');
      } catch (_) {}
      const ob = document.getElementById('onboardingModal');
      if (ob) ob.classList.add('hidden');
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
      if (typeof window.applyAppTheme === 'function') window.applyAppTheme('dark');
      if (typeof window.openAccountProfile === 'function') {
        window.openAccountProfile();
      } else if (typeof window.openAccountSubscription === 'function') {
        window.openAccountSubscription();
      }
    });
    await new Promise(r => setTimeout(r, 1000));
    await saveScreenshot(page, 'wave10-account-center-mobile-dark-390x844.png');

    console.log('\n[Wave10-Evidence] All 6 screenshots successfully captured.');
  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error('[Wave10-Evidence] Fatal error:', err);
  process.exit(1);
});
