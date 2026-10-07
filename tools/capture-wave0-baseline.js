'use strict';
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots', 'wave0-baseline');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3037;
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
  console.log('[Wave0-Capture] Starting local-dev-server on port ' + PORT + '...');
  const serverProcess = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });

  let browser;
  try {
    await waitForServer(BASE_URL);
    console.log('[Wave0-Capture] local-dev-server ready at ' + BASE_URL);

    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();

    async function setSession() {
      await page.evaluate(() => {
        localStorage.setItem('autocuan_user', 'budi');
        localStorage.setItem('autocuan_role', 'ADMIN');
        localStorage.setItem('autocuan_session', '{"username":"budi","role":"ADMIN","approved":true}');
        localStorage.setItem('autocuan_logged_in', 'true');
        localStorage.setItem('autocuan_is_admin', 'true');
        localStorage.setItem('autocuan_user_id', 'admin-budi-id');
        localStorage.setItem('autocuan_sidebar_collapsed', '0');
        localStorage.setItem('auto_cuan_onboarding_seen', 'true');
        localStorage.setItem('autocuan_entered_app', 'true');
      });
    }

    async function setupApp() {
      await page.evaluate(async () => {
        const om = document.getElementById('onboardingModal');
        if (om) om.style.display = 'none';
        if (typeof setWorkspaceSidebarVisible === 'function') setWorkspaceSidebarVisible(true);
        if (typeof syncHeaderUsername === 'function') syncHeaderUsername();
        if (typeof loadPremiumAccess === 'function') await loadPremiumAccess(true);
        if (typeof premiumAccessState !== 'undefined') {
          premiumAccessState = { state: 'ready', premium: true, accessLevel: 'approved', checkedAt: Date.now(), expiresAt: null };
        }
        if (typeof applyPremiumAccessUi === 'function') applyPremiumAccessUi();
      });
    }

    async function capture(filename, width, height, setupFn) {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      if (setupFn) await setupFn();
      await new Promise(r => setTimeout(r, 600));
      await page.evaluate(() => {
        const om = document.getElementById('onboardingModal');
        if (om) om.style.display = 'none';
      });
      const targetPath = path.join(SCREENSHOT_DIR, filename);
      await page.screenshot({ path: targetPath, fullPage: false });
      console.log(`[Captured] ${filename} (${width}x${height})`);
    }

    // 1. Landing - Desktop (1440x900)
    await page.goto(BASE_URL, { waitUntil: 'networkidle2' });
    await capture('01-landing-desktop-1440x900.png', 1440, 900);

    // 2. Landing - Mobile (390x844)
    await capture('02-landing-mobile-390x844.png', 390, 844);

    // Log in
    await setSession();
    await page.goto(BASE_URL + '/dashboard', { waitUntil: 'networkidle2' });
    await setupApp();

    // 3. Shell duplicate account controls (1440x900)
    await capture('03-shell-duplicate-account-desktop-1440x900.png', 1440, 900, async () => {
      await page.evaluate(() => {
        if (typeof navigateTo === 'function') navigateTo('dashboard');
      });
    });

    // 4. Dashboard - Desktop (1440x900)
    await capture('04-dashboard-desktop-1440x900.png', 1440, 900);

    // 5. Dashboard - Mobile (390x844)
    await capture('05-dashboard-mobile-390x844.png', 390, 844);

    // 6. Screener - Card-first default / Giant plan view (1440x900)
    await capture('06-screener-card-first-desktop-1440x900.png', 1440, 900, async () => {
      await page.evaluate(() => {
        if (typeof navigateTo === 'function') navigateTo('screener');
      });
    });

    // 7. Screener - Mobile (390x844)
    await capture('07-screener-mobile-390x844.png', 390, 844);

    // 8. Sektor Hot - Desktop (1440x900)
    await capture('08-sektor-hot-desktop-1440x900.png', 1440, 900, async () => {
      await page.evaluate(() => {
        if (typeof navigateTo === 'function') navigateTo('sektor');
      });
    });

    // Navigate to Analisis & wait for partial DOM
    await page.evaluate(() => {
      if (typeof navigateTo === 'function') navigateTo('analisis');
    });
    await page.waitForSelector('#panel-tab-financial', { timeout: 10000 });
    await new Promise(r => setTimeout(r, 600));

    // 9. Financial - Structural plain-text state (1440x900)
    await capture('09-financial-structural-desktop-1440x900.png', 1440, 900, async () => {
      await page.evaluate(() => {
        if (typeof switchAnalisisTab === 'function') switchAnalisisTab('financial');
        if (typeof loadFinancialStructureTab === 'function') loadFinancialStructureTab('financial', 'BBCA');
      });
    });

    // 10. Struktur Pasar - Empty / Ticker-first canvas (1440x900)
    await capture('10-struktur-pasar-empty-ticker-first-desktop-1440x900.png', 1440, 900, async () => {
      await page.evaluate(() => {
        if (typeof switchAnalisisTab === 'function') switchAnalisisTab('market-structure');
      });
    });

    // 11. Bandarmologi - Desktop (1440x900)
    await capture('11-bandarmologi-desktop-1440x900.png', 1440, 900, async () => {
      await page.evaluate(() => {
        if (typeof switchAnalisisTab === 'function') switchAnalisisTab('bandarmologi');
      });
    });

    // 12. Broker Hunter - Desktop (1440x900)
    await capture('12-broker-hunter-desktop-1440x900.png', 1440, 900, async () => {
      await page.evaluate(() => {
        if (typeof switchAnalisisTab === 'function') switchAnalisisTab('hunter');
      });
    });

    // 13. Sinyal Intelijen - Desktop (1440x900)
    await capture('13-sinyal-intelijen-desktop-1440x900.png', 1440, 900, async () => {
      await page.evaluate(() => {
        if (typeof switchAnalisisTab === 'function') switchAnalisisTab('intel');
      });
    });

    // 14. Insider Network - Desktop (1440x900)
    await capture('14-insider-desktop-1440x900.png', 1440, 900, async () => {
      await page.evaluate(() => {
        if (typeof switchAnalisisTab === 'function') switchAnalisisTab('insider');
      });
    });

    // 15. Ranking - Desktop (1440x900)
    await capture('15-ranking-desktop-1440x900.png', 1440, 900, async () => {
      await page.evaluate(() => {
        if (typeof switchAnalisisTab === 'function') switchAnalisisTab('ranking');
      });
    });

    // 16. Ranking - Tablet (768x1024)
    await capture('16-ranking-tablet-768x1024.png', 768, 1024);

    // 17. Track Record - Overflow / Clipping (1440x900)
    await capture('17-track-record-overflow-desktop-1440x900.png', 1440, 900, async () => {
      await page.evaluate(() => {
        if (typeof navigateTo === 'function') navigateTo('trackrecord');
      });
    });

    // 18. Track Record - Mobile Clipping (390x844)
    await capture('18-track-record-mobile-390x844.png', 390, 844);

    console.log('[Wave0-Capture] All Wave 0 baseline screenshots captured successfully.');
  } finally {
    if (browser) await browser.close();
    serverProcess.kill();
  }
}

run().catch((err) => {
  console.error('[Wave0-Capture Error]:', err);
  process.exit(1);
});
