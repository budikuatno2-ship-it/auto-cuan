'use strict';

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3099;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(ROOT, 'bukti-verifikasi-final', 'fase08');
const TARGET_SCREENSHOT = path.join(OUT_DIR, 'struktur_pasar_per_tanggal.png');

fs.mkdirSync(OUT_DIR, { recursive: true });

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

async function main() {
  console.log('[Screenshot] Starting local-dev-server on port ' + PORT + '...');
  const serverProcess = spawn(process.execPath, [path.join(ROOT, 'tools', 'local-dev-server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });

  let browser;
  try {
    await waitForServer(BASE_URL);
    console.log('[Screenshot] Server ready at ' + BASE_URL);

    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1920,1080'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.setExtraHTTPHeaders({ 'x-autocuan-preview': '1' });

    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('autocuan_user', 'budi');
      localStorage.setItem('autocuan_role', 'ADMIN');
      localStorage.setItem('autocuan_is_admin', 'true');
      localStorage.setItem('autocuan_auth', '1');
      localStorage.setItem('autocuan_logged_in', 'true');
      localStorage.setItem('autocuan_tier', 'pro');
      localStorage.setItem('auto_cuan_onboarding_seen', 'true');
      localStorage.setItem('autocuan_onboarding_completed', 'true');
      localStorage.setItem('autocuan_theme', 'dark');
      localStorage.setItem('auto_cuan_theme', 'dark');
      sessionStorage.setItem('activeTicker', 'BBCA');
      document.cookie = 'autocuan_session=test-budi-admin; path=/';
    });

    console.log('[Screenshot] Navigating to analisis-saham.html...');
    await page.goto(`${BASE_URL}/analisis-saham.html?tab=market-structure&ticker=BBCA`, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Dismiss any onboarding modal or banner and switch to market-structure tab
    await page.evaluate(async () => {
      const ob = document.getElementById('onboardingModal');
      if (ob) ob.classList.add('hidden');
      const prevBar = document.getElementById('autocuan-preview-bar');
      if (prevBar) prevBar.remove();

      if (typeof window.switchAnalisisTab === 'function') {
        window.switchAnalisisTab('market-structure');
      }
      if (window.AutoCuanMarketStructure) {
        if (!window.AutoCuanMarketStructure.hasLoaded) {
          await window.AutoCuanMarketStructure.loadUniverse(true);
        }
        window.AutoCuanMarketStructure.selectRow('BBCA', true);
      }
    });

    console.log('[Screenshot] Waiting for market structure table and rows...');
    await page.waitForSelector('#marketStructureTableBody tr[data-ticker]', { timeout: 15000 });
    await new Promise(r => setTimeout(r, 1200));

    // Verify presence of "Per tanggal" column header and data in table
    const tableVerification = await page.evaluate(() => {
      const headers = Array.from(document.querySelectorAll('#marketStructureTable thead th')).map(th => th.textContent.trim());
      const firstRowCols = Array.from(document.querySelectorAll('#marketStructureTableBody tr:first-child td')).map(td => td.textContent.trim());
      const hasPerTanggalHeader = headers.some(h => h.toLowerCase().includes('per tanggal'));
      const chipAll = document.getElementById('marketStructureFilterAll');
      const chipLowFf = document.getElementById('marketStructureFilterLowFF');
      const chipHsc = document.getElementById('marketStructureFilterHsc');
      const chipInc = document.getElementById('marketStructureFilterIncomplete');
      const detailTicker = document.getElementById('msDetailTicker');
      const detailName = document.getElementById('msDetailName');
      const detailFfBig = document.getElementById('msDetailFfBig');
      const detailSource = document.getElementById('msDetailSource');

      return {
        headers,
        hasPerTanggalHeader,
        firstRowCols,
        chips: {
          all: chipAll ? chipAll.textContent.trim() : null,
          lowFf: chipLowFf ? chipLowFf.textContent.trim() : null,
          hsc: chipHsc ? chipHsc.textContent.trim() : null,
          inc: chipInc ? chipInc.textContent.trim() : null
        },
        detail: {
          ticker: detailTicker ? detailTicker.textContent.trim() : null,
          name: detailName ? detailName.textContent.trim() : null,
          freeFloat: detailFfBig ? detailFfBig.textContent.trim() : null,
          source: detailSource ? detailSource.textContent.trim() : null
        }
      };
    });

    console.log('[Screenshot] Verification data:', JSON.stringify(tableVerification, null, 2));

    if (!tableVerification.hasPerTanggalHeader) {
      throw new Error('Column "Per tanggal" not found in #marketStructureTable header!');
    }

    console.log('[Screenshot] Capturing screenshot to ' + TARGET_SCREENSHOT);
    await page.screenshot({ path: TARGET_SCREENSHOT, fullPage: false });

    const stats = fs.statSync(TARGET_SCREENSHOT);
    console.log(`[Screenshot] Successfully captured ${TARGET_SCREENSHOT} (${stats.size} bytes)`);

    // Also write json verification proof
    fs.writeFileSync(path.join(OUT_DIR, 'struktur-pasar-ui-verification.json'), JSON.stringify({
      timestamp: new Date().toISOString(),
      screenshot_path: 'bukti-verifikasi-final/fase08/struktur_pasar_per_tanggal.png',
      screenshot_size_bytes: stats.size,
      table_verification: tableVerification
    }, null, 2), 'utf8');

  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    if (serverProcess) {
      try {
        serverProcess.kill('SIGTERM');
        setTimeout(() => { try { serverProcess.kill('SIGKILL'); } catch (_) {} }, 1000);
      } catch (_) {}
    }
  }
}

main().catch(err => {
  console.error('[Screenshot Error]', err);
  process.exit(1);
});
