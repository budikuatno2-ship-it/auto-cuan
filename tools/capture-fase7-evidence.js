'use strict';
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const EVIDENCE_DIR = 'D:\\Auto-Cuan\\evidence\\fase-7';
const ARTIFACT_DIR = 'C:\\Users\\ADVAN\\.gemini\\antigravity\\brain\\fc1f9fc3-9cac-46e4-bc9f-2aab2cf38b98';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = process.env.PORT || 3000;
const BASE_URL = `http://127.0.0.1:${PORT}`;

for (const dir of [EVIDENCE_DIR, ARTIFACT_DIR]) {
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  }
}

function waitForServer(url, timeoutMs = 5000) {
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
  await page.evaluate(() => {
    try { window.dispatchEvent(new Event('resize')); } catch (_) {}
  });
  await new Promise(r => setTimeout(r, 600));

  if (!options.preserveScroll) {
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      const app = document.getElementById('appContent');
      if (app) app.scrollTop = 0;
      document.querySelectorAll('.page-content').forEach(p => p.scrollTop = 0);
    });
  }

  // Remove modals or preview bars if present
  await page.evaluate(() => {
    const ob = document.getElementById('onboardingModal');
    if (ob) ob.classList.add('hidden');
    const prevBar = document.getElementById('autocuan-preview-bar');
    if (prevBar) prevBar.remove();
  });

  const targetPath = path.join(EVIDENCE_DIR, filename);
  await page.screenshot({ path: targetPath, fullPage: false });

  const artifactPath = path.join(ARTIFACT_DIR, filename);
  fs.copyFileSync(targetPath, artifactPath);

  const hash = computeSha256(targetPath);
  console.log(`[Captured] ${filename} (${width}x${height}) SHA256: ${hash.slice(0, 16)}...`);
  return { filename, width, height, hash };
}

async function setupPageSession(page) {
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('autocuan_auth_user', 'budi');
    localStorage.setItem('autocuan_auth_token', 'token-budi-dev-2026');
    localStorage.setItem('autocuan_is_admin', 'true');
    localStorage.setItem('autocuan_user_tier', 'PRO');
    sessionStorage.setItem('autocuan_session_verified', 'true');
    window.__AUTOCUAN_AUTHENTICATED_SESSION__ = {
      username: 'budi',
      isAdmin: true,
      tier: 'PRO',
      expiresAt: Date.now() + 86400000
    };
  });
}

async function showSmartBroksum(page, ticker) {
  await page.evaluate((tk) => {
    if (window.navigateTo) window.navigateTo('analisis', 'bandarmologi', { ticker: tk });
  }, ticker);
  await page.waitForFunction(() => !!document.getElementById('smartBrokerSummaryContainer'), { timeout: 15000 });
  await page.evaluate((tk) => {
    if (window.switchAnalisisTab) window.switchAnalisisTab('bandarmologi');
    if (window.AutoCuanMarketIntelligence) {
      window.AutoCuanMarketIntelligence.renderSmartBrokerSummary('smartBrokerSummaryContainer', tk);
    }
  }, ticker);
  await page.waitForFunction((tk) => {
    const el = document.querySelector('.ac-smart-broksum-wrap');
    return el && el.innerText.includes(tk);
  }, { timeout: 15000 }, ticker);
  await new Promise(r => setTimeout(r, 600));
}

async function showDashboardMarketBreadth(page) {
  await page.evaluate(() => {
    if (window.navigateTo) window.navigateTo('dashboard');
    if (window.AutoCuanMarketIntelligence) {
      window.AutoCuanMarketIntelligence.renderMarketBreadth('dashboardMarketBreadthWrap');
    }
  });
  await page.waitForFunction(() => {
    const el = document.querySelector('.ac-market-breadth-card');
    return el && el.innerText.includes('Market Breadth');
  }, { timeout: 15000 });
  await new Promise(r => setTimeout(r, 600));
}

