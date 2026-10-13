'use strict';

const puppeteer = require('puppeteer-core');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const EVIDENCE_DIR = path.join(ROOT_DIR, 'docs', 'evidence', 'fase-1');

if (!fs.existsSync(EVIDENCE_DIR)) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

// Start test HTTP server serving public directory and mock API routes
function createTestServer(port) {
  const mimeMap = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    let pathname = decodeURIComponent(url.pathname);

    // Mock API responses needed for clean zero-error layout renders
    if (pathname.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (pathname.includes('/maintenance-settings')) {
        res.end(JSON.stringify({ success: true, config: { maintenanceMode: false, message: '' } }));
      } else if (pathname.includes('/candles')) {
        res.end(JSON.stringify({ success: true, data: [] }));
      } else if (pathname.includes('/quote')) {
        res.end(JSON.stringify({ success: true, symbol: 'BBCA', price: 9800, change: 50, changePct: 0.51 }));
      } else if (pathname.includes('/auth/status')) {
        res.end(JSON.stringify({ loggedIn: true, user: { username: 'investor', role: 'PRO' } }));
      } else {
        res.end(JSON.stringify({ success: true }));
      }
      return;
    }

    if (pathname === '/' || pathname === '/dashboard' || pathname === '/preview/dashboard') {
      pathname = '/index.html';
    }

    let filePath = path.join(PUBLIC_DIR, pathname);
    if (!fs.existsSync(filePath)) {
      // Check partials directory at root
      if (pathname.startsWith('/partials/')) {
        const rootPartial = path.join(ROOT_DIR, pathname);
        if (fs.existsSync(rootPartial)) filePath = rootPartial;
      }
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    try {
      const data = fs.readFileSync(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'text/plain' });
      res.end(data);
    } catch (err) {
      res.writeHead(500);
      res.end('Error reading ' + filePath + ': ' + err.message);
    }
  });

  return server;
}

// Check partial synchronization and ID collisions
function checkPartialIntegrity() {
  const rootPartialsDir = path.join(ROOT_DIR, 'partials');
  const pubPartialsDir = path.join(PUBLIC_DIR, 'partials');
  const indexHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

  const report = {
    differences: [],
    idCollisions: []
  };

  if (fs.existsSync(rootPartialsDir) && fs.existsSync(pubPartialsDir)) {
    const rootFiles = fs.readdirSync(rootPartialsDir).filter(f => f.endsWith('.html'));
    for (const f of rootFiles) {
      const rootPath = path.join(rootPartialsDir, f);
      const pubPath = path.join(pubPartialsDir, f);
      if (!fs.existsSync(pubPath)) {
        report.differences.push({ file: f, status: 'MISSING_IN_PUBLIC' });
      } else {
        const rootContent = fs.readFileSync(rootPath, 'utf8');
        const pubContent = fs.readFileSync(pubPath, 'utf8');
        if (rootContent !== pubContent) {
          report.differences.push({
            file: f,
            status: 'CONTENT_MISMATCH',
            rootLength: rootContent.length,
            pubLength: pubContent.length
          });
        }
      }
    }
  }

  // Check specific ID collisions between index.html and partials
  const suspiciousIds = [
    'financialStatusBadge',
    'financialCompanyName',
    'financialStatementsTableHead',
    'financialStatementsTableBody',
    'marketStructureAccordionContainer'
  ];

  for (const id of suspiciousIds) {
    const idRegex = new RegExp(`id=["']${id}["']`, 'g');
    const matchesInIndex = (indexHtml.match(idRegex) || []).length;
    report.idCollisions.push({
      id: id,
      countInIndexHtml: matchesInIndex
    });
  }

  return report;
}

