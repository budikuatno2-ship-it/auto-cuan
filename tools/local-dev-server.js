'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

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

// Batch 8 points the VPS runners (tools/run-all-screeners-vps.js,
// tools/run-after-market-top5-lock.js) at this daemon on 127.0.0.1:3000, so it
// must be able to reach Supabase; otherwise every heavy action answers
// "Database belum dikonfigurasi." The VPS runtime env is the same file the
// runner shell scripts source, and it is absent on a developer machine.
// Hybrid: Vercel primer + VPS fallback — load all env sources so webhook secret
// and Supabase are available even when .env contains placeholders.
loadEnvFile(path.join(ROOT_DIR, '.env'));
loadEnvFile(path.join(ROOT_DIR, '.env.intraday-runtime'));
loadEnvFile(path.join(ROOT_DIR, '.env.bot'));
loadEnvFile(path.join(ROOT_DIR, '.env.local'));
loadEnvFile(path.join(ROOT_DIR, '.env.preview.local'));
loadEnvFile(path.join(ROOT_DIR, '.env.production.local'));
// VPS runner secrets (owner-only, 600) — critical for telegram-verify-webhook-v3
loadEnvFile('/home/ubuntu/auto-cuan-runner/telegram-webhook-v3-secret.env');
loadEnvFile('/home/ubuntu/auto-cuan-runner/telegram-lifecycle.env');
loadEnvFile('/home/ubuntu/auto-cuan-runner/telegram-auth-recovery-secret.env');
loadEnvFile('/home/ubuntu/auto-cuan-runner/session-secret.env');
loadEnvFile(path.join(ROOT_DIR, '.env.ai-eval-once'));

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

