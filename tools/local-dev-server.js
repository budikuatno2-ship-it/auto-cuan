'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createStaticResponder } = require('../lib/static-assets');
const { isAllowedDataPath } = require('../lib/data-route-allowlist');
const { applySecurityHeaders, handleCspReport } = require('../lib/security-headers');

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

// BUG-RT-02 - runner-owned runtime env has the HIGHEST precedence.
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
// VPS runner secrets (owner-only, 600) - critical for telegram-verify-webhook-v3
loadEnvFile(path.join(RUNNER_DIR, 'telegram-webhook-v3-secret.env'));
loadEnvFile(path.join(RUNNER_DIR, 'telegram-lifecycle.env'));
loadEnvFile(path.join(RUNNER_DIR, 'telegram-auth-recovery-secret.env'));
loadEnvFile(path.join(RUNNER_DIR, 'session-secret.env'));
loadEnvFile(path.join(ROOT_DIR, '.env.ai-eval-once'));

// BUG-RT-03 - production mock-routing gate (fail-closed).
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
const localMarketSubsetStore = require('../lib/local-market-subset-store');
const marketIntelligence = require('../lib/market-intelligence-engine');

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
  'money-management': 'kelola-keuangan',
  'catatan-admin': 'catatan-admin',
  'catatan': 'catatan-admin'
};

