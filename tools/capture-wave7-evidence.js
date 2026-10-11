'use strict';
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots', 'wave7-evidence');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3049;
const BASE_URL = `http://127.0.0.1:${PORT}`;

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      http.get(url, (res) => {
        resolve();
      }).on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timeout waiting for server at ${url}`));
        } else {
          setTimeout(check, 300);
        }
      });
    }
    check();
  });
}

const TEST_PLANS = [
  {
    id: 'owned_1',
    ticker: 'BBCA',
    entryPriceIdr: 9800,
    stopLossIdr: 9400,
    tp1Idr: 10500,
    tp2Idr: 11000,
    lots: 25,
    riskBudgetIdr: 1000000,
    estimatedMaxLossIdr: 1000000,
    capitalIdr: 24500000,
    createdAt: '2026-10-01T08:00:00.000Z',
    source: 'owned_position',
    positionStatus: 'OWNED'
  },
  {
    id: 'owned_2',
    ticker: 'BMRI',
    entryPriceIdr: 6800,
    stopLossIdr: 6400,
    tp1Idr: 7400,
    tp2Idr: 7800,
    lots: 30,
    riskBudgetIdr: 1200000,
    estimatedMaxLossIdr: 1200000,
    capitalIdr: 20400000,
    createdAt: '2026-10-02T08:00:00.000Z',
    source: 'owned_position',
    positionStatus: 'OWNED'
  },
  {
    id: 'owned_3',
    ticker: 'ASII',
    entryPriceIdr: 5100,
    stopLossIdr: 4850,
    tp1Idr: 5500,
    tp2Idr: 5800,
    lots: 40,
    riskBudgetIdr: 1000000,
    estimatedMaxLossIdr: 1000000,
    capitalIdr: 20400000,
    createdAt: '2026-10-03T08:00:00.000Z',
    source: 'owned_position',
    positionStatus: 'OWNED'
  }
];

const TEST_PRICES = {
  BBCA: 10300,
  BMRI: 6500,
  ASII: 5100
};

async function run() {
  console.log(`[Wave7B-Evidence] Starting local-dev-server on port ${PORT}...`);
  const serverProcess = spawn('node', ['tools/local-dev-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SUPABASE_URL: '' },
    stdio: 'ignore'
  });

  let browser;
  try {
    await waitForServer(`${BASE_URL}/health`);
    console.log(`[Wave7B-Evidence] local-dev-server ready at ${BASE_URL}`);

    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'x-autocuan-preview': '1' });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().includes('/api/reset-password') && req.method() === 'POST') {
        try {
          const postData = req.postData() ? JSON.parse(req.postData()) : {};
          if (postData.action === 'portfolio-state-load') {
            req.respond({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                success: true,
                state: {
                  plans: TEST_PLANS,
                  prices: TEST_PRICES,
                  price_updated_at: Date.now()
                }
              })
            });
            return;
          }
        } catch (_) {}
      }
      req.continue();
    });

    await page.evaluateOnNewDocument((plans, prices) => {
      localStorage.setItem('autocuan_user', 'budi');
      localStorage.setItem('autocuan_role', 'admin');
      localStorage.setItem('autocuan_is_admin', 'true');
      localStorage.setItem('autocuan_auth', '1');
      localStorage.setItem('autocuan_logged_in', 'true');
      localStorage.setItem('autocuan_username', 'budi');
      localStorage.setItem('autocuan_user_id', 'usr_budi_01');
      localStorage.setItem('auto_cuan_onboarding_seen', 'true');
      localStorage.setItem('has_seen_onboarding', 'true');
      localStorage.setItem('autocuan_onboarding_completed', 'true');
      localStorage.setItem('autocuan_portfolio_plans_local-dev-admin', JSON.stringify(plans));
      localStorage.setItem('autocuan_portfolio_prices_local-dev-admin', JSON.stringify(prices));
      localStorage.setItem('autocuan_portfolio_price_updated_v1_local-dev-admin', String(Date.now()));
      localStorage.setItem('autocuan_portfolio_plans_usr_budi_01', JSON.stringify(plans));
      localStorage.setItem('autocuan_portfolio_prices_usr_budi_01', JSON.stringify(prices));
      localStorage.setItem('autocuan_portfolio_price_updated_v1_usr_budi_01', String(Date.now()));
      document.cookie = 'autocuan_session=test-budi-admin; path=/';
    }, TEST_PLANS, TEST_PRICES);

    async function setLight() {
      await page.evaluate(() => {
        document.documentElement.classList.remove('dark');
        document.documentElement.classList.add('light');
        document.documentElement.setAttribute('data-theme', 'light');
        document.body.classList.remove('dark');
        document.body.removeAttribute('data-theme');
        localStorage.setItem('theme', 'light');
        localStorage.setItem('autocuan_theme', 'light');
        localStorage.setItem('auto_cuan_theme', 'light');
      });
    }

    async function dismissOverlays() {
      await page.evaluate(() => {
        if (typeof window.hideOnboardingGuide === 'function') {
          window.hideOnboardingGuide(true);
        }
        const modal = document.getElementById('accountCenterModal');
        if (modal) {
          modal.classList.add('hidden');
          modal.style.display = 'none';
        }
        const onboarding = document.getElementById('onboardingModal');
        if (onboarding) {
          onboarding.classList.add('hidden');
          onboarding.style.display = 'none';
        }
        const welcome = document.getElementById('welcomeOnboardingModal');
        if (welcome) {
          welcome.classList.add('hidden');
          welcome.style.display = 'none';
        }
        window.premiumAccessState = {
          state: 'ready',
          premium: true,
          isAdmin: true,
          accessLevel: 'admin',
          role: 'admin'
        };
      });
    }

    // 1. Watchlist Mobile (390x844)
    console.log('[Wave7B-Evidence] 1. Capturing wave7b-watchlist-mobile-390x844.png...');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(`${BASE_URL}/dashboard?page=watchlist&preview=1`, { waitUntil: 'networkidle2' });
    await dismissOverlays();
    await setLight();
    await page.evaluate(async () => {
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('watchlist');
      }
      if (typeof window.loadUserWatchlist === 'function') {
        await window.loadUserWatchlist(true);
      }
      await new Promise(r => setTimeout(r, 600));
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave7b-watchlist-mobile-390x844.png') });

    // 2. Track Record Desktop (1440x900)
    console.log('[Wave7B-Evidence] 2. Capturing wave7b-track-record-desktop-1440x900.png...');
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/dashboard?page=trackrecord&preview=1`, { waitUntil: 'networkidle2' });
    await dismissOverlays();
    await setLight();
    await page.evaluate(async () => {
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('trackrecord');
      }
      if (typeof window.loadTrackRecord === 'function') {
        await window.loadTrackRecord(true);
      }
      await new Promise(r => setTimeout(r, 800));
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave7b-track-record-desktop-1440x900.png') });

    // 3. Portfolio Populated Desktop (1440x900)
    console.log('[Wave7B-Evidence] 3. Capturing wave7b-portfolio-populated-desktop-1440x900.png...');
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/dashboard?page=portofolio&preview=1`, { waitUntil: 'networkidle2' });
    await dismissOverlays();
    await setLight();
    await page.evaluate(async (plans, prices) => {
      localStorage.setItem('autocuan_portfolio_plans_local-dev-admin', JSON.stringify(plans));
      localStorage.setItem('autocuan_portfolio_prices_local-dev-admin', JSON.stringify(prices));
      localStorage.setItem('autocuan_portfolio_price_updated_v1_local-dev-admin', String(Date.now()));
      localStorage.setItem('autocuan_portfolio_plans_usr_budi_01', JSON.stringify(plans));
      localStorage.setItem('autocuan_portfolio_prices_usr_budi_01', JSON.stringify(prices));
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('portofolio');
      }
      await new Promise(r => setTimeout(r, 800));
      window.dispatchEvent(new CustomEvent('autocuan:portfolio-changed', { detail: { userId: 'local-dev-admin' } }));
      if (typeof window.openPortfolioTab === 'function') {
        window.openPortfolioTab('watch');
      }
      await new Promise(r => setTimeout(r, 600));
    }, TEST_PLANS, TEST_PRICES);
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave7b-portfolio-populated-desktop-1440x900.png') });

    // 4. Portfolio Populated Mobile (390x844)
    console.log('[Wave7B-Evidence] 4. Capturing wave7b-portfolio-populated-mobile-390x844.png...');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(`${BASE_URL}/dashboard?page=portofolio&preview=1`, { waitUntil: 'networkidle2' });
    await dismissOverlays();
    await setLight();
    await page.evaluate(async (plans, prices) => {
      localStorage.setItem('autocuan_portfolio_plans_local-dev-admin', JSON.stringify(plans));
      localStorage.setItem('autocuan_portfolio_prices_local-dev-admin', JSON.stringify(prices));
      localStorage.setItem('autocuan_portfolio_price_updated_v1_local-dev-admin', String(Date.now()));
      localStorage.setItem('autocuan_portfolio_plans_usr_budi_01', JSON.stringify(plans));
      localStorage.setItem('autocuan_portfolio_prices_usr_budi_01', JSON.stringify(prices));
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('portofolio');
      }
      await new Promise(r => setTimeout(r, 800));
      window.dispatchEvent(new CustomEvent('autocuan:portfolio-changed', { detail: { userId: 'local-dev-admin' } }));
      if (typeof window.openPortfolioTab === 'function') {
        window.openPortfolioTab('watch');
      }
      await new Promise(r => setTimeout(r, 600));
    }, TEST_PLANS, TEST_PRICES);
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'wave7b-portfolio-populated-mobile-390x844.png') });

    console.log('[Wave7B-Evidence] All 4 required screenshots captured successfully!');
  } finally {
    if (browser) await browser.close();
    serverProcess.kill();
  }
}

run().catch((err) => {
  console.error('[Wave7B-Evidence] ERROR:', err);
  process.exit(1);
});
