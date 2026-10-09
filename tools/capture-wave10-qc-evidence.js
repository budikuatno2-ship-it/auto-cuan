'use strict';

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3000;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const OUT_DIRS = [
  path.join(ROOT),
  path.join(ROOT, 'screenshots')
];

OUT_DIRS.forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function checkServer(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      resolve(res.statusCode < 500);
    }).on('error', () => {
      resolve(false);
    });
  });
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureServer() {
  const isUp = await checkServer(`${BASE_URL}/`);
  if (isUp) {
    console.log('[Wave10-QC] Server already responding on port', PORT);
    return null;
  }
  console.log('[Wave10-QC] Spawning local dev server on port', PORT, '...');
  const serverProc = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    stdio: 'ignore'
  });
  serverProc.unref();

  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const up = await checkServer(`${BASE_URL}/`);
    if (up) {
      console.log('[Wave10-QC] Server is up and responding.');
      return serverProc;
    }
  }
  throw new Error('Server failed to start after 15 seconds.');
}

async function run() {
  let serverProc = null;
  let browser = null;

  try {
    serverProc = await ensureServer();

    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    async function saveScreenshot(page, filename) {
      for (const outDir of OUT_DIRS) {
        const dest = path.join(outDir, filename);
        await page.screenshot({ path: dest });
        console.log('  Saved:', dest);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. wave10-qc-screener-mobile-light-390x844.png & 360x780
    // Viewports: 390x844 and 360x780, light mode, showing compact density and stock results
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[1/2] Capturing Screener Mobile Light (390x844 & 360x780)...');
    const page1 = await browser.newPage();
    await page1.setExtraHTTPHeaders({ 'x-autocuan-hide-preview-bar': '1' });
    await page1.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page1.goto(`${BASE_URL}/preview/screener?nobar=1`, { waitUntil: 'networkidle2' });

    // Ensure light theme is active
    await page1.evaluate(() => {
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
      document.documentElement.setAttribute('data-theme', 'light');
    });

    // Wait for screener rows to populate
    await page1.waitForFunction(() => {
      const rows = document.querySelectorAll('#screenerTableBody tr');
      return rows.length > 0 && !rows[0].querySelector('td[colspan]');
    }, { timeout: 8000 }).catch(() => {});
    await sleep(600);

    // Measure at 390x844
    const metrics390 = await page1.evaluate(() => {
      const header = document.querySelector('#page-screener .page-header');
      const filterGrid = document.querySelector('.scr-filter-grid');
      const tableWrap = document.getElementById('screenerTableWrap');
      const firstRow = document.querySelector('#screenerTableBody tr');
      const tabsContainer = document.querySelector('#page-screener .screener-tab') ? document.querySelector('#page-screener .screener-tab').parentElement : null;
      const previewBar = document.getElementById('autocuan-preview-bar');

      const rowRect = firstRow ? firstRow.getBoundingClientRect() : null;
      const visibleHeight = rowRect ? Math.max(0, Math.min(window.innerHeight, rowRect.bottom) - Math.max(0, rowRect.top)) : 0;

      return {
        viewport: '390x844',
        headerVisible: header ? window.getComputedStyle(header).display !== 'none' : false,
        filterGridHeight: filterGrid ? filterGrid.offsetHeight : 0,
        tableWrapTop: tableWrap ? Math.round(tableWrap.getBoundingClientRect().top) : 0,
        tabsScrollable: tabsContainer ? (tabsContainer.scrollWidth > tabsContainer.clientWidth) : false,
        previewBarPresent: Boolean(previewBar),
        firstRow: rowRect ? {
          ticker: firstRow.querySelector('td') ? firstRow.querySelector('td').innerText.trim() : 'unknown',
          top: Math.round(rowRect.top),
          bottom: Math.round(rowRect.bottom),
          height: Math.round(rowRect.height),
          unobstructedVisibleHeight: Math.round(visibleHeight),
          isFullyVisible: visibleHeight >= (rowRect.height * 0.9)
        } : null
      };
    });
    console.log('  Screener 390x844 metrics:', metrics390);

    await saveScreenshot(page1, 'wave10-qc-screener-mobile-light-390x844.png');

    // Measure at 360x780
    await page1.setViewport({ width: 360, height: 780, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await sleep(500);

    const metrics360 = await page1.evaluate(() => {
      const tableWrap = document.getElementById('screenerTableWrap');
      const firstRow = document.querySelector('#screenerTableBody tr');
      const rowRect = firstRow ? firstRow.getBoundingClientRect() : null;
      const visibleHeight = rowRect ? Math.max(0, Math.min(window.innerHeight, rowRect.bottom) - Math.max(0, rowRect.top)) : 0;

      return {
        viewport: '360x780',
        tableWrapTop: tableWrap ? Math.round(tableWrap.getBoundingClientRect().top) : 0,
        firstRow: rowRect ? {
          ticker: firstRow.querySelector('td') ? firstRow.querySelector('td').innerText.trim() : 'unknown',
          top: Math.round(rowRect.top),
          bottom: Math.round(rowRect.bottom),
          height: Math.round(rowRect.height),
          unobstructedVisibleHeight: Math.round(visibleHeight),
          isFullyVisible: visibleHeight >= (rowRect.height * 0.9)
        } : null
      };
    });
    console.log('  Screener 360x780 metrics:', metrics360);
    await saveScreenshot(page1, 'wave10-qc-screener-mobile-light-360x780.png');

    await page1.close();

    // ─────────────────────────────────────────────────────────────────────────
    // 2. wave10-qc-dark-contrast-dashboard-1440x900.png
    // Viewport: 1440x900, dark mode, showing WCAG AA contrast for hints/notes
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[2/2] Capturing Dashboard Dark Mode Contrast (1440x900)...');
    const page2 = await browser.newPage();
    await page2.setExtraHTTPHeaders({ 'x-autocuan-hide-preview-bar': '1' });
    await page2.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
    await page2.goto(`${BASE_URL}/preview/dashboard?nobar=1`, { waitUntil: 'networkidle2' });

    // Ensure dark theme is active via canonical app theme switcher
    await page2.evaluate(() => {
      if (typeof applyAppTheme === 'function') {
        applyAppTheme('dark');
      } else {
        document.documentElement.classList.remove('light');
        document.body.classList.remove('light');
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    });
    await sleep(800);

    const contrastMetrics = await page2.evaluate(() => {
      const hint = document.querySelector('.ac-section-hint');
      const note = document.querySelector('#page-dashboard .dash-section-note');
      const freshnessNote = document.getElementById('dashMarketFreshnessNote');
      const getStyle = el => el ? window.getComputedStyle(el) : null;
      const hintStyle = getStyle(hint);
      const noteStyle = getStyle(note);
      return {
        htmlClasses: document.documentElement.className,
        bodyClasses: document.body ? document.body.className : '',
        hintColor: hintStyle ? hintStyle.color : null,
        noteColor: noteStyle ? noteStyle.color : null,
        freshnessNoteText: freshnessNote ? freshnessNote.innerText.trim() : null
      };
    });
    console.log('  Contrast computed colors and freshness note:', contrastMetrics);

    await saveScreenshot(page2, 'wave10-qc-dark-contrast-dashboard-1440x900.png');
    await page2.close();

    console.log('\n[Wave10-QC] Visual capture complete! 3 required evidence screenshots captured.');

  } finally {
    if (browser) {
      await browser.close();
    }
    if (serverProc) {
      try {
        serverProc.kill();
      } catch (_) {}
    }
  }
}

run().catch(err => {
  console.error('[Wave10-QC] Fatal error:', err);
  process.exit(1);
});
