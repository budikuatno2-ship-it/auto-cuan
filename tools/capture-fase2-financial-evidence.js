'use strict';
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const EVIDENCE_DIR = path.join(ROOT, 'docs', 'evidence', 'fase-2');
const BACKUP_DIR = 'D:\\Auto-Cuan\\evidence\\fase-2';
const ARTIFACT_DIR = 'C:\\Users\\ADVAN\\.gemini\\antigravity\\brain\\fc1f9fc3-9cac-46e4-bc9f-2aab2cf38b98';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3088;
const BASE_URL = `http://127.0.0.1:${PORT}`;

for (const dir of [EVIDENCE_DIR, BACKUP_DIR]) {
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  }
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
  console.log('[Fase-2-Capture] Starting local-dev-server on port ' + PORT + '...');
  const serverProcess = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });

  let browser;
  try {
    await waitForServer(BASE_URL);
    console.log('[Fase-2-Capture] Server ready at ' + BASE_URL);

    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1920,1080']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.setExtraHTTPHeaders({ 'x-autocuan-preview': '1' });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('autocuan_user', 'budi');
      localStorage.setItem('autocuan_role', 'ADMIN');
      localStorage.setItem('autocuan_auth', '1');
      localStorage.setItem('autocuan_logged_in', 'true');
      localStorage.setItem('auto_cuan_onboarding_seen', 'true');
      localStorage.setItem('autocuan_onboarding_completed', 'true');
      localStorage.setItem('auto_cuan_theme', 'dark');
      document.cookie = 'autocuan_session=test-budi-admin; path=/';
    });

    console.log('[Fase-2-Capture] Navigating to page...');
    await page.goto(`${BASE_URL}/dashboard?page=analisis&tab=financial&ticker=BBCA`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#appContent', { timeout: 10000 });

    await page.evaluate(() => {
      const modal = document.getElementById('onboardingModal');
      if (modal) { modal.classList.add('hidden'); modal.style.display = 'none'; }
      const welcome = document.getElementById('welcomeOnboardingModal');
      if (welcome) { welcome.classList.add('hidden'); welcome.style.display = 'none'; }
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('analisis', 'financial');
      } else if (typeof window.switchPage === 'function') {
        window.switchPage('analisis', { subTab: 'financial', ticker: 'BBCA' });
      }
    });

    await new Promise(r => setTimeout(r, 800));

    // Explicitly trigger loadFinancialStructureTab if needed
    await page.evaluate(async () => {
      if (typeof window.loadFinancialStructureTab === 'function') {
        await window.loadFinancialStructureTab('financial', 'BBCA');
      }
    });

    // Wait for financial data content to become visible
    await page.waitForFunction(() => {
      const content = document.getElementById('financialDataContent');
      const badge = document.getElementById('financialStatusBadge');
      return content && !content.hidden && badge && badge.textContent !== 'Memuat...';
    }, { timeout: 15000 });

    await new Promise(r => setTimeout(r, 1000));

    // Verify DOM state
    const metricsState = await page.evaluate(() => {
      return {
        companyName: document.getElementById('financialCompanyName')?.textContent,
        statusBadge: document.getElementById('financialStatusBadge')?.textContent,
        coverage: document.getElementById('financialCoverage')?.textContent,
        pbv: document.getElementById('financialPbv')?.textContent,
        bvps: document.getElementById('financialBvps')?.textContent,
        marketCap: document.getElementById('financialMarketCap')?.textContent,
        marketCapAsOf: document.getElementById('financialMarketCapAsOf')?.textContent,
        shares: document.getElementById('financialShares')?.textContent,
        period: document.getElementById('financialPeriod')?.textContent,
        source: document.getElementById('financialSource')?.textContent,
        marketCapSource: document.getElementById('financialMarketCapSource')?.textContent,
        updatedAt: document.getElementById('financialUpdatedAt')?.textContent,
        tableRowsCount: document.querySelectorAll('#financialStatementsTableBody tr')?.length
      };
    });

    console.log('[Fase-2-Capture] Financial metrics state:', JSON.stringify(metricsState, null, 2));

    async function saveScreenshot(filename) {
      const p1 = path.join(EVIDENCE_DIR, filename);
      const p2 = path.join(BACKUP_DIR, filename);
      const p3 = path.join(ARTIFACT_DIR, filename);

      await page.screenshot({ path: p1, fullPage: false });
      try { fs.copyFileSync(p1, p2); } catch (_) {}
      try { fs.copyFileSync(p1, p3); } catch (_) {}
      console.log('[Fase-2-Capture] Saved:', filename);
    }

    // 1. Capture Desktop Overview (Laba Rugi Kuartalan)
    await saveScreenshot('08-fase-2-financial-desktop-income-quarterly.png');

    // 2. Switch to Neraca Kuartalan
    await page.evaluate(() => {
      if (window.AutoCuanFinancialStatements) {
        window.AutoCuanFinancialStatements.setStatementMode('balance');
      }
    });
    await new Promise(r => setTimeout(r, 500));
    await saveScreenshot('09-fase-2-financial-desktop-balance-quarterly.png');

    // 3. Switch to Arus Kas Kuartalan
    await page.evaluate(() => {
      if (window.AutoCuanFinancialStatements) {
        window.AutoCuanFinancialStatements.setStatementMode('cashflow');
      }
    });
    await new Promise(r => setTimeout(r, 500));
    await saveScreenshot('10-fase-2-financial-desktop-cashflow-quarterly.png');

    // 4. Switch to Rasio Kuartalan
    await page.evaluate(() => {
      if (window.AutoCuanFinancialStatements) {
        window.AutoCuanFinancialStatements.setStatementMode('ratios');
      }
    });
    await new Promise(r => setTimeout(r, 500));
    await saveScreenshot('11-fase-2-financial-desktop-ratios-quarterly.png');

    // 5. Switch to Laba Rugi Tahunan (Annual)
    await page.evaluate(() => {
      if (window.AutoCuanFinancialStatements) {
        window.AutoCuanFinancialStatements.setStatementMode('income');
        window.AutoCuanFinancialStatements.setPeriodMode('annual');
      }
    });
    await new Promise(r => setTimeout(r, 500));
    await saveScreenshot('12-fase-2-financial-desktop-income-annual.png');

    // 6. Mobile Viewport (390x844)
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await new Promise(r => setTimeout(r, 800));
    await saveScreenshot('13-fase-2-financial-mobile-pass.png');

    console.log('[Fase-2-Capture] All 6 screenshots successfully captured and saved!');
  } finally {
    if (browser) await browser.close();
    serverProcess.kill();
  }
}

run().catch(err => {
  console.error('[Fase-2-Capture] Fatal error:', err);
  process.exit(1);
});
