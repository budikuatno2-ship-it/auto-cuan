'use strict';
const puppeteer = require('D:/auto-cuan-2/node_modules/puppeteer-core');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots', 'wave4c-visual-closure');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3047;
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
  console.log(`[Wave4C-Capture] Starting local-dev-server on port ${PORT}...`);
  const serverProcess = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });

  let browser;
  try {
    await waitForServer(`${BASE_URL}/health`);
    console.log(`[Wave4C-Capture] local-dev-server ready at ${BASE_URL}`);

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

    // 1. financial-mobile-start-390x844.png (table at scrollLeft = 0)
    console.log('[Wave4C-Capture] 1. financial-mobile-start-390x844.png...');
    await page.setViewport({ width: 390, height: 844 });
    await setupAnalysisPage('financial', 'BBCA');
    await page.evaluate(() => {
      if (window.AutoCuanFinancialStatements) {
        window.AutoCuanFinancialStatements.setStatementMode('income');
        window.AutoCuanFinancialStatements.setPeriodMode('quarterly');
      }
      const section = document.getElementById('financialStatementsSection');
      if (section) section.scrollIntoView();
      const wrap = document.getElementById('financialStatementsTableWrap');
      if (wrap) wrap.scrollLeft = 0;
    });
    await new Promise(r => setTimeout(r, 400));
    const dest1 = path.join(SCREENSHOT_DIR, 'financial-mobile-start-390x844.png');
    await page.screenshot({ path: dest1 });
    console.log('[Wave4C-Capture] Saved: ' + dest1);

    // 2. financial-mobile-scrolled-390x844.png (after meaningful horizontal scroll, Komponen & group labels fully readable)
    console.log('[Wave4C-Capture] 2. financial-mobile-scrolled-390x844.png...');
    await page.evaluate(() => {
      const wrap = document.getElementById('financialStatementsTableWrap');
      if (wrap) wrap.scrollLeft = 120;
    });
    await new Promise(r => setTimeout(r, 400));
    const dest2 = path.join(SCREENSHOT_DIR, 'financial-mobile-scrolled-390x844.png');
    await page.screenshot({ path: dest2 });
    console.log('[Wave4C-Capture] Saved: ' + dest2);

    // 3. financial-desktop-active-tabs-1440x900.png (showing active statement & frequency, Indonesian-first copy)
    console.log('[Wave4C-Capture] 3. financial-desktop-active-tabs-1440x900.png...');
    await page.setViewport({ width: 1440, height: 900 });
    await setupAnalysisPage('financial', 'BBCA');
    await page.evaluate(() => {
      if (window.AutoCuanFinancialStatements) {
        window.AutoCuanFinancialStatements.setStatementMode('income');
        window.AutoCuanFinancialStatements.setPeriodMode('quarterly');
      }
    });
    await new Promise(r => setTimeout(r, 400));
    const dest3 = path.join(SCREENSHOT_DIR, 'financial-desktop-active-tabs-1440x900.png');
    await page.screenshot({ path: dest3 });
    console.log('[Wave4C-Capture] Saved: ' + dest3);

    // 4. market-structure-copy-1440x900.png (proving precise HSC wording: Tidak Terindikasi HSC)
    console.log('[Wave4C-Capture] 4. market-structure-copy-1440x900.png...');
    await setupAnalysisPage('market-structure', 'BBCA');
    await page.evaluate(() => {
      if (window.AutoCuanMarketStructure) {
        window.AutoCuanMarketStructure.selectRow('BBCA', false);
      }
    });
    await new Promise(r => setTimeout(r, 400));
    const dest4 = path.join(SCREENSHOT_DIR, 'market-structure-copy-1440x900.png');
    await page.screenshot({ path: dest4 });
    console.log('[Wave4C-Capture] Saved: ' + dest4);

    // 5. Optional: financial-mobile-matrix-320x568.png (compact 320px viewport verification)
    console.log('[Wave4C-Capture] 5. financial-mobile-matrix-320x568.png (optional)...');
    await page.setViewport({ width: 320, height: 568 });
    await setupAnalysisPage('financial', 'BBCA');
    await page.evaluate(() => {
      if (window.AutoCuanFinancialStatements) {
        window.AutoCuanFinancialStatements.setStatementMode('income');
        window.AutoCuanFinancialStatements.setPeriodMode('quarterly');
      }
      const section = document.getElementById('financialStatementsSection');
      if (section) section.scrollIntoView();
      const wrap = document.getElementById('financialStatementsTableWrap');
      if (wrap) wrap.scrollLeft = 80;
    });
    await new Promise(r => setTimeout(r, 400));
    const dest5 = path.join(SCREENSHOT_DIR, 'financial-mobile-matrix-320x568.png');
    await page.screenshot({ path: dest5 });
    console.log('[Wave4C-Capture] Saved: ' + dest5);

    console.log('[Wave4C-Capture] All screenshots captured successfully!');
  } finally {
    if (browser) await browser.close();
    serverProcess.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error('[Wave4C-Capture] Error:', err);
  process.exit(1);
});