function getPreviewInjectionHtml(module) {
  return `
  <!-- AUTO-CUAN PREVIEW ZERO-AUTH BOOTSTRAP — DEV SERVER ONLY -->
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
    <a href="/preview/kelola-keuangan" class="${module === 'kelola-keuangan' ? 'active' : ''}">9. Kelola Keuangan</a>
    <button class="close-btn" onclick="document.getElementById('autocuan-preview-bar').remove()" title="Tutup preview toolbar">&times;</button>
  </div>
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
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

const ROUTE_REWRITES = {
  '/': '/index.html',
  '/dashboard': '/index.html',
  '/pattern': '/index.html',
  '/review': '/index.html',
  '/analisis-saham': '/analisis-saham.html',
  // FASE 9: the shell embeds the Portfolio Command Center at this exact path,
  // so the rewrite must exist for both the dev server and the VPS fallback.
  '/portfolio-command-center': '/portfolio-command-center.html',
  '/portfolio-planner': '/portfolio-command-center-v2.html',
  '/deepscan': '/index.html',
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
          <p>Silakan pilih salah satu dari 9 modul preview berikut:</p>
          <ol>
            <li><a style="color:#10b981;" href="/preview/landing">/preview/landing</a> (Landing Page Publik)</li>
            <li><a style="color:#10b981;" href="/preview/dashboard">/preview/dashboard</a> (Dashboard Utama)</li>
            <li><a style="color:#10b981;" href="/preview/analisis-saham">/preview/analisis-saham</a> (Analisis Saham - 7 Sub-tab)</li>
            <li><a style="color:#10b981;" href="/preview/sektor-hot">/preview/sektor-hot</a> (Sektor Hot)</li>
            <li><a style="color:#10b981;" href="/preview/screener">/preview/screener</a> (Screener 3-in-1)</li>
            <li><a style="color:#10b981;" href="/preview/watchlist">/preview/watchlist</a> (Watchlist Spreadsheet)</li>
            <li><a style="color:#10b981;" href="/preview/track-record">/preview/track-record</a> (Track Record Sinyal)</li>
            <li><a style="color:#10b981;" href="/preview/portofolio">/preview/portofolio</a> (Portofolio - 7 Sub-tab)</li>
            <li><a style="color:#10b981;" href="/preview/kelola-keuangan">/preview/kelola-keuangan</a> (Kelola Keuangan)</li>
          </ol>
        </body>
        </html>
      `);
    }

    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    let html = fs.readFileSync(indexPath, 'utf8');
    const injection = getPreviewInjectionHtml(moduleName);
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

    // Detect if this is a preview request or needs mock data
    const isPreview = Boolean(
      (req.headers.referer && req.headers.referer.includes('/preview')) ||
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

    // Money management mock
    if (endpointName === 'money-management') {
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      req.body = await parseBody(req);
      const action = req.query.action || (req.body && req.body.action) || 'summary';
      if (isPreview || !process.env.SUPABASE_URL) {
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

    // Bypass maintenance screen on local dev server
    if (endpointName === 'maintenance-settings') {
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
    if (endpointName === 'admin-users') {
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
    if (endpointName === 'reset-password') {
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

    // Review access mock
    if (endpointName === 'review-access') {
      return res.status(200).json({
        success: true,
        access: 'approved',
        role: 'ADMIN',
        user: 'budi',
        isApproved: true
      });
    }

    // Analyze status & AI analysis mock
    if (endpointName === 'analyze') {
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

    // Dev fallback for approval-based portfolio access
    if (endpointName === 'admin-users') {
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

    // Login user mock
    if (endpointName === 'login-user') {
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      if (isPreview || req.query.action === 'magic-login') {
        return res.status(200).json({
          success: true,
          user: { username: 'budi', role: 'ADMIN', approved: true }
        });
      }
    }

    // Dev fallback for subscription access profile
    if (endpointName === 'reset-password') {
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

    // Candles API mock for preview
    if (endpointName === 'candles') {
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      const ticker = (req.query.ticker || 'BBCA').toUpperCase();
      if (isPreview || !process.env.SUPABASE_URL) {
        return res.status(200).json(generateMockCandles(ticker));
      }
    }

    // Quote API mock for preview
    if (endpointName === 'quote') {
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      const ticker = (req.query.ticker || '').toUpperCase();
      const action = req.query.action || '';
      if (isPreview || !process.env.SUPABASE_URL) {
        if (ticker === 'IHSG') {
          return res.status(200).json(MOCK_IHSG);
        }
        if (action === 'daily-market-context-list') {
          return res.status(200).json({ success: true, tickers: ['BBCA', 'MEDC', 'BRPT', 'BMRI', 'ASII'] });
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

    // Sector Hot API mock for preview
    if (endpointName === 'sector-hot') {
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      req.body = await parseBody(req);
      const action = req.query.action || '';

      if (isPreview || !process.env.SUPABASE_URL) {
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
        if (action === 'insider-roster') {
          return res.status(200).json({
            success: true,
            ticker: req.query.ticker || 'BBCA',
            roster: [
              { name: 'PT Dwimuria Investama Andalan', shares: '67.729.700.000', pct: 54.94, change: 0, date: '2026-09-01' }
            ]
          });
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

  // 3. Serve from data directory
  if (pathname.startsWith('/data/')) {
    const relativeDataPath = pathname.slice('/data/'.length);
    const fullDataPath = path.join(DATA_DIR, relativeDataPath);
    if (fs.existsSync(fullDataPath) && fs.statSync(fullDataPath).isFile()) {
      const ext = path.extname(fullDataPath).toLowerCase();
      res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
      return fs.createReadStream(fullDataPath).pipe(res);
    }
  }

  // 4. SPA rewrites matching vercel.json
  if (pathname === '/dashboard' || pathname === '/review' || pathname === '/pattern') {
    pathname = '/index.html';
  }

  // 5. Serve from public directory
  let filePath = path.join(PUBLIC_DIR, pathname);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    if (fs.existsSync(filePath + '.html')) {
      filePath = filePath + '.html';
    } else {
      const notFoundPath = path.join(PUBLIC_DIR, '404.html');
      if (fs.existsSync(notFoundPath)) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return fs.createReadStream(notFoundPath).pipe(res);
      }
      res.statusCode = 404;
      return res.end('404 Not Found');
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
  fs.createReadStream(filePath).pipe(res);
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
  console.log(' 9. Kelola Keuangan:  http://' + HOST + ':' + PORT + '/preview/kelola-keuangan');
  console.log('=================================================');
});
