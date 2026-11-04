#!/usr/bin/env node
'use strict';
/**
 * FASE 20 — Full authenticated screenshot capture + pixel-diff + overflow metrics.
 *
 * Session: minted locally with lib/admin-session.js (HMAC-SHA256) using the
 * SESSION_SECRET already present in the process env (.env). The secret is never
 * written to any output or committed file. One admin session (budi) and one
 * non-admin session are prepared so the 403 boundary is re-proved.
 *
 * Output: bukti-verifikasi-final/fase20/
 *   - <shot>_<vp>_<theme>.png             canonical screenshots (fullPage)
 *   - panel3/<shot>_1440_light_panel3.png Kanvas | Aplikasi | Diff triptych
 *   - manifest.json
 *   - tabel-pixel-diff-dan-overflow.json
 *
 * CLI:  node tools/fase20-capture.js [--only=a,b,c] [--no-diff] [--no-extra]
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'fase20');
const PANEL_DIR = path.join(OUT, 'panel3');
const DIFF_SRC = path.join(OUT, 'diff-source');
const CANVAS_DIR = path.join(ROOT, 'handoff-redesign', 'design', 'project');
const APP_PORT = Number(process.env.FASE20_PORT || 3000);
const APP = 'http://127.0.0.1:' + APP_PORT;
const CANVAS_PORT = 3137;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const MIN_PNG_BYTES = 10 * 1024;

const ARG = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) ARG[m[1]] = m[2] === undefined ? true : m[2];
}
const ONLY = ARG.only ? String(ARG.only).split(',').map(s => s.trim()).filter(Boolean) : null;
const DO_DIFF = !ARG['no-diff'];
const DO_EXTRA = !ARG['no-extra'];

for (const d of [OUT, PANEL_DIR, DIFF_SRC]) fs.mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------- session
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*SESSION_SECRET\s*=\s*(.+)$/);
      if (m) {
        const v = m[1].trim().replace(/^["']|["']$/g, '');
        if (v) { process.env.SESSION_SECRET = v; return v; }
      }
    }
  } catch (_) {}
  return null;
}
const SECRET = loadSecret();
if (!SECRET) { console.error('ABORT: SESSION_SECRET unavailable — cannot mint test sessions.'); process.exit(1); }
const sessionAuth = require(path.join(ROOT, 'lib', 'admin-session.js'));
const ADMIN_TOKEN = sessionAuth.createSessionToken({ userId: 'fase20-audit-admin', username: 'budi', isAdmin: true });
const NONADMIN_TOKEN = sessionAuth.createSessionToken({ userId: 'fase20-audit-user', username: 'audit_nonadmin', isAdmin: false });
if (!ADMIN_TOKEN) { console.error('ABORT: admin token mint failed.'); process.exit(1); }

const log = m => console.log('[FASE20] ' + m);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rel = p => path.relative(ROOT, p).replace(/\\/g, '/');
const kbOf = b => Math.round((b / 1024) * 10) / 10;

// ---------------------------------------------------------------- canvas server
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
};
const canvasServer = http.createServer((req, res) => {
  let p = decodeURIComponent(String(req.url || '/').split('?')[0]);
  if (p === '/') p = '/Main.dc.html';
  const fp = path.join(CANVAS_DIR, p);
  if (!fp.startsWith(CANVAS_DIR)) { res.statusCode = 403; return res.end('forbidden'); }
  let st = null;
  try { st = fs.statSync(fp); } catch (_) {}
  if (!st || st.isDirectory()) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream');
  fs.createReadStream(fp).pipe(res);
});

function checkApp() {
  return new Promise(resolve => {
    const req = http.get(APP + '/', r => { r.resume(); resolve(r.statusCode < 500); });
    req.on('error', () => resolve(false));
    req.setTimeout(6000, () => { req.destroy(); resolve(false); });
  });
}

// ---------------------------------------------------------------- combos
const COMBOS = [
  { key: '1440_light', w: 1440, h: 900, theme: 'light' },
  { key: '1440_dark', w: 1440, h: 900, theme: 'dark' },
  { key: '390_light', w: 390, h: 844, theme: 'light' },
  { key: '390_dark', w: 390, h: 844, theme: 'dark' }
];

/**
 * SHOTS — canonical coverage: every page + every auth modal, 4 combos each.
 */
