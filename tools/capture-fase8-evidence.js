'use strict';
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const EVIDENCE_DIR = 'D:\\Auto-Cuan\\evidence\\fase-8';
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

async function main() {
  console.log('[Fase 8 Capture] Starting local server test...');
  let serverProc = null;

  try {
    await waitForServer(`${BASE_URL}/`, 1000);
    console.log('[Fase 8 Capture] Local server already running on port ' + PORT);
  } catch (_) {
    console.log('[Fase 8 Capture] Spawning tools/local-dev-server.js...');
    serverProc = spawn(process.execPath, [path.join(ROOT, 'tools', 'local-dev-server.js')], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'ignore'
    });
    await waitForServer(`${BASE_URL}/`, 8000);
    console.log('[Fase 8 Capture] Server started successfully.');
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  });

  const page = await browser.newPage();
  await page.goto(`${BASE_URL}/index.html`, { waitUntil: 'networkidle2', timeout: 30000 });

  // Authenticate as Pro Admin
  await page.evaluate(() => {
    localStorage.setItem('autocuan_auth_user', JSON.stringify({
      id: 'usr_admin_budi',
      name: 'budi',
      username: 'budi',
      tier: 'pro',
      role: 'admin',
      is_admin: true,
      has_access: true,
      email: 'budi@autocuan.id'
    }));
    sessionStorage.setItem('activeTicker', 'BBCA');
    if (typeof window.enterApp === 'function') {
      window.enterApp();
    }
  });
  await new Promise(r => setTimeout(r, 1200));

  const results = [];

  // ==========================================
  // VIEWPORT 1: Desktop 1920x1080 (Shots 01 - 02, 07 - 17, 19)
  // ==========================================
  console.log('\n--- VIEWPORT 1920x1080 ---');

  // Shot 01: Sidebar Expanded Desktop (with hover on Analisis & Chart)
  await page.evaluate(() => {
    document.body.classList.remove('sidebar-collapsed');
    const sb = document.getElementById('appSidebar');
    if (sb) {
      sb.classList.remove('hidden', 'is-collapsed', 'collapsed');
    }
    if (typeof window.navigateTo === 'function') window.navigateTo('dashboard');
    const item = document.getElementById('tabAnalisisChart');
    if (item) item.classList.add('is-hover');
  });
  await new Promise(r => setTimeout(r, 800));
  results.push(await captureShot(page, '01-fase-8-sidebar-expanded-desktop-1920x1080.png', 1920, 1080));

  // Shot 02: Sidebar Collapsed Desktop (72px rail mode)
  await page.evaluate(() => {
    const item = document.getElementById('tabAnalisisChart');
    if (item) item.classList.remove('is-hover');
    document.body.classList.add('sidebar-collapsed');
    const sb = document.getElementById('appSidebar');
    if (sb) {
      sb.classList.add('is-collapsed', 'collapsed');
    }
  });
  await new Promise(r => setTimeout(r, 800));
  results.push(await captureShot(page, '02-fase-8-sidebar-collapsed-desktop-1920x1080.png', 1920, 1080));

  // Restore sidebar expanded
  await page.evaluate(() => {
    document.body.classList.remove('sidebar-collapsed');
    const sb = document.getElementById('appSidebar');
    if (sb) {
      sb.classList.remove('is-collapsed', 'collapsed');
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // Shot 07: Dashboard Full View with Market Breadth scrolled to stats
  await page.evaluate(() => {
    if (typeof window.navigateTo === 'function') window.navigateTo('dashboard');
    window.scrollTo(0, 180);
    document.documentElement.scrollTop = 180;
    const app = document.getElementById('appContent');
    if (app) app.scrollTop = 180;
  });
  await new Promise(r => setTimeout(r, 1200));
  results.push(await captureShot(page, '07-fase-8-dashboard-market-breadth-1920x1080.png', 1920, 1080, { preserveScroll: true }));

  // Shot 08: Screener Full View with 8 Presets
  await page.evaluate(async () => {
    if (typeof window.navigateTo === 'function') window.navigateTo('screener');
    if (window.AutoCuanMarketIntelligence) {
      window.AutoCuanMarketIntelligence.closePopovers();
      await window.AutoCuanMarketIntelligence.render8ScreenerPresets('screenerPresetsContainer');
    }
  });
  await page.waitForFunction(() => {
    const el = document.querySelector('.ac-presets-container');
    return el && el.querySelectorAll('.ac-preset-btn').length >= 8;
  }, { timeout: 15000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 800));
  results.push(await captureShot(page, '08-fase-8-screener-presets-bandar-metrics-1920x1080.png', 1920, 1080));

  // Shot 09: Screener with Preset Popover Info Open
  await page.evaluate(() => {
    if (window.AutoCuanMarketIntelligence) {
      window.AutoCuanMarketIntelligence.togglePopover('silent_accumulation');
    }
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('popover_silent_accumulation');
    return el && el.style.display === 'block';
  }, { timeout: 10000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 800));
  results.push(await captureShot(page, '09-fase-8-screener-preset-popover-info-1920x1080.png', 1920, 1080));

  // Close popover before proceeding
  await page.evaluate(() => {
    if (window.AutoCuanMarketIntelligence) {
      window.AutoCuanMarketIntelligence.closePopovers();
    }
  });

  // Shot 10: Analisis & Chart Workstation (BBCA)
  await page.evaluate(async () => {
    if (typeof window.navigateTo === 'function') window.navigateTo('analisis', 'analisis-chart');
    if (window.UnifiedCockpit && typeof window.UnifiedCockpit.syncActiveTicker === 'function') {
      await window.UnifiedCockpit.syncActiveTicker('BBCA', { loadChart: true, forceChartReload: true });
    }
  });
  await new Promise(r => setTimeout(r, 2000));
  results.push(await captureShot(page, '10-fase-8-analisis-chart-workstation-1920x1080.png', 1920, 1080));

  // Shot 11: Chart Workstation for BRPT
  await page.evaluate(async () => {
    if (window.UnifiedCockpit && typeof window.UnifiedCockpit.syncActiveTicker === 'function') {
      await window.UnifiedCockpit.syncActiveTicker('BRPT', { loadChart: true, forceChartReload: true });
    }
  });
  await page.waitForFunction(() => {
    const header = document.querySelector('.unified-cockpit-header');
    return header && header.innerText.includes('BRPT');
  }, { timeout: 10000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));
  results.push(await captureShot(page, '11-fase-8-chart-workstation-brpt-1920x1080.png', 1920, 1080));

  // Switch back to BBCA
  await page.evaluate(async () => {
    if (window.UnifiedCockpit && typeof window.UnifiedCockpit.syncActiveTicker === 'function') {
      await window.UnifiedCockpit.syncActiveTicker('BBCA', { loadChart: true, forceChartReload: true });
    }
  });
  await new Promise(r => setTimeout(r, 1000));

  // Shot 12: Bandarmologi with 2-Column Smart Broker Summary
  await page.evaluate(() => {
    if (typeof window.navigateTo === 'function') window.navigateTo('analisis', 'bandarmologi');
  });
  await new Promise(r => setTimeout(r, 1500));
  results.push(await captureShot(page, '12-fase-8-bandarmologi-smart-broksum-1920x1080.png', 1920, 1080));

  // Shot 13: Financial Statements
  await page.evaluate(() => {
    if (typeof window.navigateTo === 'function') window.navigateTo('analisis', 'financial');
  });
  await new Promise(r => setTimeout(r, 1500));
  results.push(await captureShot(page, '13-fase-8-financial-statements-audit-1920x1080.png', 1920, 1080));

  // Shot 14: Struktur Pasar
  await page.evaluate(() => {
    if (typeof window.navigateTo === 'function') window.navigateTo('analisis', 'market-structure');
  });
  await new Promise(r => setTimeout(r, 1500));
  results.push(await captureShot(page, '14-fase-8-struktur-pasar-clean-1920x1080.png', 1920, 1080));

  // Shot 15: Portfolio Scenarios
  await page.evaluate(() => {
    if (typeof window.navigateTo === 'function') window.navigateTo('portofolio');
  });
  await new Promise(r => setTimeout(r, 1500));
  results.push(await captureShot(page, '15-fase-8-portfolio-scenario-sim-1920x1080.png', 1920, 1080));

  // Shot 16: Track Record
  await page.evaluate(() => {
    if (typeof window.navigateTo === 'function') window.navigateTo('trackrecord');
  });
  await new Promise(r => setTimeout(r, 1500));
  results.push(await captureShot(page, '16-fase-8-track-record-wib-1920x1080.png', 1920, 1080));

  // Shot 17: Command Palette Global Search Modal
  await page.evaluate(() => {
    if (window.AutoCuanCommandPalette && typeof window.AutoCuanCommandPalette.open === 'function') {
      window.AutoCuanCommandPalette.open();
    }
  });
  await new Promise(r => setTimeout(r, 800));
  results.push(await captureShot(page, '17-fase-8-command-palette-search-1920x1080.png', 1920, 1080));

  // Close command palette
  await page.evaluate(() => {
    if (window.AutoCuanCommandPalette && typeof window.AutoCuanCommandPalette.close === 'function') {
      window.AutoCuanCommandPalette.close();
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // Shot 19: VIP Account Center Dialog
  await page.evaluate(() => {
    if (typeof window.openSubscriptionModal === 'function') {
      window.openSubscriptionModal();
    } else if (typeof window.openAccountProfile === 'function') {
      window.openAccountProfile();
    }
  });
  await new Promise(r => setTimeout(r, 800));
  results.push(await captureShot(page, '19-fase-8-vip-account-center-1920x1080.png', 1920, 1080));

  // Close modals
  await page.evaluate(() => {
    const sm = document.getElementById('subscriptionModal');
    if (sm) sm.classList.add('hidden');
    const ap = document.getElementById('accountProfileModal');
    if (ap) ap.classList.add('hidden');
  });
  await new Promise(r => setTimeout(r, 500));

  // ==========================================
  // VIEWPORT 2: Laptop 1366x768 (Shots 03, 20, 21, 22)
  // ==========================================
  console.log('\n--- VIEWPORT 1366x768 ---');

  // Shot 03: Sidebar on 1366x768 laptop
  await page.evaluate(() => {
    if (typeof window.navigateTo === 'function') window.navigateTo('dashboard');
    const app = document.getElementById('appContent');
    if (app) app.scrollTop = 0;
    const it = document.getElementById('tabFinancial');
    if (it) it.classList.add('is-hover');
  });
  await new Promise(r => setTimeout(r, 800));
  results.push(await captureShot(page, '03-fase-8-sidebar-laptop-1366x768.png', 1366, 768));

  // Shot 20: Dashboard Laptop Scrolled Deep to Market Breadth and Top 5 Radar
  await page.evaluate(() => {
    const it = document.getElementById('tabFinancial');
    if (it) it.classList.remove('is-hover');
    window.scrollTo(0, 520);
    document.documentElement.scrollTop = 520;
    document.body.scrollTop = 520;
    const app = document.getElementById('appContent');
    if (app) app.scrollTop = 520;
  });
  await new Promise(r => setTimeout(r, 800));
  results.push(await captureShot(page, '20-fase-8-dashboard-laptop-1366x768.png', 1366, 768, { preserveScroll: true }));

  // Shot 21: Screener Laptop
  await page.evaluate(() => {
    if (typeof window.navigateTo === 'function') window.navigateTo('screener');
  });
  await new Promise(r => setTimeout(r, 1200));
  results.push(await captureShot(page, '21-fase-8-screener-laptop-1366x768.png', 1366, 768));

  // Shot 22: Analisis & Chart Laptop
  await page.evaluate(() => {
    if (typeof window.navigateTo === 'function') window.navigateTo('analisis', 'analisis-chart');
  });
  await new Promise(r => setTimeout(r, 1500));
  results.push(await captureShot(page, '22-fase-8-analisis-laptop-1366x768.png', 1366, 768));

  // ==========================================
  // VIEWPORT 3: Tablet 768x1024 (Shots 04, 23)
  // ==========================================
  console.log('\n--- VIEWPORT 768x1024 ---');

  // Shot 04: Sidebar Tablet Drawer
  await page.evaluate(() => {
    const sb = document.getElementById('appSidebar');
    if (sb) {
      sb.classList.remove('hidden');
      sb.classList.add('mobile-open');
    }
    document.documentElement.classList.add('workspace-menu-open');
  });
  await new Promise(r => setTimeout(r, 800));
  results.push(await captureShot(page, '04-fase-8-sidebar-tablet-drawer-768x1024.png', 768, 1024));

  // Close tablet drawer & capture Dashboard Tablet
  await page.evaluate(() => {
    const sb = document.getElementById('appSidebar');
    if (sb) sb.classList.remove('mobile-open');
    document.documentElement.classList.remove('workspace-menu-open');
    if (typeof window.navigateTo === 'function') window.navigateTo('dashboard');
  });
  await new Promise(r => setTimeout(r, 1000));
  results.push(await captureShot(page, '23-fase-8-dashboard-tablet-768x1024.png', 768, 1024));

  // ==========================================
  // VIEWPORT 4: Mobile 390x844 (Shots 05, 18, 24)
  // ==========================================
  console.log('\n--- VIEWPORT 390x844 ---');

  // Shot 05: Sidebar Mobile Open
  await page.evaluate(() => {
    const sb = document.getElementById('appSidebar');
    if (sb) {
      sb.classList.remove('hidden');
      sb.classList.add('mobile-open');
    }
    document.documentElement.classList.add('workspace-menu-open');
  });
  await new Promise(r => setTimeout(r, 800));
  results.push(await captureShot(page, '05-fase-8-sidebar-mobile-open-390x844.png', 390, 844));

  // Close drawer
  await page.evaluate(() => {
    const sb = document.getElementById('appSidebar');
    if (sb) sb.classList.remove('mobile-open');
    document.documentElement.classList.remove('workspace-menu-open');
  });
  await new Promise(r => setTimeout(r, 500));

  // Shot 18: Command Palette on Mobile 390x844
  await page.evaluate(() => {
    if (window.AutoCuanCommandPalette && typeof window.AutoCuanCommandPalette.open === 'function') {
      window.AutoCuanCommandPalette.open();
    }
  });
  await new Promise(r => setTimeout(r, 800));
  results.push(await captureShot(page, '18-fase-8-command-palette-mobile-390x844.png', 390, 844));

  // Close command palette
  await page.evaluate(() => {
    if (window.AutoCuanCommandPalette && typeof window.AutoCuanCommandPalette.close === 'function') {
      window.AutoCuanCommandPalette.close();
    }
    if (typeof window.navigateTo === 'function') window.navigateTo('dashboard');
  });
  await new Promise(r => setTimeout(r, 800));

  // Shot 24: Dashboard Mobile 390x844
  results.push(await captureShot(page, '24-fase-8-dashboard-mobile-390x844.png', 390, 844));

  // ==========================================
  // VIEWPORT 5: Mobile Small 360x780 (Shots 06, 25)
  // ==========================================
  console.log('\n--- VIEWPORT 360x780 ---');

  // Shot 06: Sidebar Mobile Small 360x780 Open
  await page.evaluate(() => {
    const sb = document.getElementById('appSidebar');
    if (sb) {
      sb.classList.remove('hidden');
      sb.classList.add('mobile-open');
    }
    document.documentElement.classList.add('workspace-menu-open');
  });
  await new Promise(r => setTimeout(r, 800));
  results.push(await captureShot(page, '06-fase-8-sidebar-mobile-compact-360x780.png', 360, 780));

  // Close drawer and capture Dashboard Mobile 360x780
  await page.evaluate(() => {
    const sb = document.getElementById('appSidebar');
    if (sb) sb.classList.remove('mobile-open');
    document.documentElement.classList.remove('workspace-menu-open');
    if (typeof window.navigateTo === 'function') window.navigateTo('dashboard');
  });
  await new Promise(r => setTimeout(r, 1000));
  results.push(await captureShot(page, '25-fase-8-dashboard-mobile-360x780.png', 360, 780));

  await browser.close();
  if (serverProc) {
    serverProc.kill();
  }

  // Verify unique hashes
  const hashes = new Set(results.map(r => r.hash));
  console.log(`\n[Fase 8 Summary] Total screenshots: ${results.length}, Unique SHA-256: ${hashes.size}`);
  if (hashes.size !== results.length) {
    console.error('[WARNING] Some screenshots have duplicate hashes!');
    const seen = new Map();
    for (const r of results) {
      if (seen.has(r.hash)) {
        console.error(`Duplicate pair: ${seen.get(r.hash)} and ${r.filename}`);
      } else {
        seen.set(r.hash, r.filename);
      }
    }
  } else {
    console.log('[SUCCESS] All 25 screenshots have 100% UNIQUE SHA-256 hashes!');
  }

  // Save manifest
  const manifestPath = path.join(ROOT, 'docs', 'evidence', 'fase-8', 'screenshot-manifest.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({
    phase: 'Fase 8 - Final UI/UX Polish & Workspace Validation',
    totalScreenshots: results.length,
    uniqueHashes: hashes.size,
    capturedAt: new Date().toISOString(),
    screenshots: results
  }, null, 2));

  console.log('[Manifest written] ' + manifestPath);
}

main().catch(err => {
  console.error('[Error in capture]', err);
  process.exit(1);
});
