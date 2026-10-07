'use strict';
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots', 'wave4-financial-market-structure');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3045;
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
  console.log('[Wave4-Capture] Starting local-dev-server on port ' + PORT + '...');
  const serverProcess = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });

  let browser;
  try {
    await waitForServer(BASE_URL);
    console.log('[Wave4-Capture] local-dev-server ready at ' + BASE_URL);

    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'x-autocuan-preview': '1' });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('autocuan_user', 'budi');
      localStorage.setItem('autocuan_role', 'ADMIN');
      localStorage.setItem('autocuan_auth', '1');
      localStorage.setItem('autocuan_logged_in', 'true');
      localStorage.setItem('auto_cuan_onboarding_seen', 'true');
      localStorage.setItem('autocuan_onboarding_completed', 'true');
      document.cookie = 'autocuan_session=test-budi-admin; path=/';
    });

    async function setLight() {
      await page.evaluate(() => {
        document.documentElement.classList.remove('dark');
        document.documentElement.classList.add('light');
        document.body.classList.remove('dark');
        document.body.removeAttribute('data-theme');
        localStorage.setItem('auto_cuan_theme', 'light');
      });
    }

    async function setDark() {
      await page.evaluate(() => {
        if (typeof window.applyAppTheme === 'function') {
          window.applyAppTheme('dark');
        } else {
          document.documentElement.classList.remove('light');
          document.documentElement.classList.add('dark');
          document.documentElement.setAttribute('data-theme', 'dark');
          document.body.classList.add('dark');
        }
        localStorage.setItem('auto_cuan_theme', 'dark');
      });
    }

    async function dismissOverlays() {
      await page.evaluate(() => {
        const modal = document.getElementById('onboardingModal');
        if (modal) {
          modal.classList.add('hidden');
          modal.style.display = 'none';
        }
        const welcome = document.getElementById('welcomeOnboardingModal');
        if (welcome) {
          welcome.classList.add('hidden');
          welcome.style.display = 'none';
        }
      });
    }

    async function setupAnalysisPage(tabName, ticker) {
      await page.goto(`${BASE_URL}/dashboard?page=analisis&tab=${tabName}&ticker=${ticker || 'BBCA'}`, { waitUntil: 'networkidle2' });
      await dismissOverlays();
      await setLight();
      await page.evaluate(async (tab, t) => {
        if (typeof window.navigateTo === 'function') {
          window.navigateTo('analisis', tab);
        }
        await new Promise(r => setTimeout(r, 400));
        if (tab === 'financial') {
          if (t && typeof window.loadFinancialStructureTab === 'function') {
            await window.loadFinancialStructureTab('financial', t);
          }
        } else if (tab === 'market-structure') {
          if (window.AutoCuanMarketStructure) {
            await window.AutoCuanMarketStructure.loadUniverse(true);
            if (t) window.AutoCuanMarketStructure.selectRow(t, false);
          }
        }
      }, tabName, ticker);
      await dismissOverlays();
      await new Promise(r => setTimeout(r, 600));
    }

    // 1. Financial Desktop Light (1440x900) - Normal Snapshot
    console.log('[Wave4-Capture] 1. Financial Desktop Light (1440x900)...');
    await page.setViewport({ width: 1440, height: 900 });
    await setupAnalysisPage('financial', 'BBCA');
    const dest1 = path.join(SCREENSHOT_DIR, '01-financial-desktop-light-1440x900.png');
    await page.screenshot({ path: dest1 });
    console.log('[Wave4-Capture] Saved: ' + dest1);

    // 2. Financial Mobile Light (390x844) - Mobile Layout
    console.log('[Wave4-Capture] 2. Financial Mobile Light (390x844)...');
    await page.setViewport({ width: 390, height: 844 });
    await new Promise(r => setTimeout(r, 400));
    const dest2 = path.join(SCREENSHOT_DIR, '02-financial-mobile-light-390x844.png');
    await page.screenshot({ path: dest2 });
    console.log('[Wave4-Capture] Saved: ' + dest2);

    // 3. Financial All-Unavailable State Desktop Light (1440x900)
    console.log('[Wave4-Capture] 3. Financial All-Unavailable Desktop Light (1440x900)...');
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluate(async () => {
      const inp = document.getElementById('financialTickerInput');
      if (inp) inp.value = 'XYZW';
      if (typeof window.loadFinancialStructureTab === 'function') {
        await window.loadFinancialStructureTab('financial', 'XYZW');
      }
    });
    await new Promise(r => setTimeout(r, 600));
    const dest3 = path.join(SCREENSHOT_DIR, '03-financial-unavailable-desktop-light-1440x900.png');
    await page.screenshot({ path: dest3 });
    console.log('[Wave4-Capture] Saved: ' + dest3);

    // 4. Struktur Pasar Desktop Light (1440x900) - Default List-First Universe
    console.log('[Wave4-Capture] 4. Struktur Pasar Desktop Light (1440x900)...');
    await setupAnalysisPage('market-structure');
    const dest4 = path.join(SCREENSHOT_DIR, '04-market-structure-desktop-light-1440x900.png');
    await page.screenshot({ path: dest4 });
    console.log('[Wave4-Capture] Saved: ' + dest4);

    // 5. Struktur Pasar Desktop Light (1440x900) - Filter Active: FF Rendah <15%
    console.log('[Wave4-Capture] 5. Struktur Pasar Filter Active Desktop Light (1440x900)...');
    await page.evaluate(() => {
      if (window.AutoCuanMarketStructure) {
        window.AutoCuanMarketStructure.setFilter('low_ff');
      }
    });
    await new Promise(r => setTimeout(r, 500));
    const dest5 = path.join(SCREENSHOT_DIR, '05-market-structure-filter-active-desktop-light-1440x900.png');
    await page.screenshot({ path: dest5 });
    console.log('[Wave4-Capture] Saved: ' + dest5);

    // 6. Struktur Pasar Desktop Light (1440x900) - Row Selected + Desktop Detail Pane
    console.log('[Wave4-Capture] 6. Struktur Pasar Selected Row + Detail Pane Desktop Light (1440x900)...');
    await page.evaluate(() => {
      if (window.AutoCuanMarketStructure) {
        window.AutoCuanMarketStructure.setFilter('all');
        window.AutoCuanMarketStructure.selectRow('BREN', false);
      }
    });
    await new Promise(r => setTimeout(r, 500));
    const dest6 = path.join(SCREENSHOT_DIR, '06-market-structure-selected-pane-desktop-light-1440x900.png');
    await page.screenshot({ path: dest6 });
    console.log('[Wave4-Capture] Saved: ' + dest6);

    // 7. Struktur Pasar Tablet Light (768x1024) - Tablet Uncrushed List
    console.log('[Wave4-Capture] 7. Struktur Pasar Tablet Light (768x1024)...');
    await page.setViewport({ width: 768, height: 1024 });
    await new Promise(r => setTimeout(r, 500));
    const dest7 = path.join(SCREENSHOT_DIR, '07-market-structure-tablet-light-768x1024.png');
    await page.screenshot({ path: dest7 });
    console.log('[Wave4-Capture] Saved: ' + dest7);

    // 8. Struktur Pasar Mobile Light (390x844) - Mobile Default List
    console.log('[Wave4-Capture] 8. Struktur Pasar Mobile Default Light (390x844)...');
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => {
      if (window.AutoCuanMarketStructure) {
        window.AutoCuanMarketStructure.closeDetail();
      }
    });
    await new Promise(r => setTimeout(r, 500));
    const dest8 = path.join(SCREENSHOT_DIR, '08-market-structure-mobile-default-light-390x844.png');
    await page.screenshot({ path: dest8 });
    console.log('[Wave4-Capture] Saved: ' + dest8);

    // 9. Struktur Pasar Mobile Light (390x844) - Mobile Detail Sheet Open
    console.log('[Wave4-Capture] 9. Struktur Pasar Mobile Detail Sheet Open Light (390x844)...');
    await page.evaluate(() => {
      if (window.AutoCuanMarketStructure) {
        window.AutoCuanMarketStructure.selectRow('BREN', true);
      }
    });
    await new Promise(r => setTimeout(r, 600));
    const dest9 = path.join(SCREENSHOT_DIR, '09-market-structure-mobile-sheet-open-light-390x844.png');
    await page.screenshot({ path: dest9 });
    console.log('[Wave4-Capture] Saved: ' + dest9);

    // 10. Desktop Dark (1440x900) - Night Research Mode Verification
    console.log('[Wave4-Capture] 10. Desktop Dark Night Research Mode (1440x900)...');
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluate(() => {
      if (window.AutoCuanMarketStructure) {
        window.AutoCuanMarketStructure.closeDetail();
      }
    });
    await setDark();
    await page.evaluate(() => {
      if (window.AutoCuanMarketStructure) {
        window.AutoCuanMarketStructure.selectRow('BBCA', false);
      }
    });
    await new Promise(r => setTimeout(r, 600));
    const dest10 = path.join(SCREENSHOT_DIR, '10-desktop-dark-night-research-1440x900.png');
    await page.screenshot({ path: dest10 });
    console.log('[Wave4-Capture] Saved: ' + dest10);

    console.log('[Wave4-Capture] All 10 screenshots successfully captured!');
  } finally {
    if (browser) await browser.close();
    serverProcess.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error('[Wave4-Capture] FATAL:', err);
  process.exit(1);
});
