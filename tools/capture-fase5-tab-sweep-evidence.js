'use strict';
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const EVIDENCE_DIR = 'D:\\Auto-Cuan\\evidence\\fase-5';
const ARTIFACT_DIR = 'C:\\Users\\ADVAN\\.gemini\\antigravity\\brain\\fc1f9fc3-9cac-46e4-bc9f-2aab2cf38b98';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3099;
const BASE_URL = `http://127.0.0.1:${PORT}`;

for (const dir of [EVIDENCE_DIR, ARTIFACT_DIR]) {
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

function computeSha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function captureShot(page, filename, width, height, options = {}) {
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await new Promise(r => setTimeout(r, 600));

  // Ensure scroll is at top unless preserveScroll is requested
  if (!options.preserveScroll) {
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      const app = document.getElementById('appContent');
      if (app) app.scrollTop = 0;
      const dash = document.getElementById('dashboardScreen');
      if (dash) dash.scrollTop = 0;
      document.querySelectorAll('.page-content').forEach(p => p.scrollTop = 0);
    });
  }

  // Ensure onboarding is hidden
  await page.evaluate(() => {
    const ob = document.getElementById('onboardingModal');
    if (ob) ob.classList.add('hidden');
  });

  const targetPath = path.join(EVIDENCE_DIR, filename);
  await page.screenshot({ path: targetPath, fullPage: false });

  // Copy to artifact directory so Antigravity can view it with view_file
  const artifactPath = path.join(ARTIFACT_DIR, filename);
  fs.copyFileSync(targetPath, artifactPath);

  const hash = computeSha256(targetPath);
  console.log(`[Captured] ${filename} (${width}x${height}) SHA256: ${hash.slice(0, 16)}...`);
  return { filename, width, height, hash };
}

