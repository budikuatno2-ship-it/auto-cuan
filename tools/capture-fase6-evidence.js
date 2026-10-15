'use strict';
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const EVIDENCE_DIR = 'D:\\Auto-Cuan\\evidence\\fase-6';
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

async function toggleActiveDrawer(page) {
  return await page.evaluate(() => {
    const chartDiv = document.querySelector('[id^="unifiedchart_"][id$="_container"]');
    if (!chartDiv) return false;
    const chartId = chartDiv.id.replace('_container', '');
    if (window.AutoCuanChartWorkstation && typeof window.AutoCuanChartWorkstation.toggleDrawer === 'function') {
      window.AutoCuanChartWorkstation.toggleDrawer(chartId);
      return true;
    }
    return false;
  });
}

async function switchActiveTimeframe(page, tf) {
  return await page.evaluate(async (targetTf) => {
    const chartDiv = document.querySelector('[id^="unifiedchart_"][id$="_container"]');
    if (!chartDiv) return false;
    const chartId = chartDiv.id.replace('_container', '');
    if (window.AutoCuanChartWorkstation && typeof window.AutoCuanChartWorkstation.switchTimeframe === 'function') {
      await window.AutoCuanChartWorkstation.switchTimeframe(chartId, targetTf);
      return true;
    }
    return false;
  }, tf);
}

async function applyPresetForActiveChart(page, preset) {
  return await page.evaluate((pr) => {
    const chartDiv = document.querySelector('[id^="unifiedchart_"][id$="_container"]');
    if (!chartDiv) return false;
    const chartId = chartDiv.id.replace('_container', '');
    if (window.AutoCuanChartWorkstation && typeof window.AutoCuanChartWorkstation.applyPreset === 'function') {
      window.AutoCuanChartWorkstation.applyPreset(chartId, pr);
      return true;
    }
    return false;
  }, preset);
}

async function switchToTicker(page, ticker, preset = null) {
  console.log(`[SwitchTicker] Switching to ${ticker} (preset: ${preset || 'keep'})...`);
  await page.evaluate(async (tk) => {
    if (window.UnifiedCockpit && typeof window.UnifiedCockpit.syncActiveTicker === 'function') {
      window.UnifiedCockpit.syncActiveTicker(tk, { loadChart: true, forceChartReload: true });
    }
  }, ticker);

  // Wait for canvas header or container to update with new ticker
  await page.waitForFunction((tk) => {
    const chartDiv = document.querySelector('[id^="unifiedchart_"][id$="_container"]');
    if (!chartDiv) return false;
    const chartId = chartDiv.id.replace('_container', '');
    const header = document.getElementById(chartId + '_canvas_header');
    return header && header.innerText.includes(tk);
  }, { timeout: 10000 }, ticker).catch(() => {});

  await new Promise(r => setTimeout(r, 800));

  if (preset) {
    await applyPresetForActiveChart(page, preset);
    await new Promise(r => setTimeout(r, 600));
  }
}

