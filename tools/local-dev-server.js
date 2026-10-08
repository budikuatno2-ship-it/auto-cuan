'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createStaticResponder } = require('../lib/static-assets');

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const API_DIR = path.join(ROOT_DIR, 'api');
const DATA_DIR = path.join(ROOT_DIR, 'data');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch (err) {
    console.warn('[env] Warning: failed to load', filePath, err.message);
  }
}

// BUG-RT-02 — runner-owned runtime env has the HIGHEST precedence.
//
// loadEnvFile() is first-wins, so the runner file is loaded FIRST. The runner
// .env is the canonical production secret store (it is what the cron wrappers
// export and what the PM2 web process was started with); repository files are
// only fallbacks. Previously the daemon loaded .env.local first, so a stale
// repository CRON_SECRET could win over the valid runner secret and the local
// origin answered 401 to the screener runner (BUG-RT-02).
//
//   runner/.env > .env.local > .env.intraday-runtime > .env
//
// On a development machine the runner directory does not exist, so repository
// files keep working exactly as before.
const RUNNER_DIR = process.env.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';
loadEnvFile(path.join(RUNNER_DIR, '.env'));
loadEnvFile(path.join(ROOT_DIR, '.env.local'));
loadEnvFile(path.join(ROOT_DIR, '.env.intraday-runtime'));
loadEnvFile(path.join(ROOT_DIR, '.env'));

// Specialized service env files only fill keys that the shared runtime sources
// above did not provide.
loadEnvFile(path.join(ROOT_DIR, '.env.bot'));
loadEnvFile(path.join(ROOT_DIR, '.env.preview.local'));
loadEnvFile(path.join(ROOT_DIR, '.env.production.local'));
// VPS runner secrets (owner-only, 600) — critical for telegram-verify-webhook-v3
loadEnvFile(path.join(RUNNER_DIR, 'telegram-webhook-v3-secret.env'));
loadEnvFile(path.join(RUNNER_DIR, 'telegram-lifecycle.env'));
loadEnvFile(path.join(RUNNER_DIR, 'telegram-auth-recovery-secret.env'));
loadEnvFile(path.join(RUNNER_DIR, 'session-secret.env'));
loadEnvFile(path.join(ROOT_DIR, '.env.ai-eval-once'));

// BUG-RT-03 — production mock-routing gate (fail-closed).
//
// Every preview/mock interceptor below (preview HTML routes, zero-auth header
// injection, and the endpoint-specific mock responses) is disabled whenever the
// process is production. Production therefore always reaches the canonical
// api/*.js handlers. Development previews remain available only outside a
// production runtime; there is intentionally NO flag that can enable mocks in
// production.
//
// Signals (any one is sufficient):
//   - NODE_ENV=production          (ecosystem.config.js sets this for PM2)
//   - VERCEL_ENV=production        (defensive: Vercel-managed runtimes)
//   - pm_id                        (PM2 always injects this for managed apps)
const IS_PRODUCTION_RUNTIME =
  process.env.NODE_ENV === 'production' ||
  process.env.VERCEL_ENV === 'production' ||
  process.env.pm_id != null;
const PREVIEW_MOCKS_ENABLED = !IS_PRODUCTION_RUNTIME;

const {
  MOCK_IHSG,
  MOCK_LANDING_SNAPSHOT,
  MOCK_DAILY_PICKS,
  MOCK_SECTORS,
  MOCK_SWING_KONGLO,
  MOCK_SWING_NK,
  MOCK_DAYTRADE,
  MOCK_WATCHLIST,
  MOCK_TRACK_RECORD,
  MOCK_MONEY_MANAGEMENT,
  MOCK_BANDARMOLOGI,
  generateMockCandles
} = require('../lib/mock-preview-data');

const PREVIEW_MODULE_MAP = {
  'landing': 'landing',
  'dashboard': 'dashboard',
  'analisis-saham': 'analisis-saham',
  'analisis': 'analisis-saham',
  'sektor-hot': 'sektor-hot',
  'sektor': 'sektor-hot',
  'screener': 'screener',
  'watchlist': 'watchlist',
  'track-record': 'track-record',
  'trackrecord': 'track-record',
  'portofolio': 'portofolio',
  'portfolio': 'portofolio',
  'kelola-keuangan': 'kelola-keuangan',
  'money-management': 'kelola-keuangan'
};

