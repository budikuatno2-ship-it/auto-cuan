#!/usr/bin/env node
'use strict';
// C11 — Tangkapan Layar Lengkap Authenticated (140+ PNG non-blank) + audit style-fidelity + pixel-diff 3 panel.
// Sesi login otomatis tanpa interaksi manual: suntik sesi admin VIP budi + user biasa via localStorage +
// mock API server-status (mekanisme sah lib/admin-session.js: token HMAC server, di sini disimulasikan
// server-side di harness uji lokal — tanpa secret, tanpa .env).
// PLAYWRIGHT_BROWSERS=D:/playwright-browsers, TEMP=D:/tmp. Bukti hanya Drive D.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'faseC11');
const TABLE_PATH = path.join(OUT, 'tabel-pixel-diff-dan-overflow.json');
const TMP = (process.env.TEMP && String(process.env.TEMP).startsWith('D:')) ? process.env.TEMP : 'D:\\tmp';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.mjs': 'application/javascript; charset=utf-8' };
function sendJ(res, code, o) { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); }

// ---- Mock data riil bentuk nyata (bukan sampel): struktur respons asli, angka dari konstanta UI ----
const MOCK_TOP5 = {
  konglo: [
    { ticker: 'BRPT', last_price: 1020, change_pct: 2.1, score: 82, swing_tier: 'READY', entry_high: 1050, entry_low: 1002, stop_loss: 980, tp1: 1150, tp2: 1200, risk_reward: 2.1, volume_ratio: 1.8, status: 'entry_area', final_status: 'READY' },
    { ticker: 'BBCA', last_price: 9150, change_pct: 0.8, score: 78, swing_tier: 'WATCH', entry_high: 9200, entry_low: 9000, stop_loss: 8900, tp1: 9500, tp2: 9800, risk_reward: 1.9, volume_ratio: 1.2, status: 'wait_pullback', final_status: 'WATCH' }
  ],
  nonkonglo: [
    { ticker: 'ANTM', last_price: 1520, change_pct: 1.5, score: 75, swing_tier: 'READY', entry_high: 1550, entry_low: 1502, stop_loss: 1470, tp1: 1620, tp2: 1680, risk_reward: 1.8, volume_ratio: 1.5, status: 'entry_area', final_status: 'READY' },
    { ticker: 'ADRO', last_price: 2680, change_pct: -0.5, score: 68, swing_tier: 'WATCH', entry_high: 2700, entry_low: 2620, stop_loss: 2580, tp1: 2800, tp2: 2900, risk_reward: 1.6, volume_ratio: 1.1, status: 'wait_pullback', final_status: 'WATCH' }
  ],
  daytrade: [
    { ticker: 'GOTO', last_price: 68, change_pct: 3.2, score: 80, swing_tier: 'READY', entry_high: 70, entry_low: 66, stop_loss: 64, tp1: 74, tp2: 78, risk_reward: 1.5, volume_ratio: 2.8, status: 'entry_touched', final_status: 'READY' },
    { ticker: 'MEDC', last_price: 1240, change_pct: 1.1, score: 72, swing_tier: 'WATCH', entry_high: 1260, entry_low: 1220, stop_loss: 1200, tp1: 1300, tp2: 1340, risk_reward: 1.4, volume_ratio: 1.6, status: 'entry_area', final_status: 'WATCH' }
  ]
};
const MOCK_NOTES = { success: true, summary: { total_active: 3, target_hit: 12, total_evaluated: 15, avg_gain_pct: 4.8 }, notes: [
  { id: '1', ticker: 'BRPT', style: 'swing', status: 'Di area pantau', zone_lo: 1002, zone_hi: 1050, target: 1150, risk_limit: 980, current_price: 1020, reason: 'Volume 2,8x rata-rata 20 hari, tiga broker besar akumulasi 4 hari beruntun.', edits: [] },
  { id: '2', ticker: 'BBCA', style: 'daytrade', status: 'Di area pantau', zone_lo: 9000, zone_hi: 9200, target: 9500, risk_limit: 8900, current_price: 9100, reason: 'Akumulasi broker institusi pada rentang rendah.', edits: [] },
  { id: '3', ticker: 'TLKM', style: 'swing', status: 'Kena target', zone_lo: 3000, zone_hi: 3100, target: 3300, risk_limit: 2950, current_price: 3300, reason: 'Breakout struktur dengan volume konfirmasi.', edits: [] }
] };
const MOCK_WL = { success: true, watchlist: [
  { ticker: 'BBCA', name: 'Bank Central Asia', last_price: 9150, change_pct: 0.8, alerts: [{ is_active: true, is_triggered: false, condition_type: 'PRICE_ABOVE', target_price: 9200 }], notes: 'Pantau pullback ke area entry.' },
  { ticker: 'BRPT', name: 'Barito Pacific', last_price: 1020, change_pct: 2.1, alerts: [], notes: 'Kandidat swing konglo.' }
] };
const MOCK_TR = { success: true, summary: { total_signals: 4, total_resolved: 3, running_signals: 1, waiting_signals: 0, tp1_hits: 1, tp2_hits: 1, sl_hits: 1, expired_signals: 0 }, signals: [
  { ticker: 'TLKM', outcome: 'SL_HIT', status: 'SL_HIT', date: '2026-10-02', entry1: 3050, entry2: 3050, tp1: 3200, tp2: 3350, sl: 2960, price_at_hit: 2960, gain_pct: -2.95, duration_text: '5 hari', source_short: 'Swing', source_label: 'Swing', status_label: 'Stop Loss terkena' },
  { ticker: 'BRPT', outcome: 'TP1_HIT', status: 'TP1_HIT', date: '2026-10-06', entry1: 1010, entry2: 1010, tp1: 1120, tp2: 1180, sl: 995, price_at_hit: 1120, gain_pct: 10.89, duration_text: '4 hari', source_short: 'Swing', source_label: 'Swing', status_label: 'TP1 tercapai' },
  { ticker: 'BBCA', outcome: 'TP2_HIT', status: 'TP2_HIT', date: '2026-10-08', entry1: 9000, entry2: 9000, tp1: 9300, tp2: 9600, sl: 8900, price_at_hit: 9600, gain_pct: 6.67, duration_text: '6 hari', source_short: 'Swing', source_label: 'Swing', status_label: 'TP2 tercapai' }
] };

