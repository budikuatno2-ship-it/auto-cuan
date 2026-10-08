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
  console.log(`[Wave6-Capture] Starting local-dev-server on port ${PORT}...`);
  const serverProcess = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SUPABASE_URL: '' },
    stdio: 'ignore'
  });

  let browser;
  try {
    await waitForServer(`${BASE_URL}/health`);
    console.log(`[Wave6-Capture] local-dev-server ready at ${BASE_URL}`);

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

    async function setLight() {
      await page.evaluate(() => {
        document.documentElement.classList.remove('dark');
        document.documentElement.classList.add('light');
        document.documentElement.setAttribute('data-theme', 'light');
        document.body.classList.remove('dark');
        document.body.removeAttribute('data-theme');
        localStorage.setItem('theme', 'light');
        localStorage.setItem('autocuan_theme', 'light');
        localStorage.setItem('auto_cuan_theme', 'light');
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

    // 1. Dashboard Desktop (1440x900)
    console.log('[Wave6-Capture] 1. Capturing wave6-dashboard-1440x900.png...');
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/dashboard?page=dashboard&preview=1`, { waitUntil: 'networkidle2' });
    await dismissOverlays();
    await setLight();
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
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave6-dashboard-1440x900.png') });

    // 2. Analisis & Chart Desktop (1440x900)
    console.log('[Wave6-Capture] 2. Capturing wave6-analisis-chart-1440x900.png...');
    await page.goto(`${BASE_URL}/dashboard?page=analisis&tab=analisis-chart&ticker=BBCA&preview=1`, { waitUntil: 'networkidle2' });
    await dismissOverlays();
    await setLight();
    await page.evaluate(async () => {
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('analisis', 'analisis-chart');
      }
      if (typeof window.switchAnalisisSubTab === 'function') {
        window.switchAnalisisSubTab('ai');
      }
      await new Promise(r => setTimeout(r, 600));
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave6-analisis-chart-1440x900.png') });

    // 3. Bandarmologi Desktop (1440x900) - Table-First View
    console.log('[Wave6-Capture] 3. Capturing wave6-bandarmologi-1440x900.png...');
    await page.goto(`${BASE_URL}/dashboard?page=analisis&tab=bandarmologi&ticker=BBCA&preview=1`, { waitUntil: 'networkidle2' });
    await dismissOverlays();
    await setLight();
    await page.evaluate(async () => {
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('analisis', 'bandarmologi');
      }
      if (typeof window.loadBandarmologiTab === 'function') {
        await window.loadBandarmologiTab('BBCA');
      }
      await new Promise(r => setTimeout(r, 800));
      if (window.BandarmologiRuntime && typeof window.BandarmologiRuntime.setBrokerSummaryView === 'function') {
        window.BandarmologiRuntime.setBrokerSummaryView('table');
      }
      await new Promise(r => setTimeout(r, 600));
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave6-bandarmologi-1440x900.png') });

    // 4. Sinyal Intelijen Desktop (1440x900)
    console.log('[Wave6-Capture] 4. Capturing wave6-sinyal-intelijen-1440x900.png...');
    await page.goto(`${BASE_URL}/dashboard?page=analisis&tab=intel&ticker=BBCA&preview=1`, { waitUntil: 'networkidle2' });
    await dismissOverlays();
    await setLight();
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
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave6-sinyal-intelijen-1440x900.png') });

    // 5. Broker Hunter Desktop (1440x900)
    console.log('[Wave6-Capture] 5. Capturing wave6-broker-hunter-1440x900.png...');
    await page.goto(`${BASE_URL}/dashboard?page=analisis&tab=hunter&ticker=BBCA&preview=1`, { waitUntil: 'networkidle2' });
    await dismissOverlays();
    await setLight();
    await page.evaluate(async () => {
      const hunterContainer = document.getElementById('brokerHunterContent') || document.getElementById('bandarmologiContent');
      if (window.BandarmologiRuntime && typeof window.BandarmologiRuntime.loadBrokerHunter === 'function') {
        await window.BandarmologiRuntime.loadBrokerHunter(hunterContainer);
      }
      await new Promise(r => setTimeout(r, 800));
    });
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave6-broker-hunter-1440x900.png') });

    // 6. Insider Network Desktop (1440x900)
    console.log('[Wave6-Capture] 6. Capturing wave6-insider-1440x900.png...');
    await page.goto(`${BASE_URL}/dashboard?page=analisis&tab=insider&ticker=BBCA&preview=1`, { waitUntil: 'networkidle2' });
    await dismissOverlays();
    await setLight();
    await page.evaluate(async () => {
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('analisis', 'insider');
      }
      const insiderContainer = document.getElementById('insiderNetworkDedicatedContent');
      if (window.BandarmologiRuntime && typeof window.BandarmologiRuntime.loadInsiderNetwork === 'function') {
        await window.BandarmologiRuntime.loadInsiderNetwork(insiderContainer);
      }
      await new Promise(r => setTimeout(r, 800));
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Prajogo Pangestu'));
      if (btn) {
        btn.click();
      } else if (window.BandarmologiRuntime && typeof window.BandarmologiRuntime.selectInsiderQuickChip === 'function') {
        window.BandarmologiRuntime.selectInsiderQuickChip('Prajogo Pangestu');
      }
      await new Promise(r => setTimeout(r, 800));
      const graphWrap = document.getElementById('insiderGraphSvgWrap');
      if (graphWrap) graphWrap.scrollIntoView({ block: 'center' });
    });
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave6-insider-1440x900.png') });

    // 7. Ranking Desktop (1440x900)
    console.log('[Wave6-Capture] 7. Capturing wave6-ranking-1440x900.png...');
    await page.goto(`${BASE_URL}/dashboard?page=analisis&tab=ranking&preview=1`, { waitUntil: 'networkidle2' });
    await dismissOverlays();
    await setLight();
    await page.evaluate(async () => {
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('analisis', 'ranking');
      }
      if (typeof window.ensureRankingTableLoaded === 'function') {
        await window.ensureRankingTableLoaded();
      }
      await new Promise(r => setTimeout(r, 800));
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave6-ranking-1440x900.png') });

    console.log('[Wave6-Capture] All 7 screenshots captured successfully in:', SCREENSHOT_DIR);
  } catch (err) {
    console.error('[Wave6-Capture] Error capturing screenshots:', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    serverProcess.kill();
  }
}

run();