async function runAudit() {
  const PORT = 3981;
  const server = createTestServer(PORT);
  await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));
  console.log(`[audit-layout] Test server running on http://127.0.0.1:${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const results = {
    timestamp: new Date().toISOString(),
    viewports: {},
    containerWidths: {},
    partialIntegrity: checkPartialIntegrity()
  };

  try {
    const page = await browser.newPage();

    // 1. Audit viewports for Top Navbar Gap (S1)
    const viewports = [
      { name: 'desktop_1920x1080', width: 1920, height: 1080 },
      { name: 'laptop_1440x900', width: 1440, height: 900 },
      { name: 'mobile_390x844', width: 390, height: 844 }
    ];

    for (const vp of viewports) {
      await page.setViewport({ width: vp.width, height: vp.height });
      await page.goto(`http://127.0.0.1:${PORT}`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        try {
          localStorage.setItem('autocuan_user', 'budi');
          localStorage.setItem('autocuan_logged_in', 'true');
          localStorage.setItem('autocuan_entered_app', 'true');
          localStorage.setItem('auto_cuan_onboarding_seen', 'true');
          localStorage.setItem('autocuan_theme', 'dark');
          document.documentElement.classList.remove('light');
          if (typeof hideOnboardingGuide === 'function') hideOnboardingGuide(true);
          if (typeof showDashboard === 'function') showDashboard();
        } catch (_) {}
      });
      await new Promise(r => setTimeout(r, 600));

      const vpMetrics = await page.evaluate(() => {
        const header = document.querySelector('.app-header') || document.querySelector('header');
        const nav = document.querySelector('.app-navbar') || document.querySelector('nav') || document.querySelector('#appContent');
        const bodyStyle = window.getComputedStyle(document.body);
        const htmlStyle = window.getComputedStyle(document.documentElement);

        const headerStyle = header ? window.getComputedStyle(header) : null;
        const headerVisible = headerStyle ? headerStyle.display !== 'none' : false;
        const headerRect = header ? header.getBoundingClientRect() : null;
        const navRect = nav ? nav.getBoundingClientRect() : null;

        return {
          windowScrollY: window.scrollY,
          bodyMarginTop: parseFloat(bodyStyle.marginTop) || 0,
          bodyPaddingTop: parseFloat(bodyStyle.paddingTop) || 0,
          htmlPaddingTop: parseFloat(htmlStyle.paddingTop) || 0,
          headerVisible: headerVisible,
          headerTop: headerRect ? headerRect.top : null,
          headerHeight: headerRect ? headerRect.height : null,
          navTop: navRect ? navRect.top : null,
          firstContentTop: navRect ? navRect.top : 0
        };
      });

      results.viewports[vp.name] = vpMetrics;
      console.log(`[audit-layout] ${vp.name}: navTop = ${vpMetrics.navTop}px, headerTop = ${vpMetrics.headerTop}px`);

      // Screenshot
      await page.screenshot({
        path: path.join(EVIDENCE_DIR, `audit-${vp.name}.png`)
      });
    }

    // 2. Audit Container Widths across tabs (S2 & S3) on Desktop (1920x1080)
    await page.setViewport({ width: 1920, height: 1080 });
    await page.evaluate(() => {
      try {
        localStorage.setItem('autocuan_user', 'budi');
        localStorage.setItem('autocuan_logged_in', 'true');
        localStorage.setItem('autocuan_entered_app', 'true');
        localStorage.setItem('auto_cuan_onboarding_seen', 'true');
        localStorage.setItem('autocuan_theme', 'dark');
        document.documentElement.classList.remove('light');
        if (typeof hideOnboardingGuide === 'function') hideOnboardingGuide(true);
        if (typeof setTopLevelView === 'function') setTopLevelView('app');
        if (typeof showDashboard === 'function') showDashboard();
      } catch (_) {}
    });
    await new Promise(r => setTimeout(r, 600));
    const tabsToTest = ['dashboard', 'analisis', 'screener', 'watchlist', 'portofolio', 'sektor'];

    for (const tab of tabsToTest) {
      await page.evaluate((targetTab) => {
        if (typeof navigateTo === 'function') {
          navigateTo(targetTab);
        }
      }, tab);

      await new Promise(r => setTimeout(r, 700));

      const hierarchyMetrics = await page.evaluate((targetTab) => {
        const shell = document.getElementById('appShell');
        const sidebar = document.getElementById('appSidebar');
        const main = document.getElementById('appMain');
        const content = document.getElementById('appContent');
        const pageEl = document.getElementById(`page-${targetTab}`);

        const getRect = (el) => {
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          const cs = window.getComputedStyle(el);
          const matched = [];
          for (const sheet of document.styleSheets) {
            try {
              for (const rule of sheet.cssRules) {
                if (rule.selectorText && el.matches(rule.selectorText) && rule.style.maxWidth) {
                  matched.push({ selector: rule.selectorText, maxWidth: rule.style.maxWidth });
                }
              }
            } catch (_) {}
          }
          return {
            width: rect.width,
            height: rect.height,
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            paddingLeft: cs.paddingLeft,
            paddingRight: cs.paddingRight,
            marginLeft: cs.marginLeft,
            marginRight: cs.marginRight,
            maxWidth: cs.maxWidth,
            matchedRules: matched
          };
        };

        return {
          windowWidth: window.innerWidth,
          shell: getRect(shell),
          sidebar: getRect(sidebar),
          main: getRect(main),
          content: getRect(content),
          page: getRect(pageEl)
        };
      }, tab);

      console.log(`[audit-layout] Tab [${tab}] geometry:`, JSON.stringify(hierarchyMetrics, null, 2));
      results.containerWidths[tab] = hierarchyMetrics;

      await page.screenshot({
        path: path.join(EVIDENCE_DIR, `audit-tab-${tab}-desktop.png`)
      });
    }

    // Write audit report JSON
    const reportPath = path.join(EVIDENCE_DIR, 'audit-layout-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(results, null, 2), 'utf8');
    console.log(`[audit-layout] Audit report saved to ${reportPath}`);

    return results;
  } finally {
    await browser.close();
    server.close();
  }
}

runAudit().then(report => {
  console.log('\n===== RINGKASAN AUDIT GAP LAYOUT (FAIL-BEFORE) =====');
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}).catch(err => {
  console.error('[audit-layout] Error during audit:', err);
  process.exit(1);
});