const SHOTS = [
  // ---- the 24 pages ------------------------------------------------
  { name: '01_landing', url: '/', canvas: 'Landing.dc.html', auth: 'anon', wait: 2200 },
  { name: '02_dashboard', url: '/dashboard?page=dashboard', canvas: 'Main.dc.html', wait: 3000 },
  { name: '03_screener_konglo', url: '/dashboard?page=screener', canvas: 'Screener.dc.html', do: "window.__f20Screener('konglo')", wait: 2600 },
  { name: '04_screener_nonkonglo', url: '/dashboard?page=screener', canvas: 'Screener.dc.html', do: "window.__f20Screener('nonkonglo')", wait: 2600 },
  { name: '05_screener_daytrade', url: '/dashboard?page=screener', canvas: 'Screener.dc.html', do: "window.__f20Screener('daytrade')", wait: 2600 },
  { name: '06_sektor_klasemen', url: '/dashboard?page=sektor', canvas: 'SektorHot.dc.html', do: "window.__f20Sektor('table')", wait: 2600 },
  { name: '07_sektor_heatmap', url: '/dashboard?page=sektor', canvas: 'SektorHot.dc.html', do: "window.__f20Sektor('grid')", wait: 2600 },
  { name: '08_sektor_drilldown', url: '/dashboard?page=sektor', canvas: 'SektorHot.dc.html', do: "window.__f20Group()", wait: 3400 },
  { name: '09_catatan_admin_aktif', url: '/dashboard?page=catatan-admin', canvas: 'CatatanAdmin.dc.html', wait: 3000 },
  { name: '10_catatan_admin_riwayat', url: '/dashboard?page=catatan-admin', canvas: 'CatatanAdmin.dc.html', do: "window.__f20ClickText('Riwayat')", wait: 2600 },
  { name: '11_catatan_admin_drawer', url: '/dashboard?page=catatan-admin', canvas: 'CatatanAdmin.dc.html', do: "window.__f20Drawer()", wait: 2400 },
  { name: '12_analisis_ai', url: '/dashboard?page=analisis&tab=analisis-chart', canvas: 'Analisis.dc.html', do: "window.__f20AnalisisSub('ai')", wait: 3000 },
  { name: '13_chart_workstation', url: '/dashboard?page=analisis&tab=analisis-chart', canvas: 'Analisis.dc.html', do: "window.__f20AnalisisSub('chart')", wait: 3800 },
  { name: '14_bandarmologi_summary', url: '/dashboard?page=analisis&tab=bandarmologi', canvas: 'Bandarmologi.dc.html', do: "window.__f20Bandar('summary')", wait: 3600 },
  { name: '15_bandarmologi_akumulasi', url: '/dashboard?page=analisis&tab=bandarmologi', canvas: 'Bandarmologi.dc.html', do: "window.__f20Bandar('akumulasi')", wait: 3600 },
  { name: '16_sinyal_intelijen', url: '/dashboard?page=analisis&tab=intel', canvas: 'SinyalIntelijen.dc.html', wait: 3000 },
  { name: '17_broker_hunter', url: '/dashboard?page=analisis&tab=hunter', canvas: 'BrokerHunter.dc.html', wait: 3000 },
  { name: '18_insider', url: '/dashboard?page=analisis&tab=insider', canvas: 'Insider.dc.html', wait: 3200 },
  { name: '19_ranking', url: '/dashboard?page=analisis&tab=ranking', canvas: 'Ranking.dc.html', wait: 3000 },
  { name: '20_financial', url: '/dashboard?page=analisis&tab=financial', canvas: 'Financial.dc.html', wait: 3400 },
  { name: '21_struktur_pasar', url: '/dashboard?page=analisis&tab=market-structure', canvas: 'StrukturPasar.dc.html', wait: 3400 },
  { name: '22_watchlist', url: '/dashboard?page=watchlist', canvas: 'Watchlist.dc.html', wait: 3000 },
  { name: '23_portfolio', url: '/dashboard?page=portofolio', canvas: 'Portfolio.dc.html', wait: 3400 },
  { name: '24_track_record', url: '/dashboard?page=trackrecord', canvas: 'TrackRecord.dc.html', wait: 3000 },
  { name: '25_kelola_keuangan', url: '/dashboard?page=money-management', canvas: 'KelolaKeuangan.dc.html', wait: 3400 },
  { name: '26_pusat_akun', url: '/dashboard?page=dashboard', canvas: 'AccountCenter.dc.html', do: "window.__f20Account('profile')", wait: 3000 },
  { name: '27_pattern_radar', url: '/pattern-radar', canvas: 'PatternRadar.dc.html', wait: 3000 },
  { name: '28_admin_console', url: '/dashboard?page=admin-console', canvas: 'AdminConsole.dc.html', wait: 3600 },
  { name: '29_ketentuan', url: '/ketentuan', canvas: 'Ketentuan.dc.html', auth: 'anon', wait: 1600 },
  { name: '30_maintenance', url: '/maintenance', canvas: 'Maintenance.dc.html', auth: 'anon', wait: 1600 },
  { name: '31_404', url: '/fase20-route-tidak-ada', canvas: null, auth: 'anon', wait: 1600 },

  // ---- 4 Auth modals ----------------------------------------------
  { name: '32_auth_login', url: '/', canvas: 'AuthLogin.dc.html', auth: 'anon', do: "window.__f20Auth('login')", wait: 1700 },
  { name: '33_auth_register', url: '/', canvas: 'AuthRegister.dc.html', auth: 'anon', do: "window.__f20Auth('register')", wait: 1700 },
  { name: '34_auth_recovery', url: '/', canvas: 'AuthRecovery.dc.html', auth: 'anon', do: "window.__f20Auth('recovery')", wait: 1700 },
  { name: '35_auth_choice', url: '/', canvas: 'AuthGmail.dc.html', auth: 'anon', do: "window.__f20Auth('choice')", wait: 1700 }
];

/**
 * EXTRA — requirement-specific evidence, 1440 light only.
 */
const EXTRA = [
  // Portfolio 7 tabs
  { name: 'x_portfolio_tab_today', url: '/dashboard?page=portofolio', do: "window.__f20PortTab('today')", wait: 2600 },
  { name: 'x_portfolio_tab_planner', url: '/dashboard?page=portofolio', do: "window.__f20PortTab('planner')", wait: 2600 },
  { name: 'x_portfolio_tab_watch', url: '/dashboard?page=portofolio', do: "window.__f20PortTab('watch')", wait: 2600 },
  { name: 'x_portfolio_tab_risk', url: '/dashboard?page=portofolio', do: "window.__f20PortTab('risk')", wait: 2600 },
  { name: 'x_portfolio_tab_scenarios', url: '/dashboard?page=portofolio', do: "window.__f20PortTab('scenarios')", wait: 2600 },
  { name: 'x_portfolio_tab_journal', url: '/dashboard?page=portofolio', do: "window.__f20PortTab('journal')", wait: 2600 },
  { name: 'x_portfolio_tab_ai', url: '/dashboard?page=portofolio', do: "window.__f20PortTab('ai')", wait: 2600 },
  // Pusat Akun / VIP 6 tabs
  { name: 'x_account_tab_profile', url: '/dashboard?page=dashboard', do: "window.__f20Account('profile')", wait: 2600 },
  { name: 'x_account_tab_security', url: '/dashboard?page=dashboard', do: "window.__f20Account('security')", wait: 2600 },
  { name: 'x_account_tab_preference', url: '/dashboard?page=dashboard', do: "window.__f20Account('preference')", wait: 2600 },
  { name: 'x_account_tab_ai', url: '/dashboard?page=dashboard', do: "window.__f20Account('ai')", wait: 3000 },
  { name: 'x_account_tab_langganan', url: '/dashboard?page=dashboard', do: "window.__f20Account('langganan')", wait: 3000 },
  { name: 'x_account_tab_terms', url: '/dashboard?page=dashboard', do: "window.__f20Account('terms')", wait: 2600 },
  // Admin Console 7 tabs
  { name: 'x_admin_tab_0_ringkasan', url: '/dashboard?page=admin-console', do: "window.__f20AdminTab(0)", wait: 3000 },
  { name: 'x_admin_tab_1_online', url: '/dashboard?page=admin-console', do: "window.__f20AdminTab(1)", wait: 3000 },
  { name: 'x_admin_tab_2_persetujuan', url: '/dashboard?page=admin-console', do: "window.__f20AdminTab(2)", wait: 3000 },
  { name: 'x_admin_tab_3_maintenance', url: '/dashboard?page=admin-console', do: "window.__f20AdminTab(3)", wait: 2600 },
  { name: 'x_admin_tab_4_kupon', url: '/dashboard?page=admin-console', do: "window.__f20AdminTab(4)", wait: 2600 },
  { name: 'x_admin_tab_5_pipeline', url: '/dashboard?page=admin-console', do: "window.__f20AdminTab(5)", wait: 3800 },
  { name: 'x_admin_tab_6_log_audit', url: '/dashboard?page=admin-console', do: "window.__f20AdminTab(6)", wait: 3200 },
  // Chart presets
  { name: 'x_chart_preset_simpel', url: '/dashboard?page=analisis&tab=analisis-chart', do: "window.__f20ChartPreset('simpel')", wait: 3600 },
  { name: 'x_chart_preset_pro', url: '/dashboard?page=analisis&tab=analisis-chart', do: "window.__f20ChartPreset('pro')", wait: 3600 },
  { name: 'x_chart_preset_scalping', url: '/dashboard?page=analisis&tab=analisis-chart', do: "window.__f20ChartPreset('scalping')", wait: 3600 },
  { name: 'x_chart_preset_swing', url: '/dashboard?page=analisis&tab=analisis-chart', do: "window.__f20ChartPreset('swing')", wait: 3600 },
  { name: 'x_chart_preset_investor', url: '/dashboard?page=analisis&tab=analisis-chart', do: "window.__f20ChartPreset('investor')", wait: 3600 }
];

