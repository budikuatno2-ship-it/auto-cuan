'use strict';

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots', 'wave1b-qa');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3046;
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

async function runQa() {
  console.log('[QA-Seal] Launching local-dev-server on port ' + PORT + '...');
  const serverProcess = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });

  const measurements = [];

  try {
    await waitForServer(BASE_URL);
    console.log('[QA-Seal] Dev server ready at ' + BASE_URL);

    console.log('[QA-Seal] Launching Chrome from ' + CHROME_PATH);
    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();

    async function takeShot(filename, label) {
      const fullPath = path.join(SCREENSHOT_DIR, filename);
      await new Promise(r => setTimeout(r, 400));
      await page.screenshot({ path: fullPath, fullPage: false });
      console.log(`[QA Screenshot] Saved: ${filename} (${label})`);
      return fullPath;
    }

    async function initAuthenticatedState(theme = 'dark') {
      await page.goto(BASE_URL + '/dashboard', { waitUntil: 'networkidle2' });

      await page.evaluate((th) => {
        localStorage.setItem('autocuan_user', 'budi');
        localStorage.setItem('autocuan_role', 'ADMIN');
        localStorage.setItem('autocuan_session', '{"username":"budi","role":"ADMIN","approved":true}');
        localStorage.setItem('autocuan_logged_in', 'true');
        localStorage.setItem('autocuan_is_admin', 'true');
        localStorage.setItem('autocuan_user_id', 'admin-budi-id');
        localStorage.setItem('auto_cuan_onboarding_seen', 'true');
        localStorage.setItem('autocuan_entered_app', 'true');
        localStorage.setItem('autocuan_sidebar_collapsed', '0');
        if (th === 'light') {
          document.documentElement.classList.add('light-theme');
          document.documentElement.classList.remove('dark-theme');
          localStorage.setItem('autocuan_theme', 'light');
        } else {
          document.documentElement.classList.remove('light-theme');
          document.documentElement.classList.add('dark-theme');
          localStorage.setItem('autocuan_theme', 'dark');
        }
      }, theme);

      await page.evaluate((th) => {
        if (typeof setWorkspaceSidebarVisible === 'function') setWorkspaceSidebarVisible(true);
        if (typeof syncHeaderUsername === 'function') syncHeaderUsername();
        if (typeof premiumAccessState !== 'undefined') {
          premiumAccessState = { state: 'ready', premium: true, accessLevel: 'approved', checkedAt: Date.now(), expiresAt: null };
        }
        if (typeof applyPremiumAccessUi === 'function') applyPremiumAccessUi();
        if (typeof navigateTo === 'function') navigateTo('dashboard');

        if (th === 'light') {
          document.documentElement.classList.add('light-theme');
          document.documentElement.classList.remove('dark-theme');
          const root = document.querySelector(':root');
          if (root) root.setAttribute('data-theme', 'light');
        } else {
          document.documentElement.classList.remove('light-theme');
          document.documentElement.classList.add('dark-theme');
          const root = document.querySelector(':root');
          if (root) root.setAttribute('data-theme', 'dark');
        }
        const om = document.getElementById('onboardingModal');
        if (om) om.style.display = 'none';
      }, theme);

      await new Promise(r => setTimeout(r, 600));
    }

    async function measureShell(viewportName) {
      const metrics = await page.evaluate((vp) => {
        const sidebar = document.getElementById('appSidebar');
        const header = document.querySelector('.app-header');
        const main = document.getElementById('appMain');
        const accountBtn = document.getElementById('sidebarAccountBtn');
        const activeItem = document.querySelector('.sidebar-item.active');
        const docWidth = document.documentElement.scrollWidth;
        const winWidth = window.innerWidth;

        const sbRect = sidebar ? sidebar.getBoundingClientRect() : null;
        const hdrRect = header ? header.getBoundingClientRect() : null;
        const mainRect = main ? main.getBoundingClientRect() : null;
        const acctRect = accountBtn ? accountBtn.getBoundingClientRect() : null;

        let activeStyles = null;
        if (activeItem) {
          const comp = window.getComputedStyle(activeItem);
          activeStyles = {
            bg: comp.backgroundColor,
            color: comp.color,
            borderRadius: comp.borderRadius
          };
        }

        return {
          viewport: vp,
          sidebarWidth: sbRect ? sbRect.width : 0,
          sidebarHeight: sbRect ? sbRect.height : 0,
          sidebarVisible: sidebar ? !sidebar.classList.contains('hidden') : false,
          sidebarIsCollapsed: sidebar ? sidebar.classList.contains('is-collapsed') : false,
          headerHeight: hdrRect ? hdrRect.height : 0,
          headerWidth: hdrRect ? hdrRect.width : 0,
          mainLeft: mainRect ? mainRect.left : 0,
          mainWidth: mainRect ? mainRect.width : 0,
          accountVisible: acctRect ? acctRect.top >= 0 && acctRect.bottom <= window.innerHeight : false,
          accountTop: acctRect ? acctRect.top : 0,
          horizontalScrollLeak: docWidth > winWidth,
          docWidth,
          winWidth,
          activeItem: activeStyles
        };
      }, viewportName);

      measurements.push(metrics);
      console.log(`[QA Measurement: ${viewportName}]`, JSON.stringify(metrics, null, 2));
      return metrics;
    }

    // =========================================================================
    // 1. DESKTOP 1440x900
    // =========================================================================
    console.log('\n--- VIEWPORT: 1440x900 (Desktop) ---');
    await page.setViewport({ width: 1440, height: 900 });

    // 1A. Dark Expanded
    await initAuthenticatedState('dark');
    await page.evaluate(() => { if (typeof applySidebarCollapse === 'function') applySidebarCollapse(false); });
    await takeShot('01-desktop-1440x900-dark-expanded.png', 'Desktop 1440x900 Dark Expanded');
    await measureShell('1440x900-dark-expanded');

    // 1B. Dark Collapsed
    await page.evaluate(() => { if (typeof applySidebarCollapse === 'function') applySidebarCollapse(true); });
    await takeShot('02-desktop-1440x900-dark-collapsed.png', 'Desktop 1440x900 Dark Collapsed Rail');
    await measureShell('1440x900-dark-collapsed');

    // 1C. Light Expanded
    await initAuthenticatedState('light');
    await page.evaluate(() => { if (typeof applySidebarCollapse === 'function') applySidebarCollapse(false); });
    await takeShot('03-desktop-1440x900-light-expanded.png', 'Desktop 1440x900 Light Expanded');
    await measureShell('1440x900-light-expanded');

    // 1D. Light Collapsed
    await page.evaluate(() => { if (typeof applySidebarCollapse === 'function') applySidebarCollapse(true); });
    await takeShot('04-desktop-1440x900-light-collapsed.png', 'Desktop 1440x900 Light Collapsed Rail');
    await measureShell('1440x900-light-collapsed');

    // =========================================================================
    // 2. DESKTOP 1024x768
    // =========================================================================
    console.log('\n--- VIEWPORT: 1024x768 (Desktop Standard / Large Tablet) ---');
    await page.setViewport({ width: 1024, height: 768 });

    // 2A. Dark Expanded
    await initAuthenticatedState('dark');
    await page.evaluate(() => { if (typeof applySidebarCollapse === 'function') applySidebarCollapse(false); });
    await takeShot('05-desktop-1024x768-dark-expanded.png', 'Desktop 1024x768 Dark Expanded');
    await measureShell('1024x768-dark-expanded');

    // 2B. Dark Collapsed
    await page.evaluate(() => { if (typeof applySidebarCollapse === 'function') applySidebarCollapse(true); });
    await takeShot('06-desktop-1024x768-dark-collapsed.png', 'Desktop 1024x768 Dark Collapsed Rail');
    await measureShell('1024x768-dark-collapsed');

    // 2C. Light Expanded
    await initAuthenticatedState('light');
    await page.evaluate(() => { if (typeof applySidebarCollapse === 'function') applySidebarCollapse(false); });
    await takeShot('07-desktop-1024x768-light-expanded.png', 'Desktop 1024x768 Light Expanded');
    await measureShell('1024x768-light-expanded');

    // =========================================================================
    // 3. TABLET 768x1024
    // =========================================================================
    console.log('\n--- VIEWPORT: 768x1024 (Tablet Portrait) ---');
    await page.setViewport({ width: 768, height: 1024 });

    // 3A. Dark Closed Drawer
    await initAuthenticatedState('dark');
    await takeShot('08-tablet-768x1024-dark-closed.png', 'Tablet 768x1024 Dark Drawer Closed');
    await measureShell('768x1024-dark-closed');

    // 3B. Dark Drawer Open
    await page.evaluate(() => {
      const toggle = document.getElementById('workspaceSidebarToggle');
      if (toggle) toggle.click();
    });
    await new Promise(r => setTimeout(r, 400));
    await takeShot('09-tablet-768x1024-dark-drawer-open.png', 'Tablet 768x1024 Dark Drawer Open');
    await measureShell('768x1024-dark-drawer-open');

    // 3C. Light Drawer Open
    await initAuthenticatedState('light');
    await page.evaluate(() => {
      const toggle = document.getElementById('workspaceSidebarToggle');
      if (toggle) toggle.click();
    });
    await new Promise(r => setTimeout(r, 400));
    await takeShot('10-tablet-768x1024-light-drawer-open.png', 'Tablet 768x1024 Light Drawer Open');
    await measureShell('768x1024-light-drawer-open');

    // Close drawer
    await page.evaluate(() => {
      if (typeof closeMobileSidebar === 'function') closeMobileSidebar();
    });

    // =========================================================================
    // 4. MOBILE 390x844
    // =========================================================================
    console.log('\n--- VIEWPORT: 390x844 (Mobile Portrait) ---');
    await page.setViewport({ width: 390, height: 844 });

    // 4A. Dark Mobile Home
    await initAuthenticatedState('dark');
    await takeShot('11-mobile-390x844-dark-home.png', 'Mobile 390x844 Dark Home');
    await measureShell('390x844-dark-home');

    // 4B. Light Mobile Home
    await initAuthenticatedState('light');
    await takeShot('12-mobile-390x844-light-home.png', 'Mobile 390x844 Light Home');
    await measureShell('390x844-light-home');

    // 4C. Mobile Drawer Open
    await page.evaluate(() => {
      const toggle = document.getElementById('workspaceSidebarToggle');
      if (toggle) toggle.click();
    });
    await new Promise(r => setTimeout(r, 400));
    await takeShot('13-mobile-390x844-dark-drawer-open.png', 'Mobile 390x844 Drawer Open');
    await measureShell('390x844-drawer-open');

    // Close mobile drawer
    await page.evaluate(() => {
      if (typeof closeMobileSidebar === 'function') closeMobileSidebar();
    });

    // =========================================================================
    // 5. ACCOUNT / LONG-USERNAME CLIPPING TEST
    // =========================================================================
    console.log('\n--- ACCOUNT FOOTER STRESS TEST (Long Username) ---');
    await page.setViewport({ width: 1440, height: 600 }); // Short viewport to stress vertical room
    await initAuthenticatedState('dark');
    await page.evaluate(() => {
      const userSpan = document.getElementById('sidebarUserName');
      if (userSpan) userSpan.textContent = 'budi.supercalifragilisticexpialidocious_long_identity';
    });
    await takeShot('14-sidebar-account-long-username.png', 'Sidebar Account Long Username (Short Viewport 1440x600)');
    await measureShell('1440x600-long-username');

    // Write measurements summary to file
    const reportPath = path.join(SCREENSHOT_DIR, 'qa-measurements.json');
    fs.writeFileSync(reportPath, JSON.stringify(measurements, null, 2), 'utf8');
    console.log('\n[QA-Seal] All measurements written to ' + reportPath);

    await browser.close();
    console.log('[QA-Seal] Browser closed successfully.');
  } finally {
    serverProcess.kill();
    console.log('[QA-Seal] Local server terminated.');
  }
}

runQa().catch(err => {
  console.error('[QA-Seal] Error:', err);
  process.exit(1);
});
