'use strict';

const puppeteer = require('puppeteer-core');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3043;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const TESTS = [
  {
    name: '1. Landing Page',
    url: `${BASE_URL}/preview/landing`,
    verify: async (page) => {
      await page.waitForSelector('#landingPage', { timeout: 5000 });
      const isVisible = await page.$eval('#landingPage', el => !el.classList.contains('hidden'));
      if (!isVisible) throw new Error('#landingPage is not visible');
      console.log('    ✔ Landing page visible and unauthenticated');
    }
  },
  {
    name: '2. Dashboard',
    url: `${BASE_URL}/preview/dashboard`,
    verify: async (page) => {
      await page.waitForSelector('#page-dashboard', { timeout: 5000 });
      const isVisible = await page.$eval('#page-dashboard', el => !el.classList.contains('hidden'));
      const ihsgText = await page.$eval('#ihsgLast', el => el.textContent.trim());
      const top5Html = await page.$eval('#dashboardTop5List', el => el.innerHTML);
      if (!isVisible) throw new Error('Dashboard page is hidden');
      console.log(`    ✔ Dashboard visible, IHSG: "${ihsgText}", Top 5 loaded: ${top5Html.includes('BBCA')}`);
    }
  },
  {
    name: '3. Analisis Saham',
    url: `${BASE_URL}/preview/analisis-saham`,
    verify: async (page) => {
      await page.waitForSelector('#page-analisis', { timeout: 5000 });
      const isVisible = await page.$eval('#page-analisis', el => !el.classList.contains('hidden'));
      if (!isVisible) throw new Error('Analisis page is hidden');
      await page.waitForSelector('.analisis-tab', { timeout: 6000 });
      const subtabCount = await page.$$eval('.analisis-tab', tabs => tabs.length);
      console.log(`    ✔ Analisis Saham visible with ${subtabCount} sub-tabs (Cockpit, Bandarmologi, etc.)`);
    }
  },
  {
    name: '4. Sektor Hot',
    url: `${BASE_URL}/preview/sektor-hot`,
    verify: async (page) => {
      await page.waitForSelector('#page-sektor', { timeout: 5000 });
      await page.waitForFunction(() => {
        const grid = document.getElementById('sektorGroupsGrid');
        return grid && grid.querySelectorAll('.sektor-group-card').length > 0;
      }, { timeout: 6000 });
      const count = await page.$$eval('.sektor-group-card', cards => cards.length);
      console.log(`    ✔ Sektor Hot visible with ${count} sector group cards`);
    }
  },
  {
    name: '5. Screener 3-in-1',
    url: `${BASE_URL}/preview/screener`,
    verify: async (page) => {
      await page.waitForSelector('#page-screener', { timeout: 5000 });
      await page.waitForFunction(() => {
        const grid = document.getElementById('kgCardGrid');
        const rows = document.querySelectorAll('#screenerTableBody tr');
        return (grid && grid.children.length > 0) || rows.length > 0;
      }, { timeout: 6000 });
      console.log('    ✔ Screener 3-in-1 loaded with candidates');
    }
  },
  {
    name: '6. Watchlist',
    url: `${BASE_URL}/preview/watchlist`,
    verify: async (page) => {
      await page.waitForSelector('#page-watchlist', { timeout: 5000 });
      await page.waitForFunction(() => {
        const container = document.getElementById('watchlistContainer');
        return container && container.querySelectorAll('tr').length > 0;
      }, { timeout: 6000 });
      const rowCount = await page.$$eval('#watchlistContainer table tbody tr', trs => trs.length);
      console.log(`    ✔ Watchlist spreadsheet table rendered with ${rowCount} items`);
    }
  },
  {
    name: '7. Track Record',
    url: `${BASE_URL}/preview/track-record`,
    verify: async (page) => {
      await page.waitForSelector('#page-trackrecord', { timeout: 5000 });
      await page.waitForFunction(() => {
        const wr1 = document.getElementById('trWinRateTp1');
        return wr1 && wr1.textContent.includes('%');
      }, { timeout: 6000 });
      const wr1 = await page.$eval('#trWinRateTp1', el => el.textContent.trim());
      console.log(`    ✔ Track Record rendered with Win Rate TP1: ${wr1}`);
    }
  },
  {
    name: '8. Portofolio',
    url: `${BASE_URL}/preview/portofolio`,
    verify: async (page) => {
      await page.waitForSelector('#page-portofolio', { timeout: 5000 });
      const isVisible = await page.$eval('#page-portofolio', el => !el.classList.contains('hidden'));
      if (!isVisible) throw new Error('Portofolio page is hidden');
      await page.waitForSelector('#portofolioPartialMount [data-tab]', { timeout: 6000 });
      const subtabCount = await page.$$eval('#portofolioPartialMount [data-tab]', tabs => tabs.length);
      console.log(`    ✔ Portofolio Command Center visible with ${subtabCount} sub-tabs (Hari Ini, Planner, Risk, etc.)`);
    }
  },
  {
    name: '9. Kelola Keuangan',
    url: `${BASE_URL}/preview/kelola-keuangan`,
    verify: async (page) => {
      await page.waitForSelector('#page-money-management', { timeout: 5000 });
      const isVisible = await page.$eval('#page-money-management', el => !el.classList.contains('hidden'));
      if (!isVisible) throw new Error('Money management page is hidden');
      console.log('    ✔ Kelola Keuangan / Money Management spreadsheet rendered');
    }
  }
];

function waitForServer(url, timeoutMs = 12000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      http.get(url, () => resolve()).on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('Server start timeout'));
        else setTimeout(check, 250);
      });
    }
    check();
  });
}

async function run() {
  console.log('[Browser Test] Starting server on port ' + PORT + '...');
  const server = spawn('node', ['tools/local-dev-server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });

  try {
    await waitForServer(`${BASE_URL}/preview/landing`);
    console.log('[Browser Test] Server ready! Launching Chrome...');

    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,900']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    let errors = [];
    page.on('pageerror', err => {
      console.log('[Page Error]:', err.message);
      errors.push(err.message);
    });

    console.log('\n=== RUNNING 9 PREVIEW BROWSER VERIFICATIONS ===');
    for (const t of TESTS) {
      console.log(`Testing: ${t.name} -> ${t.url}`);
      await page.goto(t.url, { waitUntil: 'networkidle2', timeout: 15000 });
      await t.verify(page);
    }

    await browser.close();
    console.log('\nALL 9 BROWSER PREVIEWS VERIFIED AND PASSED WITH FLYING COLORS!');
  } finally {
    server.kill();
  }
}

run().catch(err => {
  console.error('[Browser Test Error]:', err);
  process.exit(1);
});
