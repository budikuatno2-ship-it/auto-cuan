'use strict';
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots', 'wave6-dashboard-research');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3048;
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
  console.log(`[Wave6-Dark-Capture] Starting local-dev-server on port ${PORT}...`);
  const serverProcess = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SUPABASE_URL: '' },
    stdio: 'ignore'
  });

  let browser;
  try {
    await waitForServer(`${BASE_URL}/health`);
    console.log(`[Wave6-Dark-Capture] local-dev-server ready at ${BASE_URL}`);

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
      localStorage.setItem('autocuan_theme', 'dark');
      localStorage.setItem('theme', 'dark');
      localStorage.setItem('auto_cuan_theme', 'dark');
      document.cookie = 'autocuan_session=test-budi-admin; path=/';
    });

    async function setDark() {
      await page.evaluate(() => {
        if (typeof window.applyAppTheme === 'function') {
          window.applyAppTheme('dark');
        } else {
          document.documentElement.classList.remove('light');
          document.documentElement.classList.add('dark');
          document.documentElement.setAttribute('data-theme', 'dark');
          if (document.body) document.body.classList.remove('light');
          document.documentElement.style.background = '#0b0e14';
        }
        localStorage.setItem('theme', 'dark');
        localStorage.setItem('autocuan_theme', 'dark');
        localStorage.setItem('auto_cuan_theme', 'dark');
      });
    }

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
        const onboarding = document.getElementById('onboardingModal');
        if (onboarding) {
          onboarding.classList.add('hidden');
          onboarding.style.display = 'none';
        }
        const welcome = document.getElementById('welcomeOnboardingModal');
        if (welcome) {
          welcome.classList.add('hidden');
          welcome.style.display = 'none';
        }
        window.premiumAccessState = {
          state: 'ready',
          premium: true,
          isAdmin: true,
          accessLevel: 'admin',
          role: 'admin'
        };
      });
    }

    // 1. Dark Dashboard Desktop (1440x900)
    console.log('[Wave6-Dark-Capture] 1. Capturing wave6-dark-dashboard-1440x900.png...');
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/dashboard?page=dashboard&preview=1`, { waitUntil: 'networkidle2' });
    await dismissOverlays();
    await setDark();
    await page.evaluate(async () => {
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('dashboard');
      }
      if (typeof window.loadDashboardData === 'function') {
        await window.loadDashboardData();
      }
      await new Promise(r => setTimeout(r, 600));
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave6-dark-dashboard-1440x900.png') });

    // 2. Dark Sinyal Intelijen Desktop (1440x900)
    console.log('[Wave6-Dark-Capture] 2. Capturing wave6-dark-sinyal-intelijen-1440x900.png...');
    await page.goto(`${BASE_URL}/dashboard?page=analisis&tab=intel&ticker=BBCA&preview=1`, { waitUntil: 'networkidle2' });
    await dismissOverlays();
    await setDark();
    await page.evaluate(async () => {
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('analisis', 'intel');
      }
      const intelContainer = document.getElementById('bandarmologiIntelContent') || document.getElementById('bandarmologiContent');
      if (window.BandarmologiRuntime && typeof window.BandarmologiRuntime.loadBandarmologiIntel === 'function') {
        await window.BandarmologiRuntime.loadBandarmologiIntel('BBCA', intelContainer);
      }
      await new Promise(r => setTimeout(r, 800));
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave6-dark-sinyal-intelijen-1440x900.png') });

    console.log('[Wave6-Dark-Capture] Both dark screenshots captured successfully in:', SCREENSHOT_DIR);
  } catch (err) {
    console.error('[Wave6-Dark-Capture] Error capturing screenshots:', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    serverProcess.kill();
  }
}

run();
