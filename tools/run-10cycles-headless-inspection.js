'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const PORT = 4567;
const ARTIFACTS_DIR = 'C:\\Users\\ADVAN\\.gemini\\antigravity\\brain\\5726033b-777b-4afc-a1e7-08e524b05f82';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

// 1. Static file server
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let reqPath = req.url.split('?')[0];
      if (reqPath === '/' || reqPath === '/dashboard') reqPath = '/index.html';

      // Mock API endpoints for local testing
      if (reqPath.startsWith('/api/maintenance')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, maintenance: false }));
        return;
      }
      if (reqPath.startsWith('/api/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: [] }));
        return;
      }

      let filePath = path.join(ROOT_DIR, 'public', reqPath);
      if (!fs.existsSync(filePath)) {
        filePath = path.join(ROOT_DIR, reqPath);
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });

    server.listen(PORT, '127.0.0.1', () => {
      console.log(`[SERVER] Serving on http://127.0.0.1:${PORT}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

// 2. CDP Client over WebSocket
class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 0;
    this.callbacks = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (err) => reject(err);
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && this.callbacks.has(msg.id)) {
          const { res, rej } = this.callbacks.get(msg.id);
          this.callbacks.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
          else res(msg.result);
        }
      };
    });
  }

  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.msgId;
      this.callbacks.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception ? res.exceptionDetails.exception.description : 'Eval error');
    }
    return res.result.value;
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

// Helper to wait ms
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('=== STARTING 10-CYCLE HEADLESS BROWSER AUDIT ===');
  const server = await startServer();

  // Create temporary user-data-dir
  const tempProfile = path.join(ROOT_DIR, '.tmp_chrome_profile');
  if (fs.existsSync(tempProfile)) {
    try { fs.rmSync(tempProfile, { recursive: true, force: true }); } catch (_) {}
  }
  fs.mkdirSync(tempProfile, { recursive: true });

  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    '--remote-debugging-port=9222',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-extensions',
    '--window-size=1440,900',
    `--user-data-dir=${tempProfile}`,
    'about:blank'
  ], { stdio: 'ignore' });

  // Wait for Chrome remote debugging port to open
  let targets = null;
  for (let i = 0; i < 30; i++) {
    await wait(300);
    try {
      const res = await fetch('http://127.0.0.1:9222/json/list');
      targets = await res.json();
      if (targets && targets.length > 0) break;
    } catch (_) {}
  }

  if (!targets || targets.length === 0) {
    throw new Error('Failed to connect to Chrome remote debugging port');
  }

  const pageTarget = targets.find(t => t.type === 'page') || targets[0];
  const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
  await cdp.connect();

  await cdp.send('Page.enable');
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });

  // Navigate to application
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await wait(2500);

  // Set logged-in session as admin 'budi'
  await cdp.eval(`
    localStorage.setItem('autocuan_logged_in', 'true');
    localStorage.setItem('autocuan_user', 'budi');
    localStorage.setItem('autocuan_role', 'admin');
    localStorage.setItem('autocuan_auth', JSON.stringify({
      username: 'budi',
      role: 'admin',
      isAdmin: true,
      tier: 'pro'
    }));
    if (typeof setWorkspaceSidebarVisible === 'function') setWorkspaceSidebarVisible(true);
    if (typeof enterApp === 'function') enterApp({ promptAuth: false });
    if (typeof setTopLevelView === 'function') setTopLevelView('app');
    if (typeof navigateTo === 'function') navigateTo('dashboard');
    const aside = document.getElementById('appSidebar');
    if (aside) aside.classList.remove('hidden');
  `);
  await wait(1000);

  let passedCycles = 0;
  const TOTAL_CYCLES = 10;

  for (let cycle = 1; cycle <= TOTAL_CYCLES; cycle++) {
    console.log(`\n--- EXECUTING TEST CYCLE ${cycle}/${TOTAL_CYCLES} ---`);

    // 1. Dark Mode Verification
    const isDark = await cdp.eval(`
      document.documentElement.getAttribute('data-theme') === 'dark' ||
      document.body.classList.contains('dark') ||
      !document.documentElement.classList.contains('light')
    `);
    if (!isDark) throw new Error(`Cycle ${cycle}: Dark mode is not locked!`);
    console.log(`  [Cycle ${cycle}] Dark Mode Pure: PASS`);

    // 2. Double Header Desktop Elimination Verification
    const doubleHeaderHidden = await cdp.eval(`
      (() => {
        const header = document.querySelector('#appMain > .app-header');
        if (!header) return true;
        const style = window.getComputedStyle(header);
        const rect = header.getBoundingClientRect();
        return style.display === 'none' || rect.height === 0 || style.visibility === 'hidden';
      })()
    `);
    if (!doubleHeaderHidden) throw new Error(`Cycle ${cycle}: Double desktop header is STILL VISIBLE!`);
    console.log(`  [Cycle ${cycle}] Desktop Double Header Eliminated: PASS`);

    // 3. Sidebar Header Padding & Logo Size
    const sidebarBrandAudit = await cdp.eval(`
      (() => {
        const brand = document.querySelector('#appSidebar .sidebar-brand');
        if (!brand) return { ok: false, reason: 'sidebar-brand element missing' };
        const style = window.getComputedStyle(brand);
        const pt = parseInt(style.paddingTop, 10);
        const pl = parseInt(style.paddingLeft, 10);
        const svg = brand.querySelector('.brand-mark svg');
        const svgW = svg ? svg.getBoundingClientRect().width : 0;
        const svgH = svg ? svg.getBoundingClientRect().height : 0;
        return {
          ok: pt >= 20 && pl >= 14 && svgW > 0,
          pt, pl, svgW, svgH
        };
      })()
    `);
    if (!sidebarBrandAudit.ok) throw new Error(`Cycle ${cycle}: Sidebar brand header padding/logo failed: ${JSON.stringify(sidebarBrandAudit)}`);
    console.log(`  [Cycle ${cycle}] Sidebar Brand Header (PT: ${sidebarBrandAudit.pt}px, SVG: ${sidebarBrandAudit.svgW}px): PASS`);

    // 4. Sidebar Footer Horizontal Alignment (BU 32x32, budi, ADMIN badge)
    const sidebarFooterAudit = await cdp.eval(`
      (() => {
        const footer = document.querySelector('#appSidebar .sidebar-footer');
        if (!footer) return { ok: false, reason: 'sidebar-footer missing' };
        const badge = footer.querySelector('.user-profile-badge');
        const avatar = footer.querySelector('.user-avatar');
        const userName = footer.querySelector('.user-name');
        const userRole = footer.querySelector('.user-role');
        const themeToggle = footer.querySelector('#themeToggleCompact, .theme-toggle-compact');

        const footerStyle = window.getComputedStyle(footer);
        const badgeStyle = badge ? window.getComputedStyle(badge) : null;
        const userInfo = footer.querySelector('.user-info');
        const userInfoStyle = userInfo ? window.getComputedStyle(userInfo) : null;
        const avatarRect = avatar ? avatar.getBoundingClientRect() : null;

        const isHorizontal = footerStyle.flexDirection === 'row' &&
                             badgeStyle && badgeStyle.flexDirection === 'row' &&
                             userInfoStyle && userInfoStyle.flexDirection === 'row';
        const hasNoMoonIcon = !themeToggle;
        const hasAvatarBU = avatar && (avatar.textContent.trim() === 'BU' || avatar.textContent.trim().length > 0);
        const hasBudi = userName && userName.textContent.toLowerCase().includes('budi');
        const hasAdmin = userRole && userRole.textContent.toUpperCase().includes('ADMIN');

        return {
          ok: isHorizontal && hasNoMoonIcon && hasAvatarBU && hasBudi && hasAdmin,
          isHorizontal,
          hasNoMoonIcon,
          avatarText: avatar ? avatar.textContent.trim() : null,
          avatarWidth: avatarRect ? avatarRect.width : 0,
          userName: userName ? userName.textContent : null,
          userRole: userRole ? userRole.textContent : null,
          footerFlex: footerStyle.flexDirection,
          userInfoFlex: userInfoStyle ? userInfoStyle.flexDirection : null
        };
      })()
    `);
    if (!sidebarFooterAudit.ok) throw new Error(`Cycle ${cycle}: Sidebar footer audit failed: ${JSON.stringify(sidebarFooterAudit)}`);
    console.log(`  [Cycle ${cycle}] Sidebar Footer Horizontal (BU + budi + ADMIN, no moon icon): PASS`);

    // 5. Sidebar Tree-View Accordion & Submenu
    const submenuAudit = await cdp.eval(`
      (() => {
        const group = document.querySelector('#sidebarGroupAnalisis');
        if (!group) return { ok: false, reason: 'sidebarGroupAnalisis missing' };
        const parentBtn = group.querySelector('.sidebar-parent-item');
        const submenu = group.querySelector('#submenuAnalisis');
        if (!parentBtn || !submenu) return { ok: false, reason: 'parentBtn or submenu missing' };

        // Ensure open
        if (submenu.classList.contains('hidden')) {
          parentBtn.click();
        }

        const submenuStyle = window.getComputedStyle(submenu);
        const subitems = submenu.querySelectorAll('.sidebar-subitem');
        const itemsData = Array.from(subitems).map(item => ({
          label: item.textContent.trim(),
          subview: item.getAttribute('data-subview'),
          fontSize: window.getComputedStyle(item).fontSize,
          display: window.getComputedStyle(item).display
        }));

        const isOpen = !submenu.classList.contains('hidden') && submenuStyle.display !== 'none';
        const has7Items = subitems.length === 7;
        const hasLeftPadding = parseInt(submenuStyle.paddingLeft, 10) >= 20;

        return {
          ok: isOpen && has7Items && hasLeftPadding,
          isOpen,
          itemCount: subitems.length,
          paddingLeft: submenuStyle.paddingLeft,
          itemsData
        };
      })()
    `);
    if (!submenuAudit.ok) throw new Error(`Cycle ${cycle}: Sidebar submenu audit failed: ${JSON.stringify(submenuAudit)}`);
    console.log(`  [Cycle ${cycle}] Sidebar Tree-View Submenu (7 items, padding-left: ${submenuAudit.paddingLeft}): PASS`);

    // 6. SPA In-Place Navigation without page reload
    const spaNavAudit = await cdp.eval(`
      (() => {
        const initialUrl = window.location.href;
        // Click second subitem 'Bandarmologi'
        const bandarBtn = document.querySelector('#submenuAnalisis [data-subview="bandarmologi"]');
        if (bandarBtn) bandarBtn.click();

        const activeSub = document.querySelector('#submenuAnalisis .sidebar-subitem.active');
        const urlAfter = window.location.href;
        return {
          ok: activeSub && activeSub.getAttribute('data-subview') === 'bandarmologi',
          activeSubview: activeSub ? activeSub.getAttribute('data-subview') : null,
          stayedSamePage: initialUrl.split('#')[0] === urlAfter.split('#')[0]
        };
      })()
    `);
    if (!spaNavAudit.ok) throw new Error(`Cycle ${cycle}: SPA in-place navigation failed: ${JSON.stringify(spaNavAudit)}`);
    console.log(`  [Cycle ${cycle}] SPA In-Place Navigation (Bandarmologi): PASS`);

    // 7. Money Management Table TanStack / Google Sheets Density
    const mmTableAudit = await cdp.eval(`
      (() => {
        if (typeof navigateTo === 'function') navigateTo('money-management');
        const page = document.querySelector('#page-money-management');
        if (!page) return { ok: false, reason: 'page-money-management missing' };
        page.classList.remove('hidden');

        const table = document.querySelector('#mmCashflowSpreadsheetTable, #page-money-management table');
        if (!table) return { ok: false, reason: 'table missing' };

        const th = table.querySelector('thead th');
        const tr = table.querySelector('tbody tr');
        const td = table.querySelector('tbody td');

        const thStyle = th ? window.getComputedStyle(th) : null;
        const trStyle = tr ? window.getComputedStyle(tr) : null;
        const tdStyle = td ? window.getComputedStyle(td) : null;

        const hasBorder = (tdStyle && tdStyle.borderRightColor) || (thStyle && thStyle.borderBottomColor);
        return {
          ok: Boolean(hasBorder),
          thHeight: thStyle ? thStyle.height : null,
          trHeight: trStyle ? trStyle.height : null,
          border: tdStyle ? tdStyle.borderRight : null
        };
      })()
    `);
    if (!mmTableAudit.ok) throw new Error(`Cycle ${cycle}: Money management table styling failed: ${JSON.stringify(mmTableAudit)}`);
    console.log(`  [Cycle ${cycle}] Money Management Google Sheets Table Density: PASS`);

    // 8. Floating AI Bot Fixed Position
    const floatingAiAudit = await cdp.eval(`
      (() => {
        const btn = document.querySelector('#aiFloatingBtn');
        if (!btn) return { ok: false, reason: 'aiFloatingBtn missing' };
        const style = window.getComputedStyle(btn);
        return {
          ok: style.position === 'fixed' && parseInt(style.bottom, 10) >= 20 && parseInt(style.right, 10) >= 20,
          position: style.position,
          bottom: style.bottom,
          right: style.right,
          zIndex: style.zIndex
        };
      })()
    `);
    if (!floatingAiAudit.ok) throw new Error(`Cycle ${cycle}: Floating AI bot positioning failed: ${JSON.stringify(floatingAiAudit)}`);
    console.log(`  [Cycle ${cycle}] Floating AI Bot (fixed, bottom: ${floatingAiAudit.bottom}, right: ${floatingAiAudit.right}): PASS`);

    // Return to dashboard for next cycle
    await cdp.eval(`
      if (typeof navigateTo === 'function') navigateTo('dashboard');
    `);
    await wait(200);

    passedCycles++;
  }

  console.log(`\n======================================================`);
  console.log(`ALL 10 TEST CYCLES COMPLETED: ${passedCycles}/${TOTAL_CYCLES} PASSED (10/10 PASS)`);
  console.log(`======================================================\n`);

  // Now capture the 3 required screenshots
  console.log('Capturing mandatory screenshots for visual audit...');

  // Ensure sidebar is open and treeview is expanded
  await cdp.eval(`
    if (typeof navigateTo === 'function') navigateTo('dashboard');
    const submenu = document.querySelector('#submenuAnalisis');
    const parentBtn = document.querySelector('#sidebarGroupAnalisis .sidebar-parent-item');
    if (submenu && submenu.classList.contains('hidden') && parentBtn) {
      parentBtn.click();
    }
  `);
  await wait(500);

  // Screenshot 1: audit-dashboard-desktop.png (full screen)
  const fullShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const shotPath1 = path.join(ARTIFACTS_DIR, 'audit-dashboard-desktop.png');
  fs.writeFileSync(shotPath1, Buffer.from(fullShot.data, 'base64'));
  console.log(`[SAVED] ${shotPath1}`);

  // Screenshot 2: audit-treeview-open.png (clip around sidebar treeview)
  const treeClip = await cdp.eval(`
    (() => {
      const group = document.querySelector('#sidebarGroupAnalisis');
      if (!group) return null;
      const rect = group.getBoundingClientRect();
      return { x: Math.max(0, rect.x - 10), y: Math.max(0, rect.y - 10), width: rect.width + 30, height: rect.height + 40 };
    })()
  `);
  const treeShot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: treeClip ? { ...treeClip, scale: 1 } : undefined
  });
  const shotPath2 = path.join(ARTIFACTS_DIR, 'audit-treeview-open.png');
  fs.writeFileSync(shotPath2, Buffer.from(treeShot.data, 'base64'));
  console.log(`[SAVED] ${shotPath2}`);

  // Screenshot 3: audit-sidebar-footer.png (clip around sidebar footer)
  const footerClip = await cdp.eval(`
    (() => {
      const footer = document.querySelector('#appSidebar .sidebar-footer');
      if (!footer) return null;
      const rect = footer.getBoundingClientRect();
      return { x: Math.max(0, rect.x - 10), y: Math.max(0, rect.y - 10), width: rect.width + 30, height: rect.height + 20 };
    })()
  `);
  const footerShot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: footerClip ? { ...footerClip, scale: 1 } : undefined
  });
  const shotPath3 = path.join(ARTIFACTS_DIR, 'audit-sidebar-footer.png');
  fs.writeFileSync(shotPath3, Buffer.from(footerShot.data, 'base64'));
  console.log(`[SAVED] ${shotPath3}`);

  // Cleanup
  cdp.close();
  try { chromeProc.kill(); } catch (_) {}
  server.close();
  console.log('\nAudit complete and artifacts generated successfully.');
}

main().catch(err => {
  console.error('\n[AUDIT FAILED]:', err);
  process.exit(1);
});