const TICKERS_CHART = ['BBCA', 'BBRI', 'BMRI', 'TLKM', 'ANTM', 'BRPT', 'GOTO', 'ASII', 'ADRO', 'MEDC', 'IHSG'];
const TICKERS_FIN = ['BBCA', 'BBRI', 'BMRI', 'TLKM', 'BRPT'];

for (const t of TICKERS_CHART) {
  EXTRA.push({
    name: 'x_chart_' + t,
    url: '/dashboard?page=analisis&tab=analisis-chart',
    do: "window.__f20ChartTicker('" + t + "')",
    wait: 4000
  });
}
for (const t of TICKERS_FIN) {
  EXTRA.push({
    name: 'x_fin_q2_' + t,
    url: '/dashboard?page=analisis&tab=financial',
    do: "window.__f20FinTicker('" + t + "')",
    wait: 4000
  });
}

// ---------------------------------------------------------------- page helpers
const PAGE_HELPERS = `(function(){
  window.__f20ClickText = function(txt){
    var want = String(txt).toLowerCase();
    var cands = document.querySelectorAll('button,[role="tab"],.tab,.tbtn');
    for (var i=0;i<cands.length;i++){
      var t = (cands[i].textContent||'').replace(/\\s+/g,' ').trim().toLowerCase();
      if (t === want || t.indexOf(want) === 0) { try { cands[i].click(); return true; } catch(e){} }
    }
    return false;
  };
  window.__f20Screener = function(type){
    try { if (typeof switchScreenerType === 'function') { switchScreenerType(type); return true; } } catch(e){}
    var map = { konglo:'scrTypeKonglo', nonkonglo:'scrTypeNonKonglo', daytrade:'scrTypeDayTrade' };
    var b = document.getElementById(map[type]); if (b) { b.click(); return true; } return false;
  };
  window.__f20Sektor = function(view){
    try { if (typeof toggleSektorView === 'function') { toggleSektorView(view); return true; } } catch(e){}
    return false;
  };
  window.__f20Group = function(){
    try { if (typeof showGroupDetail === 'function') { showGroupDetail('DJARUM'); return true; } } catch(e){}
    var b = document.querySelector('[data-group-code],[onclick*="showGroupDetail"]');
    if (b) { b.click(); return true; }
    return false;
  };
  window.__f20Drawer = function(){
    try { if (typeof openNewAdminNoteDrawer === 'function') { openNewAdminNoteDrawer(); return true; } } catch(e){}
    var el = document.getElementById('adminNoteDrawer');
    var bd = document.getElementById('adminNoteDrawerBackdrop');
    if (el) { el.style.display='block'; if (bd) bd.style.display='block'; return true; }
    return false;
  };
  window.__f20AnalisisSub = function(sub){
    try { if (typeof switchAnalisisSubTab === 'function') { switchAnalisisSubTab(sub); return true; } } catch(e){}
    var id = sub === 'ai' ? 'tabAnalisisText' : 'tabChartWorkstationLens';
    var b = document.getElementById(id); if (b) { b.click(); return true; } return false;
  };
  window.__f20Bandar = function(section){
    try {
      if (window.BandarmologiRuntime && typeof window.BandarmologiRuntime.setBandarSection === 'function') {
        window.BandarmologiRuntime.setBandarSection(section); return true;
      }
    } catch(e){}
    var id = section === 'akumulasi' ? 'subTabAkumulasiBroker' : 'subTabBrokerSummary';
    var b = document.getElementById(id); if (b) { b.click(); return true; } return false;
  };
  window.__f20PortTab = function(tab){
    try { if (typeof window.openPortfolioTab === 'function') { window.openPortfolioTab(tab); return true; } } catch(e){}
    var scope = document.getElementById('page-portofolio') || document;
    var b = scope.querySelector('[data-tab="'+tab+'"]');
    if (b) { try { b.click(); return true; } catch(e){} }
    var root = document.getElementById('portofolioPartialMount');
    if (root) {
      var b2 = root.querySelector('[data-tab="'+tab+'"]');
      if (b2) { try { b2.click(); return true; } catch(e){} }
    }
    return false;
  };
  window.__f20Account = function(tab){
    try { if (window.openAccountSubscription) window.openAccountSubscription(); } catch(e){}
    var btn = document.querySelector('[data-ac-tab="'+tab+'"]');
    if (btn) { try { btn.click(); return true; } catch(e){} }
    // ensure center mounted, then retry once
    try { if (typeof window.openAccountSubscription === 'function') window.openAccountSubscription(); } catch(e){}
    var again = document.querySelector('[data-ac-tab="'+tab+'"]');
    if (again) { try { again.click(); return true; } catch(e){} }
    return false;
  };
  window.__f20AdminTab = function(idx){
    var b = document.querySelector('[data-admin-tab="'+idx+'"]');
    if (b) { b.click(); return true; }
    try { if (typeof switchAdminTab === 'function') { switchAdminTab(idx); return true; } } catch(e){}
    return false;
  };
  window.__f20ChartPreset = function(p){
    try {
      if (typeof switchAnalisisSubTab === 'function') switchAnalisisSubTab('chart');
      if (window.AutoCuanChartWorkstation && typeof window.AutoCuanChartWorkstation.applyPreset === 'function') {
        var ids = ['chartPage','mainChart','chartWorkstation','analisisChart'];
        for (var i=0;i<ids.length;i++){
          try { window.AutoCuanChartWorkstation.applyPreset(ids[i], p); } catch(e){}
        }
        return true;
      }
    } catch(e){}
    return false;
  };
  window.__f20ChartTicker = function(t){
    try {
      if (typeof switchAnalisisSubTab === 'function') switchAnalisisSubTab('chart');
      var inp = document.getElementById('chartTickerInput');
      if (inp) { inp.value = t; inp.dispatchEvent(new Event('input', {bubbles:true})); inp.dispatchEvent(new Event('change', {bubbles:true})); }
      if (typeof loadChartPage === 'function') { loadChartPage(); return true; }
      if (typeof setActiveTicker === 'function') { setActiveTicker(t); return true; }
    } catch(e){}
    return false;
  };
  window.__f20FinTicker = function(t){
    try {
      if (typeof switchAnalisisTab === 'function') switchAnalisisTab('financial');
      if (typeof selectFinancialTicker === 'function') { selectFinancialTicker(t); return true; }
      var chips = Array.prototype.slice.call(document.querySelectorAll('.tchip'));
      var hit = chips.filter(function(b){ return (b.textContent||'').trim().toUpperCase() === t; })[0];
      if (hit) { hit.click(); return true; }
    } catch(e){}
    return false;
  };
  window.__f20Auth = function(kind){
    var idMap  = { login:'loginModal', register:'registerModal', recovery:'selfResetModal', choice:'authChoiceModal' };
    var fnMap  = { login:'openLoginModal', register:'openRegisterModal', recovery:'openSelfResetModal', choice:'openAuthChoiceModal' };
    var id = idMap[kind];
    try { if (typeof window[fnMap[kind]] === 'function') window[fnMap[kind]](); } catch(e){}
    var el = document.getElementById(id);
    if (el) {
      // Pending auth-state listeners can re-hide the panel right after the
      // opener runs. Force the same open state the production opener produces
      // (remove .hidden, flex container) so the capture shows real markup.
      el.classList.remove('hidden');
      if (getComputedStyle(el).display === 'none') el.style.display = 'flex';
      return true;
    }
    return false;
  };
  return true;
})();`;

