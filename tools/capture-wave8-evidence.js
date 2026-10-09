'use strict';
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots', 'wave8-evidence');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3059;
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
  console.log(`[Wave8-Evidence] Starting local-dev-server on port ${PORT}...`);
  const serverProcess = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SUPABASE_URL: '' },
    stdio: 'ignore'
  });

  let browser;
  try {
    await waitForServer(`${BASE_URL}/health`);
    console.log('[Wave8-Evidence] Server is ready.');

    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'x-autocuan-preview': '1' });

    // 1. wave8-login-desktop-light-1440x900.png
    console.log('Capturing 1. wave8-login-desktop-light-1440x900.png...');
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(`${BASE_URL}/?preview=1`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      if (typeof window.applyAppTheme === 'function') window.applyAppTheme('light');
      if (typeof window.openLoginModal === 'function') window.openLoginModal();
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave8-login-desktop-light-1440x900.png') });

    // Seed session for account center
    await page.evaluate(() => {
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

    // 2. wave8-account-center-desktop-light-1440x900.png
    console.log('Capturing 2. wave8-account-center-desktop-light-1440x900.png...');
    await page.goto(`${BASE_URL}/dashboard?preview=1`, { waitUntil: 'networkidle2' });
    await page.evaluate(async () => {
      if (typeof window.applyAppTheme === 'function') window.applyAppTheme('light');
      if (typeof window.openAccountProfile === 'function') {
        await window.openAccountProfile();
      }
    });
    await new Promise(r => setTimeout(r, 1200));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave8-account-center-desktop-light-1440x900.png') });

    // 3. wave8-account-center-mobile-390x844.png
    console.log('Capturing 3. wave8-account-center-mobile-390x844.png...');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave8-account-center-mobile-390x844.png') });

    // 4. wave8-access-or-session-state-light-1440x900.png
    console.log('Capturing 4. wave8-access-or-session-state-light-1440x900.png...');
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.evaluate(() => {
      if (typeof window.applyAppTheme === 'function') window.applyAppTheme('light');
      const ac = document.getElementById('acAccountCenter');
      if (ac) ac.hidden = true;
      if (typeof window.openAuthChoiceModal === 'function') {
        window.openAuthChoiceModal('Sesi Anda berakhir. Masuk kembali untuk melanjutkan.');
      }
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave8-access-or-session-state-light-1440x900.png') });

    // 5. wave8-system-error-mobile-390x844.png
    console.log('Capturing 5. wave8-system-error-mobile-390x844.png...');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await page.evaluate(() => {
      const choice = document.getElementById('authChoiceModal');
      if (choice) choice.classList.add('hidden');
      const svc = document.getElementById('serviceStatusScreen');
      if (svc) svc.classList.remove('hidden');
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave8-system-error-mobile-390x844.png') });

    // 6. wave8-account-system-dark-1440x900.png
    console.log('Capturing 6. wave8-account-system-dark-1440x900.png...');
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.evaluate(async () => {
      const svc = document.getElementById('serviceStatusScreen');
      if (svc) svc.classList.add('hidden');
      if (typeof window.applyAppTheme === 'function') window.applyAppTheme('dark');
      if (typeof window.openAccountProfile === 'function') {
        await window.openAccountProfile();
      }
    });
    await new Promise(r => setTimeout(r, 1200));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave8-account-system-dark-1440x900.png') });

    console.log('Successfully captured all 6 initial baseline screenshots!');
  } finally {
    if (browser) await browser.close();
    serverProcess.kill();
  }
}

run().catch((err) => {
  console.error('[Wave8-Evidence] Error:', err);
  process.exit(1);
});