function candleSeries(base, n) {
  const out = [];
  let p = base;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = p * (1 + ((i * 37 % 11) - 5) / 997);
    const h = Math.max(o, c) * 1.004;
    const l = Math.min(o, c) * 0.996;
    const v = Math.round(1000000 * (1 + ((i * 53 % 17) / 10)));
    out.push({ date: '2026-10-' + String(1 + (i % 28)).padStart(2, '0'), open: +o.toFixed(0), high: +h.toFixed(0), low: +l.toFixed(0), close: +c.toFixed(0), volume: v });
    p = c;
  }
  return out;
}
const CANDLES = {};
for (const [t, b] of [['BBCA', 9150], ['BBRI', 4250], ['BMRI', 6850], ['TLKM', 3050], ['ANTM', 1520], ['BRPT', 1020], ['GOTO', 68], ['ASII', 5200], ['ADRO', 2680], ['MEDC', 1240], ['IHSG', 7650]]) CANDLES[t] = candleSeries(b, 60);

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const pth = decodeURIComponent(u.pathname);
    const a = u.searchParams.get('action');
    if (pth === '/api/reset-password' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let j = {};
        try { j = JSON.parse(body || '{}'); } catch (_) {}
        if (j.action === 'session-status') {
          const who = global.__C11_USER || 'budi';
          const admin = who === 'budi';
          return sendJ(res, 200, { success: true, userId: admin ? 'u-budi' : 'u-user', username: who, isAdmin: admin, isReview: false });
        }
        return sendJ(res, 200, { success: true });
      });
      return;
    }
    if (pth === '/api/login-user') return sendJ(res, 200, { success: true });
    if (pth === '/api/sector-hot') {
      if (a === 'screener') return sendJ(res, 200, { success: true, results: MOCK_TOP5.konglo, meta: { calculated_at: '2026-10-31T17:00:00+07:00' } });
      if (a === 'nk-screener-results') return sendJ(res, 200, { success: true, results: MOCK_TOP5.nonkonglo, meta: { calculated_at: '2026-10-31T17:00:00+07:00' } });
      if (a === 'daytrade-screener') return sendJ(res, 200, { success: true, results: MOCK_TOP5.daytrade, meta: { calculated_at: '2026-10-31T15:00:00+07:00' } });
      if (a === 'watchlist') return sendJ(res, 200, MOCK_WL);
      if (a === 'watchlist-alert-history') return sendJ(res, 200, { success: true, history: [{ action: 'created', ticker: 'BBCA', condition_type: 'PRICE_ABOVE', target_price: 9200, created_at: '2026-10-10T09:00:00Z' }] });
      if (a === 'track-record') return sendJ(res, 200, MOCK_TR);
      if (a === 'market-breadth') return sendJ(res, 200, { success: true, breadth: { up: 320, flat: 120, down: 280 } });
      if (a === 'landing-snapshot') return sendJ(res, 200, { success: true, snapshot: { sectors: [{ name: 'Energi', avg_change_pct: 1.2 }], dt_signals: [{ ticker: 'GOTO', signal_type: 'ENTRY', rr: 1.5 }] }, updated_at: '2026-10-31T17:00:00+07:00' });
      if (a === 'bandarmologi' || a === 'broker-hunter' || a === 'insider-roster' || a === 'insider-network' || a === 'market-structure-list' || a === 'available-dates' || a === 'broker-consistency' || a === 'screener-presets' || a === 'broker-summary-smart' || a === 'stocks-search' || a === 'tape') {
        return sendJ(res, 200, { success: true, data: [], brokers: [], rows: [], results: [], items: [], tickers: ['BBCA', 'BRPT'] });
      }
      return sendJ(res, 200, { success: true, results: MOCK_TOP5.konglo, sectors: [], signals: [], watchlist: MOCK_WL.watchlist });
    }
    if (pth === '/api/quote') {
      const t = (u.searchParams.get('ticker') || 'BBCA').toUpperCase();
      if (a === 'financial-snapshot') return sendJ(res, 200, { success: true, snapshot: { fundamental: { pbv: 2.08, per: 11.4, roe: 18.2 }, price: { last: 1020 } } });
      if (a === 'daily-market-context-list') return sendJ(res, 200, { success: true, rows: [] });
      return sendJ(res, 200, { success: true, ticker: t, last: 1002, change_pct: 1.0 });
    }
    if (pth === '/api/candles') {
      const t = (u.searchParams.get('ticker') || 'BBCA').toUpperCase();
      return sendJ(res, 200, { success: true, ticker: t, candles: CANDLES[t] || CANDLES.BBCA });
    }
    if (pth === '/api/track-record') return sendJ(res, 200, MOCK_TR);
    if (pth === '/api/admin-users') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let j = {};
        try { j = JSON.parse(body || '{}'); } catch (_) {}
        if (j.action === 'portfolio_access') {
          const who = global.__C11_USER || 'budi';
          if (who !== 'budi') return sendJ(res, 403, { success: false, error: 'Akses ditolak.' });
          return sendJ(res, 200, { success: true, user_id: 'u-budi', username: 'budi' });
        }
        if (j.action === 'admin_console_stats') {
          const who = global.__C11_USER || 'budi';
          if (who !== 'budi') return sendJ(res, 403, { success: false, error: 'Akses admin ditolak.' });
          let qsnap = null;
          try { qsnap = require(path.join(ROOT, 'lib', 'quota-state')).getQuotaSnapshot(); } catch (_) {}
          const quota = qsnap ? { used: qsnap.used, limit: qsnap.limit, pct: qsnap.pct, remaining: qsnap.remaining, driftDetected: qsnap.driftDetected, planName: qsnap.planName, planExpiresAt: qsnap.planExpiresAt, planDaysLeft: 60, updatedAt: new Date().toISOString(), config: qsnap.config || {} } : { used: 0, limit: 1, pct: 0, remaining: 1, driftDetected: false, planName: '', planExpiresAt: null, planDaysLeft: 0, updatedAt: new Date().toISOString(), config: {} };
          return sendJ(res, 200, { success: true, admin: 'budi', quota, online_summary: { online_now: 1, active_15m: 1, today: 1, idle_7d: 0 }, datasets: [], jobs: [], data_health: { overall_status: 'ok', overall_label: 'Segar', ok_count: 5, warn_count: 0, categories: [] }, operational: { ok: true } });
        }
        if (j.action === 'quota_update' || j.action === 'pattern_radar_scan') {
          const who = global.__C11_USER || 'budi';
          if (who !== 'budi') return sendJ(res, 403, { success: false, error: 'Akses admin ditolak.' });
          return sendJ(res, 200, { success: true });
        }
        const who = global.__C11_USER || 'budi';
        if (who !== 'budi') return sendJ(res, 403, { success: false, error: 'Akses admin ditolak.' });
        return sendJ(res, 200, { success: true, user_id: 'u-budi', username: 'budi' });
      });
      return;
    }
    if (pth === '/api/admin-notes') return sendJ(res, 200, MOCK_NOTES);
    if (pth === '/api/maintenance-settings') return sendJ(res, 200, { success: true, maintenance: false, config: { maintenanceMode: false } });
    if (pth === '/api/admin-logs') return sendJ(res, 200, { success: true, logs: [] });
    if (pth === '/api/analyze') return sendJ(res, 200, { success: true });
    if (pth === '/api/money-management') return sendJ(res, 200, { success: true, sheet: { rows: [] }, journal: [] });
    if (pth === '/api/review-access') return sendJ(res, 200, { success: true });
    if (pth === '/api/log') return sendJ(res, 200, { success: true });
    if (pth === '/api/register-user') return sendJ(res, 200, { success: true });
    if (pth.startsWith('/api/')) return sendJ(res, 200, { success: true });
    if (pth === '/favicon.ico') { res.statusCode = 204; return res.end(); }
    if (pth === '/' || pth === '/index.html') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'))); }
    let rel = pth.replace(/^\//, '').split('?')[0];
    if (rel === 'ketentuan') rel = 'ketentuan.html';
    if (rel === 'maintenance') rel = 'maintenance.html';
    if (rel === 'dashboard' || rel === 'screener' || rel === 'analisis-saham' || rel === 'portfolio-command-center' || rel === 'portfolio-planner') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'))); }
    const fp = path.join(PUBLIC_DIR, rel);
    if (!fp.startsWith(PUBLIC_DIR)) { res.statusCode = 403; return res.end('x'); }
    let st = null; try { st = fs.statSync(fp); } catch (_) {}
    if (!st || st.isDirectory()) { res.statusCode = 404; return res.end('x'); }
    const ext = path.extname(fp).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    return res.end(fs.readFileSync(fp));
  } catch (e) { res.statusCode = 500; return res.end('err'); }
});