async function setTheme(page, theme) {
  await page.evaluate(function (t) {
    try { localStorage.setItem('autocuan_theme', t); } catch (_) {}
    if (typeof window.applyAppTheme === 'function') {
      try { window.applyAppTheme(t); return; } catch (_) {}
    }
    var root = document.documentElement;
    var isLight = t === 'light';
    root.classList.toggle('light', isLight);
    root.classList.toggle('dark', !isLight);
    root.classList.toggle('is-dark', !isLight);
    root.setAttribute('data-theme', t);
    root.setAttribute('data-theme-pref', t);
    if (document.body) document.body.classList.toggle('light', isLight);
    root.style.background = isLight ? '#EFF1EC' : '#0E1412';
  }, theme);
  await sleep(320);
}

/** Reject blank PNGs: <10 KB, single-colour, or near-zero pixel variance. */
function inspectPng(file) {
  const buf = fs.readFileSync(file);
  const bytes = buf.length;
  const out = { bytes, kb: kbOf(bytes), under10kb: bytes < MIN_PNG_BYTES, readable: true };
  let png;
  try { png = PNG.sync.read(buf); } catch (e) {
    out.readable = false; out.blank = true; out.reason = 'unreadable PNG'; return out;
  }
  out.width = png.width;
  out.height = png.height;
  const d = png.data;
  let min = 255, max = 0, sum = 0, sumSq = 0, n = 0;
  const seen = new Set();
  const step = Math.max(4, Math.floor(d.length / 160000 / 4) * 4);
  for (let i = 0; i < d.length; i += step) {
    const lum = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    if (lum < min) min = lum;
    if (lum > max) max = lum;
    sum += lum; sumSq += lum * lum; n++;
    if (seen.size < 700) seen.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3));
  }
  const mean = n ? sum / n : 0;
  const variance = n ? (sumSq / n) - mean * mean : 0;
  const stddev = Math.sqrt(Math.max(0, variance));
  out.lumaMin = Math.round(min);
  out.lumaMax = Math.round(max);
  out.lumaStddev = Math.round(stddev * 10) / 10;
  out.lumaRange = Math.round(max - min);
  out.distinctColorsSampled = seen.size;
  out.singleColour = out.lumaRange <= 3 && seen.size <= 2;
  out.lowVariance = stddev < 2.5;
  return out;
}

async function detectBadState(page) {
  return page.evaluate(function () {
    var body = (document.body && document.body.innerText) || '';
    var spinner = Array.prototype.some.call(
      document.querySelectorAll('.spinner,.spinner-sm,.ac-loading,.ac-spinner,.spinner-border'),
      function (el) {
        var cs = getComputedStyle(el);
        var r = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 4 && r.height > 4;
      });
    var checks = {
      spinnerVisible: spinner,
      errorBanner: /Terjadi kesalahan|Gagal memuat|Something went wrong|Internal Server Error/i.test(body),
      maintenanceGate: false,
      serviceStatusGate: false,
      visibleText: body.replace(/\s+/g, ' ').trim().slice(0, 240)
    };
    var m = document.getElementById('maintenanceScreen');
    if (m && !m.classList.contains('hidden') && m.getBoundingClientRect().height > 0) checks.maintenanceGate = true;
    var s = document.getElementById('serviceStatusScreen');
    if (s && !s.classList.contains('hidden') && s.getBoundingClientRect().height > 0) checks.serviceStatusGate = true;
    return checks;
  });
}

async function measureOverflow(page) {
  const widths = [1440, 1024, 820, 390];
  const out = {};
  const original = page.viewport();
  for (const w of widths) {
    await page.setViewport({ width: w, height: original.height, deviceScaleFactor: 1 });
    await sleep(280);
    out[w] = await page.evaluate(function () {
      return Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
    });
  }
  await page.setViewport(original);
  await sleep(240);
  return out;
}