async function run() {
  console.log('[Fase-5-Capture] Starting dev server on port ' + PORT + '...');
  const serverProcess = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });

  let browser;
  const manifest = [];

  try {
    await waitForServer(BASE_URL);
    console.log('[Fase-5-Capture] Server ready at ' + BASE_URL);

    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1920,1080']
    });

    const page = await browser.newPage();
    page.on('console', msg => console.log('[Browser Console]', msg.type(), msg.text()));
    page.on('pageerror', err => console.error('[Browser Error]', err.message));
    await page.setExtraHTTPHeaders({ 'x-autocuan-preview': '1' });

    // Seed mock state for seamless rendering
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('autocuan_user', 'budi');
      localStorage.setItem('autocuan_user_id', 'budi-admin-uuid');
      localStorage.setItem('autocuan_role', 'ADMIN');
      localStorage.setItem('autocuan_auth', '1');
      localStorage.setItem('autocuan_logged_in', 'true');
      localStorage.setItem('autocuan_is_admin', 'true');
      localStorage.setItem('auto_cuan_onboarding_seen', 'true');
      localStorage.setItem('autocuan_onboarding_completed', 'true');
      localStorage.setItem('autocuan_theme', 'dark');
      localStorage.setItem('auto_cuan_theme', 'dark');
      document.cookie = 'autocuan_session=test-budi-admin; path=/';

      // Seed sample plans for portfolio scenarios
      const samplePlans = [
        {
          id: 'plan-bbca',
          ticker: 'BBCA',
          entryPriceIdr: 5950,
          stopLossIdr: 5750,
          tp1Idr: 6250,
          tp2Idr: 6500,
          entry: 5950,
          stop: 5750,
          tp1: 6250,
          tp2: 6500,
          lots: 100,
          riskBudgetIdr: 2000000,
          estimatedMaxLossIdr: 2000000,
          capitalIdr: 59500000,
          positionStatus: 'PLANNED',
          createdAt: '2026-10-12T08:00:00.000Z'
        }
      ];
      const samplePrices = { BBCA: 5950 };
      ['local-dev-admin', 'budi-admin-uuid', 'admin-budi-id', ''].forEach(id => {
        localStorage.setItem('autocuan_portfolio_plans_' + id, JSON.stringify(samplePlans));
        localStorage.setItem('autocuan_portfolio_prices_' + id, JSON.stringify(samplePrices));
      });
      localStorage.setItem('autocuan_portfolio_plans', JSON.stringify(samplePlans));
      localStorage.setItem('autocuan_portfolio_prices', JSON.stringify(samplePrices));
      localStorage.setItem('autocuan_user_id', 'local-dev-admin');
      localStorage.setItem('autocuan_user', 'budi');
    });

    // Helper navigators
    async function navToDashboard() {
      await page.evaluate(() => {
        window.navigateTo('dashboard');
      });
      await page.waitForSelector('#page-dashboard:not(.hidden)', { timeout: 10000 });
      await new Promise(r => setTimeout(r, 600));
    }

    async function navToAnalisisSubTab(subTab) {
      await page.evaluate((tab) => {
        window.navigateTo('analisis', tab);
        if (typeof window.switchAnalisisTab === 'function') window.switchAnalisisTab(tab);
      }, subTab);
      await page.waitForFunction((tab) => {
        const panel = document.getElementById('panel-tab-' + tab);
        return panel && panel.style.display !== 'none';
      }, { timeout: 10000 }, subTab);
      await new Promise(r => setTimeout(r, 600));
    }

    async function navToPortfolioSubTab(subTab) {
      await page.evaluate(() => {
        window.navigateTo('portofolio');
      });
      await page.waitForSelector('#page-portofolio:not(.hidden)', { timeout: 10000 });
      await page.waitForSelector('#portofolioPartialMount .tab-strip, #tabStrip', { timeout: 10000 });
      await page.evaluate((tab) => {
        const btn = document.querySelector('#tabStrip [data-tab="' + tab + '"], [data-tab="' + tab + '"]');
        if (btn) btn.click();
        if (typeof window.openPortfolioTab === 'function') window.openPortfolioTab(tab);
        const mobileSelect = document.getElementById('pccMobileSectionSelect');
        if (mobileSelect) {
          mobileSelect.value = tab;
          mobileSelect.dispatchEvent(new Event('change'));
        }
        if (typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(new CustomEvent('autocuan:portfolio-changed', { detail: { userId: 'local-dev-admin' } }));
        }
      }, subTab);
      await page.waitForFunction((tab) => {
        const p = document.getElementById('page-' + tab);
        return p && (p.classList.contains('active') || p.style.display !== 'none');
      }, { timeout: 10000 }, subTab);
      await new Promise(r => setTimeout(r, 600));
    }

    // Initial page load at dashboard
    await page.goto(`${BASE_URL}/dashboard?page=dashboard`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      document.documentElement.classList.remove('light');
      document.documentElement.classList.add('dark');
      document.documentElement.style.background = '#0b0e14';
      if (typeof window.enterApp === 'function') window.enterApp();
      const ob = document.getElementById('onboardingModal');
      if (ob) ob.classList.add('hidden');
    });
    await new Promise(r => setTimeout(r, 1000));

    // 1. Struktur Pasar (Full Desktop View, No Redundant Bar, No Single Search Bar)
    console.log('[Capture 1] Struktur Pasar desktop view...');
    await page.evaluate(() => {
      const btn = document.getElementById('tabMarketStructure');
      if (btn) btn.click();
      else window.navigateTo('analisis', 'market-structure');
    });
    await page.waitForSelector('#marketStructureTable', { timeout: 10000 });
    await new Promise(r => setTimeout(r, 1000));
    manifest.push(await captureShot(page, '01-fase-5-market-structure-no-redundant-bar-1920x1080.png', 1920, 1080));

    // 2. Struktur Pasar Table Scroll View (Sticky Header Opaque, ADMF not bleeding, AS-OF full date)
    console.log('[Capture 2] Struktur Pasar table scroll view...');
    await page.evaluate(() => {
      const tableWrap = document.getElementById('marketStructureTableContainer');
      if (tableWrap) tableWrap.scrollTop = 415;
    });
    await new Promise(r => setTimeout(r, 800));
    manifest.push(await captureShot(page, '02-fase-5-market-structure-scroll-clean-1920x1080.png', 1920, 1080, { preserveScroll: true }));

    // Reset scroll before leaving
    await page.evaluate(() => {
      const tableWrap = document.getElementById('marketStructureTableContainer');
      if (tableWrap) tableWrap.scrollTop = 0;
    });

    // 3. Dashboard (IHSG Normal badge, Indonesian safety rules text, translated risk labels)
    console.log('[Capture 3] Dashboard view...');
    await navToDashboard();
    manifest.push(await captureShot(page, '03-fase-5-dashboard-translated-labels-1920x1080.png', 1920, 1080));

    // 4. Bandarmologi (WIB dates, Mrd units, subtitle without em dash, Net Flow tooltips)
    console.log('[Capture 4] Bandarmologi view...');
    await navToAnalisisSubTab('bandarmologi');
    await page.evaluate(async () => {
      if (window.BandarmologiRuntime && typeof window.BandarmologiRuntime.loadBandarmologiTab === 'function') {
        await window.BandarmologiRuntime.loadBandarmologiTab('BBCA', '2026-10-12');
      }
      const dateSelect = document.getElementById('brokerDateSelect') || document.getElementById('bandarDateSelect');
      if (dateSelect) {
        dateSelect.value = '2026-10-12';
        dateSelect.dispatchEvent(new Event('change'));
      }
    });
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('.broker-summary-table-wrap tbody tr');
      return rows && rows.length > 5;
    }, { timeout: 15000 });
    await new Promise(r => setTimeout(r, 800));
    await page.evaluate(() => {
      const bWraps = document.querySelectorAll('.broker-summary-table-wrap');
      bWraps.forEach(w => { w.scrollTop = 0; w.scrollLeft = 0; });
    });
    manifest.push(await captureShot(page, '04-fase-5-bandarmologi-wib-mrd-clean-1920x1080.png', 1920, 1080));

    // 5. Portfolio Command Center - Scenarios Subtab (Fee inputs, scale-out net result, break-even stop)
    console.log('[Capture 5] Portfolio Scenarios view...');
    await navToPortfolioSubTab('scenarios');
    await page.waitForFunction(() => {
      const host = document.getElementById('scenarioList');
      return host && host.querySelectorAll('.card-head, .metric').length > 0;
    }, { timeout: 15000 });
    await new Promise(r => setTimeout(r, 800));
    manifest.push(await captureShot(page, '05-fase-5-portfolio-scenarios-fees-and-breakeven-1920x1080.png', 1920, 1080));

    // 6. Portfolio Command Center - Today Subtab
    console.log('[Capture 6] Portfolio Today view...');
    await navToPortfolioSubTab('today');
    manifest.push(await captureShot(page, '06-fase-5-portfolio-today-1920x1080.png', 1920, 1080));

    // 7. Portfolio Command Center - Planner Subtab
    console.log('[Capture 7] Portfolio Planner view...');
    await navToPortfolioSubTab('planner');
    manifest.push(await captureShot(page, '07-fase-5-portfolio-planner-1920x1080.png', 1920, 1080));

    // 8. Portfolio Command Center - Risk Subtab
    console.log('[Capture 8] Portfolio Risk view...');
    await navToPortfolioSubTab('risk');
    manifest.push(await captureShot(page, '08-fase-5-portfolio-risk-1920x1080.png', 1920, 1080));

    // 9. Ranking Harian PRO View
    console.log('[Capture 9] Ranking Harian PRO view...');
    await navToAnalisisSubTab('ranking');
    await page.evaluate(() => {
      if (typeof window.ensureRankingTableLoaded === 'function') window.ensureRankingTableLoaded();
      else if (typeof window.fetchRankingTable === 'function') window.fetchRankingTable();
    });
    await page.waitForFunction(() => {
      const wrap = document.getElementById('rankingTableWrap');
      return wrap && wrap.querySelectorAll('tr').length > 2;
    }, { timeout: 10000 });
    await new Promise(r => setTimeout(r, 800));
    manifest.push(await captureShot(page, '09-fase-5-ranking-harian-pro-1920x1080.png', 1920, 1080));

    // 10. Pattern Radar ADMIN View
    console.log('[Capture 10] Pattern Radar ADMIN view...');
    await navToAnalisisSubTab('pattern');
    manifest.push(await captureShot(page, '10-fase-5-pattern-radar-admin-1920x1080.png', 1920, 1080));

    // 11. Track Record View
    console.log('[Capture 11] Track Record view...');
    await page.evaluate(() => {
      window.navigateTo('trackrecord');
    });
    await page.waitForSelector('#page-trackrecord:not(.hidden)', { timeout: 10000 });
    await new Promise(r => setTimeout(r, 800));
    manifest.push(await captureShot(page, '11-fase-5-track-record-1920x1080.png', 1920, 1080));

    // 12. Screener Desktop (1366x768 - E1 laptop standard)
    console.log('[Capture 12] Screener desktop 1366x768...');
    await page.evaluate(() => {
      window.navigateTo('screener');
    });
    await page.waitForSelector('#page-screener:not(.hidden)', { timeout: 10000 });
    await new Promise(r => setTimeout(r, 800));
    manifest.push(await captureShot(page, '12-fase-5-screener-desktop-1366x768.png', 1366, 768));

    // 13. Dashboard Tablet (768x1024 - E1 tablet standard)
    console.log('[Capture 13] Dashboard tablet 768x1024...');
    await navToDashboard();
    manifest.push(await captureShot(page, '13-fase-5-dashboard-tablet-768x1024.png', 768, 1024));

    // 14. Struktur Pasar Mobile (390x844 - E1 mobile standard)
    console.log('[Capture 14] Struktur Pasar mobile 390x844...');
    await page.evaluate(() => {
      const btn = document.getElementById('tabMarketStructure');
      if (btn) btn.click();
      else window.navigateTo('analisis', 'market-structure');
    });
    await page.waitForSelector('#marketStructureCardsContainer', { timeout: 10000 });
    await new Promise(r => setTimeout(r, 800));
    manifest.push(await captureShot(page, '14-fase-5-market-structure-mobile-390x844.png', 390, 844));

    // 15. Portfolio Scenarios Mobile (390x844 - E1 mobile standard)
    console.log('[Capture 15] Portfolio Scenarios mobile 390x844...');
    await navToPortfolioSubTab('scenarios');
    await page.waitForFunction(() => {
      const host = document.getElementById('scenarioList');
      return host && host.querySelectorAll('.card-head, .metric').length > 0;
    }, { timeout: 15000 });
    await new Promise(r => setTimeout(r, 800));
    manifest.push(await captureShot(page, '15-fase-5-portfolio-scenarios-mobile-390x844.png', 390, 844));

    // 16. Portfolio Scenarios Mobile (360x780 - E1 compact mobile standard)
    console.log('[Capture 16] Portfolio Scenarios mobile 360x780...');
    manifest.push(await captureShot(page, '16-fase-5-portfolio-scenarios-mobile-360x780.png', 360, 780));

    console.log('[Fase-5-Capture] Successfully captured all ' + manifest.length + ' evidence screenshots!');
  } finally {
    if (browser) await browser.close().catch(() => {});
    serverProcess.kill();
  }
}

run().catch(err => {
  console.error('[Fase-5-Capture] Failed:', err);
  process.exit(1);
});