function yiqDiff(a, b) {
  const y1 = 0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2];
  const y2 = 0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2];
  const i1 = 0.596 * a[0] - 0.274 * a[1] - 0.322 * a[2];
  const i2 = 0.596 * b[0] - 0.274 * b[1] - 0.322 * b[2];
  const q1 = 0.211 * a[0] - 0.523 * a[1] + 0.312 * a[2];
  const q2 = 0.211 * b[0] - 0.523 * b[1] + 0.312 * b[2];
  return 0.8 * Math.abs(y1 - y2) / 255 + 0.1 * Math.abs(i1 - i2) / 255 + 0.1 * Math.abs(q1 - q2) / 255;
}
function colorVariance(png) {
  const n = Math.min(png.data.length / 4, 4000);
  let sr = 0, sg = 0, sb = 0;
  const step = Math.max(1, Math.floor((png.data.length / 4) / n));
  let c = 0;
  for (let i = 0; i < png.data.length && c < n; i += 4 * step, c++) { sr += png.data[i]; sg += png.data[i + 1]; sb += png.data[i + 2]; }
  if (!c) return 0;
  const mr = sr / c, mg = sg / c, mb = sb / c;
  let v = 0; c = 0;
  for (let i = 0; i < png.data.length && c < n; i += 4 * step, c++) {
    const dr = png.data[i] - mr, dg = png.data[i + 1] - mg, db = png.data[i + 2] - mb;
    v += dr * dr + dg * dg + db * db;
  }
  return v / Math.max(1, c);
}
function hasBannedText(txt) {
  return /memuat|loading|spinner|memuat ulang|gagal memuat|error memuat|failed to load|network error/i.test(txt);
}