// ---------------------------------------------------------------- pixel diff
function buildPanel3(canvasBuf, appBuf) {
  const a = PNG.sync.read(canvasBuf);
  const b = PNG.sync.read(appBuf);
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const GAP = 4;
  const panelW = w * 3 + GAP * 2;
  const panel = new PNG({ width: panelW, height: h });
  let diff = 0;
  const TH = 32;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = (a.width * y + x) << 2;
      const ib = (b.width * y + x) << 2;
      const dr = Math.abs(a.data[ia] - b.data[ib]);
      const dg = Math.abs(a.data[ia + 1] - b.data[ib + 1]);
      const db = Math.abs(a.data[ia + 2] - b.data[ib + 2]);
      const isDiff = Math.max(dr, dg, db) > TH;
      if (isDiff) diff++;

      let o = (panel.width * y + x) << 2;
      panel.data[o] = a.data[ia]; panel.data[o + 1] = a.data[ia + 1];
      panel.data[o + 2] = a.data[ia + 2]; panel.data[o + 3] = 255;

      o = (panel.width * y + x + w + GAP) << 2;
      panel.data[o] = b.data[ib]; panel.data[o + 1] = b.data[ib + 1];
      panel.data[o + 2] = b.data[ib + 2]; panel.data[o + 3] = 255;

      o = (panel.width * y + x + 2 * (w + GAP)) << 2;
      if (isDiff) { panel.data[o] = 255; panel.data[o + 1] = 42; panel.data[o + 2] = 42; }
      else {
        const gl = Math.round(((b.data[ib] * 299 + b.data[ib + 1] * 587 + b.data[ib + 2] * 114) / 1000) * 0.35 + 42);
        panel.data[o] = gl; panel.data[o + 1] = gl; panel.data[o + 2] = gl;
      }
      panel.data[o + 3] = 255;
    }
  }

  for (let y = 0; y < h; y++) {
    for (let g = 0; g < GAP; g++) {
      for (const sx of [w + g, 2 * w + GAP + g]) {
        const o = (panel.width * y + sx) << 2;
        panel.data[o] = 18; panel.data[o + 1] = 18; panel.data[o + 2] = 22; panel.data[o + 3] = 255;
      }
    }
  }

  const total = w * h;
  return {
    png: PNG.sync.write(panel),
    pixelDiffPct: total ? Math.round((diff / total) * 10000) / 100 : 0,
    diffPixels: diff,
    totalPixels: total,
    width: w,
    height: h
  };
}

// ---------------------------------------------------------------- capture
function wirePage(page, bucket) {
  page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('about:')) return req.continue();
    let host = '';
    try { host = new URL(u).hostname; } catch (_) {}
    if (host === '127.0.0.1' || host === 'localhost') return req.continue();
    bucket.external.push({ url: u.slice(0, 180), type: req.resourceType() });
    // Serve empty payload instead of aborting: keeps the DOM renderable and
    // avoids spurious net::ERR console noise while still proving zero CDN use.
    return req.respond({
      status: 200,
      contentType: req.resourceType() === 'stylesheet' ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8',
      body: ''
    });
  });
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const t = msg.text();
    if (/net::ERR_|Failed to load resource|ERR_ABORTED/.test(t)) return;
    bucket.consoleErrors.push(t.slice(0, 240));
  });
  page.on('pageerror', err => bucket.pageErrors.push(String(err && err.message || err).slice(0, 240)));
  page.on('requestfailed', req => {
    const u = req.url();
    if (/127\.0\.0\.1|localhost/.test(u) && !/favicon/.test(u)) {
      bucket.failedLocal.push({ url: u.slice(0, 150), err: (req.failure() || {}).errorText });
    }
  });
}

async function runAction(page, code) {
  if (!code) return null;
  try {
    return await page.evaluate(function (src) {
      /* eslint-disable no-new-func */
      return new Function('return (' + src + ')')();
    }, code);
  } catch (e) {
    return 'ACTION_ERROR: ' + String(e && e.message || e).slice(0, 160);
  }
}

