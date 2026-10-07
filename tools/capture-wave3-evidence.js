'use strict';
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots', 'wave3-primitives');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3040;
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
  console.log('[Wave3-Capture] Starting local-dev-server on port ' + PORT + '...');
  const serverProcess = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });

  let browser;
  try {
    await waitForServer(BASE_URL);
    console.log('[Wave3-Capture] local-dev-server ready at ' + BASE_URL);

    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();

    // 1. Desktop Table Split View + Docked Detail Pane (1440x900 Light)
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/wave3-primitives-preview.html`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      document.documentElement.className = 'light';
      document.body.className = '';
      document.body.removeAttribute('data-theme');
    });
    await new Promise(r => setTimeout(r, 600));
    const dest1 = path.join(SCREENSHOT_DIR, '01-desktop-table-split-detail-1440x900.png');
    await page.screenshot({ path: dest1 });
    console.log('[Wave3-Capture] Saved: ' + dest1);

    // 2. Desktop Filter Bar with Active Removable Chips & Intraday Provenance Header (1440x900 Light)
    const dest2 = path.join(SCREENSHOT_DIR, '02-desktop-filter-chips-freshness-1440x900.png');
    await page.screenshot({ path: dest2 });
    console.log('[Wave3-Capture] Saved: ' + dest2);

    // 3. Tablet Presentation Before Detail Open (768x1024 Light)
    await page.setViewport({ width: 768, height: 1024 });
    await page.reload({ waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      document.documentElement.className = 'light';
    });
    await new Promise(r => setTimeout(r, 600));

    // Verify no horizontal overflow on tablet
    const tabletOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    console.log('[Wave3-Capture] Tablet horizontal overflow detected:', tabletOverflow);
    if (tabletOverflow) console.warn('[Wave3-Capture] WARNING: Horizontal overflow on tablet!');

    const dest3 = path.join(SCREENSHOT_DIR, '03-tablet-table-unopened-768x1024.png');
    await page.screenshot({ path: dest3 });
    console.log('[Wave3-Capture] Saved: ' + dest3);

    // 4. Tablet Detail Sheet Visibly Open as Overlay (§2346, 768x1024 Light)
    // Click on the first row to trigger the bottom sheet overlay
    await page.evaluate(() => {
      const firstRow = document.querySelector('#previewTable tbody tr');
      if (firstRow) firstRow.click();
    });
    await new Promise(r => setTimeout(r, 600));

    const tabletSheetOpen = await page.evaluate(() => {
      const sheet = document.getElementById('mobileDetailSheet');
      return sheet && sheet.classList.contains('is-open');
    });
    console.log('[Wave3-Capture] Tablet sheet is-open:', tabletSheetOpen);

    const dest4 = path.join(SCREENSHOT_DIR, '04-tablet-detail-sheet-open-768x1024.png');
    await page.screenshot({ path: dest4 });
    console.log('[Wave3-Capture] Saved: ' + dest4);

    // 5. Mobile Presentation (390x844 Light) Before Detail Open
    await page.setViewport({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      document.documentElement.className = 'light';
    });
    await new Promise(r => setTimeout(r, 600));

    // Verify no horizontal overflow on mobile
    const mobileOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    console.log('[Wave3-Capture] Mobile horizontal overflow detected:', mobileOverflow);
    if (mobileOverflow) console.warn('[Wave3-Capture] WARNING: Horizontal overflow on mobile!');

    const dest5 = path.join(SCREENSHOT_DIR, '05-mobile-table-unopened-390x844.png');
    await page.screenshot({ path: dest5 });
    console.log('[Wave3-Capture] Saved: ' + dest5);

    // 6. Mobile Detail Sheet Visibly Open (390x844 Light)
    await page.evaluate(() => {
      const firstRow = document.querySelector('#previewTable tbody tr');
      if (firstRow) firstRow.click();
    });
    await new Promise(r => setTimeout(r, 600));

    const mobileSheetMetrics = await page.evaluate(() => {
      const sheet = document.getElementById('mobileDetailSheet');
      const closeBtn = document.getElementById('sheetCloseBtn');
      const rect = closeBtn ? closeBtn.getBoundingClientRect() : null;
      return {
        isOpen: sheet && sheet.classList.contains('is-open'),
        closeWidth: rect ? rect.width : 0,
        closeHeight: rect ? rect.height : 0
      };
    });
    console.log('[Wave3-Capture] Mobile sheet metrics:', mobileSheetMetrics);

    const dest6 = path.join(SCREENSHOT_DIR, '06-mobile-detail-sheet-open-390x844.png');
    await page.screenshot({ path: dest6 });
    console.log('[Wave3-Capture] Saved: ' + dest6);

    // Test focus restoration on mobile close
    const focusRestored = await page.evaluate(() => {
      const closeBtn = document.getElementById('sheetCloseBtn');
      const firstRow = document.querySelector('#previewTable tbody tr');
      if (closeBtn) closeBtn.click();
      return document.activeElement === firstRow;
    });
    console.log('[Wave3-Capture] Focus restored to row upon sheet close:', focusRestored);

    // 7. Desktop Lifecycle & Feedback Grammar (1440x900 Light)
    await page.setViewport({ width: 1440, height: 900 });
    await page.reload({ waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      document.documentElement.className = 'light';
      window.scrollTo(0, document.body.scrollHeight);
    });
    await new Promise(r => setTimeout(r, 600));
    const dest7 = path.join(SCREENSHOT_DIR, '07-desktop-lifecycle-feedback-grammar-1440x900.png');
    await page.screenshot({ path: dest7 });
    console.log('[Wave3-Capture] Saved: ' + dest7);

    // 8. Desktop Dark Theme / Night Research Mode (1440x900 Dark) - 1 single dark screenshot
    await page.evaluate(() => {
      document.documentElement.className = 'dark';
      document.body.className = 'dark';
      document.body.setAttribute('data-theme', 'dark');
      window.scrollTo(0, 0);
    });
    await new Promise(r => setTimeout(r, 600));
    const dest8 = path.join(SCREENSHOT_DIR, '08-desktop-primitives-dark-1440x900.png');
    await page.screenshot({ path: dest8 });
    console.log('[Wave3-Capture] Saved: ' + dest8);

    console.log('[Wave3-Capture] All Wave 3 evidence screenshots captured successfully.');
  } finally {
    if (browser) await browser.close();
    serverProcess.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error('[Wave3-Capture] Error:', err);
  process.exit(1);
});
