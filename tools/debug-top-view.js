const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 9915;
const BASE_URL = `http://localhost:${PORT}`;

function startStaticServer() {
  const server = http.createServer((req, res) => {
    let p = req.url.split('?')[0];
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

async function debugTopView() {
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

  // Call setTopLevelView('app') and navigateTo('analisis', 'analisis-chart')
  await page.evaluate(() => {
    if (typeof setTopLevelView === 'function') setTopLevelView('app');
    else {
      const d = document.getElementById('dashboardScreen');
      if (d) { d.classList.remove('hidden'); d.style.display = 'flex'; }
      const l = document.getElementById('landingPage');
      if (l) l.classList.add('hidden');
    }
    navigateTo('analisis', 'analisis-chart');
  });
  await new Promise(r => setTimeout(r, 1000));

  const after = await page.evaluate(() => {
    const anaCtx = document.querySelector('.ana-ctx');
    const r = anaCtx ? anaCtx.getBoundingClientRect() : null;
    return {
      dashboardScreenHidden: document.getElementById('dashboardScreen').classList.contains('hidden'),
      dashboardScreenDisplay: window.getComputedStyle(document.getElementById('dashboardScreen')).display,
      anaCtxDisplay: anaCtx ? window.getComputedStyle(anaCtx).display : null,
      anaCtxW: r ? r.width : null,
      anaCtxH: r ? r.height : null
    };
  });
  console.log('Results with setTopLevelView("app"):', after);

  // Switch to bandarmologi
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
      anaCtxW: r ? r.width : null,
      bandarPanelDisplay: bandarPanel ? window.getComputedStyle(bandarPanel).display : null,
      bandarPhDisplay: bandarPh ? window.getComputedStyle(bandarPh).display : null,
      bandarPhW: phR ? phR.width : null,
      bandarPhH: phR ? phR.height : null
    };
  });
  console.log('Results on bandarmologi:', bandar);

  await browser.close();
  server.close();
}

debugTopView();