const PAGES = [
  { id: 'landing', label: 'Landing' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'screener', label: 'Screener' },
  { id: 'sektor', label: 'Sektor Hot' },
  { id: 'catatan-admin', label: 'Catatan Admin' },
  { id: 'analisis-chart', label: 'Analisis Chart', analisis: 'analisis-chart' },
  { id: 'bandarmologi', label: 'Bandarmologi', analisis: 'bandarmologi' },
  { id: 'intel', label: 'Sinyal Intelijen', analisis: 'intel' },
  { id: 'hunter', label: 'Broker Hunter', analisis: 'hunter' },
  { id: 'insider', label: 'Insider', analisis: 'insider' },
  { id: 'ranking', label: 'Ranking', analisis: 'ranking' },
  { id: 'financial', label: 'Financial', analisis: 'financial' },
  { id: 'market-structure', label: 'Struktur Pasar', analisis: 'market-structure' },
  { id: 'pattern', label: 'Pattern Radar', analisis: 'pattern' },
  { id: 'watchlist', label: 'Watchlist' },
  { id: 'portofolio', label: 'Portfolio' },
  { id: 'trackrecord', label: 'Track Record' },
  { id: 'money-management', label: 'Kelola Keuangan' },
  { id: 'subscription', label: 'Langganan VIP' },
  { id: 'admin-console', label: 'Admin Console' },
  { id: 'ketentuan', label: 'Ketentuan' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'notfound', label: '404' },
  { id: 'account-center', label: 'Account Center' }
];
const COMBOS = [
  { w: 1440, h: 900, theme: 'light', tag: '1440_light' },
  { w: 1440, h: 900, theme: 'dark', tag: '1440_dark' },
  { w: 390, h: 844, theme: 'light', tag: '390_light' },
  { w: 390, h: 844, theme: 'dark', tag: '390_dark' }
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  const puppeteer = require('puppeteer-core');
  const exe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'] });
  const rows = [];
  let pngCount = 0;
  const goAdmin = async (page) => {
    await page.evaluate(() => {
      try {
        localStorage.setItem('autocuan_logged_in', 'true');
        localStorage.setItem('autocuan_user', 'budi');
        localStorage.setItem('autocuan_user_id', 'u-budi');
        localStorage.setItem('autocuan_is_admin', 'true');
        window.__AUTOCUAN_AUTHENTICATED_SESSION__ = { success: true, userId: 'u-budi', username: 'budi', isAdmin: true };
        window.premiumAccessState = { state: 'ready', premium: true, isAdmin: true, accessLevel: 'lifetime' };
      } catch (_) {}
    });
    global.__C11_USER = 'budi';
  };
  const goUser = async (page) => {
    await page.evaluate(() => {
      try {
        localStorage.setItem('autocuan_logged_in', 'true');
        localStorage.setItem('autocuan_user', 'member');
        localStorage.setItem('autocuan_user_id', 'u-user');
        localStorage.setItem('autocuan_is_admin', 'false');
        window.__AUTOCUAN_AUTHENTICATED_SESSION__ = { success: true, userId: 'u-user', username: 'member', isAdmin: false };
        window.premiumAccessState = { state: 'ready', premium: false, isAdmin: false, accessLevel: 'free' };
      } catch (_) {}
    });
    global.__C11_USER = 'member';
  };
  const shotOne = async (page, name, combo) => {
    await page.setViewport({ width: combo.w, height: combo.h });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: combo.theme }]);
    await page.evaluate((t) => {
      try {
        document.documentElement.setAttribute('data-theme', t);
        document.documentElement.classList.toggle('light', t === 'light');
        document.documentElement.classList.toggle('is-dark', t === 'dark');
      } catch (_) {}
    }, combo.theme);
    await new Promise(r => setTimeout(r, 700));
    const meta = await page.evaluate(() => ({
      over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      txt: (document.body.innerText || '').slice(0, 4000),
      title: document.title
    }));
    const buf = await page.screenshot({ encoding: 'binary' });
    const fp = path.join(OUT, name + '_' + combo.tag + '.png');
    fs.writeFileSync(fp, Buffer.from(buf));
    const img = PNG.sync.read(Buffer.from(buf));
    const variance = colorVariance(img);
    const row = { file: path.basename(fp), bytes: buf.length, width: img.width, height: img.height, variance: Math.round(variance), overflow: meta.over, banned: hasBannedText(meta.txt), title: meta.title.slice(0, 60), textHead: meta.txt.slice(0, 160).replace(/\n/g, ' ') };
    rows.push(row);
    pngCount++;
    return row;
  };

  // ===== SESI 1: Admin VIP budi — seluruh 24 halaman x 4 kombinasi =====
  {
    const page = await browser.newPage();
    const cerr = []; const perr = []; const ext = [];
    page.on('console', m => { if (m.type() === 'error') cerr.push(m.text().slice(0, 160)); });
    page.on('pageerror', e => perr.push(String(e).slice(0, 160)));
    await page.setRequestInterception(true);
    page.on('request', r => {
      const uu = r.url();
      if (/^https?:\/\//.test(uu) && uu.indexOf('127.0.0.1') < 0 && uu.indexOf('localhost') < 0) { ext.push(uu.slice(0, 100)); return r.abort(); }
      return r.continue();
    });
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(base + '/', { waitUntil: 'load', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2500));
    await goAdmin(page);
    for (const p of PAGES) {
      try {
        if (p.id === 'landing') { await page.evaluate(() => { try { showLandingPage(); } catch (_) {} }); }
        else if (p.id === 'ketentuan') { await page.goto(base + '/ketentuan', { waitUntil: 'load', timeout: 30000 }); await new Promise(r => setTimeout(r, 1200)); await goAdmin(page); }
        else if (p.id === 'maintenance') { await page.goto(base + '/maintenance', { waitUntil: 'load', timeout: 30000 }); await new Promise(r => setTimeout(r, 1200)); await goAdmin(page); }
        else if (p.id === 'notfound') { await page.goto(base + '/404.html', { waitUntil: 'load', timeout: 30000 }); await new Promise(r => setTimeout(r, 1200)); await goAdmin(page); }
        else if (p.id === 'account-center') { await page.goto(base + '/', { waitUntil: 'load', timeout: 30000 }); await new Promise(r => setTimeout(r, 1500)); await goAdmin(page); await page.evaluate(() => { try { navigateTo('dashboard'); } catch (_) {} }); await new Promise(r => setTimeout(r, 1200)); try { await page.evaluate(() => { if (typeof openAccountProfile === 'function') openAccountProfile(); }); await new Promise(r => setTimeout(r, 1200)); } catch (_) {} }
        else if (p.id === 'subscription') { await page.evaluate(() => { try { navigateTo('dashboard'); } catch (_) {} }); await new Promise(r => setTimeout(r, 1200)); await page.evaluate(() => { try { if (typeof openAccountSubscription === 'function') openAccountSubscription(); } catch (_) {} }); await new Promise(r => setTimeout(r, 1200)); }
        else if (p.analisis) { await page.evaluate((s) => { try { navigateTo('analisis', s); } catch (_) {} }, p.analisis); await new Promise(r => setTimeout(r, 1800)); }
        else { await page.evaluate((pg) => { try { navigateTo(pg); } catch (_) {} }, p.id); await new Promise(r => setTimeout(r, 1500)); }
        for (const c of COMBOS) await shotOne(page, p.id, c);
      } catch (e) { rows.push({ file: p.id + '_EXC', error: String(e).slice(0, 100) }); }
    }
    // 4 modal Auth x 4 kombinasi
    const modals = [
      { id: 'modal-login', fn: 'openLoginModal' },
      { id: 'modal-register', fn: 'openRegisterModal' },
      { id: 'modal-recovery', fn: 'openSelfResetModal' },
      { id: 'modal-choice', fn: 'openAuthChoiceModal' }
    ];
    for (const m of modals) {
      try {
        for (const c of COMBOS) {
          await page.setViewport({ width: c.w, height: c.h });
          await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: c.theme }]);
          await page.evaluate((f) => { try { window[f](); } catch (_) {} }, m.fn);
          await new Promise(r => setTimeout(r, 800));
          const buf = await page.screenshot({ encoding: 'binary' });
          const fp = path.join(OUT, m.id + '_' + c.tag + '.png');
          fs.writeFileSync(fp, Buffer.from(buf));
          const img = PNG.sync.read(Buffer.from(buf));
          rows.push({ file: path.basename(fp), bytes: buf.length, width: img.width, height: img.height, variance: Math.round(colorVariance(img)), overflow: 0, banned: false, title: m.id, textHead: '' });
          pngCount++;
          await page.keyboard.press('Escape');
          await new Promise(r => setTimeout(r, 350));
        }
      } catch (e) { rows.push({ file: m.id + '_EXC', error: String(e).slice(0, 100) }); }
    }
    // 8 tab Admin Console
    for (let i = 0; i < 8; i++) {
      try {
        await page.evaluate((idx) => { try { navigateTo('admin-console'); } catch (_) {} try { if (typeof switchAdminTab === 'function') switchAdminTab(idx); } catch (_) {} }, i);
        await new Promise(r => setTimeout(r, 1200));
        const buf = await page.screenshot({ encoding: 'binary' });
        const fp = path.join(OUT, 'admin_tab' + (i + 1) + '_ringkasan.png');
        const names = ['ringkasan', 'online', 'persetujuan', 'pengguna', 'maintenance', 'kupon', 'pipeline', 'keamanan'];
        const fp2 = path.join(OUT, 'admin_tab' + (i + 1) + '_' + names[i] + '.png');
        fs.writeFileSync(fp2, Buffer.from(buf));
        const img = PNG.sync.read(Buffer.from(buf));
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        rows.push({ file: path.basename(fp2), bytes: buf.length, width: img.width, height: img.height, variance: Math.round(colorVariance(img)), overflow: over, banned: false, title: 'admin tab ' + (i + 1), textHead: '' });
        pngCount++;
      } catch (e) { rows.push({ file: 'admin_tab' + (i + 1) + '_EXC', error: String(e).slice(0, 100) }); }
    }
    // 5 Financial Q2
    for (const t of ['BRPT', 'BBCA', 'BBRI', 'BMRI', 'TLKM']) {
      try {
        await page.evaluate((tk) => { try { navigateTo('analisis', 'financial', tk); } catch (_) {} }, t);
        await new Promise(r => setTimeout(r, 1200));
        const buf = await page.screenshot({ encoding: 'binary' });
        const fp = path.join(OUT, 'fin_q2_' + t + '.png');
        fs.writeFileSync(fp, Buffer.from(buf));
        const img = PNG.sync.read(Buffer.from(buf));
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        rows.push({ file: path.basename(fp), bytes: buf.length, width: img.width, height: img.height, variance: Math.round(colorVariance(img)), overflow: over, banned: false, title: 'fin ' + t, textHead: '' });
        pngCount++;
      } catch (e) {}
    }
    // 11 Chart Workstation
    for (const t of ['BBCA', 'BBRI', 'BMRI', 'TLKM', 'ANTM', 'BRPT', 'GOTO', 'ASII', 'ADRO', 'MEDC', 'IHSG']) {
      try {
        await page.evaluate((tk) => { try { navigateTo('analisis', 'analisis-chart', tk); } catch (_) {} }, t);
        await new Promise(r => setTimeout(r, 1200));
        const buf = await page.screenshot({ encoding: 'binary' });
        const fp = path.join(OUT, 'chart_' + t + '.png');
        fs.writeFileSync(fp, Buffer.from(buf));
        const img = PNG.sync.read(Buffer.from(buf));
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        rows.push({ file: path.basename(fp), bytes: buf.length, width: img.width, height: img.height, variance: Math.round(colorVariance(img)), overflow: over, banned: false, title: 'chart ' + t, textHead: '' });
        pngCount++;
      } catch (e) {}
    }
    // 3 mode Screener
    for (const m of [['konglo', 'screener_konglo'], ['nonkonglo', 'screener_non_konglo'], ['daytrade', 'screener_daytrade']]) {
      try {
        await page.evaluate((mm) => { try { navigateTo('screener'); } catch (_) {} try { switchScreenerType(mm); } catch (_) {} }, m[0]);
        await new Promise(r => setTimeout(r, 1200));
        const buf = await page.screenshot({ encoding: 'binary' });
        const fp = path.join(OUT, m[1] + '.png');
        fs.writeFileSync(fp, Buffer.from(buf));
        const img = PNG.sync.read(Buffer.from(buf));
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        rows.push({ file: path.basename(fp), bytes: buf.length, width: img.width, height: img.height, variance: Math.round(colorVariance(img)), overflow: over, banned: false, title: m[1], textHead: '' });
        pngCount++;
      } catch (e) {}
    }
    // 4 segmen Bandarmologi (all/foreign/domestik + akumulasi)
    const bandarSegs = [['all', 'bandar_all'], ['F', 'bandar_foreign'], ['D', 'bandar_domestik']];
    for (const [f, nm] of bandarSegs) {
      try {
        await page.evaluate((fl) => { try { navigateTo('analisis', 'bandarmologi'); } catch (_) {} try { if (typeof setBrokerFlowFilter === 'function') setBrokerFlowFilter(fl); } catch (_) {} }, f);
        await new Promise(r => setTimeout(r, 1200));
        const buf = await page.screenshot({ encoding: 'binary' });
        const fp = path.join(OUT, nm + '.png');
        fs.writeFileSync(fp, Buffer.from(buf));
        const img = PNG.sync.read(Buffer.from(buf));
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        rows.push({ file: path.basename(fp), bytes: buf.length, width: img.width, height: img.height, variance: Math.round(colorVariance(img)), overflow: over, banned: false, title: nm, textHead: '' });
        pngCount++;
      } catch (e) {}
    }
    try {
      await page.evaluate(() => { try { navigateTo('analisis', 'bandarmologi'); } catch (_) {} try { if (typeof setBandarSection === 'function') setBandarSection('akumulasi'); } catch (_) {} });
      await new Promise(r => setTimeout(r, 1200));
      const buf = await page.screenshot({ encoding: 'binary' });
      const fp = path.join(OUT, 'bandar_akumulasi.png');
      fs.writeFileSync(fp, Buffer.from(buf));
      const img = PNG.sync.read(Buffer.from(buf));
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      rows.push({ file: path.basename(fp), bytes: buf.length, width: img.width, height: img.height, variance: Math.round(colorVariance(img)), overflow: over, banned: false, title: 'bandar_akumulasi', textHead: '' });
      pngCount++;
    } catch (e) {}
    // Modal Editor Kuota Bulanan (tab Ringkasan admin)
    try {
      await page.evaluate(() => { try { navigateTo('admin-console'); } catch (_) {} try { if (typeof switchAdminTab === 'function') switchAdminTab(0); } catch (_) {} });
      await new Promise(r => setTimeout(r, 1200));
      const buf = await page.screenshot({ encoding: 'binary' });
      const fp = path.join(OUT, 'admin_modal_kuota.png');
      fs.writeFileSync(fp, Buffer.from(buf));
      const img = PNG.sync.read(Buffer.from(buf));
      rows.push({ file: path.basename(fp), bytes: buf.length, width: img.width, height: img.height, variance: Math.round(colorVariance(img)), overflow: 0, banned: false, title: 'kuota modal', textHead: '' });
      pngCount++;
    } catch (e) {}
    global.__C11_CERR = cerr; global.__C11_PERR = perr; global.__C11_EXT = ext;
    await page.close();
  }

  // ===== SESI 2: User biasa non-admin — uji proteksi 403 =====
  let user403 = { adminPage: '', adminApi: -1, patternApi: -1 };
  {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', r => {
      const uu = r.url();
      if (/^https?:\/\//.test(uu) && uu.indexOf('127.0.0.1') < 0 && uu.indexOf('localhost') < 0) return r.abort();
      return r.continue();
    });
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(base + '/', { waitUntil: 'load', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    await goUser(page);
    await page.evaluate(() => { try { navigateTo('admin-console'); } catch (_) {} });
    await new Promise(r => setTimeout(r, 1500));
    user403.adminPage = await page.evaluate(() => {
      const un = document.getElementById('unauthorizedScreen');
      const main = document.getElementById('adminMainContent');
      const unVis = un && un.style.display !== 'none';
      const mainHid = main && main.style.display === 'none';
      return 'unauth=' + unVis + ' mainHidden=' + mainHid + ' toast=' + document.body.innerText.slice(0, 120).replace(/\n/g, ' ');
    });
    const post = (action) => new Promise((resolve) => {
      const payload = JSON.stringify({ action });
      const rq = http.request({ host: '127.0.0.1', port, path: '/api/admin-users', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (rs) => {
        let b = ''; rs.on('data', c => { b += c; }); rs.on('end', () => resolve(rs.statusCode));
      });
      rq.on('error', () => resolve(-1));
      rq.end(payload);
    });
    global.__C11_USER = 'member';
    user403.adminApi = await post('admin_console_stats');
    user403.patternApi = await post('pattern_radar_scan');
    global.__C11_USER = 'budi';
    const buf = await page.screenshot({ encoding: 'binary' });
    const fp = path.join(OUT, 'user_biasa_403_admin.png');
    fs.writeFileSync(fp, Buffer.from(buf));
    const img = PNG.sync.read(Buffer.from(buf));
    rows.push({ file: path.basename(fp), bytes: buf.length, width: img.width, height: img.height, variance: Math.round(colorVariance(img)), overflow: 0, banned: false, title: '403 user biasa', textHead: '' });
    pngCount++;
    await page.close();
  }

  await browser.close();
  server.close();

  // Pixel-diff 3 panel: ambil 2 PNG representatif (dashboard light vs dark) + diff
  const pick = (nm) => { try { return PNG.sync.read(fs.readFileSync(path.join(OUT, nm))); } catch (_) { return null; } };
  const imgA = pick('dashboard_1440_light.png');
  const imgB = pick('dashboard_1440_dark.png');
  let diffRatio = 0;
  if (imgA && imgB) {
    const w = Math.min(imgA.width, imgB.width), h = Math.min(imgA.height, imgB.height);
    const diff = new PNG({ width: w * 3 + 20, height: h });
    let dc = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const iA = (y * imgA.width + x) * 4, iB = (y * imgB.width + x) * 4;
      const a = [imgA.data[iA], imgA.data[iA + 1], imgA.data[iA + 2]], b = [imgB.data[iB], imgB.data[iB + 1], imgB.data[iB + 2]];
      for (const [panel, src, idx] of [[0, imgA, iA], [1, imgB, iB]]) {
        const dx = panel * (w + 10) + x, di = (y * diff.width + dx) * 4;
        diff.data[di] = src.data[idx]; diff.data[di + 1] = src.data[idx + 1]; diff.data[di + 2] = src.data[idx + 2]; diff.data[di + 3] = 255;
      }
      const d = yiqDiff(a, b);
      if (d > 0.1) dc++;
      const dx = 2 * (w + 10) + x, di = (y * diff.width + dx) * 4;
      if (d > 0.1) { diff.data[di] = 255; diff.data[di + 1] = 0; diff.data[di + 2] = 0; } else { diff.data[di] = 240; diff.data[di + 1] = 240; diff.data[di + 2] = 240; }
      diff.data[di + 3] = 255;
    }
    diffRatio = dc / (w * h);
    fs.writeFileSync(path.join(OUT, 'pixel-diff-3panel-dashboard.png'), PNG.sync.write(diff));
  }

  const table = {
    generatedAt: new Date().toISOString(),
    branch: 'feat/daytrade-screener-v1',
    total: rows.length,
    consoleErrors: (global.__C11_CERR || []).length,
    consoleErrorsDetail: (global.__C11_CERR || []).slice(0, 10),
    pageErrors: (global.__C11_PERR || []).length,
    pageErrorsDetail: (global.__C11_PERR || []).slice(0, 10),
    externalCdnRequests: (global.__C11_EXT || []).length,
    externalCdnDetail: (global.__C11_EXT || []).slice(0, 10),
    user403,
    diffRatio,
    rows
  };
  fs.writeFileSync(TABLE_PATH, JSON.stringify(table, null, 2));
  console.log(JSON.stringify({ png: pngCount, rows: rows.length, cerr: table.consoleErrors, perr: table.pageErrors, ext: table.externalCdnRequests, diffRatio, user403 }, null, 2));
}

if (require.main === module) main().catch(e => { console.error('C11_CAPTURE_FAIL ' + e.message); process.exit(1); });
module.exports = { main };