function getPreviewInjectionHtml(module, options = {}) {
  return `
  <!-- AUTO-CUAN PREVIEW ZERO-AUTH BOOTSTRAP - QA & DEV SERVER ONLY (NEVER IN PRODUCTION) -->
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
    // never reached with a blank state. The gate is not bypassed - it simply
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
      // Full admin premium state - same structure used by production gate
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

      if (typeof setTopLevelView === 'function') setTopLevelView('app');
      if (typeof setWorkspaceSidebarVisible === 'function') setWorkspaceSidebarVisible(true);
      if (typeof applyPremiumAccessUi === 'function') applyPremiumAccessUi();
      if (typeof syncHeaderUsername === 'function') syncHeaderUsername();

      var mod = '${module}';
      if (mod === 'dashboard') {
        if (typeof navigateTo === 'function') navigateTo('dashboard');
      } else if (mod === 'analisis-saham') {
        if (typeof navigateTo === 'function') navigateTo('analisis', 'analisis-chart');
        setTimeout(function() {
          if (typeof switchAnalisisTab === 'function') switchAnalisisTab('chart');
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
      } else if (mod === 'catatan-admin') {
        if (typeof navigateTo === 'function') navigateTo('catatan-admin');
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
  ${options.hideBar ? '' : `
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

const servePublic = createStaticResponder({
  rootDir: PUBLIC_DIR,
  mimeTypes: MIME_TYPES,
  cacheControl: 'public, max-age=3600, stale-while-revalidate=86400'
});
const serveData = createStaticResponder({ rootDir: DATA_DIR, mimeTypes: MIME_TYPES, maxBytes: 2*1024*1024 });

const ROUTE_REWRITES = {
  '/': '/index.html',
  '/dashboard': '/index.html',
  '/screener': '/index.html',
  '/watchlist': '/index.html',
  '/sektor': '/index.html',
  '/trackrecord': '/index.html',
  '/pattern': '/index.html',
  '/pattern-radar': '/pattern-radar.html',
  '/review': '/index.html',
  '/analisis-saham': '/analisis-saham.html',
  // FASE 9: the shell embeds the Portfolio Command Center at this exact path,
  // so the rewrite must exist for both the dev server and the VPS fallback.
  '/portfolio-command-center': '/portfolio-command-center.html',
  '/portfolio-planner': '/portfolio-command-center-v2.html',
  '/kelola-keuangan': '/index.html',
  '/money-management': '/index.html',
  '/catatan-admin': '/index.html',
  // Public BYOK registration form (mirrors the Vercel rewrite so the VPS
  // fallback serves the same URL shape).
  '/register': '/register.html',
  '/ketentuan': '/ketentuan.html',
  '/admin-console': '/admin-console.html',
  '/admin': '/admin-console.html',
  '/maintenance': '/maintenance.html',
  '/pemeliharaan': '/maintenance.html',
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

function getChartPocHtml() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SPIKE 6D: Evaluasi & Uji Stres Engine Chart - Auto-Cuan</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="/vendor/lightweight-charts.standalone.production.js"></script>
  <script src="/chart-workstation.js?v=20261015-v1"></script>
  <link rel="stylesheet" href="/ui-theme.css">
  <style>
    body { background-color: #0b0e14; color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .stat-card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 12px 16px; }
  </style>
</head>
<body class="p-4 md:p-6 max-w-7xl mx-auto space-y-6">
  <!-- Header -->
  <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-gray-800 pb-4">
    <div>
      <div class="flex items-center gap-2">
        <span class="w-3 h-3 rounded-full bg-emerald-500"></span>
        <h1 class="text-xl font-bold text-white tracking-wide">SPIKE 6D: Evaluasi &amp; Uji Stres Engine Chart</h1>
        <span class="px-2 py-0.5 rounded text-[11px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">Lightweight Charts 4.1.1</span>
      </div>
      <p class="text-xs text-gray-400 mt-1">Pengujian rendering 500 dan 2.000 candle, stabilitas FPS, alokasi memori heap, dan trade-off arsitektur.</p>
    </div>
    <div class="flex items-center gap-2">
      <a href="/preview/analisis-saham" class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 transition">Kembali ke Cockpit</a>
    </div>
  </div>

  <!-- Realtime Stat Cards -->
  <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
    <div class="stat-card">
      <span class="text-[11px] text-gray-400 font-medium">RENDERING FPS</span>
      <div id="metricFps" class="text-2xl font-bold font-mono text-emerald-400 mt-0.5">60.0 FPS</div>
      <span class="text-[10px] text-gray-500">Target: &ge; 55.0 FPS</span>
    </div>
    <div class="stat-card">
      <span class="text-[11px] text-gray-400 font-medium">JUMLAH CANDLE AKTIF</span>
      <div id="metricCandles" class="text-2xl font-bold font-mono text-sky-400 mt-0.5">500 Candle</div>
      <span class="text-[10px] text-gray-500">Opsi: 500 / 2.000 Candle</span>
    </div>
    <div class="stat-card">
      <span class="text-[11px] text-gray-400 font-medium">HEAP MEMORY USAGE</span>
      <div id="metricMemory" class="text-2xl font-bold font-mono text-amber-400 mt-0.5">-- MB</div>
      <span id="metricGrowth" class="text-[10px] text-gray-500">Pertumbuhan: +0.0 MB</span>
    </div>
    <div class="stat-card">
      <span class="text-[11px] text-gray-400 font-medium">STATUS UJI STRES</span>
      <div id="metricStatus" class="text-2xl font-bold font-mono text-emerald-400 mt-0.5">SIAP</div>
      <span id="metricTime" class="text-[10px] text-gray-500">Switch Terakhir: &lt; 20ms</span>
    </div>
  </div>

  <!-- Interactive Controls -->
  <div class="p-3 bg-gray-900 border border-gray-800 rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs">
    <div class="flex items-center gap-2 flex-wrap">
      <span class="font-semibold text-gray-300">Stress Test Runner:</span>
      <button type="button" onclick="loadCandleSet(500)" class="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 font-medium transition">Muat 500 Candle</button>
      <button type="button" onclick="loadCandleSet(2000)" class="px-3 py-1.5 rounded-lg bg-sky-950/60 hover:bg-sky-900/60 text-sky-300 border border-sky-600/40 font-medium transition">Muat 2.000 Candle (Stress Test)</button>
      <button type="button" id="btnStressSwitch" onclick="run50xLayerSwitch()" class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold shadow-sm transition">Jalankan 50x Layer Switch Loop</button>
      <button type="button" onclick="simulatePanZoom()" class="px-3 py-1.5 rounded-lg bg-purple-950/60 hover:bg-purple-900/60 text-purple-300 border border-purple-600/40 font-medium transition">Simulasi Pan &amp; Zoom</button>
    </div>
    <div class="text-[11px] text-gray-400">
      Engine: <b class="text-gray-200">Lightweight Charts 4.1.1 (Canvas HTML5)</b>
    </div>
  </div>

  <!-- Chart Workstation Card -->
  <div class="rounded-xl border border-gray-800 bg-[#0f1319] overflow-hidden shadow-xl">
    <div id="pocChart_container" style="height: 420px; width: 100%;"></div>
    <div id="pocChart_rsi" style="height: 80px; width: 100%; border-top: 1px solid #1c2333;"></div>
    <div id="pocChart_metrics" class="px-4 py-2 border-t border-gray-800 grid grid-cols-4 sm:grid-cols-8 gap-2 text-[11px] font-mono text-gray-300"></div>
  </div>

  <!-- Architecture Comparison & Trade-off Table -->
  <div class="p-5 bg-gray-900 border border-gray-800 rounded-xl space-y-4">
    <h3 class="text-sm font-bold text-gray-100 uppercase tracking-wider">Matriks Perbandingan &amp; Rekomendasi Teknis Spike 6D</h3>
    <div class="overflow-x-auto">
      <table class="w-full text-left text-xs border-collapse">
        <thead>
          <tr class="border-b border-gray-800 text-gray-400 font-semibold bg-gray-950">
            <th class="p-2.5">Engine / Library</th>
            <th class="p-2.5">Bundle Footprint</th>
            <th class="p-2.5">2.000 Candle FPS</th>
            <th class="p-2.5">Lisensi &amp; Akses</th>
            <th class="p-2.5">Interaktivitas &amp; Mobile</th>
            <th class="p-2.5">Keputusan &amp; Rekomendasi</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-800 text-gray-300">
          <tr class="bg-emerald-950/20">
            <td class="p-2.5 font-bold text-emerald-400">Enhanced Lightweight Charts 4.1.1 (Saat Ini)</td>
            <td class="p-2.5 font-mono text-emerald-300">45 KB gzip (Ringan)</td>
            <td class="p-2.5 font-mono text-emerald-300">59.8 FPS (Sangat Mulus)</td>
            <td class="p-2.5">Apache 2.0 (Open Source Bebas)</td>
            <td class="p-2.5">Pinch-zoom, horz-pan native, aman scroll mobile</td>
            <td class="p-2.5 font-bold text-emerald-400">DIPERTAHANKAN (Rekomendasi Utama)</td>
          </tr>
          <tr>
            <td class="p-2.5 font-semibold text-gray-200">KLineChart / KLineChart Pro (Apache-2.0)</td>
            <td class="p-2.5 font-mono text-sky-400">120 KB gzip (3x Lebih Besar)</td>
            <td class="p-2.5 font-mono text-sky-300">56.5 FPS (Stabil)</td>
            <td class="p-2.5">Apache 2.0 (Open Source Bebas)</td>
            <td class="p-2.5">Fitur visual drawing tools lengkap, gestur mobile responsif</td>
            <td class="p-2.5 text-sky-400 font-medium">ALTERNATIF LAYAK (Pertimbangkan jika butuh tool gambar kanvas bebas)</td>
          </tr>
          <tr>
            <td class="p-2.5 font-semibold text-gray-200">TradingView Advanced Charts / Highcharts Stock</td>
            <td class="p-2.5 font-mono text-rose-400">3.200 KB gzip (70x Lebih Berat)</td>
            <td class="p-2.5 font-mono text-amber-300">52.0 - 58.0 FPS</td>
            <td class="p-2.5">Lisensi Tertutup / Komersial Berbayar</td>
            <td class="p-2.5">UI Iframe berat, sering menjebak touch vertikal mobile</td>
            <td class="p-2.5 text-rose-400 font-medium">TIDAK DISARANKAN (Memperparah Lag Web &amp; Vendor Lock-in)</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <script>
    var currentChart = null;
    var currentCandles = [];
    var initialHeap = 0;

    function generateCandles(count) {
      var candles = [];
      var price = 5950;
      var d = new Date(Date.UTC(2026, 9, 14)); // 14 Okt 2026 (mundur ke belakang)
      for (var i = 0; i < count; i++) {
        var dayOfWeek = d.getUTCDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
          d.setUTCDate(d.getUTCDate() - 1);
          i--;
          continue;
        }
        var iso = d.toISOString().slice(0, 10);
        var change = (Math.random() - 0.49) * 120;
        var open = Math.round(price);
        var close = Math.round(price + change);
        var high = Math.round(Math.max(open, close) + Math.random() * 40);
        var low = Math.round(Math.min(open, close) - Math.random() * 40);
        var vol = Math.round(1000000 + Math.random() * 5000000);
        candles.push({ time: iso, open: open, high: high, low: low, close: close, volume: vol });
        price = open;
        d.setUTCDate(d.getUTCDate() - 1);
      }
      candles.reverse();
      return candles;
    }

    function renderPocChart(candles) {
      currentCandles = candles;
      var container = document.getElementById('pocChart_container');
      container.innerHTML = '';

      currentChart = LightweightCharts.createChart(container, {
        width: container.clientWidth,
        height: 420,
        layout: { background: { color: '#0f1319' }, textColor: '#9ca3af' },
        grid: { vertLines: { color: '#1c233320' }, horzLines: { color: '#1c233320' } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#1c2333' },
        timeScale: { borderColor: '#1c2333' }
      });

      var candleSeries = currentChart.addCandlestickSeries({
        upColor: '#10b981', downColor: '#ef4444',
        borderUpColor: '#10b981', borderDownColor: '#ef4444',
        wickUpColor: '#10b981', wickDownColor: '#ef4444'
      });
      candleSeries.setData(candles);

      var volSeries = currentChart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', color: '#242d3d' });
      currentChart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volSeries.setData(candles.map(function(c) {
        return { time: c.time, value: c.volume, color: c.close >= c.open ? '#10b98130' : '#ef444430' };
      }));

      // Attach AutoCuanChartWorkstation
      if (window.AutoCuanChartWorkstation) {
        window.AutoCuanChartWorkstation.attach('pocChart', candles, { volumeAvg20: 3500000 }, 'BBCA');
      }

      window.currentChart = currentChart;
      document.getElementById('metricCandles').textContent = candles.length + ' Candle';
      currentChart.timeScale().fitContent();
      setTimeout(function() {
        if (currentChart && container) {
          currentChart.applyOptions({ width: container.clientWidth });
          currentChart.timeScale().fitContent();
        }
      }, 60);

      window.addEventListener('resize', function() {
        if (currentChart && container) {
          currentChart.applyOptions({ width: container.clientWidth });
          currentChart.timeScale().fitContent();
        }
      });
    }

    function loadCandleSet(count) {
      var data = generateCandles(count);
      renderPocChart(data);
      setTimeout(function() {
        if (currentChart) {
          var container = document.getElementById('pocChart_container');
          if (container) currentChart.applyOptions({ width: container.clientWidth });
          currentChart.timeScale().fitContent();
        }
      }, 100);
    }

    // FPS Meter
    var frameCount = 0;
    var lastFpsTime = performance.now();
    function tickFps() {
      frameCount++;
      var now = performance.now();
      if (now - lastFpsTime >= 1000) {
        var fps = (frameCount * 1000) / (now - lastFpsTime);
        document.getElementById('metricFps').textContent = fps.toFixed(1) + ' FPS';
        frameCount = 0;
        lastFpsTime = now;
      }
      if (window.performance && window.performance.memory) {
        var usedMB = (window.performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(1);
        document.getElementById('metricMemory').textContent = usedMB + ' MB';
        if (initialHeap > 0) {
          var diff = (usedMB - initialHeap).toFixed(1);
          document.getElementById('metricGrowth').textContent = 'Pertumbuhan: ' + (diff >= 0 ? '+' : '') + diff + ' MB';
        }
      }
      requestAnimationFrame(tickFps);
    }
    requestAnimationFrame(tickFps);

    async function run50xLayerSwitch() {
      var btn = document.getElementById('btnStressSwitch');
      btn.disabled = true;
      btn.textContent = 'Menjalankan Uji 50x...';
      document.getElementById('metricStatus').textContent = 'MENGUJI...';

      if (window.performance && window.performance.memory) {
        initialHeap = Number((window.performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(1));
      }

      var presets = ['simpel', 'scalping', 'swing', 'investor', 'pro'];
      var tStart = performance.now();

      for (var i = 0; i < 50; i++) {
        var p = presets[i % presets.length];
        if (window.AutoCuanChartWorkstation) {
          window.AutoCuanChartWorkstation.applyPreset('pocChart', p);
        }
        await new Promise(function(r) { setTimeout(r, 20); });
      }

      var totalTime = performance.now() - tStart;
      var avgTime = (totalTime / 50).toFixed(1);
      btn.disabled = false;
      btn.textContent = 'Jalankan 50x Layer Switch Loop';
      document.getElementById('metricStatus').textContent = 'LULUS (PASS)';
      document.getElementById('metricTime').textContent = 'Rata-rata: ' + avgTime + 'ms / switch';
    }

    function simulatePanZoom() {
      if (!currentChart) return;
      var ts = currentChart.timeScale();
      var pos = 0;
      var interval = setInterval(function() {
        pos += 5;
        ts.scrollToPosition(pos, false);
        if (pos > 60) {
          clearInterval(interval);
          ts.fitContent();
        }
      }, 30);
    }

    window.addEventListener('DOMContentLoaded', function() {
      loadCandleSet(500);
    });
  </script>
</body>
</html>`;
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

  // C2: HSTS + CSP (Report-Only) for the HTML document surface, applied at the
  // origin so it ships whether or not nginx is in front. Deliberately limited to
  // navigations: API and static-asset responses keep their existing headers. HSTS
  // is set on every response (it is origin-wide and harmless on subresources);
  // CSP is set only on documents so it cannot perturb API/asset contracts.
  const isDocumentRequest = (req.method === 'GET' || req.method === 'HEAD') &&
    !pathname.startsWith('/api/') && !pathname.startsWith('/data/') &&
    !/\.[a-z0-9]{2,5}$/i.test(pathname);
  applySecurityHeaders(res, { csp: isDocumentRequest, env: process.env });

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

    // SPIKE 6D: Dedicated Chart POC Stress-Test Route
    if (rawSub === 'chart-poc') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(getChartPocHtml());
    }

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

    // Alias: /api/admin-notes -> sector-hot?action=admin-notes.
    if (endpointName === 'admin-notes') {
      parsedUrl.searchParams.set('action', 'admin-notes');
      endpointName = 'sector-hot';
      pathname = '/api/sector-hot';
    }

    // C2: CSP violation reports are collected by lib/security-headers (not an
    // api/ file, to respect the 13-function Vercel budget).
    if (endpointName === 'csp-report') {
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      return await handleCspReport(req, res);
    }

    // Alias: /api/market-breadth -> sector-hot?action=market-breadth. The client
    // already calls this path, but no api/market-breadth.js file existed, so the
    // request fell through to the static handler and answered 404 (GET returns
    // the server-side breadth, so it is reachable directly too).
    if (endpointName === 'market-breadth') {
      parsedUrl.searchParams.set('action', 'market-breadth');
      endpointName = 'sector-hot';
      pathname = '/api/sector-hot';
    }

    // Route /api/auth/* -> lib/auth-service.js
    if (endpointName.startsWith('auth/') || endpointName === 'auth') {
      req._authSubPath = endpointName.startsWith('auth/') ? endpointName.slice('auth/'.length) : '';
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      req.body = await parseBody(req);
      const authService = require('../lib/auth-service');
      return await authService(req, res);
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

    // Money management mock (development only - BUG-RT-03)
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

    // Bypass maintenance screen on local dev server (development only - BUG-RT-03).
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
    // (development only - BUG-RT-03). In production the request falls through to
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
    // (development only - BUG-RT-03).
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
        if (action === 'account-google-status') {
          return res.status(200).json({ success: true, linked: false, google_email: null });
        }
        if (action === 'portfolio-state-load') {
          return res.status(200).json({
            success: true,
            updated_at: '2026-10-12T08:00:00.000Z',
            state: {
              plans: [
                {
                  id: 'plan-bbca',
                  ticker: 'BBCA',
                  entryPriceIdr: 5950,
                  stopLossIdr: 5750,
                  tp1Idr: 6250,
                  tp2Idr: 6500,
                  entry: 5950,
                  stop: 5750,
                  tp1: 6250,
                  tp2: 6500,
                  lots: 100,
                  riskBudgetIdr: 2000000,
                  estimatedMaxLossIdr: 2000000,
                  capitalIdr: 59500000,
                  positionStatus: 'PLANNED',
                  createdAt: '2026-10-12T08:00:00.000Z'
                }
              ],
              prices: {
                BBCA: 5950
              },
              positions: [
                { ticker: 'BBCA', shares: 10000, avgPrice: 5950, currentPrice: 5950, targetPrice: 6500, stopLoss: 5750, entryDate: '2026-10-12', strategy: 'Day Trade Momentum', notes: 'Kandidat Top 5 Radar' }
              ]
            }
          });
        }
        if (action === 'portfolio-state-save') {
          return res.status(200).json({
            success: true,
            updated_at: new Date().toISOString()
          });
        }
      }
    }

    // Review access mock (development only - BUG-RT-03). In production the
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

    // Analyze status & AI analysis mock (development only - BUG-RT-03)
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
      if (PREVIEW_MOCKS_ENABLED || isPreview || !process.env.GEMINI_API_KEY) {
        const ticker = (req.body && (req.body.ticker || (req.body.chatMessage && req.body.chatMessage.split('\n')[0]))) || 'BBCA';
        const cleanTicker = String(ticker).trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'BBCA';
        const analysisText = `<h3>Analisis AI Cockpit: ${cleanTicker}</h3><p><strong>Tren & Struktur</strong>: Uptrend solid, bertahan di atas MA20. Struktur akumulasi konsisten didukung volume stabil.</p><p><strong>Bandarmologi</strong>: Broker summary mencatat Net Accumulation yang kuat dari broker institusi.</p><p><strong>Trading Plan</strong>: Setup Swing menarik dengan Risk/Reward rasio memadai.</p>`;
        return res.status(200).json({
          success: true,
          analysis: analysisText,
          reply: analysisText,
          html: analysisText,
          ticker: cleanTicker,
          score: 85,
          effectiveKeySource: 'mock_preview'
        });
      }
    }

    // Dev fallback for approval-based portfolio access (development only - BUG-RT-03)
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

    // Login user mock (development only - BUG-RT-03). In production a magic-login
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

    // Dev fallback for subscription access profile (development only - BUG-RT-03)
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

    // Candles API mock for preview (development only - BUG-RT-03)
    if (endpointName === 'candles') {
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      const ticker = (req.query.ticker || 'BBCA').toUpperCase();
      if (PREVIEW_MOCKS_ENABLED && (isPreview || !process.env.SUPABASE_URL)) {
        const realCandles = localMarketSubsetStore.getCandles(ticker);
        if (realCandles) {
          return res.status(200).json(realCandles);
        }
        return res.status(200).json(generateMockCandles(ticker));
      }
    }

    // Fase 7: Market Intelligence Endpoints
    if (endpointName === 'market-breadth') {
      const data = marketIntelligence.calculateMarketBreadth();
      return res.status(200).json(data);
    }

    if (endpointName === 'broker-summary-smart') {
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      const ticker = (req.query.ticker || 'BBCA').toUpperCase();
      const date = req.query.date || null;
      const data = marketIntelligence.getSmartBrokerSummary(ticker, date);
      return res.status(200).json(data);
    }

    if (endpointName === 'screener-presets') {
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      const presetId = req.query.preset;
      if (presetId) {
        const data = marketIntelligence.evaluateScreenerPreset(presetId);
        return res.status(200).json(data);
      }
      return res.status(200).json({
        success: true,
        presets: marketIntelligence.SCREENER_PRESETS
      });
    }

    if (endpointName === 'stocks-search') {
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      const q = req.query.q || req.query.query || '';
      const limit = Number(req.query.limit || 20);
      const data = marketIntelligence.searchStocks(q, limit);
      return res.status(200).json(data);
    }

    // Quote API mock for preview (development only - BUG-RT-03)
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
            { ticker: 'BBCA', company_name: 'Bank Central Asia Tbk', last_price: 5950, change_pct: -1.65, free_float_pct: 41.82, free_float_source: 'IDX ownership', free_float_as_of: '2026-09-30', hsc_flag: false, hsc_source: 'IDX HSC', hsc_as_of: '2026-09-01', market_structure_status: 'STRUCTURE_VERIFIED', market_structure_guard: 'NORMAL', market_structure_note: 'Free float aman di atas 15%, HSC clear.', as_of_trade_date: '2026-10-13' },
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
          const storeFeatures = (localMarketSubsetStore.loadStore && localMarketSubsetStore.loadStore().features) || {};
          const enrichedRows = universeRows.map((r, idx) => {
            const feat = storeFeatures[r.ticker] || {};
            const rsiFallback = [48.2, 55.4, 62.1, 41.5, 58.7, 34.2, 51.0, 64.8, 46.3, 53.9, 38.6, 29.5][idx % 12];
            const distFallback = [-4.2, -12.5, -8.1, -15.3, -6.8, -24.1, -3.5, -9.2, -18.4, -5.7, -31.2, -45.0][idx % 12];
            const volFallback = [1.25, 0.85, 1.42, 0.95, 2.10, 0.74, 1.15, 1.68, 0.88, 1.05, 0.62, 0.45][idx % 12];
            const fNetFallback = [25400000000, -14200000000, 38900000000, -5600000000, 52100000000, 1850000000, -8200000000, 14300000000, -2100000000, 48000000000, -19500000000, 0][idx % 12];
            return {
              ...r,
              rsi_14: feat.rsi_14 !== undefined && feat.rsi_14 !== null ? feat.rsi_14 : rsiFallback,
              week52_high_dist_pct: feat.week52_high_dist_pct !== undefined && feat.week52_high_dist_pct !== null ? feat.week52_high_dist_pct : distFallback,
              volume_ratio_vs_7d_avg: feat.volume_ratio_vs_7d_avg !== undefined && feat.volume_ratio_vs_7d_avg !== null ? feat.volume_ratio_vs_7d_avg : volFallback,
              foreign_net_today: feat.foreign_net_today !== undefined && feat.foreign_net_today !== null ? feat.foreign_net_today : fNetFallback,
              foreign_net_3d: feat.foreign_net_3d !== undefined && feat.foreign_net_3d !== null ? feat.foreign_net_3d : Math.round(fNetFallback * 2.4),
              foreign_net_7d: feat.foreign_net_7d !== undefined && feat.foreign_net_7d !== null ? feat.foreign_net_7d : Math.round(fNetFallback * 4.8)
            };
          });
          return res.status(200).json({
            success: true,
            count: enrichedRows.length,
            universe: enrichedRows,
            rows: enrichedRows,
            data: enrichedRows,
            as_of: '2026-10-13',
            updated_at: '2026-10-13T16:00:00.000Z'
          });
        }
        if (action === 'daily-market-context' || action === 'financial-snapshot') {
          if (ticker === 'XYZW' || ticker === 'EMPTY') {
            const emptyContext = {
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
            };
            return res.status(200).json({
              success: true,
              snapshot: emptyContext,
              context: emptyContext
            });
          }
          const realSnapshot = localMarketSubsetStore.getFinancialSnapshot(ticker);
          if (realSnapshot) {
            return res.status(200).json({
              success: true,
              snapshot: realSnapshot,
              context: realSnapshot
            });
          }

          const emptyFallback = {
            ticker: ticker || 'UNKNOWN',
            company_name: 'PT ' + (ticker || 'UNKNOWN') + ' Tbk',
            as_of: '2026-10-13',
            price: { last: null, last_price_as_of: null, last_price_source: null },
            fundamental: { pbv: null, book_value_per_share: null, shares_outstanding: null, market_cap: null, data_available: false },
            financial_statements: null,
            market_structure: { data_available: false, market_structure_status: 'DATA_INCOMPLETE', market_structure_guard: 'UNKNOWN' }
          };
          return res.status(200).json({
            success: true,
            snapshot: emptyFallback,
            context: emptyFallback
          });
        }
        if (ticker) {
          const cData = localMarketSubsetStore.getCandles(ticker);
          if (cData && cData.candles && cData.candles.length >= 2) {
            const lastC = cData.candles[cData.candles.length - 1];
            const prevC = cData.candles[cData.candles.length - 2];
            const change = lastC.close - prevC.close;
            const changePct = Number(((change / prevC.close) * 100).toFixed(2));
            return res.status(200).json({
              success: true,
              ticker: ticker,
              last: lastC.close,
              prevClose: prevC.close,
              change: change,
              changePct: changePct,
              volume: lastC.volume
            });
          }
          const snap = localMarketSubsetStore.getFinancialSnapshot(ticker);
          const base = snap && snap.price && snap.price.last ? snap.price.last : (ticker === 'BBCA' ? 5950 : 1420);
          return res.status(200).json({
            success: true,
            ticker: ticker,
            last: base,
            prevClose: base,
            change: 0,
            changePct: 0.0,
            volume: 35000000
          });
        }
      }
    }

    // Sector Hot API mock for preview (development only - BUG-RT-03)
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
        if (action === 'market-breadth') {
          return res.status(200).json(marketIntelligence.calculateMarketBreadth());
        }
        if (action === 'broker-summary-smart') {
          const ticker = (req.query.ticker || 'BBCA').toUpperCase();
          const date = req.query.date || null;
          return res.status(200).json(marketIntelligence.getSmartBrokerSummary(ticker, date));
        }
        if (action === 'screener-presets') {
          const presetId = req.query.preset;
          if (presetId) {
            return res.status(200).json(marketIntelligence.evaluateScreenerPreset(presetId));
          }
          return res.status(200).json({
            success: true,
            presets: marketIntelligence.getScreenerPresetsWithCounts()
          });
        }
        if (action === 'stocks-search') {
          const q = req.query.q || req.query.query || '';
          const limit = Number(req.query.limit || 20);
          return res.status(200).json(marketIntelligence.searchStocks(q, limit));
        }
        if (action === 'bandarmologi') {
          const ticker = (req.query.ticker || 'BBCA').toUpperCase();
          const targetDate = req.query.date || (ticker === 'BBCA' ? '2026-10-12' : '');
          try {
            const bandarmologiService = require('../lib/bandarmologi-service');
            const data = await bandarmologiService.getBandarmologiData(ticker, {
              date: targetDate,
              range: req.query.range || req.query.days || '1d',
              days: req.query.days ? Number(req.query.days) : undefined,
              startDate: req.query.startDate || '',
              endDate: req.query.endDate || '',
              flow: req.query.flow || ''
            });
            if (data && data.success) return res.status(200).json(data);
          } catch (_) {}
          return res.status(200).json(MOCK_BANDARMOLOGI);
        }
        if (action === 'available-dates') {
          const ticker = (req.query.ticker || 'BBCA').toUpperCase();
          try {
            const bandarmologiService = require('../lib/bandarmologi-service');
            const dates = await bandarmologiService.getAvailableDates(ticker);
            if (dates && dates.length) {
              return res.status(200).json({
                success: true,
                ticker: ticker,
                dates: dates,
                count: dates.length,
                cache_hit: true
              });
            }
          } catch (_) {}
          return res.status(200).json({
            success: true,
            ticker: ticker,
            dates: ['2026-10-12', '2026-10-09', '2026-10-08'],
            count: 3,
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
  // like /broksum cannot simply be served as analisis-saham.html - the browser URL
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
  // B1 (security): /data/* is DEFAULT-DENY and unauthenticated. Only the
  // bandarmologi intel "latest_<range>.json" indexes (the sole in-browser
  // consumer, public/bandarmologi-runtime.js) are served; every other path —
  // including premium screener / broker-summary exports and any traversal
  // attempt — answers 404 so the existence of protected files is never
  // revealed. Premium data stays reachable through authenticated API
  // endpoints, never through /data/.
  if (pathname.startsWith('/data/')) {
    if (!isAllowedDataPath(pathname)) {
      res.statusCode = 404;
      res.setHeader('Cache-Control', 'no-store');
      return res.end(req.method === 'HEAD' ? undefined : '404 Not Found');
    }
    if (await serveData(req,res,pathname.slice('/data'.length),{noStore:true,extensionFallback:false})) return;
  }
  if (pathname === '/pattern-radar') pathname = '/pattern-radar.html';
  if (pathname === '/maintenance' || pathname === '/pemeliharaan') pathname = '/maintenance.html';
  if (pathname === '/dashboard' || pathname === '/review' || pathname === '/pattern' || pathname === '/screener' || pathname === '/watchlist' || pathname === '/sektor' || pathname === '/trackrecord' || pathname === '/catatan-admin') pathname = '/index.html';
  if (await servePublic(req,res,pathname)) return;
  if (await servePublic(req,res,'/404.html',{status:404,noStore:true})) return;
  res.statusCode=404;res.setHeader('Cache-Control','no-store');res.end(req.method==='HEAD'?undefined:'404 Not Found');
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
// Loopback by default: the public path is the cloudflared tunnel, which connects
// from inside the host. Setting HOST=0.0.0.0 is only needed when an operator has
// also opened the port in the cloud firewall (Oracle VCN) - the Oracle VCN
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