function getPreviewInjectionHtml(module, options = {}) {
  const hideBar = Boolean(options.hideBar);
  return `
  <!-- AUTO-CUAN PREVIEW ZERO-AUTH BOOTSTRAP — QA & DEV SERVER ONLY (NEVER IN PRODUCTION) -->
  <style id="autocuan-preview-style">
    /* ── TOP MOCK-STATE BANNER ─────────────────────────────────────── */
    #autocuan-mock-banner {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 22px;
      line-height: 22px;
      box-sizing: border-box;
      z-index: 999998;
      background: rgba(234, 179, 8, 0.92);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: #1c1917;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-align: center;
      padding: 0 48px 0 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
      user-select: none;
    }
    #autocuan-mock-banner .mock-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      line-height: 22px;
    }
    #autocuan-mock-banner .mock-sep {
      opacity: 0.5;
      margin: 0 6px;
    }
    /* Push app content down so it's not hidden behind the 22px banner */
    body { padding-top: 22px !important; }

    /* Fix sidebar offset: sticky sidebar bottom must not exceed viewport */
    #sidebar, #appSidebar, .app-sidebar {
      top: 22px !important;
      height: calc(100dvh - 22px) !important;
      max-height: calc(100dvh - 22px) !important;
    }

    /* ── BOTTOM NAV PILL ────────────────────────────────────────────── */
    #autocuan-preview-bar {
      position: fixed;
      bottom: 14px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 999999;
      background: rgba(14, 21, 36, 0.94);
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 9999px;
      box-shadow: 0 10px 30px -5px rgba(0,0,0,0.6), 0 0 16px rgba(34, 197, 94, 0.20);
      padding: 6px 14px;
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 11px;
      color: #e2e8f0;
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      max-width: 96vw;
      overflow-x: auto;
      white-space: nowrap;
    }
    #autocuan-preview-bar .preview-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-weight: 700;
      color: #22c55e;
      padding-right: 6px;
      border-right: 1px solid rgba(255, 255, 255, 0.15);
    }
    #autocuan-preview-bar .preview-badge-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #22c55e;
      box-shadow: 0 0 6px #22c55e;
    }
    #autocuan-preview-bar a {
      color: #94a3b8;
      text-decoration: none;
      padding: 3px 7px;
      border-radius: 6px;
      font-weight: 500;
      transition: all 0.15s ease;
    }
    #autocuan-preview-bar a:hover {
      color: #f8fafc;
      background: rgba(255, 255, 255, 0.08);
    }
    #autocuan-preview-bar a.active {
      color: #ffffff;
      background: #2563eb;
      font-weight: 600;
    }
    #autocuan-preview-bar .close-btn {
      background: none;
      border: none;
      color: #64748b;
      font-size: 14px;
      cursor: pointer;
      padding: 0 4px;
      margin-left: 4px;
      line-height: 1;
    }
    #autocuan-preview-bar .close-btn:hover {
      color: #f8fafc;
    }

    @media (max-width: 768px) {
      #autocuan-preview-bar {
        bottom: 8px;
        padding: 4px 8px;
        font-size: 10px;
        gap: 4px;
        max-width: 98vw;
      }
      #autocuan-preview-bar a {
        padding: 2px 5px;
      }
      body:has(#autocuan-preview-bar) {
        padding-bottom: 56px !important;
      }
    }
  </style>

  <!-- MOCK STATE BANNER (top) -->
  <div id="autocuan-mock-banner">
    <span class="mock-pill">
      ⚠️ PREVIEW
      <span class="mock-sep">·</span>
      DATA CONTOH / MOCK STATE — bukan data produksi
      <span class="mock-sep">·</span>
      Modul: <strong>${module.toUpperCase()}</strong>
      <span class="mock-sep">·</span>
      User: budi (ADMIN)
    </span>
  </div>

  <script id="autocuan-preview-script">
  (function() {
    // ── SECURITY ISOLATION: Mock auth state is set HERE (dev injection),
    // NOT in public/subscription-access-gate-v1.js (production file).
    // This script tag is inserted BEFORE <body> content by the dev server,
    // so it runs before any production JS including the subscription gate.
    window.__AUTOCUAN_PREVIEW_MODE__ = true;
    window.__AUTOCUAN_PREVIEW_MODULE__ = '${module}';
    window.__AUTOCUAN_PREVIEW_USER__ = { name: 'budi', username: 'budi', role: 'ADMIN', approved: true };

    // Set premiumAccessState IMMEDIATELY so the production gate's early-exit
    // path (if (window.__AUTOCUAN_SUBSCRIPTION_ACCESS_GATE_V1__) return) is
    // never reached with a blank state. The gate is not bypassed — it simply
    // finds the state already populated and calls setState() over our value.
    if ('${module}' === 'landing') {
      try {
        localStorage.removeItem('autocuan_logged_in');
        localStorage.removeItem('autocuan_session');
        localStorage.removeItem('autocuan_user');
        localStorage.removeItem('autocuan_role');
        localStorage.removeItem('autocuan_entered_app');
        localStorage.removeItem('autocuan_is_admin');
        localStorage.removeItem('autocuan_user_id');
        sessionStorage.clear();
      } catch (_) {}
      window.openAuthChoiceModal = function() {};
      window.openLoginModal = function() {};
      window.premiumAccessState = {
        state: 'ready', premium: false, accessLevel: 'free',
        checkedAt: Date.now(), expiresAt: null,
        subscriptionRequired: false, approved: false
      };
    } else {
      try {
        localStorage.setItem('autocuan_user', 'budi');
        localStorage.setItem('autocuan_role', 'ADMIN');
        localStorage.setItem('autocuan_session', JSON.stringify({ name: 'budi', username: 'budi', role: 'ADMIN', approved: true }));
        localStorage.setItem('autocuan_logged_in', 'true');
        localStorage.setItem('autocuan_is_admin', 'true');
        localStorage.setItem('autocuan_user_id', 'admin-budi-id');
        localStorage.setItem('autocuan_sidebar_collapsed', '0');
        localStorage.setItem('auto_cuan_onboarding_seen', 'true');
        localStorage.setItem('autocuan_entered_app', 'true');
        if (!localStorage.getItem('autocuan_portfolio_positions') || localStorage.getItem('autocuan_portfolio_positions') === '[]') {
          localStorage.setItem('autocuan_portfolio_positions', JSON.stringify([
            { ticker: 'BBCA', shares: 5000, avgPrice: 10100, currentPrice: 10250, targetPrice: 10950, stopLoss: 9950, entryDate: '2026-09-20', strategy: 'Swing Konglomerat', notes: 'Kandidat Top 5 Radar' },
            { ticker: 'MEDC', shares: 15000, avgPrice: 1380, currentPrice: 1420, targetPrice: 1540, stopLoss: 1350, entryDate: '2026-09-24', strategy: 'Day Trade Momentum', notes: 'Akumulasi broker asing' },
            { ticker: 'TLKM', shares: 8000, avgPrice: 3120, currentPrice: 3150, targetPrice: 3350, stopLoss: 3020, entryDate: '2026-09-22', strategy: 'Swing Non-Konglomerat', notes: 'Undervalued dividend play' }
          ]));
        }
      } catch (_) {}
      // Full admin premium state — same structure used by production gate
      window.premiumAccessState = {
        state: 'ready', premium: true, accessLevel: 'admin',
        checkedAt: Date.now(), expiresAt: null,
        subscriptionRequired: false, approved: true,
        trialState: 'active', currentPlan: 'admin'
      };
    }

    // Intercept fetch to add preview headers
    var _origFetch = window.fetch;
    window.fetch = function(url, opts) {
      opts = opts || {};
      opts.headers = opts.headers || {};
      if (typeof opts.headers.set === 'function') {
        opts.headers.set('X-AutoCuan-Preview', '1');
        opts.headers.set('X-Username', 'budi');
        opts.headers.set('X-User-Id', 'admin-budi-id');
      } else if (Array.isArray(opts.headers)) {
        opts.headers.push(['X-AutoCuan-Preview', '1']);
        opts.headers.push(['X-Username', 'budi']);
        opts.headers.push(['X-User-Id', 'admin-budi-id']);
      } else {
        opts.headers['X-AutoCuan-Preview'] = '1';
        opts.headers['X-Username'] = 'budi';
        opts.headers['X-User-Id'] = 'admin-budi-id';
      }
      return _origFetch.call(this, url, opts);
    };

    function initPreviewNavigation() {
      var om = document.getElementById('onboardingModal');
      if (om) om.style.display = 'none';

      if ('${module}' === 'landing') {
        var appEl = document.getElementById('app');
        var lpEl = document.getElementById('landingPage');
        if (appEl) appEl.classList.add('hidden');
        if (lpEl) lpEl.classList.remove('hidden');
        if (typeof setWorkspaceSidebarVisible === 'function') setWorkspaceSidebarVisible(false);
        if (typeof initLandingPage === 'function') initLandingPage();
        if (typeof loadLandingShowcase === 'function') loadLandingShowcase();
        return;
      }

      if (typeof setWorkspaceSidebarVisible === 'function') setWorkspaceSidebarVisible(true);
      if (typeof applyPremiumAccessUi === 'function') applyPremiumAccessUi();
      if (typeof syncHeaderUsername === 'function') syncHeaderUsername();

      var mod = '${module}';
      if (mod === 'dashboard') {
        if (typeof navigateTo === 'function') navigateTo('dashboard');
      } else if (mod === 'analisis-saham') {
        if (typeof navigateTo === 'function') navigateTo('analisis', 'analisis-chart');
        setTimeout(function() {
          if (typeof switchAnalisisTab === 'function') switchAnalisisTab('cockpit');
        }, 80);
      } else if (mod === 'sektor-hot') {
        if (typeof navigateTo === 'function') navigateTo('sektor');
      } else if (mod === 'screener') {
        if (typeof navigateTo === 'function') navigateTo('screener');
      } else if (mod === 'watchlist') {
        if (typeof navigateTo === 'function') navigateTo('watchlist');
      } else if (mod === 'track-record') {
        if (typeof navigateTo === 'function') navigateTo('trackrecord');
      } else if (mod === 'portofolio') {
        var gate = document.getElementById('accessGate');
        if (gate) gate.classList.add('hidden');
        var appPort = document.getElementById('app');
        if (appPort) appPort.classList.remove('hidden');
        if (typeof navigateTo === 'function') navigateTo('portofolio', 'today');
        setTimeout(function() {
          if (typeof openPortfolioTab === 'function') openPortfolioTab('today');
        }, 120);
      } else if (mod === 'kelola-keuangan') {
        if (typeof navigateTo === 'function') navigateTo('money-management');
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() {
        setTimeout(initPreviewNavigation, 30);
      });
    } else {
      setTimeout(initPreviewNavigation, 30);
    }
  })();
  </script>

  ${hideBar ? '' : `
  <div id="autocuan-preview-bar">
    <span class="preview-badge"><span class="preview-badge-dot"></span> Preview</span>
    <a href="/preview/landing" class="${module === 'landing' ? 'active' : ''}">1. Landing</a>
    <a href="/preview/dashboard" class="${module === 'dashboard' ? 'active' : ''}">2. Dashboard</a>
    <a href="/preview/analisis-saham" class="${module === 'analisis-saham' ? 'active' : ''}">3. Analisis Saham</a>
    <a href="/preview/sektor-hot" class="${module === 'sektor-hot' ? 'active' : ''}">4. Sektor Hot</a>
    <a href="/preview/screener" class="${module === 'screener' ? 'active' : ''}">5. Screener</a>
    <a href="/preview/watchlist" class="${module === 'watchlist' ? 'active' : ''}">6. Watchlist</a>
    <a href="/preview/track-record" class="${module === 'track-record' ? 'active' : ''}">7. Track Record</a>
    <a href="/preview/portofolio" class="${module === 'portofolio' ? 'active' : ''}">8. Portofolio</a>
    <button class="close-btn" onclick="document.getElementById('autocuan-preview-bar').remove()" title="Tutup preview toolbar">&times;</button>
  </div>
  `}
  `;
}


const MIME_TYPES = {

  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

const servePublic = createStaticResponder({ rootDir: PUBLIC_DIR, mimeTypes: MIME_TYPES });
const serveData = createStaticResponder({ rootDir: DATA_DIR, mimeTypes: MIME_TYPES, maxBytes: 2*1024*1024 });

const ROUTE_REWRITES = {
  '/': '/index.html',
  '/dashboard': '/index.html',
  '/screener': '/index.html',
  '/watchlist': '/index.html',
  '/sektor': '/index.html',
  '/trackrecord': '/index.html',
  '/pattern': '/index.html',
  '/review': '/index.html',
  '/analisis-saham': '/analisis-saham.html',
  // FASE 9: the shell embeds the Portfolio Command Center at this exact path,
  // so the rewrite must exist for both the dev server and the VPS fallback.
  '/portfolio-command-center': '/portfolio-command-center.html',
  '/portfolio-planner': '/portfolio-command-center-v2.html',
  '/kelola-keuangan': '/index.html',
  '/money-management': '/index.html',
  // Public BYOK registration form (mirrors the Vercel rewrite so the VPS
  // fallback serves the same URL shape).
  '/register': '/register.html',
  // FASE 2: broker-summary ("broksum") and chart viewers. Both are real views of
  // pages that already resolve their initial state from the query string, so
  // these short paths only need to map to the right page + default tab. The tab
  // selection stays the SPA's own contract (`?ticker=` / `?tab=` / `?page=`).
  '/broksum': '/analisis-saham.html',
  '/broker-summary': '/analisis-saham.html',
  '/bandarmologi': '/analisis-saham.html',
  '/chart': '/index.html'
};

// Default query params merged in at rewrite time for the short paths above.
// An explicit caller-supplied param always wins, so /broksum?tab=intel still
// opens the intel tab instead of the bandarmologi default.
const ROUTE_DEFAULT_QUERY = {
  '/broksum': { tab: 'bandarmologi' },
  '/broker-summary': { tab: 'bandarmologi' },
  '/bandarmologi': { tab: 'bandarmologi' },
  '/chart': { page: 'chart' }
};

async function parseBody(req) {
  if (req._parsedBody !== undefined) return req._parsedBody;
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  if (raw.length === 0) {
    req._parsedBody = {};
    return {};
  }
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  if (contentType.includes('application/json')) {
    try {
      req._parsedBody = JSON.parse(raw.toString('utf8'));
      return req._parsedBody;
    } catch {
      req._parsedBody = raw.toString('utf8');
      return req._parsedBody;
    }
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw.toString('utf8'));
    const result = {};
    for (const [k, v] of params.entries()) {
      result[k] = v;
    }
    req._parsedBody = result;
    return result;
  }
  req._parsedBody = raw.toString('utf8');
  return req._parsedBody;
}

