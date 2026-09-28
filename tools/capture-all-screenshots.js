'use strict';
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3035;
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
      }).on('error', (err) => {
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
  console.log('[Puppeteer] Launching local-dev-server on port ' + PORT + '...');
  const serverProcess = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });

  try {
    await waitForServer(BASE_URL);
    console.log('[Puppeteer] local-dev-server ready at ' + BASE_URL);

    console.log('[Puppeteer] Launching Chrome from ' + CHROME_PATH);
    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    page.on('console', msg => {
      const txt = msg.text();
      const lower = txt.toLowerCase();
      if (msg.type() === 'error' || lower.includes('error') || lower.includes('portfolio') || lower.includes('spa') || lower.includes('access')) {
        console.log(`[Browser ${msg.type()}]`, txt);
      }
    });
    page.on('pageerror', err => console.log('[Browser Uncaught Error]', err.message));

    const shots = [];

    async function takeShot(filename, description) {
      await page.evaluate(() => {
        const om = document.getElementById('onboardingModal');
        if (om) om.style.display = 'none';
      });
      const fullPath = path.join(SCREENSHOT_DIR, filename);
      await new Promise(r => setTimeout(r, 600));
      await page.screenshot({ path: fullPath, fullPage: false });
      console.log(`[Screenshot ${shots.length + 1}] Captured: ${filename} (${description})`);
      shots.push({ filename, description, path: fullPath });
    }

    // 1. Landing Page - Dark mode
    await page.goto(BASE_URL, { waitUntil: 'networkidle2' });
    await takeShot('01-landing-dark.png', 'Landing Page — Dark mode');

    // 2. Landing Page - Light mode
    await page.evaluate(() => {
      if (typeof toggleAppTheme === 'function') toggleAppTheme();
    });
    await takeShot('02-landing-light.png', 'Landing Page — Light mode');

    // Toggle back to dark mode
    await page.evaluate(() => {
      if (typeof toggleAppTheme === 'function') toggleAppTheme();
    });

    // 3. Landing Page - Features section with scroll reveal
    await page.evaluate(() => {
      const el = document.getElementById('landingFeatures');
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
    });
    await new Promise(r => setTimeout(r, 600));
    await takeShot('03-landing-features.png', 'Landing Page — Features with scroll reveal');

    // 4. Landing Page - Schedule & Safety section (no dead space)
    await page.evaluate(() => {
      const el = document.getElementById('landingSchedule') || document.getElementById('landingSafety');
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
    });
    await takeShot('04-landing-schedule-safety.png', 'Landing Page — Schedule & Safety');

    // ===== LOG IN AS ADMIN FOR APP WORKSPACE =====
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

    await page.goto(BASE_URL + '/dashboard', { waitUntil: 'networkidle2' });
    await page.evaluate(async () => {
      localStorage.setItem('auto_cuan_onboarding_seen', 'true');
      localStorage.setItem('autocuan_entered_app', 'true');
      const om = document.getElementById('onboardingModal');
      if (om) om.style.display = 'none';
      if (typeof setWorkspaceSidebarVisible === 'function') setWorkspaceSidebarVisible(true);
      if (typeof syncHeaderUsername === 'function') syncHeaderUsername();
      if (typeof loadPremiumAccess === 'function') await loadPremiumAccess(true);
      if (typeof premiumAccessState !== 'undefined') {
        premiumAccessState = { state: 'ready', premium: true, accessLevel: 'approved', checkedAt: Date.now(), expiresAt: null };
      }
      if (typeof applyPremiumAccessUi === 'function') applyPremiumAccessUi();
      if (typeof navigateTo === 'function') navigateTo('dashboard');
    });
    await new Promise(r => setTimeout(r, 800));

    // 5. Dashboard — Dark mode, sidebar expanded (240px)
    await takeShot('05-dashboard-dark-expanded.png', 'Dashboard — Dark mode, sidebar expanded (240px)');

    // 6. Dashboard — Dark mode, sidebar collapsed (72px)
    await page.evaluate(() => {
      if (typeof applySidebarCollapse === 'function') applySidebarCollapse(true);
    });
    await takeShot('06-dashboard-dark-collapsed.png', 'Dashboard — Dark mode, sidebar collapsed (72px)');

    // 7. Dashboard — Light mode
    await page.evaluate(() => {
      if (typeof applySidebarCollapse === 'function') applySidebarCollapse(false);
      if (typeof toggleAppTheme === 'function') toggleAppTheme();
    });
    await takeShot('07-dashboard-light.png', 'Dashboard — Light mode (WCAG AA contrast)');

    // Toggle back to dark mode
    await page.evaluate(() => {
      if (typeof toggleAppTheme === 'function') toggleAppTheme();
    });

    // ===== ANALISIS SAHAM SUB-TABS =====
    await page.evaluate(() => {
      navigateTo('analisis', 'analisis-chart');
    });
    await new Promise(r => setTimeout(r, 1000));

    // 8. Analisis Saham — Sub-tab 1: Analisis & Chart (Unified Cockpit)
    await takeShot('08-analisis-subtab1-cockpit.png', 'Analisis Saham — Sub-tab 1: Analisis & Chart (Unified Cockpit)');

    // 9. Analisis Saham — Sub-tab 2: Bandarmologi
    await page.evaluate(() => {
      if (typeof switchAnalisisTab === 'function') switchAnalisisTab('bandarmologi');
    });
    await takeShot('09-analisis-subtab2-bandarmologi.png', 'Analisis Saham — Sub-tab 2: Bandarmologi');

    // 10. Analisis Saham — Sub-tab 3: Sinyal Intelijen
    await page.evaluate(() => {
      if (typeof switchAnalisisTab === 'function') switchAnalisisTab('intel');
    });
    await takeShot('10-analisis-subtab3-intel.png', 'Analisis Saham — Sub-tab 3: Sinyal Intelijen');

    // 11. Analisis Saham — Sub-tab 4: Broker Hunter
    await page.evaluate(() => {
      if (typeof switchAnalisisTab === 'function') switchAnalisisTab('hunter');
    });
    await takeShot('11-analisis-subtab4-hunter.png', 'Analisis Saham — Sub-tab 4: Broker Hunter');

    // 12. Analisis Saham — Sub-tab 5: Jejaring Insider
    await page.evaluate(() => {
      if (typeof switchAnalisisTab === 'function') switchAnalisisTab('insider');
    });
    await takeShot('12-analisis-subtab5-insider.png', 'Analisis Saham — Sub-tab 5: Jejaring Insider');

    // 13. Analisis Saham — Sub-tab 6: Ranking Harian (spreadsheet-grade table)
    await page.evaluate(() => {
      if (typeof switchAnalisisTab === 'function') switchAnalisisTab('ranking');
    });
    await takeShot('13-analisis-subtab6-ranking.png', 'Analisis Saham — Sub-tab 6: Ranking Harian');

    // 14. Analisis Saham — Sub-tab 7: Pattern Radar
    await page.evaluate(() => {
      if (typeof switchAnalisisTab === 'function') switchAnalisisTab('pattern');
    });
    await takeShot('14-analisis-subtab7-pattern.png', 'Analisis Saham — Sub-tab 7: Pattern Radar');

    // ===== PORTOFOLIO SUB-TABS =====
    await page.evaluate(() => {
      if (typeof premiumAccessState !== 'undefined') {
        premiumAccessState = { state: 'ready', premium: true, accessLevel: 'approved', checkedAt: Date.now(), expiresAt: null };
      }
      if (typeof applyPremiumAccessUi === 'function') applyPremiumAccessUi();
      navigateTo('portofolio', 'today');
    });
    await page.waitForFunction(() => {
      const gate = document.getElementById('accessGate');
      const app = document.getElementById('app');
      return (app && !app.classList.contains('hidden')) || (gate && gate.classList.contains('hidden'));
    }, { timeout: 6000 }).catch(e => console.log('[Wait Portfolio Warning]:', e.message));
    await page.evaluate(() => {
      if (typeof openPortfolioTab === 'function') openPortfolioTab('today');
    });
    await new Promise(r => setTimeout(r, 600));

    // 15. Portofolio — Sub-tab 1: Hari Ini
    await takeShot('15-portofolio-subtab1-today.png', 'Portofolio — Sub-tab 1: Hari Ini');

    // 16. Portofolio — Sub-tab 2: Rencana Posisi (Planner)
    await page.evaluate(() => {
      if (typeof openPortfolioTab === 'function') openPortfolioTab('planner');
    });
    await takeShot('16-portofolio-subtab2-planner.png', 'Portofolio — Sub-tab 2: Rencana Posisi');

    // 17. Portofolio — Sub-tab 3: Pantauan (Watchlist)
    await page.evaluate(() => {
      if (typeof openPortfolioTab === 'function') openPortfolioTab('watch');
    });
    await takeShot('17-portofolio-subtab3-watch.png', 'Portofolio — Sub-tab 3: Pantauan');

    // 18. Portofolio — Sub-tab 4: Risiko & Avg Down
    await page.evaluate(() => {
      if (typeof openPortfolioTab === 'function') openPortfolioTab('risk');
    });
    await takeShot('18-portofolio-subtab4-risk.png', 'Portofolio — Sub-tab 4: Risiko & Avg Down');

    // 19. Portofolio — Sub-tab 5: Skenario Posisi
    await page.evaluate(() => {
      if (typeof openPortfolioTab === 'function') openPortfolioTab('scenarios');
    });
    await takeShot('19-portofolio-subtab5-scenarios.png', 'Portofolio — Sub-tab 5: Skenario Posisi');

    // 20. Portofolio — Sub-tab 6: Jurnal
    await page.evaluate(() => {
      if (typeof openPortfolioTab === 'function') openPortfolioTab('journal');
    });
    await takeShot('20-portofolio-subtab6-journal.png', 'Portofolio — Sub-tab 6: Jurnal');

    // 21. Portofolio — Sub-tab 7: Asisten AI
    await page.evaluate(() => {
      if (typeof openPortfolioTab === 'function') openPortfolioTab('ai');
    });
    await takeShot('21-portofolio-subtab7-ai.png', 'Portofolio — Sub-tab 7: Asisten AI');

    // ===== MAIN TABS =====
    // 22. Tab Sektor Hot
    await page.evaluate(() => {
      navigateTo('sektor');
    });
    await takeShot('22-tab-sektor.png', 'Tab Sektor Hot');

    // 23. Tab Screener
    await page.evaluate(() => {
      navigateTo('screener');
    });
    await takeShot('23-tab-screener.png', 'Tab Screener');

    // 24. Tab Track Record
    await page.evaluate(() => {
      navigateTo('trackrecord');
    });
    await takeShot('24-tab-trackrecord.png', 'Tab Track Record');

    // 25. Tab Macro DeepScan
    await page.evaluate(() => {
      navigateTo('deepscan');
    });
    await takeShot('25-tab-deepscan.png', 'Tab Macro DeepScan');

    // 26. Tab Kelola Keuangan
    await page.evaluate(() => {
      navigateTo('money-management');
    });
    await takeShot('26-tab-money-management.png', 'Tab Kelola Keuangan (Spreadsheet Table)');

    await browser.close();
    console.log(`\nAll ${shots.length} screenshots successfully captured in ${SCREENSHOT_DIR}`);
  } finally {
    serverProcess.kill();
  }
}

run().catch((err) => {
  console.error('[Error during screenshot capture]:', err);
  process.exit(1);
});
