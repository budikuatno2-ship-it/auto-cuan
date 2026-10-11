'use strict';
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots', 'wave4b-financial-deep-dive');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3046;
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
  console.log('[Wave4B-Capture] Starting local-dev-server on port ' + PORT + '...');
  const serverProcess = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });

  let browser;
  try {
    await waitForServer(BASE_URL);
    console.log('[Wave4B-Capture] local-dev-server ready at ' + BASE_URL);

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

    // 1. Desktop 1440x900: Snapshot + Laba Rugi table
    console.log('[Wave4B-Capture] 1. Desktop 1440x900: Snapshot + Laba Rugi table...');
    await page.setViewport({ width: 1440, height: 900 });
    await setupAnalysisPage('financial', 'BBCA');
    await page.evaluate(() => {
      if (window.AutoCuanFinancialStatements) {
        window.AutoCuanFinancialStatements.setStatementMode('income');
        window.AutoCuanFinancialStatements.setPeriodMode('quarterly');
      }
    });
    await new Promise(r => setTimeout(r, 400));
    const dest1 = path.join(SCREENSHOT_DIR, '01-financial-desktop-laba-rugi-1440x900.png');
    await page.screenshot({ path: dest1 });
    console.log('[Wave4B-Capture] Saved: ' + dest1);

    // 2. Desktop 1440x900: Neraca table
    console.log('[Wave4B-Capture] 2. Desktop 1440x900: Neraca table...');
    await page.evaluate(() => {
      if (window.AutoCuanFinancialStatements) {
        window.AutoCuanFinancialStatements.setStatementMode('balance');
      }
    });
    await new Promise(r => setTimeout(r, 400));
    const dest2 = path.join(SCREENSHOT_DIR, '02-financial-desktop-neraca-1440x900.png');
    await page.screenshot({ path: dest2 });
    console.log('[Wave4B-Capture] Saved: ' + dest2);

    // 3. Desktop 1440x900: Arus Kas table
    console.log('[Wave4B-Capture] 3. Desktop 1440x900: Arus Kas table...');
    await page.evaluate(() => {
      if (window.AutoCuanFinancialStatements) {
        window.AutoCuanFinancialStatements.setStatementMode('cashflow');
      }
    });
    await new Promise(r => setTimeout(r, 400));
    const dest3 = path.join(SCREENSHOT_DIR, '03-financial-desktop-arus-kas-1440x900.png');
    await page.screenshot({ path: dest3 });
    console.log('[Wave4B-Capture] Saved: ' + dest3);

    // 4. Desktop 1440x900: Rasio table
    console.log('[Wave4B-Capture] 4. Desktop 1440x900: Rasio table...');
    await page.evaluate(() => {
      if (window.AutoCuanFinancialStatements) {
        window.AutoCuanFinancialStatements.setStatementMode('ratios');
      }
    });
    await new Promise(r => setTimeout(r, 400));
    const dest4 = path.join(SCREENSHOT_DIR, '04-financial-desktop-rasio-1440x900.png');
    await page.screenshot({ path: dest4 });
    console.log('[Wave4B-Capture] Saved: ' + dest4);

    // 5. Desktop 1440x900: Tahunan mode
    console.log('[Wave4B-Capture] 5. Desktop 1440x900: Tahunan mode...');
    await page.evaluate(() => {
      if (window.AutoCuanFinancialStatements) {
        window.AutoCuanFinancialStatements.setStatementMode('income');
        window.AutoCuanFinancialStatements.setPeriodMode('annual');
      }
    });
    await new Promise(r => setTimeout(r, 400));
    const dest5 = path.join(SCREENSHOT_DIR, '05-financial-desktop-tahunan-1440x900.png');
    await page.screenshot({ path: dest5 });
    console.log('[Wave4B-Capture] Saved: ' + dest5);

    // 6. Mobile 390x844: Statement matrix with horizontal period scroll
    console.log('[Wave4B-Capture] 6. Mobile 390x844: Statement matrix with horizontal scroll...');
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => {
      if (window.AutoCuanFinancialStatements) {
        window.AutoCuanFinancialStatements.setStatementMode('income');
        window.AutoCuanFinancialStatements.setPeriodMode('quarterly');
      }
      const section = document.getElementById('financialStatementsSection');
      if (section) {
        section.scrollIntoView();
      }
      const wrap = document.getElementById('financialStatementsTableWrap');
      if (wrap) {
        wrap.scrollLeft = 80;
      }
    });
    await new Promise(r => setTimeout(r, 500));
    const dest6 = path.join(SCREENSHOT_DIR, '06-financial-mobile-matrix-scroll-390x844.png');
    await page.screenshot({ path: dest6 });
    console.log('[Wave4B-Capture] Saved: ' + dest6);

    // 7. Desktop 1440x900: Detailed statement unavailable state while snapshot remains visible
    console.log('[Wave4B-Capture] 7. Desktop 1440x900: Statement unavailable while snapshot visible...');
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluate(async () => {
      const inp = document.getElementById('financialTickerInput');
      if (inp) inp.value = 'BMRI';
      if (typeof window.loadFinancialStructureTab === 'function') {
        await window.loadFinancialStructureTab('financial', 'BMRI');
      }
    });
    await new Promise(r => setTimeout(r, 600));
    const dest7 = path.join(SCREENSHOT_DIR, '07-financial-desktop-statement-unavailable-1440x900.png');
    await page.screenshot({ path: dest7 });
    console.log('[Wave4B-Capture] Saved: ' + dest7);

    // 8. Desktop 1440x900: Struktur Pasar proving human-readable statuses/enums
    console.log('[Wave4B-Capture] 8. Desktop 1440x900: Struktur Pasar human-readable statuses/enums...');
    await setupAnalysisPage('market-structure', 'BREN');
    await page.evaluate(() => {
      if (window.AutoCuanMarketStructure) {
        window.AutoCuanMarketStructure.selectRow('BREN', false);
      }
    });
    await new Promise(r => setTimeout(r, 600));
    const dest8 = path.join(SCREENSHOT_DIR, '08-market-structure-desktop-human-enums-1440x900.png');
    await page.screenshot({ path: dest8 });
    console.log('[Wave4B-Capture] Saved: ' + dest8);

    console.log('[Wave4B-Capture] All 8 required screenshots captured cleanly!');
  } finally {
    if (browser) await browser.close();
    serverProcess.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error('[Wave4B-Capture] FATAL:', err);
  process.exit(1);
});
