const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 9912;
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

async function debug() {
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

  console.log('Current page before nav:');
  const initial = await page.evaluate(() => {
    return {
      currentPage: typeof currentPage !== 'undefined' ? currentPage : null,
      pageAnalisisClasses: document.getElementById('page-analisis')?.className,
      partialMountChildren: document.getElementById('analisisPartialMount')?.children.length,
      anaCtx: document.querySelector('.ana-ctx')?.outerHTML?.slice(0, 100)
    };
  });
  console.log(initial);

  console.log('Calling navigateTo("analisis", "analisis-chart")...');
  await page.evaluate(() => {
    navigateTo('analisis', 'analisis-chart');
  });
  await new Promise(r => setTimeout(r, 1000));

  const after = await page.evaluate(() => {
    const pAnalisis = document.getElementById('page-analisis');
    const anaCtx = document.querySelector('.ana-ctx');
    const ph = document.querySelector('#panel-tab-analisis .ph');
    const pBandar = document.getElementById('panel-tab-bandarmologi');
    const bandarPh = pBandar ? pBandar.querySelector('.ph') : null;
    return {
      currentPage: typeof currentPage !== 'undefined' ? currentPage : null,
      pAnalisisClass: pAnalisis?.className,
      pAnalisisHidden: pAnalisis?.classList.contains('hidden'),
      pAnalisisDisplay: window.getComputedStyle(pAnalisis)?.display,
      anaCtxDisplay: anaCtx ? window.getComputedStyle(anaCtx)?.display : null,
      anaCtxRect: anaCtx ? anaCtx.getBoundingClientRect() : null,
      bandarPhRect: bandarPh ? bandarPh.getBoundingClientRect() : null,
      bandarPhDisplay: bandarPh ? window.getComputedStyle(bandarPh)?.display : null
    };
  });
  console.log('After nav to analisis:');
  console.log(after);

  await browser.close();
  server.close();
}

debug();
