const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = 9913;
const BASE_URL = `http://localhost:${PORT}`;

function startServer() {
  const server = http.createServer((req, res) => {
    let pathname = new URL(req.url, BASE_URL).pathname;
    if (pathname === '/api/maintenance-settings') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, config: { maintenanceMode: false, message: '' } }));
    }
    if (pathname === '/api/admin-users') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, user_id: 'usr_admin_budi', username: 'budi', role: 'ADMIN', is_approved: true, is_admin: true }));
    }
    if (pathname.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: [] }));
    }
    if (['/', '/dashboard', '/kelola-keuangan'].includes(pathname)) pathname = '/index.html';
    const filePath = path.join(ROOT, 'public', pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  return new Promise(r => server.listen(PORT, () => r(server)));
}

async function debug() {
  const server = await startServer();
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--window-size=1440,900']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('autocuan_user', 'budi');
    localStorage.setItem('autocuan_user_id', 'usr_admin_budi');
    localStorage.setItem('autocuan_is_admin', 'true');
    localStorage.setItem('autocuan_token', 'session-budi-admin-verified');
    window.__AUTOCUAN_AUTHENTICATED_SESSION__ = { username: 'budi', userId: 'usr_admin_budi', isAdmin: true };
    window.premiumAccessState = { state: 'ready', premium: true, isAdmin: true, accessLevel: 'approved' };
  });

  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 600));

  await page.evaluate(() => {
    window.maintenanceStatus = 'off';
    window.premiumAccessState = { state: 'ready', premium: true, isAdmin: true, accessLevel: 'approved' };
    if (typeof setTopLevelView === 'function') setTopLevelView('app');
    if (typeof applyPremiumAccessUi === 'function') applyPremiumAccessUi();
    const appShell = document.getElementById('appShell');
    if (appShell) appShell.setAttribute('data-sidebar-state', 'expanded');
    const appSidebar = document.getElementById('appSidebar');
    if (appSidebar) { appSidebar.classList.remove('hidden'); appSidebar.style.display = 'flex'; }
  });
  await new Promise(r => setTimeout(r, 400));

  const elInfo = await page.evaluate(() => {
    const el = document.getElementById('nav-money-management');
    if (!el) return { found: false };
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const parent = el.closest('.sidebar-nav-group');
    const parentStyle = parent ? window.getComputedStyle(parent) : null;
    return {
      found: true,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      styleDisplay: style.display,
      styleVisibility: style.visibility,
      stylePointerEvents: style.pointerEvents,
      classList: Array.from(el.classList),
      disabled: el.disabled,
      parentDisplay: parentStyle ? parentStyle.display : null,
      parentClassList: parent ? Array.from(parent.classList) : null
    };
  });
  console.log('Element Info:', elInfo);

  await browser.close();
  server.close();
}

debug().catch(console.error);