function decorateResponse(res) {
  res.status = function(code) {
    res.statusCode = code;
    return res;
  };
  res.json = function(data) {
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify(data));
    return res;
  };
  res.send = function(data) {
    if (typeof data === 'object' && !Buffer.isBuffer(data)) {
      return res.json(data);
    }
    res.end(data);
    return res;
  };
}

const server = http.createServer(async (req, res) => {
  decorateResponse(res);
  const parsedUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  let pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Telegram-Bot-Api-Secret-Token');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  // 0. Production fail-closed: preview HTML and API mocks never exist here.
  // Without this, /preview/<module> serves a page that seeds client-side admin
  // state (window.__AUTOCUAN_PREVIEW_USER__ = budi/ADMIN) to any visitor.
  if (!PREVIEW_MOCKS_ENABLED && (pathname === '/preview' || pathname.startsWith('/preview/'))) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('Not Found');
  }

  // 0. Handle Mock Preview Routes (/preview/<module>)
  if (pathname === '/preview' || pathname === '/preview/') {
    res.statusCode = 302;
    res.setHeader('Location', '/preview/dashboard');
    return res.end();
  }

  if (pathname.startsWith('/preview/')) {
    const rawSub = pathname.slice('/preview/'.length).replace(/\/$/, '');
    const moduleName = PREVIEW_MODULE_MAP[rawSub];
    if (!moduleName) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Preview Not Found - Auto-Cuan</title></head>
        <body style="font-family:sans-serif;background:#090d14;color:#f0f4fc;padding:40px;">
          <h2>Preview Modul '${rawSub}' Tidak Ditemukan</h2>
          <p>Silakan pilih salah satu dari 8 modul preview berikut:</p>
          <ol>
            <li><a style="color:#10b981;" href="/preview/landing">/preview/landing</a> (Landing Page Publik)</li>
            <li><a style="color:#10b981;" href="/preview/dashboard">/preview/dashboard</a> (Dashboard Utama)</li>
            <li><a style="color:#10b981;" href="/preview/analisis-saham">/preview/analisis-saham</a> (Analisis Saham - 7 Sub-tab)</li>
            <li><a style="color:#10b981;" href="/preview/sektor-hot">/preview/sektor-hot</a> (Sektor Hot)</li>
            <li><a style="color:#10b981;" href="/preview/screener">/preview/screener</a> (Screener 3-in-1)</li>
            <li><a style="color:#10b981;" href="/preview/watchlist">/preview/watchlist</a> (Watchlist Spreadsheet)</li>
            <li><a style="color:#10b981;" href="/preview/track-record">/preview/track-record</a> (Track Record Sinyal)</li>
            <li><a style="color:#10b981;" href="/preview/portofolio">/preview/portofolio</a> (Portofolio - 7 Sub-tab)</li>
          </ol>
        </body>
        </html>
      `);
    }

    const hideBar = req.headers['x-autocuan-hide-preview-bar'] === '1' || parsedUrl.searchParams.get('nobar') === '1';
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    let html = fs.readFileSync(indexPath, 'utf8');
    const injection = getPreviewInjectionHtml(moduleName, { hideBar });
    html = html.replace('</head>', injection + '\n</head>');

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(html);
  }

  // 1. Handle API routes
  if (pathname.startsWith('/api/')) {
    let endpointName = pathname.slice('/api/'.length).replace(/\.js$/, '');

    // Alias: /api/track-record -> sector-hot?action=track-record.
    if (endpointName === 'track-record') {
      parsedUrl.searchParams.set('action', 'track-record');
      endpointName = 'sector-hot';
      pathname = '/api/sector-hot';
    }

    // Detect if this is a preview request or needs mock data.
    // BUG-RT-03: the client-controllable preview signals only count while the
    // development preview boundary is active; in production this is always false.
    const isPreview = PREVIEW_MOCKS_ENABLED && Boolean(
      (req.headers.referer && (req.headers.referer.includes('/preview') || req.headers.referer.includes('preview=1'))) ||
      req.headers['x-autocuan-preview'] === '1' ||
      parsedUrl.searchParams.get('preview') === '1'
    );

    // ZERO-AUTH: When preview is active, bypass session checks and inject dummy admin identity
    if (isPreview) {
      req.headers['x-user-id'] = req.headers['x-user-id'] || 'admin-budi-id';
      req.headers['x-username'] = req.headers['x-username'] || 'budi';
      req.headers['x-role'] = req.headers['x-role'] || 'ADMIN';
      if (!req.headers.cookie || !req.headers.cookie.includes('ac_sess=')) {
        req.headers.cookie = (req.headers.cookie ? req.headers.cookie + '; ' : '') + 'ac_sess=preview-budi-session';
      }
    }

    // Money management mock (development only — BUG-RT-03)
    if (endpointName === 'money-management') {
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      req.body = await parseBody(req);
      const action = req.query.action || (req.body && req.body.action) || 'summary';
      if (PREVIEW_MOCKS_ENABLED && (isPreview || !process.env.SUPABASE_URL)) {
        if (action === 'get-cashflow') {
          return res.status(200).json({ success: true, data: MOCK_MONEY_MANAGEMENT.cashflow });
        }
        if (action === 'get-journal') {
          return res.status(200).json({ success: true, data: MOCK_MONEY_MANAGEMENT.journal });
        }
        if (action === 'summary') {
          return res.status(200).json({ success: true, data: MOCK_MONEY_MANAGEMENT.summary });
        }
        if (action === 'save-cashflow' || action === 'save-journal' || action === 'delete-journal') {
          return res.status(200).json({ success: true, message: 'Saved in mock preview mode' });
        }
      }
      const mmHandler = require('../lib/money-management-handler');
      return await mmHandler(req, res);
    }

    // Bypass maintenance screen on local dev server (development only — BUG-RT-03).
    // In production the canonical handler reads the real state from app_settings.
    if (PREVIEW_MOCKS_ENABLED && endpointName === 'maintenance-settings') {
      return res.status(200).json({
        success: true,
        maintenance: false,
        operational: true,
        config: {
          maintenanceMode: false,
          message: ''
        },
        adminCode: { available: false, active: false, expiresAt: null }
      });
    }

    // Support local admin / portfolio session authorization for SPA verification
    // (development only — BUG-RT-03). In production the request falls through to
    // the canonical api/admin-users.js handler, which requires a signed session.
    if (PREVIEW_MOCKS_ENABLED && endpointName === 'admin-users') {
      const isLandingPreview = Boolean(
        (req.headers.referer && req.headers.referer.includes('/preview/landing')) ||
        (parsedUrl.searchParams.get('module') === 'landing') ||
        (req.headers['x-preview-module'] === 'landing')
      );
      if (isLandingPreview) {
        return res.status(401).json({ success: false, error: 'Unauthorized in landing preview' });
      }
      return res.status(200).json({
        success: true,
        allowed: true,
        access: 'admin',
        user_id: 'admin-budi-id',
        username: 'budi',
        role: 'ADMIN',
        is_approved: true,
        is_blocked: false,
        isAdmin: true,
        expires_at: new Date(Date.now() + 86400000).toISOString()
      });
    }

    // Reset-password endpoint mock for session status and account profile
    // (development only — BUG-RT-03).
    if (PREVIEW_MOCKS_ENABLED && endpointName === 'reset-password') {
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      req.body = await parseBody(req);
      const action = req.query.action || (req.body && req.body.action) || '';

      const isLandingPreview = Boolean(
        (req.headers.referer && req.headers.referer.includes('/preview/landing')) ||
        (parsedUrl.searchParams.get('module') === 'landing')
      );

      if (isLandingPreview) {
        if (action === 'session-status') {
          return res.status(200).json({ success: true, valid: false, userId: null, username: 'guest' });
        }
        if (action === 'account-profile') {
          return res.status(200).json({ success: true, profile: null, authenticated: false });
        }
        return res.status(200).json({ success: true, guest: true });
      }

      if (isPreview || !process.env.SUPABASE_URL) {
        if (action === 'session-status') {
          return res.status(200).json({
            success: true,
            userId: 'admin-budi-id',
            username: 'budi',
            role: 'ADMIN',
            isAdmin: true,
            isApproved: true,
            isReview: false
          });
        }
        if (action === 'account-profile') {
          return res.status(200).json({
            success: true,
            profile: {
              username: 'budi',
              role: 'ADMIN',
              is_admin: true,
              is_approved: true,
              subscription: {
                entitlement: {
                  premium: true,
                  access_level: 'admin',
                  expires_at: null,
                  trial_state: 'active',
                  current_plan: 'admin'
                }
              }
            }
          });
        }
        if (action === 'portfolio-state-load') {
          return res.status(200).json({
            success: true,
            state: {
              positions: [
                { ticker: 'BBCA', shares: 5000, avgPrice: 10100, currentPrice: 10250, targetPrice: 10950, stopLoss: 9950, entryDate: '2026-09-20', strategy: 'Swing Konglomerat', notes: 'Kandidat Top 5 Radar' },
                { ticker: 'MEDC', shares: 15000, avgPrice: 1380, currentPrice: 1420, targetPrice: 1540, stopLoss: 1350, entryDate: '2026-09-24', strategy: 'Day Trade Momentum', notes: 'Akumulasi broker asing' },
                { ticker: 'TLKM', shares: 8000, avgPrice: 3120, currentPrice: 3150, targetPrice: 3350, stopLoss: 3020, entryDate: '2026-09-22', strategy: 'Swing Non-Konglomerat', notes: 'Undervalued dividend play' }
              ]
            }
          });
        }
      }
    }

    // Review access mock (development only — BUG-RT-03). In production the
    // canonical api/review-access.js handler answers (405 for GET, token-gated
    // POST otherwise).
    if (PREVIEW_MOCKS_ENABLED && endpointName === 'review-access') {
      return res.status(200).json({
        success: true,
        access: 'approved',
        role: 'ADMIN',
        user: 'budi',
        isApproved: true
      });
    }

    // Analyze status & AI analysis mock (development only — BUG-RT-03)
    if (PREVIEW_MOCKS_ENABLED && endpointName === 'analyze') {
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      req.body = await parseBody(req);
      if (req.query.action === 'status') {
        return res.status(200).json({
          success: true,
          hasAppKey: true,
          hasPersonalKey: true,
          effectiveKeySource: 'server_app',
          status: 'ready'
        });
      }
      if (isPreview || !process.env.GEMINI_API_KEY) {
        const ticker = (req.body && req.body.ticker) || 'BBCA';
        return res.status(200).json({
          success: true,
          analysis: `### Analisis AI Cockpit: ${ticker} (Bank Central Asia Tbk.)\n\n- **Tren & Struktur**: Uptrend solid, bertahan di atas MA20 (10.150). Struktur akumulasi konsisten.\n- **Bandarmologi**: Broker summary mencatat Net Accumulation sebesar Rp 142.5 Miliar (Top Buyer: ZP, CC).\n- **Trading Plan**:\n  - Entry Area: 10.150 - 10.250\n  - Target Price 1: 10.550 (+2.9%)\n  - Target Price 2: 10.950 (+6.8%)\n  - Stop Loss: 9.950 (-2.9%)\n- **Kesimpulan**: Setup Swing Konglomerat menarik dengan Risk/Reward 1:2.3.`,
          ticker: ticker,
          score: 85,
          effectiveKeySource: 'mock_preview'
        });
      }
    }

    // Dev fallback for approval-based portfolio access (development only — BUG-RT-03)
    if (PREVIEW_MOCKS_ENABLED && endpointName === 'admin-users') {
      const parsedBody = await parseBody(req);
      if (parsedBody && parsedBody.action === 'portfolio_access') {
        return res.status(200).json({
          success: true,
          user_id: 'local-dev-admin',
          username: 'budi',
          is_approved: true,
          is_admin: true
        });
      }
    }

    // Login user mock (development only — BUG-RT-03). In production a magic-login
    // request reaches the canonical api/login-user.js handler, which validates the
    // single-use Telegram token before issuing anything.
    if (endpointName === 'login-user') {
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      if (PREVIEW_MOCKS_ENABLED && (isPreview || req.query.action === 'magic-login')) {
        return res.status(200).json({
          success: true,
          user: { username: 'budi', role: 'ADMIN', approved: true }
        });
      }
    }

    // Dev fallback for subscription access profile (development only — BUG-RT-03)
    if (PREVIEW_MOCKS_ENABLED && endpointName === 'reset-password') {
      const parsedBody = await parseBody(req);
      if (parsedBody && parsedBody.action === 'account-profile') {
        return res.status(200).json({
          success: true,
          profile: {
            username: 'budi',
            is_admin: true,
            is_approved: true,
            subscription: {
              entitlement: {
                premium: true,
                access_level: 'admin'
              }
            }
          }
        });
      }
    }

    // Candles API mock for preview (development only — BUG-RT-03)
    if (endpointName === 'candles') {
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      const ticker = (req.query.ticker || 'BBCA').toUpperCase();
      if (PREVIEW_MOCKS_ENABLED && (isPreview || !process.env.SUPABASE_URL)) {
        return res.status(200).json(generateMockCandles(ticker));
      }
    }

    // Quote API mock for preview (development only — BUG-RT-03)
    if (endpointName === 'quote') {
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      const ticker = (req.query.ticker || '').toUpperCase();
      const action = req.query.action || '';
      if (PREVIEW_MOCKS_ENABLED && (isPreview || !process.env.SUPABASE_URL)) {
        if (ticker === 'IHSG') {
          return res.status(200).json(MOCK_IHSG);
        }
        if (action === 'daily-market-context-list') {
          const universeRows = [
            { ticker: 'BBCA', company_name: 'Bank Central Asia Tbk', last_price: 10450, change_pct: 2.45, free_float_pct: 41.82, free_float_source: 'IDX ownership', free_float_as_of: '2026-08-31', hsc_flag: false, hsc_source: 'IDX HSC', hsc_as_of: '2026-09-01', market_structure_status: 'STRUCTURE_VERIFIED', market_structure_guard: 'NORMAL', market_structure_note: 'Free float aman di atas 15%, HSC clear.', as_of_trade_date: '2026-10-07' },
            { ticker: 'BREN', company_name: 'Barito Renewables Energy Tbk', last_price: 6850, change_pct: -1.25, free_float_pct: 11.75, free_float_source: 'IDX ownership', free_float_as_of: '2026-08-31', hsc_flag: true, hsc_source: 'IDX HSC', hsc_as_of: '2026-09-01', market_structure_status: 'HIGH_SHAREHOLDING_CONCENTRATION', market_structure_guard: 'CAUTION', market_structure_note: 'HSC terverifikasi aktif; free float di bawah ambang referensi 15%.', as_of_trade_date: '2026-10-07' },
            { ticker: 'CUAN', company_name: 'Petrindo Jaya Kreasi Tbk', last_price: 7200, change_pct: 3.60, free_float_pct: 14.10, free_float_source: 'IDX ownership', free_float_as_of: '2026-08-31', hsc_flag: false, hsc_source: 'IDX HSC', hsc_as_of: '2026-09-01', market_structure_status: 'LOW_FREE_FLOAT', market_structure_guard: 'CAUTION', market_structure_note: 'Free float di bawah 15%; tidak flagged HSC.', as_of_trade_date: '2026-10-07' },
            { ticker: 'AMMN', company_name: 'Amman Mineral Internasional Tbk', last_price: 8900, change_pct: 0.56, free_float_pct: 17.30, free_float_source: 'IDX ownership', free_float_as_of: '2026-08-31', hsc_flag: true, hsc_source: 'IDX HSC', hsc_as_of: '2026-09-01', market_structure_status: 'HIGH_SHAREHOLDING_CONCENTRATION', market_structure_guard: 'CAUTION', market_structure_note: 'HSC terverifikasi aktif oleh bursa.', as_of_trade_date: '2026-10-07' },
            { ticker: 'BMRI', company_name: 'Bank Mandiri (Persero) Tbk', last_price: 6850, change_pct: -0.72, free_float_pct: 39.95, free_float_source: 'IDX ownership', free_float_as_of: '2026-08-31', hsc_flag: false, hsc_source: 'IDX HSC', hsc_as_of: '2026-09-01', market_structure_status: 'STRUCTURE_VERIFIED', market_structure_guard: 'NORMAL', market_structure_note: 'Struktur kepemilikan terverifikasi normal.', as_of_trade_date: '2026-10-07' },
            { ticker: 'GOTO', company_name: 'GoTo Gojek Tokopedia Tbk', last_price: 65, change_pct: 1.56, free_float_pct: 78.40, free_float_source: 'IDX ownership', free_float_as_of: '2026-08-31', hsc_flag: false, hsc_source: 'IDX HSC', hsc_as_of: '2026-09-01', market_structure_status: 'STRUCTURE_VERIFIED', market_structure_guard: 'NORMAL', market_structure_note: 'Free float sangat tinggi, tidak flagged HSC.', as_of_trade_date: '2026-10-07' },
            { ticker: 'DATA', company_name: 'Duta Pertiwi Nusantara Tbk', last_price: 450, change_pct: 0.00, free_float_pct: null, free_float_source: null, free_float_as_of: null, hsc_flag: null, hsc_source: null, hsc_as_of: null, market_structure_status: 'DATA_INCOMPLETE', market_structure_guard: 'UNKNOWN', market_structure_note: 'Data struktur kepemilikan belum lengkap.', as_of_trade_date: '2026-10-07' },
            { ticker: 'MEDC', company_name: 'Medco Energi Internasional Tbk', last_price: 1420, change_pct: 1.43, free_float_pct: 48.20, free_float_source: 'IDX ownership', free_float_as_of: '2026-08-31', hsc_flag: false, hsc_source: 'IDX HSC', hsc_as_of: '2026-09-01', market_structure_status: 'STRUCTURE_VERIFIED', market_structure_guard: 'NORMAL', market_structure_note: 'Struktur kepemilikan terverifikasi normal.', as_of_trade_date: '2026-10-07' },
            { ticker: 'BRPT', company_name: 'Barito Pacific Tbk', last_price: 1050, change_pct: 0.96, free_float_pct: 28.50, free_float_source: 'IDX ownership', free_float_as_of: '2026-08-31', hsc_flag: false, hsc_source: 'IDX HSC', hsc_as_of: '2026-09-01', market_structure_status: 'STRUCTURE_VERIFIED', market_structure_guard: 'NORMAL', market_structure_note: 'Struktur kepemilikan terverifikasi normal.', as_of_trade_date: '2026-10-07' },
            { ticker: 'TLKM', company_name: 'Telkom Indonesia Tbk', last_price: 3150, change_pct: -0.63, free_float_pct: 47.90, free_float_source: 'IDX ownership', free_float_as_of: '2026-08-31', hsc_flag: false, hsc_source: 'IDX HSC', hsc_as_of: '2026-09-01', market_structure_status: 'STRUCTURE_VERIFIED', market_structure_guard: 'NORMAL', market_structure_note: 'Struktur kepemilikan terverifikasi normal.', as_of_trade_date: '2026-10-07' },
            { ticker: 'TPIA', company_name: 'Chandra Asri Pacific Tbk', last_price: 8800, change_pct: -0.28, free_float_pct: 7.80, free_float_source: 'IDX ownership', free_float_as_of: '2026-08-31', hsc_flag: true, hsc_source: 'IDX HSC', hsc_as_of: '2026-09-01', market_structure_status: 'HIGH_SHAREHOLDING_CONCENTRATION', market_structure_guard: 'CAUTION', market_structure_note: 'Free float sangat rendah di bawah 10% dan HSC aktif.', as_of_trade_date: '2026-10-07' },
            { ticker: 'WMUU', company_name: 'Widodo Makmur Unggas Tbk', last_price: 50, change_pct: 0.00, free_float_pct: null, free_float_source: null, free_float_as_of: null, hsc_flag: false, hsc_source: 'IDX HSC', hsc_as_of: '2026-09-01', market_structure_status: 'DATA_INCOMPLETE', market_structure_guard: 'UNKNOWN', market_structure_note: 'Free float belum tersedia.', as_of_trade_date: '2026-10-07' }
          ];
          return res.status(200).json({
            success: true,
            count: universeRows.length,
            universe: universeRows,
            rows: universeRows,
            data: universeRows,
            as_of: '2026-10-07',
            updated_at: '2026-10-07T15:45:00.000Z'
          });
        }
        if (action === 'daily-market-context') {
          if (ticker === 'XYZW' || ticker === 'EMPTY') {
            return res.status(200).json({
              success: true,
              context: {
                ticker: ticker,
                as_of: '2026-10-07',
                fundamental: {
                  pbv: null,
                  pbv_as_of_price: null,
                  book_value_per_share: null,
                  shares_outstanding: null,
                  market_cap: null,
                  market_cap_as_of: null,
                  market_cap_source: null,
                  fundamental_period: null,
                  fundamental_source: null,
                  fundamental_updated_at: null
                },
                market_structure: {
                  free_float_pct: null,
                  free_float_source: null,
                  free_float_as_of: null,
                  free_float_available: false,
                  hsc_flag: null,
                  hsc_source: null,
                  hsc_as_of: null,
                  hsc_available: false,
                  low_free_float_reference_pct: 15,
                  low_free_float_risk: null,
                  regulatory_compliance_status: 'NOT_EVALUATED',
                  market_structure_status: 'DATA_INCOMPLETE',
                  market_structure_guard: 'UNKNOWN',
                  market_structure_note: 'Data struktur kepemilikan belum tersedia.',
                  data_available: false
                }
              }
            });
          }
          const isBbca = ticker === 'BBCA' || !ticker;
          const isBmri = ticker === 'BMRI';

          const bbcaStatements = {
            quarterly: {
              periods: ['Q2 2026', 'Q1 2026', 'Q4 2025', 'Q3 2025', 'Q2 2025', 'Q1 2025'],
              income_statement: {
                periods: ['Q2 2026', 'Q1 2026', 'Q4 2025', 'Q3 2025', 'Q2 2025', 'Q1 2025'],
                rows: [
                  { type: 'group', label: 'Pendapatan & Beban Operasional' },
                  { type: 'item', label: 'Pendapatan Bunga Bersih', values: [19520, 18910, 19240, 18450, 17820, 17150], unit: 'idr' },
                  { type: 'item', label: 'Pendapatan Operasional Lainnya', values: [6120, 5840, 6310, 5720, 5490, 5210], unit: 'idr' },
                  { type: 'item', label: 'Beban Operasional Lainnya', values: [-9850, -9420, -10150, -9230, -8950, -8640], unit: 'idr' },
                  { type: 'total', label: 'Laba Operasional', values: [15790, 15330, 15400, 14940, 14360, 13720], unit: 'idr' },
                  { type: 'group', label: 'Laba Bersih & Pajak' },
                  { type: 'item', label: 'Beban Pajak Penghasilan', values: [-3120, -3050, -3080, -2990, -2870, -2740], unit: 'idr' },
                  { type: 'total', label: 'Laba Bersih Periode Berjalan', values: [12670, 12280, 12320, 11950, 11490, 10980], unit: 'idr' },
                  { type: 'item', label: 'Laba per Saham (EPS) - IDR', values: [102.78, 99.61, 99.94, 96.94, 93.21, 89.07], unit: 'number' }
                ]
              },
              balance_sheet: {
                periods: ['Q2 2026', 'Q1 2026', 'Q4 2025', 'Q3 2025', 'Q2 2025', 'Q1 2025'],
                rows: [
                  { type: 'group', label: 'Aset' },
                  { type: 'item', label: 'Kas & Setara Kas', values: [38520, 36410, 39120, 35890, 34210, 32950], unit: 'idr' },
                  { type: 'item', label: 'Penempatan pada Bank Indonesia', values: [112450, 108320, 115200, 104500, 99800, 95200], unit: 'idr' },
                  { type: 'item', label: 'Kredit yang Diberikan (Gross)', values: [865400, 842100, 831200, 805400, 782100, 755300], unit: 'idr' },
                  { type: 'total', label: 'Total Aset', values: [1448200, 1412500, 1408100, 1375400, 1342100, 1305600], unit: 'idr' },
                  { type: 'group', label: 'Liabilitas' },
                  { type: 'item', label: 'Dana Pihak Ketiga (CASA)', values: [952400, 931200, 928500, 908100, 885200, 862400], unit: 'idr' },
                  { type: 'item', label: 'Deposito Berjangka', values: [215600, 212400, 210800, 206500, 201200, 198400], unit: 'idr' },
                  { type: 'total', label: 'Total Liabilitas', values: [1180900, 1151200, 1147600, 1121500, 1092400, 1062100], unit: 'idr' },
                  { type: 'group', label: 'Ekuitas' },
                  { type: 'item', label: 'Modal Saham', values: [1541, 1541, 1541, 1541, 1541, 1541], unit: 'idr' },
                  { type: 'item', label: 'Saldo Laba Ditahan', values: [265759, 259759, 258959, 252359, 248159, 242059], unit: 'idr' },
                  { type: 'total', label: 'Total Ekuitas', values: [267300, 261300, 260500, 253900, 249700, 243500], unit: 'idr' }
                ]
              },
              cash_flow: {
                periods: ['Q2 2026', 'Q1 2026', 'Q4 2025', 'Q3 2025', 'Q2 2025', 'Q1 2025'],
                rows: [
                  { type: 'group', label: 'Arus Kas Operasi' },
                  { type: 'item', label: 'Penerimaan Pendapatan Bunga', values: [22450, 21850, 22100, 21200, 20500, 19800], unit: 'idr' },
                  { type: 'item', label: 'Pembayaran Beban Operasional', values: [-8420, -8120, -8650, -7950, -7650, -7350], unit: 'idr' },
                  { type: 'total', label: 'Arus Kas Bersih Aktivitas Operasi', values: [18450, 17820, 18120, 17150, 16420, 15650], unit: 'idr' },
                  { type: 'group', label: 'Arus Kas Investasi & Pendanaan' },
                  { type: 'item', label: 'Belanja Modal (Capex)', values: [-1250, -1180, -1450, -1120, -980, -920], unit: 'idr' },
                  { type: 'item', label: 'Pembayaran Dividen Kas', values: [-6850, 0, -5420, 0, -6150, 0], unit: 'idr' },
                  { type: 'total', label: 'Kenaikan / (Penurunan) Kas Bersih', values: [10350, 16640, 11250, 16030, 9290, 14730], unit: 'idr' }
                ]
              },
              ratios: {
                periods: ['Q2 2026', 'Q1 2026', 'Q4 2025', 'Q3 2025', 'Q2 2025', 'Q1 2025'],
                rows: [
                  { type: 'group', label: 'Valuasi & Profitabilitas' },
                  { type: 'item', label: 'Price to Earnings (PER)', values: [25.42, 26.22, 26.14, 26.95, 28.02, 29.32], unit: 'x' },
                  { type: 'item', label: 'Price to Book Value (PBV)', values: [4.82, 4.93, 4.94, 5.07, 5.16, 5.29], unit: 'x' },
                  { type: 'item', label: 'Return on Equity (ROE)', values: [18.96, 18.80, 18.91, 18.82, 18.41, 18.03], unit: 'pct' },
                  { type: 'item', label: 'Return on Assets (ROA)', values: [3.50, 3.48, 3.50, 3.48, 3.42, 3.36], unit: 'pct' },
                  { type: 'item', label: 'Net Interest Margin (NIM)', values: [5.62, 5.58, 5.55, 5.50, 5.48, 5.42], unit: 'pct' },
                  { type: 'item', label: 'Non-Performing Loan (NPL Gross)', values: [1.90, 1.92, 1.90, 1.95, 1.98, 2.02], unit: 'pct' },
                  { type: 'item', label: 'Capital Adequacy Ratio (CAR)', values: [29.10, 28.85, 29.40, 28.60, 28.20, 27.90], unit: 'pct' }
                ]
              }
            },
            annual: {
              periods: ['FY 2025', 'FY 2024', 'FY 2023', 'FY 2022'],
              income_statement: {
                periods: ['FY 2025', 'FY 2024', 'FY 2023', 'FY 2022'],
                rows: [
                  { type: 'group', label: 'Pendapatan & Beban Operasional' },
                  { type: 'item', label: 'Pendapatan Bunga Bersih', values: [75820, 69540, 64210, 58420], unit: 'idr' },
                  { type: 'item', label: 'Pendapatan Operasional Lainnya', values: [23850, 21450, 19820, 17950], unit: 'idr' },
                  { type: 'item', label: 'Beban Operasional Lainnya', values: [-38450, -35210, -32450, -29850], unit: 'idr' },
                  { type: 'total', label: 'Laba Operasional', values: [61220, 55780, 51580, 46520], unit: 'idr' },
                  { type: 'group', label: 'Laba Bersih & Pajak' },
                  { type: 'item', label: 'Beban Pajak Penghasilan', values: [-12410, -11250, -10420, -9450], unit: 'idr' },
                  { type: 'total', label: 'Laba Bersih Tahun Berjalan', values: [48810, 44530, 41160, 37070], unit: 'idr' },
                  { type: 'item', label: 'Laba per Saham (EPS) - IDR', values: [396.01, 361.27, 333.92, 300.74], unit: 'number' }
                ]
              },
              balance_sheet: {
                periods: ['FY 2025', 'FY 2024', 'FY 2023', 'FY 2022'],
                rows: [
                  { type: 'group', label: 'Aset' },
                  { type: 'item', label: 'Total Aset', values: [1408100, 1342100, 1250800, 1165400], unit: 'idr' },
                  { type: 'group', label: 'Liabilitas' },
                  { type: 'item', label: 'Total Liabilitas', values: [1147600, 1092400, 1018500, 948200], unit: 'idr' },
                  { type: 'group', label: 'Ekuitas' },
                  { type: 'item', label: 'Total Ekuitas', values: [260500, 249700, 232300, 217200], unit: 'idr' }
                ]
              },
              cash_flow: {
                periods: ['FY 2025', 'FY 2024', 'FY 2023', 'FY 2022'],
                rows: [
                  { type: 'group', label: 'Arus Kas' },
                  { type: 'item', label: 'Arus Kas Bersih Aktivitas Operasi', values: [71250, 65420, 59850, 54210], unit: 'idr' },
                  { type: 'item', label: 'Arus Kas Bersih Aktivitas Investasi', values: [-5120, -4850, -4320, -3950], unit: 'idr' },
                  { type: 'item', label: 'Arus Kas Bersih Aktivitas Pendanaan', values: [-24500, -22100, -19800, -17500], unit: 'idr' },
                  { type: 'total', label: 'Kenaikan Bersih Kas', values: [41630, 38470, 35730, 32760], unit: 'idr' }
                ]
              },
              ratios: {
                periods: ['FY 2025', 'FY 2024', 'FY 2023', 'FY 2022'],
                rows: [
                  { type: 'group', label: 'Rasio Tahunan' },
                  { type: 'item', label: 'Price to Earnings (PER)', values: [26.39, 28.92, 27.85, 26.50], unit: 'x' },
                  { type: 'item', label: 'Price to Book Value (PBV)', values: [4.94, 5.16, 4.93, 4.52], unit: 'x' },
                  { type: 'item', label: 'Return on Equity (ROE)', values: [18.74, 17.83, 17.72, 17.07], unit: 'pct' },
                  { type: 'item', label: 'Return on Assets (ROA)', values: [3.47, 3.32, 3.29, 3.18], unit: 'pct' }
                ]
              }
            }
          };

          return res.status(200).json({
            success: true,
            context: {
              ticker: ticker || 'BBCA',
              as_of: '2026-10-07',
              fundamental: {
                pbv: isBbca ? 4.82 : 1.35,
                pbv_as_of_price: isBbca ? 10450 : 1420,
                book_value_per_share: isBbca ? 2168.05 : 1051.85,
                shares_outstanding: isBbca ? 123275050000 : 25139000000,
                market_cap: isBbca ? 1288224272500000 : 35697380000000,
                market_cap_as_of: '2026-10-07',
                market_cap_source: 'IDX Trade Data',
                fundamental_period: 'Q2 2026',
                fundamental_source: 'IDX Financial Statement',
                fundamental_updated_at: '2026-09-15 14:30:00 WIB'
              },
              financial_statements: isBbca ? bbcaStatements : null,
              market_structure: {
                free_float_pct: isBbca ? 41.82 : 48.20,
                free_float_source: 'IDX ownership',
                free_float_as_of: '2026-08-31',
                free_float_available: true,
                hsc_flag: false,
                hsc_source: 'IDX HSC',
                hsc_as_of: '2026-09-01',
                hsc_available: true,
                low_free_float_reference_pct: 15,
                low_free_float_risk: false,
                regulatory_compliance_status: 'NOT_EVALUATED',
                market_structure_status: 'STRUCTURE_VERIFIED',
                market_structure_guard: 'NORMAL',
                market_structure_note: 'Free float terverifikasi aman di atas referensi 15%; snapshot HSC tidak flagged.',
                data_available: true
              }
            }
          });
        }
        if (ticker) {
          const base = ticker === 'BBCA' ? 10250 : (ticker === 'MEDC' ? 1420 : (ticker === 'BRPT' ? 1050 : (ticker === 'BMRI' ? 6800 : 5100)));
          return res.status(200).json({
            success: true,
            ticker: ticker,
            last: base,
            prevClose: base - 50,
            change: 50,
            changePct: 0.85,
            volume: 35000000
          });
        }
      }
    }

    // Sector Hot API mock for preview (development only — BUG-RT-03)
    if (endpointName === 'sector-hot') {
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      req.body = await parseBody(req);
      const action = req.query.action || '';

      if (PREVIEW_MOCKS_ENABLED && (isPreview || !process.env.SUPABASE_URL)) {
        if (action === 'landing-snapshot') return res.status(200).json(MOCK_LANDING_SNAPSHOT);
        if (action === 'web-daily-picks') return res.status(200).json(MOCK_DAILY_PICKS);
        if (action === 'screener') return res.status(200).json(MOCK_SWING_KONGLO);
        if (action === 'nk-screener-results') return res.status(200).json(MOCK_SWING_NK);
        if (action === 'daytrade-screener') return res.status(200).json(MOCK_DAYTRADE);
        if (action === 'watchlist') return res.status(200).json(MOCK_WATCHLIST);
        if (action === 'track-record') return res.status(200).json(MOCK_TRACK_RECORD);
        if (action === 'bandarmologi') return res.status(200).json(MOCK_BANDARMOLOGI);
        if (action === 'available-dates') {
          return res.status(200).json({
            success: true,
            ticker: req.query.ticker || 'BBCA',
            dates: ['2026-09-25', '2026-09-24', '2026-09-23', '2026-09-22', '2026-09-19'],
            count: 5,
            cache_hit: true
          });
        }
        if (action === 'insider-network') {
          return res.status(200).json({
            success: true,
            nodes: [
              { id: 'BBCA', label: 'BBCA', type: 'issuer', color: '#10b981' },
              { id: 'Djarum', label: 'PT Dwimuria Investama Andalan', type: 'shareholder', color: '#3b82f6' }
            ],
            links: [
              { source: 'Djarum', target: 'BBCA', value: 54.94, label: '54.94% (Pengendali)' }
            ]
          });
        }
        if (action === 'broker-hunter') {
          const brokerCode = (req.query.broker || 'AK').toUpperCase();
          const brokerNames = {
            'AK': 'UBS Sekuritas Indonesia',
            'BK': 'J.P. Morgan Sekuritas Indonesia',
            'CC': 'Mandiri Sekuritas',
            'RX': 'Macquarie Sekuritas Indonesia',
            'DX': 'Bahana Sekuritas',
            'KZ': 'CLSA Sekuritas Indonesia',
            'ZP': 'Maybank Sekuritas Indonesia',
            'YP': 'Mirae Asset Sekuritas Indonesia',
            'XC': 'Ajaib Sekuritas Asia',
            'PD': 'Indo Premier Sekuritas',
            'NI': 'BNI Sekuritas',
            'MG': 'Semesta Indovest Sekuritas',
            'SQ': 'BCA Sekuritas'
          };
          return res.status(200).json({
            success: true,
            from_cache: true,
            broker: brokerCode,
            broker_name: brokerNames[brokerCode] || (brokerCode + ' Sekuritas'),
            range: req.query.range || '1d',
            target_dates: ['2026-10-07'],
            date_range_label: '07 Okt 2026 (1D)',
            generated_at: new Date().toISOString(),
            top_accumulated: [
              { ticker: 'BBCA', bval: 142500000000, sval: 12000000000, net_val: 130500000000, avg_buy: 10250, avg_sell: 10200 },
              { ticker: 'BMRI', bval: 85000000000, sval: 15000000000, net_val: 70000000000, avg_buy: 6850, avg_sell: 6800 },
              { ticker: 'BREN', bval: 64000000000, sval: 9000000000, net_val: 55000000000, avg_buy: 6800, avg_sell: 6750 },
              { ticker: 'ASII', bval: 52000000000, sval: 8000000000, net_val: 44000000000, avg_buy: 5100, avg_sell: 5050 },
              { ticker: 'MEDC', bval: 38000000000, sval: 6000000000, net_val: 32000000000, avg_buy: 1410, avg_sell: 1395 }
            ],
            top_distributed: [
              { ticker: 'TLKM', bval: 10000000000, sval: 45000000000, net_val: -35000000000, avg_buy: 3120, avg_sell: 3150 },
              { ticker: 'GOTO', bval: 5000000000, sval: 28000000000, net_val: -23000000000, avg_buy: 64, avg_sell: 65 },
              { ticker: 'KLBF', bval: 3000000000, sval: 18000000000, net_val: -15000000000, avg_buy: 1450, avg_sell: 1460 }
            ],
            total_stocks_active: 45
          });
        }
        if (action === 'insider-roster') {
          return res.status(200).json({
            success: true,
            ticker: req.query.ticker || 'BBCA',
            roster: [
              { name: 'PT Dwimuria Investama Andalan', shares: '67.729.700.000', pct: 54.94, change: 0, date: '2026-09-01' }
            ]
          });
        }
        if (req.query.group) {
          const rawCode = String(req.query.group).toUpperCase().trim();
          const normCode = rawCode.startsWith('KONGLO_') ? rawCode : ('KONGLO_' + rawCode);
          const grp = (MOCK_SECTORS.groups || []).find(g => g.group_code === rawCode || g.group_code === normCode || g.group_code === ('SEKTOR_' + rawCode)) || {
            group_code: rawCode,
            group_name: 'Konglomerasi ' + rawCode,
            stock_count: 5,
            member_count: 5,
            avg_change_pct: 2.5,
            avg_volume_ratio: 1.8
          };
          const MOCK_GROUP_MEMBERS = {
            'KONGLO_BARITO': [
              { ticker: 'BREN', stock_name: 'Barito Renewables Energy Tbk', last_price: 6800, change_pct: 5.88, volume_today: 14200000, volume_ratio_30d: 2.4, member_type: 'ANCHOR' },
              { ticker: 'BRPT', stock_name: 'Barito Pacific Tbk', last_price: 1120, change_pct: 3.22, volume_today: 35000000, volume_ratio_30d: 1.7, member_type: 'MEMBER' },
              { ticker: 'CUAN', stock_name: 'Petrindo Jaya Kreasi Tbk', last_price: 7450, change_pct: 2.15, volume_today: 8900000, volume_ratio_30d: 1.5, member_type: 'MEMBER' },
              { ticker: 'TPIA', stock_name: 'Chandra Asri Pacific Tbk', last_price: 8900, change_pct: 1.42, volume_today: 12000000, volume_ratio_30d: 1.2, member_type: 'MEMBER' },
              { ticker: 'PTRO', stock_name: 'Petrosea Tbk', last_price: 13500, change_pct: -0.74, volume_today: 4500000, volume_ratio_30d: 0.9, member_type: 'MEMBER' }
            ],
            'KONGLO_SALIM': [
              { ticker: 'ICBP', stock_name: 'Indofood CBP Sukses Makmur Tbk', last_price: 11450, change_pct: 2.23, volume_today: 9500000, volume_ratio_30d: 1.6, member_type: 'ANCHOR' },
              { ticker: 'INDF', stock_name: 'Indofood Sukses Makmur Tbk', last_price: 6950, change_pct: 1.83, volume_today: 11200000, volume_ratio_30d: 1.4, member_type: 'ANCHOR' },
              { ticker: 'AMMN', stock_name: 'Amman Mineral Internasional Tbk', last_price: 9800, change_pct: 3.43, volume_today: 28400000, volume_ratio_30d: 2.1, member_type: 'MEMBER' },
              { ticker: 'MEDC', stock_name: 'Medco Energi Internasional Tbk', last_price: 1420, change_pct: 3.75, volume_today: 42100000, volume_ratio_30d: 2.5, member_type: 'MEMBER' },
              { ticker: 'SIMP', stock_name: 'Salim Ivomas Pratama Tbk', last_price: 430, change_pct: 0.94, volume_today: 3800000, volume_ratio_30d: 1.1, member_type: 'MEMBER' },
              { ticker: 'LSIP', stock_name: 'PP London Sumatra Indonesia Tbk', last_price: 1060, change_pct: 1.44, volume_today: 6700000, volume_ratio_30d: 1.3, member_type: 'MEMBER' },
              { ticker: 'DCII', stock_name: 'DCI Indonesia Tbk', last_price: 43500, change_pct: 0.00, volume_today: 120000, volume_ratio_30d: 0.8, member_type: 'MEMBER' },
              { ticker: 'FAST', stock_name: 'Fast Food Indonesia Tbk', last_price: 720, change_pct: -1.37, volume_today: 850000, volume_ratio_30d: 0.7, member_type: 'MEMBER' }
            ],
            'KONGLO_ASTRA': [
              { ticker: 'ASII', stock_name: 'Astra International Tbk', last_price: 5200, change_pct: 2.85, volume_today: 48000000, volume_ratio_30d: 1.9, member_type: 'ANCHOR' },
              { ticker: 'UNTR', stock_name: 'United Tractors Tbk', last_price: 27150, change_pct: 1.88, volume_today: 5600000, volume_ratio_30d: 1.4, member_type: 'MEMBER' },
              { ticker: 'AALI', stock_name: 'Astra Agro Lestari Tbk', last_price: 6475, change_pct: 1.17, volume_today: 2300000, volume_ratio_30d: 1.0, member_type: 'MEMBER' },
              { ticker: 'AUTO', stock_name: 'Astra Otoparts Tbk', last_price: 2180, change_pct: 1.40, volume_today: 4200000, volume_ratio_30d: 1.2, member_type: 'MEMBER' },
              { ticker: 'ASGR', stock_name: 'Astra Graphia Tbk', last_price: 935, change_pct: 0.54, volume_today: 780000, volume_ratio_30d: 0.9, member_type: 'MEMBER' }
            ],
            'KONGLO_DJARUM': [
              { ticker: 'BBCA', stock_name: 'Bank Central Asia Tbk', last_price: 10250, change_pct: 1.72, volume_today: 55000000, volume_ratio_30d: 1.8, member_type: 'ANCHOR' },
              { ticker: 'TOWR', stock_name: 'Sarana Menara Nusantara Tbk', last_price: 840, change_pct: 1.20, volume_today: 18000000, volume_ratio_30d: 1.3, member_type: 'MEMBER' },
              { ticker: 'BELI', stock_name: 'Global Digital Niaga Tbk', last_price: 450, change_pct: 0.45, volume_today: 12000000, volume_ratio_30d: 1.0, member_type: 'MEMBER' },
              { ticker: 'RANC', stock_name: 'Supra Boga Lestari Tbk', last_price: 410, change_pct: 0.00, volume_today: 450000, volume_ratio_30d: 0.6, member_type: 'MEMBER' }
            ],
            'SEKTOR_ENERGY': [
              { ticker: 'ADRO', stock_name: 'Adaro Energy Indonesia Tbk', last_price: 3650, change_pct: 4.65, volume_today: 62000000, volume_ratio_30d: 2.3, member_type: 'ANCHOR' },
              { ticker: 'PTBA', stock_name: 'Bukit Asam Tbk', last_price: 2980, change_pct: 2.76, volume_today: 19000000, volume_ratio_30d: 1.6, member_type: 'MEMBER' },
              { ticker: 'PGAS', stock_name: 'Perusahaan Gas Negara Tbk', last_price: 1580, change_pct: 1.94, volume_today: 42100000, volume_ratio_30d: 1.4, member_type: 'MEMBER' },
              { ticker: 'ITMG', stock_name: 'Indo Tambangraya Megah Tbk', last_price: 26800, change_pct: 2.29, volume_today: 2800000, volume_ratio_30d: 1.5, member_type: 'MEMBER' },
              { ticker: 'AKRA', stock_name: 'AKR Corporindo Tbk', last_price: 1610, change_pct: 1.26, volume_today: 15000000, volume_ratio_30d: 1.2, member_type: 'MEMBER' }
            ],
            'SEKTOR_FINANCE': [
              { ticker: 'BBCA', stock_name: 'Bank Central Asia Tbk', last_price: 10250, change_pct: 1.72, volume_today: 55000000, volume_ratio_30d: 1.8, member_type: 'ANCHOR' },
              { ticker: 'BBRI', stock_name: 'Bank Rakyat Indonesia Tbk', last_price: 5100, change_pct: 1.49, volume_today: 72000000, volume_ratio_30d: 1.6, member_type: 'ANCHOR' },
              { ticker: 'BMRI', stock_name: 'Bank Mandiri Tbk', last_price: 6800, change_pct: 2.10, volume_today: 32100000, volume_ratio_30d: 1.5, member_type: 'MEMBER' },
              { ticker: 'BBNI', stock_name: 'Bank Negara Indonesia Tbk', last_price: 5400, change_pct: 1.41, volume_today: 22000000, volume_ratio_30d: 1.3, member_type: 'MEMBER' },
              { ticker: 'BRIS', stock_name: 'Bank Syariah Indonesia Tbk', last_price: 2850, change_pct: 2.52, volume_today: 18000000, volume_ratio_30d: 1.7, member_type: 'MEMBER' }
            ]
          };
          const matchedKey = Object.keys(MOCK_GROUP_MEMBERS).find(k => k === rawCode || k === normCode || k.endsWith('_' + rawCode));
          const mockMembers = matchedKey ? MOCK_GROUP_MEMBERS[matchedKey] : (MOCK_GROUP_MEMBERS['KONGLO_' + rawCode] || []);
          const finalGrp = {
            ...grp,
            stock_count: mockMembers.length || grp.member_count || grp.stock_count || 0,
            member_count: mockMembers.length || grp.member_count || grp.stock_count || 0
          };
          return res.status(200).json({ success: true, group: finalGrp, members: mockMembers });
        }
        if (!action || action === 'sectors') return res.status(200).json(MOCK_SECTORS);
      }
    }

    const apiFile = path.join(API_DIR, endpointName + '.js');
    if (fs.existsSync(apiFile)) {
      try {
        const handler = require(apiFile);
        req.query = Object.fromEntries(parsedUrl.searchParams.entries());
        req.body = await parseBody(req);

        // On-demand fetch broker summary from VPS when requested ticker is not on local disk
        if (endpointName === 'sector-hot' && req.query.action === 'bandarmologi' && req.query.ticker) {
          try {
            const vpsFetcher = require('../lib/vps-data-fetcher');
            await vpsFetcher.ensureBrokerSummary(req.query.ticker, req.query.date || '2026-09-08');
          } catch (fetchErr) {
            console.warn('[VPS-FETCHER] On-demand fetch warning:', fetchErr.message);
          }
        }

        await handler(req, res);
        return;
      } catch (err) {
        console.error('[API ERROR] ' + pathname + ':', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal Server Error', message: err.message });
        }
        return;
      }
    } else {
      res.status(404).json({ error: 'API endpoint not found', path: pathname });
      return;
    }
  }

  // 2. Route rewrites for SPA / HTML pages
  //
  // The SPA reads its initial view from `window.location.search`, so a short path
  // like /broksum cannot simply be served as analisis-saham.html — the browser URL
  // must actually carry the tab. Redirecting (302) is therefore the correct
  // mechanism here, and it keeps the address bar shareable/reloadable.
  const defaultQuery = ROUTE_DEFAULT_QUERY[pathname];
  if (defaultQuery) {
    const target = ROUTE_REWRITES[pathname];
    const merged = new URLSearchParams(parsedUrl.searchParams);
    let added = false;
    for (const key of Object.keys(defaultQuery)) {
      // An explicit caller-supplied value always wins.
      if (!merged.has(key)) {
        merged.set(key, defaultQuery[key]);
        added = true;
      }
    }
    if (added) {
      const query = merged.toString();
      res.statusCode = 302;
      res.setHeader('Location', target + (query ? '?' + query : ''));
      return res.end();
    }
    pathname = target;
  } else if (ROUTE_REWRITES[pathname]) {
    pathname = ROUTE_REWRITES[pathname];
  }

  // API/auth handling above never enters the public static cache.
  if (pathname.startsWith('/data/')) {
    if (await serveData(req,res,pathname.slice('/data'.length),{noStore:true,extensionFallback:false})) return;
  }
  if (pathname === '/dashboard' || pathname === '/review' || pathname === '/pattern' || pathname === '/screener' || pathname === '/watchlist' || pathname === '/sektor' || pathname === '/trackrecord') pathname = '/index.html';
  if (await servePublic(req,res,pathname)) return;
  if (await servePublic(req,res,'/404.html',{status:404,noStore:true})) return;
  res.statusCode=404;res.setHeader('Cache-Control','no-store');res.end(req.method==='HEAD'?undefined:'404 Not Found');
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
// Loopback by default: the public path is the cloudflared tunnel, which connects
// from inside the host. Setting HOST=0.0.0.0 is only needed when an operator has
// also opened the port in the cloud firewall (Oracle VCN) — the Oracle VCN
// security list blocks every port except 22/3001, so binding wider alone does
// NOT make this publicly reachable.
const HOST = process.env.HOST || '127.0.0.1';

server.listen(PORT, HOST, () => {
  console.log('=================================================');
  console.log(' AUTO-CUAN LOCAL DEVELOPMENT SERVER IS RUNNING');
  console.log(' URL: http://' + HOST + ':' + PORT);
  console.log('-------------------------------------------------');
  console.log(' ZERO-AUTH MOCK PREVIEW ROUTES:');
  console.log(' 1. Landing:          http://' + HOST + ':' + PORT + '/preview/landing');
  console.log(' 2. Dashboard:        http://' + HOST + ':' + PORT + '/preview/dashboard');
  console.log(' 3. Analisis Saham:   http://' + HOST + ':' + PORT + '/preview/analisis-saham');
  console.log(' 4. Sektor Hot:       http://' + HOST + ':' + PORT + '/preview/sektor-hot');
  console.log(' 5. Screener:         http://' + HOST + ':' + PORT + '/preview/screener');
  console.log(' 6. Watchlist:        http://' + HOST + ':' + PORT + '/preview/watchlist');
  console.log(' 7. Track Record:     http://' + HOST + ':' + PORT + '/preview/track-record');
  console.log(' 8. Portofolio:       http://' + HOST + ':' + PORT + '/preview/portofolio');
  console.log('=================================================');
});