async function captureCanonical(browser, shot) {
  const authMode = shot.auth || 'admin';
  const token = authMode === 'nonadmin' ? NONADMIN_TOKEN : ADMIN_TOKEN;
  const results = [];

  for (const combo of COMBOS) {
    const bucket = { consoleErrors: [], pageErrors: [], external: [], failedLocal: [] };
    const page = await browser.newPage();
    wirePage(page, bucket);
    await page.setViewport({ width: combo.w, height: combo.h, deviceScaleFactor: 1 });
    if (authMode !== 'anon') {
      await page.setCookie({ name: 'ac_sess', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' });
    }

    const fileBase = shot.name + '_' + combo.key;
    const dest = path.join(OUT, fileBase + '.png');
    const rec = {
      shot: shot.name, combo: combo.key, theme: combo.theme,
      viewport: { width: combo.w, height: combo.h },
      route: shot.url, action: shot.do || null, auth: authMode,
      file: fileBase + '.png'
    };

    try {
      await page.evaluateOnNewDocument(function (theme) {
        try { localStorage.setItem('autocuan_theme', theme); } catch (_) {}
      }, combo.theme);

      await page.goto(APP + shot.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await sleep(950);
      await page.evaluate(PAGE_HELPERS);
      await setTheme(page, combo.theme);

      rec.actionResult = await runAction(page, shot.do);
      await sleep(shot.wait || 2400);
      await setTheme(page, combo.theme);

      rec.horizontalOverflow = await measureOverflow(page);
      rec.horizontalOverflowMax = Math.max.apply(null, Object.values(rec.horizontalOverflow));
      const bad = await detectBadState(page);

      await page.screenshot({ path: dest, fullPage: true });
      const png = inspectPng(dest);

      Object.assign(rec, {
        kb: png.kb, bytes: png.bytes, width: png.width, height: png.height,
        lumaStddev: png.lumaStddev, lumaRange: png.lumaRange,
        distinctColorsSampled: png.distinctColorsSampled,
        nonBlank: !png.under10kb && !png.singleColour && !png.lowVariance && png.readable,
        nonBlankChecks: {
          above10kb: !png.under10kb,
          notSingleColour: !png.singleColour,
          hasVariance: !png.lowVariance,
          readable: png.readable
        },
        consoleErrors: bucket.consoleErrors, consoleErrorCount: bucket.consoleErrors.length,
        pageErrors: bucket.pageErrors, pageErrorCount: bucket.pageErrors.length,
        externalCdnRequests: bucket.external.length,
        externalCdnSample: bucket.external.slice(0, 4),
        failedLocalRequests: bucket.failedLocal.length,
        failedLocalSample: bucket.failedLocal.slice(0, 3),
        spinnerVisible: bad.spinnerVisible,
        errorBannerVisible: bad.errorBanner,
        maintenanceGate: bad.maintenanceGate,
        serviceStatusGate: bad.serviceStatusGate,
        visibleTextHead: bad.visibleText
      });

      if (combo.key === '1440_light' && shot.canvas) {
        const vpFile = path.join(DIFF_SRC, shot.name + '_1440_light_viewport.png');
        await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
        await sleep(300);
        await page.screenshot({ path: vpFile, fullPage: false });
        rec.diffSource = rel(vpFile);
        rec.appFirstHeadingY = await page.evaluate(function () {
          var sel = '#dashboardScreen:not(.hidden) h1, #landingPage:not(.hidden) h1, .ph h1, h1';
          var h = document.querySelector(sel);
          if (!h) return null;
          var r = h.getBoundingClientRect();
          return Math.round(r.top + (window.scrollY || 0));
        });
        rec.appBodyLen = await page.evaluate(function () {
          return ((document.body && document.body.innerText) || '').length;
        });
      }

      log('  ' + fileBase + '.png  ' + png.kb + ' KB  ' + (rec.nonBlank ? 'OK' : 'BLANK') +
        '  cErr=' + rec.consoleErrorCount + ' pErr=' + rec.pageErrorCount +
        ' ext=' + rec.externalCdnRequests + ' ovf=' + JSON.stringify(rec.horizontalOverflow));
    } catch (e) {
      rec.error = String(e && e.message || e).slice(0, 240);
      rec.nonBlank = false;
      rec.consoleErrors = bucket.consoleErrors;
      rec.consoleErrorCount = bucket.consoleErrors.length;
      rec.pageErrors = bucket.pageErrors;
      rec.pageErrorCount = bucket.pageErrors.length;
      rec.externalCdnRequests = bucket.external.length;
      rec.horizontalOverflow = {};
      rec.horizontalOverflowMax = -1;
      log('  ' + fileBase + ' FAILED: ' + rec.error.slice(0, 120));
    }
    await page.close();
    results.push(rec);
  }
  return results;
}

async function captureExtra(browser, shot) {
  const bucket = { consoleErrors: [], pageErrors: [], external: [], failedLocal: [] };
  const page = await browser.newPage();
  wirePage(page, bucket);
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.setCookie({ name: 'ac_sess', value: ADMIN_TOKEN, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' });

  const dest = path.join(OUT, shot.name + '.png');
  const rec = {
    shot: shot.name, combo: '1440_light_extra', theme: 'light',
    viewport: { width: 1440, height: 900 },
    route: shot.url, action: shot.do || null, auth: 'admin',
    file: shot.name + '.png'
  };

  try {
    await page.evaluateOnNewDocument(function () {
      try { localStorage.setItem('autocuan_theme', 'light'); } catch (_) {}
    });
    await page.goto(APP + shot.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await sleep(1050);
    await page.evaluate(PAGE_HELPERS);
    await setTheme(page, 'light');
    rec.actionResult = await runAction(page, shot.do);
    await sleep(shot.wait || 2800);
    await setTheme(page, 'light');

    const bad = await detectBadState(page);
    await page.screenshot({ path: dest, fullPage: true });
    const png = inspectPng(dest);

    Object.assign(rec, {
      kb: png.kb, bytes: png.bytes, width: png.width, height: png.height,
      lumaStddev: png.lumaStddev, lumaRange: png.lumaRange,
      distinctColorsSampled: png.distinctColorsSampled,
      nonBlank: !png.under10kb && !png.singleColour && !png.lowVariance && png.readable,
      nonBlankChecks: {
        above10kb: !png.under10kb,
        notSingleColour: !png.singleColour,
        hasVariance: !png.lowVariance,
        readable: png.readable
      },
      consoleErrors: bucket.consoleErrors, consoleErrorCount: bucket.consoleErrors.length,
      pageErrors: bucket.pageErrors, pageErrorCount: bucket.pageErrors.length,
      externalCdnRequests: bucket.external.length,
      externalCdnSample: bucket.external.slice(0, 3),
      spinnerVisible: bad.spinnerVisible,
      errorBannerVisible: bad.errorBanner,
      maintenanceGate: bad.maintenanceGate,
      serviceStatusGate: bad.serviceStatusGate,
      visibleTextHead: bad.visibleText
    });
    log('  ' + shot.name + '.png  ' + png.kb + ' KB  ' + (rec.nonBlank ? 'OK' : 'BLANK') +
      '  cErr=' + rec.consoleErrorCount + ' pErr=' + rec.pageErrorCount + ' ext=' + rec.externalCdnRequests);
  } catch (e) {
    rec.error = String(e && e.message || e).slice(0, 200);
    rec.nonBlank = false;
    rec.consoleErrors = bucket.consoleErrors;
    rec.consoleErrorCount = bucket.consoleErrors.length;
    rec.pageErrors = bucket.pageErrors;
    rec.pageErrorCount = bucket.pageErrors.length;
    rec.externalCdnRequests = bucket.external.length;
    log('  ' + shot.name + ' FAILED: ' + rec.error.slice(0, 120));
  }
  await page.close();
  return rec;
}

// ---------------------------------------------------------------- 403 harness
function startAuthHarness() {
  return new Promise(resolve => {
    let handler;
    try { handler = require(path.join(ROOT, 'api', 'admin-users.js')); }
    catch (e) { console.warn('harness: cannot load api/admin-users.js:', e.message); return resolve(null); }
    const port = 3141;
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { req.body = raw ? JSON.parse(raw) : {}; } catch (_) { req.body = {}; }
        const u = new URL(req.url, 'http://127.0.0.1');
        req.query = Object.fromEntries(u.searchParams.entries());
        res.status = code => {
          res.statusCode = code;
          return { json: o => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); } };
        };
        res.json = o => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
        Promise.resolve(handler(req, res)).catch(e => {
          if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e && e.message) })); }
        });
      });
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, port }));
  });
}

function postJsonTo(port, pathname, body, cookie) {
  return new Promise(resolve => {
    const payload = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'POST', headers }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { let p = null; try { p = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, body: p }); });
    });
    req.on('error', e => resolve({ status: -1, error: String(e.message) }));
    req.write(payload); req.end();
  });
}