async function showScreenerPresets(page, activePreset = null) {
  await page.evaluate((presetId) => {
    if (window.navigateTo) window.navigateTo('screener');
    if (window.AutoCuanMarketIntelligence) {
      window.AutoCuanMarketIntelligence.render8ScreenerPresets('screenerPresetsContainer');
      if (presetId) window.AutoCuanMarketIntelligence.applyPreset(presetId);
    }
  }, activePreset);
  await page.waitForFunction(() => {
    const el = document.querySelector('.ac-presets-container');
    return el && el.querySelectorAll('.ac-preset-btn').length >= 8;
  }, { timeout: 15000 });
  await new Promise(r => setTimeout(r, 600));
}

async function run() {
  let serverProcess = null;
  try {
    await waitForServer(BASE_URL, 2000);
    console.log('[Fase-7-Capture] Using existing server at ' + BASE_URL);
  } catch (_) {
    console.log('[Fase-7-Capture] Starting dev server on port ' + PORT + '...');
    serverProcess = spawn('node', ['tools/local-dev-server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'inherit'
    });
    await waitForServer(BASE_URL, 15000);
    console.log('[Fase-7-Capture] Dev server ready at ' + BASE_URL);
  }

  let browser;
  const manifest = [];

  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1920,1080']
    });

    const page = await browser.newPage();
    await page.setCookie({
      name: 'ac_sess',
      value: 'preview-budi-session',
      domain: '127.0.0.1',
      path: '/'
    });
    await setupPageSession(page);

    // Initial navigation
    await page.goto(`${BASE_URL}/#dashboard`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => !!window.AutoCuanCommandPalette, { timeout: 10000 });

    // =========================================================================
    // PART 1: DESKTOP 1920x1080
    // =========================================================================
    console.log('\n--- Capturing Desktop 1920x1080 ---');

    // 01: Command Palette Open (Popular Defaults)
    await page.evaluate(() => {
      window.AutoCuanCommandPalette.open();
    });
    await new Promise(r => setTimeout(r, 800));
    manifest.push(await captureShot(page, '01-fase-7-command-palette-open-1920x1080.png', 1920, 1080));

    // 02: Command Palette Search BBCA
    await page.evaluate(() => {
      const inp = document.getElementById('commandPaletteInput');
      if (inp) {
        inp.value = 'BBCA';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await new Promise(r => setTimeout(r, 600));
    manifest.push(await captureShot(page, '02-fase-7-command-palette-search-bbca-1920x1080.png', 1920, 1080));

    // Close command palette
    await page.evaluate(() => {
      window.AutoCuanCommandPalette.close();
    });
    await new Promise(r => setTimeout(r, 400));

    // 03: Dashboard Market Breadth
    await showDashboardMarketBreadth(page);
    manifest.push(await captureShot(page, '03-fase-7-dashboard-market-breadth-1920x1080.png', 1920, 1080));

    // 04: Bandarmologi Smart Broker Summary (BBCA)
    await showSmartBroksum(page, 'BBCA');
    manifest.push(await captureShot(page, '04-fase-7-bandarmologi-smart-broksum-bbca-1920x1080.png', 1920, 1080));

    // 05: Bandarmologi Smart Broker Summary (BRPT)
    await showSmartBroksum(page, 'BRPT');
    manifest.push(await captureShot(page, '05-fase-7-bandarmologi-smart-broksum-brpt-1920x1080.png', 1920, 1080));

    // 06: Screener 8 Presets Grid
    await showScreenerPresets(page);
    manifest.push(await captureShot(page, '06-fase-7-screener-8-presets-grid-1920x1080.png', 1920, 1080));

    // 07: Screener Preset Popover Open (silent_accumulation)
    await page.evaluate(() => {
      if (window.AutoCuanMarketIntelligence) {
        window.AutoCuanMarketIntelligence.togglePopover('silent_accumulation');
      }
    });
    await page.waitForFunction(() => {
      const el = document.getElementById('popover_silent_accumulation');
      return el && el.style.display === 'block';
    }, { timeout: 10000 });
    await new Promise(r => setTimeout(r, 600));
    manifest.push(await captureShot(page, '07-fase-7-screener-preset-popover-open-1920x1080.png', 1920, 1080));

    // 08: Screener Preset Filtered Results
    await page.evaluate(() => {
      if (window.AutoCuanMarketIntelligence) {
        window.AutoCuanMarketIntelligence.closePopovers();
        window.AutoCuanMarketIntelligence.applyPreset('silent_accumulation');
      }
    });
    await page.waitForFunction(() => {
      const el = document.querySelector('.ac-preset-results-card');
      return el && el.querySelectorAll('tbody tr').length > 0;
    }, { timeout: 15000 });
    await new Promise(r => setTimeout(r, 800));
    manifest.push(await captureShot(page, '08-fase-7-screener-preset-filtered-results-1920x1080.png', 1920, 1080));

    // 25: Bi-directional Select Flow (Click row to switch context)
    await page.evaluate(() => {
      if (window.AutoCuanMarketIntelligence) {
        window.AutoCuanMarketIntelligence.selectStockRow('TLKM');
      }
    });
    await new Promise(r => setTimeout(r, 1000));
    manifest.push(await captureShot(page, '25-fase-7-bidirectional-select-flow-1920x1080.png', 1920, 1080));

    // =========================================================================
    // PART 2: LAPTOP 1366x768
    // =========================================================================
    console.log('\n--- Capturing Laptop 1366x768 ---');

    // 09: Command Palette 1366x768
    await page.evaluate(() => {
      window.AutoCuanCommandPalette.open();
      const inp = document.getElementById('commandPaletteInput');
      if (inp) {
        inp.value = 'BMRI';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await new Promise(r => setTimeout(r, 600));
    manifest.push(await captureShot(page, '09-fase-7-command-palette-1366x768.png', 1366, 768));

    await page.evaluate(() => { window.AutoCuanCommandPalette.close(); });
    await new Promise(r => setTimeout(r, 300));

    // 10: Dashboard Market Breadth 1366x768
    await showDashboardMarketBreadth(page);
    manifest.push(await captureShot(page, '10-fase-7-dashboard-market-breadth-1366x768.png', 1366, 768));

    // 11: Smart Broksum 1366x768 (TLKM)
    await showSmartBroksum(page, 'TLKM');
    manifest.push(await captureShot(page, '11-fase-7-smart-broksum-1366x768.png', 1366, 768));

    // 12: Screener Presets 1366x768
    await showScreenerPresets(page);
    manifest.push(await captureShot(page, '12-fase-7-screener-presets-1366x768.png', 1366, 768));

    // =========================================================================
    // PART 3: TABLET 768x1024
    // =========================================================================
    console.log('\n--- Capturing Tablet 768x1024 ---');

    // 13: Command Palette Tablet
    await page.evaluate(() => {
      window.AutoCuanCommandPalette.open();
      const inp = document.getElementById('commandPaletteInput');
      if (inp) {
        inp.value = 'ASII';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await new Promise(r => setTimeout(r, 600));
    manifest.push(await captureShot(page, '13-fase-7-command-palette-tablet-768x1024.png', 768, 1024));

    await page.evaluate(() => { window.AutoCuanCommandPalette.close(); });
    await new Promise(r => setTimeout(r, 300));

    // 14: Dashboard Market Breadth Tablet
    await showDashboardMarketBreadth(page);
    manifest.push(await captureShot(page, '14-fase-7-dashboard-market-breadth-tablet-768x1024.png', 768, 1024));

    // 15: Smart Broksum Tablet
    await showSmartBroksum(page, 'ASII');
    manifest.push(await captureShot(page, '15-fase-7-smart-broksum-tablet-768x1024.png', 768, 1024));

    // 16: Screener Presets Tablet
    await showScreenerPresets(page, 'big_foreign_inflow');
    manifest.push(await captureShot(page, '16-fase-7-screener-presets-tablet-768x1024.png', 768, 1024));

    // =========================================================================
    // PART 4: MOBILE 390x844
    // =========================================================================
    console.log('\n--- Capturing Mobile 390x844 ---');

    // 17: Command Palette Mobile 390x844
    await page.evaluate(() => {
      window.AutoCuanCommandPalette.open();
      const inp = document.getElementById('commandPaletteInput');
      if (inp) {
        inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await new Promise(r => setTimeout(r, 600));
    manifest.push(await captureShot(page, '17-fase-7-command-palette-mobile-390x844.png', 390, 844));

    await page.evaluate(() => { window.AutoCuanCommandPalette.close(); });
    await new Promise(r => setTimeout(r, 300));

    // 18: Dashboard Market Breadth Mobile 390x844
    await showDashboardMarketBreadth(page);
    manifest.push(await captureShot(page, '18-fase-7-dashboard-market-breadth-mobile-390x844.png', 390, 844));

    // 19: Smart Broksum Mobile 390x844 (ANTM)
    await showSmartBroksum(page, 'ANTM');
    manifest.push(await captureShot(page, '19-fase-7-smart-broksum-mobile-390x844.png', 390, 844));

    // 20: Screener Presets Mobile 390x844
    await showScreenerPresets(page);
    manifest.push(await captureShot(page, '20-fase-7-screener-presets-mobile-390x844.png', 390, 844));

    // =========================================================================
    // PART 5: MOBILE 360x780
    // =========================================================================
    console.log('\n--- Capturing Mobile 360x780 ---');

    // 21: Command Palette Mobile 360x780
    await page.evaluate(() => {
      window.AutoCuanCommandPalette.open();
      const inp = document.getElementById('commandPaletteInput');
      if (inp) {
        inp.value = 'BBRI';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await new Promise(r => setTimeout(r, 600));
    manifest.push(await captureShot(page, '21-fase-7-command-palette-mobile-360x780.png', 360, 780));

    await page.evaluate(() => { window.AutoCuanCommandPalette.close(); });
    await new Promise(r => setTimeout(r, 300));

    // 22: Dashboard Market Breadth Mobile 360x780
    await showDashboardMarketBreadth(page);
    manifest.push(await captureShot(page, '22-fase-7-dashboard-market-breadth-mobile-360x780.png', 360, 780));

    // 23: Smart Broksum Mobile 360x780
    await showSmartBroksum(page, 'BBRI');
    manifest.push(await captureShot(page, '23-fase-7-smart-broksum-mobile-360x780.png', 360, 780));

    // 24: Screener Presets Mobile 360x780
    await showScreenerPresets(page, 'breakout_high_20d');
    manifest.push(await captureShot(page, '24-fase-7-screener-presets-mobile-360x780.png', 360, 780));

    console.log('\n--- Evidence Capture Completed Successfully ---');
    console.log(`Total screenshots: ${manifest.length}`);

    // Verify SHA-256 uniqueness
    const hashes = new Set();
    const duplicates = [];
    manifest.forEach(m => {
      if (hashes.has(m.hash)) {
        duplicates.push(m.filename);
      } else {
        hashes.add(m.hash);
      }
    });

    if (duplicates.length > 0) {
      console.error('ERROR: Duplicate screenshots detected:', duplicates);
      process.exitCode = 1;
    } else {
      console.log('PASS: All 25 screenshots have unique SHA-256 hashes (0 duplicates)!');
    }

    // Save manifest to docs/evidence/fase-7/screenshot-manifest.json
    const manifestDir = path.join(ROOT, 'docs', 'evidence', 'fase-7');
    if (!fs.existsSync(manifestDir)) fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, 'screenshot-manifest.json'), JSON.stringify(manifest, null, 2));

  } finally {
    if (browser) await browser.close();
    if (serverProcess) {
      serverProcess.kill();
    }
  }
}

run().catch((err) => {
  console.error('[Fatal Error]', err);
  process.exit(1);
});
