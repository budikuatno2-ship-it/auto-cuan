'use strict';
const puppeteer = require('D:/auto-cuan-2/node_modules/puppeteer-core');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots', 'wave5-screener-sektor-hot');
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
  console.log(`[Wave5-Capture] Starting local-dev-server on port ${PORT}...`);
  const serverProcess = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SUPABASE_URL: '' },
    stdio: 'ignore'
  });

  let browser;
  try {
    await waitForServer(`${BASE_URL}/health`);
    console.log(`[Wave5-Capture] local-dev-server ready at ${BASE_URL}`);

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
        localStorage.setItem('autocuan_logged_in', 'true');
        localStorage.setItem('autocuan_username', 'budi');
        localStorage.setItem('autocuan_role', 'admin');
        localStorage.setItem('autocuan_is_admin', 'true');
        localStorage.setItem('autocuan_user_id', 'usr_budi_01');
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

    // 1. Desktop Screener Konglo Table-First (1440x900)
    console.log('[Wave5-Capture] Capturing 01_desktop_screener_konglo_table.png...');
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/dashboard?page=screener&mode=konglo&preview=1`, { waitUntil: 'networkidle2' });
    await dismissOverlays();
    await setLight();
    await page.evaluate(async () => {
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('screener');
      }
      if (typeof window.switchScreenerType === 'function') {
        window.switchScreenerType('konglo');
      }
      if (typeof window.loadSwingScreener === 'function') {
        await window.loadSwingScreener();
      }
      await new Promise(r => setTimeout(r, 600));
      // Auto-select first row if exists
      const firstRow = document.querySelector('#screenerTableBody tr[data-ticker]');
      if (firstRow && window.AutoCuanScreener) {
        const ticker = firstRow.getAttribute('data-ticker');
        window.AutoCuanScreener.selectRow('konglo', ticker, firstRow);
      }
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01_desktop_screener_konglo_table.png') });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave5b-screener-table-clean-1440x900.png') });

    // 2. Desktop Screener Konglo Plan View (1440x900)
    console.log('[Wave5-Capture] Capturing 02_desktop_screener_konglo_plan_view.png & wave5b-screener-plan-1440x900.png...');
    await page.evaluate(() => {
      if (window.toggleScreenerView) {
        window.toggleScreenerView('konglo', 'card');
      }
    });
    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02_desktop_screener_konglo_plan_view.png') });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave5b-screener-plan-1440x900.png') });

    // Switch back to table
    await page.evaluate(() => {
      if (window.toggleScreenerView) {
        window.toggleScreenerView('konglo', 'table');
      }
    });

    // 3. Desktop Screener Non-Konglo Table-First (1440x900)
    console.log('[Wave5-Capture] Capturing 03_desktop_screener_nonkonglo_table.png...');
    await page.evaluate(async () => {
      if (typeof window.switchScreenerType === 'function') {
        window.switchScreenerType('nonkonglo');
      }
      if (typeof window.loadNkScreener === 'function') {
        await window.loadNkScreener();
      }
      await new Promise(r => setTimeout(r, 600));
      const firstRow = document.querySelector('#nkScreenerTableBody tr[data-ticker]');
      if (firstRow && window.AutoCuanScreener) {
        const ticker = firstRow.getAttribute('data-ticker');
        window.AutoCuanScreener.selectRow('nonkonglo', ticker, firstRow);
      }
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03_desktop_screener_nonkonglo_table.png') });

    // 4. Desktop Screener Day Trade Table-First (1440x900)
    console.log('[Wave5-Capture] Capturing 04_desktop_screener_daytrade_table.png & wave5b-daytrade-fixed-1440x900.png...');
    await page.evaluate(async () => {
      if (typeof window.switchScreenerType === 'function') {
        window.switchScreenerType('daytrade');
      }
      if (typeof window.loadDayTradeScreener === 'function') {
        await window.loadDayTradeScreener();
      }
      await new Promise(r => setTimeout(r, 600));
      const firstRow = document.querySelector('#dtScreenerTableBody tr[data-ticker]');
      if (firstRow && window.AutoCuanScreener) {
        const ticker = firstRow.getAttribute('data-ticker');
        window.AutoCuanScreener.selectRow('daytrade', ticker, firstRow);
      }
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04_desktop_screener_daytrade_table.png') });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave5b-daytrade-fixed-1440x900.png') });

    // 5. Tablet Screener Konglo Table-First (768x1024)
    console.log('[Wave5-Capture] Capturing 05_tablet_screener_konglo_table.png...');
    await page.setViewport({ width: 768, height: 1024 });
    await page.evaluate(async () => {
      if (typeof window.switchScreenerType === 'function') {
        window.switchScreenerType('konglo');
      }
    });
    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05_tablet_screener_konglo_table.png') });

    // 6. Mobile Screener Konglo Table (390x844)
    console.log('[Wave5-Capture] Capturing 06_mobile_screener_konglo_table.png...');
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => {
      if (window.AutoCuanScreener) {
        window.AutoCuanScreener.closeMobileSheet();
      }
    });
    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '06_mobile_screener_konglo_table.png') });

    // 7. Mobile Screener Konglo Sheet Open (390x844)
    console.log('[Wave5-Capture] Capturing 07_mobile_screener_detail_sheet.png & wave5b-screener-mobile-390x844.png...');
    await page.evaluate(() => {
      const firstRow = document.querySelector('#screenerTableBody tr[data-ticker]');
      if (firstRow && window.AutoCuanScreener) {
        const ticker = firstRow.getAttribute('data-ticker');
        window.AutoCuanScreener.selectRow('konglo', ticker, firstRow);
      }
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '07_mobile_screener_detail_sheet.png') });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave5b-screener-mobile-390x844.png') });

    // 8. Desktop Sektor Hot Overview Table (1440x900)
    console.log('[Wave5-Capture] Capturing 08_desktop_sektor_hot_table.png & wave5b-sektor-overview-1440x900.png...');
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/dashboard?page=sektor`, { waitUntil: 'networkidle2' });
    await dismissOverlays();
    await setLight();
    await page.evaluate(async () => {
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('sektor');
      }
      if (typeof window.loadSektorHot === 'function') {
        await window.loadSektorHot();
      }
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '08_desktop_sektor_hot_table.png') });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave5b-sektor-overview-1440x900.png') });

    // 9. Desktop Sektor Hot Group Detail: SALIM (1440x900)
    console.log('[Wave5-Capture] Capturing 09_desktop_sektor_hot_detail.png & wave5b-sektor-group-detail-1440x900.png (Salim)...');
    await page.evaluate(async () => {
      if (typeof window.showGroupDetail === 'function') {
        await window.showGroupDetail('KONGLO_SALIM');
      }
    });
    await new Promise(r => setTimeout(r, 700));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '09_desktop_sektor_hot_detail.png') });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave5b-sektor-group-detail-1440x900.png') });

    // 9b. Desktop Sektor Hot Group Detail: BARITO (1440x900) to prove zero cross-bleed
    console.log('[Wave5-Capture] Capturing wave5b-sektor-barito-detail-1440x900.png (Barito)...');
    await page.evaluate(async () => {
      if (typeof window.showGroupDetail === 'function') {
        await window.showGroupDetail('KONGLO_BARITO');
      }
    });
    await new Promise(r => setTimeout(r, 700));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave5b-sektor-barito-detail-1440x900.png') });

    // 10. Mobile Sektor Hot Overview (390x844)
    console.log('[Wave5-Capture] Capturing 10_mobile_sektor_hot_overview.png...');
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => {
      if (typeof window.backToSektorList === 'function') {
        window.backToSektorList();
      }
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '10_mobile_sektor_hot_overview.png') });

    console.log('[Wave5-Capture] All screenshots captured successfully in:', SCREENSHOT_DIR);
  } catch (err) {
    console.error('[Wave5-Capture] Error capturing screenshots:', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    serverProcess.kill();
  }
}

run();
