const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 9916;
const BASE_URL = `http://localhost:${PORT}`;

function startStaticServer() {
  const server = http.createServer((req, res) => {
    let p = req.url.split('?')[0];
    if (p === '/api/maintenance-settings') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        config: { maintenanceMode: false, message: '' }
      }));
      return;
    }
    if (p.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: [] }));
      return;
    }
    if (p === '/') p = '/index.html';
    const f = path.join(ROOT, 'public', p);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.writeHead(200);
      fs.createReadStream(f).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  return new Promise(r => server.listen(PORT, () => r(server)));
}

async function debugRect2() {
  const server = await startStaticServer();
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--window-size=1440,900']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('autocuan_user', 'budi');
    localStorage.setItem('autocuan_is_admin', 'true');
    localStorage.setItem('autocuan_token', 'test');
  });

  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => {
    maintenanceStatus = 'off';
    setTopLevelView('app');
    navigateTo('analisis', 'analisis-chart');
  });
  await new Promise(r => setTimeout(r, 1000));

  const details = await page.evaluate(() => {
    const anaCtx = document.querySelector('.ana-ctx');
    const r = anaCtx ? anaCtx.getBoundingClientRect() : null;
    return {
      dashboardDisplay: window.getComputedStyle(document.getElementById('dashboardScreen')).display,
      anaCtxDisplay: anaCtx ? window.getComputedStyle(anaCtx).display : null,
      rectW: r ? Math.round(r.width) : null,
      rectH: r ? Math.round(r.height) : null
    };
  });
  console.log('anaCtx details with maintenance-settings mock:', details);

  // Now switch to bandarmologi
  await page.evaluate(() => navigateTo('analisis', 'bandarmologi'));
  await new Promise(r => setTimeout(r, 500));

  const bandar = await page.evaluate(() => {
    const anaCtx = document.querySelector('.ana-ctx');
    const r = anaCtx ? anaCtx.getBoundingClientRect() : null;
    const bandarPanel = document.getElementById('panel-tab-bandarmologi');
    const bandarPh = bandarPanel ? bandarPanel.querySelector('.ph') : null;
    const phR = bandarPh ? bandarPh.getBoundingClientRect() : null;
    return {
      anaCtxDisplay: anaCtx ? window.getComputedStyle(anaCtx).display : null,
      anaCtxRectW: r ? Math.round(r.width) : null,
      bandarPanelDisplay: bandarPanel ? window.getComputedStyle(bandarPanel).display : null,
      bandarPhDisplay: bandarPh ? window.getComputedStyle(bandarPh).display : null,
      bandarPhW: phR ? Math.round(phR.width) : null,
      bandarPhH: phR ? Math.round(phR.height) : null
    };
  });
  console.log('bandarmologi details:', bandar);

  await browser.close();
  server.close();
}

debugRect2();