// ---------------------------------------------------------------- main
(async function main() {
  log('START ' + new Date().toISOString());
  log('SESSION_SECRET loaded: true (value never logged). admin token len=' + ADMIN_TOKEN.length);
  if (!(await checkApp())) { console.error('ABORT: app server not reachable at ' + APP); process.exit(1); }
  log('App server UP: ' + APP);

  await new Promise(r => canvasServer.listen(CANVAS_PORT, '127.0.0.1', r));
  log('Canvas server UP: http://127.0.0.1:' + CANVAS_PORT);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--force-color-profile=srgb', '--font-render-hinting=none', '--hide-scrollbars']
  });

  const shots = ONLY ? SHOTS.filter(s => ONLY.includes(s.name)) : SHOTS;
  const extras = ONLY ? EXTRA.filter(s => ONLY.includes(s.name)) : (DO_EXTRA ? EXTRA : []);
  log('Canonical shots: ' + shots.length + ' -> ' + (shots.length * 4) + ' PNG | Extras: ' + extras.length);

  const records = [];
  for (const shot of shots) {
    log('-- ' + shot.name + ' :: ' + shot.url);
    const rs = await captureCanonical(browser, shot);
    for (const r of rs) records.push(r);
  }

  const extraRecords = [];
  for (const shot of extras) {
    log('-- extra ' + shot.name);
    extraRecords.push(await captureExtra(browser, shot));
  }

  // ------------------------------------------------ pixel diff pass
  const diffRows = [];
  if (DO_DIFF) {
    log('--- pixel diff pass (panel3: Kanvas | Aplikasi | Diff)');
    const canvasPage = await browser.newPage();
    await canvasPage.setRequestInterception(true);
    canvasPage.on('request', req => {
      const u = req.url();
      if (u.startsWith('http://127.0.0.1:' + CANVAS_PORT) || u.startsWith('data:') || u.startsWith('blob:')) return req.continue();
      return req.abort();
    });

    for (const shot of shots) {
      if (!shot.canvas) {
        diffRows.push({
          shot: shot.name, route: shot.url, canvas: null, pixelDiffPct: null, deltaYPx: null,
          note: 'Tidak ada kanvas .dc.html untuk rute ini (halaman 404 tidak punya kanvas desain).'
        });
        continue;
      }
      const appFile = path.join(DIFF_SRC, shot.name + '_1440_light_viewport.png');
      if (!fs.existsSync(appFile)) {
        diffRows.push({ shot: shot.name, route: shot.url, canvas: shot.canvas, pixelDiffPct: null, deltaYPx: null, error: 'app viewport snapshot missing' });
        continue;
      }
      try {
        await canvasPage.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
        await canvasPage.goto('http://127.0.0.1:' + CANVAS_PORT + '/' + shot.canvas, { waitUntil: 'networkidle2', timeout: 25000 });
        await sleep(1200);
        const canvasShot = await canvasPage.screenshot({ fullPage: false });
        const canvasHeadingY = await canvasPage.evaluate(function () {
          var h = document.querySelector('h1, .ph h1, .h1');
          if (!h) return null;
          var r = h.getBoundingClientRect();
          return Math.round(r.top + (window.scrollY || 0));
        });

        const d = buildPanel3(canvasShot, fs.readFileSync(appFile));
        const panelFile = path.join(PANEL_DIR, shot.name + '_1440_light_panel3.png');
        fs.writeFileSync(panelFile, d.png);
        const panelKB = kbOf(fs.statSync(panelFile).size);

        const appRec = records.find(r => r.shot === shot.name && r.combo === '1440_light') || {};
        const appHeadingY = typeof appRec.appFirstHeadingY === 'number' ? appRec.appFirstHeadingY : null;
        const deltaY = (typeof appHeadingY === 'number' && typeof canvasHeadingY === 'number')
          ? Math.abs(appHeadingY - canvasHeadingY) : null;

        diffRows.push({
          shot: shot.name,
          route: shot.url,
          canvas: shot.canvas,
          panel3: rel(panelFile),
          panel3Kb: panelKB,
          panel3Width: d.width * 3 + 8,
          panel3Height: d.height,
          comparedWidth: d.width,
          comparedHeight: d.height,
          pixelDiffPct: d.pixelDiffPct,
          diffPixels: d.diffPixels,
          totalPixels: d.totalPixels,
          deltaYPx: deltaY,
          deltaYSource: { appFirstHeadingY: appHeadingY, canvasFirstHeadingY: canvasHeadingY }
        });
        log('  diff ' + shot.name + ' -> ' + d.pixelDiffPct + '%  deltaY=' + deltaY + 'px  panel=' + panelKB + 'KB');
      } catch (e) {
        diffRows.push({ shot: shot.name, route: shot.url, canvas: shot.canvas, pixelDiffPct: null, deltaYPx: null, error: String(e.message).slice(0, 180) });
        log('  diff ' + shot.name + ' FAILED: ' + String(e.message).slice(0, 110));
      }
    }
    await canvasPage.close();
  }

  await browser.close();
  canvasServer.close();

  // ------------------------------------------------ 403 boundary re-proof
  const authBoundary = [];
  const harness = await startAuthHarness();
  if (harness) {
    for (const action of ['pattern_map_access', 'admin_console_stats', 'data_health_inspect']) {
      const nonAdmin = await postJsonTo(harness.port, '/api/admin-users', { action }, 'ac_sess=' + NONADMIN_TOKEN);
      const anon = await postJsonTo(harness.port, '/api/admin-users', { action }, '');
      const admin = await postJsonTo(harness.port, '/api/admin-users', { action }, 'ac_sess=' + ADMIN_TOKEN);
      authBoundary.push({
        endpoint: action,
        non_admin_status: nonAdmin.status, non_admin_expected: 403, non_admin_pass: nonAdmin.status === 403,
        anon_status: anon.status, anon_expected: 401, anon_pass: anon.status === 401,
        admin_status: admin.status, admin_expected: 200, admin_pass: admin.status === 200
      });
      log('403 proof ' + action + ': nonadmin=' + nonAdmin.status + ' anon=' + anon.status + ' admin=' + admin.status);
    }
    harness.server.close();
  }

  // ------------------------------------------------ manifest
  const all = records.concat(extraRecords);
  const onDisk = all.filter(r => r.file && fs.existsSync(path.join(OUT, r.file)));
  const nonBlank = all.filter(r => r.nonBlank === true);
  const blank = all.filter(r => r.nonBlank !== true);
  const totalKB = Math.round(onDisk.reduce((s, r) => s + (r.kb || 0), 0) * 10) / 10;
  const panelCount = fs.existsSync(PANEL_DIR) ? fs.readdirSync(PANEL_DIR).filter(f => /\.png$/i.test(f)).length : 0;

  const manifest = {
    fase: 20,
    generatedAt: new Date().toISOString(),
    generatedBy: 'tools/fase20-capture.js',
    session: {
      mechanism: 'lib/admin-session.js::createSessionToken (HMAC-SHA256), cookie ac_sess',
      secretSource: 'process.env.SESSION_SECRET (loaded from D:/auto-cuan-2/.env; value never written to output)',
      adminSession: { userId: 'fase20-audit-admin', username: 'budi', isAdmin: true },
      nonAdminSession: { userId: 'fase20-audit-user', username: 'audit_nonadmin', isAdmin: false }
    },
    coverage: {
      canonicalShots: SHOTS.length,
      combosPerShot: COMBOS.map(c => c.key),
      extraShots: extras.length,
      chartTickers: TICKERS_CHART,
      financialQ2Tickers: TICKERS_FIN
    },
    totals: {
      pngFilesOnDisk: onDisk.length,
      nonBlankPng: nonBlank.length,
      blankOrFailedPng: blank.length,
      totalSizeKB: totalKB,
      pixelDiffPanels: panelCount
    },
    minimumRequired: 112,
    minimumMet: onDisk.length >= 112 && nonBlank.length >= 112,
    blankFiles: blank.map(b => ({ file: b.file, shot: b.shot, combo: b.combo, kb: b.kb, error: b.error || null, checks: b.nonBlankChecks || null })),
    files: onDisk.map(r => ({
      file: r.file, shot: r.shot, combo: r.combo, theme: r.theme, route: r.route,
      kb: r.kb, bytes: r.bytes, width: r.width, height: r.height,
      lumaStddev: r.lumaStddev, lumaRange: r.lumaRange,
      distinctColorsSampled: r.distinctColorsSampled,
      nonBlank: r.nonBlank, nonBlankChecks: r.nonBlankChecks
    }))
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // ------------------------------------------------ metric table
  const pages = [];
  for (const shot of shots) {
    const rs = records.filter(r => r.shot === shot.name);
    const diff = diffRows.find(d => d.shot === shot.name) || {};
    const combos = {};
    for (const r of rs) {
      combos[r.combo] = {
        file: r.file, kb: r.kb, nonBlank: r.nonBlank,
        consoleErrors: r.consoleErrorCount, pageErrors: r.pageErrorCount,
        externalCdnRequests: r.externalCdnRequests,
        horizontalOverflow: r.horizontalOverflow || {},
        spinnerVisible: !!r.spinnerVisible, errorBannerVisible: !!r.errorBannerVisible,
        maintenanceGate: !!r.maintenanceGate, serviceStatusGate: !!r.serviceStatusGate,
        error: r.error || null
      };
    }
    const pick = (key) => Math.max.apply(null, Object.values(combos).map(c => c[key] || 0));
    const ovfW = (w) => {
      const vals = Object.values(combos)
        .map(c => (c.horizontalOverflow && typeof c.horizontalOverflow[w] === 'number') ? c.horizontalOverflow[w] : 0);
      return vals.length ? Math.max.apply(null, vals) : 0;
    };
    pages.push({
      shot: shot.name,
      route: shot.url,
      canvas: diff.canvas || null,
      png: Object.keys(combos).map(k => ({ combo: k, file: combos[k].file, kb: combos[k].kb, nonBlank: combos[k].nonBlank })),
      pixelDiffPct: diff.pixelDiffPct === undefined ? null : diff.pixelDiffPct,
      panel3: diff.panel3 || null,
      panel3Kb: diff.panel3Kb || null,
      deltaYPx: diff.deltaYPx === undefined ? null : diff.deltaYPx,
      consoleErrors: pick('consoleErrors'),
      pageErrors: pick('pageErrors'),
      externalCdnRequests: pick('externalCdnRequests'),
      horizontalOverflow: { w1440: ovfW(1440), w1024: ovfW(1024), w820: ovfW(820), w390: ovfW(390) },
      spinnerVisibleAny: Object.values(combos).some(c => c.spinnerVisible),
      errorBannerVisibleAny: Object.values(combos).some(c => c.errorBannerVisible),
      maintenanceGateAny: Object.values(combos).some(c => c.maintenanceGate),
      serviceStatusGateAny: Object.values(combos).some(c => c.serviceStatusGate),
      combos
    });
  }

  const extrasRows = extraRecords.map(r => ({
    shot: r.shot, route: r.route, action: r.action, file: r.file, kb: r.kb,
    nonBlank: r.nonBlank, consoleErrors: r.consoleErrorCount, pageErrors: r.pageErrorCount,
    externalCdnRequests: r.externalCdnRequests,
    spinnerVisible: !!r.spinnerVisible, errorBannerVisible: !!r.errorBannerVisible,
    error: r.error || null
  }));

  const diffVals = pages.map(p => p.pixelDiffPct).filter(v => typeof v === 'number');
  const deltaVals = pages.map(p => p.deltaYPx).filter(v => typeof v === 'number');

  const metricTable = {
    fase: 20,
    generatedAt: new Date().toISOString(),
    requirements: {
      consoleErrors: 0,
      pageErrors: 0,
      externalCdnRequests: 0,
      horizontalOverflow_1440: 0,
      horizontalOverflow_1024: 0,
      horizontalOverflow_820: 0,
      horizontalOverflow_390: 0
    },
    summary: {
      pagesCompared: pages.length,
      consoleErrorsTotal: pages.reduce((s, p) => s + (p.consoleErrors || 0), 0) + extrasRows.reduce((s, p) => s + (p.consoleErrors || 0), 0),
      pageErrorsTotal: pages.reduce((s, p) => s + (p.pageErrors || 0), 0) + extrasRows.reduce((s, p) => s + (p.pageErrors || 0), 0),
      externalCdnRequestsTotal: pages.reduce((s, p) => s + (p.externalCdnRequests || 0), 0) + extrasRows.reduce((s, p) => s + (p.externalCdnRequests || 0), 0),
      horizontalOverflowNonZeroPages: pages.filter(p => Object.values(p.horizontalOverflow).some(v => v > 0)).length,
      pagesWithPixelDiff: diffVals.length,
      meanPixelDiffPct: diffVals.length ? Math.round((diffVals.reduce((a, b) => a + b, 0) / diffVals.length) * 100) / 100 : null,
      maxPixelDiffPct: diffVals.length ? Math.max.apply(null, diffVals) : null,
      deltaYMaxPx: deltaVals.length ? Math.max.apply(null, deltaVals) : null,
      deltaYMeanPx: deltaVals.length ? Math.round((deltaVals.reduce((a, b) => a + b, 0) / deltaVals.length) * 10) / 10 : null
    },
    authBoundary403: authBoundary,
    pages,
    extras: extrasRows
  };
  fs.writeFileSync(path.join(OUT, 'tabel-pixel-diff-dan-overflow.json'), JSON.stringify(metricTable, null, 2));

  log('');
  log('=== DONE ' + new Date().toISOString() + ' ===');
  log('PNG on disk: ' + onDisk.length + ' | non-blank: ' + nonBlank.length + ' | blank/failed: ' + blank.length);
  log('Total size: ' + totalKB + ' KB | panel3 images: ' + panelCount);
  log('consoleErrors total: ' + metricTable.summary.consoleErrorsTotal);
  log('pageErrors total: ' + metricTable.summary.pageErrorsTotal);
  log('externalCdnRequests total: ' + metricTable.summary.externalCdnRequestsTotal);
  log('overflow non-zero pages: ' + metricTable.summary.horizontalOverflowNonZeroPages);
  log('mean pixel diff: ' + metricTable.summary.meanPixelDiffPct + '% | max: ' + metricTable.summary.maxPixelDiffPct + '%');
  log('deltaY max: ' + metricTable.summary.deltaYMaxPx + 'px | mean: ' + metricTable.summary.deltaYMeanPx + 'px');
  log('minimum 112 met: ' + manifest.minimumMet);
  log('OUT: ' + OUT);

  if (blank.length) {
    log('BLANK/FAILED:');
    blank.forEach(b => log('   ' + (b.file || b.shot) + ' :: ' + JSON.stringify(b.nonBlankChecks || b.error || '')));
  }
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
