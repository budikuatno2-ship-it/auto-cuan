const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 9914;
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

async function debugParents() {
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
  await page.evaluate(() => navigateTo('analisis', 'analisis-chart'));
  await new Promise(r => setTimeout(r, 1000));

  const chain = await page.evaluate(() => {
    const el = document.querySelector('.ana-ctx');
    const res = [];
    let curr = el;
    while (curr) {
      const st = window.getComputedStyle(curr);
      const r = curr.getBoundingClientRect();
      res.push({
        tag: curr.tagName,
        id: curr.id,
        className: curr.className,
        display: st.display,
        visibility: st.visibility,
        opacity: st.opacity,
        w: r.width,
        h: r.height
      });
      curr = curr.parentElement;
    }
    return res;
  });
  console.log('Parent chain of .ana-ctx:');
  console.log(chain);

  await browser.close();
  server.close();
}

debugParents();