async function run() {
  let serverProcess = null;
  try {
    await waitForServer(BASE_URL, 2000);
    console.log('[Fase-6-Capture] Using existing server at ' + BASE_URL);
  } catch (_) {
    console.log('[Fase-6-Capture] Starting dev server on port ' + PORT + '...');
    serverProcess = spawn('node', ['tools/local-dev-server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'inherit'
    });
    await waitForServer(BASE_URL, 15000);
    console.log('[Fase-6-Capture] Dev server ready at ' + BASE_URL);
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

    // -------------------------------------------------------------
    // PART 1: CHART WORKSTATION IN ANALISIS SAHAM (DESKTOP 1920x1080)
    // -------------------------------------------------------------
    console.log('\n--- PART 1: CHART WORKSTATION DESKTOP (1920x1080) ---');
    await page.goto(`${BASE_URL}/preview/analisis-saham`, { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 1200));

    // Step 1: Click sidebar "Analisis & Chart"
    await page.evaluate(() => {
      const navBtn = document.getElementById('tabAnalisisChart');
      if (navBtn) navBtn.click();
    });
    await new Promise(r => setTimeout(r, 800));

    // Step 2: Click sub-tab "Chart & AI Vision"
    await page.evaluate(() => {
      const chartSubBtn = document.getElementById('tabAnalisisVision');
      if (chartSubBtn) chartSubBtn.click();
    });
    await new Promise(r => setTimeout(r, 2000));

    // Shot 01: BBCA - Preset Simpel
    await switchToTicker(page, 'BBCA', 'simpel');
    manifest.push(await captureShot(page, '01-fase-6-workstation-simpel-1920x1080.png', 1920, 1080));

    // Shot 02: BRPT - Preset Scalping
    await switchToTicker(page, 'BRPT', 'scalping');
    manifest.push(await captureShot(page, '02-fase-6-workstation-scalping-1920x1080.png', 1920, 1080));

    // Shot 03: TLKM - Preset Swing
    await switchToTicker(page, 'TLKM', 'swing');
    manifest.push(await captureShot(page, '03-fase-6-workstation-swing-1920x1080.png', 1920, 1080));

    // Shot 04: BMRI - Preset Investor
    await switchToTicker(page, 'BMRI', 'investor');
    manifest.push(await captureShot(page, '04-fase-6-workstation-investor-1920x1080.png', 1920, 1080));

    // Shot 05: ANTM - Preset Pro
    await switchToTicker(page, 'ANTM', 'pro');
    manifest.push(await captureShot(page, '05-fase-6-workstation-pro-1920x1080.png', 1920, 1080));

    // Shot 06: ANTM - Drawer Mode & Layer Open (9 groups)
    await toggleActiveDrawer(page);
    await new Promise(r => setTimeout(r, 700));
    manifest.push(await captureShot(page, '06-fase-6-workstation-drawer-open-1920x1080.png', 1920, 1080));

    // Close drawer
    await toggleActiveDrawer(page);
    await new Promise(r => setTimeout(r, 400));

    // Shot 07: BBCA - Visual Trading Plan Overlay (Safe R/R >= 1.5)
    await switchToTicker(page, 'BBCA', 'swing');
    manifest.push(await captureShot(page, '07-fase-6-trading-plan-visual-1920x1080.png', 1920, 1080));

    // Shot 08: BBCA - Visual Trading Plan Warning (R/R < 1.5 Strict Warning)
    await page.evaluate(() => {
      const chartDiv = document.querySelector('[id^="unifiedchart_"][id$="_container"]');
      if (chartDiv) {
        const chartId = chartDiv.id.replace('_container', '');
        const inst = window.AutoCuanChartWorkstation.getOrCreateInstance(chartId);
        if (inst) {
          inst.state.customTradingPlan = { forceUnsafeRR: true };
          window.AutoCuanChartWorkstation.toggleLayer(chartId, 'trading_plan', true);
        }
      }
      const planCard = document.querySelector('.chart-plan-backtest-card');
      if (planCard) {
        planCard.scrollIntoView({ behavior: 'instant', block: 'center' });
      }
    });
    await new Promise(r => setTimeout(r, 800));
    manifest.push(await captureShot(page, '08-fase-6-trading-plan-warning-1920x1080.png', 1920, 1080, { preserveScroll: true }));

    // Reset plan and scroll to top
    await page.evaluate(() => {
      const chartDiv = document.querySelector('[id^="unifiedchart_"][id$="_container"]');
      if (chartDiv) {
        const chartId = chartDiv.id.replace('_container', '');
        const inst = window.AutoCuanChartWorkstation.getOrCreateInstance(chartId);
        if (inst) {
          inst.state.customTradingPlan = null;
          window.AutoCuanChartWorkstation.toggleLayer(chartId, 'trading_plan', true);
        }
      }
      window.scrollTo(0, 0);
    });
    await new Promise(r => setTimeout(r, 400));

    // Shot 09 & 10: Multi-Timeframe 1D Harian vs 1W Mingguan (BBCA)
    console.log('\n--- PART 2: MULTI-TIMEFRAME (1D vs 1W) ---');
    await switchToTicker(page, 'BBCA', 'simpel');
    await switchActiveTimeframe(page, '1D');
    await new Promise(r => setTimeout(r, 800));
    manifest.push(await captureShot(page, '09-fase-6-multi-timeframe-1d-1920x1080.png', 1920, 1080));

    await switchActiveTimeframe(page, '1W');
    await new Promise(r => setTimeout(r, 800));
    manifest.push(await captureShot(page, '10-fase-6-multi-timeframe-1w-1920x1080.png', 1920, 1080));

    // Switch back to 1D
    await switchActiveTimeframe(page, '1D');
    await new Promise(r => setTimeout(r, 500));

    // Shot 11: BRPT - Bandar Metrics Overlays + Sub-panel Active
    console.log('\n--- PART 2b: BRPT BANDAR METRICS OVERLAYS & SUB-PANELS ---');
    await switchToTicker(page, 'BRPT', 'pro');
    manifest.push(await captureShot(page, '11-fase-6-bandar-metrics-overlays-1920x1080.png', 1920, 1080));

    // -------------------------------------------------------------
    // PART 2: DESKTOP 1366x768 & TABLET 768x1024
    // -------------------------------------------------------------
    console.log('\n--- PART 3: LAPTOP 1366x768 & TABLET 768x1024 ---');
    // Shot 12: BBCA Simpel 1366x768
    await switchToTicker(page, 'BBCA', 'simpel');
    manifest.push(await captureShot(page, '12-fase-6-workstation-simpel-1366x768.png', 1366, 768));

    // Shot 13: BRPT Pro 1366x768
    await switchToTicker(page, 'BRPT', 'pro');
    manifest.push(await captureShot(page, '13-fase-6-workstation-pro-1366x768.png', 1366, 768));

    // Shot 14: BRPT Drawer Open 1366x768
    await toggleActiveDrawer(page);
    await new Promise(r => setTimeout(r, 600));
    manifest.push(await captureShot(page, '14-fase-6-workstation-drawer-1366x768.png', 1366, 768));

    // Close drawer
    await toggleActiveDrawer(page);
    await new Promise(r => setTimeout(r, 400));

    // Shot 15: TLKM Trading Plan 1366x768
    await switchToTicker(page, 'TLKM', 'swing');
    manifest.push(await captureShot(page, '15-fase-6-trading-plan-1366x768.png', 1366, 768));

    // Shot 16: BMRI Tablet 768x1024
    await switchToTicker(page, 'BMRI', 'simpel');
    manifest.push(await captureShot(page, '16-fase-6-workstation-tablet-768x1024.png', 768, 1024));

    // Shot 17: BMRI Drawer Tablet 768x1024
    await toggleActiveDrawer(page);
    await new Promise(r => setTimeout(r, 600));
    manifest.push(await captureShot(page, '17-fase-6-workstation-drawer-tablet-768x1024.png', 768, 1024));

    // Close drawer
    await toggleActiveDrawer(page);
    await new Promise(r => setTimeout(r, 400));

    // Shot 18: ANTM Trading Plan Tablet 768x1024
    await switchToTicker(page, 'ANTM', 'swing');
    manifest.push(await captureShot(page, '18-fase-6-trading-plan-tablet-768x1024.png', 768, 1024));

    // -------------------------------------------------------------
    // PART 3: MOBILE 390x844 & 360x780
    // -------------------------------------------------------------
    console.log('\n--- PART 4: MOBILE 390x844 & 360x780 ---');
    // Shot 19: BBCA Mobile 390x844 Simpel (Centered on chart container)
    await switchToTicker(page, 'BBCA', 'simpel');
    await page.evaluate(() => {
      const el = document.getElementById('unifiedChartContainer');
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
    });
    await new Promise(r => setTimeout(r, 600));
    manifest.push(await captureShot(page, '19-fase-6-workstation-mobile-390x844.png', 390, 844, { preserveScroll: true }));

    // Shot 20: BBCA Mobile 390x844 Drawer Open
    await toggleActiveDrawer(page);
    await page.evaluate(() => {
      const chartDiv = document.querySelector('[id^="unifiedchart_"][id$="_container"]');
      const chartId = chartDiv ? chartDiv.id.replace('_container', '') : '';
      const drawer = document.getElementById(chartId + '_drawer');
      if (drawer) drawer.scrollIntoView({ behavior: 'instant', block: 'start' });
    });
    await new Promise(r => setTimeout(r, 600));
    manifest.push(await captureShot(page, '20-fase-6-workstation-drawer-mobile-390x844.png', 390, 844, { preserveScroll: true }));

    // Close drawer
    await toggleActiveDrawer(page);
    await new Promise(r => setTimeout(r, 400));

    // Shot 21: BRPT Mobile 390x844 Trading Plan
    await switchToTicker(page, 'BRPT', 'swing');
    await page.evaluate(() => {
      const el = document.getElementById('unifiedChartContainer');
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
    });
    await new Promise(r => setTimeout(r, 600));
    manifest.push(await captureShot(page, '21-fase-6-trading-plan-mobile-390x844.png', 390, 844, { preserveScroll: true }));

    // Shot 22: TLKM Mobile 360x780 Scalping
    await switchToTicker(page, 'TLKM', 'scalping');
    await page.evaluate(() => {
      const el = document.getElementById('unifiedChartContainer');
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
    });
    await new Promise(r => setTimeout(r, 600));
    manifest.push(await captureShot(page, '22-fase-6-workstation-mobile-360x780.png', 360, 780, { preserveScroll: true }));

    // Shot 23: ANTM Mobile 360x780 Trading Plan
    await switchToTicker(page, 'ANTM', 'swing');
    await page.evaluate(() => {
      const el = document.getElementById('unifiedChartContainer');
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
    });
    await new Promise(r => setTimeout(r, 600));
    manifest.push(await captureShot(page, '23-fase-6-trading-plan-mobile-360x780.png', 360, 780, { preserveScroll: true }));

    // -------------------------------------------------------------
    // PART 4: SPIKE 6D STRESS TEST POC (/preview/chart-poc)
    // -------------------------------------------------------------
    console.log('\n--- PART 5: SPIKE 6D STRESS TEST POC (/preview/chart-poc) ---');
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.goto(`${BASE_URL}/preview/chart-poc`, { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 1500));

    // Shot 24: Spike POC 500 Candles
    await page.evaluate(() => {
      if (typeof window.loadCandleSet === 'function') {
        window.loadCandleSet(500);
      }
    });
    await new Promise(r => setTimeout(r, 800));
    manifest.push(await captureShot(page, '24-fase-6-spike-poc-500-candles-1920x1080.png', 1920, 1080));

    // Shot 25: Spike POC 2.000 Candles Stress Test
    await page.evaluate(() => {
      if (typeof window.loadCandleSet === 'function') {
        window.loadCandleSet(2000);
      }
    });
    await new Promise(r => setTimeout(r, 1200));
    manifest.push(await captureShot(page, '25-fase-6-spike-poc-2000-candles-1920x1080.png', 1920, 1080));

    // Shot 26: Spike POC 50x Switch Pass
    await page.evaluate(async () => {
      if (typeof window.run50xLayerSwitch === 'function') {
        await window.run50xLayerSwitch();
      }
    });
    await new Promise(r => setTimeout(r, 1200));
    manifest.push(await captureShot(page, '26-fase-6-spike-poc-50x-switch-pass-1920x1080.png', 1920, 1080));

    console.log('\n=== SELESAI MENANGKAP ' + manifest.length + ' SCREENSHOT BUKTI FASE 6 ===');

    // Verify SHA-256 uniqueness across all 26 captures
    const hashes = new Map();
    const duplicates = [];
    manifest.forEach(item => {
      if (hashes.has(item.hash)) {
        duplicates.push({
          duplicate: item.filename,
          original: hashes.get(item.hash),
          hash: item.hash
        });
      } else {
        hashes.set(item.hash, item.filename);
      }
    });

    if (duplicates.length > 0) {
      console.error('\n[FATAL ERROR] Ditemukan hash screenshot duplikat!');
      duplicates.forEach(d => console.error(`  - Duplikat: ${d.duplicate} identik dengan ${d.original} (${d.hash})`));
      throw new Error(`Terdapat ${duplicates.length} screenshot kembar identik yang terdeteksi!`);
    } else {
      console.log(`\n[VERIFIKASI LOLOS] Semua ${manifest.length} screenshot memiliki SHA-256 unik (0 duplikat)!`);
    }

    fs.writeFileSync(path.join(ROOT, 'docs', 'evidence', 'fase-6', 'screenshot-manifest.json'), JSON.stringify(manifest, null, 2));

  } finally {
    if (browser) await browser.close();
    if (serverProcess) {
      serverProcess.kill('SIGINT');
      console.log('[Fase-6-Capture] Dev server stopped.');
    }
  }
}

run().catch(err => {
  console.error('[Fase-6-Capture] Fatal Error:', err);
  process.exit(1);
});
